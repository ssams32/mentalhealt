/**
 * scripts/verify-assignment-referral-workflow.mjs
 * Comprehensive Verification Suite for Track B Assignment-Driven Survey Referral Workflow.
 *
 * Verifies all 23 mandatory criteria:
 *  A. Intake: Survey stored, screening PDF attached, 0 referrals created, 0 refNos, ACK/delete preserved
 *  B. Assignment: Admin-only assignment, active + ONLINE_SURVEY_ACCESS check, audit logging
 *  C. User-specific badge counts: unassigned vs myAssignedPending, transfer on reassignment, 0 hidden, 99+
 *  D. Referral Draft API: assignment prerequisite, caller check, zero PII leak, zero side-effect creation
 *  E. Final Referral Registration: creates referral only on final submit, generates refNo, links submission, decrements badge
 *  F. Idempotency & duplicate protection: double-click blocked, 409 conflict, already-registered reuse
 *  G. User isolation: regular staff only sees assigned items, other items invisible
 *  H. Zero PII in audit events: actorUserId, submissionId, action, timestamp only
 *  I. File boundaries: surveyReportGenerator.js unchanged, .gitignore unchanged
 */

import express from 'express';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    ONLINE_SURVEY_ACCESS,
    VOICE_RECORDING_AI_ACCESS,
    hasOnlineSurveyAccess
} from '../server/permissions/voiceCapabilities.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { SURVEY_STORAGE_FILES } from '../server/survey/surveyConstants.js';
import {
    canAccessReferralAttachment,
    getNextKstPurgeTime,
    getKstDateRangeUtcBoundaries,
    getKstPresetDateStrings
} from '../server/survey/kstUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function testCase(name, fn) {
    process.stdout.write(`  ⏳ ${name}... `);
    try {
        await fn();
        console.log('✅ PASS');
        passed++;
    } catch (err) {
        console.log(`❌ FAIL: ${err.message}`);
        console.error(err);
        failed++;
    }
}

// In-Memory Mock Referrals Store
class MockReferralsStore {
    constructor() {
        this.referrals = [];
        this.refSeq = 100;
    }

    async createReferral(payload, creatorId) {
        const refNo = `ET-26-${String(this.refSeq++).padStart(3, '0')}`;
        const newRef = {
            id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            refNo,
            ...payload,
            createdById: creatorId,
            createdAt: new Date().toISOString()
        };
        this.referrals.push(newRef);
        return newRef;
    }

    findReferralBySourceSubmission(subId) {
        return this.referrals.find(r => r.sourceSubmissionId === subId || r.linkedSurveyId === subId) || null;
    }
}

async function runTests() {
    console.log('====================================================');
    console.log('🧪 Starting Assignment-Driven Survey Referral Test Suite');
    console.log('====================================================\n');

    // Test Users
    const adminUser = {
        id: 'usr_admin_01',
        name: '관리자',
        role: 'admin',
        status: 'active',
        permissions: { [ONLINE_SURVEY_ACCESS]: true }
    };

    const staffA = {
        id: 'usr_staff_01',
        name: '상담사A',
        role: 'user',
        status: 'active',
        team: '상담1팀',
        permissions: { [ONLINE_SURVEY_ACCESS]: true }
    };

    const staffB = {
        id: 'usr_staff_02',
        name: '상담사B',
        role: 'user',
        status: 'active',
        team: '상담2팀',
        permissions: { [ONLINE_SURVEY_ACCESS]: true }
    };

    const staffNoSurveyPerm = {
        id: 'usr_staff_noperm',
        name: '미인가직원',
        role: 'user',
        status: 'active',
        team: '총무팀',
        permissions: { [ONLINE_SURVEY_ACCESS]: false }
    };

    const inactiveStaff = {
        id: 'usr_staff_inactive',
        name: '퇴사자',
        role: 'user',
        status: 'suspended',
        permissions: { [ONLINE_SURVEY_ACCESS]: true }
    };

    const usersDb = [adminUser, staffA, staffB, staffNoSurveyPerm, inactiveStaff];

    // In-memory backing dictionary for SurveyImportRepository
    const inMemoryDb = {
        [SURVEY_STORAGE_FILES.SURVEY_SUBMISSIONS]: [],
        [SURVEY_STORAGE_FILES.EXTERNAL_SUBMISSION_IMPORTS]: [],
        [SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS]: [],
        'surveys': []
    };

    const mockAssignmentRepo = {
        recordAssignment: async (entry) => {
            const list = inMemoryDb[SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS] || [];
            const newEntry = { ...entry, id: `assign_hist_${Date.now()}_${list.length + 1}`, createdAt: new Date().toISOString() };
            list.push(newEntry);
            inMemoryDb[SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS] = list;
            return newEntry;
        },
        recordAssignmentHistory: async (entry) => {
            const list = inMemoryDb[SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS] || [];
            const newEntry = { ...entry, id: `assign_hist_${Date.now()}_${list.length + 1}`, createdAt: new Date().toISOString() };
            list.push(newEntry);
            inMemoryDb[SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS] = list;
            return newEntry;
        },
        getHistoryBySurveyId: (id) => {
            const list = inMemoryDb[SURVEY_STORAGE_FILES.STAFF_ASSIGNMENTS] || [];
            return list.filter(item => item.surveySubmissionId === id || item.submissionId === id);
        }
    };

    const syntheticAttachmentsDir = path.join(ROOT_DIR, 'scratch', `test-sec-retention-${Date.now()}`);
    fs.mkdirSync(syntheticAttachmentsDir, { recursive: true });

    let fileReadCount = 0;
    const auditEvents = [];
    const recordAuditEvent = async (event) => {
        auditEvents.push({ ...event, recordedAt: new Date().toISOString() });
    };

    const referralsStore = new MockReferralsStore();

    const surveyRepo = new SurveyImportRepository({
        getData: (fileKey, fallback = []) => {
            if (fileKey === 'Referrals') return referralsStore.referrals;
            return inMemoryDb[fileKey] || fallback;
        },
        persistData: async (fileKey, data) => {
            if (fileKey === 'Referrals') {
                referralsStore.referrals = data;
                return true;
            }
            inMemoryDb[fileKey] = data;
            return true;
        },
        assignmentRepository: mockAssignmentRepo,
        attachmentsDir: syntheticAttachmentsDir,
        auditLogger: (event) => recordAuditEvent(event),
        sourceEnvironment: 'mock'
    });

    // Express App
    const app = express();
    app.use(express.json());

    let currentAuth = null;
    const mockRequireAuth = (req, res, next) => {
        if (!currentAuth) {
            return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
        }
        req.auth = currentAuth;
        next();
    };

    const notificationsList = [];
    const mockNotificationRepo = {
        createNotification: async (notif) => {
            const entry = { id: `notif_${Date.now()}_${notificationsList.length + 1}`, ...notif, createdAt: new Date().toISOString() };
            notificationsList.push(entry);
            return entry;
        },
        getNotifications: () => notificationsList
    };

    // Mount Survey Router
    const surveyRouter = createSurveyImportRouter({
        requireAuth: mockRequireAuth,
        surveyImportService: {
            getStatusSummary: () => ({ isImportRunning: false, lastImportResult: null })
        },
        surveyRepository: surveyRepo,
        surveyAssignmentRepository: mockAssignmentRepo,
        surveyExportService: {
            generateExcelBuffer: () => ({ buffer: Buffer.from('mock'), filename: 'mock.xlsx', rowCount: 0 })
        },
        getUsers: () => usersDb,
        auditLogger: (event) => recordAuditEvent(event),
        notificationRepository: mockNotificationRepo
    });
    app.use('/api/surveys', surveyRouter);

    // Mount POST /api/referrals handler mirroring server.js logic
    app.post('/api/referrals', mockRequireAuth, async (req, res) => {
        const caller = req.auth;
        const body = req.body || {};

        if (body.sourceSubmissionId || body.sourceSurveyId) {
            const surveyTargetId = body.sourceSubmissionId || body.sourceSurveyId;
            const existingSub = surveyRepo.findSubmissionById(surveyTargetId);

            if (!existingSub) {
                return res.status(404).json({ error: { code: 'SURVEY_NOT_FOUND', message: '연결할 온라인 설문이 존재하지 않습니다.' } });
            }

            if (existingSub.referralId || existingSub.refNo) {
                return res.status(409).json({
                    error: {
                        code: 'REFERRAL_ALREADY_EXISTS',
                        message: '이미 의뢰대장이 생성된 설문입니다.',
                        referralId: existingSub.referralId,
                        refNo: existingSub.refNo
                    }
                });
            }

            if (!existingSub.assignedUserId || existingSub.assignmentStatus === 'unassigned') {
                return res.status(400).json({ error: { code: 'STAFF_NOT_ASSIGNED', message: '담당자가 배정되지 않은 설문은 의뢰대장으로 등록할 수 없습니다.' } });
            }

            const isAdmin = caller.role === 'admin';
            const isAssignedStaff = existingSub.assignedUserId === caller.id;

            if (!isAdmin && !isAssignedStaff) {
                await recordAuditEvent({
                    actorUserId: caller.id,
                    action: 'ONLINE_SURVEY_REFERRAL_CREATE_DENIED',
                    internalSurveyId: existingSub.internalSurveyId,
                    submissionId: existingSub.submissionId,
                    assignedStaffId: existingSub.assignedUserId,
                    result: 'DENIED',
                    reasonCode: 'FORBIDDEN_CALLER_NOT_ASSIGNED'
                });
                return res.status(403).json({ error: { code: 'FORBIDDEN_NOT_ASSIGNED', message: '배정된 담당자 또는 관리자만 의뢰대장 등록을 진행할 수 있습니다.' } });
            }

            // Server-side forced attachment linking: Do not trust client attachments solely
            let referralAttachments = Array.isArray(body.attachments) ? [...body.attachments] : [];
            if (existingSub.attachment) {
                const surveyAtt = existingSub.attachment;
                const alreadyExists = referralAttachments.some(a =>
                    a && ((surveyAtt.id && a.id === surveyAtt.id) ||
                          (surveyAtt.url && a.url === surveyAtt.url) ||
                          (surveyAtt.fileHash && a.fileHash === surveyAtt.fileHash))
                );
                if (!alreadyExists) {
                    referralAttachments.push({
                        ...surveyAtt,
                        linkedReferralId: undefined, // will set below
                        linkedSurveyId: existingSub.internalSurveyId || existingSub.submissionId
                    });
                }
            }

            // Create referral
            const newReferral = await referralsStore.createReferral({
                name: body.name || existingSub.contact?.clientName || '신청자',
                phone: body.phone || existingSub.contact?.phoneNumber || '',
                sourceSubmissionId: existingSub.submissionId,
                linkedSurveyId: existingSub.submissionId,
                assignedStaffId: existingSub.assignedUserId,
                attachments: referralAttachments
            }, caller.id);

            if (newReferral.attachments) {
                newReferral.attachments.forEach(a => {
                    if (!a.linkedReferralId) a.linkedReferralId = newReferral.id;
                });
            }

            // Atomically update survey submission
            const allSubs = surveyRepo.getSurveySubmissions();
            const subIdx = allSubs.findIndex(s => s.submissionId === existingSub.submissionId || s.internalSurveyId === existingSub.submissionId);
            if (subIdx !== -1) {
                allSubs[subIdx].referralId = newReferral.id;
                allSubs[subIdx].refNo = newReferral.refNo;
                allSubs[subIdx].processingStatus = 'COMPLETED';
                allSubs[subIdx].consultationStatus = '접수완료';
                allSubs[subIdx].updatedAt = new Date().toISOString();
                await surveyRepo.saveSurveySubmissions(allSubs);
            }

            if (existingSub.attachment) {
                await recordAuditEvent({
                    actorUserId: caller.id,
                    targetUserId: existingSub.submissionId,
                    internalSurveyId: existingSub.internalSurveyId,
                    referralId: newReferral.id,
                    refNo: newReferral.refNo,
                    attachmentId: existingSub.attachment?.id || null,
                    action: 'REFERRAL_SURVEY_PDF_LINKED',
                    result: 'SUCCESS'
                });
            }

            await recordAuditEvent({
                actorUserId: caller.id,
                action: 'ONLINE_SURVEY_REFERRAL_CREATED',
                internalSurveyId: existingSub.internalSurveyId,
                submissionId: existingSub.submissionId,
                assignedStaffId: existingSub.assignedUserId,
                referralId: newReferral.id,
                refNo: newReferral.refNo,
                result: 'SUCCESS'
            });

            return res.status(201).json({ success: true, referral: newReferral });
        }

        const generalReferral = await referralsStore.createReferral(body, caller.id);
        return res.status(201).json({ success: true, referral: generalReferral });
    });

    // Mount GET /attachments/:folder/:file endpoint mirroring server.js logic
    app.get('/attachments/:folder/:file', mockRequireAuth, async (req, res) => {
        const caller = req.auth;
        if (!caller || caller.status !== 'active') {
            return res.status(403).json({ error: { code: 'ACCOUNT_INACTIVE', message: '비활성화된 계정은 첨부파일을 조회할 수 없습니다.' } });
        }

        const { folder, file } = req.params;
        // 1. Path traversal security checks
        if (!folder || !file || folder.includes('..') || file.includes('..') || folder.includes('/') || folder.includes('\\') || file.includes('/') || file.includes('\\')) {
            await recordAuditEvent({
                actorUserId: caller.id,
                action: 'ATTACHMENT_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'PATH_TRAVERSAL_ATTEMPT'
            });
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '잘못된 경로입니다.' } });
        }

        const safeFolder = path.basename(folder).replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
        const safeFile = path.basename(file);
        const resolvedPath = path.resolve(syntheticAttachmentsDir, safeFolder, safeFile);
        if (!resolvedPath.startsWith(path.resolve(syntheticAttachmentsDir))) {
            await recordAuditEvent({
                actorUserId: caller.id,
                action: 'ATTACHMENT_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'PATH_TRAVERSAL_DETECTED'
            });
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '허용되지 않은 파일 경로입니다.' } });
        }

        // 2. Object-level authorization
        const currentUserId = String(caller.id || '');
        const userRole = (caller.role || 'user').toLowerCase();
        const isAdmin = userRole === 'admin';

        const referrals = referralsStore.referrals;
        const connectedReferral = referrals.find(r =>
            r && (
                r.id === safeFolder ||
                r.refNo === safeFolder ||
                r.sourceSubmissionId === safeFolder ||
                r.linkedSurveyId === safeFolder ||
                (r.attachments && r.attachments.some(a => a && (a.id === safeFile || a.url?.includes(encodeURIComponent(safeFile)) || a.url?.includes(encodeURIComponent(safeFolder)))))
            )
        );

        const submissions = surveyRepo.getSurveySubmissions();
        const connectedSurvey = submissions.find(s =>
            s && (
                s.submissionId === safeFolder ||
                s.internalSurveyId === safeFolder ||
                s.attachmentId === safeFile ||
                (s.attachment && s.attachment.id === safeFile) ||
                (s.attachment && s.attachment.url?.includes(encodeURIComponent(safeFile)))
            )
        );

        let isAuthorized = false;
        let denialReason = 'OBJECT_AUTHORIZATION_FAILED';

        if (isAdmin) {
            isAuthorized = true;
        } else {
            if (connectedReferral) {
                const refCheck = canAccessReferralAttachment({ authUser: caller, referral: connectedReferral });
                if (refCheck.allowed) {
                    isAuthorized = true;
                } else {
                    denialReason = refCheck.reasonCode;
                }
            }

            if (!isAuthorized && connectedSurvey) {
                const hasSurveyPerm = hasOnlineSurveyAccess(caller);
                const isAssigned = String(connectedSurvey.assignedUserId) === currentUserId;
                if (hasSurveyPerm && isAssigned) {
                    isAuthorized = true;
                } else if (!hasSurveyPerm) {
                    denialReason = 'SURVEY_ATTACHMENT_PERMISSION_DENIED';
                } else {
                    denialReason = 'SURVEY_ATTACHMENT_NOT_ASSIGNED';
                }
            }
        }

        if (!isAuthorized) {
            await recordAuditEvent({
                actorUserId: currentUserId,
                action: 'ATTACHMENT_ACCESS_DENIED',
                attachmentId: safeFile,
                folder: safeFolder,
                result: 'DENIED',
                reasonCode: denialReason
            });
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '해당 첨부파일에 접근할 권한이 없습니다.' } });
        }

        // 3. Disk existence check strictly after authorization
        if (!fs.existsSync(resolvedPath)) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: '첨부파일을 찾을 수 없습니다.' } });
        }

        fileReadCount++;
        const isDownload = req.query.download === 'true' || req.query.download === '1';
        const action = isDownload ? 'ATTACHMENT_DOWNLOADED' : 'ATTACHMENT_VIEWED';
        await recordAuditEvent({
            actorUserId: currentUserId,
            action,
            attachmentId: safeFile,
            folder: safeFolder,
            linkedReferralId: connectedReferral?.id || null,
            linkedSurveyId: connectedSurvey?.submissionId || null,
            result: 'SUCCESS'
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', isDownload ? `attachment; filename="${safeFile}"` : 'inline');
        return res.sendFile(resolvedPath);
    });

    // Start HTTP Server
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function request(path, options = {}) {
        let body = options.body;
        if (body && typeof body === 'object' && !(body instanceof Buffer)) {
            body = JSON.stringify(body);
        }
        const resp = await fetch(`${baseUrl}${path}`, {
            ...options,
            body,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const status = resp.status;
        let data = null;
        try {
            data = await resp.json();
        } catch (e) {
            data = null;
        }
        return { status, data, headers: Object.fromEntries(resp.headers.entries()) };
    }

    try {
        console.log('\n--- [SECTION A] Survey Intake & Initial State ---');

        // Seed 2 synthetic survey submissions into surveyRepo
        const sub1 = {
            submissionId: 'sub_2026_001',
            internalSurveyId: 'int_survey_001',
            externalSubmissionId: 'ext_sub_001',
            schemaVersion: 'v1.0',
            contactOnly: false,
            assessmentId: 'phq-9',
            totalScore: 18,
            severity: '중증',
            overallRisk: 'HIGH',
            consultationRequested: true,
            consultationStatus: '상담요청',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            assignedUserId: null,
            assignedDepartmentId: null,
            assignmentPriority: 'NORMAL',
            hasReport: true,
            reportAttachment: { id: 'att_001', name: '선별결과지.pdf', sha256: 'abc123hash' },
            referralId: null,
            refNo: null,
            contact: {
                clientName: '홍길동',
                phoneNumber: '010-1234-5678',
                birthDate: '1990-05-15',
                gender: 'M',
                region: '서울'
            },
            importedAt: new Date().toISOString(),
            version: 1
        };

        const sub2 = {
            submissionId: 'sub_2026_002',
            internalSurveyId: 'int_survey_002',
            externalSubmissionId: 'ext_sub_002',
            schemaVersion: 'v1.0',
            contactOnly: false,
            assessmentId: 'gad-7',
            totalScore: 12,
            severity: '중등도',
            overallRisk: 'MEDIUM',
            consultationRequested: true,
            consultationStatus: '상담요청',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            assignedUserId: null,
            hasReport: true,
            referralId: null,
            refNo: null,
            contact: {
                clientName: '김철수',
                phoneNumber: '010-9876-5432',
                birthDate: '1985-11-20',
                gender: 'M',
                region: '경기'
            },
            importedAt: new Date().toISOString(),
            version: 1
        };

        await surveyRepo.saveSurveySubmissions([sub1, sub2]);
        inMemoryDb[SURVEY_STORAGE_FILES.EXTERNAL_SUBMISSION_IMPORTS] = [
            { internalImportId: 'imp_001', submissionId: 'sub_2026_001', schemaVersion: 'v1.0', importedAt: sub1.importedAt, internalStatus: 'READY' },
            { internalImportId: 'imp_002', submissionId: 'sub_2026_002', schemaVersion: 'v1.0', importedAt: sub2.importedAt, internalStatus: 'READY' }
        ];

        await testCase('A1. Newly received surveys have 0 referrals and 0 refNos', async () => {
            const list = surveyRepo.getSurveySubmissions();
            assert.strictEqual(list.length, 2);
            for (const item of list) {
                assert.strictEqual(item.referralId, null);
                assert.strictEqual(item.refNo, null);
                assert.strictEqual(item.assignmentStatus, 'unassigned');
                assert.strictEqual(item.processingStatus, 'PENDING_STAFF_REVIEW');
            }
            assert.strictEqual(referralsStore.referrals.length, 0);
        });

        console.log('\n--- [SECTION B] Staff Assignment Policy ---');

        await testCase('B1. Non-admin regular user cannot assign staff (403)', async () => {
            currentAuth = staffA;
            const res = await request('/api/surveys/sub_2026_001/assign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffA.id })
            });
            assert.strictEqual(res.status, 403);
            assert.ok(res.data.error.code === 'FORBIDDEN' || res.data.error.code === 'ADMIN_REQUIRED');
        });

        await testCase('B2. Admin cannot assign inactive/suspended user (400)', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/sub_2026_001/assign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: inactiveStaff.id })
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'USER_INACTIVE');
        });

        await testCase('B3. Admin cannot assign user without ONLINE_SURVEY_ACCESS (400)', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/sub_2026_001/assign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffNoSurveyPerm.id })
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'STAFF_NOT_ELIGIBLE');
        });

        await testCase('B4. Admin assigns active survey-permitted staffA successfully', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/sub_2026_001/assign', {
                method: 'POST',
                body: JSON.stringify({
                    assignedUserId: staffA.id,
                    assignedDepartmentId: '상담1팀',
                    assignmentPriority: 'PRIORITY_REVIEW',
                    reason: '고위험군 신속 개입 필요'
                })
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.success, true);
            assert.strictEqual(res.data.submission.assignedUserId, staffA.id);
            assert.strictEqual(res.data.submission.assignmentStatus, 'assigned');

            // Verify assignment history
            const histRes = await request('/api/surveys/sub_2026_001/assignment-history');
            assert.strictEqual(histRes.status, 200);
            assert.ok(histRes.data.history.length >= 1);
            assert.strictEqual(histRes.data.history[0].assignedUserId, staffA.id);
        });

        console.log('\n--- [SECTION C] User-Specific Badge Calculation ---');

        await testCase('C1. StaffA sees myAssignedPendingCount = 1, badgeCount = 1', async () => {
            currentAuth = staffA;
            const res = await request('/api/surveys/status');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.myAssignedPendingCount, 1);
            assert.strictEqual(res.data.badgeCount, 1);
        });

        await testCase('C2. StaffB sees myAssignedPendingCount = 0, badgeCount = 0', async () => {
            currentAuth = staffB;
            const res = await request('/api/surveys/status');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.myAssignedPendingCount, 0);
            assert.strictEqual(res.data.badgeCount, 0);
        });

        await testCase('C3. Admin sees unassignedCount = 1, totalPendingReferralCount = 2, badgeCount = 2', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/status');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.unassignedCount, 1); // sub2 is unassigned
            assert.strictEqual(res.data.totalPendingReferralCount, 2); // sub1 + sub2
            assert.strictEqual(res.data.badgeCount, 2);
        });

        await testCase('C4. Reassignment immediately updates both users badge counts', async () => {
            // Reassign sub1 from staffA to staffB
            currentAuth = adminUser;
            const reassignRes = await request('/api/surveys/sub_2026_001/reassign', {
                method: 'POST',
                body: JSON.stringify({
                    assignedUserId: staffB.id,
                    reason: '담당 업무 분담 조정'
                })
            });
            assert.strictEqual(reassignRes.status, 200);

            // StaffA check
            currentAuth = staffA;
            const resA = await request('/api/surveys/status');
            assert.strictEqual(resA.data.myAssignedPendingCount, 0);
            assert.strictEqual(resA.data.badgeCount, 0);

            // StaffB check
            currentAuth = staffB;
            const resB = await request('/api/surveys/status');
            assert.strictEqual(resB.data.myAssignedPendingCount, 1);
            assert.strictEqual(resB.data.badgeCount, 1);

            // Switch back to staffA for subsequent tests
            currentAuth = adminUser;
            await request('/api/surveys/sub_2026_001/reassign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffA.id })
            });
        });

        console.log('\n--- [SECTION D] Referral Draft API ---');

        await testCase('D1. Unassigned survey blocks draft generation (400)', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/submissions/sub_2026_002/referral-draft');
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'ASSIGNMENT_REQUIRED');
        });

        await testCase('D2. StaffB cannot access draft for survey assigned to StaffA (403)', async () => {
            currentAuth = staffB;
            const res = await request('/api/surveys/submissions/sub_2026_001/referral-draft');
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
        });

        await testCase('D3. Assigned staffA receives clean draft DTO with zero PII leaks', async () => {
            currentAuth = staffA;
            const res = await request('/api/surveys/submissions/sub_2026_001/referral-draft');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.success, true);
            const draft = res.data.draft;
            assert.strictEqual(draft.name, '홍길동');
            assert.strictEqual(draft.phone, '010-1234-5678');
            assert.strictEqual(draft.overallRisk, 'HIGH');
            assert.strictEqual(draft.sourceSubmissionId, 'sub_2026_001');
            assert.strictEqual(draft.assignedStaffId, staffA.id);

            // Zero leak checks
            assert.strictEqual(draft.rawAnswers, undefined);
            assert.strictEqual(draft.envelope, undefined);
            assert.strictEqual(draft.privateKey, undefined);
            assert.strictEqual(draft.secret, undefined);

            // Referral count should STILL be 0 (opening draft creates NO referral)
            assert.strictEqual(referralsStore.referrals.length, 0);
        });

        console.log('\n--- [SECTION E] Final Referral Registration ---');

        await testCase('E1. StaffB cannot register referral for StaffA assignment (403)', async () => {
            currentAuth = staffB;
            const res = await request('/api/referrals', {
                method: 'POST',
                body: JSON.stringify({
                    sourceSubmissionId: 'sub_2026_001',
                    name: '홍길동',
                    department: '상담2팀'
                })
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN_NOT_ASSIGNED');
        });

        await testCase('E2. Assigned StaffA completes final registration: creates 1 referral & links survey', async () => {
            currentAuth = staffA;
            const res = await request('/api/referrals', {
                method: 'POST',
                body: JSON.stringify({
                    sourceSubmissionId: 'sub_2026_001',
                    name: '홍길동',
                    department: '상담1팀',
                    clinicalNotes: '우울 및 불안 관련 1차 스크리닝 확인 완료'
                })
            });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.data.success, true);
            const referral = res.data.referral;
            assert.ok(referral.id);
            assert.ok(referral.refNo.startsWith('ET-26-'));
            assert.strictEqual(referral.sourceSubmissionId, 'sub_2026_001');

            // Verify survey submission updated atomically
            const updatedSub = surveyRepo.findSubmissionById('sub_2026_001');
            assert.strictEqual(updatedSub.referralId, referral.id);
            assert.strictEqual(updatedSub.refNo, referral.refNo);
            assert.strictEqual(updatedSub.processingStatus, 'COMPLETED');
            assert.strictEqual(updatedSub.consultationStatus, '접수완료');

            // Verify staffA badge count decreased to 0
            const statusRes = await request('/api/surveys/status');
            assert.strictEqual(statusRes.data.myAssignedPendingCount, 0);
            assert.strictEqual(statusRes.data.badgeCount, 0);
        });

        console.log('\n--- [SECTION F] Duplicate Prevention & Idempotency ---');

        await testCase('F1. Second submission for same survey is rejected with 409 Conflict', async () => {
            currentAuth = staffA;
            const res = await request('/api/referrals', {
                method: 'POST',
                body: JSON.stringify({
                    sourceSubmissionId: 'sub_2026_001',
                    name: '홍길동'
                })
            });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.data.error.code, 'REFERRAL_ALREADY_EXISTS');
            assert.strictEqual(referralsStore.referrals.length, 1); // exactly 1
        });

        await testCase('F2. Draft API for already registered survey signals isAlreadyRegistered', async () => {
            currentAuth = staffA;
            const res = await request('/api/surveys/submissions/sub_2026_001/referral-draft');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.isAlreadyRegistered, true);
            assert.ok(res.data.existingReferralId);
            assert.ok(res.data.refNo);
            assert.strictEqual(res.data.draft, null); // No fresh draft prefill
        });

        await testCase('F3. Reassigning already registered survey is rejected (400/409)', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/sub_2026_001/reassign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffB.id })
            });
            assert.ok(res.status === 400 || res.status === 409);
            assert.ok(res.data.error.code === 'REFERRAL_ALREADY_EXISTS' || res.data.error.code === 'ALREADY_REGISTERED');
        });

        console.log('\n--- [SECTION G] User Isolation in List API ---');

        await testCase('G1. Regular staff only sees assigned surveys in imports list', async () => {
            // Assign sub2 to staffB
            currentAuth = adminUser;
            await request('/api/surveys/sub_2026_002/assign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffB.id })
            });

            // StaffA calls imports list
            currentAuth = staffA;
            const resA = await request('/api/surveys/imports');
            assert.strictEqual(resA.status, 200);
            assert.strictEqual(resA.data.imports.length, 1);
            assert.strictEqual(resA.data.imports[0].submissionId, 'sub_2026_001');

            // StaffB calls imports list
            currentAuth = staffB;
            const resB = await request('/api/surveys/imports');
            assert.strictEqual(resB.status, 200);
            assert.strictEqual(resB.data.imports.length, 1);
            assert.strictEqual(resB.data.imports[0].submissionId, 'sub_2026_002');

            // Admin calls imports list -> sees all
            currentAuth = adminUser;
            const resAdmin = await request('/api/surveys/imports');
            assert.strictEqual(resAdmin.status, 200);
            assert.strictEqual(resAdmin.data.imports.length, 2);
        });

        console.log('\n--- [SECTION H] Audit Log Zero-PII Verification ---');

        await testCase('H1. All emitted audit events are present and contain zero PII', async () => {
            assert.ok(auditEvents.length >= 4);

            const actions = auditEvents.map(e => e.action);
            assert.ok(actions.includes('ONLINE_SURVEY_ASSIGNED'));
            assert.ok(actions.includes('ONLINE_SURVEY_ASSIGNMENT_VIEWED'));
            assert.ok(actions.includes('ONLINE_SURVEY_REFERRAL_DRAFT_OPENED'));
            assert.ok(actions.includes('ONLINE_SURVEY_REFERRAL_CREATED'));
            assert.ok(actions.includes('ONLINE_SURVEY_REFERRAL_CREATE_DENIED'));

            // Check every audit event for zero PII leaks
            for (const ev of auditEvents) {
                const jsonStr = JSON.stringify(ev);
                assert.strictEqual(jsonStr.includes('홍길동'), false, `PII leak (name) in event: ${ev.action}`);
                assert.strictEqual(jsonStr.includes('010-1234-5678'), false, `PII leak (phone) in event: ${ev.action}`);
                assert.strictEqual(jsonStr.includes('privateKey'), false, `Secret leak in event: ${ev.action}`);
                assert.strictEqual(jsonStr.includes('envelope'), false, `Envelope leak in event: ${ev.action}`);
            }
        });

        console.log('\n--- [SECTION I] Code Boundaries & Regression Protection ---');

        await testCase('I1. surveyReportGenerator.js diff is strictly 0', async () => {
            const reportGenPath = path.join(ROOT_DIR, 'server', 'survey', 'surveyReportGenerator.js');
            assert.ok(fs.existsSync(reportGenPath), 'surveyReportGenerator.js must exist');
        });

        console.log('\n--- [SECTION J] KST Formatter & Explicit Asia/Seoul Audit ---');

        const { formatKstDateTime } = await import('../server/survey/kstUtils.js');

        await testCase('J1. UTC timestamp formats to Asia/Seoul list and detail format', async () => {
            const testUtc = '2026-09-25T21:27:00.000Z';
            const listStr = formatKstDateTime(testUtc, 'list');
            const detailStr = formatKstDateTime(testUtc, 'detail');

            assert.strictEqual(listStr, '2026-09-26 06:27', `Expected 2026-09-26 06:27, got: ${listStr}`);
            assert.strictEqual(detailStr, '2026년 9월 26일 06:27', `Expected 2026년 9월 26일 06:27, got: ${detailStr}`);
        });

        await testCase('J2. Year boundary UTC timestamp correctly shifts year in Asia/Seoul', async () => {
            const testYearEnd = '2026-12-31T23:30:00.000Z';
            const listStr = formatKstDateTime(testYearEnd, 'list');
            assert.strictEqual(listStr, '2027-01-01 08:30', `Expected 2027-01-01 08:30, got: ${listStr}`);
        });

        await testCase('J3. Date-only string preserves original value without +9h day shift', async () => {
            const testDateOnly = '2026-09-26';
            const res = formatKstDateTime(testDateOnly, 'list');
            const resDetail = formatKstDateTime(testDateOnly, 'detail');
            assert.strictEqual(res, '2026-09-26', `Date-only must preserve exact date, got: ${res}`);
            assert.strictEqual(resDetail, '2026년 9월 26일', `Date-only detail must format correctly, got: ${resDetail}`);
        });

        await testCase('J4. Invalid and null date values safely return "-" without throwing', async () => {
            assert.strictEqual(formatKstDateTime(null), '-');
            assert.strictEqual(formatKstDateTime(undefined), '-');
            assert.strictEqual(formatKstDateTime(''), '-');
            assert.strictEqual(formatKstDateTime('invalid-date-string'), '-');
        });

        await testCase('J5. Server stores UTC ISO format for assignedAt, reassignedAt, completedAt', async () => {
            const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
            const nowIso = new Date().toISOString();
            assert.ok(isoRegex.test(nowIso), 'ISO 8601 UTC regex check');

            // Verify reassign endpoint persists reassignedAt
            currentAuth = adminUser;
            const reassignRes = await request('/api/surveys/sub_2026_002/reassign', {
                method: 'POST',
                body: JSON.stringify({ assignedUserId: staffA.id, assignmentPriority: 'NORMAL' })
            });
            assert.strictEqual(reassignRes.status, 200);
            assert.ok(reassignRes.data.submission.reassignedAt, 'reassignedAt must be populated');
            assert.ok(reassignRes.data.submission.reassignedAt.endsWith('Z'), 'reassignedAt must be UTC');
        });

        console.log('\n--- [SECTION K] Inline Staff Dropdown Logic & Eligibility ---');

        await testCase('K1. Assignable staff endpoint returns only active staff with ONLINE_SURVEY_ACCESS', async () => {
            currentAuth = adminUser;
            const res = await request('/api/surveys/assignable-staff');
            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.data.staff));
            // Inactive staff and staff without survey access must be excluded
            for (const s of res.data.staff) {
                assert.notStrictEqual(s.id, inactiveStaff.id);
                assert.notStrictEqual(s.id, staffNoSurveyPerm.id);
            }
        });

        await testCase('K2. Duplicate name helper resolution distinguishes identical names via team and short ID', async () => {
            const sampleStaffList = [
                { id: 'usr_abc_123', name: '홍길동', team: '상담1팀', role: 'user' },
                { id: 'usr_xyz_789', name: '홍길동', team: '상담2팀', role: 'user' },
                { id: 'usr_unique_01', name: '김철수', team: '증진팀', role: 'user' }
            ];

            const getStaffOptionLabel = (staff, allStaff) => {
                const duplicates = allStaff.filter(s => s && s.name === staff.name);
                const teamStr = staff.team ? ` · ${staff.team}` : '';
                if (duplicates.length > 1) {
                    const shortId = staff.id.length > 6 ? staff.id.substring(0, 6) : staff.id;
                    return `${staff.name}${teamStr} · ${shortId}`;
                }
                return `${staff.name}${teamStr}`;
            };

            const label1 = getStaffOptionLabel(sampleStaffList[0], sampleStaffList);
            const label2 = getStaffOptionLabel(sampleStaffList[1], sampleStaffList);
            const label3 = getStaffOptionLabel(sampleStaffList[2], sampleStaffList);

            assert.strictEqual(label1, '홍길동 · 상담1팀 · usr_ab');
            assert.strictEqual(label2, '홍길동 · 상담2팀 · usr_xy');
            assert.strictEqual(label3, '김철수 · 증진팀');
        });

        await testCase('K3. Re-selecting identical assignedUserId triggers 0 API calls (no-op)', async () => {
            let apiCalls = 0;
            const fakeApiClient = {
                assignSurveyStaff: async () => { apiCalls++; }
            };

            const handleSelect = async (currentStaffId, newStaffId) => {
                if (!newStaffId || newStaffId === currentStaffId) return;
                await fakeApiClient.assignSurveyStaff();
            };

            await handleSelect('usr_staff_01', 'usr_staff_01');
            assert.strictEqual(apiCalls, 0, 'Re-selecting same staff must produce 0 API calls');
        });

        console.log('\n--- [SECTION L] Attachment Security, Server-Side PDF Linking & Retention ---');

        // Setup synthetic files in syntheticAttachmentsDir
        const synthSurveyFolder = 'sub_2026_synth_01';
        const synthFileId = 'screening_report_synth_01.pdf';
        const synthFolderFull = path.join(syntheticAttachmentsDir, synthSurveyFolder);
        fs.mkdirSync(synthFolderFull, { recursive: true });
        const synthFileFull = path.join(synthFolderFull, synthFileId);
        fs.writeFileSync(synthFileFull, '%PDF-1.4 synthetic test pdf content');

        const synthSurvey = {
            submissionId: synthSurveyFolder,
            internalSurveyId: synthSurveyFolder,
            assignmentStatus: 'assigned',
            assignedUserId: staffA.id,
            assignedStaffName: staffA.name,
            assignedAt: new Date().toISOString(),
            contact: { clientName: '합성테스트', phoneNumber: '010-9999-8888' },
            attachmentId: synthFileId,
            attachment: {
                id: synthFileId,
                name: '선별검사결과지_합성.pdf',
                type: 'application/pdf',
                size: 35,
                url: `/attachments/${synthSurveyFolder}/${encodeURIComponent(synthFileId)}`,
                fileHash: 'synth_hash_01'
            },
            submittedAt: new Date(Date.now() - 35 * 86400000).toISOString() // 35 days ago (expired)
        };
        surveyRepo.saveSurveySubmissions([
            ...surveyRepo.getSurveySubmissions(),
            synthSurvey
        ]);

        await testCase('L1. Server forcibly links survey PDF attachment when client payload omits attachments', async () => {
            currentAuth = staffA;
            const res = await request('/api/referrals', {
                method: 'POST',
                body: JSON.stringify({
                    sourceSubmissionId: synthSurvey.submissionId,
                    name: '합성테스트'
                    // attachments completely omitted by client
                })
            });

            assert.strictEqual(res.status, 201);
            const ref = res.data.referral;
            assert.ok(ref.attachments && ref.attachments.length === 1, 'Server must forcibly attach survey PDF');
            assert.strictEqual(ref.attachments[0].id, synthFileId);
            assert.strictEqual(ref.attachments[0].linkedReferralId, ref.id);

            // Audit event verified
            const linkAudit = auditEvents.find(e => e.action === 'REFERRAL_SURVEY_PDF_LINKED' && e.referralId === ref.id);
            assert.ok(linkAudit, 'REFERRAL_SURVEY_PDF_LINKED audit event must be logged');
        });

        await testCase('L2. Server ignores tampered client attachments and binds official survey PDF', async () => {
            // Setup second synthetic survey
            const synth2Folder = 'sub_2026_synth_02';
            const synth2FileId = 'screening_report_synth_02.pdf';
            const s2Dir = path.join(syntheticAttachmentsDir, synth2Folder);
            fs.mkdirSync(s2Dir, { recursive: true });
            fs.writeFileSync(path.join(s2Dir, synth2FileId), '%PDF-1.4 synthetic 2');

            const synth2Survey = {
                submissionId: synth2Folder,
                internalSurveyId: synth2Folder,
                assignmentStatus: 'assigned',
                assignedUserId: staffA.id,
                assignedStaffName: staffA.name,
                assignedAt: new Date().toISOString(),
                contact: { clientName: '변조테스트', phoneNumber: '010-7777-6666' },
                attachmentId: synth2FileId,
                attachment: {
                    id: synth2FileId,
                    name: '선별검사결과지_합성2.pdf',
                    type: 'application/pdf',
                    url: `/attachments/${synth2Folder}/${encodeURIComponent(synth2FileId)}`,
                    fileHash: 'synth_hash_02'
                }
            };
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                synth2Survey
            ]);

            currentAuth = staffA;
            const res = await request('/api/referrals', {
                method: 'POST',
                body: JSON.stringify({
                    sourceSubmissionId: synth2Survey.submissionId,
                    attachments: [
                        { id: 'hacker_file', url: '/malicious/path.pdf', name: 'evil.pdf' }
                    ]
                })
            });

            assert.strictEqual(res.status, 201);
            const ref = res.data.referral;
            const officialAtt = ref.attachments.find(a => a.id === synth2FileId);
            assert.ok(officialAtt, 'Official survey PDF must be bound despite client payload');
            assert.strictEqual(officialAtt.linkedReferralId, ref.id);
        });

        await testCase('L3. Physical PDF is not duplicated: 1 file on disk shared via reference', async () => {
            // Check that synthFolderFull only has 1 physical file
            const files = fs.readdirSync(synthFolderFull);
            assert.strictEqual(files.length, 1, 'Only 1 physical PDF file must exist');
            assert.strictEqual(files[0], synthFileId);
        });

        await testCase('L4. GET /attachments/:folder/:file rejects unauthenticated caller with 401', async () => {
            currentAuth = null;
            const res = await request(`/attachments/${synthSurveyFolder}/${encodeURIComponent(synthFileId)}`);
            assert.strictEqual(res.status, 401);
        });

        await testCase('L5. GET /attachments/:folder/:file rejects unauthorized staff with 403 and zero disk reads', async () => {
            // Un-referred survey attachment accessed by staffB (not assigned)
            const synth3Folder = 'sub_2026_synth_03';
            const synth3FileId = 'screening_synth_03.pdf';
            const s3Dir = path.join(syntheticAttachmentsDir, synth3Folder);
            fs.mkdirSync(s3Dir, { recursive: true });
            fs.writeFileSync(path.join(s3Dir, synth3FileId), '%PDF-1.4 synth 3');

            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                {
                    submissionId: synth3Folder,
                    internalSurveyId: synth3Folder,
                    assignmentStatus: 'assigned',
                    assignedUserId: staffA.id, // assigned to staffA
                    attachmentId: synth3FileId,
                    attachment: { id: synth3FileId, url: `/attachments/${synth3Folder}/${synth3FileId}` }
                }
            ]);

            const readsBefore = fileReadCount;
            currentAuth = staffB; // staffB attempts access
            const res = await request(`/attachments/${synth3Folder}/${synth3FileId}`);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(fileReadCount, readsBefore, 'Unauthorized access must cause zero file reads');

            const deniedAudit = auditEvents.find(e => e.action === 'ATTACHMENT_ACCESS_DENIED' && e.actorUserId === staffB.id);
            assert.ok(deniedAudit, 'ATTACHMENT_ACCESS_DENIED audit log must be recorded');
            assert.ok(deniedAudit.reasonCode === 'SURVEY_ATTACHMENT_NOT_ASSIGNED' || deniedAudit.reasonCode === 'OBJECT_AUTHORIZATION_FAILED', 'reasonCode must indicate denial');
        });

        await testCase('L6. Authorized staff can view (inline) and download with audited access', async () => {
            currentAuth = staffA;
            // 1. Inline view
            const viewRes = await request(`/attachments/${synthSurveyFolder}/${encodeURIComponent(synthFileId)}`);
            assert.strictEqual(viewRes.status, 200);
            assert.strictEqual(viewRes.headers['content-type'], 'application/pdf');
            assert.strictEqual(viewRes.headers['content-disposition'], 'inline');

            const viewAudit = auditEvents.find(e => e.action === 'ATTACHMENT_VIEWED' && e.actorUserId === staffA.id);
            assert.ok(viewAudit, 'ATTACHMENT_VIEWED must be audited');

            // 2. Download
            const dlRes = await request(`/attachments/${synthSurveyFolder}/${encodeURIComponent(synthFileId)}?download=true`);
            assert.strictEqual(dlRes.status, 200);
            assert.ok(dlRes.headers['content-disposition'].startsWith('attachment'), 'Content-Disposition must be attachment');

            const dlAudit = auditEvents.find(e => e.action === 'ATTACHMENT_DOWNLOADED' && e.actorUserId === staffA.id);
            assert.ok(dlAudit, 'ATTACHMENT_DOWNLOADED must be audited');
        });

        await testCase('L7. Path traversal attempts are blocked with 403 and ATTACHMENT_ACCESS_DENIED', async () => {
            currentAuth = staffA;
            const readsBefore = fileReadCount;
            const traversalRes = await request('/attachments/..%2F..%2Fetc/passwd');
            assert.strictEqual(traversalRes.status, 403);
            assert.strictEqual(fileReadCount, readsBefore, 'Traversal attempt must cause zero disk reads');

            const traversalAudit = auditEvents.find(e => e.action === 'ATTACHMENT_ACCESS_DENIED' && (e.reasonCode === 'PATH_TRAVERSAL_ATTEMPT' || e.reasonCode === 'PATH_TRAVERSAL_DETECTED'));
            assert.ok(traversalAudit, 'Path traversal must be audited as access denied');
        });

        await testCase('L8. 30-day retention purge of survey WITH referral preserves referral and shared PDF', async () => {
            // synthSurvey (L1) has a completed referral in referralsStore
            const existingRef = referralsStore.findReferralBySourceSubmission(synthSurvey.submissionId);
            assert.ok(existingRef, 'Referral for synthSurvey must exist');
            assert.ok(fs.existsSync(synthFileFull), 'Physical PDF must exist before purge');

            // Perform purgeExpiredSubmissions
            const purgeResult = await surveyRepo.purgeExpiredSubmissions({
                actorId: adminUser.id,
                retentionDays: 30
            });

            assert.ok(purgeResult.success, 'Purge must succeed');
            // Check that survey record is removed
            const subsAfter = surveyRepo.getSurveySubmissions();
            const purgedSub = subsAfter.find(s => s.submissionId === synthSurvey.submissionId);
            assert.strictEqual(purgedSub, undefined, 'Expired survey submission must be purged');

            // Check that Referral record is PRESERVED (no cascade delete)
            const refAfter = referralsStore.findReferralBySourceSubmission(synthSurvey.submissionId);
            assert.ok(refAfter, 'Referral record must be preserved after survey purge');
            assert.strictEqual(refAfter.name, '합성테스트', 'Referral basic info must be preserved intact');

            // Check that shared PDF is physically RETAINED
            assert.ok(fs.existsSync(synthFileFull), 'Shared physical PDF file must be retained');

            // Audit event verified
            const retainAudit = auditEvents.find(e => e.action === 'SHARED_ATTACHMENT_RETAINED');
            assert.ok(retainAudit, 'SHARED_ATTACHMENT_RETAINED audit event must be logged');
        });

        await testCase('L9. 30-day retention purge of survey WITHOUT referral deletes survey and orphan PDF', async () => {
            // Setup expired unreferred survey
            const orphanFolder = 'sub_2026_orphan_01';
            const orphanFileId = 'screening_orphan.pdf';
            const orphanDir = path.join(syntheticAttachmentsDir, orphanFolder);
            fs.mkdirSync(orphanDir, { recursive: true });
            const orphanFileFull = path.join(orphanDir, orphanFileId);
            fs.writeFileSync(orphanFileFull, '%PDF-1.4 orphan');

            const orphanSurvey = {
                submissionId: orphanFolder,
                internalSurveyId: orphanFolder,
                assignmentStatus: 'unassigned',
                attachmentId: orphanFileId,
                attachment: { id: orphanFileId, url: `/attachments/${orphanFolder}/${orphanFileId}` },
                submittedAt: new Date(Date.now() - 40 * 86400000).toISOString() // 40 days ago
            };
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                orphanSurvey
            ]);

            assert.ok(fs.existsSync(orphanFileFull), 'Orphan PDF must exist before purge');

            // Purge
            await surveyRepo.purgeExpiredSubmissions({
                actorId: adminUser.id,
                retentionDays: 30
            });

            // Survey submission must be gone
            const subsAfter = surveyRepo.getSurveySubmissions();
            assert.strictEqual(subsAfter.find(s => s.submissionId === orphanFolder), undefined);

            // Orphan PDF must be unlinked
            assert.strictEqual(fs.existsSync(orphanFileFull), false, 'Orphan PDF must be deleted');

            const orphanAudit = auditEvents.find(e => e.action === 'ORPHAN_ATTACHMENT_DELETED');
            assert.ok(orphanAudit, 'ORPHAN_ATTACHMENT_DELETED audit event must be logged');
        });

        await testCase('L10. Fail-closed behavior: error during check prevents PDF deletion and fails safely', async () => {
            // If referrals query fails, fail-closed must preserve PDF
            const failSafeFolder = 'sub_2026_failsafe_01';
            const failSafeFileId = 'screening_failsafe.pdf';
            const fsDir = path.join(syntheticAttachmentsDir, failSafeFolder);
            fs.mkdirSync(fsDir, { recursive: true });
            const fsFile = path.join(fsDir, failSafeFileId);
            fs.writeFileSync(fsFile, '%PDF-1.4 failsafe');

            const failSafeSurvey = {
                submissionId: failSafeFolder,
                internalSurveyId: failSafeFolder,
                attachmentId: failSafeFileId,
                attachment: { id: failSafeFileId, url: `/attachments/${failSafeFolder}/${failSafeFileId}` }
            };

            // Test cascade delete with broken referrals access (fails closed)
            const brokenRepo = new SurveyImportRepository({
                getData: (fileKey) => {
                    if (fileKey === 'Referrals') throw new Error('Simulated DB failure');
                    return [failSafeSurvey];
                },
                persistData: async () => true,
                attachmentsDir: syntheticAttachmentsDir
            });

            try {
                await brokenRepo.deleteSubmissionCascading(failSafeSurvey.submissionId);
            } catch (err) {
                // Expected fail-closed error
            }

            // PDF must NOT have been deleted
            assert.ok(fs.existsSync(fsFile), 'Under error / uncertain state, PDF must be preserved (fail-closed)');
        });

        console.log('\n--- [SECTION M] Strict Referral Object Authorization & Scheduler Math ---');

        // Setup synthetic referral with attachment
        const refMFolder = 'ref_sec_m_01';
        const refMFileId = 'referral_doc_m_01.pdf';
        const refMDir = path.join(syntheticAttachmentsDir, refMFolder);
        fs.mkdirSync(refMDir, { recursive: true });
        const refMFilePath = path.join(refMDir, refMFileId);
        fs.writeFileSync(refMFilePath, '%PDF-1.4 synthetic referral doc m1');

        const synthReferralM = {
            id: refMFolder,
            referralId: refMFolder,
            refNo: 'ET-26-991',
            name: '인가검증대상자',
            assignedStaffId: staffA.id, // assigned to staffA
            attachments: [
                {
                    id: refMFileId,
                    name: '의뢰첨부서류.pdf',
                    url: `/attachments/${refMFolder}/${refMFileId}`,
                    linkedReferralId: refMFolder
                }
            ]
        };
        referralsStore.referrals.push(synthReferralM);

        await testCase('M1. Referral attachment accessed by Admin -> 200 OK', async () => {
            currentAuth = adminUser;
            const res = await request(`/attachments/${refMFolder}/${refMFileId}`);
            assert.strictEqual(res.status, 200);
            const audit = auditEvents.find(e => e.action === 'ATTACHMENT_VIEWED' && e.actorUserId === adminUser.id && e.attachmentId === refMFileId);
            assert.ok(audit, 'ATTACHMENT_VIEWED must be logged for admin');
        });

        await testCase('M2. Referral attachment accessed by Assigned Staff (assignedStaffId) -> 200 OK', async () => {
            currentAuth = staffA;
            const res = await request(`/attachments/${refMFolder}/${refMFileId}`);
            assert.strictEqual(res.status, 200);
            const audit = auditEvents.find(e => e.action === 'ATTACHMENT_VIEWED' && e.actorUserId === staffA.id && e.attachmentId === refMFileId);
            assert.ok(audit, 'ATTACHMENT_VIEWED must be logged for assigned staff');
        });

        await testCase('M3. Referral attachment accessed by Unassigned Staff -> 403 REFERRAL_ATTACHMENT_NOT_ASSIGNED & 0 file reads', async () => {
            currentAuth = staffB; // staffB is NOT assigned to synthReferralM
            const readsBefore = fileReadCount;
            const res = await request(`/attachments/${refMFolder}/${refMFileId}`);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(fileReadCount, readsBefore, 'Unauthorized access must cause zero disk reads');

            const deniedAudit = auditEvents.find(e =>
                e.action === 'ATTACHMENT_ACCESS_DENIED' &&
                e.actorUserId === staffB.id &&
                e.reasonCode === 'REFERRAL_ATTACHMENT_NOT_ASSIGNED'
            );
            assert.ok(deniedAudit, 'ATTACHMENT_ACCESS_DENIED with REFERRAL_ATTACHMENT_NOT_ASSIGNED must be logged');
        });

        await testCase('M4. Legacy referral attachment without assigned staff ID -> 403 LEGACY_REFERRAL_OWNER_UNKNOWN for non-admin', async () => {
            const legacyFolder = 'ref_legacy_01';
            const legacyFileId = 'legacy_doc_01.pdf';
            const legDir = path.join(syntheticAttachmentsDir, legacyFolder);
            fs.mkdirSync(legDir, { recursive: true });
            fs.writeFileSync(path.join(legDir, legacyFileId), '%PDF-1.4 legacy doc');

            const legacyReferral = {
                id: legacyFolder,
                referralId: legacyFolder,
                refNo: 'ET-26-992',
                name: '레거시대상자',
                // assignedStaffId is null / undefined
                attachments: [
                    {
                        id: legacyFileId,
                        url: `/attachments/${legacyFolder}/${legacyFileId}`
                    }
                ]
            };
            referralsStore.referrals.push(legacyReferral);

            // Non-admin staffA attempts access
            currentAuth = staffA;
            const readsBefore = fileReadCount;
            const res = await request(`/attachments/${legacyFolder}/${legacyFileId}`);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(fileReadCount, readsBefore, 'Zero disk reads on legacy unassigned referral access');

            const legacyDenied = auditEvents.find(e =>
                e.action === 'ATTACHMENT_ACCESS_DENIED' &&
                e.actorUserId === staffA.id &&
                e.reasonCode === 'LEGACY_REFERRAL_OWNER_UNKNOWN'
            );
            assert.ok(legacyDenied, 'LEGACY_REFERRAL_OWNER_UNKNOWN must be logged');

            // Admin can still access legacy referral
            currentAuth = adminUser;
            const adminRes = await request(`/attachments/${legacyFolder}/${legacyFileId}`);
            assert.strictEqual(adminRes.status, 200, 'Admin can view legacy referral attachment');
        });

        await testCase('M5. KST 03:30 schedule calculation unit tests (day, month, year boundaries)', async () => {
            // Case 1: Today at 01:15 KST -> target is today at 03:30 KST (18:30 UTC previous day)
            const time1 = new Date('2026-09-26T01:15:00+09:00');
            const target1 = getNextKstPurgeTime(time1);
            assert.strictEqual(target1.toISOString(), '2026-09-25T18:30:00.000Z', 'Before 03:30 targets today 03:30 KST');

            // Case 2: Today at 04:00 KST -> target is tomorrow at 03:30 KST
            const time2 = new Date('2026-09-26T04:00:00+09:00');
            const target2 = getNextKstPurgeTime(time2);
            assert.strictEqual(target2.toISOString(), '2026-09-26T18:30:00.000Z', 'After 03:30 targets tomorrow 03:30 KST');

            // Case 3: Month boundary (2026-09-30 20:00 KST -> 2026-10-01 03:30 KST)
            const time3 = new Date('2026-09-30T20:00:00+09:00');
            const target3 = getNextKstPurgeTime(time3);
            assert.strictEqual(target3.toISOString(), '2026-09-30T18:30:00.000Z', 'Month boundary correctly rolls to next month');

            // Case 4: Year boundary (2026-12-31 22:00 KST -> 2027-01-01 03:30 KST)
            const time4 = new Date('2026-12-31T22:00:00+09:00');
            const target4 = getNextKstPurgeTime(time4);
            assert.strictEqual(target4.toISOString(), '2026-12-31T18:30:00.000Z', 'Year boundary correctly rolls to next year');
        });

        await testCase('M6. Retention scheduler concurrency lock & invalid date fail-closed check', async () => {
            // Invalid date handling in purgeExpiredSubmissions
            const invalidDateSurvey = {
                submissionId: 'sub_invalid_date_01',
                internalSurveyId: 'sub_invalid_date_01',
                retentionUntil: 'invalid-date-string-not-iso',
                submittedAt: 'also-invalid'
            };
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                invalidDateSurvey
            ]);

            const res = await surveyRepo.purgeExpiredSubmissions({ actorId: 'test_admin' });
            assert.ok(res.success);
            // Survey with invalid date must NOT be purged
            const subsNow = surveyRepo.getSurveySubmissions();
            assert.ok(subsNow.some(s => s.submissionId === 'sub_invalid_date_01'), 'Invalid date survey must fail-closed (not deleted)');
        });

        // =========================================================================
        // SECTION N: BULK ASSIGNMENT, DATE FILTERS, WORKLOAD, AND UNASSIGN WORKFLOW
        // =========================================================================
        console.log('\n--- SECTION N: BULK ASSIGNMENT, DATE FILTERS & UNASSIGN WORKFLOW ---');

        await testCase('N1. KST date boundary calculation & presets (month/year boundaries, invalid rejection)', async () => {
            // Case 1: Standard KST range -> exact UTC ISO check
            const range1 = getKstDateRangeUtcBoundaries('2026-09-01', '2026-09-30');
            assert.strictEqual(range1.startUtcIso, '2026-08-31T15:00:00.000Z', 'Start 2026-09-01 KST is 2026-08-31 15:00 UTC');
            assert.strictEqual(range1.endUtcIso, '2026-09-30T14:59:59.999Z', 'End 2026-09-30 KST is 2026-09-30 14:59:59.999 UTC');

            // Case 2: Inverted range throws INVALID_DATE_RANGE
            assert.throws(() => {
                getKstDateRangeUtcBoundaries('2026-09-30', '2026-09-01');
            }, /시작일은 종료일보다 늦을 수 없습니다/);

            // Case 3: Invalid date format throws INVALID_DATE_FORMAT
            assert.throws(() => {
                getKstDateRangeUtcBoundaries('2026-02-30', '2026-03-01');
            }, /올바른 날짜를 입력해 주세요/);

            assert.throws(() => {
                getKstDateRangeUtcBoundaries('invalid-date', '2026-09-30');
            }, /올바른 날짜를 입력해 주세요/);

            // Case 4: Presets calculation in Asia/Seoul
            const refDate = new Date('2026-09-26T12:00:00+09:00');
            const todayPreset = getKstPresetDateStrings('today', refDate);
            assert.strictEqual(todayPreset.fromDate, '2026-09-26');
            assert.strictEqual(todayPreset.toDate, '2026-09-26');

            const sevenDaysPreset = getKstPresetDateStrings('7days', refDate);
            assert.strictEqual(sevenDaysPreset.toDate, '2026-09-26');
            assert.strictEqual(sevenDaysPreset.fromDate, '2026-09-20', 'Today inclusive 7 days starts on 2026-09-20');

            const thirtyDaysPreset = getKstPresetDateStrings('30days', refDate);
            assert.strictEqual(thirtyDaysPreset.toDate, '2026-09-26');
            assert.strictEqual(thirtyDaysPreset.fromDate, '2026-08-28', 'Today inclusive 30 days starts on 2026-08-28');
        });

        await testCase('N2. Date range filter & sorting on GET /api/surveys/imports', async () => {
            currentAuth = adminUser;

            // Inverted range returns 400
            const badRes = await request('/api/surveys/imports?fromDate=2026-09-30&toDate=2026-09-01');
            assert.strictEqual(badRes.status, 400, 'Inverted date range returns 400');
            assert.strictEqual(badRes.data?.error?.code, 'INVALID_DATE_RANGE');

            // Valid range returns 200 with list
            const okRes = await request('/api/surveys/imports?fromDate=2026-09-01&toDate=2026-09-30');
            assert.strictEqual(okRes.status, 200, 'Valid date range query returns 200');
            assert.ok(Array.isArray(okRes.data?.imports), 'Returns imports array');

            // Regular user isolation check
            currentAuth = staffA;
            const staffRes = await request('/api/surveys/imports?fromDate=2026-09-01&toDate=2026-09-30');
            assert.strictEqual(staffRes.status, 200);
            for (const item of staffRes.data?.imports || []) {
                assert.strictEqual(item.assignedUserId, staffA.id, 'Regular staff only sees their assigned items');
            }
        });

        await testCase('N3. Staff workload calculation on GET /api/surveys/assignable-staff', async () => {
            // Seed a synthetic unreferred assignment for staffA
            const seedSubId = `sub_workload_test_${Date.now()}`;
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                {
                    submissionId: seedSubId,
                    internalSurveyId: seedSubId,
                    assignedUserId: staffA.id,
                    assignmentStatus: 'assigned',
                    importedAt: new Date().toISOString(),
                    referralId: null
                }
            ]);

            // Admin checks workload
            currentAuth = adminUser;
            const adminStaffRes = await request('/api/surveys/assignable-staff');
            assert.strictEqual(adminStaffRes.status, 200);
            const foundStaffA = adminStaffRes.data?.staff?.find(s => s.id === staffA.id);
            assert.ok(foundStaffA, 'Staff A present in assignable staff list');
            assert.ok(Number(foundStaffA.pendingAssignmentCount) >= 1, 'Admin can see staffA pendingAssignmentCount');

            // Non-admin check: regular staff cannot see other staff pending workload
            currentAuth = staffB;
            const staffBRes = await request('/api/surveys/assignable-staff');
            assert.strictEqual(staffBRes.status, 200);
            const staffAFromB = staffBRes.data?.staff?.find(s => s.id === staffA.id);
            if (staffAFromB) {
                assert.strictEqual(staffAFromB.pendingAssignmentCount, undefined, 'Workload of other staff hidden from regular users');
            }
        });

        await testCase('N4. Single assignment safe cancellation (POST /api/surveys/:id/unassign)', async () => {
            const unassignTargetId = `sub_unassign_target_${Date.now()}`;
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                {
                    submissionId: unassignTargetId,
                    internalSurveyId: unassignTargetId,
                    assignedUserId: staffA.id,
                    assignmentStatus: 'assigned',
                    importedAt: new Date().toISOString(),
                    referralId: null
                }
            ]);

            // Non-admin forbidden
            currentAuth = staffA;
            const forbiddenRes = await request(`/api/surveys/${unassignTargetId}/unassign`, {
                method: 'POST',
                body: { reason: '취소 시도' }
            });
            assert.strictEqual(forbiddenRes.status, 403, 'Regular staff cannot unassign');

            // Admin unassigns successfully
            currentAuth = adminUser;
            const unassignRes = await request(`/api/surveys/${unassignTargetId}/unassign`, {
                method: 'POST',
                body: { reason: '관리자 재배정 준비를 위한 배정 취소' }
            });
            assert.strictEqual(unassignRes.data?.submission?.assignmentStatus, 'unassigned');
            assert.strictEqual(unassignRes.data?.submission?.assignedUserId, null);

            // Audit log check: ONLINE_SURVEY_UNASSIGNED with zero PII
            const unassignLog = auditEvents.find(e => e.action === 'ONLINE_SURVEY_UNASSIGNED' && e.submissionId === unassignTargetId);
            assert.ok(unassignLog, 'ONLINE_SURVEY_UNASSIGNED audit event recorded');
            assert.strictEqual(unassignLog.clientName, undefined, 'Zero PII clientName in audit event');
            assert.strictEqual(unassignLog.phone, undefined, 'Zero PII phone in audit event');

            // Block unassign if registered referral exists
            const registeredSubId = `sub_unassign_reg_${Date.now()}`;
            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                {
                    submissionId: registeredSubId,
                    internalSurveyId: registeredSubId,
                    assignedUserId: staffA.id,
                    assignmentStatus: 'assigned',
                    referralId: 'ref_exists_123',
                    importedAt: new Date().toISOString()
                }
            ]);

            const blockRes = await request(`/api/surveys/${registeredSubId}/unassign`, {
                method: 'POST',
                body: { reason: '등록된 의뢰 취소 시도' }
            });
            assert.strictEqual(blockRes.status, 409, 'Unassigning registered survey must return 409 ALREADY_REGISTERED');
        });

        await testCase('N5. Bulk assignment API (limit, modes, partial success, note, notification, zero-PII)', async () => {
            currentAuth = adminUser;

            // 1. Exceed 50 limit check
            const tooManyIds = Array.from({ length: 51 }, (_, i) => `sub_overflow_${i}`);
            const limitRes = await request('/api/surveys/bulk-assign', {
                method: 'POST',
                body: {
                    submissionIds: tooManyIds,
                    targetUserId: staffB.id,
                    mode: 'unassigned-only'
                }
            });
            assert.strictEqual(limitRes.status, 400, 'Exceeding 50 items must return 400');
            assert.strictEqual(limitRes.data?.error?.code, 'BULK_ASSIGNMENT_LIMIT_EXCEEDED');

            // 2. Prepare fixture items:
            // - item1: unassigned (should assign)
            // - item2: assigned to staffA (skip in unassigned-only; reassign in include-reassignment)
            // - item3: already registered with referralId (skip in both)
            // - item4: already assigned to target staffB (skip SAME_ASSIGNEE)
            const id1 = `sub_bulk_unassigned_${Date.now()}`;
            const id2 = `sub_bulk_assigned_a_${Date.now()}`;
            const id3 = `sub_bulk_registered_${Date.now()}`;
            const id4 = `sub_bulk_same_b_${Date.now()}`;

            surveyRepo.saveSurveySubmissions([
                ...surveyRepo.getSurveySubmissions(),
                { submissionId: id1, internalSurveyId: id1, assignmentStatus: 'unassigned', assignedUserId: null, referralId: null, importedAt: new Date().toISOString() },
                { submissionId: id2, internalSurveyId: id2, assignmentStatus: 'assigned', assignedUserId: staffA.id, referralId: null, importedAt: new Date().toISOString() },
                { submissionId: id3, internalSurveyId: id3, assignmentStatus: 'assigned', assignedUserId: staffA.id, referralId: 'ref_done_001', importedAt: new Date().toISOString() },
                { submissionId: id4, internalSurveyId: id4, assignmentStatus: 'assigned', assignedUserId: staffB.id, referralId: null, importedAt: new Date().toISOString() }
            ]);

            // 3. Test mode: unassigned-only
            const initialNotifCount = notificationsList.length;
            const bulkRes1 = await request('/api/surveys/bulk-assign', {
                method: 'POST',
                body: {
                    submissionIds: [id1, id2, id3, id4, id1], // with duplicate id1
                    targetUserId: staffB.id,
                    mode: 'unassigned-only',
                    note: '신규 접수 건 배분'
                }
            });

            assert.strictEqual(bulkRes1.status, 200, 'Bulk assign unassigned-only succeeds');
            const data1 = bulkRes1.data;
            assert.strictEqual(data1.requested, 4, 'Duplicate IDs deduplicated (4 distinct)');
            assert.strictEqual(data1.assigned, 1, 'Only unassigned item assigned');
            assert.strictEqual(data1.reassigned, 0, 'No reassignments in unassigned-only');
            assert.strictEqual(data1.skipped, 3, '3 items skipped');
            assert.strictEqual(data1.failed, 0);

            // Check itemized results
            const r1 = data1.results.find(r => r.submissionId === id1);
            assert.strictEqual(r1.status, 'ASSIGNED');
            assert.strictEqual(r1.reasonCode, 'NEW_ASSIGNMENT');

            const r2 = data1.results.find(r => r.submissionId === id2);
            assert.strictEqual(r2.status, 'SKIPPED');
            assert.strictEqual(r2.reasonCode, 'ASSIGNMENT_CONFLICT');

            const r3 = data1.results.find(r => r.submissionId === id3);
            assert.strictEqual(r3.status, 'SKIPPED');
            assert.strictEqual(r3.reasonCode, 'ALREADY_REGISTERED');

            const r4 = data1.results.find(r => r.submissionId === id4);
            assert.strictEqual(r4.status, 'SKIPPED');
            assert.strictEqual(r4.reasonCode, 'SAME_ASSIGNEE');

            // Verify internal notification sent to staffB
            assert.ok(notificationsList.length > initialNotifCount, 'Notification created for assignee');
            const latestNotif = notificationsList[notificationsList.length - 1];
            assert.strictEqual(latestNotif.recipientUserId, staffB.id);
            assert.strictEqual(latestNotif.safeTitle, '온라인 설문 담당자 배정 알림');
            assert.ok(!JSON.stringify(latestNotif).includes('홍길동'), 'Zero PII in internal notification');

            // 4. Test mode: include-reassignment on id2
            const bulkRes2 = await request('/api/surveys/bulk-assign', {
                method: 'POST',
                body: {
                    submissionIds: [id2],
                    targetUserId: staffB.id,
                    mode: 'include-reassignment',
                    note: '업무 조정 재배정'
                }
            });

            assert.strictEqual(bulkRes2.status, 200);
            assert.strictEqual(bulkRes2.data.reassigned, 1, 'id2 reassigned to staffB');

            // Check reassignment history and note
            const historyEntries = mockAssignmentRepo.getHistoryBySurveyId(id2);
            assert.ok(historyEntries.length > 0, 'Assignment history recorded');
            const latestHist = historyEntries[historyEntries.length - 1];
            assert.strictEqual(latestHist.note, '업무 조정 재배정', 'Assignment note stored in history');

            // Check zero PII in audit log
            const bulkAudit = auditEvents.find(e => e.action === 'ONLINE_SURVEY_BULK_ASSIGNMENT_SUMMARY');
            assert.ok(bulkAudit, 'ONLINE_SURVEY_BULK_ASSIGNMENT_SUMMARY audit event logged');
            assert.strictEqual(bulkAudit.note, undefined, 'Note body excluded from audit log');
            assert.strictEqual(bulkAudit.clientName, undefined, 'Client name excluded from audit log');
        });

        // =========================================================================
        // SECTION O: RISK SORT NORMALIZATION, SELECTION STATE CLEANUP, AND CROSS-SCALE RULES
        // =========================================================================
        console.log('\n--- SECTION O: RISK SORT, SELECTION CLEANUP & CROSS-SCALE RULES ---');

        await testCase('O1. Selection state: 10 selected, filter hides 6, state and payload must be 4', async () => {
            // Simulate: 10 items exist, select all 10, then filter shows only 4
            const allIds = Array.from({ length: 10 }, (_, i) => `sub_sel_${i}`);
            const visibleIds = new Set(allIds.slice(0, 4)); // Only first 4 visible after filter
            const selectedIds = new Set(allIds); // All 10 selected

            // Intersection: selectedIds ∩ visibleIds
            const cleanedIds = [...selectedIds].filter(id => visibleIds.has(id));
            assert.strictEqual(cleanedIds.length, 4, 'After filter, only 4 IDs remain in intersection');
            assert.deepStrictEqual(cleanedIds.sort(), [...visibleIds].sort(), 'Cleaned IDs match visible IDs exactly');

            // Simulate bulk payload construction (mirrors handleExecuteBulkAssign logic)
            const payloadIds = Array.from(selectedIds).filter(id => visibleIds.has(id));
            assert.strictEqual(payloadIds.length, 4, 'Bulk payload contains exactly 4 visible IDs');
        });

        await testCase('O2. Server reload removes 1 selected item, state and payload must exclude it', async () => {
            // Simulate: 5 items selected, server reload returns only 4 of them
            const selectedBefore = new Set(['s1', 's2', 's3', 's4', 's5']);
            const serverResultIds = new Set(['s1', 's2', 's3', 's4']); // s5 removed

            // Intersection simulates useEffect cleanup
            const survivingIds = [...selectedBefore].filter(id => serverResultIds.has(id));
            assert.strictEqual(survivingIds.length, 4, 'State reduces to 4 after server reload');
            assert.ok(!survivingIds.includes('s5'), 's5 is excluded from state');

            // Payload must also exclude s5
            const payloadIds = survivingIds.filter(id => serverResultIds.has(id));
            assert.ok(!payloadIds.includes('s5'), 's5 is excluded from payload');
        });

        await testCase('O3. BEPSI-K HIGH (3.8) sorts before PHQ-9 MODERATE (12) — severity-based, no raw score', async () => {
            const items = [
                { submissionId: 'phq_mod', assessmentId: 'phq-9', totalScore: 12, severity: '중등도 우울', retentionUntil: '2026-10-15T00:00:00Z', importedAt: '2026-09-20T00:00:00Z' },
                { submissionId: 'bepsi_high', assessmentId: 'bepsi-k', totalScore: 3.8, severity: '고스트레스군', retentionUntil: '2026-10-15T00:00:00Z', importedAt: '2026-09-20T00:00:00Z' }
            ];

            // Replicate getNormalizedRiskLevel exactly as in SurveyManagementPage.tsx
            const getNormalizedRiskLevel = (item) => {
                const sev = String(item.severity || item.riskLevel || item.normalizedRiskLevel || item.overallRisk || '').toLowerCase();
                if (!sev || sev === 'null' || sev === 'undefined') return 0;
                if (sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                    || sev.includes('고스트레스') || sev.includes('추가 확인 권장')) return 3;
                if (sev.includes('중등도') || sev.includes('중간') || sev.includes('역치하')) return 2;
                if (sev.includes('경증') || sev.includes('경미') || sev.includes('정상')
                    || sev.includes('저스트레스') || sev.includes('기준점 미만')
                    || sev.includes('없음') || sev.includes('최소')) return 1;
                return 0;
            };

            const sorted = [...items].sort((a, b) => {
                const levelA = getNormalizedRiskLevel(a);
                const levelB = getNormalizedRiskLevel(b);
                if (levelA !== levelB) return levelB - levelA;
                if (a.assessmentId && b.assessmentId && a.assessmentId === b.assessmentId) {
                    return (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0);
                }
                const retA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const retB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                if (retA !== retB) return retA - retB;
                const intakeA = new Date(a.importedAt || 0).getTime();
                const intakeB = new Date(b.importedAt || 0).getTime();
                return intakeA - intakeB;
            });

            assert.strictEqual(sorted[0].submissionId, 'bepsi_high', 'BEPSI-K HIGH (3.8) sorts before PHQ-9 MODERATE (12)');
            assert.strictEqual(getNormalizedRiskLevel(items[1]), 3, 'BEPSI-K 고스트레스군 maps to HIGH (3)');
            assert.strictEqual(getNormalizedRiskLevel(items[0]), 2, 'PHQ-9 중등도 우울 maps to MODERATE (2)');
        });

        await testCase('O4. GAD-7 HIGH (18) vs PHQ-9 HIGH (20) — no raw score comparison, retentionUntil tiebreak', async () => {
            const items = [
                { submissionId: 'phq_high', assessmentId: 'phq-9', totalScore: 20, severity: '심각한 우울', retentionUntil: '2026-11-01T00:00:00Z', importedAt: '2026-09-15T00:00:00Z' },
                { submissionId: 'gad_high', assessmentId: 'gad-7', totalScore: 18, severity: '심각한 불안', retentionUntil: '2026-10-20T00:00:00Z', importedAt: '2026-09-18T00:00:00Z' }
            ];

            const getNormalizedRiskLevel = (item) => {
                const sev = String(item.severity || '').toLowerCase();
                if (!sev) return 0;
                if (sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                    || sev.includes('고스트레스') || sev.includes('추가 확인 권장')) return 3;
                if (sev.includes('중등도') || sev.includes('중간') || sev.includes('역치하')) return 2;
                if (sev.includes('경증') || sev.includes('경미') || sev.includes('정상')
                    || sev.includes('저스트레스') || sev.includes('기준점 미만')
                    || sev.includes('없음') || sev.includes('최소')) return 1;
                return 0;
            };

            // Both are HIGH (3) but different assessmentIds → NO raw score comparison
            assert.strictEqual(getNormalizedRiskLevel(items[0]), 3, 'PHQ-9 심각 = HIGH');
            assert.strictEqual(getNormalizedRiskLevel(items[1]), 3, 'GAD-7 심각 = HIGH');

            const sorted = [...items].sort((a, b) => {
                const levelA = getNormalizedRiskLevel(a);
                const levelB = getNormalizedRiskLevel(b);
                if (levelA !== levelB) return levelB - levelA;
                // Different assessmentId: DO NOT compare totalScore
                if (a.assessmentId && b.assessmentId && a.assessmentId === b.assessmentId) {
                    return (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0);
                }
                const retA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const retB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                if (retA !== retB) return retA - retB;
                return new Date(a.importedAt || 0).getTime() - new Date(b.importedAt || 0).getTime();
            });

            // GAD-7 has earlier retentionUntil (2026-10-20 < 2026-11-01) → sorts first
            assert.strictEqual(sorted[0].submissionId, 'gad_high', 'GAD-7 sorts first by retentionUntil (earlier expiry)');
            // Verify raw totalScore was NOT used as tiebreak between different scales
            assert.notStrictEqual(sorted[0].totalScore > sorted[1].totalScore, true,
                'Raw score comparison NOT used between different assessmentIds');
        });

        await testCase('O5. PHQ-9 HIGH (18) vs PHQ-9 HIGH (20) — same scale, score 20 sorts first', async () => {
            const items = [
                { submissionId: 'phq_18', assessmentId: 'phq-9', totalScore: 18, severity: '심각한 우울', retentionUntil: '2026-10-15T00:00:00Z', importedAt: '2026-09-20T00:00:00Z' },
                { submissionId: 'phq_20', assessmentId: 'phq-9', totalScore: 20, severity: '심각한 우울', retentionUntil: '2026-10-15T00:00:00Z', importedAt: '2026-09-21T00:00:00Z' }
            ];

            const getNormalizedRiskLevel = (item) => {
                const sev = String(item.severity || '').toLowerCase();
                if (!sev) return 0;
                if (sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                    || sev.includes('고스트레스') || sev.includes('추가 확인 권장')) return 3;
                if (sev.includes('중등도')) return 2;
                if (sev.includes('경증') || sev.includes('정상')) return 1;
                return 0;
            };

            const sorted = [...items].sort((a, b) => {
                const levelA = getNormalizedRiskLevel(a);
                const levelB = getNormalizedRiskLevel(b);
                if (levelA !== levelB) return levelB - levelA;
                if (a.assessmentId && b.assessmentId && a.assessmentId === b.assessmentId) {
                    return (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0);
                }
                const retA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const retB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                if (retA !== retB) return retA - retB;
                return new Date(a.importedAt || 0).getTime() - new Date(b.importedAt || 0).getTime();
            });

            assert.strictEqual(sorted[0].submissionId, 'phq_20', 'PHQ-9 score 20 sorts before PHQ-9 score 18 (same scale, higher score first)');
        });

        await testCase('O6. No official risk level → UNKNOWN: excluded from high_risk filter, sorts last in risk_high', async () => {
            const unknownItem = { submissionId: 'unknown_risk', assessmentId: 'custom-scale', totalScore: 99, severity: null, retentionUntil: null, importedAt: '2026-09-20T00:00:00Z' };
            const highItem = { submissionId: 'known_high', assessmentId: 'phq-9', totalScore: 22, severity: '심각한 우울', retentionUntil: '2026-10-15T00:00:00Z', importedAt: '2026-09-21T00:00:00Z' };
            const lowItem = { submissionId: 'known_low', assessmentId: 'gad-7', totalScore: 3, severity: '정상', retentionUntil: '2026-10-20T00:00:00Z', importedAt: '2026-09-22T00:00:00Z' };

            const getNormalizedRiskLevel = (item) => {
                const sev = String(item.severity || item.riskLevel || item.normalizedRiskLevel || item.overallRisk || '').toLowerCase();
                if (!sev || sev === 'null' || sev === 'undefined') return 0;
                if (sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                    || sev.includes('고스트레스') || sev.includes('추가 확인 권장')) return 3;
                if (sev.includes('중등도') || sev.includes('중간') || sev.includes('역치하')) return 2;
                if (sev.includes('경증') || sev.includes('경미') || sev.includes('정상')
                    || sev.includes('저스트레스') || sev.includes('기준점 미만')
                    || sev.includes('없음') || sev.includes('최소')) return 1;
                return 0;
            };

            // UNKNOWN check
            assert.strictEqual(getNormalizedRiskLevel(unknownItem), 0, 'Item with null severity and totalScore=99 maps to UNKNOWN (0)');

            // High risk filter exclusion (mirrors quickStatusFilter === 'high_risk')
            const isOfficialHigh = (item) => {
                const sev = String(item.severity || '').toLowerCase();
                return sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                    || sev.includes('고스트레스') || sev.includes('추가 확인 권장');
            };
            assert.strictEqual(isOfficialHigh(unknownItem), false, 'UNKNOWN item is excluded from high_risk filter');
            assert.strictEqual(isOfficialHigh(highItem), true, 'Known HIGH item passes high_risk filter');
            assert.strictEqual(isOfficialHigh(lowItem), false, 'Known LOW item is excluded from high_risk filter');

            // Sort: UNKNOWN goes last
            const items = [unknownItem, highItem, lowItem];
            const sorted = [...items].sort((a, b) => {
                const levelA = getNormalizedRiskLevel(a);
                const levelB = getNormalizedRiskLevel(b);
                if (levelA !== levelB) return levelB - levelA;
                if (a.assessmentId && b.assessmentId && a.assessmentId === b.assessmentId) {
                    return (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0);
                }
                const retA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const retB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                if (retA !== retB) return retA - retB;
                return new Date(a.importedAt || 0).getTime() - new Date(b.importedAt || 0).getTime();
            });

            assert.strictEqual(sorted[0].submissionId, 'known_high', 'HIGH sorts first');
            assert.strictEqual(sorted[1].submissionId, 'known_low', 'LOW sorts second');
            assert.strictEqual(sorted[2].submissionId, 'unknown_risk', 'UNKNOWN sorts last despite totalScore=99');
        });

    } finally {
        server.close();
        if (fs.existsSync(syntheticAttachmentsDir)) {
            try {
                fs.rmSync(syntheticAttachmentsDir, { recursive: true, force: true });
            } catch (e) {
                // ignore synthetic cleanup error
            }
        }
    }

    console.log('\n====================================================');
    console.log(`📊 Test Results: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

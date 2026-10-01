/**
 * scripts/verify-survey-staff-visibility.mjs
 * Verification suite for Survey Staff Visibility & Role-Based Access Controls.
 *
 * Verifies:
 * 1. Admin A list and detail access
 * 2. Staff B full list visibility (same count as Admin A)
 * 3. Staff B views surveys synced by Admin A (importedBy !== B)
 * 4. Staff B views surveys assigned to other departments
 * 5. Staff B views unassigned counseling requests
 * 6. Staff B views screening completed (검사완료) submissions
 * 7. Staff B campaign filter query (S4-A)
 * 8. Staff B detail access across all submissions (no assignment isolation)
 * 9. Staff B PDF report streaming
 * 10. Staff B assignment mutation blocked with 403 (Admin-only boundary preserved)
 * 11. Unauthorized Staff C blocked with 403 on list, detail, and sync
 * 12. Unauthenticated caller blocked with 401 on protected endpoints
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';

import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import {
    SURVEY_STORAGE_FILES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS
} from '../server/survey/surveyConstants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const scratchDir = path.resolve(projectRoot, 'scratch');

function createInMemoryStorage() {
    const memory = new Map();
    return {
        getData: (filename, defaultValue = []) => {
            if (!memory.has(filename)) {
                memory.set(filename, JSON.parse(JSON.stringify(defaultValue)));
            }
            return memory.get(filename);
        },
        persistData: async (filename, data) => {
            memory.set(filename, JSON.parse(JSON.stringify(data)));
            return true;
        },
        dump: (filename) => memory.get(filename) || []
    };
}

async function runStaffVisibilityVerification() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Survey Staff Visibility Contract Suite');
    console.log('🧪 ========================================================');

    let passedTests = 0;
    let failedTests = 0;

    const test = (name, fn) => {
        try {
            fn();
            console.log(`  ✅ PASS: ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failedTests++;
        }
    };

    const testAsync = async (name, fn) => {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failedTests++;
        }
    };

    // Prepare isolated scratch attachments directory
    if (!fs.existsSync(scratchDir)) {
        fs.mkdirSync(scratchDir, { recursive: true });
    }
    const testAttachmentsDir = fs.mkdtempSync(path.join(scratchDir, 'test-survey-vis-'));

    // Fixture Users
    const userA = {
        id: 'user-admin-a',
        username: 'admin_a',
        name: '관리자A',
        role: 'admin',
        department: '운영팀',
        team: '운영팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const userB = {
        id: 'user-staff-b',
        username: 'staff_b',
        name: '상담직원B',
        role: 'user',
        department: '상담팀',
        team: '상담팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const userC = {
        id: 'user-staff-c',
        username: 'staff_c',
        name: '무권한직원C',
        role: 'user',
        department: '행정팀',
        team: '행정팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: false }
    };

    const userOther = {
        id: 'user-other-d',
        username: 'staff_other_d',
        name: '타부서직원D',
        role: 'user',
        department: '위기개입팀',
        team: '위기개입팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const allUsers = [userA, userB, userC, userOther];

    // Fixture Submissions & Ledger
    const sub1Id = 'sub-s4a-001';
    const sub2Id = 'sub-b-002';
    const sub3Id = 'sub-other-003';

    // Create synthetic PDF file on disk for sub1
    const sub1Folder = path.join(testAttachmentsDir, sub1Id);
    fs.mkdirSync(sub1Folder, { recursive: true });
    const pdfFilename = 'survey-report-s1.pdf';
    const pdfFilePath = path.join(sub1Folder, pdfFilename);
    const mockPdfBytes = Buffer.from('%PDF-1.4 Mock PDF Stream for Mental Health Report');
    fs.writeFileSync(pdfFilePath, mockPdfBytes);

    const nowIso = new Date().toISOString();

    const campaignsFixture = [
        {
            code: 'S4-A',
            companyName: 'S4-A 협약기업',
            purpose: '2026 직장인 마음건강 실태조사',
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2026-12-31T23:59:59Z',
            createdAt: nowIso,
            updatedAt: nowIso,
            actorId: userA.id,
            isActive: true
        }
    ];

    const submissionsFixture = [
        // 1. A 동기화 · 미배정 · 상담요청 · 캠페인 S4-A 1건 + PDF 첨부
        {
            submissionId: sub1Id,
            internalSurveyId: `surv_${sub1Id}`,
            schemaVersion: 'v1.0',
            importedBy: userA.id,
            importedAt: '2026-10-01T10:00:00Z',
            submittedAt: '2026-10-01T09:50:00Z',
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationRequestedAt: '2026-10-01T09:50:00Z',
            consultationStatus: '신규접수대기',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            assignedUserId: null,
            assignedDepartmentId: null,
            campaignCode: 'S4-A',
            contact: {
                clientName: '홍길동',
                phone: '010-1111-2222',
                region: '이천시',
                counselingRequestText: '상담 희망합니다.'
            },
            assessment: {
                totalScore: 16,
                severity: '고위험군'
            },
            attachment: {
                id: pdfFilename,
                name: pdfFilename,
                type: 'application/pdf',
                url: `/attachments/${sub1Id}/${pdfFilename}`
            }
        },
        // 2. A 동기화 · B 배정 1건
        {
            submissionId: sub2Id,
            internalSurveyId: `surv_${sub2Id}`,
            schemaVersion: 'v1.0',
            importedBy: userA.id,
            importedAt: '2026-10-01T11:00:00Z',
            submittedAt: '2026-10-01T10:45:00Z',
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationRequestedAt: '2026-10-01T10:45:00Z',
            consultationStatus: '접수진행중',
            processingStatus: 'ASSIGNED',
            assignmentStatus: 'assigned',
            assignedUserId: userB.id,
            assignedDepartmentId: userB.department,
            assignedAt: '2026-10-01T11:30:00Z',
            campaignCode: null,
            contact: {
                clientName: '김철수',
                phone: '010-3333-4444',
                region: '이천시',
                counselingRequestText: '직원B 상담 대기'
            },
            assessment: {
                totalScore: 8,
                severity: '경증'
            }
        },
        // 3. 타 부서 배정 1건 (검사완료 / SCREENING_ONLY)
        {
            submissionId: sub3Id,
            internalSurveyId: `surv_${sub3Id}`,
            schemaVersion: 'v1.0',
            importedBy: userA.id,
            importedAt: '2026-10-01T12:00:00Z',
            submittedAt: '2026-10-01T11:55:00Z',
            requestType: 'SCREENING_ONLY',
            consultationRequested: false,
            consultationStatus: '검사완료',
            processingStatus: 'SCREENING_COMPLETED',
            assignmentStatus: 'assigned',
            assignedUserId: userOther.id,
            assignedDepartmentId: userOther.department,
            assignedAt: '2026-10-01T12:30:00Z',
            campaignCode: null,
            contact: {
                clientName: '이영희',
                phone: '010-5555-6666',
                region: '이천시'
            },
            assessment: {
                totalScore: 4,
                severity: '정상'
            }
        }
    ];

    const ledgerFixture = submissionsFixture.map(s => ({
        internalImportId: `imp_${s.submissionId}`,
        submissionId: s.submissionId,
        schemaVersion: s.schemaVersion,
        keyVersion: 'k2026_01',
        externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
        internalStatus: SURVEY_INTERNAL_STATUS.DOWNLOADED,
        importedAt: s.importedAt,
        receivedAt: s.submittedAt,
        importedBy: s.importedBy
    }));

    // Setup Storage & Repository
    const storage = createInMemoryStorage();
    const repo = new SurveyImportRepository({
        getData: storage.getData,
        persistData: storage.persistData,
        sourceEnvironment: 'mock',
        attachmentsDir: testAttachmentsDir
    });

    await repo.saveSurveySubmissions(submissionsFixture);
    await repo.saveImportsLedger(ledgerFixture);
    await repo.saveCampaigns(campaignsFixture);

    // Setup Express App
    const app = express();
    app.use(express.json());

    let currentAuthUser = null;
    const authMiddleware = (req, res, next) => {
        if (currentAuthUser) {
            req.auth = { ...currentAuthUser };
        } else {
            req.auth = null;
        }
        next();
    };

    const recordedAuditLogs = [];
    const auditLogger = (event) => {
        recordedAuditLogs.push(event);
    };

    const surveyRouter = createSurveyImportRouter({
        requireAuth: authMiddleware,
        surveyImportService: {
            getStatusSummary: () => ({}),
            importPendingSubmissions: async () => ({ imported: 0, failed: 0 })
        },
        surveyRepository: repo,
        getUsers: () => allUsers,
        attachmentsDir: testAttachmentsDir,
        auditLogger
    });

    app.use('/api/surveys', surveyRouter);

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const requestApi = async (pathStr, options = {}) => {
        const url = `${baseUrl}${pathStr}`;
        const headers = { ...(options.headers || {}) };
        if (options.body && typeof options.body === 'object') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        const res = await fetch(url, { ...options, headers });
        let data = null;
        let buffer = null;
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            data = await res.json().catch(() => null);
        } else if (contentType.includes('application/pdf')) {
            const ab = await res.arrayBuffer();
            buffer = Buffer.from(ab);
        } else {
            const txt = await res.text().catch(() => '');
            try { data = JSON.parse(txt); } catch { data = txt; }
        }
        return { status: res.status, headers: res.headers, data, buffer };
    };

    try {
        console.log('\n▶️ Testing 12 Visibility & Security Invariants');

        // 1. A 목록/상세 PASS
        await testAsync('1. A 목록/상세 PASS (Admin A has full list & detail access)', async () => {
            currentAuthUser = userA;

            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200, 'Admin A list returns 200');
            assert.strictEqual(listRes.data.total, 3, 'Admin A sees all 3 submissions');
            assert.strictEqual(listRes.data.imports.length, 3);

            const detail1Res = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detail1Res.status, 200, 'Admin A detail for sub1 returns 200');
            assert.strictEqual(detail1Res.data.submission.submissionId, sub1Id);

            const detail2Res = await requestApi(`/api/surveys/submissions/${sub2Id}`);
            assert.strictEqual(detail2Res.status, 200, 'Admin A detail for sub2 returns 200');

            const detail3Res = await requestApi(`/api/surveys/submissions/${sub3Id}`);
            assert.strictEqual(detail3Res.status, 200, 'Admin A detail for sub3 returns 200');
        });

        // 2. B 목록 전체 조회 PASS (건수 = A와 동일)
        await testAsync('2. B 목록 전체 조회 PASS (Staff B sees all 3 submissions, count matches Admin A)', async () => {
            currentAuthUser = userB;

            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200, 'Staff B list returns 200');
            assert.strictEqual(listRes.data.total, 3, 'Staff B sees total 3 submissions (identical to Admin A)');
            assert.strictEqual(listRes.data.imports.length, 3, 'Staff B safeList length is 3');

            const ids = listRes.data.imports.map(i => i.submissionId);
            assert.ok(ids.includes(sub1Id), 'sub1 present in B list');
            assert.ok(ids.includes(sub2Id), 'sub2 present in B list');
            assert.ok(ids.includes(sub3Id), 'sub3 present in B list');
        });

        // 3. B가 A 동기화 결과 조회 PASS (importedBy≠B 여도 표시)
        await testAsync('3. B가 A 동기화 결과 조회 PASS (Submissions synced by Admin A visible to Staff B)', async () => {
            currentAuthUser = userB;

            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200);

            const item1 = listRes.data.imports.find(i => i.submissionId === sub1Id);
            assert.ok(item1, 'Survey 1 (synced by Admin A) is visible to Staff B');

            const item2 = listRes.data.imports.find(i => i.submissionId === sub2Id);
            assert.ok(item2, 'Survey 2 (synced by Admin A) is visible to Staff B');
        });

        // 4. B 타 부서 설문 조회 PASS
        await testAsync('4. B 타 부서 설문 조회 PASS (Staff B can view Survey 3 assigned to other department)', async () => {
            currentAuthUser = userB;

            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200);

            const item3 = listRes.data.imports.find(i => i.submissionId === sub3Id);
            assert.ok(item3, 'Survey 3 assigned to other dept is present in Staff B list');
            assert.strictEqual(item3.assignedDepartmentId, '위기개입팀', 'Department is 위기개입팀');
            assert.strictEqual(item3.assignedUserId, userOther.id, 'Assigned user is userOther');
        });

        // 5. B 미배정 상담요청 조회 PASS
        await testAsync('5. B 미배정 상담요청 조회 PASS (Staff B can view unassigned counseling request Survey 1)', async () => {
            currentAuthUser = userB;

            // Check in default list
            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200);
            const item1 = listRes.data.imports.find(i => i.submissionId === sub1Id);
            assert.ok(item1, 'Unassigned Survey 1 is visible in default list');
            assert.strictEqual(item1.consultationRequested, true, 'consultationRequested is true');
            assert.strictEqual(item1.assignmentStatus, 'unassigned', 'assignmentStatus is unassigned');
            assert.strictEqual(item1.assignedUserId, null, 'assignedUserId is null');

            // Check via statusFilter=unassigned filter
            const filterRes = await requestApi('/api/surveys/imports?statusFilter=unassigned');
            assert.strictEqual(filterRes.status, 200);
            assert.strictEqual(filterRes.data.total, 1, 'Exactly 1 unassigned item found');
            assert.strictEqual(filterRes.data.imports[0].submissionId, sub1Id);
        });

        // 6. B 검사완료 조회 PASS
        await testAsync('6. B 검사완료 조회 PASS (Staff B can view completed screening survey)', async () => {
            currentAuthUser = userB;

            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200);

            const item3 = listRes.data.imports.find(i => i.submissionId === sub3Id);
            assert.ok(item3, 'Survey 3 is visible');
            assert.strictEqual(item3.consultationStatus, '검사완료', 'consultationStatus is 검사완료');
            assert.strictEqual(item3.processingStatus, 'SCREENING_COMPLETED', 'processingStatus is SCREENING_COMPLETED');
            assert.strictEqual(item3.requestType, 'SCREENING_ONLY', 'requestType is SCREENING_ONLY');
        });

        // 7. B 캠페인 필터 조회 PASS
        await testAsync('7. B 캠페인 필터 조회 PASS (Staff B can filter by campaignFilter S4-A)', async () => {
            currentAuthUser = userB;

            const campRes = await requestApi('/api/surveys/imports?campaignFilter=S4-A');
            assert.strictEqual(campRes.status, 200);
            assert.strictEqual(campRes.data.total, 1, 'Only 1 survey belongs to campaign S4-A');
            const item = campRes.data.imports[0];
            assert.strictEqual(item.submissionId, sub1Id);
            assert.strictEqual(item.campaignCode, 'S4-A');
            assert.strictEqual(item.campaignRegistrationStatus, 'REGISTERED');
            assert.strictEqual(item.campaignName, 'S4-A 협약기업');
        });

        // 8. B 상세 PASS
        await testAsync('8. B 상세 PASS (Staff B has detail access across all 3 submissions)', async () => {
            currentAuthUser = userB;

            // Sub 1: Unassigned counseling request
            const res1 = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(res1.status, 200, 'Staff B detail for unassigned sub1 returns 200 OK');
            assert.strictEqual(res1.data.submission.submissionId, sub1Id);

            // Sub 2: Assigned to B
            const res2 = await requestApi(`/api/surveys/submissions/${sub2Id}`);
            assert.strictEqual(res2.status, 200, 'Staff B detail for assigned-to-self sub2 returns 200 OK');
            assert.strictEqual(res2.data.submission.submissionId, sub2Id);

            // Sub 3: Assigned to other department
            const res3 = await requestApi(`/api/surveys/submissions/${sub3Id}`);
            assert.strictEqual(res3.status, 200, 'Staff B detail for other-dept sub3 returns 200 OK');
            assert.strictEqual(res3.data.submission.submissionId, sub3Id);

            // Verify audit logging occurred
            const detailAuditEvents = recordedAuditLogs.filter(e => e.action === 'ONLINE_SURVEY_DETAIL_VIEWED');
            assert.ok(detailAuditEvents.length >= 3, 'Audit log emitted for all 3 detail views');
            assert.strictEqual(detailAuditEvents[detailAuditEvents.length - 1].actorUserId, userB.id);
        });

        // 9. B PDF 접근 PASS
        await testAsync('9. B PDF 접근 PASS (Staff B can stream/download survey PDF report)', async () => {
            currentAuthUser = userB;

            // Via /submissions/:id/report
            const pdfRes = await requestApi(`/api/surveys/submissions/${sub1Id}/report`);
            assert.strictEqual(pdfRes.status, 200, 'Staff B PDF streaming returns 200 OK');
            assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
            assert.ok(pdfRes.buffer && pdfRes.buffer.length > 0, 'PDF buffer received');
            assert.strictEqual(pdfRes.buffer.toString(), mockPdfBytes.toString(), 'PDF content matches exactly');

            // Via /:id/report alias
            const aliasRes = await requestApi(`/api/surveys/${sub1Id}/report`);
            assert.strictEqual(aliasRes.status, 200, 'Staff B PDF via alias returns 200 OK');
            assert.strictEqual(aliasRes.headers.get('content-type'), 'application/pdf');
        });

        // 10. B 배정 API는 403 (승인 범위 = admin-only 유지)
        await testAsync('10. B 배정 API는 403 (Staff B assignment attempt rejected with 403 FORBIDDEN)', async () => {
            currentAuthUser = userB;

            const assignRes = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: { assignedUserId: userB.id }
            });

            assert.strictEqual(assignRes.status, 403, 'Non-admin staff assignment returns 403');
            assert.strictEqual(assignRes.data.error.code, 'FORBIDDEN');
            assert.ok(assignRes.data.error.message.includes('관리자'), 'Error message specifies Admin requirement');
        });

        // 11. C 목록/상세/동기화 403 PASS
        await testAsync('11. C 목록/상세/동기화 403 PASS (Unauthorized Staff C blocked on all protected endpoints)', async () => {
            currentAuthUser = userC;

            // List
            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 403, 'Unauthorized staff C list returns 403');
            assert.strictEqual(listRes.data.error.code, 'FORBIDDEN');

            // Detail
            const detailRes = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detailRes.status, 403, 'Unauthorized staff C detail returns 403');
            assert.strictEqual(detailRes.data.error.code, 'FORBIDDEN');

            // Import/Sync
            const importRes = await requestApi('/api/surveys/import', {
                method: 'POST',
                body: { limit: 5 }
            });
            assert.strictEqual(importRes.status, 403, 'Unauthorized staff C sync returns 403');
            assert.strictEqual(importRes.data.error.code, 'FORBIDDEN');
        });

        // 12. 미인증 요청 401 PASS (로그아웃 후 보호 API 호출 차단 상당)
        await testAsync('12. 미인증 요청 401 PASS (Unauthenticated requests blocked with 401 UNAUTHENTICATED)', async () => {
            currentAuthUser = null; // No authentication token/session

            // List
            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 401, 'Unauthenticated list returns 401');
            assert.strictEqual(listRes.data.error.code, 'UNAUTHENTICATED');

            // Detail
            const detailRes = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detailRes.status, 401, 'Unauthenticated detail returns 401');
            assert.strictEqual(detailRes.data.error.code, 'UNAUTHENTICATED');

            // Sync
            const syncRes = await requestApi('/api/surveys/import', {
                method: 'POST',
                body: { limit: 5 }
            });
            assert.strictEqual(syncRes.status, 401, 'Unauthenticated import returns 401');
            assert.strictEqual(syncRes.data.error.code, 'UNAUTHENTICATED');
        });

    } finally {
        server.close();
        if (fs.existsSync(testAttachmentsDir)) {
            try {
                fs.rmSync(testAttachmentsDir, { recursive: true, force: true });
            } catch (err) {
                console.warn('Attachments cleanup warning:', err.message);
            }
        }
    }

    console.log('\n========================================================');
    console.log(`📊 Summary: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
    console.log('========================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStaffVisibilityVerification().catch(err => {
    console.error('Fatal suite failure:', err);
    process.exit(1);
});

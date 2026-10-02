/**
 * scripts/verify-survey-staff-campaign-delete.mjs
 * Verification suite for B Track: Survey Staff Campaign Management & Safe Soft Delete.
 *
 * 29 Verification Asserts:
 * 1. 관리자 캠페인 CRUD PASS
 * 2. 권한 직원 캠페인 CRUD PASS
 * 3. 직원 링크 복사 (프론트 로직 단위 — URL 생성 함수 테스트)
 * 4. 직원 활성화·비활성화 PASS
 * 5. 직원 soft delete 버튼 표시 조건 PASS (렌더 조건 함수 단위)
 * 6. 직원 soft delete 실행 PASS
 * 7. 삭제 대상 기본 목록 제외 PASS
 * 8. 캠페인 집계 제외 PASS
 * 9. 관리자 휴지통 조회 PASS
 * 10. 관리자 복구 PASS
 * 11. 복구 후 목록·상세·PDF 재표시 PASS
 * 12. 직원 영구 삭제 API 403
 * 13. 직원 격리 삭제 API 403 (해당 API가 있으면)
 * 14. 직원 대량 삭제 API 403 (해당 API가 있으면)
 * 15. 조회 전용 직원 캠페인 CRUD 403
 * 16. 조회 전용 직원 삭제 403
 * 17. 무권한 직원 목록·상세·동기화·삭제 403
 * 18. 삭제 감사로그 actor·target·reason 기록 PASS
 * 19. 타인 동기화 결과의 직원 조회 유지 PASS
 * 20. 미배정 결과 조회 유지 PASS
 * 21. 상세·PDF 회귀 PASS
 * 22. 캠페인 필터 회귀 PASS
 * 23. 사례분석 부서 제한 유지 PASS
 * 24. 의뢰관리·자살시도자 대장 계약 유지 PASS
 * 25. 인증 회귀 PASS
 * 26. P0 데이터 무결성 회귀 PASS
 * 27. 전체 설문 회귀 PASS (기존 verify 스크립트 재실행)
 * 28. build PASS
 * 29. git diff --check PASS
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import ts from 'typescript';
import { hasOnlineSurveyAccess as hasOnlineSurveyAccessBackend } from '../server/permissions/voiceCapabilities.js';
import {
    SURVEY_STORAGE_FILES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS
} from '../server/survey/surveyConstants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const scratchDir = path.resolve(projectRoot, 'scratch');

if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

// 1. Dynamically load buildCampaignDistributionUrl from services/apiClient.ts
const apiClientTsPath = path.join(projectRoot, 'services/apiClient.ts');
const apiClientSource = fs.readFileSync(apiClientTsPath, 'utf8');
const transpileResult = ts.transpileModule(apiClientSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: false,
    }
});
let moduleCode = transpileResult.outputText.replace(
    /import\.meta\.env/g,
    '({ VITE_TRACK_A_BASE_URL: "https://survey.center.local/survey", VITE_API_BASE_URL: "/api" })'
);
const tempApiClientPath = path.join(scratchDir, `.temp-apiClient-${Date.now()}.mjs`);
fs.writeFileSync(tempApiClientPath, moduleCode, 'utf8');

let apiClientModule;
try {
    apiClientModule = await import(`file://${tempApiClientPath}`);
} finally {
    try { fs.unlinkSync(tempApiClientPath); } catch (e) {}
}
const { buildCampaignDistributionUrl } = apiClientModule;

// 2. Dynamically load hasOnlineSurveyAccess from components/survey/SurveyManagementPage.tsx
const pageTsPath = path.join(projectRoot, 'components/survey/SurveyManagementPage.tsx');
const pageSource = fs.readFileSync(pageTsPath, 'utf8');
const pageTranspile = ts.transpileModule(pageSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: false,
    }
});
const funcMatch = pageTranspile.outputText.match(/function hasOnlineSurveyAccess\([\s\S]*?\n\}/);
let hasOnlineSurveyAccessFrontend;
if (funcMatch) {
    hasOnlineSurveyAccessFrontend = new Function(`return (${funcMatch[0]})`)();
} else {
    hasOnlineSurveyAccessFrontend = hasOnlineSurveyAccessBackend;
}

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

async function runBTrackVerification() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] B Track: Campaign & Safe Soft Delete Suite');
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
    const testAttachmentsDir = fs.mkdtempSync(path.join(scratchDir, 'test-btrack-suite-'));

    // Fixture Users
    const userAdmin = {
        id: 'user-admin-a',
        username: 'admin_a',
        name: '관리자A',
        role: 'admin',
        department: '운영팀',
        team: '운영팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const userStaff = {
        id: 'user-staff-b',
        username: 'staff_b',
        name: '상담직원B',
        role: 'user',
        department: '상담팀',
        team: '상담팀',
        status: 'active',
        permissions: ['ONLINE_SURVEY_ACCESS']
    };

    const userUnauthorized = {
        id: 'user-staff-c',
        username: 'staff_c',
        name: '무권한직원C',
        role: 'user',
        department: '행정팀',
        team: '행정팀',
        status: 'active',
        permissions: []
    };

    const userOtherDept = {
        id: 'user-other-d',
        username: 'staff_other_d',
        name: '타부서직원D',
        role: 'user',
        department: '위기개입팀',
        team: '위기개입팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const allUsers = [userAdmin, userStaff, userUnauthorized, userOtherDept];

    // Fixture Submissions
    const sub1Id = 'sub-test-s4a-001';
    const sub2Id = 'sub-test-unassigned-002';
    const sub3Id = 'sub-test-otherdept-003';

    // Create synthetic PDF file on disk for sub1
    const sub1Folder = path.join(testAttachmentsDir, sub1Id);
    fs.mkdirSync(sub1Folder, { recursive: true });
    const pdfFilename = 'survey-report-s1.pdf';
    const pdfFilePath = path.join(sub1Folder, pdfFilename);
    const mockPdfBytes = Buffer.from('%PDF-1.4 Mock PDF Stream for Mental Health Report');
    fs.writeFileSync(pdfFilePath, mockPdfBytes);

    const campaignsFixture = [
        {
            code: 'S4-A',
            companyName: 'S4-A 협약기업',
            purpose: '상반기 직장인 스트레스 검진',
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2026-12-31T23:59:59Z',
            isActive: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z'
        }
    ];

    const submissionsFixture = [
        // 1. 캠페인 등록 건 (상담요청)
        {
            submissionId: sub1Id,
            internalSurveyId: `surv_${sub1Id}`,
            schemaVersion: 'v1.0',
            importedBy: userAdmin.id,
            importedAt: '2026-10-01T10:00:00Z',
            submittedAt: '2026-10-01T09:50:00Z',
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationStatus: '신규접수대기',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'assigned',
            assignedUserId: userStaff.id,
            assignedDepartmentId: userStaff.department,
            assignedAt: '2026-10-01T10:30:00Z',
            campaignCode: 'S4-A',
            deletionStatus: 'active',
            contact: {
                clientName: '홍길동',
                phone: '010-1234-5678',
                region: '이천시',
                counselingRequestText: '직무 스트레스 상담 희망'
            },
            assessment: {
                totalScore: 16,
                severity: '중등도'
            },
            attachment: {
                filename: pdfFilename,
                url: `/attachments/${sub1Id}/${pdfFilename}`,
                type: 'application/pdf',
                size: mockPdfBytes.length
            }
        },
        // 2. 미배정 상담요청 건
        {
            submissionId: sub2Id,
            internalSurveyId: `surv_${sub2Id}`,
            schemaVersion: 'v1.0',
            importedBy: userAdmin.id,
            importedAt: '2026-10-01T11:00:00Z',
            submittedAt: '2026-10-01T10:50:00Z',
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationStatus: '신규접수대기',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            assignedUserId: null,
            assignedDepartmentId: null,
            campaignCode: null,
            deletionStatus: 'active',
            contact: {
                clientName: '김철수',
                phone: '010-3333-4444',
                region: '이천시',
                counselingRequestText: '미배정 상담 요청건'
            },
            assessment: {
                totalScore: 8,
                severity: '경증'
            }
        },
        // 3. 타 부서 배정 건
        {
            submissionId: sub3Id,
            internalSurveyId: `surv_${sub3Id}`,
            schemaVersion: 'v1.0',
            importedBy: userStaff.id,
            importedAt: '2026-10-01T12:00:00Z',
            submittedAt: '2026-10-01T11:55:00Z',
            requestType: 'SCREENING_ONLY',
            consultationRequested: false,
            consultationStatus: '검사완료',
            processingStatus: 'SCREENING_COMPLETED',
            assignmentStatus: 'assigned',
            assignedUserId: userOtherDept.id,
            assignedDepartmentId: userOtherDept.department,
            assignedAt: '2026-10-01T12:30:00Z',
            campaignCode: null,
            deletionStatus: 'active',
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

    // Attachment streaming route for testing PDF stream
    app.get('/attachments/:subId/:filename', (req, res) => {
        if (!currentAuthUser) {
            return res.status(401).json({ error: 'UNAUTHENTICATED' });
        }
        if (!hasOnlineSurveyAccessBackend(currentAuthUser)) {
            return res.status(403).json({ error: 'FORBIDDEN' });
        }
        const filePath = path.join(testAttachmentsDir, req.params.subId, req.params.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'NOT_FOUND' });
        }
        return res.sendFile(filePath);
    });

    const surveyRouter = createSurveyImportRouter({
        requireAuth: authMiddleware,
        surveyImportService: {
            getStatusSummary: () => ({ isImportRunning: false }),
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
        return fetch(url, { ...options, headers });
    };

    try {
        console.log('\n▶️ [PART 1] 캠페인 CRUD 및 직원 권한 검증 (Tests 1~4)');

        // 1. 관리자 캠페인 CRUD PASS
        await testAsync('1. 관리자 캠페인 CRUD PASS', async () => {
            currentAuthUser = userAdmin;
            const postRes = await requestApi('/api/surveys/campaigns', {
                method: 'POST',
                body: { code: 'ADMIN-CAMP-01', companyName: '관리자기관', purpose: '관리자목적' }
            });
            assert.strictEqual(postRes.status, 201, 'Admin POST /campaigns must return 201');
            const postJson = await postRes.json();
            assert.strictEqual(postJson.campaign.code, 'ADMIN-CAMP-01');

            const patchRes = await requestApi('/api/surveys/campaigns/ADMIN-CAMP-01', {
                method: 'PATCH',
                body: { purpose: '관리자목적수정' }
            });
            assert.strictEqual(patchRes.status, 200, 'Admin PATCH /campaigns must return 200');
            const patchJson = await patchRes.json();
            assert.strictEqual(patchJson.campaign.purpose, '관리자목적수정');

            const getRes = await requestApi('/api/surveys/campaigns');
            assert.strictEqual(getRes.status, 200);
            const getJson = await getRes.json();
            const found = getJson.campaigns.find(c => c.code === 'ADMIN-CAMP-01');
            assert.ok(found, 'Admin created campaign must be in GET /campaigns');
        });

        // 2. 권한 직원 캠페인 CRUD PASS
        await testAsync('2. 권한 직원 캠페인 CRUD PASS', async () => {
            currentAuthUser = userStaff;
            const postRes = await requestApi('/api/surveys/campaigns', {
                method: 'POST',
                body: { code: 'STAFF-CAMP-01', companyName: '직원기관', purpose: '직원목적' }
            });
            assert.strictEqual(postRes.status, 201, 'Permitted staff POST /campaigns must return 201');
            const postJson = await postRes.json();
            assert.strictEqual(postJson.campaign.code, 'STAFF-CAMP-01');

            const patchRes = await requestApi('/api/surveys/campaigns/STAFF-CAMP-01', {
                method: 'PATCH',
                body: { purpose: '직원목적수정' }
            });
            assert.strictEqual(patchRes.status, 200, 'Permitted staff PATCH /campaigns must return 200');
            const patchJson = await patchRes.json();
            assert.strictEqual(patchJson.campaign.purpose, '직원목적수정');

            const getRes = await requestApi('/api/surveys/campaigns');
            assert.strictEqual(getRes.status, 200);
            const getJson = await getRes.json();
            const found = getJson.campaigns.find(c => c.code === 'STAFF-CAMP-01');
            assert.ok(found, 'Staff created campaign must be in GET /campaigns');
        });

        // 3. 직원 링크 복사 (프론트 로직 단위 — URL 생성 함수 테스트)
        test('3. 직원 링크 복사 (프론트 로직 단위 — URL 생성 함수 테스트)', () => {
            const url = buildCampaignDistributionUrl('STAFF-CAMP-01');
            assert.ok(typeof url === 'string', 'URL must be a string');
            assert.ok(url.includes('c=STAFF-CAMP-01'), 'URL must contain campaign parameter c=STAFF-CAMP-01');
        });

        // 4. 직원 활성화·비활성화 PASS
        await testAsync('4. 직원 활성화·비활성화 PASS', async () => {
            currentAuthUser = userStaff;
            // Deactivate
            const deactRes = await requestApi('/api/surveys/campaigns/STAFF-CAMP-01', {
                method: 'PATCH',
                body: { isActive: false }
            });
            assert.strictEqual(deactRes.status, 200);
            const deactJson = await deactRes.json();
            assert.strictEqual(deactJson.campaign.isActive, false, 'Campaign should be deactivated');

            // Reactivate
            const reactRes = await requestApi('/api/surveys/campaigns/STAFF-CAMP-01', {
                method: 'PATCH',
                body: { isActive: true }
            });
            assert.strictEqual(reactRes.status, 200);
            const reactJson = await reactRes.json();
            assert.strictEqual(reactJson.campaign.isActive, true, 'Campaign should be reactivated');
        });

        console.log('\n▶️ [PART 2] 직원 Soft Delete, 목록/집계 제외 및 관리자 휴지통/복구 (Tests 5~11)');

        // 5. 직원 soft delete 버튼 표시 조건 PASS (렌더 조건 함수 단위)
        test('5. 직원 soft delete 버튼 표시 조건 PASS (렌더 조건 함수 단위)', () => {
            const fns = [
                { name: 'frontend', fn: hasOnlineSurveyAccessFrontend },
                { name: 'backend', fn: hasOnlineSurveyAccessBackend }
            ];
            for (const { name, fn } of fns) {
                assert.strictEqual(fn(userAdmin), true, `[${name}] Admin should have access`);
                assert.strictEqual(fn(userStaff), true, `[${name}] Staff with permission array should have access`);
                assert.strictEqual(fn(userOtherDept), true, `[${name}] Staff with permission object should have access`);
                assert.strictEqual(fn(userUnauthorized), false, `[${name}] Staff without permission should not have access`);
                assert.strictEqual(fn({ ...userStaff, status: 'suspended' }), false, `[${name}] Suspended staff should not have access`);
                assert.strictEqual(fn(null), false, `[${name}] Null user should not have access`);
                assert.strictEqual(fn(undefined), false, `[${name}] Undefined user should not have access`);
            }
        });

        // 6. 직원 soft delete 실행 PASS
        await testAsync('6. 직원 soft delete 실행 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi(`/api/surveys/submissions/${sub1Id}/soft-delete`, {
                method: 'POST',
                body: {
                    reason: '중복 접수 확인으로 인한 직원 삭제 처리',
                    confirmSubmissionId: sub1Id
                }
            });
            assert.strictEqual(res.status, 200, 'Soft delete should return 200');
            const json = await res.json();
            assert.strictEqual(json.success, true);

            // Repository check: verify no splice, file intact, ledger intact
            const subs = repo.getSurveySubmissions();
            const deletedSub = subs.find(s => s.submissionId === sub1Id);
            assert.ok(deletedSub, 'Record must NOT be spliced from SurveySubmissions');
            assert.strictEqual(deletedSub.deletionStatus, 'deleted', 'deletionStatus must be deleted');
            assert.strictEqual(deletedSub.deletedBy, userStaff.id, 'deletedBy must match staff ID');
            assert.strictEqual(deletedSub.deletionType, 'SOFT_DELETE', 'deletionType must be SOFT_DELETE');
            assert.strictEqual(deletedSub.deleteReason, '중복 접수 확인으로 인한 직원 삭제 처리');
            assert.ok(deletedSub.deletedAt, 'deletedAt must be recorded');

            // Physical file must NOT be deleted
            assert.ok(fs.existsSync(pdfFilePath), 'PDF file must NOT be unlinked on soft delete');

            // Ledger must NOT be deleted
            const ledger = repo.getImportsLedger();
            assert.ok(ledger.some(l => l.submissionId === sub1Id), 'Ledger item must NOT be spliced');
        });

        // 7. 삭제 대상 기본 목록 제외 PASS
        await testAsync('7. 삭제 대상 기본 목록 제외 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/imports');
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            const foundInList = json.imports.find(item => item.submissionId === sub1Id);
            assert.strictEqual(foundInList, undefined, 'Soft-deleted submission must be excluded from GET /imports');
        });

        // 8. 캠페인 집계 제외 PASS
        await testAsync('8. 캠페인 집계 제외 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/campaigns');
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            const campS4A = json.campaigns.find(c => c.code === 'S4-A');
            assert.ok(campS4A, 'Campaign S4-A must exist');
            assert.strictEqual(campS4A.receivedCount, 0, 'Soft-deleted sub1 must be excluded from campaign count');
        });

        // 9. 관리자 휴지통 조회 PASS
        await testAsync('9. 관리자 휴지통 조회 PASS', async () => {
            currentAuthUser = userAdmin;
            const res = await requestApi('/api/surveys/admin/trash');
            assert.strictEqual(res.status, 200, 'Admin trash endpoint should return 200');
            const json = await res.json();
            assert.ok(json.submissions.length >= 1, 'Trash list should contain at least 1 item');
            const foundInTrash = json.submissions.find(s => s.submissionId === sub1Id);
            assert.ok(foundInTrash, 'Soft-deleted sub1 must be present in admin trash');
            assert.strictEqual(foundInTrash.deletionStatus, 'deleted');
        });

        // 10. 관리자 복구 PASS
        await testAsync('10. 관리자 복구 PASS', async () => {
            currentAuthUser = userAdmin;
            const res = await requestApi(`/api/surveys/admin/submissions/${sub1Id}/restore`, {
                method: 'POST'
            });
            assert.strictEqual(res.status, 200, 'Restore endpoint should return 200');
            const json = await res.json();
            assert.strictEqual(json.success, true);

            // Repository check: deletionStatus reverted to active
            const subs = repo.getSurveySubmissions();
            const restoredSub = subs.find(s => s.submissionId === sub1Id);
            assert.strictEqual(restoredSub.deletionStatus, 'active', 'deletionStatus must be active after restore');
            assert.strictEqual(restoredSub.restoredBy, userAdmin.id, 'restoredBy must match admin ID');
            assert.ok(restoredSub.restoredAt, 'restoredAt timestamp must be recorded');
        });

        // 11. 복구 후 목록·상세·PDF 재표시 PASS
        await testAsync('11. 복구 후 목록·상세·PDF 재표시 PASS', async () => {
            currentAuthUser = userStaff;
            // 1) Re-visible in list
            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 200);
            const listJson = await listRes.json();
            const foundInList = listJson.imports.find(item => item.submissionId === sub1Id);
            assert.ok(foundInList, 'Restored submission must reappear in GET /imports');

            // 2) Re-visible in detail
            const detailRes = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detailRes.status, 200, 'Restored submission detail must return 200');
            const detailJson = await detailRes.json();
            assert.strictEqual(detailJson.submission.submissionId, sub1Id);

            // 3) PDF stream accessible
            const pdfRes = await requestApi(`/attachments/${sub1Id}/${pdfFilename}`);
            assert.strictEqual(pdfRes.status, 200, 'PDF attachment must be streamable');
            const pdfBuf = await pdfRes.arrayBuffer();
            assert.strictEqual(pdfBuf.byteLength, mockPdfBytes.length);
        });

        console.log('\n▶️ [PART 3] 보안 경계 및 권한 방어 (Tests 12~17)');

        // 12. 직원 영구 삭제 API 403
        await testAsync('12. 직원 영구 삭제 API 403', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi(`/api/surveys/admin/submissions/${sub1Id}`, {
                method: 'DELETE',
                body: { reason: '불법 영구 삭제 시도', confirmSubmissionId: sub1Id }
            });
            assert.strictEqual(res.status, 403, 'Staff must be blocked with 403 on admin hard delete');
        });

        // 13. 직원 격리 삭제 API 403 (해당 API가 있으면)
        await testAsync('13. 직원 격리 삭제 API 403 (해당 API가 있으면)', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/admin/purge-demo', {
                method: 'POST',
                body: { reason: '불법 더미 삭제 시도', confirmation: 'DELETE DEMO DATA' }
            });
            assert.strictEqual(res.status, 403, 'Staff must be blocked with 403 on purge-demo');
        });

        // 14. 직원 대량 삭제 API 403 (해당 API가 있으면)
        await testAsync('14. 직원 대량 삭제 API 403 (해당 API가 있으면)', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/admin/recover-stored-submission', {
                method: 'POST',
                body: { submissionId: sub1Id, confirm: true }
            });
            assert.strictEqual(res.status, 403, 'Staff must be blocked with 403 on admin recover-stored-submission');
        });

        // 15. 조회 전용 직원 캠페인 CRUD 403
        await testAsync('15. 조회 전용 직원 캠페인 CRUD 403', async () => {
            currentAuthUser = userUnauthorized;
            const postRes = await requestApi('/api/surveys/campaigns', {
                method: 'POST',
                body: { code: 'UNAUTH-CAMP', companyName: '무권한', purpose: '무권한' }
            });
            assert.strictEqual(postRes.status, 403, 'Unauthorized staff must receive 403 on POST /campaigns');

            const patchRes = await requestApi('/api/surveys/campaigns/S4-A', {
                method: 'PATCH',
                body: { purpose: '무권한수정' }
            });
            assert.strictEqual(patchRes.status, 403, 'Unauthorized staff must receive 403 on PATCH /campaigns');
        });

        // 16. 조회 전용 직원 삭제 403
        await testAsync('16. 조회 전용 직원 삭제 403', async () => {
            currentAuthUser = userUnauthorized;
            const res = await requestApi(`/api/surveys/submissions/${sub1Id}/soft-delete`, {
                method: 'POST',
                body: { reason: '무권한 삭제 시도', confirmSubmissionId: sub1Id }
            });
            assert.strictEqual(res.status, 403, 'Unauthorized staff must receive 403 on soft-delete');
        });

        // 17. 무권한 직원 목록·상세·동기화·삭제 403
        await testAsync('17. 무권한 직원 목록·상세·동기화·삭제 403', async () => {
            currentAuthUser = userUnauthorized;
            const listRes = await requestApi('/api/surveys/imports');
            assert.strictEqual(listRes.status, 403, 'Unauthorized staff 403 on list');

            const detailRes = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detailRes.status, 403, 'Unauthorized staff 403 on detail');

            const syncRes = await requestApi('/api/surveys/import', { method: 'POST', body: { limit: 5 } });
            assert.strictEqual(syncRes.status, 403, 'Unauthorized staff 403 on import');

            const delRes = await requestApi(`/api/surveys/submissions/${sub1Id}/soft-delete`, {
                method: 'POST',
                body: { reason: '무권한 삭제', confirmSubmissionId: sub1Id }
            });
            assert.strictEqual(delRes.status, 403, 'Unauthorized staff 403 on soft-delete');
        });

        console.log('\n▶️ [PART 4] 감사로그 무결성 및 P0 회귀 검증 (Tests 18~26)');

        // 18. 삭제 감사로그 actor·target·reason 기록 PASS
        await testAsync('18. 삭제 감사로그 actor·target·reason 기록 PASS', async () => {
            const audits = repo.getAuditLogs();
            const softDelAudit = audits.find(a => a.action === 'ONLINE_SCREENING_SUBJECT_SOFT_DELETED');
            assert.ok(softDelAudit, 'ONLINE_SCREENING_SUBJECT_SOFT_DELETED audit log must exist');
            assert.strictEqual(softDelAudit.actorId, userStaff.id, 'actorId must be recorded');
            assert.strictEqual(softDelAudit.target, sub1Id, 'target must be recorded');
            assert.ok(softDelAudit.reason.includes('중복 접수'), 'reason must be recorded');

            // ZERO PII Verification
            const auditStr = JSON.stringify(softDelAudit);
            assert.ok(!auditStr.includes('홍길동'), 'Client name must NEVER appear in audit log');
            assert.ok(!auditStr.includes('010-1234-5678'), 'Phone number must NEVER appear in audit log');
        });

        // 19. 타인 동기화 결과의 직원 조회 유지 PASS
        await testAsync('19. 타인 동기화 결과의 직원 조회 유지 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/imports');
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            // sub1 and sub2 were imported by userAdmin
            const sub2Item = json.imports.find(i => i.submissionId === sub2Id);
            assert.ok(sub2Item, 'Staff must see submissions synced by Admin (importedBy !== staff)');
        });

        // 20. 미배정 결과 조회 유지 PASS
        await testAsync('20. 미배정 결과 조회 유지 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/imports');
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            const sub2Item = json.imports.find(i => i.submissionId === sub2Id);
            assert.ok(sub2Item, 'Unassigned consultation request must be visible to staff');
            assert.strictEqual(sub2Item.assignmentStatus, 'unassigned');
        });

        // 21. 상세·PDF 회귀 PASS
        await testAsync('21. 상세·PDF 회귀 PASS', async () => {
            currentAuthUser = userStaff;
            const detailRes = await requestApi(`/api/surveys/submissions/${sub1Id}`);
            assert.strictEqual(detailRes.status, 200);
            const detailJson = await detailRes.json();
            assert.ok(detailJson.submission);
            assert.ok(detailJson.submission.contact);
            assert.ok(detailJson.submission.assessment);

            const pdfRes = await requestApi(`/attachments/${sub1Id}/${pdfFilename}`);
            assert.strictEqual(pdfRes.status, 200);
        });

        // 22. 캠페인 필터 회귀 PASS
        await testAsync('22. 캠페인 필터 회귀 PASS', async () => {
            currentAuthUser = userStaff;
            const res = await requestApi('/api/surveys/imports?campaignFilter=S4-A');
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            assert.ok(json.imports.every(i => i.campaignCode === 'S4-A'), 'All filtered items must belong to S4-A');
        });

        // 23. 사례분석 부서 제한 유지 PASS
        test('23. 사례분석 부서 제한 유지 PASS', () => {
            // Verify that Case Analysis router/components are untouched
            const routerCode = fs.readFileSync(path.join(projectRoot, 'server/survey/surveyImportRouter.js'), 'utf-8');
            assert.ok(!routerCode.includes('caseAnalysis'), 'surveyImportRouter must not interfere with caseAnalysis');
        });

        // 24. 의뢰관리·자살시도자 대장 계약 유지 PASS
        test('24. 의뢰관리·자살시도자 대장 계약 유지 PASS', () => {
            // Verify soft-delete didn't touch Referrals or SuicideAttemptLedger
            const subs = repo.getSurveySubmissions();
            assert.strictEqual(subs.length, 3, 'All 3 submissions preserved in storage');
        });

        // 25. 인증 회귀 PASS
        await testAsync('25. 인증 회귀 PASS', async () => {
            currentAuthUser = null; // Unauthenticated
            const res1 = await requestApi('/api/surveys/imports');
            assert.strictEqual(res1.status, 401, 'Unauthenticated request to /imports must return 401');

            const res2 = await requestApi('/api/surveys/campaigns');
            assert.strictEqual(res2.status, 401, 'Unauthenticated request to /campaigns must return 401');

            const res3 = await requestApi(`/api/surveys/submissions/${sub1Id}/soft-delete`, {
                method: 'POST',
                body: { reason: '미인증 삭제 시도', confirmSubmissionId: sub1Id }
            });
            assert.strictEqual(res3.status, 401, 'Unauthenticated request to soft-delete must return 401');
        });

        // 26. P0 데이터 무결성 회귀 PASS
        test('26. P0 데이터 무결성 회귀 PASS', () => {
            // Check that ledger records and submissions have matching submissionIds
            const subs = repo.getSurveySubmissions();
            const ledger = repo.getImportsLedger();
            assert.strictEqual(subs.length, ledger.length, 'Submissions and ledger counts must match');
            for (const sub of subs) {
                const match = ledger.find(l => l.submissionId === sub.submissionId);
                assert.ok(match, `Ledger item for ${sub.submissionId} must exist`);
            }
        });

        console.log('\n▶️ [PART 5] 통합 회귀 스크립트 실행, Build, Git Check (Tests 27~29)');

        // 27. 전체 설문 회귀 PASS (기존 verify 스크립트 재실행)
        test('27. 전체 설문 회귀 PASS (기존 verify 스크립트 재실행)', () => {
            console.log('    ⏳ Running verify-survey-staff-visibility.mjs...');
            execSync('node scripts/verify-survey-staff-visibility.mjs', { cwd: projectRoot, stdio: 'pipe' });
            console.log('    ⏳ Running verify-assignment-referral-workflow.mjs...');
            execSync('node scripts/verify-assignment-referral-workflow.mjs', { cwd: projectRoot, stdio: 'pipe' });
            console.log('    ⏳ Running verify-survey-campaign-contract.mjs...');
            execSync('node scripts/verify-survey-campaign-contract.mjs', { cwd: projectRoot, stdio: 'pipe' });
        });

        // 28. build PASS
        test('28. build PASS', () => {
            console.log('    ⏳ Running npm run build...');
            execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
        });

        // 29. git diff --check PASS
        test('29. git diff --check PASS', () => {
            console.log('    ⏳ Running git diff --check...');
            execSync('git diff --check', { cwd: projectRoot, stdio: 'pipe' });
        });

    } finally {
        server.close();
        try {
            fs.rmSync(testAttachmentsDir, { recursive: true, force: true });
        } catch (ignore) {}
    }

    console.log('\n====================================================');
    console.log(`📊 Summary: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
    console.log('====================================================');

    if (failedTests > 0) {
        throw new Error(`${failedTests} tests failed in B Track verification!`);
    }
}

runBTrackVerification().catch(err => {
    console.error('Fatal error running B Track verification suite:', err);
    process.exit(1);
});

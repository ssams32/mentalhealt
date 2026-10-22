/**
 * scripts/verify-survey-badge-my-assigned.mjs
 * Verification for sidebar badge semantics (2026-10-22):
 * GET /api/surveys/status의 badgeCount가 관리자 포함 전 사용자
 * "본인 배정·미등록 건수(myAssignedPendingCount)"로 통일됐는지 검증한다.
 *
 * Fixture: 직원 A 배정 2건, 직원 B 배정 3건, 미배정 5건, 관리자 배정 0건
 *          + 노이즈(의뢰 전환 완료 1건, 상담신청 아님 1건, 삭제 1건)
 * 기대값: badgeCount → A=2, B=3, 관리자=0
 *         관리자 응답의 unassignedCount=5, totalPendingReferralCount=10 유지
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import {
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

async function main() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Survey Badge = My Assigned Pending Count');
    console.log('🧪 ========================================================');

    let passed = 0;
    let failed = 0;
    const testAsync = async (name, fn) => {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failed++;
        }
    };

    if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
    const testAttachmentsDir = fs.mkdtempSync(path.join(scratchDir, 'test-survey-badge-'));

    const userAdmin = {
        id: 'user-admin', username: 'admin_user', name: '최고관리자',
        role: 'admin', department: '운영팀', team: '운영팀', status: 'active'
    };
    const staffA = {
        id: 'user-staff-a', username: 'staff_a', name: '직원A',
        role: 'user', department: '상담팀', team: '상담팀', status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };
    const staffB = {
        id: 'user-staff-b', username: 'staff_b', name: '직원B',
        role: 'user', department: '상담팀', team: '상담팀', status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };
    const allUsers = [userAdmin, staffA, staffB];

    const baseSub = (id, overrides = {}) => ({
        submissionId: id,
        internalSurveyId: `surv_${id}`,
        schemaVersion: '1.0',
        clientName: '테스트',
        phone: '010-0000-0000',
        consultationRequested: true,
        requestType: 'CONSULTATION_REQUEST',
        consultationStatus: '신규접수대기',
        assignmentStatus: 'unassigned',
        assignedUserId: null,
        assignedDepartmentId: null,
        assignmentPriority: 'NORMAL',
        version: 1,
        submittedAt: '2026-10-20T10:00:00Z',
        importedAt: '2026-10-20T10:05:00Z',
        importedBy: userAdmin.id,
        status: 'active',
        deletionStatus: 'active',
        ...overrides
    });

    const submissionsFixture = [
        // A 배정 2건
        baseSub('sub-badge-a1', { assignmentStatus: 'assigned', assignedUserId: staffA.id }),
        baseSub('sub-badge-a2', { assignmentStatus: 'assigned', assignedUserId: staffA.id }),
        // B 배정 3건
        baseSub('sub-badge-b1', { assignmentStatus: 'assigned', assignedUserId: staffB.id }),
        baseSub('sub-badge-b2', { assignmentStatus: 'assigned', assignedUserId: staffB.id }),
        baseSub('sub-badge-b3', { assignmentStatus: 'assigned', assignedUserId: staffB.id }),
        // 미배정 5건
        baseSub('sub-badge-u1'), baseSub('sub-badge-u2'), baseSub('sub-badge-u3'),
        baseSub('sub-badge-u4'), baseSub('sub-badge-u5'),
        // 노이즈: A 배정이지만 이미 의뢰 전환됨 → pending 아님
        baseSub('sub-badge-noise1', { assignmentStatus: 'assigned', assignedUserId: staffA.id, referralId: 'ref-001' }),
        // 노이즈: 상담신청이 아닌 단순 검사 제출 → 제외
        baseSub('sub-badge-noise2', { consultationRequested: false, requestType: 'SCREENING_ONLY', assignmentStatus: 'assigned', assignedUserId: staffA.id }),
        // 노이즈: 삭제된 건 → 제외
        baseSub('sub-badge-noise3', { assignmentStatus: 'assigned', assignedUserId: staffB.id, status: 'deleted', deletionStatus: 'deleted' })
    ];

    const storage = createInMemoryStorage();
    const repo = new SurveyImportRepository({
        getData: storage.getData,
        persistData: storage.persistData,
        sourceEnvironment: 'mock',
        attachmentsDir: testAttachmentsDir
    });
    await repo.saveSurveySubmissions(submissionsFixture);
    await repo.saveImportsLedger(submissionsFixture.map(s => ({
        internalImportId: `imp_${s.submissionId}`,
        submissionId: s.submissionId,
        schemaVersion: s.schemaVersion,
        keyVersion: 'k2026_01',
        externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
        internalStatus: SURVEY_INTERNAL_STATUS.DOWNLOADED,
        importedAt: s.importedAt,
        receivedAt: s.submittedAt,
        importedBy: s.importedBy
    })));

    const app = express();
    app.use(express.json());
    let currentAuthUser = null;
    const authMiddleware = (req, res, next) => {
        req.auth = currentAuthUser ? { ...currentAuthUser } : null;
        next();
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
        auditLogger: () => {}
    });
    app.use('/api/surveys', surveyRouter);

    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const getStatus = async () => {
        const res = await fetch(`${baseUrl}/api/surveys/status`);
        return { status: res.status, data: await res.json().catch(() => null) };
    };

    try {
        await testAsync('직원 A: badgeCount = 2 (본인 배정·미등록만)', async () => {
            currentAuthUser = staffA;
            const { status, data } = await getStatus();
            assert.strictEqual(status, 200);
            assert.strictEqual(data.badgeCount, 2, `badgeCount=${data.badgeCount}`);
            assert.strictEqual(data.myAssignedPendingCount, 2);
            assert.strictEqual(data.badgeCount, data.myAssignedPendingCount);
        });

        await testAsync('직원 B: badgeCount = 3', async () => {
            currentAuthUser = staffB;
            const { status, data } = await getStatus();
            assert.strictEqual(status, 200);
            assert.strictEqual(data.badgeCount, 3, `badgeCount=${data.badgeCount}`);
            assert.strictEqual(data.myAssignedPendingCount, 3);
        });

        await testAsync('관리자: badgeCount = 0 (본인 배정 없음 — 전체 건수로 뜨지 않음)', async () => {
            currentAuthUser = userAdmin;
            const { status, data } = await getStatus();
            assert.strictEqual(status, 200);
            assert.strictEqual(data.badgeCount, 0, `badgeCount=${data.badgeCount}`);
            assert.strictEqual(data.myAssignedPendingCount, 0);
        });

        await testAsync('관리자 응답의 전체 필드는 유지: unassignedCount=5, totalPendingReferralCount=10', async () => {
            currentAuthUser = userAdmin;
            const { data } = await getStatus();
            assert.strictEqual(data.unassignedCount, 5, `unassignedCount=${data.unassignedCount}`);
            assert.strictEqual(data.totalPendingReferralCount, 10, `totalPendingReferralCount=${data.totalPendingReferralCount}`);
        });
    } finally {
        server.close();
    }

    console.log(`\n🧪 결과: ${passed} PASS / ${failed} FAIL`);
    if (failed > 0) process.exit(1);
    console.log('🧪 ✅ Survey badge verification ALL PASS');
}

main().catch(err => {
    console.error('🧪 ❌ Verification crashed:', err);
    process.exit(1);
});

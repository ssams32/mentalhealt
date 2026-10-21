/**
 * scripts/verify-survey-assignable-toggle.mjs
 * Reproduction / regression suite for the staff-management "온라인 설문 ON ⇒ 담당자 배정 대상" contract.
 *
 * Background (jun report, 2026-10-21):
 *  - In AccountsPage (직원관리) two active non-admin staff show 온라인 설문 = 허용됨(ON),
 *    yet they cannot be assigned in SurveyManagementPage.
 *  - The AccountsPage display check (checkHasSurveyAccess) treats any truthy
 *    `permissions.ONLINE_SURVEY_ACCESS` value as ON, while the server gate
 *    (hasOnlineSurveyAccess) only accepts boolean true / array membership.
 *  - Stored representations with truthy non-boolean values (e.g. 'true', 'TRUE', 1)
 *    therefore display ON in the UI but are excluded server-side.
 *
 * Verifies for every permission representation:
 *  (a) GET  /api/surveys/assignable-staff includes the target
 *  (b) POST /api/surveys/:id/assign succeeds for the target
 *  (c) POST /api/surveys/bulk-assign succeeds for the target
 * Controls (OFF representations) must fail all three.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import { hasOnlineSurveyAccess, hasSurveyAssignmentAccess } from '../server/permissions/voiceCapabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const scratchDir = path.resolve(projectRoot, 'scratch');
if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
const testAttachmentsDir = fs.mkdtempSync(path.join(scratchDir, 'test-assignable-toggle-'));

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
        }
    };
}

let passed = 0;
let failed = 0;
const failures = [];
async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ FAIL: ${name}`);
        console.log(`     → ${err.message}`);
        failed++;
        failures.push(`${name}: ${err.message}`);
    }
}

async function main() {
    console.log('🧪 ========================================================');
    console.log('🧪 [REPRO] 온라인 설문 ON ⇒ 담당자 배정 대상 계약 검증');
    console.log('🧪 ========================================================');

    const admin = {
        id: 'admin', username: 'admin', name: '관리자', role: 'admin',
        team: '증진팀', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    // --- Target fixtures: same person shape, different stored representations ---
    const targets = [
        { key: 'array', label: "배열 ['ONLINE_SURVEY_ACCESS']", expect: true,
          user: { id: 't-array', username: 't_array', name: '배열직원', role: 'user', team: '자살예방센터', status: 'active', permissions: ['ONLINE_SURVEY_ACCESS'] } },
        { key: 'objbool', label: "객체 {ONLINE_SURVEY_ACCESS:true}", expect: true,
          user: { id: 't-objbool', username: 't_objbool', name: '객체직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } } },
        { key: 'nested', label: '메뉴객체+{ONLINE_SURVEY_ACCESS:true}', expect: true,
          user: { id: 't-nested', username: 't_nested', name: '메뉴직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { referrals: { read: true, write: true, delete: false }, ONLINE_SURVEY_ACCESS: true } } },
        { key: 'str', label: "객체 {ONLINE_SURVEY_ACCESS:'true'}", expect: true,
          user: { id: 't-str', username: 't_str', name: '문자열직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: 'true' } } },
        { key: 'strupper', label: "객체 {ONLINE_SURVEY_ACCESS:'TRUE'}", expect: true,
          user: { id: 't-strupper', username: 't_strupper', name: '대문자직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: 'TRUE' } } },
        { key: 'num', label: '객체 {ONLINE_SURVEY_ACCESS:1}', expect: true,
          user: { id: 't-num', username: 't_num', name: '숫자직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: 1 } } },
        { key: 'strfalse', label: "객체 {ONLINE_SURVEY_ACCESS:'false'} (대조군)", expect: false,
          user: { id: 't-strfalse', username: 't_strfalse', name: '거짓문자직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: 'false' } } },
        { key: 'off', label: '객체 {ONLINE_SURVEY_ACCESS:false} (대조군)', expect: false,
          user: { id: 't-off', username: 't_off', name: '미부여직원', role: 'user', team: '자살예방센터', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: false } } },
        { key: 'none', label: '객체 {} (대조군)', expect: false,
          user: { id: 't-none', username: 't_none', name: '무권한직원', role: 'user', team: '자살예방센터', status: 'active', permissions: {} } }
    ];

    const allUsers = [admin, ...targets.map(t => t.user)];

    // --- Submissions: 2 unassigned per target (single + bulk) ---
    const submissionsFixture = [];
    for (const t of targets) {
        for (const kind of ['single', 'bulk']) {
            const sid = `sub-${t.key}-${kind}`;
            submissionsFixture.push({
                submissionId: sid,
                internalSurveyId: `surv_${sid}`,
                schemaVersion: 'v1.0',
                importedBy: admin.id,
                importedAt: '2026-10-21T09:00:00Z',
                submittedAt: '2026-10-21T08:50:00Z',
                requestType: 'CONSULTATION_REQUEST',
                consultationRequested: true,
                consultationRequestedAt: '2026-10-21T08:50:00Z',
                consultationStatus: '신규접수대기',
                processingStatus: 'PENDING_STAFF_REVIEW',
                assignmentStatus: 'unassigned',
                assignedUserId: null,
                assignedDepartmentId: null,
                campaignCode: null,
                contact: { clientName: '테스트', phone: '010-0000-0000', region: '이천시', counselingRequestText: '상담 희망' },
                assessment: { totalScore: 5, severity: '경증' }
            });
        }
    }

    const storage = createInMemoryStorage();
    const repo = new SurveyImportRepository({
        getData: storage.getData,
        persistData: storage.persistData,
        sourceEnvironment: 'mock',
        attachmentsDir: testAttachmentsDir
    });
    await repo.saveSurveySubmissions(submissionsFixture);

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
    const requestApi = async (pathStr, options = {}) => {
        const headers = { ...(options.headers || {}) };
        if (options.body && typeof options.body === 'object') {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(options.body);
        }
        const res = await fetch(`${baseUrl}${pathStr}`, { ...options, headers });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
    };

    try {
        console.log('\n▶️ 단위 판정: hasOnlineSurveyAccess / hasSurveyAssignmentAccess');
        for (const t of targets) {
            await testAsync(`unit hasOnlineSurveyAccess [${t.label}] === ${t.expect}`, async () => {
                assert.strictEqual(hasOnlineSurveyAccess(t.user), t.expect);
            });
        }
        await testAsync('unit hasSurveyAssignmentAccess: ONLINE_SURVEY_ACCESS만으로는 false (actor 경계 유지)', async () => {
            assert.strictEqual(hasSurveyAssignmentAccess(targets[1].user), false);
            assert.strictEqual(hasSurveyAssignmentAccess({ ...targets[1].user, permissions: { SURVEY_ASSIGNMENT_ACCESS: true } }), true);
            assert.strictEqual(hasSurveyAssignmentAccess({ ...targets[1].user, permissions: ['SURVEY_ASSIGNMENT_ACCESS'] }), true);
        });

        console.log('\n▶️ API 흐름: (a) assignable-staff 포함 (b) 단건 배정 (c) 일괄 배정 — actor=admin');
        currentAuthUser = admin;
        const staffRes = await requestApi('/api/surveys/assignable-staff');
        assert.strictEqual(staffRes.status, 200, `assignable-staff status ${staffRes.status}`);
        const staffIds = (staffRes.data?.staff || []).map(s => s.id);

        for (const t of targets) {
            await testAsync(`(a) assignable-staff ${t.expect ? '포함' : '제외'} [${t.label}]`, async () => {
                assert.strictEqual(staffIds.includes(t.user.id), t.expect,
                    `staffIds=${JSON.stringify(staffIds)}`);
            });
            await testAsync(`(b) 단건 배정 ${t.expect ? '성공' : '거부'} [${t.label}]`, async () => {
                const res = await requestApi(`/api/surveys/sub-${t.key}-single/assign`, {
                    method: 'POST',
                    body: { assignedUserId: t.user.id }
                });
                if (t.expect) {
                    assert.strictEqual(res.status, 200, `status=${res.status} body=${JSON.stringify(res.data)}`);
                } else {
                    assert.strictEqual(res.status, 400, `status=${res.status} body=${JSON.stringify(res.data)}`);
                    assert.strictEqual(res.data?.error?.code, 'STAFF_NOT_ELIGIBLE');
                }
            });
            await testAsync(`(c) 일괄 배정 ${t.expect ? '성공' : '거부'} [${t.label}]`, async () => {
                const res = await requestApi('/api/surveys/bulk-assign', {
                    method: 'POST',
                    body: { submissionIds: [`sub-${t.key}-bulk`], targetUserId: t.user.id, mode: 'unassigned-only' }
                });
                if (t.expect) {
                    assert.strictEqual(res.status, 200, `status=${res.status} body=${JSON.stringify(res.data)}`);
                    assert.ok((res.data?.assigned || 0) >= 1, `assigned=${res.data?.assigned}`);
                } else {
                    assert.strictEqual(res.status, 400, `status=${res.status} body=${JSON.stringify(res.data)}`);
                    assert.strictEqual(res.data?.error?.code, 'STAFF_NOT_ELIGIBLE');
                }
            });
        }
    } finally {
        server.close();
        fs.rmSync(testAttachmentsDir, { recursive: true, force: true });
    }

    console.log('\n🧪 ========================================================');
    console.log(`🧪 결과: PASS ${passed} / FAIL ${failed}`);
    if (failures.length) {
        console.log('🧪 실패 목록:');
        failures.forEach(f => console.log(`   - ${f}`));
    }
    console.log('🧪 ========================================================');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('❌ 검증 실행 오류:', err);
    process.exit(2);
});

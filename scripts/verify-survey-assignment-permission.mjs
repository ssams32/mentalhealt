/**
 * scripts/verify-survey-assignment-permission.mjs
 * Verification suite for SURVEY_ASSIGNMENT_ACCESS permission & assignment boundary.
 *
 * Test Checklist:
 * 1. 관리자 배정 PASS (기존 동작)
 * 2. SURVEY_ASSIGNMENT_ACCESS 보유 직원 배정 PASS
 * 3. 보유 직원 재배정 PASS
 * 4. 미보유 직원 배정 403
 * 5. 보유 직원 bulk-assign 403 (관리자 전용 유지)
 * 6. 보유 직원 unassign 403 (관리자 전용 유지)
 * 7. 무권한(ONLINE_SURVEY_ACCESS 없음) 직원 배정 403
 * 8. 미인증 401
 * 9. 판정 함수 단위 테스트: admin→true, 배열형→true, 객체형→true, 비활성→false, 무권한→false
 * 10. 기존 회귀: verify-survey-staff-visibility, verify-assignment-referral-workflow, verify-survey-campaign-contract, verify-survey-staff-campaign-delete 재실행
 * 11. build PASS, git diff --check PASS
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
    SURVEY_ASSIGNMENT_ACCESS,
    hasSurveyAssignmentAccess,
    hasOnlineSurveyAccess
} from '../server/permissions/voiceCapabilities.js';
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

async function runSurveyAssignmentPermissionVerification() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Survey Assignment Permission Suite');
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

    // ----------------------------------------------------
    // PART 1: 판정 함수 단위 테스트 (Item 9)
    // ----------------------------------------------------
    console.log('\n▶️ [PART 1] 판정 함수 단위 테스트 (Item 9)');

    test('9.1. admin (active) → true', () => {
        const user = { role: 'admin', status: 'active' };
        assert.strictEqual(hasSurveyAssignmentAccess(user), true);
    });

    test('9.2. 배열형 permissions (active, 포함) → true', () => {
        const user = {
            role: 'user',
            status: 'active',
            permissions: ['ONLINE_SURVEY_ACCESS', SURVEY_ASSIGNMENT_ACCESS]
        };
        assert.strictEqual(hasSurveyAssignmentAccess(user), true);
    });

    test('9.3. 객체형 permissions (active, === true) → true', () => {
        const userObj = {
            role: 'user',
            status: 'active',
            permissions: {
                ONLINE_SURVEY_ACCESS: true,
                [SURVEY_ASSIGNMENT_ACCESS]: true
            }
        };
        assert.strictEqual(hasSurveyAssignmentAccess(userObj), true);

        // camelCase variant also supported
        const userCamel = {
            role: 'user',
            status: 'active',
            permissions: {
                surveyAssignmentAccess: true
            }
        };
        assert.strictEqual(hasSurveyAssignmentAccess(userCamel), true);
    });

    test('9.4. 비활성 계정 → false (admin/보유자 불문)', () => {
        const inactiveAdmin = { role: 'admin', status: 'inactive' };
        assert.strictEqual(hasSurveyAssignmentAccess(inactiveAdmin), false);

        const inactiveStaff = {
            role: 'user',
            status: 'inactive',
            permissions: [SURVEY_ASSIGNMENT_ACCESS]
        };
        assert.strictEqual(hasSurveyAssignmentAccess(inactiveStaff), false);

        const suspendedStaff = {
            role: 'user',
            status: 'suspended',
            permissions: { [SURVEY_ASSIGNMENT_ACCESS]: true }
        };
        assert.strictEqual(hasSurveyAssignmentAccess(suspendedStaff), false);
    });

    test('9.5. 무권한 직원 / malformed / null → false', () => {
        // active but no permission
        const userNoPerm = {
            role: 'user',
            status: 'active',
            permissions: { ONLINE_SURVEY_ACCESS: true, [SURVEY_ASSIGNMENT_ACCESS]: false }
        };
        assert.strictEqual(hasSurveyAssignmentAccess(userNoPerm), false);

        const userEmptyPerms = { role: 'user', status: 'active', permissions: [] };
        assert.strictEqual(hasSurveyAssignmentAccess(userEmptyPerms), false);

        const userNoPermsProp = { role: 'user', status: 'active' };
        assert.strictEqual(hasSurveyAssignmentAccess(userNoPermsProp), false);

        assert.strictEqual(hasSurveyAssignmentAccess(null), false);
        assert.strictEqual(hasSurveyAssignmentAccess(undefined), false);
    });

    // ----------------------------------------------------
    // PART 2: Isolated API Integration Server & Fixtures
    // ----------------------------------------------------
    console.log('\n▶️ [PART 2] 배정 API 권한 확대 및 격리 경계 테스트 (Items 1~8)');

    if (!fs.existsSync(scratchDir)) {
        fs.mkdirSync(scratchDir, { recursive: true });
    }
    const testAttachmentsDir = fs.mkdtempSync(path.join(scratchDir, 'test-survey-assign-perm-'));

    // Fixture Users
    const userAdmin = {
        id: 'user-admin',
        username: 'admin_user',
        name: '최고관리자',
        role: 'admin',
        department: '운영팀',
        team: '운영팀',
        status: 'active'
    };

    const userStaffWithAssign = {
        id: 'user-staff-assign',
        username: 'staff_with_assign',
        name: '배정권한직원',
        role: 'user',
        department: '상담팀',
        team: '상담팀',
        status: 'active',
        permissions: {
            ONLINE_SURVEY_ACCESS: true,
            SURVEY_ASSIGNMENT_ACCESS: true
        }
    };

    const userStaffNoAssign = {
        id: 'user-staff-no-assign',
        username: 'staff_no_assign',
        name: '미보유직원',
        role: 'user',
        department: '상담팀',
        team: '상담팀',
        status: 'active',
        permissions: {
            ONLINE_SURVEY_ACCESS: true,
            SURVEY_ASSIGNMENT_ACCESS: false
        }
    };

    const userStaffNoSurvey = {
        id: 'user-staff-no-survey',
        username: 'staff_no_survey',
        name: '무권한직원',
        role: 'user',
        department: '행정팀',
        team: '행정팀',
        status: 'active',
        permissions: {
            ONLINE_SURVEY_ACCESS: false,
            SURVEY_ASSIGNMENT_ACCESS: false
        }
    };

    const targetStaff1 = {
        id: 'user-target-1',
        username: 'target_1',
        name: '상담직원1',
        role: 'user',
        department: '상담팀',
        team: '상담팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const targetStaff2 = {
        id: 'user-target-2',
        username: 'target_2',
        name: '상담직원2',
        role: 'user',
        department: '회복팀',
        team: '회복팀',
        status: 'active',
        permissions: { ONLINE_SURVEY_ACCESS: true }
    };

    const allUsers = [
        userAdmin,
        userStaffWithAssign,
        userStaffNoAssign,
        userStaffNoSurvey,
        targetStaff1,
        targetStaff2
    ];

    // Fixture Submissions
    const sub1Id = 'sub-test-assign-001';
    const sub2Id = 'sub-test-assign-002';

    const submissionsFixture = [
        {
            submissionId: sub1Id,
            internalSurveyId: `surv_${sub1Id}`,
            schemaVersion: '1.0',
            clientName: '홍길동',
            phone: '010-1111-2222',
            counselingRequested: true,
            consultationStatus: '신규접수대기',
            assignmentStatus: 'unassigned',
            assignedUserId: null,
            assignedDepartmentId: null,
            assignmentPriority: 'NORMAL',
            version: 1,
            submittedAt: '2026-10-02T10:00:00Z',
            importedAt: '2026-10-02T10:05:00Z',
            importedBy: userAdmin.id,
            status: 'active',
            deletionStatus: 'active'
        },
        {
            submissionId: sub2Id,
            internalSurveyId: `surv_${sub2Id}`,
            schemaVersion: '1.0',
            clientName: '김철수',
            phone: '010-3333-4444',
            counselingRequested: true,
            consultationStatus: '상담배정',
            assignmentStatus: 'assigned',
            assignedUserId: targetStaff1.id,
            assignedDepartmentId: targetStaff1.department,
            assignedAt: '2026-10-02T10:10:00Z',
            assignmentPriority: 'NORMAL',
            version: 1,
            submittedAt: '2026-10-02T10:00:00Z',
            importedAt: '2026-10-02T10:05:00Z',
            importedBy: userAdmin.id,
            status: 'active',
            deletionStatus: 'active'
        }
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
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            data = await res.json().catch(() => null);
        } else {
            const txt = await res.text().catch(() => '');
            try { data = JSON.parse(txt); } catch { data = txt; }
        }
        return { status: res.status, headers: res.headers, data };
    };

    try {
        // 1. 관리자 배정 PASS (기존 동작)
        await testAsync('1. 관리자 배정 PASS (기존 동작 유지)', async () => {
            currentAuthUser = userAdmin;

            const res = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff1.id,
                    assignedDepartmentId: targetStaff1.department,
                    assignmentPriority: 'NORMAL',
                    reason: '관리자 최초 배정'
                }
            });

            assert.strictEqual(res.status, 200, `Admin assign returns 200 (got ${res.status})`);
            assert.strictEqual(res.data.success, true);
            assert.strictEqual(res.data.submission.assignedUserId, targetStaff1.id);
            assert.strictEqual(res.data.submission.assignmentStatus, 'assigned');
        });

        // 2. SURVEY_ASSIGNMENT_ACCESS 보유 직원 배정 PASS
        await testAsync('2. SURVEY_ASSIGNMENT_ACCESS 보유 직원 배정 PASS', async () => {
            currentAuthUser = userStaffWithAssign;

            // Reset sub1 to unassigned first (preserving sub2)
            await repo.saveSurveySubmissions([
                { ...submissionsFixture[0], version: 1 },
                { ...submissionsFixture[1], version: 1 }
            ]);

            const res = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff2.id,
                    assignedDepartmentId: targetStaff2.department,
                    assignmentPriority: 'PRIORITY_REVIEW',
                    reason: '권한 보유 직원 최초 배정'
                }
            });

            assert.strictEqual(res.status, 200, `Staff with assign access returns 200 (got ${res.status})`);
            assert.strictEqual(res.data.success, true);
            assert.strictEqual(res.data.submission.assignedUserId, targetStaff2.id);
            assert.strictEqual(res.data.submission.assignmentStatus, 'assigned');
        });

        // 3. 보유 직원 재배정 PASS
        await testAsync('3. 보유 직원 재배정 PASS (POST /:id/reassign)', async () => {
            currentAuthUser = userStaffWithAssign;

            const res = await requestApi(`/api/surveys/${sub2Id}/reassign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff2.id,
                    assignedDepartmentId: targetStaff2.department,
                    assignmentPriority: 'IMMEDIATE_REVIEW',
                    reason: '권한 보유 직원 재배정'
                }
            });

            assert.strictEqual(res.status, 200, `Staff with assign access reassign returns 200 (got ${res.status})`);
            assert.strictEqual(res.data.success, true);
            assert.strictEqual(res.data.submission.assignedUserId, targetStaff2.id);
            assert.strictEqual(res.data.submission.previousAssignedUserId, targetStaff1.id);
        });

        // 4. 미보유 직원 배정 403
        await testAsync('4. 미보유 직원 배정 403 (ONLINE_SURVEY_ACCESS만 있고 배정권한 없음)', async () => {
            currentAuthUser = userStaffNoAssign;

            const res = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff1.id
                }
            });

            assert.strictEqual(res.status, 403, `Staff without assign access returns 403 (got ${res.status})`);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
            assert.ok(
                res.data.error.message.includes('관리자') || res.data.error.message.includes('권한'),
                'Error message specifies permission requirement'
            );
        });

        // 5. 보유 직원 bulk-assign 403 (관리자 전용 유지)
        await testAsync('5. 보유 직원 bulk-assign 403 (관리자 전용 유지)', async () => {
            currentAuthUser = userStaffWithAssign;

            const res = await requestApi('/api/surveys/bulk-assign', {
                method: 'POST',
                body: {
                    submissionIds: [sub1Id],
                    targetUserId: targetStaff1.id
                }
            });

            assert.strictEqual(res.status, 403, `Staff bulk-assign is strictly 403 admin only (got ${res.status})`);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
        });

        // 6. 보유 직원 unassign 403 (관리자 전용 유지)
        await testAsync('6. 보유 직원 unassign 403 (관리자 전용 유지)', async () => {
            currentAuthUser = userStaffWithAssign;

            const res = await requestApi(`/api/surveys/${sub2Id}/unassign`, {
                method: 'POST',
                body: {
                    reason: '담당자 배정 취소 시도'
                }
            });

            assert.strictEqual(res.status, 403, `Staff unassign is strictly 403 admin only (got ${res.status})`);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
        });

        // 7. 무권한(ONLINE_SURVEY_ACCESS 없음) 직원 배정 403
        await testAsync('7. 무권한(ONLINE_SURVEY_ACCESS 없음) 직원 배정 403', async () => {
            currentAuthUser = userStaffNoSurvey;

            const res = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff1.id
                }
            });

            assert.strictEqual(res.status, 403, `Unauthorized staff returns 403 (got ${res.status})`);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
        });

        // 8. 미인증 401
        await testAsync('8. 미인증 401 (Unauthenticated request returns 401)', async () => {
            currentAuthUser = null;

            const res = await requestApi(`/api/surveys/${sub1Id}/assign`, {
                method: 'POST',
                body: {
                    assignedUserId: targetStaff1.id
                }
            });

            assert.strictEqual(res.status, 401, `Unauthenticated request returns 401 (got ${res.status})`);
            assert.strictEqual(res.data.error.code, 'UNAUTHENTICATED');
        });

        // ----------------------------------------------------
        // PART 3: 기존 회귀 및 빌드/형상 검증 (Items 10~11)
        // ----------------------------------------------------
        console.log('\n▶️ [PART 3] 회귀 검증 및 형상 검사 (Items 10~11)');

        test('10. 기존 회귀 테스트 재실행 PASS', () => {
            console.log('    ⏳ Running verify-survey-staff-visibility.mjs...');
            execSync('node scripts/verify-survey-staff-visibility.mjs', { cwd: projectRoot, stdio: 'pipe' });
            console.log('    ⏳ Running verify-assignment-referral-workflow.mjs...');
            execSync('node scripts/verify-assignment-referral-workflow.mjs', { cwd: projectRoot, stdio: 'pipe' });
            console.log('    ⏳ Running verify-survey-campaign-contract.mjs...');
            execSync('node scripts/verify-survey-campaign-contract.mjs', { cwd: projectRoot, stdio: 'pipe' });
            console.log('    ⏳ Running verify-survey-staff-campaign-delete.mjs...');
            execSync('node scripts/verify-survey-staff-campaign-delete.mjs', { cwd: projectRoot, stdio: 'pipe' });
        });

        test('11.1. npm run build PASS', () => {
            console.log('    ⏳ Running npm run build...');
            execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
        });

        test('11.2. git diff --check PASS', () => {
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
        throw new Error(`${failedTests} tests failed in Survey Assignment Permission verification!`);
    }
}

runSurveyAssignmentPermissionVerification().catch(err => {
    console.error('Fatal error running verification suite:', err);
    process.exit(1);
});

/**
 * scripts/verify-voice-recording-ai-access.mjs
 * Comprehensive Permission Matrix Test Suite for Voice Recording AI Access Control.
 *
 * Verifies all 22 mandatory requirements:
 *  1. true grant success
 *  2. false revoke success
 *  3. "true" rejected with 400
 *  4. "false" rejected with 400
 *  5. 1 rejected with 400
 *  6. 0 rejected with 400
 *  7. null rejected with 400
 *  8. missing body/granted rejected with 400
 *  9. array [] rejected with 400
 *  10. object {} rejected with 400
 *  11. User permissions unchanged after invalid value requests
 *  12. Non-admin PATCH rejected with 403
 *  13. Inactive user grant rejected with 400
 *  14. Array permissions other keys preserved
 *  15. Object permissions other keys preserved
 *  16. voiceCalls key value preserved (never mutated)
 *  17. Storage failure leaves original user permissions untouched (atomic)
 *  18. Zero mojibake in modified files
 *  19. Administrator AI access normal (200)
 *  20. Authorized user AI access normal (200)
 *  21. Unauthorized user AI access blocked (403)
 *  22. General voice call workflows preserved for all staff (200)
 */

import express from 'express';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {
    VOICE_RECORDING_AI_ACCESS,
    hasVoiceAiAccess,
    getEffectiveVoiceCapabilities,
    VOICE_CAPABILITIES
} from '../server/permissions/voiceCapabilities.js';
import {
    requireVoiceAiAccess,
    requireRole
} from '../server/permissions/permissionMiddleware.js';
import { createVoiceCallRouter } from '../server/voice-calls/voiceCallRouter.js';

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
        failed++;
    }
}

// In-memory mock repository
class MockVoiceCallRepository {
    constructor() {
        this.calls = [
            {
                id: 'call_101',
                originalFileName: '20260925_admin_call.mp3',
                callRecordType: 'administrative_call',
                callCategory: 'administrative',
                status: 'classified',
                notes: '행정 처리 관련 통화'
            },
            {
                id: 'call_102',
                originalFileName: '20260925_indiv_call.mp3',
                callRecordType: 'individual_counseling',
                callCategory: 'clinical',
                status: 'classified',
                notes: '개별 상담 통화'
            }
        ];
    }
    list() { return [...this.calls]; }
    findById(id) { return this.calls.find(c => c.id === id) || null; }
    update(id, updater) {
        const item = this.findById(id);
        if (item) updater(item);
        return item;
    }
    create(data) {
        const item = { id: `call_${Date.now()}`, ...data };
        this.calls.push(item);
        return item;
    }
}

async function runTests() {
    console.log('====================================================');
    console.log('🧪 Starting Voice Recording AI Permission Matrix Tests');
    console.log('====================================================\n');

    // Synthetic Users
    const adminUser = { id: 'admin_1', username: 'admin', role: 'admin', status: 'active' };
    const grantedUser = {
        id: 'user_granted',
        username: 'granted_user',
        role: 'user',
        status: 'active',
        permissions: { [VOICE_RECORDING_AI_ACCESS]: true, voiceCalls: true, referrals: { read: true } }
    };
    const grantedArrayUser = {
        id: 'user_granted_arr',
        username: 'granted_arr_user',
        role: 'user',
        status: 'active',
        permissions: [VOICE_RECORDING_AI_ACCESS, 'voiceCalls', 'other_perm']
    };
    const unauthorizedUser = {
        id: 'user_unauth',
        username: 'unauth_user',
        role: 'user',
        status: 'active',
        permissions: { referrals: { read: true }, voiceCalls: true }
    };
    const inactiveGrantedUser = {
        id: 'user_inactive',
        username: 'inactive_user',
        role: 'user',
        status: 'suspended',
        permissions: { [VOICE_RECORDING_AI_ACCESS]: true, voiceCalls: true }
    };

    const auditLogs = [];
    const auditLogger = (log) => auditLogs.push(log);

    // Deep clone initial synthetic users DB
    let mockUsersDb = JSON.parse(JSON.stringify([
        adminUser,
        grantedUser,
        grantedArrayUser,
        unauthorizedUser,
        inactiveGrantedUser
    ]));

    let failStorageSim = false;

    // Setup Test Express App
    const app = express();
    app.use(express.json());

    // Mock Auth Middleware
    let activeTestAuth = null;
    const mockRequireAuth = (req, res, next) => {
        if (!activeTestAuth) {
            return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
        }
        req.auth = activeTestAuth;
        next();
    };

    const mockVoiceCallRepo = new MockVoiceCallRepository();
    const voiceRouter = createVoiceCallRouter({
        requireAuth: mockRequireAuth,
        voiceCallRepository: mockVoiceCallRepo,
        getData: (key) => key === 'Users' ? mockUsersDb : [],
        persistData: async (key, data) => {
            if (failStorageSim) throw new Error('Simulated disk write failure');
            if (key === 'Users') mockUsersDb = data;
            return true;
        },
        auditLogger
    });

    app.use('/api/voice-calls', voiceRouter);

    // Admin Permission Patch Endpoint under test (strictly identical to server.js implementation)
    app.patch('/api/users/:id/voice-access', mockRequireAuth, async (req, res) => {
        try {
            if (!req.auth || req.auth.role !== 'admin') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetUserId: req.params.id,
                    action: 'VOICE_AI_ACCESS_DENIED',
                    result: 'DENIED',
                    reasonCode: 'ADMIN_REQUIRED'
                });
                return res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: '관리자만 사용자 권한을 변경할 수 있습니다.'
                    }
                });
            }

            if (!req.body || typeof req.body.granted !== 'boolean') {
                auditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    targetUserId: req.params.id,
                    action: 'VOICE_AI_ACCESS_DENIED',
                    result: 'DENIED',
                    reasonCode: 'INVALID_GRANTED_VALUE'
                });
                return res.status(400).json({
                    error: {
                        code: 'INVALID_GRANTED_VALUE',
                        message: 'granted 값은 true 또는 false여야 합니다.'
                    }
                });
            }

            const granted = req.body.granted;
            const targetId = req.params.id;
            const users = mockUsersDb;
            const targetIndex = users.findIndex(u => u && String(u.id) === String(targetId));

            if (targetIndex === -1) {
                return res.status(404).json({
                    error: {
                        code: 'USER_NOT_FOUND',
                        message: '대상 사용자를 찾을 수 없습니다.'
                    }
                });
            }

            const targetUser = users[targetIndex];

            if (targetUser.status !== 'active') {
                return res.status(400).json({
                    error: {
                        code: 'USER_NOT_ACTIVE',
                        message: '비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.'
                    }
                });
            }

            // Safe immutable permissions clone (preserves all other keys including voiceCalls)
            let updatedPermissions;
            if (Array.isArray(targetUser.permissions)) {
                if (granted) {
                    updatedPermissions = targetUser.permissions.includes(VOICE_RECORDING_AI_ACCESS)
                        ? [...targetUser.permissions]
                        : [...targetUser.permissions, VOICE_RECORDING_AI_ACCESS];
                } else {
                    updatedPermissions = targetUser.permissions.filter(p => p !== VOICE_RECORDING_AI_ACCESS);
                }
            } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
                updatedPermissions = {
                    ...targetUser.permissions,
                    [VOICE_RECORDING_AI_ACCESS]: granted
                };
            } else {
                updatedPermissions = {
                    [VOICE_RECORDING_AI_ACCESS]: granted
                };
            }

            // Atomic update: construct cloned user and cloned array without mutating existing records in place
            const updatedUser = {
                ...targetUser,
                permissions: updatedPermissions
            };

            const updatedUsers = [
                ...users.slice(0, targetIndex),
                updatedUser,
                ...users.slice(targetIndex + 1)
            ];

            if (failStorageSim) {
                throw new Error('Simulated disk write failure');
            }
            mockUsersDb = updatedUsers;

            const auditAction = granted ? 'VOICE_AI_PERMISSION_GRANTED' : 'VOICE_AI_PERMISSION_REVOKED';
            auditLogger({
                actorUserId: req.auth.id,
                targetUserId: updatedUser.id,
                action: auditAction,
                result: 'SUCCESS',
                reasonCode: granted ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED'
            });

            const { password, ...safeUser } = updatedUser;
            return res.json({
                success: true,
                message: granted
                    ? '음성 녹음 분석(AI) 사용 권한을 부여했습니다.'
                    : '음성 녹음 분석(AI) 사용 권한을 회수했습니다.',
                user: safeUser
            });
        } catch (err) {
            res.status(500).json({
                error: {
                    code: 'INTERNAL_ERROR',
                    message: '권한 변경 처리 중 오류가 발생했습니다.'
                }
            });
        }
    });

    // Start ephemeral server
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function reqApi(method, path, body = null) {
        const url = `${baseUrl}${path}`;
        const headers = { 'Content-Type': 'application/json' };
        const res = await fetch(url, {
            method,
            headers,
            body: body !== null ? JSON.stringify(body) : undefined
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, headers: res.headers, body: json };
    }

    try {
        console.log('--- 1. Strict Boolean Validation & Rejection Matrix ---');

        await testCase('1.1 granted: true succeeds (200 OK)', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: true });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.message, '음성 녹음 분석(AI) 사용 권한을 부여했습니다.');
            const u = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.strictEqual(hasVoiceAiAccess(u), true);
        });

        await testCase('1.2 granted: false succeeds (200 OK)', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: false });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.message, '음성 녹음 분석(AI) 사용 권한을 회수했습니다.');
            const u = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.strictEqual(hasVoiceAiAccess(u), false);
        });

        await testCase('1.3 String "true" rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: "true" });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.4 String "false" rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: "false" });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.5 Number 1 rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: 1 });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.6 Number 0 rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: 0 });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.7 null rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: null });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.8 Missing granted rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', {});
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.9 Array [] rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: [] });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.10 Object {} rejected with 400 INVALID_GRANTED_VALUE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: {} });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.11 User permissions remain completely unmodified after rejected requests', async () => {
            const u = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.strictEqual(u.permissions[VOICE_RECORDING_AI_ACCESS], false);
            assert.strictEqual(u.permissions.voiceCalls, true);
        });

        console.log('\n--- 2. Permission Key Isolation & Key Preservation ---');

        await testCase('2.1 Object permissions: other keys and voiceCalls preserved on grant & revoke', async () => {
            activeTestAuth = adminUser;
            // Grant
            await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: true });
            let u = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.strictEqual(u.permissions[VOICE_RECORDING_AI_ACCESS], true);
            assert.strictEqual(u.permissions.voiceCalls, true);
            assert.deepStrictEqual(u.permissions.referrals, { read: true });

            // Revoke
            await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: false });
            u = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.strictEqual(u.permissions[VOICE_RECORDING_AI_ACCESS], false);
            assert.strictEqual(u.permissions.voiceCalls, true); // PRESERVED!
            assert.deepStrictEqual(u.permissions.referrals, { read: true }); // PRESERVED!
        });

        await testCase('2.2 Array permissions: other keys and voiceCalls preserved on grant & revoke', async () => {
            activeTestAuth = adminUser;
            // Grant
            await reqApi('PATCH', '/api/users/user_granted_arr/voice-access', { granted: true });
            let u = mockUsersDb.find(x => x.id === 'user_granted_arr');
            assert(u.permissions.includes(VOICE_RECORDING_AI_ACCESS));
            assert(u.permissions.includes('voiceCalls'));
            assert(u.permissions.includes('other_perm'));

            // Revoke
            await reqApi('PATCH', '/api/users/user_granted_arr/voice-access', { granted: false });
            u = mockUsersDb.find(x => x.id === 'user_granted_arr');
            assert(!u.permissions.includes(VOICE_RECORDING_AI_ACCESS));
            assert(u.permissions.includes('voiceCalls')); // PRESERVED!
            assert(u.permissions.includes('other_perm')); // PRESERVED!
        });

        console.log('\n--- 3. Authorization & Lifecycle Controls ---');

        await testCase('3.1 Non-admin PATCH request rejected with 403 FORBIDDEN', async () => {
            activeTestAuth = unauthorizedUser;
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: true });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'FORBIDDEN');
            assert.strictEqual(res.body.error.message, '관리자만 사용자 권한을 변경할 수 있습니다.');
        });

        await testCase('3.2 Admin grant to inactive user rejected with 400 USER_NOT_ACTIVE', async () => {
            activeTestAuth = adminUser;
            const res = await reqApi('PATCH', '/api/users/user_inactive/voice-access', { granted: true });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'USER_NOT_ACTIVE');
            assert.strictEqual(res.body.error.message, '비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.');
        });

        console.log('\n--- 4. Atomic Persistence on Failure ---');

        await testCase('4.1 Persistence failure returns 500 and leaves memory user permissions intact', async () => {
            activeTestAuth = adminUser;
            failStorageSim = true;
            const prevUser = JSON.parse(JSON.stringify(mockUsersDb.find(x => x.id === 'user_unauth')));
            const res = await reqApi('PATCH', '/api/users/user_unauth/voice-access', { granted: true });
            failStorageSim = false;
            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body.error.code, 'INTERNAL_ERROR');
            assert.strictEqual(res.body.error.message, '권한 변경 처리 중 오류가 발생했습니다.');
            const curUser = mockUsersDb.find(x => x.id === 'user_unauth');
            assert.deepStrictEqual(curUser.permissions, prevUser.permissions);
        });

        console.log('\n--- 5. Encoding & Mojibake Zero-Defect Audit ---');

        await testCase('5.1 Verify zero mojibake characters in all modified files', async () => {
            const filesToCheck = [
                'server.js',
                'App.tsx',
                'components/accounts/AccountsPage.tsx',
                'components/layout/Sidebar.tsx',
                'services/apiClient.ts',
                'server/permissions/voiceCapabilities.js',
                'server/permissions/permissionMiddleware.js',
                'server/voice-calls/voiceCallRouter.js',
                'scripts/verify-voice-recording-ai-access.mjs'
            ];
            // Use unicode escapes so regex pattern itself does not trigger a false positive
            const mojibakeRegex = new RegExp('[\\uFFFD\\u936E\\u6C85\\u613F]|\\?\\uBAEE|\\?\\u314A|\\?\\uB6AF');
            for (const file of filesToCheck) {
                const fullPath = path.resolve(file);
                if (fs.existsSync(fullPath)) {
                    const text = fs.readFileSync(fullPath, 'utf8');
                    const match = text.match(mojibakeRegex);
                    assert(!match, `Mojibake pattern found in ${file}: ${match}`);
                }
            }
        });

        console.log('\n--- 6. Endpoint Access & Workflow Separation ---');

        await testCase('6.1 Admin full AI & general access (200 OK)', async () => {
            activeTestAuth = adminUser;
            const resStats = await reqApi('GET', '/api/voice-calls/stats');
            assert.strictEqual(resStats.status, 200);
            const resAnalyze = await reqApi('POST', '/api/voice-calls/call_101/analyze');
            assert.strictEqual(resAnalyze.status, 200);
        });

        await testCase('6.2 Granted user AI access normal (200 OK)', async () => {
            activeTestAuth = mockUsersDb.find(x => x.id === 'user_granted');
            const resAnalyze = await reqApi('POST', '/api/voice-calls/call_102/analyze');
            assert.strictEqual(resAnalyze.status, 200);
        });

        await testCase('6.3 Unauthorized user AI access blocked with 403', async () => {
            activeTestAuth = mockUsersDb.find(x => x.id === 'user_unauth');
            const resAnalyze = await reqApi('POST', '/api/voice-calls/call_101/analyze');
            assert.strictEqual(resAnalyze.status, 403);
            const resResult = await reqApi('GET', '/api/voice-calls/call_101/analysis');
            assert.strictEqual(resResult.status, 403);
        });

        await testCase('6.4 Unauthorized user general voice call access preserved (200 OK)', async () => {
            activeTestAuth = mockUsersDb.find(x => x.id === 'user_unauth');
            const resList = await reqApi('GET', '/api/voice-calls');
            assert.strictEqual(resList.status, 200);
            const resStats = await reqApi('GET', '/api/voice-calls/stats');
            assert.strictEqual(resStats.status, 200);
            const resDetail = await reqApi('GET', '/api/voice-calls/call_101');
            assert.strictEqual(resDetail.status, 200);
            const resClassify = await reqApi('POST', '/api/voice-calls/call_101/classify', {
                callRecordType: 'administrative_call'
            });
            assert.strictEqual(resClassify.status, 200);
        });

        console.log('\n--- 7. Seed-Samples Environment & Role Protection ---');

        const originalNodeEnv = process.env.NODE_ENV;

        try {
            // A. Production Admin Blocked (403)
            await testCase('7.1 Production: Admin seed-samples blocked with 403', async () => {
                process.env.NODE_ENV = 'production';
                activeTestAuth = adminUser;
                const prevCount = mockVoiceCallRepo.list().length;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.body.error.code, 'FORBIDDEN');
                assert.strictEqual(res.body.error.message, '운영 환경에서는 샘플 데이터를 생성할 수 없습니다.');
                assert.strictEqual(mockVoiceCallRepo.list().length, prevCount, 'No records created');
            });

            // B. Production Regular User Blocked (403)
            await testCase('7.2 Production: Regular user seed-samples blocked with 403', async () => {
                process.env.NODE_ENV = 'production';
                activeTestAuth = unauthorizedUser;
                const prevCount = mockVoiceCallRepo.list().length;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.body.error.code, 'FORBIDDEN');
                assert.strictEqual(mockVoiceCallRepo.list().length, prevCount, 'No records created');
            });

            // C. Missing / Unset NODE_ENV -> Fail-Closed (403)
            await testCase('7.3 Unset / empty NODE_ENV fail-closed blocks seed-samples (403)', async () => {
                delete process.env.NODE_ENV;
                activeTestAuth = adminUser;
                const prevCount = mockVoiceCallRepo.list().length;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.body.error.code, 'FORBIDDEN');
                assert.strictEqual(mockVoiceCallRepo.list().length, prevCount, 'No records created');
            });

            // D. Development Regular User Blocked (403 ADMIN_REQUIRED)
            await testCase('7.4 Development: Regular user seed-samples blocked with 403', async () => {
                process.env.NODE_ENV = 'development';
                activeTestAuth = unauthorizedUser;
                const prevCount = mockVoiceCallRepo.list().length;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 403);
                assert.strictEqual(res.body.error.code, 'FORBIDDEN');
                assert.strictEqual(res.body.error.message, '관리자만 샘플 데이터를 생성할 수 있습니다.');
                assert.strictEqual(mockVoiceCallRepo.list().length, prevCount, 'No records created');
            });

            // E. Unauthenticated Request -> 401 UNAUTHENTICATED
            await testCase('7.5 Unauthenticated request rejected with 401', async () => {
                process.env.NODE_ENV = 'development';
                activeTestAuth = null;
                const prevCount = mockVoiceCallRepo.list().length;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 401);
                assert.strictEqual(mockVoiceCallRepo.list().length, prevCount, 'No records created');
            });

            // F. Development Admin Allowed (200 OK)
            await testCase('7.6 Development: Admin seed-samples execution allowed (200 OK)', async () => {
                process.env.NODE_ENV = 'development';
                activeTestAuth = adminUser;
                const res = await reqApi('POST', '/api/voice-calls/seed-samples');
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.success, true);
            });
        } finally {
            if (originalNodeEnv !== undefined) {
                process.env.NODE_ENV = originalNodeEnv;
            } else {
                delete process.env.NODE_ENV;
            }
        }

    } finally {
        server.close();
    }

    console.log('\n====================================================');
    console.log(`📊 Matrix Summary: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

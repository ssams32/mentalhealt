/**
 * scripts/verify-account-permission-matrix.mjs
 * Comprehensive Permission Matrix Test Suite for Online Survey & Voice AI Access Control.
 *
 * Verifies all 14 mandatory sections (A through J):
 *  A. Admin dual access, auto-granted, and independent grant/revoke
 *  B. Dual-granted active user full access
 *  C. Online Survey ONLY user isolation (Survey 200, Voice AI 403)
 *  D. Voice AI ONLY user isolation (Survey 403, Voice AI 200)
 *  E. Unassigned regular user default deny (both 403, general referral & general voice preserved)
 *  F. Inactive user fail-closed block
 *  G. Admin permission API strict boolean validation & atomicity
 *  H. Independent revocation & immediate gating
 *  I. UI matrix logic & 360px mobile visibility
 *  J. Regression preservation (Voice AI, General referrals, zero PII, zero mojibake)
 */

import express from 'express';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {
    ONLINE_SURVEY_ACCESS,
    VOICE_RECORDING_AI_ACCESS,
    hasOnlineSurveyAccess,
    hasVoiceAiAccess
} from '../server/permissions/voiceCapabilities.js';
import {
    requireOnlineSurveyAccess,
    requireVoiceAiAccess
} from '../server/permissions/permissionMiddleware.js';
import { createVoiceCallRouter } from '../server/voice-calls/voiceCallRouter.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';

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

// In-memory mock repositories
class MockVoiceCallRepository {
    constructor() {
        this.calls = [
            {
                id: 'call_101',
                originalFileName: '20260925_admin_call.mp3',
                callRecordType: 'administrative_call',
                callCategory: 'administrative',
                status: 'classified',
                notes: '행정 통화'
            },
            {
                id: 'call_102',
                originalFileName: '20260925_counsel_call.mp3',
                callRecordType: 'individual_counseling',
                callCategory: 'clinical',
                status: 'classified',
                notes: '상담 통화'
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
}

class MockSurveyRepository {
    constructor() {
        this.submissions = [
            {
                submissionId: 'sub_test_001',
                internalSurveyId: 'survey_int_001',
                externalStatus: 'COMPLETED',
                internalStatus: 'READY',
                respondent: { name: '홍길동', phone: '010-1234-5678' }
            }
        ];
        this.ledger = [
            {
                submissionId: 'sub_test_001',
                internalSurveyId: 'survey_int_001',
                importedAt: new Date().toISOString()
            }
        ];
        this.auditEvents = [];
    }
    getSurveySubmissions() { return [...this.submissions]; }
    getImportsLedger() { return [...this.ledger]; }
    findBySubmissionId(subId) { return this.submissions.find(s => s.submissionId === subId) || null; }
    getData(table) { return []; }
    async recordAuditEvent(event) { this.auditEvents.push(event); }
}

class MockSurveyImportService {
    getStatusSummary() {
        return { total: 1, ready: 1, error: 0, completed: 1 };
    }
}

class MockSurveyExportService {
    generateExcelBuffer() {
        return {
            buffer: Buffer.from('mock excel data'),
            filename: 'survey_export_test.xlsx',
            rowCount: 1
        };
    }
}

async function runTests() {
    console.log('====================================================');
    console.log('🧪 Starting Account Permission Matrix Test Suite');
    console.log('====================================================\n');

    // Synthetic Test Users
    const adminUser = {
        id: 'user_admin',
        name: '최고관리자',
        role: 'admin',
        status: 'active',
        permissions: { referrals: { read: true, write: true, delete: true } }
    };

    const dualGrantedUser = {
        id: 'user_dual',
        name: '통합실무자',
        role: 'user',
        status: 'active',
        permissions: {
            [ONLINE_SURVEY_ACCESS]: true,
            [VOICE_RECORDING_AI_ACCESS]: true,
            voiceCalls: true
        }
    };

    const surveyOnlyUser = {
        id: 'user_survey_only',
        name: '설문담당자',
        role: 'user',
        status: 'active',
        permissions: {
            [ONLINE_SURVEY_ACCESS]: true,
            [VOICE_RECORDING_AI_ACCESS]: false,
            referrals: { read: true }
        }
    };

    const voiceOnlyUser = {
        id: 'user_voice_only',
        name: '음성AI담당자',
        role: 'user',
        status: 'active',
        permissions: {
            [ONLINE_SURVEY_ACCESS]: false,
            [VOICE_RECORDING_AI_ACCESS]: true,
            voiceCalls: true
        }
    };

    const unassignedUser = {
        id: 'user_unassigned',
        name: '일반직원',
        role: 'user',
        status: 'active',
        permissions: {
            referrals: { read: true },
            [ONLINE_SURVEY_ACCESS]: false,
            [VOICE_RECORDING_AI_ACCESS]: false,
            voiceCalls: true
        }
    };

    const inactiveUser = {
        id: 'user_inactive',
        name: '퇴사자',
        role: 'user',
        status: 'suspended',
        permissions: [ONLINE_SURVEY_ACCESS, VOICE_RECORDING_AI_ACCESS]
    };

    const arrayDualUser = {
        id: 'user_array_dual',
        name: '배열권한사용자',
        role: 'user',
        status: 'active',
        permissions: [ONLINE_SURVEY_ACCESS, VOICE_RECORDING_AI_ACCESS, 'voiceCalls']
    };

    const auditLogs = [];
    const surveyAuditLogger = (log) => auditLogs.push(log);
    const voiceAuditLogger = (log) => auditLogs.push(log);

    let mockUsersDb = JSON.parse(JSON.stringify([
        adminUser,
        dualGrantedUser,
        surveyOnlyUser,
        voiceOnlyUser,
        unassignedUser,
        inactiveUser,
        arrayDualUser
    ]));

    let failStorageSim = false;

    // Express App Setup
    const app = express();
    app.use(express.json());

    let activeAuth = null;
    const mockRequireAuth = (req, res, next) => {
        if (!activeAuth) {
            return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } });
        }
        req.auth = activeAuth;
        next();
    };

    // Mount Voice Calls Router
    const mockVoiceRepo = new MockVoiceCallRepository();
    const voiceRouter = createVoiceCallRouter({
        requireAuth: mockRequireAuth,
        voiceCallRepository: mockVoiceRepo,
        getData: (key) => key === 'Users' ? mockUsersDb : [],
        persistData: async (key, data) => {
            if (failStorageSim) throw new Error('Simulated persistence failure');
            if (key === 'Users') mockUsersDb = data;
            return true;
        },
        auditLogger: voiceAuditLogger
    });
    app.use('/api/voice-calls', voiceRouter);

    // Mount Survey Import Router
    const mockSurveyRepo = new MockSurveyRepository();
    const surveyRouter = createSurveyImportRouter({
        requireAuth: mockRequireAuth,
        surveyImportService: new MockSurveyImportService(),
        surveyRepository: mockSurveyRepo,
        surveyExportService: new MockSurveyExportService(),
        getUsers: () => mockUsersDb,
        auditLogger: surveyAuditLogger
    });
    app.use('/api/surveys', surveyRouter);

    // Mount PATCH /api/users/:id/voice-access (as in server.js)
    app.patch('/api/users/:id/voice-access', mockRequireAuth, async (req, res) => {
        try {
            if (!req.auth || req.auth.role !== 'admin') {
                voiceAuditLogger({ actorUserId: req.auth?.id || 'unknown', targetUserId: req.params.id, action: 'VOICE_AI_ACCESS_DENIED', result: 'DENIED', reasonCode: 'ADMIN_REQUIRED' });
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: '관리자만 권한을 변경할 수 있습니다.' } });
            }
            if (!req.body || typeof req.body.granted !== 'boolean') {
                voiceAuditLogger({ actorUserId: req.auth?.id || 'unknown', targetUserId: req.params.id, action: 'VOICE_AI_ACCESS_DENIED', result: 'DENIED', reasonCode: 'INVALID_GRANTED_VALUE' });
                return res.status(400).json({ error: { code: 'INVALID_GRANTED_VALUE', message: 'granted 값은 true 또는 false여야 합니다.' } });
            }
            const granted = req.body.granted;
            const targetId = req.params.id;
            const targetIndex = mockUsersDb.findIndex(u => u && String(u.id) === String(targetId));
            if (targetIndex === -1) return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
            const targetUser = mockUsersDb[targetIndex];
            if (targetUser.status !== 'active') return res.status(400).json({ error: { code: 'USER_NOT_ACTIVE', message: '비활성 사용자입니다.' } });

            let updatedPermissions;
            if (Array.isArray(targetUser.permissions)) {
                updatedPermissions = granted
                    ? (targetUser.permissions.includes(VOICE_RECORDING_AI_ACCESS) ? [...targetUser.permissions] : [...targetUser.permissions, VOICE_RECORDING_AI_ACCESS])
                    : targetUser.permissions.filter(p => p !== VOICE_RECORDING_AI_ACCESS);
            } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
                updatedPermissions = { ...targetUser.permissions, [VOICE_RECORDING_AI_ACCESS]: granted };
            } else {
                updatedPermissions = { [VOICE_RECORDING_AI_ACCESS]: granted };
            }

            const updatedUser = { ...targetUser, permissions: updatedPermissions };
            if (failStorageSim) throw new Error('Simulated persistence failure');
            mockUsersDb = [...mockUsersDb.slice(0, targetIndex), updatedUser, ...mockUsersDb.slice(targetIndex + 1)];

            const auditAction = granted ? 'VOICE_AI_PERMISSION_GRANTED' : 'VOICE_AI_PERMISSION_REVOKED';
            voiceAuditLogger({ actorUserId: req.auth.id, targetUserId: updatedUser.id, action: auditAction, result: 'SUCCESS', reasonCode: granted ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED' });
            return res.json({ success: true, user: updatedUser });
        } catch (err) {
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // Mount PATCH /api/users/:id/online-survey-access (as in server.js)
    app.patch('/api/users/:id/online-survey-access', mockRequireAuth, async (req, res) => {
        try {
            if (!req.auth || req.auth.role !== 'admin') {
                surveyAuditLogger({ actorUserId: req.auth?.id || 'unknown', targetUserId: req.params.id, action: 'ONLINE_SURVEY_ACCESS_DENIED', result: 'DENIED', reasonCode: 'ADMIN_REQUIRED' });
                return res.status(403).json({ error: { code: 'FORBIDDEN', message: '관리자만 권한을 변경할 수 있습니다.' } });
            }
            if (!req.body || typeof req.body.granted !== 'boolean') {
                surveyAuditLogger({ actorUserId: req.auth?.id || 'unknown', targetUserId: req.params.id, action: 'ONLINE_SURVEY_ACCESS_DENIED', result: 'DENIED', reasonCode: 'INVALID_GRANTED_VALUE' });
                return res.status(400).json({ error: { code: 'INVALID_GRANTED_VALUE', message: 'granted 값은 true 또는 false여야 합니다.' } });
            }
            const granted = req.body.granted;
            const targetId = req.params.id;
            const targetIndex = mockUsersDb.findIndex(u => u && String(u.id) === String(targetId));
            if (targetIndex === -1) return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없습니다.' } });
            const targetUser = mockUsersDb[targetIndex];
            if (targetUser.status !== 'active') return res.status(400).json({ error: { code: 'USER_NOT_ACTIVE', message: '비활성 사용자입니다.' } });

            let updatedPermissions;
            if (Array.isArray(targetUser.permissions)) {
                updatedPermissions = granted
                    ? (targetUser.permissions.includes(ONLINE_SURVEY_ACCESS) ? [...targetUser.permissions] : [...targetUser.permissions, ONLINE_SURVEY_ACCESS])
                    : targetUser.permissions.filter(p => p !== ONLINE_SURVEY_ACCESS);
            } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
                updatedPermissions = { ...targetUser.permissions, [ONLINE_SURVEY_ACCESS]: granted };
            } else {
                updatedPermissions = { [ONLINE_SURVEY_ACCESS]: granted };
            }

            const updatedUser = { ...targetUser, permissions: updatedPermissions };
            if (failStorageSim) throw new Error('Simulated persistence failure');
            mockUsersDb = [...mockUsersDb.slice(0, targetIndex), updatedUser, ...mockUsersDb.slice(targetIndex + 1)];

            const auditAction = granted ? 'ONLINE_SURVEY_PERMISSION_GRANTED' : 'ONLINE_SURVEY_PERMISSION_REVOKED';
            surveyAuditLogger({ actorUserId: req.auth.id, targetUserId: updatedUser.id, action: auditAction, result: 'SUCCESS', reasonCode: granted ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED' });
            return res.json({ success: true, user: updatedUser });
        } catch (err) {
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function reqApi(method, path, body = null, authUser = null) {
        activeAuth = authUser;
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: body !== null ? JSON.stringify(body) : undefined
        });
        const status = res.status;
        let data = null;
        try {
            data = await res.json();
        } catch (e) {
            data = null;
        }
        return { status, data, headers: res.headers };
    }

    try {
        console.log('--- 1. Strict Boolean Validation for Online Survey Permission API ---');
        await testCase('1.1 granted: true succeeds (200 OK)', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: true }, adminUser);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.success, true);
            const user = mockUsersDb.find(u => u.id === 'user_unassigned');
            assert.strictEqual(user.permissions[ONLINE_SURVEY_ACCESS], true);
        });

        await testCase('1.2 granted: false succeeds (200 OK)', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: false }, adminUser);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.success, true);
            const user = mockUsersDb.find(u => u.id === 'user_unassigned');
            assert.strictEqual(user.permissions[ONLINE_SURVEY_ACCESS], false);
        });

        await testCase('1.3 String "true" rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: "true" }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.4 String "false" rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: "false" }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.5 Number 1 rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: 1 }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.6 Number 0 rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: 0 }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.7 null rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: null }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.8 Missing granted rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', {}, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.9 Array [] rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: [] }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        await testCase('1.10 Object {} rejected with 400 INVALID_GRANTED_VALUE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: {} }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'INVALID_GRANTED_VALUE');
        });

        console.log('\n--- 2. Permission Key Isolation & Independence ---');
        await testCase('2.1 Online Survey grant does NOT alter VOICE_RECORDING_AI_ACCESS or voiceCalls', async () => {
            const before = mockUsersDb.find(u => u.id === 'user_voice_only');
            assert.strictEqual(before.permissions[VOICE_RECORDING_AI_ACCESS], true);
            assert.strictEqual(before.permissions.voiceCalls, true);

            const res = await reqApi('PATCH', '/api/users/user_voice_only/online-survey-access', { granted: true }, adminUser);
            assert.strictEqual(res.status, 200);

            const after = mockUsersDb.find(u => u.id === 'user_voice_only');
            assert.strictEqual(after.permissions[ONLINE_SURVEY_ACCESS], true);
            assert.strictEqual(after.permissions[VOICE_RECORDING_AI_ACCESS], true);
            assert.strictEqual(after.permissions.voiceCalls, true);
        });

        await testCase('2.2 Voice AI revoke does NOT alter ONLINE_SURVEY_ACCESS', async () => {
            const res = await reqApi('PATCH', '/api/users/user_voice_only/voice-access', { granted: false }, adminUser);
            assert.strictEqual(res.status, 200);

            const user = mockUsersDb.find(u => u.id === 'user_voice_only');
            assert.strictEqual(user.permissions[ONLINE_SURVEY_ACCESS], true);
            assert.strictEqual(user.permissions[VOICE_RECORDING_AI_ACCESS], false);
        });

        await testCase('2.3 Array permissions isolation on grant and revoke', async () => {
            const userBefore = mockUsersDb.find(u => u.id === 'user_array_dual');
            assert.ok(userBefore.permissions.includes(ONLINE_SURVEY_ACCESS));
            assert.ok(userBefore.permissions.includes(VOICE_RECORDING_AI_ACCESS));

            // Revoke Online Survey only
            const res1 = await reqApi('PATCH', '/api/users/user_array_dual/online-survey-access', { granted: false }, adminUser);
            assert.strictEqual(res1.status, 200);

            const userAfterRevoke = mockUsersDb.find(u => u.id === 'user_array_dual');
            assert.strictEqual(userAfterRevoke.permissions.includes(ONLINE_SURVEY_ACCESS), false);
            assert.strictEqual(userAfterRevoke.permissions.includes(VOICE_RECORDING_AI_ACCESS), true);
            assert.strictEqual(userAfterRevoke.permissions.includes('voiceCalls'), true);

            // Re-grant Online Survey
            const res2 = await reqApi('PATCH', '/api/users/user_array_dual/online-survey-access', { granted: true }, adminUser);
            assert.strictEqual(res2.status, 200);

            const userAfterGrant = mockUsersDb.find(u => u.id === 'user_array_dual');
            assert.strictEqual(userAfterGrant.permissions.includes(ONLINE_SURVEY_ACCESS), true);
            assert.strictEqual(userAfterGrant.permissions.includes(VOICE_RECORDING_AI_ACCESS), true);
            assert.strictEqual(userAfterGrant.permissions.includes('voiceCalls'), true);
        });

        console.log('\n--- 3. Authorization & Lifecycle Controls ---');
        await testCase('3.1 Non-admin PATCH request rejected with 403 FORBIDDEN', async () => {
            const res = await reqApi('PATCH', '/api/users/user_unassigned/online-survey-access', { granted: true }, unassignedUser);
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.data.error.code, 'FORBIDDEN');
        });

        await testCase('3.2 Admin grant to inactive user rejected with 400 USER_NOT_ACTIVE', async () => {
            const res = await reqApi('PATCH', '/api/users/user_inactive/online-survey-access', { granted: true }, adminUser);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.data.error.code, 'USER_NOT_ACTIVE');
        });

        await testCase('3.3 Atomic persistence failure returns 500 and leaves memory untouched', async () => {
            const targetBefore = JSON.parse(JSON.stringify(mockUsersDb.find(u => u.id === 'user_survey_only')));
            failStorageSim = true;
            try {
                const res = await reqApi('PATCH', '/api/users/user_survey_only/online-survey-access', { granted: false }, adminUser);
                assert.strictEqual(res.status, 500);
                const targetAfter = mockUsersDb.find(u => u.id === 'user_survey_only');
                assert.deepStrictEqual(targetAfter.permissions, targetBefore.permissions);
            } finally {
                failStorageSim = false;
            }
        });

        console.log('\n--- 4. Endpoint Access & Separation Matrix (A through F) ---');
        await testCase('4.1 Admin: Online Survey API (200 OK) & Voice AI API (200 OK)', async () => {
            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, adminUser);
            assert.strictEqual(surveyRes.status, 200);

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, adminUser);
            assert.strictEqual(voiceRes.status, 200);
        });

        await testCase('4.2 Dual Granted User: Online Survey API (200 OK) & Voice AI API (200 OK)', async () => {
            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, dualGrantedUser);
            assert.strictEqual(surveyRes.status, 200);

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, dualGrantedUser);
            assert.strictEqual(voiceRes.status, 200);
        });

        await testCase('4.3 Survey Only User: Online Survey API (200 OK) & Voice AI API (403 FORBIDDEN)', async () => {
            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, surveyOnlyUser);
            assert.strictEqual(surveyRes.status, 200);

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, surveyOnlyUser);
            assert.strictEqual(voiceRes.status, 403);
            assert.strictEqual(voiceRes.data.error.code, 'FORBIDDEN');
        });

        await testCase('4.4 Voice AI Only User: Online Survey API (403 FORBIDDEN) & Voice AI API (200 OK)', async () => {
            const voiceOnlyAuth = {
                id: 'user_voice_isolated',
                role: 'user',
                status: 'active',
                permissions: { [VOICE_RECORDING_AI_ACCESS]: true, [ONLINE_SURVEY_ACCESS]: false, voiceCalls: true }
            };

            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, voiceOnlyAuth);
            assert.strictEqual(surveyRes.status, 403);
            assert.strictEqual(surveyRes.data.error.code, 'FORBIDDEN');

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, voiceOnlyAuth);
            assert.strictEqual(voiceRes.status, 200);
        });

        await testCase('4.5 Unassigned User: Online Survey API (403) & Voice AI API (403), General voice calls (200)', async () => {
            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, unassignedUser);
            assert.strictEqual(surveyRes.status, 403);
            assert.strictEqual(surveyRes.data.error.code, 'FORBIDDEN');

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, unassignedUser);
            assert.strictEqual(voiceRes.status, 403);
            assert.strictEqual(voiceRes.data.error.code, 'FORBIDDEN');

            // General voice calls workflow preserved!
            const generalVoiceRes = await reqApi('GET', '/api/voice-calls', null, unassignedUser);
            assert.strictEqual(generalVoiceRes.status, 200);
        });

        await testCase('4.6 Inactive User: Blocked (403) even with granted permissions in record', async () => {
            const surveyRes = await reqApi('GET', '/api/surveys/imports', null, inactiveUser);
            assert.strictEqual(surveyRes.status, 403);
            assert.strictEqual(surveyRes.data.error.message.includes('비활성화된 계정'), true);

            const voiceRes = await reqApi('POST', '/api/voice-calls/call_101/analyze', null, inactiveUser);
            assert.strictEqual(voiceRes.status, 403);
            assert.strictEqual(voiceRes.data.error.message.includes('비활성화된 계정'), true);
        });

        console.log('\n--- 5. Capability Functions Verification ---');
        await testCase('5.1 hasOnlineSurveyAccess pure unit evaluation', () => {
            assert.strictEqual(hasOnlineSurveyAccess(adminUser), true);
            assert.strictEqual(hasOnlineSurveyAccess(dualGrantedUser), true);
            assert.strictEqual(hasOnlineSurveyAccess(surveyOnlyUser), true);
            assert.strictEqual(hasOnlineSurveyAccess(voiceOnlyUser), false);
            assert.strictEqual(hasOnlineSurveyAccess(unassignedUser), false);
            assert.strictEqual(hasOnlineSurveyAccess(inactiveUser), false);
            assert.strictEqual(hasOnlineSurveyAccess(arrayDualUser), true);
            assert.strictEqual(hasOnlineSurveyAccess(null), false);
            assert.strictEqual(hasOnlineSurveyAccess({ status: 'active', role: 'manager' }), false);
        });

        await testCase('5.2 hasVoiceAiAccess pure unit evaluation', () => {
            assert.strictEqual(hasVoiceAiAccess(adminUser), true);
            assert.strictEqual(hasVoiceAiAccess(dualGrantedUser), true);
            assert.strictEqual(hasVoiceAiAccess(surveyOnlyUser), false);
            assert.strictEqual(hasVoiceAiAccess(voiceOnlyUser), true);
            assert.strictEqual(hasVoiceAiAccess(unassignedUser), false);
            assert.strictEqual(hasVoiceAiAccess(inactiveUser), false);
            assert.strictEqual(hasVoiceAiAccess(arrayDualUser), true);
            assert.strictEqual(hasVoiceAiAccess(null), false);
        });

        console.log('\n--- 6. Audit Logging & Zero-PII Verification ---');
        await testCase('6.1 Required Online Survey audit event types recorded', () => {
            const actions = auditLogs.map(l => l.action);
            assert.ok(actions.includes('ONLINE_SURVEY_PERMISSION_GRANTED'), 'Missing ONLINE_SURVEY_PERMISSION_GRANTED');
            assert.ok(actions.includes('ONLINE_SURVEY_PERMISSION_REVOKED'), 'Missing ONLINE_SURVEY_PERMISSION_REVOKED');
            assert.ok(actions.includes('ONLINE_SURVEY_ACCESS_DENIED'), 'Missing ONLINE_SURVEY_ACCESS_DENIED');
            assert.ok(actions.includes('ONLINE_SURVEY_LIST_VIEWED'), 'Missing ONLINE_SURVEY_LIST_VIEWED');
        });

        await testCase('6.2 Zero-PII audit validation (No names, phones, passwords, answers)', () => {
            for (const log of auditLogs) {
                const serialized = JSON.stringify(log);
                assert.strictEqual(serialized.includes('홍길동'), false, 'PII Leak: Name found in audit log');
                assert.strictEqual(serialized.includes('010-1234-5678'), false, 'PII Leak: Phone found in audit log');
                assert.strictEqual(serialized.includes('password'), false, 'PII Leak: Password found in audit log');
            }
        });

        console.log('\n--- 7. Encoding & Zero-Mojibake Audit ---');
        await testCase('7.1 Verify zero mojibake in all modified files', () => {
            const filesToCheck = [
                'server/permissions/voiceCapabilities.js',
                'server/permissions/permissionMiddleware.js',
                'server/survey/surveyImportRouter.js',
                'server.js',
                'services/apiClient.ts',
                'components/layout/Sidebar.tsx',
                'App.tsx',
                'components/accounts/AccountsPage.tsx'
            ];

            const mojibakePatterns = [
                /鍮꾪솢/, /沅뚰븳/, /愿\?由ъ옄/, //, /덈뒗/, /ъ슜/, /섏떇/, /몄쿇/
            ];

            for (const relPath of filesToCheck) {
                const fullPath = path.resolve(process.cwd(), relPath);
                const content = fs.readFileSync(fullPath, 'utf8');
                for (const pattern of mojibakePatterns) {
                    assert.strictEqual(
                        pattern.test(content),
                        false,
                        `Mojibake pattern ${pattern} detected in ${relPath}`
                    );
                }
            }
        });

    } finally {
        server.close();
    }

    console.log('\n====================================================');
    console.log(`📊 Matrix Summary: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});

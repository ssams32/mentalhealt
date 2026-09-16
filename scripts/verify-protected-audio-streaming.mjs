/**
 * scripts/verify-protected-audio-streaming.mjs
 * Comprehensive Test Suite for Mind-ERP OS Track A7:
 * Authenticated HTTP Range Audio Streaming, Access Control, and Audit Logging.
 * 
 * Tests 100% synthetic files and synthetic users in an isolated temporary test harness.
 */

import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';
import http from 'http';
import { Writable } from 'stream';

import { SessionRepository } from '../server/auth/sessionRepository.js';
import { AuthService } from '../server/auth/authService.js';
import { createAuthMiddleware } from '../server/auth/authMiddleware.js';
import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import {
    PrivateAudioAccessService,
    AuditEventSink,
    createAudioStreamingRouter,
    STREAMING_ERROR_CODES,
    AUDIT_EVENT_TYPES
} from '../server/audio-streaming/index.js';
import { AudioStreamingController } from '../server/audio-streaming/audioStreamingController.js';
import {
    STORAGE_RECONCILIATION_CHECKS
} from '../server/audio-storage/index.js';
import {
    PROCESSING_STATUS,
    ASSIGNMENT_STATUS,
    INTAKE_VALIDATION_STATUS,
    AUDIO_INTAKE_SOURCE
} from '../server/voice-calls/voiceCallConstants.js';
import { resolveAndValidatePath } from '../server/audio-storage/privateAudioStorageKey.js';
import {
    resolveCanonicalDepartmentId,
    CANONICAL_DEPARTMENTS
} from '../server/permissions/canonicalDepartment.js';
import {
    VoiceAccessRepository,
    VoiceAccessAuthorizer,
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    ALL_VOICE_ACCESS_CAPABILITIES
} from '../server/voice-access/index.js';

// Setup Isolated Directory
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
const PRIVATE_AUDIO_DIR = path.join(TEST_ROOT, 'private-audio');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_AUDIO_DIR, { recursive: true });

console.log(`📁 Isolated A7 Test Directory: ${TEST_ROOT}`);

// Synthetic Users
const SYNTHETIC_USERS = [
    {
        id: 'synth_admin',
        username: 'admin',
        name: '관리자',
        password: 'admin_password_123',
        role: 'admin',
        team: '운영팀',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synth_manager',
        username: 'manager',
        name: '상담1팀장',
        password: 'manager_password_123',
        role: 'manager',
        team: '상담1팀',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synth_user_a',
        username: 'user_a',
        name: '상담원A',
        password: 'user_a_password_123',
        role: 'user',
        team: '상담1팀',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synth_user_b',
        username: 'user_b',
        name: '상담원B',
        password: 'user_b_password_123',
        role: 'user',
        team: '상담2팀',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synth_inactive',
        username: 'inactive_user',
        name: '비활성직원',
        password: 'inactive_password_123',
        role: 'user',
        team: '상담1팀',
        status: 'suspended',
        permissions: { voiceCalls: true }
    }
];

// In-Memory File-backed Store
const memoryStore = {
    Users: SYNTHETIC_USERS,
    AuthSessions: [],
    VoiceCalls: []
};

const getData = (name, def = []) => {
    if (memoryStore[name] !== undefined) return memoryStore[name];
    return def;
};

const persistData = async (name, data) => {
    memoryStore[name] = data;
    return true;
};

/**
 * Synthetic WAV Generator
 */
function createSyntheticWav(payloadBytes = 1000, seed = 0) {
    const totalSize = 44 + payloadBytes;
    const buf = Buffer.alloc(totalSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(totalSize - 8, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // Mono
    buf.writeUInt32LE(16000, 24); // 16kHz
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(payloadBytes, 40);
    for (let i = 44; i < totalSize; i++) {
        buf[i] = ((i + seed) % 256);
    }
    return buf;
}

// Server and Service Initialization
const sessionRepo = new SessionRepository(getData, persistData);
const authService = new AuthService(sessionRepo, () => getData('Users', []));
const { requireAuth } = createAuthMiddleware(authService);
const voiceCallRepo = new VoiceCallRepository(getData, persistData);
const accessService = new PrivateAudioAccessService({
    privateAudioRoot: PRIVATE_AUDIO_DIR
});
const auditSink = new AuditEventSink();

const app = express();
app.use(compression({
    filter: (req, res) => {
        if (req.path && req.path.includes('/audio')) {
            return false;
        }
        const cacheControl = res.getHeader('Cache-Control');
        if (typeof cacheControl === 'string' && /no-transform/i.test(cacheControl)) {
            return false;
        }
        return compression.filter(req, res);
    }
}));
app.use(express.json());

// Endpoint for testing normal API response compression
app.get('/api/test-compressible-json', (req, res) => {
    res.json({ data: 'COMPRESSIBLE_PAYLOAD_'.repeat(100) });
});

const syntheticGrants = [
    {
        id: 'grant_synth_admin',
        userId: 'synth_admin',
        status: GRANT_STATUS.ACTIVE,
        capabilities: ALL_VOICE_ACCESS_CAPABILITIES,
        scope: { type: ACCESS_SCOPE_TYPE.ALL },
        grantedBy: 'system',
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    },
    {
        id: 'grant_synth_manager',
        userId: 'synth_manager',
        status: GRANT_STATUS.ACTIVE,
        capabilities: ALL_VOICE_ACCESS_CAPABILITIES,
        scope: { type: ACCESS_SCOPE_TYPE.DEPARTMENT, departmentId: '상담1팀' },
        grantedBy: 'synth_admin',
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    },
    {
        id: 'grant_synth_user_a',
        userId: 'synth_user_a',
        status: GRANT_STATUS.ACTIVE,
        capabilities: ALL_VOICE_ACCESS_CAPABILITIES,
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        grantedBy: 'synth_admin',
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    },
    {
        id: 'grant_synth_user_b',
        userId: 'synth_user_b',
        status: GRANT_STATUS.ACTIVE,
        capabilities: ALL_VOICE_ACCESS_CAPABILITIES,
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        grantedBy: 'synth_admin',
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    }
];
fs.writeFileSync(path.join(DATA_DIR, 'VoiceSystemAccessGrants.json'), JSON.stringify(syntheticGrants, null, 2));

const voiceAccessRepo = new VoiceAccessRepository({ dataDir: DATA_DIR });
const voiceAccessAuthorizer = new VoiceAccessAuthorizer({ voiceAccessRepo });

const streamingRouter = createAudioStreamingRouter({
    requireAuth,
    voiceCallRepository: voiceCallRepo,
    privateAudioAccessService: accessService,
    auditEventSink: auditSink,
    voiceAccessAuthorizer
});

app.use('/api/voice-calls', streamingRouter);

// API Catch-all 404 handler (prevents SPA HTML fallback for missing API endpoints)
app.all('/api/*', (req, res) => {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: '요청한 API 엔드포인트를 찾을 수 없습니다.'
        }
    });
});

// Catch-all for Frontend SPA
app.get('*', (req, res) => {
    res.send('<!DOCTYPE html><html><body>SPA_FALLBACK_PAGE</body></html>');
});

let server;
let serverPort;
let baseUrl;

async function startServer() {
    return new Promise((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            baseUrl = `http://127.0.0.1:${serverPort}`;
            resolve();
        });
    });
}

async function stopServer() {
    return new Promise((resolve) => {
        if (server) server.close(resolve);
        else resolve();
    });
}

// Helper: login user and get session cookie
async function loginAndGetCookie(username, password) {
    const res = await authService.login(username, password, {
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1'
    });
    return `mind_session=${res.token}; Path=/; HttpOnly`;
}

async function runAllTests() {
    console.log('====================================================');
    console.log('🧪 Starting Mind-ERP OS Track A7 Audio Streaming Tests');
    console.log('====================================================\n');

    await startServer();

    let passedTests = 0;
    let failedTests = 0;
    let totalAssertions = 0;

    const testCase = async (name, fn) => {
        try {
            await fn();
            console.log(`  ✅ [PASS] ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ [FAIL] ${name}`);
            console.error(`     Reason:`, err.message);
            if (err.stack) {
                console.error(err.stack.split('\n').slice(1, 3).join('\n'));
            }
            failedTests++;
        }
    };

    const assertStrictEqual = (actual, expected, msg) => {
        totalAssertions++;
        assert.strictEqual(actual, expected, msg);
    };

    const assertCondition = (cond, msg) => {
        totalAssertions++;
        assert(cond, msg);
    };

    // Obtain Session Cookies
    const adminCookie = await loginAndGetCookie('admin', 'admin_password_123');
    const managerCookie = await loginAndGetCookie('manager', 'manager_password_123');
    const userACookie = await loginAndGetCookie('user_a', 'user_a_password_123');
    const userBCookie = await loginAndGetCookie('user_b', 'user_b_password_123');

    // Fixture Audio: 1044 bytes total (44 byte header + 1000 byte PCM)
    const testAudioWav = createSyntheticWav(1000, 10);
    const testAudioSize = testAudioWav.length; // 1044 bytes
    const testHash = crypto.createHash('sha256').update(testAudioWav).digest('hex');

    // Write physical file on disk using single resolved path
    const audioRelKey = 'private-audio/2026/05/call_user_a/audio_obj_1.wav';
    const audioDiskPath = resolveAndValidatePath(PRIVATE_AUDIO_DIR, audioRelKey).resolvedPath;
    fs.mkdirSync(path.dirname(audioDiskPath), { recursive: true });
    fs.writeFileSync(audioDiskPath, testAudioWav);

    // Create Test VoiceCall Records
    // Call 1: Assigned to User A (Team: 상담1팀)
    const callUserA = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'confidential_call.wav',
        contentHash: testHash,
        mimeType: 'audio/wav',
        fileSize: testAudioSize,
        processingStatus: PROCESSING_STATUS.VALIDATING,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID
    });
    await voiceCallRepo.completeStoragePromotion(callUserA.id, callUserA.version, {
        storageKey: audioRelKey,
        storageObjectId: 'audio_obj_1'
    });
    // Assign to user A and team 상담1팀
    const assignedCallA = await voiceCallRepo.updateMetadata(callUserA.id, callUserA.version + 1, {
        assignedUserId: 'synth_user_a',
        assignedDepartmentId: '상담1팀',
        assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED
    });

    // Call 2: Assigned to User B (Team: 상담2팀) with UNIQUE audio/hash
    const testAudioWavB = createSyntheticWav(1000, 20);
    const testHashB = crypto.createHash('sha256').update(testAudioWavB).digest('hex');
    const audioRelKeyB = 'private-audio/2026/05/call_user_b/audio_obj_2.wav';
    const audioDiskPathB = resolveAndValidatePath(PRIVATE_AUDIO_DIR, audioRelKeyB).resolvedPath;
    fs.mkdirSync(path.dirname(audioDiskPathB), { recursive: true });
    fs.writeFileSync(audioDiskPathB, testAudioWavB);

    const callUserB = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'call_b.wav',
        contentHash: testHashB,
        mimeType: 'audio/wav',
        fileSize: testAudioSize,
        processingStatus: PROCESSING_STATUS.VALIDATING,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID
    });
    await voiceCallRepo.completeStoragePromotion(callUserB.id, callUserB.version, {
        storageKey: audioRelKeyB,
        storageObjectId: 'audio_obj_2'
    });
    const assignedCallB = await voiceCallRepo.updateMetadata(callUserB.id, callUserB.version + 1, {
        assignedUserId: 'synth_user_b',
        assignedDepartmentId: '상담2팀',
        assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED
    });

    // Call 3: Unassigned Call (Team: null, assignedUserId: null)
    const callUnassigned = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'unassigned.wav',
        contentHash: 'hash_unassigned',
        mimeType: 'audio/wav',
        fileSize: testAudioSize,
        processingStatus: PROCESSING_STATUS.VALIDATING,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID
    });
    await voiceCallRepo.completeStoragePromotion(callUnassigned.id, callUnassigned.version, {
        storageKey: audioRelKey,
        storageObjectId: 'audio_obj_unassigned'
    });

    // Call 4: Rejected Call (quarantine only)
    const callRejected = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'trojan.exe',
        contentHash: 'hash_rejected',
        mimeType: 'application/octet-stream',
        fileSize: 100,
        processingStatus: PROCESSING_STATUS.REJECTED,
        validationStatus: INTAKE_VALIDATION_STATUS.QUARANTINED,
        rejectionCode: 'INVALID_SIGNATURE',
        quarantineStorageKey: 'quarantine/2026/05/intake_bad/bad.bin'
    });

    // Call 5: Pending Promotion Call (not yet linked)
    const callPending = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'pending.wav',
        contentHash: 'hash_pending',
        mimeType: 'audio/wav',
        fileSize: 500,
        processingStatus: PROCESSING_STATUS.VALIDATING,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID,
        pendingStorageKey: 'private-audio/2026/05/pending/audio.wav',
        storagePromotionStatus: 'pending'
    });

    // Call 6: Missing file call
    const callMissing = await voiceCallRepo.create({
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        originalFileName: 'missing.wav',
        contentHash: 'hash_missing',
        mimeType: 'audio/wav',
        fileSize: 100,
        processingStatus: PROCESSING_STATUS.VALIDATING,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID
    });
    await voiceCallRepo.completeStoragePromotion(callMissing.id, callMissing.version, {
        storageKey: 'private-audio/2026/05/call_missing/non_existent.wav'
    });
    await voiceCallRepo.updateMetadata(callMissing.id, callMissing.version + 1, {
        assignedUserId: 'synth_user_a',
        assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED
    });

    // ============================================================
    // 1. AUTHENTICATION & CLIENT SPOOFING DEFENSE
    // ============================================================
    console.log('--- 1. Authentication & Client Spoofing Defense ---');

    await testCase('1.1 Request without session cookie returns 401 UNAUTHENTICATED', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`);
        assertStrictEqual(res.status, 401);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.UNAUTHENTICATED);
    });

    await testCase('1.2 Tampered or invalid session cookie returns 401', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: 'auth_session=tampered_invalid_token_12345' }
        });
        assertStrictEqual(res.status, 401);
    });

    await testCase('1.3 Client attempt to inject userId, role, or team in body/query is completely ignored', async () => {
        // user_b tries to spoof as admin via query and body to access user_a's call
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio?role=admin&userId=synth_admin&team=운영팀`, {
            method: 'GET',
            headers: {
                Cookie: userBCookie,
                'Content-Type': 'application/json'
            }
        });
        // Must be rejected with 404 (Resource Scope existence concealment)
        assertStrictEqual(res.status, 404);
    });

    // ============================================================
    // 2. CAPABILITY & DOWNLOAD PERMISSION SEPARATION
    // ============================================================
    console.log('\n--- 2. Capability & Download Separation ---');

    await testCase('2.1 Standard user with play_audio capability can stream inline audio', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-type'), 'audio/wav');
        assertCondition(res.headers.get('content-disposition').startsWith('inline'));
    });

    await testCase('2.2 Standard user without download_audio cannot access download route (403)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio/download`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 403);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_DOWNLOAD_FORBIDDEN);
    });

    await testCase('2.3 Admin with download_audio capability can download attachment', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio/download`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 200);
        assertCondition(res.headers.get('content-disposition').startsWith('attachment'));
        assertCondition(res.headers.get('content-disposition').includes('voice-call-audio.wav'));
        // Confirm client original filename and subject are NOT leaked
        assertCondition(!res.headers.get('content-disposition').includes('confidential_call'));
    });

    // ============================================================
    // 3. RESOURCE SCOPE ISOLATION
    // ============================================================
    console.log('\n--- 3. Resource Scope Isolation ---');

    await testCase('3.1 User cannot access calls assigned to other users (Concealed as 404)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallB.id}/audio`, {
            headers: { Cookie: userACookie } // User A tries to access User B's call
        });
        assertStrictEqual(res.status, 404);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND);
    });

    await testCase('3.2 User cannot access unassigned calls (404)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${callUnassigned.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 404);
    });

    await testCase('3.3 Manager can access calls within own department (상담1팀)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: managerCookie }
        });
        assertStrictEqual(res.status, 200);
    });

    await testCase('3.4 Manager cannot access calls outside own department (상담2팀)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallB.id}/audio`, {
            headers: { Cookie: managerCookie }
        });
        assertStrictEqual(res.status, 404);
    });

    await testCase('3.5 Admin can access calls across all departments', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallB.id}/audio`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 200);
    });

    // ============================================================
    // 4. RESOURCE ELIGIBILITY & REJECTED / QUARANTINE SHIELD
    // ============================================================
    console.log('\n--- 4. Resource Eligibility & Lifecycle Shield ---');

    await testCase('4.1 Rejected / Quarantined call cannot be streamed by anyone (403)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${callRejected.id}/audio`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 403);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_NOT_AVAILABLE);
    });

    await testCase('4.2 Pending promotion call cannot be streamed before linking (409)', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${callPending.id}/audio`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 409);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_STORAGE_NOT_LINKED);
    });

    await testCase('4.3 Soft-deleted call cannot be streamed (404)', async () => {
        // Delete a call
        await voiceCallRepo.softDelete(assignedCallA.id, assignedCallA.version);
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 404);

        // Restore for subsequent tests
        const records = getData('VoiceCalls');
        const r = records.find(x => x.id === assignedCallA.id);
        r.isDeleted = false;
        r.deletedAt = undefined;
        await persistData('VoiceCalls', records);
    });

    // ============================================================
    // 5. STORAGE & PATH SECURITY (SYMLINK, TRAVERSAL, ESCAPE)
    // ============================================================
    console.log('\n--- 5. Storage Path & Symlink Defense ---');

    await testCase('5.1 Missing audio file on disk returns safe 404 without leaking path', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${callMissing.id}/audio`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 404);
        const bodyText = await res.text();
        assertCondition(!bodyText.includes('private-audio'));
        assertCondition(!bodyText.includes(TEST_ROOT));
    });

    await testCase('5.2 Symlink audio file is strictly rejected (AUDIO_FILE_IS_SYMLINK)', async () => {
        const targetReal = path.join(PRIVATE_AUDIO_DIR, 'real_audio.wav');
        fs.writeFileSync(targetReal, testAudioWav);
        const symlinkRelKey = 'private-audio/2026/05/call_sym/symlink_obj.wav';
        const symlinkPath = path.join(PRIVATE_AUDIO_DIR, symlinkRelKey);
        fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });

        try {
            fs.symlinkSync(targetReal, symlinkPath);
            const callSym = await voiceCallRepo.create({
                intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
                originalFileName: 'sym.wav',
                contentHash: testHash,
                mimeType: 'audio/wav',
                fileSize: testAudioSize,
                processingStatus: PROCESSING_STATUS.VALIDATING,
                validationStatus: INTAKE_VALIDATION_STATUS.VALID
            });
            await voiceCallRepo.completeStoragePromotion(callSym.id, callSym.version, {
                storageKey: symlinkRelKey
            });

            const res = await fetch(`${baseUrl}/api/voice-calls/${callSym.id}/audio`, {
                headers: { Cookie: adminCookie }
            });
            assertStrictEqual(res.status, 403);
            const data = await res.json();
            assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_FILE_IS_SYMLINK);

            fs.unlinkSync(symlinkPath);
            fs.unlinkSync(targetReal);
        } catch (e) {
            if (e.code === 'EPERM' || e.code === 'ENOSYS') {
                console.log('     (Symlink creation not permitted on current OS user privilege - skipped gracefully)');
            } else {
                throw e;
            }
        }
    });

    // ============================================================
    // 6. FULL CONTENT 200 & RFC 7233 RANGE 206 RESPONSES
    // ============================================================
    console.log('\n--- 6. HTTP Range Parsing & Responses ---');

    await testCase('6.1 Request without Range header returns 200 with full body and security headers', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize));
        assertStrictEqual(res.headers.get('accept-ranges'), 'bytes');
        assertStrictEqual(res.headers.get('x-content-type-options'), 'nosniff');
        assertCondition(res.headers.get('cache-control').includes('no-store'));
        assertCondition(res.headers.get('cache-control').includes('no-transform'));

        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, testAudioSize);
        assertStrictEqual(crypto.createHash('sha256').update(buf).digest('hex'), testHash);
    });

    await testCase('6.2 Range bytes=0-99 returns 206 with exactly 100 bytes', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=0-99'
            }
        });
        assertStrictEqual(res.status, 206);
        assertStrictEqual(res.headers.get('content-range'), `bytes 0-99/${testAudioSize}`);
        assertStrictEqual(res.headers.get('content-length'), '100');

        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, 100);
        assertStrictEqual(buf[0], testAudioWav[0]);
        assertStrictEqual(buf[99], testAudioWav[99]);
    });

    await testCase('6.3 Open-ended Range bytes=100- returns 206 from offset 100 to end of file', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=100-'
            }
        });
        assertStrictEqual(res.status, 206);
        const expectedLength = testAudioSize - 100;
        assertStrictEqual(res.headers.get('content-range'), `bytes 100-${testAudioSize - 1}/${testAudioSize}`);
        assertStrictEqual(res.headers.get('content-length'), String(expectedLength));

        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, expectedLength);
        assertStrictEqual(buf[0], testAudioWav[100]);
        assertStrictEqual(buf[buf.length - 1], testAudioWav[testAudioSize - 1]);
    });

    await testCase('6.4 Suffix Range bytes=-200 returns 206 for last 200 bytes of file', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=-200'
            }
        });
        assertStrictEqual(res.status, 206);
        assertStrictEqual(res.headers.get('content-range'), `bytes ${testAudioSize - 200}-${testAudioSize - 1}/${testAudioSize}`);
        assertStrictEqual(res.headers.get('content-length'), '200');

        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, 200);
        assertStrictEqual(buf[0], testAudioWav[testAudioSize - 200]);
    });

    // ============================================================
    // 7. INVALID RANGE HANDLING (416 SATISFIABILITY)
    // ============================================================
    console.log('\n--- 7. Invalid Range Handling (416) ---');

    await testCase('7.1 Range starting at or past file size returns 416 with Content-Range bytes */size', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: `bytes=${testAudioSize}-`
            }
        });
        assertStrictEqual(res.status, 416);
        assertStrictEqual(res.headers.get('content-range'), `bytes */${testAudioSize}`);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_RANGE_NOT_SATISFIABLE);
    });

    await testCase('7.2 Range with end < start returns 416', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=500-200'
            }
        });
        assertStrictEqual(res.status, 416);
    });

    await testCase('7.3 Multipart / comma-separated range is rejected with 416', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=0-50,100-150'
            }
        });
        assertStrictEqual(res.status, 416);
    });

    await testCase('7.4 Non-bytes or malformed range is rejected with 416', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'items=0-10'
            }
        });
        assertStrictEqual(res.status, 416);
    });

    // ============================================================
    // 8. HEAD METHOD
    // ============================================================
    console.log('\n--- 8. HEAD Request Handling ---');

    await testCase('8.1 HEAD request returns headers without payload body', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            method: 'HEAD',
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize));
        assertStrictEqual(res.headers.get('accept-ranges'), 'bytes');
        assertStrictEqual(res.headers.get('content-type'), 'audio/wav');
        const text = await res.text();
        assertStrictEqual(text, '', 'HEAD body must be empty');
    });

    await testCase('8.2 Unauthorized HEAD request returns 401/404 without payload', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            method: 'HEAD'
        });
        assertStrictEqual(res.status, 401);
    });

    // ============================================================
    // 9. AUDIT EVENT SINK VERIFICATION
    // ============================================================
    console.log('\n--- 9. Audit Event Sink Verification ---');

    await testCase('9.1 Successful playback and downloads emit audited sanitized records', async () => {
        const events = auditSink.getEvents();
        assertCondition(events.length > 0, 'Events must be recorded');

        const playEvent = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED);
        assertCondition(playEvent !== undefined, 'AUDIO_PLAY_STARTED recorded');
        assertStrictEqual(playEvent.outcome, 'SUCCESS');
        assertStrictEqual(playEvent.resourceId, assignedCallA.id);

        const dlEvent = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_DOWNLOAD_STARTED);
        assertCondition(dlEvent !== undefined, 'AUDIO_DOWNLOAD_STARTED recorded');

        const deniedEvent = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED);
        assertCondition(deniedEvent !== undefined, 'AUDIO_ACCESS_DENIED recorded');

        // Verify that NO audit event contains clinical details or paths
        for (const ev of events) {
            assertStrictEqual(ev.transcript, undefined);
            assertStrictEqual(ev.aiSummary, undefined);
            assertStrictEqual(ev.storageKey, undefined);
            assertStrictEqual(ev.absolutePath, undefined);
            assertStrictEqual(ev.contentHash, undefined);
        }
    });

    await testCase('9.2 Repeated range chunk requests within same session are debounced', async () => {
        auditSink.clear();
        // Fire 5 rapid range requests in sequence for the same user and call
        for (let i = 0; i < 5; i++) {
            await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
                headers: {
                    Cookie: userACookie,
                    Range: `bytes=${i * 10}-${i * 10 + 9}`
                }
            });
        }
        const playEvents = auditSink.getEvents().filter(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED);
        assertStrictEqual(playEvents.length, 1, 'Rapid seeking range requests must be debounced into 1 playback session event');
    });

    // ============================================================
    // 10. A6 CLOSURE METRICS VALIDATION
    // ============================================================
    console.log('\n--- 10. A6 Closure Gate Verification ---');

    await testCase('10.1 Storage Reconciliation canonical check code enumeration is 18', async () => {
        const totalChecks = Object.keys(STORAGE_RECONCILIATION_CHECKS).length;
        assertStrictEqual(totalChecks, 18, 'Must have exactly 18 reconciliation check codes');
    });

    // ============================================================
    // 11. STORAGE ROOT PATH SEMANTICS & FAIL-CLOSED CONFIGURATION (CATEGORY A)
    // ============================================================
    console.log('\n--- 11. Storage Root Semantics & Fail-Closed Config (Category A) ---');

    await testCase('11.1 Option A path resolution: storageRoot + storageKey has no double private-audio nesting', async () => {
        const configuredParent = path.join(TEST_ROOT, 'storage-parent');
        const key = 'private-audio/2026/05/call_x/obj.wav';
        const res = resolveAndValidatePath(configuredParent, key);
        const expected = path.resolve(configuredParent, 'private-audio/2026/05/call_x/obj.wav');
        assertStrictEqual(res.resolvedPath, expected);
        assertCondition(!res.resolvedPath.includes('private-audio' + path.sep + 'private-audio'));
    });

    await testCase('11.2 Normalization when configured storageRoot already ends with private-audio', async () => {
        const configuredDir = path.join(TEST_ROOT, 'custom', 'private-audio');
        const key = 'private-audio/2026/05/call_x/obj.wav';
        const res = resolveAndValidatePath(configuredDir, key);
        const expected = path.resolve(TEST_ROOT, 'custom', 'private-audio', '2026/05/call_x/obj.wav');
        assertStrictEqual(res.resolvedPath, expected);
        assertCondition(!res.resolvedPath.includes('private-audio' + path.sep + 'private-audio'));
    });

    await testCase('11.3 Unconfigured storage root marks service unavailable and denies arbitrary directory creation', async () => {
        const unconfiguredService = new PrivateAudioAccessService({ privateAudioRoot: null });
        assertStrictEqual(unconfiguredService.available, false);
        let errorThrown = null;
        try {
            await unconfiguredService.validateEligibleAudio(assignedCallA);
        } catch (e) {
            errorThrown = e;
        }
        assertCondition(errorThrown !== null);
        assertStrictEqual(errorThrown.code, STREAMING_ERROR_CODES.AUDIO_STORAGE_UNAVAILABLE);
    });

    await testCase('11.4 Audio controller returns 503 AUDIO_STORAGE_UNAVAILABLE when storage is disabled', async () => {
        const unconfiguredService = new PrivateAudioAccessService({ privateAudioRoot: null });
        const unconfiguredController = new AudioStreamingController({
            voiceCallRepo,
            accessService: unconfiguredService,
            auditEventSink: auditSink
        });
        const fakeReq = { params: { id: assignedCallA.id }, auth: { id: 'synth_admin', role: 'admin' }, headers: {} };
        let sentStatus = null;
        let sentJson = null;
        const fakeRes = {
            status: (s) => { sentStatus = s; return fakeRes; },
            json: (j) => { sentJson = j; return fakeRes; },
            setHeader: () => fakeRes
        };
        await unconfiguredController.streamAudio(fakeReq, fakeRes);
        assertStrictEqual(sentStatus, 503);
        assertStrictEqual(sentJson.error.code, STREAMING_ERROR_CODES.AUDIO_STORAGE_UNAVAILABLE);
    });

    await testCase('11.5 Non-voice API remains completely functional when audio is unavailable', async () => {
        const res = await fetch(`${baseUrl}/api/test-compressible-json`);
        assertStrictEqual(res.status, 200);
        const data = await res.json();
        assertCondition(data.data.startsWith('COMPRESSIBLE_PAYLOAD_'));
    });

    // ============================================================
    // 12. SYMLINK BOUNDARY ENFORCEMENT (CATEGORY B)
    // ============================================================
    console.log('\n--- 12. Symlink Boundary Enforcement (Category B) ---');

    await testCase('12.1 Target directory instead of regular file is rejected (AUDIO_FILE_NOT_REGULAR)', async () => {
        const subDirPath = path.join(PRIVATE_AUDIO_DIR, '2026', '05', 'call_dir', 'obj_dir.wav');
        fs.mkdirSync(subDirPath, { recursive: true });
        const dirCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'folder.wav',
            contentHash: 'hash_dir',
            mimeType: 'audio/wav',
            fileSize: 100,
            processingStatus: PROCESSING_STATUS.VALIDATING,
            validationStatus: INTAKE_VALIDATION_STATUS.VALID
        });
        const promotedDirCall = await voiceCallRepo.completeStoragePromotion(dirCall.id, dirCall.version, {
            storageKey: 'private-audio/2026/05/call_dir/obj_dir.wav',
            storageObjectId: 'obj_dir'
        });
        let caughtErr = null;
        try {
            await accessService.validateEligibleAudio(promotedDirCall);
        } catch (e) {
            caughtErr = e;
        }
        assertCondition(caughtErr !== null);
        assertStrictEqual(caughtErr.code, STREAMING_ERROR_CODES.AUDIO_FILE_NOT_REGULAR);
    });

    await testCase('12.2 Path traversal escaping root is strictly blocked (STORAGE_TRAVERSAL_ATTEMPTED)', async () => {
        let threw = false;
        try {
            resolveAndValidatePath(PRIVATE_AUDIO_DIR, '../../outside.wav');
        } catch (e) {
            threw = true;
            assertCondition(e.name === 'PrivateAudioStorageError' || /STORAGE/.test(e.message) || e.code === 'STORAGE_KEY_INVALID' || e.code === 'STORAGE_TRAVERSAL_ATTEMPTED');
        }
        assertStrictEqual(threw, true, 'Traversal must throw');
    });

    // ============================================================
    // 13. EXPRESS COMPRESSION WIRE INTEGRATION (CATEGORY C)
    // ============================================================
    console.log('\n--- 13. Express Compression Wire Integration (Category C) ---');

    await testCase('13.1 Full GET audio request with Accept-Encoding: gzip returns 200 without Content-Encoding', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                'Accept-Encoding': 'gzip, deflate, br'
            }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-encoding'), null, 'Audio must not be compressed');
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize));
        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, testAudioSize);
        assertStrictEqual(crypto.createHash('sha256').update(buf).digest('hex'), testHash);
    });

    await testCase('13.2 Range GET audio request with Accept-Encoding: gzip returns 206 without Content-Encoding', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=0-99',
                'Accept-Encoding': 'gzip, deflate, br'
            }
        });
        assertStrictEqual(res.status, 206);
        assertStrictEqual(res.headers.get('content-encoding'), null, 'Range audio must not be compressed');
        assertStrictEqual(res.headers.get('content-length'), '100');
        assertStrictEqual(res.headers.get('content-range'), `bytes 0-99/${testAudioSize}`);
        const buf = Buffer.from(await res.arrayBuffer());
        assertStrictEqual(buf.length, 100);
        assertStrictEqual(buf[0], testAudioWav[0]);
        assertStrictEqual(buf[99], testAudioWav[99]);
    });

    await testCase('13.3 General JSON API endpoint compresses with gzip under compression middleware', async () => {
        const res = await fetch(`${baseUrl}/api/test-compressible-json`, {
            headers: {
                'Accept-Encoding': 'gzip'
            }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-encoding'), 'gzip', 'Standard JSON API must use gzip compression');
    });

    // ============================================================
    // 14. RANGE HEADER PRESENCE POLICY (CATEGORY D)
    // ============================================================
    console.log('\n--- 14. Range Header Presence Policy (Category D) ---');

    await testCase('14.1 Range Header absent (undefined) returns 200 Full Content', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize));
        assertStrictEqual(res.headers.get('content-range'), null);
    });

    await testCase('14.2 Range Header present as empty string "" returns 416 AUDIO_RANGE_INVALID', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: ''
            }
        });
        assertStrictEqual(res.status, 416);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID);
    });

    await testCase('14.3 Range Header present as whitespace only "   " returns 416 AUDIO_RANGE_INVALID', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: '   '
            }
        });
        assertStrictEqual(res.status, 416);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID);
    });

    await testCase('14.4 Range Header with valid range returns 206 with correct byte count', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=50-149'
            }
        });
        assertStrictEqual(res.status, 206);
        assertStrictEqual(res.headers.get('content-length'), '100');
        assertStrictEqual(res.headers.get('content-range'), `bytes 50-149/${testAudioSize}`);
    });

    await testCase('14.5 Multiple Range header is rejected with 416 AUDIO_RANGE_INVALID', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: {
                Cookie: userACookie,
                Range: 'bytes=0-50,60-100'
            }
        });
        assertStrictEqual(res.status, 416);
        const data = await res.json();
        assertStrictEqual(data.error.code, STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID);
    });

    // ============================================================
    // 15. HEAD POLICY WITH RANGE AND STREAM LIFECYCLE (CATEGORY E)
    // ============================================================
    console.log('\n--- 15. HEAD Policy & Stream Avoidance (Category E) ---');

    await testCase('15.1 HEAD request without Range header returns 200 with full Content-Length and 0 body', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            method: 'HEAD',
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize));
        assertStrictEqual(res.headers.get('content-range'), null);
        const text = await res.text();
        assertStrictEqual(text.length, 0);
    });

    await testCase('15.2 HEAD request WITH Range header ignores Range: returns 200 and no Content-Range', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            method: 'HEAD',
            headers: {
                Cookie: userACookie,
                Range: 'bytes=0-99'
            }
        });
        assertStrictEqual(res.status, 200, 'HEAD must ignore Range and return 200');
        assertStrictEqual(res.headers.get('content-length'), String(testAudioSize), 'HEAD Content-Length must be full size');
        assertStrictEqual(res.headers.get('content-range'), null, 'HEAD must not include Content-Range');
        const text = await res.text();
        assertStrictEqual(text.length, 0);
    });

    await testCase('15.3 HEAD request never triggers AUDIO_PLAY_STARTED audit event', async () => {
        auditSink.clear();
        await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            method: 'HEAD',
            headers: { Cookie: userACookie }
        });
        const playEvents = auditSink.getEvents().filter(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED);
        assertStrictEqual(playEvents.length, 0, 'HEAD request must never log AUDIO_PLAY_STARTED');
    });

    // ============================================================
    // 16. CANONICAL DEPARTMENT IDENTIFIER RESOLUTION (CATEGORY F)
    // ============================================================
    console.log('\n--- 16. Canonical Department Resolution (Category F) ---');

    await testCase('16.1 Canonical department resolution maps codes and Korean names to canonical IDs', async () => {
        assertStrictEqual(resolveCanonicalDepartmentId('상담1팀'), CANONICAL_DEPARTMENTS.COUNSEL_1);
        assertStrictEqual(resolveCanonicalDepartmentId('상담2팀'), CANONICAL_DEPARTMENTS.COUNSEL_2);
        assertStrictEqual(resolveCanonicalDepartmentId('HB'), 'dept_promotion');
        assertStrictEqual(resolveCanonicalDepartmentId('정신건강증진팀'), 'dept_promotion');
        assertStrictEqual(resolveCanonicalDepartmentId('UNKNOWN_TEAM'), null);
        assertStrictEqual(resolveCanonicalDepartmentId(null), null);
    });

    await testCase('16.2 Manager in same canonical department has access', async () => {
        // Manager synth_manager is in team 상담1팀 (dept_counsel_1)
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: managerCookie }
        });
        assertStrictEqual(res.status, 200);
    });

    await testCase('16.3 Manager in other department is concealed with 404', async () => {
        // assignedCallB is assigned to 상담2팀 (dept_counsel_2), manager is in 상담1팀
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallB.id}/audio`, {
            headers: { Cookie: managerCookie }
        });
        assertStrictEqual(res.status, 404);
    });

    await testCase('16.4 Unknown department is rejected by default', async () => {
        assertStrictEqual(resolveCanonicalDepartmentId('fake_dept_123'), null);
    });

    await testCase('16.5 Client query parameter injection attempting to forge department is ignored', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallB.id}/audio?team=상담1팀&assignedDepartmentId=상담1팀`, {
            headers: { Cookie: managerCookie }
        });
        assertStrictEqual(res.status, 404, 'Client query parameters must not override server model data');
    });

    // ============================================================
    // 17. VERIFIED MIME MAPPING & REJECTION (CATEGORY G)
    // ============================================================
    console.log('\n--- 17. Verified MIME Policy (Category G) ---');

    await testCase('17.1 Client-declared fake MIME is ignored; server Content-Type is derived from verified format', async () => {
        // Call created with fake client declared MIME 'text/html', but verifiedFormat: 'wav'
        const fakeMimeCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'spoof.wav',
            contentHash: 'unique_hash_fake_mime_' + Date.now(),
            mimeType: 'text/html',
            fileSize: testAudioSize,
            processingStatus: PROCESSING_STATUS.VALIDATING,
            validationStatus: INTAKE_VALIDATION_STATUS.VALID
        });
        const promotedFakeMimeCall = await voiceCallRepo.completeStoragePromotion(fakeMimeCall.id, fakeMimeCall.version, {
            storageKey: audioRelKey,
            storageObjectId: 'audio_obj_fake'
        });
        const meta = await accessService.validateEligibleAudio(promotedFakeMimeCall);
        assertStrictEqual(meta.mimeType, 'audio/wav', 'Content-Type must be verified audio/wav, not text/html');
    });

    await testCase('17.2 Verified MP3 format returns audio/mpeg', async () => {
        const mp3RelKey = 'private-audio/2026/05/call_mp3/audio.mp3';
        const mp3DiskPath = resolveAndValidatePath(PRIVATE_AUDIO_DIR, mp3RelKey).resolvedPath;
        fs.mkdirSync(path.dirname(mp3DiskPath), { recursive: true });
        fs.writeFileSync(mp3DiskPath, Buffer.from('FAKE_MP3_DATA'));

        const mp3Call = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'test.mp3',
            contentHash: 'hash_mp3',
            mimeType: 'audio/mp3',
            fileSize: 13,
            processingStatus: PROCESSING_STATUS.VALIDATING,
            validationStatus: INTAKE_VALIDATION_STATUS.VALID
        });
        const promotedMp3Call = await voiceCallRepo.completeStoragePromotion(mp3Call.id, mp3Call.version, {
            storageKey: mp3RelKey,
            storageObjectId: 'audio_obj_mp3'
        });
        const meta = await accessService.validateEligibleAudio(promotedMp3Call);
        assertStrictEqual(meta.mimeType, 'audio/mpeg');
    });

    await testCase('17.3 Unsupported verified format is rejected with AUDIO_FILE_INVALID', async () => {
        const flacCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'test.flac',
            contentHash: 'hash_flac',
            mimeType: 'audio/flac',
            fileSize: 100,
            processingStatus: PROCESSING_STATUS.VALIDATING,
            validationStatus: INTAKE_VALIDATION_STATUS.VALID
        });
        const promotedFlacCall = await voiceCallRepo.completeStoragePromotion(flacCall.id, flacCall.version, {
            storageKey: 'private-audio/2026/05/call_flac/audio.flac',
            storageObjectId: 'audio_obj_flac'
        });
        let caught = null;
        try {
            await accessService.validateEligibleAudio(promotedFlacCall);
        } catch (e) {
            caught = e;
        }
        assertCondition(caught !== null);
        assertStrictEqual(caught.code, STREAMING_ERROR_CODES.AUDIO_FILE_INVALID);
    });

    // ============================================================
    // 18. AUDIT SINK BOUNDS & RESILIENCE (CATEGORY H)
    // ============================================================
    console.log('\n--- 18. Audit Sink Bounds & Resilience (Category H) ---');

    await testCase('18.1 Audit sink bounds: buffer is capped at maxEvents (500)', async () => {
        const boundedSink = new AuditEventSink({ maxEvents: 50 });
        for (let i = 0; i < 100; i++) {
            boundedSink.record({
                eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
                resourceId: `call_${i}`,
                actorUserId: 'synth_admin',
                outcome: 'SUCCESS'
            });
        }
        assertStrictEqual(boundedSink.getEvents().length, 50, 'Sink events must be capped at maxEvents');
    });

    await testCase('18.2 Audit sink debouncer limits max entries (200)', async () => {
        const boundedSink = new AuditEventSink({ maxDebounceEntries: 10 });
        for (let i = 0; i < 25; i++) {
            boundedSink.record({
                eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
                resourceId: `resource_${i}`,
                actorUserId: `user_${i}`,
                outcome: 'SUCCESS'
            });
        }
        assertCondition(boundedSink.activeSessions.size <= 10, 'Debounce map size must be bounded');
    });

    await testCase('18.3 Audit sink throw resilience: sink throwing error does not fail streaming response', async () => {
        const faultySink = new AuditEventSink();
        faultySink.record = () => { throw new Error('Simulated audit sink failure'); };

        const resilientController = new AudioStreamingController({
            voiceCallRepo,
            accessService,
            auditEventSink: faultySink,
            voiceAccessAuthorizer
        });

        const fakeReq = {
            params: { id: assignedCallA.id },
            auth: { id: 'synth_user_a', role: 'user', team: '상담1팀', status: 'active', permissions: { voiceCalls: true } },
            headers: {}
        };
        let responseStatus = null;
        const fakeRes = new Writable({
            write(chunk, encoding, callback) { callback(); }
        });
        fakeRes.status = (s) => { responseStatus = s; return fakeRes; };
        fakeRes.setHeader = () => fakeRes;
        fakeRes.json = () => fakeRes;
        fakeRes.headersSent = false;
        let didThrow = false;
        try {
            await resilientController.streamAudio(fakeReq, fakeRes);
        } catch (e) {
            didThrow = true;
        }
        assertStrictEqual(didThrow, false, 'Sink throw must not crash streamAudio');
        assertStrictEqual(responseStatus, 200, 'Streaming status must be 200');
    });

    await testCase('18.4 Audit event semantics: AUTHORIZED -> STREAM_OPENED -> PLAY_STARTED on first chunk', async () => {
        auditSink.clear();
        await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        const events = auditSink.getEvents();
        const authEv = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_ACCESS_AUTHORIZED);
        const openEv = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_STREAM_OPENED);
        const playEv = events.find(e => e.eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED);
        assertCondition(authEv !== undefined, 'AUDIO_ACCESS_AUTHORIZED must be logged');
        assertCondition(openEv !== undefined, 'AUDIO_STREAM_OPENED must be logged');
        assertCondition(playEv !== undefined, 'AUDIO_PLAY_STARTED must be logged');
    });

    // ============================================================
    // 19. ROUTE ORDER & SPA FALLBACK PROTECTION (CATEGORY I)
    // ============================================================
    console.log('\n--- 19. Route Order, ID Validation & SPA Protection (Category I) ---');

    await testCase('19.1 /download route sets Content-Disposition attachment', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio/download`, {
            headers: { Cookie: adminCookie }
        });
        assertStrictEqual(res.status, 200);
        assertCondition(res.headers.get('content-disposition').includes('attachment'));
    });

    await testCase('19.2 Standard /audio route sets Content-Disposition inline', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertCondition(res.headers.get('content-disposition').includes('inline'));
    });

    await testCase('19.3 Query download=true on /audio does NOT enable attachment disposition', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/${assignedCallA.id}/audio?download=true`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 200);
        assertCondition(res.headers.get('content-disposition').includes('inline'), 'Query must not grant download');
    });

    await testCase('19.4 Malformed Call ID returns 400 INVALID_ID_FORMAT', async () => {
        const res = await fetch(`${baseUrl}/api/voice-calls/malformed!!id/audio`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 400);
        const data = await res.json();
        assertStrictEqual(data.error.code, 'INVALID_ID_FORMAT');
    });

    await testCase('19.5 Nonexistent API route returns JSON 404, NEVER SPA index.html', async () => {
        const res = await fetch(`${baseUrl}/api/nonexistent-subsystem/endpoint`, {
            headers: { Cookie: userACookie }
        });
        assertStrictEqual(res.status, 404);
        const data = await res.json();
        assertStrictEqual(data.error.code, 'NOT_FOUND');
    });

    await testCase('19.6 Non-API frontend path falls back to SPA HTML', async () => {
        const res = await fetch(`${baseUrl}/dashboard/client-record`);
        assertStrictEqual(res.status, 200);
        const text = await res.text();
        assertCondition(text.includes('SPA_FALLBACK_PAGE'));
    });

    await stopServer();

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n====================================================');
    console.log('📊 Track A7 Audio Streaming Verification Summary:');
    console.log(`   - Tests Passed: ${passedTests}`);
    console.log(`   - Tests Failed: ${failedTests}`);
    console.log(`   - Total Assertions: ${totalAssertions}`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        console.error(`❌ Verification failed with ${failedTests} failures.`);
        process.exit(1);
    } else {
        console.log('🎉 All Track A7 Audio Streaming tests passed with 100% success!\n');
        process.exit(0);
    }
}

runAllTests().catch((err) => {
    console.error('Fatal test error:', err);
    if (server) server.close();
    process.exit(1);
});

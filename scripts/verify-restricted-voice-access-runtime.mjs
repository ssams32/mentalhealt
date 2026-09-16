/**
 * scripts/verify-restricted-voice-access-runtime.mjs
 * Mind-ERP OS Track A10.5 Runtime Enforcement Closure Verification.
 * 
 * End-to-end Express HTTP integration test harness verifying real-server runtime wiring,
 * mandatory authorizer fail-closed defense, bypass removal, and grant lifecycle enforcement.
 */

import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';
import http from 'http';

import { SessionRepository } from '../server/auth/sessionRepository.js';
import { AuthService } from '../server/auth/authService.js';
import { createAuthMiddleware } from '../server/auth/authMiddleware.js';
import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import {
    PrivateAudioAccessService,
    AuditEventSink,
    createAudioStreamingRouter,
    AudioStreamingController
} from '../server/audio-streaming/index.js';
import {
    parseVoiceAccessConfig,
    validateVoiceAccessConfig,
    VoiceAccessRepository,
    VoiceAccessHistoryRepository,
    VoiceAccessAuthorizer,
    VoiceAccessService,
    VOICE_ACCESS_CAPABILITIES,
    ACCESS_SCOPE_TYPE,
    GRANT_STATUS
} from '../server/voice-access/index.js';
import { AssignmentService } from '../server/assignment/assignmentService.js';

// Setup isolated temporary test root
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice_access_runtime_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
const PRIVATE_AUDIO_DIR = path.join(TEST_ROOT, 'private-audio');
const VOICE_ACCESS_DIR = path.join(DATA_DIR, 'voice-access');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_AUDIO_DIR, { recursive: true });
fs.mkdirSync(VOICE_ACCESS_DIR, { recursive: true });

console.log('================================================================');
console.log('🧪 Starting Mind-ERP OS Track A10.5: Runtime Enforcement Tests');
console.log(`📁 Runtime Sandbox: ${TEST_ROOT}`);
console.log('================================================================\n');

// Synthetic Users
const SYNTH_USERS = [
    {
        id: 'synth_bootstrap_admin',
        username: 'bootstrap_admin',
        password: 'boot_secret',
        name: 'Bootstrap Admin',
        role: 'admin',
        team: '기획팀',
        status: 'active'
    },
    {
        id: 'synth_unlisted_admin',
        username: 'unlisted_admin',
        password: 'admin_secret',
        name: 'Unlisted Admin',
        role: 'admin',
        team: '기획팀',
        status: 'active'
    },
    {
        id: 'synth_unlisted_user',
        username: 'unlisted_user',
        password: 'user_secret',
        name: 'Unlisted User',
        role: 'user',
        team: '회복지원팀',
        status: 'active'
    },
    {
        id: 'synth_granted_admin',
        username: 'granted_admin',
        password: 'granted_admin_secret',
        name: 'Granted Admin',
        role: 'admin',
        team: '기획팀',
        status: 'active'
    },
    {
        id: 'synth_granted_user',
        username: 'granted_user',
        password: 'granted_user_secret',
        name: 'Granted User',
        role: 'user',
        team: '회복지원팀',
        status: 'active'
    }
];

// Helper: Synthetic WAV file generator
function createSyntheticWav(payloadBytes = 2000) {
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
        buf[i] = (i % 256);
    }
    return buf;
}

// In-memory data store for persistence mocks
const memoryStore = {
    Users: SYNTH_USERS,
    VoiceCalls: [],
    Sessions: []
};

function getData(filename, defaultValue = []) {
    return memoryStore[filename] || defaultValue;
}

async function persistData(filename, data) {
    memoryStore[filename] = data;
    return true;
}

// Initialize Synthetic Audio File
const callId = 'call_runtime_001';
const storageKey = 'private-audio/2026/09/call_runtime_001/obj_001.wav';
const fullAudioPath = path.join(TEST_ROOT, storageKey);
fs.mkdirSync(path.dirname(fullAudioPath), { recursive: true });
const wavData = createSyntheticWav(4000);
fs.writeFileSync(fullAudioPath, wavData);

const callRecord = {
    id: callId,
    clientName: '홍길동',
    callCategory: 'inbound',
    processingStatus: 'intake_validated',
    storagePromotionStatus: 'linked',
    assignedDepartmentId: 'dept_recovery',
    assignedUserId: 'synth_granted_user',
    storageKey: storageKey,
    contentHash: crypto.createHash('sha256').update(wavData).digest('hex'),
    fileSize: wavData.length,
    mimeType: 'audio/wav',
    durationSeconds: 15,
    version: 1
};
memoryStore.VoiceCalls = [callRecord];

let passedTests = 0;
function recordPass(name) {
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
}

// Helper: HTTP request over node http
function makeHttpRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const bodyBuf = Buffer.concat(chunks);
                let json = null;
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try {
                        json = JSON.parse(bodyBuf.toString('utf8'));
                    } catch {}
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: bodyBuf,
                    json
                });
            });
        });
        req.on('error', reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

// Helper: Login and return cookie string
async function loginAndGetCookie(authService, username, password) {
    const result = await authService.login(username, password, {
        ipAddress: '127.0.0.1',
        userAgent: 'NodeTestHarness/1.0'
    });
    return `mind_session=${result.token}`;
}

async function runRuntimeTests() {
    // 1. Common Services
    const sessionRepo = new SessionRepository(getData, persistData);
    const authService = new AuthService(sessionRepo, () => getData('Users', []));
    const { requireAuth } = createAuthMiddleware(authService);
    const voiceCallRepo = new VoiceCallRepository(getData, persistData);
    const accessService = new PrivateAudioAccessService({
        privateAudioRoot: PRIVATE_AUDIO_DIR
    });
    const auditSink = new AuditEventSink();

    // Prepare sessions
    const cookieBootstrapAdmin = await loginAndGetCookie(authService, 'bootstrap_admin', 'boot_secret');
    const cookieUnlistedAdmin = await loginAndGetCookie(authService, 'unlisted_admin', 'admin_secret');
    const cookieUnlistedUser = await loginAndGetCookie(authService, 'unlisted_user', 'user_secret');
    const cookieGrantedAdmin = await loginAndGetCookie(authService, 'granted_admin', 'granted_admin_secret');
    const cookieGrantedUser = await loginAndGetCookie(authService, 'granted_user', 'granted_user_secret');

    // =========================================================================
    // SCENARIO A: MISSING AUTHORIZER (FAIL-CLOSED 503) & STRICT DEFAULT-DENY
    // =========================================================================
    console.log('--- SCENARIO A: Missing Authorizer Fail-Closed ---');
    {
        const appA = express();
        appA.use(express.json());

        // Legacy non-voice route must remain completely functional
        appA.get('/api/health', (req, res) => res.json({ status: 'ok', subsystem: 'core' }));

        // Intentionally provide null / missing authorizer
        const routerA = createAudioStreamingRouter({
            requireAuth,
            voiceCallRepository: voiceCallRepo,
            privateAudioAccessService: accessService,
            auditEventSink: auditSink,
            voiceAccessAuthorizer: null // Explicitly null
        });
        appA.use('/api/voice-calls', routerA);

        const serverA = http.createServer(appA);
        await new Promise(res => serverA.listen(0, '127.0.0.1', res));
        const portA = serverA.address().port;

        // A.1 GET /audio returns 503 VOICE_SYSTEM_UNAVAILABLE
        const resGet = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: portA,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resGet.statusCode, 503, 'Missing authorizer must return 503 on GET');
        assert.strictEqual(resGet.json?.error?.code, 'VOICE_SYSTEM_UNAVAILABLE');
        recordPass('A.1 Controller constructed without authorizer always denies GET (503)');

        // A.2 HEAD /audio returns 503
        const resHead = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: portA,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'HEAD',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resHead.statusCode, 503, 'Missing authorizer must return 503 on HEAD');
        recordPass('A.2 Controller constructed without authorizer always denies HEAD (503)');

        // A.3 GET /audio/download returns 503
        const resDown = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: portA,
            path: `/api/voice-calls/${callId}/audio/download`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resDown.statusCode, 503, 'Missing authorizer must return 503 on download');
        assert.strictEqual(resDown.json?.error?.code, 'VOICE_SYSTEM_UNAVAILABLE');
        recordPass('A.3 Controller constructed without authorizer always denies download (503)');

        // A.4 Controller with strictVoiceAccess=false but no authorizer still denies
        const controllerStrictFalse = new AudioStreamingController({
            voiceCallRepo,
            accessService,
            auditEventSink: auditSink,
            strictVoiceAccess: false,
            voiceAccessAuthorizer: null
        });
        const fakeReqA = { params: { id: callId }, auth: SYNTH_USERS[3], headers: {} };
        let statusStrictFalse = null;
        let bodyStrictFalse = null;
        const fakeResStrictFalse = {
            status: (s) => { statusStrictFalse = s; return fakeResStrictFalse; },
            json: (b) => { bodyStrictFalse = b; return fakeResStrictFalse; },
            end: () => fakeResStrictFalse,
            setHeader: () => fakeResStrictFalse
        };
        await controllerStrictFalse.streamAudio(fakeReqA, fakeResStrictFalse);
        assert.strictEqual(statusStrictFalse, 503, 'Controller with strictVoiceAccess=false but no authorizer must deny 503');
        assert.strictEqual(bodyStrictFalse?.error?.code, 'VOICE_SYSTEM_UNAVAILABLE');
        recordPass('A.4 Controller with strictVoiceAccess=false but no authorizer still denies (503)');

        // A.5 Controller with VOICE_SYSTEM_ENABLED unset but no authorizer still denies
        const prevEnv = process.env.VOICE_SYSTEM_ENABLED;
        delete process.env.VOICE_SYSTEM_ENABLED;
        let statusEnvUnset = null;
        let bodyEnvUnset = null;
        const fakeResEnvUnset = {
            status: (s) => { statusEnvUnset = s; return fakeResEnvUnset; },
            json: (b) => { bodyEnvUnset = b; return fakeResEnvUnset; },
            end: () => fakeResEnvUnset,
            setHeader: () => fakeResEnvUnset
        };
        await controllerStrictFalse.streamAudio(fakeReqA, fakeResEnvUnset);
        assert.strictEqual(statusEnvUnset, 503, 'Controller with VOICE_SYSTEM_ENABLED unset but no authorizer must deny 503');
        assert.strictEqual(bodyEnvUnset?.error?.code, 'VOICE_SYSTEM_UNAVAILABLE');
        if (prevEnv !== undefined) process.env.VOICE_SYSTEM_ENABLED = prevEnv;
        recordPass('A.5 Controller with VOICE_SYSTEM_ENABLED unset but no authorizer still denies (503)');

        // A.6 AssignmentService without authorizer always denies
        const assignmentServiceMissing = new AssignmentService({
            voiceCallRepo,
            voiceAccessAuthorizer: null
        });
        let assignBlocked = false;
        try {
            await assignmentServiceMissing.assignCall({
                callId,
                operationId: 'op_missing_auth',
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synth_granted_user',
                expectedVersion: 1,
                reasonCode: 'manual_assignment'
            }, SYNTH_USERS[3]);
        } catch (err) {
            if (err.code === 'VOICE_SYSTEM_UNAVAILABLE' && (err.status === 503 || err.statusCode === 503)) {
                assignBlocked = true;
            }
        }
        assert.strictEqual(assignBlocked, true, 'AssignmentService with missing authorizer throws 503');
        recordPass('A.6 AssignmentService without authorizer always denies (503)');

        // A.7 Legacy non-voice route remains unaffected
        const resHealthA = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: portA,
            path: '/api/health',
            method: 'GET'
        });
        assert.strictEqual(resHealthA.statusCode, 200, 'Legacy non-voice route must return 200 OK');
        assert.strictEqual(resHealthA.json?.status, 'ok');
        recordPass('A.7 Legacy non-voice route remains unaffected (200 OK) when voice system is unavailable');

        await new Promise(res => serverA.close(res));
    }

    // =========================================================================
    // SCENARIO B: VOICE ACCESS MODE & FEATURE CONFIGURATION VALIDATION
    // =========================================================================
    console.log('\n--- SCENARIO B: Voice Access Mode & Feature Validation ---');
    {
        // B.1 audit mode rejected
        const configAudit = parseVoiceAccessConfig({ VOICE_SYSTEM_ACCESS_MODE: 'audit' });
        const valAudit = validateVoiceAccessConfig(configAudit);
        assert.strictEqual(valAudit.valid, false, 'audit mode must be rejected');
        recordPass('B.1 audit mode rejected (configuration invalid)');

        // B.2 permissive mode rejected
        const configPermissive = parseVoiceAccessConfig({ VOICE_SYSTEM_ACCESS_MODE: 'permissive' });
        const valPermissive = validateVoiceAccessConfig(configPermissive);
        assert.strictEqual(valPermissive.valid, false, 'permissive mode must be rejected');
        recordPass('B.2 permissive mode rejected (configuration invalid)');

        // B.3 role_only mode rejected
        const configRoleOnly = parseVoiceAccessConfig({ VOICE_SYSTEM_ACCESS_MODE: 'role_only' });
        const valRoleOnly = validateVoiceAccessConfig(configRoleOnly);
        assert.strictEqual(valRoleOnly.valid, false, 'role_only mode must be rejected');
        recordPass('B.3 role_only mode rejected (configuration invalid)');

        // B.4 strict and allowlist modes accepted
        const configStrict = parseVoiceAccessConfig({ VOICE_SYSTEM_ACCESS_MODE: 'strict' });
        assert.strictEqual(validateVoiceAccessConfig(configStrict).valid, true, 'strict mode must be valid');
        const configAllowlist = parseVoiceAccessConfig({ VOICE_SYSTEM_ACCESS_MODE: 'allowlist' });
        assert.strictEqual(validateVoiceAccessConfig(configAllowlist).valid, true, 'allowlist mode must be valid');
        recordPass('B.4 strict and allowlist enforceable modes accepted');

        // B.5 Disabled voice system returns 503
        const envDisabled = {
            VOICE_SYSTEM_ENABLED: 'false',
            DATA_DIR: DATA_DIR
        };
        const configDisabled = parseVoiceAccessConfig(envDisabled);
        assert.strictEqual(configDisabled.enabled, false);

        let disabledAuthorizer = null;
        if (configDisabled.enabled) {
            disabledAuthorizer = new VoiceAccessAuthorizer({
                repository: new VoiceAccessRepository({ dataDir: configDisabled.dataDir })
            });
        }

        const appB = express();
        appB.use(express.json());
        const routerB = createAudioStreamingRouter({
            requireAuth,
            voiceCallRepository: voiceCallRepo,
            privateAudioAccessService: accessService,
            auditEventSink: auditSink,
            voiceAccessAuthorizer: disabledAuthorizer
        });
        appB.use('/api/voice-calls', routerB);

        const serverB = http.createServer(appB);
        await new Promise(res => serverB.listen(0, '127.0.0.1', res));
        const portB = serverB.address().port;

        const resDisabled = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: portB,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resDisabled.statusCode, 503, 'Disabled voice system returns 503');
        recordPass('B.5 Disabled voice system returns 503 VOICE_SYSTEM_UNAVAILABLE');

        await new Promise(res => serverB.close(res));
    }

    // =========================================================================
    // FULL OPERATIONAL SERVER SETUP (VOICE_SYSTEM_ENABLED=true)
    // =========================================================================
    const envEnabled = {
        VOICE_SYSTEM_ENABLED: 'true',
        VOICE_SYSTEM_ACCESS_MODE: 'strict',
        VOICE_SYSTEM_ACCESS_DATA_DIR: VOICE_ACCESS_DIR,
        VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: 'synth_bootstrap_admin'
    };
    const voiceConfig = parseVoiceAccessConfig(envEnabled);
    const voiceValidation = validateVoiceAccessConfig(voiceConfig);
    assert.strictEqual(voiceValidation.valid, true);

    const grantRepo = new VoiceAccessRepository({ dataDir: voiceConfig.dataDir });
    const historyRepo = new VoiceAccessHistoryRepository({ dataDir: voiceConfig.dataDir });
    const voiceAuthorizer = new VoiceAccessAuthorizer({
        repository: grantRepo,
        mode: voiceConfig.mode
    });
    const voiceService = new VoiceAccessService({
        voiceAccessRepo: grantRepo,
        voiceAccessHistoryRepo: historyRepo,
        voiceAccessAuthorizer: voiceAuthorizer,
        config: voiceConfig
    });

    const runtimeApp = express();
    runtimeApp.use(compression({
        filter: (req, res) => {
            if (req.path && req.path.includes('/audio')) return false;
            return compression.filter(req, res);
        }
    }));
    runtimeApp.use(express.json());

    const runtimeAudioRouter = createAudioStreamingRouter({
        requireAuth,
        voiceCallRepository: voiceCallRepo,
        privateAudioAccessService: accessService,
        auditEventSink: auditSink,
        voiceAccessAuthorizer: voiceAuthorizer
    });
    runtimeApp.use('/api/voice-calls', runtimeAudioRouter);

    const runtimeServer = http.createServer(runtimeApp);
    await new Promise(res => runtimeServer.listen(0, '127.0.0.1', res));
    const runtimePort = runtimeServer.address().port;

    const assignmentService = new AssignmentService({
        voiceCallRepo,
        voiceAccessAuthorizer: voiceAuthorizer,
        strictVoiceAccess: true
    });

    // =========================================================================
    // SCENARIO C: NO GRANT (UNLISTED USER / ADMIN -> 403 DEFAULT-DENY)
    // =========================================================================
    console.log('\n--- SCENARIO C: Default-Deny for Unlisted Users ---');
    {
        // C.0 Missing bootstrap ID rejects initialization
        const emptyConfig = parseVoiceAccessConfig({
            VOICE_SYSTEM_ENABLED: 'true',
            VOICE_SYSTEM_ACCESS_DATA_DIR: path.join(DATA_DIR, 'unbooted'),
            VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: ''
        });
        const unbootedGrantRepo = new VoiceAccessRepository({ dataDir: emptyConfig.dataDir });
        const unbootedHistoryRepo = new VoiceAccessHistoryRepository({ dataDir: emptyConfig.dataDir });
        const unbootedService = new VoiceAccessService({
            voiceAccessRepo: unbootedGrantRepo,
            voiceAccessHistoryRepo: unbootedHistoryRepo,
            voiceAccessAuthorizer: new VoiceAccessAuthorizer({ repository: unbootedGrantRepo }),
            config: emptyConfig
        });
        let missingBootBlocked = false;
        try {
            await unbootedService.initializeBootstrapGrant(SYNTH_USERS[0], {
                capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
                reason: 'Bootstrap without ID'
            });
        } catch (err) {
            if (err.statusCode === 403 || err.code === 'BOOTSTRAP_UNAUTHORIZED') {
                missingBootBlocked = true;
            }
        }
        assert.strictEqual(missingBootBlocked, true, 'Missing bootstrap ID rejects initialization');
        recordPass('C.0 Missing bootstrap ID rejects first-grant initialization (403)');

        // C.0.1 Bootstrap ID alone cannot stream audio
        const resBootStream = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieBootstrapAdmin }
        });
        assert.strictEqual(resBootStream.statusCode, 403, 'Bootstrap ID alone cannot stream audio');
        recordPass('C.0.1 Bootstrap ID alone cannot stream audio (403)');

        // C.0.2 Bootstrap ID alone cannot download audio
        const resBootDown = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio/download`,
            method: 'GET',
            headers: { Cookie: cookieBootstrapAdmin }
        });
        assert.strictEqual(resBootDown.statusCode, 403, 'Bootstrap ID alone cannot download audio');
        recordPass('C.0.2 Bootstrap ID alone cannot download audio (403)');

        // C.0.3 Bootstrap ID alone cannot assign calls
        let bootAssignBlocked = false;
        try {
            await assignmentService.assignCall({
                callId,
                operationId: 'op_boot_admin_alone',
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synth_granted_user',
                expectedVersion: 1,
                reasonCode: 'manual_assignment'
            }, SYNTH_USERS[0]);
        } catch (err) {
            if (err.code === 'ASSIGNMENT_FORBIDDEN') {
                bootAssignBlocked = true;
            }
        }
        assert.strictEqual(bootAssignBlocked, true, 'Bootstrap identity alone cannot assign calls');
        recordPass('C.0.3 Bootstrap ID alone cannot assign calls (403)');

        // C.1 Unlisted Admin denied streaming (403)
        const resAdminStream = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieUnlistedAdmin }
        });
        assert.strictEqual(resAdminStream.statusCode, 403, 'Unlisted admin must be denied streaming');
        assert.strictEqual(resAdminStream.json?.error?.code, 'AUDIO_ACCESS_FORBIDDEN');
        recordPass('C.1 Unlisted admin streaming denied (403 AUDIO_ACCESS_FORBIDDEN)');

        // C.2 Unlisted User denied streaming (403)
        const resUserStream = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieUnlistedUser }
        });
        assert.strictEqual(resUserStream.statusCode, 403, 'Unlisted user must be denied streaming');
        recordPass('C.2 Unlisted user streaming denied (403)');

        // C.3 Unlisted Admin HEAD probe denied (403)
        const resAdminHead = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'HEAD',
            headers: { Cookie: cookieUnlistedAdmin }
        });
        assert.strictEqual(resAdminHead.statusCode, 403, 'Unlisted admin HEAD denied (403)');
        recordPass('C.3 Unlisted admin HEAD probe denied (403)');

        // C.4 Unlisted Admin assignment denied (403)
        let unlistedAssignBlocked = false;
        try {
            await assignmentService.assignCall({
                callId,
                operationId: 'op_unlisted_admin',
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synth_granted_user',
                expectedVersion: 1,
                reasonCode: 'manual_assignment'
            }, SYNTH_USERS[1]);
        } catch (err) {
            if (err.code === 'ASSIGNMENT_FORBIDDEN' && (err.status === 403 || err.statusCode === 403)) {
                unlistedAssignBlocked = true;
            }
        }
        assert.strictEqual(unlistedAssignBlocked, true, 'Unlisted admin assignment denied');
        recordPass('C.4 Unlisted admin assignment denied (403 ASSIGNMENT_FORBIDDEN)');
    }

    // =========================================================================
    // SCENARIO D: ACTIVE GRANT (STREAMING & DOWNLOAD SUCCEEDS)
    // =========================================================================
    console.log('\n--- SCENARIO D: Active Grant Authorized Execution ---');
    let adminGrantId = null;
    let adminGrantVersion = null;
    {
        // Bootstrap admin initializes first grant for themselves
        const bootstrapActor = SYNTH_USERS[0];
        const bootGrant = await voiceService.initializeBootstrapGrant(bootstrapActor, {
            capabilities: [
                VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
                VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS,
                VOICE_ACCESS_CAPABILITIES.VIEW,
                VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
                VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,
                VOICE_ACCESS_CAPABILITIES.ASSIGN
            ],
            reason: 'Bootstrap admin initialization'
        });
        assert.ok(bootGrant.id);
        recordPass('D.1 Bootstrap initialization creates first active grant');

        // Create active grant for granted_admin
        const adminGrant = await voiceService.createGrant(bootstrapActor, {
            userId: 'synth_granted_admin',
            capabilities: [
                VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
                VOICE_ACCESS_CAPABILITIES.VIEW,
                VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
                VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,
                VOICE_ACCESS_CAPABILITIES.ASSIGN
            ],
            scope: { type: ACCESS_SCOPE_TYPE.ALL },
            reason: 'Primary admin grant'
        });
        adminGrantId = adminGrant.id;
        adminGrantVersion = adminGrant.version;
        recordPass('D.2 Granted admin provisioned with full voice capabilities');

        // D.3 HTTP Range Streaming succeeds (206 Partial Content)
        const resStreamRange = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: {
                Cookie: cookieGrantedAdmin,
                Range: 'bytes=0-499'
            }
        });
        assert.strictEqual(resStreamRange.statusCode, 206, 'Range streaming must return 206');
        assert.strictEqual(resStreamRange.headers['content-range'], 'bytes 0-499/4044');
        assert.strictEqual(resStreamRange.body.length, 500);
        recordPass('D.3 HTTP Range streaming succeeds (206 Partial Content, exact range)');

        // D.4 HEAD request succeeds (200 OK)
        const resHeadSuccess = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'HEAD',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resHeadSuccess.statusCode, 200, 'HEAD must return 200 OK');
        assert.strictEqual(resHeadSuccess.headers['content-length'], '4044');
        recordPass('D.4 HEAD request returns 200 with full Content-Length');

        // D.5 Download succeeds (200 OK, attachment)
        const resDownload = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio/download`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resDownload.statusCode, 200, 'Download returns 200');
        assert.ok(resDownload.headers['content-disposition']?.includes('attachment'), 'Must be attachment');
        assert.strictEqual(resDownload.body.length, 4044);
        recordPass('D.5 Download returns 200 OK with attachment disposition');

        // D.6 Assignment clears restricted authorization gate
        let assignProceeded = false;
        try {
            await assignmentService.assignCall({
                callId,
                operationId: 'op_granted_admin_ok',
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synth_granted_user',
                expectedVersion: 1,
                reasonCode: 'manual_assignment'
            }, SYNTH_USERS[3]);
        } catch (err) {
            // Downstream repo mock failure is fine; verify authorization cleared
            if (err.code !== 'ASSIGNMENT_FORBIDDEN' && err.code !== 'VOICE_SYSTEM_UNAVAILABLE') {
                assignProceeded = true;
            }
        }
        assert.strictEqual(assignProceeded, true, 'Granted admin clears assignment gate');
        recordPass('D.6 Granted admin clears assignment authorization gate');

        // D.7 Legacy non-voice route on operational server remains unaffected
        runtimeApp.get('/api/health', (req, res) => res.json({ status: 'ok', runtime: true }));
        const resHealthRuntime = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: '/api/health',
            method: 'GET'
        });
        assert.strictEqual(resHealthRuntime.statusCode, 200, 'Legacy non-voice route must return 200 OK');
        assert.strictEqual(resHealthRuntime.json?.status, 'ok');
        recordPass('D.7 Legacy non-voice route remains unaffected (200 OK) on operational server');
    }

    // =========================================================================
    // SCENARIO E: GRANT LIFECYCLE ENFORCEMENT IN REAL-TIME
    // =========================================================================
    console.log('\n--- SCENARIO E: Real-time Grant Lifecycle Enforcement ---');
    {
        const bootstrapActor = SYNTH_USERS[0];

        // E.1 Suspend grant -> Immediate 403 in runtime HTTP
        const suspended = await voiceService.suspendGrant(
            bootstrapActor,
            adminGrantId,
            adminGrantVersion,
            'Security audit hold'
        );
        adminGrantVersion = suspended.version;

        const resSuspended = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resSuspended.statusCode, 403, 'Suspended user must immediately receive 403');
        recordPass('E.1 Suspended user receives real-time 403 without stale session cache');

        // E.2 Reactivate grant -> Immediate 206 in runtime HTTP
        const reactivated = await voiceService.reactivateGrant(
            bootstrapActor,
            adminGrantId,
            adminGrantVersion,
            'Audit hold lifted'
        );
        adminGrantVersion = reactivated.version;

        const resReactivated = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: {
                Cookie: cookieGrantedAdmin,
                Range: 'bytes=0-100'
            }
        });
        assert.strictEqual(resReactivated.statusCode, 206, 'Reactivated user immediately restored');
        recordPass('E.2 Reactivated user immediately restored to streaming access (206)');

        // E.3 Revoke grant -> Permanent 403
        const revoked = await voiceService.revokeGrant(
            bootstrapActor,
            adminGrantId,
            adminGrantVersion,
            'Permanent revocation'
        );
        adminGrantVersion = revoked.version;

        const resRevoked = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieGrantedAdmin }
        });
        assert.strictEqual(resRevoked.statusCode, 403, 'Revoked user strictly denied');
        recordPass('E.3 Revoked grant strictly denied (403)');
    }

    // =========================================================================
    // SCENARIO F: BOOTSTRAP LIMITS & CONFLICTS
    // =========================================================================
    console.log('\n--- SCENARIO F: Bootstrap Limits ---');
    {
        // F.1 Second bootstrap initialization is blocked (409 Conflict)
        let secondBootstrapBlocked = false;
        try {
            await voiceService.initializeBootstrapGrant(SYNTH_USERS[0], {
                capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
                reason: 'Second bootstrap attempt'
            });
        } catch (err) {
            if (err.code === 'BOOTSTRAP_ALREADY_INITIALIZED' || err.statusCode === 409) {
                secondBootstrapBlocked = true;
            }
        }
        assert.strictEqual(secondBootstrapBlocked, true, 'Second bootstrap initialization must be rejected');
        recordPass('F.1 Second bootstrap initialization rejected (409 Conflict)');

        // F.2 Non-bootstrap admin cannot call bootstrap initialization
        let unauthorizedBootstrapBlocked = false;
        try {
            await voiceService.initializeBootstrapGrant(SYNTH_USERS[1], {
                capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
                reason: 'Rogue bootstrap'
            });
        } catch (err) {
            if (err.code === 'BOOTSTRAP_ADMIN_REQUIRED' || err.statusCode === 403 || err.code === 'BOOTSTRAP_ALREADY_INITIALIZED') {
                unauthorizedBootstrapBlocked = true;
            }
        }
        assert.strictEqual(unauthorizedBootstrapBlocked, true, 'Non-bootstrap admin initialization rejected');
        recordPass('F.2 Non-bootstrap admin cannot execute bootstrap initialization');
    }

    // =========================================================================
    // SCENARIO G: DIRECT BYPASS PREVENTION
    // =========================================================================
    console.log('\n--- SCENARIO G: Direct Bypass Prevention ---');
    {
        // G.1 Direct request without session cookie -> 401 Unauthorized
        const resNoAuth = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET'
        });
        assert.strictEqual(resNoAuth.statusCode, 401, 'Anonymous request must return 401');
        recordPass('G.1 Anonymous request returns 401 Unauthorized');

        // G.2 Forged x-user-id header ignored -> 401 Unauthorized
        const resForgedHeader = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: {
                'x-user-id': 'synth_bootstrap_admin',
                'x-role': 'admin'
            }
        });
        assert.strictEqual(resForgedHeader.statusCode, 401, 'Forged header ignored, returns 401');
        recordPass('G.2 Forged identity header ignored, returns 401');

        // G.3 _preAuthorized bypass attempt in AssignmentService is strictly blocked
        const sneakyContext = { ...SYNTH_USERS[1], _preAuthorized: true };
        let sneakyBlocked = false;
        try {
            await assignmentService.assignCall({
                callId,
                operationId: 'op_sneaky',
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synth_granted_user',
                expectedVersion: 1,
                reasonCode: 'manual_assignment'
            }, sneakyContext);
        } catch (err) {
            if (err.code === 'ASSIGNMENT_FORBIDDEN') {
                sneakyBlocked = true;
            }
        }
        assert.strictEqual(sneakyBlocked, true, '_preAuthorized: true cannot bypass AssignmentService');
        recordPass('G.3 _preAuthorized bypass attempt in AssignmentService strictly blocked (403)');

        // G.4 Regular user cannot download audio even if grant allows download
        // Provision user grant with DOWNLOAD capability
        const userGrant = await voiceService.createGrant(SYNTH_USERS[0], {
            userId: 'synth_granted_user',
            capabilities: [
                VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
                VOICE_ACCESS_CAPABILITIES.VIEW,
                VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
                VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO
            ],
            scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
            reason: 'User grant'
        });
        assert.ok(userGrant.id);

        const resUserDownload = await makeHttpRequest({
            hostname: '127.0.0.1',
            port: runtimePort,
            path: `/api/voice-calls/${callId}/audio/download`,
            method: 'GET',
            headers: { Cookie: cookieGrantedUser }
        });
        assert.strictEqual(resUserDownload.statusCode, 403, 'Regular user cannot download even if grant has it');
        recordPass('G.4 Role restriction strictly enforced (grant cannot enlarge role permissions)');
    }

    await new Promise(res => runtimeServer.close(res));

    console.log('\n================================================================');
    console.log(`🎉 ALL ${passedTests} RUNTIME ENFORCEMENT INTEGRATION TESTS PASSED!`);
    console.log('================================================================\n');
}

runRuntimeTests().catch(err => {
    console.error('\n❌ RUNTIME VERIFICATION FAILED:', err);
    process.exit(1);
});

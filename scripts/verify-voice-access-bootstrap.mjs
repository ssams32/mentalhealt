/**
 * scripts/verify-voice-access-bootstrap.mjs
 * Mind-ERP OS Track A10.6 Verification Suite:
 * Pilot Voice Access Bootstrap Foundation, Dry-run, and Safe Config Validation.
 * 
 * Exclusively executes against isolated temporary directories and synthetic data.
 * ZERO production grant creation. ZERO production Users.json or data changes.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';
import http from 'http';
import express from 'express';

import {
    executeBootstrap,
    validateBootstrapConfig,
    validateBootstrapUser,
    checkGrantStoreStatus,
    DEFAULT_PILOT_CAPABILITIES
} from './bootstrap-voice-access-grant.mjs';
import {
    VOICE_ACCESS_CAPABILITIES,
    GRANTS_FILE_NAME,
    HISTORY_FILE_NAME,
    GRANT_STATUS
} from '../server/voice-access/voiceAccessConstants.js';
import {
    VoiceAccessRepository
} from '../server/voice-access/voiceAccessRepository.js';
import {
    VoiceAccessHistoryRepository
} from '../server/voice-access/voiceAccessHistoryRepository.js';
import {
    VoiceAccessAuthorizer
} from '../server/voice-access/voiceAccessAuthorizer.js';
import {
    VoiceAccessService
} from '../server/voice-access/voiceAccessService.js';
import {
    VoiceCallRepository
} from '../server/voice-calls/voiceCallRepository.js';
import {
    PrivateAudioAccessService,
    AuditEventSink,
    createAudioStreamingRouter
} from '../server/audio-streaming/index.js';
import { SessionRepository } from '../server/auth/sessionRepository.js';
import { AuthService } from '../server/auth/authService.js';
import { createAuthMiddleware } from '../server/auth/authMiddleware.js';

// Setup isolated sandbox
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice_bootstrap_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
const VOICE_ACCESS_DIR = path.join(DATA_DIR, 'voice-access');
const PRIVATE_AUDIO_DIR = path.join(TEST_ROOT, 'private-audio');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VOICE_ACCESS_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_AUDIO_DIR, { recursive: true });

console.log('================================================================');
console.log('🧪 Starting Mind-ERP OS Track A10.6: Bootstrap Foundation Tests');
console.log(`📁 Isolated Test Sandbox: ${TEST_ROOT}`);
console.log('================================================================\n');

// Synthetic Users
const SYNTH_USERS = [
    {
        id: 'synth_boot_admin',
        username: 'boot_admin',
        password: 'admin_secret',
        role: 'admin',
        team: '기획팀',
        status: 'active'
    },
    {
        id: 'synth_unlisted_admin',
        username: 'unlisted_admin',
        password: 'unlisted_admin_secret',
        role: 'admin',
        team: '운영팀',
        status: 'active'
    },
    {
        id: 'synth_inactive_admin',
        username: 'inactive_admin',
        password: 'inactive_secret',
        role: 'admin',
        team: '기획팀',
        status: 'inactive'
    },
    {
        id: 'synth_suspended_admin',
        username: 'suspended_admin',
        password: 'suspended_secret',
        role: 'admin',
        team: '기획팀',
        status: 'suspended'
    },
    {
        id: 'synth_deleted_admin',
        username: 'deleted_admin',
        password: 'deleted_secret',
        role: 'admin',
        team: '기획팀',
        status: 'active',
        isDeleted: true
    },
    {
        id: 'synth_regular_user',
        username: 'regular_user',
        password: 'user_secret',
        role: 'user',
        team: '상담1팀',
        status: 'active'
    }
];

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

async function runAllTests() {
    // =========================================================================
    // SECTION A: CONFIGURATION VALIDATION
    // =========================================================================
    console.log('--- SECTION A: Configuration Validation ---');
    {
        // A.1 Feature disabled rejected
        const cfgDisabled = {
            enabled: false,
            accessMode: 'allowlist',
            dataDir: VOICE_ACCESS_DIR,
            bootstrapAdminUserId: 'synth_boot_admin'
        };
        const valDisabled = validateBootstrapConfig(cfgDisabled);
        assert.strictEqual(valDisabled.valid, false, 'Feature disabled must be rejected');
        assert.ok(valDisabled.errors.some(e => e.includes('VOICE_SYSTEM_ENABLED must be true')));
        recordPass('A.1 Feature disabled rejected');

        // A.2 Mode missing rejected
        const cfgModeMissing = {
            enabled: true,
            accessMode: '',
            dataDir: VOICE_ACCESS_DIR,
            bootstrapAdminUserId: 'synth_boot_admin'
        };
        const valModeMissing = validateBootstrapConfig(cfgModeMissing);
        assert.strictEqual(valModeMissing.valid, false, 'Mode missing must be rejected');
        assert.ok(valModeMissing.errors.some(e => e.includes('VOICE_SYSTEM_ACCESS_MODE is required')));
        recordPass('A.2 Mode missing rejected');

        // A.3 Audit mode rejected
        const cfgAudit = {
            enabled: true,
            accessMode: 'audit',
            dataDir: VOICE_ACCESS_DIR,
            bootstrapAdminUserId: 'synth_boot_admin'
        };
        const valAudit = validateBootstrapConfig(cfgAudit);
        assert.strictEqual(valAudit.valid, false, 'Audit mode must be rejected');
        assert.ok(valAudit.errors.some(e => e.includes('audit, permissive, and role_only are strictly forbidden')));
        recordPass('A.3 Audit mode rejected');

        // A.4 Permissive mode rejected
        const cfgPermissive = {
            enabled: true,
            accessMode: 'permissive',
            dataDir: VOICE_ACCESS_DIR,
            bootstrapAdminUserId: 'synth_boot_admin'
        };
        const valPermissive = validateBootstrapConfig(cfgPermissive);
        assert.strictEqual(valPermissive.valid, false, 'Permissive mode must be rejected');
        assert.ok(valPermissive.errors.some(e => e.includes('audit, permissive, and role_only are strictly forbidden')));
        recordPass('A.4 Permissive mode rejected');

        // A.5 Bootstrap ID missing rejected
        const cfgBootMissing = {
            enabled: true,
            accessMode: 'allowlist',
            dataDir: VOICE_ACCESS_DIR,
            bootstrapAdminUserId: null
        };
        const valBootMissing = validateBootstrapConfig(cfgBootMissing);
        assert.strictEqual(valBootMissing.valid, false, 'Bootstrap ID missing must be rejected');
        assert.ok(valBootMissing.errors.some(e => e.includes('VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID is required')));
        recordPass('A.5 Bootstrap ID missing rejected');

        // A.6 Data directory missing rejected
        const cfgDataMissing = {
            enabled: true,
            accessMode: 'allowlist',
            dataDir: '',
            bootstrapAdminUserId: 'synth_boot_admin'
        };
        const valDataMissing = validateBootstrapConfig(cfgDataMissing);
        assert.strictEqual(valDataMissing.valid, false, 'Data directory missing must be rejected');
        assert.ok(valDataMissing.errors.some(e => e.includes('VOICE_SYSTEM_ACCESS_DATA_DIR is required')));
        recordPass('A.6 Data directory missing rejected');
    }

    // =========================================================================
    // SECTION B: USER ELIGIBILITY
    // =========================================================================
    console.log('\n--- SECTION B: User Eligibility ---');
    {
        const bootId = 'synth_boot_admin';

        // B.1 User missing rejected
        const valMissing = validateBootstrapUser(null, bootId);
        assert.strictEqual(valMissing.valid, false);
        assert.strictEqual(valMissing.error, 'USER_NOT_FOUND');
        recordPass('B.1 User missing rejected');

        // B.2 User inactive rejected
        const inactiveAdmin = SYNTH_USERS.find(u => u.id === 'synth_inactive_admin');
        const valInactive = validateBootstrapUser(inactiveAdmin, inactiveAdmin.id);
        assert.strictEqual(valInactive.valid, false);
        assert.strictEqual(valInactive.error, 'USER_INACTIVE');
        recordPass('B.2 User inactive rejected');

        // B.3 User suspended rejected
        const suspendedAdmin = SYNTH_USERS.find(u => u.id === 'synth_suspended_admin');
        const valSuspended = validateBootstrapUser(suspendedAdmin, suspendedAdmin.id);
        assert.strictEqual(valSuspended.valid, false);
        assert.strictEqual(valSuspended.error, 'USER_SUSPENDED');
        recordPass('B.3 User suspended rejected');

        // B.4 User deleted rejected
        const deletedAdmin = SYNTH_USERS.find(u => u.id === 'synth_deleted_admin');
        const valDeleted = validateBootstrapUser(deletedAdmin, deletedAdmin.id);
        assert.strictEqual(valDeleted.valid, false);
        assert.strictEqual(valDeleted.error, 'USER_DELETED');
        recordPass('B.4 User deleted rejected');

        // B.5 Regular user bootstrap rejected
        const regularUser = SYNTH_USERS.find(u => u.id === 'synth_regular_user');
        const valRegular = validateBootstrapUser(regularUser, regularUser.id);
        assert.strictEqual(valRegular.valid, false);
        assert.strictEqual(valRegular.error, 'USER_ROLE_INVALID');
        recordPass('B.5 Regular user bootstrap rejected');

        // B.6 Active admin accepted
        const activeAdmin = SYNTH_USERS.find(u => u.id === 'synth_boot_admin');
        const valAdmin = validateBootstrapUser(activeAdmin, activeAdmin.id);
        assert.strictEqual(valAdmin.valid, true);
        recordPass('B.6 Active admin accepted');
    }

    // =========================================================================
    // SECTION C: STORE STATUS & REFUSAL
    // =========================================================================
    console.log('\n--- SECTION C: Store Status & Refusal ---');
    {
        const emptyDir = path.join(TEST_ROOT, 'empty-store');
        fs.mkdirSync(emptyDir, { recursive: true });

        // C.1 Empty store eligible
        const statusEmpty = checkGrantStoreStatus(emptyDir);
        assert.strictEqual(statusEmpty.eligible, true);
        assert.strictEqual(statusEmpty.empty, true);
        recordPass('C.1 Empty store eligible');

        // C.2 Non-empty store rejected
        const nonEmptyDir = path.join(TEST_ROOT, 'non-empty-store');
        fs.mkdirSync(nonEmptyDir, { recursive: true });
        fs.writeFileSync(path.join(nonEmptyDir, GRANTS_FILE_NAME), JSON.stringify([{ id: 'grant_pre_existing' }]));
        const statusNonEmpty = checkGrantStoreStatus(nonEmptyDir);
        assert.strictEqual(statusNonEmpty.eligible, false);
        assert.strictEqual(statusNonEmpty.empty, false);
        assert.strictEqual(statusNonEmpty.error, 'STORE_NOT_EMPTY');
        recordPass('C.2 Non-empty store rejected');

        // C.3 Corrupted store rejected
        const corruptDir = path.join(TEST_ROOT, 'corrupt-store');
        fs.mkdirSync(corruptDir, { recursive: true });
        fs.writeFileSync(path.join(corruptDir, GRANTS_FILE_NAME), '{{{ corrupt json invalid');
        const statusCorrupt = checkGrantStoreStatus(corruptDir);
        assert.strictEqual(statusCorrupt.eligible, false);
        assert.strictEqual(statusCorrupt.corrupted, true);
        assert.strictEqual(statusCorrupt.error, 'STORE_CORRUPTED');
        recordPass('C.3 Corrupted store rejected');

        // C.4 No automatic overwrite (corrupted file remains on disk untouched)
        const contentBefore = fs.readFileSync(path.join(corruptDir, GRANTS_FILE_NAME), 'utf8');
        assert.strictEqual(contentBefore, '{{{ corrupt json invalid');
        recordPass('C.4 Corrupted store not overwritten (fail-closed integrity)');

        // C.5 Second run rejected on populated store
        const envNonEmpty = {
            VOICE_SYSTEM_ENABLED: 'true',
            VOICE_SYSTEM_ACCESS_MODE: 'allowlist',
            VOICE_SYSTEM_ACCESS_DATA_DIR: nonEmptyDir,
            VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: 'synth_boot_admin'
        };
        let secondRunRejected = false;
        try {
            await executeBootstrap({
                env: envNonEmpty,
                users: SYNTH_USERS,
                apply: true,
                silent: true
            });
        } catch (err) {
            if (err.result?.grantStoreEmpty === false) {
                secondRunRejected = true;
            }
        }
        assert.strictEqual(secondRunRejected, true, 'Second bootstrap execution must be refused');
        recordPass('C.5 Second run rejected');
    }

    // =========================================================================
    // SECTION D: DRY-RUN SAFETY
    // =========================================================================
    console.log('\n--- SECTION D: Dry-Run Safety ---');
    {
        const dryRunDir = path.join(TEST_ROOT, 'dry-run-store');
        fs.mkdirSync(dryRunDir, { recursive: true });

        const envDryRun = {
            VOICE_SYSTEM_ENABLED: 'true',
            VOICE_SYSTEM_ACCESS_MODE: 'allowlist',
            VOICE_SYSTEM_ACCESS_DATA_DIR: dryRunDir,
            VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: 'synth_boot_admin'
        };

        const dryRunSummary = await executeBootstrap({
            env: envDryRun,
            users: SYNTH_USERS,
            apply: false,
            silent: true
        });

        // D.1 Creates no grant file
        assert.strictEqual(fs.existsSync(path.join(dryRunDir, GRANTS_FILE_NAME)), false);
        recordPass('D.1 Dry-run creates no grant file');

        // D.2 Creates no history file
        assert.strictEqual(fs.existsSync(path.join(dryRunDir, HISTORY_FILE_NAME)), false);
        recordPass('D.2 Dry-run creates no history file');

        // D.3 Does not modify store
        const filesInDir = fs.readdirSync(dryRunDir);
        assert.strictEqual(filesInDir.length, 0);
        recordPass('D.3 Dry-run does not modify store (0 files written)');

        // D.4 Does not print identifiers
        const outputKeys = Object.keys(dryRunSummary);
        const prohibitedKeywords = ['user', 'admin', 'path', 'dir', 'secret', 'password', 'id', 'name'];
        for (const key of outputKeys) {
            const lowerKey = key.toLowerCase();
            for (const bad of ['userid', 'username', 'datadir', 'password', 'capabilities']) {
                assert.ok(!lowerKey.includes(bad), `Prohibited key leaked in dry-run: ${key}`);
            }
        }
        assert.strictEqual(dryRunSummary.configurationValid, true);
        assert.strictEqual(dryRunSummary.bootstrapEligible, true);
        assert.strictEqual(dryRunSummary.targetUserExists, true);
        assert.strictEqual(dryRunSummary.targetUserActive, true);
        assert.strictEqual(dryRunSummary.grantStoreEmpty, true);
        assert.strictEqual(dryRunSummary.proposedCapabilityCount, 6);
        recordPass('D.4 Dry-run output contains safe metadata only without identifiers');

        // D.5 Reports applyRequired=true
        assert.strictEqual(dryRunSummary.applyRequired, true);
        recordPass('D.5 Dry-run reports applyRequired=true');
    }

    // =========================================================================
    // SECTION E: APPLY AGAINST ISOLATED SYNTHETIC STORE
    // =========================================================================
    console.log('\n--- SECTION E: Apply Against Isolated Synthetic Store ---');
    let bootstrapDir = null;
    let createdGrantRecord = null;
    {
        bootstrapDir = path.join(TEST_ROOT, 'apply-store');
        fs.mkdirSync(bootstrapDir, { recursive: true });

        const envApply = {
            VOICE_SYSTEM_ENABLED: 'true',
            VOICE_SYSTEM_ACCESS_MODE: 'allowlist',
            VOICE_SYSTEM_ACCESS_DATA_DIR: bootstrapDir,
            VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: 'synth_boot_admin'
        };

        // E.1 Explicit --apply required (running without apply triggers dry-run)
        const noApplySummary = await executeBootstrap({
            env: envApply,
            users: SYNTH_USERS,
            apply: false,
            silent: true
        });
        assert.strictEqual(noApplySummary.applyRequired, true);
        assert.strictEqual(fs.existsSync(path.join(bootstrapDir, GRANTS_FILE_NAME)), false);
        recordPass('E.1 Explicit --apply required for creation');

        // Real apply execution
        const applyResult = await executeBootstrap({
            env: envApply,
            users: SYNTH_USERS,
            apply: true,
            silent: true
        });
        assert.strictEqual(applyResult.success, true);
        assert.strictEqual(applyResult.grantCreated, true);
        assert.strictEqual(applyResult.historyRecorded, true);

        // E.2 Creates exactly one grant
        const grantFileContent = JSON.parse(fs.readFileSync(path.join(bootstrapDir, GRANTS_FILE_NAME), 'utf8'));
        assert.strictEqual(grantFileContent.length, 1);
        createdGrantRecord = grantFileContent[0];
        assert.strictEqual(createdGrantRecord.userId, 'synth_boot_admin');
        assert.strictEqual(createdGrantRecord.status, GRANT_STATUS.ACTIVE);
        recordPass('E.2 Creates exactly one grant');

        // E.3 Creates exactly one history record
        const historyFileContent = JSON.parse(fs.readFileSync(path.join(bootstrapDir, HISTORY_FILE_NAME), 'utf8'));
        assert.strictEqual(historyFileContent.length, 1);
        assert.strictEqual(historyFileContent[0].grantId, createdGrantRecord.id);
        recordPass('E.3 Creates exactly one history record');

        // E.4 No download capability by default
        assert.strictEqual(createdGrantRecord.capabilities.includes(VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO), false);
        recordPass('E.4 No download capability in default pilot grant');

        // E.5 No manage_access capability by default
        assert.strictEqual(createdGrantRecord.capabilities.includes(VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS), false);
        recordPass('E.5 No manage_access capability in default pilot grant');

        // E.6 Bootstrap ID alone does not grant access (tested via authorizer without grant)
        const emptyRepo = new VoiceAccessRepository({ dataDir: path.join(TEST_ROOT, 'empty-check') });
        const authorizerNoGrant = new VoiceAccessAuthorizer({ repository: emptyRepo });
        const bootAdminUser = SYNTH_USERS.find(u => u.id === 'synth_boot_admin');
        const checkNoGrant = await authorizerNoGrant.canAccessVoiceSystem(bootAdminUser);
        assert.strictEqual(checkNoGrant.allowed, false);
        recordPass('E.6 Bootstrap ID alone does not grant access');

        // E.7 Normal active grant authorizes access
        const populatedRepo = new VoiceAccessRepository({ dataDir: bootstrapDir });
        const authorizerPopulated = new VoiceAccessAuthorizer({ repository: populatedRepo });
        const checkWithGrant = await authorizerPopulated.authorize(bootAdminUser, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO);
        assert.strictEqual(checkWithGrant.allowed, true);
        recordPass('E.7 Normal active grant authorizes access');

        // E.8 Second apply rejected
        let secondApplyBlocked = false;
        try {
            await executeBootstrap({
                env: envApply,
                users: SYNTH_USERS,
                apply: true,
                silent: true
            });
        } catch (err) {
            secondApplyBlocked = true;
        }
        assert.strictEqual(secondApplyBlocked, true);
        recordPass('E.8 Second apply rejected (grant store not empty)');
    }

    // =========================================================================
    // SECTION F: RUNTIME REGRESSION INTEGRATION
    // =========================================================================
    console.log('\n--- SECTION F: Runtime Regression Integration ---');
    {
        // Setup synthetic call and audio file
        const callId = 'call_bootstrap_runtime_01';
        const relAudioPath = 'private-audio/2026/09/call_bootstrap_runtime_01/audio.wav';
        const fullAudioPath = path.join(TEST_ROOT, relAudioPath);
        fs.mkdirSync(path.dirname(fullAudioPath), { recursive: true });
        fs.writeFileSync(fullAudioPath, Buffer.alloc(1000, 42));

        const callRecord = {
            id: callId,
            clientName: '홍길동',
            callCategory: 'inbound',
            processingStatus: 'intake_validated',
            storagePromotionStatus: 'linked',
            assignedDepartmentId: 'dept_recovery',
            assignedUserId: 'synth_boot_admin',
            storageKey: relAudioPath,
            fileSize: 1000,
            mimeType: 'audio/wav',
            version: 1
        };

        const memoryStore = {
            Users: SYNTH_USERS,
            VoiceCalls: [callRecord],
            Sessions: []
        };
        const getData = (name, def = []) => memoryStore[name] || def;
        const persistData = async (name, data) => { memoryStore[name] = data; return true; };

        const sessionRepo = new SessionRepository(getData, persistData);
        const authService = new AuthService(sessionRepo, () => getData('Users', []));
        const { requireAuth } = createAuthMiddleware(authService);
        const voiceCallRepo = new VoiceCallRepository(getData, persistData);
        const accessService = new PrivateAudioAccessService({ privateAudioRoot: PRIVATE_AUDIO_DIR });
        const auditSink = new AuditEventSink();

        const grantRepo = new VoiceAccessRepository({ dataDir: bootstrapDir });
        const historyRepo = new VoiceAccessHistoryRepository({ dataDir: bootstrapDir });
        const authorizer = new VoiceAccessAuthorizer({ repository: grantRepo, mode: 'allowlist' });
        const service = new VoiceAccessService({
            voiceAccessRepo: grantRepo,
            voiceAccessHistoryRepo: historyRepo,
            voiceAccessAuthorizer: authorizer,
            config: { enabled: true, accessMode: 'allowlist', dataDir: bootstrapDir }
        });

        const app = express();
        app.use(express.json());

        // Legacy non-voice route
        app.get('/api/health', (req, res) => res.json({ status: 'healthy', subsystem: 'core' }));

        const streamingRouter = createAudioStreamingRouter({
            requireAuth,
            voiceCallRepository: voiceCallRepo,
            privateAudioAccessService: accessService,
            auditEventSink: auditSink,
            voiceAccessAuthorizer: authorizer
        });
        app.use('/api/voice-calls', streamingRouter);

        const server = http.createServer(app);
        await new Promise(res => server.listen(0, '127.0.0.1', res));
        const port = server.address().port;

        const cookieBootAdmin = await loginAndGetCookie(authService, 'boot_admin', 'admin_secret');
        const cookieUnlistedAdmin = await loginAndGetCookie(authService, 'unlisted_admin', 'unlisted_admin_secret');

        // F.1 Unlisted admin audio denied (403)
        const resUnlisted = await makeHttpRequest({
            hostname: '127.0.0.1',
            port,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieUnlistedAdmin }
        });
        assert.strictEqual(resUnlisted.statusCode, 403, 'Unlisted admin audio streaming must be denied');
        recordPass('F.1 Unlisted admin audio denied (403)');

        // F.2 Granted pilot user audio allowed (200 / 206)
        const resGranted = await makeHttpRequest({
            hostname: '127.0.0.1',
            port,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieBootAdmin }
        });
        assert.strictEqual(resGranted.statusCode, 200, 'Granted pilot user audio streaming must be allowed');
        recordPass('F.2 Granted pilot user audio allowed (200 OK)');

        // F.3 Grant suspended immediately denied (403)
        const grantToSuspend = await grantRepo.findById(createdGrantRecord.id);
        await grantRepo.saveGrantAtomic({
            ...grantToSuspend,
            status: GRANT_STATUS.SUSPENDED
        }, { expectedVersion: grantToSuspend.version });
        const resSuspended = await makeHttpRequest({
            hostname: '127.0.0.1',
            port,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieBootAdmin }
        });
        assert.strictEqual(resSuspended.statusCode, 403, 'Suspended grant must immediately deny access');
        recordPass('F.3 Grant suspended immediately denied (403)');

        // F.4 Grant revoked immediately denied (403)
        const grantToRevoke = await grantRepo.findById(createdGrantRecord.id);
        await grantRepo.saveGrantAtomic({
            ...grantToRevoke,
            status: GRANT_STATUS.REVOKED
        }, { expectedVersion: grantToRevoke.version });
        const resRevoked = await makeHttpRequest({
            hostname: '127.0.0.1',
            port,
            path: `/api/voice-calls/${callId}/audio`,
            method: 'GET',
            headers: { Cookie: cookieBootAdmin }
        });
        assert.strictEqual(resRevoked.statusCode, 403, 'Revoked grant must immediately deny access');
        recordPass('F.4 Grant revoked immediately denied (403)');

        // F.5 Legacy non-voice route unaffected (200 OK)
        const resHealth = await makeHttpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/api/health',
            method: 'GET'
        });
        assert.strictEqual(resHealth.statusCode, 200, 'Legacy non-voice route must return 200 OK');
        assert.strictEqual(resHealth.json?.status, 'healthy');
        recordPass('F.5 Legacy non-voice route unaffected (200 OK)');

        await new Promise(res => server.close(res));
    }

    console.log('\n================================================================');
    console.log(`🎉 ALL ${passedTests} BOOTSTRAP FOUNDATION TESTS PASSED SUCCESSFULLY!`);
    console.log('================================================================\n');
}

runAllTests().catch(err => {
    console.error('\n❌ BOOTSTRAP FOUNDATION VERIFICATION FAILED:', err);
    process.exit(1);
});

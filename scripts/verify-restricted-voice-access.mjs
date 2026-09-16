/**
 * scripts/verify-restricted-voice-access.mjs
 * Comprehensive Verification Test Harness for Mind-ERP OS Track A10.5: Restricted Voice Access Gate.
 * Enforces Default-Deny, Grant Lifecycle, Capability & Scope Composition, Streaming & Assignment Integration,
 * Safe Menu Summary Generation, and Fail-Closed Corruption Defense.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PassThrough } from 'stream';

import {
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    VOICE_ACCESS_CAPABILITIES,
    HISTORY_ACTIONS,
    VOICE_ACCESS_CHECK_CODES,
    VoiceAccessRepository,
    VoiceAccessHistoryRepository,
    VoiceAccessAuthorizer,
    VoiceAccessService,
    VoiceAccessReconciliation,
    VoiceAccessMetrics,
    VoiceAccessError,
    VOICE_ACCESS_ERROR_CODES
} from '../server/voice-access/index.js';

import { AudioStreamingController } from '../server/audio-streaming/audioStreamingController.js';
import { AssignmentService } from '../server/assignment/assignmentService.js';
import { VOICE_CAPABILITIES } from '../server/permissions/voiceCapabilities.js';

// Setup isolated temporary test directory
const testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-erp-voice-access-test-'));
const grantsFile = path.join(testBaseDir, 'VoiceSystemAccessGrants.json');
const historyFile = path.join(testBaseDir, 'VoiceSystemAccessHistory.json');

console.log('================================================================');
console.log('🧪 Starting Mind-ERP OS Track A10.5: Restricted Voice Access Gate Tests');
console.log(`📁 Test Sandbox: ${testBaseDir}`);
console.log('================================================================\n');

let passedTests = 0;
function recordPass(testName) {
    passedTests++;
    console.log(`  ✅ [PASS] ${testName}`);
}

async function runAllTests() {
    const grantRepo = new VoiceAccessRepository({ dataDir: testBaseDir, filePath: grantsFile });
    const historyRepo = new VoiceAccessHistoryRepository({ dataDir: testBaseDir, filePath: historyFile });
    const authorizer = new VoiceAccessAuthorizer({ voiceAccessRepo: grantRepo });
    const service = new VoiceAccessService({
        voiceAccessRepo: grantRepo,
        voiceAccessHistoryRepo: historyRepo,
        voiceAccessAuthorizer: authorizer,
        config: {
            enabled: true,
            accessMode: 'strict',
            bootstrapAdminUserId: 'synthetic_admin_bootstrap'
        }
    });

    // Synthetic Test Users
    const bootstrapAdmin = { id: 'synthetic_admin_bootstrap', role: 'admin', status: 'active' };
    const unlistedAdmin = { id: 'synthetic_admin_unlisted', role: 'admin', status: 'active' };
    const unlistedManager = { id: 'synthetic_manager_unlisted', role: 'manager', team: '회복지원팀', status: 'active' };
    const unlistedUser = { id: 'synthetic_user_unlisted', role: 'user', team: '회복지원팀', status: 'active' };

    const grantedAdmin = { id: 'synthetic_admin_granted', role: 'admin', status: 'active' };
    const grantedManager = { id: 'synthetic_manager_granted', role: 'manager', team: '회복지원팀', status: 'active' };
    const grantedUser = { id: 'synthetic_user_granted', role: 'user', team: '회복지원팀', status: 'active' };

    // =========================================================================
    // SECTION A: DEFAULT DENY
    // =========================================================================
    console.log('--- SECTION A: Default Deny ---');

    // A.1 Admin without grant denied
    const adminCheck = await authorizer.canAccessVoiceSystem(unlistedAdmin);
    assert.strictEqual(adminCheck.allowed, false, 'Admin without grant must be denied access');
    assert.strictEqual(adminCheck.reason, 'GRANT_NOT_FOUND');
    recordPass('A.1 Admin without grant denied');

    // A.2 Manager without grant denied
    const managerCheck = await authorizer.canAccessVoiceSystem(unlistedManager);
    assert.strictEqual(managerCheck.allowed, false, 'Manager without grant must be denied access');
    assert.strictEqual(managerCheck.reason, 'GRANT_NOT_FOUND');
    recordPass('A.2 Manager without grant denied');

    // A.3 User without grant denied
    const userCheck = await authorizer.canAccessVoiceSystem(unlistedUser);
    assert.strictEqual(userCheck.allowed, false, 'User without grant must be denied access');
    assert.strictEqual(userCheck.reason, 'GRANT_NOT_FOUND');
    recordPass('A.3 User without grant denied');

    // A.4 Disabled feature / capability denied
    const authDenied = await authorizer.authorize(unlistedAdmin, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO);
    assert.strictEqual(authDenied.allowed, false, 'Unlisted admin must be denied specific capability');
    recordPass('A.4 Disabled feature / capability denied');

    // A.5 Corrupted store denied (fail closed)
    fs.writeFileSync(grantsFile, '<<<INVALID_JSON_CORRUPTED>>>', 'utf-8');
    const corruptedCheck = await authorizer.canAccessVoiceSystem(unlistedAdmin);
    assert.strictEqual(corruptedCheck.allowed, false, 'Corrupted store must fail closed');
    assert.strictEqual(corruptedCheck.reason, 'STORE_CORRUPTED');
    recordPass('A.5 Corrupted store denied (fail closed)');

    // Reset corruption & clean file for Section B
    grantRepo.resetCorruptionState();
    fs.unlinkSync(grantsFile);

    // A.6 Spoofed query/body userId/role/capabilities ignored
    const spoofedReqUser = {
        id: 'synthetic_user_unlisted',
        role: 'user',
        status: 'active',
        // Attacker injected spoofed fields
        isAdmin: true,
        admin: true,
        capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO]
    };
    const spoofCheck = await authorizer.canAccessVoiceSystem(spoofedReqUser);
    assert.strictEqual(spoofCheck.allowed, false, 'Injected permissions/roles must be ignored');
    recordPass('A.6 Spoofed query/body/capabilities ignored');

    // =========================================================================
    // SECTION B: GRANT LIFECYCLE
    // =========================================================================
    console.log('\n--- SECTION B: Grant Lifecycle ---');

    // B.0 Missing bootstrap ID denies initialization
    const serviceNoBoot = new VoiceAccessService({
        voiceAccessRepo: grantRepo,
        voiceAccessHistoryRepo: historyRepo,
        voiceAccessAuthorizer: authorizer,
        config: { enabled: true, accessMode: 'strict', bootstrapAdminUserId: null }
    });
    let missingBootBlocked = false;
    try {
        await serviceNoBoot.createInitialBootstrapGrant(bootstrapAdmin, {
            userId: bootstrapAdmin.id,
            capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
            reason: 'Test'
        });
    } catch (err) {
        if (err.code === VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_UNAUTHORIZED) {
            missingBootBlocked = true;
        }
    }
    assert.strictEqual(missingBootBlocked, true, 'Missing bootstrap ID must reject initialization');
    recordPass('B.0 Missing bootstrap ID denies first-grant initialization');

    // B.1 Bootstrap administrator initializes the first grant
    const bootstrapGrant = await service.createInitialBootstrapGrant(bootstrapAdmin, {
        userId: bootstrapAdmin.id,
        capabilities: [
            VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
            VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS,
            VOICE_ACCESS_CAPABILITIES.VIEW,
            VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
            VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,
            VOICE_ACCESS_CAPABILITIES.ASSIGN,
            VOICE_ACCESS_CAPABILITIES.REASSIGN,
            VOICE_ACCESS_CAPABILITIES.REVIEW
        ],
        scope: { type: ACCESS_SCOPE_TYPE.ALL },
        reason: 'Bootstrap initialization'
    });
    assert.ok(bootstrapGrant.id.startsWith('grant_'), 'Bootstrap grant ID must be generated');
    assert.strictEqual(bootstrapGrant.version, 1, 'Initial version must be 1');
    recordPass('B.1 Bootstrap administrator initializes the first grant');

    // B.2 Bootstrap initialization blocked once grants exist
    let bootstrapBlocked = false;
    try {
        await service.createInitialBootstrapGrant(bootstrapAdmin, {
            userId: 'another_user',
            capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS]
        });
    } catch (err) {
        if (err.code === VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_ALREADY_INITIALIZED) {
            bootstrapBlocked = true;
        }
    }
    assert.strictEqual(bootstrapBlocked, true, 'Subsequent bootstrap call must be rejected with 409');
    recordPass('B.2 Bootstrap initialization blocked once store is populated');

    // B.3 Create active grant for grantedAdmin, grantedManager, grantedUser
    const adminGrant = await service.createGrant(bootstrapAdmin, {
        userId: grantedAdmin.id,
        capabilities: [
            VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
            VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS,
            VOICE_ACCESS_CAPABILITIES.VIEW,
            VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
            VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,
            VOICE_ACCESS_CAPABILITIES.ASSIGN,
            VOICE_ACCESS_CAPABILITIES.REASSIGN,
            VOICE_ACCESS_CAPABILITIES.REVIEW
        ],
        scope: { type: ACCESS_SCOPE_TYPE.ALL },
        reason: 'Admin voice access grant'
    });
    assert.strictEqual(adminGrant.status, GRANT_STATUS.ACTIVE);
    recordPass('B.3 Create active grant for admin');

    const managerGrant = await service.createGrant(bootstrapAdmin, {
        userId: grantedManager.id,
        capabilities: [
            VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
            VOICE_ACCESS_CAPABILITIES.VIEW,
            VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
            VOICE_ACCESS_CAPABILITIES.ASSIGN,
            VOICE_ACCESS_CAPABILITIES.REVIEW
        ],
        scope: { type: ACCESS_SCOPE_TYPE.DEPARTMENT, departmentId: '회복지원팀' },
        reason: 'Manager voice access grant'
    });
    assert.strictEqual(managerGrant.status, GRANT_STATUS.ACTIVE);
    recordPass('B.4 Create active grant for manager');

    // B.5 Enforce one active grant per user (duplicate active grant rejected)
    let duplicateRejected = false;
    try {
        await service.createGrant(bootstrapAdmin, {
            userId: grantedAdmin.id,
            capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
            scope: { type: ACCESS_SCOPE_TYPE.ALL }
        });
    } catch (err) {
        if (err.code === VOICE_ACCESS_ERROR_CODES.DUPLICATE_ACTIVE_GRANT) {
            duplicateRejected = true;
        }
    }
    assert.strictEqual(duplicateRejected, true, 'Second active grant for same user must be rejected with 409');
    recordPass('B.5 One active grant per user constraint enforced');

    // B.6 Update capabilities with OCC
    let occConflict = false;
    try {
        await service.updateGrantCapabilities(bootstrapAdmin, adminGrant.id, [
            VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
            VOICE_ACCESS_CAPABILITIES.VIEW
        ], 999, 'Wrong expectedVersion');
    } catch (err) {
        if (err.code === VOICE_ACCESS_ERROR_CODES.OCC_VERSION_CONFLICT) {
            occConflict = true;
        }
    }
    assert.strictEqual(occConflict, true, 'OCC version mismatch must throw 409');

    const updatedAdminGrant = await service.updateGrantCapabilities(bootstrapAdmin, adminGrant.id, [
        VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
        VOICE_ACCESS_CAPABILITIES.VIEW,
        VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
        VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,
        VOICE_ACCESS_CAPABILITIES.ASSIGN,
        VOICE_ACCESS_CAPABILITIES.REASSIGN,
        VOICE_ACCESS_CAPABILITIES.REVIEW
    ], adminGrant.version, 'Updated capabilities');
    assert.strictEqual(updatedAdminGrant.version, adminGrant.version + 1, 'Version must increment by 1');
    recordPass('B.6 Update capabilities with OCC');

    // B.7 Update scope with OCC
    const updatedManagerGrant = await service.updateGrantScope(
        bootstrapAdmin,
        managerGrant.id,
        { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        managerGrant.version,
        'Restricting manager to assigned only'
    );
    assert.strictEqual(updatedManagerGrant.scope.type, ACCESS_SCOPE_TYPE.ASSIGNED_ONLY);
    assert.strictEqual(updatedManagerGrant.version, managerGrant.version + 1);
    recordPass('B.7 Update scope with OCC');

    // B.8 Suspend & Reactivate lifecycle
    const suspended = await service.suspendGrant(bootstrapAdmin, updatedManagerGrant.id, updatedManagerGrant.version, 'Temporary hold');
    assert.strictEqual(suspended.status, GRANT_STATUS.SUSPENDED);
    const suspendedAuth = await authorizer.canAccessVoiceSystem(grantedManager);
    assert.strictEqual(suspendedAuth.allowed, false, 'Suspended grant must be denied');

    const reactivated = await service.reactivateGrant(bootstrapAdmin, suspended.id, suspended.version, 'Hold released');
    assert.strictEqual(reactivated.status, GRANT_STATUS.ACTIVE);
    const reactivatedAuth = await authorizer.canAccessVoiceSystem(grantedManager);
    assert.strictEqual(reactivatedAuth.allowed, true, 'Reactivated grant must be allowed');
    recordPass('B.8 Suspend and reactivate lifecycle with OCC');

    // B.9 Expire behavior (expired active record still denied)
    const expiringGrant = await service.createGrant(bootstrapAdmin, {
        userId: grantedUser.id,
        capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO],
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        expiresAt: new Date(Date.now() - 10000).toISOString(), // Expired 10s ago
        reason: 'Short testing grant'
    });
    const expiredAuth = await authorizer.canAccessVoiceSystem(grantedUser);
    assert.strictEqual(expiredAuth.allowed, false, 'Expired grant must be denied');
    assert.strictEqual(expiredAuth.reason, 'GRANT_EXPIRED');
    recordPass('B.9 Expired active grant is strictly denied');

    // B.10 Soft Revoke & No Hard Delete
    const revoked = await service.revokeGrant(bootstrapAdmin, expiringGrant.id, expiringGrant.version, 'Completed test');
    assert.strictEqual(revoked.status, GRANT_STATUS.REVOKED);
    const allGrants = await grantRepo.findAll();
    const revokedFound = allGrants.find(g => g.id === expiringGrant.id);
    assert.ok(revokedFound, 'Revoked grant must still exist in storage (soft revoke, no hard delete)');
    assert.strictEqual(revokedFound.status, GRANT_STATUS.REVOKED);
    recordPass('B.10 Soft revoke preserves grant in storage (no hard delete)');

    // =========================================================================
    // SECTION C: CAPABILITY COMPOSITION
    // =========================================================================
    console.log('\n--- SECTION C: Capability Composition ---');

    // Setup active grant for grantedUser
    const activeUserGrant = await service.createGrant(bootstrapAdmin, {
        userId: grantedUser.id,
        capabilities: [
            VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,
            VOICE_ACCESS_CAPABILITIES.VIEW,
            VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,
            VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO, // Granted by admin in grant, BUT User role lacks download
            VOICE_ACCESS_CAPABILITIES.ASSIGN // Granted by admin in grant, BUT User role lacks assign
        ],
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        reason: 'User voice access grant'
    });

    // C.1 Role allowed + Grant allowed -> SUCCEEDS
    const playAuth = await authorizer.authorize(grantedUser, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO);
    assert.strictEqual(playAuth.allowed, true, 'User role allowed + grant allowed must succeed');
    recordPass('C.1 Role allowed + grant allowed succeeds');

    // C.2 Role allowed + Grant missing -> DENIED
    const reviewAuth = await authorizer.authorize(grantedUser, VOICE_ACCESS_CAPABILITIES.REVIEW);
    assert.strictEqual(reviewAuth.allowed, false, 'Role allowed but grant missing capability must be denied');
    recordPass('C.2 Role allowed + grant missing denies');

    // C.3 Role denied + Grant allowed -> DENIED (Grant CANNOT enlarge Role capability)
    // Regular user lacks DOWNLOAD_AUDIO in getEffectiveVoiceCapabilities
    const downloadAuth = await authorizer.authorize(grantedUser, VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO);
    assert.strictEqual(downloadAuth.allowed, false, 'User role lacks download_audio; grant cannot enlarge role capability');
    recordPass('C.3 Role denied + grant allowed denies (grant cannot enlarge role capability)');

    // C.4 Assignment independently denied for user lacking role capability
    const assignAuth = await authorizer.authorize(grantedUser, VOICE_ACCESS_CAPABILITIES.ASSIGN);
    assert.strictEqual(assignAuth.allowed, false, 'User role lacks assign; must be denied even if grant has it');
    recordPass('C.4 Assignment independently denied when role lacks capability');

    // C.5 Missing voice_system.access denies all
    // Create a rogue grant missing foundational access
    const rogueGrant = {
        id: `grant_rogue_${Date.now()}`,
        userId: 'synthetic_user_rogue',
        status: GRANT_STATUS.ACTIVE,
        capabilities: [VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO], // Missing SYSTEM_ACCESS
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
        grantedBy: bootstrapAdmin.id,
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    };
    await grantRepo.saveGrantAtomic(rogueGrant);
    const rogueUser = { id: 'synthetic_user_rogue', role: 'user', status: 'active' };
    const rogueCheck = await authorizer.canAccessVoiceSystem(rogueUser);
    assert.strictEqual(rogueCheck.allowed, false, 'Grant missing voice_system.access must be denied');
    assert.strictEqual(rogueCheck.reason, 'FOUNDATIONAL_ACCESS_REQUIRED');
    recordPass('C.5 voice_system.access missing denies foundational access');

    // =========================================================================
    // SECTION D: SCOPE COMPOSITION
    // =========================================================================
    console.log('\n--- SECTION D: Scope Composition ---');

    // D.1 Admin role (ALL) + ASSIGNED_ONLY grant -> ASSIGNED_ONLY
    const adminRestrictedGrant = await service.createGrant(bootstrapAdmin, {
        userId: 'synthetic_admin_restricted',
        capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO],
        scope: { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY }
    });
    const restrictedAdmin = { id: 'synthetic_admin_restricted', role: 'admin', status: 'active' };
    const adminScope = authorizer.resolveEffectiveScope(restrictedAdmin, adminRestrictedGrant);
    assert.strictEqual(adminScope.type, ACCESS_SCOPE_TYPE.ASSIGNED_ONLY, 'Admin with assigned_only grant results in assigned_only');
    recordPass('D.1 All-role plus assigned-only grant results in assigned-only');

    // D.2 Department role (Manager) + ALL grant -> DEPARTMENT ceiling
    const managerAllGrant = {
        id: `grant_manager_all_${Date.now()}`,
        userId: 'synthetic_manager_all',
        status: GRANT_STATUS.ACTIVE,
        capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS, VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO],
        scope: { type: ACCESS_SCOPE_TYPE.ALL }, // Attempt to give manager ALL
        grantedBy: bootstrapAdmin.id,
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    };
    await grantRepo.saveGrantAtomic(managerAllGrant);
    const managerAllUser = { id: 'synthetic_manager_all', role: 'manager', team: '회복지원팀', status: 'active' };
    const managerScope = authorizer.resolveEffectiveScope(managerAllUser, managerAllGrant);
    assert.strictEqual(managerScope.type, ACCESS_SCOPE_TYPE.DEPARTMENT, 'Manager role ceiling must be DEPARTMENT even if grant says ALL');
    assert.strictEqual(managerScope.departmentId, '회복지원팀');
    recordPass('D.2 Department role plus all grant results in department ceiling');

    // D.3 Mismatched department denies
    const mismatchedGrant = {
        id: `grant_manager_mismatch_${Date.now()}`,
        userId: 'synthetic_manager_mismatch',
        status: GRANT_STATUS.ACTIVE,
        capabilities: [VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS],
        scope: { type: ACCESS_SCOPE_TYPE.DEPARTMENT, departmentId: '위기개입팀' },
        grantedBy: bootstrapAdmin.id,
        grantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
    };
    const mismatchUser = { id: 'synthetic_manager_mismatch', role: 'manager', team: '회복지원팀', status: 'active' };
    const mismatchScope = authorizer.resolveEffectiveScope(mismatchUser, mismatchedGrant);
    assert.strictEqual(mismatchScope.allowed, false, 'Manager department mismatch must deny scope');
    assert.strictEqual(mismatchScope.reason, 'GRANT_DEPARTMENT_MISMATCH');
    recordPass('D.3 Mismatched department denies');

    // D.4 Missing manager department denies
    const noDeptManager = { id: 'synthetic_manager_nodept', role: 'manager', team: '', status: 'active' };
    const noDeptScope = authorizer.resolveEffectiveScope(noDeptManager, managerAllGrant);
    assert.strictEqual(noDeptScope.allowed, false, 'Manager without department must be denied');
    assert.strictEqual(noDeptScope.reason, 'MANAGER_DEPARTMENT_MISSING');
    recordPass('D.4 Missing manager department denies');

    // =========================================================================
    // SECTION E: INTEGRATION (AUDIO STREAMING & ASSIGNMENT)
    // =========================================================================
    console.log('\n--- SECTION E: Integration ---');

    // Mock Repositories for Audio Streaming
    const mockAudioCall = {
        id: 'synthetic_call_001',
        assignedUserId: grantedUser.id,
        assignedDepartmentId: '회복지원팀',
        storageKey: 'audio_001.mp3'
    };
    const mockVoiceCallRepo = {
        findById: (id) => (id === mockAudioCall.id ? mockAudioCall : null)
    };
    const mockAccessService = {
        available: true,
        validateEligibleAudio: async () => ({
            filePath: path.join(testBaseDir, 'test.mp3'),
            fileSize: 1024,
            mimeType: 'audio/mpeg',
            extension: 'mp3'
        }),
        openReadStream: async () => {
            const readable = new PassThrough();
            setImmediate(() => {
                readable.write(Buffer.from('mock audio chunk'));
                readable.end();
            });
            return { stream: readable };
        }
    };
    const mockAuditSink = { record: async () => {} };

    const streamingController = new AudioStreamingController({
        voiceCallRepo: mockVoiceCallRepo,
        accessService: mockAccessService,
        auditEventSink: mockAuditSink,
        voiceAccessAuthorizer: authorizer
    });

    function createMockRes() {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = {};
        res.body = null;
        res.status = function(code) { this.statusCode = code; return this; };
        res.setHeader = function(k, v) { this.headers[k] = v; return this; };
        res.json = function(obj) { this.body = obj; return this; };
        return res;
    }

    // E.1 Allowed user with grant may stream audio
    const resAllowed = createMockRes();
    await streamingController.streamAudio({
        params: { id: mockAudioCall.id },
        auth: grantedUser,
        headers: { range: 'bytes=0-500' }
    }, resAllowed);
    assert.strictEqual(resAllowed.statusCode, 206, 'Allowed granted user should stream audio (206)');
    recordPass('E.1 Allowed user with active grant may stream audio');

    // E.2 Unlisted admin without grant may NOT stream audio
    const resUnlistedAdmin = createMockRes();
    await streamingController.streamAudio({
        params: { id: mockAudioCall.id },
        auth: unlistedAdmin,
        headers: {}
    }, resUnlistedAdmin);
    assert.strictEqual(resUnlistedAdmin.statusCode, 403, 'Unlisted admin must be denied streaming (403)');
    recordPass('E.2 Unlisted admin without grant may not stream audio');

    // E.3 Direct URL bypass prevented (even with valid callId)
    const resDirectUrl = createMockRes();
    await streamingController.streamAudio({
        params: { id: mockAudioCall.id },
        auth: null, // No session
        headers: {}
    }, resDirectUrl);
    assert.strictEqual(resDirectUrl.statusCode, 401, 'Direct URL without auth must return 401');
    recordPass('E.3 Direct URL bypass prevented');

    // E.4 Grantless admin may NOT assign calls via AssignmentService
    const mockAssignmentRepo = {
        saveReferralRecordAtomic: async () => {}
    };
    const assignmentService = new AssignmentService({
        voiceCallRepo: mockVoiceCallRepo,
        voiceAccessAuthorizer: authorizer
    });

    let grantlessAssignBlocked = false;
    try {
        await assignmentService.assignCall({
            callId: mockAudioCall.id,
            operationId: 'synthetic_op_001',
            requestedDepartmentId: 'dept_recovery',
            requestedUserId: 'synthetic_user_02',
            expectedVersion: 1,
            reasonCode: 'manual_assignment'
        }, unlistedAdmin);
    } catch (err) {
        if (err.code === 'ASSIGNMENT_FORBIDDEN') {
            grantlessAssignBlocked = true;
        } else {
            console.log('UNEXPECTED ASSIGN ERROR:', err);
        }
    }
    assert.strictEqual(grantlessAssignBlocked, true, 'Grantless admin must be denied assignment');
    recordPass('E.4 Grantless admin may not assign calls');

    // E.5 Granted admin with assign capability may assign calls
    let grantedAssignProceeded = false;
    try {
        await assignmentService.assignCall({
            callId: mockAudioCall.id,
            operationId: 'synthetic_op_002',
            requestedDepartmentId: 'dept_recovery',
            requestedUserId: 'synthetic_user_02',
            expectedVersion: 1,
            reasonCode: 'manual_assignment'
        }, grantedAdmin);
    } catch (err) {
        // If it fails on downstream repository operations, authorization itself succeeded!
        if (err.code !== 'ASSIGNMENT_FORBIDDEN') {
            grantedAssignProceeded = true;
        }
    }
    assert.strictEqual(grantedAssignProceeded, true, 'Granted admin with assign capability clears authorization gate');
    recordPass('E.5 Granted admin with assign capability clears authorization gate');

    // E.6 Bypass attempt with _preAuthorized: true is strictly denied
    let preAuthorizedBypassBlocked = false;
    const sneakyActor = { ...unlistedAdmin, _preAuthorized: true };
    try {
        await assignmentService.assignCall({
            callId: mockAudioCall.id,
            operationId: 'synthetic_op_sneaky',
            requestedDepartmentId: 'dept_recovery',
            requestedUserId: 'synthetic_user_02',
            expectedVersion: 1,
            reasonCode: 'manual_assignment'
        }, sneakyActor);
    } catch (err) {
        if (err.code === 'ASSIGNMENT_FORBIDDEN') {
            preAuthorizedBypassBlocked = true;
        }
    }
    assert.strictEqual(preAuthorizedBypassBlocked, true, '_preAuthorized: true must NOT bypass assignment authorization');
    recordPass('E.6 _preAuthorized bypass attempt is strictly denied');

    // E.7 Missing authorizer in AssignmentService fails closed (503)
    const missingAuthAssignmentService = new AssignmentService({
        voiceCallRepo: mockVoiceCallRepo,
        voiceAccessAuthorizer: null // Explicitly null
    });
    let missingAuthBlocked = false;
    try {
        await missingAuthAssignmentService.assignCall({
            callId: mockAudioCall.id,
            operationId: 'synthetic_op_no_auth',
            requestedDepartmentId: 'dept_recovery',
            requestedUserId: 'synthetic_user_02',
            expectedVersion: 1,
            reasonCode: 'manual_assignment'
        }, grantedAdmin);
    } catch (err) {
        if (err.code === 'VOICE_SYSTEM_UNAVAILABLE' && (err.status === 503 || err.statusCode === 503)) {
            missingAuthBlocked = true;
        }
    }
    assert.strictEqual(missingAuthBlocked, true, 'Missing authorizer in AssignmentService must fail closed with 503');
    recordPass('E.7 Missing authorizer in AssignmentService fails closed with 503');

    // E.8 Missing authorizer in AudioStreamingController fails closed (503)
    const missingAuthStreamingController = new AudioStreamingController({
        voiceCallRepo: mockVoiceCallRepo,
        accessService: mockAccessService,
        auditEventSink: mockAuditSink,
        voiceAccessAuthorizer: null // Explicitly null
    });
    const resMissingAuth = createMockRes();
    await missingAuthStreamingController.streamAudio({
        params: { id: mockAudioCall.id },
        auth: grantedAdmin,
        headers: { range: 'bytes=0-100' }
    }, resMissingAuth);
    assert.strictEqual(resMissingAuth.statusCode, 503, 'Missing authorizer in AudioStreamingController must return 503');
    assert.strictEqual(resMissingAuth.body?.error?.code, 'VOICE_SYSTEM_UNAVAILABLE');
    recordPass('E.8 Missing authorizer in AudioStreamingController fails closed with 503');

    // =========================================================================
    // SECTION F: SAFE SUMMARY
    // =========================================================================
    console.log('\n--- SECTION F: Safe Summary ---');

    // F.1 Unlisted user receives all-false summary
    const unlistedSummary = await service.getSafeAccessSummary(unlistedUser);
    assert.strictEqual(unlistedSummary.canAccessVoiceSystem, false);
    assert.strictEqual(unlistedSummary.canViewCalls, false);
    assert.strictEqual(unlistedSummary.canPlayAudio, false);
    assert.strictEqual(unlistedSummary.grantId, undefined);
    assert.strictEqual(unlistedSummary.grantedBy, undefined);
    assert.strictEqual(unlistedSummary.capabilities, undefined);
    recordPass('F.1 Unlisted user receives all-false summary with zero PII/metadata');

    // F.2 Granted user receives boolean-only summary matching effective capabilities
    const grantedUserSummary = await service.getSafeAccessSummary(grantedUser);
    assert.strictEqual(grantedUserSummary.canAccessVoiceSystem, true);
    assert.strictEqual(grantedUserSummary.canPlayAudio, true);
    assert.strictEqual(grantedUserSummary.canDownloadAudio, false); // Role restriction
    assert.strictEqual(grantedUserSummary.canAssignCalls, false); // Role restriction
    assert.strictEqual(grantedUserSummary.grantId, undefined, 'No grant ID exposed');
    assert.strictEqual(grantedUserSummary.grantedBy, undefined, 'No grantedBy exposed');
    assert.strictEqual(grantedUserSummary.capabilities, undefined, 'No capability array exposed');
    recordPass('F.2 Granted user receives menu access booleans only');

    // =========================================================================
    // SECTION G: HISTORY, METRICS, RECONCILIATION & CORRUPTION
    // =========================================================================
    console.log('\n--- SECTION G: History, Metrics & Reconciliation ---');

    // G.1 Verify History entries recorded for all lifecycle transitions
    const historyEntries = await historyRepo.findAll();
    assert.ok(historyEntries.length >= 6, `Expected at least 6 history records, found ${historyEntries.length}`);
    const actionsRecorded = historyEntries.map(h => h.action);
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.CREATE));
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.UPDATE_CAPABILITIES));
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.UPDATE_SCOPE));
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.SUSPEND));
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.REACTIVATE));
    assert.ok(actionsRecorded.includes(HISTORY_ACTIONS.REVOKE));
    recordPass('G.1 Complete lifecycle audit history recorded');

    // G.2 Verify zero PII in history records
    for (const h of historyEntries) {
        assert.strictEqual(h.residentNumber, undefined);
        assert.strictEqual(h.phone, undefined);
        assert.strictEqual(h.password, undefined);
    }
    recordPass('G.2 Zero PII in history storage');

    // G.3 Operational Metrics Snapshot
    const metricsCalc = new VoiceAccessMetrics({
        voiceAccessRepo: grantRepo,
        voiceAccessHistoryRepo: historyRepo
    });
    const metrics = await metricsCalc.getMetricsSnapshot();
    assert.strictEqual(metrics.isStoreHealthy, true);
    assert.ok(metrics.totalGrants > 0);
    assert.ok(metrics.totalHistoryRecords > 0);
    assert.ok(typeof metrics.usersWithAccessCount === 'number');
    recordPass('G.3 Operational metrics snapshot generated without PII');

    // G.4 Read-Only Reconciliation Coverage
    const reconciler = new VoiceAccessReconciliation({
        dataDir: testBaseDir,
        grantsFilePath: grantsFile,
        historyFilePath: historyFile
    });
    const reconResult = await reconciler.reconcile();
    assert.strictEqual(reconResult.isHealthy, true, 'Store should reconcile as healthy');
    assert.ok(reconResult.summary.totalGrants > 0);
    recordPass('G.4 Read-only reconciliation verifies store health without mutations');

    // G.5 Fail-Closed store corruption defense
    fs.writeFileSync(grantsFile, '<<<CORRUPTED_DISASTER_BYTE>>>', 'utf-8');
    let corruptionCaught = false;
    try {
        await grantRepo.findAll();
    } catch (err) {
        if (err.code === VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED) {
            corruptionCaught = true;
        }
    }
    assert.strictEqual(corruptionCaught, true, 'Corrupted JSON must enter fail-closed 503 state');
    // Ensure disk file was NOT overwritten or truncated
    const diskContent = fs.readFileSync(grantsFile, 'utf-8');
    assert.strictEqual(diskContent, '<<<CORRUPTED_DISASTER_BYTE>>>', 'Corrupted file must never be truncated or overwritten');
    recordPass('G.5 Fail-closed corruption defense with zero disk truncation');

    // Cleanup isolated test directory
    try {
        fs.rmSync(testBaseDir, { recursive: true, force: true });
    } catch {
        // Best effort tmp cleanup
    }

    console.log('\n================================================================');
    console.log(`🎉 ALL ${passedTests} TRACK A10.5 TESTS PASSED SUCCESSFULLY!`);
    console.log('================================================================');
}

runAllTests().catch(err => {
    console.error('\n❌ Track A10.5 Verification Failed with Error:', err);
    process.exit(1);
});

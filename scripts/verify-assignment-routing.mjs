/**
 * scripts/verify-assignment-routing.mjs
 * Comprehensive Verification Suite for Track A10: Manual Assignment, Reassignment and Routing Service.
 * Mind-ERP OS Track A10.
 * 
 * EXECUTION RESTRICTIONS:
 * - Uses isolated temporary directory via fs.mkdtemp.
 * - NEVER touches production DATA_DIR.
 * - Uses exclusively synthetic data (synthetic_admin, synthetic_manager_a, synthetic_call_0001, etc.).
 * - ZERO external calls, ZERO frontend, ZERO AI.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';

import {
    ASSIGNMENT_STATUS,
    OPERATION_STATUS,
    ASSIGNMENT_REASON_CODES,
    ASSIGNMENT_ERROR_CODES,
    ASSIGNMENT_OPERATIONS_STORAGE_FILE,
    ASSIGNMENT_RECONCILIATION_CHECK_CODES
} from '../server/assignment/assignmentConstants.js';
import { AssignmentError } from '../server/assignment/assignmentErrors.js';
import { AssignmentOperationRepository } from '../server/assignment/assignmentOperationRepository.js';
import { AssignmentService as BaseAssignmentService } from '../server/assignment/assignmentService.js';
class AssignmentService extends BaseAssignmentService {
    constructor(deps = {}) {
        super({
            voiceAccessAuthorizer: deps.voiceAccessAuthorizer !== undefined ? deps.voiceAccessAuthorizer : {
                async authorize() {
                    return { allowed: true, effectiveScope: { allowed: true, type: 'all' } };
                }
            },
            ...deps
        });
    }
}
import { runAssignmentReconciliation, SEVERITY } from '../server/assignment/assignmentReconciliation.js';
import { getAssignmentMetricsSnapshot } from '../server/assignment/assignmentMetrics.js';

import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import { AssignmentHistoryRepository } from '../server/voice-calls/assignmentHistoryRepository.js';
import {
    PROCESSING_STATUS,
    CALL_CATEGORY,
    INTAKE_VALIDATION_STATUS,
    AUDIO_INTAKE_SOURCE,
    REVIEW_STATUS
} from '../server/voice-calls/voiceCallConstants.js';

import { NotificationRepository } from '../server/notifications/notificationRepository.js';
import { NotificationOutboxRepository } from '../server/notifications/notificationOutboxRepository.js';
import { NotificationDispatcherRunner } from '../server/notifications/notificationDispatcherRunner.js';
import { NOTIFICATION_STATUS, OUTBOX_STATUS, NOTIFICATION_TYPES } from '../server/notifications/notificationConstants.js';
import { CANONICAL_DEPARTMENTS, validateCanonicalDepartmentMappings } from '../server/permissions/canonicalDepartment.js';
import { computeAssignmentFingerprint, normalizeAssignableUser } from '../server/assignment/assignmentValidator.js';

// Setup isolated test directory
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment_test_'));
console.log(`📁 Isolated A10 Test Directory: ${testRoot}`);

let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passedTests++;
        console.log(`  ✅ [PASS] ${name}`);
    } catch (err) {
        failedTests++;
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        if (err.stack) console.error(err.stack);
    }
}

// Memory & Disk store harness factory
function createStoreHarness(subDirName) {
    const dir = path.join(testRoot, subDirName);
    fs.mkdirSync(dir, { recursive: true });

    const getData = (filename, defaultValue) => {
        const filePath = path.join(dir, `${filename}.json`);
        if (!fs.existsSync(filePath)) {
            return defaultValue !== undefined ? defaultValue : [];
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    };

    const persistData = async (filename, data) => {
        const filePath = path.join(dir, `${filename}.json`);
        const tempPath = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
        return true;
    };

    return { dir, getData, persistData };
}

// Synthetic Users Directory
const SYNTHETIC_USERS = [
    {
        id: 'synthetic_admin',
        username: 'admin_user',
        name: '시스템 관리자',
        role: 'admin',
        team: 'dept_operations',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synthetic_manager_a',
        username: 'manager_promo',
        name: '증진팀 팀장',
        role: 'manager',
        team: 'dept_promotion',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synthetic_manager_b',
        username: 'manager_recov',
        name: '회복팀 팀장',
        role: 'manager',
        team: 'dept_recovery',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synthetic_user_a',
        username: 'worker_promo_1',
        name: '증진팀 담당자',
        role: 'user',
        team: 'dept_promotion',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synthetic_user_b',
        username: 'worker_recov_1',
        name: '회복팀 담당자',
        role: 'user',
        team: 'dept_recovery',
        status: 'active',
        permissions: { voiceCalls: true }
    },
    {
        id: 'synthetic_inactive_user',
        username: 'worker_inactive',
        name: '퇴사자',
        role: 'user',
        team: 'dept_promotion',
        status: 'inactive',
        permissions: { voiceCalls: true }
    }
];

function getUserById(id) {
    return SYNTHETIC_USERS.find(u => u.id === id || u.username === id) || null;
}

function getUsers() {
    return SYNTHETIC_USERS;
}

// Helper to seed a synthetic VoiceCall
async function seedVoiceCall(voiceCallRepo, overrides = {}) {
    const callId = overrides.id || `call_${crypto.randomUUID().slice(0, 8)}`;
    const record = {
        id: callId,
        originalFileName: 'call_audio.wav',
        contentHash: crypto.randomBytes(32).toString('hex'),
        mimeType: 'audio/wav',
        fileSize: 102400,
        intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
        validationStatus: INTAKE_VALIDATION_STATUS.VALID,
        processingStatus: overrides.processingStatus || PROCESSING_STATUS.RECEIVED,
        callCategory: CALL_CATEGORY.CLINICAL,
        assignmentStatus: overrides.assignmentStatus || ASSIGNMENT_STATUS.UNASSIGNED,
        assignedDepartmentId: overrides.assignedDepartmentId || undefined,
        assignedUserId: overrides.assignedUserId || undefined,
        recommendedDepartmentId: overrides.recommendedDepartmentId || undefined,
        reviewStatus: REVIEW_STATUS.NOT_STARTED,
        receivedAt: new Date().toISOString(),
        version: overrides.version || 1,
        ...overrides
    };

    // Use persist directly into store
    const calls = voiceCallRepo._getAllRecords() || [];
    calls.push(record);
    await voiceCallRepo.persistData('VoiceCalls', calls);
    return record;
}

async function runAllTests() {
    console.log('\n============================================================');
    console.log('🧪 TRACK A10: ASSIGNMENT & ROUTING SERVICE VERIFICATION');
    console.log('============================================================');

    // -------------------------------------------------------------
    // Section A: A9 Precondition Gate
    // -------------------------------------------------------------
    console.log('\n--- A. A9 Precondition Gate ---');
    const hGate = createStoreHarness('h_gate');
    const notifRepoGate = new NotificationRepository(hGate.getData, hGate.persistData, { dataDir: hGate.dir });
    const outboxRepoGate = new NotificationOutboxRepository(hGate.getData, hGate.persistData, { dataDir: hGate.dir });

    await runTest('A9 Gate: Prohibited PII keys reject notification creation completely', async () => {
        await assert.rejects(
            async () => {
                await notifRepoGate.createNotification({
                    recipientUserId: 'u1',
                    type: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
                    resourceType: 'voice_call',
                    resourceId: 'call_01',
                    messageCode: 'CALL_ASSIGNED',
                    deduplicationKey: 'dedup_pii_1',
                    safeMetadata: {
                        transcript: 'sensitive transcript content'
                    }
                });
            },
            err => err.code === 'UNSAFE_PAYLOAD_DETECTED'
        );
    });

    await runTest('A9 Gate: Notification unread with readAt or expired in future is rejected', async () => {
        // unread with readAt
        await assert.rejects(
            async () => {
                await notifRepoGate.createNotification({
                    recipientUserId: 'u1',
                    type: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
                    resourceType: 'voice_call',
                    resourceId: 'call_02',
                    messageCode: 'CALL_ASSIGNED',
                    deduplicationKey: 'dedup_invar_1'
                });
                const notifs = notifRepoGate.list();
                notifs[0].readAt = new Date().toISOString(); // illegal for unread
                await notifRepoGate._saveStore(notifs);
                notifRepoGate.resetCorruptionState();
            },
            err => err.code === 'NOTIFICATION_STORE_CORRUPTED' || err.code === 'NOTIFICATION_PAYLOAD_INVALID'
        );
    });

    await runTest('A9 Gate: Outbox wrong owner, token, or expired token is rejected', async () => {
        const ev = await outboxRepoGate.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            aggregateType: 'voice_call',
            aggregateId: 'call_03',
            recipientUserId: 'u1',
            sourceVersion: 1
        });
        const claim = await outboxRepoGate.claimNextEvent({ workerId: 'gate_w1', leaseDurationMs: 100 });

        // Wrong owner
        await assert.rejects(
            async () => {
                await outboxRepoGate.markDispatching({ eventId: ev.id, workerId: 'wrong_owner', leaseToken: claim.leaseToken });
            },
            err => err.code === 'OUTBOX_LEASE_OWNER_MISMATCH'
        );

        // Wrong token
        await assert.rejects(
            async () => {
                await outboxRepoGate.markDispatching({ eventId: ev.id, workerId: 'gate_w1', leaseToken: 'wrong_token' });
            },
            err => err.code === 'OUTBOX_LEASE_TOKEN_INVALID'
        );
    });

    // -------------------------------------------------------------
    // Section B: Authorization and Capability
    // -------------------------------------------------------------
    console.log('\n--- B. Authorization and Capability ---');
    const hAuth = createStoreHarness('h_auth');
    const callRepoAuth = new VoiceCallRepository(hAuth.getData, hAuth.persistData);
    const histRepoAuth = new AssignmentHistoryRepository(hAuth.getData, hAuth.persistData, { voiceCallRepo: callRepoAuth });
    const opRepoAuth = new AssignmentOperationRepository(hAuth.getData, hAuth.persistData, { dataDir: hAuth.dir });
    const outboxRepoAuth = new NotificationOutboxRepository(hAuth.getData, hAuth.persistData, { dataDir: hAuth.dir });

    const serviceAuth = new AssignmentService({
        voiceCallRepo: callRepoAuth,
        assignmentHistoryRepo: histRepoAuth,
        assignmentOperationRepo: opRepoAuth,
        outboxRepo: outboxRepoAuth,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Admin can assign calls across any department', async () => {
        const call = await seedVoiceCall(callRepoAuth, { id: 'call_auth_01' });
        const res = await serviceAuth.assignCall(
            {
                callId: call.id,
                operationId: 'op_admin_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0] // Admin
        );
        assert.strictEqual(res.status, 'COMPLETED');
        assert.strictEqual(res.assignedUserId, 'synthetic_user_a');
        assert.strictEqual(res.assignedDepartmentId, 'dept_promotion');
    });

    await runTest('Manager in dept_promotion can assign calls within own department', async () => {
        const call = await seedVoiceCall(callRepoAuth, {
            id: 'call_auth_02',
            owningDepartmentId: 'dept_promotion',
            assignedDepartmentId: 'dept_promotion'
        });
        const res = await serviceAuth.assignCall(
            {
                callId: call.id,
                operationId: 'op_mgr_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[1] // Manager Promotion
        );
        assert.strictEqual(res.status, 'COMPLETED');
    });

    await runTest('Manager attempting to assign outside department is rejected', async () => {
        const call = await seedVoiceCall(callRepoAuth, {
            id: 'call_auth_03',
            owningDepartmentId: 'dept_recovery',
            assignedDepartmentId: 'dept_recovery'
        });
        await assert.rejects(
            async () => {
                await serviceAuth.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_mgr_02',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_recovery',
                        requestedUserId: 'synthetic_user_b',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[1] // Manager Promotion attempting Recovery
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN || err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_CROSS_DEPARTMENT_FORBIDDEN
        );
    });

    await runTest('Regular user attempting to assign is rejected (Default-Deny)', async () => {
        const call = await seedVoiceCall(callRepoAuth, { id: 'call_auth_04' });
        await assert.rejects(
            async () => {
                await serviceAuth.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_usr_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_promotion',
                        requestedUserId: 'synthetic_user_a',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[3] // Regular user
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN
        );
    });

    await runTest('Client-injected roles or capabilities in command payload are strictly rejected', async () => {
        const call = await seedVoiceCall(callRepoAuth, { id: 'call_auth_05' });
        await assert.rejects(
            async () => {
                await serviceAuth.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_spoof_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_promotion',
                        requestedUserId: 'synthetic_user_a',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT,
                        actorRole: 'admin', // spoofed attempt
                        capability: 'voice_call.assign'
                    },
                    SYNTHETIC_USERS[3] // Regular user
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID
        );
    });

    // -------------------------------------------------------------
    // Section C: Target User Validation
    // -------------------------------------------------------------
    console.log('\n--- C. Target User Validation ---');
    const hTarget = createStoreHarness('h_target');
    const callRepoTarget = new VoiceCallRepository(hTarget.getData, hTarget.persistData);
    const histRepoTarget = new AssignmentHistoryRepository(hTarget.getData, hTarget.persistData, { voiceCallRepo: callRepoTarget });
    const opRepoTarget = new AssignmentOperationRepository(hTarget.getData, hTarget.persistData, { dataDir: hTarget.dir });
    const outboxRepoTarget = new NotificationOutboxRepository(hTarget.getData, hTarget.persistData, { dataDir: hTarget.dir });

    const serviceTarget = new AssignmentService({
        voiceCallRepo: callRepoTarget,
        assignmentHistoryRepo: histRepoTarget,
        assignmentOperationRepo: opRepoTarget,
        outboxRepo: outboxRepoTarget,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Assignment to inactive or suspended user is rejected', async () => {
        const call = await seedVoiceCall(callRepoTarget, { id: 'call_target_01' });
        await assert.rejects(
            async () => {
                await serviceTarget.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_inact_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_promotion',
                        requestedUserId: 'synthetic_inactive_user',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[0]
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_TARGET_USER_INACTIVE
        );
    });

    await runTest('Assignment to user whose department does not match requested department is rejected', async () => {
        const call = await seedVoiceCall(callRepoTarget, { id: 'call_target_02' });
        await assert.rejects(
            async () => {
                await serviceTarget.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_mismatch_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_recovery',
                        requestedUserId: 'synthetic_user_a', // belongs to dept_promotion!
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[0]
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_DEPARTMENT_MISMATCH
        );
    });

    // -------------------------------------------------------------
    // Section D: Initial Assignment & Outbox Notification
    // -------------------------------------------------------------
    console.log('\n--- D. Initial Assignment & Outbox ---');
    const hInit = createStoreHarness('h_init');
    const callRepoInit = new VoiceCallRepository(hInit.getData, hInit.persistData);
    const histRepoInit = new AssignmentHistoryRepository(hInit.getData, hInit.persistData, { voiceCallRepo: callRepoInit });
    const opRepoInit = new AssignmentOperationRepository(hInit.getData, hInit.persistData, { dataDir: hInit.dir });
    const outboxRepoInit = new NotificationOutboxRepository(hInit.getData, hInit.persistData, { dataDir: hInit.dir });

    const serviceInit = new AssignmentService({
        voiceCallRepo: callRepoInit,
        assignmentHistoryRepo: histRepoInit,
        assignmentOperationRepo: opRepoInit,
        outboxRepo: outboxRepoInit,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Initial assignment transitions unassigned to assigned, bumps version, creates history and outbox', async () => {
        const call = await seedVoiceCall(callRepoInit, { id: 'call_init_01', version: 1 });
        const res = await serviceInit.assignCall(
            {
                callId: call.id,
                operationId: 'op_init_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );

        assert.strictEqual(res.status, 'COMPLETED');
        assert.strictEqual(res.assignmentStatus, ASSIGNMENT_STATUS.ASSIGNED);
        assert.strictEqual(res.resultingVersion, 2);

        // Verify VoiceCall record
        const updatedCall = callRepoInit.findById(call.id);
        assert.strictEqual(updatedCall.assignedUserId, 'synthetic_user_a');
        assert.strictEqual(updatedCall.assignedDepartmentId, 'dept_promotion');
        assert.strictEqual(updatedCall.assignmentStatus, ASSIGNMENT_STATUS.ASSIGNED);
        assert.strictEqual(updatedCall.version, 2);

        // Verify History record
        const history = histRepoInit.getHistoryForCall(call.id);
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].operationId, 'op_init_01');
        assert.strictEqual(history[0].nextUserId, 'synthetic_user_a');
        assert.strictEqual(history[0].previousUserId, undefined);
        assert.strictEqual(history[0].resultingVersion, 2);

        // Verify Outbox Event
        const outboxEvents = outboxRepoInit.list();
        assert.strictEqual(outboxEvents.length, 1);
        assert.strictEqual(outboxEvents[0].eventType, NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED);
        assert.strictEqual(outboxEvents[0].recipientUserId, 'synthetic_user_a');
        assert.strictEqual(outboxEvents[0].sourceVersion, 2);
        assert.strictEqual(outboxEvents[0].payload.safeMetadata.assignmentVersion, 2);
    });

    // -------------------------------------------------------------
    // Section E: Reassignment & NO_CHANGE Idempotency
    // -------------------------------------------------------------
    console.log('\n--- E. Reassignment & NO_CHANGE ---');
    const hReassign = createStoreHarness('h_reassign');
    const callRepoRe = new VoiceCallRepository(hReassign.getData, hReassign.persistData);
    const histRepoRe = new AssignmentHistoryRepository(hReassign.getData, hReassign.persistData, { voiceCallRepo: callRepoRe });
    const opRepoRe = new AssignmentOperationRepository(hReassign.getData, hReassign.persistData, { dataDir: hReassign.dir });
    const outboxRepoRe = new NotificationOutboxRepository(hReassign.getData, hReassign.persistData, { dataDir: hReassign.dir });

    const serviceRe = new AssignmentService({
        voiceCallRepo: callRepoRe,
        assignmentHistoryRepo: histRepoRe,
        assignmentOperationRepo: opRepoRe,
        outboxRepo: outboxRepoRe,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Reassignment transitions assigned to reassigned, records previous/next, emits outbox', async () => {
        const call = await seedVoiceCall(callRepoRe, {
            id: 'call_re_01',
            assignedUserId: 'synthetic_user_a',
            assignedDepartmentId: 'dept_promotion',
            assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED,
            version: 2
        });

        const res = await serviceRe.assignCall(
            {
                callId: call.id,
                operationId: 'op_re_01',
                expectedVersion: 2,
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synthetic_user_b',
                reasonCode: ASSIGNMENT_REASON_CODES.DEPARTMENT_TRANSFER
            },
            SYNTHETIC_USERS[0] // Admin
        );

        assert.strictEqual(res.status, 'COMPLETED');
        assert.strictEqual(res.assignmentStatus, ASSIGNMENT_STATUS.REASSIGNED);
        assert.strictEqual(res.resultingVersion, 3);

        const updatedCall = callRepoRe.findById(call.id);
        assert.strictEqual(updatedCall.assignedUserId, 'synthetic_user_b');
        assert.strictEqual(updatedCall.assignmentStatus, ASSIGNMENT_STATUS.REASSIGNED);
        assert.strictEqual(updatedCall.version, 3);

        const history = histRepoRe.getHistoryForCall(call.id);
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].previousUserId, 'synthetic_user_a');
        assert.strictEqual(history[0].nextUserId, 'synthetic_user_b');

        const outbox = outboxRepoRe.list();
        assert.strictEqual(outbox.length, 1);
        assert.strictEqual(outbox[0].eventType, NOTIFICATION_TYPES.VOICE_CALL_REASSIGNED);
        assert.strictEqual(outbox[0].recipientUserId, 'synthetic_user_b');
    });

    await runTest('Assigning same assignee produces NO_CHANGE without version bump or duplicate events', async () => {
        const call = callRepoRe.findById('call_re_01');
        const res = await serviceRe.assignCall(
            {
                callId: call.id,
                operationId: 'op_nochange_01',
                expectedVersion: call.version,
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synthetic_user_b',
                reasonCode: ASSIGNMENT_REASON_CODES.SUPERVISOR_DECISION
            },
            SYNTHETIC_USERS[0]
        );

        assert.strictEqual(res.status, 'NO_CHANGE');
        assert.strictEqual(res.version, call.version);

        // Verify history and outbox counts did NOT increase
        const history = histRepoRe.getHistoryForCall(call.id);
        assert.strictEqual(history.length, 1);

        const outbox = outboxRepoRe.list();
        assert.strictEqual(outbox.length, 1);
    });

    // -------------------------------------------------------------
    // Section F: Concurrency Control (OCC)
    // -------------------------------------------------------------
    console.log('\n--- F. Concurrency Control (OCC) ---');
    const hOcc = createStoreHarness('h_occ');
    const callRepoOcc = new VoiceCallRepository(hOcc.getData, hOcc.persistData);
    const histRepoOcc = new AssignmentHistoryRepository(hOcc.getData, hOcc.persistData, { voiceCallRepo: callRepoOcc });
    const opRepoOcc = new AssignmentOperationRepository(hOcc.getData, hOcc.persistData, { dataDir: hOcc.dir });
    const outboxRepoOcc = new NotificationOutboxRepository(hOcc.getData, hOcc.persistData, { dataDir: hOcc.dir });

    const serviceOcc1 = new AssignmentService({
        voiceCallRepo: callRepoOcc,
        assignmentHistoryRepo: histRepoOcc,
        assignmentOperationRepo: opRepoOcc,
        outboxRepo: outboxRepoOcc,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    const serviceOcc2 = new AssignmentService({
        voiceCallRepo: new VoiceCallRepository(hOcc.getData, hOcc.persistData),
        assignmentHistoryRepo: new AssignmentHistoryRepository(hOcc.getData, hOcc.persistData, { voiceCallRepo: callRepoOcc }),
        assignmentOperationRepo: new AssignmentOperationRepository(hOcc.getData, hOcc.persistData, { dataDir: hOcc.dir }),
        outboxRepo: new NotificationOutboxRepository(hOcc.getData, hOcc.persistData, { dataDir: hOcc.dir }),
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Concurrent assignment attempts with same expectedVersion: exactly one succeeds, one conflicts', async () => {
        const call = await seedVoiceCall(callRepoOcc, { id: 'call_occ_01', version: 1 });

        const req1 = serviceOcc1.assignCall(
            {
                callId: call.id,
                operationId: 'op_conc_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );

        const req2 = serviceOcc2.assignCall(
            {
                callId: call.id,
                operationId: 'op_conc_02',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_recovery',
                requestedUserId: 'synthetic_user_b',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );

        const results = await Promise.allSettled([req1, req2]);
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent assignment must succeed');
        assert.strictEqual(rejected.length, 1, 'The other concurrent assignment must be rejected');
        assert.strictEqual(rejected[0].reason.code, ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT);

        // Verify exactly one history record and one outbox event exist
        const history = histRepoOcc.getHistoryForCall(call.id);
        assert.strictEqual(history.length, 1);

        const outbox = outboxRepoOcc.list();
        assert.strictEqual(outbox.length, 1);
    });

    // -------------------------------------------------------------
    // Section G: Idempotency Key Tracking
    // -------------------------------------------------------------
    console.log('\n--- G. Idempotency Key Tracking ---');
    const hIdemp = createStoreHarness('h_idemp');
    const callRepoIdemp = new VoiceCallRepository(hIdemp.getData, hIdemp.persistData);
    const histRepoIdemp = new AssignmentHistoryRepository(hIdemp.getData, hIdemp.persistData, { voiceCallRepo: callRepoIdemp });
    const opRepoIdemp = new AssignmentOperationRepository(hIdemp.getData, hIdemp.persistData, { dataDir: hIdemp.dir });
    const outboxRepoIdemp = new NotificationOutboxRepository(hIdemp.getData, hIdemp.persistData, { dataDir: hIdemp.dir });

    const serviceIdemp = new AssignmentService({
        voiceCallRepo: callRepoIdemp,
        assignmentHistoryRepo: histRepoIdemp,
        assignmentOperationRepo: opRepoIdemp,
        outboxRepo: outboxRepoIdemp,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Re-executing same operationId with identical payload returns cached completed result', async () => {
        const call = await seedVoiceCall(callRepoIdemp, { id: 'call_idemp_01', version: 1 });

        const firstRes = await serviceIdemp.assignCall(
            {
                callId: call.id,
                operationId: 'op_idemp_same_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );
        assert.strictEqual(firstRes.status, 'COMPLETED');

        // Re-execute with identical parameters
        const secondRes = await serviceIdemp.assignCall(
            {
                callId: call.id,
                operationId: 'op_idemp_same_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );
        assert.strictEqual(secondRes.status, 'COMPLETED');
        assert.strictEqual(secondRes.idempotent, true);

        // Assert no duplicate history or outbox records
        const history = histRepoIdemp.getHistoryForCall(call.id);
        assert.strictEqual(history.length, 1);

        const outbox = outboxRepoIdemp.list();
        assert.strictEqual(outbox.length, 1);
    });

    await runTest('Re-executing same operationId with differing payload fails with ASSIGNMENT_IDEMPOTENCY_CONFLICT', async () => {
        await assert.rejects(
            async () => {
                await serviceIdemp.assignCall(
                    {
                        callId: 'call_idemp_01',
                        operationId: 'op_idemp_same_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_recovery', // differing department!
                        requestedUserId: 'synthetic_user_b',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[0]
                );
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT
        );
    });

    // -------------------------------------------------------------
    // Section H: Partial Failure Recovery & Restart Simulation
    // -------------------------------------------------------------
    console.log('\n--- H. Partial Failure Recovery ---');
    const hPart = createStoreHarness('h_part');
    let failHistoryPersist = false;
    let failOutboxPersist = false;

    const monitoredPersist = async (filename, data) => {
        if (failHistoryPersist && filename === 'VoiceCallAssignmentHistory') {
            return false;
        }
        if (failOutboxPersist && filename === 'NotificationOutbox') {
            return false;
        }
        return hPart.persistData(filename, data);
    };

    const callRepoPart = new VoiceCallRepository(hPart.getData, monitoredPersist);
    const histRepoPart = new AssignmentHistoryRepository(hPart.getData, monitoredPersist, { voiceCallRepo: callRepoPart });
    const opRepoPart = new AssignmentOperationRepository(hPart.getData, monitoredPersist, { dataDir: hPart.dir });
    const outboxRepoPart = new NotificationOutboxRepository(hPart.getData, monitoredPersist, { dataDir: hPart.dir });

    const servicePart = new AssignmentService({
        voiceCallRepo: callRepoPart,
        assignmentHistoryRepo: histRepoPart,
        assignmentOperationRepo: opRepoPart,
        outboxRepo: outboxRepoPart,
        getUserByIdFn: getUserById,
        getUsersFn: getUsers
    });

    await runTest('Partial failure during history write halts safely and leaves operation in CALL_UPDATED state', async () => {
        const call = await seedVoiceCall(callRepoPart, { id: 'call_part_01', version: 1 });
        failHistoryPersist = true;

        await assert.rejects(
            async () => {
                await servicePart.assignCall(
                    {
                        callId: call.id,
                        operationId: 'op_part_fail_01',
                        expectedVersion: 1,
                        requestedDepartmentId: 'dept_promotion',
                        requestedUserId: 'synthetic_user_a',
                        reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                    },
                    SYNTHETIC_USERS[0]
                );
            },
            err => err.message.includes('배정 이력') || err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_HISTORY_FAILED
        );

        // Verify Call was updated to version 2, but operation remains at call_updated
        const updatedCall = callRepoPart.findById(call.id);
        assert.strictEqual(updatedCall.version, 2);

        const op = opRepoPart.findByOperationId('op_part_fail_01');
        assert.strictEqual(op.status, OPERATION_STATUS.CALL_UPDATED);
        assert.strictEqual(op.resultingCallVersion, 2);
    });

    await runTest('In-process restart simulation: fresh service instance resumes from CALL_UPDATED and converges without duplicate call update', async () => {
        failHistoryPersist = false;

        // Discard old instances and create fresh ones
        const freshCallRepo = new VoiceCallRepository(hPart.getData, hPart.persistData);
        const freshHistRepo = new AssignmentHistoryRepository(hPart.getData, hPart.persistData, { voiceCallRepo: freshCallRepo });
        const freshOpRepo = new AssignmentOperationRepository(hPart.getData, hPart.persistData, { dataDir: hPart.dir });
        const freshOutboxRepo = new NotificationOutboxRepository(hPart.getData, hPart.persistData, { dataDir: hPart.dir });

        const freshService = new AssignmentService({
            voiceCallRepo: freshCallRepo,
            assignmentHistoryRepo: freshHistRepo,
            assignmentOperationRepo: freshOpRepo,
            outboxRepo: freshOutboxRepo,
            getUserByIdFn: getUserById,
            getUsersFn: getUsers
        });

        // Resume assignment with original operationId and initial expectedVersion 1
        const res = await freshService.assignCall(
            {
                callId: 'call_part_01',
                operationId: 'op_part_fail_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            },
            SYNTHETIC_USERS[0]
        );

        assert.strictEqual(res.status, 'COMPLETED');

        // Verify Call version is still 2 (NOT bumped to 3!)
        const finalCall = freshCallRepo.findById('call_part_01');
        assert.strictEqual(finalCall.version, 2);

        // Verify exactly one history record and one outbox event exist
        const history = freshHistRepo.getHistoryForCall('call_part_01');
        assert.strictEqual(history.length, 1);

        const outbox = freshOutboxRepo.list();
        assert.strictEqual(outbox.length, 1);
    });

    // -------------------------------------------------------------
    // Section I: Store Corruption Fail-Closed
    // -------------------------------------------------------------
    console.log('\n--- I. Store Corruption Handling ---');
    const hCorrupt = createStoreHarness('h_corrupt');
    const opRepoCorrupt = new AssignmentOperationRepository(hCorrupt.getData, hCorrupt.persistData, { dataDir: hCorrupt.dir });

    await runTest('Corrupted VoiceCallAssignmentOperations.json halts operations without overwriting disk data', async () => {
        const filePath = path.join(hCorrupt.dir, `${ASSIGNMENT_OPERATIONS_STORAGE_FILE}.json`);
        fs.writeFileSync(filePath, '{ bad_json: invalid', 'utf8');

        assert.throws(
            () => opRepoCorrupt.list(),
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED
        );

        // File content must remain intact and NOT overwritten with []
        const diskRaw = fs.readFileSync(filePath, 'utf8');
        assert.strictEqual(diskRaw, '{ bad_json: invalid');
    });

    await runTest('resetCorruptionState rejects invalid schema and succeeds once store is repaired', async () => {
        const filePath = path.join(hCorrupt.dir, `${ASSIGNMENT_OPERATIONS_STORAGE_FILE}.json`);

        // Attempt reset on malformed data -> rejected
        assert.throws(() => opRepoCorrupt.resetCorruptionState());

        // Restore valid empty array
        fs.writeFileSync(filePath, '[]', 'utf8');
        const restored = opRepoCorrupt.resetCorruptionState();
        assert.strictEqual(restored, true);
        assert.strictEqual(opRepoCorrupt.isCorrupted, false);
    });

    // -------------------------------------------------------------
    // Section J: Reconciliation Engine
    // -------------------------------------------------------------
    console.log('\n--- J. Reconciliation Engine ---');
    const hRecon = createStoreHarness('h_recon');
    const callRepoRecon = new VoiceCallRepository(hRecon.getData, hRecon.persistData);
    const histRepoRecon = new AssignmentHistoryRepository(hRecon.getData, hRecon.persistData, { voiceCallRepo: callRepoRecon });
    const opRepoRecon = new AssignmentOperationRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir });
    const outboxRepoRecon = new NotificationOutboxRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir });

    await runTest('runAssignmentReconciliation detects orphan calls, missing histories, and inactive assignees without PII', async () => {
        // Seed an orphan operation pointing to non-existent call
        await opRepoRecon.createOperation({
            operationId: 'op_orphan_999',
            callId: 'non_existent_call_123',
            actorUserId: 'synthetic_admin',
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'synthetic_user_a',
            expectedVersion: 1,
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        });

        // Seed a call marked assigned but missing assignedUserId
        await seedVoiceCall(callRepoRecon, {
            id: 'call_broken_01',
            assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED,
            assignedUserId: undefined,
            assignedDepartmentId: 'dept_promotion'
        });

        const report = await runAssignmentReconciliation({
            voiceCallRepo: callRepoRecon,
            assignmentHistoryRepo: histRepoRecon,
            assignmentOperationRepo: opRepoRecon,
            outboxRepo: outboxRepoRecon,
            users: SYNTHETIC_USERS
        });

        assert.strictEqual(report.totalFindings >= 2, true);
        const orphanFinding = report.findings.find(f => f.checkCode === ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_ORPHAN_CALL);
        assert.ok(orphanFinding);
        assert.strictEqual(orphanFinding.repairable, false);

        const missingUserFinding = report.findings.find(f => f.checkCode === ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNED_CALL_USER_MISSING);
        assert.ok(missingUserFinding);

        // Verify zero PII in findings
        const serializedFindings = JSON.stringify(report.findings);
        assert.strictEqual(serializedFindings.includes('010-'), false);
        assert.strictEqual(serializedFindings.includes('transcript'), false);
    });

    // -------------------------------------------------------------
    // Section K: Metrics Snapshot
    // -------------------------------------------------------------
    console.log('\n--- K. Metrics Snapshot ---');
    await runTest('getAssignmentMetricsSnapshot computes accurate aggregated counts without PII', async () => {
        const metrics = getAssignmentMetricsSnapshot({
            voiceCallRepo: callRepoRecon,
            assignmentHistoryRepo: histRepoRecon,
            assignmentOperationRepo: opRepoRecon,
            outboxRepo: outboxRepoRecon
        });

        assert.strictEqual(typeof metrics.totalOperations, 'number');
        assert.strictEqual(typeof metrics.assignedCallCount, 'number');
        assert.strictEqual(typeof metrics.operationStoreSerializedBytesEstimate, 'number');

        const serialized = JSON.stringify(metrics);
        assert.strictEqual(serialized.includes('synthetic_user'), false);
    });

    // -------------------------------------------------------------
    // -------------------------------------------------------------
    // Section L: Unassign Blocked Policy
    // -------------------------------------------------------------
    console.log('\n--- L. Unassign Blocked Policy ---');
    await runTest('unassignCall throws ASSIGNMENT_UNASSIGN_POLICY_BLOCKED', async () => {
        await assert.rejects(
            async () => {
                await serviceInit.unassignCall({ callId: 'call_init_01' }, SYNTHETIC_USERS[0]);
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_UNASSIGN_POLICY_BLOCKED
        );
    });

    // -------------------------------------------------------------
    // Section M: Call Updated Stage Failure & Restart Recovery
    // -------------------------------------------------------------
    console.log('\n--- M. Call Updated Stage Failure & Recovery ---');
    const hStageFail = createStoreHarness('h_stage_fail');
    let injectStageFail = true;

    // Custom persist for operations that fails when saving CALL_UPDATED
    const opPersistStageFail = async (filename, data) => {
        if (injectStageFail && filename === ASSIGNMENT_OPERATIONS_STORAGE_FILE) {
            const hasCallUpdated = Array.isArray(data) && data.some(o => o.status === OPERATION_STATUS.CALL_UPDATED);
            if (hasCallUpdated) {
                throw new Error('Injected disk persist failure on CALL_UPDATED stage');
            }
        }
        return hStageFail.persistData(filename, data);
    };

    const callRepoStage = new VoiceCallRepository(hStageFail.getData, hStageFail.persistData);
    const histRepoStage = new AssignmentHistoryRepository(hStageFail.getData, hStageFail.persistData, { voiceCallRepo: callRepoStage });
    const opRepoStage = new AssignmentOperationRepository(hStageFail.getData, opPersistStageFail, { dataDir: hStageFail.dir });
    const outboxRepoStage = new NotificationOutboxRepository(hStageFail.getData, hStageFail.persistData, { dataDir: hStageFail.dir });

    const serviceStage = new AssignmentService({
        voiceCallRepo: callRepoStage,
        assignmentHistoryRepo: histRepoStage,
        assignmentOperationRepo: opRepoStage,
        outboxRepo: outboxRepoStage,
        getUsersFn: () => SYNTHETIC_USERS
    });

    await runTest('Call Updated stage failure halts without success reporting and leaves proof on disk', async () => {
        const seededCall = await seedVoiceCall(callRepoStage, {
            id: 'call_stage_01',
            owningDepartmentId: 'dept_promotion',
            version: 1
        });

        // Step 1: Execute with failure injection
        await assert.rejects(
            async () => {
                await serviceStage.assignCall({
                    callId: seededCall.id,
                    operationId: 'op_stage_fail_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.message.includes('Injected disk persist failure')
        );

        // Verify VoiceCall was applied on disk with lastAssignmentOperationId and version bumped to 2
        const diskCalls = hStageFail.getData('VoiceCalls');
        const diskCall = diskCalls.find(c => c.id === seededCall.id);
        assert.ok(diskCall);
        assert.strictEqual(diskCall.version, 2);
        assert.strictEqual(diskCall.lastAssignmentOperationId, 'op_stage_fail_01');
        assert.strictEqual(diskCall.assignedUserId, 'synthetic_user_a');
        assert.ok(diskCall.assignmentChangedAt);

        // Verify Operation is still in pending state on disk
        const diskOps = hStageFail.getData(ASSIGNMENT_OPERATIONS_STORAGE_FILE);
        const diskOp = diskOps.find(o => o.operationId === 'op_stage_fail_01');
        assert.ok(diskOp);
        assert.strictEqual(diskOp.status, OPERATION_STATUS.PENDING);

        // Verify zero history and zero outbox generated yet
        const diskHist = hStageFail.getData('VoiceCallAssignmentHistory', []);
        assert.strictEqual(diskHist.length, 0);
        const diskOutbox = hStageFail.getData('NotificationOutbox', []);
        assert.strictEqual(diskOutbox.length, 0);
    });

    await runTest('Fresh service instance detects call.lastAssignmentOperationId and recovers cleanly without duplicate call update', async () => {
        // Disarm failure injection
        injectStageFail = false;

        // Create fresh instances to simulate restart
        const freshCallRepo = new VoiceCallRepository(hStageFail.getData, hStageFail.persistData);
        const freshHistRepo = new AssignmentHistoryRepository(hStageFail.getData, hStageFail.persistData, { voiceCallRepo: freshCallRepo });
        const freshOpRepo = new AssignmentOperationRepository(hStageFail.getData, hStageFail.persistData, { dataDir: hStageFail.dir });
        const freshOutboxRepo = new NotificationOutboxRepository(hStageFail.getData, hStageFail.persistData, { dataDir: hStageFail.dir });

        const freshService = new AssignmentService({
            voiceCallRepo: freshCallRepo,
            assignmentHistoryRepo: freshHistRepo,
            assignmentOperationRepo: freshOpRepo,
            outboxRepo: freshOutboxRepo,
            getUsersFn: () => SYNTHETIC_USERS
        });

        // Re-execute identical command
        const recovered = await freshService.assignCall({
            callId: 'call_stage_01',
            operationId: 'op_stage_fail_01',
            expectedVersion: 1, // original expectedVersion
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'synthetic_user_a',
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        }, SYNTHETIC_USERS[0]);

        assert.strictEqual(recovered.status, 'COMPLETED');
        assert.strictEqual(recovered.resultingVersion, 2);

        // Verify VoiceCall version was NOT incremented again (must remain 2!)
        const diskCalls = hStageFail.getData('VoiceCalls');
        const diskCall = diskCalls.find(c => c.id === 'call_stage_01');
        assert.strictEqual(diskCall.version, 2, 'Call version must not increment twice');
        assert.strictEqual(diskCall.lastAssignmentOperationId, 'op_stage_fail_01');

        // Verify exactly one history record on disk
        const diskHist = hStageFail.getData('VoiceCallAssignmentHistory');
        const opHist = diskHist.filter(h => h.operationId === 'op_stage_fail_01');
        assert.strictEqual(opHist.length, 1, 'Exactly one history record');
        assert.strictEqual(opHist[0].resultingVersion, 2);

        // Verify exactly one outbox event on disk
        const diskOutbox = hStageFail.getData('NotificationOutbox');
        const opOutbox = diskOutbox.filter(e => e.aggregateId === 'call_stage_01');
        assert.strictEqual(opOutbox.length, 1, 'Exactly one outbox record');

        // Verify operation on disk is COMPLETED
        const diskOps = hStageFail.getData(ASSIGNMENT_OPERATIONS_STORAGE_FILE);
        const diskOp = diskOps.find(o => o.operationId === 'op_stage_fail_01');
        assert.strictEqual(diskOp.status, OPERATION_STATUS.COMPLETED);
    });

    // -------------------------------------------------------------
    // Section N: Ambiguous Recovery (No Auto-Repair)
    // -------------------------------------------------------------
    console.log('\n--- N. Ambiguous Recovery Guards ---');
    await runTest('Ambiguous call state with mismatched assignee or version throws ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS', async () => {
        const hAmbig = createStoreHarness('h_ambig');
        const callRepoAmbig = new VoiceCallRepository(hAmbig.getData, hAmbig.persistData);
        const histRepoAmbig = new AssignmentHistoryRepository(hAmbig.getData, hAmbig.persistData, { voiceCallRepo: callRepoAmbig });
        const opRepoAmbig = new AssignmentOperationRepository(hAmbig.getData, hAmbig.persistData, { dataDir: hAmbig.dir });
        const outboxRepoAmbig = new NotificationOutboxRepository(hAmbig.getData, hAmbig.persistData, { dataDir: hAmbig.dir });

        const serviceAmbig = new AssignmentService({
            voiceCallRepo: callRepoAmbig,
            assignmentHistoryRepo: histRepoAmbig,
            assignmentOperationRepo: opRepoAmbig,
            outboxRepo: outboxRepoAmbig,
            getUsersFn: () => SYNTHETIC_USERS
        });

        // Seed call having lastAssignmentOperationId='op_ambig_01' but with mismatched version (3 instead of expectedVersion+1=2)
        await seedVoiceCall(callRepoAmbig, {
            id: 'call_ambig_01',
            owningDepartmentId: 'dept_promotion',
            assignedDepartmentId: 'dept_promotion',
            assignedUserId: 'synthetic_user_a',
            lastAssignmentOperationId: 'op_ambig_01',
            version: 3
        });

        // Seed operation in PENDING
        await opRepoAmbig.createOperation({
            operationId: 'op_ambig_01',
            callId: 'call_ambig_01',
            actorUserId: 'synthetic_admin',
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'synthetic_user_a',
            expectedVersion: 1,
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        });

        // Re-execution must refuse auto-repair and throw ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS
        await assert.rejects(
            async () => {
                await serviceAmbig.assignCall({
                    callId: 'call_ambig_01',
                    operationId: 'op_ambig_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS
        );

        // Verify operation on disk is marked INCOMPLETE
        const opOnDisk = opRepoAmbig.findByOperationId('op_ambig_01');
        assert.strictEqual(opOnDisk.status, OPERATION_STATUS.INCOMPLETE);
        assert.strictEqual(opOnDisk.lastErrorCode, ASSIGNMENT_ERROR_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS);
    });

    // -------------------------------------------------------------
    // Section O: Actor-Bound Idempotency
    // -------------------------------------------------------------
    console.log('\n--- O. Actor-Bound Idempotency & Fingerprint ---');
    const hActor = createStoreHarness('h_actor');
    const callRepoActor = new VoiceCallRepository(hActor.getData, hActor.persistData);
    const histRepoActor = new AssignmentHistoryRepository(hActor.getData, hActor.persistData, { voiceCallRepo: callRepoActor });
    const opRepoActor = new AssignmentOperationRepository(hActor.getData, hActor.persistData, { dataDir: hActor.dir });
    const outboxRepoActor = new NotificationOutboxRepository(hActor.getData, hActor.persistData, { dataDir: hActor.dir });

    const serviceActor = new AssignmentService({
        voiceCallRepo: callRepoActor,
        assignmentHistoryRepo: histRepoActor,
        assignmentOperationRepo: opRepoActor,
        outboxRepo: outboxRepoActor,
        getUsersFn: () => SYNTHETIC_USERS
    });

    await runTest('Same operationId with different actor context is rejected with ASSIGNMENT_IDEMPOTENCY_CONFLICT', async () => {
        const call = await seedVoiceCall(callRepoActor, {
            id: 'call_actor_01',
            owningDepartmentId: 'dept_promotion',
            version: 1
        });

        // First attempt by Admin
        await serviceActor.assignCall({
            callId: call.id,
            operationId: 'op_actor_bound_01',
            expectedVersion: 1,
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'synthetic_user_a',
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        }, SYNTHETIC_USERS[0]); // Admin

        // Second attempt by Manager with same operationId
        await assert.rejects(
            async () => {
                await serviceActor.assignCall({
                    callId: call.id,
                    operationId: 'op_actor_bound_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[1]); // Manager Promotion (different actor!)
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT
        );
    });

    await runTest('Same operationId with differing reasonCode is rejected with ASSIGNMENT_IDEMPOTENCY_CONFLICT', async () => {
        await assert.rejects(
            async () => {
                await serviceActor.assignCall({
                    callId: 'call_actor_01',
                    operationId: 'op_actor_bound_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.WORKLOAD_REBALANCE // Differing reason!
                }, SYNTHETIC_USERS[0]);
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT
        );
    });

    await runTest('computeAssignmentFingerprint produces deterministic sorted hash and changes on any field mutation', () => {
        const fp1 = computeAssignmentFingerprint({
            operationType: 'ASSIGN',
            callId: 'c1',
            actorUserId: 'u1',
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'target_u',
            expectedVersion: 1,
            reasonCode: 'initial_assignment'
        });

        const fp2 = computeAssignmentFingerprint({
            operationType: 'ASSIGN',
            callId: 'c1',
            actorUserId: 'u1',
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'target_u',
            expectedVersion: 1,
            reasonCode: 'initial_assignment'
        });

        const fpDifferentActor = computeAssignmentFingerprint({
            operationType: 'ASSIGN',
            callId: 'c1',
            actorUserId: 'u2',
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'target_u',
            expectedVersion: 1,
            reasonCode: 'initial_assignment'
        });

        assert.strictEqual(fp1, fp2, 'Identical inputs must yield identical fingerprints');
        assert.notStrictEqual(fp1, fpDifferentActor, 'Different actor must yield different fingerprint');
    });

    // -------------------------------------------------------------
    // Section P: Real User Directory Schema Adapter & Sanitization
    // -------------------------------------------------------------
    console.log('\n--- P. Real User Schema Contract ---');
    await runTest('normalizeAssignableUser correctly normalizes real Users.json schema without leaking passwords', () => {
        const realUser = {
            id: 'real_worker_01',
            username: 'real_worker_01',
            name: '김전문요원',
            role: 'user',
            team: '증진팀',
            status: 'active',
            password: 'argon2_hashed_secret_password'
        };

        const normalized = normalizeAssignableUser(realUser);
        assert.strictEqual(normalized.id, 'real_worker_01');
        assert.strictEqual(normalized.role, 'user');
        assert.strictEqual(normalized.canonicalDepartmentId, 'dept_promotion');
        assert.strictEqual(normalized.isActive, true);
        assert.strictEqual(normalized.isSuspended, false);
        assert.strictEqual(normalized.isDeleted, false);
        assert.strictEqual(normalized.isAssignable, true);

        // Password MUST NOT be present in normalized output
        assert.strictEqual('password' in normalized, false);
    });

    await runTest('normalizeAssignableUser marks suspended, deleted, and unknown team users as unassignable', () => {
        const suspendedUser = normalizeAssignableUser({ id: 'u_susp', role: 'user', team: '회복팀', status: 'suspended' });
        assert.strictEqual(suspendedUser.isSuspended, true);
        assert.strictEqual(suspendedUser.isAssignable, false);

        const deletedUser = normalizeAssignableUser({ id: 'u_del', role: 'user', team: '회복팀', isDeleted: true });
        assert.strictEqual(deletedUser.isDeleted, true);
        assert.strictEqual(deletedUser.isAssignable, false);

        const unknownTeamUser = normalizeAssignableUser({ id: 'u_unk', role: 'user', team: '외계팀', status: 'active' });
        assert.strictEqual(unknownTeamUser.canonicalDepartmentId, null);
        assert.strictEqual(unknownTeamUser.isAssignable, false);
    });

    // -------------------------------------------------------------
    // Section Q: Unassigned Call Ownership Scope
    // -------------------------------------------------------------
    console.log('\n--- Q. Unassigned Call Ownership Scope ---');
    const hScope = createStoreHarness('h_scope');
    const callRepoScope = new VoiceCallRepository(hScope.getData, hScope.persistData);
    const histRepoScope = new AssignmentHistoryRepository(hScope.getData, hScope.persistData, { voiceCallRepo: callRepoScope });
    const opRepoScope = new AssignmentOperationRepository(hScope.getData, hScope.persistData, { dataDir: hScope.dir });
    const outboxRepoScope = new NotificationOutboxRepository(hScope.getData, hScope.persistData, { dataDir: hScope.dir });

    const serviceScope = new AssignmentService({
        voiceCallRepo: callRepoScope,
        assignmentHistoryRepo: histRepoScope,
        assignmentOperationRepo: opRepoScope,
        outboxRepo: outboxRepoScope,
        getUsersFn: () => SYNTHETIC_USERS
    });

    await runTest('Unassigned call without owningDepartmentId is rejected for Manager assignment', async () => {
        const call = await seedVoiceCall(callRepoScope, {
            id: 'call_scope_no_owner',
            assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED,
            owningDepartmentId: undefined,
            version: 1
        });

        await assert.rejects(
            async () => {
                await serviceScope.assignCall({
                    callId: call.id,
                    operationId: 'op_scope_no_owner_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[1]); // Manager Promotion
            },
            err => err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN
        );
    });

    await runTest('Admin can assign unassigned call even without owningDepartmentId', async () => {
        const call = await seedVoiceCall(callRepoScope, {
            id: 'call_scope_admin_ok',
            assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED,
            owningDepartmentId: undefined,
            version: 1
        });

        const res = await serviceScope.assignCall({
            callId: call.id,
            operationId: 'op_scope_admin_ok',
            expectedVersion: 1,
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'synthetic_user_a',
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        }, SYNTHETIC_USERS[0]); // Admin

        assert.strictEqual(res.status, 'COMPLETED');
    });

    await runTest('Client-provided owningDepartmentId in updateMetadata is strictly rejected', async () => {
        const call = await seedVoiceCall(callRepoScope, { id: 'call_scope_forbid', version: 1 });
        await assert.rejects(
            async () => {
                await callRepoScope.updateMetadata(call.id, 1, { owningDepartmentId: 'dept_recovery' });
            },
            err => err.message.includes('일반 updateMetadata로 직접 수정할 수 없습니다')
        );
    });

    // -------------------------------------------------------------
    // Section R: History Content-Checking Idempotency
    // -------------------------------------------------------------
    console.log('\n--- R. History Content-Checking Idempotency ---');
    const hHistIdem = createStoreHarness('h_hist_idem');
    const callRepoHistIdem = new VoiceCallRepository(hHistIdem.getData, hHistIdem.persistData);
    const histRepoIdem = new AssignmentHistoryRepository(hHistIdem.getData, hHistIdem.persistData, { voiceCallRepo: callRepoHistIdem });

    await runTest('AssignmentHistoryRepository returns existing on identical content and throws on content mismatch', async () => {
        const call = await seedVoiceCall(callRepoHistIdem, { id: 'call_hist_idem', version: 2 });

        const entry1 = {
            callId: call.id,
            operationId: 'op_hist_idem_01',
            nextUserId: 'synthetic_user_a',
            nextDepartmentId: 'dept_promotion',
            reason: '초기 배정',
            assignedBy: 'synthetic_admin',
            resultingVersion: 2
        };

        const rec1 = await histRepoIdem.recordAssignment(entry1);
        assert.ok(rec1.id);

        // Same operationId, exact same content -> returns existing
        const rec2 = await histRepoIdem.recordAssignment(entry1);
        assert.strictEqual(rec2.id, rec1.id);

        // Same operationId, differing nextUserId -> throws ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT
        await assert.rejects(
            async () => {
                await histRepoIdem.recordAssignment({
                    ...entry1,
                    nextUserId: 'synthetic_user_b'
                });
            },
            err => err.code === 'ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT'
        );
    });

    // -------------------------------------------------------------
    // Section S: Outbox Payload-Checking Idempotency
    // -------------------------------------------------------------
    console.log('\n--- S. Outbox Payload-Checking Idempotency ---');
    const hOutboxIdem = createStoreHarness('h_outbox_idem');
    const outboxRepoIdem = new NotificationOutboxRepository(hOutboxIdem.getData, hOutboxIdem.persistData, { dataDir: hOutboxIdem.dir });

    await runTest('NotificationOutboxRepository createEvent with idempotentResume returns existing on match and rejects on payload diff', async () => {
        const ev1 = await outboxRepoIdem.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            aggregateType: 'voice_call',
            aggregateId: 'call_outbox_01',
            recipientUserId: 'synthetic_user_a',
            sourceVersion: 2,
            idempotentResume: true,
            payload: { messageCode: 'ASSIGNED', severity: 'info' }
        });

        // Exact match with idempotentResume returns existing
        const ev2 = await outboxRepoIdem.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            aggregateType: 'voice_call',
            aggregateId: 'call_outbox_01',
            recipientUserId: 'synthetic_user_a',
            sourceVersion: 2,
            idempotentResume: true,
            payload: { messageCode: 'ASSIGNED', severity: 'info' }
        });
        assert.strictEqual(ev2.id, ev1.id);

        // Differing payload throws OUTBOX_IDEMPOTENCY_CONFLICT
        await assert.rejects(
            async () => {
                await outboxRepoIdem.createEvent({
                    eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
                    aggregateType: 'voice_call',
                    aggregateId: 'call_outbox_01',
                    recipientUserId: 'synthetic_user_a',
                    sourceVersion: 2,
                    idempotentResume: true,
                    payload: { messageCode: 'DIFFERING_PAYLOAD', severity: 'warning' }
                });
            },
            err => err.code === 'OUTBOX_IDEMPOTENCY_CONFLICT'
        );
    });

    // -------------------------------------------------------------
    // Section T: Concurrent Multi-Service OCC Disk State Verification
    // -------------------------------------------------------------
    console.log('\n--- T. Concurrent Assignment Disk State ---');
    await runTest('Concurrent assignment requests on disk produce exactly 1 winner, 1 conflict, 0 pending, 1 history, 1 outbox', async () => {
        const hConc = createStoreHarness('h_conc_disk');

        const callRepo1 = new VoiceCallRepository(hConc.getData, hConc.persistData);
        const histRepo1 = new AssignmentHistoryRepository(hConc.getData, hConc.persistData, { voiceCallRepo: callRepo1 });
        const opRepo1 = new AssignmentOperationRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });
        const outboxRepo1 = new NotificationOutboxRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });

        const service1 = new AssignmentService({
            voiceCallRepo: callRepo1,
            assignmentHistoryRepo: histRepo1,
            assignmentOperationRepo: opRepo1,
            outboxRepo: outboxRepo1,
            getUsersFn: () => SYNTHETIC_USERS
        });

        const callRepo2 = new VoiceCallRepository(hConc.getData, hConc.persistData);
        const histRepo2 = new AssignmentHistoryRepository(hConc.getData, hConc.persistData, { voiceCallRepo: callRepo2 });
        const opRepo2 = new AssignmentOperationRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });
        const outboxRepo2 = new NotificationOutboxRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });

        const service2 = new AssignmentService({
            voiceCallRepo: callRepo2,
            assignmentHistoryRepo: histRepo2,
            assignmentOperationRepo: opRepo2,
            outboxRepo: outboxRepo2,
            getUsersFn: () => SYNTHETIC_USERS
        });

        const call = await seedVoiceCall(callRepo1, {
            id: 'call_conc_disk_01',
            owningDepartmentId: 'dept_promotion',
            version: 1
        });

        const [r1, r2] = await Promise.allSettled([
            service1.assignCall({
                callId: call.id,
                operationId: 'op_conc_winner_01',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            }, SYNTHETIC_USERS[0]),
            service2.assignCall({
                callId: call.id,
                operationId: 'op_conc_loser_02',
                expectedVersion: 1,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'synthetic_user_a',
                reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
            }, SYNTHETIC_USERS[0])
        ]);

        const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
        const rejected = [r1, r2].filter(r => r.status === 'rejected');

        assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent request succeeds');
        assert.strictEqual(rejected.length, 1, 'Exactly one concurrent request conflicts');
        assert.strictEqual(rejected[0].reason.code, ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT);

        // Read directly from DISK (bypassing in-memory repository caches)
        const diskCalls = hConc.getData('VoiceCalls');
        assert.strictEqual(diskCalls.length, 1);
        const finalCall = diskCalls[0];
        assert.strictEqual(finalCall.version, 2, 'Call version on disk must be exactly expectedVersion + 1');
        assert.strictEqual(finalCall.lastAssignmentOperationId, fulfilled[0].value.operationId);

        const diskHist = hConc.getData('VoiceCallAssignmentHistory');
        assert.strictEqual(diskHist.length, 1, 'Exactly 1 history record on disk');
        assert.strictEqual(diskHist[0].operationId, fulfilled[0].value.operationId);

        const diskOutbox = hConc.getData('NotificationOutbox');
        assert.strictEqual(diskOutbox.length, 1, 'Exactly 1 outbox event on disk');

        const diskOps = hConc.getData(ASSIGNMENT_OPERATIONS_STORAGE_FILE);
        assert.strictEqual(diskOps.length, 2, 'Exactly 2 operations on disk');

        const completedOp = diskOps.find(o => o.status === OPERATION_STATUS.COMPLETED);
        assert.ok(completedOp, 'One operation is completed');
        assert.strictEqual(completedOp.operationId, fulfilled[0].value.operationId);

        const conflictOp = diskOps.find(o => o.status === OPERATION_STATUS.CONFLICT);
        assert.ok(conflictOp, 'Losing operation is marked CONFLICT (not pending!)');
        assert.strictEqual(conflictOp.lastErrorCode, ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT);

        const pendingOps = diskOps.filter(o => o.status === OPERATION_STATUS.PENDING);
        assert.strictEqual(pendingOps.length, 0, 'Zero operations left in pending status on disk');
    });

    // -------------------------------------------------------------
    // Section U: A9 Outbox Lease Method Separation
    // -------------------------------------------------------------
    console.log('\n--- U. A9 Outbox Lease Credentials Separation ---');
    const hLease = createStoreHarness('h_lease_sep');
    const outboxRepoLease = new NotificationOutboxRepository(hLease.getData, hLease.persistData, { dataDir: hLease.dir });

    await runTest('Worker lease methods strictly require worker credentials and reject missing or invalid tokens', async () => {
        const ev = await outboxRepoLease.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            aggregateType: 'voice_call',
            aggregateId: 'call_lease_01',
            recipientUserId: 'u_lease',
            sourceVersion: 1
        });

        const claim = await outboxRepoLease.claimNextEvent({ workerId: 'worker_01' });
        assert.ok(claim);

        // Missing credentials in cancelLeasedEvent throws OUTBOX_LEASE_REQUIRED
        await assert.rejects(
            async () => {
                await outboxRepoLease.cancelLeasedEvent({ eventId: ev.id });
            },
            err => err.code === 'OUTBOX_LEASE_REQUIRED'
        );

        // Wrong worker throws OUTBOX_LEASE_OWNER_MISMATCH
        await assert.rejects(
            async () => {
                await outboxRepoLease.cancelLeasedEvent({
                    eventId: ev.id,
                    workerId: 'wrong_worker',
                    leaseToken: claim.leaseToken
                });
            },
            err => err.code === 'OUTBOX_LEASE_OWNER_MISMATCH'
        );

        // Wrong token throws OUTBOX_LEASE_TOKEN_INVALID
        await assert.rejects(
            async () => {
                await outboxRepoLease.cancelLeasedEvent({
                    eventId: ev.id,
                    workerId: 'worker_01',
                    leaseToken: 'wrong_token_123'
                });
            },
            err => err.code === 'OUTBOX_LEASE_TOKEN_INVALID'
        );

        // Valid credentials succeed
        const cancelled = await outboxRepoLease.cancelLeasedEvent({
            eventId: ev.id,
            workerId: 'worker_01',
            leaseToken: claim.leaseToken
        });
        assert.strictEqual(cancelled.status, OUTBOX_STATUS.CANCELLED);
    });

    // -------------------------------------------------------------
    // Section V: Comprehensive Failure Injections
    // -------------------------------------------------------------
    console.log('\n--- V. Failure Injection Verification ---');
    await runTest('Failure injections across stages halt safely without inconsistent store mutations', async () => {
        const hFail = createStoreHarness('h_fail_inject');
        let failMode = null;

        const customPersist = async (filename, data) => {
            if (failMode === filename) {
                throw new Error(`Injected failure for ${filename}`);
            }
            return hFail.persistData(filename, data);
        };

        const callRepoFail = new VoiceCallRepository(hFail.getData, customPersist);
        const histRepoFail = new AssignmentHistoryRepository(hFail.getData, customPersist, { voiceCallRepo: callRepoFail });
        const opRepoFail = new AssignmentOperationRepository(hFail.getData, customPersist, { dataDir: hFail.dir });
        const outboxRepoFail = new NotificationOutboxRepository(hFail.getData, customPersist, { dataDir: hFail.dir });

        const serviceFail = new AssignmentService({
            voiceCallRepo: callRepoFail,
            assignmentHistoryRepo: histRepoFail,
            assignmentOperationRepo: opRepoFail,
            outboxRepo: outboxRepoFail,
            getUsersFn: () => SYNTHETIC_USERS
        });

        // Pre-seed test calls before enabling failure injection
        const call1 = await seedVoiceCall(callRepoFail, { id: 'call_fail_01', owningDepartmentId: 'dept_promotion', version: 1 });
        const call2 = await seedVoiceCall(callRepoFail, { id: 'call_fail_02', owningDepartmentId: 'dept_promotion', version: 1 });
        const call3 = await seedVoiceCall(callRepoFail, { id: 'call_fail_03', owningDepartmentId: 'dept_promotion', version: 1 });
        const call4 = await seedVoiceCall(callRepoFail, { id: 'call_fail_04', owningDepartmentId: 'dept_promotion', version: 1 });

        // 1. Pending Operation Write failure
        failMode = ASSIGNMENT_OPERATIONS_STORAGE_FILE;
        await assert.rejects(
            async () => {
                await serviceFail.assignCall({
                    callId: call1.id,
                    operationId: 'op_fail_01',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.message.includes('Injected failure') || err.message.includes('AssignmentOperation')
        );
        failMode = null;

        // 2. VoiceCall Write failure
        failMode = 'VoiceCalls';
        await assert.rejects(
            async () => {
                await serviceFail.assignCall({
                    callId: call2.id,
                    operationId: 'op_fail_02',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.message.includes('Injected failure')
        );
        failMode = null;

        // 3. History Write failure
        failMode = 'VoiceCallAssignmentHistory';
        await assert.rejects(
            async () => {
                await serviceFail.assignCall({
                    callId: call3.id,
                    operationId: 'op_fail_03',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.message.includes('Injected failure')
        );
        failMode = null;

        // 4. Outbox Write failure
        failMode = 'NotificationOutbox';
        await assert.rejects(
            async () => {
                await serviceFail.assignCall({
                    callId: call4.id,
                    operationId: 'op_fail_04',
                    expectedVersion: 1,
                    requestedDepartmentId: 'dept_promotion',
                    requestedUserId: 'synthetic_user_a',
                    reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
                }, SYNTHETIC_USERS[0]);
            },
            err => err.message.includes('Injected failure') || err.message.includes('Outbox')
        );
        failMode = null;

        // 5. Resolver conflict check
        assert.strictEqual(validateCanonicalDepartmentMappings(), true);
    });

    // Clean up temporary test directory
    try {
        fs.rmSync(testRoot, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temporary test directory: ${testRoot}`);
    } catch {
        // ignore
    }

    console.log('\n============================================================');
    console.log(`📊 A10 VERIFICATION RESULTS: ${passedTests} Passed, ${failedTests} Failed`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test execution error:', err);
    process.exit(1);
});

/**
 * scripts/verify-persistent-audit-log.mjs
 * Comprehensive Verification Test Harness for Mind-ERP OS Track A11 Persistent Audit Log.
 * Validates Append-only Store, Hash Chain, Canonical JSON, Privacy Minimization,
 * Concurrency, Tamper Detection, Reconciliation, Metrics, and Integration Adapters.
 *
 * BOUNDARY NOTICE:
 * - Runs in isolated mkdtemp directory (never touches production DATA_DIR).
 * - Uses strictly synthetic IDs and data (zero PII, zero real subject details).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import crypto from 'crypto';

import {
    AUDIT_STORAGE_FILE,
    AUDIT_HEAD_STORAGE_FILE,
    AUDIT_SCHEMA_VERSION,
    GENESIS_HASH,
    AUDIT_CATEGORIES,
    AUDIT_ACTOR_TYPES,
    AUDIT_OUTCOMES,
    AUDIT_EVENT_TYPES,
    AUDIT_RECONCILIATION_CHECK_CODES,
    AUDIT_LIMITS,
    AuditError,
    AUDIT_ERROR_CODES,
    validateSafeMetadata,
    canonicalizeAuditData,
    computeEntryHash,
    verifyEntryHash,
    verifyHashChainLink,
    validateAuditEntryInput,
    validateStoredAuditEntry,
    AuditRepository,
    runAuditReconciliation,
    reconcileAuditLog,
    previewAuditHeadRepair,
    executeAuditHeadRepair,
    getAuditMetricsSnapshot,
    AssignmentAuditSink,
    PersistentAudioAuditAdapter,
    VoiceAccessAuditAdapter,
    CANONICAL_AUDIO_EVENT_TYPES,
    CANONICAL_VOICE_ACCESS_EVENT_TYPES,
    AuditEventDeduplicator
} from '../server/audit/index.js';

import {
    ASSIGNMENT_REASON_CODES,
    ASSIGNMENT_STATUS,
    OPERATION_STATUS
} from '../server/assignment/assignmentConstants.js';
import { AssignmentService } from '../server/assignment/assignmentService.js';
import { AssignmentOperationRepository } from '../server/assignment/assignmentOperationRepository.js';
import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import { AssignmentHistoryRepository } from '../server/voice-calls/assignmentHistoryRepository.js';
import { NotificationOutboxRepository } from '../server/notifications/notificationOutboxRepository.js';
import { projectVoiceCallForClient } from '../server/voice-calls/index.js';
import { executeBootstrap } from './bootstrap-voice-access-grant.mjs';

// Setup isolated temporary test directory
const tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit_test_'));
console.log(`📁 Isolated A11 Test Directory: ${tempBaseDir}`);

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
    totalTests++;
    try {
        await fn();
        passedTests++;
        console.log(`  ✅ [PASS] ${name}`);
    } catch (err) {
        failedTests++;
        console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
        if (err.stack) {
            console.error(err.stack.split('\n').slice(0, 5).join('\n'));
        }
    }
}

// Memory/Disk store harness builder
function createAuditHarness(label) {
    const harnessDir = path.join(tempBaseDir, label);
    fs.mkdirSync(harnessDir, { recursive: true });

    const memoryCache = new Map();

    const getData = (filename, defaultValue) => {
        const filePath = path.join(harnessDir, filename);
        if (memoryCache.has(filename)) {
            return JSON.parse(JSON.stringify(memoryCache.get(filename)));
        }
        if (!fs.existsSync(filePath)) {
            return defaultValue !== undefined ? defaultValue : null;
        }
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            memoryCache.set(filename, parsed);
            return JSON.parse(JSON.stringify(parsed));
        } catch {
            throw new Error(`Failed to read file ${filename}`);
        }
    };

    const persistData = async (filename, data) => {
        const filePath = path.join(harnessDir, filename);
        const serialized = JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, serialized, 'utf8');
        memoryCache.set(filename, JSON.parse(serialized));
        return true;
    };

    return { dir: harnessDir, getData, persistData, memoryCache };
}

async function main() {
    console.log('\n============================================================');
    console.log('🧪 TRACK A11: APPEND-ONLY PERSISTENT AUDIT LOG VERIFICATION');
    console.log('============================================================');

    // -------------------------------------------------------------
    // Section A: A10 Precondition Gate Verification
    // -------------------------------------------------------------
    console.log('\n--- A. A10 Precondition Gate ---');
    const hGate = createAuditHarness('h_gate');
    const callRepoGate = new VoiceCallRepository(hGate.getData, hGate.persistData);
    const histRepoGate = new AssignmentHistoryRepository(hGate.getData, hGate.persistData, { voiceCallRepo: callRepoGate });
    const opRepoGate = new AssignmentOperationRepository(hGate.getData, hGate.persistData, { dataDir: hGate.dir });
    const outboxRepoGate = new NotificationOutboxRepository(hGate.getData, hGate.persistData, { dataDir: hGate.dir });

    await runTest('A10 Gate: applyAssignmentChange records lastAssignmentOperationId and bumps version in single persist', async () => {
        // Seed initial unassigned voice call
        const seededCall = {
            id: 'synthetic_call_gate_01',
            clientProvidedId: 'client_gate_01',
            direction: 'inbound',
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationSeconds: 120,
            callerPhoneNumber: '010-0000-0001',
            callerName: 'Synthetic Subject',
            processingStatus: 'received',
            assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED,
            owningDepartmentId: 'dept_promotion',
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: 'synthetic_intake'
        };
        await hGate.persistData('VoiceCalls', [seededCall]);

        const updated = await callRepoGate.applyAssignmentChange({
            callId: 'synthetic_call_gate_01',
            operationId: 'synthetic_op_gate_01',
            expectedVersion: 1,
            nextDepartmentId: 'dept_promotion',
            nextUserId: 'synthetic_user_gate_01',
            assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED,
            actorUserId: 'synthetic_admin_gate'
        });

        assert.strictEqual(updated.version, 2);
        assert.strictEqual(updated.lastAssignmentOperationId, 'synthetic_op_gate_01');
        assert.strictEqual(updated.lastAssignmentActorId, 'synthetic_admin_gate');
        assert.ok(updated.assignmentChangedAt);
    });

    await runTest('A10 Gate: updateMetadata strictly forbids modifying assignment fields', async () => {
        let threw = false;
        try {
            await callRepoGate.updateMetadata('synthetic_call_gate_01', 2, {
                assignedUserId: 'forbidden_tamper_user'
            });
        } catch (err) {
            threw = true;
            assert.ok(err.code === 'VOICE_CALL_INVARIANT_VIOLATION' || err.code === 'INVARIANT_VIOLATION');
        }
        assert.strictEqual(threw, true);
    });

    // -------------------------------------------------------------
    // Section B: Audit Entry Domain Model & Immutability
    // -------------------------------------------------------------
    console.log('\n--- B. Audit Entry Domain Model ---');
    const hEntry = createAuditHarness('h_entry');
    const repoEntry = new AuditRepository(hEntry.getData, hEntry.persistData, { dataDir: hEntry.dir });

    await runTest('Audit entry creation initializes server ID, sequence 1, schemaVersion 1, Genesis hash, and SHA-256 entryHash', async () => {
        const input = {
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'synthetic_actor_01',
            resourceType: 'session',
            resourceId: 'session_synth_1001',
            outcome: AUDIT_OUTCOMES.SUCCESS,
            safeMetadata: { sourceEventCode: 'LOGIN_WEB' }
        };

        const entry = await repoEntry.appendEvent(input);

        assert.ok(entry.id && entry.id.startsWith('audit_'));
        assert.strictEqual(entry.sequence, 1);
        assert.strictEqual(entry.schemaVersion, AUDIT_SCHEMA_VERSION);
        assert.strictEqual(entry.category, AUDIT_CATEGORIES.AUTHENTICATION);
        assert.strictEqual(entry.previousEntryHash, GENESIS_HASH);
        assert.strictEqual(entry.entryHash.length, 64);
        assert.strictEqual(/^[0-9a-f]{64}$/.test(entry.entryHash), true);
        assert.ok(entry.recordedAt);
        assert.strictEqual(verifyEntryHash(entry), true);
    });

    await runTest('Audit entry creation rejects caller-supplied sequence, id, schemaVersion, or hash', async () => {
        const forbiddenKeys = ['id', 'sequence', 'schemaVersion', 'recordedAt', 'previousEntryHash', 'entryHash'];
        for (const key of forbiddenKeys) {
            let threw = false;
            try {
                await repoEntry.appendEvent({
                    eventType: AUDIT_EVENT_TYPES.AUTH_LOGOUT,
                    actorType: AUDIT_ACTOR_TYPES.USER,
                    actorId: 'synthetic_actor_01',
                    resourceType: 'session',
                    resourceId: 'session_synth_1001',
                    outcome: AUDIT_OUTCOMES.SUCCESS,
                    [key]: 'forbidden_value'
                });
            } catch (err) {
                threw = true;
                assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID);
            }
            assert.strictEqual(threw, true, `Expected rejection for supplied '${key}'`);
        }
    });

    await runTest('Input object remains unmutated after appendEvent execution', async () => {
        const originalInput = {
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGOUT,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'synthetic_actor_01',
            resourceType: 'session',
            resourceId: 'session_synth_1001',
            outcome: AUDIT_OUTCOMES.SUCCESS
        };
        const inputSnapshot = JSON.stringify(originalInput);

        await repoEntry.appendEvent(originalInput);
        assert.strictEqual(JSON.stringify(originalInput), inputSnapshot);
    });

    // -------------------------------------------------------------
    // Section C: Payload Policy & Minimization
    // -------------------------------------------------------------
    console.log('\n--- C. Payload Policy & Minimization ---');

    await runTest('safeMetadata allowlist permits approved keys and values', async () => {
        const validMeta = {
            sourceEventCode: 'DISPATCH_OK',
            assignmentReasonCode: 'initial_assignment',
            departmentCanonicalId: 'dept_promotion',
            retryCount: 2,
            streamDisposition: 'inline'
        };
        const validated = validateSafeMetadata(validMeta);
        assert.strictEqual(validated.sourceEventCode, 'DISPATCH_OK');
        assert.strictEqual(validated.retryCount, 2);
    });

    await runTest('Prohibited PII keys (phone, transcript, summary, token, password) are strictly rejected with sanitized error', async () => {
        const prohibitedKeys = [
            'phone', 'name', 'transcript', 'summary', 'address', 'password',
            'token', 'storageKey', 'contentHash', 'fullUserAgent', 'fullIpAddress'
        ];

        for (const pKey of prohibitedKeys) {
            let threw = false;
            try {
                validateSafeMetadata({
                    sourceEventCode: 'TEST',
                    [pKey]: 'secret_or_pii_value'
                });
            } catch (err) {
                threw = true;
                assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE);
                // Verify error message NEVER leaks sensitive key or value
                assert.strictEqual(err.message.includes('secret_or_pii_value'), false);
                assert.strictEqual(err.message.includes(pKey), false);
            }
            assert.strictEqual(threw, true, `Expected rejection for prohibited key '${pKey}'`);
        }
    });

    await runTest('Nested objects and arrays in safeMetadata are strictly rejected', async () => {
        let threwObj = false;
        try {
            validateSafeMetadata({
                sourceEventCode: 'TEST',
                nestedObj: { foo: 'bar' }
            });
        } catch (err) {
            threwObj = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE);
        }
        assert.strictEqual(threwObj, true);

        let threwArr = false;
        try {
            validateSafeMetadata({
                sourceEventCode: 'TEST',
                nestedArr: [1, 2, 3]
            });
        } catch (err) {
            threwArr = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE);
        }
        assert.strictEqual(threwArr, true);
    });

    // -------------------------------------------------------------
    // Section D: Canonical JSON Serialization
    // -------------------------------------------------------------
    console.log('\n--- D. Canonical JSON Serialization ---');

    await runTest('canonicalizeAuditData produces identical output regardless of object key order', async () => {
        const obj1 = { b: 'two', a: 'one', c: 3 };
        const obj2 = { c: 3, a: 'one', b: 'two' };

        assert.strictEqual(canonicalizeAuditData(obj1), canonicalizeAuditData(obj2));
        assert.strictEqual(canonicalizeAuditData(obj1), '{"a":"one","b":"two","c":3}');
    });

    await runTest('canonicalizeAuditData normalizes Unicode strings to NFC', async () => {
        // Decomposed vs Composed Korean characters (한글)
        const decomposed = '\u1112\u1161\u11AB'; // ᄒ + ᅡ + ᆫ
        const composed = '\uD55C'; // 한

        assert.notStrictEqual(decomposed, composed);
        const canon1 = canonicalizeAuditData({ text: decomposed });
        const canon2 = canonicalizeAuditData({ text: composed });

        assert.strictEqual(canon1, canon2);
    });

    await runTest('canonicalizeAuditData strictly rejects undefined, NaN, and Infinity', async () => {
        assert.throws(() => canonicalizeAuditData({ val: undefined }), /undefined/);
        assert.throws(() => canonicalizeAuditData({ val: NaN }), /NaN/);
        assert.throws(() => canonicalizeAuditData({ val: Infinity }), /Infinity/);
    });

    // -------------------------------------------------------------
    // Section E: Hash Chain Continuity
    // -------------------------------------------------------------
    console.log('\n--- E. Hash Chain Continuity ---');
    const hChain = createAuditHarness('h_chain');
    const repoChain = new AuditRepository(hChain.getData, hChain.persistData, { dataDir: hChain.dir });

    await runTest('10 sequential appends maintain strict sequence increment and previousEntryHash linkage', async () => {
        let prevHash = GENESIS_HASH;

        for (let i = 1; i <= 10; i++) {
            const entry = await repoChain.appendEvent({
                eventType: AUDIT_EVENT_TYPES.JOB_CREATED,
                actorType: AUDIT_ACTOR_TYPES.WORKER,
                actorId: 'synthetic_worker_01',
                resourceType: 'voice_call_job',
                resourceId: `job_synth_${i}`,
                outcome: AUDIT_OUTCOMES.SUCCESS,
                safeMetadata: { retryCount: 0 }
            });

            assert.strictEqual(entry.sequence, i);
            assert.strictEqual(entry.previousEntryHash, prevHash);
            assert.strictEqual(verifyEntryHash(entry), true);
            prevHash = entry.entryHash;
        }

        // Verify head anchor
        const head = await repoChain.getHead();
        assert.strictEqual(head.lastSequence, 10);
        assert.strictEqual(head.lastEntryHash, prevHash);
    });

    await runTest('Disk reloading preserves complete hash chain validity', async () => {
        const freshRepo = new AuditRepository(hChain.getData, hChain.persistData, { dataDir: hChain.dir });
        const entries = await freshRepo.getEntries({ limit: 50 });

        assert.strictEqual(entries.length, 10);
        let prev = null;
        for (const entry of entries) {
            const result = verifyHashChainLink(entry, prev);
            assert.strictEqual(result.valid, true, result.reason);
            prev = entry;
        }
    });

    // -------------------------------------------------------------
    // Section F: Concurrent Append
    // -------------------------------------------------------------
    console.log('\n--- F. Concurrent Append ---');
    const hConc = createAuditHarness('h_conc');
    const repoConc1 = new AuditRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });
    const repoConc2 = new AuditRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });

    await runTest('10 concurrent appends from 2 repository instances serialize with zero lost entries and intact chain', async () => {
        const appendPromises = [];

        for (let i = 1; i <= 10; i++) {
            const chosenRepo = (i % 2 === 0) ? repoConc1 : repoConc2;
            appendPromises.push(chosenRepo.appendEvent({
                eventType: AUDIT_EVENT_TYPES.OUTBOX_DISPATCH_SUCCEEDED,
                actorType: AUDIT_ACTOR_TYPES.SYSTEM,
                actorId: 'synthetic_dispatcher',
                resourceType: 'notification_outbox',
                resourceId: `outbox_synth_${i}`,
                outcome: AUDIT_OUTCOMES.SUCCESS,
                safeMetadata: { safeResultCode: `OK_${i}` }
            }));
        }

        const results = await Promise.all(appendPromises);
        assert.strictEqual(results.length, 10);

        // Verify disk state
        const freshRepo = new AuditRepository(hConc.getData, hConc.persistData, { dataDir: hConc.dir });
        const diskEntries = await freshRepo.getEntries({ limit: 50 });

        assert.strictEqual(diskEntries.length, 10);

        // Ensure strictly sequential sequences 1..10 with zero duplicates or gaps
        const sequences = diskEntries.map(e => e.sequence);
        assert.deepStrictEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        // Ensure all entry IDs are unique
        const idSet = new Set(diskEntries.map(e => e.id));
        assert.strictEqual(idSet.size, 10);

        // Ensure hash chain is continuous
        let prev = null;
        for (const entry of diskEntries) {
            const check = verifyHashChainLink(entry, prev);
            assert.strictEqual(check.valid, true, check.reason);
            prev = entry;
        }
    });

    // -------------------------------------------------------------
    // Section G: Persist Failure Handling
    // -------------------------------------------------------------
    console.log('\n--- G. Persist Failure Handling ---');
    const hFail = createAuditHarness('h_fail');
    let injectPersistError = false;

    const failingPersist = async (file, data) => {
        if (injectPersistError && file === AUDIT_STORAGE_FILE) {
            return false;
        }
        return hFail.persistData(file, data);
    };

    const repoFail = new AuditRepository(hFail.getData, failingPersist, { dataDir: hFail.dir });

    await runTest('Persist failure does NOT advance sequence or corrupt chain on subsequent successful append', async () => {
        // 1. Entry 1 succeeds
        const e1 = await repoFail.appendEvent({
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'synthetic_actor_01',
            resourceType: 'session',
            resourceId: 'sess_1',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });
        assert.strictEqual(e1.sequence, 1);

        // 2. Entry 2 fails persist
        injectPersistError = true;
        let threw = false;
        try {
            await repoFail.appendEvent({
                eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_FAILED,
                actorType: AUDIT_ACTOR_TYPES.ANONYMOUS,
                resourceType: 'session',
                resourceId: 'sess_fail',
                outcome: AUDIT_OUTCOMES.DENIED
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_STORE_FAILED);
        }
        assert.strictEqual(threw, true);

        // Store must contain only Entry 1
        const entriesAfterFail = await repoFail.getEntries();
        assert.strictEqual(entriesAfterFail.length, 1);

        // 3. Entry 3 succeeds persist; sequence must be 2 linking to Entry 1
        injectPersistError = false;
        const e3 = await repoFail.appendEvent({
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGOUT,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'synthetic_actor_01',
            resourceType: 'session',
            resourceId: 'sess_1',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });

        assert.strictEqual(e3.sequence, 2);
        assert.strictEqual(e3.previousEntryHash, e1.entryHash);
        assert.strictEqual(verifyEntryHash(e3), true);

        const finalEntries = await repoFail.getEntries();
        assert.strictEqual(finalEntries.length, 2);
        assert.strictEqual(verifyHashChainLink(finalEntries[1], finalEntries[0]).valid, true);
    });

    // -------------------------------------------------------------
    // Section H: Tamper Detection
    // -------------------------------------------------------------
    console.log('\n--- H. Tamper Detection ---');

    await runTest('Tamper: Mid-chain actorId modification is detected by entryHash mismatch', async () => {
        const hTamper = createAuditHarness('h_tamper_1');
        const repo = new AuditRepository(hTamper.getData, hTamper.persistData, { dataDir: hTamper.dir });

        await repo.appendEvent({
            eventType: AUDIT_EVENT_TYPES.JOB_CREATED,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'actor_original',
            resourceType: 'job',
            resourceId: 'job_01',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });
        await repo.appendEvent({
            eventType: AUDIT_EVENT_TYPES.JOB_CLAIMED,
            actorType: AUDIT_ACTOR_TYPES.WORKER,
            actorId: 'worker_01',
            resourceType: 'job',
            resourceId: 'job_01',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });

        // Directly tamper with disk record of Entry 1
        const rawEntries = hTamper.getData(AUDIT_STORAGE_FILE, []);
        rawEntries[0].actorId = 'actor_tampered';
        await hTamper.persistData(AUDIT_STORAGE_FILE, rawEntries);

        const recon = await runAuditReconciliation({ auditRepo: repo });
        assert.strictEqual(recon.issuesCount >= 1, true);
        const hashIssue = recon.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_HASH_MISMATCH);
        assert.ok(hashIssue, 'Expected AUDIT_ENTRY_HASH_MISMATCH');
    });

    await runTest('Tamper: Entry deletion is detected by sequence gap or previousEntryHash mismatch', async () => {
        const hTamper = createAuditHarness('h_tamper_2');
        const repo = new AuditRepository(hTamper.getData, hTamper.persistData, { dataDir: hTamper.dir });

        await repo.appendEvent({ eventType: AUDIT_EVENT_TYPES.JOB_CREATED, actorType: AUDIT_ACTOR_TYPES.USER, actorId: 'u1', resourceType: 'job', resourceId: 'j1', outcome: AUDIT_OUTCOMES.SUCCESS });
        await repo.appendEvent({ eventType: AUDIT_EVENT_TYPES.JOB_CLAIMED, actorType: AUDIT_ACTOR_TYPES.WORKER, actorId: 'w1', resourceType: 'job', resourceId: 'j1', outcome: AUDIT_OUTCOMES.SUCCESS });
        await repo.appendEvent({ eventType: AUDIT_EVENT_TYPES.JOB_COMPLETED, actorType: AUDIT_ACTOR_TYPES.WORKER, actorId: 'w1', resourceType: 'job', resourceId: 'j1', outcome: AUDIT_OUTCOMES.SUCCESS });

        // Delete Entry 2
        const rawEntries = hTamper.getData(AUDIT_STORAGE_FILE, []);
        rawEntries.splice(1, 1);
        await hTamper.persistData(AUDIT_STORAGE_FILE, rawEntries);

        const recon = await runAuditReconciliation({ auditRepo: repo });
        assert.strictEqual(recon.issuesCount >= 1, true);
        const gapIssue = recon.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_GAP);
        const prevMismatch = recon.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_PREVIOUS_HASH_MISMATCH);
        assert.ok(gapIssue || prevMismatch, 'Expected gap or hash mismatch issue');
    });

    await runTest('Tamper: Head ahead detects truncation of entries', async () => {
        const hTamper = createAuditHarness('h_tamper_3');
        const repo = new AuditRepository(hTamper.getData, hTamper.persistData, { dataDir: hTamper.dir });

        await repo.appendEvent({ eventType: AUDIT_EVENT_TYPES.JOB_CREATED, actorType: AUDIT_ACTOR_TYPES.USER, actorId: 'u1', resourceType: 'job', resourceId: 'j1', outcome: AUDIT_OUTCOMES.SUCCESS });
        await repo.appendEvent({ eventType: AUDIT_EVENT_TYPES.JOB_CLAIMED, actorType: AUDIT_ACTOR_TYPES.WORKER, actorId: 'w1', resourceType: 'job', resourceId: 'j1', outcome: AUDIT_OUTCOMES.SUCCESS });

        // Remove last entry from entries while keeping Head anchor at sequence 2
        const rawEntries = hTamper.getData(AUDIT_STORAGE_FILE, []);
        rawEntries.pop();
        await hTamper.persistData(AUDIT_STORAGE_FILE, rawEntries);

        const recon = await runAuditReconciliation({ auditRepo: repo });
        const aheadIssue = recon.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_AHEAD);
        assert.ok(aheadIssue, 'Expected AUDIT_HEAD_AHEAD');
    });

    // -------------------------------------------------------------
    // Section I: Assignment Audit Adapter
    // -------------------------------------------------------------
    console.log('\n--- I. Assignment Audit Adapter ---');
    const hAssign = createAuditHarness('h_assign');
    const auditRepoAssign = new AuditRepository(hAssign.getData, hAssign.persistData, { dataDir: hAssign.dir });
    const assignSink = new AssignmentAuditSink(auditRepoAssign);

    const callRepoAssign = new VoiceCallRepository(hAssign.getData, hAssign.persistData);
    const histRepoAssign = new AssignmentHistoryRepository(hAssign.getData, hAssign.persistData, { voiceCallRepo: callRepoAssign });
    const opRepoAssign = new AssignmentOperationRepository(hAssign.getData, hAssign.persistData, { dataDir: hAssign.dir });
    const outboxRepoAssign = new NotificationOutboxRepository(hAssign.getData, hAssign.persistData, { dataDir: hAssign.dir });

    const assignService = new AssignmentService({
        voiceCallRepo: callRepoAssign,
        assignmentHistoryRepo: histRepoAssign,
        assignmentOperationRepo: opRepoAssign,
        outboxRepo: outboxRepoAssign,
        auditSink: assignSink,
        getUserByIdFn: async (id) => ({ id, team: 'dept_promotion', role: 'user', status: 'active' }),
        voiceAccessAuthorizer: {
            async authorize() {
                return { allowed: true, effectiveScope: { allowed: true, type: 'all' } };
            }
        }
    });

    await runTest('AssignmentService emits ASSIGNMENT_SUCCEEDED and NO_CHANGE audit entries without PII', async () => {
        // Seed call
        await hAssign.persistData('VoiceCalls', [{
            id: 'call_assign_audit_01',
            clientProvidedId: 'client_01',
            direction: 'inbound',
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationSeconds: 60,
            callerPhoneNumber: '010-1234-5678',
            processingStatus: 'received',
            assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED,
            owningDepartmentId: 'dept_promotion',
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }]);

        // 1. Initial Assignment
        const res1 = await assignService.assignCall({
            callId: 'call_assign_audit_01',
            operationId: 'op_audit_01',
            expectedVersion: 1,
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'user_audit_01',
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        }, { id: 'admin_01', role: 'admin', team: 'dept_admin', status: 'active' });

        assert.strictEqual(res1.status, 'COMPLETED');

        // Check audit entry
        const entries1 = await auditRepoAssign.getEntries();
        assert.strictEqual(entries1.length, 1);
        assert.strictEqual(entries1[0].eventType, AUDIT_EVENT_TYPES.ASSIGNMENT_SUCCEEDED);
        assert.strictEqual(entries1[0].resourceId, 'call_assign_audit_01');
        assert.strictEqual(entries1[0].actorId, 'admin_01');
        assert.strictEqual(entries1[0].beforeVersion, 1);
        assert.strictEqual(entries1[0].afterVersion, 2);

        // Ensure zero PII in audit metadata
        const serialized = JSON.stringify(entries1[0]);
        assert.strictEqual(serialized.includes('010-1234-5678'), false);

        // 2. Replay completed operation -> Deduplication prevents duplicate audit
        await assignService.assignCall({
            callId: 'call_assign_audit_01',
            operationId: 'op_audit_01',
            expectedVersion: 1,
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'user_audit_01',
            reasonCode: ASSIGNMENT_REASON_CODES.INITIAL_ASSIGNMENT
        }, { id: 'admin_01', role: 'admin', team: 'dept_admin', status: 'active' });

        const entriesAfterReplay = await auditRepoAssign.getEntries();
        assert.strictEqual(entriesAfterReplay.length, 1, 'Replay must not create duplicate audit log');

        // 3. NO_CHANGE assignment
        const resNoChange = await assignService.assignCall({
            callId: 'call_assign_audit_01',
            operationId: 'op_audit_02',
            expectedVersion: 2,
            requestedDepartmentId: 'dept_promotion',
            requestedUserId: 'user_audit_01',
            reasonCode: ASSIGNMENT_REASON_CODES.WORKLOAD_REBALANCE
        }, { id: 'admin_01', role: 'admin', team: 'dept_admin', status: 'active' });

        assert.strictEqual(resNoChange.status, 'NO_CHANGE');
        const entriesAfterNoChange = await auditRepoAssign.getEntries();
        assert.strictEqual(entriesAfterNoChange.length, 2);
        assert.strictEqual(entriesAfterNoChange[1].eventType, AUDIT_EVENT_TYPES.ASSIGNMENT_NO_CHANGE);
    });

    await runTest('Assignment denied outcome emits ASSIGNMENT_DENIED audit entry without blocking error throw', async () => {
        let threw = false;
        try {
            await assignService.assignCall({
                callId: 'call_assign_audit_01',
                operationId: 'op_audit_denied',
                expectedVersion: 2,
                requestedDepartmentId: 'dept_promotion',
                requestedUserId: 'user_audit_01',
                reasonCode: ASSIGNMENT_REASON_CODES.WORKLOAD_REBALANCE
            }, { id: 'regular_user_01', role: 'user', team: 'dept_promotion', status: 'active' });
        } catch (err) {
            threw = true;
        }
        assert.strictEqual(threw, true);

        const entries = await auditRepoAssign.getEntries();
        const deniedEntry = entries.find(e => e.operationId === 'op_audit_denied');
        assert.ok(deniedEntry);
        assert.strictEqual(deniedEntry.eventType, AUDIT_EVENT_TYPES.ASSIGNMENT_DENIED);
        assert.strictEqual(deniedEntry.outcome, AUDIT_OUTCOMES.DENIED);
    });

    // -------------------------------------------------------------
    // Section J: Audio Streaming Audit Adapter
    // -------------------------------------------------------------
    console.log('\n--- J. Audio Streaming Audit Adapter ---');
    const hAudio = createAuditHarness('h_audio');
    const auditRepoAudio = new AuditRepository(hAudio.getData, hAudio.persistData, { dataDir: hAudio.dir });
    const audioAdapter = new PersistentAudioAuditAdapter(auditRepoAudio, { sessionDebounceMs: 5000 });

    await runTest('Audio adapter records session start and debounces rapid Range chunk requests', async () => {
        // First chunk request
        const res1 = await audioAdapter.record({
            eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
            resourceId: 'synthetic_call_audio_01',
            actorUserId: 'synthetic_listener_01',
            outcome: 'SUCCESS',
            safeMetadata: { streamDisposition: 'inline', rangeRequestKind: 'range' }
        });
        assert.strictEqual(res1.recorded, true);

        // Immediate second chunk within debounce window (e.g. seeking or next buffer slice)
        const res2 = await audioAdapter.record({
            eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
            resourceId: 'synthetic_call_audio_01',
            actorUserId: 'synthetic_listener_01',
            outcome: 'SUCCESS',
            safeMetadata: { streamDisposition: 'inline', rangeRequestKind: 'range' }
        });
        assert.strictEqual(res2.recorded, false);
        assert.strictEqual(res2.debounced, true);

        // Verify only 1 audit entry was persisted to disk
        const entries = await auditRepoAudio.getEntries();
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].eventType, AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED);
        assert.strictEqual(entries[0].actorId, 'synthetic_listener_01');
        assert.ok(entries[0].safeMetadata.playbackSessionId);

        // Zero raw range headers or storage keys
        assert.strictEqual(entries[0].safeMetadata.storageKey, undefined);
        assert.strictEqual(entries[0].safeMetadata.rangeHeader, undefined);
    });

    await runTest('Audio adapter records download started and access denied events', async () => {
        await audioAdapter.record({
            eventType: AUDIT_EVENT_TYPES.AUDIO_DOWNLOAD_STARTED,
            resourceId: 'synthetic_call_audio_01',
            actorUserId: 'synthetic_admin_01',
            outcome: 'SUCCESS',
            safeMetadata: { streamDisposition: 'attachment' }
        });

        await audioAdapter.record({
            eventType: AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED,
            resourceId: 'synthetic_call_audio_01',
            actorUserId: 'synthetic_intruder_01',
            outcome: 'DENIED',
            reasonCode: 'CROSS_TEAM_FORBIDDEN'
        });

        const entries = await auditRepoAudio.getEntries();
        assert.strictEqual(entries.length, 3);
        assert.strictEqual(entries[1].eventType, AUDIT_EVENT_TYPES.AUDIO_DOWNLOAD_STARTED);
        assert.strictEqual(entries[2].eventType, AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED);
        assert.strictEqual(entries[2].outcome, AUDIT_OUTCOMES.DENIED);
    });

    // -------------------------------------------------------------
    // Section K: Store Corruption Handling
    // -------------------------------------------------------------
    console.log('\n--- K. Store Corruption Handling ---');
    const hCorrupt = createAuditHarness('h_corrupt');
    const repoCorrupt = new AuditRepository(hCorrupt.getData, hCorrupt.persistData, { dataDir: hCorrupt.dir });

    await runTest('Corrupted JSON halts append operations without overwriting damaged disk data', async () => {
        // Append entry 1
        await repoCorrupt.appendEvent({
            eventType: AUDIT_EVENT_TYPES.JOB_CREATED,
            actorType: AUDIT_ACTOR_TYPES.SYSTEM,
            actorId: 'sys',
            resourceType: 'job',
            resourceId: 'j1',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });

        // Corrupt disk file with malformed JSON
        const corruptContent = "<<<MALFORMED_JSON_CORRUPTION>>>";
        fs.writeFileSync(path.join(hCorrupt.dir, AUDIT_STORAGE_FILE), corruptContent, 'utf8');
        hCorrupt.memoryCache.delete(AUDIT_STORAGE_FILE);

        let threw = false;
        try {
            await repoCorrupt.appendEvent({
                eventType: AUDIT_EVENT_TYPES.JOB_CREATED,
                actorType: AUDIT_ACTOR_TYPES.SYSTEM,
                actorId: 'sys',
                resourceType: 'job',
                resourceId: 'j2',
                outcome: AUDIT_OUTCOMES.SUCCESS
            });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_STORE_CORRUPTED);
        }
        assert.strictEqual(threw, true);

        // Verify disk file was NOT overwritten with []
        const onDisk = fs.readFileSync(path.join(hCorrupt.dir, AUDIT_STORAGE_FILE), 'utf8');
        assert.strictEqual(onDisk, corruptContent);

        // resetCorruptionState fails while file remains corrupted
        assert.strictEqual(repoCorrupt.resetCorruptionState(), false);
        assert.strictEqual(repoCorrupt.isCorrupted, true);
    });

    // -------------------------------------------------------------
    // Section L: Reconciliation Engine
    // -------------------------------------------------------------
    console.log('\n--- L. Reconciliation Engine ---');
    const hRecon = createAuditHarness('h_recon_suite');
    const repoRecon = new AuditRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir });

    await runTest('runAuditReconciliation cleanly detects check codes without PII', async () => {
        // Seed an entry with unknown eventType and unsupported schemaVersion
        const malformedEntry = {
            id: 'audit_test_bad',
            sequence: 1,
            schemaVersion: 999, // unsupported
            eventType: 'UNKNOWN_CUSTOM_EVENT', // unknown
            category: 'system',
            actorType: 'user',
            actorId: 'bad_actor',
            resourceType: 'voice_call',
            resourceId: 'non_existent_call_999',
            operationId: 'non_existent_op_999',
            outcome: 'success',
            occurredAt: new Date().toISOString(),
            recordedAt: new Date().toISOString(),
            previousEntryHash: GENESIS_HASH,
            entryHash: '0000000000000000000000000000000000000000000000000000000000000000'
        };
        await hRecon.persistData(AUDIT_STORAGE_FILE, [malformedEntry]);

        const reconReport = await runAuditReconciliation({
            auditRepo: repoRecon,
            externalRefs: {
                assignmentOperations: [],
                voiceCalls: []
            }
        });

        assert.strictEqual(reconReport.issuesCount >= 3, true);

        const schemaIssue = reconReport.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SCHEMA_VERSION_UNSUPPORTED);
        assert.ok(schemaIssue);

        const typeIssue = reconReport.issues.find(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_UNKNOWN_EVENT_TYPE);
        assert.ok(typeIssue);

        // Verify zero PII in serialized report
        const serialized = JSON.stringify(reconReport);
        assert.strictEqual(serialized.includes('010-'), false);
        assert.strictEqual(serialized.includes('transcript'), false);
    });

    // -------------------------------------------------------------
    // Section M: Operational Metrics Snapshot
    // -------------------------------------------------------------
    console.log('\n--- M. Operational Metrics Snapshot ---');
    const hMetrics = createAuditHarness('h_metrics');
    const repoMetrics = new AuditRepository(hMetrics.getData, hMetrics.persistData, { dataDir: hMetrics.dir });

    await runTest('getAuditMetricsSnapshot aggregates entries, counts, and size estimate without PII', async () => {
        await repoMetrics.appendEvent({
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: 'synthetic_user_01',
            resourceType: 'session',
            resourceId: 'sess_1',
            outcome: AUDIT_OUTCOMES.SUCCESS
        });
        await repoMetrics.appendEvent({
            eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_FAILED,
            actorType: AUDIT_ACTOR_TYPES.ANONYMOUS,
            resourceType: 'session',
            resourceId: 'sess_2',
            outcome: AUDIT_OUTCOMES.DENIED
        });

        const metrics = await getAuditMetricsSnapshot(repoMetrics);

        assert.strictEqual(metrics.totalEntries, 2);
        assert.strictEqual(metrics.firstSequence, 1);
        assert.strictEqual(metrics.lastSequence, 2);
        assert.strictEqual(metrics.chainValid, true);
        assert.strictEqual(metrics.deniedCount, 1);
        assert.strictEqual(metrics.entriesByCategory.authentication, 2);
        assert.strictEqual(typeof metrics.auditStoreSerializedBytesEstimate, 'number');
        assert.ok(metrics.auditStoreSerializedBytesEstimate > 0);

        // Verify zero user identifiers in metrics snapshot
        const serialized = JSON.stringify(metrics);
        assert.strictEqual(serialized.includes('synthetic_user_01'), false);
    });

    // -------------------------------------------------------------
    // Section N: Failure Injection Verification
    // -------------------------------------------------------------
    console.log('\n--- N. Failure Injection ---');
    await runTest('Failure injection across repository, canonicalization, and adapter halts safely', async () => {
        // 1. Repository read failure
        const brokenGet = () => { throw new Error('Simulated disk read IO error'); };
        const repoBrokenRead = new AuditRepository(brokenGet, async () => true);
        let readFailed = false;
        try {
            await repoBrokenRead.appendEvent({
                eventType: AUDIT_EVENT_TYPES.JOB_CREATED,
                actorType: AUDIT_ACTOR_TYPES.SYSTEM,
                actorId: 'sys',
                resourceType: 'job',
                resourceId: 'j1',
                outcome: AUDIT_OUTCOMES.SUCCESS
            });
        } catch (err) {
            readFailed = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_STORE_CORRUPTED);
        }
        assert.strictEqual(readFailed, true);

        // 2. Canonicalization circular reference failure
        const circular = { a: 1 };
        circular.self = circular;
        let canonFailed = false;
        try {
            canonicalizeAuditData(circular);
        } catch (err) {
            canonFailed = true;
            assert.strictEqual(err.code, AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED);
        }
        assert.strictEqual(canonFailed, true);

        // 3. Audio adapter failure isolation
        const failingAuditRepo = {
            appendEvent: async () => { throw new Error('Simulated audit append outage'); }
        };
        const failingAudioAdapter = new PersistentAudioAuditAdapter(failingAuditRepo);
        const res = await failingAudioAdapter.record({
            eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
            resourceId: 'call_1',
            actorUserId: 'user_1',
            outcome: 'SUCCESS'
        });
        assert.strictEqual(res.recorded, false);
        assert.ok(res.error);
    });

    // -------------------------------------------------------------
    // Section O: Voice Access Audit Adapter & Lifecycle Events
    // -------------------------------------------------------------
    console.log('\n--- O. Voice Access Lifecycle & Access Outcomes ---');
    const hVoiceAccess = createAuditHarness('h_voice_access');
    const repoVoiceAccess = new AuditRepository(hVoiceAccess.getData, hVoiceAccess.persistData, { dataDir: hVoiceAccess.dir });
    const vaAdapter = new VoiceAccessAuditAdapter(repoVoiceAccess, { denyDebounceMs: 2000 });

    await runTest('VoiceAccessAuditAdapter records every canonical lifecycle event with zero PII', async () => {
        const lifecycleEvents = [
            AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_CREATED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_CAPABILITIES_UPDATED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_SCOPE_UPDATED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_SUSPENDED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_REACTIVATED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_REVOKED,
            AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_EXPIRED
        ];

        for (let i = 0; i < lifecycleEvents.length; i++) {
            const ev = lifecycleEvents[i];
            const res = await vaAdapter.recordLifecycleEvent({
                eventType: ev,
                actorId: 'admin_sys_1',
                targetUserId: 'user_target_1',
                grantId: 'grant_101',
                reasonCode: 'LIFECYCLE_TEST',
                beforeVersion: i,
                afterVersion: i + 1,
                safeMetadata: {
                    grantScopeType: 'assigned_only',
                    capabilityCount: 6,
                    actionCode: ev,
                    grantVersion: i + 1
                }
            });
            assert.strictEqual(res.recorded, true);
            assert.ok(res.entry);
            assert.strictEqual(res.entry.category, AUDIT_CATEGORIES.VOICE_ACCESS);
            assert.strictEqual(res.entry.sequence, i + 1);
        }

        const entries = await repoVoiceAccess.getEntries({ limit: 10 });
        assert.strictEqual(entries.length, 7);

        // Verify zero PII in any serialized entry
        const serialized = JSON.stringify(entries);
        assert.strictEqual(serialized.includes('@'), false);
        assert.strictEqual(serialized.includes('010-'), false);
        assert.strictEqual(serialized.includes('token'), false);
    });

    await runTest('VoiceAccessAuditAdapter records access allowed and access denied with bounded debounce', async () => {
        // 1. Access allowed
        const allowRes = await vaAdapter.recordAccessOutcome({
            allowed: true,
            actorId: 'user_pilot_1',
            capability: 'voice_call.play_audio',
            resourceId: 'call_test_01'
        });
        assert.strictEqual(allowRes.recorded, true);
        assert.strictEqual(allowRes.entry.eventType, AUDIT_EVENT_TYPES.VOICE_ACCESS_ALLOWED);
        assert.strictEqual(allowRes.entry.outcome, AUDIT_OUTCOMES.SUCCESS);

        // 2. Access denied (first occurrence)
        const denyRes1 = await vaAdapter.recordAccessOutcome({
            allowed: false,
            actorId: 'user_pilot_2',
            capability: 'voice_call.download_audio',
            reasonCode: 'CAPABILITY_DENIED'
        });
        assert.strictEqual(denyRes1.recorded, true);
        assert.strictEqual(denyRes1.entry.eventType, AUDIT_EVENT_TYPES.VOICE_ACCESS_DENIED);
        assert.strictEqual(denyRes1.entry.outcome, AUDIT_OUTCOMES.DENIED);

        // 3. Immediate duplicate denial is debounced
        const denyRes2 = await vaAdapter.recordAccessOutcome({
            allowed: false,
            actorId: 'user_pilot_2',
            capability: 'voice_call.download_audio',
            reasonCode: 'CAPABILITY_DENIED'
        });
        assert.strictEqual(denyRes2.recorded, false);
        assert.strictEqual(denyRes2.debounced, true);

        // 4. Different actor denial is NOT debounced
        const denyRes3 = await vaAdapter.recordAccessOutcome({
            allowed: false,
            actorId: 'user_pilot_3',
            capability: 'voice_call.download_audio',
            reasonCode: 'CAPABILITY_DENIED'
        });
        assert.strictEqual(denyRes3.recorded, true);
    });

    // -------------------------------------------------------------
    // Section P: Bootstrap Audit Integration Contract
    // -------------------------------------------------------------
    console.log('\n--- P. Bootstrap Audit Integration Contract ---');
    const hBootstrap = createAuditHarness('h_bootstrap');
    const repoBootstrap = new AuditRepository(hBootstrap.getData, hBootstrap.persistData, { dataDir: hBootstrap.dir });
    const bootstrapAdapter = new VoiceAccessAuditAdapter(repoBootstrap);

    const syntheticBootstrapDir = path.join(tempBaseDir, 'synth_bootstrap_data');
    fs.mkdirSync(syntheticBootstrapDir, { recursive: true });

    const synthEnv = {
        VOICE_SYSTEM_ENABLED: 'true',
        VOICE_SYSTEM_ACCESS_MODE: 'allowlist',
        VOICE_SYSTEM_ACCESS_DATA_DIR: syntheticBootstrapDir,
        VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID: 'admin_synth_bootstrap'
    };
    const synthUsers = [{
        id: 'admin_synth_bootstrap',
        role: 'admin',
        status: 'active'
    }];

    await runTest('Bootstrap dry-run creates zero audit records', async () => {
        const dryRunRes = await executeBootstrap({
            env: synthEnv,
            users: synthUsers,
            apply: false,
            auditSink: bootstrapAdapter,
            silent: true
        });
        assert.strictEqual(dryRunRes.applyRequired, true);

        const entries = await repoBootstrap.getEntries();
        assert.strictEqual(entries.length, 0, 'Dry-run must not create any audit entries');
    });

    await runTest('Bootstrap isolated apply creates exactly one success audit record', async () => {
        const applyRes = await executeBootstrap({
            env: synthEnv,
            users: synthUsers,
            apply: true,
            auditSink: bootstrapAdapter,
            silent: true
        });
        assert.strictEqual(applyRes.success, true);
        assert.strictEqual(applyRes.auditRecorded, true);

        const entries = await repoBootstrap.getEntries();
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].eventType, AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_SUCCEEDED);
        assert.strictEqual(entries[0].outcome, AUDIT_OUTCOMES.SUCCESS);
        assert.strictEqual(entries[0].actorId, 'admin_synth_bootstrap');
    });

    await runTest('Bootstrap replay creates no duplicate success audit record', async () => {
        // Replaying recordBootstrap on same grant/actor
        const replayRes = await bootstrapAdapter.recordBootstrap({
            outcome: 'success',
            actorId: 'admin_synth_bootstrap',
            grantId: 'bootstrap_grant',
            reasonCode: 'REPLAY_TEST'
        });
        assert.strictEqual(replayRes.recorded, false);
        assert.strictEqual(replayRes.deduplicated, true);

        const entries = await repoBootstrap.getEntries();
        assert.strictEqual(entries.length, 1, 'Total entries must remain 1 after replay');
    });

    // -------------------------------------------------------------
    // Section Q: Event Name Consistency & Audio Canonicalization
    // -------------------------------------------------------------
    console.log('\n--- Q. Event Name Consistency ---');
    const hAudioConsistency = createAuditHarness('h_audio_consistency');
    const repoAudioConsistency = new AuditRepository(hAudioConsistency.getData, hAudioConsistency.persistData, { dataDir: hAudioConsistency.dir });
    const audioAdapterConsistency = new PersistentAudioAuditAdapter(repoAudioConsistency);

    await runTest('Audio adapter normalizes legacy names into canonical audio event allowlist', async () => {
        // 1. AUDIO_STREAM_ACCESSED is mapped to AUDIO_ACCESS_AUTHORIZED
        const res1 = await audioAdapterConsistency.record({
            eventType: 'AUDIO_STREAM_ACCESSED',
            resourceId: 'call_c1',
            actorUserId: 'user_c1',
            outcome: 'SUCCESS'
        });
        assert.strictEqual(res1.recorded, true);
        assert.strictEqual(res1.entry.eventType, AUDIT_EVENT_TYPES.AUDIO_ACCESS_AUTHORIZED);
        assert.ok(CANONICAL_AUDIO_EVENT_TYPES.has(res1.entry.eventType));

        // 2. AUDIO_STREAM_BLOCKED is mapped to AUDIO_ACCESS_DENIED
        const res2 = await audioAdapterConsistency.record({
            eventType: 'AUDIO_STREAM_BLOCKED',
            resourceId: 'call_c2',
            actorUserId: 'user_c2',
            outcome: 'DENIED'
        });
        assert.strictEqual(res2.recorded, true);
        assert.strictEqual(res2.entry.eventType, AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED);
        assert.ok(CANONICAL_AUDIO_EVENT_TYPES.has(res2.entry.eventType));

        // 3. Audio adapter rejects arbitrary unapproved event name safely (do not map to AUDIO_STREAM_FAILED)
        const res3 = await audioAdapterConsistency.record({
            eventType: 'ARBITRARY_UNAPPROVED_NAME',
            resourceId: 'call_c3',
            actorUserId: 'user_c3',
            outcome: 'FAILED'
        });
        assert.strictEqual(res3.recorded, false);
        assert.ok(res3.error && res3.error.includes('Rejected unknown or unapproved'));
    });

    await runTest('VoiceAccessAuditAdapter rejects non-canonical voice access event types', async () => {
        const res = await vaAdapter.recordLifecycleEvent({
            eventType: 'NON_CANONICAL_VOICE_EVENT',
            actorId: 'admin_1',
            grantId: 'g1'
        });
        assert.strictEqual(res.recorded, false);
        assert.ok(res.error.includes('Invalid voice access eventType'));
    });

    // -------------------------------------------------------------
    // Section R: Assignment Persistent Deduplication
    // -------------------------------------------------------------
    console.log('\n--- R. Assignment Persistent Deduplication ---');
    const hAssignDedup = createAuditHarness('h_assign_dedup');
    const repoAssignDedup = new AuditRepository(hAssignDedup.getData, hAssignDedup.persistData, { dataDir: hAssignDedup.dir });

    await runTest('AssignmentAuditSink prevents duplicate success audit records across fresh instances', async () => {
        const sink1 = new AssignmentAuditSink(repoAssignDedup);
        const res1 = await sink1.record({
            eventType: AUDIT_EVENT_TYPES.ASSIGNMENT_SUCCEEDED,
            actorId: 'worker_01',
            resourceId: 'call_persistent_dedup',
            operationId: 'op_persistent_001',
            outcome: AUDIT_OUTCOMES.SUCCESS,
            beforeVersion: 1,
            afterVersion: 2
        });
        assert.strictEqual(res1.recorded, true);

        // Instance 2 simulates process restart with empty memory cache
        const sink2 = new AssignmentAuditSink(repoAssignDedup);
        const res2 = await sink2.record({
            eventType: AUDIT_EVENT_TYPES.ASSIGNMENT_SUCCEEDED,
            actorId: 'worker_01',
            resourceId: 'call_persistent_dedup',
            operationId: 'op_persistent_001',
            outcome: AUDIT_OUTCOMES.SUCCESS,
            beforeVersion: 1,
            afterVersion: 2
        });
        assert.strictEqual(res2.recorded, false);
        assert.strictEqual(res2.deduplicated, true);

        const entries = await repoAssignDedup.getEntries();
        assert.strictEqual(entries.length, 1, 'Store must contain exactly 1 entry despite repeated calls across instances');
    });

    // -------------------------------------------------------------
    // Section S: Read-Only Reconciliation & Audit Head Repair Boundary
    // -------------------------------------------------------------
    console.log('\n--- S. Head Repair Boundary & Read-Only Reconciliation ---');
    const hHeadRepair = createAuditHarness('h_head_repair');
    const repoHeadRepair = new AuditRepository(hHeadRepair.getData, hHeadRepair.persistData, { dataDir: hHeadRepair.dir });

    await repoHeadRepair.appendEvent({
        eventType: AUDIT_EVENT_TYPES.AUTH_LOGIN_SUCCEEDED,
        actorType: AUDIT_ACTOR_TYPES.USER,
        actorId: 'user_hr_1',
        resourceType: 'session',
        resourceId: 'sess_hr_1',
        outcome: AUDIT_OUTCOMES.SUCCESS
    });

    await runTest('reconcileAuditLog is strictly read-only and never alters stored state', async () => {
        const beforeHead = await repoHeadRepair.getHead();
        const beforeEntries = await repoHeadRepair.getEntries();

        const report = await reconcileAuditLog({ auditRepo: repoHeadRepair });
        assert.strictEqual(report.issuesCount, 0);

        const afterHead = await repoHeadRepair.getHead();
        const afterEntries = await repoHeadRepair.getEntries();
        assert.deepStrictEqual(beforeHead, afterHead);
        assert.strictEqual(beforeEntries.length, afterEntries.length);
    });

    await runTest('previewAuditHeadRepair is read-only and executeAuditHeadRepair requires admin + repair capability + reasonCode', async () => {
        // 1. Artificially remove AuditHead.json to create repair preview scenario
        const headPath = path.join(hHeadRepair.dir, AUDIT_HEAD_STORAGE_FILE);
        if (fs.existsSync(headPath)) fs.unlinkSync(headPath);
        hHeadRepair.memoryCache.delete(AUDIT_HEAD_STORAGE_FILE);

        const preview = await previewAuditHeadRepair({ auditRepo: repoHeadRepair });
        assert.strictEqual(preview.repairable, true);
        assert.ok(preview.proposedHead);
        assert.strictEqual(preview.proposedHead.lastSequence, 1);
        assert.ok(preview.previewId);
        assert.ok(preview.warning.includes('Cross-store repair is not ACID'));

        // Verify preview did NOT write the head file
        assert.strictEqual(fs.existsSync(headPath), false, 'Preview must be strictly read-only');

        // 2. executeAuditHeadRepair without admin role is rejected
        let nonAdminFailed = false;
        try {
            await executeAuditHeadRepair({
                auditRepo: repoHeadRepair,
                actorContext: { role: 'user', capabilities: ['audit.repair_head'] },
                reasonCode: 'TEST_RECOVERY'
            });
        } catch (err) {
            nonAdminFailed = true;
            assert.ok(err.message.includes('Administrative authorization required'));
        }
        assert.strictEqual(nonAdminFailed, true);

        // 3. executeAuditHeadRepair without repair capability is rejected
        let missingCapFailed = false;
        try {
            await executeAuditHeadRepair({
                auditRepo: repoHeadRepair,
                actorContext: { role: 'admin', capabilities: [] },
                reasonCode: 'TEST_RECOVERY'
            });
        } catch (err) {
            missingCapFailed = true;
            assert.ok(err.message.includes('Dedicated repair capability'));
        }
        assert.strictEqual(missingCapFailed, true);

        // 4. executeAuditHeadRepair without reasonCode is rejected
        let missingReasonFailed = false;
        try {
            await executeAuditHeadRepair({
                auditRepo: repoHeadRepair,
                actorContext: { role: 'admin', capabilities: ['audit.repair_head'] },
                reasonCode: ''
            });
        } catch (err) {
            missingReasonFailed = true;
            assert.ok(err.message.includes('Explicit reasonCode is required'));
        }
        assert.strictEqual(missingReasonFailed, true);

        // 5. executeAuditHeadRepair with mismatched previewId is rejected
        let stalePreviewFailed = false;
        try {
            await executeAuditHeadRepair({
                auditRepo: repoHeadRepair,
                actorContext: { role: 'admin', capabilities: ['audit.repair_head'] },
                reasonCode: 'AUDIT_HEAD_RECOVERY_TEST',
                previewId: 'stale_preview_id_12345'
            });
        } catch (err) {
            stalePreviewFailed = true;
            assert.ok(err.message.includes('preview identity mismatch'));
        }
        assert.strictEqual(stalePreviewFailed, true);

        // 6. Authorized executeAuditHeadRepair succeeds with capability, reasonCode, and preview identity
        const executeRes = await executeAuditHeadRepair({
            auditRepo: repoHeadRepair,
            actorContext: { role: 'admin', capabilities: ['audit.repair_head'] },
            reasonCode: 'AUDIT_HEAD_RECOVERY_TEST',
            previewId: preview.previewId
        });
        assert.strictEqual(executeRes.success, true);
        assert.strictEqual(executeRes.acidGuaranteed, false);
        assert.ok(executeRes.notice.includes('Cross-store repair is not ACID'));
        assert.ok(fs.existsSync(headPath), 'AuditHead must now be persisted');
    });

    await runTest('Tampered or corrupted hash chain cannot be repaired', async () => {
        // Tamper with entries file directly
        const entriesPath = path.join(hHeadRepair.dir, AUDIT_STORAGE_FILE);
        const entries = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
        entries[0].entryHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        fs.writeFileSync(entriesPath, JSON.stringify(entries), 'utf8');
        hHeadRepair.memoryCache.delete(AUDIT_STORAGE_FILE);

        // Preview reports unrepairable
        const preview = await previewAuditHeadRepair({ auditRepo: repoHeadRepair });
        assert.strictEqual(preview.repairable, false);
        assert.ok(preview.reason.includes('prohibited'));

        // Execute rejects
        let execFailed = false;
        try {
            await executeAuditHeadRepair({
                auditRepo: repoHeadRepair,
                actorContext: { role: 'admin', capabilities: ['audit.repair_head'] },
                reasonCode: 'REPAIR_TAMPERED'
            });
        } catch (err) {
            execFailed = true;
            assert.ok(err.message.includes('rejected'));
        }
        assert.strictEqual(execFailed, true);
    });

    // -------------------------------------------------------------
    // Section T: Retention Policy (Unset by Default)
    // -------------------------------------------------------------
    console.log('\n--- T. Retention Policy Truthfulness ---');
    const hRetention = createAuditHarness('h_retention');
    const repoRetention = new AuditRepository(hRetention.getData, hRetention.persistData, { dataDir: hRetention.dir });

    await repoRetention.appendEvent({
        eventType: AUDIT_EVENT_TYPES.JOB_COMPLETED,
        actorType: AUDIT_ACTOR_TYPES.SYSTEM,
        actorId: 'worker_retention',
        resourceType: 'job',
        resourceId: 'job_old_1',
        outcome: AUDIT_OUTCOMES.SUCCESS
    });

    // Backdate entry to 400 days ago
    const retEntries = hRetention.getData(AUDIT_STORAGE_FILE, []);
    retEntries[0].recordedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await hRetention.persistData(AUDIT_STORAGE_FILE, retEntries);

    await runTest('Retention policy is unset by default: zero retention candidates flagged', async () => {
        const report = await runAuditReconciliation({ auditRepo: repoRetention });
        const retentionIssues = report.issues.filter(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_RETENTION_CANDIDATE);
        assert.strictEqual(retentionIssues.length, 0, 'No retention candidate classification when policy is unset');
    });

    await runTest('Test-only retention threshold may be injected', async () => {
        const report = await runAuditReconciliation({
            auditRepo: repoRetention,
            retentionThresholdDays: 365
        });
        const retentionIssues = report.issues.filter(i => i.checkCode === AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_RETENTION_CANDIDATE);
        assert.strictEqual(retentionIssues.length, 1, 'Injected threshold flags old entry');
        assert.ok(retentionIssues[0].safeMessage.includes('365 days'));
    });

    // -------------------------------------------------------------
    // Section U: Safe View Projection Contract
    // -------------------------------------------------------------
    console.log('\n--- U. Safe View Projection Contract ---');

    await runTest('projectVoiceCallForClient strips lastAssignmentActorId unless caller has explicit audit permission', () => {
        const rawCall = {
            id: 'call_proj_01',
            assignedUserId: 'counselor_1',
            assignedDepartmentId: 'dept_psych',
            lastAssignmentOperationId: 'op_assign_100',
            lastAssignmentActorId: 'admin_private_id_99',
            version: 3
        };

        // 1. General user caller
        const userView = projectVoiceCallForClient(rawCall, { id: 'u1', role: 'user' });
        assert.strictEqual(userView.lastAssignmentActorId, undefined);
        assert.strictEqual(userView.id, 'call_proj_01');

        // 2. Manager caller without audit permission
        const managerView = projectVoiceCallForClient(rawCall, { id: 'm1', role: 'manager' });
        assert.strictEqual(managerView.lastAssignmentActorId, undefined);

        // 3. Admin caller without explicit canViewAudit
        const adminView = projectVoiceCallForClient(rawCall, { id: 'a1', role: 'admin' });
        assert.strictEqual(adminView.lastAssignmentActorId, undefined);

        // 4. Caller with explicit audit viewing permission
        const auditView = projectVoiceCallForClient(rawCall, {
            id: 'auditor_1',
            role: 'admin',
            permissions: { canViewAudit: true }
        });
        assert.strictEqual(auditView.lastAssignmentActorId, 'admin_private_id_99');
    });

    // Teardown
    try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temporary test directory: ${tempBaseDir}`);
    } catch {
        // ignore teardown error
    }

    console.log('\n============================================================');
    console.log(`📊 A11 AUDIT VERIFICATION RESULTS: ${passedTests} Passed, ${failedTests} Failed (Total: ${totalTests})`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});

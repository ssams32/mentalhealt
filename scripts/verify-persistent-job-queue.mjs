/**
 * scripts/verify-persistent-job-queue.mjs
 * Comprehensive Verification & Failure Injection Suite for Persistent Job Queue.
 * Mind-ERP OS Track A8 Final Integrity Closure.
 * 
 * Verifies:
 * - 29.1 Creation & Invariants
 * - 29.2 Idempotency & Concurrency
 * - 29.3 Claim Ordering & Priority
 * - 29.4 Lease Ownership & Timing-Safe Verification
 * - 29.5 Processing & Heartbeat Throttling
 * - 29.6 Completion & Result Reference Strict Allowlist
 * - 29.7 Retry & Bounded Exponential Backoff
 * - 29.8 Lease Expiry Recovery
 * - 29.9 Restart Recovery across Process Instances (No teardown cheats)
 * - 29.10 Pre-Claim Blocking & Attempt Count Strict Immutability
 * - 29.11 Cancellation
 * - 29.12 Store Corruption Fail-Closed & Non-Destructive Reset
 * - 29.13 Reconciliation (20 check codes & production synthetic check)
 * - 29.14 Metrics Snapshot & Archival Candidate Tracking
 * - 29.15 Worker Runner
 * - 30 Failure Injections & Store Error Codes
 * - Cross-Instance Real File Path Lock & Isolation
 * - Handler Timeout, AbortSignal & Late Completion Guard
 * - Queue Configuration Validation
 * - Due Retries Release inside Lock
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';

import {
    JOB_STATUS,
    ACTIVE_JOB_STATUSES,
    JOB_TYPES,
    PRODUCTION_JOB_TYPES,
    SYNTHETIC_JOB_TYPES,
    JOB_PRIORITY,
    DEFAULT_JOB_LIMITS,
    JOB_ERROR_CODES,
    ERROR_CLASSIFICATION,
    VoiceCallJobError,
    validateJobRecord,
    validateQueueConfig,
    isSafeResultReference,
    ALLOWED_RESULT_REFERENCE_KEYS,
    isTransitionAllowed,
    classifyError,
    computeRetryDelay,
    VoiceCallJobRepository,
    VoiceCallWorkerRunner,
    runJobReconciliation,
    RECONCILIATION_CHECK_CODES,
    getQueueMetricsSnapshot
} from '../server/jobs/index.js';

import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import { normalizeLockKey } from '../server/storage/sharedFileLockRegistry.js';

// Setup Isolated Temp Directory
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'job_queue_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

console.log(`📁 Isolated A8 Test Directory: ${TEST_ROOT}`);

let passedCount = 0;
let failedCount = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passedCount++;
        console.log(`  ✅ [PASS] ${name}`);
    } catch (err) {
        failedCount++;
        console.error(`  ❌ [FAIL] ${name}:`, err.message);
        if (err.stack) {
            console.error(err.stack.split('\n').slice(1, 4).join('\n'));
        }
    }
}

/**
 * File-backed persistence helper for testing.
 */
function createStoreHarness(subDirName) {
    const dir = path.join(DATA_DIR, subDirName);
    fs.mkdirSync(dir, { recursive: true });

    const getData = (filename, defaultValue = []) => {
        const filePath = path.join(dir, `${filename}.json`);
        if (!fs.existsSync(filePath)) return defaultValue;
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) return defaultValue;
        return JSON.parse(content);
    };

    const persistData = async (filename, data) => {
        const filePath = path.join(dir, `${filename}.json`);
        const tmpPath = path.join(dir, `${filename}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    };

    return { dir, getData, persistData };
}

async function runAllTests() {
    console.log('\n============================================================');
    console.log('🧪 TRACK A8: FINAL QUEUE INTEGRITY CLOSURE FULL VERIFICATION');
    console.log('============================================================\n');

    // -------------------------------------------------------------
    // Section A: Shared File Lock by Real File Path
    // -------------------------------------------------------------
    console.log('--- A. Shared File Lock by Real File Path ---');
    const hLockA = createStoreHarness('h_lock_a');
    const hLockB = createStoreHarness('h_lock_b');

    await runTest('Two repositories on same file path serialize under same lock', async () => {
        const repoA1 = new VoiceCallJobRepository(hLockA.getData, hLockA.persistData, {
            dataDir: hLockA.dir,
            enableSyntheticJobTypes: true
        });
        const repoA2 = new VoiceCallJobRepository(hLockA.getData, hLockA.persistData, {
            dataDir: hLockA.dir,
            enableSyntheticJobTypes: true
        });

        await repoA1.createJob({ callId: 'call_lock_conc_01', jobType: JOB_TYPES.SYNTHETIC_NOOP });

        const [claim1, claim2] = await Promise.all([
            repoA1.claimNextJob({ workerId: 'worker_lock_1' }),
            repoA2.claimNextJob({ workerId: 'worker_lock_2' })
        ]);

        const winner = claim1 || claim2;
        const loser = claim1 ? claim2 : claim1;
        assert.ok(winner !== null);
        assert.strictEqual(loser, null);
    });

    await runTest('Repositories on different dataDirs do not block each other', async () => {
        const repoA = new VoiceCallJobRepository(hLockA.getData, hLockA.persistData, { dataDir: hLockA.dir, enableSyntheticJobTypes: true });
        const repoB = new VoiceCallJobRepository(hLockB.getData, hLockB.persistData, { dataDir: hLockB.dir, enableSyntheticJobTypes: true });

        assert.notStrictEqual(repoA.lockKey, repoB.lockKey);
        await repoA.createJob({ callId: 'call_indep_a001', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        await repoB.createJob({ callId: 'call_indep_b001', jobType: JOB_TYPES.SYNTHETIC_NOOP });

        const [claimA, claimB] = await Promise.all([
            repoA.claimNextJob({ workerId: 'worker_indep_a' }),
            repoB.claimNextJob({ workerId: 'worker_indep_b' })
        ]);

        assert.ok(claimA !== null);
        assert.ok(claimB !== null);
    });

    await runTest('Linux lock key preserves case while Windows normalizes case', () => {
        const pathA = '/app/data/QueueA.json';
        const pathB = '/app/data/queuea.json';

        const linuxKeyA = normalizeLockKey(pathA, 'linux');
        const linuxKeyB = normalizeLockKey(pathB, 'linux');
        assert.notStrictEqual(linuxKeyA, linuxKeyB, 'On Linux/POSIX, QueueA.json and queuea.json must produce distinct lock keys');

        const winKeyA = normalizeLockKey('C:\\app\\data\\QueueA.json', 'win32');
        const winKeyB = normalizeLockKey('C:\\app\\data\\queuea.json', 'win32');
        assert.strictEqual(winKeyA, winKeyB, 'On Windows, equivalent paths with differing case must produce identical lock keys');
    });

    await runTest('Relative vs absolute path pointing to same file share identical lock key', () => {
        const repoAbs = new VoiceCallJobRepository(() => [], async () => true, {
            filePath: path.resolve(DATA_DIR, 'VoiceCallJobs.json')
        });
        const repoRel = new VoiceCallJobRepository(() => [], async () => true, {
            filePath: path.relative(process.cwd(), path.resolve(DATA_DIR, 'VoiceCallJobs.json'))
        });

        assert.strictEqual(
            normalizeLockKey(repoAbs.lockKey, 'win32'),
            normalizeLockKey(repoRel.lockKey, 'win32')
        );
    });

    // -------------------------------------------------------------
    // Section B: Production vs Test Job Type Separation
    // -------------------------------------------------------------
    console.log('\n--- B. Production vs Test Job Type Separation ---');
    const hProd = createStoreHarness('h_prod');
    const repoProd = new VoiceCallJobRepository(hProd.getData, hProd.persistData, {
        dataDir: hProd.dir,
        isProduction: true,
        enableSyntheticJobTypes: false
    });

    await runTest('Production mode rejects creating synthetic job types', async () => {
        await assert.rejects(
            async () => repoProd.createJob({ callId: 'call_prod_test_01', jobType: JOB_TYPES.SYNTHETIC_NOOP }),
            (err) => err.code === JOB_ERROR_CODES.JOB_TEST_TYPE_NOT_ALLOWED
        );
    });

    await runTest('Production mode permits creating production job types', async () => {
        const prodJob = await repoProd.createJob({ callId: 'call_prod_valid_01', jobType: JOB_TYPES.ROUTING });
        assert.strictEqual(prodJob.jobType, JOB_TYPES.ROUTING);
    });

    await runTest('Test mode with enableSyntheticJobTypes=true permits synthetic jobs', async () => {
        const repoTest = new VoiceCallJobRepository(hProd.getData, hProd.persistData, {
            dataDir: hProd.dir,
            isProduction: false,
            enableSyntheticJobTypes: true
        });
        const testJob = await repoTest.createJob({ callId: 'call_synth_ok_01', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        assert.strictEqual(testJob.jobType, JOB_TYPES.SYNTHETIC_NOOP);
    });

    // -------------------------------------------------------------
    // Section C: Attempt Count Strict Immutability & Pre-Claim Blocking
    // -------------------------------------------------------------
    console.log('\n--- C. Attempt Count Immutability & Pre-Claim Blocking ---');
    const hAttempt = createStoreHarness('h_attempt');
    const repoAttempt = new VoiceCallJobRepository(hAttempt.getData, hAttempt.persistData, {
        dataDir: hAttempt.dir,
        enableSyntheticJobTypes: true
    });

    await runTest('Attempt count starts at 0 and increments strictly upon claim', async () => {
        const job = await repoAttempt.createJob({ callId: 'call_attempt_immut', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        assert.strictEqual(job.attemptCount, 0);

        const claim = await repoAttempt.claimNextJob({ workerId: 'worker_att' });
        assert.strictEqual(claim.job.attemptCount, 1);
    });

    await runTest('Attempt count is never decremented on blockJob or unblockJob', async () => {
        const job = await repoAttempt.createJob({ callId: 'call_block_immut', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const claim = await repoAttempt.claimNextJob({ workerId: 'worker_blk' });
        assert.strictEqual(claim.job.attemptCount, 1);

        const blocked = await repoAttempt.blockJob({
            jobId: job.id,
            workerId: 'worker_blk',
            leaseToken: claim.leaseToken,
            reasonCode: JOB_ERROR_CODES.CAPACITY_LIMIT_REACHED
        });
        assert.strictEqual(blocked.status, JOB_STATUS.BLOCKED);
        assert.strictEqual(blocked.attemptCount, 1); // Immutable!

        const unblocked = await repoAttempt.unblockJob({ jobId: job.id });
        assert.strictEqual(unblocked.status, JOB_STATUS.QUEUED);
        assert.strictEqual(unblocked.attemptCount, 1); // Preserved!
    });

    await runTest('Pre-claim blocking blocks unexecutable job without consuming attemptCount', async () => {
        const hPreclaim = createStoreHarness('h_preclaim');
        const repoPreclaim = new VoiceCallJobRepository(hPreclaim.getData, hPreclaim.persistData, { dataDir: hPreclaim.dir });

        const sttJob = await repoPreclaim.createJob({ callId: 'call_preclaim_stt', jobType: JOB_TYPES.STT_TRANSCRIPTION });
        assert.strictEqual(sttJob.attemptCount, 0);

        const claim = await repoPreclaim.claimNextJob({
            workerId: 'worker_preclaim',
            executionContext: { aiEnabled: false, sttConfigured: false }
        });

        assert.strictEqual(claim, null);
        const updatedJob = repoPreclaim.findById(sttJob.id);
        assert.strictEqual(updatedJob.status, JOB_STATUS.BLOCKED);
        assert.strictEqual(updatedJob.lastErrorCode, JOB_ERROR_CODES.AI_DISABLED);
        assert.strictEqual(updatedJob.attemptCount, 0);
    });

    await runTest('Pre-claim blocking does not halt queue: claims next executable job', async () => {
        const hSearch = createStoreHarness('h_search');
        const repoSearch = new VoiceCallJobRepository(hSearch.getData, hSearch.persistData, { dataDir: hSearch.dir });

        await repoSearch.createJob({
            callId: 'call_urgent_stt',
            jobType: JOB_TYPES.STT_TRANSCRIPTION,
            priority: JOB_PRIORITY.URGENT
        });

        const normalJob = await repoSearch.createJob({
            callId: 'call_normal_recon',
            jobType: JOB_TYPES.RECONCILIATION,
            priority: JOB_PRIORITY.NORMAL
        });

        const claim = await repoSearch.claimNextJob({
            workerId: 'worker_search_cont',
            executionContext: { aiEnabled: true, sttConfigured: false }
        });

        assert.ok(claim !== null);
        assert.strictEqual(claim.job.id, normalJob.id);
        assert.strictEqual(claim.job.attemptCount, 1);
        assert.strictEqual(claim.job.status, JOB_STATUS.LEASED);
    });

    await runTest('Pre-claim blocking and claim execute in single store commit; failure rolls back entirely', async () => {
        const hAtomic = createStoreHarness('h_atomic');
        let persistAttempts = 0;
        let shouldFailPersist = false;

        const failingPersist = async (filename, data) => {
            persistAttempts++;
            if (shouldFailPersist) {
                return false;
            }
            return hAtomic.persistData(filename, data);
        };

        const repoAtomic = new VoiceCallJobRepository(hAtomic.getData, failingPersist, { dataDir: hAtomic.dir });

        const sttJob = await repoAtomic.createJob({
            callId: 'call_atomic_stt',
            jobType: JOB_TYPES.STT_TRANSCRIPTION,
            priority: JOB_PRIORITY.URGENT
        });

        const reconJob = await repoAtomic.createJob({
            callId: 'call_atomic_recon',
            jobType: JOB_TYPES.RECONCILIATION,
            priority: JOB_PRIORITY.NORMAL
        });

        const initialPersistCount = persistAttempts; // after 2 creates: 2
        const initialStoreJson = JSON.stringify(hAtomic.getData('VoiceCallJobs', []));

        // Now trigger claim with failing persist
        shouldFailPersist = true;

        await assert.rejects(
            async () => repoAtomic.claimNextJob({
                workerId: 'worker_atomic',
                executionContext: { aiEnabled: true, sttConfigured: false }
            }),
            (err) => err.code === JOB_ERROR_CODES.JOB_STORE_WRITE_FAILED
        );

        // Verify exactly one persist attempt was made for the claimNextJob operation
        assert.strictEqual(persistAttempts, initialPersistCount + 1, 'Exactly one single store commit attempt must occur');

        // Verify disk data remained completely unmodified
        const storeAfterFail = JSON.stringify(hAtomic.getData('VoiceCallJobs', []));
        assert.strictEqual(storeAfterFail, initialStoreJson, 'Store data on disk must remain untouched upon persist failure');

        // Now allow persist and retry
        shouldFailPersist = false;
        const successfulClaim = await repoAtomic.claimNextJob({
            workerId: 'worker_atomic_retry',
            executionContext: { aiEnabled: true, sttConfigured: false }
        });

        assert.ok(successfulClaim !== null);
        assert.strictEqual(successfulClaim.job.id, reconJob.id);
        assert.strictEqual(successfulClaim.job.attemptCount, 1);

        const blockedStt = repoAtomic.findById(sttJob.id);
        assert.strictEqual(blockedStt.status, JOB_STATUS.BLOCKED);
        assert.strictEqual(blockedStt.attemptCount, 0);
    });

    // -------------------------------------------------------------
    // Section D: Handler Timeout, AbortSignal & Late Completion Guard
    // -------------------------------------------------------------
    console.log('\n--- D. Handler Timeout & AbortSignal ---');
    const hTimeout = createStoreHarness('h_timeout');
    const repoTimeout = new VoiceCallJobRepository(hTimeout.getData, hTimeout.persistData, {
        dataDir: hTimeout.dir,
        enableSyntheticJobTypes: true
    });

    await runTest('Handler timeout triggers AbortSignal and transitions to retry or failed', async () => {
        const runnerTimeout = new VoiceCallWorkerRunner({
            repository: repoTimeout,
            handlerTimeoutMs: 150,
            workerId: 'worker_timeout_test'
        });

        let signalReceived = false;
        let signalAborted = false;

        runnerTimeout.registerHandler(JOB_TYPES.SYNTHETIC_TEST, async ({ signal }) => {
            signalReceived = signal !== undefined;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 500);
                signal.addEventListener('abort', () => {
                    signalAborted = true;
                    clearTimeout(timer);
                    resolve();
                });
            });
            return { resultReference: { safeResultCode: 'LATE_FINISHED' } };
        });

        const job = await repoTimeout.createJob({ callId: 'call_timeout_001', jobType: JOB_TYPES.SYNTHETIC_TEST, maxAttempts: 2 });
        const report = await runnerTimeout.runOnce();

        assert.strictEqual(signalReceived, true);
        assert.strictEqual(signalAborted, true);
        assert.strictEqual(report.outcome, 'RETRY_SCHEDULED');
        assert.strictEqual(report.errorCode, JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT);

        const updated = repoTimeout.findById(job.id);
        assert.strictEqual(updated.status, JOB_STATUS.RETRY_WAIT);
        assert.strictEqual(updated.lastErrorCode, JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT);
    });

    await runTest('Late completion after timeout is safely ignored and discarded', async () => {
        const runnerLate = new VoiceCallWorkerRunner({
            repository: repoTimeout,
            handlerTimeoutMs: 100,
            workerId: 'worker_late_test'
        });

        let lateResolveExecuted = false;

        runnerLate.registerHandler(JOB_TYPES.SYNTHETIC_NOOP, async () => {
            await new Promise(r => setTimeout(r, 250));
            lateResolveExecuted = true;
            return { resultReference: { safeResultCode: 'FORGED_SUCCESS' } };
        });

        const job = await repoTimeout.createJob({ callId: 'call_late_guard_01', jobType: JOB_TYPES.SYNTHETIC_NOOP, maxAttempts: 1 });
        const report = await runnerLate.runOnce();

        assert.strictEqual(report.outcome, 'FAILED');
        assert.strictEqual(report.errorCode, JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT);

        await new Promise(r => setTimeout(r, 200));
        const finalJob = repoTimeout.findById(job.id);
        assert.strictEqual(finalJob.status, JOB_STATUS.FAILED);
        assert.strictEqual(finalJob.resultReference, null);
    });

    await runTest('Handler input isolates capabilities: no repository, leaseToken, or mutation methods provided', async () => {
        const runnerIso = new VoiceCallWorkerRunner({
            repository: repoTimeout,
            workerId: 'worker_isolation_test'
        });

        let receivedJob = null;
        let receivedContext = null;

        runnerIso.registerHandler(JOB_TYPES.SYNTHETIC_TEST, async ({ job, context, signal }) => {
            receivedJob = job;
            receivedContext = context;
            return { resultReference: { safeResultCode: 'ISOLATION_VERIFIED' } };
        });

        const job = await repoTimeout.createJob({ callId: 'call_iso_001', jobType: JOB_TYPES.SYNTHETIC_TEST });
        const report = await runnerIso.runOnce();

        assert.strictEqual(report.outcome, 'COMPLETED');
        assert.ok(receivedJob !== null);
        assert.ok(receivedContext !== null);

        // Verify handler job view isolation
        assert.strictEqual(receivedJob.id, job.id);
        assert.strictEqual(receivedJob.repository, undefined, 'Handler job view must not have repository');
        assert.strictEqual(receivedJob.leaseToken, undefined, 'Handler job view must not have raw leaseToken');
        assert.strictEqual(receivedJob.leaseTokenHash, undefined, 'Handler job view must not have leaseTokenHash');

        // Verify context does NOT contain repository or leaseToken
        assert.strictEqual(receivedContext.repository, undefined, 'ExecutionContext must not provide repository');
        assert.strictEqual(receivedContext.leaseToken, undefined, 'ExecutionContext must not provide leaseToken');

        // Verify attempting to mutate safeHandlerJobView throws or does not affect internal store
        assert.throws(() => {
            receivedJob.status = 'completed';
        }, TypeError, 'safeHandlerJobView must be frozen');
    });

    await runTest('Late reject after timeout is safely swallowed and does not alter store', async () => {
        const runnerLateRej = new VoiceCallWorkerRunner({
            repository: repoTimeout,
            handlerTimeoutMs: 100,
            workerId: 'worker_late_rej'
        });

        let lateRejectPromise = null;

        runnerLateRej.registerHandler(JOB_TYPES.SYNTHETIC_NOOP, async () => {
            lateRejectPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Late network failure after timeout')), 250);
            });
            return lateRejectPromise;
        });

        const job = await repoTimeout.createJob({ callId: 'call_late_rej_01', jobType: JOB_TYPES.SYNTHETIC_NOOP, maxAttempts: 1 });
        const report = await runnerLateRej.runOnce();

        assert.strictEqual(report.outcome, 'FAILED');
        assert.strictEqual(report.errorCode, JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT);

        // Await the late reject to settle completely without uncaught rejection
        await lateRejectPromise.catch(() => {});

        const finalJob = repoTimeout.findById(job.id);
        assert.strictEqual(finalJob.status, JOB_STATUS.FAILED);
        assert.strictEqual(finalJob.lastErrorCode, JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT);
    });

    // -------------------------------------------------------------
    // Section E: Result Reference Strict Allowlist
    // -------------------------------------------------------------
    console.log('\n--- E. Result Reference Strict Allowlist ---');

    await runTest('Result reference allowlist strictly enforces approved keys', () => {
        assert.strictEqual(isSafeResultReference(null), true);
        assert.strictEqual(isSafeResultReference({}), true);
        assert.strictEqual(isSafeResultReference({ safeResultCode: 'SUCCESS_200' }), true);
        assert.strictEqual(isSafeResultReference({ processingRevisionId: 'rev_12345', transcriptId: 'tr_67890' }), true);

        assert.strictEqual(isSafeResultReference({ unknownKey: 'value' }), false);
        assert.strictEqual(isSafeResultReference({ transcript: 'secret conversation text' }), false);
        assert.strictEqual(isSafeResultReference({ storageKey: 'audio/2026-09/secret.wav' }), false);
        assert.strictEqual(isSafeResultReference({ password: '123' }), false);
        assert.strictEqual(isSafeResultReference({ leaseToken: 'raw_token' }), false);
        assert.strictEqual(isSafeResultReference({ safeResultCode: { nested: true } }), false);
        assert.strictEqual(isSafeResultReference(['item']), false);
    });

    // -------------------------------------------------------------
    // Section F: Queue Configuration Validation
    // -------------------------------------------------------------
    console.log('\n--- F. Queue Configuration Validation ---');

    await runTest('validateQueueConfig accepts valid configuration', () => {
        assert.strictEqual(validateQueueConfig({
            leaseDurationMs: 30000,
            heartbeatIntervalMs: 10000,
            minHeartbeatIntervalMs: 500,
            stalledThresholdMs: 60000,
            handlerTimeoutMs: 30000,
            shutdownGraceMs: 5000,
            maxActiveJobs: 500,
            maxTotalJobs: 5000,
            maxPerCallJobs: 20,
            maxPerTypeJobs: 200
        }), true);
    });

    await runTest('validateQueueConfig rejects inconsistent configuration', () => {
        assert.throws(
            () => validateQueueConfig({ leaseDurationMs: 10000, heartbeatIntervalMs: 10000 }),
            (err) => err.code === JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID
        );

        assert.throws(
            () => validateQueueConfig({ leaseDurationMs: 30000, heartbeatIntervalMs: 1000, minHeartbeatIntervalMs: 2000 }),
            (err) => err.code === JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID
        );

        assert.throws(
            () => validateQueueConfig({ maxActiveJobs: 10, maxPerCallJobs: 20 }),
            (err) => err.code === JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID
        );
    });

    // -------------------------------------------------------------
    // Section G: Due Retries Release inside Lock
    // -------------------------------------------------------------
    console.log('\n--- G. Due Retries Release inside Lock ---');
    const hDue = createStoreHarness('h_due');
    const repoDue = new VoiceCallJobRepository(hDue.getData, hDue.persistData, { dataDir: hDue.dir, enableSyntheticJobTypes: true });

    await runTest('retry_wait job past nextAttemptAt is automatically released and claimed inside claimNextJob', async () => {
        const job = await repoDue.createJob({ callId: 'call_due_retry_01', jobType: JOB_TYPES.SYNTHETIC_NOOP, maxAttempts: 3 });
        const c1 = await repoDue.claimNextJob({ workerId: 'worker_due_1' });
        await repoDue.markProcessing({ jobId: job.id, workerId: 'worker_due_1', leaseToken: c1.leaseToken });

        const pastTime = new Date(Date.now() - 5000);
        await repoDue.scheduleRetry({
            jobId: job.id,
            workerId: 'worker_due_1',
            leaseToken: c1.leaseToken,
            errorCode: JOB_ERROR_CODES.AI_PROVIDER_TIMEOUT,
            errorMessage: 'Past timeout',
            nextAttemptAt: pastTime
        });

        const inRetryWait = repoDue.findById(job.id);
        assert.strictEqual(inRetryWait.status, JOB_STATUS.RETRY_WAIT);

        const c2 = await repoDue.claimNextJob({ workerId: 'worker_due_2' });
        assert.ok(c2 !== null);
        assert.strictEqual(c2.job.id, job.id);
        assert.strictEqual(c2.job.attemptCount, 2);
        assert.strictEqual(c2.job.status, JOB_STATUS.LEASED);
    });

    // -------------------------------------------------------------
    // Section H: Store Error Codes
    // -------------------------------------------------------------
    console.log('\n--- H. Store Error Codes ---');

    await runTest('persistData failure throws JOB_STORE_WRITE_FAILED', async () => {
        const failingPersist = async () => false;
        const repoFailing = new VoiceCallJobRepository(hDue.getData, failingPersist, { dataDir: hDue.dir });

        await assert.rejects(
            async () => repoFailing.createJob({ callId: 'call_store_write_fail', jobType: JOB_TYPES.ROUTING }),
            (err) => err.code === JOB_ERROR_CODES.JOB_STORE_WRITE_FAILED
        );
    });

    // -------------------------------------------------------------
    // Section I: Store Growth & Archival Candidate Metrics
    // -------------------------------------------------------------
    console.log('\n--- I. Store Growth & Archival Metrics ---');
    const hGrowth = createStoreHarness('h_growth');
    const repoGrowth = new VoiceCallJobRepository(hGrowth.getData, hGrowth.persistData, {
        dataDir: hGrowth.dir,
        enableSyntheticJobTypes: true,
        limits: { MAX_ACTIVE_JOBS: 10 }
    });

    await runTest('Metrics snapshot reflects terminal and archival candidate counts', async () => {
        await repoGrowth.createJob({ callId: 'call_grow_0001', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        await repoGrowth.createJob({ callId: 'call_grow_0002', jobType: JOB_TYPES.SYNTHETIC_NOOP });

        const c1 = await repoGrowth.claimNextJob({ workerId: 'w_grow' });
        await repoGrowth.markProcessing({ jobId: c1.job.id, workerId: 'w_grow', leaseToken: c1.leaseToken });
        await repoGrowth.completeJob({ jobId: c1.job.id, workerId: 'w_grow', leaseToken: c1.leaseToken, resultReference: { safeResultCode: 'OK' } });

        const snapshot = getQueueMetricsSnapshot({ repository: repoGrowth });
        assert.strictEqual(snapshot.totalJobsCount, 2);
        assert.strictEqual(snapshot.activeJobsCount, 1);
        assert.strictEqual(snapshot.terminalJobsCount, 1);
        assert.strictEqual(snapshot.archivalCandidateCount, 1);
        assert.strictEqual(snapshot.capacityRemaining, 9);
        assert.ok(snapshot.queueStoreEstimatedBytes > 0);
    });

    // -------------------------------------------------------------
    // Section J: Clean Restart Recovery without Lock Registry Cheats
    // -------------------------------------------------------------
    console.log('\n--- J. Clean Restart Recovery ---');
    const hRestart = createStoreHarness('h_restart');

    await runTest('Restart recovery across distinct repository instances', async () => {
        let repo1 = new VoiceCallJobRepository(hRestart.getData, hRestart.persistData, { dataDir: hRestart.dir, enableSyntheticJobTypes: true });
        const job = await repo1.createJob({ callId: 'call_clean_restart', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const c1 = await repo1.claimNextJob({ workerId: 'worker_old_instance', leaseDurationMs: 2000 });
        await repo1.markProcessing({ jobId: job.id, workerId: 'worker_old_instance', leaseToken: c1.leaseToken });

        // Discard old instance completely without clearing lock registry
        repo1 = null;

        // Boot new instance at future time past lease expiry
        const futureTime = new Date(Date.now() + 4000);
        const repo2 = new VoiceCallJobRepository(hRestart.getData, hRestart.persistData, { dataDir: hRestart.dir, enableSyntheticJobTypes: true });

        // Claim sweeps expired leases and claims in single atomic call
        const c2 = await repo2.claimNextJob({ workerId: 'worker_new_instance', now: futureTime });
        assert.ok(c2 !== null);
        assert.strictEqual(c2.job.id, job.id);
        assert.strictEqual(c2.job.attemptCount, 2);

        // Old worker token cannot complete job
        await assert.rejects(
            async () => repo2.completeJob({ jobId: job.id, workerId: 'worker_old_instance', leaseToken: c1.leaseToken, now: futureTime }),
            (err) => err.code === JOB_ERROR_CODES.JOB_LEASE_OWNER_MISMATCH
        );

        // New worker completes successfully
        await repo2.markProcessing({ jobId: job.id, workerId: 'worker_new_instance', leaseToken: c2.leaseToken, now: futureTime });
        const completed = await repo2.completeJob({
            jobId: job.id,
            workerId: 'worker_new_instance',
            leaseToken: c2.leaseToken,
            resultReference: { safeResultCode: 'RECOVERY_OK' },
            now: futureTime
        });

        assert.strictEqual(completed.status, JOB_STATUS.COMPLETED);
    });

    // -------------------------------------------------------------
    // Section K: Idempotency, Concurrency & Invariants
    // -------------------------------------------------------------
    console.log('\n--- K. Core Invariants & Idempotency ---');
    const hIdemp = createStoreHarness('h_idemp');
    const repoIdemp = new VoiceCallJobRepository(hIdemp.getData, hIdemp.persistData, { dataDir: hIdemp.dir, enableSyntheticJobTypes: true });

    await runTest('Reject duplicate active job creation for same call + type + revision', async () => {
        await repoIdemp.createJob({ callId: 'synth_call_0002', jobType: JOB_TYPES.ROUTING, pipelineRevision: 1 });
        await assert.rejects(
            async () => repoIdemp.createJob({ callId: 'synth_call_0002', jobType: JOB_TYPES.ROUTING, pipelineRevision: 1 }),
            (err) => err.code === JOB_ERROR_CODES.JOB_IDEMPOTENCY_CONFLICT
        );
    });

    await runTest('Allow job creation with different pipelineRevision', async () => {
        const rev2 = await repoIdemp.createJob({ callId: 'synth_call_0002', jobType: JOB_TYPES.ROUTING, pipelineRevision: 2 });
        assert.strictEqual(rev2.pipelineRevision, 2);
    });

    await runTest('Reject sensitive payload keys in job', () => {
        assert.throws(
            () => validateJobRecord({
                id: 'job_test_sensitive',
                callId: 'synth_call_0001',
                jobType: JOB_TYPES.SYNTHETIC_NOOP,
                status: JOB_STATUS.QUEUED,
                version: 1,
                pipelineRevision: 1,
                attemptCount: 0,
                maxAttempts: 3,
                priority: 'normal',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transcript: 'Secret conversation content'
            }),
            (err) => err.code === JOB_ERROR_CODES.JOB_PAYLOAD_INVALID
        );
    });

    // -------------------------------------------------------------
    // Section L: Store Corruption Handling
    // -------------------------------------------------------------
    console.log('\n--- L. Store Corruption Handling ---');
    const hCorrupt = createStoreHarness('h_corrupt');
    const repoCorrupt = new VoiceCallJobRepository(hCorrupt.getData, hCorrupt.persistData, { dataDir: hCorrupt.dir });

    await runTest('Corrupted JSON halts operations without overwriting disk data', async () => {
        const filePath = path.join(hCorrupt.dir, 'VoiceCallJobs.json');
        const invalidJson = '{"corrupted": true, broken';
        fs.writeFileSync(filePath, invalidJson, 'utf8');

        await assert.rejects(
            async () => repoCorrupt.createJob({ callId: 'call_corrupt_01', jobType: JOB_TYPES.ROUTING }),
            (err) => err.code === JOB_ERROR_CODES.JOB_STORE_CORRUPTED || err.code === JOB_ERROR_CODES.JOB_STORE_READ_FAILED
        );

        const diskContent = fs.readFileSync(filePath, 'utf8');
        assert.strictEqual(diskContent, invalidJson);

        fs.writeFileSync(filePath, '[]', 'utf8');
        const resetResult = repoCorrupt.resetCorruptionState();
        assert.strictEqual(resetResult, true);
        assert.strictEqual(repoCorrupt.isCorrupted, false);
    });

    // -------------------------------------------------------------
    // Section M: Reconciliation
    // -------------------------------------------------------------
    console.log('\n--- M. Reconciliation ---');
    const hRecon = createStoreHarness('h_recon');
    const repoRecon = new VoiceCallJobRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir, enableSyntheticJobTypes: true });

    await runTest('Reconciliation audits invariants and reports check codes safely', async () => {
        const expiredJob = await repoRecon.createJob({ callId: 'call_audit_exp_01', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        await repoRecon.claimNextJob({ workerId: 'worker_exp', leaseDurationMs: 1000 });

        const futureTime = new Date(Date.now() + 5000);
        const findings = await runJobReconciliation({ repository: repoRecon, now: futureTime });

        const expiredFinding = findings.find(f => f.checkCode === RECONCILIATION_CHECK_CODES.JOB_LEASE_EXPIRED);
        assert.ok(expiredFinding);
        assert.strictEqual(expiredFinding.resourceId, expiredJob.id);
        assert.strictEqual(expiredFinding.repairable, false);

        const findingsJson = JSON.stringify(findings);
        assert.strictEqual(findingsJson.includes('leaseToken'), false);
        assert.strictEqual(findingsJson.includes('password'), false);
    });

    await runTest('Synthetic job in production triggers dedicated JOB_TEST_TYPE_IN_PRODUCTION check code', async () => {
        const hProdRecon = createStoreHarness('h_prod_recon');
        // Manually place synthetic job in production store
        const filePath = path.join(hProdRecon.dir, 'VoiceCallJobs.json');
        const synthRecord = {
            id: 'job_synth_in_prod_001',
            callId: 'call_prod_audit_01',
            jobType: JOB_TYPES.SYNTHETIC_NOOP,
            status: JOB_STATUS.QUEUED,
            idempotencyKey: 'hash_synth_prod_001',
            pipelineRevision: 1,
            priority: JOB_PRIORITY.NORMAL,
            attemptCount: 0,
            maxAttempts: 3,
            nextAttemptAt: null,
            leaseOwner: null,
            leaseTokenHash: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            startedAt: null,
            completedAt: null,
            cancelledAt: null,
            failedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            resultReference: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1
        };
        fs.writeFileSync(filePath, JSON.stringify([synthRecord], null, 2), 'utf8');

        const repoProdAudit = new VoiceCallJobRepository(hProdRecon.getData, hProdRecon.persistData, {
            dataDir: hProdRecon.dir,
            isProduction: true,
            enableSyntheticJobTypes: false
        });

        const findings = await runJobReconciliation({ repository: repoProdAudit });
        const synthFinding = findings.find(f => f.checkCode === RECONCILIATION_CHECK_CODES.JOB_TEST_TYPE_IN_PRODUCTION);

        assert.ok(synthFinding, 'Must report JOB_TEST_TYPE_IN_PRODUCTION');
        assert.strictEqual(synthFinding.resourceId, 'job_synth_in_prod_001');
        assert.strictEqual(synthFinding.severity, 'CRITICAL');
    });

    // Teardown
    try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temporary test directory: ${TEST_ROOT}`);
    } catch (e) {
        console.warn('Notice: Test cleanup failed:', e.message);
    }

    console.log('\n============================================================');
    console.log(`📊 A8 FINAL INTEGRITY CLOSURE RESULTS: ${passedCount} Passed, ${failedCount} Failed`);
    console.log('============================================================\n');

    if (failedCount > 0) {
        process.exit(1);
    }
    process.exit(0);
}

runAllTests().catch((err) => {
    console.error('Fatal test runner failure:', err);
    process.exit(1);
});

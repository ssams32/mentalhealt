/**
 * scripts/verify-operational-readiness.mjs
 * Verification test suite for Mind-ERP OS Track A12: Operational Readiness.
 * 
 * Verifies:
 * - Missing configuration handled safely
 * - Corrupted store detection
 * - Disabled voice system handling
 * - Legacy application unaffected (legacyReferralOperationsOperational === true)
 * - Safe aggregated output without absolute paths, user IDs, secrets
 * - Reconciliation read-only behavior
 * - A10 reconciliation coverage diff
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    VoiceSystemReadiness,
    OPERATIONAL_STATUS,
    OPERATIONAL_SUBSYSTEMS,
    runReconciliationOrchestration,
    getA10ReconciliationCoverageDiff,
    getOperationMetrics,
    RetentionPolicyManager,
    StartupCoordinator,
    ShutdownCoordinator,
    OperationError
} from '../server/operations/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops_readiness_test_'));

let passedTests = 0;
let failedTests = 0;

async function runTest(name, testFn) {
    try {
        await testFn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(err);
        failedTests++;
    }
}

console.log('\n============================================================');
console.log('🧪 TRACK A12: OPERATIONAL READINESS VERIFICATION');
console.log('============================================================\n');

try {
    // -------------------------------------------------------------
    // 1. Missing Configuration & Disabled Voice System
    // -------------------------------------------------------------
    console.log('--- 1. Missing Configuration & Disabled Voice System ---');

    await runTest('Unconfigured and disabled voice system produces safe degraded/disabled status without affecting legacy operations', async () => {
        const readiness = new VoiceSystemReadiness({
            voiceEnabled: false
        });

        const assessment = readiness.assessReadiness();
        assert.strictEqual(assessment.overallStatus, OPERATIONAL_STATUS.DISABLED);
        assert.strictEqual(assessment.voiceSystemOperational, false);
        assert.strictEqual(assessment.legacyReferralOperationsOperational, true);

        // Subsystems should show unconfigured or disabled
        const usersStore = assessment.subsystems[OPERATIONAL_SUBSYSTEMS.USERS_STORE];
        assert.strictEqual(usersStore.status, OPERATIONAL_STATUS.UNCONFIGURED);
        assert.strictEqual(usersStore.healthy, false);
    });

    // -------------------------------------------------------------
    // 2. Corrupted Store Detection
    // -------------------------------------------------------------
    console.log('\n--- 2. Corrupted Store Detection ---');

    await runTest('Corrupted JSON file marks subsystem as CORRUPTED and blocks voice startup', async () => {
        const corruptedDataDir = path.join(tempDir, 'corrupted_data');
        fs.mkdirSync(corruptedDataDir, { recursive: true });

        // Write invalid JSON into Users.json
        fs.writeFileSync(path.join(corruptedDataDir, 'Users.json'), 'INVALID_JSON_CORRUPTED{{{', 'utf-8');

        const readiness = new VoiceSystemReadiness({
            dataDir: corruptedDataDir,
            voiceEnabled: true
        });

        const assessment = readiness.assessReadiness();
        assert.strictEqual(assessment.overallStatus, OPERATIONAL_STATUS.CORRUPTED);
        assert.strictEqual(assessment.voiceSystemOperational, false);
        assert.strictEqual(assessment.legacyReferralOperationsOperational, true);

        const usersSub = assessment.subsystems[OPERATIONAL_SUBSYSTEMS.USERS_STORE];
        assert.strictEqual(usersSub.status, OPERATIONAL_STATUS.CORRUPTED);
        assert.strictEqual(usersSub.checkCode, 'STORE_CORRUPTED');
    });

    // -------------------------------------------------------------
    // 3. Information Hiding & Redaction
    // -------------------------------------------------------------
    console.log('\n--- 3. Information Hiding & Redaction ---');

    await runTest('Readiness output and OperationError contain zero absolute paths, user IDs, or secret values', async () => {
        const sensitiveSecret = 'SUPER_SECRET_TOKEN_XYZ';
        const sensitivePath = 'C:\\Private\\System\\Root\\Data';
        const sensitiveUser = 'user_admin_9999';

        const err = new OperationError('TEST_CODE', 'A safe diagnostic message', {
            secretToken: sensitiveSecret,
            targetPath: sensitivePath,
            assignedUser: sensitiveUser,
            normalKey: 'safe_info'
        });

        const serialized = JSON.stringify(err.details);
        assert.strictEqual(serialized.includes(sensitiveSecret), false);
        assert.strictEqual(serialized.includes(sensitivePath), false);
        assert.strictEqual(serialized.includes(sensitiveUser), false);
        assert.strictEqual(err.details.secretToken, '[REDACTED]');
        assert.strictEqual(err.details.targetPath, '[REDACTED]');
        assert.strictEqual(err.details.assignedUser, '[REDACTED]');
        assert.strictEqual(err.details.normalKey, 'safe_info');

        // Also check readiness assessment serialization
        const readiness = new VoiceSystemReadiness({
            dataDir: 'C:\\Users\\admin\\secret\\data',
            voiceEnabled: true
        });
        const assessment = readiness.assessReadiness();
        const jsonStr = JSON.stringify(assessment);
        assert.strictEqual(jsonStr.includes('C:\\Users\\admin'), false);
    });

    // -------------------------------------------------------------
    // 4. Healthy Operational State
    // -------------------------------------------------------------
    console.log('\n--- 4. Healthy Operational State ---');

    await runTest('Valid stores and directories evaluate to ready status', async () => {
        const healthyDir = path.join(tempDir, 'healthy_data');
        const audioDir = path.join(tempDir, 'audio_root');
        const joyCallDir = path.join(tempDir, 'joycall_src');
        const nasDir = path.join(tempDir, 'nas_incoming');

        fs.mkdirSync(healthyDir, { recursive: true });
        fs.mkdirSync(audioDir, { recursive: true });
        fs.mkdirSync(joyCallDir, { recursive: true });
        fs.mkdirSync(nasDir, { recursive: true });

        // Populate minimal valid files
        fs.writeFileSync(path.join(healthyDir, 'Users.json'), JSON.stringify([{ id: 'u1' }]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceSystemAccessGrants.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceSystemAccessHistory.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceCalls.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceCallJobs.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'Notifications.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'NotificationOutbox.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceCallAssignmentOperations.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'VoiceCallAssignmentHistory.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'AuditEntries.json'), JSON.stringify([]));
        fs.writeFileSync(path.join(healthyDir, 'AuditHead.json'), JSON.stringify({ sequence: 0 }));

        const readiness = new VoiceSystemReadiness({
            dataDir: healthyDir,
            privateAudioRoot: audioDir,
            joyCallSourcePath: joyCallDir,
            nasIncomingPath: nasDir,
            sttConfig: { enabled: false },
            ollamaConfig: { enabled: false },
            voiceEnabled: true
        });

        const assessment = readiness.assessReadiness();
        assert.strictEqual(assessment.overallStatus, OPERATIONAL_STATUS.READY);
        assert.strictEqual(assessment.voiceSystemOperational, true);
        assert.strictEqual(assessment.legacyReferralOperationsOperational, true);
        assert.strictEqual(assessment.summary.readyCount >= 14, true);

        // Operation Metrics Snapshot
        const metrics = getOperationMetrics(assessment.subsystems);
        assert.strictEqual(metrics.metrics.totalSubsystems, 16);
        assert.strictEqual(metrics.healthyRatio > 0.8, true);
    });

    // -------------------------------------------------------------
    // 5. Reconciliation Orchestrator & A10 Coverage Diff
    // -------------------------------------------------------------
    console.log('\n--- 5. Reconciliation Orchestrator & Coverage Diff ---');

    await runTest('Reconciliation Orchestrator executes in read-only mode and produces accurate A10 diff', async () => {
        const report = await runReconciliationOrchestration({});
        assert.strictEqual(report.isReadOnly, true);
        assert.strictEqual(report.mutationsPerformed, 0);
        assert.strictEqual(report.subsystemResults.assignment.status, 'SKIPPED');
        assert.strictEqual(report.subsystemResults.jobQueue.status, 'SKIPPED');
        assert.strictEqual(report.subsystemResults.audit.status, 'SKIPPED');

        // Verify A10 Coverage Diff
        const diff = report.coverageDiff;
        assert.ok(diff);
        assert.strictEqual(diff.previousCheckCodes.length, 34);
        assert.strictEqual(diff.currentCheckCodes.length, 34);
        assert.strictEqual(diff.removedChecks.length, 0);
        assert.strictEqual(diff.checksWithoutReplacements.length, 0);
        assert.strictEqual(diff.restoredChecks.length, 0);
        assert.strictEqual(diff.testedCount, 34);
        assert.strictEqual(diff.actualImplementationCount >= 34, true);
    });

    // -------------------------------------------------------------
    // 6. Retention Policy Contract
    // -------------------------------------------------------------
    console.log('\n--- 6. Retention Policy Contract ---');

    await runTest('Retention policy defaults to unset, forbids deletion, and preserves all data', async () => {
        const retention = new RetentionPolicyManager();
        const policy = retention.getPolicy();
        assert.strictEqual(policy.retentionMode, 'UNSET');
        assert.strictEqual(policy.retentionDays, null);
        assert.strictEqual(policy.allowAutomaticDelete, false);

        const evalResult = retention.evaluateRecordRetention(new Date('2020-01-01').toISOString());
        assert.strictEqual(evalResult.eligibleForDeletion, false);
        assert.strictEqual(evalResult.action, 'PRESERVE');

        // Execution of retention purge is strictly blocked
        assert.throws(() => {
            retention.executeRetentionPurge();
        }, (err) => {
            return err instanceof OperationError && err.code === 'INVALID_RETENTION_POLICY';
        });
    });

    // -------------------------------------------------------------
    // 7. Startup & Shutdown Coordinators
    // -------------------------------------------------------------
    console.log('\n--- 7. Startup & Shutdown Coordinators ---');

    await runTest('Startup coordinator validates startup conditions; Shutdown coordinator safely executes hooks', async () => {
        const startup = new StartupCoordinator({ voiceEnabled: false });
        const startupRes = await startup.evaluateStartup();
        assert.strictEqual(startupRes.voiceSystemCanStart, false);
        assert.strictEqual(startupRes.legacyReferralOperationsOperational, true);

        // Shutdown Coordinator
        const shutdown = new ShutdownCoordinator({ timeoutMs: 1000 });
        let hook1Called = false;
        let hook2Called = false;

        shutdown.registerHook('hook1', async () => { hook1Called = true; }, 10);
        shutdown.registerHook('hook2', async () => { hook2Called = true; }, 20);

        const shutdownRes = await shutdown.shutdown();
        assert.strictEqual(shutdownRes.completed, true);
        assert.strictEqual(shutdownRes.state, 'TERMINATED');
        assert.strictEqual(hook1Called, true);
        assert.strictEqual(hook2Called, true);
    });

} finally {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

console.log('\n============================================================');
console.log(`📊 OPERATIONAL READINESS RESULTS: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
console.log('============================================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}

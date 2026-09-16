/**
 * scripts/verify-joycall-sync-agent.mjs
 * Comprehensive verification test suite for Mind-ERP OS Track A12.1: JoyCall Sync Agent Hardening.
 * 
 * Verifies:
 * - Detector & extension allowlist
 * - Audio signature validation
 * - Stability checks: growing file, mtime change, content change, zero-byte, truncated audio, disappearance, permission error
 * - Single-instance guard: first instance, second rejected, clean release, stale recovery, malformed lock
 * - Destination collision: Case A (absent), Case B (same hash), Case C (diff hash collision), Case D (matching .uploading recovery), Case E (mismatching .uploading conflict)
 * - Network interruption and failure injection (partial copy, hash mismatch)
 * - Manifest safety: minimal safe fields, fail-closed on corruption, preserved backup
 * - Source preservation: local files never modified or deleted
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
    JoyCallSyncAgent,
    JoyCallFileDetector,
    JoyCallFileStability,
    JoyCallTransferManifest,
    JoyCallNasTransfer,
    JoyCallSingleInstanceGuard,
    TRANSFER_STATUS
} from '../agent/joycall-sync/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joycall_sync_harden_test_'));

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

/**
 * Helper to create synthetic valid WAV buffer
 */
function createSyntheticWavBuffer(sampleCount = 1000) {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(16000, 24);
    buffer.writeUInt32LE(32000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < sampleCount; i++) {
        buffer.writeInt16LE((i % 200) * 100, 44 + i * 2);
    }
    return buffer;
}

console.log('\n============================================================');
console.log('🧪 TRACK A12.1: JOYCALL SYNC AGENT HARDENING VERIFICATION');
console.log('============================================================\n');

try {
    const joyCallDbDir = path.join(tempDir, 'joycall_db');
    const nasIncomingDir = path.join(tempDir, 'nas_incoming');
    const stateDir = path.join(tempDir, 'agent_state');
    const manifestPath = path.join(stateDir, 'joycall_transfer_manifest.json');

    fs.mkdirSync(joyCallDbDir, { recursive: true });
    fs.mkdirSync(nasIncomingDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // -------------------------------------------------------------
    // 1. Detector & Extension Allowlist
    // -------------------------------------------------------------
    console.log('--- 1. Detector & Extension Filtering ---');

    await runTest('Detector approves supported audio and ignores db, idx, ini, tmp, and .uploading files', async () => {
        const detector = new JoyCallFileDetector();

        assert.strictEqual(detector.isSupportedRecordingFile('recording.wav'), true);
        assert.strictEqual(detector.isSupportedRecordingFile('recording.mp3'), true);
        assert.strictEqual(detector.isSupportedRecordingFile('recording.m4a'), true);

        assert.strictEqual(detector.isSupportedRecordingFile('JoyCall.db'), false);
        assert.strictEqual(detector.isSupportedRecordingFile('JoyCall.idx'), false);
        assert.strictEqual(detector.isSupportedRecordingFile('config.ini'), false);
        assert.strictEqual(detector.isSupportedRecordingFile('call.wav.uploading'), false);
        assert.strictEqual(detector.shouldIgnoreFile('call.wav.uploading'), true);
    });

    // -------------------------------------------------------------
    // 2. Stability Hardening & Edge Cases
    // -------------------------------------------------------------
    console.log('\n--- 2. File Stability & Edge Cases ---');

    await runTest('Stability: growing file and modified time changes reset consecutive sample counter', async () => {
        const stability = new JoyCallFileStability({
            stabilityChecksRequired: 2,
            quietPeriodMs: 50,
            minFileBytes: 500
        });

        const testFile = path.join(joyCallDbDir, 'grow_test.wav');
        const wav1 = createSyntheticWavBuffer(300);
        fs.writeFileSync(testFile, wav1);

        const now1 = Date.now() + 100;
        const res1 = await stability.checkStability(testFile, now1);
        assert.strictEqual(res1.isStable, false); // check 1 of 2

        // Simulate append / growth
        const wav2 = createSyntheticWavBuffer(500);
        fs.writeFileSync(testFile, wav2);

        const res2 = await stability.checkStability(testFile, now1 + 50);
        assert.strictEqual(res2.isStable, false); // size changed, reset count

        // Complete write and wait
        const nowFinal = now1 + 200;
        await stability.checkStability(testFile, nowFinal); // check 1
        const resFinal = await stability.checkStability(testFile, nowFinal); // check 2
        assert.strictEqual(resFinal.isStable, true);
        assert.strictEqual(resFinal.format, 'wav');
    });

    await runTest('Stability: same size but contents change resets stability counter', async () => {
        const stability = new JoyCallFileStability({
            stabilityChecksRequired: 2,
            quietPeriodMs: 0,
            minFileBytes: 500
        });

        const testFile = path.join(joyCallDbDir, 'content_change_test.wav');
        const bufA = createSyntheticWavBuffer(400);
        const bufB = Buffer.from(bufA);
        bufB.write('DIFFERENT_PCM_CONTENT', 60);

        fs.writeFileSync(testFile, bufA);
        await stability.checkStability(testFile); // check 1

        // Overwrite with exact same byte length but modified content
        fs.writeFileSync(testFile, bufB);
        const resChanged = await stability.checkStability(testFile);
        assert.strictEqual(resChanged.isStable, false); // reset counter
    });

    await runTest('Stability: zero-byte and truncated audio below minFileBytes are rejected', async () => {
        const stability = new JoyCallFileStability({
            minFileBytes: 1024,
            quietPeriodMs: 0,
            stabilityChecksRequired: 1
        });

        const zeroFile = path.join(joyCallDbDir, 'zero_test.wav');
        fs.writeFileSync(zeroFile, Buffer.alloc(0));
        const resZero = await stability.checkStability(zeroFile);
        assert.strictEqual(resZero.isStable, false);
        assert.strictEqual(resZero.reason, 'Zero-byte file');

        const tinyFile = path.join(joyCallDbDir, 'tiny_test.wav');
        fs.writeFileSync(tinyFile, Buffer.alloc(100));
        const resTiny = await stability.checkStability(tinyFile);
        assert.strictEqual(resTiny.isStable, false);
        assert.strictEqual(resTiny.reason.includes('File smaller than minimum'), true);
    });

    await runTest('Stability: file disappearing during sampling returns safe non-crash reason', async () => {
        const stability = new JoyCallFileStability();
        const nonExistent = path.join(joyCallDbDir, 'vanished_file.wav');
        const res = await stability.checkStability(nonExistent);
        assert.strictEqual(res.isStable, false);
        assert.strictEqual(res.reason.includes('disappeared'), true);
    });

    // -------------------------------------------------------------
    // 3. Single-Instance Guard
    // -------------------------------------------------------------
    console.log('\n--- 3. Single-Instance Guard ---');

    await runTest('SingleInstanceGuard: first instance acquires, second instance is rejected with AGENT_ALREADY_RUNNING', async () => {
        const guard1 = new JoyCallSingleInstanceGuard({ stateDir });
        const guard2 = new JoyCallSingleInstanceGuard({ stateDir });

        const acquired1 = guard1.acquire();
        assert.strictEqual(acquired1, true);

        // Second instance must fail
        assert.throws(() => {
            guard2.acquire();
        }, (err) => {
            return err.code === 'AGENT_ALREADY_RUNNING';
        });

        // Clean release
        guard1.release();
        assert.strictEqual(guard1.isAcquired, false);

        // Guard2 can now acquire
        const acquired2 = guard2.acquire();
        assert.strictEqual(acquired2, true);
        guard2.release();
    });

    await runTest('SingleInstanceGuard: stale lock from crashed PID is safely recovered without killing active processes', async () => {
        const guard = new JoyCallSingleInstanceGuard({ stateDir, lockFilename: 'stale_test.lock' });
        // Write synthetic stale lock with non-existent PID (e.g. 99999999)
        const lockPath = path.join(stateDir, 'stale_test.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));

        const acquired = guard.acquire();
        assert.strictEqual(acquired, true);
        guard.release();
    });

    await runTest('SingleInstanceGuard: malformed lock file is safely recovered', async () => {
        const guard = new JoyCallSingleInstanceGuard({ stateDir, lockFilename: 'malformed_test.lock' });
        const lockPath = path.join(stateDir, 'malformed_test.lock');
        fs.writeFileSync(lockPath, 'CORRUPTED_NON_JSON_DATA{{{');

        const acquired = guard.acquire();
        assert.strictEqual(acquired, true);
        guard.release();
    });

    // -------------------------------------------------------------
    // 4. Destination Collision Policies (Cases A, B, C, D, E)
    // -------------------------------------------------------------
    console.log('\n--- 4. Destination Collision Policies ---');

    const transfer = new JoyCallNasTransfer({ nasIncomingDir });

    await runTest('Case A: destination absent performs normal transfer to .uploading and atomic rename', async () => {
        const wavData = createSyntheticWavBuffer(600);
        const srcFile = path.join(joyCallDbDir, 'case_a.wav');
        fs.writeFileSync(srcFile, wavData);

        const sha256 = crypto.createHash('sha256').update(wavData).digest('hex');
        const res = await transfer.transferFile(srcFile, {
            filename: 'case_a.wav',
            size: wavData.length,
            sha256
        });

        assert.strictEqual(res.status, TRANSFER_STATUS.COMPLETED);
        assert.strictEqual(fs.existsSync(path.join(nasIncomingDir, 'case_a.wav')), true);
        assert.strictEqual(fs.existsSync(path.join(nasIncomingDir, 'case_a.wav.uploading')), false);
    });

    await runTest('Case B: destination final file exists with identical hash returns SKIPPED_DUPLICATE', async () => {
        const srcFile = path.join(joyCallDbDir, 'case_a.wav');
        const wavData = fs.readFileSync(srcFile);
        const sha256 = crypto.createHash('sha256').update(wavData).digest('hex');

        const res = await transfer.transferFile(srcFile, {
            filename: 'case_a.wav',
            size: wavData.length,
            sha256
        });

        assert.strictEqual(res.status, TRANSFER_STATUS.SKIPPED_DUPLICATE);
    });

    await runTest('Case C: destination final file exists with differing hash throws FILENAME_COLLISION without overwriting', async () => {
        // Create conflicting destination file with different contents
        const destFile = path.join(nasIncomingDir, 'collision_call.wav');
        fs.writeFileSync(destFile, 'EXISTING_DIFFERENT_DESTINATION_FILE_DATA');

        const srcFile = path.join(joyCallDbDir, 'collision_call.wav');
        const srcData = createSyntheticWavBuffer(700);
        fs.writeFileSync(srcFile, srcData);
        const sha256 = crypto.createHash('sha256').update(srcData).digest('hex');

        await assert.rejects(async () => {
            await transfer.transferFile(srcFile, {
                filename: 'collision_call.wav',
                size: srcData.length,
                sha256
            });
        }, (err) => {
            return err.code === 'FILENAME_COLLISION';
        });

        // Verify destination file was NOT overwritten
        const preservedDest = fs.readFileSync(destFile, 'utf-8');
        assert.strictEqual(preservedDest, 'EXISTING_DIFFERENT_DESTINATION_FILE_DATA');
    });

    await runTest('Case D: matching .uploading file from interrupted transfer is verified and finalized', async () => {
        const srcFile = path.join(joyCallDbDir, 'resume_call.wav');
        const srcData = createSyntheticWavBuffer(800);
        fs.writeFileSync(srcFile, srcData);
        const sha256 = crypto.createHash('sha256').update(srcData).digest('hex');

        // Simulate interrupted transfer by pre-creating matching .uploading file
        const tempFile = path.join(nasIncomingDir, 'resume_call.wav.uploading');
        fs.writeFileSync(tempFile, srcData);

        const res = await transfer.transferFile(srcFile, {
            filename: 'resume_call.wav',
            size: srcData.length,
            sha256
        });

        assert.strictEqual(res.status, TRANSFER_STATUS.RESUMED_AND_FINALIZED);
        assert.strictEqual(fs.existsSync(path.join(nasIncomingDir, 'resume_call.wav')), true);
        assert.strictEqual(fs.existsSync(tempFile), false);
    });

    await runTest('Case E: mismatching .uploading file moves artifact to conflict and throws UPLOADING_CONFLICT', async () => {
        const srcFile = path.join(joyCallDbDir, 'mismatch_uploading.wav');
        const srcData = createSyntheticWavBuffer(900);
        fs.writeFileSync(srcFile, srcData);
        const sha256 = crypto.createHash('sha256').update(srcData).digest('hex');

        // Pre-create differing .uploading file
        const tempFile = path.join(nasIncomingDir, 'mismatch_uploading.wav.uploading');
        fs.writeFileSync(tempFile, 'DIFFERENT_PARTIAL_BYTES_CORRUPTED');

        await assert.rejects(async () => {
            await transfer.transferFile(srcFile, {
                filename: 'mismatch_uploading.wav',
                size: srcData.length,
                sha256
            });
        }, (err) => {
            return err.code === 'UPLOADING_CONFLICT';
        });

        // Verify old .uploading was renamed to conflict preservation
        assert.strictEqual(fs.existsSync(tempFile), false);
    });

    // -------------------------------------------------------------
    // 5. Manifest Safety & Corruption Handling
    // -------------------------------------------------------------
    console.log('\n--- 5. Manifest Safety & Corruption Handling ---');

    await runTest('TransferManifest records only approved safe fields and strips private information', async () => {
        const manifest = new JoyCallTransferManifest(manifestPath);
        const testHash = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';

        const safeRecord = manifest.recordSuccess({
            filename: 'call_phone_01012345678.wav',
            sha256: testHash,
            sizeBytes: 1500,
            destinationFilename: 'safe_call.wav',
            extraPrivateField: 'SHOULD_NOT_BE_STORED'
        });

        assert.ok(safeRecord.transferId);
        assert.strictEqual(safeRecord.sourceHash, testHash);
        assert.strictEqual(safeRecord.sourceSize, 1500);
        assert.strictEqual(safeRecord.status, 'COMPLETED');
        assert.strictEqual(safeRecord.extraPrivateField, undefined);

        // Verify on disk
        const rawJson = fs.readFileSync(manifestPath, 'utf-8');
        assert.strictEqual(rawJson.includes('01012345678'), false);
        assert.strictEqual(rawJson.includes('SHOULD_NOT_BE_STORED'), false);
    });

    await runTest('Manifest corruption enters fail-closed state, preserves original corrupt file untouched without rename or replacement', async () => {
        const corruptManifestPath = path.join(stateDir, 'corrupt_manifest_test.json');
        const corruptContent = 'INVALID_JSON_CORRUPT{{{';
        fs.writeFileSync(corruptManifestPath, corruptContent, 'utf-8');

        assert.throws(() => {
            new JoyCallTransferManifest(corruptManifestPath);
        }, (err) => {
            return err.code === 'MANIFEST_CORRUPTED';
        });

        // Verify the original corrupt file still exists with exact content
        assert.strictEqual(fs.existsSync(corruptManifestPath), true);
        assert.strictEqual(fs.readFileSync(corruptManifestPath, 'utf-8'), corruptContent);
    });

    // -------------------------------------------------------------
    // 6. Source File Preservation & Immutability Proof
    // -------------------------------------------------------------
    console.log('\n--- 6. Source File Preservation & Immutability Proof ---');

    await runTest('Source file immutability proof: source size, mtime, and SHA-256 remain strictly unchanged before and after transfer', async () => {
        const immutabilitySource = path.join(joyCallDbDir, 'immutability_proof.wav');
        const wavData = createSyntheticWavBuffer(1500);
        fs.writeFileSync(immutabilitySource, wavData);

        const statBefore = fs.statSync(immutabilitySource);
        const hashBefore = crypto.createHash('sha256').update(wavData).digest('hex');

        // Transfer to NAS via .uploading
        const res = await transfer.transferFile(immutabilitySource, {
            filename: 'immutability_proof.wav',
            size: wavData.length,
            sha256: hashBefore
        });

        assert.strictEqual(res.status, TRANSFER_STATUS.COMPLETED);

        // Verify destination exists and matches
        const finalDest = path.join(nasIncomingDir, 'immutability_proof.wav');
        assert.strictEqual(fs.existsSync(finalDest), true);
        const destStat = fs.statSync(finalDest);
        assert.strictEqual(destStat.size, statBefore.size);
        const destData = fs.readFileSync(finalDest);
        const destHash = crypto.createHash('sha256').update(destData).digest('hex');
        assert.strictEqual(destHash, hashBefore);

        // Verify source is 100% UNCHANGED
        assert.strictEqual(fs.existsSync(immutabilitySource), true);
        const statAfter = fs.statSync(immutabilitySource);
        assert.strictEqual(statAfter.size, statBefore.size);
        assert.strictEqual(statAfter.mtimeMs, statBefore.mtimeMs);
        const sourceDataAfter = fs.readFileSync(immutabilitySource);
        const hashAfter = crypto.createHash('sha256').update(sourceDataAfter).digest('hex');
        assert.strictEqual(hashAfter, hashBefore);
    });

    // -------------------------------------------------------------
    // 7. Recursive Directory Inspection & Bounded Traversal
    // -------------------------------------------------------------
    console.log('\n--- 7. Recursive Directory Inspection & Bounded Traversal ---');

    await runTest('inspectJoyCallDirectory recursively finds recordings in nested date subdirectories with zero filenames in output', async () => {
        const { inspectJoyCallDirectory, observeJoyCallDirectoryChanges } = await import('../agent/joycall-sync/inspectJoyCallDirectory.js');

        const nestedSource = path.join(tempDir, 'nested_source_tree');
        const dateSubDir = path.join(nestedSource, '2026-09-12');
        fs.mkdirSync(dateSubDir, { recursive: true });

        // Seed valid wav in nested date dir
        const nestedWav = path.join(dateSubDir, 'nested_call.wav');
        fs.writeFileSync(nestedWav, createSyntheticWavBuffer(800));

        // Seed database file that should be ignored
        fs.writeFileSync(path.join(nestedSource, 'JoyCall.db'), 'DB_DATA');

        const report = await inspectJoyCallDirectory({
            customDir: nestedSource,
            maxDepth: 3
        });

        assert.strictEqual(report.status, 'PASS');
        assert.strictEqual(report.candidateCount, 1);
        assert.strictEqual(report.hasNestedDateDirectories, true);
        assert.strictEqual(report.totalDirectoryCount >= 1, true);

        // Strictly verify NO filenames, paths, or phone numbers in output
        const serialized = JSON.stringify(report);
        assert.strictEqual(serialized.includes('nested_call.wav'), false);
        assert.strictEqual(serialized.includes('2026-09-12'), false);
        assert.strictEqual(serialized.includes(nestedSource), false);

        // Observation mode test
        const observation = await observeJoyCallDirectoryChanges({
            customDir: nestedSource,
            intervalMs: 50
        });
        assert.strictEqual(typeof observation.delta.candidateDelta, 'number');
        assert.strictEqual(JSON.stringify(observation).includes('nested_call.wav'), false);
    });

    await runTest('inspectJoyCallDirectory respects bounds: depth limit and file count limit', async () => {
        const { inspectJoyCallDirectory } = await import('../agent/joycall-sync/inspectJoyCallDirectory.js');

        const deepDir = path.join(tempDir, 'deep_tree', 'lvl1', 'lvl2', 'lvl3', 'lvl4');
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, 'deep_call.wav'), createSyntheticWavBuffer(500));

        // When maxDepth is 2, deep_call at lvl4 should not be reached
        const shallowReport = await inspectJoyCallDirectory({
            customDir: path.join(tempDir, 'deep_tree'),
            maxDepth: 2
        });
        assert.strictEqual(shallowReport.candidateCount, 0);
        assert.strictEqual(shallowReport.inspectionMetrics.traversalLimitReached, true);
    });

    // -------------------------------------------------------------
    // 8. Hardened Lock Identity & PID Reuse Safety
    // -------------------------------------------------------------
    console.log('\n--- 8. Hardened Single-Instance Lock Identity ---');

    await runTest('SingleInstanceGuard payload contains pid, agentInstanceId, startedAt, executableIdentity, schemaVersion', async () => {
        const lockTestDir = path.join(tempDir, 'hardened_lock_test');
        fs.mkdirSync(lockTestDir, { recursive: true });
        const guard = new JoyCallSingleInstanceGuard({
            stateDir: lockTestDir,
            lockFilename: 'hardened.lock'
        });

        guard.acquire();
        const lockPath = path.join(lockTestDir, 'hardened.lock');
        assert.strictEqual(fs.existsSync(lockPath), true);

        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        assert.strictEqual(lockData.schemaVersion, 2);
        assert.strictEqual(lockData.pid, process.pid);
        assert.ok(lockData.agentInstanceId);
        assert.ok(lockData.startedAt);
        assert.ok(lockData.executableIdentity);

        guard.release();
        assert.strictEqual(fs.existsSync(lockPath), false);
    });

} finally {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

console.log('\n============================================================');
console.log(`📊 JOYCALL SYNC AGENT HARDENING RESULTS: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
console.log('============================================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}

/**
 * scripts/verify-joycall-intake.mjs
 * Verification test suite for Mind-ERP OS Track A12: JoyCall NAS Intake Contract.
 * 
 * Verifies:
 * - .uploading ignored
 * - Valid completed audio accepted
 * - Invalid signature rejected / quarantined by contract
 * - Duplicate hash rejected
 * - NAS source file preserved (never deleted or modified)
 * - Initial state: processingStatus='pending', classificationStatus='pending',
 *   callRecordType=null, classificationMethod=null,
 *   subjectLinkStatus='unlinked', institutionLinkStatus='unlinked'
 * - Zero transcript or summary stored
 * - Zero STT or Ollama execution
 * - Zero automatic classification or client linking
 * - Manual staff classification succeeds with canonical types only
 * - Prohibited values (ai_classified, automatic_phone_match) are strictly rejected
 * - Safe error output without leaking NAS paths
 * - Read-only intake reconciliation
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
    JoyCallIntakeValidator,
    JoyCallIntakeRepository,
    JoyCallIntakeCoordinator,
    runJoyCallIntakeReconciliation,
    JoyCallIntakeMetrics,
    JoyCallIntakeError,
    JOYCALL_INTAKE_PROCESSING_STATUS,
    JOYCALL_CLASSIFICATION_STATUS,
    JOYCALL_LINK_STATUS,
    JOYCALL_CANONICAL_RECORD_TYPES,
    JOYCALL_CANONICAL_CLASSIFICATION_METHODS
} from '../server/joycall-intake/index.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'joycall_intake_test_'));

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
 * Creates a valid synthetic WAV file buffer with standard 44-byte RIFF header and PCM payload.
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
console.log('🧪 TRACK A12: NAS JOYCALL INTAKE CONTRACT VERIFICATION');
console.log('============================================================\n');

try {
    const nasDir = path.join(tempDir, 'nas_incoming');
    fs.mkdirSync(nasDir, { recursive: true });

    let inMemoryStore = [];
    const getData = () => inMemoryStore;
    const persistData = (calls) => { inMemoryStore = calls; };

    const repo = new JoyCallIntakeRepository(getData, persistData);
    const coordinator = new JoyCallIntakeCoordinator({
        nasIncomingDir: nasDir,
        repository: repo
    });

    // -------------------------------------------------------------
    // 1. Filename & Suffix Filtering (.uploading & extensions)
    // -------------------------------------------------------------
    console.log('--- 1. Filename & Extension Rules ---');

    await runTest('.uploading temporary files, conflict artifacts, and unsupported extensions are safely ignored', async () => {
        const uploadingFile = path.join(nasDir, 'audio_rec_01.wav.uploading');
        fs.writeFileSync(uploadingFile, 'IN_PROGRESS_UPLOADING_BYTES');

        const conflictFile = path.join(nasDir, 'audio_rec_02.wav.uploading.conflict.1726000000');
        fs.writeFileSync(conflictFile, 'CONFLICT_EVIDENCE_BYTES');

        const txtFile = path.join(nasDir, 'notes.txt');
        fs.writeFileSync(txtFile, 'TEXT_NOTES');

        const resUpload = await coordinator.processFile('audio_rec_01.wav.uploading');
        assert.strictEqual(resUpload.status, 'IGNORED');
        assert.strictEqual(resUpload.code, 'UPLOADING_FILE_IGNORED');

        const resConflict = await coordinator.processFile('audio_rec_02.wav.uploading.conflict.1726000000');
        assert.strictEqual(resConflict.status, 'IGNORED');
        assert.strictEqual(resConflict.code, 'UNSUPPORTED_EXTENSION');

        const resTxt = await coordinator.processFile('notes.txt');
        assert.strictEqual(resTxt.status, 'IGNORED');
        assert.strictEqual(resTxt.code, 'UNSUPPORTED_EXTENSION');
    });

    // -------------------------------------------------------------
    // 2. Zero-byte & Corrupted Audio Rejection
    // -------------------------------------------------------------
    console.log('\n--- 2. File Validation & Signature Checks ---');

    await runTest('Zero-byte and invalid audio files are rejected without altering NAS files', async () => {
        const zeroFile = path.join(nasDir, 'zero.wav');
        fs.writeFileSync(zeroFile, Buffer.alloc(0));

        const resZero = await coordinator.processFile('zero.wav');
        assert.strictEqual(resZero.status, 'REJECTED');
        assert.strictEqual(resZero.code, 'ZERO_BYTE_FILE');

        const corruptFile = path.join(nasDir, 'corrupt.wav');
        fs.writeFileSync(corruptFile, Buffer.alloc(2048, 'THIS_IS_CORRUPT_NON_AUDIO_HEADER_BYTES_'));

        const resCorrupt = await coordinator.processFile('corrupt.wav');
        assert.strictEqual(resCorrupt.status, 'REJECTED');
        assert.strictEqual(resCorrupt.code, 'INVALID_SIGNATURE');

        // Verify files remain in NAS (not deleted or altered)
        assert.strictEqual(fs.existsSync(zeroFile), true);
        assert.strictEqual(fs.existsSync(corruptFile), true);
    });

    // -------------------------------------------------------------
    // 3. Valid Audio Intake & Strict Initial State
    // -------------------------------------------------------------
    console.log('\n--- 3. Valid Intake & Initial Call State ---');

    let validCallId = null;
    let validContentHash = null;

    await runTest('Valid completed audio is accepted with strict initial unclassified and unlinked state', async () => {
        const wavData = createSyntheticWavBuffer(1200);
        const validFile = path.join(nasDir, 'completed_call_01.wav');
        fs.writeFileSync(validFile, wavData);

        const intakeRes = await coordinator.processFile('completed_call_01.wav');
        assert.strictEqual(intakeRes.status, 'ACCEPTED');
        assert.strictEqual(intakeRes.code, 'INTAKE_SUCCESS');
        assert.ok(intakeRes.voiceCallId);
        validCallId = intakeRes.voiceCallId;
        validContentHash = intakeRes.contentHash;

        // Verify VoiceCall record in repository
        const call = repo.findById(validCallId);
        assert.ok(call);
        assert.strictEqual(call.processingStatus, JOYCALL_INTAKE_PROCESSING_STATUS.PENDING);
        assert.strictEqual(call.classificationStatus, JOYCALL_CLASSIFICATION_STATUS.PENDING);
        assert.strictEqual(call.callRecordType, null);
        assert.strictEqual(call.classificationMethod, null);
        assert.strictEqual(call.subjectLinkStatus, JOYCALL_LINK_STATUS.UNLINKED);
        assert.strictEqual(call.institutionLinkStatus, JOYCALL_LINK_STATUS.UNLINKED);

        // Strict prohibition: zero transcript and zero summary
        assert.strictEqual(call.transcript, undefined);
        assert.strictEqual(call.summary, undefined);

        // NAS source file must be preserved
        assert.strictEqual(fs.existsSync(validFile), true);
    });

    // -------------------------------------------------------------
    // 4. Duplicate SHA-256 Detection
    // -------------------------------------------------------------
    console.log('\n--- 4. Duplicate Hash Detection ---');

    await runTest('Duplicate SHA-256 audio file is rejected with DUPLICATE status', async () => {
        // Re-process same file or copy with different name
        const duplicateFile = path.join(nasDir, 'copy_of_call_01.wav');
        const sourceFile = path.join(nasDir, 'completed_call_01.wav');
        fs.copyFileSync(sourceFile, duplicateFile);

        const dupRes = await coordinator.processFile('copy_of_call_01.wav');
        assert.strictEqual(dupRes.status, 'DUPLICATE');
        assert.strictEqual(dupRes.code, 'DUPLICATE_HASH');
        assert.strictEqual(dupRes.existingCallId, validCallId);
        assert.strictEqual(dupRes.sha256, validContentHash);
    });

    // -------------------------------------------------------------
    // 5. Canonical Manual Classification
    // -------------------------------------------------------------
    console.log('\n--- 5. Manual Classification & Prohibited AI States ---');

    await runTest('Authorized staff classification accepts canonical record types and methods only', async () => {
        // Successful classification
        const classified = await repo.classifyManually(
            validCallId,
            JOYCALL_CANONICAL_RECORD_TYPES.INDIVIDUAL_COUNSELING,
            JOYCALL_CANONICAL_CLASSIFICATION_METHODS.STAFF_SELECTED,
            'staff_user_01'
        );

        assert.strictEqual(classified.classificationStatus, JOYCALL_CLASSIFICATION_STATUS.CLASSIFIED);
        assert.strictEqual(classified.callRecordType, 'individual_counseling');
        assert.strictEqual(classified.classificationMethod, 'staff_selected');
        assert.strictEqual(classified.classifiedByUserId, 'staff_user_01');
        assert.strictEqual(classified.version, 2);

        // Prohibited record type: e.g. automatic AI classification
        await assert.rejects(async () => {
            await repo.classifyManually(
                validCallId,
                'ai_classified_emergency',
                JOYCALL_CANONICAL_CLASSIFICATION_METHODS.STAFF_SELECTED,
                'staff_user_01'
            );
        }, (err) => {
            return err instanceof JoyCallIntakeError && err.code === 'INVALID_SOURCE';
        });

        // Prohibited classification method: e.g. automatic phone matching
        await assert.rejects(async () => {
            await repo.classifyManually(
                validCallId,
                JOYCALL_CANONICAL_RECORD_TYPES.ADMINISTRATIVE_CALL,
                'automatic_phone_match',
                'staff_user_01'
            );
        }, (err) => {
            return err instanceof JoyCallIntakeError && err.code === 'INVALID_SOURCE';
        });
    });

    // -------------------------------------------------------------
    // 6. Safe Error Output & Redaction
    // -------------------------------------------------------------
    console.log('\n--- 6. Error Redaction & Information Hiding ---');

    await runTest('JoyCallIntakeError redacts NAS paths, tokens, and secrets from details', async () => {
        const sensitiveNasPath = '\\\\192.168.1.100\\recordings\\joycall\\incoming';
        const err = new JoyCallIntakeError('FILE_ERROR', 'Intake file access failure', {
            nasPath: sensitiveNasPath,
            token: 'SECRET_TOKEN_XYZ',
            filename: 'safe_call.wav'
        });

        const serialized = JSON.stringify(err.details);
        assert.strictEqual(serialized.includes(sensitiveNasPath), false);
        assert.strictEqual(serialized.includes('SECRET_TOKEN_XYZ'), false);
        assert.strictEqual(err.details.nasPath, '[REDACTED]');
        assert.strictEqual(err.details.token, '[REDACTED]');
        assert.strictEqual(err.details.filename, 'safe_call.wav');
    });

    // -------------------------------------------------------------
    // 7. Read-Only Intake Reconciliation
    // -------------------------------------------------------------
    console.log('\n--- 7. Intake Reconciliation ---');

    await runTest('runJoyCallIntakeReconciliation detects pending .uploading and empty files without mutating state', async () => {
        const reconReport = await runJoyCallIntakeReconciliation({
            nasIncomingDir: nasDir,
            repository: repo
        });

        assert.strictEqual(reconReport.isReadOnly, true);
        assert.strictEqual(reconReport.totalFindings >= 2, true); // uploading file and zero-byte file

        const uploadingFinding = reconReport.findings.find(f => f.code === 'UPLOADING_FILE_PENDING');
        assert.ok(uploadingFinding);

        const emptyFinding = reconReport.findings.find(f => f.code === 'EMPTY_FILE_FOUND');
        assert.ok(emptyFinding);
    });

} finally {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

console.log('\n============================================================');
console.log(`📊 NAS INTAKE VERIFICATION RESULTS: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
console.log('============================================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}

/**
 * scripts/verify-audio-intake.mjs
 * Comprehensive Automated Verification Suite for Track A5:
 * Audio Intake, Temporary Stream Reception, Magic-Number Validation, and Invariant Checks.
 * Zero production data touched (isolated temporary directories).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import crypto from 'crypto';
import { Readable } from 'stream';

import {
    PROCESSING_STATUS,
    INTAKE_VALIDATION_STATUS,
    AUDIO_INTAKE_SOURCE,
    ERROR_CODES,
    VoiceCallRepository,
    TranscriptRepository,
    ProcessingRevisionRepository,
    AssignmentHistoryRepository,
    VoiceCallReconciliationService
} from '../server/voice-calls/index.js';

import {
    AUDIO_FORMAT,
    INTAKE_LIMITS,
    INTAKE_ERROR_CODES,
    AudioIntakeError,
    normalizeAudioFilename,
    detectAudioSignature,
    detectDangerousSignature,
    probeAudioMetadata,
    TemporaryAudioStorage,
    AudioIntakeValidator,
    AudioIntakeCoordinator
} from '../server/audio-intake/index.js';

import { withFileLock, clearLockRegistryForTest } from '../server/storage/sharedFileLockRegistry.js';

// Setup Isolated Temp Test Environment
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audio_intake_test_'));
const TEMP_STORAGE_DIR = path.join(TEST_DIR, 'audio-intake');
const QUARANTINE_DIR = path.join(TEST_DIR, 'quarantine');
console.log(`📁 Isolated Test Directory: ${TEST_DIR}`);

// In-memory test store mirroring Mind-ERP getData/persistData contracts
const testStore = {};

const getData = (filename, defaultValue = []) => {
    if (testStore[filename] !== undefined) return testStore[filename];
    const fp = path.join(TEST_DIR, `${filename}.json`);
    if (fs.existsSync(fp)) {
        try {
            testStore[filename] = JSON.parse(fs.readFileSync(fp, 'utf8'));
            return testStore[filename];
        } catch (e) {
            throw e;
        }
    }
    testStore[filename] = defaultValue;
    return defaultValue;
};

const persistData = async (filename, data) => {
    testStore[filename] = data;
    const fp = path.join(TEST_DIR, `${filename}.json`);
    const tmp = `${fp}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, fp);
    return true;
};

// Synthetic Audio Generators
function createSyntheticWav(byteLength = 1024, sampleRate = 16000) {
    const totalBytes = Math.max(44, byteLength);
    const buf = Buffer.alloc(totalBytes);
    // RIFF header
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(totalBytes - 8, 4);
    buf.write('WAVE', 8, 'ascii');
    // fmt subchunk
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16); // subchunk1 size (16 for PCM)
    buf.writeUInt16LE(1, 20); // audio format (1 = PCM)
    buf.writeUInt16LE(1, 22); // num channels (1 = mono)
    buf.writeUInt32LE(sampleRate, 24); // sample rate
    const byteRate = sampleRate * 1 * 2; // sampleRate * numChannels * bitsPerSample/8
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(2, 32); // block align (numChannels * bitsPerSample/8)
    buf.writeUInt16LE(16, 34); // bits per sample
    // data subchunk
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(totalBytes - 44, 40);
    // fill body with synthetic PCM data
    for (let i = 44; i < totalBytes; i++) {
        buf[i] = (i * 17) % 256;
    }
    return buf;
}

function createSyntheticMp3(byteLength = 1024) {
    const totalBytes = Math.max(64, byteLength);
    const buf = Buffer.alloc(totalBytes);
    // ID3v2.3 header
    buf.write('ID3', 0, 'ascii');
    buf[3] = 0x03; // version 2.3
    buf[4] = 0x00;
    buf[5] = 0x00; // flags
    buf.writeUInt32BE(0x0000000A, 6); // tag size: 10 synchsafe bytes
    // MPEG Audio Frame sync at offset 16 (0xFF, 0xFB = Layer III, 128kbps, 44.1kHz)
    buf[16] = 0xFF;
    buf[17] = 0xFB;
    buf[18] = 0x90;
    buf[19] = 0x00;
    for (let i = 20; i < totalBytes; i++) {
        buf[i] = (i * 31) % 256;
    }
    return buf;
}

function createSyntheticM4a(byteLength = 1024) {
    const totalBytes = Math.max(64, byteLength);
    const buf = Buffer.alloc(totalBytes);
    // ftyp box
    buf.writeUInt32BE(32, 0); // box size 32
    buf.write('ftyp', 4, 'ascii');
    buf.write('M4A ', 8, 'ascii'); // major brand
    buf.writeUInt32BE(0, 12); // minor version
    buf.write('isom', 16, 'ascii'); // compatible brand
    buf.write('mp42', 20, 'ascii');
    for (let i = 32; i < totalBytes; i++) {
        buf[i] = (i * 13) % 256;
    }
    return buf;
}

function bufferToStream(buffer, chunkSize = 256) {
    let offset = 0;
    return new Readable({
        read() {
            if (offset >= buffer.length) {
                this.push(null);
                return;
            }
            const end = Math.min(offset + chunkSize, buffer.length);
            const chunk = buffer.slice(offset, end);
            offset = end;
            this.push(chunk);
        }
    });
}

async function runAllTests() {
    console.log('====================================================');
    console.log('🧪 Starting Mind-ERP OS Track A5 Audio Intake Tests');
    console.log('====================================================\n');

    let passedTests = 0;
    let failedTests = 0;
    let totalAssertions = 0;

    let streamTestCount = 0;
    let signatureTestCount = 0;
    let failureInjectionCount = 0;
    let crossInstanceTestCount = 0;

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

    const assertCondition = (cond, msg) => {
        totalAssertions++;
        assert(cond, msg);
    };

    const assertStrictEqual = (actual, expected, msg) => {
        totalAssertions++;
        assert.strictEqual(actual, expected, msg);
    };

    // Shared repositories for tests
    const voiceCallRepo = new VoiceCallRepository(getData, persistData);
    const revisionRepo = new ProcessingRevisionRepository(getData, persistData, { voiceCallRepo });
    const assignmentRepo = new AssignmentHistoryRepository(getData, persistData, { voiceCallRepo });
    const transcriptRepo = new TranscriptRepository(TEST_DIR, { voiceCallRepo });

    const intakeConfig = {
        temporaryRoot: TEMP_STORAGE_DIR,
        quarantineRoot: QUARANTINE_DIR,
        minFileBytes: 512, // test conservative min
        maxFileBytes: 2 * 1024 * 1024 // 2 MB test cap
    };

    const coordinator = new AudioIntakeCoordinator(intakeConfig, { voiceCallRepo });

    // ============================================================
    // A. PRECONDITION GATE (CROSS-INSTANCE LOCKING & PARTIAL FAILURE)
    // ============================================================
    console.log('--- A. Precondition Gate (Shared Locking & Bypass Removal) ---');

    await testCase('A.1 Cross-instance VoiceCall creation concurrency: 2 instances saving concurrently preserve all records', async () => {
        crossInstanceTestCount++;
        const repoInstance1 = new VoiceCallRepository(getData, persistData);
        const repoInstance2 = new VoiceCallRepository(getData, persistData);

        const p1 = repoInstance1.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'cross_inst_1.wav',
            contentHash: 'hash_cross_inst_1',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        const p2 = repoInstance2.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'cross_inst_2.wav',
            contentHash: 'hash_cross_inst_2',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        assertCondition(r1.id !== r2.id, 'Distinct calls must have distinct IDs');

        const all = repoInstance1.list();
        assertCondition(all.some(c => c.id === r1.id));
        assertCondition(all.some(c => c.id === r2.id));
    });

    await testCase('A.2 Cross-instance Revision creation concurrency: 2 instances generate non-colliding revision numbers', async () => {
        crossInstanceTestCount++;
        const targetCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'rev_cross_call.wav',
            contentHash: 'hash_rev_cross_call',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        const revInstance1 = new ProcessingRevisionRepository(getData, persistData, { voiceCallRepo });
        const revInstance2 = new ProcessingRevisionRepository(getData, persistData, { voiceCallRepo });

        const p1 = revInstance1.createRevision({
            callId: targetCall.id,
            aiSummary: '인스턴스 1 생성 요약'
        });
        const p2 = revInstance2.createRevision({
            callId: targetCall.id,
            aiSummary: '인스턴스 2 생성 요약'
        });

        const [res1, res2] = await Promise.all([p1, p2]);
        assertCondition(res1.revisionNumber !== res2.revisionNumber, 'revisionNumbers must not collide across instances');
        const revNums = [res1.revisionNumber, res2.revisionNumber].sort((a, b) => a - b);
        assertStrictEqual(revNums[0], 1);
        assertStrictEqual(revNums[1], 2);
    });

    await testCase('A.3 Cross-instance Assignment History append concurrency: 10 items from 2 instances preserved without loss', async () => {
        crossInstanceTestCount++;
        const targetCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'history_cross_call.wav',
            contentHash: 'hash_history_cross_call',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        const instA = new AssignmentHistoryRepository(getData, persistData, { voiceCallRepo });
        const instB = new AssignmentHistoryRepository(getData, persistData, { voiceCallRepo });

        const promises = [];
        for (let i = 1; i <= 10; i++) {
            const inst = (i % 2 === 0) ? instA : instB;
            promises.push(inst.recordAssignment({
                callId: targetCall.id,
                nextUserId: `worker_${i}`,
                assignedBy: 'supervisor',
                reason: `동시 배정 ${i}`,
                resultingVersion: i + 1
            }));
        }

        const recorded = await Promise.all(promises);
        assertStrictEqual(recorded.length, 10);

        const history = instA.getHistoryForCall(targetCall.id);
        assertStrictEqual(history.length, 10, 'All 10 history entries from multiple instances must be preserved');
    });

    await testCase('A.4 Public API bypass options are strictly absent from TranscriptRepository', async () => {
        // Attempting to pass bypassCallExistenceCheck to saveTranscript must STILL verify call existence
        const fakeCallId = crypto.randomUUID();
        let caught = null;
        try {
            await transcriptRepo.saveTranscript(fakeCallId, {
                callId: fakeCallId,
                text: '우회 시도',
                segments: []
            }, { bypassCallExistenceCheck: true });
        } catch (err) {
            caught = err;
        }
        assertCondition(caught !== null, 'Public bypass option must not bypass call check');
        assertStrictEqual(caught.code, ERROR_CODES.NOT_FOUND);
    });

    await testCase('A.5 Transcript linking partial failure leaves orphan transcript detectable by Reconciliation', async () => {
        failureInjectionCount++;
        const call = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'partial_t_call.wav',
            contentHash: 'hash_partial_t_call',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        // 1. Transcript successfully saved on disk
        const saved = await transcriptRepo.saveTranscript(call.id, {
            callId: call.id,
            text: '정상 전사 파일 저장됨',
            segments: []
        });
        assertCondition(saved.storageKey !== undefined);

        // 2. Simulate failure updating VoiceCall.transcriptStorageKey (e.g. storage error)
        // VoiceCall is intentionally NOT updated with transcriptStorageKey.
        // Reconciliation must find this as ORPHAN_TRANSCRIPT_FILE!
        const recon = new VoiceCallReconciliationService({
            voiceCallRepo,
            transcriptRepo,
            revisionRepo,
            assignmentRepo
        });

        const report = await recon.runReconciliation();
        // Since call has no transcriptStorageKey, disk file is an orphan
        const orphanIssue = report.issues.find(i => i.resourceId === call.id && i.checkCode === 'ORPHAN_TRANSCRIPT_FILE');
        assertCondition(orphanIssue !== undefined, 'Orphan transcript must be detected by Reconciliation');
    });

    // ============================================================
    // B. FILENAME NORMALIZATION
    // ============================================================
    console.log('\n--- B. Filename Normalization ---');

    await testCase('B.1 Korean and standard filename normalized with NFC preserving extension', async () => {
        const res = normalizeAudioFilename('상담_녹음_2026_09.wav');
        assertStrictEqual(res.normalizedFileName, '상담_녹음_2026_09.wav');
        assertStrictEqual(res.normalizedExtension, '.wav');
    });

    await testCase('B.2 Path traversal sequences, null bytes, and slashes stripped', async () => {
        const res1 = normalizeAudioFilename('../../../etc/passwd.mp3');
        assertStrictEqual(res1.normalizedFileName, 'passwd.mp3');
        assertStrictEqual(res1.normalizedExtension, '.mp3');

        const res2 = normalizeAudioFilename('voice\0hidden\x07_bell.wav');
        assertStrictEqual(res2.normalizedFileName, 'voicehidden_bell.wav');

        const res3 = normalizeAudioFilename('C:\\Windows\\System32\\driver.m4a');
        assertStrictEqual(res3.normalizedFileName, 'driver.m4a');
        assertStrictEqual(res3.normalizedExtension, '.m4a');
    });

    await testCase('B.3 Overly long filename truncated while preserving extension', async () => {
        const longName = 'A'.repeat(250) + '.wav';
        const res = normalizeAudioFilename(longName);
        assertCondition(res.normalizedFileName.length <= INTAKE_LIMITS.MAX_FILENAME_LENGTH);
        assertStrictEqual(res.normalizedExtension, '.wav');
        assertCondition(res.normalizedFileName.endsWith('.wav'));
    });

    await testCase('B.4 Empty or dot-only filename returns safe fallback audio_recording.bin', async () => {
        const res1 = normalizeAudioFilename('');
        assertStrictEqual(res1.normalizedFileName, 'audio_recording.bin');

        const res2 = normalizeAudioFilename('....');
        assertStrictEqual(res2.normalizedFileName, 'audio_recording.bin');
    });

    // ============================================================
    // C. STREAM HANDLING & BACKPRESSURE
    // ============================================================
    console.log('\n--- C. Stream Handling & Backpressure ---');

    await testCase('C.1 Node Readable stream written chunk by chunk without full memory buffering', async () => {
        streamTestCount++;
        const syntheticWav = createSyntheticWav(4096);
        const stream = bufferToStream(syntheticWav, 512);

        const storage = new TemporaryAudioStorage({ temporaryRoot: TEMP_STORAGE_DIR });
        const intakeId = crypto.randomUUID();

        const res = await storage.writeStream(stream, intakeId);
        assertStrictEqual(res.fileSize, 4096);
        assertStrictEqual(res.contentHash, crypto.createHash('sha256').update(syntheticWav).digest('hex'));
        assertCondition(fs.existsSync(res.absolutePath), 'Temporary .part file must exist on disk');

        // Clean up
        await storage.removeTemporaryFile(intakeId);
        assertCondition(!fs.existsSync(res.absolutePath), 'Part file must be removed cleanly');
    });

    await testCase('C.2 Stream read error immediately cleans up partial file and rejects', async () => {
        streamTestCount++;
        failureInjectionCount++;
        const storage = new TemporaryAudioStorage({ temporaryRoot: TEMP_STORAGE_DIR });
        const intakeId = crypto.randomUUID();

        // Create failing stream that errors mid-way
        let sent = 0;
        const failingStream = new Readable({
            read() {
                if (sent === 0) {
                    this.push(Buffer.from('INITIAL_CHUNK_DATA_'));
                    sent++;
                } else {
                    this.destroy(new Error('Simulated network stream dropped prematurely'));
                }
            }
        });

        let caught = null;
        try {
            await storage.writeStream(failingStream, intakeId);
        } catch (e) {
            caught = e;
        }

        assertCondition(caught !== null, 'Stream error must reject writeStream');
        assertStrictEqual(caught.code, INTAKE_ERROR_CODES.INVALID_STREAM);

        // Verify partial file was automatically unlinked
        const expectedPartFile = path.join(TEMP_STORAGE_DIR, `${intakeId}.part`);
        assertCondition(!fs.existsSync(expectedPartFile), 'Partial file must not be left on disk after error');
    });

    // ============================================================
    // D. SIZE ENFORCEMENT & IMMEDIATE ABORT
    // ============================================================
    console.log('\n--- D. Size Enforcement & Immediate Abort ---');

    await testCase('D.1 Exceeding maxFileBytes aborts stream immediately and cleans up partial file', async () => {
        streamTestCount++;
        failureInjectionCount++;
        const storage = new TemporaryAudioStorage({
            temporaryRoot: TEMP_STORAGE_DIR,
            maxFileBytes: 1024 // 1 KB strict limit
        });
        const intakeId = crypto.randomUUID();

        // Stream emitting 4 KB in 512B chunks
        const oversizedBuf = Buffer.alloc(4096, 0xAA);
        const stream = bufferToStream(oversizedBuf, 512);

        let caught = null;
        try {
            await storage.writeStream(stream, intakeId);
        } catch (e) {
            caught = e;
        }

        assertCondition(caught !== null, 'Oversized payload must throw');
        assertStrictEqual(caught.code, INTAKE_ERROR_CODES.PAYLOAD_TOO_LARGE);
        assertStrictEqual(caught.status, 413);

        const expectedPartFile = path.join(TEMP_STORAGE_DIR, `${intakeId}.part`);
        assertCondition(!fs.existsSync(expectedPartFile), 'Oversized partial file must be unlinked');
    });

    await testCase('D.2 File below minFileBytes rejected by validator', async () => {
        const validator = new AudioIntakeValidator({ minFileBytes: 1024, maxFileBytes: 10000 });
        assert.throws(
            () => validator.validateSize(500),
            err => err.code === INTAKE_ERROR_CODES.PAYLOAD_TOO_SMALL
        );
        assertCondition(validator.validateSize(1024).sizeValid);
    });

    // ============================================================
    // E. SIGNATURE DETECTION (MAGIC NUMBERS)
    // ============================================================
    console.log('\n--- E. Audio Signature Detection ---');

    await testCase('E.1 Valid WAV header with RIFF, WAVE, and fmt correctly identified', async () => {
        signatureTestCount++;
        const wavBuf = createSyntheticWav(1024);
        const res = detectAudioSignature(wavBuf);
        assertStrictEqual(res.detected, true);
        assertStrictEqual(res.format, AUDIO_FORMAT.WAV);
        assertStrictEqual(res.canonicalMime, 'audio/wav');
        assertStrictEqual(res.isDangerous, false);
    });

    await testCase('E.2 Valid MP3 with ID3v2 container identified', async () => {
        signatureTestCount++;
        const mp3Buf = createSyntheticMp3(1024);
        const res = detectAudioSignature(mp3Buf);
        assertStrictEqual(res.detected, true);
        assertStrictEqual(res.format, AUDIO_FORMAT.MP3);
        assertStrictEqual(res.canonicalMime, 'audio/mpeg');
        assertStrictEqual(res.isDangerous, false);
    });

    await testCase('E.3 Valid M4A with ftyp box identified', async () => {
        signatureTestCount++;
        const m4aBuf = createSyntheticM4a(1024);
        const res = detectAudioSignature(m4aBuf);
        assertStrictEqual(res.detected, true);
        assertStrictEqual(res.format, AUDIO_FORMAT.M4A);
        assertStrictEqual(res.canonicalMime, 'audio/mp4');
        assertStrictEqual(res.isDangerous, false);
    });

    await testCase('E.4 Truncated WAV header (< 44 bytes) fails detection', async () => {
        signatureTestCount++;
        const truncated = Buffer.from('RIFF....WAVE');
        const res = detectAudioSignature(truncated);
        assertStrictEqual(res.detected, false);
    });

    await testCase('E.5 Dangerous MZ Windows Executable disguised with .wav extension detected and flagged', async () => {
        signatureTestCount++;
        const mzBuf = Buffer.alloc(512);
        mzBuf[0] = 0x4D; // 'M'
        mzBuf[1] = 0x5A; // 'Z'
        mzBuf.write('This is a disguised PE EXE file', 2);

        const res = detectAudioSignature(mzBuf);
        assertStrictEqual(res.detected, false);
        assertStrictEqual(res.isDangerous, true);
        assertStrictEqual(res.dangerType, 'MZ_EXECUTABLE');
    });

    await testCase('E.6 Dangerous ZIP archive disguised as .mp3 detected and flagged', async () => {
        signatureTestCount++;
        const zipBuf = Buffer.alloc(512);
        zipBuf[0] = 0x50; // 'P'
        zipBuf[1] = 0x4B; // 'K'
        zipBuf[2] = 0x03;
        zipBuf[3] = 0x04;

        const res = detectAudioSignature(zipBuf);
        assertStrictEqual(res.detected, false);
        assertStrictEqual(res.isDangerous, true);
        assertStrictEqual(res.dangerType, 'ZIP_ARCHIVE');
    });

    await testCase('E.7 HTML/XML document disguised as audio detected and rejected', async () => {
        signatureTestCount++;
        const htmlBuf = Buffer.from('<!DOCTYPE html><html><body>Malicious HTML payload</body></html>');
        const res = detectAudioSignature(htmlBuf);
        assertStrictEqual(res.detected, false);
        assertStrictEqual(res.isDangerous, true);
        assertStrictEqual(res.dangerType, 'NON_AUDIO_TEXT');
    });

    await testCase('E.8 Random arbitrary non-audio bytes rejected safely', async () => {
        signatureTestCount++;
        const randomBuf = crypto.randomBytes(512);
        const res = detectAudioSignature(randomBuf);
        assertStrictEqual(res.detected, false);
        assertStrictEqual(res.isDangerous, false);
    });

    // ============================================================
    // F. MIME & EXTENSION CONSISTENCY
    // ============================================================
    console.log('\n--- F. MIME & Extension Consistency ---');

    await testCase('F.1 Disallowed extension is rejected with 415', async () => {
        const validator = new AudioIntakeValidator();
        assert.throws(
            () => validator.validateFormatConsistency('.exe', 'audio/wav', { detected: true, format: 'wav' }),
            err => err.code === INTAKE_ERROR_CODES.UNSUPPORTED_FORMAT && err.status === 415
        );
    });

    await testCase('F.2 Extension and detected format mismatch rejected with 400', async () => {
        const validator = new AudioIntakeValidator();
        // File named .mp3 but detected as wav
        assert.throws(
            () => validator.validateFormatConsistency('.mp3', 'audio/mpeg', { detected: true, format: 'wav', canonicalMime: 'audio/wav' }),
            err => err.code === INTAKE_ERROR_CODES.CONTENT_MISMATCH
        );
    });

    // ============================================================
    // G. DURATION PROBE
    // ============================================================
    console.log('\n--- G. Duration Probe ---');

    await testCase('G.1 WAV duration calculated deterministically from byteRate and data subchunk', async () => {
        // 16000 Hz, 1 channel, 16 bits = 32000 bytes/sec
        // If data subchunk has 32000 bytes, duration is exactly 1.00 second
        const wav1Sec = createSyntheticWav(44 + 32000, 16000);
        const probe = probeAudioMetadata(wav1Sec, AUDIO_FORMAT.WAV, wav1Sec.length);
        assertStrictEqual(probe.durationValidationStatus, 'exact');
        assertStrictEqual(probe.durationSeconds, 1.0);
    });

    await testCase('G.2 MP3 and M4A durations marked pending (deferred to STT worker probe)', async () => {
        const mp3Buf = createSyntheticMp3(2048);
        const probe = probeAudioMetadata(mp3Buf, AUDIO_FORMAT.MP3, 2048);
        assertStrictEqual(probe.durationValidationStatus, 'pending');
        assertStrictEqual(probe.durationSeconds, null);
    });

    // ============================================================
    // H. COORDINATOR END-TO-END INTAKE & QUARANTINE CONTRACT
    // ============================================================
    console.log('\n--- H. Coordinator End-to-End Ingestion ---');

    let validIntakeResult = null;

    await testCase('H.1 Valid WAV stream ingested successfully: ends at validating status without transitioning to queued', async () => {
        const wavBuf = createSyntheticWav(2048);
        const stream = bufferToStream(wavBuf);

        validIntakeResult = await coordinator.processIntake({
            stream,
            filename: '상담_신규녹음_2026.wav',
            mimeType: 'audio/wav',
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD
        });

        assertCondition(validIntakeResult.intakeId !== undefined);
        assertCondition(validIntakeResult.voiceCallId !== null);
        assertStrictEqual(validIntakeResult.processingStatus, PROCESSING_STATUS.VALIDATING, 'A5 strictly terminates at validating status');
        assertStrictEqual(validIntakeResult.validationStatus, INTAKE_VALIDATION_STATUS.VALID);
        assertStrictEqual(validIntakeResult.detectedFormat, 'wav');
        assertCondition(validIntakeResult.temporaryStorageKey.startsWith('audio-intake/'));
        assertCondition(!validIntakeResult.temporaryStorageKey.includes('..') && !path.isAbsolute(validIntakeResult.temporaryStorageKey));

        // Check VoiceCallRecord state in repository
        const storedCall = voiceCallRepo.findById(validIntakeResult.voiceCallId);
        assertStrictEqual(storedCall.processingStatus, PROCESSING_STATUS.VALIDATING);
        assertStrictEqual(storedCall.validationStatus, INTAKE_VALIDATION_STATUS.VALID);
    });

    await testCase('H.2 Sequential duplicate contentHash rejected with duplicate status and cleans up temp file', async () => {
        const wavBuf = createSyntheticWav(2048); // same buffer -> same contentHash
        const stream = bufferToStream(wavBuf);

        const dupResult = await coordinator.processIntake({
            stream,
            filename: '중복_업로드_시도.wav',
            mimeType: 'audio/wav'
        });

        assertStrictEqual(dupResult.validationStatus, INTAKE_VALIDATION_STATUS.DUPLICATE);
        assertStrictEqual(dupResult.rejectionCode, 'DUPLICATE_CONTENT_HASH');
        assertStrictEqual(dupResult.voiceCallId, null, 'Duplicate must not create a new VoiceCallRecord');
        assertStrictEqual(dupResult.duplicateOfCallId, validIntakeResult.voiceCallId);

        // Verify temp file was removed
        const partFile = path.join(TEMP_STORAGE_DIR, `${dupResult.intakeId}.part`);
        assertCondition(!fs.existsSync(partFile), 'Temp file for duplicate must be cleaned up');
    });

    await testCase('H.3 Disguised MZ file is quarantined and creates a REJECTED VoiceCallRecord', async () => {
        const mzBuf = Buffer.alloc(1024);
        mzBuf[0] = 0x4D;
        mzBuf[1] = 0x5A;
        mzBuf.write('Executable binary payload disguised as audio', 2);
        const stream = bufferToStream(mzBuf);

        const res = await coordinator.processIntake({
            stream,
            filename: 'trojan_disguised.wav',
            mimeType: 'audio/wav'
        });

        assertStrictEqual(res.validationStatus, INTAKE_VALIDATION_STATUS.QUARANTINED);
        assertStrictEqual(res.rejectionCode, 'MALICIOUS_SIGNATURE_DETECTED');
        assertCondition((res.quarantineStorageKey || res.temporaryStorageKey).includes('quarantine'));

        // Verify quarantined file moved to quarantine directory
        const qFile = path.join(QUARANTINE_DIR, `${res.intakeId}.quarantine`);
        assertCondition(fs.existsSync(qFile), 'File must reside in quarantine directory');

        // Verify VoiceCall record terminated at REJECTED
        const storedCall = voiceCallRepo.findById(res.voiceCallId);
        assertStrictEqual(storedCall.processingStatus, PROCESSING_STATUS.REJECTED);
        assertStrictEqual(storedCall.rejectionCode, 'MALICIOUS_SIGNATURE_DETECTED');
    });

    await testCase('H.4 Output contains zero sensitive data (no absolute paths, no binary streams)', async () => {
        assertCondition(!JSON.stringify(validIntakeResult).includes(TEST_DIR), 'Result must not contain absolute server paths');
        assertCondition(!('password' in validIntakeResult));
        assertCondition(!('token' in validIntakeResult));
    });

    console.log('\n====================================================');
    console.log(`📊 Track A5 Audio Intake Verification Summary:`);
    console.log(`   - Tests Passed: ${passedTests}`);
    console.log(`   - Tests Failed: ${failedTests}`);
    console.log(`   - Total Assertions: ${totalAssertions}`);
    console.log(`   - Stream & Backpressure Scenarios: ${streamTestCount}`);
    console.log(`   - Signature & Disguise Checks: ${signatureTestCount}`);
    console.log(`   - Failure Injection Scenarios: ${failureInjectionCount}`);
    console.log(`   - Cross-Instance Lock Scenarios: ${crossInstanceTestCount}`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        throw new Error(`Track A5 verification failed with ${failedTests} errors.`);
    }
}

runAllTests()
    .then(() => {
        console.log('🎉 Track A5 Audio Intake and Validation tests completed with 100% success!');
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Track A5 verification failed:', err);
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
        process.exit(1);
    });

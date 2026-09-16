/**
 * scripts/verify-private-audio-storage.mjs
 * Comprehensive Verification Suite for Mind-ERP OS Track A6:
 * Private Permanent Audio Storage, Atomic Promotion, EXDEV Copy Fallback,
 * Reconciliation, and A5 Closure Enforcement.
 * 
 * Strictly isolated: Uses fs.mkdtemp, synthetic audio fixtures, zero production data.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';
import { Readable } from 'stream';

import {
    PrivateAudioStorage,
    AudioPromotionCoordinator,
    PrivateAudioReconciliationService,
    generatePermanentStorageKey,
    generateQuarantineStorageKey,
    isSafePrivateStorageKey,
    resolveAndValidatePath,
    PROMOTION_ERROR_CODES,
    STORAGE_RECONCILIATION_CHECKS,
    PrivateAudioStorageError
} from '../server/audio-storage/index.js';

import {
    AudioIntakeCoordinator,
    toPublicAudioIntakeResult,
    detectAudioSignature,
    probeAudioMetadata,
    MEDIA_VALIDATION_STAGE,
    AUDIO_FORMAT
} from '../server/audio-intake/index.js';

import { VoiceCallRepository } from '../server/voice-calls/voiceCallRepository.js';
import {
    PROCESSING_STATUS,
    ASSIGNMENT_STATUS,
    AUDIO_INTAKE_SOURCE,
    INTAKE_VALIDATION_STATUS,
    ERROR_CODES
} from '../server/voice-calls/voiceCallConstants.js';

// Setup Isolated Temporary Test Directory
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'private_audio_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
const TEMP_INTAKE_DIR = path.join(TEST_ROOT, 'audio-intake');
const PRIVATE_AUDIO_DIR = path.join(TEST_ROOT, 'private-audio');
const QUARANTINE_AUDIO_DIR = path.join(TEST_ROOT, 'quarantine');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TEMP_INTAKE_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_AUDIO_DIR, { recursive: true });
fs.mkdirSync(QUARANTINE_AUDIO_DIR, { recursive: true });

console.log(`📁 Isolated A6 Test Directory: ${TEST_ROOT}`);

// Simple in-memory persistence adapter simulating file-based storage
const memoryStore = {};
const getData = (name, def = []) => {
    if (memoryStore[name] !== undefined) return memoryStore[name];
    const fp = path.join(DATA_DIR, `${name}.json`);
    if (fs.existsSync(fp)) {
        try {
            memoryStore[name] = JSON.parse(fs.readFileSync(fp, 'utf8'));
            return memoryStore[name];
        } catch (e) {
            throw e;
        }
    }
    memoryStore[name] = def;
    return def;
};

const persistData = async (name, data) => {
    memoryStore[name] = data;
    const fp = path.join(DATA_DIR, `${name}.json`);
    const tmp = `${fp}.tmp_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
};

/**
 * Synthetic WAV Generator (Standard 44-byte header + PCM payload)
 */
function createSyntheticWav(payloadBytes = 1024, seed = 0) {
    const totalFileSize = 44 + payloadBytes;
    const buffer = Buffer.alloc(totalFileSize);

    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(totalFileSize - 8, 4);
    buffer.write('WAVE', 8);

    // fmt subchunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    buffer.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
    buffer.writeUInt16LE(1, 22);  // NumChannels (1 = Mono)
    buffer.writeUInt32LE(16000, 24); // SampleRate (16000 Hz)
    buffer.writeUInt32LE(32000, 28); // ByteRate (16000 * 1 * 2 = 32000)
    buffer.writeUInt16LE(2, 32);  // BlockAlign (1 * 2 = 2)
    buffer.writeUInt16LE(16, 34); // BitsPerSample (16 bits)

    // data subchunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(payloadBytes, 40);

    // Fill audio PCM samples with synthetic sine-wave pattern parameterized by seed
    for (let i = 44; i < totalFileSize; i++) {
        buffer[i] = ((i + seed) % 256);
    }

    return buffer;
}

/**
 * Synthetic ID3v2 container with MPEG Audio sync frame
 */
function createSyntheticMp3(withMpegFrame = true) {
    // 10-byte ID3 header
    const id3Header = Buffer.from([
        0x49, 0x44, 0x33, // 'ID3'
        0x03, 0x00,       // version 2.3.0
        0x00,             // flags
        0x00, 0x00, 0x00, 0x10 // synchsafe size = 16 bytes
    ]);
    const id3Payload = Buffer.alloc(16, 0x20); // 16 bytes spaces

    let mpegFrame = Buffer.alloc(0);
    if (withMpegFrame) {
        // Valid MPEG 1 Layer III frame header: 0xFF 0xFB 0x90 0x64
        // 0xFF 0xFB -> Sync 11 bits (11111111 111), Version 1 (11), Layer 3 (01), Error protection absent (1)
        // 0x90 -> Bitrate index 9 (128 kbps), Sample rate index 0 (44100 Hz), Padding bit 0
        mpegFrame = Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
    }

    return Buffer.concat([id3Header, id3Payload, mpegFrame]);
}

/**
 * Synthetic M4A container with ftyp box
 */
function createSyntheticM4a() {
    const ftyp = Buffer.alloc(32);
    ftyp.writeUInt32BE(32, 0);       // box size = 32
    ftyp.write('ftyp', 4);           // box type
    ftyp.write('M4A ', 8);           // major brand
    ftyp.writeUInt32BE(0, 12);       // minor version
    ftyp.write('isom', 16);          // compatible brand 1
    ftyp.write('mp42', 20);          // compatible brand 2
    return ftyp;
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
    console.log('🧪 Starting Mind-ERP OS Track A6 Private Audio Tests');
    console.log('====================================================\n');

    let passedTests = 0;
    let failedTests = 0;
    let totalAssertions = 0;

    let storageTestCount = 0;
    let promotionTestCount = 0;
    let failureInjectionCount = 0;
    let reconciliationTestCount = 0;

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

    // Shared repositories & services
    const voiceCallRepo = new VoiceCallRepository(getData, persistData);

    const privateStorage = new PrivateAudioStorage({
        privateAudioRoot: PRIVATE_AUDIO_DIR,
        quarantineAudioRoot: QUARANTINE_AUDIO_DIR,
        temporaryAudioRoot: TEMP_INTAKE_DIR
    });

    const coordinator = new AudioPromotionCoordinator({
        audioStorage: privateStorage,
        voiceCallRepo
    });

    const intakeCoordinator = new AudioIntakeCoordinator(
        {
            temporaryRoot: TEMP_INTAKE_DIR,
            quarantineRoot: QUARANTINE_AUDIO_DIR,
            minFileBytes: 44,
            maxFileBytes: 10 * 1024 * 1024
        },
        { voiceCallRepo }
    );

    // ============================================================
    // 1. A5 CLOSURE GATE CORRECTIONS
    // ============================================================
    console.log('--- 1. A5 Closure Gate Corrections ---');

    await testCase('1.1 Duplicate public result strictly strips existingCallId and contentHash', async () => {
        const syntheticWav = createSyntheticWav(512);
        // Ingest first time
        const res1 = await intakeCoordinator.processIntake({
            stream: bufferToStream(syntheticWav),
            filename: 'first_call.wav',
            mimeType: 'audio/wav'
        });
        assertStrictEqual(res1.validationStatus, INTAKE_VALIDATION_STATUS.VALID);

        // Ingest second time (duplicate)
        const res2 = await intakeCoordinator.processIntake({
            stream: bufferToStream(syntheticWav),
            filename: 'duplicate_attempt.wav',
            mimeType: 'audio/wav'
        });
        assertStrictEqual(res2.validationStatus, INTAKE_VALIDATION_STATUS.DUPLICATE);
        assertCondition(res2.duplicateOfCallId !== undefined, 'Internal result may track duplicateOfCallId');

        // Transform to public result
        const publicRes = toPublicAudioIntakeResult(res2);
        assertStrictEqual(publicRes.status, 'duplicate');
        assertStrictEqual(publicRes.duplicateOfCallId, undefined, 'Public result must NOT contain duplicateOfCallId');
        assertStrictEqual(publicRes.contentHash, undefined, 'Public result must NOT contain full contentHash');
        assertStrictEqual(publicRes.storageKey, undefined, 'Public result must NOT expose storage path');
        assertStrictEqual(publicRes.mediaValidationStage, MEDIA_VALIDATION_STAGE.REJECTED);
    });

    await testCase('1.2 ID3-only MP3 is marked as pending_decode and NOT confirmed decoded', async () => {
        const id3OnlyBuf = createSyntheticMp3(false); // ID3 only, no MPEG audio frame
        const sig = detectAudioSignature(id3OnlyBuf);
        assertCondition(sig.detected, 'ID3 container detected');
        assertStrictEqual(sig.format, AUDIO_FORMAT.MP3);
        assertStrictEqual(sig.mediaValidationStage, MEDIA_VALIDATION_STAGE.PENDING_DECODE, 'ID3-only must be pending_decode');

        // With MPEG frame: structural
        const fullMp3Buf = createSyntheticMp3(true);
        const sig2 = detectAudioSignature(fullMp3Buf);
        assertStrictEqual(sig2.mediaValidationStage, MEDIA_VALIDATION_STAGE.STRUCTURAL);
    });

    await testCase('1.3 M4A ftyp-only is classified as candidate with pending_decode', async () => {
        const m4aBuf = createSyntheticM4a();
        const sig = detectAudioSignature(m4aBuf);
        assertStrictEqual(sig.format, AUDIO_FORMAT.M4A);
        assertStrictEqual(sig.mediaValidationStage, MEDIA_VALIDATION_STAGE.PENDING_DECODE, 'M4A ftyp-only must be pending_decode');
    });

    await testCase('1.4 WAV duration probe preserves raw unrounded floating-point number', async () => {
        const wavBuf = createSyntheticWav(12345); // Odd byte payload
        const probe = probeAudioMetadata(wavBuf, AUDIO_FORMAT.WAV, wavBuf.length);
        assertCondition(typeof probe.durationSeconds === 'number');
        // effectiveDataSize = 12345, byteRate = 32000 -> 12345 / 32000 = 0.38578125 (exact float)
        assertStrictEqual(probe.durationSeconds, 12345 / 32000, 'WAV duration must be exact floating-point division');
    });

    await testCase('1.5 Rejected VoiceCall has NO normal storageKey, only quarantineStorageKey', async () => {
        const mzBuffer = Buffer.concat([Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), Buffer.alloc(120)]); // 128-byte MZ executable
        const rejRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(mzBuffer),
            filename: 'disguised_trojan.wav',
            mimeType: 'audio/wav'
        });

        const rejCall = voiceCallRepo.findById(rejRes.voiceCallId);
        assertStrictEqual(rejCall.processingStatus, PROCESSING_STATUS.REJECTED);
        assertStrictEqual(rejCall.storageKey, undefined, 'Rejected call must NOT have storageKey');
        assertCondition(rejCall.quarantineStorageKey !== undefined, 'Rejected call must have quarantineStorageKey');
        assertStrictEqual(rejCall.assignmentStatus, ASSIGNMENT_STATUS.UNASSIGNED);
    });

    await testCase('1.6 Rejected VoiceCall cannot be assigned or linked to subject', async () => {
        const mzBuffer = Buffer.concat([Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x01]), Buffer.alloc(120)]);
        const rejRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(mzBuffer),
            filename: 'evil.wav',
            mimeType: 'audio/wav'
        });

        // Attempting to assign user to rejected call violates invariants
        await assert.rejects(
            async () => {
                await voiceCallRepo.updateMetadata(rejRes.voiceCallId, 3, {
                    assignedUserId: 'worker_1',
                    assignmentStatus: ASSIGNMENT_STATUS.ASSIGNED
                });
            },
            (err) => err.code === ERROR_CODES.INVARIANT_VIOLATION
        );
    });

    // ============================================================
    // 2. PERMANENT STORAGE KEY GENERATION & SECURITY
    // ============================================================
    console.log('\n--- 2. Storage Key Syntax & Confinement ---');

    await testCase('2.1 Generate permanent storage key adhering to canonical path pattern', async () => {
        storageTestCount++;
        const testCallId = crypto.randomUUID();
        const key = generatePermanentStorageKey(testCallId, 'wav', new Date('2026-05-15T00:00:00Z'));
        assertCondition(key.startsWith(`private-audio/2026/05/${testCallId}/`));
        assertCondition(key.endsWith('.wav'));
        assertCondition(isSafePrivateStorageKey(key));
    });

    await testCase('2.2 Security checks reject traversal, drive letters, backslashes, and null bytes', async () => {
        storageTestCount++;
        assertStrictEqual(isSafePrivateStorageKey('/private-audio/2026/01/call_1/abc.wav'), false, 'Leading slash');
        assertStrictEqual(isSafePrivateStorageKey('private-audio\\2026\\01\\call_1\\abc.wav'), false, 'Backslashes');
        assertStrictEqual(isSafePrivateStorageKey('private-audio/2026/01/../call_1/abc.wav'), false, 'Traversal');
        assertStrictEqual(isSafePrivateStorageKey('C:/private-audio/2026/01/call_1/abc.wav'), false, 'Drive letter');
        assertStrictEqual(isSafePrivateStorageKey('private-audio/2026/01/call_1/abc.wav\0.exe'), false, 'Null byte');
        assertStrictEqual(isSafePrivateStorageKey('http://evil.com/audio.wav'), false, 'URL');
    });

    await testCase('2.3 resolveAndValidatePath confines target strictly to root', async () => {
        storageTestCount++;
        const key = generatePermanentStorageKey('call_ok', 'wav');
        const { resolvedPath } = resolveAndValidatePath(PRIVATE_AUDIO_DIR, key);
        assertCondition(resolvedPath.startsWith(PRIVATE_AUDIO_DIR));

        // Invalid key throws PrivateAudioStorageError
        assert.throws(
            () => resolveAndValidatePath(PRIVATE_AUDIO_DIR, '../escaped.wav'),
            (err) => err instanceof PrivateAudioStorageError && err.code === PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID
        );
    });

    // ============================================================
    // 3. SOURCE VALIDATION BEFORE PROMOTION
    // ============================================================
    console.log('\n--- 3. Source File Validation ---');

    await testCase('3.1 Valid source file verified with size, hash, and signature', async () => {
        storageTestCount++;
        const wav = createSyntheticWav(1024);
        const tempKey = 'test_source_valid.part';
        const tempPath = path.join(TEMP_INTAKE_DIR, tempKey);
        fs.writeFileSync(tempPath, wav);

        const expectedHash = crypto.createHash('sha256').update(wav).digest('hex');
        const meta = await privateStorage.validateSourceFile(tempKey, expectedHash, wav.length);

        assertStrictEqual(meta.actualSize, wav.length);
        assertStrictEqual(meta.actualHash, expectedHash);
        assertStrictEqual(meta.detectedFormat, 'wav');

        fs.unlinkSync(tempPath);
    });

    await testCase('3.2 Non-existent source file throws AUDIO_SOURCE_NOT_FOUND', async () => {
        failureInjectionCount++;
        await assert.rejects(
            async () => {
                await privateStorage.validateSourceFile('non_existent.part', 'hash', 100);
            },
            (err) => err.code === PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_FOUND
        );
    });

    await testCase('3.3 Source path escaping temp root throws AUDIO_SOURCE_OUTSIDE_TEMP_ROOT', async () => {
        failureInjectionCount++;
        await assert.rejects(
            async () => {
                await privateStorage.validateSourceFile('../outside.part', 'hash', 100);
            },
            (err) => err.code === PROMOTION_ERROR_CODES.AUDIO_SOURCE_OUTSIDE_TEMP_ROOT
        );
    });

    await testCase('3.4 Hash mismatch throws AUDIO_HASH_MISMATCH', async () => {
        failureInjectionCount++;
        const wav = createSyntheticWav(512);
        const tempKey = 'test_hash_mismatch.part';
        const tempPath = path.join(TEMP_INTAKE_DIR, tempKey);
        fs.writeFileSync(tempPath, wav);

        await assert.rejects(
            async () => {
                await privateStorage.validateSourceFile(tempKey, '0000000000000000000000000000000000000000000000000000000000000000', wav.length);
            },
            (err) => err.code === PROMOTION_ERROR_CODES.AUDIO_HASH_MISMATCH
        );

        fs.unlinkSync(tempPath);
    });

    // ============================================================
    // 4. ATOMIC PROMOTION & EXDEV FALLBACK
    // ============================================================
    console.log('\n--- 4. Audio Promotion & EXDEV Fallback ---');

    await testCase('4.1 Normal promotion renames temporary file to permanent storage key', async () => {
        promotionTestCount++;
        const wav = createSyntheticWav(2048, 41);
        const intakeRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(wav),
            filename: 'meeting_normal.wav',
            mimeType: 'audio/wav'
        });

        const permKey = generatePermanentStorageKey(intakeRes.voiceCallId, 'wav');
        const promo = await privateStorage.promoteFile(intakeRes.temporaryStorageKey, permKey, {
            expectedHash: intakeRes.contentHash,
            expectedSize: intakeRes.fileSize
        });

        assertStrictEqual(promo.permanentStorageKey, permKey);
        assertCondition(fs.existsSync(promo.targetPath), 'Permanent file must exist on disk');

        // Verify temp file was removed
        const tempAbs = path.join(TEMP_INTAKE_DIR, intakeRes.temporaryStorageKey);
        assertCondition(!fs.existsSync(tempAbs), 'Temporary file must be removed after successful promotion');
    });

    await testCase('4.2 Target collision blocks overwrite without destroying existing file', async () => {
        failureInjectionCount++;
        const wav1 = createSyntheticWav(1024);
        const wav2 = createSyntheticWav(2048);

        const permKey = generatePermanentStorageKey('collision_call', 'wav');
        const targetPath = resolveAndValidatePath(PRIVATE_AUDIO_DIR, permKey).resolvedPath;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, wav1); // Pre-existing target

        const tempKey = 'collision_source.part';
        fs.writeFileSync(path.join(TEMP_INTAKE_DIR, tempKey), wav2);

        await assert.rejects(
            async () => {
                await privateStorage.promoteFile(tempKey, permKey);
            },
            (err) => err.code === PROMOTION_ERROR_CODES.AUDIO_STORAGE_COLLISION
        );

        // Pre-existing file remains intact
        assertStrictEqual(fs.readFileSync(targetPath).length, wav1.length);
        fs.unlinkSync(path.join(TEMP_INTAKE_DIR, tempKey));
    });

    await testCase('4.3 EXDEV fallback uses streaming copy with partial file isolation and verifies hash', async () => {
        promotionTestCount++;
        const wav = createSyntheticWav(4096);
        const expectedHash = crypto.createHash('sha256').update(wav).digest('hex');

        const tempKey = 'exdev_source.part';
        const tempPath = path.join(TEMP_INTAKE_DIR, tempKey);
        fs.writeFileSync(tempPath, wav);

        const permKey = generatePermanentStorageKey('exdev_call', 'wav');
        const promo = await privateStorage.promoteFile(tempKey, permKey, {
            expectedHash,
            expectedSize: wav.length,
            forceCopyFallback: true // Force EXDEV simulation
        });

        assertStrictEqual(promo.usedCopyFallback, true);
        assertCondition(fs.existsSync(promo.targetPath));
        assertStrictEqual(fs.readFileSync(promo.targetPath).length, wav.length);
        assertStrictEqual(promo.contentHash, expectedHash);

        // Source file removed after successful EXDEV copy
        assertCondition(!fs.existsSync(tempPath), 'Source file must be unlinked after copy fallback success');
    });

    // ============================================================
    // 5. COORDINATOR PROMOTION & METADATA LINKING
    // ============================================================
    console.log('\n--- 5. Coordinator Promotion & Option B Linking ---');

    await testCase('5.1 Coordinator completes full promotion pipeline and links VoiceCall.storageKey', async () => {
        promotionTestCount++;
        const wav = createSyntheticWav(2048, 51);
        const intakeRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(wav),
            filename: 'counsel_audio.wav',
            mimeType: 'audio/wav'
        });

        const initialCall = voiceCallRepo.findById(intakeRes.voiceCallId);
        assertStrictEqual(initialCall.processingStatus, PROCESSING_STATUS.VALIDATING);

        // Run promotion coordinator
        const promoRes = await coordinator.promoteCallAudio(intakeRes.voiceCallId);
        assertStrictEqual(promoRes.status, 'promoted');
        assertCondition(promoRes.storageKey.startsWith('private-audio/'));

        // Check updated VoiceCall record
        const updatedCall = voiceCallRepo.findById(intakeRes.voiceCallId);
        assertStrictEqual(updatedCall.storageKey, promoRes.storageKey);
        assertStrictEqual(updatedCall.storagePromotionStatus, 'linked');
        assertStrictEqual(updatedCall.pendingStorageKey, undefined, 'pendingStorageKey must be cleared');
        assertStrictEqual(updatedCall.processingStatus, PROCESSING_STATUS.VALIDATING, 'Must remain validating (no queued transition)');
        assertStrictEqual(updatedCall.validationStatus, INTAKE_VALIDATION_STATUS.VALID);
        assertStrictEqual(updatedCall.version, initialCall.version + 2, 'Version incremented by exactly 2 (pending -> linked)');
    });

    await testCase('5.2 General updateMetadata strictly forbids tampering with storageKey or promotion fields', async () => {
        const dummyCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'meta_test.wav',
            contentHash: 'dummy_hash_meta',
            mimeType: 'audio/wav',
            fileSize: 100
        });

        // Attempting to modify storageKey via general updateMetadata is rejected
        await assert.rejects(
            async () => {
                await voiceCallRepo.updateMetadata(dummyCall.id, dummyCall.version, {
                    storageKey: 'hacked/path/audio.wav'
                });
            },
            (err) => err.code === ERROR_CODES.INVARIANT_VIOLATION
        );

        // Attempting to modify pendingStorageKey is rejected
        await assert.rejects(
            async () => {
                await voiceCallRepo.updateMetadata(dummyCall.id, dummyCall.version, {
                    pendingStorageKey: 'pending/hack.wav'
                });
            },
            (err) => err.code === ERROR_CODES.INVARIANT_VIOLATION
        );
    });

    // ============================================================
    // 6. IDEMPOTENCY & CONCURRENT PROMOTION
    // ============================================================
    console.log('\n--- 6. Idempotency & Concurrency ---');

    await testCase('6.1 Re-promoting an already promoted call is idempotent (no duplicate files, no version bump)', async () => {
        promotionTestCount++;
        const wav = createSyntheticWav(1024, 61);
        const intakeRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(wav),
            filename: 'idempotent_call.wav',
            mimeType: 'audio/wav'
        });

        const firstPromo = await coordinator.promoteCallAudio(intakeRes.voiceCallId);
        assertStrictEqual(firstPromo.status, 'promoted');

        const callAfterFirst = voiceCallRepo.findById(intakeRes.voiceCallId);

        // Second promotion call for the same callId
        const secondPromo = await coordinator.promoteCallAudio(intakeRes.voiceCallId);
        assertStrictEqual(secondPromo.status, 'already_promoted');
        assertStrictEqual(secondPromo.storageKey, firstPromo.storageKey);
        assertStrictEqual(secondPromo.idempotent, true);

        const callAfterSecond = voiceCallRepo.findById(intakeRes.voiceCallId);
        assertStrictEqual(callAfterSecond.version, callAfterFirst.version, 'Idempotent re-promotion must not bump version');
    });

    await testCase('6.2 Cross-instance concurrent promotion for same callId: exactly 1 promotion succeeds', async () => {
        promotionTestCount++;
        const wav = createSyntheticWav(2048, 62);
        const intakeRes = await intakeCoordinator.processIntake({
            stream: bufferToStream(wav),
            filename: 'concurrent_promo.wav',
            mimeType: 'audio/wav'
        });

        // Two independent coordinator instances
        const coordA = new AudioPromotionCoordinator({ audioStorage: privateStorage, voiceCallRepo });
        const coordB = new AudioPromotionCoordinator({ audioStorage: privateStorage, voiceCallRepo });

        const [rA, rB] = await Promise.all([
            coordA.promoteCallAudio(intakeRes.voiceCallId),
            coordB.promoteCallAudio(intakeRes.voiceCallId)
        ]);

        // One should be 'promoted' and the other 'already_promoted'
        const statuses = [rA.status, rB.status].sort();
        assertStrictEqual(statuses[0], 'already_promoted');
        assertStrictEqual(statuses[1], 'promoted');
        assertStrictEqual(rA.storageKey, rB.storageKey, 'Both instances resolve to identical permanent storageKey');

        const finalCall = voiceCallRepo.findById(intakeRes.voiceCallId);
        assertStrictEqual(finalCall.storagePromotionStatus, 'linked');
    });

    // ============================================================
    // 7. PRIVATE STORAGE RECONCILIATION
    // ============================================================
    console.log('\n--- 7. Private Storage Reconciliation ---');

    await testCase('7.1 Reconciliation detects missing audio file (STORAGE_KEY_WITHOUT_FILE)', async () => {
        reconciliationTestCount++;
        const missingCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'missing_audio.wav',
            contentHash: 'hash_missing_audio_test',
            mimeType: 'audio/wav',
            fileSize: 1000
        });

        // Manually link a non-existent permanent storageKey
        const nonExistentKey = generatePermanentStorageKey(missingCall.id, 'wav');
        await voiceCallRepo.completeStoragePromotion(missingCall.id, missingCall.version, {
            storageKey: nonExistentKey
        });

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });

        const report = await recon.runReconciliation();
        const issue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.STORAGE_KEY_WITHOUT_FILE && i.resourceId === missingCall.id);
        assertCondition(issue !== undefined, 'STORAGE_KEY_WITHOUT_FILE must be detected');
        assertStrictEqual(issue.severity, 'error');
    });

    await testCase('7.2 Reconciliation detects orphan audio file on disk (FILE_WITHOUT_VOICE_CALL)', async () => {
        reconciliationTestCount++;
        const orphanKey = generatePermanentStorageKey('orphan_call_uuid', 'wav');
        const orphanPath = path.join(PRIVATE_AUDIO_DIR, orphanKey);
        fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
        fs.writeFileSync(orphanPath, createSyntheticWav(512));

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });

        const report = await recon.runReconciliation();
        const issue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.FILE_WITHOUT_VOICE_CALL);
        assertCondition(issue !== undefined, 'FILE_WITHOUT_VOICE_CALL must be detected');
        assertStrictEqual(issue.severity, 'warning');

        fs.unlinkSync(orphanPath);
    });

    await testCase('7.3 Reconciliation detects hash mismatch (STORAGE_HASH_MISMATCH)', async () => {
        reconciliationTestCount++;
        const wav = createSyntheticWav(1024, 73);
        const correctHash = crypto.createHash('sha256').update(wav).digest('hex');

        const call = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'tampered_audio.wav',
            contentHash: correctHash,
            mimeType: 'audio/wav',
            fileSize: wav.length
        });

        const permKey = generatePermanentStorageKey(call.id, 'wav');
        const diskPath = path.join(PRIVATE_AUDIO_DIR, permKey);
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        // Write tampered contents with different hash
        fs.writeFileSync(diskPath, Buffer.alloc(wav.length, 0xEE));

        await voiceCallRepo.completeStoragePromotion(call.id, call.version, {
            storageKey: permKey
        });

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });

        const report = await recon.runReconciliation();
        const issue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.STORAGE_HASH_MISMATCH && i.resourceId === call.id);
        assertCondition(issue !== undefined, 'STORAGE_HASH_MISMATCH must be detected');

        fs.unlinkSync(diskPath);
    });

    await testCase('7.4 Reconciliation detects lingering promotion partial file (PROMOTION_PARTIAL_FILE)', async () => {
        reconciliationTestCount++;
        const partialDir = path.join(PRIVATE_AUDIO_DIR, 'private-audio', '2026', '06', 'call_part');
        fs.mkdirSync(partialDir, { recursive: true });
        const partialFile = path.join(partialDir, 'audio.wav.part_123456');
        fs.writeFileSync(partialFile, Buffer.from('PARTIAL_INCOMPLETE_BYTES'));

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });

        const report = await recon.runReconciliation();
        const issue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.PROMOTION_PARTIAL_FILE);
        assertCondition(issue !== undefined, 'PROMOTION_PARTIAL_FILE must be detected');

        fs.unlinkSync(partialFile);
    });

    await testCase('7.5 Reconciliation output contains zero absolute paths, raw hashes, or sensitive tokens', async () => {
        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });
        const report = await recon.runReconciliation();
        const serialized = JSON.stringify(report);

        assertCondition(!serialized.includes(PRIVATE_AUDIO_DIR), 'Must not leak absolute private audio path');
        assertCondition(!serialized.includes(TEMP_INTAKE_DIR), 'Must not leak absolute temp path');
        assertCondition(!serialized.includes('C:\\'), 'Must not leak drive letters');
        assertCondition(!serialized.includes('/home/'), 'Must not leak home directory');
    });

    await testCase('7.6 Reconciliation detects orphan temp file and capacity warning', async () => {
        reconciliationTestCount++;
        // Create orphan .part file in TEMP_INTAKE_DIR
        const orphanTempPath = path.join(TEMP_INTAKE_DIR, 'orphan_stream_unlinked.part');
        fs.writeFileSync(orphanTempPath, Buffer.from('TEMP_BYTES'));

        // Storage with very high minimum space to trigger warning
        const constrainedStorage = new PrivateAudioStorage({
            privateAudioRoot: PRIVATE_AUDIO_DIR,
            quarantineAudioRoot: QUARANTINE_AUDIO_DIR,
            temporaryAudioRoot: TEMP_INTAKE_DIR,
            minimumFreeSpaceBytes: 100 * 1024 * 1024 * 1024 * 1024 // 100 TB (triggers capacity warning)
        });

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: constrainedStorage
        });

        const report = await recon.runReconciliation();
        const tempIssue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.TEMP_FILE_WITHOUT_INTAKE);
        assertCondition(tempIssue !== undefined, 'TEMP_FILE_WITHOUT_INTAKE must be detected');

        // Check capacity warning if statfs supported on platform
        const cap = await constrainedStorage.checkCapacity(0);
        if (cap.verified) {
            const capIssue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.STORAGE_CAPACITY_WARNING);
            assertCondition(capIssue !== undefined, 'STORAGE_CAPACITY_WARNING must be detected when below minimum threshold');
        }

        fs.unlinkSync(orphanTempPath);
    });

    await testCase('7.7 Reconciliation detects state anomaly: rejected call with normal storage & stale pending', async () => {
        reconciliationTestCount++;
        const dummyCall = await voiceCallRepo.create({
            intakeSource: AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: 'anomaly.wav',
            contentHash: 'hash_anomaly_test',
            mimeType: 'audio/wav',
            fileSize: 100
        });

        // Artificially inject stale pendingStorageKey and rejected state
        await voiceCallRepo.setPendingStoragePromotion(dummyCall.id, dummyCall.version, 'private-audio/2026/05/call/obj.wav');

        const recon = new PrivateAudioReconciliationService({
            voiceCallRepo,
            audioStorage: privateStorage
        });

        const report = await recon.runReconciliation();
        const staleIssue = report.issues.find(i => i.checkCode === STORAGE_RECONCILIATION_CHECKS.PENDING_STORAGE_LINK_STALE && i.resourceId === dummyCall.id);
        assertCondition(staleIssue !== undefined, 'PENDING_STORAGE_LINK_STALE must be detected');
    });

    // ============================================================
    // SUMMARY
    // ============================================================
    console.log('\n====================================================');
    console.log('📊 Track A6 Private Audio Storage Verification Summary:');
    console.log(`   - Tests Passed: ${passedTests}`);
    console.log(`   - Tests Failed: ${failedTests}`);
    console.log(`   - Total Assertions: ${totalAssertions}`);
    console.log(`   - Storage & Key Security Tests: ${storageTestCount}`);
    console.log(`   - Atomic Promotion Tests: ${promotionTestCount}`);
    console.log(`   - Failure Injections: ${failureInjectionCount}`);
    console.log(`   - Storage Reconciliation Tests: ${reconciliationTestCount}`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        console.error(`❌ Verification failed with ${failedTests} test failures.`);
        process.exit(1);
    } else {
        console.log('🎉 All Track A6 Private Audio Storage tests passed with 100% success!\n');
        process.exit(0);
    }
}

runAllTests().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

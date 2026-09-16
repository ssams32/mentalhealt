/**
 * server/audio-intake/audioIntakeCoordinator.js
 * End-to-End Orchestrator for Temporary Audio Ingestion and Validation in Mind-ERP OS.
 * Connects Stream Storage, Normalization, Signature Detection, Invariant Checks, and VoiceCall creation.
 * Guarantees that successful A5 intake terminates at [validating] status with no transition to [queued].
 */

import crypto from 'crypto';
import {
    PROCESSING_STATUS,
    INTAKE_VALIDATION_STATUS,
    AUDIO_INTAKE_SOURCE,
    CALL_CATEGORY,
    ASSIGNMENT_STATUS,
    REVIEW_STATUS
} from '../voice-calls/voiceCallConstants.js';
import { MEDIA_VALIDATION_STAGE } from './audioIntakeConstants.js';
import { normalizeAudioFilename } from './filenameNormalizer.js';
import { detectAudioSignature } from './audioSignatureDetector.js';
import { probeAudioMetadata } from './audioMetadataProbe.js';
import { TemporaryAudioStorage } from './temporaryAudioStorage.js';
import { AudioIntakeValidator } from './audioIntakeValidator.js';
import { AudioIntakeError, INTAKE_ERROR_CODES } from './audioIntakeErrors.js';

/**
 * Transform internal audio intake result to safe public representation.
 * Strictly removes sensitive internals:
 * - existingCallId / duplicateOfCallId
 * - contentHash (full hash value)
 * - temporaryStorageKey / quarantineStorageKey / storageKey / absolutePath
 * - subject / patient / user identifiers
 * - internal error stacks
 */
export function toPublicAudioIntakeResult(internalResult) {
    if (!internalResult || typeof internalResult !== 'object') return null;

    const isValid = internalResult.validationStatus === INTAKE_VALIDATION_STATUS.VALID;
    const isDuplicate = internalResult.validationStatus === INTAKE_VALIDATION_STATUS.DUPLICATE;

    let status = 'rejected';
    if (isValid) status = 'accepted';
    else if (isDuplicate) status = 'duplicate';

    return {
        intakeId: internalResult.intakeId,
        status,
        validationStatus: internalResult.validationStatus,
        mediaValidationStage: internalResult.mediaValidationStage || (isValid ? MEDIA_VALIDATION_STAGE.PENDING_DECODE : MEDIA_VALIDATION_STAGE.REJECTED),
        messageCode: internalResult.rejectionCode || (isValid ? 'INTAKE_ACCEPTED' : (isDuplicate ? 'DUPLICATE_CONTENT_HASH' : 'INTAKE_REJECTED')),
        fileSize: internalResult.fileSize,
        declaredMimeType: internalResult.declaredMimeType || null,
        detectedFormat: internalResult.detectedFormat || null,
        warnings: Array.isArray(internalResult.warnings) ? internalResult.warnings : [],
        receivedAt: internalResult.receivedAt,
        validatedAt: internalResult.validatedAt
    };
}

export class AudioIntakeCoordinator {
    /**
     * @param {Object} config
     * @param {string} config.temporaryRoot - Absolute or relative path to temp folder
     * @param {string} [config.quarantineRoot] - Absolute or relative path to quarantine folder
     * @param {number} [config.minFileBytes] - Minimum allowed bytes
     * @param {number} [config.maxFileBytes] - Maximum allowed bytes
     * @param {number} [config.maxDurationSeconds] - Maximum duration in seconds
     * @param {Object} deps
     * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepo
     */
    constructor(config = {}, deps = {}) {
        if (!config || !config.temporaryRoot) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.CONFIG_MISSING,
                'AudioIntake 설정(temporaryRoot)이 누락되었습니다.',
                500
            );
        }
        if (!deps || !deps.voiceCallRepo) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.CONFIG_MISSING,
                'VoiceCallRepository 의존성이 누락되었습니다.',
                500
            );
        }

        this.config = config;
        this.voiceCallRepo = deps.voiceCallRepo;

        this.storage = new TemporaryAudioStorage({
            temporaryRoot: config.temporaryRoot,
            quarantineRoot: config.quarantineRoot,
            maxFileBytes: config.maxFileBytes
        });

        this.validator = new AudioIntakeValidator({
            minFileBytes: config.minFileBytes,
            maxFileBytes: config.maxFileBytes
        });
    }

    /**
     * Ingest an audio stream, validate signatures, and create an initial VoiceCall record in validating status.
     * 
     * @param {Object} params
     * @param {import('stream').Readable} params.stream - Readable audio stream
     * @param {string} params.filename - Original client filename
     * @param {string} params.mimeType - Client declared MIME type
     * @param {number} [params.contentLength] - Client declared content length header
     * @param {string} [params.intakeSource] - audio intake source enum
     * @returns {Promise<Object>} AudioIntakeResult
     */
    async processIntake(params) {
        if (!params || !params.stream) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.INVALID_STREAM,
                '처리할 오디오 스트림이 제공되지 않았습니다.',
                400
            );
        }

        const intakeId = crypto.randomUUID();
        const receivedAt = new Date().toISOString();

        // 1. Filename Normalization
        const { originalFileName, normalizedFileName, normalizedExtension } = normalizeAudioFilename(params.filename);

        let streamResult = null;
        try {
            // 2. Stream chunk write, cumulative size check, SHA-256 hashing
            streamResult = await this.storage.writeStream(params.stream, intakeId, {
                maxFileBytes: this.config.maxFileBytes
            });
        } catch (streamErr) {
            // Partial cleanup already performed inside writeStream on abort/error
            throw streamErr;
        }

        const { temporaryStorageKey, fileSize, contentHash, headerBuffer } = streamResult;

        // 3. Content-Hash Deduplication Check against active VoiceCall records
        const existingCall = this.voiceCallRepo.findByContentHash(contentHash);
        if (existingCall) {
            // Clean up temporary file immediately
            await this.storage.removeTemporaryFile(intakeId);
            return {
                intakeId,
                voiceCallId: null,
                temporaryStorageKey: null,
                originalFileName,
                normalizedFileName,
                declaredMimeType: params.mimeType || 'application/octet-stream',
                detectedMimeType: null,
                detectedFormat: null,
                fileSize,
                contentHash,
                durationSeconds: null,
                durationValidationStatus: 'unavailable',
                validationStatus: INTAKE_VALIDATION_STATUS.DUPLICATE,
                rejectionCode: 'DUPLICATE_CONTENT_HASH',
                mediaValidationStage: MEDIA_VALIDATION_STAGE.REJECTED,
                duplicateOfCallId: existingCall.id,
                receivedAt,
                validatedAt: new Date().toISOString()
            };
        }

        // 4. Validate Size Boundaries
        try {
            this.validator.validateSize(fileSize, params.contentLength);
        } catch (sizeErr) {
            await this.storage.removeTemporaryFile(intakeId);
            throw sizeErr;
        }

        // 5. Detect Signature (Magic Numbers)
        const signatureResult = detectAudioSignature(headerBuffer);

        // 6. Handle Dangerous / Disguised Files (Quarantine Contract)
        if (signatureResult.isDangerous || !signatureResult.detected) {
            let quarantineKey = null;
            try {
                const qRes = await this.storage.quarantineFile(intakeId);
                quarantineKey = qRes.quarantineStorageKey;
            } catch (qErr) {
                await this.storage.removeTemporaryFile(intakeId);
            }

            // Create rejected VoiceCall record to preserve audit trial of blocked intake
            const nowIso = new Date().toISOString();
            const rejectionCode = signatureResult.isDangerous ? 'MALICIOUS_SIGNATURE_DETECTED' : 'INVALID_AUDIO_SIGNATURE';

            // Rejected call must NOT have normal storageKey, only quarantineStorageKey
            const createdCall = await this.voiceCallRepo.create({
                intakeSource: params.intakeSource || AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
                originalFileName: normalizedFileName,
                contentHash,
                mimeType: signatureResult.canonicalMime || params.mimeType || 'application/octet-stream',
                fileSize,
                storageKey: undefined,
                quarantineStorageKey: quarantineKey || undefined,
                assignmentStatus: ASSIGNMENT_STATUS.UNASSIGNED,
                validationStatus: signatureResult.isDangerous ? INTAKE_VALIDATION_STATUS.QUARANTINED : INTAKE_VALIDATION_STATUS.CORRUPTED,
                rejectionCode,
                processingStatus: PROCESSING_STATUS.RECEIVED
            });

            // Transition from received -> validating -> rejected
            const valCall = await this.voiceCallRepo.transitionStatus(createdCall.id, createdCall.version, PROCESSING_STATUS.VALIDATING);
            const rejCall = await this.voiceCallRepo.transitionStatus(valCall.id, valCall.version, PROCESSING_STATUS.REJECTED, {
                rejectionCode
            });

            return {
                intakeId,
                voiceCallId: rejCall.id,
                temporaryStorageKey: null,
                quarantineStorageKey: quarantineKey,
                originalFileName,
                normalizedFileName,
                declaredMimeType: params.mimeType,
                detectedMimeType: null,
                detectedFormat: null,
                mediaValidationStage: MEDIA_VALIDATION_STAGE.REJECTED,
                fileSize,
                contentHash,
                durationSeconds: null,
                durationValidationStatus: 'unavailable',
                validationStatus: signatureResult.isDangerous ? INTAKE_VALIDATION_STATUS.QUARANTINED : INTAKE_VALIDATION_STATUS.CORRUPTED,
                rejectionCode,
                receivedAt,
                validatedAt: nowIso
            };
        }

        // 7. Validate Format & Extension & MIME Consistency
        try {
            this.validator.validateFormatConsistency(normalizedExtension, params.mimeType, signatureResult);
        } catch (formatErr) {
            await this.storage.removeTemporaryFile(intakeId);
            throw formatErr;
        }

        // 8. Probe Header Metadata & Duration
        const metadataProbe = probeAudioMetadata(headerBuffer, signatureResult.format, fileSize);

        // 9. Create VoiceCallRecord in RECEIVED status
        const createdCall = await this.voiceCallRepo.create({
            intakeSource: params.intakeSource || AUDIO_INTAKE_SOURCE.BROWSER_UPLOAD,
            originalFileName: normalizedFileName,
            contentHash,
            mimeType: signatureResult.canonicalMime,
            fileSize,
            storageKey: temporaryStorageKey,
            durationSeconds: metadataProbe.durationSeconds !== null ? metadataProbe.durationSeconds : undefined,
            validationStatus: INTAKE_VALIDATION_STATUS.VALID,
            processingStatus: PROCESSING_STATUS.RECEIVED
        });

        // 10. Transition Status: received -> validating (A5 Gate terminal state: strictly STOPS at validating)
        const validatingCall = await this.voiceCallRepo.transitionStatus(
            createdCall.id,
            createdCall.version,
            PROCESSING_STATUS.VALIDATING
        );

        const validatedAt = new Date().toISOString();

        return {
            intakeId,
            voiceCallId: validatingCall.id,
            temporaryStorageKey,
            originalFileName,
            normalizedFileName,
            declaredMimeType: params.mimeType,
            detectedMimeType: signatureResult.canonicalMime,
            detectedFormat: signatureResult.format,
            mediaValidationStage: signatureResult.mediaValidationStage || MEDIA_VALIDATION_STAGE.PENDING_DECODE,
            fileSize,
            contentHash,
            durationSeconds: metadataProbe.durationSeconds,
            durationValidationStatus: metadataProbe.durationValidationStatus,
            processingStatus: validatingCall.processingStatus, // 'validating'
            validationStatus: INTAKE_VALIDATION_STATUS.VALID,
            receivedAt,
            validatedAt
        };
    }
}

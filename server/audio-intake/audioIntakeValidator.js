/**
 * server/audio-intake/audioIntakeValidator.js
 * MIME, Extension, Size, and Signature Consistency Validator for Mind-ERP OS Audio Intake.
 */

import { ALLOWED_EXTENSIONS, MIME_MAP } from './audioIntakeConstants.js';
import { AudioIntakeError, INTAKE_ERROR_CODES } from './audioIntakeErrors.js';

export class AudioIntakeValidator {
    /**
     * @param {Object} [config={}]
     * @param {number} [config.minFileBytes]
     * @param {number} [config.maxFileBytes]
     */
    constructor(config = {}) {
        this.minFileBytes = config.minFileBytes || 1024;
        this.maxFileBytes = config.maxFileBytes || 50 * 1024 * 1024;
    }

    /**
     * Validate size bounds.
     */
    validateSize(actualBytes, declaredContentLength = null) {
        if (typeof actualBytes !== 'number' || actualBytes < this.minFileBytes) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.PAYLOAD_TOO_SMALL,
                `파일 크기가 최소 요구치(${this.minFileBytes} bytes)에 미달합니다. (실제: ${actualBytes} bytes)`,
                400
            );
        }

        if (actualBytes > this.maxFileBytes) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.PAYLOAD_TOO_LARGE,
                `파일 크기가 최대 허용치(${this.maxFileBytes} bytes)를 초과합니다.`,
                413
            );
        }

        if (declaredContentLength !== null && declaredContentLength !== undefined) {
            const declared = Number(declaredContentLength);
            if (!isNaN(declared) && declared > 0 && declared !== actualBytes) {
                // Log warning or throw if strict length mismatch
                return {
                    sizeValid: true,
                    hasLengthMismatch: true,
                    declared,
                    actual: actualBytes
                };
            }
        }

        return { sizeValid: true, hasLengthMismatch: false };
    }

    /**
     * Validate consistency between normalizedExtension, declaredMime, and signatureResult.
     * 
     * @param {string} normalizedExt - e.g. '.wav'
     * @param {string} declaredMime - e.g. 'audio/wav'
     * @param {Object} signatureResult - result from detectAudioSignature
     */
    validateFormatConsistency(normalizedExt, declaredMime, signatureResult) {
        // 1. Check extension allowlist
        if (!ALLOWED_EXTENSIONS.includes(normalizedExt.toLowerCase())) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.UNSUPPORTED_FORMAT,
                `허용되지 않은 파일 확장자입니다: [${normalizedExt}]. 지원 형식: ${ALLOWED_EXTENSIONS.join(', ')}`,
                415
            );
        }

        // 2. Check dangerous signature detection
        if (signatureResult.isDangerous) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.DANGEROUS_FILE_DETECTED,
                `위험하거나 위장된 파일 시그니처가 감지되었습니다: ${signatureResult.reason}`,
                400,
                { dangerType: signatureResult.dangerType }
            );
        }

        // 3. Check audio signature detected
        if (!signatureResult.detected || !signatureResult.format) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.SIGNATURE_DETECTION_FAILED,
                `유효한 오디오 시그니처를 확인할 수 없습니다: ${signatureResult.reason || '알 수 없는 형식'}`,
                400
            );
        }

        // 4. Check extension vs detected format match
        const expectedExtForFormat = `.${signatureResult.format}`;
        if (normalizedExt.toLowerCase() !== expectedExtForFormat) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.CONTENT_MISMATCH,
                `확장자(${normalizedExt})와 실제 감지된 오디오 형식(${signatureResult.format})이 일치하지 않습니다.`,
                400
            );
        }

        // 5. Check declared MIME vs detected format
        const cleanDeclaredMime = String(declaredMime || '').split(';')[0].trim().toLowerCase();
        const allowedMimesForFormat = MIME_MAP[signatureResult.format] || [];

        if (cleanDeclaredMime && !allowedMimesForFormat.includes(cleanDeclaredMime)) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.CONTENT_MISMATCH,
                `선언된 MIME 타입(${cleanDeclaredMime})과 실제 감지된 포맷(${signatureResult.format})이 일치하지 않습니다.`,
                400
            );
        }

        return {
            valid: true,
            detectedFormat: signatureResult.format,
            canonicalMime: signatureResult.canonicalMime
        };
    }
}

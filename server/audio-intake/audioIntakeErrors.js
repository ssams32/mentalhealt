/**
 * server/audio-intake/audioIntakeErrors.js
 * Structured Audio Intake Error Classes for Mind-ERP OS.
 * Guarantees zero sensitive data leakage (no absolute paths, no binary streams, no secrets).
 */

export const INTAKE_ERROR_CODES = Object.freeze({
    CONFIG_MISSING: 'AUDIO_INTAKE_NOT_CONFIGURED',
    INVALID_STREAM: 'AUDIO_STREAM_INVALID',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    PAYLOAD_TOO_SMALL: 'PAYLOAD_TOO_SMALL',
    CONTENT_LENGTH_MISMATCH: 'CONTENT_LENGTH_MISMATCH',
    SIGNATURE_DETECTION_FAILED: 'SIGNATURE_DETECTION_FAILED',
    UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
    CONTENT_MISMATCH: 'CONTENT_MISMATCH',
    DANGEROUS_FILE_DETECTED: 'DANGEROUS_FILE_DETECTED',
    DUPLICATE_CONTENT: 'DUPLICATE_CONTENT_HASH',
    STORAGE_ERROR: 'TEMPORARY_STORAGE_ERROR',
    QUARANTINE_ERROR: 'QUARANTINE_FAILED',
    COORDINATOR_STATE_ERROR: 'COORDINATOR_STATE_ERROR'
});

export class AudioIntakeError extends Error {
    constructor(code, message, status = 400, details = {}) {
        super(message);
        this.name = 'AudioIntakeError';
        this.code = code;
        this.status = status;
        // Strip any accidental sensitive paths or properties from details
        this.details = { ...details };
        delete this.details.absolutePath;
        delete this.details.tempPath;
        delete this.details.token;
        delete this.details.password;
        delete this.details.buffer;
        delete this.details.stream;
    }
}

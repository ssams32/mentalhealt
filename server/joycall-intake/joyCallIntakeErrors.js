/**
 * server/joycall-intake/joyCallIntakeErrors.js
 * Error definitions for JoyCall NAS intake.
 * Strictly redacts internal NAS filesystem paths and credentials.
 */

export class JoyCallIntakeError extends Error {
    constructor(code, message, details = {}) {
        const sanitizedDetails = JoyCallIntakeError.sanitize(details);
        super(message);
        this.name = 'JoyCallIntakeError';
        this.code = code;
        this.details = sanitizedDetails;
    }

    static sanitize(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const copy = Array.isArray(obj) ? [] : {};
        for (const [key, value] of Object.entries(obj)) {
            const lowerKey = key.toLowerCase();
            if (
                lowerKey.includes('path') ||
                lowerKey.includes('nas') ||
                lowerKey.includes('dir') ||
                lowerKey.includes('token') ||
                lowerKey.includes('secret')
            ) {
                copy[key] = '[REDACTED]';
            } else if (typeof value === 'object' && value !== null) {
                copy[key] = JoyCallIntakeError.sanitize(value);
            } else {
                copy[key] = value;
            }
        }
        return copy;
    }
}

export const JOYCALL_INTAKE_ERROR_CODES = Object.freeze({
    INVALID_SOURCE: 'INVALID_SOURCE',
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    UPLOADING_FILE_NOT_READY: 'UPLOADING_FILE_NOT_READY',
    UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
    ZERO_BYTE_PAYLOAD: 'ZERO_BYTE_PAYLOAD',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    FILE_UNSTABLE: 'FILE_UNSTABLE',
    INVALID_SIGNATURE: 'INVALID_SIGNATURE',
    DUPLICATE_CONTENT: 'DUPLICATE_CONTENT',
    STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
    DATABASE_ERROR: 'DATABASE_ERROR'
});

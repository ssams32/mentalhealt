/**
 * server/operations/operationErrors.js
 * Error definitions for Operational Readiness and Orchestration.
 * Strictly redacts file paths, secrets, user IDs, and voice data.
 */

export class OperationError extends Error {
    constructor(code, message, details = {}) {
        // Redact any potentially sensitive fields in details
        const sanitizedDetails = OperationError.sanitize(details);
        super(message);
        this.name = 'OperationError';
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
                lowerKey.includes('filepath') ||
                lowerKey.includes('dir') ||
                lowerKey.includes('password') ||
                lowerKey.includes('token') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('user') ||
                lowerKey.includes('transcript') ||
                lowerKey.includes('summary') ||
                lowerKey.includes('recording')
            ) {
                copy[key] = '[REDACTED]';
            } else if (typeof value === 'object' && value !== null) {
                copy[key] = OperationError.sanitize(value);
            } else {
                copy[key] = value;
            }
        }
        return copy;
    }
}

export const OPERATION_ERROR_CODES = Object.freeze({
    STARTUP_PRECONDITION_FAILED: 'STARTUP_PRECONDITION_FAILED',
    SUBSYSTEM_UNAVAILABLE: 'SUBSYSTEM_UNAVAILABLE',
    SUBSYSTEM_CORRUPTED: 'SUBSYSTEM_CORRUPTED',
    RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
    INVALID_RETENTION_POLICY: 'INVALID_RETENTION_POLICY',
    SHUTDOWN_TIMEOUT: 'SHUTDOWN_TIMEOUT',
    UNAUTHORIZED_MAINTENANCE: 'UNAUTHORIZED_MAINTENANCE'
});

/**
 * server/audit/auditErrors.js
 * Domain error class and error codes for the A11 Persistent Audit Log.
 */

export const AUDIT_ERROR_CODES = Object.freeze({
    AUDIT_PAYLOAD_UNSAFE: 'AUDIT_PAYLOAD_UNSAFE',
    AUDIT_CANONICALIZATION_FAILED: 'AUDIT_CANONICALIZATION_FAILED',
    AUDIT_STORE_FAILED: 'AUDIT_STORE_FAILED',
    AUDIT_STORE_CORRUPTED: 'AUDIT_STORE_CORRUPTED',
    AUDIT_HEAD_STORE_FAILED: 'AUDIT_HEAD_STORE_FAILED',
    AUDIT_HEAD_CORRUPTED: 'AUDIT_HEAD_CORRUPTED',
    AUDIT_EVENT_INVALID: 'AUDIT_EVENT_INVALID',
    AUDIT_TAMPER_DETECTED: 'AUDIT_TAMPER_DETECTED',
    AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
    AUDIT_LOCK_FAILED: 'AUDIT_LOCK_FAILED',
    AUDIT_IDEMPOTENCY_CONFLICT: 'AUDIT_IDEMPOTENCY_CONFLICT',
    AUDIT_OPERATION_FAILED: 'AUDIT_OPERATION_FAILED'
});

export class AuditError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {Record<string, unknown>} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'AuditError';
        this.code = code;
        this.details = details;
    }
}

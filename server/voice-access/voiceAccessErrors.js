/**
 * server/voice-access/voiceAccessErrors.js
 * Standardized Error Classes and Codes for Restricted Voice Access Gate.
 */

export const VOICE_ACCESS_ERROR_CODES = Object.freeze({
    ACCESS_DENIED: 'VOICE_ACCESS_DENIED',
    UNAUTHENTICATED: 'VOICE_ACCESS_UNAUTHENTICATED',
    USER_INACTIVE: 'VOICE_ACCESS_USER_INACTIVE',
    GRANT_REQUIRED: 'VOICE_ACCESS_GRANT_REQUIRED',
    GRANT_EXPIRED: 'VOICE_ACCESS_GRANT_EXPIRED',
    GRANT_SUSPENDED: 'VOICE_ACCESS_GRANT_SUSPENDED',
    GRANT_REVOKED: 'VOICE_ACCESS_GRANT_REVOKED',
    FOUNDATIONAL_ACCESS_REQUIRED: 'VOICE_ACCESS_FOUNDATIONAL_ACCESS_REQUIRED',
    CAPABILITY_REQUIRED: 'VOICE_ACCESS_CAPABILITY_REQUIRED',
    SCOPE_EXPANSION_FORBIDDEN: 'VOICE_ACCESS_SCOPE_EXPANSION_FORBIDDEN',
    OCC_VERSION_CONFLICT: 'VOICE_ACCESS_OCC_VERSION_CONFLICT',
    STORE_CORRUPTED: 'VOICE_ACCESS_STORE_CORRUPTED',
    STORE_UNAVAILABLE: 'VOICE_ACCESS_STORE_UNAVAILABLE',
    INVALID_ARGUMENT: 'VOICE_ACCESS_INVALID_ARGUMENT',
    NOT_FOUND: 'VOICE_ACCESS_NOT_FOUND',
    BOOTSTRAP_ALREADY_INITIALIZED: 'VOICE_ACCESS_BOOTSTRAP_ALREADY_INITIALIZED',
    BOOTSTRAP_UNAUTHORIZED: 'VOICE_ACCESS_BOOTSTRAP_UNAUTHORIZED',
    DUPLICATE_ACTIVE_GRANT: 'VOICE_ACCESS_DUPLICATE_ACTIVE_GRANT',
    PROHIBITED_PAYLOAD: 'VOICE_ACCESS_PROHIBITED_PAYLOAD',
    VOICE_SYSTEM_UNAVAILABLE: 'VOICE_SYSTEM_UNAVAILABLE',
    VOICE_ACCESS_AUTHORIZER_MISSING: 'VOICE_ACCESS_AUTHORIZER_MISSING'
});

export class VoiceAccessError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {number} [statusCode=403]
     * @param {Record<string, unknown>|null} [details=null]
     */
    constructor(code, message, statusCode = 403, details = null) {
        super(message);
        this.name = 'VoiceAccessError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, VoiceAccessError);
        }
    }
}

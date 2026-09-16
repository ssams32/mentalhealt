/**
 * server/jobs/voiceCallJobErrors.js
 * Error definitions for Mind-ERP OS Persistent Job Queue.
 * Mind-ERP OS Track A8.
 */

import { DEFAULT_JOB_LIMITS } from './voiceCallJobConstants.js';

export class VoiceCallJobError extends Error {
    /**
     * @param {string} code - Standardized error code from JOB_ERROR_CODES
     * @param {string} message - Sanitized, non-sensitive error message
     * @param {number} [status=500] - HTTP-equivalent status code
     * @param {Object} [details=null] - Optional safe metadata (no tokens/secrets/pii)
     */
    constructor(code, message, status = 500, details = null) {
        const safeMessage = typeof message === 'string'
            ? message.slice(0, DEFAULT_JOB_LIMITS.MAX_ERROR_MESSAGE_LEN)
            : 'Unknown job error';
        super(safeMessage);
        this.name = 'VoiceCallJobError';
        this.code = code || 'JOB_INTERNAL_ERROR';
        this.status = status;
        this.details = details;
    }
}

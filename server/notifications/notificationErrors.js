/**
 * server/notifications/notificationErrors.js
 * Domain Errors for Persistent Notifications and Outbox.
 * Mind-ERP OS Track A9.
 */

export class NotificationError extends Error {
    /**
     * @param {string} code - From NOTIFICATION_ERROR_CODES
     * @param {string} message - Sanitized, non-sensitive message
     * @param {Object} [details={}] - Optional non-sensitive metadata
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'NotificationError';
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * server/notifications/notificationPayloadPolicy.js
 * Strict Payload Allowlist and Sanitization Policy.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Free text messages are prohibited: all notifications use standard messageCode.
 * - PII and sensitive internal fields (transcript, summary, names, phone, audio paths) are strictly rejected.
 */

import { NOTIFICATION_ERROR_CODES } from './notificationConstants.js';
import { NotificationError } from './notificationErrors.js';

export const ALLOWED_METADATA_KEYS = Object.freeze(new Set([
    'assignmentVersion',
    'reviewStatusCode',
    'sourceEventCode',
    'departmentCanonicalId'
]));

export const PROHIBITED_PAYLOAD_KEYS = Object.freeze(new Set([
    'name',
    'targetName',
    'subjectName',
    'phone',
    'mobile',
    'residentNumber',
    'transcript',
    'summary',
    'note',
    'prompt',
    'response',
    'audioPath',
    'storageKey',
    'contentHash',
    'originalFileName',
    'emailBody',
    'smsBody',
    'session',
    'cookie',
    'password',
    'token',
    'leaseToken',
    'leaseTokenHash',
    'stack'
]));

/**
 * Validates and sanitizes safeMetadata according to strict allowlist.
 * 
 * @param {Object|null|undefined} metadata
 * @returns {Object|null}
 * @throws {NotificationError} If prohibited or unknown keys are present
 */
export function validateAndSanitizeSafeMetadata(metadata) {
    if (metadata === null || metadata === undefined) {
        return null;
    }

    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new NotificationError(
            NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED,
            'safeMetadata must be a plain object'
        );
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(metadata)) {
        const lowerKey = key.toLowerCase();

        // 1. Prohibited check
        if (PROHIBITED_PAYLOAD_KEYS.has(lowerKey)) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED,
                'Prohibited sensitive key detected in metadata'
            );
        }

        // 2. Strict allowlist check
        if (!ALLOWED_METADATA_KEYS.has(key)) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED,
                'Disallowed or unknown metadata key detected'
            );
        }

        // 3. Reject nested objects or arrays
        if (value !== null && typeof value === 'object') {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED,
                'Nested objects and arrays are prohibited in safeMetadata'
            );
        }

        // 4. Primitive value length limit
        if (typeof value === 'string' && value.length > 128) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED,
                'Metadata scalar value exceeds maximum length of 128'
            );
        }

        sanitized[key] = value;
    }

    return Object.keys(sanitized).length > 0 ? Object.freeze(sanitized) : null;
}

/**
 * Check whether a metadata object is safe without throwing.
 */
export function isSafeMetadata(metadata) {
    try {
        validateAndSanitizeSafeMetadata(metadata);
        return true;
    } catch {
        return false;
    }
}

/**
 * server/audit/auditValidator.js
 * Input and stored record validation for A11 Persistent Audit Log.
 */

import {
    AUDIT_CATEGORIES,
    AUDIT_ACTOR_TYPES,
    AUDIT_OUTCOMES,
    AUDIT_EVENT_TYPES,
    EVENT_TYPE_TO_CATEGORY,
    AUDIT_LIMITS,
    AUDIT_SCHEMA_VERSION
} from './auditConstants.js';
import { AuditError, AUDIT_ERROR_CODES } from './auditErrors.js';
import { validateSafeMetadata } from './auditPayloadPolicy.js';

const HEX_64_REGEX = /^[0-9a-f]{64}$/;
const ID_SAFE_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validates external input for an audit event before assignment of sequence and hashes.
 *
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>} Validated and normalized event input
 */
export function validateAuditEntryInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            'Audit event input must be a non-null object'
        );
    }

    // 1. Forbidden caller-supplied fields
    const forbiddenCallerKeys = ['id', 'sequence', 'schemaVersion', 'recordedAt', 'previousEntryHash', 'entryHash'];
    for (const key of forbiddenCallerKeys) {
        if (input[key] !== undefined) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                `Caller is strictly forbidden from providing '${key}'`
            );
        }
    }

    // 2. eventType validation
    if (!input.eventType || typeof input.eventType !== 'string' || !AUDIT_EVENT_TYPES[input.eventType]) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            `Unknown or invalid audit eventType: ${input.eventType}`
        );
    }

    // 3. category validation
    const expectedCategory = EVENT_TYPE_TO_CATEGORY[input.eventType];
    if (input.category && input.category !== expectedCategory) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            `Category mismatch for eventType ${input.eventType}: expected ${expectedCategory}, received ${input.category}`
        );
    }
    const category = expectedCategory || input.category;
    if (!category || !Object.values(AUDIT_CATEGORIES).includes(category)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            `Invalid audit category: ${category}`
        );
    }

    // 4. actorType validation
    if (!input.actorType || !Object.values(AUDIT_ACTOR_TYPES).includes(input.actorType)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            `Invalid actorType: ${input.actorType}`
        );
    }

    // 5. actorId validation
    let actorId = null;
    if (input.actorType === AUDIT_ACTOR_TYPES.ANONYMOUS) {
        if (input.actorId && typeof input.actorId === 'string' && input.actorId.trim().length > 0) {
            actorId = input.actorId.trim();
        }
    } else {
        if (!input.actorId || typeof input.actorId !== 'string') {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                `actorId is required for actorType '${input.actorType}'`
            );
        }
        actorId = input.actorId.trim();
        if (actorId.length === 0 || actorId.length > AUDIT_LIMITS.MAX_IDENTIFIER_LENGTH) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                `actorId length must be between 1 and ${AUDIT_LIMITS.MAX_IDENTIFIER_LENGTH}`
            );
        }
        // Disallow emails or names
        if (actorId.includes('@') || actorId.includes(' ')) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'actorId cannot contain email symbols or spaces'
            );
        }
    }

    // 6. resourceType & resourceId validation
    if (!input.resourceType || typeof input.resourceType !== 'string' || input.resourceType.trim().length === 0) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            'resourceType is required and must be a non-empty string'
        );
    }
    const resourceType = input.resourceType.trim();

    if (!input.resourceId || typeof input.resourceId !== 'string' || input.resourceId.trim().length === 0) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            'resourceId is required and must be a non-empty string'
        );
    }
    const resourceId = input.resourceId.trim();

    // 7. operationId validation (optional)
    let operationId = null;
    if (input.operationId !== undefined && input.operationId !== null) {
        if (typeof input.operationId !== 'string' || input.operationId.trim().length === 0) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'operationId, if provided, must be a non-empty string'
            );
        }
        operationId = input.operationId.trim();
    }

    // 8. outcome validation
    if (!input.outcome || !Object.values(AUDIT_OUTCOMES).includes(input.outcome)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            `Invalid outcome: ${input.outcome}`
        );
    }

    // 9. reasonCode validation (optional)
    let reasonCode = null;
    if (input.reasonCode !== undefined && input.reasonCode !== null) {
        if (typeof input.reasonCode !== 'string') {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'reasonCode must be a string'
            );
        }
        reasonCode = input.reasonCode.trim();
    }

    // 10. beforeVersion & afterVersion validation (optional safe integers)
    let beforeVersion = null;
    if (input.beforeVersion !== undefined && input.beforeVersion !== null) {
        if (!Number.isSafeInteger(input.beforeVersion) || input.beforeVersion < 0) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'beforeVersion must be a non-negative safe integer'
            );
        }
        beforeVersion = input.beforeVersion;
    }

    let afterVersion = null;
    if (input.afterVersion !== undefined && input.afterVersion !== null) {
        if (!Number.isSafeInteger(input.afterVersion) || input.afterVersion < 0) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'afterVersion must be a non-negative safe integer'
            );
        }
        afterVersion = input.afterVersion;
    }

    // 11. occurredAt validation
    let occurredAt = new Date().toISOString();
    if (input.occurredAt !== undefined && input.occurredAt !== null) {
        if (typeof input.occurredAt !== 'string' || Number.isNaN(Date.parse(input.occurredAt))) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
                'occurredAt must be a valid ISO 8601 date string'
            );
        }
        occurredAt = new Date(input.occurredAt).toISOString();
    }

    // 12. safeMetadata validation
    const safeMetadata = validateSafeMetadata(input.safeMetadata);

    return Object.freeze({
        eventType: input.eventType,
        category,
        actorType: input.actorType,
        actorId,
        resourceType,
        resourceId,
        operationId,
        outcome: input.outcome,
        reasonCode,
        beforeVersion,
        afterVersion,
        occurredAt,
        safeMetadata
    });
}

/**
 * Validates an existing audit entry stored in disk or memory.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function validateStoredAuditEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
    }

    if (typeof entry.id !== 'string' || entry.id.length === 0) {
        return false;
    }
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
        return false;
    }
    if (entry.schemaVersion !== AUDIT_SCHEMA_VERSION) {
        return false;
    }
    if (!entry.eventType || !AUDIT_EVENT_TYPES[entry.eventType]) {
        return false;
    }
    if (!entry.category || !Object.values(AUDIT_CATEGORIES).includes(entry.category)) {
        return false;
    }
    if (!entry.actorType || !Object.values(AUDIT_ACTOR_TYPES).includes(entry.actorType)) {
        return false;
    }
    if (!entry.resourceType || typeof entry.resourceType !== 'string') {
        return false;
    }
    if (!entry.resourceId || typeof entry.resourceId !== 'string') {
        return false;
    }
    if (!entry.outcome || !Object.values(AUDIT_OUTCOMES).includes(entry.outcome)) {
        return false;
    }
    if (typeof entry.occurredAt !== 'string' || Number.isNaN(Date.parse(entry.occurredAt))) {
        return false;
    }
    if (typeof entry.recordedAt !== 'string' || Number.isNaN(Date.parse(entry.recordedAt))) {
        return false;
    }
    if (typeof entry.previousEntryHash !== 'string' || !HEX_64_REGEX.test(entry.previousEntryHash)) {
        return false;
    }
    if (typeof entry.entryHash !== 'string' || !HEX_64_REGEX.test(entry.entryHash)) {
        return false;
    }

    return true;
}

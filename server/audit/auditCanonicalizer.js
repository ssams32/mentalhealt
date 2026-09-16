/**
 * server/audit/auditCanonicalizer.js
 * Deterministic JSON serialization with key sorting and Unicode NFC normalization.
 */

import { AuditError, AUDIT_ERROR_CODES } from './auditErrors.js';

/**
 * Recursively canonicalizes a value into a deterministic JSON-compatible structure.
 *
 * @param {unknown} value
 * @param {Set<object>} seen
 * @returns {unknown}
 */
function canonicalizeValue(value, seen = new Set()) {
    if (value === undefined) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
            'Canonical JSON rejects undefined values'
        );
    }

    if (value === null) {
        return null;
    }

    const type = typeof value;

    if (type === 'string') {
        return value.normalize('NFC');
    }

    if (type === 'number') {
        if (!Number.isFinite(value) || Number.isNaN(value)) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
                'Canonical JSON rejects NaN and Infinity'
            );
        }
        if (!Number.isSafeInteger(value)) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
                'Canonical JSON requires safe integers for numbers'
            );
        }
        return value;
    }

    if (type === 'boolean') {
        return value;
    }

    if (type === 'bigint' || type === 'symbol' || type === 'function') {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
            `Canonical JSON rejects unsupported type: ${type}`
        );
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
            'Canonical JSON rejects arrays in audit entry fields'
        );
    }

    if (type === 'object') {
        if (seen.has(value)) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
                'Canonical JSON rejects circular references'
            );
        }
        seen.add(value);

        const sortedKeys = Object.keys(value).sort();
        const sortedObj = {};

        for (const key of sortedKeys) {
            const val = value[key];
            if (val === undefined) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
                    `Canonical JSON rejects undefined property: ${key}`
                );
            }
            sortedObj[key.normalize('NFC')] = canonicalizeValue(val, seen);
        }

        seen.delete(value);
        return sortedObj;
    }

    throw new AuditError(
        AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
        `Unexpected type encountered: ${type}`
    );
}

/**
 * Produces a deterministic canonical JSON string for an object.
 *
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
export function canonicalizeAuditData(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_CANONICALIZATION_FAILED,
            'Input to canonicalizeAuditData must be a non-null plain object'
        );
    }

    const canonicalStructure = canonicalizeValue(obj, new Set());
    return JSON.stringify(canonicalStructure);
}

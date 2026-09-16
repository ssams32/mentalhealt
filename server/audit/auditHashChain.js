/**
 * server/audit/auditHashChain.js
 * Cryptographic hash chain calculation and verification for A11 Persistent Audit Log.
 */

import crypto from 'crypto';
import { GENESIS_HASH } from './auditConstants.js';
import { canonicalizeAuditData } from './auditCanonicalizer.js';
import { AuditError, AUDIT_ERROR_CODES } from './auditErrors.js';

/**
 * Extracts and canonicalizes the fields included in the entryHash digest.
 * Excludes entryHash itself.
 *
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
export function extractHashablePayload(entry) {
    if (!entry || typeof entry !== 'object') {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_EVENT_INVALID,
            'Entry must be a valid object to extract hashable payload'
        );
    }

    return {
        id: entry.id,
        sequence: entry.sequence,
        schemaVersion: entry.schemaVersion,
        eventType: entry.eventType,
        category: entry.category,
        actorType: entry.actorType,
        actorId: entry.actorId !== undefined ? entry.actorId : null,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        operationId: entry.operationId !== undefined ? entry.operationId : null,
        outcome: entry.outcome,
        reasonCode: entry.reasonCode !== undefined ? entry.reasonCode : null,
        beforeVersion: entry.beforeVersion !== undefined ? entry.beforeVersion : null,
        afterVersion: entry.afterVersion !== undefined ? entry.afterVersion : null,
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt,
        previousEntryHash: entry.previousEntryHash,
        safeMetadata: entry.safeMetadata !== undefined ? entry.safeMetadata : null
    };
}

/**
 * Computes the lowercase 64-character SHA-256 hex digest of an audit entry.
 *
 * @param {Record<string, unknown>} entryWithoutHash
 * @returns {string}
 */
export function computeEntryHash(entryWithoutHash) {
    const payload = extractHashablePayload(entryWithoutHash);
    const canonicalJson = canonicalizeAuditData(payload);
    return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
}

/**
 * Verifies that the entry's self-contained entryHash matches the computed SHA-256 digest.
 *
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
export function verifyEntryHash(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.entryHash !== 'string') {
        return false;
    }

    const expectedHash = computeEntryHash(entry);
    return entry.entryHash === expectedHash;
}

/**
 * Verifies the cryptographic linkage between two sequential audit entries.
 *
 * @param {Record<string, unknown>} currentEntry
 * @param {Record<string, unknown> | null} previousEntry
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyHashChainLink(currentEntry, previousEntry) {
    if (!currentEntry) {
        return { valid: false, reason: 'Current entry is missing' };
    }

    // 1. Genesis entry check
    if (!previousEntry) {
        if (currentEntry.sequence !== 1) {
            return {
                valid: false,
                reason: `Genesis entry must have sequence 1, got ${currentEntry.sequence}`
            };
        }
        if (currentEntry.previousEntryHash !== GENESIS_HASH) {
            return {
                valid: false,
                reason: 'Genesis entry must reference GENESIS_HASH'
            };
        }
    } else {
        // 2. Sequential entry check
        if (currentEntry.sequence !== previousEntry.sequence + 1) {
            return {
                valid: false,
                reason: `Sequence gap or mismatch: expected ${previousEntry.sequence + 1}, got ${currentEntry.sequence}`
            };
        }
        if (currentEntry.previousEntryHash !== previousEntry.entryHash) {
            return {
                valid: false,
                reason: 'previousEntryHash does not match previous entryHash'
            };
        }
    }

    // 3. Self-hash verification
    if (!verifyEntryHash(currentEntry)) {
        return {
            valid: false,
            reason: 'Self-computed entryHash mismatch'
        };
    }

    return { valid: true };
}

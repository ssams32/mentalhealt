/**
 * server/audit/auditRepository.js
 * Append-only persistent repository for Mind-ERP OS Track A11 Audit Log.
 * Serializes writes using canonical file path lock and guarantees cryptographic chain continuity.
 *
 * LOCKING BOUNDARY STATEMENT:
 * withFileLock protects concurrent asynchronous operations inside one Node.js process only.
 * It does not protect:
 * - multiple Node.js processes
 * - multiple containers
 * - multiple hosts
 * - shared NAS writers
 */

import crypto from 'crypto';
import path from 'path';
import {
    AUDIT_STORAGE_FILE,
    AUDIT_HEAD_STORAGE_FILE,
    AUDIT_SCHEMA_VERSION,
    GENESIS_HASH,
    AUDIT_LIMITS
} from './auditConstants.js';
import { AuditError, AUDIT_ERROR_CODES } from './auditErrors.js';
import { validateAuditEntryInput, validateStoredAuditEntry } from './auditValidator.js';
import { computeEntryHash, verifyEntryHash, verifyHashChainLink } from './auditHashChain.js';
import { withFileLock, normalizeLockKey } from '../storage/sharedFileLockRegistry.js';

export class AuditRepository {
    /**
     * @param {Function} getDataFn - (filename, defaultValue) => any
     * @param {Function} persistDataFn - async (filename, data) => Promise<boolean>
     * @param {object} [deps]
     */
    constructor(getDataFn, persistDataFn, deps = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.dataDir = deps.dataDir || '';
        this.isCorrupted = false;

        // Compute normalized lock key
        const baseKey = this.dataDir
            ? path.resolve(this.dataDir, AUDIT_STORAGE_FILE)
            : AUDIT_STORAGE_FILE;
        this.lockKey = normalizeLockKey(baseKey);
    }

    /**
     * Appends a new verified audit event to the append-only log.
     * Guarantees strict sequential sequence and cryptographic previousEntryHash linking.
     *
     * @param {Record<string, unknown>} eventInput
     * @returns {Promise<Record<string, unknown>>}
     */
    async appendEvent(eventInput) {
        return withFileLock(this.lockKey, async () => {
            if (this.isCorrupted) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_STORE_CORRUPTED,
                    'Audit store is in corrupted state: append operations are blocked'
                );
            }

            // 1. Load existing entries
            let rawEntries;
            try {
                rawEntries = this.getData(AUDIT_STORAGE_FILE, null);
            } catch {
                this.isCorrupted = true;
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_STORE_CORRUPTED,
                    'Failed to read Audit store from disk: invalid or corrupted data'
                );
            }

            let entries = [];
            if (rawEntries === null || rawEntries === undefined) {
                entries = [];
            } else if (Array.isArray(rawEntries)) {
                entries = rawEntries;
            } else {
                this.isCorrupted = true;
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_STORE_CORRUPTED,
                    'Audit store data is not an array'
                );
            }

            // 2. Option C: Validate last entry if exists before appending
            let previousEntryHash = GENESIS_HASH;
            let nextSequence = 1;

            if (entries.length > 0) {
                const lastEntry = entries[entries.length - 1];
                if (!validateStoredAuditEntry(lastEntry) || !verifyEntryHash(lastEntry)) {
                    this.isCorrupted = true;
                    throw new AuditError(
                        AUDIT_ERROR_CODES.AUDIT_CHAIN_BROKEN,
                        'Audit hash chain broken at tail entry: append aborted'
                    );
                }
                previousEntryHash = lastEntry.entryHash;
                nextSequence = lastEntry.sequence + 1;
            }

            // 3. Validate and normalize input
            const validated = validateAuditEntryInput(eventInput);

            // 4. Construct entry with server-generated cryptographic identifiers
            const entryId = `audit_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
            const recordedAt = new Date().toISOString();

            const candidateWithoutHash = {
                id: entryId,
                sequence: nextSequence,
                schemaVersion: AUDIT_SCHEMA_VERSION,
                eventType: validated.eventType,
                category: validated.category,
                actorType: validated.actorType,
                actorId: validated.actorId,
                resourceType: validated.resourceType,
                resourceId: validated.resourceId,
                operationId: validated.operationId,
                outcome: validated.outcome,
                reasonCode: validated.reasonCode,
                beforeVersion: validated.beforeVersion,
                afterVersion: validated.afterVersion,
                occurredAt: validated.occurredAt,
                recordedAt,
                previousEntryHash,
                safeMetadata: validated.safeMetadata
            };

            // 5. Compute cryptographic SHA-256 entryHash
            const entryHash = computeEntryHash(candidateWithoutHash);
            const fullEntry = Object.freeze({
                ...candidateWithoutHash,
                entryHash
            });

            // 6. Append to list
            const updatedList = [...entries, fullEntry];

            // 7. Persist AuditEntries.json
            let saveSuccess = false;
            try {
                saveSuccess = await this.persistData(AUDIT_STORAGE_FILE, updatedList);
            } catch (err) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_STORE_FAILED,
                    `Disk write exception occurred for Audit store: ${err && err.message ? err.message : String(err)}`
                );
            }

            if (!saveSuccess) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_STORE_FAILED,
                    'Failed to persist Audit store to disk'
                );
            }

            // 8. Persist AuditHead.json anchor (best effort; discrepancies are caught in Reconciliation)
            try {
                const headData = {
                    schemaVersion: AUDIT_SCHEMA_VERSION,
                    lastSequence: fullEntry.sequence,
                    lastEntryHash: fullEntry.entryHash,
                    updatedAt: fullEntry.recordedAt
                };
                await this.persistData(AUDIT_HEAD_STORAGE_FILE, headData);
            } catch {
                // Head failure does not invalidate entry write, but triggers audit reconciliation check
            }

            return JSON.parse(JSON.stringify(fullEntry));
        });
    }

    /**
     * Reads a slice of entries from the store (read-only).
     *
     * @param {{ fromSequence?: number, limit?: number }} [options]
     * @returns {Promise<Array<Record<string, unknown>>>}
     */
    async getEntries({ fromSequence = 1, limit = AUDIT_LIMITS.MAX_QUERY_LIMIT } = {}) {
        return withFileLock(this.lockKey, async () => {
            const rawEntries = this.getData(AUDIT_STORAGE_FILE, []);
            if (!Array.isArray(rawEntries)) {
                return [];
            }
            const filtered = rawEntries.filter(e => e && e.sequence >= fromSequence);
            const capped = filtered.slice(0, Math.min(limit, AUDIT_LIMITS.MAX_QUERY_LIMIT));
            return JSON.parse(JSON.stringify(capped));
        });
    }

    /**
     * Retrieves an audit entry by its sequence number.
     *
     * @param {number} sequence
     * @returns {Promise<Record<string, unknown> | null>}
     */
    async getEntryBySequence(sequence) {
        return withFileLock(this.lockKey, async () => {
            const rawEntries = this.getData(AUDIT_STORAGE_FILE, []);
            if (!Array.isArray(rawEntries)) return null;
            const found = rawEntries.find(e => e && e.sequence === sequence);
            return found ? JSON.parse(JSON.stringify(found)) : null;
        });
    }

    /**
     * Retrieves the audit anchor head from AuditHead.json.
     *
     * @returns {Promise<Record<string, unknown> | null>}
     */
    async getHead() {
        return withFileLock(this.lockKey, async () => {
            try {
                const head = this.getData(AUDIT_HEAD_STORAGE_FILE, null);
                return head && typeof head === 'object' ? JSON.parse(JSON.stringify(head)) : null;
            } catch {
                return null;
            }
        });
    }

    /**
     * Checks if a successful audit event with the given operationId already exists in persistent storage.
     * Used for persistent deduplication across process restarts or cache flushes.
     *
     * @param {string} operationId
     * @returns {Promise<boolean>}
     */
    async hasSuccessfulOperationEvent(operationId) {
        if (!operationId) return false;
        return withFileLock(this.lockKey, async () => {
            const rawEntries = this.getData(AUDIT_STORAGE_FILE, []);
            if (!Array.isArray(rawEntries)) return false;
            const targetOpId = String(operationId).trim();
            return rawEntries.some(e => e && e.operationId === targetOpId && e.outcome === 'success');
        });
    }

    /**
     * Resets corruption status ONLY if the store currently on disk parses cleanly
     * and completely satisfies schema, sequential sequence, and hash chain validation.
     *
     * @returns {boolean} True if successfully reset, false if store remains invalid.
     */
    resetCorruptionState() {
        try {
            const raw = this.getData(AUDIT_STORAGE_FILE, null);
            if (!Array.isArray(raw)) {
                this.isCorrupted = true;
                return false;
            }

            let prev = null;
            for (const entry of raw) {
                if (!validateStoredAuditEntry(entry)) {
                    this.isCorrupted = true;
                    return false;
                }
                const linkResult = verifyHashChainLink(entry, prev);
                if (!linkResult.valid) {
                    this.isCorrupted = true;
                    return false;
                }
                prev = entry;
            }

            this.isCorrupted = false;
            return true;
        } catch {
            this.isCorrupted = true;
            return false;
        }
    }
}

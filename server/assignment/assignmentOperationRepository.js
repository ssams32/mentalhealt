/**
 * server/assignment/assignmentOperationRepository.js
 * In-process, File-Locked Persistence for VoiceCall Assignment Operations.
 * Mind-ERP OS Track A10.
 */

import crypto from 'crypto';
import path from 'path';
import {
    ASSIGNMENT_OPERATIONS_STORAGE_FILE,
    OPERATION_STATUS,
    ASSIGNMENT_ERROR_CODES,
    ASSIGNMENT_LIMITS
} from './assignmentConstants.js';
import { AssignmentError } from './assignmentErrors.js';
import { validateAssignmentOperation } from './assignmentValidator.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

function deepClone(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(obj);
        } catch {
            // fallback
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

export class AssignmentOperationRepository {
    constructor(getDataFn, persistDataFn, options = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.dataDir = options.dataDir || process.env.DATA_DIR || './';
        this.isCorrupted = false;

        const rawPath = path.resolve(this.dataDir, `${ASSIGNMENT_OPERATIONS_STORAGE_FILE}.json`);
        this.lockKey = process.platform === 'win32' ? rawPath.toLowerCase() : rawPath;
        this.limits = { ...ASSIGNMENT_LIMITS, ...(options.limits || {}) };
    }

    _loadStore() {
        if (this.isCorrupted) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                'AssignmentOperation store is in fail-closed corrupted state',
                503
            );
        }
        let raw;
        try {
            raw = this.getData(ASSIGNMENT_OPERATIONS_STORAGE_FILE, []);
        } catch (err) {
            this.isCorrupted = true;
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                'Failed to read AssignmentOperation store from disk',
                503
            );
        }
        if (!Array.isArray(raw)) {
            this.isCorrupted = true;
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                'AssignmentOperation store content is not an array',
                503
            );
        }
        return raw;
    }

    async _saveStore(operations) {
        if (!Array.isArray(operations)) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                'Cannot persist non-array to AssignmentOperation store'
            );
        }
        let success = false;
        try {
            success = await this.persistData(ASSIGNMENT_OPERATIONS_STORAGE_FILE, operations);
        } catch (err) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_FAILED,
                `Exception thrown while writing AssignmentOperation store to disk: ${err && err.message ? err.message : String(err)}`
            );
        }
        if (!success) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_FAILED,
                'Failed to write AssignmentOperation store to disk'
            );
        }
        return true;
    }

    resetCorruptionState() {
        try {
            const records = this.getData(ASSIGNMENT_OPERATIONS_STORAGE_FILE, null);
            if (!Array.isArray(records)) {
                this.isCorrupted = true;
                throw new AssignmentError(ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED, 'Not an array');
            }
            const seenIds = new Set();
            const seenOpIds = new Set();

            for (const r of records) {
                validateAssignmentOperation(r);
                if (seenIds.has(r.id)) {
                    this.isCorrupted = true;
                    throw new AssignmentError(ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED, 'Duplicate ID');
                }
                seenIds.add(r.id);

                if (seenOpIds.has(r.operationId)) {
                    this.isCorrupted = true;
                    throw new AssignmentError(ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED, 'Duplicate operationId');
                }
                seenOpIds.add(r.operationId);
            }

            this.isCorrupted = false;
            return true;
        } catch (err) {
            this.isCorrupted = true;
            if (err instanceof AssignmentError) throw err;
            throw new AssignmentError(ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED, err.message);
        }
    }

    async createOperation(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const operations = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const isoNow = now.toISOString();

            const {
                operationId,
                callId,
                actorUserId,
                requestedDepartmentId,
                requestedUserId,
                expectedVersion,
                reasonCode,
                requestFingerprint
            } = params;

            // Check if existing operation with same operationId already exists
            const existing = operations.find(o => o.operationId === operationId);
            if (existing) {
                // Idempotency check: compare fingerprint if available, otherwise compare core fields
                if (existing.requestFingerprint && requestFingerprint) {
                    if (existing.requestFingerprint === requestFingerprint) {
                        return deepClone(existing);
                    }
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT,
                        'OperationId already exists with differing fingerprint or actor context',
                        409
                    );
                }

                if (
                    existing.callId === callId &&
                    existing.actorUserId === actorUserId &&
                    existing.requestedUserId === requestedUserId &&
                    existing.requestedDepartmentId === requestedDepartmentId &&
                    existing.expectedVersion === expectedVersion
                ) {
                    return deepClone(existing);
                }
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT,
                    'OperationId already exists with differing command parameters',
                    409
                );
            }

            if (operations.length >= this.limits.MAX_TOTAL_OPERATIONS) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_FAILED,
                    'Max total operations capacity reached'
                );
            }

            const id = `op_${crypto.randomUUID()}`;
            const newOp = {
                id,
                operationId: String(operationId),
                callId: String(callId),
                actorUserId: String(actorUserId),
                requestedDepartmentId: String(requestedDepartmentId),
                requestedUserId: String(requestedUserId),
                expectedVersion: Number(expectedVersion),
                reasonCode: reasonCode || undefined,
                requestFingerprint: requestFingerprint || undefined,
                status: OPERATION_STATUS.PENDING,
                resultingCallVersion: null,
                historyRecordId: null,
                outboxEventId: null,
                lastErrorCode: null,
                createdAt: isoNow,
                updatedAt: isoNow,
                completedAt: null,
                version: 1
            };

            validateAssignmentOperation(newOp);

            operations.push(deepClone(newOp));
            await this._saveStore(operations);

            return deepClone(newOp);
        });
    }

    findById(id) {
        const operations = this._loadStore();
        const found = operations.find(o => o.id === id);
        return found ? deepClone(found) : null;
    }

    findByOperationId(operationId) {
        if (!operationId) return null;
        const operations = this._loadStore();
        const found = operations.find(o => o.operationId === String(operationId));
        return found ? deepClone(found) : null;
    }

    async updateStage(id, newStatus, updates = {}) {
        return withFileLock(this.lockKey, async () => {
            const operations = this._loadStore();
            const now = updates.now instanceof Date && !Number.isNaN(updates.now.getTime()) ? updates.now : new Date();

            const op = operations.find(o => o.id === id);
            if (!op) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_RESOURCE_NOT_FOUND,
                    `AssignmentOperation ${id} not found`,
                    404
                );
            }

            op.status = newStatus;
            op.updatedAt = now.toISOString();
            op.version += 1;

            if (updates.requestFingerprint !== undefined) {
                op.requestFingerprint = updates.requestFingerprint;
            }
            if (updates.resultingCallVersion !== undefined) {
                op.resultingCallVersion = updates.resultingCallVersion;
            }
            if (updates.historyRecordId !== undefined) {
                op.historyRecordId = updates.historyRecordId;
            }
            if (updates.outboxEventId !== undefined) {
                op.outboxEventId = updates.outboxEventId;
            }
            if (updates.lastErrorCode !== undefined) {
                op.lastErrorCode = updates.lastErrorCode;
            }
            if (
                newStatus === OPERATION_STATUS.COMPLETED ||
                newStatus === OPERATION_STATUS.FAILED ||
                newStatus === OPERATION_STATUS.CONFLICT
            ) {
                op.completedAt = now.toISOString();
            }

            validateAssignmentOperation(op);
            await this._saveStore(operations);

            return deepClone(op);
        });
    }

    list() {
        const operations = this._loadStore();
        return operations.map(deepClone);
    }
}

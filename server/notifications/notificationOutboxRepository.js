/**
 * server/notifications/notificationOutboxRepository.js
 * Persistent Storage for Transactional Notification Outbox Events.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Real file path Shared File Lock per instance.
 * - Raw lease tokens are NEVER persisted to disk: only sha256 hashes.
 * - Atomic single commit for claimNextEvent.
 * - Monotonically non-decreasing attemptCount: increments strictly upon successful lease claim.
 */

import crypto from 'crypto';
import path from 'path';
import {
    OUTBOX_STATUS,
    ACTIVE_OUTBOX_STATUSES,
    DEFAULT_NOTIFICATION_LIMITS,
    NOTIFICATION_ERROR_CODES
} from './notificationConstants.js';
import { NotificationError } from './notificationErrors.js';
import { validateOutboxRecord } from './notificationValidator.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

export const OUTBOX_STORAGE_FILE = 'NotificationOutbox';

function deepClone(val) {
    return JSON.parse(JSON.stringify(val));
}

function safeTokenMatchesHash(providedToken, storedHash) {
    if (typeof providedToken !== 'string' || typeof storedHash !== 'string') return false;
    if (providedToken.length === 0 || providedToken.length > 256 || storedHash.length !== 64) return false;
    try {
        const computedHash = crypto.createHash('sha256').update(providedToken).digest('hex');
        const bufA = Buffer.from(computedHash, 'hex');
        const bufB = Buffer.from(storedHash, 'hex');
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

export class NotificationOutboxRepository {
    /**
     * @param {Function} getDataFn
     * @param {Function} persistDataFn
     * @param {Object} [deps={}]
     */
    constructor(getDataFn, persistDataFn, deps = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.limits = {
            ...DEFAULT_NOTIFICATION_LIMITS,
            ...(deps.limits || {})
        };

        if (deps.filePath) {
            this.filePath = path.resolve(deps.filePath);
        } else if (deps.dataDir) {
            this.filePath = path.resolve(deps.dataDir, `${OUTBOX_STORAGE_FILE}.json`);
        } else {
            this.filePath = path.resolve(process.cwd(), 'app', 'data', `${OUTBOX_STORAGE_FILE}.json`);
        }
        this.lockKey = this.filePath;
        this.isCorrupted = false;
    }

    _loadStore() {
        if (this.isCorrupted) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED,
                'Outbox store is corrupted. Operations halted.'
            );
        }

        let raw;
        try {
            raw = this.getData(OUTBOX_STORAGE_FILE, []);
        } catch {
            this.isCorrupted = true;
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_STORE_READ_FAILED,
                'Failed to read Outbox storage from disk.'
            );
        }

        if (!Array.isArray(raw)) {
            this.isCorrupted = true;
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED,
                'Outbox store root must be an array.'
            );
        }

        return raw;
    }

    async _saveStore(events) {
        if (!Array.isArray(events)) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID,
                'Cannot persist non-array to Outbox store'
            );
        }
        let success = false;
        try {
            success = await this.persistData(OUTBOX_STORAGE_FILE, events);
        } catch {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_STORE_WRITE_FAILED,
                'Exception thrown while writing Outbox store to disk'
            );
        }
        if (!success) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.OUTBOX_STORE_WRITE_FAILED,
                'Failed to write Outbox store to disk'
            );
        }
        return true;
    }

    resetCorruptionState() {
        try {
            const records = this.getData(OUTBOX_STORAGE_FILE, null);
            if (!Array.isArray(records)) {
                this.isCorrupted = true;
                throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED, 'Not an array');
            }
            const seenIds = new Set();
            const seenDedup = new Set();

            for (const record of records) {
                validateOutboxRecord(record);
                if (seenIds.has(record.id)) {
                    this.isCorrupted = true;
                    throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED, 'Duplicate ID');
                }
                seenIds.add(record.id);

                if (ACTIVE_OUTBOX_STATUSES.includes(record.status)) {
                    if (seenDedup.has(record.deduplicationKey)) {
                        this.isCorrupted = true;
                        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED, 'Duplicate active deduplication key');
                    }
                    seenDedup.add(record.deduplicationKey);
                }
            }

            this.isCorrupted = false;
            return true;
        } catch (err) {
            this.isCorrupted = true;
            if (err instanceof NotificationError) throw err;
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_STORE_CORRUPTED, err.message);
        }
    }

    _verifyLease(event, workerId, leaseToken, now = new Date()) {
        if (!workerId || typeof workerId !== 'string') {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_REQUIRED, 'workerId is required to assert lease');
        }
        if (!leaseToken || typeof leaseToken !== 'string') {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_TOKEN_INVALID, 'leaseToken is required');
        }
        if (event.leaseOwner !== workerId) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_OWNER_MISMATCH, 'Lease owner mismatch');
        }
        if (!safeTokenMatchesHash(leaseToken, event.leaseTokenHash)) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_TOKEN_INVALID, 'Invalid lease token provided');
        }
        if (!event.leaseExpiresAt || new Date(event.leaseExpiresAt).getTime() <= now.getTime()) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_EXPIRED, 'Lease has expired');
        }
        return true;
    }

    /**
     * Generate canonical server-side deduplication key.
     */
    generateDeduplicationKey(eventType, aggregateType, aggregateId, recipientUserId, sourceVersion = 1) {
        return crypto.createHash('sha256')
            .update(`${eventType}:${aggregateType}:${aggregateId}:${recipientUserId}:${sourceVersion}`)
            .digest('hex');
    }

    /**
     * Create a new Outbox event.
     */
    async createEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const isoNow = now.toISOString();

            const {
                eventType,
                aggregateType,
                aggregateId,
                recipientUserId,
                sourceVersion = 1,
                payload = {},
                maxAttempts = this.limits.MAX_ATTEMPTS,
                customId = null
            } = params;

            if (!recipientUserId || typeof recipientUserId !== 'string' || recipientUserId.trim() === '') {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.RECIPIENT_INVALID, 'recipientUserId is required');
            }

            const deduplicationKey = this.generateDeduplicationKey(
                eventType,
                aggregateType,
                aggregateId,
                recipientUserId.trim(),
                sourceVersion
            );

            // Active deduplication check
            const existingActive = events.find(e => e.deduplicationKey === deduplicationKey && ACTIVE_OUTBOX_STATUSES.includes(e.status));
            if (existingActive) {
                if (params.idempotentResume === true) {
                    const isMatch = JSON.stringify(existingActive.payload) === JSON.stringify(payload);
                    if (isMatch) {
                        return deepClone(existingActive);
                    }
                    throw new NotificationError(
                        NOTIFICATION_ERROR_CODES.OUTBOX_IDEMPOTENCY_CONFLICT,
                        `Active outbox event already exists for deduplication key [${deduplicationKey}] with differing payload`
                    );
                }
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_IDEMPOTENCY_CONFLICT,
                    `Active outbox event already exists for this deduplication key`
                );
            }

            // Already delivered check
            const existingDelivered = events.find(e => e.deduplicationKey === deduplicationKey && e.status === OUTBOX_STATUS.DELIVERED);
            if (existingDelivered) {
                const isMatch = JSON.stringify(existingDelivered.payload) === JSON.stringify(payload);
                if (isMatch) {
                    return deepClone(existingDelivered);
                }
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_IDEMPOTENCY_CONFLICT,
                    `Delivered outbox event already exists for deduplication key [${deduplicationKey}] with differing payload`
                );
            }

            if (events.length >= this.limits.MAX_TOTAL_OUTBOX) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.CAPACITY_EXCEEDED, 'Outbox total capacity exceeded');
            }

            const id = customId || `outbox_${crypto.randomUUID().replace(/-/g, '')}`;
            const newEvent = {
                id,
                eventType,
                aggregateType,
                aggregateId,
                recipientUserId: recipientUserId.trim(),
                sourceVersion,
                deduplicationKey,
                payload: deepClone(payload),
                status: OUTBOX_STATUS.PENDING,
                attemptCount: 0,
                maxAttempts,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
                deliveredNotificationId: null,
                lastErrorCode: null,
                createdAt: isoNow,
                updatedAt: isoNow,
                deliveredAt: null,
                failedAt: null,
                cancelledAt: null,
                version: 1
            };

            validateOutboxRecord(newEvent);

            events.push(newEvent);
            await this._saveStore(events);

            return deepClone(newEvent);
        });
    }

    findById(id) {
        const events = this._loadStore();
        const found = events.find(e => e.id === id);
        return found ? deepClone(found) : null;
    }

    findByDeduplicationKey(deduplicationKey) {
        const events = this._loadStore();
        const found = events.find(e => e.deduplicationKey === deduplicationKey);
        return found ? deepClone(found) : null;
    }

    _recoverExpiredLeasesInternal(events, now) {
        const nowMs = now.getTime();
        let count = 0;
        for (const ev of events) {
            if ([OUTBOX_STATUS.LEASED, OUTBOX_STATUS.DISPATCHING].includes(ev.status)) {
                if (ev.leaseExpiresAt && new Date(ev.leaseExpiresAt).getTime() <= nowMs) {
                    if (ev.attemptCount < ev.maxAttempts) {
                        ev.status = OUTBOX_STATUS.RETRY_WAIT;
                        ev.nextAttemptAt = now.toISOString();
                        ev.lastErrorCode = NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_EXPIRED;
                    } else {
                        ev.status = OUTBOX_STATUS.FAILED;
                        ev.failedAt = now.toISOString();
                        ev.lastErrorCode = NOTIFICATION_ERROR_CODES.OUTBOX_MAX_ATTEMPTS_EXCEEDED;
                    }
                    ev.leaseOwner = null;
                    ev.leaseTokenHash = null;
                    ev.leaseAcquiredAt = null;
                    ev.leaseExpiresAt = null;
                    ev.updatedAt = now.toISOString();
                    ev.version += 1;
                    count++;
                }
            }
        }
        return count;
    }

    _releaseDueRetriesInternal(events, now) {
        const nowMs = now.getTime();
        let count = 0;
        for (const ev of events) {
            if (ev.status === OUTBOX_STATUS.RETRY_WAIT) {
                if (ev.nextAttemptAt && new Date(ev.nextAttemptAt).getTime() <= nowMs) {
                    ev.status = OUTBOX_STATUS.PENDING;
                    ev.nextAttemptAt = null;
                    ev.updatedAt = now.toISOString();
                    ev.version += 1;
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Atomically claim next pending Outbox event inside lock with single commit.
     */
    async claimNextEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const nowMs = now.getTime();
            const isoNow = now.toISOString();

            const {
                workerId,
                leaseDurationMs = this.limits.DEFAULT_LEASE_DURATION_MS
            } = params;

            if (!workerId || typeof workerId !== 'string') {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_REQUIRED, 'workerId is required to claim outbox event');
            }

            let storeMutated = false;

            // 1. Recover expired leases
            if (this._recoverExpiredLeasesInternal(events, now) > 0) storeMutated = true;

            // 2. Release due retries
            if (this._releaseDueRetriesInternal(events, now) > 0) storeMutated = true;

            // 3. Filter pending
            const eligible = events.filter(e => {
                if (e.status !== OUTBOX_STATUS.PENDING) return false;
                if (e.nextAttemptAt && new Date(e.nextAttemptAt).getTime() > nowMs) return false;
                return true;
            });

            if (eligible.length === 0) {
                if (storeMutated) {
                    await this._saveStore(events);
                }
                return null;
            }

            // 4. Sort by createdAt ASC, id ASC
            eligible.sort((a, b) => {
                const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                if (diff !== 0) return diff;
                return a.id.localeCompare(b.id);
            });

            const candidate = eligible[0];

            // 5. Claim and lease
            candidate.attemptCount += 1; // Monotonically incremented ONLY on successful claim
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();

            candidate.status = OUTBOX_STATUS.LEASED;
            candidate.leaseOwner = workerId;
            candidate.leaseTokenHash = tokenHash;
            candidate.leaseAcquiredAt = isoNow;
            candidate.leaseExpiresAt = leaseExpiresAt;
            candidate.updatedAt = isoNow;
            candidate.version += 1;

            validateOutboxRecord(candidate);

            // Single commit to disk
            await this._saveStore(events);

            return {
                event: deepClone(candidate),
                leaseToken: rawToken
            };
        });
    }

    async markDispatching(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            ev.status = OUTBOX_STATUS.DISPATCHING;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    async heartbeat(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken, leaseDurationMs = this.limits.DEFAULT_LEASE_DURATION_MS } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            if (ev.heartbeatAt) {
                const elapsed = now.getTime() - new Date(ev.heartbeatAt).getTime();
                if (elapsed < this.limits.MIN_HEARTBEAT_INTERVAL_MS) {
                    throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_HEARTBEAT_TOO_FREQUENT, 'Heartbeat invoked too frequently');
                }
            }

            ev.heartbeatAt = now.toISOString();
            ev.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    async markDelivered(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken, deliveredNotificationId } = params;

            if (!deliveredNotificationId || typeof deliveredNotificationId !== 'string') {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'deliveredNotificationId is required');
            }

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            ev.status = OUTBOX_STATUS.DELIVERED;
            ev.deliveredNotificationId = deliveredNotificationId;
            ev.deliveredAt = now.toISOString();
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    async scheduleRetry(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken, errorCode, nextAttemptAt } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            ev.status = OUTBOX_STATUS.RETRY_WAIT;
            ev.nextAttemptAt = (nextAttemptAt instanceof Date ? nextAttemptAt : new Date(nextAttemptAt)).toISOString();
            ev.lastErrorCode = errorCode || NOTIFICATION_ERROR_CODES.TRANSIENT_DISPATCH_FAILURE;
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    async markFailed(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken, errorCode } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            ev.status = OUTBOX_STATUS.FAILED;
            ev.failedAt = now.toISOString();
            ev.lastErrorCode = errorCode || NOTIFICATION_ERROR_CODES.OUTBOX_MAX_ATTEMPTS_EXCEEDED;
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    /**
     * Cancel an event held by a worker lease.
     * Credentials (workerId, leaseToken) are strictly MANDATORY.
     */
    async cancelLeasedEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            if (ev.status === OUTBOX_STATUS.DELIVERED) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Cannot cancel already delivered event');
            }

            ev.status = OUTBOX_STATUS.CANCELLED;
            ev.cancelledAt = now.toISOString();
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    /**
     * Block an event held by a worker lease.
     * Credentials (workerId, leaseToken) are strictly MANDATORY.
     */
    async blockLeasedEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, workerId, leaseToken, reasonCode } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            this._verifyLease(ev, workerId, leaseToken, now);

            ev.status = OUTBOX_STATUS.BLOCKED;
            ev.lastErrorCode = reasonCode || NOTIFICATION_ERROR_CODES.NOTIFICATION_SUBSYSTEM_DISABLED;
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    /**
     * Administratively cancel an event.
     * Requires internal system context and reasonCode. Rejects if actively leased unless forced.
     */
    async administrativelyCancelEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, systemContext, reasonCode = 'ADMIN_CANCEL' } = params;

            if (!systemContext || typeof systemContext !== 'object') {
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID,
                    'systemContext is required for administrative operations'
                );
            }

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            if (ev.status === OUTBOX_STATUS.DELIVERED) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Cannot cancel already delivered event');
            }

            // Check if actively leased without expired lease
            if (
                (ev.status === OUTBOX_STATUS.LEASED || ev.status === OUTBOX_STATUS.DISPATCHING) &&
                ev.leaseExpiresAt && new Date(ev.leaseExpiresAt).getTime() > now.getTime() &&
                !systemContext.forceOverride
            ) {
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_REQUIRED,
                    'Cannot administratively cancel actively leased event without explicit recovery override'
                );
            }

            ev.status = OUTBOX_STATUS.CANCELLED;
            ev.cancelledAt = now.toISOString();
            ev.lastErrorCode = reasonCode;
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    /**
     * Administratively block an event.
     * Requires internal system context and reasonCode. Rejects if actively leased unless forced.
     */
    async administrativelyBlockEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId, systemContext, reasonCode = NOTIFICATION_ERROR_CODES.NOTIFICATION_SUBSYSTEM_DISABLED } = params;

            if (!systemContext || typeof systemContext !== 'object') {
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID,
                    'systemContext is required for administrative operations'
                );
            }

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            if (
                (ev.status === OUTBOX_STATUS.LEASED || ev.status === OUTBOX_STATUS.DISPATCHING) &&
                ev.leaseExpiresAt && new Date(ev.leaseExpiresAt).getTime() > now.getTime() &&
                !systemContext.forceOverride
            ) {
                throw new NotificationError(
                    NOTIFICATION_ERROR_CODES.OUTBOX_LEASE_REQUIRED,
                    'Cannot administratively block actively leased event without explicit recovery override'
                );
            }

            ev.status = OUTBOX_STATUS.BLOCKED;
            ev.lastErrorCode = reasonCode;
            ev.leaseOwner = null;
            ev.leaseTokenHash = null;
            ev.leaseAcquiredAt = null;
            ev.leaseExpiresAt = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    async cancelEvent(params = {}) {
        if (params.workerId || params.leaseToken) {
            return this.cancelLeasedEvent(params);
        }
        return this.administrativelyCancelEvent({
            ...params,
            systemContext: params.systemContext || { internal: true, forceOverride: true }
        });
    }

    async blockEvent(params = {}) {
        if (params.workerId || params.leaseToken) {
            return this.blockLeasedEvent(params);
        }
        return this.administrativelyBlockEvent({
            ...params,
            systemContext: params.systemContext || { internal: true, forceOverride: true }
        });
    }

    async unblockEvent(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const events = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { eventId } = params;

            const ev = events.find(e => e.id === eventId);
            if (!ev) throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_EVENT_NOT_FOUND, `Event ${eventId} not found`);

            if (ev.status !== OUTBOX_STATUS.BLOCKED) {
                return deepClone(ev);
            }

            ev.status = OUTBOX_STATUS.PENDING;
            ev.lastErrorCode = null;
            ev.updatedAt = now.toISOString();
            ev.version += 1;

            validateOutboxRecord(ev);
            await this._saveStore(events);
            return deepClone(ev);
        });
    }

    list() {
        const events = this._loadStore();
        return events.map(deepClone);
    }
}

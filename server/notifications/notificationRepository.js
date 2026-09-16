/**
 * server/notifications/notificationRepository.js
 * Persistent Storage for In-App User Notifications.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Uses normalized file path Shared File Lock.
 * - Free text and PII prohibited by payload policy.
 * - markAllRead runs in a single lock and single persist pass.
 * - No hard delete: status moves to archived or expired.
 */

import crypto from 'crypto';
import path from 'path';
import {
    NOTIFICATION_STATUS,
    NOTIFICATION_SEVERITY,
    NOTIFICATION_TYPES,
    DEFAULT_NOTIFICATION_LIMITS,
    NOTIFICATION_ERROR_CODES
} from './notificationConstants.js';
import { NotificationError } from './notificationErrors.js';
import { validateNotificationRecord } from './notificationValidator.js';
import { validateAndSanitizeSafeMetadata } from './notificationPayloadPolicy.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

export const NOTIFICATION_STORAGE_FILE = 'Notifications';

function deepClone(val) {
    return JSON.parse(JSON.stringify(val));
}

export class NotificationRepository {
    /**
     * @param {Function} getDataFn - (filename, defaultValue) => Array
     * @param {Function} persistDataFn - async (filename, data) => Promise<boolean>
     * @param {Object} [deps={}]
     * @param {string} [deps.dataDir]
     * @param {string} [deps.filePath]
     * @param {Object} [deps.limits]
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
            this.filePath = path.resolve(deps.dataDir, `${NOTIFICATION_STORAGE_FILE}.json`);
        } else {
            this.filePath = path.resolve(process.cwd(), 'app', 'data', `${NOTIFICATION_STORAGE_FILE}.json`);
        }
        this.lockKey = this.filePath;
        this.isCorrupted = false;
    }

    _loadStore() {
        if (this.isCorrupted) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED,
                'Notification store is corrupted. Operations halted.'
            );
        }

        let raw;
        try {
            raw = this.getData(NOTIFICATION_STORAGE_FILE, []);
        } catch {
            this.isCorrupted = true;
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_READ_FAILED,
                'Failed to read Notification storage from disk.'
            );
        }

        if (!Array.isArray(raw)) {
            this.isCorrupted = true;
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED,
                'Notification store root must be an array.'
            );
        }

        return raw;
    }

    async _saveStore(notifications) {
        if (!Array.isArray(notifications)) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID,
                'Cannot persist non-array to Notification store'
            );
        }
        let success = false;
        try {
            success = await this.persistData(NOTIFICATION_STORAGE_FILE, notifications);
        } catch {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_WRITE_FAILED,
                'Exception thrown while writing Notification store to disk'
            );
        }
        if (!success) {
            throw new NotificationError(
                NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_WRITE_FAILED,
                'Failed to write Notification store to disk'
            );
        }
        return true;
    }

    /**
     * Operator recovery: reset corruption state only after verifying valid structure.
     */
    resetCorruptionState() {
        try {
            const records = this.getData(NOTIFICATION_STORAGE_FILE, null);
            if (!Array.isArray(records)) {
                this.isCorrupted = true;
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED, 'Not an array');
            }
            const seenIds = new Set();
            const seenDedup = new Set();

            for (const record of records) {
                validateNotificationRecord(record);
                if (seenIds.has(record.id)) {
                    this.isCorrupted = true;
                    throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED, 'Duplicate ID');
                }
                seenIds.add(record.id);

                if (seenDedup.has(record.deduplicationKey)) {
                    this.isCorrupted = true;
                    throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED, 'Duplicate DeduplicationKey');
                }
                seenDedup.add(record.deduplicationKey);
            }

            this.isCorrupted = false;
            return true;
        } catch (err) {
            this.isCorrupted = true;
            if (err instanceof NotificationError) throw err;
            throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED, err.message);
        }
    }

    /**
     * Create a new persistent notification with atomic deduplication check.
     */
    async createNotification(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const items = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const isoNow = now.toISOString();

            const {
                recipientUserId,
                type,
                resourceType,
                resourceId,
                messageCode,
                severity = NOTIFICATION_SEVERITY.INFO,
                deduplicationKey,
                sourceOutboxEventId = null,
                safeMetadata = null,
                expiresInDays = this.limits.DEFAULT_EXPIRY_DAYS,
                customId = null
            } = params;

            if (!recipientUserId || typeof recipientUserId !== 'string' || recipientUserId.trim() === '') {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.RECIPIENT_INVALID, 'recipientUserId is required and must be non-empty');
            }

            if (!deduplicationKey || typeof deduplicationKey !== 'string') {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.DEDUPLICATION_KEY_INVALID, 'deduplicationKey is required');
            }

            // Check capacity
            if (items.length >= this.limits.MAX_TOTAL_NOTIFICATIONS) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.CAPACITY_EXCEEDED, 'Max total notifications limit reached');
            }

            // Check deduplication key
            const existing = items.find(n => n.deduplicationKey === deduplicationKey);
            if (existing) {
                // Idempotent: return existing record without mutating or duplicating
                return deepClone(existing);
            }

            const sanitizedMetadata = validateAndSanitizeSafeMetadata(safeMetadata);

            const expiresAt = new Date(now.getTime() + (expiresInDays * 24 * 60 * 60 * 1000)).toISOString();
            const id = customId || `notif_${crypto.randomUUID().replace(/-/g, '')}`;

            const newNotif = {
                id,
                recipientUserId: recipientUserId.trim(),
                type,
                resourceType,
                resourceId,
                messageCode,
                severity,
                status: NOTIFICATION_STATUS.UNREAD,
                deduplicationKey,
                sourceOutboxEventId,
                safeMetadata: sanitizedMetadata,
                createdAt: isoNow,
                updatedAt: isoNow,
                deliveredAt: isoNow,
                readAt: null,
                archivedAt: null,
                expiresAt,
                version: 1
            };

            validateNotificationRecord(newNotif);

            items.push(newNotif);
            await this._saveStore(items);

            return deepClone(newNotif);
        });
    }

    findById(id) {
        const items = this._loadStore();
        const found = items.find(n => n.id === id);
        return found ? deepClone(found) : null;
    }

    findByDeduplicationKey(deduplicationKey) {
        const items = this._loadStore();
        const found = items.find(n => n.deduplicationKey === deduplicationKey);
        return found ? deepClone(found) : null;
    }

    listForRecipient(recipientUserId, filter = {}) {
        const items = this._loadStore();
        const targetUser = (recipientUserId || '').trim();
        return items.filter(n => {
            if (n.recipientUserId !== targetUser) return false;
            if (filter.status && n.status !== filter.status) return false;
            if (filter.excludeExpired && n.status === NOTIFICATION_STATUS.EXPIRED) return false;
            if (filter.excludeArchived && n.status === NOTIFICATION_STATUS.ARCHIVED) return false;
            return true;
        }).map(deepClone);
    }

    countUnreadForRecipient(recipientUserId) {
        const items = this._loadStore();
        const targetUser = (recipientUserId || '').trim();
        return items.filter(n => n.recipientUserId === targetUser && n.status === NOTIFICATION_STATUS.UNREAD).length;
    }

    /**
     * Mark single notification as read with expectedVersion validation.
     */
    async markRead(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const items = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { notificationId, recipientUserId, expectedVersion } = params;

            const notif = items.find(n => n.id === notificationId);
            if (!notif) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_NOT_FOUND, `Notification ${notificationId} not found`);
            }

            // User authorization isolation
            if (recipientUserId && notif.recipientUserId !== recipientUserId.trim()) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_ACCESS_DENIED, 'Cannot modify another user notification');
            }

            // Idempotent: if already read, return existing state without bumping version
            if (notif.status === NOTIFICATION_STATUS.READ) {
                return deepClone(notif);
            }

            if (notif.status === NOTIFICATION_STATUS.ARCHIVED || notif.status === NOTIFICATION_STATUS.EXPIRED) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, `Cannot mark ${notif.status} notification as read`);
            }

            if (expectedVersion !== undefined && notif.version !== expectedVersion) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.VERSION_CONFLICT, `Version conflict: expected ${expectedVersion}, actual ${notif.version}`);
            }

            notif.status = NOTIFICATION_STATUS.READ;
            notif.readAt = now.toISOString();
            notif.updatedAt = now.toISOString();
            notif.version += 1;

            validateNotificationRecord(notif);
            await this._saveStore(items);

            return deepClone(notif);
        });
    }

    /**
     * Mark all unread notifications for a recipient as read in a single lock and single persist pass.
     */
    async markAllRead(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const items = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const targetUser = (params.recipientUserId || '').trim();

            if (!targetUser) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.RECIPIENT_INVALID, 'recipientUserId is required for markAllRead');
            }

            let modifiedCount = 0;
            const isoNow = now.toISOString();

            for (const notif of items) {
                // Target recipient only, unread only, ignore archived or expired
                if (notif.recipientUserId === targetUser && notif.status === NOTIFICATION_STATUS.UNREAD) {
                    notif.status = NOTIFICATION_STATUS.READ;
                    notif.readAt = isoNow;
                    notif.updatedAt = isoNow;
                    notif.version += 1;
                    modifiedCount++;
                }
            }

            if (modifiedCount > 0) {
                await this._saveStore(items);
            }

            return { modifiedCount };
        });
    }

    /**
     * Move notification to archived state.
     */
    async archiveNotification(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const items = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const { notificationId, recipientUserId } = params;

            const notif = items.find(n => n.id === notificationId);
            if (!notif) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_NOT_FOUND, `Notification ${notificationId} not found`);
            }

            if (recipientUserId && notif.recipientUserId !== recipientUserId.trim()) {
                throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_ACCESS_DENIED, 'Cannot archive another user notification');
            }

            if (notif.status === NOTIFICATION_STATUS.ARCHIVED) {
                return deepClone(notif);
            }

            notif.status = NOTIFICATION_STATUS.ARCHIVED;
            notif.archivedAt = now.toISOString();
            notif.updatedAt = now.toISOString();
            notif.version += 1;

            validateNotificationRecord(notif);
            await this._saveStore(items);

            return deepClone(notif);
        });
    }

    /**
     * Mark expired notifications past expiresAt.
     */
    async expireNotifications(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const items = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
            const nowMs = now.getTime();
            let expiredCount = 0;

            for (const notif of items) {
                if (notif.status !== NOTIFICATION_STATUS.EXPIRED && notif.status !== NOTIFICATION_STATUS.ARCHIVED) {
                    if (notif.expiresAt && new Date(notif.expiresAt).getTime() <= nowMs) {
                        notif.status = NOTIFICATION_STATUS.EXPIRED;
                        notif.updatedAt = now.toISOString();
                        notif.version += 1;
                        expiredCount++;
                    }
                }
            }

            if (expiredCount > 0) {
                await this._saveStore(items);
            }

            return { expiredCount };
        });
    }

    list() {
        const items = this._loadStore();
        return items.map(deepClone);
    }
}

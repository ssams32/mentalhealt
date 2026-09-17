/**
 * server/notifications/internalNotificationRepository.js
 * In-app internal notification store with deduplication and zero-leak privacy controls.
 */

import crypto from 'crypto';
import { NOTIFICATION_TYPES } from '../survey/surveyConstants.js';

export class InternalNotificationRepository {
    /**
     * @param {Object} deps
     * @param {Function} deps.getData
     * @param {Function} deps.persistData
     */
    constructor(deps = {}) {
        if (!deps.getData || !deps.persistData) {
            throw new Error('InternalNotificationRepository requires getData and persistData dependencies');
        }
        this.getData = deps.getData;
        this.persistData = deps.persistData;
    }

    _nowIso() {
        return new Date().toISOString();
    }

    getNotificationsList() {
        return this.getData('InternalNotifications', []);
    }

    async saveNotificationsList(list) {
        return this.persistData('InternalNotifications', list);
    }

    /**
     * Create a notification with deduplication check.
     */
    async createNotification({
        recipientUserId,
        type,
        relatedEntityType = 'survey',
        relatedEntityId,
        safeTitle,
        safeMessage,
        priority = 'NORMAL',
        createdByUserId = 'system',
        deduplicationKey
    }) {
        const list = this.getNotificationsList();

        // 1. Deduplication key check
        if (deduplicationKey) {
            const existing = list.find(n => n.deduplicationKey === deduplicationKey);
            if (existing) {
                return Object.assign({}, existing, { notification: existing, isDuplicate: true });
            }
        }

        // 2. Build safe notification record
        const now = this._nowIso();
        const notification = {
            notificationId: `notif_${crypto.randomUUID()}`,
            recipientUserId,
            type,
            relatedEntityType,
            relatedEntityId: relatedEntityId || null,
            safeTitle: safeTitle || '새로운 알림이 도착했습니다.',
            safeMessage: safeMessage || '확인해 주시기 바랍니다.',
            priority: priority || 'NORMAL',
            createdAt: now,
            readAt: null,
            dismissedAt: null,
            createdByUserId,
            deduplicationKey: deduplicationKey || `dedup_${crypto.randomUUID()}`
        };

        list.push(notification);

        // Retain last 5,000 notifications in storage
        if (list.length > 5000) {
            list.splice(0, list.length - 5000);
        }

        await this.saveNotificationsList(list);
        return Object.assign({}, notification, { notification, isDuplicate: false });
    }

    /**
     * Get unread notification count for a specific user.
     */
    getUnreadCount(userId) {
        const list = this.getNotificationsList();
        return list.filter(n => n.recipientUserId === userId && !n.readAt && !n.dismissedAt).length;
    }

    /**
     * Get notifications for a specific user (newest first).
     */
    getUserNotifications(userId, { limit = 50, includeRead = true } = {}) {
        const list = this.getNotificationsList();
        return list
            .filter(n => n.recipientUserId === userId && !n.dismissedAt && (includeRead || !n.readAt))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, limit);
    }

    getNotificationsForUser(userId, opts) {
        return this.getUserNotifications(userId, opts);
    }

    /**
     * Mark a single notification as read by ID.
     */
    async markAsRead(notificationId, userId) {
        const list = this.getNotificationsList();
        const item = list.find(n => n.notificationId === notificationId && n.recipientUserId === userId);
        if (item && !item.readAt) {
            item.readAt = this._nowIso();
            await this.saveNotificationsList(list);
            return item;
        }
        return item || null;
    }

    /**
     * Mark all unread notifications for a user as read.
     */
    async markAllAsRead(userId) {
        const list = this.getNotificationsList();
        const now = this._nowIso();
        let updatedCount = 0;

        for (const item of list) {
            if (item.recipientUserId === userId && !item.readAt && !item.dismissedAt) {
                item.readAt = now;
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            await this.saveNotificationsList(list);
        }
        return updatedCount;
    }

    /**
     * Dismiss a notification.
     */
    async dismissNotification(notificationId, userId) {
        const list = this.getNotificationsList();
        const item = list.find(n => n.notificationId === notificationId && n.recipientUserId === userId);
        if (item && !item.dismissedAt) {
            item.dismissedAt = this._nowIso();
            await this.saveNotificationsList(list);
            return true;
        }
        return false;
    }
}

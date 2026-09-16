/**
 * server/notifications/notificationMetrics.js
 * Read-Only Diagnostic Metrics Snapshot for Notifications & Outbox.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Aggregated counts only: NO per-user personal data, phone numbers, or PII.
 */

import {
    NOTIFICATION_STATUS,
    OUTBOX_STATUS,
    DEFAULT_NOTIFICATION_LIMITS
} from './notificationConstants.js';

/**
 * Capture combined diagnostic snapshot for Notifications and Outbox.
 * 
 * @param {Object} params
 * @param {import('./notificationRepository.js').NotificationRepository} [params.notificationRepo]
 * @param {import('./notificationOutboxRepository.js').NotificationOutboxRepository} [params.outboxRepo]
 * @param {Date} [params.now]
 * @returns {Object}
 */
export function getNotificationMetricsSnapshot(params = {}) {
    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
    const nowMs = now.getTime();

    const notifRepo = params.notificationRepo;
    const outboxRepo = params.outboxRepo;

    // 1. Notification Metrics
    let notifications = [];
    let notificationStoreSerializedBytesEstimate = 0;
    if (notifRepo) {
        try {
            notifications = notifRepo.list();
            notificationStoreSerializedBytesEstimate = Buffer.byteLength(JSON.stringify(notifications), 'utf8');
        } catch {
            // fail-closed
        }
    }

    let unreadCount = 0;
    let readCount = 0;
    let archivedCount = 0;
    let expiredCount = 0;
    let oldestUnreadAgeSeconds = null;
    let retentionCandidateCount = 0;

    const retentionDays = DEFAULT_NOTIFICATION_LIMITS.RETENTION_DAYS;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    for (const n of notifications) {
        if (n.status === NOTIFICATION_STATUS.UNREAD) {
            unreadCount++;
            const ageSec = Math.floor((nowMs - new Date(n.createdAt).getTime()) / 1000);
            if (oldestUnreadAgeSeconds === null || ageSec > oldestUnreadAgeSeconds) {
                oldestUnreadAgeSeconds = ageSec;
            }
        } else if (n.status === NOTIFICATION_STATUS.READ) {
            readCount++;
        } else if (n.status === NOTIFICATION_STATUS.ARCHIVED) {
            archivedCount++;
        } else if (n.status === NOTIFICATION_STATUS.EXPIRED) {
            expiredCount++;
        }

        if (nowMs - new Date(n.createdAt).getTime() > retentionMs) {
            retentionCandidateCount++;
        }
    }

    const notificationMetrics = {
        totalCount: notifications.length,
        unreadCount,
        readCount,
        archivedCount,
        expiredCount,
        oldestUnreadAgeSeconds: oldestUnreadAgeSeconds !== null ? Math.max(0, oldestUnreadAgeSeconds) : null,
        retentionCandidateCount,
        notificationStoreSerializedBytesEstimate
    };

    // 2. Outbox Metrics
    let outboxEvents = [];
    let outboxStoreSerializedBytesEstimate = 0;
    if (outboxRepo) {
        try {
            outboxEvents = outboxRepo.list();
            outboxStoreSerializedBytesEstimate = Buffer.byteLength(JSON.stringify(outboxEvents), 'utf8');
        } catch {
            // fail-closed
        }
    }

    let pendingCount = 0;
    let leasedCount = 0;
    let dispatchingCount = 0;
    let retryWaitCount = 0;
    let deliveredCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let blockedCount = 0;
    let expiredLeaseCount = 0;
    let stalledCount = 0;
    let oldestPendingAgeSeconds = null;

    const stalledThreshold = outboxRepo?.limits?.STALLED_THRESHOLD_MS || DEFAULT_NOTIFICATION_LIMITS.STALLED_THRESHOLD_MS;

    for (const e of outboxEvents) {
        if (e.status === OUTBOX_STATUS.PENDING) {
            pendingCount++;
            const ageSec = Math.floor((nowMs - new Date(e.createdAt).getTime()) / 1000);
            if (oldestPendingAgeSeconds === null || ageSec > oldestPendingAgeSeconds) {
                oldestPendingAgeSeconds = ageSec;
            }
        } else if (e.status === OUTBOX_STATUS.LEASED) {
            leasedCount++;
        } else if (e.status === OUTBOX_STATUS.DISPATCHING) {
            dispatchingCount++;
        } else if (e.status === OUTBOX_STATUS.RETRY_WAIT) {
            retryWaitCount++;
        } else if (e.status === OUTBOX_STATUS.DELIVERED) {
            deliveredCount++;
        } else if (e.status === OUTBOX_STATUS.FAILED) {
            failedCount++;
        } else if (e.status === OUTBOX_STATUS.CANCELLED) {
            cancelledCount++;
        } else if (e.status === OUTBOX_STATUS.BLOCKED) {
            blockedCount++;
        }

        if ([OUTBOX_STATUS.LEASED, OUTBOX_STATUS.DISPATCHING].includes(e.status)) {
            if (e.leaseExpiresAt && new Date(e.leaseExpiresAt).getTime() <= nowMs) {
                expiredLeaseCount++;
            }
            const refTime = e.heartbeatAt || e.leaseAcquiredAt;
            if (refTime && (nowMs - new Date(refTime).getTime() > stalledThreshold)) {
                stalledCount++;
            }
        }
    }

    const maxActive = outboxRepo?.limits?.MAX_ACTIVE_OUTBOX || DEFAULT_NOTIFICATION_LIMITS.MAX_ACTIVE_OUTBOX;
    const activeCount = pendingCount + leasedCount + dispatchingCount + retryWaitCount + blockedCount;
    const capacityRemaining = Math.max(0, maxActive - activeCount);

    const outboxMetrics = {
        totalCount: outboxEvents.length,
        pendingCount,
        leasedCount,
        dispatchingCount,
        retryWaitCount,
        deliveredCount,
        failedCount,
        cancelledCount,
        blockedCount,
        expiredLeaseCount,
        stalledCount,
        oldestPendingAgeSeconds: oldestPendingAgeSeconds !== null ? Math.max(0, oldestPendingAgeSeconds) : null,
        outboxStoreSerializedBytesEstimate,
        capacityRemaining
    };

    return {
        timestamp: now.toISOString(),
        notifications: notificationMetrics,
        outbox: outboxMetrics
    };
}

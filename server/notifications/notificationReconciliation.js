/**
 * server/notifications/notificationReconciliation.js
 * Read-Only Consistency Auditor for Notifications and Outbox.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Read-only: Does NOT mutate stores or perform automatic repair.
 * - Sensitive payload protection: Never includes PII, tokens, hashes, or stack traces.
 */

import {
    NOTIFICATION_STATUS,
    OUTBOX_STATUS,
    ACTIVE_OUTBOX_STATUSES,
    DEFAULT_NOTIFICATION_LIMITS
} from './notificationConstants.js';
import { isSafeMetadata } from './notificationPayloadPolicy.js';
import { isValidIsoDate } from './notificationValidator.js';

export const RECONCILIATION_CHECK_CODES = Object.freeze({
    NOTIFICATION_STORE_CORRUPTED: 'NOTIFICATION_STORE_CORRUPTED',
    OUTBOX_STORE_CORRUPTED: 'OUTBOX_STORE_CORRUPTED',
    NOTIFICATION_DUPLICATE_ID: 'NOTIFICATION_DUPLICATE_ID',
    OUTBOX_DUPLICATE_ID: 'OUTBOX_DUPLICATE_ID',
    NOTIFICATION_DUPLICATE_DEDUP_KEY: 'NOTIFICATION_DUPLICATE_DEDUP_KEY',
    OUTBOX_DUPLICATE_DEDUP_KEY: 'OUTBOX_DUPLICATE_DEDUP_KEY',
    NOTIFICATION_ORPHAN_OUTBOX_REF: 'NOTIFICATION_ORPHAN_OUTBOX_REF',
    OUTBOX_DELIVERED_NOTIFICATION_MISSING: 'OUTBOX_DELIVERED_NOTIFICATION_MISSING',
    OUTBOX_NOTIFICATION_RECIPIENT_MISMATCH: 'OUTBOX_NOTIFICATION_RECIPIENT_MISMATCH',
    OUTBOX_PAYLOAD_INVALID: 'OUTBOX_PAYLOAD_INVALID',
    NOTIFICATION_PAYLOAD_UNSAFE: 'NOTIFICATION_PAYLOAD_UNSAFE',
    NOTIFICATION_READ_TIME_MISSING: 'NOTIFICATION_READ_TIME_MISSING',
    NOTIFICATION_ARCHIVE_TIME_MISSING: 'NOTIFICATION_ARCHIVE_TIME_MISSING',
    NOTIFICATION_EXPIRED_TIME_INVALID: 'NOTIFICATION_EXPIRED_TIME_INVALID',
    OUTBOX_LEASE_FIELDS_MISSING: 'OUTBOX_LEASE_FIELDS_MISSING',
    OUTBOX_LEASE_EXPIRED: 'OUTBOX_LEASE_EXPIRED',
    OUTBOX_RETRY_TIME_MISSING: 'OUTBOX_RETRY_TIME_MISSING',
    OUTBOX_DELIVERED_TIME_MISSING: 'OUTBOX_DELIVERED_TIME_MISSING',
    OUTBOX_FAILED_ERROR_MISSING: 'OUTBOX_FAILED_ERROR_MISSING',
    OUTBOX_ATTEMPT_EXCEEDS_MAX: 'OUTBOX_ATTEMPT_EXCEEDS_MAX',
    OUTBOX_STALLED: 'OUTBOX_STALLED',
    NOTIFICATION_RETENTION_CANDIDATE: 'NOTIFICATION_RETENTION_CANDIDATE',
    OUTBOX_ARCHIVE_CANDIDATE: 'OUTBOX_ARCHIVE_CANDIDATE',
    NOTIFICATION_STORE_SIZE_WARNING: 'NOTIFICATION_STORE_SIZE_WARNING',
    OUTBOX_STORE_SIZE_WARNING: 'OUTBOX_STORE_SIZE_WARNING'
});

export const SEVERITY = Object.freeze({
    CRITICAL: 'CRITICAL',
    WARNING: 'WARNING',
    INFO: 'INFO'
});

export async function runNotificationReconciliation(params = {}) {
    const findings = [];
    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
    const nowMs = now.getTime();

    const { notificationRepo, outboxRepo } = params;

    let notifications = [];
    let outboxEvents = [];

    // 1. Load Notifications safely
    if (notificationRepo) {
        try {
            notifications = notificationRepo.list();
        } catch {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_STORE_CORRUPTED,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification_store',
                resourceId: 'Notifications',
                repairable: false,
                safeMessage: 'Notifications store is corrupted or unreadable'
            });
        }
    }

    // 2. Load Outbox safely
    if (outboxRepo) {
        try {
            outboxEvents = outboxRepo.list();
        } catch {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_STORE_CORRUPTED,
                severity: SEVERITY.CRITICAL,
                resourceType: 'outbox_store',
                resourceId: 'NotificationOutbox',
                repairable: false,
                safeMessage: 'NotificationOutbox store is corrupted or unreadable'
            });
        }
    }

    // Index notifications
    const notifMap = new Map();
    const notifDedupMap = new Map();
    for (const notif of notifications) {
        if (notifMap.has(notif.id)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_DUPLICATE_ID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Duplicate notification id detected'
            });
        } else {
            notifMap.set(notif.id, notif);
        }

        if (notifDedupMap.has(notif.deduplicationKey)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_DUPLICATE_DEDUP_KEY,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Duplicate notification deduplicationKey detected'
            });
        } else {
            notifDedupMap.set(notif.deduplicationKey, notif);
        }

        // Field checks
        if (notif.status === NOTIFICATION_STATUS.READ && !isValidIsoDate(notif.readAt)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_READ_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Read notification missing valid readAt'
            });
        }

        if (notif.status === NOTIFICATION_STATUS.ARCHIVED && !isValidIsoDate(notif.archivedAt)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_ARCHIVE_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Archived notification missing valid archivedAt'
            });
        }

        if (notif.expiresAt && !isValidIsoDate(notif.expiresAt)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_EXPIRED_TIME_INVALID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Notification expiresAt is not a valid ISO date'
            });
        }

        if (!isSafeMetadata(notif.safeMetadata)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_PAYLOAD_UNSAFE,
                severity: SEVERITY.CRITICAL,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: 'Notification contains unsafe or prohibited metadata fields'
            });
        }

        // Retention candidate check
        const retentionDays = DEFAULT_NOTIFICATION_LIMITS.RETENTION_DAYS;
        if (nowMs - new Date(notif.createdAt).getTime() > retentionDays * 24 * 60 * 60 * 1000) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_RETENTION_CANDIDATE,
                severity: SEVERITY.INFO,
                resourceType: 'notification',
                resourceId: notif.id,
                repairable: false,
                safeMessage: `Notification exceeds standard retention policy of ${retentionDays} days`
            });
        }
    }

    // Index outbox
    const outboxMap = new Map();
    const outboxActiveDedupMap = new Map();
    for (const ev of outboxEvents) {
        if (outboxMap.has(ev.id)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_DUPLICATE_ID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'outbox_event',
                resourceId: ev.id,
                repairable: false,
                safeMessage: 'Duplicate outbox event id detected'
            });
        } else {
            outboxMap.set(ev.id, ev);
        }

        if (ACTIVE_OUTBOX_STATUSES.includes(ev.status)) {
            if (outboxActiveDedupMap.has(ev.deduplicationKey)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_DUPLICATE_DEDUP_KEY,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Duplicate active outbox deduplicationKey detected'
                });
            } else {
                outboxActiveDedupMap.set(ev.deduplicationKey, ev);
            }
        }

        // Lease checks
        if ([OUTBOX_STATUS.LEASED, OUTBOX_STATUS.DISPATCHING].includes(ev.status)) {
            if (!ev.leaseOwner || !ev.leaseTokenHash || !ev.leaseExpiresAt) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_LEASE_FIELDS_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Leased/dispatching outbox event missing lease ownership fields'
                });
            }

            if (ev.leaseExpiresAt && new Date(ev.leaseExpiresAt).getTime() <= nowMs) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_LEASE_EXPIRED,
                    severity: SEVERITY.WARNING,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Active outbox event lease has expired and is pending recovery'
                });
            }

            // Stalled check
            const stalledThreshold = outboxRepo?.limits?.STALLED_THRESHOLD_MS || DEFAULT_NOTIFICATION_LIMITS.STALLED_THRESHOLD_MS;
            const refTime = ev.heartbeatAt || ev.leaseAcquiredAt;
            if (refTime && (nowMs - new Date(refTime).getTime() > stalledThreshold)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_STALLED,
                    severity: SEVERITY.WARNING,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: `Outbox event stalled without heartbeat for over ${Math.round(stalledThreshold / 1000)}s`
                });
            }
        }

        // Status specific checks
        if (ev.status === OUTBOX_STATUS.RETRY_WAIT && !isValidIsoDate(ev.nextAttemptAt)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_RETRY_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'outbox_event',
                resourceId: ev.id,
                repairable: false,
                safeMessage: 'Retry wait event missing nextAttemptAt'
            });
        }

        if (ev.status === OUTBOX_STATUS.DELIVERED) {
            if (!isValidIsoDate(ev.deliveredAt)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_DELIVERED_TIME_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Delivered outbox event missing deliveredAt'
                });
            }

            // Cross-store reference check: Verify target notification exists
            if (ev.deliveredNotificationId) {
                const targetNotif = notifMap.get(ev.deliveredNotificationId);
                if (!targetNotif) {
                    findings.push({
                        checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_DELIVERED_NOTIFICATION_MISSING,
                        severity: SEVERITY.CRITICAL,
                        resourceType: 'outbox_event',
                        resourceId: ev.id,
                        repairable: false,
                        safeMessage: `Delivered outbox references missing notification (${ev.deliveredNotificationId})`
                    });
                } else if (targetNotif.recipientUserId !== ev.recipientUserId) {
                    findings.push({
                        checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_NOTIFICATION_RECIPIENT_MISMATCH,
                        severity: SEVERITY.CRITICAL,
                        resourceType: 'outbox_event',
                        resourceId: ev.id,
                        repairable: false,
                        safeMessage: 'Delivered outbox recipient does not match delivered notification recipient'
                    });
                }
            }
        }

        if (ev.status === OUTBOX_STATUS.FAILED && !ev.lastErrorCode) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_FAILED_ERROR_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'outbox_event',
                resourceId: ev.id,
                repairable: false,
                safeMessage: 'Failed outbox event missing lastErrorCode'
            });
        }

        if (ev.attemptCount > ev.maxAttempts) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_ATTEMPT_EXCEEDS_MAX,
                severity: SEVERITY.CRITICAL,
                resourceType: 'outbox_event',
                resourceId: ev.id,
                repairable: false,
                safeMessage: 'Outbox attemptCount exceeds maxAttempts'
            });
        }
    }

    // Capacity / Size Warning checks
    if (notifications.length >= (notificationRepo?.limits?.MAX_TOTAL_NOTIFICATIONS || DEFAULT_NOTIFICATION_LIMITS.MAX_TOTAL_NOTIFICATIONS) * 0.8) {
        findings.push({
            checkCode: RECONCILIATION_CHECK_CODES.NOTIFICATION_STORE_SIZE_WARNING,
            severity: SEVERITY.WARNING,
            resourceType: 'notification_store',
            resourceId: 'Notifications',
            repairable: false,
            safeMessage: `Notification store size reached 80% capacity`
        });
    }

    const activeOutbox = outboxEvents.filter(e => ACTIVE_OUTBOX_STATUSES.includes(e.status));
    if (activeOutbox.length >= (outboxRepo?.limits?.MAX_ACTIVE_OUTBOX || DEFAULT_NOTIFICATION_LIMITS.MAX_ACTIVE_OUTBOX) * 0.8) {
        findings.push({
            checkCode: RECONCILIATION_CHECK_CODES.OUTBOX_STORE_SIZE_WARNING,
            severity: SEVERITY.WARNING,
            resourceType: 'outbox_store',
            resourceId: 'NotificationOutbox',
            repairable: false,
            safeMessage: `Active outbox queue reached 80% capacity`
        });
    }

    return findings;
}

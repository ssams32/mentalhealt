/**
 * server/notifications/notificationValidator.js
 * Schema and Record Validators for Notifications and Outbox.
 * Mind-ERP OS Track A9.
 */

import {
    NOTIFICATION_STATUS,
    NOTIFICATION_SEVERITY,
    NOTIFICATION_TYPES,
    OUTBOX_STATUS,
    NOTIFICATION_ERROR_CODES
} from './notificationConstants.js';
import { NotificationError } from './notificationErrors.js';
import { validateAndSanitizeSafeMetadata } from './notificationPayloadPolicy.js';

export function isValidIsoDate(value) {
    if (typeof value !== 'string') return false;
    const d = new Date(value);
    return !Number.isNaN(d.getTime()) && value.includes('T');
}

/**
 * Validates a Notification record against schema invariants.
 */
export function validateNotificationRecord(record) {
    if (!record || typeof record !== 'object') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'Notification record must be an object');
    }

    if (!record.id || typeof record.id !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'Notification id is required');
    }

    if (!record.recipientUserId || typeof record.recipientUserId !== 'string' || record.recipientUserId.trim() === '') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RECIPIENT_INVALID, 'recipientUserId must be a non-empty string');
    }

    if (!Object.values(NOTIFICATION_TYPES).includes(record.type)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.UNKNOWN_NOTIFICATION_TYPE, `Invalid notification type: ${record.type}`);
    }

    if (!record.resourceType || typeof record.resourceType !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RESOURCE_REFERENCE_INVALID, 'resourceType is required');
    }

    if (!record.resourceId || typeof record.resourceId !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RESOURCE_REFERENCE_INVALID, 'resourceId is required');
    }

    if (!record.messageCode || typeof record.messageCode !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'messageCode is required');
    }

    if (!Object.values(NOTIFICATION_SEVERITY).includes(record.severity)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, `Invalid severity: ${record.severity}`);
    }

    if (!Object.values(NOTIFICATION_STATUS).includes(record.status)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, `Invalid notification status: ${record.status}`);
    }

    if (!record.deduplicationKey || typeof record.deduplicationKey !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.DEDUPLICATION_KEY_INVALID, 'deduplicationKey is required');
    }

    if (!isValidIsoDate(record.createdAt) || !isValidIsoDate(record.updatedAt)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'createdAt and updatedAt must be ISO dates');
    }

    if (!Number.isSafeInteger(record.version) || record.version < 1) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'version must be positive integer');
    }

    // State specific invariant checks
    if (record.status === NOTIFICATION_STATUS.UNREAD && record.readAt) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'readAt must not be present when status is unread');
    }

    if (record.status === NOTIFICATION_STATUS.READ && !isValidIsoDate(record.readAt)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'readAt is required when status is read');
    }

    if (record.status === NOTIFICATION_STATUS.ARCHIVED && !isValidIsoDate(record.archivedAt)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'archivedAt is required when status is archived');
    }

    if (record.status === NOTIFICATION_STATUS.EXPIRED) {
        if (!isValidIsoDate(record.expiresAt)) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'expiresAt is required when status is expired');
        }
        if (new Date(record.expiresAt).getTime() > Date.now()) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.NOTIFICATION_PAYLOAD_INVALID, 'expiresAt must not be in the future when status is expired');
        }
    }

    // Validate metadata
    validateAndSanitizeSafeMetadata(record.safeMetadata);

    return true;
}

/**
 * Validates an Outbox record against schema invariants.
 */
export function validateOutboxRecord(record) {
    if (!record || typeof record !== 'object') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Outbox record must be an object');
    }

    if (!record.id || typeof record.id !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Outbox id is required');
    }

    if (!Object.values(NOTIFICATION_TYPES).includes(record.eventType)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.UNKNOWN_NOTIFICATION_TYPE, `Invalid eventType: ${record.eventType}`);
    }

    if (!record.aggregateType || typeof record.aggregateType !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RESOURCE_REFERENCE_INVALID, 'aggregateType is required');
    }

    if (!record.aggregateId || typeof record.aggregateId !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RESOURCE_REFERENCE_INVALID, 'aggregateId is required');
    }

    if (!record.recipientUserId || typeof record.recipientUserId !== 'string' || record.recipientUserId.trim() === '') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.RECIPIENT_INVALID, 'recipientUserId must be non-empty string');
    }

    if (!Object.values(OUTBOX_STATUS).includes(record.status)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, `Invalid outbox status: ${record.status}`);
    }

    if (!record.deduplicationKey || typeof record.deduplicationKey !== 'string') {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.DEDUPLICATION_KEY_INVALID, 'deduplicationKey is required');
    }

    if (typeof record.attemptCount !== 'number' || record.attemptCount < 0) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'attemptCount must be non-negative integer');
    }

    if (!Number.isSafeInteger(record.version) || record.version < 1) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'version must be positive integer');
    }

    if (!isValidIsoDate(record.createdAt) || !isValidIsoDate(record.updatedAt)) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'createdAt and updatedAt must be ISO dates');
    }

    // Prohibit raw leaseToken in record
    if (record.leaseToken !== undefined) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Raw leaseToken cannot be persisted in store');
    }

    // Leased/Dispatching fields
    if ([OUTBOX_STATUS.LEASED, OUTBOX_STATUS.DISPATCHING].includes(record.status)) {
        if (!record.leaseOwner || !record.leaseTokenHash || !record.leaseExpiresAt) {
            throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Leased outbox missing leaseOwner, leaseTokenHash, or leaseExpiresAt');
        }
    }

    if (record.status === OUTBOX_STATUS.DELIVERED && (!record.deliveredNotificationId || !isValidIsoDate(record.deliveredAt))) {
        throw new NotificationError(NOTIFICATION_ERROR_CODES.OUTBOX_PAYLOAD_INVALID, 'Delivered outbox missing deliveredNotificationId or deliveredAt');
    }

    // Validate payload
    if (record.payload) {
        if (record.payload.safeMetadata) {
            validateAndSanitizeSafeMetadata(record.payload.safeMetadata);
        }
    }

    return true;
}

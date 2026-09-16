/**
 * server/notifications/notificationDispatcherRunner.js
 * In-Process Dispatcher for Notification Outbox to Notification Delivery.
 * Mind-ERP OS Track A9.
 * 
 * BOUNDARY NOTICE:
 * - Purely in-process: Delivers ONLY to internal NotificationRepository.
 * - Zero external network calls (No email, SMS, push, teams).
 * - Partial failure resilient: If Outbox markDelivered fails after Notification is created,
 *   subsequent retry/restart resolves the existing Notification via deduplication key without duplicating.
 */

import crypto from 'crypto';
import {
    NOTIFICATION_ERROR_CODES,
    RETRYABLE_NOTIFICATION_ERRORS,
    NON_RETRYABLE_NOTIFICATION_ERRORS,
    BLOCKED_NOTIFICATION_ERRORS
} from './notificationConstants.js';
import { computeRetryDelay } from '../jobs/retryBackoffPolicy.js';

export class NotificationDispatcherRunner {
    /**
     * @param {Object} params
     * @param {import('./notificationOutboxRepository.js').NotificationOutboxRepository} params.outboxRepo
     * @param {import('./notificationRepository.js').NotificationRepository} params.notificationRepo
     * @param {string} [params.dispatcherId]
     * @param {number} [params.pollIntervalMs]
     * @param {number} [params.leaseDurationMs]
     * @param {number} [params.shutdownGraceMs]
     */
    constructor(params = {}) {
        if (!params.outboxRepo || !params.notificationRepo) {
            throw new Error('outboxRepo and notificationRepo are required for NotificationDispatcherRunner');
        }
        this.outboxRepo = params.outboxRepo;
        this.notificationRepo = params.notificationRepo;
        this.dispatcherId = params.dispatcherId || `dispatcher_${crypto.randomBytes(8).toString('hex')}`;
        this.pollIntervalMs = params.pollIntervalMs || 1000;
        this.leaseDurationMs = params.leaseDurationMs || 30000;
        this.shutdownGraceMs = params.shutdownGraceMs || 5000;

        this.isRunning = false;
        this.isStopping = false;
        this.pollTimer = null;
        this.activeExecution = null;
    }

    /**
     * Run a single dispatch pass.
     * 1. Claim Outbox event
     * 2. Mark dispatching
     * 3. Idempotently create/find Notification
     * 4. Mark Outbox event delivered with deliveredNotificationId
     * 
     * @param {Object} [options={}]
     * @param {Date} [options.now]
     * @returns {Promise<Object>}
     */
    async runOnce(options = {}) {
        if (this.isStopping) {
            return { handled: false, reason: 'STOPPING' };
        }

        const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();

        // 1. Claim next pending event
        const claim = await this.outboxRepo.claimNextEvent({
            workerId: this.dispatcherId,
            leaseDurationMs: this.leaseDurationMs,
            now
        });

        if (!claim) {
            return { handled: false, reason: 'NO_EVENT_AVAILABLE' };
        }

        const { event, leaseToken } = claim;

        const executionPromise = (async () => {
            try {
                // 2. Mark dispatching
                try {
                    await this.outboxRepo.markDispatching({
                        eventId: event.id,
                        workerId: this.dispatcherId,
                        leaseToken,
                        now
                    });
                } catch {
                    // Non-fatal if already leased
                }

                // 3. Check for existing notification with same deduplicationKey
                let notification = this.notificationRepo.findByDeduplicationKey(event.deduplicationKey);

                if (!notification) {
                    notification = await this.notificationRepo.createNotification({
                        recipientUserId: event.recipientUserId,
                        type: event.eventType,
                        resourceType: event.aggregateType,
                        resourceId: event.aggregateId,
                        messageCode: event.payload?.messageCode || 'NOTIFICATION_DEFAULT',
                        severity: event.payload?.severity,
                        deduplicationKey: event.deduplicationKey,
                        sourceOutboxEventId: event.id,
                        safeMetadata: event.payload?.safeMetadata,
                        now
                    });
                }

                // 4. Mark Outbox event delivered
                await this.outboxRepo.markDelivered({
                    eventId: event.id,
                    workerId: this.dispatcherId,
                    leaseToken,
                    deliveredNotificationId: notification.id,
                    now
                });

                return {
                    handled: true,
                    eventId: event.id,
                    notificationId: notification.id,
                    outcome: 'DELIVERED'
                };
            } catch (err) {
                const errorCode = err.code || NOTIFICATION_ERROR_CODES.TRANSIENT_DISPATCH_FAILURE;

                if (BLOCKED_NOTIFICATION_ERRORS.has(errorCode)) {
                    await this.outboxRepo.blockEvent({
                        eventId: event.id,
                        reasonCode: errorCode,
                        now
                    });
                    return { handled: true, eventId: event.id, outcome: 'BLOCKED', errorCode };
                }

                if (RETRYABLE_NOTIFICATION_ERRORS.has(errorCode) && event.attemptCount < event.maxAttempts) {
                    const { nextAttemptAt } = computeRetryDelay({
                        attemptCount: event.attemptCount,
                        now
                    });
                    try {
                        await this.outboxRepo.scheduleRetry({
                            eventId: event.id,
                            workerId: this.dispatcherId,
                            leaseToken,
                            errorCode,
                            nextAttemptAt,
                            now
                        });
                        return { handled: true, eventId: event.id, outcome: 'RETRY_SCHEDULED', errorCode };
                    } catch (retryErr) {
                        return { handled: true, eventId: event.id, outcome: 'RETRY_SCHEDULE_FAILED', errorCode: retryErr.code || errorCode };
                    }
                }

                // Non-retryable or max attempts exhausted
                try {
                    await this.outboxRepo.markFailed({
                        eventId: event.id,
                        workerId: this.dispatcherId,
                        leaseToken,
                        errorCode: (event.attemptCount >= event.maxAttempts && RETRYABLE_NOTIFICATION_ERRORS.has(errorCode))
                            ? NOTIFICATION_ERROR_CODES.OUTBOX_MAX_ATTEMPTS_EXCEEDED
                            : errorCode,
                        now
                    });
                } catch {
                    // Outbox write failed, return unhandled failure state
                }

                return { handled: true, eventId: event.id, outcome: 'FAILED', errorCode };
            }
        })();

        this.activeExecution = executionPromise;
        try {
            return await executionPromise;
        } finally {
            this.activeExecution = null;
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isStopping = false;

        const loop = async () => {
            if (!this.isRunning || this.isStopping) return;
            try {
                await this.runOnce();
            } catch (err) {
                console.error(`[DISPATCHER ${this.dispatcherId}] runOnce failed:`, err.message);
            }
            if (this.isRunning && !this.isStopping) {
                this.pollTimer = setTimeout(loop, this.pollIntervalMs);
            }
        };

        this.pollTimer = setTimeout(loop, 10);
    }

    stop() {
        this.isRunning = false;
        this.isStopping = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async gracefulShutdown(gracePeriodMs = null) {
        const timeoutMs = gracePeriodMs !== null ? gracePeriodMs : this.shutdownGraceMs;
        this.stop();
        if (this.activeExecution) {
            const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
            await Promise.race([this.activeExecution, timeoutPromise]);
        }
    }

    getStatus() {
        return {
            dispatcherId: this.dispatcherId,
            isRunning: this.isRunning,
            isStopping: this.isStopping,
            hasActiveExecution: this.activeExecution !== null
        };
    }
}

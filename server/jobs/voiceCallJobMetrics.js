/**
 * server/jobs/voiceCallJobMetrics.js
 * Read-Only Metric Snapshot Generator for Persistent Job Queue.
 * Mind-ERP OS Track A8 Final Integrity Closure.
 * 
 * Implements:
 * - Sanitized Snapshot without PII, Transcripts, or Tokens
 * - Store Growth, Archival Candidate Counting, and Capacity Remaining metrics
 */

import {
    JOB_STATUS,
    ACTIVE_JOB_STATUSES,
    TERMINAL_JOB_STATUSES,
    DEFAULT_JOB_LIMITS
} from './voiceCallJobConstants.js';

/**
 * Generate a safe, sanitized metrics snapshot of the persistent job queue.
 * 
 * @param {Object} params
 * @param {import('./voiceCallJobRepository.js').VoiceCallJobRepository} params.repository
 * @param {Date} [params.now=new Date()]
 * @returns {Object} Sanitized metrics snapshot
 */
export function getQueueMetricsSnapshot(params = {}) {
    const repo = params.repository;
    if (!repo) {
        throw new Error('repository is required to generate metrics snapshot');
    }

    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
        ? params.now
        : new Date();
    const nowMs = now.getTime();

    const jobs = repo.list();

    let queuedCount = 0;
    let leasedCount = 0;
    let processingCount = 0;
    let retryWaitCount = 0;
    let blockedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let expiredLeaseCount = 0;
    let stalledCount = 0;

    let oldestQueuedCreatedAt = null;
    let nextAvailableTimeMs = null;

    const stalledThreshold = repo.limits.STALLED_THRESHOLD_MS || DEFAULT_JOB_LIMITS.STALLED_THRESHOLD_MS;

    for (const job of jobs) {
        switch (job.status) {
            case JOB_STATUS.QUEUED:
                queuedCount++;
                const createdAtMs = new Date(job.createdAt).getTime();
                if (oldestQueuedCreatedAt === null || createdAtMs < oldestQueuedCreatedAt) {
                    oldestQueuedCreatedAt = createdAtMs;
                }
                const candidateTime = job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : createdAtMs;
                if (nextAvailableTimeMs === null || candidateTime < nextAvailableTimeMs) {
                    nextAvailableTimeMs = candidateTime;
                }
                break;

            case JOB_STATUS.LEASED:
                leasedCount++;
                if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs) {
                    expiredLeaseCount++;
                }
                break;

            case JOB_STATUS.PROCESSING:
                processingCount++;
                if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs) {
                    expiredLeaseCount++;
                }
                const refTime = job.heartbeatAt || job.startedAt || job.leaseAcquiredAt;
                if (refTime && (nowMs - new Date(refTime).getTime() > stalledThreshold)) {
                    stalledCount++;
                }
                break;

            case JOB_STATUS.RETRY_WAIT:
                retryWaitCount++;
                if (job.nextAttemptAt) {
                    const retryTimeMs = new Date(job.nextAttemptAt).getTime();
                    if (nextAvailableTimeMs === null || retryTimeMs < nextAvailableTimeMs) {
                        nextAvailableTimeMs = retryTimeMs;
                    }
                }
                break;

            case JOB_STATUS.BLOCKED:
                blockedCount++;
                break;

            case JOB_STATUS.COMPLETED:
                completedCount++;
                break;

            case JOB_STATUS.FAILED:
                failedCount++;
                break;

            case JOB_STATUS.CANCELLED:
                cancelledCount++;
                break;
        }
    }

    const activeCount = queuedCount + leasedCount + processingCount + retryWaitCount + blockedCount;
    const terminalCount = completedCount + failedCount + cancelledCount;
    const maxActive = repo.limits.MAX_ACTIVE_JOBS || DEFAULT_JOB_LIMITS.MAX_ACTIVE_JOBS;
    const capacityUsageRatio = maxActive > 0 ? Number((activeCount / maxActive).toFixed(4)) : 0;
    const capacityRemaining = Math.max(0, maxActive - activeCount);

    const oldestQueuedAgeSeconds = oldestQueuedCreatedAt !== null
        ? Math.max(0, Math.round((nowMs - oldestQueuedCreatedAt) / 1000))
        : 0;

    const nextAvailableJobAt = nextAvailableTimeMs !== null
        ? new Date(nextAvailableTimeMs).toISOString()
        : null;

    // Estimate JSON serialized bytes on disk
    let queueStoreEstimatedBytes = 0;
    try {
        queueStoreEstimatedBytes = Buffer.byteLength(JSON.stringify(jobs), 'utf8');
    } catch {
        queueStoreEstimatedBytes = 0;
    }

    return {
        snapshotTimestamp: now.toISOString(),
        totalJobsCount: jobs.length,
        activeJobsCount: activeCount,
        terminalJobsCount: terminalCount,
        archivalCandidateCount: terminalCount,
        capacityRemaining,
        queuedCount,
        leasedCount,
        processingCount,
        retryWaitCount,
        blockedCount,
        completedCount,
        failedCount,
        cancelledCount,
        expiredLeaseCount,
        stalledCount,
        oldestQueuedAgeSeconds,
        nextAvailableJobAt,
        capacityUsageRatio,
        maxActiveCapacity: maxActive,
        queueStoreEstimatedBytes
    };
}

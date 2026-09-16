/**
 * server/jobs/voiceCallJobReconciliation.js
 * Read-Only Consistency & Anomaly Auditor for Persistent Job Queue.
 * Mind-ERP OS Track A8.
 * 
 * BOUNDARY NOTICE:
 * - Read-only: Does NOT perform automatic mutation or repair.
 * - Sensitive payload protection: Never includes transcripts, tokens, hashes, audio paths, or PII.
 */

import {
    JOB_STATUS,
    ACTIVE_JOB_STATUSES,
    JOB_TYPES,
    SYNTHETIC_JOB_TYPES,
    DEFAULT_JOB_LIMITS
} from './voiceCallJobConstants.js';
import { isValidIsoDate, isSafeResultReference } from './voiceCallJobValidator.js';

export const RECONCILIATION_CHECK_CODES = Object.freeze({
    JOB_STORE_CORRUPTED: 'JOB_STORE_CORRUPTED',
    JOB_DUPLICATE_ID: 'JOB_DUPLICATE_ID',
    JOB_DUPLICATE_IDEMPOTENCY_KEY: 'JOB_DUPLICATE_IDEMPOTENCY_KEY',
    JOB_ORPHAN_CALL: 'JOB_ORPHAN_CALL',
    JOB_INVALID_STATUS: 'JOB_INVALID_STATUS',
    JOB_INVALID_VERSION: 'JOB_INVALID_VERSION',
    JOB_INVALID_TIMESTAMP: 'JOB_INVALID_TIMESTAMP',
    JOB_LEASE_FIELDS_MISSING: 'JOB_LEASE_FIELDS_MISSING',
    JOB_LEASE_EXPIRED: 'JOB_LEASE_EXPIRED',
    JOB_LEASE_TOKEN_HASH_INVALID: 'JOB_LEASE_TOKEN_HASH_INVALID',
    JOB_RETRY_TIME_MISSING: 'JOB_RETRY_TIME_MISSING',
    JOB_COMPLETED_TIME_MISSING: 'JOB_COMPLETED_TIME_MISSING',
    JOB_FAILED_ERROR_MISSING: 'JOB_FAILED_ERROR_MISSING',
    JOB_CANCELLED_TIME_MISSING: 'JOB_CANCELLED_TIME_MISSING',
    JOB_ATTEMPT_EXCEEDS_MAX: 'JOB_ATTEMPT_EXCEEDS_MAX',
    JOB_STALLED: 'JOB_STALLED',
    JOB_BLOCKED_REASON_MISSING: 'JOB_BLOCKED_REASON_MISSING',
    JOB_UNKNOWN_TYPE: 'JOB_UNKNOWN_TYPE',
    JOB_TEST_TYPE_IN_PRODUCTION: 'JOB_TEST_TYPE_IN_PRODUCTION',
    JOB_RESULT_REFERENCE_INVALID: 'JOB_RESULT_REFERENCE_INVALID',
    JOB_QUEUE_CAPACITY_WARNING: 'JOB_QUEUE_CAPACITY_WARNING'
});

export const SEVERITY = Object.freeze({
    CRITICAL: 'CRITICAL',
    WARNING: 'WARNING',
    INFO: 'INFO'
});

/**
 * Execute a read-only reconciliation scan on the persistent job queue.
 * 
 * @param {Object} params
 * @param {import('./voiceCallJobRepository.js').VoiceCallJobRepository} params.repository
 * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} [params.voiceCallRepo]
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<Array<Object>>} Findings
 */
export async function runJobReconciliation(params = {}) {
    const findings = [];
    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
        ? params.now
        : new Date();
    const nowMs = now.getTime();

    const repo = params.repository;
    if (!repo) {
        throw new Error('repository is required for reconciliation');
    }

    const voiceCallRepo = params.voiceCallRepo || repo.voiceCallRepo || null;

    let jobs;
    try {
        jobs = repo.list();
    } catch (err) {
        findings.push({
            checkCode: RECONCILIATION_CHECK_CODES.JOB_STORE_CORRUPTED,
            severity: SEVERITY.CRITICAL,
            resourceType: 'voice_call_job_store',
            resourceId: 'VoiceCallJobs',
            repairable: false,
            safeMessage: 'Failed to read job store from disk: storage is corrupted or unreadable'
        });
        return findings;
    }

    // Capacity warning check
    const activeJobs = jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
    const maxActive = repo.limits.MAX_ACTIVE_JOBS || DEFAULT_JOB_LIMITS.MAX_ACTIVE_JOBS;
    if (activeJobs.length >= maxActive * 0.8) {
        findings.push({
            checkCode: RECONCILIATION_CHECK_CODES.JOB_QUEUE_CAPACITY_WARNING,
            severity: SEVERITY.WARNING,
            resourceType: 'voice_call_job_store',
            resourceId: 'VoiceCallJobs',
            repairable: false,
            safeMessage: `Active jobs (${activeJobs.length}) reached or exceeded 80% capacity of ${maxActive}`
        });
    }

    const seenIds = new Set();
    const activeIdempotencyMap = new Map();

    const validStatuses = new Set(Object.values(JOB_STATUS));
    const validJobTypes = new Set(Object.values(JOB_TYPES));

    for (const job of jobs) {
        // 1. Duplicate ID check
        if (!job.id || seenIds.has(job.id)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_DUPLICATE_ID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id || 'missing_id',
                repairable: false,
                safeMessage: 'Duplicate or missing job ID detected'
            });
        } else {
            seenIds.add(job.id);
        }

        // 2. Duplicate active idempotency key
        if (ACTIVE_JOB_STATUSES.includes(job.status)) {
            if (activeIdempotencyMap.has(job.idempotencyKey)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_DUPLICATE_IDEMPOTENCY_KEY,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: 'Duplicate active idempotency key detected across active jobs'
                });
            } else {
                activeIdempotencyMap.set(job.idempotencyKey, job.id);
            }
        }

        // 3. Orphan call check
        if (voiceCallRepo && job.callId) {
            const parentCall = voiceCallRepo.findById(job.callId);
            if (!parentCall) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_ORPHAN_CALL,
                    severity: SEVERITY.WARNING,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: `Job references non-existent parent VoiceCall (${job.callId})`
                });
            }
        }

        // 4. Unknown job type & production synthetic check
        if (!validJobTypes.has(job.jobType)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_UNKNOWN_TYPE,
                severity: SEVERITY.WARNING,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: `Unrecognized job type: ${job.jobType}`
            });
        } else if (repo.isProduction && !repo.enableSyntheticJobTypes && SYNTHETIC_JOB_TYPES.has(job.jobType)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_TEST_TYPE_IN_PRODUCTION,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: `Synthetic test job prohibited in production store: ${job.jobType}`
            });
        }

        // 5. Invalid status
        if (!validStatuses.has(job.status)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_INVALID_STATUS,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: `Invalid job status: ${job.status}`
            });
        }

        // 6. Invalid version
        if (!Number.isSafeInteger(job.version) || job.version < 1) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_INVALID_VERSION,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Job version is missing or not a positive safe integer'
            });
        }

        // 7. Invalid timestamps
        if (!isValidIsoDate(job.createdAt) || !isValidIsoDate(job.updatedAt)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_INVALID_TIMESTAMP,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Job createdAt or updatedAt is not a valid ISO timestamp'
            });
        }

        // 8. Attempt count invariants
        if (typeof job.attemptCount === 'number' && typeof job.maxAttempts === 'number') {
            if (job.attemptCount > job.maxAttempts) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_ATTEMPT_EXCEEDS_MAX,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: `Job attemptCount (${job.attemptCount}) exceeds maxAttempts (${job.maxAttempts})`
                });
            }
        }

        // 9. Lease field checks & expiry
        if ([JOB_STATUS.LEASED, JOB_STATUS.PROCESSING].includes(job.status)) {
            if (!job.leaseOwner || !job.leaseTokenHash || !job.leaseExpiresAt) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_LEASE_FIELDS_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: 'Leased/Processing job missing mandatory lease ownership fields'
                });
            }

            if (job.leaseTokenHash && !/^[a-f0-9]{64}$/i.test(job.leaseTokenHash)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_LEASE_TOKEN_HASH_INVALID,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: 'Job leaseTokenHash is not a valid 64-character sha256 hex string'
                });
            }

            if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_LEASE_EXPIRED,
                    severity: SEVERITY.WARNING,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: 'Active job lease has expired and is pending recovery'
                });
            }

            // 10. Stalled job check
            const stalledThreshold = repo.limits.STALLED_THRESHOLD_MS || DEFAULT_JOB_LIMITS.STALLED_THRESHOLD_MS;
            const refTime = job.heartbeatAt || job.startedAt || job.leaseAcquiredAt;
            if (refTime && (nowMs - new Date(refTime).getTime() > stalledThreshold)) {
                findings.push({
                    checkCode: RECONCILIATION_CHECK_CODES.JOB_STALLED,
                    severity: SEVERITY.WARNING,
                    resourceType: 'voice_call_job',
                    resourceId: job.id,
                    repairable: false,
                    safeMessage: `Job has been inactive without heartbeat for over ${Math.round(stalledThreshold / 1000)}s`
                });
            }
        }

        // 11. State-specific checks
        if (job.status === JOB_STATUS.RETRY_WAIT && !job.nextAttemptAt) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_RETRY_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Job in retry_wait status is missing nextAttemptAt'
            });
        }

        if (job.status === JOB_STATUS.COMPLETED && !job.completedAt) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_COMPLETED_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Completed job is missing completedAt timestamp'
            });
        }

        if (job.status === JOB_STATUS.FAILED && !job.lastErrorCode) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_FAILED_ERROR_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Failed job is missing lastErrorCode'
            });
        }

        if (job.status === JOB_STATUS.CANCELLED && !job.cancelledAt) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_CANCELLED_TIME_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Cancelled job is missing cancelledAt timestamp'
            });
        }

        if (job.status === JOB_STATUS.BLOCKED && !job.lastErrorCode) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_BLOCKED_REASON_MISSING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Blocked job is missing lastErrorCode reason'
            });
        }

        // 12. Safe result reference
        if (!isSafeResultReference(job.resultReference)) {
            findings.push({
                checkCode: RECONCILIATION_CHECK_CODES.JOB_RESULT_REFERENCE_INVALID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call_job',
                resourceId: job.id,
                repairable: false,
                safeMessage: 'Job resultReference contains prohibited keys or excessive payload size'
            });
        }
    }

    return findings;
}

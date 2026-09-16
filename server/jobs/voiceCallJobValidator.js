/**
 * server/jobs/voiceCallJobValidator.js
 * Invariant, Schema & Configuration Validator for Persistent Job Queue.
 * Mind-ERP OS Track A8 Final Integrity Closure.
 */

import {
    JOB_STATUS,
    JOB_TYPES,
    PRODUCTION_JOB_TYPES,
    SYNTHETIC_JOB_TYPES,
    JOB_PRIORITY,
    JOB_ERROR_CODES,
    DEFAULT_JOB_LIMITS
} from './voiceCallJobConstants.js';
import { VoiceCallJobError } from './voiceCallJobErrors.js';

const CALL_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

// Strict allowlist of permissible keys inside resultReference
export const ALLOWED_RESULT_REFERENCE_KEYS = Object.freeze(new Set([
    'processingRevisionId',
    'transcriptId',
    'reconciliationRunId',
    'safeResultCode'
]));

// Forbidden sensitive property names that MUST NOT exist in VoiceCallJob
const FORBIDDEN_SENSITIVE_KEYS = new Set([
    'audio',
    'audiobinary',
    'audiodata',
    'audiopath',
    'transcript',
    'transcription',
    'summary',
    'prompt',
    'response',
    'clientname',
    'callername',
    'name',
    'phonenumber',
    'phone',
    'ssn',
    'rrn',
    'storagekey',
    'absolutepath',
    'signedurl',
    'sessiontoken',
    'cookie',
    'password',
    'stack',
    'stacktrace',
    'leasetoken' // Store must only contain leaseTokenHash, never raw leaseToken!
]);

export function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    return JSON.parse(JSON.stringify(obj));
}

export function isValidIsoDate(value) {
    if (typeof value !== 'string') return false;
    const d = new Date(value);
    return !Number.isNaN(d.getTime()) && value === d.toISOString();
}

export function sanitizeErrorMessage(message) {
    if (!message || typeof message !== 'string') return null;
    let sanitized = message.split('\n')[0].trim();
    if (sanitized.length > DEFAULT_JOB_LIMITS.MAX_ERROR_MESSAGE_LEN) {
        sanitized = sanitized.slice(0, DEFAULT_JOB_LIMITS.MAX_ERROR_MESSAGE_LEN);
    }
    return sanitized;
}

/**
 * Strict allowlist validator for resultReference.
 * Only permits defined keys with safe string identifier values.
 * Prohibits nested objects, arrays, and any unknown or sensitive keys.
 * 
 * @param {Object|null} ref
 * @returns {boolean}
 */
export function isSafeResultReference(ref) {
    if (ref === null || ref === undefined) return true;
    if (typeof ref !== 'object' || Array.isArray(ref)) return false;

    const keys = Object.keys(ref);
    if (keys.length === 0) return true;

    for (const key of keys) {
        // Enforce strict allowlist: any key not in allowlist is rejected
        if (!ALLOWED_RESULT_REFERENCE_KEYS.has(key)) {
            return false;
        }

        const val = ref[key];
        // Value must be a safe non-empty string or boolean
        if (typeof val === 'string') {
            if (!SAFE_ID_REGEX.test(val)) return false;
        } else if (typeof val !== 'boolean') {
            return false;
        }
    }
    return true;
}

/**
 * Validate configuration parameters for the Queue, Worker, and Repository.
 * Ensures consistent relationship among lease duration, heartbeat interval, timeouts, and limits.
 * 
 * @param {Object} config
 * @throws {VoiceCallJobError} If configuration is invalid
 */
export function validateQueueConfig(config = {}) {
    const {
        leaseDurationMs,
        heartbeatIntervalMs,
        minHeartbeatIntervalMs,
        stalledThresholdMs,
        handlerTimeoutMs,
        shutdownGraceMs,
        maxActiveJobs,
        maxTotalJobs,
        maxPerCallJobs,
        maxPerTypeJobs
    } = config;

    if (leaseDurationMs !== undefined) {
        if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'leaseDurationMs must be positive safe integer');
        }
    }

    if (heartbeatIntervalMs !== undefined) {
        if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'heartbeatIntervalMs must be positive safe integer');
        }
    }

    if (minHeartbeatIntervalMs !== undefined) {
        if (!Number.isSafeInteger(minHeartbeatIntervalMs) || minHeartbeatIntervalMs <= 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'minHeartbeatIntervalMs must be positive safe integer');
        }
    }

    if (stalledThresholdMs !== undefined) {
        if (!Number.isSafeInteger(stalledThresholdMs) || stalledThresholdMs <= 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'stalledThresholdMs must be positive safe integer');
        }
    }

    if (handlerTimeoutMs !== undefined) {
        if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs <= 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'handlerTimeoutMs must be positive safe integer');
        }
    }

    if (shutdownGraceMs !== undefined) {
        if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0) {
            throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'shutdownGraceMs must be non-negative safe integer');
        }
    }

    // Relational consistency assertions
    if (leaseDurationMs && heartbeatIntervalMs && heartbeatIntervalMs >= leaseDurationMs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'heartbeatIntervalMs must be strictly less than leaseDurationMs');
    }

    if (minHeartbeatIntervalMs && heartbeatIntervalMs && minHeartbeatIntervalMs > heartbeatIntervalMs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'minHeartbeatIntervalMs cannot exceed heartbeatIntervalMs');
    }

    if (stalledThresholdMs && leaseDurationMs && stalledThresholdMs < leaseDurationMs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'stalledThresholdMs cannot be less than leaseDurationMs');
    }

    // Capacity relational consistency
    if (maxActiveJobs && maxTotalJobs && maxActiveJobs > maxTotalJobs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'maxActiveJobs cannot exceed maxTotalJobs');
    }

    if (maxPerCallJobs && maxActiveJobs && maxPerCallJobs > maxActiveJobs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'maxPerCallJobs cannot exceed maxActiveJobs');
    }

    if (maxPerTypeJobs && maxTotalJobs && maxPerTypeJobs > maxTotalJobs) {
        throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_CONFIGURATION_INVALID, 'maxPerTypeJobs cannot exceed maxTotalJobs');
    }

    return true;
}

/**
 * Validates a single VoiceCallJob record against canonical schema & invariants.
 * 
 * @param {Object} job
 * @param {Object} [options={}]
 * @param {Date} [options.now]
 * @param {boolean} [options.isProduction=false]
 * @param {boolean} [options.enableSyntheticJobTypes=false]
 */
export function validateJobRecord(job, options = {}) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            'Job payload must be a non-null object'
        );
    }

    // 1. Check forbidden sensitive keys at root level
    for (const key of Object.keys(job)) {
        if (FORBIDDEN_SENSITIVE_KEYS.has(key.toLowerCase())) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
                `Sensitive payload key prohibited in job record: ${key}`
            );
        }
    }

    // 2. Identity and typing
    if (typeof job.id !== 'string' || !JOB_ID_REGEX.test(job.id)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            'Job id must be a valid non-empty identifier'
        );
    }

    if (typeof job.callId !== 'string' || !CALL_ID_REGEX.test(job.callId)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            'Job callId must be a valid identifier'
        );
    }

    const validJobTypes = new Set(Object.values(JOB_TYPES));
    if (!validJobTypes.has(job.jobType)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.UNSUPPORTED_JOB_TYPE,
            `Unsupported jobType: ${job.jobType}`
        );
    }

    // Check production prohibition of synthetic test job types
    if (options.isProduction && !options.enableSyntheticJobTypes && SYNTHETIC_JOB_TYPES.has(job.jobType)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_TEST_TYPE_NOT_ALLOWED,
            `Synthetic test job type is prohibited in production: ${job.jobType}`
        );
    }

    const validStatuses = new Set(Object.values(JOB_STATUS));
    if (!validStatuses.has(job.status)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            `Invalid job status: ${job.status}`
        );
    }

    const validPriorities = new Set(Object.values(JOB_PRIORITY));
    if (!validPriorities.has(job.priority)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            `Invalid job priority: ${job.priority}`
        );
    }

    // 3. Version and attempts
    if (!Number.isSafeInteger(job.version) || job.version < 1) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'version must be a positive safe integer >= 1'
        );
    }

    if (!Number.isSafeInteger(job.pipelineRevision) || job.pipelineRevision < 1) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'pipelineRevision must be a positive safe integer >= 1'
        );
    }

    if (!Number.isSafeInteger(job.attemptCount) || job.attemptCount < 0) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'attemptCount must be a non-negative integer >= 0'
        );
    }

    if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'maxAttempts must be a positive integer >= 1'
        );
    }

    if (job.attemptCount > job.maxAttempts) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_MAX_ATTEMPTS_EXCEEDED,
            `attemptCount (${job.attemptCount}) cannot exceed maxAttempts (${job.maxAttempts})`
        );
    }

    // 4. Timestamps
    if (!isValidIsoDate(job.createdAt)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'createdAt must be a valid UTC ISO string'
        );
    }

    if (!isValidIsoDate(job.updatedAt)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'updatedAt must be a valid UTC ISO string'
        );
    }

    if (new Date(job.updatedAt).getTime() < new Date(job.createdAt).getTime()) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
            'updatedAt cannot precede createdAt'
        );
    }

    // 5. Result reference check
    if (!isSafeResultReference(job.resultReference)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
            'resultReference contains invalid, unapproved, or sensitive fields'
        );
    }

    // 6. State-specific invariants
    switch (job.status) {
        case JOB_STATUS.QUEUED:
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'queued job must not have active lease fields'
                );
            }
            if (job.nextAttemptAt !== null && !isValidIsoDate(job.nextAttemptAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'queued job nextAttemptAt must be a valid ISO string or null'
                );
            }
            break;

        case JOB_STATUS.LEASED:
            if (!job.leaseOwner || typeof job.leaseOwner !== 'string') {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_LEASE_REQUIRED,
                    'leased job requires leaseOwner'
                );
            }
            if (!job.leaseTokenHash || !SHA256_HEX_REGEX.test(job.leaseTokenHash)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_LEASE_TOKEN_INVALID,
                    'leased job requires valid leaseTokenHash'
                );
            }
            if (!isValidIsoDate(job.leaseAcquiredAt) || !isValidIsoDate(job.leaseExpiresAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'leased job requires valid leaseAcquiredAt and leaseExpiresAt'
                );
            }
            if (new Date(job.leaseExpiresAt).getTime() <= new Date(job.leaseAcquiredAt).getTime()) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'leaseExpiresAt must be after leaseAcquiredAt'
                );
            }
            break;

        case JOB_STATUS.PROCESSING:
            if (!job.leaseOwner || !job.leaseTokenHash || !SHA256_HEX_REGEX.test(job.leaseTokenHash)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_LEASE_REQUIRED,
                    'processing job requires leaseOwner and leaseTokenHash'
                );
            }
            if (!isValidIsoDate(job.startedAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'processing job requires valid startedAt'
                );
            }
            if (!isValidIsoDate(job.leaseExpiresAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'processing job requires valid leaseExpiresAt'
                );
            }
            break;

        case JOB_STATUS.RETRY_WAIT:
            if (!isValidIsoDate(job.nextAttemptAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'retry_wait job requires nextAttemptAt'
                );
            }
            if (!job.lastErrorCode) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'retry_wait job requires lastErrorCode'
                );
            }
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'retry_wait job must not have active lease'
                );
            }
            break;

        case JOB_STATUS.COMPLETED:
            if (!isValidIsoDate(job.completedAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'completed job requires completedAt'
                );
            }
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'completed job must not have active lease'
                );
            }
            break;

        case JOB_STATUS.FAILED:
            if (!isValidIsoDate(job.failedAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'failed job requires failedAt'
                );
            }
            if (!job.lastErrorCode) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'failed job requires lastErrorCode'
                );
            }
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'failed job must not have active lease'
                );
            }
            break;

        case JOB_STATUS.CANCELLED:
            if (!isValidIsoDate(job.cancelledAt)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'cancelled job requires cancelledAt'
                );
            }
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'cancelled job must not have active lease'
                );
            }
            break;

        case JOB_STATUS.BLOCKED:
            if (!job.lastErrorCode) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'blocked job requires lastErrorCode'
                );
            }
            if (job.leaseOwner !== null || job.leaseTokenHash !== null || job.leaseExpiresAt !== null) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVARIANTS_VIOLATED,
                    'blocked job must not have active lease'
                );
            }
            break;
    }

    return true;
}

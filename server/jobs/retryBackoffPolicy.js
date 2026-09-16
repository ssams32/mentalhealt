/**
 * server/jobs/retryBackoffPolicy.js
 * Exponential Backoff with Bounded Jitter and Error Classification.
 * Mind-ERP OS Track A8.
 */

import {
    DEFAULT_JOB_LIMITS,
    ERROR_CLASSIFICATION,
    RETRYABLE_ERROR_CODES,
    NON_RETRYABLE_ERROR_CODES,
    BLOCKED_ERROR_CODES
} from './voiceCallJobConstants.js';

/**
 * Classify an error code into RETRYABLE, NON_RETRYABLE, or BLOCKED.
 * 
 * @param {string} errorCode
 * @returns {string} One of ERROR_CLASSIFICATION
 */
export function classifyError(errorCode) {
    if (RETRYABLE_ERROR_CODES.has(errorCode)) {
        return ERROR_CLASSIFICATION.RETRYABLE;
    }
    if (BLOCKED_ERROR_CODES.has(errorCode)) {
        return ERROR_CLASSIFICATION.BLOCKED;
    }
    // Default fail-safe: Any unclassified or domain error is non-retryable
    return ERROR_CLASSIFICATION.NON_RETRYABLE;
}

/**
 * Compute the exponential backoff delay with bounded jitter.
 * 
 * @param {Object} params
 * @param {number} params.attemptCount - Current attempt count (>= 1)
 * @param {number} [params.baseDelayMs] - Default 1000ms
 * @param {number} [params.maxDelayMs] - Default 60000ms
 * @param {number} [params.jitterRatio] - Ratio in [0, 1], default 0.2
 * @param {Function} [params.randomFn] - Deterministic random function returning [0, 1)
 * @param {Date} [params.now] - Current reference time
 * @returns {{ delayMs: number, nextAttemptAt: Date }}
 */
export function computeRetryDelay(params = {}) {
    const attemptCount = Number.isSafeInteger(params.attemptCount) && params.attemptCount >= 1
        ? params.attemptCount
        : 1;

    const baseDelayMs = Number.isSafeInteger(params.baseDelayMs) && params.baseDelayMs >= 0
        ? params.baseDelayMs
        : DEFAULT_JOB_LIMITS.RETRY_BASE_DELAY_MS;

    const maxDelayMs = Number.isSafeInteger(params.maxDelayMs) && params.maxDelayMs >= baseDelayMs
        ? params.maxDelayMs
        : DEFAULT_JOB_LIMITS.RETRY_MAX_DELAY_MS;

    const jitterRatio = typeof params.jitterRatio === 'number' && params.jitterRatio >= 0 && params.jitterRatio <= 1
        ? params.jitterRatio
        : DEFAULT_JOB_LIMITS.RETRY_JITTER_RATIO;

    const randomFn = typeof params.randomFn === 'function'
        ? params.randomFn
        : Math.random;

    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
        ? params.now
        : new Date();

    // Exponential factor with overflow guard: 2^(attemptCount - 1)
    const exponent = Math.min(30, Math.max(0, attemptCount - 1));
    const rawExponential = baseDelayMs * Math.pow(2, exponent);

    // Clamp to maxDelayMs before jitter
    const clampedDelay = Math.min(rawExponential, maxDelayMs);

    // Apply bounded jitter: +/- jitterRatio
    // bounded in [clampedDelay * (1 - jitterRatio), clampedDelay * (1 + jitterRatio)]
    const randomVal = Number.isFinite(randomFn()) ? Math.max(0, Math.min(1, randomFn())) : 0.5;
    const jitterMultiplier = 1 + (randomVal * 2 - 1) * jitterRatio;
    const jitteredDelay = Math.round(clampedDelay * jitterMultiplier);

    // Final safety clamps: must be >= 0 and <= maxDelayMs (with slight ceiling margin or strictly maxDelayMs)
    const finalDelayMs = Math.max(0, Math.min(jitteredDelay, maxDelayMs));
    const nextAttemptAt = new Date(now.getTime() + finalDelayMs);

    return {
        delayMs: finalDelayMs,
        nextAttemptAt
    };
}

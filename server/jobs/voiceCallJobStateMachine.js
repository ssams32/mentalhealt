/**
 * server/jobs/voiceCallJobStateMachine.js
 * State Machine and Transition Rules for Persistent Job Queue.
 * Mind-ERP OS Track A8.
 */

import { JOB_STATUS, JOB_ERROR_CODES } from './voiceCallJobConstants.js';
import { VoiceCallJobError } from './voiceCallJobErrors.js';
import { validateJobRecord } from './voiceCallJobValidator.js';

export const ALLOWED_TRANSITIONS = Object.freeze({
    [JOB_STATUS.QUEUED]: Object.freeze([
        JOB_STATUS.LEASED,
        JOB_STATUS.CANCELLED,
        JOB_STATUS.BLOCKED
    ]),
    [JOB_STATUS.LEASED]: Object.freeze([
        JOB_STATUS.PROCESSING,
        JOB_STATUS.QUEUED,
        JOB_STATUS.RETRY_WAIT,
        JOB_STATUS.FAILED,
        JOB_STATUS.CANCELLED,
        JOB_STATUS.BLOCKED
    ]),
    [JOB_STATUS.PROCESSING]: Object.freeze([
        JOB_STATUS.COMPLETED,
        JOB_STATUS.RETRY_WAIT,
        JOB_STATUS.FAILED,
        JOB_STATUS.CANCELLED,
        JOB_STATUS.BLOCKED
    ]),
    [JOB_STATUS.RETRY_WAIT]: Object.freeze([
        JOB_STATUS.QUEUED,
        JOB_STATUS.FAILED,
        JOB_STATUS.CANCELLED,
        JOB_STATUS.BLOCKED
    ]),
    [JOB_STATUS.BLOCKED]: Object.freeze([
        JOB_STATUS.QUEUED,
        JOB_STATUS.CANCELLED,
        JOB_STATUS.FAILED
    ]),
    // Terminal states - no further transitions permitted
    [JOB_STATUS.COMPLETED]: Object.freeze([]),
    [JOB_STATUS.FAILED]: Object.freeze([]),
    [JOB_STATUS.CANCELLED]: Object.freeze([])
});

/**
 * Check whether a status transition is permitted.
 */
export function isTransitionAllowed(currentStatus, targetStatus) {
    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed) return false;
    return allowed.includes(targetStatus);
}

/**
 * Perform a validated state transition on a mutable or cloned job object.
 * Increments version and validates all schema invariants post-transition.
 * 
 * @param {Object} job - The job record to mutate
 * @param {string} targetStatus - New status
 * @param {Object} patchFields - Fields required for the new status
 * @param {Date} [now=new Date()]
 * @returns {Object} mutated job
 */
export function transitionJob(job, targetStatus, patchFields = {}, now = new Date()) {
    const currentStatus = job.status;

    if (!isTransitionAllowed(currentStatus, targetStatus)) {
        throw new VoiceCallJobError(
            JOB_ERROR_CODES.JOB_INVALID_STATE_TRANSITION,
            `Cannot transition job from ${currentStatus} to ${targetStatus}`
        );
    }

    const isoNow = now.toISOString();

    // Apply patch fields
    Object.assign(job, patchFields);

    // Update status, version, and updatedAt
    job.status = targetStatus;
    job.version = (job.version || 0) + 1;
    job.updatedAt = isoNow;

    // Validate post-transition invariants
    validateJobRecord(job, { now });

    return job;
}

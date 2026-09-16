/**
 * server/jobs/voiceCallJobRepository.js
 * Atomic File Persistence for VoiceCall Persistent Job Queue.
 * Mind-ERP OS Track A8 Final Integrity Closure.
 * 
 * Implements:
 * - Actual Normalized File Path-based Shared File Locking
 * - Monotonically Non-Decreasing Attempt Count (Strict Immutability)
 * - Pre-Claim Eligibility Evaluation & Non-blocking Pre-claim Blocking
 * - Release of Due Retries inside Lock
 * - Production vs Test Job Type Separation
 * - Separated Store Read/Write Error Codes
 * - Fail-Closed Store Corruption Defense
 */

import crypto from 'crypto';
import path from 'path';
import {
    JOB_STATUS,
    ACTIVE_JOB_STATUSES,
    JOB_TYPES,
    PRODUCTION_JOB_TYPES,
    SYNTHETIC_JOB_TYPES,
    JOB_PRIORITY,
    PRIORITY_WEIGHTS,
    DEFAULT_JOB_LIMITS,
    JOB_ERROR_CODES
} from './voiceCallJobConstants.js';
import { VoiceCallJobError } from './voiceCallJobErrors.js';
import {
    validateJobRecord,
    validateQueueConfig,
    deepClone,
    sanitizeErrorMessage,
    isSafeResultReference
} from './voiceCallJobValidator.js';
import { transitionJob } from './voiceCallJobStateMachine.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

export const JOB_STORAGE_FILE = 'VoiceCallJobs';

/**
 * Timing-safe comparison of provided lease token against stored sha256 hash.
 */
function safeTokenMatchesHash(providedToken, storedHash) {
    if (typeof providedToken !== 'string' || typeof storedHash !== 'string') {
        return false;
    }
    if (providedToken.length === 0 || providedToken.length > 256 || storedHash.length !== 64) {
        return false;
    }
    try {
        const computedHash = crypto.createHash('sha256').update(providedToken).digest('hex');
        const bufA = Buffer.from(computedHash, 'hex');
        const bufB = Buffer.from(storedHash, 'hex');
        if (bufA.length !== bufB.length) {
            return false;
        }
        return crypto.timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

export class VoiceCallJobRepository {
    /**
     * @param {Function} getDataFn - (filename, defaultValue) => Array
     * @param {Function} persistDataFn - async (filename, data) => Promise<boolean>
     * @param {Object} [deps={}] - Dependencies & Config
     * @param {string} [deps.dataDir] - Optional directory path to resolve actual queue file
     * @param {string} [deps.filePath] - Optional explicit absolute file path
     * @param {Object} [deps.voiceCallRepo] - VoiceCallRepository dependency
     * @param {Object} [deps.limits] - Custom capacity and timeout limits
     * @param {boolean} [deps.isProduction] - Production mode flag
     * @param {boolean} [deps.enableSyntheticJobTypes] - Flag to allow synthetic jobs
     */
    constructor(getDataFn, persistDataFn, deps = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.voiceCallRepo = deps.voiceCallRepo || null;

        this.limits = {
            ...DEFAULT_JOB_LIMITS,
            ...(deps.limits || {})
        };

        // Validate configuration invariants
        validateQueueConfig(this.limits);

        this.isProduction = deps.isProduction !== undefined
            ? Boolean(deps.isProduction)
            : process.env.NODE_ENV === 'production';
        this.enableSyntheticJobTypes = Boolean(deps.enableSyntheticJobTypes);

        // Compute normalized absolute path for file-level locking
        if (deps.filePath) {
            this.filePath = path.resolve(deps.filePath);
        } else if (deps.dataDir) {
            this.filePath = path.resolve(deps.dataDir, `${JOB_STORAGE_FILE}.json`);
        } else {
            this.filePath = path.resolve(process.cwd(), 'app', 'data', `${JOB_STORAGE_FILE}.json`);
        }
        this.lockKey = this.filePath;

        this.isCorrupted = false;
    }

    setVoiceCallRepository(repo) {
        this.voiceCallRepo = repo;
    }

    /**
     * Operator recovery: reset corruption state ONLY after verifying the store is valid.
     */
    resetCorruptionState() {
        try {
            const records = this.getData(JOB_STORAGE_FILE, null);
            if (!Array.isArray(records)) {
                this.isCorrupted = true;
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                    'Recovery failed: Store data is not a valid JSON array'
                );
            }

            const seenIds = new Set();
            const seenActiveIdempotency = new Set();

            for (const record of records) {
                validateJobRecord(record, {
                    isProduction: this.isProduction,
                    enableSyntheticJobTypes: this.enableSyntheticJobTypes
                });

                if (seenIds.has(record.id)) {
                    this.isCorrupted = true;
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                        'Recovery failed: Duplicate job id detected in store'
                    );
                }
                seenIds.add(record.id);

                if (ACTIVE_JOB_STATUSES.includes(record.status)) {
                    if (seenActiveIdempotency.has(record.idempotencyKey)) {
                        this.isCorrupted = true;
                        throw new VoiceCallJobError(
                            JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                            'Recovery failed: Duplicate active idempotency key in store'
                        );
                    }
                    seenActiveIdempotency.add(record.idempotencyKey);
                }
            }

            this.isCorrupted = false;
            return true;
        } catch (err) {
            this.isCorrupted = true;
            if (err instanceof VoiceCallJobError) throw err;
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                'Store reset verification failed: ' + (err.message || 'Unknown error')
            );
        }
    }

    /**
     * Safely load all jobs from store with corruption protection.
     * @private
     */
    _loadStore() {
        if (this.isCorrupted) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                'Queue storage is corrupted. Operations halted.'
            );
        }

        let raw;
        try {
            raw = this.getData(JOB_STORAGE_FILE, []);
        } catch (e) {
            this.isCorrupted = true;
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_READ_FAILED,
                'Failed to read or parse Queue storage from disk.'
            );
        }

        if (!Array.isArray(raw)) {
            this.isCorrupted = true;
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_CORRUPTED,
                'Queue storage root must be an array.'
            );
        }

        return raw;
    }

    /**
     * Safely persist jobs to disk.
     * @private
     */
    async _saveStore(jobs) {
        if (!Array.isArray(jobs)) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
                'Cannot persist non-array to Queue store'
            );
        }
        let success = false;
        try {
            success = await this.persistData(JOB_STORAGE_FILE, jobs);
        } catch (err) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_WRITE_FAILED,
                'Exception thrown while writing Queue store to disk'
            );
        }
        if (!success) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_STORE_WRITE_FAILED,
                'Failed to write Queue store to disk'
            );
        }
        return true;
    }

    /**
     * Verify lease ownership and validity.
     * @private
     */
    _verifyLeaseOwnership(job, workerId, leaseToken, now = new Date()) {
        if (!workerId || typeof workerId !== 'string') {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_LEASE_REQUIRED,
                'Worker identity is required to assert lease'
            );
        }

        if (!leaseToken || typeof leaseToken !== 'string') {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_LEASE_TOKEN_INVALID,
                'Lease token is required to assert lease'
            );
        }

        if (job.leaseOwner !== workerId) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_LEASE_OWNER_MISMATCH,
                'Lease owner mismatch for this job'
            );
        }

        if (!safeTokenMatchesHash(leaseToken, job.leaseTokenHash)) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_LEASE_TOKEN_INVALID,
                'Invalid lease token provided'
            );
        }

        if (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now.getTime()) {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.JOB_LEASE_EXPIRED,
                'Lease has expired for this job'
            );
        }

        return true;
    }

    /**
     * Determine whether a queued job is executable under current execution context.
     * Used for pre-claim blocking without incrementing attemptCount.
     * 
     * @param {Object} job
     * @param {Object} [ctx={}]
     * @returns {{ executable: boolean, blockedCode?: string, blockedMessage?: string }}
     */
    isJobExecutable(job, ctx = {}) {
        const isProduction = ctx.isProduction !== undefined ? ctx.isProduction : this.isProduction;
        const enableSynthetic = ctx.enableSyntheticJobTypes !== undefined ? ctx.enableSyntheticJobTypes : this.enableSyntheticJobTypes;

        // 1. Synthetic job protection
        if (SYNTHETIC_JOB_TYPES.has(job.jobType)) {
            if (isProduction && !enableSynthetic) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.JOB_TEST_TYPE_NOT_ALLOWED,
                    blockedMessage: 'Synthetic test jobs are prohibited from execution in production'
                };
            }
        }

        // 2. STT Provider configuration
        if (job.jobType === JOB_TYPES.STT_TRANSCRIPTION) {
            if (ctx.aiEnabled === false) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.AI_DISABLED,
                    blockedMessage: 'AI pipeline is disabled in current configuration'
                };
            }
            if (ctx.sttConfigured === false) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                    blockedMessage: 'STT Provider is unconfigured'
                };
            }
        }

        // 3. LLM Provider configuration
        if (job.jobType === JOB_TYPES.LLM_CLASSIFICATION) {
            if (ctx.aiEnabled === false) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.AI_DISABLED,
                    blockedMessage: 'AI pipeline is disabled in current configuration'
                };
            }
            if (ctx.llmConfigured === false) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                    blockedMessage: 'LLM Provider is unconfigured'
                };
            }
        }

        // 4. Audio decode validation provider
        if (job.jobType === JOB_TYPES.AUDIO_DECODE_VALIDATION) {
            if (ctx.decodeProviderConfigured === false) {
                return {
                    executable: false,
                    blockedCode: JOB_ERROR_CODES.DEPENDENCY_NOT_READY,
                    blockedMessage: 'Audio decode validation provider is not ready'
                };
            }
        }

        return { executable: true };
    }

    /**
     * Generate canonical server-side idempotency key.
     */
    generateIdempotencyKey(jobType, callId, pipelineRevision) {
        return crypto.createHash('sha256')
            .update(`${jobType}:${callId}:${pipelineRevision}`)
            .digest('hex');
    }

    /**
     * Create a new persistent job.
     */
    async createJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const isoNow = now.toISOString();

            const {
                callId,
                jobType,
                pipelineRevision = 1,
                priority = JOB_PRIORITY.NORMAL,
                maxAttempts = this.limits.MAX_ATTEMPTS,
                customId = null,
                initialStatus = JOB_STATUS.QUEUED,
                blockedReasonCode = null,
                blockedReasonMessage = null
            } = params;

            if (!callId || typeof callId !== 'string') {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
                    'callId is required'
                );
            }

            // Reject synthetic job types in production unless explicitly enabled
            if (this.isProduction && !this.enableSyntheticJobTypes && SYNTHETIC_JOB_TYPES.has(jobType)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_TEST_TYPE_NOT_ALLOWED,
                    `Synthetic job type (${jobType}) is prohibited in production`
                );
            }

            // Verify parent call exists if voiceCallRepo is injected
            if (this.voiceCallRepo) {
                const call = this.voiceCallRepo.findById(callId);
                if (!call) {
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.ORPHAN_CALL_NOT_ALLOWED,
                        `Parent VoiceCall record (${callId}) not found`
                    );
                }
            }

            // Check Queue Capacity Limits
            const activeJobs = jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
            if (activeJobs.length >= this.limits.MAX_ACTIVE_JOBS) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_QUEUE_CAPACITY_EXCEEDED,
                    `Queue active job limit reached (${this.limits.MAX_ACTIVE_JOBS})`
                );
            }

            if (jobs.length >= this.limits.MAX_TOTAL_JOBS) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_QUEUE_CAPACITY_EXCEEDED,
                    `Queue total job limit reached (${this.limits.MAX_TOTAL_JOBS})`
                );
            }

            const perCallActive = activeJobs.filter(j => j.callId === callId);
            if (perCallActive.length >= this.limits.MAX_PER_CALL_JOBS) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_QUEUE_CAPACITY_EXCEEDED,
                    `Queue per-call active limit reached (${this.limits.MAX_PER_CALL_JOBS})`
                );
            }

            const perTypeActive = activeJobs.filter(j => j.jobType === jobType);
            if (perTypeActive.length >= this.limits.MAX_PER_TYPE_JOBS) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_QUEUE_CAPACITY_EXCEEDED,
                    `Queue per-type active limit reached (${this.limits.MAX_PER_TYPE_JOBS})`
                );
            }

            // Generate and check Idempotency Key
            const idempotencyKey = this.generateIdempotencyKey(jobType, callId, pipelineRevision);

            const existingSameKey = jobs.filter(j => j.idempotencyKey === idempotencyKey);
            for (const existing of existingSameKey) {
                if (ACTIVE_JOB_STATUSES.includes(existing.status)) {
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.JOB_IDEMPOTENCY_CONFLICT,
                        `Active job already exists for this revision (${jobType}:${callId}:${pipelineRevision})`
                    );
                }
                if (existing.status === JOB_STATUS.COMPLETED) {
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.JOB_ALREADY_COMPLETED,
                        `Job revision has already completed successfully. New revision required.`
                    );
                }
                if (existing.status === JOB_STATUS.FAILED) {
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.JOB_FAILED_REVISION_EXISTS,
                        `Prior job revision failed. Re-run requires an incremented pipelineRevision.`
                    );
                }
            }

            const id = customId || `job_${crypto.randomUUID().replace(/-/g, '')}`;

            const isBlocked = initialStatus === JOB_STATUS.BLOCKED;
            const newJob = {
                id,
                callId,
                jobType,
                status: isBlocked ? JOB_STATUS.BLOCKED : JOB_STATUS.QUEUED,
                idempotencyKey,
                pipelineRevision,
                priority,
                attemptCount: 0,
                maxAttempts,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
                startedAt: null,
                completedAt: null,
                cancelledAt: null,
                failedAt: null,
                lastErrorCode: isBlocked ? (blockedReasonCode || JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED) : null,
                lastErrorMessage: isBlocked ? sanitizeErrorMessage(blockedReasonMessage || 'Initial state blocked') : null,
                resultReference: null,
                createdAt: isoNow,
                updatedAt: isoNow,
                version: 1
            };

            validateJobRecord(newJob, {
                now,
                isProduction: this.isProduction,
                enableSyntheticJobTypes: this.enableSyntheticJobTypes
            });

            jobs.push(newJob);
            await this._saveStore(jobs);

            return deepClone(newJob);
        });
    }

    /**
     * Find job by ID.
     */
    findById(id) {
        const jobs = this._loadStore();
        const found = jobs.find(j => j.id === id);
        return found ? deepClone(found) : null;
    }

    /**
     * Find job by idempotency key.
     */
    findByIdempotencyKey(idempotencyKey) {
        const jobs = this._loadStore();
        const found = jobs.find(j => j.id === idempotencyKey);
        return found ? deepClone(found) : null;
    }

    /**
     * List jobs matching filter criteria.
     */
    list(filter = {}) {
        const jobs = this._loadStore();
        return jobs.filter(j => {
            if (filter.callId && j.callId !== filter.callId) return false;
            if (filter.jobType && j.jobType !== filter.jobType) return false;
            if (filter.status && j.status !== filter.status) return false;
            if (filter.priority && j.priority !== filter.priority) return false;
            return true;
        }).map(deepClone);
    }

    /**
     * Sweep due retry_wait jobs back to queued inside the lock.
     * @private
     */
    _releaseDueRetriesInternal(jobs, now) {
        const nowMs = now.getTime();
        let released = 0;
        for (const job of jobs) {
            if (job.status === JOB_STATUS.RETRY_WAIT) {
                if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() <= nowMs) {
                    transitionJob(job, JOB_STATUS.QUEUED, {
                        nextAttemptAt: null,
                        lastErrorCode: null,
                        lastErrorMessage: null
                    }, now);
                    released++;
                }
            }
        }
        return released;
    }

    /**
     * Sweep expired leases to retry_wait or failed.
     * @private
     */
    _recoverExpiredLeasesInternal(jobs, now) {
        const nowMs = now.getTime();
        let recovered = 0;

        for (const job of jobs) {
            if ([JOB_STATUS.LEASED, JOB_STATUS.PROCESSING].includes(job.status)) {
                if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= nowMs) {
                    if (job.attemptCount < job.maxAttempts) {
                        transitionJob(job, JOB_STATUS.RETRY_WAIT, {
                            nextAttemptAt: now.toISOString(),
                            lastErrorCode: JOB_ERROR_CODES.JOB_LEASE_EXPIRED,
                            lastErrorMessage: 'Lease expired without completion or heartbeat',
                            leaseOwner: null,
                            leaseTokenHash: null,
                            leaseAcquiredAt: null,
                            leaseExpiresAt: null
                        }, now);
                    } else {
                        transitionJob(job, JOB_STATUS.FAILED, {
                            failedAt: now.toISOString(),
                            lastErrorCode: JOB_ERROR_CODES.JOB_MAX_ATTEMPTS_EXCEEDED,
                            lastErrorMessage: 'Max attempts reached upon lease expiration',
                            leaseOwner: null,
                            leaseTokenHash: null,
                            leaseAcquiredAt: null,
                            leaseExpiresAt: null
                        }, now);
                    }
                    recovered++;
                }
            }
        }
        return recovered;
    }

    /**
     * Atomically claim the highest priority available executable queued job.
     * Performs pre-claim blocking for unexecutable jobs without consuming attempts,
     * and continues seeking the next executable candidate.
     */
    async claimNextJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const nowMs = now.getTime();
            const isoNow = now.toISOString();

            const {
                workerId,
                jobTypes = null,
                leaseDurationMs = this.limits.DEFAULT_LEASE_DURATION_MS,
                executionContext = {}
            } = params;

            if (!workerId || typeof workerId !== 'string') {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_LEASE_REQUIRED,
                    'workerId is required to claim next job'
                );
            }

            let storeMutated = false;

            // 1. Recover expired leases first
            const recoveredCount = this._recoverExpiredLeasesInternal(jobs, now);
            if (recoveredCount > 0) storeMutated = true;

            // 2. Release due retries (retry_wait -> queued)
            const releasedCount = this._releaseDueRetriesInternal(jobs, now);
            if (releasedCount > 0) storeMutated = true;

            // 3. Filter queued jobs eligible by type and time
            const eligible = jobs.filter(j => {
                if (j.status !== JOB_STATUS.QUEUED) return false;
                if (Array.isArray(jobTypes) && jobTypes.length > 0 && !jobTypes.includes(j.jobType)) {
                    return false;
                }
                if (j.nextAttemptAt && new Date(j.nextAttemptAt).getTime() > nowMs) {
                    return false;
                }
                return true;
            });

            if (eligible.length === 0) {
                if (storeMutated) {
                    await this._saveStore(jobs);
                }
                return null;
            }

            // 4. Sort by priority DESC (urgent > high > normal), nextAttemptAt ASC, createdAt ASC, id ASC
            eligible.sort((a, b) => {
                const pA = PRIORITY_WEIGHTS[a.priority] || 1;
                const pB = PRIORITY_WEIGHTS[b.priority] || 1;
                if (pB !== pA) return pB - pA;

                const tA = a.nextAttemptAt ? new Date(a.nextAttemptAt).getTime() : 0;
                const tB = b.nextAttemptAt ? new Date(b.nextAttemptAt).getTime() : 0;
                if (tA !== tB) return tA - tB;

                const cA = new Date(a.createdAt).getTime();
                const cB = new Date(b.createdAt).getTime();
                if (cA !== cB) return cA - cB;

                return a.id.localeCompare(b.id);
            });

            // 5. Pre-claim eligibility check loop:
            // If a candidate is blocked (e.g. unconfigured AI), mark as blocked without incrementing attemptCount,
            // and continue loop to inspect the next candidate!
            let claimedJob = null;
            let rawToken = null;

            for (const candidate of eligible) {
                const eligibility = this.isJobExecutable(candidate, executionContext);
                if (!eligibility.executable) {
                    // Pre-claim block: Do NOT increment attemptCount!
                    transitionJob(candidate, JOB_STATUS.BLOCKED, {
                        lastErrorCode: eligibility.blockedCode || JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                        lastErrorMessage: sanitizeErrorMessage(eligibility.blockedMessage || 'Pre-claim prerequisite unmet'),
                        leaseOwner: null,
                        leaseTokenHash: null,
                        leaseAcquiredAt: null,
                        leaseExpiresAt: null
                    }, now);
                    storeMutated = true;
                    // Continue loop to claim next eligible job
                    continue;
                }

                // Found executable job! Claim it.
                claimedJob = candidate;
                claimedJob.attemptCount += 1; // Monotonically incremented ONLY on successful claim

                rawToken = crypto.randomBytes(32).toString('hex');
                const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
                const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();

                transitionJob(claimedJob, JOB_STATUS.LEASED, {
                    leaseOwner: workerId,
                    leaseTokenHash: tokenHash,
                    leaseAcquiredAt: isoNow,
                    leaseExpiresAt,
                    nextAttemptAt: null
                }, now);

                storeMutated = true;
                break;
            }

            if (storeMutated) {
                await this._saveStore(jobs);
            }

            if (!claimedJob) {
                return null;
            }

            return {
                job: deepClone(claimedJob),
                leaseToken: rawToken
            };
        });
    }

    /**
     * Mark a leased job as processing.
     */
    async markProcessing(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId, workerId, leaseToken } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            this._verifyLeaseOwnership(job, workerId, leaseToken, now);

            transitionJob(job, JOB_STATUS.PROCESSING, {
                startedAt: now.toISOString()
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Heartbeat to extend lease during long running execution.
     */
    async heartbeat(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const {
                jobId,
                workerId,
                leaseToken,
                leaseDurationMs = this.limits.DEFAULT_LEASE_DURATION_MS
            } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            this._verifyLeaseOwnership(job, workerId, leaseToken, now);

            // Throttle check
            if (job.heartbeatAt) {
                const elapsed = now.getTime() - new Date(job.heartbeatAt).getTime();
                if (elapsed < this.limits.MIN_HEARTBEAT_INTERVAL_MS) {
                    throw new VoiceCallJobError(
                        JOB_ERROR_CODES.JOB_HEARTBEAT_TOO_FREQUENT,
                        `Heartbeat invoked too quickly (${elapsed}ms < ${this.limits.MIN_HEARTBEAT_INTERVAL_MS}ms)`
                    );
                }
            }

            const newExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

            job.heartbeatAt = now.toISOString();
            job.leaseExpiresAt = newExpiresAt;
            job.version += 1;
            job.updatedAt = now.toISOString();

            validateJobRecord(job, {
                now,
                isProduction: this.isProduction,
                enableSyntheticJobTypes: this.enableSyntheticJobTypes
            });

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Complete job execution with safe result reference.
     */
    async completeJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId, workerId, leaseToken, resultReference = null } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            this._verifyLeaseOwnership(job, workerId, leaseToken, now);

            if (!isSafeResultReference(resultReference)) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_PAYLOAD_INVALID,
                    'resultReference contains invalid, unapproved, or sensitive fields'
                );
            }

            transitionJob(job, JOB_STATUS.COMPLETED, {
                completedAt: now.toISOString(),
                resultReference: resultReference ? deepClone(resultReference) : null,
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Schedule a retry for a failed attempt.
     */
    async scheduleRetry(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const {
                jobId,
                workerId,
                leaseToken,
                errorCode,
                errorMessage,
                nextAttemptAt
            } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            this._verifyLeaseOwnership(job, workerId, leaseToken, now);

            // Off-by-one check: If attemptCount reached or exceeded maxAttempts, transition to failed
            if (job.attemptCount >= job.maxAttempts) {
                transitionJob(job, JOB_STATUS.FAILED, {
                    failedAt: now.toISOString(),
                    lastErrorCode: JOB_ERROR_CODES.JOB_MAX_ATTEMPTS_EXCEEDED,
                    lastErrorMessage: sanitizeErrorMessage(errorMessage || 'Max attempts exceeded'),
                    leaseOwner: null,
                    leaseTokenHash: null,
                    leaseAcquiredAt: null,
                    leaseExpiresAt: null
                }, now);
            } else {
                const targetIso = nextAttemptAt instanceof Date
                    ? nextAttemptAt.toISOString()
                    : (typeof nextAttemptAt === 'string' ? nextAttemptAt : now.toISOString());

                transitionJob(job, JOB_STATUS.RETRY_WAIT, {
                    nextAttemptAt: targetIso,
                    lastErrorCode: errorCode || 'JOB_EXECUTION_FAILED',
                    lastErrorMessage: sanitizeErrorMessage(errorMessage),
                    leaseOwner: null,
                    leaseTokenHash: null,
                    leaseAcquiredAt: null,
                    leaseExpiresAt: null
                }, now);
            }

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Mark a job as definitively failed.
     */
    async failJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId, workerId = null, leaseToken = null, errorCode, errorMessage } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            if (job.leaseOwner && job.leaseTokenHash) {
                this._verifyLeaseOwnership(job, workerId, leaseToken, now);
            }

            transitionJob(job, JOB_STATUS.FAILED, {
                failedAt: now.toISOString(),
                lastErrorCode: errorCode || 'JOB_FAILED',
                lastErrorMessage: sanitizeErrorMessage(errorMessage),
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Cancel an active job.
     */
    async cancelJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId, workerId = null, leaseToken = null, reasonCode, reasonMessage } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            if ([JOB_STATUS.LEASED, JOB_STATUS.PROCESSING].includes(job.status)) {
                this._verifyLeaseOwnership(job, workerId, leaseToken, now);
            }

            transitionJob(job, JOB_STATUS.CANCELLED, {
                cancelledAt: now.toISOString(),
                lastErrorCode: reasonCode || 'JOB_CANCELLED_BY_OPERATOR',
                lastErrorMessage: sanitizeErrorMessage(reasonMessage),
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Block a job due to missing prerequisite.
     * Note: attemptCount is NEVER decremented (strict immutability).
     */
    async blockJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId, workerId = null, leaseToken = null, reasonCode, reasonMessage } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            if ([JOB_STATUS.LEASED, JOB_STATUS.PROCESSING].includes(job.status)) {
                this._verifyLeaseOwnership(job, workerId, leaseToken, now);
            }

            // attemptCount is NOT decremented. Immutability strictly preserved.
            transitionJob(job, JOB_STATUS.BLOCKED, {
                lastErrorCode: reasonCode || JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                lastErrorMessage: sanitizeErrorMessage(reasonMessage || 'Prerequisite blocked'),
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Unblock a blocked job back to queued when prerequisites are satisfied.
     * Preserves attemptCount and idempotencyKey without decrementing or clearing attempts.
     */
    async unblockJob(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();
            const { jobId } = params;

            const job = jobs.find(j => j.id === jobId);
            if (!job) {
                throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_NOT_FOUND, `Job ${jobId} not found`);
            }

            if (job.status !== JOB_STATUS.BLOCKED) {
                throw new VoiceCallJobError(
                    JOB_ERROR_CODES.JOB_INVALID_STATE_TRANSITION,
                    `Only blocked jobs can be unblocked (current: ${job.status})`
                );
            }

            transitionJob(job, JOB_STATUS.QUEUED, {
                lastErrorCode: null,
                lastErrorMessage: null,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseTokenHash: null,
                leaseAcquiredAt: null,
                leaseExpiresAt: null
            }, now);

            await this._saveStore(jobs);
            return deepClone(job);
        });
    }

    /**
     * Explicit public recovery method for expired leases.
     */
    async recoverExpiredLeases(params = {}) {
        return withFileLock(this.lockKey, async () => {
            const jobs = this._loadStore();
            const now = params.now instanceof Date && !Number.isNaN(params.now.getTime())
                ? params.now
                : new Date();

            const recoveredCount = this._recoverExpiredLeasesInternal(jobs, now);
            if (recoveredCount > 0) {
                await this._saveStore(jobs);
            }
            return { recoveredCount };
        });
    }

    /**
     * Count jobs grouped by status.
     */
    countByStatus() {
        const jobs = this._loadStore();
        const counts = {};
        for (const s of Object.values(JOB_STATUS)) {
            counts[s] = 0;
        }
        for (const j of jobs) {
            counts[j.status] = (counts[j.status] || 0) + 1;
        }
        return counts;
    }

    /**
     * Validate store integrity.
     */
    validateStore() {
        try {
            const jobs = this._loadStore();
            const errors = [];
            for (const job of jobs) {
                try {
                    validateJobRecord(job, {
                        isProduction: this.isProduction,
                        enableSyntheticJobTypes: this.enableSyntheticJobTypes
                    });
                } catch (e) {
                    errors.push({ id: job.id, error: e.message });
                }
            }
            return { valid: errors.length === 0, count: jobs.length, errors };
        } catch (e) {
            return { valid: false, count: 0, errors: [e.message] };
        }
    }
}

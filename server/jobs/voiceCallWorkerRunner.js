/**
 * server/jobs/voiceCallWorkerRunner.js
 * Worker Runner and Execution Contract for Persistent Job Queue.
 * Mind-ERP OS Track A8 Final Integrity Closure.
 * 
 * Implements:
 * - Handler Timeout with AbortSignal
 * - Generation Guard against Late Handler Completion / Rejection
 * - Execution Context Pass-through for Pre-claim Eligibility
 * - Graceful Shutdown with Abort Propagation
 */

import crypto from 'crypto';
import {
    JOB_ERROR_CODES,
    ERROR_CLASSIFICATION,
    JOB_TYPES,
    DEFAULT_JOB_LIMITS
} from './voiceCallJobConstants.js';
import { VoiceCallJobError } from './voiceCallJobErrors.js';
import { validateQueueConfig } from './voiceCallJobValidator.js';
import { classifyError, computeRetryDelay } from './retryBackoffPolicy.js';

export class VoiceCallWorkerRunner {
    /**
     * @param {Object} params
     * @param {import('./voiceCallJobRepository.js').VoiceCallJobRepository} params.repository
     * @param {string} [params.workerId]
     * @param {string[]} [params.jobTypes]
     * @param {number} [params.pollIntervalMs]
     * @param {number} [params.leaseDurationMs]
     * @param {number} [params.handlerTimeoutMs]
     * @param {number} [params.shutdownGraceMs]
     * @param {Function} [params.randomFn]
     * @param {Object} [params.executionContext] - { aiEnabled, sttConfigured, llmConfigured, ... }
     */
    constructor(params = {}) {
        if (!params.repository) {
            throw new Error('repository is required for VoiceCallWorkerRunner');
        }
        this.repository = params.repository;
        this.workerId = params.workerId || `worker_${crypto.randomBytes(8).toString('hex')}`;
        this.jobTypes = params.jobTypes || null;
        this.pollIntervalMs = params.pollIntervalMs || 1000;
        this.leaseDurationMs = params.leaseDurationMs || this.repository.limits.DEFAULT_LEASE_DURATION_MS || DEFAULT_JOB_LIMITS.DEFAULT_LEASE_DURATION_MS;
        this.handlerTimeoutMs = params.handlerTimeoutMs || this.repository.limits.HANDLER_TIMEOUT_MS || DEFAULT_JOB_LIMITS.HANDLER_TIMEOUT_MS;
        this.shutdownGraceMs = params.shutdownGraceMs || this.repository.limits.SHUTDOWN_GRACE_MS || DEFAULT_JOB_LIMITS.SHUTDOWN_GRACE_MS;
        this.randomFn = typeof params.randomFn === 'function' ? params.randomFn : Math.random;

        // Execution Context (AI Provider configuration flags)
        this.executionContext = {
            isProduction: this.repository.isProduction,
            enableSyntheticJobTypes: this.repository.enableSyntheticJobTypes,
            aiEnabled: false,
            sttConfigured: false,
            llmConfigured: false,
            decodeProviderConfigured: true,
            ...(params.executionContext || {})
        };

        // Validate runner config
        validateQueueConfig({
            leaseDurationMs: this.leaseDurationMs,
            handlerTimeoutMs: this.handlerTimeoutMs,
            shutdownGraceMs: this.shutdownGraceMs
        });

        this.handlers = new Map();
        this.isRunning = false;
        this.isStopping = false;
        this.pollTimer = null;
        this.activeExecution = null;
        this.activeAbortController = null;
        this.currentInvocationId = null;

        // Register default handlers
        if (!this.repository.isProduction || this.repository.enableSyntheticJobTypes) {
            this.registerHandler(JOB_TYPES.SYNTHETIC_NOOP, async () => {
                return { resultReference: { safeResultCode: 'SYNTHETIC_NOOP_SUCCESS' } };
            });
        }

        this.registerHandler(JOB_TYPES.STT_TRANSCRIPTION, async () => {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                'STT Provider is unconfigured in Track A8'
            );
        });

        this.registerHandler(JOB_TYPES.LLM_CLASSIFICATION, async () => {
            throw new VoiceCallJobError(
                JOB_ERROR_CODES.AI_SERVICE_UNCONFIGURED,
                'LLM Provider is unconfigured in Track A8'
            );
        });
    }

    /**
     * Register a worker handler for a specific jobType.
     * @param {string} jobType
     * @param {Function} handlerFn - async ({ job, signal, context }) => ({ resultReference })
     */
    registerHandler(jobType, handlerFn) {
        if (typeof handlerFn !== 'function') {
            throw new Error(`Handler for ${jobType} must be a function`);
        }
        this.handlers.set(jobType, handlerFn);
    }

    /**
     * Run a single iteration: Claim -> MarkProcessing -> Execute with Timeout -> Complete/Fail/Retry.
     * Includes late completion protection via invocation generation guard.
     * 
     * @param {Object} [options={}]
     * @param {Date} [options.now]
     * @returns {Promise<Object>} Execution report
     */
    async runOnce(options = {}) {
        if (this.isStopping) {
            return { handled: false, reason: 'STOPPING' };
        }

        const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
            ? options.now
            : new Date();

        // 1. Atomically claim next executable job (pre-claim blocking executed internally)
        const claim = await this.repository.claimNextJob({
            workerId: this.workerId,
            jobTypes: this.jobTypes,
            now,
            leaseDurationMs: this.leaseDurationMs,
            executionContext: this.executionContext
        });

        if (!claim) {
            return { handled: false, reason: 'NO_JOB_AVAILABLE' };
        }

        const { job, leaseToken } = claim;

        // 2. Transition to processing
        await this.repository.markProcessing({
            jobId: job.id,
            workerId: this.workerId,
            leaseToken,
            now
        });

        // 3. Locate handler
        const handler = this.handlers.get(job.jobType);
        if (!handler) {
            await this.repository.failJob({
                jobId: job.id,
                workerId: this.workerId,
                leaseToken,
                errorCode: JOB_ERROR_CODES.UNSUPPORTED_JOB_HANDLER,
                errorMessage: `No handler registered for jobType: ${job.jobType}`,
                now
            });
            return {
                handled: true,
                jobId: job.id,
                outcome: 'FAILED',
                errorCode: JOB_ERROR_CODES.UNSUPPORTED_JOB_HANDLER
            };
        }

        // 4. Setup Invocation Context with Timeout & AbortController
        const invocationId = crypto.randomUUID();
        this.currentInvocationId = invocationId;
        const abortController = new AbortController();
        this.activeAbortController = abortController;

        const context = {
            signal: abortController.signal,
            executionContext: this.executionContext,
            heartbeat: async (opts = {}) => {
                // Heartbeat guard: reject if timed out or invocation mismatch
                if (this.currentInvocationId !== invocationId || abortController.signal.aborted) {
                    throw new VoiceCallJobError(JOB_ERROR_CODES.JOB_LEASE_EXPIRED, 'Heartbeat rejected: invocation has timed out or aborted');
                }
                return this.repository.heartbeat({
                    jobId: job.id,
                    workerId: this.workerId,
                    leaseToken,
                    leaseDurationMs: this.leaseDurationMs,
                    ...opts
                });
            }
        };

        let isTimedOut = false;
        let isExecutionFinished = false;

        const timeoutPromise = new Promise((_, reject) => {
            const timer = setTimeout(() => {
                if (isExecutionFinished) return;
                isTimedOut = true;
                abortController.abort(new VoiceCallJobError(JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT, `Handler timed out after ${this.handlerTimeoutMs}ms`));
                reject(new VoiceCallJobError(JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT, `Handler timed out after ${this.handlerTimeoutMs}ms`));
            }, this.handlerTimeoutMs);

            // Ensure timer cleanup
            abortController.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        });

        // Handler Isolation: Provide only minimal immutable safe view of job.
        // Handler receives NO repository instance, NO leaseToken, and NO mutation methods.
        const safeHandlerJobView = Object.freeze({
            id: job.id,
            callId: job.callId,
            jobType: job.jobType,
            pipelineRevision: job.pipelineRevision,
            attemptCount: job.attemptCount,
            priority: job.priority
        });

        try {
            const executionPromise = handler({
                job: safeHandlerJobView,
                signal: abortController.signal,
                context
            });
            this.activeExecution = executionPromise;

            // Race handler execution against timeout
            const result = await Promise.race([executionPromise, timeoutPromise]);
            isExecutionFinished = true;

            // Late Completion Guard: if timeout already occurred, discard resolution
            if (isTimedOut || this.currentInvocationId !== invocationId) {
                return {
                    handled: true,
                    jobId: job.id,
                    outcome: 'TIMED_OUT',
                    errorCode: JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT
                };
            }

            // 5. Complete job
            await this.repository.completeJob({
                jobId: job.id,
                workerId: this.workerId,
                leaseToken,
                resultReference: result?.resultReference || null,
                now
            });

            return {
                handled: true,
                jobId: job.id,
                outcome: 'COMPLETED',
                resultReference: result?.resultReference || null
            };
        } catch (err) {
            isExecutionFinished = true;

            // Invalidate invocation guard to neutralize late completions
            this.currentInvocationId = null;

            const isTimeoutError = isTimedOut || err?.code === JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT || abortController.signal.aborted;
            const errorCode = isTimeoutError ? JOB_ERROR_CODES.JOB_HANDLER_TIMEOUT : (err?.code || 'JOB_EXECUTION_EXCEPTION');
            const classification = classifyError(errorCode);

            if (classification === ERROR_CLASSIFICATION.BLOCKED) {
                await this.repository.blockJob({
                    jobId: job.id,
                    workerId: this.workerId,
                    leaseToken,
                    reasonCode: errorCode,
                    reasonMessage: err.message,
                    now
                });
                return {
                    handled: true,
                    jobId: job.id,
                    outcome: 'BLOCKED',
                    errorCode
                };
            }

            if (classification === ERROR_CLASSIFICATION.RETRYABLE && job.attemptCount < job.maxAttempts) {
                const { nextAttemptAt } = computeRetryDelay({
                    attemptCount: job.attemptCount,
                    randomFn: this.randomFn,
                    now
                });

                await this.repository.scheduleRetry({
                    jobId: job.id,
                    workerId: this.workerId,
                    leaseToken,
                    errorCode,
                    errorMessage: err.message,
                    nextAttemptAt,
                    now
                });

                return {
                    handled: true,
                    jobId: job.id,
                    outcome: 'RETRY_SCHEDULED',
                    errorCode,
                    nextAttemptAt: nextAttemptAt.toISOString()
                };
            }

            // Non-retryable or max attempts exhausted
            await this.repository.failJob({
                jobId: job.id,
                workerId: this.workerId,
                leaseToken,
                errorCode: errorCode,
                errorMessage: err.message,
                now
            });

            return {
                handled: true,
                jobId: job.id,
                outcome: 'FAILED',
                errorCode
            };
        } finally {
            this.activeExecution = null;
            this.activeAbortController = null;
        }
    }

    /**
     * Start continuous polling loop.
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isStopping = false;

        const loop = async () => {
            if (!this.isRunning || this.isStopping) return;
            try {
                await this.runOnce();
            } catch (err) {
                console.error(`[WORKER ${this.workerId}] Uncaught error during runOnce:`, err.message);
            }

            if (this.isRunning && !this.isStopping) {
                this.pollTimer = setTimeout(loop, this.pollIntervalMs);
            }
        };

        this.pollTimer = setTimeout(loop, 10);
    }

    /**
     * Stop polling immediately.
     */
    stop() {
        this.isRunning = false;
        this.isStopping = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.activeAbortController) {
            this.activeAbortController.abort();
        }
        this.currentInvocationId = null;
    }

    /**
     * Gracefully shutdown worker with grace period timeout.
     */
    async gracefulShutdown(gracePeriodMs = null) {
        const timeoutMs = gracePeriodMs !== null ? gracePeriodMs : this.shutdownGraceMs;
        this.isStopping = true;
        this.isRunning = false;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.activeExecution) {
            const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
            await Promise.race([this.activeExecution, timeoutPromise]);
            if (this.activeAbortController) {
                this.activeAbortController.abort();
            }
        }
        this.currentInvocationId = null;
    }

    /**
     * Get diagnostic status of worker.
     */
    getStatus() {
        return {
            workerId: this.workerId,
            isRunning: this.isRunning,
            isStopping: this.isStopping,
            hasActiveExecution: this.activeExecution !== null,
            jobTypes: this.jobTypes,
            pollIntervalMs: this.pollIntervalMs,
            handlerTimeoutMs: this.handlerTimeoutMs,
            shutdownGraceMs: this.shutdownGraceMs
        };
    }
}

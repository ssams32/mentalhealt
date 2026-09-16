/**
 * agent/joycall-sync/joyCallSyncAgent.js
 * Near-real-time synchronization agent for JoyCall recordings.
 * Strictly preserves local files and directories without modification or deletion.
 * Enforces single-instance guard and collision handling.
 */

import path from 'path';
import fs from 'fs';
import { JoyCallFileDetector } from './joyCallFileDetector.js';
import { JoyCallFileStability } from './joyCallFileStability.js';
import { JoyCallTransferManifest } from './joyCallTransferManifest.js';
import { JoyCallNasTransfer } from './joyCallNasTransfer.js';
import { JoyCallSyncMetrics } from './joyCallSyncMetrics.js';
import { JoyCallSingleInstanceGuard } from './joyCallSingleInstanceGuard.js';
import { JOYCALL_SYNC_DEFAULTS, TRANSFER_STATUS } from './joyCallSyncConstants.js';

export class JoyCallSyncAgent {
    constructor(options = {}) {
        this.sourceDir = options.sourceDir;
        this.nasIncomingDir = options.nasIncomingDir;
        this.pollIntervalMs = options.pollIntervalMs || JOYCALL_SYNC_DEFAULTS.POLL_INTERVAL_MS;

        this.detector = new JoyCallFileDetector(options);
        this.stability = new JoyCallFileStability(options);
        this.manifest = new JoyCallTransferManifest(options.manifestFilePath);
        this.transfer = new JoyCallNasTransfer({
            nasIncomingDir: this.nasIncomingDir,
            maxRetries: options.maxRetries,
            retryBackoffMs: options.retryBackoffMs
        });
        this.metrics = new JoyCallSyncMetrics();
        this.singleInstanceGuard = new JoyCallSingleInstanceGuard({
            stateDir: options.stateDir,
            lockFilename: options.lockFilename
        });

        this.isRunning = false;
        this.pollTimer = null;
    }

    /**
     * Perform a single pass of reconciliation/detection and transfer.
     * @param {number} [customNowMs] Optional timestamp override for deterministic testing
     */
    async syncOnce(customNowMs = null) {
        if (!this.sourceDir || !fs.existsSync(this.sourceDir)) {
            return { error: 'SOURCE_DIRECTORY_UNAVAILABLE', processed: 0 };
        }

        const candidateFiles = this.detector.scanDirectory(this.sourceDir);
        const results = [];

        for (const filename of candidateFiles) {
            this.metrics.recordDetected();
            const filePath = path.join(this.sourceDir, filename);

            // 1. Check stability
            const stabilityResult = await this.stability.checkStability(filePath, customNowMs);
            if (!stabilityResult.isStable) {
                results.push({
                    filename,
                    status: 'SKIPPED_UNSTABLE',
                    reason: stabilityResult.reason
                });
                continue;
            }

            this.metrics.recordStabilized();

            // 2. Check manifest for duplicate hash
            if (this.manifest.hasCompletedHash(stabilityResult.sha256)) {
                this.metrics.recordDuplicateSkipped();
                results.push({
                    filename,
                    status: 'SKIPPED_DUPLICATE_HASH',
                    sha256: stabilityResult.sha256
                });
                continue;
            }

            // 3. Mark in-progress to prevent concurrent race
            this.stability.markInProgress(filePath);

            try {
                // Transfer to NAS
                const transferResult = await this.transfer.transferFile(filePath, {
                    filename,
                    size: stabilityResult.size,
                    sha256: stabilityResult.sha256
                });

                if (transferResult.status === TRANSFER_STATUS.SKIPPED_DUPLICATE) {
                    this.metrics.recordDuplicateSkipped();
                    this.manifest.recordSuccess({
                        filename,
                        sha256: stabilityResult.sha256,
                        sizeBytes: stabilityResult.size,
                        destinationFilename: path.basename(transferResult.destinationPath),
                        status: TRANSFER_STATUS.SKIPPED_DUPLICATE
                    });
                    results.push({
                        filename,
                        status: 'SKIPPED_DUPLICATE_NAS',
                        sha256: stabilityResult.sha256
                    });
                } else if (transferResult.status === TRANSFER_STATUS.RESUMED_AND_FINALIZED) {
                    this.metrics.recordTransferred(stabilityResult.size);
                    this.manifest.recordSuccess({
                        filename,
                        sha256: stabilityResult.sha256,
                        sizeBytes: stabilityResult.size,
                        destinationFilename: path.basename(transferResult.destinationPath),
                        status: TRANSFER_STATUS.RESUMED_AND_FINALIZED
                    });
                    results.push({
                        filename,
                        status: 'RESUMED_AND_FINALIZED',
                        destinationPath: transferResult.destinationPath,
                        sha256: stabilityResult.sha256
                    });
                } else {
                    this.metrics.recordTransferred(stabilityResult.size);
                    this.manifest.recordSuccess({
                        filename,
                        sha256: stabilityResult.sha256,
                        sizeBytes: stabilityResult.size,
                        destinationFilename: path.basename(transferResult.destinationPath),
                        status: TRANSFER_STATUS.COMPLETED
                    });
                    results.push({
                        filename,
                        status: 'TRANSFERRED',
                        destinationPath: transferResult.destinationPath,
                        sha256: stabilityResult.sha256,
                        size: stabilityResult.size
                    });
                }
            } catch (err) {
                this.metrics.recordError();
                this.manifest.recordFailure({
                    filename,
                    sha256: stabilityResult.sha256,
                    sizeBytes: stabilityResult.size
                }, err.message, err.code);

                results.push({
                    filename,
                    status: err.code || 'TRANSFER_FAILED',
                    error: err.message
                });
            } finally {
                this.stability.clearInProgress(filePath);
            }
        }

        return {
            processed: candidateFiles.length,
            results,
            metrics: this.metrics.getSnapshot()
        };
    }

    /**
     * Start continuous background monitoring with single-instance lock.
     */
    start() {
        if (this.isRunning) return;
        this.singleInstanceGuard.acquire();
        this.isRunning = true;

        const loop = async () => {
            if (!this.isRunning) return;
            try {
                await this.syncOnce();
            } catch {
                // Continue loop on cycle error
            }
            if (this.isRunning) {
                this.pollTimer = setTimeout(loop, this.pollIntervalMs);
            }
        };

        this.pollTimer = setTimeout(loop, 100);
    }

    /**
     * Gracefully stop the agent and release single-instance lock.
     */
    async stop() {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.singleInstanceGuard.release();
    }
}

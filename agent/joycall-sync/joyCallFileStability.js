/**
 * agent/joycall-sync/joyCallFileStability.js
 * Verifies that candidate recording files are completely written, quiet, and valid audio.
 * Never modifies local files or databases.
 */

import fs from 'fs';
import crypto from 'crypto';
import { detectAudioSignature } from '../../server/audio-intake/audioSignatureDetector.js';
import { JOYCALL_SYNC_DEFAULTS } from './joyCallSyncConstants.js';
import { JoyCallSyncError, JOYCALL_SYNC_ERROR_CODES } from './joyCallSyncErrors.js';

export class JoyCallFileStability {
    constructor(options = {}) {
        this.stabilityChecksRequired = options.stabilityChecksRequired || JOYCALL_SYNC_DEFAULTS.STABILITY_CHECKS_REQUIRED;
        this.quietPeriodMs = options.quietPeriodMs ?? JOYCALL_SYNC_DEFAULTS.QUIET_PERIOD_MS;
        this.minFileBytes = options.minFileBytes || 1024;
        // In-memory state tracking { [filePath]: { lastSize, stableChecks, lastMtimeMs, lastSampleHash } }
        this.fileStates = new Map();
        // Set of file paths currently being processed
        this.inProgressFiles = new Set();
    }

    /**
     * Mark a file as currently in-progress to prevent concurrent transfer attempts.
     */
    markInProgress(filePath) {
        this.inProgressFiles.add(filePath);
    }

    /**
     * Clear in-progress flag once transfer concludes or fails.
     */
    clearInProgress(filePath) {
        this.inProgressFiles.delete(filePath);
    }

    /**
     * Compute SHA-256 of file non-destructively.
     */
    async computeSha256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            let stream = null;
            try {
                stream = fs.createReadStream(filePath);
            } catch (err) {
                return reject(new JoyCallSyncError(JOYCALL_SYNC_ERROR_CODES.FILE_READ_FAILED, err.message));
            }
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(new JoyCallSyncError(JOYCALL_SYNC_ERROR_CODES.FILE_READ_FAILED, err.message)));
        });
    }

    /**
     * Sample first 512 bytes non-destructively and check signature.
     */
    validateAudioSignature(filePath) {
        let fd = null;
        try {
            fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(512);
            const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
            if (bytesRead < 44) {
                return { valid: false, reason: 'File too small for valid audio header' };
            }
            const signature = detectAudioSignature(buffer.subarray(0, bytesRead));
            if (!signature || !signature.detected || signature.isDangerous) {
                return { valid: false, reason: signature?.reason || 'Invalid audio signature' };
            }
            // Quick sample hash for content change detection
            const sampleHash = crypto.createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
            return { valid: true, format: signature.format, sampleHash };
        } catch (err) {
            return { valid: false, reason: err.message, errorCode: err.code };
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
        }
    }

    /**
     * Check stability of a file across multiple samples and quiet periods.
     * @param {string} filePath 
     * @param {number} [customNowMs] 
     * @returns {Promise<{ isStable: boolean, reason?: string, size?: number, sha256?: string, format?: string }>}
     */
    async checkStability(filePath, customNowMs = null) {
        // 1. In-progress guard
        if (this.inProgressFiles.has(filePath)) {
            return { isStable: false, reason: 'File transfer currently in progress' };
        }

        // 2. Existence and disappearance check
        if (!fs.existsSync(filePath)) {
            this.fileStates.delete(filePath);
            return { isStable: false, reason: 'File does not exist or disappeared' };
        }

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            return { isStable: false, reason: `Stat failed: ${err.message}`, errorCode: err.code };
        }

        // 3. Zero-byte check
        if (stat.size === 0) {
            return { isStable: false, reason: 'Zero-byte file' };
        }

        // 4. Minimum file bytes check
        if (stat.size < this.minFileBytes) {
            return { isStable: false, reason: `File smaller than minimum allowed bytes (${stat.size} < ${this.minFileBytes})` };
        }

        // 5. Quiet period check
        const now = customNowMs ?? Date.now();
        const ageMs = now - stat.mtimeMs;
        if (this.quietPeriodMs > 0 && ageMs < this.quietPeriodMs) {
            return {
                isStable: false,
                reason: `File modified too recently (${Math.round(ageMs)}ms ago < required ${this.quietPeriodMs}ms quiet period)`
            };
        }

        // 6. Signature & Readability check
        const sig = this.validateAudioSignature(filePath);
        if (!sig.valid) {
            if (sig.errorCode === 'EACCES' || sig.errorCode === 'EPERM') {
                return { isStable: false, reason: `Permission denied reading file: ${sig.reason}`, errorCode: sig.errorCode };
            }
            return { isStable: false, reason: `Audio signature invalid: ${sig.reason}` };
        }

        // 7. Sample consecutive checks (size, mtime, and sample content)
        const prev = this.fileStates.get(filePath) || {
            lastSize: -1,
            stableChecks: 0,
            lastMtimeMs: 0,
            lastSampleHash: null
        };

        const isSizeSame = (stat.size === prev.lastSize);
        const isMtimeSame = (stat.mtimeMs === prev.lastMtimeMs);
        const isContentSame = (sig.sampleHash === prev.lastSampleHash);

        if (isSizeSame && isMtimeSame && isContentSame) {
            prev.stableChecks += 1;
        } else {
            prev.lastSize = stat.size;
            prev.lastMtimeMs = stat.mtimeMs;
            prev.lastSampleHash = sig.sampleHash;
            prev.stableChecks = 1;
        }
        this.fileStates.set(filePath, prev);

        if (prev.stableChecks < this.stabilityChecksRequired) {
            return {
                isStable: false,
                reason: `File stability check in progress (${prev.stableChecks}/${this.stabilityChecksRequired})`
            };
        }

        // 8. Full SHA-256 computation non-destructively
        let sha256;
        try {
            sha256 = await this.computeSha256(filePath);
        } catch (err) {
            return { isStable: false, reason: `Failed to compute hash: ${err.message}` };
        }

        return {
            isStable: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256,
            format: sig.format
        };
    }

    resetState(filePath) {
        if (filePath) this.fileStates.delete(filePath);
        else this.fileStates.clear();
    }
}

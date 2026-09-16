/**
 * agent/joycall-sync/joyCallNasTransfer.js
 * Safely transfers audio files to NAS incoming directory.
 * Writes to .uploading temporary suffix, verifies byte count and SHA-256, then atomically renames.
 * Strictly adheres to collision policies A, B, C, D, E and interrupted transfer recovery.
 * NEVER deletes or alters the local source file.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JoyCallSyncError, JOYCALL_SYNC_ERROR_CODES } from './joyCallSyncErrors.js';
import { JOYCALL_SYNC_DEFAULTS, TRANSFER_STATUS } from './joyCallSyncConstants.js';

export class JoyCallNasTransfer {
    constructor(options = {}) {
        this.nasIncomingDir = options.nasIncomingDir;
        this.maxRetries = options.maxRetries ?? JOYCALL_SYNC_DEFAULTS.MAX_RETRIES;
        this.retryBackoffMs = options.retryBackoffMs ?? JOYCALL_SYNC_DEFAULTS.RETRY_BACKOFF_MS;
        this.uploadingSuffix = options.uploadingSuffix || JOYCALL_SYNC_DEFAULTS.UPLOADING_SUFFIX;
    }

    /**
     * Compute SHA-256 of file.
     */
    async _computeSha256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            let stream = null;
            try {
                stream = fs.createReadStream(filePath);
            } catch (err) {
                return reject(err);
            }
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(err));
        });
    }

    /**
     * Copy file using stream with fsync flush.
     */
    async _copyStream(srcPath, destPath) {
        return new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(srcPath);
            const writeStream = fs.createWriteStream(destPath, { flags: 'w' });

            readStream.on('error', (err) => {
                try { writeStream.destroy(); } catch { /* ignore */ }
                reject(err);
            });

            writeStream.on('error', reject);

            writeStream.on('finish', () => {
                // Perform fsync if underlying descriptor is available
                try {
                    if (typeof writeStream.fd === 'number') {
                        fs.fsyncSync(writeStream.fd);
                    }
                } catch {
                    // fsync may not be supported on all network shares; continue safely
                }
                resolve();
            });

            readStream.pipe(writeStream);
        });
    }

    /**
     * Transfer file to NAS with collision handling, verification and atomic rename.
     * @param {string} sourceFilePath 
     * @param {Object} fileInfo { filename, size, sha256 }
     */
    async transferFile(sourceFilePath, fileInfo) {
        if (!this.nasIncomingDir || !fs.existsSync(this.nasIncomingDir)) {
            throw new JoyCallSyncError(
                JOYCALL_SYNC_ERROR_CODES.DESTINATION_UNAVAILABLE,
                'NAS incoming directory does not exist or is unavailable'
            );
        }

        const baseName = path.basename(sourceFilePath);
        const tempName = `${baseName}${this.uploadingSuffix}`;
        const tempDestPath = path.join(this.nasIncomingDir, tempName);
        const finalDestPath = path.join(this.nasIncomingDir, baseName);

        // =========================================================
        // COLLISION CHECK 1: FINAL DESTINATION EXISTS
        // =========================================================
        if (fs.existsSync(finalDestPath)) {
            const existingHash = await this._computeSha256(finalDestPath);
            if (existingHash === fileInfo.sha256) {
                // CASE B: Final filename exists and hash is identical
                return {
                    status: TRANSFER_STATUS.SKIPPED_DUPLICATE,
                    destinationPath: finalDestPath,
                    size: fileInfo.size,
                    sha256: fileInfo.sha256
                };
            } else {
                // CASE C: Final filename exists and hash differs
                // STRICT RULE: Do not overwrite, set FILENAME_COLLISION, preserve both, require operator review
                throw new JoyCallSyncError(
                    JOYCALL_SYNC_ERROR_CODES.FILENAME_COLLISION,
                    `Destination file already exists with differing SHA-256 hash: ${baseName}`,
                    {
                        filename: baseName,
                        existingHash,
                        sourceHash: fileInfo.sha256
                    }
                );
            }
        }

        // =========================================================
        // COLLISION CHECK 2: .uploading FILE ALREADY EXISTS
        // =========================================================
        if (fs.existsSync(tempDestPath)) {
            let tempStat = null;
            let tempHash = null;
            try {
                tempStat = fs.statSync(tempDestPath);
                tempHash = await this._computeSha256(tempDestPath);
            } catch {
                tempStat = null;
                tempHash = null;
            }

            if (tempStat && tempStat.size === fileInfo.size && tempHash === fileInfo.sha256) {
                // CASE D: .uploading exists and matches source size and hash
                // Interrupted transfer recovery: verify fully and finalize atomic rename!
                fs.renameSync(tempDestPath, finalDestPath);
                return {
                    status: TRANSFER_STATUS.RESUMED_AND_FINALIZED,
                    destinationPath: finalDestPath,
                    size: fileInfo.size,
                    sha256: fileInfo.sha256,
                    recoveredFromUploading: true
                };
            } else {
                // CASE E: .uploading exists but differs from source
                // STRICT RULE: Do not overwrite silently; preserve conflict artifact
                const conflictName = `${tempName}.conflict.${Date.now()}`;
                const conflictPath = path.join(this.nasIncomingDir, conflictName);
                try {
                    fs.renameSync(tempDestPath, conflictPath);
                } catch { /* ignore */ }

                throw new JoyCallSyncError(
                    JOYCALL_SYNC_ERROR_CODES.UPLOADING_CONFLICT,
                    `Pre-existing .uploading file differs from source; moved to conflict preservation: ${conflictName}`,
                    {
                        filename: baseName,
                        conflictPath
                    }
                );
            }
        }

        // =========================================================
        // CASE A: NORMAL TRANSFER WITH RETRY AND ATOMIC RENAME
        // =========================================================
        let attempt = 0;
        let lastError = null;

        while (attempt < this.maxRetries) {
            attempt++;
            try {
                // 1. Copy stream to .uploading
                await this._copyStream(sourceFilePath, tempDestPath);

                // 2. Verify destination size
                const destStat = fs.statSync(tempDestPath);
                if (destStat.size !== fileInfo.size) {
                    throw new JoyCallSyncError(
                        JOYCALL_SYNC_ERROR_CODES.SIZE_MISMATCH,
                        `Destination file size (${destStat.size}) does not match source (${fileInfo.size})`
                    );
                }

                // 3. Verify destination SHA-256
                const destHash = await this._computeSha256(tempDestPath);
                if (destHash !== fileInfo.sha256) {
                    throw new JoyCallSyncError(
                        JOYCALL_SYNC_ERROR_CODES.HASH_MISMATCH,
                        `Destination SHA-256 (${destHash}) does not match source (${fileInfo.sha256})`
                    );
                }

                // 4. Atomic rename to final filename
                fs.renameSync(tempDestPath, finalDestPath);

                return {
                    status: TRANSFER_STATUS.COMPLETED,
                    destinationPath: finalDestPath,
                    size: fileInfo.size,
                    sha256: fileInfo.sha256,
                    attempts: attempt
                };
            } catch (err) {
                lastError = err;
                // Clean up partial temp file if exists on retryable failure
                try {
                    if (fs.existsSync(tempDestPath)) {
                        fs.unlinkSync(tempDestPath);
                    }
                } catch { /* ignore */ }

                if (attempt < this.maxRetries) {
                    const delay = this.retryBackoffMs * Math.pow(2, attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        throw new JoyCallSyncError(
            JOYCALL_SYNC_ERROR_CODES.TRANSFER_FAILED,
            `Transfer failed after ${attempt} attempts: ${lastError?.message || 'Unknown error'}`
        );
    }
}

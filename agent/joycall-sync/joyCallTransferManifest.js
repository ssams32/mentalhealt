/**
 * agent/joycall-sync/joyCallTransferManifest.js
 * Persistent transfer manifest tracking synced JoyCall recordings.
 * Strictly adheres to privacy constraints and fail-closed corruption recovery.
 * 
 * FIELD PRIVACY POLICY:
 * - Stores ONLY: transferId, sourceHash, sourceSize, destinationSafeName,
 *   status, attemptCount, firstSeenAt, lastAttemptAt, completedAt, lastErrorCode, version.
 * - NEVER stores: phone numbers, full source paths, full NAS paths, transcripts, summaries, user names, credentials.
 * 
 * CORRUPTION POLICY:
 * - Preserves the original corrupt manifest file on disk untouched (never renamed or replaced).
 * - Enters fail-closed MANIFEST_CORRUPTED status.
 * - Forbids automatic empty resets or automatic finalization.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TRANSFER_STATUS, JOYCALL_SYNC_DEFAULTS } from './joyCallSyncConstants.js';
import { JoyCallSyncError, JOYCALL_SYNC_ERROR_CODES } from './joyCallSyncErrors.js';

export class JoyCallTransferManifest {
    constructor(manifestFilePath) {
        this.manifestFilePath = manifestFilePath || path.join(process.cwd(), JOYCALL_SYNC_DEFAULTS.MANIFEST_FILENAME);
        this.transfers = new Map(); // key: sourceHash, value: record
        this.isCorrupted = false;
        this.status = 'READY';
        this.load();
    }

    /**
     * Load manifest from disk if exists.
     * Fails closed if corrupted without altering or replacing the original file.
     */
    load() {
        if (!fs.existsSync(this.manifestFilePath)) {
            return;
        }

        try {
            const raw = fs.readFileSync(this.manifestFilePath, 'utf-8');
            if (raw && raw.trim().length > 0) {
                const list = JSON.parse(raw);
                if (!Array.isArray(list)) {
                    throw new Error('Manifest root must be an array');
                }
                for (const item of list) {
                    if (item && item.sourceHash) {
                        this.transfers.set(item.sourceHash, item);
                    }
                }
            }
            this.status = 'READY';
        } catch (err) {
            // CORRUPTION HANDLING: FAIL CLOSED
            // STRICT REQUIREMENT: Preserve original corrupt manifest, do NOT silently rename or replace it!
            this.isCorrupted = true;
            this.status = 'MANIFEST_CORRUPTED';

            throw new JoyCallSyncError(
                'MANIFEST_CORRUPTED',
                `Transfer manifest is corrupted: ${err.message}. Original file preserved untouched. Fail-closed active.`
            );
        }
    }

    /**
     * Save manifest atomically to disk.
     */
    save() {
        if (this.isCorrupted) {
            throw new JoyCallSyncError(
                'MANIFEST_CORRUPTED',
                'Cannot persist to corrupted manifest. Original corrupt file is preserved; manual intervention required.'
            );
        }

        const list = Array.from(this.transfers.values());
        const json = JSON.stringify(list, null, 2);
        const tmpPath = `${this.manifestFilePath}.tmp.${Date.now()}`;

        try {
            const dir = path.dirname(this.manifestFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(tmpPath, json, 'utf-8');
            fs.renameSync(tmpPath, this.manifestFilePath);
        } catch (err) {
            try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch { /* ignore */ }
            throw new JoyCallSyncError(
                JOYCALL_SYNC_ERROR_CODES.MANIFEST_WRITE_FAILED,
                `Failed to write transfer manifest: ${err.message}`
            );
        }
    }

    /**
     * Check whether a SHA-256 hash was already successfully transferred.
     */
    hasCompletedHash(sha256) {
        if (!sha256 || this.isCorrupted) return false;
        const record = this.transfers.get(sha256);
        return record?.status === TRANSFER_STATUS.COMPLETED || record?.status === TRANSFER_STATUS.RESUMED_AND_FINALIZED;
    }

    /**
     * Record completed transfer with strict schema minimization.
     */
    recordSuccess(record) {
        if (this.isCorrupted) {
            throw new JoyCallSyncError(
                'MANIFEST_CORRUPTED',
                'Manifest is corrupted; cannot record success'
            );
        }

        const sourceHash = record.sha256 || record.sourceHash;
        const nowIso = new Date().toISOString();
        const existing = this.transfers.get(sourceHash);

        const safeRecord = {
            transferId: existing?.transferId || `tx_${crypto.randomUUID()}`,
            sourceHash,
            sourceSize: record.sizeBytes || record.sourceSize,
            destinationSafeName: path.basename(record.destinationFilename || record.destinationSafeName || record.filename),
            status: record.status || TRANSFER_STATUS.COMPLETED,
            attemptCount: (existing?.attemptCount || 0) + (record.attempts || 1),
            firstSeenAt: existing?.firstSeenAt || nowIso,
            lastAttemptAt: nowIso,
            completedAt: nowIso,
            lastErrorCode: null,
            version: (existing?.version || 0) + 1
        };

        this.transfers.set(sourceHash, safeRecord);
        this.save();
        return safeRecord;
    }

    /**
     * Record failed transfer with strict schema minimization.
     */
    recordFailure(record, errorMsg, errorCode = null) {
        if (this.isCorrupted) return;

        const sourceHash = record.sha256 || record.sourceHash;
        const nowIso = new Date().toISOString();
        const existing = this.transfers.get(sourceHash);

        const safeRecord = {
            transferId: existing?.transferId || `tx_${crypto.randomUUID()}`,
            sourceHash,
            sourceSize: record.sizeBytes || record.sourceSize,
            destinationSafeName: path.basename(record.destinationFilename || record.destinationSafeName || record.filename || 'unknown'),
            status: TRANSFER_STATUS.FAILED,
            attemptCount: (existing?.attemptCount || 0) + 1,
            firstSeenAt: existing?.firstSeenAt || nowIso,
            lastAttemptAt: nowIso,
            completedAt: null,
            lastErrorCode: errorCode || 'TRANSFER_FAILED',
            version: (existing?.version || 0) + 1
        };

        this.transfers.set(sourceHash, safeRecord);
        try {
            this.save();
        } catch { /* ignore */ }
        return safeRecord;
    }

    getAllRecords() {
        return Array.from(this.transfers.values());
    }

    getRecord(sourceHash) {
        return this.transfers.get(sourceHash) || null;
    }

    /**
     * Read-only reconciliation of manifest records.
     */
    reconcileManifest() {
        return {
            status: this.status,
            isCorrupted: this.isCorrupted,
            originalPreserved: true,
            totalRecords: this.transfers.size,
            completedCount: Array.from(this.transfers.values()).filter(r => r.status === TRANSFER_STATUS.COMPLETED).length,
            failedCount: Array.from(this.transfers.values()).filter(r => r.status === TRANSFER_STATUS.FAILED).length
        };
    }
}

/**
 * server/voice-access/voiceAccessHistoryRepository.js
 * Append-Only Persistent Audit History for Voice System Access Grants.
 * Enforces Fail-Closed Corruption Defense and PII Redaction.
 */

import fs from 'fs';
import path from 'path';
import { HISTORY_FILE_NAME } from './voiceAccessConstants.js';
import { VoiceAccessError, VOICE_ACCESS_ERROR_CODES } from './voiceAccessErrors.js';
import { validateStoredHistory } from './voiceAccessValidator.js';
import { withFileLock, normalizeLockKey } from '../storage/sharedFileLockRegistry.js';

export class VoiceAccessHistoryRepository {
    /**
     * @param {Object} [options]
     * @param {string} [options.dataDir]
     * @param {string} [options.filePath]
     */
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.resolve(process.cwd(), 'server', 'data');
        this.filePath = options.filePath || path.join(this.dataDir, HISTORY_FILE_NAME);
        this.isCorrupted = false;
        this.corruptionError = null;
    }

    /**
     * Resets corruption state without altering on-disk files.
     */
    resetCorruptionState() {
        this.isCorrupted = false;
        this.corruptionError = null;
    }

    /**
     * Internal raw read under lock.
     * @private
     */
    async _readHistoryUnsafe() {
        if (this.isCorrupted) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                `Voice access history store is in fail-closed state: ${this.corruptionError?.message || 'Corrupted'}`,
                503
            );
        }

        if (!fs.existsSync(this.filePath)) {
            return [];
        }

        let raw;
        try {
            raw = await fs.promises.readFile(this.filePath, 'utf-8');
        } catch (err) {
            this.isCorrupted = true;
            this.corruptionError = err;
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                `Failed to read voice access history store: ${err.message}`,
                503
            );
        }

        if (!raw || raw.trim().length === 0) {
            return [];
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseErr) {
            this.isCorrupted = true;
            this.corruptionError = parseErr;
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                `Voice access history store JSON is corrupted: ${parseErr.message}`,
                503
            );
        }

        if (!Array.isArray(parsed)) {
            this.isCorrupted = true;
            this.corruptionError = new Error('History file root is not an array');
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                'Voice access history store format error: root must be an array',
                503
            );
        }

        return parsed;
    }

    /**
     * Internal atomic write under lock.
     * @private
     */
    async _writeHistoryUnsafe(entries) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }

        const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
        const content = JSON.stringify(entries, null, 2);

        try {
            await fs.promises.writeFile(tmpPath, content, 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (err) {
            try {
                if (fs.existsSync(tmpPath)) {
                    await fs.promises.unlink(tmpPath);
                }
            } catch {
                // Ignore cleanup error
            }
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_UNAVAILABLE,
                `Failed to persist voice access history: ${err.message}`,
                503
            );
        }
    }

    /**
     * Append a new history entry.
     */
    async appendEntry(entry) {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const history = await this._readHistoryUnsafe();

            const fullEntry = {
                id: entry.id || `vah_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
                grantId: entry.grantId,
                userId: entry.userId,
                action: entry.action,
                performedBy: entry.performedBy,
                performedAt: entry.performedAt || new Date().toISOString(),
                changes: entry.changes || null,
                reason: entry.reason || null
            };

            const val = validateStoredHistory(fullEntry);
            if (!val.valid) {
                throw new VoiceAccessError(
                    VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                    `Invalid history entry: ${val.reason}`,
                    400
                );
            }

            history.push(fullEntry);
            await this._writeHistoryUnsafe(history);
            return JSON.parse(JSON.stringify(fullEntry));
        });
    }

    /**
     * Retrieve all history entries.
     */
    async findAll() {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const history = await this._readHistoryUnsafe();
            return JSON.parse(JSON.stringify(history));
        });
    }

    /**
     * Retrieve history entries for a grant.
     */
    async findByGrantId(grantId) {
        if (!grantId) return [];
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const history = await this._readHistoryUnsafe();
            const matched = history.filter(h => h.grantId === grantId);
            return JSON.parse(JSON.stringify(matched));
        });
    }

    /**
     * Retrieve history entries for a user.
     */
    async findByUserId(userId) {
        if (!userId) return [];
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const history = await this._readHistoryUnsafe();
            const matched = history.filter(h => h.userId === userId);
            return JSON.parse(JSON.stringify(matched));
        });
    }

    /**
     * Count total stored history records.
     */
    async count() {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const history = await this._readHistoryUnsafe();
            return history.length;
        });
    }
}

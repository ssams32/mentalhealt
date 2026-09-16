/**
 * server/voice-access/voiceAccessRepository.js
 * Atomic, Lock-Protected Persistent Repository for VoiceSystemAccessGrants.json.
 * Enforces Fail-Closed Corruption Defense, OCC Versioning, and 1 Active Grant Per User.
 */

import fs from 'fs';
import path from 'path';
import { GRANTS_FILE_NAME, GRANT_STATUS } from './voiceAccessConstants.js';
import { VoiceAccessError, VOICE_ACCESS_ERROR_CODES } from './voiceAccessErrors.js';
import { validateStoredGrant } from './voiceAccessValidator.js';
import { withFileLock, normalizeLockKey } from '../storage/sharedFileLockRegistry.js';

export class VoiceAccessRepository {
    /**
     * @param {Object} [options]
     * @param {string} [options.dataDir]
     * @param {string} [options.filePath]
     */
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.resolve(process.cwd(), 'server', 'data');
        this.filePath = options.filePath || path.join(this.dataDir, GRANTS_FILE_NAME);
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
     * Internal raw read under mutex lock or read-only access.
     * @private
     */
    async _readGrantsUnsafe() {
        if (this.isCorrupted) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                `Voice access grant store is in fail-closed state: ${this.corruptionError?.message || 'Corrupted'}`,
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
                `Failed to read voice access grant store: ${err.message}`,
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
                `Voice access grant store JSON is corrupted: ${parseErr.message}`,
                503
            );
        }

        if (!Array.isArray(parsed)) {
            this.isCorrupted = true;
            this.corruptionError = new Error('Grants file root is not an array');
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_CORRUPTED,
                'Voice access grant store format error: root must be an array',
                503
            );
        }

        return parsed;
    }

    /**
     * Internal atomic write under lock.
     * @private
     */
    async _writeGrantsUnsafe(grants) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }

        const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
        const content = JSON.stringify(grants, null, 2);

        try {
            await fs.promises.writeFile(tmpPath, content, 'utf-8');
            await fs.promises.rename(tmpPath, this.filePath);
        } catch (err) {
            try {
                if (fs.existsSync(tmpPath)) {
                    await fs.promises.unlink(tmpPath);
                }
            } catch {
                // Ignore tmp cleanup error
            }
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.STORE_UNAVAILABLE,
                `Failed to atomically persist voice access grants: ${err.message}`,
                503
            );
        }
    }

    /**
     * Retrieve all grants.
     */
    async findAll() {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            return JSON.parse(JSON.stringify(grants));
        });
    }

    /**
     * Find a grant by its unique ID.
     */
    async findById(grantId) {
        if (!grantId) return null;
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            const found = grants.find(g => g.id === grantId);
            return found ? JSON.parse(JSON.stringify(found)) : null;
        });
    }

    /**
     * Find active grant for a specific userId.
     * @param {string} userId
     * @param {Object} [options]
     * @param {boolean} [options.includeExpired=false]
     */
    async findActiveByUserId(userId, options = {}) {
        if (!userId) return null;
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            const now = new Date();
            const found = grants.find(g => {
                if (g.userId !== userId || g.status !== GRANT_STATUS.ACTIVE) {
                    return false;
                }
                // Check if expired unless includeExpired is true
                if (!options.includeExpired && g.expiresAt) {
                    const exp = new Date(g.expiresAt);
                    if (now > exp) return false;
                }
                return true;
            });
            return found ? JSON.parse(JSON.stringify(found)) : null;
        });
    }

    /**
     * Find all grants for a specific userId.
     */
    async findByUserId(userId) {
        if (!userId) return [];
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            const matched = grants.filter(g => g.userId === userId);
            return JSON.parse(JSON.stringify(matched));
        });
    }

    /**
     * Count total stored grants.
     */
    async count() {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            return grants.length;
        });
    }

    /**
     * Atomically insert or update a grant record.
     * Enforces OCC version matching and 1-active-grant-per-user constraint.
     */
    async saveGrantAtomic(grant, options = {}) {
        const lockKey = normalizeLockKey(this.filePath);
        return withFileLock(lockKey, async () => {
            const grants = await this._readGrantsUnsafe();
            const existingIndex = grants.findIndex(g => g.id === grant.id);

            // 1. OCC Version Check if updating
            if (existingIndex !== -1) {
                const current = grants[existingIndex];
                if (options.expectedVersion !== undefined) {
                    if (current.version !== options.expectedVersion) {
                        throw new VoiceAccessError(
                            VOICE_ACCESS_ERROR_CODES.OCC_VERSION_CONFLICT,
                            `Grant OCC conflict: expected version ${options.expectedVersion}, found ${current.version}`,
                            409
                        );
                    }
                }
            }

            // 2. Enforce 1 active grant per user
            if (grant.status === GRANT_STATUS.ACTIVE) {
                const conflictingActive = grants.find(
                    g => g.userId === grant.userId && g.id !== grant.id && g.status === GRANT_STATUS.ACTIVE
                );
                if (conflictingActive) {
                    throw new VoiceAccessError(
                        VOICE_ACCESS_ERROR_CODES.DUPLICATE_ACTIVE_GRANT,
                        `User [${grant.userId}] already has an active access grant [${conflictingActive.id}]`,
                        409
                    );
                }
            }

            // 3. Prepare updated record
            const now = new Date().toISOString();
            const updated = {
                ...grant,
                updatedAt: now,
                version: existingIndex !== -1 ? (grants[existingIndex].version || 1) + 1 : (grant.version || 1)
            };

            const val = validateStoredGrant(updated);
            if (!val.valid) {
                throw new VoiceAccessError(
                    VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                    `Grant validation failed: ${val.reason}`,
                    400
                );
            }

            // 4. Update or append
            if (existingIndex !== -1) {
                grants[existingIndex] = updated;
            } else {
                grants.push(updated);
            }

            // 5. Atomic persist
            await this._writeGrantsUnsafe(grants);
            return JSON.parse(JSON.stringify(updated));
        });
    }
}

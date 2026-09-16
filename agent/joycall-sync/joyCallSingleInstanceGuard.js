/**
 * agent/joycall-sync/joyCallSingleInstanceGuard.js
 * Enforces single-instance execution on Windows using exclusive atomic PID lock files.
 * 
 * SAFETY RULES:
 * - Lock file is NEVER placed inside the JoyCall db directory or on the NAS.
 * - Atomic create using 'wx' flag prevents race conditions during startup.
 * - Stale locks from crashed processes are conservatively detected via process liveness.
 * - Active locks are NEVER stolen from running processes.
 * - Process ID is kept private and never exposed to client-facing errors.
 * - Hardened identity tracks: pid, agentInstanceId, startedAt, executableIdentity, schemaVersion.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JoyCallSyncError, JOYCALL_SYNC_ERROR_CODES } from './joyCallSyncErrors.js';

export class JoyCallSingleInstanceGuard {
    /**
     * @param {Object} options
     * @param {string} [options.stateDir] Dedicated local agent state directory
     * @param {string} [options.lockFilename] Name of the lock file
     * @param {string} [options.instanceId] Unique agent instance identifier
     */
    constructor(options = {}) {
        this.stateDir = options.stateDir || path.join(process.cwd(), '.agent_state');
        this.lockFilename = options.lockFilename || 'joycall_sync_agent.lock';
        this.lockPath = path.join(this.stateDir, this.lockFilename);
        this.agentInstanceId = options.instanceId || `inst_${crypto.randomUUID()}`;
        this.isAcquired = false;
    }

    /**
     * Check if a process with given PID is currently active.
     */
    _isProcessAlive(pid) {
        if (!pid || typeof pid !== 'number' || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            return err.code === 'EPERM'; // Process exists but belongs to different user context
        }
    }

    /**
     * Build hardened lock payload containing all required identity fields.
     */
    _createLockPayload() {
        return JSON.stringify({
            schemaVersion: 2,
            pid: process.pid,
            agentInstanceId: this.agentInstanceId,
            startedAt: new Date().toISOString(),
            executableIdentity: process.execPath ? path.basename(process.execPath) : 'node'
        }, null, 2);
    }

    /**
     * Attempt to acquire exclusive single-instance lock.
     */
    acquire() {
        if (this.isAcquired) {
            return true;
        }

        // Ensure state directory exists
        if (!fs.existsSync(this.stateDir)) {
            fs.mkdirSync(this.stateDir, { recursive: true });
        }

        const lockPayload = this._createLockPayload();

        // 1. Try atomic exclusive create ('wx')
        try {
            fs.writeFileSync(this.lockPath, lockPayload, { flag: 'wx' });
            this.isAcquired = true;
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw new JoyCallSyncError(
                    JOYCALL_SYNC_ERROR_CODES.SOURCE_UNAVAILABLE,
                    'Failed to initialize single-instance lock directory'
                );
            }
        }

        // 2. Lock file exists: inspect whether it is held by an active process or stale
        let lockData = null;
        try {
            const raw = fs.readFileSync(this.lockPath, 'utf-8');
            lockData = JSON.parse(raw);
        } catch {
            lockData = null; // Malformed
        }

        if (lockData && typeof lockData.pid === 'number' && this._isProcessAlive(lockData.pid)) {
            // Active instance is already running! Refuse to start.
            throw new JoyCallSyncError(
                'AGENT_ALREADY_RUNNING',
                'Another instance of JoyCall Sync Agent is already running.'
            );
        }

        // Stale or corrupted lock detected: safely remove and re-acquire atomically
        try {
            fs.unlinkSync(this.lockPath);
            fs.writeFileSync(this.lockPath, lockPayload, { flag: 'wx' });
            this.isAcquired = true;
            return true;
        } catch {
            throw new JoyCallSyncError(
                'AGENT_ALREADY_RUNNING',
                'Failed to claim stale lock; another instance may have just started.'
            );
        }
    }

    /**
     * Release lock cleanly on shutdown.
     */
    release() {
        if (!this.isAcquired) {
            return;
        }

        try {
            if (fs.existsSync(this.lockPath)) {
                const raw = fs.readFileSync(this.lockPath, 'utf-8');
                const lockData = JSON.parse(raw);
                // Verify both pid and agentInstanceId before releasing to prevent unlinking reused locks
                if (lockData?.pid === process.pid && lockData?.agentInstanceId === this.agentInstanceId) {
                    fs.unlinkSync(this.lockPath);
                }
            }
        } catch {
            // Ignore release unlinking errors
        } finally {
            this.isAcquired = false;
        }
    }
}

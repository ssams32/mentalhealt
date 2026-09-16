/**
 * server/storage/sharedFileLockRegistry.js
 * In-process Shared File Lock Registry for Mind-ERP OS.
 * Serializes async disk write operations per normalized file key.
 * 
 * BOUNDARY NOTICE:
 * - This lock registry coordinates concurrency strictly WITHIN A SINGLE Node.js PROCESS.
 * - It does NOT provide cross-process or multi-container distributed locking across multiple Node processes or NAS mount nodes.
 */

import fs from 'fs';
import path from 'path';

// Map<normalizedKey, { tail: Promise<any>, activeCount: number }>
const lockRegistry = new Map();

/**
 * Normalize a file identifier or path to ensure identical targets share the same lock queue.
 * - On win32: case-folds paths and tokens to match case-insensitive Windows filesystem.
 * - On linux / darwin / POSIX: strictly preserves case sensitivity.
 * - Resolves parent directory realpath if accessible to canonicalize symlink aliases.
 * 
 * @param {string} target - File path or identifier token
 * @param {string} [platform=process.platform] - Target OS platform identifier
 * @returns {string} Normalized lock key
 */
export function normalizeLockKey(target, platform = process.platform) {
    if (!target || typeof target !== 'string') {
        throw new Error('Lock target must be a non-empty string');
    }

    const trimmed = target.trim();
    const isPathLike = trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('.');

    if (isPathLike) {
        let resolved = path.resolve(trimmed);
        try {
            const parentDir = path.dirname(resolved);
            if (fs.existsSync(parentDir)) {
                const realParent = fs.realpathSync(parentDir);
                resolved = path.join(realParent, path.basename(resolved));
            }
        } catch {
            // Fall back to path.resolve if realpath is inaccessible
        }

        if (platform === 'win32') {
            return resolved.toLowerCase();
        }
        return resolved;
    }

    if (platform === 'win32') {
        return trimmed.toLowerCase();
    }
    return trimmed;
}

/**
 * Execute an async function exclusively for the given lock key.
 * Guarantees FIFO queuing, error non-blocking, and memory cleanup on idle.
 * 
 * @param {string} targetKey - File name, table name, or path
 * @param {Function} asyncFn - () => Promise<T>
 * @param {Object} [options={}] - { platform }
 * @returns {Promise<T>}
 */
export async function withFileLock(targetKey, asyncFn, options = {}) {
    if (typeof asyncFn !== 'function') {
        throw new Error('asyncFn must be a callable function');
    }

    const key = normalizeLockKey(targetKey, options.platform || process.platform);

    let entry = lockRegistry.get(key);
    if (!entry) {
        entry = {
            tail: Promise.resolve(),
            activeCount: 0
        };
        lockRegistry.set(key, entry);
    }

    entry.activeCount++;

    // Chain execution after existing tail, whether previous succeeded or failed
    const currentRun = entry.tail.then(
        () => asyncFn(),
        () => asyncFn() // continue queue even if previous rejected
    );

    // Update tail to track current run
    entry.tail = currentRun.catch(() => {});

    try {
        return await currentRun;
    } finally {
        entry.activeCount--;
        if (entry.activeCount <= 0) {
            // Memory cleanup: remove entry when no waiting operations remain
            lockRegistry.delete(key);
        }
    }
}

/**
 * Get current lock registry diagnostic size.
 */
export function getActiveLockCount() {
    return lockRegistry.size;
}

/**
 * Clear all locks (for test teardown only).
 */
export function clearLockRegistryForTest() {
    lockRegistry.clear();
}

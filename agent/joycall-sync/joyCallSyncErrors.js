/**
 * agent/joycall-sync/joyCallSyncErrors.js
 * Error definitions for JoyCall Sync Agent.
 */

export class JoyCallSyncError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'JoyCallSyncError';
        this.code = code;
        this.details = details;
    }
}

export const JOYCALL_SYNC_ERROR_CODES = Object.freeze({
    SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
    DESTINATION_UNAVAILABLE: 'DESTINATION_UNAVAILABLE',
    FILE_READ_FAILED: 'FILE_READ_FAILED',
    FILE_UNSTABLE: 'FILE_UNSTABLE',
    INVALID_AUDIO_SIGNATURE: 'INVALID_AUDIO_SIGNATURE',
    SIZE_MISMATCH: 'SIZE_MISMATCH',
    HASH_MISMATCH: 'HASH_MISMATCH',
    TRANSFER_FAILED: 'TRANSFER_FAILED',
    RENAME_FAILED: 'RENAME_FAILED',
    MANIFEST_WRITE_FAILED: 'MANIFEST_WRITE_FAILED',
    FILENAME_COLLISION: 'FILENAME_COLLISION',
    UPLOADING_CONFLICT: 'UPLOADING_CONFLICT'
});

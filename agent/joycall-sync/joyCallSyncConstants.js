/**
 * agent/joycall-sync/joyCallSyncConstants.js
 * Constants and configuration defaults for the JoyCall Near-Real-Time Sync Agent.
 */

export const DEFAULT_JOYCALL_SOURCE_DIR = 'C:\\Program Files (x86)\\JoyCall\\db';

export const JOYCALL_SUPPORTED_EXTENSIONS = Object.freeze(['.wav', '.mp3', '.m4a']);

export const JOYCALL_IGNORED_EXTENSIONS = Object.freeze([
    '.db', '.idx', '.log', '.ini', '.tmp', '.dat', '.lock', '.uploading', '.bak'
]);

export const JOYCALL_SYNC_DEFAULTS = Object.freeze({
    STABILITY_CHECKS_REQUIRED: 3,
    STABILITY_CHECK_INTERVAL_MS: 1000,
    QUIET_PERIOD_MS: 5000,
    POLL_INTERVAL_MS: 5000,
    MAX_RETRIES: 3,
    RETRY_BACKOFF_MS: 1000,
    UPLOADING_SUFFIX: '.uploading',
    MANIFEST_FILENAME: 'joycall_transfer_manifest.json'
});

export const TRANSFER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    UPLOADING: 'UPLOADING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE',
    FILENAME_COLLISION: 'FILENAME_COLLISION',
    UPLOADING_CONFLICT: 'UPLOADING_CONFLICT',
    RESUMED_AND_FINALIZED: 'RESUMED_AND_FINALIZED'
});


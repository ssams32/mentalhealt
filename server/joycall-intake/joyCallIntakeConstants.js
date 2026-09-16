/**
 * server/joycall-intake/joyCallIntakeConstants.js
 * Domain constants, canonical record types, and classification states for NAS JoyCall intake.
 */

export const JOYCALL_INTAKE_PROCESSING_STATUS = Object.freeze({
    PENDING: 'pending',
    VALIDATING: 'validating',
    STORED: 'stored',
    REJECTED: 'rejected',
    DUPLICATE: 'duplicate'
});

export const JOYCALL_CLASSIFICATION_STATUS = Object.freeze({
    PENDING: 'pending',
    CLASSIFIED: 'classified'
});

export const JOYCALL_CANONICAL_RECORD_TYPES = Object.freeze({
    ADMINISTRATIVE_CALL: 'administrative_call',
    INDIVIDUAL_COUNSELING: 'individual_counseling',
    INTAKE_COUNSELING: 'intake_counseling'
});

export const JOYCALL_CANONICAL_CLASSIFICATION_METHODS = Object.freeze({
    STAFF_SELECTED: 'staff_selected',
    STAFF_CORRECTED: 'staff_corrected'
});

export const JOYCALL_LINK_STATUS = Object.freeze({
    UNLINKED: 'unlinked',
    LINKED: 'linked'
});

export const JOYCALL_INTAKE_DEFAULTS = Object.freeze({
    MIN_FILE_BYTES: 1024,
    MAX_FILE_BYTES: 100 * 1024 * 1024, // 100MB
    SUPPORTED_EXTENSIONS: ['.wav', '.mp3', '.m4a']
});

export const JOYCALL_INTAKE_CHECK_CODES = Object.freeze({
    UPLOADING_FILE_IGNORED: 'UPLOADING_FILE_IGNORED',
    UNSUPPORTED_EXTENSION: 'UNSUPPORTED_EXTENSION',
    ZERO_BYTE_FILE: 'ZERO_BYTE_FILE',
    FILE_TOO_SMALL: 'FILE_TOO_SMALL',
    FILE_UNSTABLE: 'FILE_UNSTABLE',
    INVALID_SIGNATURE: 'INVALID_SIGNATURE',
    DUPLICATE_HASH: 'DUPLICATE_HASH',
    INTAKE_SUCCESS: 'INTAKE_SUCCESS'
});

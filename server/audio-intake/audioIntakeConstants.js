/**
 * server/audio-intake/audioIntakeConstants.js
 * Canonical Constants, Magic Number Signatures, and MIME Mappings for Mind-ERP OS Audio Intake.
 */

export const AUDIO_FORMAT = Object.freeze({
    MP3: 'mp3',
    WAV: 'wav',
    M4A: 'm4a'
});

export const ALLOWED_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a']);

export const MIME_MAP = Object.freeze({
    [AUDIO_FORMAT.MP3]: Object.freeze(['audio/mpeg', 'audio/mp3', 'audio/x-mpeg']),
    [AUDIO_FORMAT.WAV]: Object.freeze(['audio/wav', 'audio/x-wav', 'audio/wave']),
    [AUDIO_FORMAT.M4A]: Object.freeze(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'])
});

export const DURATION_VALIDATION_STATUS = Object.freeze({
    PENDING: 'pending',
    EXACT: 'exact',
    ESTIMATED: 'estimated',
    UNAVAILABLE: 'unavailable',
    EXCEEDED: 'exceeded'
});

export const MEDIA_VALIDATION_STAGE = Object.freeze({
    SIGNATURE_ONLY: 'signature_only',
    STRUCTURAL: 'structural',
    PENDING_DECODE: 'pending_decode',
    DECODED: 'decoded',
    REJECTED: 'rejected'
});

export const INTAKE_LIMITS = Object.freeze({
    DEFAULT_MIN_FILE_BYTES: 1024, // 1 KB
    DEFAULT_MAX_FILE_BYTES: 50 * 1024 * 1024, // 50 MB
    DEFAULT_MAX_DURATION_SECONDS: 7200, // 2 Hours
    DEFAULT_TEMPORARY_TTL_MINUTES: 60,
    MAX_FILENAME_LENGTH: 200,
    HEADER_PROBE_BYTES: 4096,
    HASH_ALGORITHM: 'sha256'
});

// Known Magic Number Signatures for Dangerous / Disguised Files
export const DANGEROUS_SIGNATURES = Object.freeze({
    MZ_EXECUTABLE: Object.freeze([0x4D, 0x5A]), // Windows EXE/DLL ('MZ')
    ELF_EXECUTABLE: Object.freeze([0x7F, 0x45, 0x4C, 0x46]), // Linux ELF
    ZIP_ARCHIVE: Object.freeze([0x50, 0x4B, 0x03, 0x04]), // ZIP PK
    SEVEN_ZIP: Object.freeze([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]),
    RAR_ARCHIVE: Object.freeze([0x52, 0x61, 0x72, 0x21]), // 'Rar!'
    PDF_DOCUMENT: Object.freeze([0x25, 0x50, 0x44, 0x46]), // '%PDF'
    PNG_IMAGE: Object.freeze([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
});

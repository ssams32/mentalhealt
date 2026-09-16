/**
 * server/audio-storage/privateAudioStorageKey.js
 * Permanent Storage Key Generator and Path Sanitization for Mind-ERP OS.
 * Guarantees zero path traversal, drive letters, or client filename contamination.
 */

import crypto from 'crypto';
import path from 'path';
import { PrivateAudioStorageError } from './privateAudioStorageErrors.js';
import { PROMOTION_ERROR_CODES } from './privateAudioStorageConstants.js';

const ALLOWED_PERMANENT_EXTENSIONS = new Set(['wav', 'mp3', 'm4a']);
const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate canonical relative permanent storage key for verified audio.
 * Format: private-audio/YYYY/MM/{callId}/{audioObjectId}.{verifiedExtension}
 * 
 * @param {string} callId - Validated UUID/ID of the VoiceCall
 * @param {string} verifiedExtension - Verified file extension ('wav', 'mp3', 'm4a')
 * @param {Date} [date=new Date()]
 * @returns {string} Relative storage key
 */
export function generatePermanentStorageKey(callId, verifiedExtension, date = new Date()) {
    if (!callId || typeof callId !== 'string') {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            '영구 저장소 키 생성을 위한 callId가 올바르지 않습니다.'
        );
    }

    const cleanExt = String(verifiedExtension || '').toLowerCase().replace(/^\./, '').trim();
    if (!ALLOWED_PERMANENT_EXTENSIONS.has(cleanExt)) {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            `허용되지 않은 영구 오디오 확장자입니다: [${cleanExt}]`
        );
    }

    const cleanCallId = callId.trim();
    if (!SAFE_SEGMENT_REGEX.test(cleanCallId)) {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            'callId에 안전하지 않은 문자가 포함되어 있습니다.'
        );
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const audioObjectId = crypto.randomUUID();

    return `private-audio/${year}/${month}/${cleanCallId}/${audioObjectId}.${cleanExt}`;
}

/**
 * Generate canonical relative quarantine storage key for rejected/malicious payloads.
 * Format: quarantine/YYYY/MM/{intakeId}/{quarantineObjectId}.bin
 * 
 * @param {string} intakeId - UUID of the intake event
 * @param {Date} [date=new Date()]
 * @returns {string} Relative quarantine storage key
 */
export function generateQuarantineStorageKey(intakeId, date = new Date()) {
    if (!intakeId || typeof intakeId !== 'string') {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            '격리 저장소 키 생성을 위한 intakeId가 올바르지 않습니다.'
        );
    }

    const cleanIntakeId = intakeId.trim();
    if (!SAFE_SEGMENT_REGEX.test(cleanIntakeId)) {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            'intakeId에 안전하지 않은 문자가 포함되어 있습니다.'
        );
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const quarantineObjectId = crypto.randomUUID();

    return `quarantine/${year}/${month}/${cleanIntakeId}/${quarantineObjectId}.bin`;
}

/**
 * Validate syntax and security rules of a relative storage key.
 * 
 * @param {string} storageKey
 * @returns {boolean}
 */
export function isSafePrivateStorageKey(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') return false;
    const trimmed = storageKey.trim();
    if (trimmed === '' || trimmed.length > 300) return false;

    // Strict relative path checks
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false; // Leading slashes
    if (trimmed.includes('\\')) return false; // Backslashes strictly forbidden
    if (trimmed.includes('..')) return false; // Traversal forbidden
    if (trimmed.includes('\0')) return false; // Null bytes
    if (/^[a-zA-Z]:/.test(trimmed)) return false; // Drive letters
    if (trimmed.includes('://')) return false; // URLs
    if (trimmed.startsWith('file:')) return false; // File URIs

    // Must start with recognized namespace prefix
    const isPrivate = trimmed.startsWith('private-audio/');
    const isQuarantine = trimmed.startsWith('quarantine/');
    if (!isPrivate && !isQuarantine) return false;

    // Path segments validation
    const segments = trimmed.split('/');
    if (segments.length !== 5) return false; // [namespace, YYYY, MM, id, filename]

    const [namespace, year, month, id, filename] = segments;
    if (!/^\d{4}$/.test(year)) return false;
    if (!/^(0[1-9]|1[0-2])$/.test(month)) return false;
    if (!SAFE_SEGMENT_REGEX.test(id)) return false;

    const fileParts = filename.split('.');
    if (fileParts.length !== 2) return false;
    const [objectId, ext] = fileParts;
    if (!SAFE_SEGMENT_REGEX.test(objectId)) return false;

    if (isPrivate && !ALLOWED_PERMANENT_EXTENSIONS.has(ext.toLowerCase())) return false;
    if (isQuarantine && ext.toLowerCase() !== 'bin') return false;

    return true;
}

/**
 * Resolve and strictly validate a relative storage key against a base root directory.
 * Guarantees that resolved path is strictly contained within base root.
 * 
 * @param {string} rootDirectory - Absolute base root
 * @param {string} relativeKey - Relative storage key
 * @returns {{ resolvedPath: string, relativeKey: string }}
 */
export function resolveAndValidatePath(rootDirectory, relativeKey) {
    if (!rootDirectory || typeof rootDirectory !== 'string') {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            '저장소 루트 디렉터리가 제공되지 않았습니다.'
        );
    }

    if (!isSafePrivateStorageKey(relativeKey)) {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            '저장소 키 형식이 유효하지 않거나 안전 규칙을 위반했습니다.'
        );
    }

    let effectiveRoot = path.resolve(rootDirectory);
    const keyNamespace = relativeKey.split('/')[0]; // 'private-audio' or 'quarantine'
    const rootBase = path.basename(effectiveRoot);
    if (rootBase === keyNamespace) {
        // Parent storageRoot normalization: Prevent double namespace nesting (e.g. .../private-audio/private-audio/...)
        effectiveRoot = path.dirname(effectiveRoot);
    }

    const resolvedTarget = path.resolve(effectiveRoot, relativeKey);

    // Confinement check: Target path must start with root + path.sep
    const rootPrefix = effectiveRoot.endsWith(path.sep) ? effectiveRoot : effectiveRoot + path.sep;
    if (!resolvedTarget.startsWith(rootPrefix)) {
        throw new PrivateAudioStorageError(
            PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
            '저장소 키가 루트 디렉터리 경계를 벗어났습니다.'
        );
    }

    return {
        resolvedPath: resolvedTarget,
        relativeKey
    };
}

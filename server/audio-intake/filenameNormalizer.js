/**
 * server/audio-intake/filenameNormalizer.js
 * Sanitization and Normalization of Incoming Audio Filenames.
 * Treats original filenames purely as presentation metadata, strictly isolated from disk paths.
 */

import path from 'path';
import { INTAKE_LIMITS } from './audioIntakeConstants.js';

const SAFE_FALLBACK_NAME = 'audio_recording.bin';

/**
 * Normalize an untrusted client filename for safe metadata storage.
 * 
 * @param {string} rawName - Client provided filename
 * @returns {{ originalFileName: string, normalizedFileName: string, normalizedExtension: string }}
 */
export function normalizeAudioFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') {
        return {
            originalFileName: '',
            normalizedFileName: SAFE_FALLBACK_NAME,
            normalizedExtension: '.bin'
        };
    }

    const original = String(rawName);

    // 1. Remove Windows drive letters (e.g. C:, D:)
    let cleaned = original.replace(/^[a-zA-Z]:/, '');

    // 2. Extract basename taking into account both POSIX (/) and Windows (\)
    cleaned = cleaned.replace(/\\/g, '/');
    cleaned = path.posix.basename(cleaned);

    // 3. Remove null bytes and control characters
    cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');

    // 4. Remove slashes, backslashes, path traversal sequences
    cleaned = cleaned.replace(/[\/\\]/g, '').replace(/\.{2,}/g, '.');

    // 5. Apply Unicode NFC normalization
    try {
        cleaned = cleaned.normalize('NFC');
    } catch (e) {
        // Fallback if normalization fails
    }

    // 6. Trim leading/trailing whitespace and periods
    cleaned = cleaned.trim().replace(/^\.+|\.+$/g, '');

    // 7. If completely empty, return safe fallback
    if (!cleaned || cleaned === '') {
        return {
            originalFileName: original,
            normalizedFileName: SAFE_FALLBACK_NAME,
            normalizedExtension: '.bin'
        };
    }

    // 8. Extract extension
    let ext = path.extname(cleaned).toLowerCase();

    // 9. Length truncation with extension preservation
    const maxLen = INTAKE_LIMITS.MAX_FILENAME_LENGTH;
    if (cleaned.length > maxLen) {
        const base = path.basename(cleaned, ext);
        const allowedBaseLen = Math.max(1, maxLen - ext.length);
        cleaned = `${base.slice(0, allowedBaseLen)}${ext}`;
    }

    return {
        originalFileName: original,
        normalizedFileName: cleaned,
        normalizedExtension: ext
    };
}

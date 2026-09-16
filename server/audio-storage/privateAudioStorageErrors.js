/**
 * server/audio-storage/privateAudioStorageErrors.js
 * Sanitized Error Handling for Mind-ERP OS Private Audio Storage.
 * Strictly avoids leaking absolute server paths, binary bytes, or system credentials.
 */

import { PROMOTION_ERROR_CODES } from './privateAudioStorageConstants.js';

export class PrivateAudioStorageError extends Error {
    /**
     * @param {string} code - PROMOTION_ERROR_CODES
     * @param {string} message - Human-readable safe message
     * @param {number} [status=400] - HTTP status code
     * @param {Object} [safeDetails={}] - Non-sensitive audit metadata
     */
    constructor(code, message, status = 400, safeDetails = {}) {
        super(message);
        this.name = 'PrivateAudioStorageError';
        this.code = code || PROMOTION_ERROR_CODES.AUDIO_STORAGE_WRITE_FAILED;
        this.status = status;
        this.safeDetails = this._sanitizeDetails(safeDetails);
    }

    _sanitizeDetails(details) {
        if (!details || typeof details !== 'object') return {};
        const sanitized = { ...details };

        // Strip dangerous properties
        delete sanitized.absolutePath;
        delete sanitized.sourcePath;
        delete sanitized.targetPath;
        delete sanitized.tempPath;
        delete sanitized.rawBytes;
        delete sanitized.stack;
        delete sanitized.password;
        delete sanitized.token;

        return sanitized;
    }

    toJSON() {
        return {
            error: {
                name: this.name,
                code: this.code,
                message: this.message,
                details: this.safeDetails
            }
        };
    }
}

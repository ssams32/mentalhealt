/**
 * server/audio-streaming/audioStreamingErrors.js
 * Sanitized Non-leaking Error Domain for Mind-ERP OS Audio Streaming.
 */

import { STREAMING_ERROR_CODES } from './audioStreamingConstants.js';

export class AudioStreamingError extends Error {
    /**
     * @param {string} code - Canonical error code from STREAMING_ERROR_CODES
     * @param {string} safeMessage - Client-safe message (zero absolute paths, storageKeys, or hashes)
     * @param {number} [statusCode=400] - HTTP status code
     * @param {string} [reasonCode] - Internal reason identifier
     */
    constructor(code, safeMessage, statusCode = 400, reasonCode = null) {
        super(safeMessage);
        this.name = 'AudioStreamingError';
        this.code = code || STREAMING_ERROR_CODES.AUDIO_STREAM_FAILED;
        this.statusCode = statusCode;
        this.safeMessage = safeMessage;
        this.reasonCode = reasonCode || this.code;
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.safeMessage
            }
        };
    }
}

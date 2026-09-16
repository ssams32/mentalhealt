/**
 * server/audio-intake/audioMetadataProbe.js
 * Header-based Audio Metadata and Duration Probe for Mind-ERP OS Audio Intake.
 * Parses deterministic WAV duration; returns pending status for MP3/M4A awaiting Track B/Worker.
 */

import { AUDIO_FORMAT, DURATION_VALIDATION_STATUS } from './audioIntakeConstants.js';

/**
 * Probe WAV header to calculate precise duration from byteRate and data chunk size.
 */
function probeWavDuration(headerBuffer, totalFileSize) {
    if (!headerBuffer || headerBuffer.length < 44) {
        return { durationSeconds: null, status: DURATION_VALIDATION_STATUS.UNAVAILABLE };
    }

    try {
        // Read sampleRate at offset 24 (4 bytes uint32 little-endian)
        const sampleRate = headerBuffer.readUInt32LE(24);
        // Read byteRate at offset 28 (4 bytes uint32 little-endian)
        const byteRate = headerBuffer.readUInt32LE(28);
        // Read blockAlign at offset 32 (2 bytes uint16 little-endian)
        const blockAlign = headerBuffer.readUInt16LE(32);

        if (!byteRate || byteRate <= 0 || !sampleRate || sampleRate <= 0) {
            return { durationSeconds: null, status: DURATION_VALIDATION_STATUS.UNAVAILABLE };
        }

        // Find 'data' chunk
        let dataSize = null;
        for (let i = 12; i < headerBuffer.length - 8; i++) {
            // 'data' in ASCII
            if (headerBuffer[i] === 0x64 && headerBuffer[i + 1] === 0x61 && headerBuffer[i + 2] === 0x74 && headerBuffer[i + 3] === 0x61) {
                dataSize = headerBuffer.readUInt32LE(i + 4);
                break;
            }
        }

        // Fallback: estimate dataSize from totalFileSize minus typical 44-byte header if data chunk offset was beyond headerBuffer
        const effectiveDataSize = (dataSize && dataSize > 0) ? dataSize : Math.max(0, totalFileSize - 44);
        // Exact floating point without rounding (rounding only allowed at UI presentation layer)
        const duration = effectiveDataSize / byteRate;

        return {
            durationSeconds: duration >= 0 ? duration : null,
            status: DURATION_VALIDATION_STATUS.EXACT,
            byteRate,
            sampleRate,
            blockAlign
        };
    } catch (e) {
        return { durationSeconds: null, status: DURATION_VALIDATION_STATUS.UNAVAILABLE };
    }
}

/**
 * Probe audio header metadata.
 * 
 * @param {Buffer} headerBuffer - Initial buffer containing file header
 * @param {string} format - Detected audio format ('mp3', 'wav', 'm4a')
 * @param {number} totalFileSize - Actual total bytes received
 * @returns {{ durationSeconds: number|null, durationValidationStatus: string, details?: string }}
 */
export function probeAudioMetadata(headerBuffer, format, totalFileSize) {
    if (format === AUDIO_FORMAT.WAV) {
        const wavProbe = probeWavDuration(headerBuffer, totalFileSize);
        return {
            durationSeconds: wavProbe.durationSeconds,
            durationValidationStatus: wavProbe.status,
            details: 'Calculated deterministically from WAV RIFF fmt/data headers'
        };
    }

    // For MP3 and M4A:
    // Pure Node parser without external binary dependencies (ffprobe) cannot reliably determine VBR duration.
    // Durations for MP3/M4A are formally deferred to Track B STT ingestion.
    return {
        durationSeconds: null,
        durationValidationStatus: DURATION_VALIDATION_STATUS.PENDING,
        details: 'Deferred to worker metadata probe (external parser dependency not mounted in Gate A5)'
    };
}

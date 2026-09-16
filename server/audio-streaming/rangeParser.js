/**
 * server/audio-streaming/rangeParser.js
 * Strict RFC 7233 Single-Range Header Parser for Mind-ERP OS Audio Streaming.
 */

import { STREAMING_ERROR_CODES, STREAMING_LIMITS } from './audioStreamingConstants.js';
import { AudioStreamingError } from './audioStreamingErrors.js';

/**
 * Parse HTTP Range header for a specific file size.
 * Only single range specification is permitted; multipart/byteranges is rejected.
 * 
 * @param {string|undefined} rangeHeader - Raw Range header from client
 * @param {number} fileSize - Total file size in bytes
 * @returns {{ type: 'full'|'range', start: number, end: number, length: number }}
 */
export function parseRangeHeader(rangeHeader, fileSize) {
    if (typeof fileSize !== 'number' || isNaN(fileSize) || fileSize < 0 || !Number.isSafeInteger(fileSize)) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_FILE_INVALID,
            '파일 크기가 유효하지 않습니다.',
            500
        );
    }

    // 1. Full Content (Range header was not provided by client)
    if (rangeHeader === undefined || rangeHeader === null) {
        return {
            type: 'full',
            start: 0,
            end: Math.max(0, fileSize - 1),
            length: fileSize
        };
    }

    // 2. Malformed / Empty Header (Header was provided, but empty or only whitespace)
    if (typeof rangeHeader !== 'string' || rangeHeader.trim() === '') {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 헤더가 비어있거나 올바르지 않습니다.',
            416
        );
    }

    const trimmed = rangeHeader.trim();

    // Guard against excessively long range headers (denial of service / fuzzing)
    if (trimmed.length > STREAMING_LIMITS.MAX_RANGE_HEADER_LENGTH) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 헤더 길이가 허용 한도를 초과했습니다.',
            416
        );
    }

    // 2. Reject multi-part ranges (comma separated)
    if (trimmed.includes(',')) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            '다중 범위(multipart/byteranges) 요청은 지원되지 않습니다.',
            416
        );
    }

    // 3. Must start with 'bytes='
    const prefix = 'bytes=';
    if (!trimmed.startsWith(prefix)) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 단위는 bytes만 허용됩니다.',
            416
        );
    }

    const rangeSpec = trimmed.slice(prefix.length).trim();
    const dashIdx = rangeSpec.indexOf('-');
    if (dashIdx === -1) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 헤더 형식이 올바르지 않습니다.',
            416
        );
    }

    const startStr = rangeSpec.slice(0, dashIdx).trim();
    const endStr = rangeSpec.slice(dashIdx + 1).trim();

    // Empty range on both sides (e.g. "bytes=-")
    if (startStr === '' && endStr === '') {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            '유효하지 않은 Range 값입니다.',
            416
        );
    }

    // Case A: Suffix Range (e.g. "bytes=-500" - the last 500 bytes)
    if (startStr === '') {
        if (!/^\d+$/.test(endStr)) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
                'Range 접미사 값이 정수가 아닙니다.',
                416
            );
        }
        const suffixLen = Number(endStr);
        if (!Number.isSafeInteger(suffixLen) || suffixLen < 0) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
                'Range 접미사 범위가 안전 정수를 벗어났습니다.',
                416
            );
        }
        if (suffixLen === 0) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_NOT_SATISFIABLE,
                '요청한 0바이트 접미사 범위를 만족할 수 없습니다.',
                416
            );
        }

        const effectiveLen = Math.min(suffixLen, fileSize);
        const start = Math.max(0, fileSize - effectiveLen);
        const end = Math.max(0, fileSize - 1);
        return {
            type: 'range',
            start,
            end,
            length: end - start + 1
        };
    }

    // Case B: Normal range or Open-ended (e.g. "bytes=100-200" or "bytes=100-")
    if (!/^\d+$/.test(startStr)) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 시작 오프셋이 정수가 아닙니다.',
            416
        );
    }
    const start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
            'Range 시작 오프셋이 안전 정수를 벗어났습니다.',
            416
        );
    }

    // If start is at or past fileSize
    if (start >= fileSize || fileSize === 0) {
        throw new AudioStreamingError(
            STREAMING_ERROR_CODES.AUDIO_RANGE_NOT_SATISFIABLE,
            '요청한 Range 시작 위치가 파일 크기를 초과합니다.',
            416
        );
    }

    let end;
    if (endStr === '') {
        // Open-ended: bytes=start-
        end = fileSize - 1;
    } else {
        if (!/^\d+$/.test(endStr)) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
                'Range 종료 오프셋이 정수가 아닙니다.',
                416
            );
        }
        end = Number(endStr);
        if (!Number.isSafeInteger(end) || end < 0) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
                'Range 종료 오프셋이 안전 정수를 벗어났습니다.',
                416
            );
        }
        if (end < start) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RANGE_INVALID,
                'Range 종료 위치가 시작 위치보다 작습니다.',
                416
            );
        }
        // If end exceeds file boundary, RFC 7233 truncates end to fileSize - 1
        if (end >= fileSize) {
            end = fileSize - 1;
        }
    }

    return {
        type: 'range',
        start,
        end,
        length: end - start + 1
    };
}

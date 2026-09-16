/**
 * server/joycall-intake/joyCallIntakeValidator.js
 * Invariant checks and validation for files arriving at NAS intake.
 */

import path from 'path';
import fs from 'fs';
import { detectAudioSignature } from '../audio-intake/audioSignatureDetector.js';
import {
    JOYCALL_INTAKE_DEFAULTS,
    JOYCALL_INTAKE_CHECK_CODES
} from './joyCallIntakeConstants.js';
import { JoyCallIntakeError, JOYCALL_INTAKE_ERROR_CODES } from './joyCallIntakeErrors.js';

export class JoyCallIntakeValidator {
    constructor(options = {}) {
        this.minFileBytes = options.minFileBytes || JOYCALL_INTAKE_DEFAULTS.MIN_FILE_BYTES;
        this.maxFileBytes = options.maxFileBytes || JOYCALL_INTAKE_DEFAULTS.MAX_FILE_BYTES;
        this.supportedExtensions = new Set(
            (options.supportedExtensions || JOYCALL_INTAKE_DEFAULTS.SUPPORTED_EXTENSIONS).map(e => e.toLowerCase())
        );
    }

    /**
     * Check filename properties (not uploading suffix, valid extension).
     */
    validateFilename(filename) {
        if (!filename || typeof filename !== 'string') {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.INVALID_SOURCE,
                '유효하지 않은 파일 이름입니다.'
            );
        }

        const lower = filename.toLowerCase();
        if (lower.endsWith('.uploading')) {
            return {
                valid: false,
                isUploading: true,
                code: JOYCALL_INTAKE_CHECK_CODES.UPLOADING_FILE_IGNORED,
                reason: '전송 중인 임시 파일(.uploading)은 수신 대상에서 제외됩니다.'
            };
        }

        const ext = path.extname(lower);
        if (!this.supportedExtensions.has(ext)) {
            return {
                valid: false,
                isUploading: false,
                code: JOYCALL_INTAKE_CHECK_CODES.UNSUPPORTED_EXTENSION,
                reason: `지원되지 않는 파일 확장자입니다: ${ext}`
            };
        }

        return {
            valid: true,
            extension: ext
        };
    }

    /**
     * Validate file size and readability.
     */
    validateFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.FILE_NOT_FOUND,
                '파일을 찾을 수 없습니다.'
            );
        }

        const stat = fs.statSync(filePath);
        if (stat.size === 0) {
            return {
                valid: false,
                code: JOYCALL_INTAKE_CHECK_CODES.ZERO_BYTE_FILE,
                reason: '0바이트 파일은 처리할 수 없습니다.'
            };
        }

        if (stat.size < this.minFileBytes) {
            return {
                valid: false,
                code: JOYCALL_INTAKE_CHECK_CODES.FILE_TOO_SMALL,
                reason: `파일 크기가 최소 요구치(${this.minFileBytes} bytes)에 미달합니다.`
            };
        }

        if (stat.size > this.maxFileBytes) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.FILE_TOO_LARGE,
                `파일 크기가 최대 허용치(${this.maxFileBytes} bytes)를 초과합니다.`
            );
        }

        // Validate audio signature
        let fd = null;
        try {
            fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(512);
            const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
            if (bytesRead < 44) {
                return {
                    valid: false,
                    code: JOYCALL_INTAKE_CHECK_CODES.INVALID_SIGNATURE,
                    reason: '헤더 길이가 유효한 오디오 규격에 미달합니다.'
                };
            }
            const signature = detectAudioSignature(buffer.subarray(0, bytesRead));
            if (!signature || !signature.detected || signature.isDangerous) {
                return {
                    valid: false,
                    code: JOYCALL_INTAKE_CHECK_CODES.INVALID_SIGNATURE,
                    reason: signature?.reason || '유효하지 않거나 위험한 오디오 파일 시그니처입니다.'
                };
            }

            return {
                valid: true,
                size: stat.size,
                mtime: stat.mtime,
                detectedFormat: signature.format,
                canonicalMime: signature.canonicalMime
            };
        } catch (err) {
            return {
                valid: false,
                code: JOYCALL_INTAKE_CHECK_CODES.INVALID_SIGNATURE,
                reason: err.message
            };
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
        }
    }
}

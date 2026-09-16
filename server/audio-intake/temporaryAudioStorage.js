/**
 * server/audio-intake/temporaryAudioStorage.js
 * Streaming Temporary File Receiver for Mind-ERP OS Audio Intake.
 * Writes chunk-by-chunk to isolated temporary storage without loading entire files into memory.
 * Computes SHA-256 hash in-flight, enforces size limits with immediate abort, and cleans up partial files on failure.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { INTAKE_LIMITS } from './audioIntakeConstants.js';
import { AudioIntakeError, INTAKE_ERROR_CODES } from './audioIntakeErrors.js';

export class TemporaryAudioStorage {
    /**
     * @param {Object} options
     * @param {string} options.temporaryRoot - Directory for storing .part files
     * @param {string} options.quarantineRoot - Directory for isolating suspicious files
     * @param {number} [options.maxFileBytes] - Maximum allowed byte size
     */
    constructor(options = {}) {
        if (!options.temporaryRoot) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.CONFIG_MISSING,
                'temporaryRoot 경로가 설정되지 않았습니다.',
                500
            );
        }

        this.temporaryRoot = path.resolve(options.temporaryRoot);
        this.quarantineRoot = path.resolve(options.quarantineRoot || path.join(this.temporaryRoot, 'quarantine'));
        this.maxFileBytes = options.maxFileBytes || INTAKE_LIMITS.DEFAULT_MAX_FILE_BYTES;

        // Ensure directories exist
        if (!fs.existsSync(this.temporaryRoot)) {
            fs.mkdirSync(this.temporaryRoot, { recursive: true, mode: 0o700 });
        }
        if (!fs.existsSync(this.quarantineRoot)) {
            fs.mkdirSync(this.quarantineRoot, { recursive: true, mode: 0o700 });
        }
    }

    /**
     * Stream incoming Readable stream into temporary file.
     * Computes SHA-256 hash in flight and captures header buffer for signature detection.
     * 
     * @param {import('stream').Readable} readableStream - Incoming chunk stream
     * @param {string} intakeId - Unique intake UUID
     * @param {Object} [options={}] - { maxFileBytes }
     * @returns {Promise<{ temporaryStorageKey: string, absolutePath: string, fileSize: number, contentHash: string, headerBuffer: Buffer }>}
     */
    async writeStream(readableStream, intakeId, options = {}) {
        if (!readableStream || typeof readableStream.pipe !== 'function') {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.INVALID_STREAM,
                '유효한 스트림 객체가 필요합니다.',
                400
            );
        }

        const maxBytes = options.maxFileBytes || this.maxFileBytes;
        const targetFilename = `${intakeId}.part`;
        const tempPath = path.join(this.temporaryRoot, targetFilename);
        const relativeKey = `audio-intake/${targetFilename}`;

        // Ensure no overwrite of existing intake
        if (fs.existsSync(tempPath)) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.STORAGE_ERROR,
                '동일한 임시 intake 파일이 이미 존재합니다.',
                409
            );
        }

        const hash = crypto.createHash(INTAKE_LIMITS.HASH_ALGORITHM);
        const writeStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });

        let totalBytes = 0;
        let headerChunks = [];
        let headerCapturedBytes = 0;
        let isCleanedUp = false;

        const cleanupPartial = async () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            await new Promise((res) => {
                if (writeStream.destroyed && writeStream.closed) {
                    return res();
                }
                const onDone = () => res();
                writeStream.once('close', onDone);
                try {
                    writeStream.destroy();
                } catch (e) {
                    res();
                }
                setTimeout(onDone, 60);
            });

            for (let i = 0; i < 5; i++) {
                if (!fs.existsSync(tempPath)) break;
                try {
                    await fs.promises.unlink(tempPath);
                    break;
                } catch (e) {
                    await new Promise(r => setTimeout(r, 25));
                }
            }
        };

        return new Promise((resolve, reject) => {
            const onError = async (err) => {
                await cleanupPartial();
                reject(err);
            };

            readableStream.on('error', async (err) => {
                await onError(new AudioIntakeError(
                    INTAKE_ERROR_CODES.INVALID_STREAM,
                    `스트림 수신 중 오류가 발생했습니다: ${err.message}`,
                    400
                ));
            });

            writeStream.on('error', async (err) => {
                await onError(new AudioIntakeError(
                    INTAKE_ERROR_CODES.STORAGE_ERROR,
                    `임시 파일 저장 중 쓰기 오류가 발생했습니다: ${err.message}`,
                    500
                ));
            });

            readableStream.on('data', async (chunk) => {
                if (isCleanedUp) return;
                totalBytes += chunk.length;

                // Immediate abort if cumulative size exceeds limit
                if (totalBytes > maxBytes) {
                    try {
                        readableStream.pause();
                        readableStream.destroy();
                    } catch (e) {}
                    await onError(new AudioIntakeError(
                        INTAKE_ERROR_CODES.PAYLOAD_TOO_LARGE,
                        `파일 크기 제한(${maxBytes} bytes)을 초과했습니다.`,
                        413
                    ));
                    return;
                }

                // Collect header probe bytes (up to HEADER_PROBE_BYTES)
                if (headerCapturedBytes < INTAKE_LIMITS.HEADER_PROBE_BYTES) {
                    const needed = INTAKE_LIMITS.HEADER_PROBE_BYTES - headerCapturedBytes;
                    const slice = chunk.slice(0, needed);
                    headerChunks.push(slice);
                    headerCapturedBytes += slice.length;
                }

                hash.update(chunk);

                // Write to disk with backpressure handling
                const ok = writeStream.write(chunk);
                if (!ok) {
                    readableStream.pause();
                    writeStream.once('drain', () => {
                        readableStream.resume();
                    });
                }
            });

            readableStream.on('end', () => {
                writeStream.end();
            });

            writeStream.on('finish', () => {
                if (isCleanedUp) return;

                const contentHash = hash.digest('hex').toLowerCase();
                const headerBuffer = Buffer.concat(headerChunks);

                resolve({
                    temporaryStorageKey: relativeKey,
                    absolutePath: tempPath,
                    fileSize: totalBytes,
                    contentHash,
                    headerBuffer
                });
            });
        });
    }

    /**
     * Quarantine a suspicious file (moves .part to quarantine directory).
     * 
     * @param {string} intakeId
     * @returns {Promise<{ quarantineStorageKey: string }>}
     */
    async quarantineFile(intakeId) {
        const sourcePath = path.join(this.temporaryRoot, `${intakeId}.part`);
        if (!fs.existsSync(sourcePath)) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.STORAGE_ERROR,
                '격리 대상 임시 파일이 존재하지 않습니다.',
                404
            );
        }

        const quarantineFilename = `${intakeId}.quarantine`;
        const destPath = path.join(this.quarantineRoot, quarantineFilename);

        try {
            await fs.promises.rename(sourcePath, destPath);
            return {
                quarantineStorageKey: `audio-intake/quarantine/${quarantineFilename}`
            };
        } catch (e) {
            throw new AudioIntakeError(
                INTAKE_ERROR_CODES.QUARANTINE_ERROR,
                `격리 저장소 이동 실패: ${e.message}`,
                500
            );
        }
    }

    /**
     * Safely delete an intake's temporary file.
     * 
     * @param {string} intakeId
     */
    async removeTemporaryFile(intakeId) {
        if (!intakeId) return false;
        const targetPath = path.join(this.temporaryRoot, `${intakeId}.part`);
        if (fs.existsSync(targetPath)) {
            try {
                await fs.promises.unlink(targetPath);
                return true;
            } catch (e) {
                return false;
            }
        }
        return false;
    }
}

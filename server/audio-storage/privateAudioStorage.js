/**
 * server/audio-storage/privateAudioStorage.js
 * Core Storage Engine for Permanent Private Audio Storage in Mind-ERP OS.
 * Handles atomic rename promotion, EXDEV streaming copy fallback, disk capacity checks,
 * source/target hash/size verification, and target partial isolation.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { PrivateAudioStorageError } from './privateAudioStorageErrors.js';
import {
    PROMOTION_ERROR_CODES,
    DEFAULT_STORAGE_LIMITS
} from './privateAudioStorageConstants.js';
import { resolveAndValidatePath } from './privateAudioStorageKey.js';
import { detectAudioSignature } from '../audio-intake/audioSignatureDetector.js';

export class PrivateAudioStorage {
    /**
     * @param {Object} config
     * @param {string} config.privateAudioRoot - Directory for verified permanent audio files
     * @param {string} [config.quarantineAudioRoot] - Directory for quarantined rejected files
     * @param {string} config.temporaryAudioRoot - Directory where A5 temporary .part files live
     * @param {number} [config.minimumFreeSpaceBytes] - Threshold for free disk space check
     * @param {number} [config.maxSingleFileBytes] - Max permissible single audio file bytes
     */
    constructor(config = {}) {
        if (!config || !config.privateAudioRoot) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
                'privateAudioRoot 설정이 제공되지 않았습니다.',
                500
            );
        }
        if (!config.temporaryAudioRoot) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
                'temporaryAudioRoot 설정이 제공되지 않았습니다.',
                500
            );
        }

        this.config = {
            privateAudioRoot: path.resolve(config.privateAudioRoot),
            quarantineAudioRoot: config.quarantineAudioRoot ? path.resolve(config.quarantineAudioRoot) : path.resolve(config.privateAudioRoot, '..', 'quarantine'),
            temporaryAudioRoot: path.resolve(config.temporaryAudioRoot),
            minimumFreeSpaceBytes: config.minimumFreeSpaceBytes || DEFAULT_STORAGE_LIMITS.MINIMUM_FREE_SPACE_BYTES,
            maxSingleFileBytes: config.maxSingleFileBytes || DEFAULT_STORAGE_LIMITS.MAX_SINGLE_FILE_BYTES
        };
    }

    /**
     * Verify disk capacity using fs.statfs where supported.
     * 
     * @param {number} requiredBytes
     * @returns {Promise<{ available: boolean, verified: boolean, freeBytes?: number }>}
     */
    async checkCapacity(requiredBytes = 0) {
        if (typeof fs.promises.statfs !== 'function') {
            // Platform / Node version does not support statfs
            return {
                available: true,
                verified: false,
                reason: 'fs.statfs is not available in current Node.js runtime'
            };
        }

        try {
            const stats = await fs.promises.statfs(this.config.privateAudioRoot);
            const freeBytes = Number(stats.bfree) * Number(stats.bsize);
            const needed = this.config.minimumFreeSpaceBytes + requiredBytes;

            if (freeBytes < needed) {
                return {
                    available: false,
                    verified: true,
                    freeBytes,
                    neededBytes: needed
                };
            }

            return {
                available: true,
                verified: true,
                freeBytes
            };
        } catch (err) {
            // If target directory does not exist yet, check its parent
            try {
                const parentDir = path.dirname(this.config.privateAudioRoot);
                const stats = await fs.promises.statfs(parentDir);
                const freeBytes = Number(stats.bfree) * Number(stats.bsize);
                const needed = this.config.minimumFreeSpaceBytes + requiredBytes;

                return {
                    available: freeBytes >= needed,
                    verified: true,
                    freeBytes
                };
            } catch (fallbackErr) {
                return {
                    available: true,
                    verified: false,
                    reason: `statfs failed: ${fallbackErr.message}`
                };
            }
        }
    }

    /**
     * Thoroughly validate source file before promotion.
     * 
     * @param {string} temporaryStorageKey - Relative key under temporaryAudioRoot
     * @param {string} expectedHash - Expected SHA-256 hash
     * @param {number} expectedSize - Expected file size in bytes
     * @returns {Promise<{ sourcePath: string, actualSize: number, actualHash: string, detectedFormat: string }>}
     */
    async validateSourceFile(temporaryStorageKey, expectedHash, expectedSize) {
        if (!temporaryStorageKey || typeof temporaryStorageKey !== 'string') {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_FOUND,
                '임시 오디오 저장소 키가 제공되지 않았습니다.'
            );
        }

        // Relative path sanity
        const cleanKey = temporaryStorageKey.replace(/\\/g, '/').replace(/^\/+/, '');
        if (cleanKey.includes('..') || cleanKey.includes('://') || cleanKey.includes('\0')) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_OUTSIDE_TEMP_ROOT,
                '임시 오디오 키에 허용되지 않은 경로 시퀀스가 포함되어 있습니다.'
            );
        }

        let sourcePath = path.resolve(this.config.temporaryAudioRoot, cleanKey);
        const tempRootPrefix = this.config.temporaryAudioRoot.endsWith(path.sep)
            ? this.config.temporaryAudioRoot
            : this.config.temporaryAudioRoot + path.sep;

        if (!sourcePath.startsWith(tempRootPrefix)) {
            // If cleanKey has audio-intake/ prefix and temporaryAudioRoot is already that directory
            if (cleanKey.startsWith('audio-intake/')) {
                const stripped = cleanKey.replace(/^audio-intake\//, '');
                const cand = path.resolve(this.config.temporaryAudioRoot, stripped);
                if (cand.startsWith(tempRootPrefix)) {
                    sourcePath = cand;
                }
            }
        }

        if (!sourcePath.startsWith(tempRootPrefix)) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_OUTSIDE_TEMP_ROOT,
                '임시 오디오 경로가 임시 저장소 루트 경계를 벗어났습니다.'
            );
        }

        // If direct resolve does not exist on disk, check if stripping redundant prefix resolves to the file
        if (!fs.existsSync(sourcePath) && cleanKey.startsWith('audio-intake/')) {
            const stripped = cleanKey.replace(/^audio-intake\//, '');
            const cand = path.resolve(this.config.temporaryAudioRoot, stripped);
            if (fs.existsSync(cand) && cand.startsWith(tempRootPrefix)) {
                sourcePath = cand;
            }
        }

        // 1. Existence and lstat (symlink check)
        let stat;
        try {
            stat = await fs.promises.lstat(sourcePath);
        } catch (err) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_FOUND,
                '승격 대상 임시 소스 파일을 찾을 수 없습니다.'
            );
        }

        if (stat.isSymbolicLink()) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_IS_SYMLINK,
                '심볼릭 링크는 승격 소스 파일로 허용되지 않습니다.'
            );
        }

        if (!stat.isFile()) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_REGULAR_FILE,
                '승격 대상 소스가 일반 파일이 아닙니다.'
            );
        }

        // 2. File size verification
        if (expectedSize !== undefined && stat.size !== Number(expectedSize)) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SIZE_MISMATCH,
                `소스 파일 크기(${stat.size})가 기대치(${expectedSize})와 일치하지 않습니다.`
            );
        }

        if (stat.size > this.config.maxSingleFileBytes) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SIZE_MISMATCH,
                `파일 크기가 영구 저장소 단일 파일 제한(${this.config.maxSingleFileBytes} bytes)을 초과했습니다.`
            );
        }

        // 3. Streaming SHA-256 recalculation and header signature revalidation
        const hash = crypto.createHash('sha256');
        let headerBuffer = Buffer.alloc(0);
        const MAX_HEADER_PROBE = 4096;

        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(sourcePath);
            stream.on('data', (chunk) => {
                hash.update(chunk);
                if (headerBuffer.length < MAX_HEADER_PROBE) {
                    const needed = MAX_HEADER_PROBE - headerBuffer.length;
                    headerBuffer = Buffer.concat([headerBuffer, chunk.slice(0, needed)]);
                }
            });
            stream.on('error', (err) => {
                reject(new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_REGULAR_FILE,
                    `소스 파일 스트림 읽기 오류: ${err.message}`
                ));
            });
            stream.on('end', resolve);
        });

        const actualHash = hash.digest('hex').toLowerCase();
        if (expectedHash && actualHash !== expectedHash.toLowerCase().trim()) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_HASH_MISMATCH,
                '소스 파일의 해시(SHA-256)가 등록된 contentHash와 일치하지 않습니다.'
            );
        }

        // 4. Verify Signature has not changed or corrupted
        const sig = detectAudioSignature(headerBuffer);
        if (sig.isDangerous || !sig.detected) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_SIGNATURE_CHANGED,
                '소스 파일의 오디오 시그니처가 변조되었거나 지원되지 않는 형식입니다.'
            );
        }

        return {
            sourcePath,
            actualSize: stat.size,
            actualHash,
            detectedFormat: sig.format
        };
    }

    /**
     * Promote temporary file to permanent storage key.
     * Uses atomic rename on same filesystem, or streaming copy fallback on EXDEV.
     * 
     * @param {string} temporaryStorageKey - Source key in temp root
     * @param {string} permanentStorageKey - Target key in private root
     * @param {Object} [options={}]
     * @param {string} [options.expectedHash] - Content hash
     * @param {number} [options.expectedSize] - File size in bytes
     * @param {boolean} [options.forceCopyFallback=false] - For testing EXDEV copy fallback
     * @returns {Promise<{ permanentStorageKey: string, targetPath: string, fileSize: number, contentHash: string }>}
     */
    async promoteFile(temporaryStorageKey, permanentStorageKey, options = {}) {
        // 1. Source verification
        const sourceMeta = await this.validateSourceFile(
            temporaryStorageKey,
            options.expectedHash,
            options.expectedSize
        );

        // 2. Capacity Check
        const cap = await this.checkCapacity(sourceMeta.actualSize);
        if (cap.verified && !cap.available) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_INSUFFICIENT_STORAGE,
                `영구 저장소의 디스크 여유 공간이 부족합니다 (남은 공간: ${cap.freeBytes} bytes).`,
                507
            );
        }

        // 3. Resolve and validate permanent target path
        const { resolvedPath: targetPath } = resolveAndValidatePath(
            this.config.privateAudioRoot,
            permanentStorageKey
        );

        // 4. Collision check: target destination must not already exist
        if (fs.existsSync(targetPath)) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_STORAGE_COLLISION,
                '대상 영구 저장소 키에 이미 파일이 존재합니다 (덮어쓰기 금지).'
            );
        }

        // 5. Ensure parent directory exists
        const targetDir = path.dirname(targetPath);
        await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });

        // 6. Create target partial file name
        const targetPartialPath = `${targetPath}.part_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        let usedCopyFallback = false;

        const cleanupPartial = async () => {
            if (fs.existsSync(targetPartialPath)) {
                try {
                    await fs.promises.unlink(targetPartialPath);
                } catch (ignore) {}
            }
        };

        try {
            if (options.forceCopyFallback) {
                // Simulate cross-device link error
                const exdevErr = new Error('Cross-device link simulation');
                exdevErr.code = 'EXDEV';
                throw exdevErr;
            }

            // Attempt fast atomic rename on same filesystem
            await fs.promises.rename(sourceMeta.sourcePath, targetPartialPath);
        } catch (renameErr) {
            if (renameErr.code === 'EXDEV' || options.forceCopyFallback) {
                usedCopyFallback = true;
                // Fallback: Streaming copy with backpressure and concurrent hashing
                try {
                    const readStream = fs.createReadStream(sourceMeta.sourcePath);
                    const writeStream = fs.createWriteStream(targetPartialPath, { flags: 'wx', mode: 0o600 });
                    const copyHash = crypto.createHash('sha256');

                    readStream.on('data', (c) => copyHash.update(c));

                    await pipeline(readStream, writeStream);

                    const finalCopyHash = copyHash.digest('hex').toLowerCase();
                    if (finalCopyHash !== sourceMeta.actualHash) {
                        await cleanupPartial();
                        throw new PrivateAudioStorageError(
                            PROMOTION_ERROR_CODES.AUDIO_HASH_MISMATCH,
                            '스트리밍 복사 후 대상 해시가 소스 해시와 일치하지 않습니다.'
                        );
                    }
                } catch (copyErr) {
                    await cleanupPartial();
                    throw new PrivateAudioStorageError(
                        PROMOTION_ERROR_CODES.AUDIO_PROMOTION_COPY_FAILED,
                        `EXDEV 스트리밍 복사 승격 실패: ${copyErr.message}`
                    );
                }
            } else {
                await cleanupPartial();
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.AUDIO_PROMOTION_RENAME_FAILED,
                    `임시 파일 이름 변경 승격 실패: ${renameErr.message}`
                );
            }
        }

        // 7. Verify promoted target partial file integrity
        try {
            const targetStat = await fs.promises.lstat(targetPartialPath);
            if (targetStat.size !== sourceMeta.actualSize) {
                await cleanupPartial();
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.AUDIO_SIZE_MISMATCH,
                    '승격된 파일의 크기가 소스 파일 크기와 일치하지 않습니다.'
                );
            }

            // 8. Atomic finalize: Rename partial file to final target destination
            await fs.promises.rename(targetPartialPath, targetPath);
        } catch (finalizeErr) {
            await cleanupPartial();
            if (finalizeErr instanceof PrivateAudioStorageError) throw finalizeErr;
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_PROMOTION_RENAME_FAILED,
                `최종 영구 파일 경로 확정 실패: ${finalizeErr.message}`
            );
        }

        // 9. If copy fallback was used, cleanly unlink original source after full promotion success
        if (usedCopyFallback && fs.existsSync(sourceMeta.sourcePath)) {
            try {
                await fs.promises.unlink(sourceMeta.sourcePath);
            } catch (unlinkErr) {
                console.warn('Warning: Clean up of source file after copy promotion failed:', unlinkErr.message);
            }
        }

        return {
            permanentStorageKey,
            targetPath,
            fileSize: sourceMeta.actualSize,
            contentHash: sourceMeta.actualHash,
            usedCopyFallback
        };
    }
}

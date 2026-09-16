/**
 * server/audio-streaming/privateAudioAccessService.js
 * Secure Read Access Service for Verified Permanent Private Audio Files.
 * Enforces Option A root semantics, fail-closed configuration, symlink denial, and verified MIME mapping.
 */

import fs from 'fs';
import path from 'path';
import { resolveAndValidatePath } from '../audio-storage/privateAudioStorageKey.js';
import { STREAMING_ERROR_CODES, SUPPORTED_AUDIO_MIMES } from './audioStreamingConstants.js';
import { AudioStreamingError } from './audioStreamingErrors.js';
import { PROCESSING_STATUS } from '../voice-calls/voiceCallConstants.js';

export class PrivateAudioAccessService {
    /**
     * @param {Object} [config={}]
     * @param {string} [config.storageRoot] - Base parent directory containing private-audio/
     * @param {string} [config.privateAudioRoot] - Direct or base root (normalized safely)
     * @param {boolean} [config.available=true] - Subsystem availability flag
     */
    constructor(config = {}) {
        this.available = config.available !== false;
        const rawRoot = config.storageRoot || config.privateAudioRoot;

        if (!rawRoot) {
            this.available = false;
            this.storageRoot = null;
            this.privateAudioRoot = null;
            this.unavailableReason = 'Storage root directory not configured.';
            return;
        }

        this.storageRoot = path.resolve(rawRoot);
        this.privateAudioRoot = this.storageRoot;
    }

    /**
     * Inspect and validate that a VoiceCall is fully eligible and its audio file is safe on disk.
     * 
     * @param {Object} call - VoiceCall domain record
     * @returns {Promise<{ resolvedPath: string, fileSize: number, mimeType: string, extension: string, verifiedFormat: string }>}
     */
    async validateEligibleAudio(call) {
        if (!this.available || !this.storageRoot) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_STORAGE_UNAVAILABLE,
                '오디오 저장소가 구성되지 않았거나 일시적으로 사용 불가능합니다.',
                503
            );
        }

        if (!call || typeof call !== 'object') {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND,
                '요청한 음성통화 레코드가 존재하지 않습니다.',
                404
            );
        }

        // 1. Lifecycle Eligibility Checks
        if (call.isDeleted) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND,
                '삭제된 음성통화 레코드입니다.',
                404
            );
        }

        if (call.processingStatus === PROCESSING_STATUS.REJECTED || call.mediaValidationStage === 'rejected') {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_NOT_AVAILABLE,
                '거부된 음성통화는 스트리밍할 수 없습니다.',
                403
            );
        }

        if (call.storagePromotionStatus !== 'linked' || !call.storageKey) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_STORAGE_NOT_LINKED,
                '오디오 파일이 아직 영구 저장소에 승격/연결되지 않았습니다.',
                409
            );
        }

        if (!call.storageKey.startsWith('private-audio/')) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_NOT_AVAILABLE,
                '유효하지 않은 영구 저장소 키입니다.',
                403
            );
        }

        // 2. Storage Key and Path Confinement (Option A resolution)
        let resolvedPath;
        try {
            const res = resolveAndValidatePath(this.storageRoot, call.storageKey);
            resolvedPath = res.resolvedPath;
        } catch (keyErr) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_FILE_INVALID,
                '저장소 키 검증에 실패했습니다.',
                400
            );
        }

        // 3. Intermediate Path Traversal / Symlink Check
        await this._assertNoIntermediateSymlinks(this.storageRoot, resolvedPath);

        // 4. Target File Lstat Check
        let stat;
        try {
            stat = await fs.promises.lstat(resolvedPath);
        } catch (ioErr) {
            if (ioErr.code === 'ENOENT') {
                throw new AudioStreamingError(
                    STREAMING_ERROR_CODES.AUDIO_FILE_MISSING,
                    '저장소에 오디오 파일이 존재하지 않습니다.',
                    404
                );
            }
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_STREAM_FAILED,
                '오디오 파일 상태를 확인할 수 없습니다.',
                500
            );
        }

        if (stat.isSymbolicLink()) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_FILE_IS_SYMLINK,
                '심볼릭 링크 파일은 스트리밍이 금지됩니다.',
                403
            );
        }

        if (!stat.isFile()) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_FILE_NOT_REGULAR,
                '대상 파일이 일반 파일이 아닙니다.',
                403
            );
        }

        // 5. Size Validation
        if (call.fileSize !== undefined && call.fileSize !== null) {
            const expectedSize = Number(call.fileSize);
            if (stat.size !== expectedSize) {
                throw new AudioStreamingError(
                    STREAMING_ERROR_CODES.AUDIO_SIZE_MISMATCH,
                    '디스크 오디오 파일 크기가 등록된 메타데이터와 불일치합니다.',
                    500
                );
            }
        }

        // 6. Resolve Verified MIME Policy (Strictly server verified format; never client declared)
        const ext = path.extname(resolvedPath).replace(/^\./, '').toLowerCase();
        const verifiedFormat = call.verifiedFormat ? String(call.verifiedFormat).toLowerCase() : ext;

        if (ext !== verifiedFormat) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_FILE_INVALID,
                '저장된 파일 확장자와 검증된 오디오 형식이 불일치합니다.',
                415
            );
        }

        const mimeType = SUPPORTED_AUDIO_MIMES[verifiedFormat];
        if (!mimeType) {
            throw new AudioStreamingError(
                STREAMING_ERROR_CODES.AUDIO_FILE_INVALID,
                '지원되지 않는 오디오 미디어 타입입니다.',
                415
            );
        }

        return {
            resolvedPath,
            fileSize: stat.size,
            mimeType,
            extension: ext,
            verifiedFormat
        };
    }

    /**
     * Open a node ReadStream for the audio file at the specified byte range.
     * 
     * @param {Object} call - VoiceCall record
     * @param {{ start: number, end: number }} range
     * @returns {Promise<{ stream: import('fs').ReadStream, fileSize: number, mimeType: string, extension: string }>}
     */
    async openReadStream(call, range = {}) {
        const meta = await this.validateEligibleAudio(call);
        const { start, end } = range;

        const streamOptions = {
            autoClose: true
        };
        if (typeof start === 'number') streamOptions.start = start;
        if (typeof end === 'number') streamOptions.end = end;

        const stream = fs.createReadStream(meta.resolvedPath, streamOptions);
        return {
            stream,
            fileSize: meta.fileSize,
            mimeType: meta.mimeType,
            extension: meta.extension
        };
    }

    /**
     * Inspect intermediate path directories ensuring none are symlinks.
     * @private
     */
    async _assertNoIntermediateSymlinks(root, targetPath) {
        let effectiveRoot = root;
        const rootBase = path.basename(effectiveRoot);
        if (rootBase === 'private-audio' || rootBase === 'quarantine') {
            effectiveRoot = path.dirname(effectiveRoot);
        }

        // 1. Check storageRoot itself
        try {
            const rootStat = await fs.promises.lstat(effectiveRoot);
            if (rootStat.isSymbolicLink()) {
                throw new AudioStreamingError(
                    STREAMING_ERROR_CODES.AUDIO_FILE_IS_SYMLINK,
                    '저장소 루트 디렉터리가 심볼릭 링크입니다.',
                    403
                );
            }
        } catch (e) {
            if (e instanceof AudioStreamingError) throw e;
        }

        // 2. Check each intermediate directory segment
        const rel = path.relative(effectiveRoot, targetPath);
        const segments = rel.split(path.sep);

        let current = effectiveRoot;
        for (let i = 0; i < segments.length - 1; i++) {
            current = path.join(current, segments[i]);
            try {
                const segStat = await fs.promises.lstat(current);
                if (segStat.isSymbolicLink()) {
                    throw new AudioStreamingError(
                        STREAMING_ERROR_CODES.AUDIO_FILE_IS_SYMLINK,
                        '오디오 경로의 상위 디렉터리가 심볼릭 링크입니다.',
                        403
                    );
                }
            } catch (err) {
                if (err instanceof AudioStreamingError) throw err;
            }
        }
    }
}

/**
 * server/audio-storage/audioPromotionCoordinator.js
 * Safe Audio Promotion Coordinator for Mind-ERP OS.
 * Orchestrates promotion from temporary .part storage to permanent private audio storage.
 * Enforces single-call lock, idempotency, pending-state tracking, and error boundaries.
 */

import path from 'path';
import { PrivateAudioStorageError } from './privateAudioStorageErrors.js';
import { PROMOTION_ERROR_CODES } from './privateAudioStorageConstants.js';
import { generatePermanentStorageKey, resolveAndValidatePath } from './privateAudioStorageKey.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';
import {
    PROCESSING_STATUS,
    INTAKE_VALIDATION_STATUS
} from '../voice-calls/voiceCallConstants.js';

export class AudioPromotionCoordinator {
    /**
     * @param {Object} deps
     * @param {import('./privateAudioStorage.js').PrivateAudioStorage} deps.audioStorage
     * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepo
     */
    constructor(deps = {}) {
        if (!deps.audioStorage) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
                'audioStorage 의존성이 누락되었습니다.',
                500
            );
        }
        if (!deps.voiceCallRepo) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.AUDIO_STORAGE_KEY_INVALID,
                'voiceCallRepo 의존성이 누락되었습니다.',
                500
            );
        }

        this.audioStorage = deps.audioStorage;
        this.voiceCallRepo = deps.voiceCallRepo;
    }

    /**
     * Promote temporary audio intake file to permanent private audio storage.
     * 
     * @param {string} callId - VoiceCall ID
     * @param {Object} [options={}]
     * @param {string} [options.temporaryStorageKey] - Explicit temporary key
     * @param {string} [options.verifiedExtension] - Target extension ('wav', 'mp3', 'm4a')
     * @param {number} [options.expectedVersion] - OCC version expectation
     * @param {boolean} [options.forceCopyFallback] - Force EXDEV copy fallback for testing
     * @returns {Promise<Object>} Promotion result
     */
    async promoteCallAudio(callId, options = {}) {
        if (!callId) {
            throw new PrivateAudioStorageError(
                PROMOTION_ERROR_CODES.CALL_NOT_FOUND,
                '승격 대상 callId가 제공되지 않았습니다.'
            );
        }

        // Shared lock keyed by callId to strictly prevent concurrent promotions for the same call
        const lockKey = `promotion_call_${callId}`;

        return withFileLock(lockKey, async () => {
            // 1. Fetch VoiceCall record
            const call = this.voiceCallRepo.findById(callId);
            if (!call) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.CALL_NOT_FOUND,
                    `ID [${callId}]에 해당하는 통화 레코드를 찾을 수 없습니다.`,
                    404
                );
            }

            if (call.isDeleted) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.INVALID_CALL_STATE,
                    '삭제된 통화 레코드는 오디오 승격을 진행할 수 없습니다.'
                );
            }

            // 2. Reject disallowed states
            if (call.processingStatus === PROCESSING_STATUS.REJECTED) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.INVALID_CALL_STATE,
                    '거부(rejected)된 통화는 정상 영구 오디오 저장소로 승격할 수 없습니다.'
                );
            }

            // A6 Promotion requires validating status with valid validationStatus
            if (call.processingStatus !== PROCESSING_STATUS.VALIDATING || call.validationStatus !== INTAKE_VALIDATION_STATUS.VALID) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.INVALID_CALL_STATE,
                    `승격 가능한 상태(validating & valid)가 아닙니다. 현재: [${call.processingStatus}/${call.validationStatus}]`
                );
            }

            // 3. Idempotency Check: Already successfully promoted
            if (call.storagePromotionStatus === 'linked' && call.storageKey && call.storageKey.startsWith('private-audio/')) {
                // Verify physical existence of permanent file
                try {
                    const { resolvedPath: permPath } = resolveAndValidatePath(this.audioStorage.config.privateAudioRoot, call.storageKey);
                    if (await this._pathExists(permPath)) {
                        return {
                            status: 'already_promoted',
                            callId: call.id,
                            storageKey: call.storageKey,
                            version: call.version,
                            idempotent: true
                        };
                    }
                } catch (ignore) {}
            }

            // 4. Resolve source temporary storage key
            const tempKey = options.temporaryStorageKey || (call.storageKey && !call.storageKey.startsWith('private-audio/') ? call.storageKey : null);
            if (!tempKey) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.AUDIO_SOURCE_NOT_FOUND,
                    '승격할 임시 오디오 저장소 키(temporaryStorageKey)를 확인할 수 없습니다.'
                );
            }

            // 5. Determine verified extension
            let ext = options.verifiedExtension;
            if (!ext) {
                if (call.mimeType === 'audio/wav' || call.mimeType === 'audio/x-wav') ext = 'wav';
                else if (call.mimeType === 'audio/mpeg' || call.mimeType === 'audio/mp3') ext = 'mp3';
                else if (call.mimeType === 'audio/mp4' || call.mimeType === 'audio/x-m4a') ext = 'm4a';
                else if (call.originalFileName && call.originalFileName.includes('.')) {
                    ext = call.originalFileName.split('.').pop().toLowerCase();
                }
            }
            if (!ext || !['wav', 'mp3', 'm4a'].includes(ext)) {
                ext = 'wav'; // Safe fallback
            }

            // 6. Generate canonical permanent storage key
            const permStorageKey = generatePermanentStorageKey(call.id, ext);
            const audioObjectId = permStorageKey.split('/').pop().split('.')[0];

            // 7. Option B linking step 1: Set pendingStorageKey on VoiceCall
            const expVersion = options.expectedVersion !== undefined ? options.expectedVersion : call.version;
            let pendingCall;
            try {
                pendingCall = await this.voiceCallRepo.setPendingStoragePromotion(call.id, expVersion, permStorageKey);
            } catch (occErr) {
                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.CONCURRENT_PROMOTION_CONFLICT,
                    `승격 전 상태 갱신 충돌: ${occErr.message}`,
                    409
                );
            }

            // 8. Execute disk file promotion
            let promoReceipt;
            try {
                promoReceipt = await this.audioStorage.promoteFile(tempKey, permStorageKey, {
                    expectedHash: call.contentHash,
                    expectedSize: call.fileSize,
                    forceCopyFallback: options.forceCopyFallback
                });
            } catch (promoErr) {
                // Mark promotion failed in metadata
                try {
                    await this.voiceCallRepo.failStoragePromotion(call.id, pendingCall.version, {
                        reason: promoErr.message,
                        incomplete: true
                    });
                } catch (ignore) {}
                throw promoErr;
            }

            // 9. Option B linking step 2: Finalize VoiceCall.storageKey and clear pendingStorageKey
            let finalizedCall;
            try {
                finalizedCall = await this.voiceCallRepo.completeStoragePromotion(call.id, pendingCall.version, {
                    storageKey: permStorageKey,
                    storageObjectId: audioObjectId
                });
            } catch (linkErr) {
                // Disk file was promoted, but metadata linking failed: leave incomplete record for reconciliation
                try {
                    await this.voiceCallRepo.failStoragePromotion(call.id, pendingCall.version, {
                        reason: `디스크 승격 성공 후 메타데이터 연결 실패: ${linkErr.message}`,
                        incomplete: true
                    });
                } catch (ignore) {}

                throw new PrivateAudioStorageError(
                    PROMOTION_ERROR_CODES.AUDIO_METADATA_LINK_FAILED,
                    `오디오 승격 후 통화 레코드 연결에 실패했습니다: ${linkErr.message}`,
                    500
                );
            }

            return {
                status: 'promoted',
                callId: finalizedCall.id,
                storageKey: finalizedCall.storageKey,
                storagePromotionStatus: finalizedCall.storagePromotionStatus, // 'linked'
                version: finalizedCall.version,
                fileSize: promoReceipt.fileSize,
                contentHash: promoReceipt.contentHash,
                usedCopyFallback: promoReceipt.usedCopyFallback,
                promotedAt: finalizedCall.storagePromotedAt
            };
        });
    }

    async _pathExists(p) {
        try {
            await import('fs').then(f => f.promises.access(p));
            return true;
        } catch (e) {
            return false;
        }
    }
}

/**
 * server/voice-calls/summaryReviewRepository.js
 * Human Review Storage for Mind-ERP OS Voice Calls.
 * Separates AI snapshot from human-edited summaries to ensure audit reproducibility.
 * Enforces OCC, snapshot immutability, and length limits without leaking sensitive text.
 */

import crypto from 'crypto';
import { REVIEW_STATUS, DOMAIN_LIMITS, ERROR_CODES } from './voiceCallConstants.js';
import { validateSummaryReviewLimits, isValidIsoDate, deepClone } from './voiceCallValidator.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

const STORAGE_FILE = 'VoiceCallSummaryReviews';

export class SummaryReviewRepository {
    /**
     * @param {Function} getDataFn
     * @param {Function} persistDataFn
     * @param {Object} [deps={}] - { revisionRepo, voiceCallRepo }
     */
    constructor(getDataFn, persistDataFn, deps = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.revisionRepo = deps.revisionRepo || null;
        this.voiceCallRepo = deps.voiceCallRepo || null;
        this.isCorrupted = false;
    }

    setDependencies(deps = {}) {
        if (deps.revisionRepo) this.revisionRepo = deps.revisionRepo;
        if (deps.voiceCallRepo) this.voiceCallRepo = deps.voiceCallRepo;
    }

    resetCorruptionState() {
        try {
            const reviews = this.getData(STORAGE_FILE, null);
            if (!Array.isArray(reviews)) {
                this.isCorrupted = true;
                throw new Error('복구 실패: 저장소 데이터가 올바른 배열 형식이 아닙니다.');
            }
            for (const r of reviews) {
                if (!r || typeof r !== 'object' || Array.isArray(r)) {
                    this.isCorrupted = true;
                    throw new Error('복구 실패: 저장소 항목에 유효하지 않은 데이터가 포함되어 있습니다.');
                }
            }
            this.isCorrupted = false;
            return { recovered: true, count: reviews.length };
        } catch (err) {
            this.isCorrupted = true;
            throw err;
        }
    }

    _getAllReviews() {
        if (this.isCorrupted) return null;
        try {
            const reviews = this.getData(STORAGE_FILE, []);
            if (!Array.isArray(reviews)) {
                throw new Error('SummaryReviews data is not an array');
            }
            return reviews;
        } catch (err) {
            this.isCorrupted = true;
            console.error('❌ [SUMMARY_REVIEWS_CORRUPTION] Storage corrupted:', err.message);
            return null;
        }
    }

    /**
     * Create initial review record linked to an AI revision.
     */
    async createReview(data) {
        return withFileLock(STORAGE_FILE, async () => {
            if (!data || !data.callId || !data.processingRevisionId) {
                throw new Error('callId와 processingRevisionId는 필수입니다.');
            }

            if (!data.reviewedBy || typeof data.reviewedBy !== 'string' || data.reviewedBy.trim() === '') {
                const err = new Error('검토자(reviewedBy) 정보가 필수입니다.');
                err.code = ERROR_CODES.INVARIANT_VIOLATION;
                err.status = 400;
                throw err;
            }

            // Validate callId matches the revision's callId if revisionRepo is available (NO bypass)
            if (this.revisionRepo) {
                const rev = this.revisionRepo.findById(data.processingRevisionId);
                if (rev && rev.callId !== String(data.callId)) {
                    const err = new Error('검토 대상 리비전의 통화 ID가 일치하지 않습니다.');
                    err.code = ERROR_CODES.INVARIANT_VIOLATION;
                    err.status = 400;
                    throw err;
                }
            }

        const reviews = this._getAllReviews();
        if (this.isCorrupted || reviews === null) {
            const err = new Error('리뷰 저장소가 일시적으로 사용 불가능합니다.');
            err.code = ERROR_CODES.STORAGE_UNAVAILABLE;
            err.status = 503;
            throw err;
        }

        // Validate limits without leaking raw strings
        validateSummaryReviewLimits(data);

        const nowIso = new Date().toISOString();
        const id = crypto.randomUUID();

        const newReview = {
            id,
            callId: String(data.callId),
            processingRevisionId: String(data.processingRevisionId),
            aiSummarySnapshot: String(data.aiSummarySnapshot || ''),
            reviewedSummary: String(data.reviewedSummary !== undefined ? data.reviewedSummary : (data.aiSummarySnapshot || '')),
            aiKeyPointsSnapshot: Array.isArray(data.aiKeyPointsSnapshot) ? data.aiKeyPointsSnapshot.map(String) : [],
            reviewedKeyPoints: Array.isArray(data.reviewedKeyPoints)
                ? data.reviewedKeyPoints.map(String)
                : (Array.isArray(data.aiKeyPointsSnapshot) ? data.aiKeyPointsSnapshot.map(String) : []),
            aiRequestedActionsSnapshot: Array.isArray(data.aiRequestedActionsSnapshot) ? data.aiRequestedActionsSnapshot.map(String) : [],
            reviewedRequestedActions: Array.isArray(data.reviewedRequestedActions)
                ? data.reviewedRequestedActions.map(String)
                : (Array.isArray(data.aiRequestedActionsSnapshot) ? data.aiRequestedActionsSnapshot.map(String) : []),
            reviewStatus: data.reviewStatus || REVIEW_STATUS.IN_REVIEW,
            reviewedBy: String(data.reviewedBy).trim(),
            reviewedAt: data.reviewedAt || nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            version: 1
        };

        const updatedList = [...reviews, deepClone(newReview)];
        await this.persistData(STORAGE_FILE, updatedList);

        return deepClone(newReview);
        });
    }

    /**
     * Update existing review with version check and snapshot immutability.
     */
    async updateReview(id, expectedVersion, updates = {}) {
        return withFileLock(STORAGE_FILE, async () => {
            if (!id) throw new Error('id가 누락되었습니다.');

            const reviews = this._getAllReviews();
            if (this.isCorrupted || reviews === null) {
                const err = new Error('리뷰 저장소가 일시적으로 사용 불가능합니다.');
                err.code = ERROR_CODES.STORAGE_UNAVAILABLE;
                err.status = 503;
                throw err;
            }

            const index = reviews.findIndex(r => r && r.id === String(id));
            if (index === -1) {
                const err = new Error('해당 리뷰를 찾을 수 없습니다.');
                err.code = ERROR_CODES.NOT_FOUND;
                err.status = 404;
                throw err;
            }

            const current = reviews[index];

            // Optimistic concurrency check
            if (expectedVersion !== undefined && expectedVersion !== null) {
                if (Number(current.version) !== Number(expectedVersion)) {
                    const err = new Error('다른 작업자에 의해 변경되었습니다.');
                    err.code = ERROR_CODES.VERSION_CONFLICT;
                    err.status = 409;
                    err.currentVersion = current.version;
                    throw err;
                }
            }

            // Snapshot Immutability Check: Clients cannot alter snapshots
            const SNAPSHOT_FIELDS = ['aiSummarySnapshot', 'aiKeyPointsSnapshot', 'aiRequestedActionsSnapshot'];
            for (const sf of SNAPSHOT_FIELDS) {
                if (updates[sf] !== undefined && JSON.stringify(updates[sf]) !== JSON.stringify(current[sf])) {
                    const err = new Error(`AI 초안 스냅샷 [${sf}] 필드는 수정할 수 없습니다.`);
                    err.code = ERROR_CODES.INVARIANT_VIOLATION;
                    err.status = 400;
                    throw err;
                }
            }

            // Validate limits on modified fields
            validateSummaryReviewLimits(updates);

            // Staff editable allowlist
            const cleanUpdates = {};
            if (updates.reviewedSummary !== undefined) cleanUpdates.reviewedSummary = String(updates.reviewedSummary);
            if (updates.reviewedKeyPoints !== undefined && Array.isArray(updates.reviewedKeyPoints)) {
                cleanUpdates.reviewedKeyPoints = updates.reviewedKeyPoints.map(String);
            }
            if (updates.reviewedRequestedActions !== undefined && Array.isArray(updates.reviewedRequestedActions)) {
                cleanUpdates.reviewedRequestedActions = updates.reviewedRequestedActions.map(String);
            }
            if (updates.reviewStatus !== undefined) cleanUpdates.reviewStatus = updates.reviewStatus;
            if (updates.reviewedBy !== undefined) cleanUpdates.reviewedBy = String(updates.reviewedBy).trim();
            if (updates.reviewedAt !== undefined) cleanUpdates.reviewedAt = updates.reviewedAt;

            const nowIso = new Date().toISOString();
            const updated = {
                ...deepClone(current),
                ...cleanUpdates,
                id: current.id,
                callId: current.callId,
                processingRevisionId: current.processingRevisionId,
                aiSummarySnapshot: current.aiSummarySnapshot,
                aiKeyPointsSnapshot: current.aiKeyPointsSnapshot,
                aiRequestedActionsSnapshot: current.aiRequestedActionsSnapshot,
                version: (current.version || 1) + 1,
                updatedAt: nowIso
            };

            const updatedList = [...reviews];
            updatedList[index] = deepClone(updated);
            await this.persistData(STORAGE_FILE, updatedList);

            return deepClone(updated);
        });
    }

    findByCallId(callId) {
        if (!callId) return [];
        const reviews = this._getAllReviews();
        if (this.isCorrupted || reviews === null) return [];
        return reviews.filter(r => r && r.callId === String(callId)).map(r => deepClone(r));
    }

    findById(id) {
        if (!id) return null;
        const reviews = this._getAllReviews();
        if (this.isCorrupted || reviews === null) return null;
        const match = reviews.find(r => r && r.id === String(id));
        return match ? deepClone(match) : null;
    }
}

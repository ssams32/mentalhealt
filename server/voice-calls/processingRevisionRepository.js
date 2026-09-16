/**
 * server/voice-calls/processingRevisionRepository.js
 * AI Processing Revision Storage for Mind-ERP OS.
 * Preserves AI lineage and re-run history without overwriting prior revision records.
 * Uses Dependency Injection for getData / persistData and serializes concurrent revision creations.
 */

import crypto from 'crypto';
import { CALL_CATEGORY, DIARIZATION_MODE, DOMAIN_LIMITS, ERROR_CODES } from './voiceCallConstants.js';
import { validateRevisionLimits, deepClone } from './voiceCallValidator.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

const STORAGE_FILE = 'VoiceCallProcessingRevisions';

export class ProcessingRevisionRepository {
    /**
     * @param {Function} getDataFn
     * @param {Function} persistDataFn
     * @param {Object} [deps={}] - { voiceCallRepo }
     */
    constructor(getDataFn, persistDataFn, deps = {}) {
        if (typeof getDataFn !== 'function' || typeof persistDataFn !== 'function') {
            throw new Error('getDataFn and persistDataFn must be injected as functions');
        }
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.voiceCallRepo = deps.voiceCallRepo || null;
        this.isCorrupted = false;
    }

    setVoiceCallRepository(repo) {
        this.voiceCallRepo = repo;
    }

    /**
     * Operator recovery: resets corruption state ONLY after verifying the store is valid.
     */
    resetCorruptionState() {
        try {
            const revisions = this.getData(STORAGE_FILE, null);
            if (!Array.isArray(revisions)) {
                this.isCorrupted = true;
                throw new Error('복구 실패: 저장소 데이터가 올바른 배열 형식이 아닙니다.');
            }
            for (const r of revisions) {
                if (!r || typeof r !== 'object' || Array.isArray(r)) {
                    this.isCorrupted = true;
                    throw new Error('복구 실패: 저장소 항목에 유효하지 않은 데이터가 포함되어 있습니다.');
                }
            }
            this.isCorrupted = false;
            return { recovered: true, count: revisions.length };
        } catch (err) {
            this.isCorrupted = true;
            throw err;
        }
    }

    _getAllRevisions() {
        if (this.isCorrupted) return null;
        try {
            const revisions = this.getData(STORAGE_FILE, []);
            if (!Array.isArray(revisions)) {
                throw new Error('ProcessingRevisions data is not an array');
            }
            return revisions;
        } catch (err) {
            this.isCorrupted = true;
            console.error('❌ [PROCESSING_REVISIONS_CORRUPTION] Storage corrupted, fail-closed:', err.message);
            return null;
        }
    }

    /**
     * Create a new processing revision for a call.
     * Concurrency-safe across instances using withFileLock.
     */
    async createRevision(data) {
        return withFileLock(STORAGE_FILE, async () => {
            return this._executeCreateRevision(data);
        });
    }

    async _executeCreateRevision(data) {
        if (!data || !data.callId) {
            throw new Error('callId가 누락되었습니다.');
        }

        // Check voice call existence if repo is available (NO bypasses permitted)
        if (this.voiceCallRepo) {
            const call = this.voiceCallRepo.findById(data.callId, { includeDeleted: true });
            if (!call) {
                const err = new Error(`존재하지 않는 통화 [${data.callId}]에 대한 리비전을 생성할 수 없습니다.`);
                err.code = ERROR_CODES.NOT_FOUND;
                err.status = 404;
                throw err;
            }
        }

        const revisions = this._getAllRevisions();
        if (this.isCorrupted || revisions === null) {
            const err = new Error('처리 리비전 저장소가 일시적으로 사용 불가능합니다.');
            err.code = ERROR_CODES.STORAGE_UNAVAILABLE;
            err.status = 503;
            throw err;
        }

        // Validate limits against DOMAIN_LIMITS
        validateRevisionLimits(data);

        // Validate confidence range
        if (data.classificationConfidence !== undefined) {
            if (typeof data.classificationConfidence !== 'number' || data.classificationConfidence < 0 || data.classificationConfidence > 1) {
                const err = new Error('분류 신뢰도는 0과 1 사이여야 합니다.');
                err.code = ERROR_CODES.VALIDATION_FAILED;
                err.status = 400;
                throw err;
            }
        }

        // Validate category
        if (data.callCategory && !Object.values(CALL_CATEGORY).includes(data.callCategory)) {
            const err = new Error('유효하지 않은 통화 분류 카테고리입니다.');
            err.code = ERROR_CODES.VALIDATION_FAILED;
            err.status = 400;
            throw err;
        }

        // Compute next revision number strictly for this callId
        const existingCallRevisions = revisions.filter(r => r && r.callId === String(data.callId));
        const maxRevision = existingCallRevisions.reduce((max, r) => Math.max(max, r.revisionNumber || 0), 0);
        const nextRevisionNumber = maxRevision + 1;

        const nowIso = new Date().toISOString();
        const id = crypto.randomUUID();

        // If newly created revision is active, mark all previous revisions for this call as 'superseded'
        const shouldBeActive = data.status === 'active' || existingCallRevisions.length === 0;

        const newRevision = {
            id,
            callId: String(data.callId),
            revisionNumber: nextRevisionNumber,
            status: shouldBeActive ? 'active' : (data.status || 'draft'),
            sttEngine: String(data.sttEngine || 'synthesized'),
            sttModel: String(data.sttModel || 'whisper-synth'),
            sttModelDigest: data.sttModelDigest || undefined,
            llmProvider: String(data.llmProvider || 'synthesized'),
            llmModel: String(data.llmModel || 'ollama-synth'),
            llmModelDigest: data.llmModelDigest || undefined,
            promptId: String(data.promptId || 'clinical_v1'),
            promptVersion: String(data.promptVersion || '1.0.0'),
            schemaVersion: String(data.schemaVersion || '1.0.0'),
            callCategory: data.callCategory || CALL_CATEGORY.UNKNOWN,
            classificationConfidence: data.classificationConfidence !== undefined ? Number(data.classificationConfidence) : 0,
            requiresHumanReview: Boolean(data.requiresHumanReview ?? true),
            aiSummary: String(data.aiSummary || ''),
            aiKeyPoints: Array.isArray(data.aiKeyPoints) ? data.aiKeyPoints.map(String) : [],
            aiRequestedActions: Array.isArray(data.aiRequestedActions) ? data.aiRequestedActions.map(String) : [],
            safetyFlags: Array.isArray(data.safetyFlags) ? data.safetyFlags.map(String) : [],
            recommendedDepartmentId: data.recommendedDepartmentId || undefined,
            recommendedAssigneeId: data.recommendedAssigneeId || undefined,
            detectedLanguage: data.detectedLanguage || 'ko',
            diarizationMode: data.diarizationMode || DIARIZATION_MODE.NONE,
            validationResult: data.validationResult || 'pass',
            validationErrors: Array.isArray(data.validationErrors)
                ? data.validationErrors.map(e => ({ field: String(e.field || ''), message: String(e.message || '') }))
                : undefined,
            retryCount: Number(data.retryCount || 0),
            startedAt: data.startedAt || nowIso,
            completedAt: data.completedAt || nowIso,
            createdAt: nowIso
        };

        const updatedList = revisions.map(r => {
            if (shouldBeActive && r && r.callId === String(data.callId) && r.status === 'active') {
                return { ...r, status: 'superseded' };
            }
            return r;
        });

        updatedList.push(newRevision);

        // Check storage size warning threshold
        const estimatedBytes = JSON.stringify(updatedList).length;
        if (estimatedBytes > DOMAIN_LIMITS.STORAGE_SIZE_WARNING_BYTES) {
            console.warn(`⚠️ [STORAGE_SIZE_WARNING] VoiceCallProcessingRevisions.json (${estimatedBytes} bytes) exceeds threshold (${DOMAIN_LIMITS.STORAGE_SIZE_WARNING_BYTES} bytes).`);
        }

        await this.persistData(STORAGE_FILE, updatedList);

        return deepClone(newRevision);
    }

    /**
     * Get all revisions for a call, sorted by revisionNumber ascending.
     */
    findRevisionsByCallId(callId) {
        if (!callId) return [];
        const revisions = this._getAllRevisions();
        if (this.isCorrupted || revisions === null) {
            throw new Error('처리 리비전 저장소가 일시적으로 사용 불가능합니다.');
        }

        return revisions
            .filter(r => r && r.callId === String(callId))
            .sort((a, b) => (a.revisionNumber || 0) - (b.revisionNumber || 0))
            .map(r => deepClone(r));
    }

    /**
     * Find active revision for a call.
     */
    findActiveRevision(callId) {
        if (!callId) return null;
        const revisions = this.findRevisionsByCallId(callId);
        return revisions.find(r => r.status === 'active') || null;
    }

    /**
     * Find revision by its unique ID.
     */
    findById(id) {
        if (!id) return null;
        const revisions = this._getAllRevisions();
        if (this.isCorrupted || revisions === null) return null;
        const match = revisions.find(r => r && r.id === String(id));
        return match ? deepClone(match) : null;
    }
}

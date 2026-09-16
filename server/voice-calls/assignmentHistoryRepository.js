/**
 * server/voice-calls/assignmentHistoryRepository.js
 * Assignment & Reassignment History Storage for Mind-ERP OS Voice Calls.
 * Records sequential history of successful assignments with concurrency serialization.
 * Only records successfully committed assignments (failed attempts are logged to audit).
 */

import crypto from 'crypto';
import { DOMAIN_LIMITS, ERROR_CODES } from './voiceCallConstants.js';
import { deepClone } from './voiceCallValidator.js';
import { withFileLock } from '../storage/sharedFileLockRegistry.js';

const STORAGE_FILE = 'VoiceCallAssignmentHistory';

export class AssignmentHistoryRepository {
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

    resetCorruptionState() {
        try {
            const history = this.getData(STORAGE_FILE, null);
            if (!Array.isArray(history)) {
                this.isCorrupted = true;
                throw new Error('복구 실패: 저장소 데이터가 올바른 배열 형식이 아닙니다.');
            }
            for (const h of history) {
                if (!h || typeof h !== 'object' || Array.isArray(h)) {
                    this.isCorrupted = true;
                    throw new Error('복구 실패: 저장소 항목에 유효하지 않은 데이터가 포함되어 있습니다.');
                }
            }
            this.isCorrupted = false;
            return { recovered: true, count: history.length };
        } catch (err) {
            this.isCorrupted = true;
            throw err;
        }
    }

    _getAllHistory() {
        if (this.isCorrupted) return null;
        try {
            const history = this.getData(STORAGE_FILE, []);
            if (!Array.isArray(history)) {
                throw new Error('AssignmentHistory data is not an array');
            }
            return history;
        } catch (err) {
            this.isCorrupted = true;
            console.error('❌ [ASSIGNMENT_HISTORY_CORRUPTION] Storage corrupted:', err.message);
            return null;
        }
    }

    /**
     * Record a successful assignment transition.
     * Concurrency-safe across instances using withFileLock.
     */
    async recordAssignment(entry) {
        return withFileLock(STORAGE_FILE, async () => {
            return this._executeRecordAssignment(entry);
        });
    }

    async _executeRecordAssignment(entry) {
        if (!entry || !entry.callId) {
            throw new Error('callId가 누락되었습니다.');
        }

        if (!entry.assignedBy || typeof entry.assignedBy !== 'string' || entry.assignedBy.trim() === '') {
            const err = new Error('배정 작업자(assignedBy)가 필수입니다.');
            err.code = ERROR_CODES.INVARIANT_VIOLATION;
            err.status = 400;
            throw err;
        }

        // Validate call existence if repo is provided (NO bypasses permitted)
        if (this.voiceCallRepo) {
            const call = this.voiceCallRepo.findById(entry.callId, { includeDeleted: true });
            if (!call) {
                const err = new Error(`존재하지 않는 통화 [${entry.callId}]에 대한 배정 이력을 기록할 수 없습니다.`);
                err.code = ERROR_CODES.NOT_FOUND;
                err.status = 404;
                throw err;
            }
        }

        // Validate resultingVersion is safe integer > 0
        const resultingVersion = Number(entry.resultingVersion);
        if (!Number.isSafeInteger(resultingVersion) || resultingVersion <= 0) {
            const err = new Error('결과 버전(resultingVersion)은 1 이상의 정수여야 합니다.');
            err.code = ERROR_CODES.INVARIANT_VIOLATION;
            err.status = 400;
            throw err;
        }

        // Validate reason length
        if (entry.reason && typeof entry.reason === 'string' && entry.reason.length > DOMAIN_LIMITS.MAX_REASON_LENGTH) {
            const err = new Error('배정 사유(reason)의 최대 길이를 초과했습니다.');
            err.code = ERROR_CODES.VALIDATION_FAILED;
            err.status = 400;
            throw err;
        }

        const history = this._getAllHistory();
        if (this.isCorrupted || history === null) {
            const err = new Error('배정 이력 저장소가 일시적으로 사용 불가능합니다.');
            err.code = ERROR_CODES.STORAGE_UNAVAILABLE;
            err.status = 503;
            throw err;
        }

        if (entry.operationId) {
            const existing = history.find(h => h && h.operationId === String(entry.operationId));
            if (existing) {
                const matches = (
                    String(existing.callId) === String(entry.callId) &&
                    String(existing.nextUserId || '') === String(entry.nextUserId || '') &&
                    String(existing.previousUserId || '') === String(entry.previousUserId || '') &&
                    String(existing.nextDepartmentId || '') === String(entry.nextDepartmentId || '') &&
                    String(existing.previousDepartmentId || '') === String(entry.previousDepartmentId || '') &&
                    String(existing.reason || '').trim() === String(entry.reason || '담당자 배정').trim() &&
                    String(existing.assignedBy || '').trim() === String(entry.assignedBy || '').trim() &&
                    Number(existing.resultingVersion) === resultingVersion
                );

                if (matches) {
                    return deepClone(existing);
                }

                const conflictErr = new Error(`동일 operationId [${entry.operationId}]에 다른 내용의 배정 이력이 존재합니다.`);
                conflictErr.code = 'ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT';
                conflictErr.status = 409;
                throw conflictErr;
            }
        }

        const nowIso = new Date().toISOString();
        const id = crypto.randomUUID();

        const record = {
            id,
            callId: String(entry.callId),
            operationId: entry.operationId ? String(entry.operationId) : undefined,
            previousUserId: entry.previousUserId || undefined,
            nextUserId: entry.nextUserId || undefined,
            previousDepartmentId: entry.previousDepartmentId || undefined,
            nextDepartmentId: entry.nextDepartmentId || undefined,
            reason: String(entry.reason || '담당자 배정').trim(),
            assignedBy: String(entry.assignedBy).trim(),
            assignedAt: entry.assignedAt || nowIso,
            resultingVersion
        };

        const updatedList = [...history, deepClone(record)];
        const saved = await this.persistData(STORAGE_FILE, updatedList);
        if (!saved) {
            const err = new Error('배정 이력 저장에 실패했습니다.');
            err.code = ERROR_CODES.STORAGE_UNAVAILABLE;
            err.status = 500;
            throw err;
        }

        return deepClone(record);
    }

    /**
     * Find history record by operationId.
     */
    findByOperationId(operationId) {
        if (!operationId) return null;
        const history = this._getAllHistory();
        if (this.isCorrupted || history === null) return null;

        const found = history.find(h => h && h.operationId === String(operationId));
        return found ? deepClone(found) : null;
    }

    /**
     * Idempotently append assignment history record if absent by operationId.
     */
    async appendIfAbsent(entry) {
        return this.recordAssignment(entry);
    }

    /**
     * Get assignment history for a given callId, ordered by timestamp ascending.
     */
    getHistoryForCall(callId) {
        if (!callId) return [];
        const history = this._getAllHistory();
        if (this.isCorrupted || history === null) return [];

        return history
            .filter(h => h && h.callId === String(callId))
            .sort((a, b) => new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime())
            .map(h => deepClone(h));
    }
}

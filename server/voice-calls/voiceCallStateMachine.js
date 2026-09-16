/**
 * server/voice-calls/voiceCallStateMachine.js
 * Centralized State Machine and Invariant Enforcement for Mind-ERP OS Voice Calls.
 * Guarantees immutability upon transition and enforces strict invariants.
 */

import {
    PROCESSING_STATUS,
    ALLOWED_TRANSITIONS,
    REVIEW_STATUS,
    ASSIGNMENT_STATUS,
    SUBJECT_TYPE,
    ERROR_CODES
} from './voiceCallConstants.js';
import { isValidIsoDate, deepClone, isSafeStorageKey } from './voiceCallValidator.js';

export class StateTransitionError extends Error {
    constructor(fromStatus, toStatus, message = null) {
        const msg = message || `상태 전이가 허용되지 않습니다: [${fromStatus}] -> [${toStatus}]`;
        super(msg);
        this.name = 'StateTransitionError';
        this.code = ERROR_CODES.INVALID_TRANSITION;
        this.status = 400;
        this.fromStatus = fromStatus;
        this.toStatus = toStatus;
    }
}

export class InvariantViolationError extends Error {
    constructor(rule, message) {
        super(message);
        this.name = 'InvariantViolationError';
        this.code = ERROR_CODES.INVARIANT_VIOLATION;
        this.status = 400;
        this.rule = rule;
    }
}

/**
 * Check if transition from one status to another is permitted.
 */
export function canTransition(fromStatus, toStatus) {
    if (!fromStatus || !toStatus) return false;
    const allowed = ALLOWED_TRANSITIONS[fromStatus];
    if (!allowed || !Array.isArray(allowed)) return false;
    return allowed.includes(toStatus);
}

/**
 * Assert that transition is valid; throws StateTransitionError if invalid.
 */
export function assertTransition(fromStatus, toStatus) {
    if (!canTransition(fromStatus, toStatus)) {
        throw new StateTransitionError(fromStatus, toStatus);
    }
    return true;
}

/**
 * Validate domain invariants for a VoiceCall record.
 */
export function assertInvariants(record) {
    if (!record || typeof record !== 'object') {
        throw new InvariantViolationError('RECORD_OBJECT', '레코드는 유효한 객체여야 합니다.');
    }

    // 1. Rejected invariant: must have non-empty rejectionCode and isolated from business/clinical workflows
    if (record.processingStatus === PROCESSING_STATUS.REJECTED) {
        if (!record.rejectionCode || typeof record.rejectionCode !== 'string' || record.rejectionCode.trim() === '') {
            throw new InvariantViolationError('REJECTED_REQUIRES_CODE', '거부(rejected) 상태에는 거부 사유 코드(rejectionCode)가 필수입니다.');
        }
        if (record.assignmentStatus && record.assignmentStatus !== ASSIGNMENT_STATUS.UNASSIGNED) {
            throw new InvariantViolationError('REJECTED_MUST_BE_UNASSIGNED', '거부(rejected) 상태 레코드는 unassigned 상태여야 합니다.');
        }
        if (record.assignedUserId || record.assignedDepartmentId || record.recommendedAssigneeId || record.recommendedDepartmentId) {
            throw new InvariantViolationError('REJECTED_CANNOT_HAVE_ASSIGNEE', '거부(rejected) 상태 레코드에는 담당자/부서 배정 정보가 존재할 수 없습니다.');
        }
        if (record.subjectId || record.subjectType || record.referralId) {
            throw new InvariantViolationError('REJECTED_CANNOT_HAVE_SUBJECT', '거부(rejected) 상태 레코드는 대상자 또는 의뢰대장과 연결될 수 없습니다.');
        }
        if (record.activeProcessingRevisionId || record.transcriptStorageKey) {
            throw new InvariantViolationError('REJECTED_CANNOT_HAVE_AI_PIPELINE', '거부(rejected) 상태 레코드는 전사 또는 AI 리비전을 가질 수 없습니다.');
        }
        if (record.storageKey) {
            throw new InvariantViolationError('REJECTED_CANNOT_HAVE_NORMAL_STORAGE', '거부(rejected) 상태 레코드는 정상 오디오 저장소 키(storageKey)를 가질 수 없습니다. quarantineStorageKey만 허용됩니다.');
        }
    }

    // 2. Completed invariant: must have confirmedAt or processedAt
    if (record.processingStatus === PROCESSING_STATUS.COMPLETED) {
        if (!record.confirmedAt && !record.processedAt) {
            throw new InvariantViolationError('COMPLETED_REQUIRES_TIMESTAMP', '완료(completed) 상태에는 완료 시각(confirmedAt 또는 processedAt)이 필수입니다.');
        }
    }

    // 3. ReviewStatus invariants
    if (record.reviewStatus === REVIEW_STATUS.NOT_STARTED) {
        if (record.confirmedBy || record.confirmedAt) {
            throw new InvariantViolationError('NOT_STARTED_NO_CONFIRMATION', '미시작(not_started) 리뷰 상태에서는 확정자나 확정시각이 존재할 수 없습니다.');
        }
    }
    if (record.reviewStatus === REVIEW_STATUS.CONFIRMED) {
        if (!record.confirmedBy || typeof record.confirmedBy !== 'string' || record.confirmedBy.trim() === '') {
            throw new InvariantViolationError('CONFIRMED_REQUIRES_ACTOR', '확정(confirmed) 리뷰 상태에는 확정자(confirmedBy)가 필수입니다.');
        }
        if (!record.confirmedAt || !isValidIsoDate(record.confirmedAt)) {
            throw new InvariantViolationError('CONFIRMED_REQUIRES_TIMESTAMP', '확정(confirmed) 리뷰 상태에는 올바른 확정시각(confirmedAt)이 필수입니다.');
        }
    }

    // 4. AssignmentStatus invariants
    if (record.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED || record.assignmentStatus === ASSIGNMENT_STATUS.REASSIGNED) {
        if (!record.assignedUserId || typeof record.assignedUserId !== 'string' || record.assignedUserId.trim() === '') {
            throw new InvariantViolationError('ASSIGNED_REQUIRES_USER', '배정(assigned) 상태에는 담당자 ID(assignedUserId)가 필수입니다.');
        }
    }
    if (record.assignmentStatus === ASSIGNMENT_STATUS.UNASSIGNED) {
        if (record.assignedUserId && record.assignedUserId.trim() !== '') {
            throw new InvariantViolationError('UNASSIGNED_CANNOT_HAVE_ASSIGNEE', '미배정(unassigned) 상태에는 담당자 ID(assignedUserId)가 존재할 수 없습니다.');
        }
    }
    if (record.assignmentStatus === ASSIGNMENT_STATUS.RECOMMENDED) {
        if (!record.recommendedDepartmentId && !record.recommendedAssigneeId) {
            throw new InvariantViolationError('RECOMMENDED_REQUIRES_TARGET', '추천(recommended) 상태에는 추천 부서 또는 추천 담당자가 필수입니다.');
        }
    }

    // 5. Classification confidence range (0.0 to 1.0)
    if (record.classificationConfidence !== undefined && record.classificationConfidence !== null) {
        if (typeof record.classificationConfidence !== 'number' || record.classificationConfidence < 0 || record.classificationConfidence > 1) {
            throw new InvariantViolationError('CONFIDENCE_RANGE', '분류 신뢰도(classificationConfidence)는 0과 1 사이여야 합니다.');
        }
    }

    // 6. Safe File Size (non-negative safe integer)
    if (record.fileSize !== undefined) {
        if (typeof record.fileSize !== 'number' || !Number.isSafeInteger(record.fileSize) || record.fileSize < 0) {
            throw new InvariantViolationError('FILE_SIZE_INVALID', '파일 크기는 0 이상의 정수여야 합니다.');
        }
    }

    // 7. Safe Duration (non-negative number if present)
    if (record.durationSeconds !== undefined && record.durationSeconds !== null) {
        if (typeof record.durationSeconds !== 'number' || record.durationSeconds < 0 || isNaN(record.durationSeconds)) {
            throw new InvariantViolationError('DURATION_INVALID', '재생 시간은 0 이상의 숫자여야 합니다.');
        }
    }

    // 8. Version invariant: version >= 1 safe integer
    if (record.version !== undefined) {
        if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) {
            throw new InvariantViolationError('VERSION_INVALID', '버전 번호는 1 이상의 정수여야 합니다.');
        }
    }

    // 9. Subject identity invariant: subjectId without subjectType is prohibited
    if (record.subjectId) {
        if (!record.subjectType || !Object.values(SUBJECT_TYPE).includes(record.subjectType)) {
            throw new InvariantViolationError('SUBJECT_TYPE_REQUIRED', 'subjectId 지정 시 유효한 subjectType이 필수입니다.');
        }
    }

    // 10. Storage key safety
    if (record.storageKey && !isSafeStorageKey(record.storageKey)) {
        throw new InvariantViolationError('STORAGE_KEY_UNSAFE', '저장소 키(storageKey)는 안전한 상대 경로여야 합니다.');
    }
    if (record.transcriptStorageKey && !isSafeStorageKey(record.transcriptStorageKey)) {
        throw new InvariantViolationError('TRANSCRIPT_STORAGE_KEY_UNSAFE', '전사 저장소 키는 안전한 상대 경로여야 합니다.');
    }

    // 11. Timestamps ordering
    if (record.createdAt && record.updatedAt && isValidIsoDate(record.createdAt) && isValidIsoDate(record.updatedAt)) {
        if (new Date(record.updatedAt).getTime() < new Date(record.createdAt).getTime()) {
            throw new InvariantViolationError('TIMESTAMP_ORDER', '수정 시각(updatedAt)은 생성 시각(createdAt)보다 빠를 수 없습니다.');
        }
    }

    return true;
}

/**
 * Execute state transition immutably on a VoiceCall record.
 * Returns a new deep-cloned record object with updated status, version, and updatedAt.
 * Does NOT mutate currentRecord.
 * 
 * @param {Object} currentRecord - The existing immutable VoiceCall record
 * @param {string} nextStatus - Desired target ProcessingStatus
 * @param {Object} [context={}] - Additional field updates (e.g. rejectionCode, confirmedBy)
 * @returns {Object} A brand new frozen VoiceCallRecord object
 */
export function transitionVoiceCall(currentRecord, nextStatus, context = {}) {
    if (!currentRecord) {
        throw new InvariantViolationError('MISSING_RECORD', '전이 대상 레코드가 없습니다.');
    }

    assertTransition(currentRecord.processingStatus, nextStatus);

    const nowIso = new Date().toISOString();
    const nextVersion = (currentRecord.version || 1) + 1;

    // Deep clone to prevent any mutation of source object
    const cleanContext = deepClone(context || {});
    delete cleanContext.processingStatus; // ensure status comes from nextStatus only
    delete cleanContext.version; // version increment is managed strictly

    const updatedRecord = {
        ...deepClone(currentRecord),
        ...cleanContext,
        processingStatus: nextStatus,
        version: nextVersion,
        updatedAt: nowIso
    };

    // Auto-fill timestamps based on status if not provided
    if (nextStatus === PROCESSING_STATUS.COMPLETED && !updatedRecord.confirmedAt && !updatedRecord.processedAt) {
        updatedRecord.confirmedAt = nowIso;
    }

    // Assert all invariants hold on the new state
    assertInvariants(updatedRecord);

    return Object.freeze(deepClone(updatedRecord));
}

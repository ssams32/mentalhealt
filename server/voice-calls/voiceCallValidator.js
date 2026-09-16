/**
 * server/voice-calls/voiceCallValidator.js
 * Pure JavaScript Domain Validator for Mind-ERP OS Voice Calls.
 * Enforces domain limits, deep copy safety, and invariant validation without leaking raw text.
 */

import path from 'path';
import {
    PROCESSING_STATUS,
    CALL_CATEGORY,
    ASSIGNMENT_STATUS,
    REVIEW_STATUS,
    INTAKE_VALIDATION_STATUS,
    AUDIO_INTAKE_SOURCE,
    DIARIZATION_MODE,
    SUBJECT_TYPE,
    DOMAIN_LIMITS,
    ERROR_CODES
} from './voiceCallConstants.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?([+-]\d{2}:\d{2})?$/;
const UUID_OR_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;

export class DomainValidationError extends Error {
    constructor(fields = [], message = '입력 데이터 검증에 실패했습니다.') {
        super(message);
        this.name = 'DomainValidationError';
        this.code = ERROR_CODES.VALIDATION_FAILED;
        this.status = 400;
        // Fields array contains structured reason descriptors only (NEVER raw user input)
        this.fields = fields.map(f => ({
            field: String(f.field || 'unknown'),
            reason: String(f.reason || 'INVALID')
        }));
    }
}

/**
 * Deep clone an object using structuredClone when available or JSON clone as fallback.
 * Eliminates shallow freeze vulnerabilities.
 */
export function deepClone(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(obj);
        } catch (e) {
            // fall through to JSON
        }
    }
    return JSON.parse(JSON.stringify(obj));
}

export function isValidIsoDate(str) {
    if (typeof str !== 'string') return false;
    if (!ISO_DATE_REGEX.test(str)) return false;
    const date = new Date(str);
    return !isNaN(date.getTime());
}

export function isValidId(str) {
    if (typeof str !== 'string') return false;
    return UUID_OR_ID_REGEX.test(str);
}

/**
 * Check if a storageKey is a safe relative path without traversal, drive letters, or absolute prefixes.
 */
export function isSafeStorageKey(key) {
    if (typeof key !== 'string' || key.trim() === '') return false;
    // Disallow backslashes, drive letters (e.g. C:), URL protocols, traversal (..)
    if (key.includes('\\') || key.includes('..') || key.includes('://')) return false;
    if (/^[a-zA-Z]:/.test(key)) return false;
    if (key.startsWith('/') || path.isAbsolute(key)) return false;
    return true;
}

/**
 * Validate input fields for a new or updated VoiceCallRecord.
 */
export function validateVoiceCallRecord(record, isNew = false) {
    const fields = [];

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new DomainValidationError([{ field: 'root', reason: 'RECORD_MUST_BE_OBJECT' }]);
    }

    // 1. Mandatory Fields on Creation
    if (isNew) {
        if (!record.id) fields.push({ field: 'id', reason: 'REQUIRED' });
        if (!record.originalFileName) fields.push({ field: 'originalFileName', reason: 'REQUIRED' });
        if (!record.contentHash) fields.push({ field: 'contentHash', reason: 'REQUIRED' });
        if (!record.mimeType) fields.push({ field: 'mimeType', reason: 'REQUIRED' });
        if (record.fileSize === undefined || record.fileSize === null) fields.push({ field: 'fileSize', reason: 'REQUIRED' });
        if (!record.intakeSource) fields.push({ field: 'intakeSource', reason: 'REQUIRED' });
    }

    // 2. ID Validation
    if (record.id !== undefined && !isValidId(record.id)) {
        fields.push({ field: 'id', reason: 'INVALID_ID_FORMAT' });
    }

    // 3. Enum Checks
    if (record.intakeSource !== undefined && !Object.values(AUDIO_INTAKE_SOURCE).includes(record.intakeSource)) {
        fields.push({ field: 'intakeSource', reason: 'INVALID_ENUM' });
    }
    if (record.validationStatus !== undefined && !Object.values(INTAKE_VALIDATION_STATUS).includes(record.validationStatus)) {
        fields.push({ field: 'validationStatus', reason: 'INVALID_ENUM' });
    }
    if (record.processingStatus !== undefined && !Object.values(PROCESSING_STATUS).includes(record.processingStatus)) {
        fields.push({ field: 'processingStatus', reason: 'INVALID_ENUM' });
    }
    if (record.callCategory !== undefined && !Object.values(CALL_CATEGORY).includes(record.callCategory)) {
        fields.push({ field: 'callCategory', reason: 'INVALID_ENUM' });
    }
    if (record.assignmentStatus !== undefined && !Object.values(ASSIGNMENT_STATUS).includes(record.assignmentStatus)) {
        fields.push({ field: 'assignmentStatus', reason: 'INVALID_ENUM' });
    }
    if (record.reviewStatus !== undefined && !Object.values(REVIEW_STATUS).includes(record.reviewStatus)) {
        fields.push({ field: 'reviewStatus', reason: 'INVALID_ENUM' });
    }
    if (record.subjectType !== undefined && record.subjectType !== null && !Object.values(SUBJECT_TYPE).includes(record.subjectType)) {
        fields.push({ field: 'subjectType', reason: 'INVALID_ENUM' });
    }

    // 4. Numeric Ranges & Safe Integers
    if (record.fileSize !== undefined) {
        if (typeof record.fileSize !== 'number' || !Number.isSafeInteger(record.fileSize) || record.fileSize < 0) {
            fields.push({ field: 'fileSize', reason: 'INVALID_FILE_SIZE' });
        }
    }

    if (record.durationSeconds !== undefined && record.durationSeconds !== null) {
        if (typeof record.durationSeconds !== 'number' || record.durationSeconds < 0 || isNaN(record.durationSeconds)) {
            fields.push({ field: 'durationSeconds', reason: 'INVALID_DURATION' });
        }
    }

    if (record.classificationConfidence !== undefined && record.classificationConfidence !== null) {
        if (typeof record.classificationConfidence !== 'number' || record.classificationConfidence < 0 || record.classificationConfidence > 1) {
            fields.push({ field: 'classificationConfidence', reason: 'OUT_OF_RANGE' });
        }
    }

    if (record.version !== undefined) {
        if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) {
            fields.push({ field: 'version', reason: 'INVALID_VERSION' });
        }
    }

    // 5. Timestamps
    const dateFields = ['receivedAt', 'processedAt', 'confirmedAt', 'createdAt', 'updatedAt', 'deletedAt', 'assignmentChangedAt'];
    for (const df of dateFields) {
        if (record[df] !== undefined && record[df] !== null && !isValidIsoDate(record[df])) {
            fields.push({ field: df, reason: 'INVALID_ISO_DATE' });
        }
    }

    if (record.lastAssignmentOperationId !== undefined && record.lastAssignmentOperationId !== null) {
        if (!isValidId(record.lastAssignmentOperationId)) {
            fields.push({ field: 'lastAssignmentOperationId', reason: 'INVALID_ID_FORMAT' });
        }
    }

    if (record.owningDepartmentId !== undefined && record.owningDepartmentId !== null) {
        if (typeof record.owningDepartmentId !== 'string' || record.owningDepartmentId.trim() === '') {
            fields.push({ field: 'owningDepartmentId', reason: 'INVALID_DEPARTMENT_FORMAT' });
        }
    }

    if (record.createdAt && record.updatedAt && isValidIsoDate(record.createdAt) && isValidIsoDate(record.updatedAt)) {
        if (new Date(record.updatedAt).getTime() < new Date(record.createdAt).getTime()) {
            fields.push({ field: 'updatedAt', reason: 'UPDATED_AT_BEFORE_CREATED_AT' });
        }
    }

    // 6. Security: Deny Forbidden Injected Client Attributes
    const forbiddenFields = [
        'password',
        'token',
        'session',
        'signedUrl',
        'absolutePath',
        'rawAudio',
        'rawTranscript',
        'prompt'
    ];
    for (const ff of forbiddenFields) {
        if (record[ff] !== undefined) {
            fields.push({ field: ff, reason: 'FORBIDDEN_FIELD' });
        }
    }

    // 7. Security: Storage Keys & Intake Reference
    if (record.storageKey) {
        if (!isSafeStorageKey(record.storageKey)) {
            fields.push({ field: 'storageKey', reason: 'INVALID_STORAGE_KEY' });
        }
    }
    if (record.pendingStorageKey) {
        if (!isSafeStorageKey(record.pendingStorageKey)) {
            fields.push({ field: 'pendingStorageKey', reason: 'INVALID_PENDING_STORAGE_KEY' });
        }
    }
    if (record.quarantineStorageKey) {
        if (!isSafeStorageKey(record.quarantineStorageKey)) {
            fields.push({ field: 'quarantineStorageKey', reason: 'INVALID_QUARANTINE_STORAGE_KEY' });
        }
    }
    if (record.transcriptStorageKey) {
        if (!isSafeStorageKey(record.transcriptStorageKey)) {
            fields.push({ field: 'transcriptStorageKey', reason: 'INVALID_TRANSCRIPT_STORAGE_KEY' });
        }
    }
    if (record.intakeReference) {
        if (typeof record.intakeReference !== 'string' || record.intakeReference.includes('..') || record.intakeReference.includes('://')) {
            fields.push({ field: 'intakeReference', reason: 'INVALID_INTAKE_REFERENCE' });
        }
    }

    // 8. Subject Invariants
    if (record.subjectId && !record.subjectType) {
        fields.push({ field: 'subjectType', reason: 'REQUIRED_WHEN_SUBJECT_ID_PRESENT' });
    }

    // 9. Review Invariants
    if (record.reviewStatus === REVIEW_STATUS.NOT_STARTED) {
        if (record.confirmedBy || record.confirmedAt) {
            fields.push({ field: 'reviewStatus', reason: 'NOT_STARTED_MUST_NOT_HAVE_CONFIRMATION' });
        }
    }

    if (fields.length > 0) {
        throw new DomainValidationError(fields);
    }

    return true;
}

/**
 * Validate Processing Revision size and field limits against DOMAIN_LIMITS.
 */
export function validateRevisionLimits(revision) {
    const fields = [];

    if (!revision || typeof revision !== 'object') {
        throw new DomainValidationError([{ field: 'root', reason: 'REVISION_MUST_BE_OBJECT' }]);
    }

    if (revision.aiSummary && typeof revision.aiSummary === 'string' && revision.aiSummary.length > DOMAIN_LIMITS.MAX_AI_SUMMARY_LENGTH) {
        fields.push({ field: 'aiSummary', reason: 'EXCEEDS_MAX_LENGTH' });
    }

    if (Array.isArray(revision.aiKeyPoints)) {
        if (revision.aiKeyPoints.length > DOMAIN_LIMITS.MAX_AI_KEY_POINTS_COUNT) {
            fields.push({ field: 'aiKeyPoints', reason: 'EXCEEDS_MAX_COUNT' });
        }
        for (let i = 0; i < revision.aiKeyPoints.length; i++) {
            if (typeof revision.aiKeyPoints[i] === 'string' && revision.aiKeyPoints[i].length > DOMAIN_LIMITS.MAX_KEY_POINT_LENGTH) {
                fields.push({ field: `aiKeyPoints[${i}]`, reason: 'EXCEEDS_MAX_LENGTH' });
                break;
            }
        }
    }

    if (Array.isArray(revision.aiRequestedActions)) {
        if (revision.aiRequestedActions.length > DOMAIN_LIMITS.MAX_REQUESTED_ACTIONS_COUNT) {
            fields.push({ field: 'aiRequestedActions', reason: 'EXCEEDS_MAX_COUNT' });
        }
        for (let i = 0; i < revision.aiRequestedActions.length; i++) {
            if (typeof revision.aiRequestedActions[i] === 'string' && revision.aiRequestedActions[i].length > DOMAIN_LIMITS.MAX_ACTION_LENGTH) {
                fields.push({ field: `aiRequestedActions[${i}]`, reason: 'EXCEEDS_MAX_LENGTH' });
                break;
            }
        }
    }

    if (Array.isArray(revision.safetyFlags)) {
        if (revision.safetyFlags.length > DOMAIN_LIMITS.MAX_SAFETY_FLAGS_COUNT) {
            fields.push({ field: 'safetyFlags', reason: 'EXCEEDS_MAX_COUNT' });
        }
        for (let i = 0; i < revision.safetyFlags.length; i++) {
            if (typeof revision.safetyFlags[i] === 'string' && revision.safetyFlags[i].length > DOMAIN_LIMITS.MAX_SAFETY_FLAG_LENGTH) {
                fields.push({ field: `safetyFlags[${i}]`, reason: 'EXCEEDS_MAX_LENGTH' });
                break;
            }
        }
    }

    if (Array.isArray(revision.validationErrors)) {
        if (revision.validationErrors.length > DOMAIN_LIMITS.MAX_VALIDATION_ERRORS_COUNT) {
            fields.push({ field: 'validationErrors', reason: 'EXCEEDS_MAX_COUNT' });
        }
        for (let i = 0; i < revision.validationErrors.length; i++) {
            const err = revision.validationErrors[i];
            const msg = typeof err === 'object' && err !== null ? err.message : String(err);
            if (msg && msg.length > DOMAIN_LIMITS.MAX_VALIDATION_ERROR_LENGTH) {
                fields.push({ field: `validationErrors[${i}]`, reason: 'EXCEEDS_MAX_LENGTH' });
                break;
            }
        }
    }

    if (revision.sttModel && typeof revision.sttModel === 'string' && revision.sttModel.length > DOMAIN_LIMITS.MAX_MODEL_NAME_LENGTH) {
        fields.push({ field: 'sttModel', reason: 'EXCEEDS_MAX_LENGTH' });
    }
    if (revision.llmModel && typeof revision.llmModel === 'string' && revision.llmModel.length > DOMAIN_LIMITS.MAX_MODEL_NAME_LENGTH) {
        fields.push({ field: 'llmModel', reason: 'EXCEEDS_MAX_LENGTH' });
    }
    if (revision.promptVersion && typeof revision.promptVersion === 'string' && revision.promptVersion.length > DOMAIN_LIMITS.MAX_PROMPT_VERSION_LENGTH) {
        fields.push({ field: 'promptVersion', reason: 'EXCEEDS_MAX_LENGTH' });
    }

    if (fields.length > 0) {
        throw new DomainValidationError(fields);
    }
    return true;
}

/**
 * Validate Summary Review input and limits against DOMAIN_LIMITS.
 */
export function validateSummaryReviewLimits(review) {
    const fields = [];

    if (!review || typeof review !== 'object') {
        throw new DomainValidationError([{ field: 'root', reason: 'REVIEW_MUST_BE_OBJECT' }]);
    }

    if (review.reviewedSummary && typeof review.reviewedSummary === 'string' && review.reviewedSummary.length > DOMAIN_LIMITS.MAX_AI_SUMMARY_LENGTH) {
        fields.push({ field: 'reviewedSummary', reason: 'EXCEEDS_MAX_LENGTH' });
    }

    if (review.aiSummarySnapshot && typeof review.aiSummarySnapshot === 'string' && review.aiSummarySnapshot.length > DOMAIN_LIMITS.MAX_AI_SUMMARY_LENGTH) {
        fields.push({ field: 'aiSummarySnapshot', reason: 'EXCEEDS_MAX_LENGTH' });
    }

    if (Array.isArray(review.reviewedKeyPoints)) {
        if (review.reviewedKeyPoints.length > DOMAIN_LIMITS.MAX_AI_KEY_POINTS_COUNT) {
            fields.push({ field: 'reviewedKeyPoints', reason: 'EXCEEDS_MAX_COUNT' });
        }
        for (let i = 0; i < review.reviewedKeyPoints.length; i++) {
            if (typeof review.reviewedKeyPoints[i] === 'string' && review.reviewedKeyPoints[i].length > DOMAIN_LIMITS.MAX_KEY_POINT_LENGTH) {
                fields.push({ field: `reviewedKeyPoints[${i}]`, reason: 'EXCEEDS_MAX_LENGTH' });
                break;
            }
        }
    }

    if (fields.length > 0) {
        throw new DomainValidationError(fields);
    }
    return true;
}

/**
 * Safe view projection contract for VoiceCall records.
 * Strips internal audit references (such as lastAssignmentActorId) from general client responses
 * unless the caller has an explicit audit viewing permission.
 *
 * @param {Object} voiceCall - The raw VoiceCall record
 * @param {Object} [actorContext] - The requesting caller context (user, permissions, role)
 * @returns {Object} Projected safe copy of VoiceCall
 */
export function projectVoiceCallForClient(voiceCall, actorContext = {}) {
    if (!voiceCall || typeof voiceCall !== 'object') {
        return voiceCall;
    }

    const projected = deepClone(voiceCall);

    // Determine if actor has explicit audit view permission
    const hasExplicitAuditPermission = Boolean(
        actorContext && (
            actorContext.permissions?.canViewAudit === true ||
            actorContext.permissions?.audit === true ||
            actorContext.canViewAudit === true ||
            actorContext.allowAuditView === true
        )
    );

    if (!hasExplicitAuditPermission) {
        delete projected.lastAssignmentActorId;
    }

    return projected;
}

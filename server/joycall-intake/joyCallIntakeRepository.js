/**
 * server/joycall-intake/joyCallIntakeRepository.js
 * Specialized repository / store for JoyCall VoiceCall records.
 * Enforces initial unclassified, unlinked pending state.
 */

import {
    JOYCALL_INTAKE_PROCESSING_STATUS,
    JOYCALL_CLASSIFICATION_STATUS,
    JOYCALL_LINK_STATUS,
    JOYCALL_CANONICAL_RECORD_TYPES,
    JOYCALL_CANONICAL_CLASSIFICATION_METHODS
} from './joyCallIntakeConstants.js';
import { JoyCallIntakeError, JOYCALL_INTAKE_ERROR_CODES } from './joyCallIntakeErrors.js';

export class JoyCallIntakeRepository {
    constructor(getDataFn, persistDataFn) {
        this.getData = getDataFn;
        this.persistData = persistDataFn;
    }

    _loadCalls() {
        const data = this.getData ? this.getData() : [];
        return Array.isArray(data) ? [...data] : [];
    }

    _saveCalls(calls) {
        if (this.persistData) {
            this.persistData(calls);
        }
    }

    findByContentHash(sha256) {
        if (!sha256) return null;
        const calls = this._loadCalls();
        return calls.find(c => c.contentHash === sha256) || null;
    }

    findById(id) {
        if (!id) return null;
        const calls = this._loadCalls();
        return calls.find(c => c.id === id) || null;
    }

    /**
     * Create new VoiceCall record from NAS JoyCall intake.
     * Enforces required initial pending states:
     * - processingStatus = pending
     * - classificationStatus = pending
     * - callRecordType = null
     * - classificationMethod = null
     * - subjectLinkStatus = unlinked
     * - institutionLinkStatus = unlinked
     */
    async createIntakeCall(data) {
        const calls = this._loadCalls();

        // Check duplicate hash
        if (data.contentHash && calls.some(c => c.contentHash === data.contentHash)) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.DUPLICATE_CONTENT,
                '이미 등록된 동일한 내용의 오디오 파일(SHA-256 중복)입니다.'
            );
        }

        const id = data.id || `call_jc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const nowIso = new Date().toISOString();

        const newCall = {
            id,
            version: 1,
            intakeSource: 'joycall_nas_sync',
            originalFileName: data.originalFileName,
            contentHash: data.contentHash,
            fileSize: data.fileSize,
            mimeType: data.mimeType || 'audio/wav',
            storageKey: data.storageKey,

            // Initial Contract States
            processingStatus: JOYCALL_INTAKE_PROCESSING_STATUS.PENDING,
            classificationStatus: JOYCALL_CLASSIFICATION_STATUS.PENDING,
            callRecordType: null,
            classificationMethod: null,
            subjectLinkStatus: JOYCALL_LINK_STATUS.UNLINKED,
            institutionLinkStatus: JOYCALL_LINK_STATUS.UNLINKED,

            // Prohibited fields: MUST NEVER exist at initial intake
            transcript: undefined,
            summary: undefined,

            createdAt: nowIso,
            updatedAt: nowIso
        };

        calls.push(newCall);
        this._saveCalls(calls);
        return newCall;
    }

    /**
     * Manual classification by authorized staff member.
     * Only accepts canonical manual record types and staff methods.
     */
    async classifyManually(callId, recordType, method, staffUserId) {
        const calls = this._loadCalls();
        const call = calls.find(c => c.id === callId);
        if (!call) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.FILE_NOT_FOUND,
                'VoiceCall을 찾을 수 없습니다.'
            );
        }

        if (!Object.values(JOYCALL_CANONICAL_RECORD_TYPES).includes(recordType)) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.INVALID_SOURCE,
                `허용되지 않은 통화 분류 유형입니다: ${recordType}`
            );
        }

        if (!Object.values(JOYCALL_CANONICAL_CLASSIFICATION_METHODS).includes(method)) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.INVALID_SOURCE,
                `허용되지 않은 통화 분류 방식입니다: ${method}`
            );
        }

        call.callRecordType = recordType;
        call.classificationMethod = method;
        call.classificationStatus = JOYCALL_CLASSIFICATION_STATUS.CLASSIFIED;
        call.classifiedByUserId = staffUserId;
        call.classifiedAt = new Date().toISOString();
        call.version += 1;
        call.updatedAt = call.classifiedAt;

        this._saveCalls(calls);
        return call;
    }

    list() {
        return this._loadCalls();
    }
}

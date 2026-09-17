/**
 * server/survey/surveyImportRepository.js
 * Atomic storage operations for survey imports, intake records, consent evidence,
 * and pending referral candidates using existing JSON file store conventions.
 */

import crypto from 'crypto';
import {
    SURVEY_STORAGE_FILES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS
} from './surveyConstants.js';

export class SurveyImportRepository {
    /**
     * @param {Object} deps
     * @param {Function} deps.getData
     * @param {Function} deps.persistData
     */
    constructor(deps = {}) {
        if (!deps.getData || !deps.persistData) {
            throw new Error('SurveyImportRepository requires getData and persistData dependencies');
        }
        this.getData = deps.getData;
        this.persistData = deps.persistData;
        this.assignmentRepository = deps.assignmentRepository || null;
        this.sourceEnvironment = deps.sourceEnvironment || 'mock';
    }

    _nowIso() {
        return new Date().toISOString();
    }

    // ──────────────────────────────────────────────────────────
    // 1. External Submission Imports Ledger
    // ──────────────────────────────────────────────────────────

    getImportsLedger() {
        return this.getData(SURVEY_STORAGE_FILES.EXTERNAL_SUBMISSION_IMPORTS, []);
    }

    async saveImportsLedger(list) {
        return this.persistData(SURVEY_STORAGE_FILES.EXTERNAL_SUBMISSION_IMPORTS, list);
    }

    findBySubmissionId(submissionId) {
        const list = this.getImportsLedger();
        return list.find(item => item.submissionId === submissionId) || null;
    }

    async createOrUpdateImportRecord(record) {
        const list = this.getImportsLedger();
        const index = list.findIndex(item => item.submissionId === record.submissionId);
        const now = this._nowIso();

        if (index === -1) {
            const newRecord = {
                internalImportId: `imp_${crypto.randomUUID()}`,
                submissionId: record.submissionId,
                leaseId: record.leaseId || null,
                leasedAt: record.leasedAt || null,
                leaseUntil: record.leaseUntil || null,
                workerId: record.workerId || null,
                schemaVersion: record.schemaVersion || 'v1.0',
                keyVersion: record.keyVersion || 'k2026_01',
                externalStatus: record.externalStatus || SURVEY_EXTERNAL_STATUS.PENDING,
                internalStatus: record.internalStatus || SURVEY_INTERNAL_STATUS.DOWNLOADED,
                localAttemptId: record.localAttemptId || null,
                receivedAt: record.receivedAt || now,
                downloadedAt: record.downloadedAt || now,
                decryptedAt: record.decryptedAt || null,
                importedAt: record.importedAt || null,
                ackRequestId: record.ackRequestId || null,
                acknowledgedAt: record.acknowledgedAt || null,
                failedRequestId: record.failedRequestId || null,
                failedReportedAt: record.failedReportedAt || null,
                deleteRequestId: record.deleteRequestId || null,
                deletionRequestedAt: record.deletionRequestedAt || null,
                externalDeletedAt: record.externalDeletedAt || null,
                retryCount: record.retryCount || 0,
                lastErrorCode: record.lastErrorCode || null,
                lastAttemptAt: record.lastAttemptAt || now,
                sourceEnvironment: record.sourceEnvironment || this.sourceEnvironment || 'mock',
                createdAt: now,
                updatedAt: now
            };
            list.push(newRecord);
            await this.saveImportsLedger(list);
            return newRecord;
        } else {
            const existing = list[index];
            const updated = {
                ...existing,
                ...record,
                sourceEnvironment: record.sourceEnvironment !== undefined ? record.sourceEnvironment : (existing.sourceEnvironment || this.sourceEnvironment || 'mock'),
                leaseId: record.leaseId !== undefined ? record.leaseId : existing.leaseId,
                leasedAt: record.leasedAt !== undefined ? record.leasedAt : existing.leasedAt,
                leaseUntil: record.leaseUntil !== undefined ? record.leaseUntil : existing.leaseUntil,
                workerId: record.workerId !== undefined ? record.workerId : existing.workerId,
                ackRequestId: record.ackRequestId !== undefined ? record.ackRequestId : existing.ackRequestId,
                failedRequestId: record.failedRequestId !== undefined ? record.failedRequestId : existing.failedRequestId,
                deleteRequestId: record.deleteRequestId !== undefined ? record.deleteRequestId : existing.deleteRequestId,
                updatedAt: now
            };
            list[index] = updated;
            await this.saveImportsLedger(list);
            return updated;
        }
    }

    // ──────────────────────────────────────────────────────────
    // 2. Survey Submissions Data
    // ──────────────────────────────────────────────────────────

    getSurveySubmissions() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_SUBMISSIONS, []);
    }

    async saveSurveySubmissions(list) {
        return this.persistData(SURVEY_STORAGE_FILES.SURVEY_SUBMISSIONS, list);
    }

    findSubmissionById(internalSurveyId) {
        const list = this.getSurveySubmissions();
        return list.find(s => s.internalSurveyId === internalSurveyId) || null;
    }

    async updateSubmissionReferralLink(internalSurveyId, referralId) {
        const list = this.getSurveySubmissions();
        const index = list.findIndex(s => s.internalSurveyId === internalSurveyId || s.submissionId === internalSurveyId);
        if (index !== -1) {
            list[index].referralId = referralId;
            list[index].updatedAt = this._nowIso();
            await this.saveSurveySubmissions(list);
            return list[index];
        }
        return null;
    }

    /**
     * Assign or reassign a staff member to an imported survey.
     * Enforces optimistic concurrency and appends to assignment history.
     */
    async assignStaff({
        internalSurveyId,
        submissionId,
        targetUserId,
        assignedUserId,
        assignedDepartmentId,
        assignedByUserId,
        actorId,
        assignmentPriority,
        priority = 'NORMAL',
        reason = null,
        expectedVersion = null
    }) {
        const targetId = internalSurveyId || submissionId;
        const newUserId = targetUserId || assignedUserId;
        const effectivePriority = assignmentPriority || priority;
        const actor = assignedByUserId || actorId || 'system';

        const list = this.getSurveySubmissions();
        const index = list.findIndex(s => (targetId && (s.internalSurveyId === targetId || s.submissionId === targetId)));
        if (index === -1) {
            const err = new Error(`Survey submission not found: ${targetId}`);
            err.code = 'RECORD_NOT_FOUND';
            throw err;
        }

        const current = list[index];

        // Optimistic concurrency check
        if (expectedVersion !== null && expectedVersion !== undefined) {
            const curVer = current.version || 1;
            if (curVer !== Number(expectedVersion)) {
                const err = new Error('동시 수정 충돌이 발생했습니다. 최신 데이터를 다시 불러온 후 시도해 주세요.');
                err.code = 'CONCURRENCY_CONFLICT';
                throw err;
            }
        }

        const previousAssignedUserId = current.assignedUserId || null;
        const previousPriority = current.assignmentPriority || 'NORMAL';
        const isReassignment = !!previousAssignedUserId && previousAssignedUserId !== newUserId;
        const assignmentStatus = isReassignment ? 'reassigned' : 'assigned';
        const now = this._nowIso();

        const updated = {
            ...current,
            assignedUserId: newUserId,
            assignedDepartmentId: assignedDepartmentId || current.assignedDepartmentId || '',
            assignedByUserId: actor,
            assignedAt: current.assignedAt || now,
            assignmentUpdatedAt: now,
            assignmentStatus,
            assignmentPriority: effectivePriority,
            consultationStatus: '상담배정',
            version: (current.version || 1) + 1,
            updatedAt: now,
            previousAssignedUserId,
            previousPriority
        };

        list[index] = updated;
        await this.saveSurveySubmissions(list);

        // Record history
        let historyItem = null;
        if (this.assignmentRepository) {
            historyItem = await this.assignmentRepository.recordAssignmentHistory({
                surveySubmissionId: updated.internalSurveyId || updated.submissionId,
                previousAssignedUserId,
                newAssignedUserId: newUserId,
                changedByUserId: actor,
                reason,
                previousPriority,
                newPriority: effectivePriority
            });
        }

        // Record audit
        await this.recordAuditEvent({
            actorId: actor,
            action: isReassignment ? 'SURVEY_REASSIGNED' : 'SURVEY_ASSIGNED',
            internalSurveyId: current.internalSurveyId,
            submissionId: current.submissionId,
            result: 'SUCCESS'
        });

        return {
            ...updated,
            submission: updated,
            historyItem,
            isReassignment,
            previousAssignedUserId
        };
    }

    /**
     * Update consultation processing status of a submission
     */
    async updateConsultationStatus({ submissionId, consultationStatus, actorId, note }) {
        if (!submissionId || !consultationStatus) {
            throw new Error('submissionId and consultationStatus are required');
        }

        const list = this.getSurveySubmissions();
        const index = list.findIndex(s => s.submissionId === submissionId || s.internalSurveyId === submissionId);
        if (index === -1) {
            const err = new Error(`Submission ${submissionId} not found`);
            err.code = SURVEY_ERROR_CODES.RECORD_NOT_FOUND;
            throw err;
        }

        const current = list[index];
        const now = this._nowIso();
        const actor = actorId || 'system';

        const updated = {
            ...current,
            consultationStatus,
            consultationStatusUpdatedAt: now,
            consultationStatusUpdatedBy: actor,
            consultationNote: note !== undefined ? note : (current.consultationNote || ''),
            version: (current.version || 1) + 1,
            updatedAt: now
        };

        list[index] = updated;
        await this.saveSurveySubmissions(list);

        // Record audit
        await this.recordAuditEvent({
            actorId: actor,
            action: 'CONSULTATION_STATUS_CHANGED',
            internalSurveyId: current.internalSurveyId,
            submissionId: current.submissionId,
            result: 'SUCCESS'
        });

        return updated;
    }

    // ──────────────────────────────────────────────────────────
    // 3. Survey Consent Evidence
    // ──────────────────────────────────────────────────────────

    getConsentEvidenceList() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_CONSENT_EVIDENCE, []);
    }

    async saveConsentEvidenceList(list) {
        return this.persistData(SURVEY_STORAGE_FILES.SURVEY_CONSENT_EVIDENCE, list);
    }

    // ──────────────────────────────────────────────────────────
    // 4. Survey Import Audit Log
    // ──────────────────────────────────────────────────────────

    getAuditLogs() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT, []);
    }

    async recordAuditEvent({ actorId, action, submissionId, internalSurveyId, result, errorCode, batchId }) {
        const list = this.getAuditLogs();
        const event = {
            id: `aud_${crypto.randomUUID()}`,
            timestamp: this._nowIso(),
            actorId: actorId || 'system',
            action,
            submissionId: submissionId || null,
            internalSurveyId: internalSurveyId || null,
            result: result || 'SUCCESS',
            errorCode: errorCode || null,
            batchId: batchId || null
        };
        list.push(event);
        // Keep last 10,000 audit items
        if (list.length > 10000) {
            list.splice(0, list.length - 10000);
        }
        await this.persistData(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT, list);
        return event;
    }

    // ──────────────────────────────────────────────────────────
    // 4.5. Survey Workflow Journal (Multi-Document Atomic State Tracking)
    // ──────────────────────────────────────────────────────────

    getWorkflowJournal() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_WORKFLOW_JOURNAL, []);
    }

    async saveWorkflowJournal(list) {
        return this.persistData(SURVEY_STORAGE_FILES.SURVEY_WORKFLOW_JOURNAL, list);
    }

    async recordWorkflowStep({ submissionId, internalSurveyId = null, step, details = {} }) {
        const list = this.getWorkflowJournal();
        const entry = {
            id: `jrn_${crypto.randomUUID()}`,
            timestamp: this._nowIso(),
            submissionId,
            internalSurveyId,
            step,
            details: typeof details === 'object' ? details : { info: details }
        };
        list.push(entry);
        if (list.length > 20000) {
            list.splice(0, list.length - 20000);
        }
        await this.saveWorkflowJournal(list);
        return entry;
    }

    getLatestWorkflowStep(submissionId) {
        const list = this.getWorkflowJournal();
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].submissionId === submissionId) {
                return list[i];
            }
        }
        return null;
    }

    // ──────────────────────────────────────────────────────────
    // 5. Atomic Survey Intake Transaction
    // ──────────────────────────────────────────────────────────

    /**
     * Persist a validated survey submission into the database.
     * Integrates with PendingReferrals without unsafe auto-merge.
     */
    async persistSurveyIntake({ envelope, payload, isSbqrQuarantined, quarantineReason, actorId, batchId }) {
        const now = this._nowIso();
        const internalSurveyId = `surv_${crypto.randomUUID()}`;
        const submissionId = envelope.submissionId;

        // Calculate retention expiration
        const retentionDays = payload.retention?.retentionDays || 365;
        const retentionUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

        // 1. Survey Submission Record
        const surveySubmissions = this.getSurveySubmissions();
        const surveyRecord = {
            internalSurveyId,
            submissionId,
            assessmentId: payload.assessmentId,
            assessmentVersion: payload.assessmentVersion,
            contactOnly: !!payload.contactOnly,
            assessmentDataIncluded: !!(payload.assessment && Object.keys(payload.assessment).length > 0),
            importedAt: now,
            consultationStatus: isSbqrQuarantined ? '격리(SBQ-R 대기)' : '신규접수대기',
            assignedUserId: null,
            assignedByUserId: null,
            assignedAt: null,
            assignmentStatus: 'unassigned',
            assignmentPriority: 'NORMAL',
            assignmentUpdatedAt: null,
            version: 1,
            retentionPolicy: payload.retention?.policy || 'standard_counseling_1yr',
            retentionUntil,
            deletionStatus: 'active',
            isSbqrQuarantined: !!isSbqrQuarantined,
            quarantineReason: quarantineReason || null,
            sourceEnvironment: envelope.sourceEnvironment || this.sourceEnvironment || 'mock',
            contact: payload.contact || {},
            assessment: payload.assessment || {},
            createdAt: now,
            updatedAt: now
        };
        surveySubmissions.push(surveyRecord);
        await this.saveSurveySubmissions(surveySubmissions);

        // 2. Consent Evidence Record
        const consentList = this.getConsentEvidenceList();
        const consentEvidence = {
            internalSurveyId,
            submissionId,
            consentVersion: payload.consentEvidence.consentVersion,
            personalInfoConsent: payload.consentEvidence.personalInfoConsent,
            sensitiveInfoConsent: payload.consentEvidence.sensitiveInfoConsent,
            consentedAt: payload.consentEvidence.consentedAt,
            transmittedFieldSet: payload.consentEvidence.transmittedFieldSet,
            sourceEnvironment: envelope.sourceEnvironment || this.sourceEnvironment || 'mock',
            createdAt: now
        };
        consentList.push(consentEvidence);
        await this.saveConsentEvidenceList(consentList);

        // 3. Register into PendingReferrals candidate pool for staff review (unless SBQ-R quarantined)
        let pendingReferralId = null;
        if (!isSbqrQuarantined && payload.contact && (payload.contact.clientName || payload.contact.phone)) {
            const pendingList = this.getData('PendingReferrals', []);
            pendingReferralId = `pref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            
            const pendingEntry = {
                id: pendingReferralId,
                name: payload.contact.clientName || '온라인 설문 접수자',
                phone: payload.contact.phone || '',
                gender: payload.contact.gender || '미상',
                birthDate: payload.contact.birthDate || '',
                region: payload.contact.region || '이천시',
                problem: `[온라인 ${payload.assessmentId.toUpperCase()} 설문] 총점: ${payload.assessment?.totalScore ?? 'N/A'} (${payload.assessment?.severity ?? '미분류'})`,
                reason: payload.contact.counselingRequestText || '온라인 자가검진 후 상담 신청 접수',
                status: 'pending',
                source: 'online_survey',
                sourceEnvironment: envelope.sourceEnvironment || this.sourceEnvironment || 'mock',
                surveySubmissionId: internalSurveyId,
                submissionId: submissionId,
                createdAt: now,
                autoMerged: false // Explicitly unmerged: requires manual staff review
            };
            pendingList.push(pendingEntry);
            await this.persistData('PendingReferrals', pendingList);
        }

        // 4. Update Ledger Status to STORED / COMPLETED
        const ledgerStatus = isSbqrQuarantined
            ? SURVEY_INTERNAL_STATUS.QUARANTINED_SBQR_GATE
            : SURVEY_INTERNAL_STATUS.STORED;

        const ledger = await this.createOrUpdateImportRecord({
            submissionId,
            schemaVersion: envelope.schemaVersion,
            keyVersion: envelope.keyVersion,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: ledgerStatus,
            importedAt: now,
            lastAttemptAt: now
        });

        // 5. Record Audit
        await this.recordAuditEvent({
            actorId,
            action: isSbqrQuarantined ? 'SURVEY_IMPORT_QUARANTINED' : 'SURVEY_IMPORT_STORED',
            submissionId,
            internalSurveyId,
            result: isSbqrQuarantined ? 'QUARANTINED' : 'SUCCESS',
            errorCode: isSbqrQuarantined ? 'SBQR_GATE_UNAPPROVED' : null,
            batchId
        });

        // 6. Read-back Persistence Verification
        const verifiedSub = this.findSubmissionById(internalSurveyId);
        if (!verifiedSub) {
            throw new Error(`Read-back persistence check failed for internalSurveyId ${internalSurveyId}`);
        }

        return {
            internalSurveyId,
            ledger,
            pendingReferralId
        };
    }
}

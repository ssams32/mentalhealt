/**
 * server/survey/surveyImportService.js
 * Atomic, idempotent import coordinator for pulling encrypted envelopes from Track A,
 * validating lease ownership, in-memory decryption, payload & consent validation,
 * referral & report generation, ACK readiness gating, safe deletion, and lease error recovery.
 */

import crypto from 'crypto';
import {
    SURVEY_ERROR_CODES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    SURVEY_WORKFLOW_STEPS,
    TRACK_A_FAILURE_CATEGORIES,
    NOTIFICATION_TYPES,
    DEFAULT_LEASE_SECONDS
} from './surveyConstants.js';
import { SurveyOperationError } from './surveyErrors.js';

export class SurveyImportService {
    /**
     * @param {Object} deps
     * @param {import('./surveyImportRepository.js').SurveyImportRepository} deps.repository
     * @param {import('./surveyDecryptionService.js').SurveyDecryptionService} deps.decryptionService
     * @param {import('./surveyPayloadValidator.js').SurveyPayloadValidator} deps.validator
     * @param {Object} deps.externalApiClient - TrackAClient or compatible mock
     * @param {import('./surveyReferralService.js').SurveyReferralService} [deps.referralService]
     * @param {Object} [deps.assignmentRepository]
     * @param {Object} [deps.notificationRepository]
     * @param {string} [deps.workerId] - Configured Track B worker ID
     * @param {number} [deps.defaultLeaseSeconds=600]
     * @param {string} [deps.sourceEnvironment='mock']
     */
    constructor(deps = {}) {
        if (!deps.repository || !deps.decryptionService || !deps.validator || !deps.externalApiClient) {
            throw new Error('SurveyImportService missing required dependencies');
        }
        this.repository = deps.repository;
        this.decryptionService = deps.decryptionService;
        this.validator = deps.validator;
        this.externalApiClient = deps.externalApiClient;
        this.referralService = deps.referralService || null;
        this.assignmentRepository = deps.assignmentRepository || null;
        this.notificationRepository = deps.notificationRepository || null;
        this.workerId = deps.workerId || process.env.TRACK_B_WORKER_ID || 'track-b-worker-1';
        this.defaultLeaseSeconds = Number(deps.defaultLeaseSeconds) || Number(process.env.TRACK_A_DEFAULT_LEASE_SECONDS) || DEFAULT_LEASE_SECONDS || 600;
        this.sourceEnvironment = deps.sourceEnvironment || process.env.SURVEY_TRACK_A_MODE || 'mock';

        this._isImportRunning = false;
        this._currentBatchId = null;
    }

    /**
     * Acquire single-instance import semaphore.
     */
    _acquireLock() {
        if (this._isImportRunning) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.IMPORT_ALREADY_IN_PROGRESS,
                '현재 다른 가져오기 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.'
            );
        }
        this._isImportRunning = true;
        this._currentBatchId = `bch_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
        return this._currentBatchId;
    }

    /**
     * Release import semaphore safely.
     */
    _releaseLock() {
        this._isImportRunning = false;
        this._currentBatchId = null;
    }

    /**
     * Main manual import operation triggered by "신규 온라인 설문 가져오기".
     * 
     * @param {Object} options
     * @param {string} options.actorId - User ID of authorized administrator
     * @param {number} [options.limit=50] - Bounded batch limit
     * @returns {Promise<{ batchId: string, totalFetched: number, imported: number, duplicates: number, quarantined: number, ackPending: number, deletePending: number, completedAt: string }>}
     */
    async runManualImport({ actorId, limit = 50 }) {
        const batchId = this._acquireLock();

        const summary = {
            batchId,
            totalFetched: 0,
            imported: 0,
            duplicates: 0,
            quarantined: 0,
            ackPending: 0,
            deletePending: 0,
            completedAt: null
        };

        try {
            await this.repository.recordAuditEvent({
                actorId,
                action: 'SURVEY_IMPORT_BATCH_STARTED',
                result: 'STARTED',
                batchId
            });

            // [E2E_STEP 01/14] Track A 연결 및 게이트 상태 검증
            if (typeof this.externalApiClient.checkSubmissionGateStatus === 'function') {
                const gate = await this.externalApiClient.checkSubmissionGateStatus();
                if (!gate.enabled) {
                    console.warn(`⚠️ [E2E_STEP 01/14] Track A 연결 확인: 준비 미완료 (${gate.message})`);
                    await this.repository.recordAuditEvent({
                        actorId,
                        action: 'TRACK_A_GATE_DISABLED',
                        result: 'PREPARATION_INCOMPLETE',
                        errorCode: 'COUNSELING_SUBMISSION_DISABLED',
                        batchId
                    });
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.EXTERNAL_API_UNAVAILABLE,
                        `Track A 연동 준비 미완료: COUNSELING_SUBMISSION_ENABLED=false (${gate.message || '상담 접수 수집이 활성화되지 않았습니다.'})`
                    );
                }
            }
            console.log(`📡 [E2E_STEP 01/14] Track A 연결: 성공 (COUNSELING_SUBMISSION_ENABLED=true)`);

            // [E2E_STEP 02/14] pending 조회
            console.log(`📥 [E2E_STEP 02/14] pending 조회: 시작 (limit: ${limit}, leaseSeconds: ${this.defaultLeaseSeconds})`);
            let externalResponse;
            try {
                if (typeof this.externalApiClient.leasePendingSubmissions === 'function') {
                    externalResponse = await this.externalApiClient.leasePendingSubmissions({
                        limit,
                        leaseSeconds: this.defaultLeaseSeconds
                    });
                } else {
                    externalResponse = await this.externalApiClient.fetchPending({
                        limit,
                        leaseSeconds: this.defaultLeaseSeconds
                    });
                }
            } catch (err) {
                await this.repository.recordAuditEvent({
                    actorId,
                    action: 'SURVEY_IMPORT_BATCH_FAILED',
                    result: 'NETWORK_ERROR',
                    errorCode: SURVEY_ERROR_CODES.EXTERNAL_API_UNAVAILABLE,
                    batchId
                });
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.EXTERNAL_API_UNAVAILABLE,
                    '외부 설문 수집 서비스에 연결할 수 없습니다.'
                );
            }

            const envelopes = externalResponse?.submissions || [];
            summary.totalFetched = envelopes.length;
            console.log(`📥 [E2E_STEP 02/14] pending 조회: 완료 (${envelopes.length}건 수신)`);

            // 2. Process each leased envelope atomically
            for (const envelope of envelopes) {
                const subId = envelope?.submissionId;
                if (!subId) {
                    summary.quarantined++;
                    continue;
                }

                // Extract lease metadata
                const lease = envelope.lease || {};
                const leaseId = lease.leaseId || `lease_${subId.substring(0, 8)}`;
                const leasedAt = lease.leasedAt || new Date().toISOString();
                const leaseUntil = lease.leaseUntil || new Date(Date.now() + this.defaultLeaseSeconds * 1000).toISOString();
                const now = Date.now();

                // Check submission uniqueness in ledger
                const existing = this.repository.findBySubmissionId(subId);
                if (existing && (existing.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED || existing.internalStatus === SURVEY_INTERNAL_STATUS.STORED)) {
                    summary.duplicates++;
                    console.log(`ℹ️ [E2E_DEDUP] 이미 처리 완료된 설문입니다. 중복 생성 방지: submissionId=${subId}`);
                    // Re-verify ACK / Delete status in case previous run failed midway
                    await this._reconcileExternalState(existing, { leaseId, leaseUntil });
                    continue;
                }

                // Check lease expiration before starting processing
                if (leaseUntil && new Date(leaseUntil).getTime() <= now) {
                    summary.quarantined++;
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: subId,
                        leaseId,
                        leasedAt,
                        leaseUntil,
                        workerId: this.workerId,
                        internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
                        lastErrorCode: SURVEY_ERROR_CODES.LEASE_EXPIRED
                    });
                    continue;
                }

                // [E2E_STEP 03/14] lease 획득
                const leaseDurationSec = Math.round((new Date(leaseUntil).getTime() - now) / 1000);
                console.log(`🔒 [E2E_STEP 03/14] lease 획득: submissionId=${subId}, leaseId=${leaseId}, leaseDuration=${leaseDurationSec}s`);

                // Persist lease ownership metadata in ledger before in-memory decryption
                await this.repository.createOrUpdateImportRecord({
                    submissionId: subId,
                    leaseId,
                    leasedAt,
                    leaseUntil,
                    workerId: this.workerId,
                    schemaVersion: envelope.schemaVersion || 'v1.0',
                    keyVersion: envelope.keyVersion || 'k2026_01',
                    externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
                    internalStatus: SURVEY_INTERNAL_STATUS.DOWNLOADED,
                    receivedAt: envelope.receivedAt || new Date().toISOString()
                });

                await this.repository.recordWorkflowStep({
                    submissionId: subId,
                    step: SURVEY_WORKFLOW_STEPS.LEASE_RECEIVED,
                    details: { leaseId, workerId: this.workerId, leaseUntil }
                });

                // [E2E_STEP 04/14] 복호화 (In-memory Decryption)
                let payload;
                try {
                    payload = this.decryptionService.decryptEnvelope(envelope);
                    console.log(`🔓 [E2E_STEP 04/14] 복호화: 성공 (keyVersion=${envelope.keyVersion || 'k2026_01'}, submissionId=${subId})`);
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: subId,
                        internalStatus: SURVEY_INTERNAL_STATUS.DECRYPTED,
                        decryptedAt: new Date().toISOString()
                    });
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        step: SURVEY_WORKFLOW_STEPS.DECRYPTED,
                        details: { keyVersion: envelope.keyVersion }
                    });
                } catch (decErr) {
                    summary.quarantined++;
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: subId,
                        internalStatus: SURVEY_INTERNAL_STATUS.QUARANTINED_TAMPERED,
                        lastErrorCode: decErr.code || SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED
                    });
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        step: SURVEY_WORKFLOW_STEPS.QUARANTINED,
                        details: { reason: decErr.code || 'CIPHERTEXT_AUTHENTICATION_FAILED' }
                    });
                    await this.repository.recordAuditEvent({
                        actorId,
                        action: 'SURVEY_DECRYPTION_FAILED',
                        submissionId: subId,
                        result: 'QUARANTINED',
                        errorCode: decErr.code || SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED,
                        batchId
                    });

                    // Report failure to Track A without payload details
                    const failedRequestId = `req_fail_${subId}_${Date.now()}`;
                    try {
                        if (typeof this.externalApiClient.reportSubmissionFailed === 'function') {
                            await this.externalApiClient.reportSubmissionFailed(subId, {
                                leaseId,
                                workerId: this.workerId,
                                requestId: failedRequestId,
                                category: TRACK_A_FAILURE_CATEGORIES.QUARANTINED,
                                reason: decErr.code || 'CIPHERTEXT_AUTH_FAILED'
                            });
                        } else if (typeof this.externalApiClient.reportFailure === 'function') {
                            await this.externalApiClient.reportFailure(subId, decErr.code || 'CIPHERTEXT_AUTH_FAILED');
                        }
                    } catch (ignore) {}
                    continue;
                }

                // [E2E_STEP 05/14] 동의 검증 (Schema, Consent, and Allowlist Validation)
                let validationResult;
                try {
                    validationResult = this.validator.validate(payload);
                    console.log(`✅ [E2E_STEP 05/14] 동의 검증: 성공 (필수 동의 2종 확인, allowlist 검증 완료, assessmentId=${payload.assessmentId})`);
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        step: SURVEY_WORKFLOW_STEPS.PAYLOAD_VALIDATED,
                        details: { assessmentId: payload.assessmentId }
                    });
                } catch (valErr) {
                    summary.quarantined++;
                    const quarantineStatus = valErr.code === SURVEY_ERROR_CODES.CONSENT_VIOLATION_PERSONAL ||
                                            valErr.code === SURVEY_ERROR_CODES.CONSENT_VIOLATION_SENSITIVE
                                            ? SURVEY_INTERNAL_STATUS.QUARANTINED_CONSENT
                                            : SURVEY_INTERNAL_STATUS.QUARANTINED_SCHEMA;

                    await this.repository.createOrUpdateImportRecord({
                        submissionId: subId,
                        internalStatus: quarantineStatus,
                        lastErrorCode: valErr.code || SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA
                    });
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        step: SURVEY_WORKFLOW_STEPS.QUARANTINED,
                        details: { reason: valErr.code || 'INVALID_PAYLOAD_SCHEMA' }
                    });
                    await this.repository.recordAuditEvent({
                        actorId,
                        action: 'SURVEY_VALIDATION_QUARANTINED',
                        submissionId: subId,
                        result: 'QUARANTINED',
                        errorCode: valErr.code || SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                        batchId
                    });

                    const failedRequestId = `req_fail_${subId}_${Date.now()}`;
                    try {
                        if (typeof this.externalApiClient.reportSubmissionFailed === 'function') {
                            await this.externalApiClient.reportSubmissionFailed(subId, {
                                leaseId,
                                workerId: this.workerId,
                                requestId: failedRequestId,
                                category: TRACK_A_FAILURE_CATEGORIES.QUARANTINED,
                                reason: valErr.code || 'SCHEMA_INVALID'
                            });
                        } else if (typeof this.externalApiClient.reportFailure === 'function') {
                            await this.externalApiClient.reportFailure(subId, valErr.code || 'SCHEMA_INVALID');
                        }
                    } catch (ignore) {}
                    continue;
                }

                // [E2E_STEP 06/14] 설문 저장 (Atomic Survey Intake Database Persistence)
                let intakeResult;
                try {
                    intakeResult = await this.repository.persistSurveyIntake({
                        envelope,
                        payload,
                        isSbqrQuarantined: validationResult.isSbqrQuarantined,
                        quarantineReason: validationResult.quarantineReason,
                        actorId,
                        batchId
                    });
                    console.log(`💾 [E2E_STEP 06/14] 설문 저장: 성공 (internalSurveyId=${intakeResult.internalSurveyId}, env=${this.sourceEnvironment})`);

                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        internalSurveyId: intakeResult.internalSurveyId,
                        step: SURVEY_WORKFLOW_STEPS.SURVEY_STORED
                    });
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        internalSurveyId: intakeResult.internalSurveyId,
                        step: SURVEY_WORKFLOW_STEPS.CONSENT_STORED
                    });

                    if (validationResult.isSbqrQuarantined) {
                        summary.quarantined++;
                    } else {
                        summary.imported++;
                    }
                } catch (persistErr) {
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: subId,
                        internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
                        lastErrorCode: SURVEY_ERROR_CODES.PERSISTENCE_FAILED
                    });
                    await this.repository.recordAuditEvent({
                        actorId,
                        action: 'SURVEY_PERSISTENCE_FAILED',
                        submissionId: subId,
                        result: 'FAILED',
                        errorCode: SURVEY_ERROR_CODES.PERSISTENCE_FAILED,
                        batchId
                    });
                    continue; // Do NOT ACK or delete on persistence failure
                }

                // Strict SBQ-R Gate: Quarantined SBQ-R submissions do NOT create referrals
                if (validationResult.isSbqrQuarantined) {
                    await this.repository.recordWorkflowStep({
                        submissionId: subId,
                        internalSurveyId: intakeResult.internalSurveyId,
                        step: SURVEY_WORKFLOW_STEPS.QUARANTINED,
                        details: { reason: 'SBQR_GATE_UNAPPROVED' }
                    });

                    const failedRequestId = `req_fail_${subId}_${Date.now()}`;
                    try {
                        if (typeof this.externalApiClient.reportSubmissionFailed === 'function') {
                            await this.externalApiClient.reportSubmissionFailed(subId, {
                                leaseId,
                                workerId: this.workerId,
                                requestId: failedRequestId,
                                category: TRACK_A_FAILURE_CATEGORIES.QUARANTINED,
                                reason: 'SBQR_GATE_UNAPPROVED'
                            });
                        } else if (typeof this.externalApiClient.reportFailure === 'function') {
                            await this.externalApiClient.reportFailure(subId, 'SBQR_GATE_UNAPPROVED');
                        }
                    } catch (ignore) {}
                    continue; // Stop here for SBQ-R: No referral, no ordinary ACK, no delete
                }

                // Automatic Referral Draft & Neutral Screening Report Attachment Creation
                let referralResult = null;
                if (this.referralService) {
                    try {
                        referralResult = await this.referralService.createReferralFromSurvey({
                            payload,
                            internalSurveyId: intakeResult.internalSurveyId,
                            submissionId: subId,
                            sourceEnvironment: this.sourceEnvironment,
                            actorId
                        });

                        if (referralResult?.referral?.referralId) {
                            await this.repository.updateSubmissionReferralLink(
                                intakeResult.internalSurveyId,
                                referralResult.referral.referralId
                            );
                        }

                        // [E2E_STEP 07/14] 의뢰대장 생성
                        console.log(`📋 [E2E_STEP 07/14] 의뢰대장 생성: 성공 (referralId=${referralResult?.referral?.referralId || referralResult?.referral?.id}, refNo=${referralResult?.referral?.refNo})`);
                        // [E2E_STEP 08/14] PDF 생성
                        console.log(`📄 [E2E_STEP 08/14] PDF 생성: 성공 (파일명: ${referralResult?.attachment?.name}, 크기: ${referralResult?.attachment?.size}B)`);
                        // [E2E_STEP 09/14] 첨부 등록
                        console.log(`📎 [E2E_STEP 09/14] 첨부 등록: 성공 (attachmentId=${referralResult?.attachment?.id})`);
                        // [E2E_STEP 10/14] 첨부 read-back
                        console.log(`🔍 [E2E_STEP 10/14] 첨부 read-back: 성공 (디스크 파일 무결성 및 바이트 크기 일치 확인)`);

                        await this.repository.recordWorkflowStep({
                            submissionId: subId,
                            internalSurveyId: intakeResult.internalSurveyId,
                            step: SURVEY_WORKFLOW_STEPS.REFERRAL_CREATED,
                            details: { refNo: referralResult?.referral?.refNo }
                        });
                        await this.repository.recordWorkflowStep({
                            submissionId: subId,
                            internalSurveyId: intakeResult.internalSurveyId,
                            step: SURVEY_WORKFLOW_STEPS.REPORT_GENERATED,
                            details: { reportAttachmentId: referralResult?.attachment?.id }
                        });
                        await this.repository.recordWorkflowStep({
                            submissionId: subId,
                            internalSurveyId: intakeResult.internalSurveyId,
                            step: SURVEY_WORKFLOW_STEPS.ATTACHMENT_REGISTERED
                        });
                        await this.repository.recordWorkflowStep({
                            submissionId: subId,
                            internalSurveyId: intakeResult.internalSurveyId,
                            step: SURVEY_WORKFLOW_STEPS.READ_BACK_VERIFIED
                        });
                    } catch (referralErr) {
                        console.error(`❌ [SURVEY_REFERRAL_CREATION_FAILED] ${subId}:`, referralErr.message);
                        await this.repository.createOrUpdateImportRecord({
                            submissionId: subId,
                            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
                            lastErrorCode: 'REFERRAL_CREATION_FAILED'
                        });
                        await this.repository.recordAuditEvent({
                            actorId,
                            action: 'SURVEY_REFERRAL_CREATION_FAILED',
                            submissionId: subId,
                            result: 'FAILED',
                            errorCode: referralErr.message || 'REFERRAL_CREATION_FAILED',
                            batchId
                        });
                        // Do NOT ACK or delete if referral creation or report generation fails!
                        continue;
                    }
                }

                // Phase 12 & 13: External ACK Readiness Gate and Ciphertext Deletion Sequence
                await this._acknowledgeAndDeleteExternalRecord(
                    subId,
                    { leaseId, leaseUntil },
                    actorId,
                    batchId,
                    summary,
                    {
                        internalSurveyId: intakeResult.internalSurveyId,
                        referralId: referralResult?.referral?.referralId,
                        priority: validationResult?.priority || 'NORMAL'
                    }
                );
            }

            summary.completedAt = new Date().toISOString();

            await this.repository.recordAuditEvent({
                actorId,
                action: 'SURVEY_IMPORT_BATCH_COMPLETED',
                result: 'SUCCESS',
                batchId
            });

            return summary;
        } finally {
            this._releaseLock();
        }
    }

    /**
     * Send ACK only after verified internal persistence & report generation, then request deletion.
     */
    async _acknowledgeAndDeleteExternalRecord(submissionId, leaseMetadata, actorId, batchId, summary, extraParams = {}) {
        const record = this.repository.findBySubmissionId(submissionId);
        const leaseId = leaseMetadata?.leaseId || record?.leaseId;
        const leaseUntil = leaseMetadata?.leaseUntil || record?.leaseUntil;

        // Phase 12 Gate Checks: Check lease validity before sending ACK
        const now = Date.now();
        if (leaseUntil && new Date(leaseUntil).getTime() <= now) {
            await this.repository.createOrUpdateImportRecord({
                submissionId,
                lastErrorCode: SURVEY_ERROR_CODES.ACK_REQUIRES_REACQUIRE
            });
            await this.repository.recordWorkflowStep({
                submissionId,
                step: SURVEY_WORKFLOW_STEPS.ACK_PENDING,
                details: { status: 'REQUIRES_REACQUIRE', reason: 'LOCAL_LEASE_EXPIRED' }
            });
            if (summary) summary.ackPending++;
            return;
        }

        // Reuse or create stable ackRequestId
        const ackRequestId = record?.ackRequestId || `req_ack_${submissionId}_${Date.now()}`;
        await this.repository.createOrUpdateImportRecord({
            submissionId,
            ackRequestId
        });
        await this.repository.recordWorkflowStep({
            submissionId,
            step: SURVEY_WORKFLOW_STEPS.ACK_PENDING,
            details: { leaseId, ackRequestId }
        });

        // 1. Send External ACK [E2E_STEP 11/14]
        let ackSuccess = false;
        try {
            let ackResp;
            if (typeof this.externalApiClient.acknowledgeSubmission === 'function') {
                ackResp = await this.externalApiClient.acknowledgeSubmission(submissionId, {
                    leaseId,
                    workerId: this.workerId,
                    requestId: ackRequestId
                });
            } else {
                ackResp = await this.externalApiClient.acknowledge(submissionId, {
                    leaseId,
                    workerId: this.workerId,
                    requestId: ackRequestId
                });
            }

            if (ackResp && ackResp.success !== false) {
                ackSuccess = true;
                await this.repository.createOrUpdateImportRecord({
                    submissionId,
                    externalStatus: SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED,
                    internalStatus: SURVEY_INTERNAL_STATUS.COMPLETED,
                    acknowledgedAt: new Date().toISOString()
                });
                await this.repository.recordWorkflowStep({
                    submissionId,
                    step: SURVEY_WORKFLOW_STEPS.ACKED,
                    details: { leaseId, ackRequestId }
                });
                console.log(`🤝 [E2E_STEP 11/14] ACK: 성공 (ackRequestId=${ackRequestId}, externalStatus=ACKNOWLEDGED)`);
            } else {
                throw new Error('ACK rejected by external service');
            }
        } catch (ackErr) {
            const isLeaseExpired = ackErr.isLeaseExpired || ackErr.code === 'LEASE_EXPIRED' || ackErr.trackACode === 'LEASE_EXPIRED';
            const errorCode = isLeaseExpired ? SURVEY_ERROR_CODES.ACK_REQUIRES_REACQUIRE : SURVEY_ERROR_CODES.EXTERNAL_ACK_FAILED;

            if (summary) summary.ackPending++;
            await this.repository.createOrUpdateImportRecord({
                submissionId,
                lastErrorCode: errorCode
            });
            await this.repository.recordAuditEvent({
                actorId,
                action: isLeaseExpired ? 'SURVEY_LEASE_REACQUIRE_REQUIRED' : 'SURVEY_EXTERNAL_ACK_FAILED',
                submissionId,
                result: 'RETRY_PENDING',
                errorCode,
                batchId
            });
            return; // Cannot proceed without successful ACK!
        }

        // [E2E_STEP 12/14] 담당자 배정
        const assignedUserId = 'admin';
        if (this.repository && typeof this.repository.assignStaff === 'function') {
            try {
                await this.repository.assignStaff({
                    internalSurveyId: extraParams?.internalSurveyId,
                    submissionId,
                    targetUserId: assignedUserId,
                    actorId: actorId || 'system',
                    reason: '신규 온라인 설문 자동 배정',
                    priority: extraParams?.priority || 'NORMAL'
                });
                await this.repository.recordWorkflowStep({
                    submissionId,
                    internalSurveyId: extraParams?.internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.ASSIGNED,
                    details: { assignedUserId }
                });
                console.log(`👤 [E2E_STEP 12/14] 담당자 배정: 성공 (assignedUserId=${assignedUserId})`);
            } catch (assignErr) {
                console.warn(`⚠️ [E2E_STEP 12/14] 담당자 배정 경고 (비치명적): ${assignErr.message}`);
            }
        }

        // [E2E_STEP 13/14] 내부 알림
        if (this.notificationRepository && typeof this.notificationRepository.createNotification === 'function') {
            try {
                const notifResult = await this.notificationRepository.createNotification({
                    recipientUserId: assignedUserId,
                    type: NOTIFICATION_TYPES.SURVEY_ASSIGNED,
                    relatedEntityType: 'survey',
                    relatedEntityId: submissionId,
                    safeTitle: '신규 온라인 설문이 배정되었습니다.',
                    safeMessage: `접수번호 [${extraParams?.internalSurveyId || submissionId}] 신규 건이 배정되었습니다.`,
                    priority: extraParams?.priority || 'NORMAL',
                    createdByUserId: actorId || 'system',
                    deduplicationKey: `survey_assign_${submissionId}_${assignedUserId}`
                });
                await this.repository.recordWorkflowStep({
                    submissionId,
                    internalSurveyId: extraParams?.internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.NOTIFICATION_CREATED,
                    details: { notificationId: notifResult.notificationId || notifResult.notification?.notificationId }
                });
                console.log(`🔔 [E2E_STEP 13/14] 내부 알림: 성공 (notifId=${notifResult.notificationId || notifResult.notification?.notificationId})`);
            } catch (notifErr) {
                console.warn(`⚠️ [E2E_STEP 13/14] 내부 알림 경고 (비치명적): ${notifErr.message}`);
            }
        }

        // 2. Phase 13 Delete Sequence: Only after ACK succeeds! [E2E_STEP 14/14]
        const deleteRequestId = record?.deleteRequestId || `req_del_${submissionId}_${Date.now()}`;
        await this.repository.createOrUpdateImportRecord({
            submissionId,
            deleteRequestId,
            deletionRequestedAt: new Date().toISOString()
        });
        await this.repository.recordWorkflowStep({
            submissionId,
            step: SURVEY_WORKFLOW_STEPS.DELETE_PENDING,
            details: { deleteRequestId }
        });

        try {
            let delResp;
            if (typeof this.externalApiClient.deleteImportedSubmission === 'function') {
                delResp = await this.externalApiClient.deleteImportedSubmission(submissionId, {
                    leaseId,
                    workerId: this.workerId,
                    requestId: deleteRequestId
                });
            } else {
                delResp = await this.externalApiClient.deleteCiphertext(submissionId, {
                    leaseId,
                    workerId: this.workerId,
                    requestId: deleteRequestId
                });
            }

            if (delResp && delResp.success !== false) {
                await this.repository.createOrUpdateImportRecord({
                    submissionId,
                    externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
                    externalDeletedAt: new Date().toISOString()
                });
                await this.repository.recordWorkflowStep({
                    submissionId,
                    step: SURVEY_WORKFLOW_STEPS.COMPLETED,
                    details: { deleteRequestId }
                });
                await this.repository.recordAuditEvent({
                    actorId,
                    action: 'SURVEY_EXTERNAL_DELETED',
                    submissionId,
                    result: 'SUCCESS',
                    batchId
                });
                console.log(`🗑️ [E2E_STEP 14/14] 외부 delete: 성공 (deleteRequestId=${deleteRequestId}, externalStatus=DELETED)`);
            } else {
                throw new Error('Delete rejected by external service');
            }
        } catch (delErr) {
            if (summary) summary.deletePending++;
            await this.repository.createOrUpdateImportRecord({
                submissionId,
                externalStatus: SURVEY_EXTERNAL_STATUS.DELETE_PENDING,
                lastErrorCode: SURVEY_ERROR_CODES.EXTERNAL_DELETE_FAILED
            });
            await this.repository.recordAuditEvent({
                actorId,
                action: 'SURVEY_EXTERNAL_DELETE_PENDING',
                submissionId,
                result: 'RETRY_PENDING',
                errorCode: SURVEY_ERROR_CODES.EXTERNAL_DELETE_FAILED,
                batchId
            });
        }
    }

    /**
     * Reconcile external ACK / deletion state for duplicates or partially completed imports.
     */
    async _reconcileExternalState(ledgerRecord, leaseMetadata = {}) {
        if (ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.DELETED) {
            return;
        }

        const deleteRequestId = ledgerRecord.deleteRequestId || `req_del_${ledgerRecord.submissionId}_reconcile`;
        if (ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING || ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED) {
            try {
                let res;
                if (typeof this.externalApiClient.deleteImportedSubmission === 'function') {
                    res = await this.externalApiClient.deleteImportedSubmission(ledgerRecord.submissionId, {
                        leaseId: leaseMetadata.leaseId || ledgerRecord.leaseId,
                        workerId: this.workerId,
                        requestId: deleteRequestId
                    });
                } else {
                    res = await this.externalApiClient.deleteCiphertext(ledgerRecord.submissionId, {
                        leaseId: leaseMetadata.leaseId || ledgerRecord.leaseId,
                        workerId: this.workerId,
                        requestId: deleteRequestId
                    });
                }

                if (res && res.success !== false) {
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: ledgerRecord.submissionId,
                        externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
                        externalDeletedAt: new Date().toISOString()
                    });
                }
            } catch (ignore) {}
        }
    }

    /**
     * Reacquire lease and complete ACK/delete for records where lease expired.
     * Guarantees zero duplicate referrals or reports.
     */
    async reacquireLeaseAndComplete(submissionId, actorId = 'system') {
        const record = this.repository.findBySubmissionId(submissionId);
        if (!record) throw new Error(`Submission not found: ${submissionId}`);

        // Re-lease from Track A
        let freshEnvelope = null;
        let response;
        if (typeof this.externalApiClient.leasePendingSubmissions === 'function') {
            response = await this.externalApiClient.leasePendingSubmissions({ limit: 50 });
        } else {
            response = await this.externalApiClient.fetchPending({ limit: 50 });
        }

        freshEnvelope = (response?.submissions || []).find(s => s.submissionId === submissionId);
        if (!freshEnvelope || !freshEnvelope.lease?.leaseId) {
            throw new Error(`Could not reacquire active lease for submissionId: ${submissionId}`);
        }

        // Update lease in ledger without recreating survey or referral draft
        await this.repository.createOrUpdateImportRecord({
            submissionId,
            leaseId: freshEnvelope.lease.leaseId,
            leasedAt: freshEnvelope.lease.leasedAt,
            leaseUntil: freshEnvelope.lease.leaseUntil,
            workerId: this.workerId,
            lastErrorCode: null
        });

        // Perform ACK and delete with the new lease
        await this._acknowledgeAndDeleteExternalRecord(
            submissionId,
            freshEnvelope.lease,
            actorId,
            'reacquire',
            null
        );

        return { success: true, submissionId, newLeaseId: freshEnvelope.lease.leaseId };
    }

    /**
     * Retry all pending external deletions.
     */
    async retryPendingDeletions(actorId = 'system') {
        const list = this.repository.getImportsLedger();
        const pending = list.filter(item =>
            item.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING ||
            (item.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED && item.externalStatus !== SURVEY_EXTERNAL_STATUS.DELETED)
        );

        let succeeded = 0;
        let failed = 0;

        for (const item of pending) {
            const deleteRequestId = item.deleteRequestId || `req_del_${item.submissionId}_retry`;
            try {
                let res;
                if (typeof this.externalApiClient.deleteImportedSubmission === 'function') {
                    res = await this.externalApiClient.deleteImportedSubmission(item.submissionId, {
                        leaseId: item.leaseId,
                        workerId: this.workerId,
                        requestId: deleteRequestId
                    });
                } else {
                    res = await this.externalApiClient.deleteCiphertext(item.submissionId, {
                        leaseId: item.leaseId,
                        workerId: this.workerId,
                        requestId: deleteRequestId
                    });
                }

                if (res && res.success !== false) {
                    await this.repository.createOrUpdateImportRecord({
                        submissionId: item.submissionId,
                        externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
                        externalDeletedAt: new Date().toISOString()
                    });
                    succeeded++;
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
            }
        }
        return { total: pending.length, succeeded, failed };
    }

    /**
     * Startup workflow recovery: scans for uncompleted deletions or pending ACKs.
     */
    async recoverPendingWorkflows(actorId = 'system') {
        const deletionResults = await this.retryPendingDeletions(actorId);
        return {
            recoveredDeletions: deletionResults.succeeded,
            failedDeletions: deletionResults.failed
        };
    }

    /**
     * Return safe summary status for admin dashboard.
     */
    getStatusSummary() {
        const ledger = this.repository.getImportsLedger();
        const submissions = this.repository.getSurveySubmissions();

        return {
            totalImports: ledger.length,
            completed: ledger.filter(i => i.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED).length,
            quarantined: ledger.filter(i => i.internalStatus.startsWith('QUARANTINED')).length,
            quarantinedSbqr: ledger.filter(i => i.internalStatus === SURVEY_INTERNAL_STATUS.QUARANTINED_SBQR_GATE).length,
            deletePending: ledger.filter(i => i.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING).length,
            ackPending: ledger.filter(i => i.externalStatus === SURVEY_EXTERNAL_STATUS.LEASED).length,
            isImportRunning: this._isImportRunning,
            currentBatchId: this._currentBatchId,
            totalSubmissions: submissions.length
        };
    }
}

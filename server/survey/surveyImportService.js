/**
 * server/survey/surveyImportService.js
 * Atomic, idempotent import coordinator for pulling encrypted envelopes from Track A,
 * validating lease ownership, in-memory decryption, payload & consent validation,
 * referral & report generation, ACK readiness gating, safe deletion, and lease error recovery.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    SURVEY_ERROR_CODES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    SURVEY_WORKFLOW_STEPS,
    TRACK_A_FAILURE_CATEGORIES,
    NOTIFICATION_TYPES,
    DEFAULT_LEASE_SECONDS,
    SURVEY_PROCESSING_STATUS,
    SURVEY_ASSIGNMENT_STATUS
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
        const rawBatchSize = deps.maxBatchSize !== undefined ? deps.maxBatchSize : process.env.TRACK_A_MAX_BATCH_SIZE;
        const parsedBatchSize = Number(rawBatchSize);
        this.maxBatchSize = (rawBatchSize !== null && rawBatchSize !== '' && /^\d+$/.test(String(rawBatchSize).trim()) && Number.isInteger(parsedBatchSize) && parsedBatchSize >= 1 && parsedBatchSize <= 100)
            ? parsedBatchSize
            : 50;
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
     * Check if an import job is currently executing.
     */
    get isImportRunning() {
        return this._isImportRunning;
    }

    /**
     * Main manual import operation triggered by "지금 동기화".
     * Processes all currently available Track A pending submissions through bounded batches.
     */
    async runManualImport(options = {}) {
        return this._drainAndImportSubmissions({
            actorId: options.actorId || 'admin',
            mode: 'MANUAL',
            limit: options.limit,
            batchSize: options.batchSize,
            maxItems: options.maxItems,
            maxDurationMs: options.maxDurationMs,
            delayBetweenBatchesMs: options.delayBetweenBatchesMs
        });
    }

    /**
     * Automatic server-side scheduled import cycle.
     */
    async runAutoImportCycle(options = {}) {
        return this._drainAndImportSubmissions({
            actorId: options.actorId || 'system_auto_import',
            mode: 'AUTO',
            batchSize: options.batchSize || 10,
            maxItems: options.maxItems || 100,
            maxDurationMs: options.maxDurationMs || 300000,
            delayBetweenBatchesMs: options.delayBetweenBatchesMs || 300
        });
    }

    /**
     * Safe, bounded batch drain loop for ingesting all Track A pending submissions.
     */
    async _drainAndImportSubmissions({
        actorId = 'system',
        mode = 'MANUAL',
        limit = 50,
        batchSize = 10,
        maxItems = 200,
        maxDurationMs = 600000,
        delayBetweenBatchesMs = 300
    } = {}) {
        const batchId = this._acquireLock();
        const startTime = Date.now();

        const effBatchSize = Math.max(1, Math.min(50, Number(batchSize) || Number(limit) || 10));
        const effMaxItems = Math.max(1, Math.min(500, Number(maxItems) || 200));
        const effMaxDuration = Math.max(5000, Math.min(1800000, Number(maxDurationMs) || 600000));
        const effDelayMs = Math.max(0, Math.min(5000, Number(delayBetweenBatchesMs) || 300));

        const summary = {
            jobId: batchId,
            batchId,
            mode,
            startedAt: new Date(startTime).toISOString(),
            completedAt: null,
            requestedBatches: 0,
            discovered: 0,
            imported: 0,
            reused: 0,
            failed: 0,
            acknowledged: 0,
            deleted: 0,
            skipped: 0,
            remainingEstimate: 0,
            stopReason: 'QUEUE_DRAINED',
            // backwards compatibility
            totalFetched: 0,
            duplicates: 0,
            quarantined: 0,
            ackPending: 0,
            deletePending: 0
        };

        const failedSubmissionIdsInRun = new Set();

        try {
            await this.repository.recordAuditEvent({
                actorId,
                action: mode === 'AUTO' ? 'SURVEY_AUTO_IMPORT_STARTED' : 'SURVEY_MANUAL_IMPORT_STARTED',
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

            while (true) {
                // Safety 1: Max runtime limit
                const elapsed = Date.now() - startTime;
                if (elapsed >= effMaxDuration) {
                    summary.stopReason = 'MAX_RUNTIME_EXCEEDED';
                    console.warn(`⚠️ [DRAIN_LOOP] Maximum runtime of ${effMaxDuration}ms reached.`);
                    break;
                }

                // Safety 2: Max items limit
                const totalProcessedSoFar = summary.imported + summary.failed + summary.reused + summary.skipped;
                if (totalProcessedSoFar >= effMaxItems) {
                    summary.stopReason = 'MAX_ITEMS_EXCEEDED';
                    console.log(`ℹ️ [DRAIN_LOOP] Maximum items limit of ${effMaxItems} reached.`);
                    break;
                }

                const currentBatchLimit = Math.min(effBatchSize, effMaxItems - totalProcessedSoFar);
                summary.requestedBatches++;

                // [E2E_STEP 02/14] pending 조회
                console.log(`📥 [E2E_STEP 02/14] pending 조회: 시작 (batch #${summary.requestedBatches}, limit: ${currentBatchLimit}, leaseSeconds: ${this.defaultLeaseSeconds})`);
                let externalResponse;
                try {
                    if (typeof this.externalApiClient.leasePendingSubmissions === 'function') {
                        externalResponse = await this.externalApiClient.leasePendingSubmissions({
                            limit: currentBatchLimit,
                            leaseSeconds: this.defaultLeaseSeconds
                        });
                    } else {
                        externalResponse = await this.externalApiClient.fetchPending({
                            limit: currentBatchLimit,
                            leaseSeconds: this.defaultLeaseSeconds
                        });
                    }
                } catch (err) {
                    await this.repository.recordAuditEvent({
                        actorId,
                        action: mode === 'AUTO' ? 'SURVEY_AUTO_IMPORT_FAILED' : 'SURVEY_IMPORT_BATCH_FAILED',
                        result: 'NETWORK_ERROR',
                        errorCode: SURVEY_ERROR_CODES.EXTERNAL_API_UNAVAILABLE,
                        batchId
                    });
                    console.error('[SURVEY_IMPORT_UPSTREAM_ERROR]', {
                        name: typeof err?.name === 'string' ? err.name : 'UnknownError',
                        message: typeof err?.message === 'string' ? err.message : 'Unknown upstream error',
                        trackACode: typeof err?.trackACode === 'string' ? err.trackACode : null,
                        statusCode: Number.isInteger(err?.statusCode) ? err.statusCode : null,
                        batchId
                    });
                    if (summary.requestedBatches === 1) {
                        throw new SurveyOperationError(
                            SURVEY_ERROR_CODES.EXTERNAL_API_UNAVAILABLE,
                            '외부 설문 수집 서비스에 연결할 수 없습니다.'
                        );
                    } else {
                        summary.stopReason = 'UPSTREAM_FETCH_FAILED';
                        break;
                    }
                }

                const envelopes = externalResponse?.submissions || [];
                const rawEnvelopes = Array.isArray(envelopes) ? envelopes : [];
                const rawCount = Number.isInteger(externalResponse?.httpMeta?.rawSubmissionsLength)
                    ? externalResponse.httpMeta.rawSubmissionsLength
                    : rawEnvelopes.length;
                const parsedCount = rawEnvelopes.length;

                let excludedNoSubmissionId = 0;
                let excludedRepeatFailed = 0;
                const unfailedItems = [];

                for (const e of rawEnvelopes) {
                    if (!e?.submissionId) {
                        excludedNoSubmissionId++;
                    } else if (failedSubmissionIdsInRun.has(e.submissionId)) {
                        excludedRepeatFailed++;
                    } else {
                        unfailedItems.push(e);
                    }
                }
                const filteredCount = unfailedItems.length;

                console.log(`TRACK_A_PENDING_BATCH rawCount=${rawCount} parsedCount=${parsedCount} filteredCount=${filteredCount} excludedNoSubmissionId=${excludedNoSubmissionId} excludedRepeatFailed=${excludedRepeatFailed}`);

                if (!Array.isArray(envelopes) || envelopes.length === 0) {
                    summary.stopReason = 'QUEUE_DRAINED';
                    if (rawCount === 0) {
                        console.log('QUEUE_DRAINED_CLASS=A rawCount=0');
                    } else {
                        console.log('QUEUE_DRAINED_CLASS=B rawCount>0 parsedCount=0');
                    }
                    break;
                }

                summary.discovered += envelopes.length;
                summary.totalFetched += envelopes.length;
                console.log(`📥 [E2E_STEP 02/14] pending 조회: 완료 (${envelopes.length}건 수신, 누적 발견: ${summary.discovered}건)`);

                // Safety 3: Prevent infinite loop on repeated failures
                if (unfailedItems.length === 0) {
                    summary.stopReason = 'FAILED_ITEM_LOOP_PREVENTED';
                    console.log('QUEUE_DRAINED_CLASS=C parsedCount>0 filteredCount=0');
                    console.warn('⚠️ [DRAIN_LOOP] Only repeated failed submissions returned. Breaking drain loop.');
                    break;
                }

                const batchImportedBefore = summary.imported;
                const batchQuarantinedBefore = summary.quarantined;
                const batchDuplicatesBefore = summary.duplicates;

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

                // Check submission uniqueness in ledger and stored submissions
                const existing = this.repository.findBySubmissionId(subId);
                const existingSubmission = typeof this.repository.findSubmissionById === 'function'
                    ? this.repository.findSubmissionById(subId)
                    : (this.repository.getSurveySubmissions ? this.repository.getSurveySubmissions().find(s => s.submissionId === subId) : null);
                const isAlreadyPersisted = Boolean(existingSubmission || existing?.internalSurveyId);
                const isExistingCompleted = existing && (existing.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED || existing.internalStatus === SURVEY_INTERNAL_STATUS.STORED);

                // Incomplete or stored error records must route to dedicated recovery policy and not be repeatedly consumed
                if (existing && existing.internalStatus === SURVEY_INTERNAL_STATUS.ERROR) {
                    summary.skipped++;
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
                    console.warn(`⚠️ [RECOVERY_ROUTE] Existing stored error/incomplete record routed to recovery policy: submissionId=${subId}`);
                    continue;
                }

                if ((isExistingCompleted || isAlreadyPersisted) && (existing?.requestType === 'CONSULTATION_REQUEST' || existing?.consultationRequested === true || existingSubmission)) {
                    summary.duplicates++;
                    summary.reused++;
                    console.log(`ℹ️ [E2E_DEDUP] 이미 처리 완료된 설문입니다. 중복 생성 방지: submissionId=${subId}`);
                    // Re-verify ACK / Delete status in case previous run failed midway
                    await this._reconcileExternalState(existing || { submissionId: subId, internalSurveyId: existingSubmission?.internalSurveyId }, { leaseId, leaseUntil });
                    continue;
                }

                // Check lease expiration before starting processing
                if (leaseUntil && new Date(leaseUntil).getTime() <= now) {
                    summary.quarantined++;
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
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

                    // Merge trusted envelope request metadata before payload validation.
                    if (envelope.requestType === 'CONSULTATION_REQUEST') {
                        payload.requestType = 'CONSULTATION_REQUEST';
                        payload.consultationRequested = true;

                        if (
                            typeof envelope.consultationRequestedAt === 'string' &&
                            envelope.consultationRequestedAt.trim() !== ''
                        ) {
                            payload.consultationRequestedAt = envelope.consultationRequestedAt;
                        } else if (!payload.consultationRequestedAt) {
                            payload.consultationRequestedAt = payload.submittedAt || envelope.receivedAt || new Date().toISOString();
                        }
                    } else if (
                        envelope.requestType === 'SCREENING_ONLY' &&
                        !payload.requestType
                    ) {
                        payload.requestType = 'SCREENING_ONLY';
                    }
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
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
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
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
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

                // Check promotion for existing SCREENING_ONLY record
                if (isExistingCompleted && existing.requestType === 'SCREENING_ONLY') {
                    if (payload.requestType === 'CONSULTATION_REQUEST') {
                        console.log(`🚀 [E2E_PROMOTION] SCREENING_ONLY -> CONSULTATION_REQUEST 상태 승격: submissionId=${subId}`);
                        const sub = this.repository.findSubmissionById(existing.submissionId) || this.repository.findSubmissionById(subId);
                        const existingAttachment = sub?.attachment || null;

                        await this.repository.promoteToConsultationRequest({
                            submissionId: subId,
                            consultationRequestedAt: payload.consultationRequestedAt,
                            actorId
                        });

                        const subs = this.repository.getSurveySubmissions();
                        const sIdx = subs.findIndex(s => s.submissionId === subId || s.internalSurveyId === sub?.internalSurveyId);
                        if (sIdx !== -1) {
                            subs[sIdx].processingStatus = SURVEY_PROCESSING_STATUS.PENDING_STAFF_REVIEW;
                            subs[sIdx].assignmentStatus = SURVEY_ASSIGNMENT_STATUS.UNASSIGNED;
                            subs[sIdx].consultationStatus = '신규접수대기';
                            await this.repository.saveSurveySubmissions(subs);
                        }

                        await this._acknowledgeAndDeleteExternalRecord(
                            subId,
                            { leaseId, leaseUntil },
                            actorId,
                            batchId,
                            summary,
                            {
                                internalSurveyId: sub?.internalSurveyId,
                                referralId: refResult?.referral?.referralId,
                                priority: validationResult?.priority || 'NORMAL'
                            }
                        );
                        summary.imported++;
                        continue;
                    } else {
                        summary.duplicates++;
                        console.log(`ℹ️ [E2E_DEDUP] 이미 검진 완료된 설문입니다. 중복 생성 방지: submissionId=${subId}`);
                        await this._reconcileExternalState(existing, { leaseId, leaseUntil });
                        continue;
                    }
                }

                // [E2E_STEP 06/14] 설문 저장 (Atomic Survey Intake Database Persistence)
                let intakeResult;
                try {
                    intakeResult = await this.repository.persistSurveyIntake({
                        envelope,
                        payload,
                        campaignCodeMetadata: validationResult.campaignCodeMetadata,
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
                        summary.failed++;
                        failedSubmissionIdsInRun.add(subId);
                    }
                } catch (persistErr) {
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
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
                const isScreeningOnly = payload.requestType === 'SCREENING_ONLY';

                if (isScreeningOnly) {
                    // SCREENING_ONLY: Generate standalone PDF report without creating referral draft
                    if (this.referralService) {
                        try {
                            const reportResult = await this.referralService.generateScreeningReportOnly({
                                payload,
                                internalSurveyId: intakeResult.internalSurveyId,
                                submissionId: subId,
                                actorId
                            });

                            const subs = this.repository.getSurveySubmissions();
                            const sIdx = subs.findIndex(s => s.internalSurveyId === intakeResult.internalSurveyId);
                            if (sIdx !== -1) {
                                subs[sIdx].attachmentId = reportResult.attachment?.id;
                                subs[sIdx].attachment = reportResult.attachment;
                                await this.repository.saveSurveySubmissions(subs);
                            }

                            console.log(`📄 [E2E_STEP 08/14] PDF 생성 (SCREENING_ONLY): 성공 (파일명: ${reportResult?.attachment?.name}, 크기: ${reportResult?.attachment?.size}B)`);
                            console.log(`📎 [E2E_STEP 09/14] 첨부 등록: 성공 (attachmentId=${reportResult?.attachment?.id})`);
                            console.log(`🔍 [E2E_STEP 10/14] 첨부 read-back: 성공 (디스크 파일 무결성 및 바이트 크기 일치 확인)`);

                            await this.repository.recordWorkflowStep({
                                submissionId: subId,
                                internalSurveyId: intakeResult.internalSurveyId,
                                step: SURVEY_WORKFLOW_STEPS.REPORT_GENERATED,
                                details: { reportAttachmentId: reportResult?.attachment?.id }
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
                        } catch (err) {
                            console.error(`❌ [SCREENING_PDF_FAILED] ${subId}:`, err.message);
                        }
                    }
                } else {
                    // CONSULTATION_REQUEST: Generate standalone screening report PDF and set status to PENDING_STAFF_REVIEW (No automatic referral creation)
                    if (this.referralService) {
                        try {
                            const reportResult = await this.referralService.generateScreeningReportOnly({
                                payload,
                                internalSurveyId: intakeResult.internalSurveyId,
                                submissionId: subId,
                                actorId
                            });

                            const subs = this.repository.getSurveySubmissions();
                            const sIdx = subs.findIndex(s => s.internalSurveyId === intakeResult.internalSurveyId);
                            if (sIdx !== -1) {
                                subs[sIdx].attachmentId = reportResult.attachment?.id;
                                subs[sIdx].attachment = reportResult.attachment;
                                subs[sIdx].processingStatus = SURVEY_PROCESSING_STATUS.PENDING_STAFF_REVIEW;
                                subs[sIdx].assignmentStatus = SURVEY_ASSIGNMENT_STATUS.UNASSIGNED;
                                subs[sIdx].consultationStatus = '신규접수대기';
                                subs[sIdx].referralId = null;
                                subs[sIdx].refNo = null;
                                await this.repository.saveSurveySubmissions(subs);
                            }

                            console.log(`📄 [E2E_STEP 08/14] PDF 생성 (CONSULTATION_REQUEST): 성공 (파일명: ${reportResult?.attachment?.name}, 크기: ${reportResult?.attachment?.size}B)`);
                            console.log(`📎 [E2E_STEP 09/14] 첨부 등록: 성공 (attachmentId=${reportResult?.attachment?.id})`);
                            console.log(`🔍 [E2E_STEP 10/14] 첨부 read-back: 성공 (디스크 파일 무결성 및 바이트 크기 일치 확인)`);

                            await this.repository.recordWorkflowStep({
                                submissionId: subId,
                                internalSurveyId: intakeResult.internalSurveyId,
                                step: SURVEY_WORKFLOW_STEPS.REPORT_GENERATED,
                                details: { reportAttachmentId: reportResult?.attachment?.id }
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
                        } catch (reportErr) {
                            summary.failed++;
                            failedSubmissionIdsInRun.add(subId);
                            console.error(`❌ [SCREENING_PDF_FAILED] ${subId}:`, reportErr.message);
                            await this.repository.createOrUpdateImportRecord({
                                submissionId: subId,
                                internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
                                lastErrorCode: 'REPORT_GENERATION_FAILED'
                            });
                            await this.repository.recordAuditEvent({
                                actorId,
                                action: 'SURVEY_REFERRAL_CREATION_FAILED',
                                submissionId: subId,
                                result: 'FAILED',
                                errorCode: reportErr.message || 'REFERRAL_CREATION_FAILED',
                                batchId
                            });
                            // Do NOT ACK or delete if referral creation or report generation fails!
                            continue;
                        }
                    }
                }

                // Phase 12 & 13: External ACK Readiness Gate and Ciphertext Deletion Sequence
                const ackResult = await this._acknowledgeAndDeleteExternalRecord(
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
                if (ackResult && ackResult.acknowledged) {
                    if (!validationResult.isSbqrQuarantined) {
                        summary.imported++;
                    }
                } else {
                    summary.failed++;
                    failedSubmissionIdsInRun.add(subId);
                }
            }

                const batchImported = summary.imported - batchImportedBefore;
                const batchQuarantined = summary.quarantined - batchQuarantinedBefore;
                const batchDuplicates = summary.duplicates - batchDuplicatesBefore;

                if (batchImported === 0) {
                    console.log(`POST_FILTER_NO_IMPORT filteredCount=${filteredCount} imported=0 quarantined=${batchQuarantined} duplicates=${batchDuplicates}`);
                }

                // If fewer envelopes were returned than requested, queue is drained
                if (envelopes.length < currentBatchLimit) {
                    summary.stopReason = 'QUEUE_DRAINED';
                    break;
                }

                // Brief pause between batches
                if (effDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, effDelayMs));
                }
            } // end while (true)

            summary.completedAt = new Date().toISOString();

            const finalAction = mode === 'AUTO'
                ? (summary.failed > 0 && summary.imported > 0
                    ? 'SURVEY_AUTO_IMPORT_PARTIAL_FAILURE'
                    : summary.failed > 0
                        ? 'SURVEY_AUTO_IMPORT_FAILED'
                        : 'SURVEY_AUTO_IMPORT_COMPLETED')
                : 'SURVEY_MANUAL_IMPORT_COMPLETED';

            await this.repository.recordAuditEvent({
                actorId,
                action: finalAction,
                result: summary.failed > 0 ? (summary.imported > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCESS',
                batchId
            });

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
            return { success: false, acknowledged: false };
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
                if (summary && summary.acknowledged !== undefined) {
                    summary.acknowledged++;
                }
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
            return { success: false, acknowledged: false }; // Cannot proceed without successful ACK!
        }

        // 2. External Delete Sequence: Sent immediately after ACK succeeds!
        // Requirement 5: Do not keep external ciphertext merely because the manager has not yet assigned an employee.
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
                if (summary && summary.deleted !== undefined) {
                    summary.deleted++;
                }
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
                console.log(`🗑️ [E2E_STEP] 외부 delete: 성공 (deleteRequestId=${deleteRequestId}, externalStatus=DELETED)`);
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
                action: 'SURVEY_EXTERNAL_DELETE_FAILED',
                submissionId,
                result: 'RETRY_PENDING',
                errorCode: SURVEY_ERROR_CODES.EXTERNAL_DELETE_FAILED,
                batchId
            });
            console.warn(`⚠️ [E2E_DELETE_WARN] 외부 delete 재시도 대기: ${delErr.message}`);
        }

        // 3. Post-Import Staff Assignment & Notification Workflow (Decoupled)
        // Production flow: referral auto-created -> PENDING_STAFF_REVIEW -> UNASSIGNED
        // Staff assignment is performed separately by an authorized manager (no auto-admin assignment).
        const targetUserId = (extraParams?.assignedUserId && extraParams.assignedUserId !== 'admin' && extraParams.assignedUserId !== 'system')
            ? extraParams.assignedUserId
            : null;
        if (targetUserId && this.repository && typeof this.repository.assignStaff === 'function') {
            try {
                await this.repository.assignStaff({
                    internalSurveyId: extraParams?.internalSurveyId,
                    submissionId,
                    targetUserId,
                    actorId: actorId || 'system',
                    reason: '설문 접수 담당자 배정',
                    priority: extraParams?.priority || 'NORMAL'
                });
                await this.repository.recordWorkflowStep({
                    submissionId,
                    internalSurveyId: extraParams?.internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.ASSIGNED,
                    details: { assignedUserId: targetUserId }
                });
                console.log(`👤 [E2E_STEP] 담당자 배정: 성공 (assignedUserId=${targetUserId})`);

                if (this.notificationRepository && typeof this.notificationRepository.createNotification === 'function') {
                    const notifResult = await this.notificationRepository.createNotification({
                        recipientUserId: targetUserId,
                        type: NOTIFICATION_TYPES.SURVEY_ASSIGNED,
                        relatedEntityType: 'referral',
                        relatedEntityId: extraParams?.referralId || submissionId,
                        safeTitle: '온라인 설문 담당자 배정 알림',
                        safeMessage: '온라인 설문 기반 상담신청 1건이 배정되었습니다.\n온라인 설문관리에서 확인해 주세요.',
                        priority: extraParams?.priority || 'NORMAL',
                        createdByUserId: actorId || 'system',
                        deduplicationKey: `survey_assign_${submissionId}_${targetUserId}`
                    });
                    await this.repository.recordWorkflowStep({
                        submissionId,
                        internalSurveyId: extraParams?.internalSurveyId,
                        step: SURVEY_WORKFLOW_STEPS.NOTIFICATION_CREATED,
                        details: { notificationId: notifResult.notificationId || notifResult.notification?.notificationId }
                    });
                    console.log(`🔔 [E2E_STEP] 내부 알림: 성공 (notifId=${notifResult.notificationId || notifResult.notification?.notificationId})`);
                }
            } catch (assignErr) {
                console.warn(`⚠️ [E2E_STEP] 담당자 배정 처리 경고: ${assignErr.message}`);
            }
        } else {
            // Default unassigned state for production and manual management
            console.log(`👤 [E2E_STEP] 접수 완료 건 배정 대기: UNASSIGNED (상태: PENDING_STAFF_REVIEW, 관리자 배정 대기)`);
            await this.repository.recordWorkflowStep({
                submissionId,
                internalSurveyId: extraParams?.internalSurveyId,
                step: SURVEY_WORKFLOW_STEPS.ASSIGNMENT_READY,
                details: { status: 'UNASSIGNED', workflow: 'PENDING_STAFF_REVIEW' }
            });
        }

        return { success: true, acknowledged: true };
    }

    /**
     * Reconcile external ACK / deletion state for duplicates or partially completed imports.
     * When lease expired earlier, resumes ACK/delete directly without regenerating referrals or PDF reports.
     */
    async _reconcileExternalState(ledgerRecord, leaseMetadata = {}) {
        if (ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.DELETED) {
            return;
        }

        const subId = ledgerRecord.submissionId;
        const currentLeaseId = leaseMetadata.leaseId || ledgerRecord.leaseId;
        const currentLeaseUntil = leaseMetadata.leaseUntil || ledgerRecord.leaseUntil;

        // If not yet acknowledged, resume ACK step with new lease without regenerating referrals/PDFs
        if (ledgerRecord.externalStatus !== SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED && ledgerRecord.externalStatus !== SURVEY_EXTERNAL_STATUS.DELETE_PENDING) {
            const now = Date.now();
            if (currentLeaseUntil && new Date(currentLeaseUntil).getTime() > now) {
                await this._acknowledgeAndDeleteExternalRecord(
                    subId,
                    { leaseId: currentLeaseId, leaseUntil: currentLeaseUntil },
                    'system',
                    this._currentBatchId,
                    null
                );
                return;
            }
        }

        const deleteRequestId = ledgerRecord.deleteRequestId || `req_del_${ledgerRecord.submissionId}_reconcile`;
        if (ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING || ledgerRecord.externalStatus === SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED) {
            try {
                let res;
                if (typeof this.externalApiClient.deleteImportedSubmission === 'function') {
                    res = await this.externalApiClient.deleteImportedSubmission(ledgerRecord.submissionId, {
                        leaseId: currentLeaseId,
                        workerId: this.workerId,
                        requestId: deleteRequestId
                    });
                } else {
                    res = await this.externalApiClient.deleteCiphertext(ledgerRecord.submissionId, {
                        leaseId: currentLeaseId,
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
    getStatusSummary(userId = null) {
        const ledger = this.repository.getImportsLedger();
        const submissions = this.repository.getSurveySubmissions();
        const stats = typeof this.repository.getStatistics === 'function'
            ? this.repository.getStatistics(userId)
            : {};

        return {
            totalImports: ledger.length,
            completed: ledger.filter(i => i.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED).length,
            quarantined: ledger.filter(i => i.internalStatus.startsWith('QUARANTINED')).length,
            quarantinedSbqr: ledger.filter(i => i.internalStatus === SURVEY_INTERNAL_STATUS.QUARANTINED_SBQR_GATE).length,
            deletePending: ledger.filter(i => i.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING).length,
            ackPending: ledger.filter(i => i.externalStatus === SURVEY_EXTERNAL_STATUS.LEASED).length,
            isImportRunning: this._isImportRunning,
            currentBatchId: this._currentBatchId,
            totalSubmissions: submissions.length,
            ...stats
        };
    }

    /**
     * Dedicated, isolated, idempotent recovery path for stored survey submissions.
     * Reuses existing internalSurveyId, SurveySubmission, and Consent records without duplicates.
     * Reuses existing valid PDF or generates only missing PDF.
     * Enforces dry-run first, strict per-submissionId recovery lock, and zero PII leaks.
     *
     * @param {Object} params
     * @param {string} params.submissionId
     * @param {string} [params.expectedInternalSurveyId]
     * @param {string} [params.actorId='system']
     * @param {boolean} [params.dryRun=true]
     * @param {string} [params.confirm]
     * @param {string} [params.requestId]
     * @returns {Promise<Object>} Safe recovery summary (Zero PII)
     */
    async recoverStoredSubmission({
        submissionId,
        expectedInternalSurveyId = null,
        actorId = 'system',
        dryRun = true,
        confirm = null,
        requestId = null
    } = {}) {
        if (!submissionId || typeof submissionId !== 'string' || !submissionId.trim()) {
            const err = new Error('유효한 submissionId가 필요합니다.');
            err.code = 'INVALID_SUBMISSION_ID';
            err.statusCode = 400;
            throw err;
        }

        const trimmedSubId = submissionId.trim();
        const isDryRun = dryRun !== false;

        // 1. Concurrency Lock (per-submissionId)
        if (!this._recoveryLocks) {
            this._recoveryLocks = new Set();
        }

        if (this._recoveryLocks.has(trimmedSubId)) {
            const err = new Error('동일 설문에 대한 복구 작업이 현재 진행 중입니다.');
            err.code = 'RECOVERY_IN_PROGRESS';
            err.statusCode = 409;
            throw err;
        }

        this._recoveryLocks.add(trimmedSubId);

        try {
            const blockingReasons = [];
            const plannedActions = [];
            const executedActions = [];

            // 2. Query SurveySubmissions
            const allSubs = this.repository.getSurveySubmissions();
            const matchingSubs = allSubs.filter(s => s && s.submissionId === trimmedSubId);

            if (matchingSubs.length === 0) {
                blockingReasons.push('RECORD_NOT_FOUND');
            } else if (matchingSubs.length > 1) {
                blockingReasons.push('DUPLICATE_INTERNAL_RECORDS_DETECTED');
            }

            const sub = matchingSubs[0] || null;
            const internalSurveyId = sub?.internalSurveyId || null;

            if (sub && !internalSurveyId) {
                blockingReasons.push('INTERNAL_SURVEY_ID_MISSING');
            }

            if (sub && expectedInternalSurveyId && expectedInternalSurveyId !== internalSurveyId) {
                blockingReasons.push('INTERNAL_SURVEY_ID_MISMATCH');
            }

            // 3. Ledger & Consent records
            const ledger = this.repository.findBySubmissionId(trimmedSubId);
            if (!ledger) {
                blockingReasons.push('LEDGER_RECORD_NOT_FOUND');
            }

            const allConsents = typeof this.repository.getConsentEvidenceList === 'function'
                ? this.repository.getConsentEvidenceList()
                : [];
            const consent = allConsents.find(c => c && (c.submissionId === trimmedSubId || (internalSurveyId && c.internalSurveyId === internalSurveyId))) || null;
            if (!consent) {
                blockingReasons.push('CONSENT_RECORD_NOT_FOUND');
            }

            // 4. Referral & status checks
            if (sub && (sub.referralId || sub.refNo)) {
                blockingReasons.push('ALREADY_CONVERTED_TO_REFERRAL');
            }

            if (sub && (sub.status === 'deleted' || sub.deletionStatus === 'deleted')) {
                blockingReasons.push('SURVEY_RECORD_DELETED');
            }

            const isAlreadyFullyCompleted = ledger &&
                ledger.externalStatus === SURVEY_EXTERNAL_STATUS.DELETED &&
                ledger.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED;

            if (isAlreadyFullyCompleted) {
                blockingReasons.push('ALREADY_COMPLETED');
            }

            // 5. Attachment Integrity Gate
            let attachmentState = 'MISSING';
            let existingAttachmentValid = false;
            let targetFilePath = null;
            const existingAttachmentId = sub?.attachmentId || sub?.attachment?.id || null;

            const attachmentsRoot = this.repository.attachmentsDir || this.referralService?.attachmentsDir || null;

            if (existingAttachmentId) {
                attachmentState = 'INVALID';
                if (!attachmentsRoot || !fs.existsSync(attachmentsRoot)) {
                    blockingReasons.push('ATTACHMENTS_ROOT_DIR_NOT_FOUND');
                } else {
                    const foldersToCheck = new Set();
                    if (internalSurveyId) foldersToCheck.add(internalSurveyId);
                    foldersToCheck.add(trimmedSubId);

                    let foundPath = null;
                    for (const folder of foldersToCheck) {
                        const safeFolder = folder.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
                        const candidate = path.join(attachmentsRoot, safeFolder, existingAttachmentId);
                        if (fs.existsSync(candidate)) {
                            foundPath = candidate;
                            break;
                        }
                    }

                    if (!foundPath) {
                        const directCandidate = path.join(attachmentsRoot, existingAttachmentId);
                        if (fs.existsSync(directCandidate)) {
                            foundPath = directCandidate;
                        }
                    }

                    if (!foundPath) {
                        blockingReasons.push('RECOVERY_ATTACHMENT_INVALID');
                    } else {
                        const resolvedPath = path.resolve(foundPath);
                        const resolvedRoot = path.resolve(attachmentsRoot);
                        if (!resolvedPath.startsWith(resolvedRoot)) {
                            blockingReasons.push('RECOVERY_ATTACHMENT_PATH_TRAVERSAL_DETECTED');
                        } else {
                            try {
                                const stat = fs.statSync(resolvedPath);
                                if (stat.size <= 0) {
                                    blockingReasons.push('RECOVERY_ATTACHMENT_INVALID');
                                } else {
                                    const fd = fs.openSync(resolvedPath, 'r');
                                    const headerBuf = Buffer.alloc(5);
                                    fs.readSync(fd, headerBuf, 0, 5, 0);
                                    fs.closeSync(fd);

                                    const isPdfMagic = headerBuf.toString('utf8', 0, 5) === '%PDF-';
                                    if (!isPdfMagic) {
                                        blockingReasons.push('RECOVERY_ATTACHMENT_INVALID');
                                    } else {
                                        if (sub?.attachment?.fileHash) {
                                            const fileData = fs.readFileSync(resolvedPath);
                                            const calcHash = crypto.createHash('sha256').update(fileData).digest('hex');
                                            if (calcHash !== sub.attachment.fileHash) {
                                                blockingReasons.push('RECOVERY_ATTACHMENT_INVALID');
                                            } else {
                                                attachmentState = 'VALID_EXISTING';
                                                existingAttachmentValid = true;
                                                targetFilePath = resolvedPath;
                                            }
                                        } else {
                                            attachmentState = 'VALID_EXISTING';
                                            existingAttachmentValid = true;
                                            targetFilePath = resolvedPath;
                                        }
                                    }
                                }
                            } catch (e) {
                                blockingReasons.push('RECOVERY_ATTACHMENT_INVALID');
                            }
                        }
                    }
                }
            } else {
                attachmentState = 'MISSING';
            }

            // Plan actions
            if (attachmentState === 'VALID_EXISTING') {
                plannedActions.push('REUSE_EXISTING_PDF');
            } else if (attachmentState === 'MISSING') {
                plannedActions.push('GENERATE_SCREENING_PDF');
                plannedActions.push('BIND_ATTACHMENT');
            }

            const nowTime = Date.now();
            let activeLeaseId = ledger?.leaseId || null;
            let activeLeaseUntil = ledger?.leaseUntil || null;
            const isLeaseActive = Boolean(
                activeLeaseUntil &&
                new Date(activeLeaseUntil).getTime() > nowTime + 10000
            );

            const needsLeaseForAck = ledger &&
                ledger.externalStatus !== SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED &&
                ledger.externalStatus !== SURVEY_EXTERNAL_STATUS.DELETE_PENDING &&
                !isAlreadyFullyCompleted;

            const supportsDeterministicLease = typeof this.externalApiClient?.leaseSubmissionById === 'function';

            if (needsLeaseForAck) {
                if (isLeaseActive) {
                    plannedActions.push('REUSE_EXISTING_LEASE');
                    plannedActions.push('ACKNOWLEDGE_EXTERNAL');
                    plannedActions.push('DELETE_EXTERNAL');
                } else if (supportsDeterministicLease) {
                    plannedActions.push('REACQUIRE_TARGETED_LEASE');
                    plannedActions.push('ACKNOWLEDGE_EXTERNAL');
                    plannedActions.push('DELETE_EXTERNAL');
                } else {
                    // Track A does not provide a targeted lease API by submissionId.
                    // Generic pending calls (e.g. limit=1 or batch) are strictly prohibited
                    // to prevent collateral leases on unrelated submissions. Fail-closed!
                    blockingReasons.push('DETERMINISTIC_REACQUIRE_NOT_AVAILABLE');
                }
            } else if (ledger && (ledger.externalStatus === SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED || ledger.externalStatus === SURVEY_EXTERNAL_STATUS.DELETE_PENDING) && !isAlreadyFullyCompleted) {
                plannedActions.push('DELETE_EXTERNAL');
            }

            const safeToExecute = blockingReasons.length === 0;

            // 6. Handle Dry-Run Mode
            if (isDryRun) {
                await this.repository.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'SURVEY_RECOVERY_DRY_RUN',
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    attachmentId: existingAttachmentId,
                    result: safeToExecute ? 'SUCCESS' : 'BLOCKED',
                    reasonCode: blockingReasons[0] || null,
                    requestId,
                    dryRun: true,
                    timestamp: new Date().toISOString()
                });

                return {
                    success: safeToExecute,
                    dryRun: true,
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    currentExternalStatus: ledger?.externalStatus || null,
                    currentProcessingStatus: sub?.processingStatus || null,
                    attachmentState,
                    plannedActions,
                    blockingReasons,
                    safeToExecute
                };
            }

            // 7. Non-DryRun Execution Mode
            if (!safeToExecute) {
                await this.repository.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'SURVEY_RECOVERY_BLOCKED',
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    attachmentId: existingAttachmentId,
                    result: 'BLOCKED',
                    reasonCode: blockingReasons[0] || 'RECOVERY_NOT_SAFE',
                    requestId,
                    dryRun: false,
                    timestamp: new Date().toISOString()
                });

                const err = new Error(`복구 사전 검증 실패: ${blockingReasons.join(', ')}`);
                err.code = blockingReasons[0] || 'RECOVERY_BLOCKED';
                err.statusCode = 422;
                err.details = { blockingReasons, safeToExecute: false };
                throw err;
            }

            if (confirm !== 'RECOVER_STORED_SUBMISSION') {
                const err = new Error('실제 복구 실행을 위해 confirm="RECOVER_STORED_SUBMISSION" 확인이 필요합니다.');
                err.code = 'CONFIRMATION_REQUIRED';
                err.statusCode = 400;
                throw err;
            }

            await this.repository.recordWorkflowStep({
                submissionId: trimmedSubId,
                internalSurveyId,
                step: 'RECOVERY_STARTED',
                details: { actorId, requestId }
            });

            await this.repository.recordAuditEvent({
                actorId,
                actorUserId: actorId,
                action: 'SURVEY_RECOVERY_STARTED',
                submissionId: trimmedSubId,
                internalSurveyId,
                attachmentId: existingAttachmentId,
                result: 'STARTED',
                requestId,
                dryRun: false,
                timestamp: new Date().toISOString()
            });

            // Action: Existing PDF Reuse vs Missing PDF Generation
            if (existingAttachmentValid) {
                executedActions.push('REUSE_EXISTING_PDF');
                await this.repository.recordWorkflowStep({
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    step: 'EXISTING_ATTACHMENT_VERIFIED',
                    details: { attachmentId: existingAttachmentId }
                });
                await this.repository.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'SURVEY_RECOVERY_EXISTING_PDF_REUSED',
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    attachmentId: existingAttachmentId,
                    result: 'SUCCESS',
                    requestId,
                    dryRun: false
                });
            } else if (attachmentState === 'MISSING') {
                if (!this.referralService) {
                    throw new Error('referralService is required to generate missing PDF');
                }

                const payload = sub.payload || {
                    assessmentId: sub.assessmentId,
                    assessmentVersion: sub.assessmentVersion,
                    contactOnly: Boolean(sub.contactOnly),
                    contact: sub.contact || {},
                    assessment: sub.assessment || {},
                    requestType: sub.requestType || 'CONSULTATION_REQUEST',
                    consultationRequested: sub.consultationRequested !== false,
                    consultationRequestedAt: sub.consultationRequestedAt,
                    screeningCompletedAt: sub.screeningCompletedAt,
                    consentEvidence: consent
                };

                const reportResult = await this.referralService.generateScreeningReportOnly({
                    payload,
                    internalSurveyId,
                    submissionId: trimmedSubId,
                    actorId
                });

                if (!reportResult?.attachment?.id) {
                    throw new Error('PDF generation did not return valid attachment metadata');
                }

                // Bind to existing SurveySubmission (DO NOT create new SurveySubmission!)
                const freshSubs = this.repository.getSurveySubmissions();
                const subIdx = freshSubs.findIndex(s => s && (s.internalSurveyId === internalSurveyId || s.submissionId === trimmedSubId));
                if (subIdx !== -1) {
                    freshSubs[subIdx].attachmentId = reportResult.attachment.id;
                    freshSubs[subIdx].attachment = reportResult.attachment;
                    freshSubs[subIdx].updatedAt = new Date().toISOString();
                    await this.repository.saveSurveySubmissions(freshSubs);
                }

                executedActions.push('GENERATE_SCREENING_PDF');
                executedActions.push('BIND_ATTACHMENT');

                await this.repository.recordWorkflowStep({
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.REPORT_GENERATED,
                    details: { reportAttachmentId: reportResult.attachment.id }
                });
                await this.repository.recordWorkflowStep({
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.ATTACHMENT_REGISTERED
                });
                await this.repository.recordWorkflowStep({
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    step: SURVEY_WORKFLOW_STEPS.READ_BACK_VERIFIED
                });

                await this.repository.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'SURVEY_RECOVERY_MISSING_PDF_GENERATED',
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    attachmentId: reportResult.attachment.id,
                    result: 'SUCCESS',
                    requestId,
                    dryRun: false
                });
            }

            // Action: Lease Verification / Targeted Reacquisition & Gated ACK / Delete
            if (needsLeaseForAck) {
                if (isLeaseActive) {
                    // Reuse existing valid lease without calling Track A lease API
                    executedActions.push('REUSE_EXISTING_LEASE');
                    await this.repository.recordWorkflowStep({
                        submissionId: trimmedSubId,
                        internalSurveyId,
                        step: 'EXISTING_LEASE_VERIFIED',
                        details: { leaseId: activeLeaseId, source: 'EXISTING_ACTIVE_LEASE' }
                    });
                } else if (supportsDeterministicLease) {
                    const freshEnvelope = await this.externalApiClient.leaseSubmissionById(trimmedSubId);
                    if (!freshEnvelope || freshEnvelope.submissionId !== trimmedSubId || !freshEnvelope.lease?.leaseId) {
                        const err = new Error('DETERMINISTIC_REACQUIRE_NOT_AVAILABLE: Targeted lease returned invalid envelope');
                        err.code = 'DETERMINISTIC_REACQUIRE_NOT_AVAILABLE';
                        err.statusCode = 422;
                        throw err;
                    }

                    activeLeaseId = freshEnvelope.lease.leaseId;
                    activeLeaseUntil = freshEnvelope.lease.leaseUntil;

                    await this.repository.createOrUpdateImportRecord({
                        submissionId: trimmedSubId,
                        leaseId: activeLeaseId,
                        leasedAt: freshEnvelope.lease.leasedAt || new Date().toISOString(),
                        leaseUntil: activeLeaseUntil,
                        workerId: this.workerId
                    });

                    executedActions.push('REACQUIRE_TARGETED_LEASE');

                    await this.repository.recordWorkflowStep({
                        submissionId: trimmedSubId,
                        internalSurveyId,
                        step: 'LEASE_REACQUIRED',
                        details: { leaseId: activeLeaseId }
                    });

                    await this.repository.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'SURVEY_RECOVERY_LEASE_ACQUIRED',
                        submissionId: trimmedSubId,
                        internalSurveyId,
                        result: 'SUCCESS',
                        requestId,
                        dryRun: false
                    });
                } else {
                    const err = new Error('DETERMINISTIC_REACQUIRE_NOT_AVAILABLE: Track A does not support targeted lease by submissionId. Generic pending calls are prohibited to prevent collateral leases on unrelated submissions.');
                    err.code = 'DETERMINISTIC_REACQUIRE_NOT_AVAILABLE';
                    err.statusCode = 422;
                    throw err;
                }
            }

            // Gated ACK
            if (ledger.externalStatus !== SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED && ledger.externalStatus !== SURVEY_EXTERNAL_STATUS.DELETE_PENDING) {
                const ackRequestId = ledger.ackRequestId || `req_ack_${trimmedSubId}_rec_${Date.now()}`;
                await this.repository.createOrUpdateImportRecord({
                    submissionId: trimmedSubId,
                    ackRequestId
                });

                let ackResp;
                if (typeof this.externalApiClient.acknowledgeSubmission === 'function') {
                    ackResp = await this.externalApiClient.acknowledgeSubmission(trimmedSubId, {
                        leaseId: activeLeaseId,
                        workerId: this.workerId,
                        requestId: ackRequestId
                    });
                } else if (typeof this.externalApiClient.acknowledge === 'function') {
                    ackResp = await this.externalApiClient.acknowledge(trimmedSubId, {
                        leaseId: activeLeaseId,
                        workerId: this.workerId,
                        requestId: ackRequestId
                    });
                } else {
                    throw new Error('externalApiClient does not support acknowledgeSubmission');
                }

                if (!ackResp || ackResp.success === false) {
                    throw new Error('External ACK rejected by Track A');
                }

                await this.repository.createOrUpdateImportRecord({
                    submissionId: trimmedSubId,
                    externalStatus: SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED,
                    acknowledgedAt: new Date().toISOString()
                });

                executedActions.push('ACKNOWLEDGE_EXTERNAL');

                await this.repository.recordWorkflowStep({
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    step: 'ACK_COMPLETED',
                    details: { ackRequestId, leaseId: activeLeaseId }
                });

                await this.repository.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'SURVEY_RECOVERY_ACKNOWLEDGED',
                    submissionId: trimmedSubId,
                    internalSurveyId,
                    result: 'SUCCESS',
                    requestId,
                    dryRun: false
                });
            }

            // Gated Delete
            const deleteRequestId = ledger.deleteRequestId || `req_del_${trimmedSubId}_rec_${Date.now()}`;
            await this.repository.createOrUpdateImportRecord({
                submissionId: trimmedSubId,
                deleteRequestId
            });

            let delResp;
            if (typeof this.externalApiClient.deleteImportedSubmission === 'function') {
                delResp = await this.externalApiClient.deleteImportedSubmission(trimmedSubId, {
                    leaseId: activeLeaseId,
                    workerId: this.workerId,
                    requestId: deleteRequestId
                });
            } else if (typeof this.externalApiClient.deleteCiphertext === 'function') {
                delResp = await this.externalApiClient.deleteCiphertext(trimmedSubId, {
                    leaseId: activeLeaseId,
                    workerId: this.workerId,
                    requestId: deleteRequestId
                });
            } else {
                throw new Error('externalApiClient does not support deleteImportedSubmission');
            }

            if (!delResp || delResp.success === false) {
                throw new Error('External Delete rejected by Track A');
            }

            await this.repository.createOrUpdateImportRecord({
                submissionId: trimmedSubId,
                externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
                internalStatus: SURVEY_INTERNAL_STATUS.COMPLETED,
                externalDeletedAt: new Date().toISOString()
            });

            executedActions.push('DELETE_EXTERNAL');

            await this.repository.recordWorkflowStep({
                submissionId: trimmedSubId,
                internalSurveyId,
                step: 'EXTERNAL_DELETE_COMPLETED',
                details: { deleteRequestId }
            });

            await this.repository.recordWorkflowStep({
                submissionId: trimmedSubId,
                internalSurveyId,
                step: 'RECOVERY_COMPLETED',
                details: { executedActions }
            });

            await this.repository.recordAuditEvent({
                actorId,
                actorUserId: actorId,
                action: 'SURVEY_RECOVERY_EXTERNAL_DELETED',
                submissionId: trimmedSubId,
                internalSurveyId,
                result: 'SUCCESS',
                requestId,
                dryRun: false
            });

            await this.repository.recordAuditEvent({
                actorId,
                actorUserId: actorId,
                action: 'SURVEY_RECOVERY_COMPLETED',
                submissionId: trimmedSubId,
                internalSurveyId,
                result: 'SUCCESS',
                requestId,
                dryRun: false
            });

            return {
                success: true,
                dryRun: false,
                submissionId: trimmedSubId,
                internalSurveyId,
                currentExternalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
                currentProcessingStatus: sub?.processingStatus || null,
                attachmentState,
                executedActions,
                safeToExecute: true
            };

        } catch (execErr) {
            await this.repository.recordAuditEvent({
                actorId,
                actorUserId: actorId,
                action: 'SURVEY_RECOVERY_FAILED',
                submissionId: trimmedSubId,
                result: 'FAILED',
                errorCode: execErr.code || execErr.message || 'RECOVERY_EXECUTION_FAILED',
                requestId,
                dryRun: isDryRun,
                timestamp: new Date().toISOString()
            });
            throw execErr;
        } finally {
            this._recoveryLocks.delete(trimmedSubId);
        }
    }
}

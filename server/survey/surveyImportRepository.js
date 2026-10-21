/**
 * server/survey/surveyImportRepository.js
 * Atomic storage operations for survey imports, intake records, consent evidence,
 * and pending referral candidates using existing JSON file store conventions.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    SURVEY_STORAGE_FILES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    CAMPAIGN_CODE_PATTERN,
    SURVEY_CAMPAIGN_AUDIT_ACTIONS,
    SURVEY_CAMPAIGN_CLASSIFICATIONS,
    SURVEY_CAMPAIGN_REGISTRATION_STATUS,
    SURVEY_ERROR_CODES
} from './surveyConstants.js';
import { getCampaignMetadataForPayload } from './surveyPayloadValidator.js';

export class SurveyImportRepository {
    /**
     * @param {Object} deps
     * @param {Function} deps.getData
     * @param {Function} deps.persistData
     * @param {string} [deps.attachmentsDir]
     */
    constructor(deps = {}) {
        if (!deps.getData || !deps.persistData) {
            throw new Error('SurveyImportRepository requires getData and persistData dependencies');
        }
        this.getData = deps.getData;
        this.persistData = deps.persistData;
        this.assignmentRepository = deps.assignmentRepository || null;
        this.sourceEnvironment = deps.sourceEnvironment || 'mock';
        this.attachmentsDir = deps.attachmentsDir || null;
        this.auditLogger = deps.auditLogger || null;
        // Campaign-specific Promise mutex for strict serial atomic execution (Calibration 2)
        this._campaignMutex = Promise.resolve();
    }

    _nowIso() {
        return new Date().toISOString();
    }

    /**
     * Campaign-specific Mutex Critical Section (Calibration 2)
     * Wraps: lock -> latest read -> duplicate check -> append/modify -> persist -> unlock.
     */
    async _withCampaignLock(operation) {
        const currentLock = this._campaignMutex;
        let release;
        const opPromise = new Promise(resolve => { release = resolve; });
        this._campaignMutex = currentLock.then(() => opPromise, () => opPromise);

        try {
            await currentLock;
            return await operation();
        } finally {
            release();
        }
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
        const effectiveSourceEnv = record.sourceEnvironment || this.sourceEnvironment || 'mock';
        if (this.sourceEnvironment === 'production' && effectiveSourceEnv !== 'production') {
            throw new Error(`[SECURITY_VIOLATION] Production mode rejected ledger write with non-production sourceEnvironment: ${effectiveSourceEnv}`);
        }
        if (this.sourceEnvironment === 'staging' && effectiveSourceEnv === 'production') {
            throw new Error('[SECURITY_VIOLATION] Staging mode rejected ledger write targeting production');
        }

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

    findSubmissionById(id) {
        const list = this.getSurveySubmissions();
        return list.find(s => s.internalSurveyId === id || s.submissionId === id) || null;
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

    // ──────────────────────────────────────────────────────────
    // 2.5. Survey Campaigns Registry (Calibration 2: Mutex Critical Section)
    // ──────────────────────────────────────────────────────────

    getCampaigns() {
        return this.getData(SURVEY_STORAGE_FILES.SURVEY_CAMPAIGNS, []);
    }

    async saveCampaigns(list) {
        return this.persistData(SURVEY_STORAGE_FILES.SURVEY_CAMPAIGNS, list);
    }

    findCampaignByCode(code) {
        if (!code || typeof code !== 'string') return null;
        const canonical = code.trim().toUpperCase();
        const list = this.getCampaigns();
        return list.find(c => c && c.code && c.code.toUpperCase() === canonical) || null;
    }

    /**
     * Create a new survey campaign inside a campaign-specific mutex critical section.
     * Sequence: lock -> latest read -> duplicate check -> append -> atomic persist -> unlock.
     * Guaranteed: Read is 100% inside the lock.
     */
    async createCampaign({ code, companyName, purpose, startsAt = null, endsAt = null, actorId = 'system' }) {
        if (!code || typeof code !== 'string') {
            const err = new Error('캠페인 코드가 필요합니다.');
            err.code = SURVEY_ERROR_CODES.INVALID_CAMPAIGN_CODE;
            err.status = 400;
            throw err;
        }

        const canonicalCode = code.trim().toUpperCase();
        if (!CAMPAIGN_CODE_PATTERN.test(canonicalCode)) {
            const err = new Error('캠페인 코드 형식이 올바르지 않습니다 (2~32자, 영문 대문자/숫자로 시작, 영문대문자·숫자·하이픈만 허용).');
            err.code = SURVEY_ERROR_CODES.INVALID_CAMPAIGN_CODE;
            err.status = 400;
            throw err;
        }

        if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
            const err = new Error('회사/기관명은 필수 입력 항목입니다.');
            err.code = 'INVALID_REQUEST';
            err.status = 400;
            throw err;
        }

        if (!purpose || typeof purpose !== 'string' || !purpose.trim()) {
            const err = new Error('캠페인 목적은 필수 입력 항목입니다.');
            err.code = 'INVALID_REQUEST';
            err.status = 400;
            throw err;
        }

        if (startsAt && isNaN(Date.parse(startsAt))) {
            const err = new Error('시작 일시 형식이 올바르지 않습니다.');
            err.code = 'INVALID_DATE';
            err.status = 400;
            throw err;
        }

        if (endsAt && isNaN(Date.parse(endsAt))) {
            const err = new Error('종료 일시 형식이 올바르지 않습니다.');
            err.code = 'INVALID_DATE';
            err.status = 400;
            throw err;
        }

        return await this._withCampaignLock(async () => {
            // 1. Read latest registry strictly inside mutex
            const list = this.getCampaigns();

            // 2. Duplicate check strictly inside mutex
            const duplicate = list.find(c => c && c.code && c.code.toUpperCase() === canonicalCode);
            if (duplicate) {
                const err = new Error(`이미 존재하는 캠페인 코드입니다: ${canonicalCode}`);
                err.code = SURVEY_ERROR_CODES.CONCURRENCY_CONFLICT;
                err.status = 409;
                throw err;
            }

            // 3. Append new campaign
            const now = this._nowIso();
            const newCampaign = {
                code: canonicalCode,
                companyName: companyName.trim(),
                purpose: purpose.trim(),
                startsAt: startsAt || null,
                endsAt: endsAt || null,
                isActive: true,
                version: 1,
                createdAt: now,
                updatedAt: now
            };
            list.push(newCampaign);

            // 4. Atomic persist strictly inside mutex
            await this.saveCampaigns(list);

            // 5. Record Audit Event
            await this.recordAuditEvent({
                actorId: actorId || 'system',
                action: SURVEY_CAMPAIGN_AUDIT_ACTIONS.CAMPAIGN_CREATED,
                result: 'SUCCESS',
                details: {
                    code: canonicalCode,
                    companyName: newCampaign.companyName,
                    purpose: newCampaign.purpose
                }
            });

            return newCampaign;
        });
    }

    /**
     * Update an existing survey campaign inside a campaign-specific mutex critical section.
     * Enforces strict code immutability and optimistic version checking if provided.
     * Modifiable fields ONLY: companyName, purpose, startsAt, endsAt, isActive.
     */
    async updateCampaign(code, updates = {}, actorId = 'system') {
        if (!code || typeof code !== 'string') {
            const err = new Error('캠페인 코드가 필요합니다.');
            err.code = SURVEY_ERROR_CODES.INVALID_CAMPAIGN_CODE;
            err.status = 400;
            throw err;
        }

        const canonicalCode = code.trim().toUpperCase();

        // Enforce code immutability
        if (updates.code !== undefined && updates.code !== null) {
            const requestedCode = String(updates.code).trim().toUpperCase();
            if (requestedCode !== canonicalCode) {
                const err = new Error('캠페인 코드는 수정할 수 없습니다 (코드 불변).');
                err.code = SURVEY_ERROR_CODES.CAMPAIGN_CODE_IMMUTABLE;
                err.status = 400;
                throw err;
            }
        }

        if (updates.startsAt && isNaN(Date.parse(updates.startsAt))) {
            const err = new Error('시작 일시 형식이 올바르지 않습니다.');
            err.code = 'INVALID_DATE';
            err.status = 400;
            throw err;
        }

        if (updates.endsAt && isNaN(Date.parse(updates.endsAt))) {
            const err = new Error('종료 일시 형식이 올바르지 않습니다.');
            err.code = 'INVALID_DATE';
            err.status = 400;
            throw err;
        }

        return await this._withCampaignLock(async () => {
            // 1. Read latest registry strictly inside mutex
            const list = this.getCampaigns();

            // 2. Find target campaign
            const index = list.findIndex(c => c && c.code && c.code.toUpperCase() === canonicalCode);
            if (index === -1) {
                const err = new Error(`캠페인을 찾을 수 없습니다: ${canonicalCode}`);
                err.code = SURVEY_ERROR_CODES.RECORD_NOT_FOUND;
                err.status = 404;
                throw err;
            }

            const existing = list[index];

            // 3. Optimistic version check if provided
            if (updates.expectedVersion !== undefined && updates.expectedVersion !== null) {
                if (Number(existing.version) !== Number(updates.expectedVersion)) {
                    const err = new Error('캠페인이 이미 다른 프로세스에 의해 수정되었습니다 (버전 불일치).');
                    err.code = SURVEY_ERROR_CODES.CONCURRENCY_CONFLICT;
                    err.status = 409;
                    throw err;
                }
            }

            // 4. Apply allowed updates ONLY
            const now = this._nowIso();
            const updated = {
                ...existing,
                companyName: updates.companyName !== undefined && updates.companyName !== null ? String(updates.companyName).trim() : existing.companyName,
                purpose: updates.purpose !== undefined && updates.purpose !== null ? String(updates.purpose).trim() : existing.purpose,
                startsAt: updates.startsAt !== undefined ? updates.startsAt : existing.startsAt,
                endsAt: updates.endsAt !== undefined ? updates.endsAt : existing.endsAt,
                isActive: updates.isActive !== undefined ? Boolean(updates.isActive) : existing.isActive,
                version: (Number(existing.version) || 1) + 1,
                updatedAt: now
            };
            list[index] = updated;

            // 5. Atomic persist strictly inside mutex
            await this.saveCampaigns(list);

            // 6. Record Audit Event
            await this.recordAuditEvent({
                actorId: actorId || 'system',
                action: SURVEY_CAMPAIGN_AUDIT_ACTIONS.CAMPAIGN_UPDATED,
                result: 'SUCCESS',
                details: {
                    code: canonicalCode,
                    updatedVersion: updated.version,
                    changes: Object.keys(updates).filter(k => k !== 'code' && k !== 'expectedVersion')
                }
            });

            return updated;
        });
    }

    /**
     * Assign or change the campaign of one or more imported survey submissions.
     * - campaignCode: canonical registered campaign code, or null to clear back to
     *   "unspecified" (일반접수).
     * - Targets may currently be unspecified (null) or already assigned — both are
     *   updated. Soft-deleted submissions are skipped.
     * - Runs inside the campaign mutex so validation + mutation stay atomic.
     * - Per-item audit events are recorded for every actual change.
     */
    async updateSubmissionsCampaign({ ids, campaignCode = null, actorId = 'system' } = {}) {
        if (!Array.isArray(ids) || ids.length === 0) {
            const err = new Error('캠페인을 지정할 설문 목록(ids)이 비어있습니다.');
            err.code = 'INVALID_PARAM';
            err.status = 400;
            throw err;
        }

        const canonicalCode = (campaignCode === null || campaignCode === undefined || campaignCode === '')
            ? null
            : String(campaignCode).trim().toUpperCase();

        return await this._withCampaignLock(async () => {
            // 1. Target campaign must actually exist (fail before touching any record)
            let campaign = null;
            if (canonicalCode) {
                campaign = this.findCampaignByCode(canonicalCode);
                if (!campaign) {
                    const err = new Error(`캠페인을 찾을 수 없습니다: ${canonicalCode}`);
                    err.code = SURVEY_ERROR_CODES.CAMPAIGN_NOT_FOUND;
                    err.status = 404;
                    throw err;
                }
            }

            // 2. Mutate matching submissions
            const list = this.getSurveySubmissions();
            const now = this._nowIso();
            const results = [];
            let updatedCount = 0;
            let unchangedCount = 0;
            let skippedCount = 0;
            let notFoundCount = 0;
            const auditTargets = [];

            for (const rawId of ids) {
                const id = String(rawId);
                const index = list.findIndex(s => s && (s.submissionId === id || s.internalSurveyId === id));
                if (index === -1) {
                    notFoundCount++;
                    results.push({ submissionId: id, status: 'NOT_FOUND' });
                    continue;
                }

                const sub = list[index];
                if (sub.deletionStatus === 'deleted' || sub.status === 'deleted') {
                    skippedCount++;
                    results.push({ submissionId: sub.submissionId, status: 'SKIPPED_DELETED' });
                    continue;
                }

                const previousCode = (typeof sub.campaignCode === 'string' && sub.campaignCode.trim())
                    ? sub.campaignCode.trim().toUpperCase()
                    : null;

                if (previousCode === canonicalCode) {
                    unchangedCount++;
                    results.push({ submissionId: sub.submissionId, status: 'UNCHANGED', previousCampaignCode: previousCode, campaignCode: canonicalCode });
                    continue;
                }

                list[index] = {
                    ...sub,
                    campaignCode: canonicalCode,
                    version: (Number(sub.version) || 1) + 1,
                    updatedAt: now
                };
                updatedCount++;
                auditTargets.push({
                    submissionId: sub.submissionId,
                    internalSurveyId: sub.internalSurveyId || null,
                    previousCampaignCode: previousCode
                });
                results.push({ submissionId: sub.submissionId, status: 'UPDATED', previousCampaignCode: previousCode, campaignCode: canonicalCode });
            }

            if (updatedCount > 0) {
                await this.saveSurveySubmissions(list);
            }

            // 3. Per-item audit events (same pattern as assignStaff)
            for (const target of auditTargets) {
                await this.recordAuditEvent({
                    actorId: actorId || 'system',
                    action: SURVEY_CAMPAIGN_AUDIT_ACTIONS.SUBMISSION_CAMPAIGN_CHANGED,
                    submissionId: target.submissionId,
                    internalSurveyId: target.internalSurveyId,
                    result: 'SUCCESS',
                    details: {
                        previousCampaignCode: target.previousCampaignCode,
                        newCampaignCode: canonicalCode,
                        campaignCompanyName: campaign ? (campaign.companyName || null) : null
                    }
                });
            }

            return {
                requested: ids.length,
                updated: updatedCount,
                unchanged: unchangedCount,
                skipped: skippedCount,
                notFound: notFoundCount,
                campaignCode: canonicalCode,
                campaign: campaign ? { code: campaign.code, companyName: campaign.companyName || null } : null,
                results
            };
        });
    }

    /**
     * Bulk-delete imported survey submissions (admin simplified deletion).
     * Safety rules:
     * - Submissions already converted to a Referral are NEVER deleted here
     *   (skipped with SKIPPED_REFERRAL_LINKED so the caller can warn the admin);
     *   the linked Referral itself is never touched either.
     * - Physical deletion reuses deleteSubmissionCascading, which removes the
     *   submission, ledger entry, consent evidence, pending records, workflow
     *   journal and orphan report attachment files (files shared with a
     *   Referral are retained by that routine).
     */
    async bulkDeleteSubmissions({ submissionIds, actorId = 'admin', reason = '' } = {}) {
        if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
            const err = new Error('삭제할 설문 목록(submissionIds)이 비어있습니다.');
            err.code = 'INVALID_PARAM';
            err.status = 400;
            throw err;
        }

        const effectiveReason = (typeof reason === 'string' && reason.trim())
            ? reason.trim().substring(0, 200)
            : '관리자 일괄 삭제';

        const subs = this.getSurveySubmissions();
        const referrals = this.getData('Referrals', []);
        const results = [];
        let deletedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let deletedFileCount = 0;

        for (const rawId of submissionIds) {
            const id = String(rawId);
            const sub = subs.find(s => s && (s.submissionId === id || s.internalSurveyId === id));

            if (!sub) {
                failedCount++;
                results.push({ submissionId: id, status: 'NOT_FOUND' });
                continue;
            }

            if (sub.deletionStatus === 'deleted' || sub.status === 'deleted') {
                skippedCount++;
                results.push({ submissionId: sub.submissionId, status: 'ALREADY_DELETED' });
                continue;
            }

            // Referral-converted submissions are excluded from deletion (safety first)
            const linkedReferral = referrals.find(r =>
                r && (
                    (sub.referralId && (r.referralId === sub.referralId || r.id === sub.referralId)) ||
                    r.sourceSubmissionId === sub.submissionId ||
                    (sub.internalSurveyId && r.linkedSurveyId === sub.internalSurveyId)
                )
            ) || null;

            if (sub.referralId || linkedReferral) {
                skippedCount++;
                results.push({
                    submissionId: sub.submissionId,
                    status: 'SKIPPED_REFERRAL_LINKED',
                    referralId: (linkedReferral && (linkedReferral.referralId || linkedReferral.id)) || sub.referralId || null,
                    refNo: (linkedReferral && linkedReferral.refNo) || sub.refNo || null
                });
                continue;
            }

            try {
                const delResult = await this.deleteSubmissionCascading({
                    submissionId: sub.submissionId,
                    actorId,
                    reason: effectiveReason
                });
                deletedFileCount += Number(delResult?.deletedFileCount || 0);
                deletedCount++;
                results.push({ submissionId: sub.submissionId, status: 'DELETED' });
            } catch (delErr) {
                failedCount++;
                results.push({ submissionId: sub.submissionId, status: 'FAILED', reasonCode: delErr.code || 'DELETE_FAILED' });
            }
        }

        // Summary audit event (no submissionId so it survives cascade audit sanitization)
        await this.recordAuditEvent({
            actorId: actorId || 'admin',
            action: SURVEY_CAMPAIGN_AUDIT_ACTIONS.BULK_SUBMISSIONS_DELETED,
            result: failedCount > 0 ? 'PARTIAL' : 'SUCCESS',
            details: {
                requested: submissionIds.length,
                deleted: deletedCount,
                skipped: skippedCount,
                failed: failedCount,
                deletedFileCount,
                reason: effectiveReason,
                skippedBreakdown: results
                    .filter(r => r.status === 'SKIPPED_REFERRAL_LINKED' || r.status === 'ALREADY_DELETED')
                    .map(r => ({ submissionId: r.submissionId, status: r.status }))
            }
        });

        return {
            requested: submissionIds.length,
            deleted: deletedCount,
            skipped: skippedCount,
            failed: failedCount,
            deletedFileCount,
            results
        };
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

        return updated;
    }

    /**
     * Unassign staff from an imported survey.
     * Allowed only if not registered (no referralId) and currently assigned.
     */
    async unassignStaff({ internalSurveyId, submissionId, actorId = 'admin', reason = '담당자 배정 취소' }) {
        const targetId = internalSurveyId || submissionId;
        const list = this.getSurveySubmissions();
        const index = list.findIndex(s => (targetId && (s.internalSurveyId === targetId || s.submissionId === targetId)));
        if (index === -1) {
            const err = new Error(`Survey submission not found: ${targetId}`);
            err.code = 'RECORD_NOT_FOUND';
            throw err;
        }

        const current = list[index];

        if (current.referralId) {
            const err = new Error('이미 의뢰대장이 등록된 설문은 배정 취소할 수 없습니다.');
            err.code = 'ALREADY_REGISTERED';
            throw err;
        }

        if (!current.assignedUserId || current.assignmentStatus === 'unassigned') {
            const err = new Error('이미 미배정 상태입니다.');
            err.code = 'NOT_ASSIGNED';
            throw err;
        }

        const previousAssignedUserId = current.assignedUserId;
        const previousPriority = current.assignmentPriority || 'NORMAL';
        const now = this._nowIso();

        const updated = {
            ...current,
            assignedUserId: null,
            assignedDepartmentId: '',
            assignedByUserId: null,
            assignedAt: null,
            assignmentUpdatedAt: now,
            assignmentStatus: 'unassigned',
            consultationStatus: '신규접수대기',
            reassignedAt: null,
            version: (current.version || 1) + 1,
            updatedAt: now,
            previousAssignedUserId: null
        };

        list[index] = updated;
        await this.saveSurveySubmissions(list);

        // Record history
        let historyItem = null;
        if (this.assignmentRepository) {
            historyItem = await this.assignmentRepository.recordAssignmentHistory({
                surveySubmissionId: updated.internalSurveyId || updated.submissionId,
                previousAssignedUserId,
                newAssignedUserId: null,
                changedByUserId: actorId,
                reason,
                previousPriority,
                newPriority: 'NORMAL'
            });
        }

        // Record audit
        await this.recordAuditEvent({
            actorId,
            actorUserId: actorId,
            action: 'ONLINE_SURVEY_UNASSIGNED',
            internalSurveyId: current.internalSurveyId,
            submissionId: current.submissionId,
            previousAssignedUserId,
            result: 'SUCCESS'
        });

        return {
            success: true,
            submission: updated,
            previousAssignedUserId
        };
    }

    /**
     * Atomically bulk assign or reassign staff members to multiple submissions.
     * Enforces 50 item limit, mode policy, and per-item atomicity with partial success results.
     */
    async bulkAssignStaff({
        submissionIds = [],
        targetUserId,
        targetDepartmentId = '',
        mode = 'unassigned-only',
        note = null,
        actorId = 'admin',
        bulkRequestId = null
    }) {
        if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
            const err = new Error('배정할 대상자 목록(submissionIds)이 비어있습니다.');
            err.code = 'INVALID_PARAM';
            throw err;
        }

        if (submissionIds.length > 50) {
            const err = new Error('일괄 배정은 한 번에 최대 50건까지만 가능합니다.');
            err.code = 'BULK_ASSIGNMENT_LIMIT_EXCEEDED';
            throw err;
        }

        const validModes = ['unassigned-only', 'include-reassignment'];
        if (!validModes.includes(mode)) {
            const err = new Error(`유효하지 않은 배정 모드입니다: ${mode}`);
            err.code = 'INVALID_MODE';
            throw err;
        }

        // Deduplicate IDs while preserving order
        const uniqueIds = Array.from(new Set(submissionIds.map(id => String(id).trim()))).filter(Boolean);
        const effectiveBulkReqId = bulkRequestId || `blk_${crypto.randomUUID()}`;
        const sanitizedNote = note && typeof note === 'string' ? note.trim().substring(0, 200) : null;
        const noteProvided = Boolean(sanitizedNote);

        await this.recordAuditEvent({
            actorId,
            actorUserId: actorId,
            action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_STARTED',
            bulkRequestId: effectiveBulkReqId,
            targetUserId: String(targetUserId),
            requestedCount: uniqueIds.length,
            mode,
            noteProvided,
            result: 'STARTED'
        });

        let assigned = 0;
        let reassigned = 0;
        let skipped = 0;
        let failed = 0;
        const results = [];

        for (const subId of uniqueIds) {
            try {
                // Fetch fresh submission state immediately prior to mutation
                const subs = this.getSurveySubmissions();
                const subIndex = subs.findIndex(s => s && (s.submissionId === subId || s.internalSurveyId === subId));

                if (subIndex === -1) {
                    skipped++;
                    results.push({
                        submissionId: subId,
                        status: 'SKIPPED',
                        reasonCode: 'NOT_FOUND_OR_NOT_ACCESSIBLE'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        targetUserId: String(targetUserId),
                        reasonCode: 'NOT_FOUND_OR_NOT_ACCESSIBLE',
                        result: 'SKIPPED'
                    });
                    continue;
                }

                const current = subs[subIndex];

                // 1. Check if already converted to referral
                if (current.referralId) {
                    skipped++;
                    results.push({
                        submissionId: subId,
                        status: 'SKIPPED',
                        reasonCode: 'ALREADY_REGISTERED'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        targetUserId: String(targetUserId),
                        reasonCode: 'ALREADY_REGISTERED',
                        result: 'SKIPPED'
                    });
                    continue;
                }

                // 2. Check if deleted or cancelled
                if (current.status === 'deleted' || current.deletionStatus === 'deleted') {
                    skipped++;
                    results.push({
                        submissionId: subId,
                        status: 'SKIPPED',
                        reasonCode: 'CANCELLED'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        targetUserId: String(targetUserId),
                        reasonCode: 'CANCELLED',
                        result: 'SKIPPED'
                    });
                    continue;
                }

                // 3. Check if expired
                if (current.retentionUntil) {
                    const expiryMs = new Date(current.retentionUntil).getTime();
                    if (!isNaN(expiryMs) && expiryMs <= Date.now()) {
                        skipped++;
                        results.push({
                            submissionId: subId,
                            status: 'SKIPPED',
                            reasonCode: 'EXPIRED'
                        });
                        await this.recordAuditEvent({
                            actorId,
                            actorUserId: actorId,
                            action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                            bulkRequestId: effectiveBulkReqId,
                            submissionId: subId,
                            targetUserId: String(targetUserId),
                            reasonCode: 'EXPIRED',
                            result: 'SKIPPED'
                        });
                        continue;
                    }
                }

                const prevAssignee = current.assignedUserId || null;

                // 4. Check if already assigned to the SAME assignee
                if (prevAssignee && String(prevAssignee) === String(targetUserId)) {
                    skipped++;
                    results.push({
                        submissionId: subId,
                        status: 'SKIPPED',
                        reasonCode: 'SAME_ASSIGNEE'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        targetUserId: String(targetUserId),
                        previousAssignedUserId: prevAssignee,
                        reasonCode: 'SAME_ASSIGNEE',
                        result: 'SKIPPED'
                    });
                    continue;
                }

                // 5. Mode policy: if unassigned-only and already assigned to another staff
                if (prevAssignee && mode === 'unassigned-only') {
                    skipped++;
                    results.push({
                        submissionId: subId,
                        status: 'SKIPPED',
                        reasonCode: 'ASSIGNMENT_CONFLICT'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SKIPPED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        targetUserId: String(targetUserId),
                        previousAssignedUserId: prevAssignee,
                        reasonCode: 'ASSIGNMENT_CONFLICT',
                        result: 'SKIPPED'
                    });
                    continue;
                }

                // Proceed with assignment / reassignment
                const isReassign = Boolean(prevAssignee && prevAssignee !== targetUserId);
                const now = this._nowIso();

                const updated = {
                    ...current,
                    assignedUserId: String(targetUserId),
                    assignedDepartmentId: targetDepartmentId || current.assignedDepartmentId || '',
                    assignedByUserId: actorId,
                    assignedAt: current.assignedAt || now,
                    reassignedAt: isReassign ? now : (current.reassignedAt || null),
                    assignmentUpdatedAt: now,
                    assignmentStatus: isReassign ? 'reassigned' : 'assigned',
                    consultationStatus: '상담배정',
                    assignmentNote: sanitizedNote || current.assignmentNote || '',
                    version: (current.version || 1) + 1,
                    updatedAt: now,
                    previousAssignedUserId: prevAssignee
                };

                subs[subIndex] = updated;
                await this.saveSurveySubmissions(subs);

                // Record history
                if (this.assignmentRepository) {
                    await this.assignmentRepository.recordAssignmentHistory({
                        surveySubmissionId: updated.internalSurveyId || updated.submissionId,
                        previousAssignedUserId: prevAssignee,
                        newAssignedUserId: String(targetUserId),
                        changedByUserId: actorId,
                        reason: sanitizedNote || (isReassign ? '일괄 재배정' : '일괄 신규 배정'),
                        note: sanitizedNote || null,
                        previousPriority: current.assignmentPriority || 'NORMAL',
                        newPriority: updated.assignmentPriority || 'NORMAL'
                    });
                }

                if (isReassign) {
                    reassigned++;
                    results.push({
                        submissionId: subId,
                        status: 'REASSIGNED',
                        reasonCode: 'REASSIGNED'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_REASSIGNED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        internalSurveyId: current.internalSurveyId,
                        previousAssignedUserId: prevAssignee,
                        targetUserId: String(targetUserId),
                        result: 'SUCCESS'
                    });
                } else {
                    assigned++;
                    results.push({
                        submissionId: subId,
                        status: 'ASSIGNED',
                        reasonCode: 'NEW_ASSIGNMENT'
                    });
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_BULK_ASSIGNED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        internalSurveyId: current.internalSurveyId,
                        targetUserId: String(targetUserId),
                        result: 'SUCCESS'
                    });
                }

                if (noteProvided) {
                    await this.recordAuditEvent({
                        actorId,
                        actorUserId: actorId,
                        action: 'ONLINE_SURVEY_ASSIGNMENT_NOTE_RECORDED',
                        bulkRequestId: effectiveBulkReqId,
                        submissionId: subId,
                        noteProvided: true,
                        result: 'SUCCESS'
                    });
                }

            } catch (itemErr) {
                failed++;
                results.push({
                    submissionId: subId,
                    status: 'FAILED',
                    reasonCode: itemErr.code || 'INTERNAL_ERROR'
                });
                await this.recordAuditEvent({
                    actorId,
                    actorUserId: actorId,
                    action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_FAILED',
                    bulkRequestId: effectiveBulkReqId,
                    submissionId: subId,
                    targetUserId: String(targetUserId),
                    reasonCode: itemErr.code || 'INTERNAL_ERROR',
                    result: 'FAILED'
                });
            }
        }

        // Summary audit
        await this.recordAuditEvent({
            actorId,
            actorUserId: actorId,
            action: 'ONLINE_SURVEY_BULK_ASSIGNMENT_SUMMARY',
            bulkRequestId: effectiveBulkReqId,
            targetUserId: String(targetUserId),
            requestedCount: uniqueIds.length,
            assignedCount: assigned,
            reassignedCount: reassigned,
            skippedCount: skipped,
            failedCount: failed,
            result: failed === 0 ? 'SUCCESS' : (assigned + reassigned > 0 ? 'PARTIAL_SUCCESS' : 'ALL_FAILED')
        });

        return {
            requested: uniqueIds.length,
            assigned,
            reassigned,
            skipped,
            failed,
            results,
            bulkRequestId: effectiveBulkReqId
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

    async recordAuditEvent(eventData = {}) {
        const list = this.getAuditLogs();
        const event = {
            id: `aud_${crypto.randomUUID()}`,
            timestamp: this._nowIso(),
            actorId: eventData.actorId || eventData.actorUserId || 'system',
            actorUserId: eventData.actorUserId || eventData.actorId || 'system',
            action: eventData.action,
            submissionId: eventData.submissionId || null,
            internalSurveyId: eventData.internalSurveyId || null,
            result: eventData.result || 'SUCCESS',
            errorCode: eventData.errorCode || null,
            batchId: eventData.batchId || null,
            ...eventData
        };
        list.push(event);
        // Keep last 10,000 audit items
        if (list.length > 10000) {
            list.splice(0, list.length - 10000);
        }
        await this.persistData(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT, list);
        if (typeof this.auditLogger === 'function') {
            try { this.auditLogger(event); } catch (ignore) {}
        }
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
    async persistSurveyIntake({ envelope, payload, campaignCodeMetadata = null, isSbqrQuarantined, quarantineReason, actorId, batchId }) {
        const effectiveSourceEnv = envelope.sourceEnvironment || this.sourceEnvironment || 'mock';
        if (this.sourceEnvironment === 'production' && effectiveSourceEnv !== 'production') {
            throw new Error(`[SECURITY_VIOLATION] Production mode rejected intake write with non-production sourceEnvironment: ${effectiveSourceEnv}`);
        }
        if (this.sourceEnvironment === 'staging' && effectiveSourceEnv === 'production') {
            throw new Error('[SECURITY_VIOLATION] Staging mode rejected intake write targeting production');
        }

        const now = this._nowIso();
        const internalSurveyId = `surv_${crypto.randomUUID()}`;
        const submissionId = envelope.submissionId;

        // Calculate retention expiration
        const retentionDays = payload.retention?.retentionDays || 365;
        const retentionUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

        const requestType = payload.requestType || (payload.consultationRequested ? 'CONSULTATION_REQUEST' : 'SCREENING_ONLY');
        const isScreeningOnly = requestType === 'SCREENING_ONLY';
        const consultationRequested = isScreeningOnly ? false : Boolean(payload.consultationRequested);
        const consultationRequestedAt = isScreeningOnly ? null : (payload.consultationRequestedAt || null);
        const screeningCompletedAt = payload.screeningCompletedAt || payload.submittedAt || now;

        const processingStatus = isScreeningOnly
            ? 'SCREENING_COMPLETED'
            : (isSbqrQuarantined ? 'QUARANTINED' : 'PENDING_STAFF_REVIEW');
        const assignmentStatus = isScreeningOnly ? 'not_required' : 'unassigned';
        const consultationStatus = isScreeningOnly ? '검사완료' : (isSbqrQuarantined ? '격리(SBQ-R 대기)' : '신규접수대기');

        // 1. Survey Submission Record
        const surveySubmissions = this.getSurveySubmissions();
        const surveyRecord = {
            internalSurveyId,
            submissionId,
            requestType,
            consultationRequested,
            consultationRequestedAt,
            screeningCompletedAt,
            assessmentId: payload.assessmentId,
            assessmentVersion: payload.assessmentVersion,
            contactOnly: !!payload.contactOnly,
            assessmentDataIncluded: !!(payload.assessment && Object.keys(payload.assessment).length > 0),
            importedAt: now,
            processingStatus,
            consultationStatus,
            assignedUserId: null,
            assignedByUserId: null,
            assignedAt: null,
            assignmentStatus,
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
            campaignCode: payload.campaignCode || null,
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

        // 3. Register into PendingReferrals candidate pool ONLY for CONSULTATION_REQUEST (not SCREENING_ONLY, not quarantined)
        let pendingReferralId = null;
        if (!isScreeningOnly && !isSbqrQuarantined && payload.contact && (payload.contact.clientName || payload.contact.phone)) {
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
            requestType,
            consultationRequested,
            consultationRequestedAt,
            screeningCompletedAt,
            processingStatus,
            assignmentStatus,
            importedAt: now,
            lastAttemptAt: now
        });

        // 5. Campaign Intake Classification & Audit (Calibration 1 & M1 §I.3)
        let campaignClassification = SURVEY_CAMPAIGN_CLASSIFICATIONS.ABSENT;
        const campaignMeta = campaignCodeMetadata || (envelope && envelope.campaignCodeMetadata) || getCampaignMetadataForPayload(payload);
        if (campaignMeta && campaignMeta.status === 'INVALID') {
            campaignClassification = SURVEY_CAMPAIGN_CLASSIFICATIONS.INVALID;
        } else if (payload.campaignCode) {
            const registeredCampaign = this.findCampaignByCode(payload.campaignCode);
            campaignClassification = registeredCampaign
                ? SURVEY_CAMPAIGN_CLASSIFICATIONS.VALID_REGISTERED
                : SURVEY_CAMPAIGN_CLASSIFICATIONS.VALID_UNREGISTERED;
        } else {
            campaignClassification = SURVEY_CAMPAIGN_CLASSIFICATIONS.ABSENT;
        }

        // 5a. Record Standard Intake Audit
        await this.recordAuditEvent({
            actorId,
            action: isSbqrQuarantined ? 'SURVEY_IMPORT_QUARANTINED' : 'SURVEY_IMPORT_STORED',
            submissionId,
            internalSurveyId,
            result: isSbqrQuarantined ? 'QUARANTINED' : 'SUCCESS',
            errorCode: isSbqrQuarantined ? 'SBQR_GATE_UNAPPROVED' : null,
            campaignClassification,
            // CRITICAL: NEVER log raw invalid code string in audit logs
            campaignCode: campaignClassification === SURVEY_CAMPAIGN_CLASSIFICATIONS.INVALID ? null : (payload.campaignCode || null),
            batchId
        });

        // 5b. Record Explicit Intake Classification Audit Event
        await this.recordAuditEvent({
            actorId: actorId || 'system',
            action: campaignClassification,
            submissionId,
            internalSurveyId,
            result: 'SUCCESS',
            campaignClassification,
            campaignCode: campaignClassification === SURVEY_CAMPAIGN_CLASSIFICATIONS.INVALID ? null : (payload.campaignCode || null),
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

    // ──────────────────────────────────────────────────────────
    // 6. CONSULTATION_REQUEST Promotion
    // ──────────────────────────────────────────────────────────

    /**
     * Promote an existing SCREENING_ONLY record to CONSULTATION_REQUEST.
     * Enforces idempotency and guarantees zero duplicate subject records.
     */
    async promoteToConsultationRequest({ submissionId, consultationRequestedAt, actorId = 'system' }) {
        if (!submissionId) {
            throw new Error('submissionId is required for promotion');
        }

        const now = this._nowIso();
        const subs = this.getSurveySubmissions();
        const subIndex = subs.findIndex(s => s.submissionId === submissionId || s.internalSurveyId === submissionId);
        if (subIndex === -1) {
            return { notFound: true, submissionId };
        }

        const currentSub = subs[subIndex];
        // Idempotency: if already CONSULTATION_REQUEST, return without duplicate
        if (currentSub.requestType === 'CONSULTATION_REQUEST' && currentSub.consultationRequested === true) {
            return {
                submission: currentSub,
                alreadyPromoted: true,
                isDuplicate: true
            };
        }

        const requestedAt = consultationRequestedAt || now;
        const updatedSub = {
            ...currentSub,
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationRequestedAt: requestedAt,
            assignmentStatus: 'unassigned',
            processingStatus: 'PENDING_STAFF_REVIEW',
            consultationStatus: '신규접수대기',
            updatedAt: now,
            version: (currentSub.version || 1) + 1
        };
        subs[subIndex] = updatedSub;
        await this.saveSurveySubmissions(subs);

        // Update ledger
        const ledgerList = this.getImportsLedger();
        const lIndex = ledgerList.findIndex(l => l.submissionId === submissionId);
        if (lIndex !== -1) {
            ledgerList[lIndex] = {
                ...ledgerList[lIndex],
                requestType: 'CONSULTATION_REQUEST',
                consultationRequested: true,
                consultationRequestedAt: requestedAt,
                assignmentStatus: 'unassigned',
                processingStatus: 'PENDING_STAFF_REVIEW',
                updatedAt: now
            };
            await this.saveImportsLedger(ledgerList);
        }

        await this.recordWorkflowStep({
            submissionId,
            internalSurveyId: updatedSub.internalSurveyId,
            step: 'CONSULTATION_PROMOTED',
            details: { promotedAt: now, actorId }
        });

        await this.recordAuditEvent({
            actorId,
            action: 'SURVEY_CONSULTATION_PROMOTED',
            submissionId,
            internalSurveyId: updatedSub.internalSurveyId,
            result: 'SUCCESS'
        });

        return {
            submission: updatedSub,
            alreadyPromoted: false,
            promoted: true
        };
    }

    // ──────────────────────────────────────────────────────────
    // 7. Cascading Deletion & Demo Data Purge
    // ──────────────────────────────────────────────────────────

    /**
     * Cascading deletion of a single submission and all connected assets.
     * ZERO PII audit logging.
     */
    async deleteSubmissionCascading(args) {
        const params = typeof args === 'string' ? { submissionId: args } : (args || {});
        const { submissionId, actorId = 'admin', reason = 'Admin deletion', isSynthetic = false } = params;
        if (!submissionId) {
            throw new Error('submissionId is required for deletion');
        }

        const subs = this.getSurveySubmissions();
        const subIndex = subs.findIndex(s => s.submissionId === submissionId || s.internalSurveyId === submissionId);
        const ledgerList = this.getImportsLedger();
        const ledgerIndex = ledgerList.findIndex(l => l.submissionId === submissionId);

        if (subIndex === -1 && ledgerIndex === -1) {
            // Idempotent: already deleted
            return {
                success: true,
                alreadyDeleted: true,
                deletedRecordCount: 0,
                deletedFileCount: 0,
                submissionId
            };
        }

        const sub = subIndex !== -1 ? subs[subIndex] : null;
        const ledger = ledgerIndex !== -1 ? ledgerList[ledgerIndex] : null;

        // Check active lease
        if (ledger && ledger.externalStatus === SURVEY_EXTERNAL_STATUS.LEASED) {
            if (ledger.leaseUntil && new Date(ledger.leaseUntil).getTime() > Date.now()) {
                const err = new Error(`Cannot delete submission ${submissionId}: active lease exists`);
                err.code = 'ACTIVE_LEASE_EXISTS';
                throw err;
            }
        }

        let deletedRecordCount = 0;
        let deletedFileCount = 0;

        // 1. Remove from SurveySubmissions
        if (subIndex !== -1) {
            subs.splice(subIndex, 1);
            await this.saveSurveySubmissions(subs);
            deletedRecordCount++;
        }

        // 2. Remove from ExternalSubmissionImports
        if (ledgerIndex !== -1) {
            ledgerList.splice(ledgerIndex, 1);
            await this.saveImportsLedger(ledgerList);
            deletedRecordCount++;
        }

        // 3. Remove from SurveyConsentEvidence
        const consents = this.getConsentEvidenceList();
        const remainingConsents = consents.filter(c => c.submissionId !== submissionId && c.internalSurveyId !== sub?.internalSurveyId);
        if (remainingConsents.length !== consents.length) {
            deletedRecordCount += (consents.length - remainingConsents.length);
            await this.saveConsentEvidenceList(remainingConsents);
        }

        // 4. Independent Referral Retention: DO NOT cascade delete Referral records
        const referrals = this.getData('Referrals', []);
        const connectedReferral = referrals.find(r =>
            r && (
                r.sourceSubmissionId === submissionId ||
                r.externalIdx === submissionId ||
                r.linkedSurveyId === submissionId ||
                (sub?.referralId && (r.referralId === sub.referralId || r.id === sub.referralId))
            )
        ) || null;

        // 5. Remove connected PendingReferrals
        const pendingList = this.getData('PendingReferrals', []);
        const remainingPending = pendingList.filter(p =>
            p && p.submissionId !== submissionId && p.surveySubmissionId !== sub?.internalSurveyId
        );
        if (remainingPending.length !== pendingList.length) {
            deletedRecordCount += (pendingList.length - remainingPending.length);
            await this.persistData('PendingReferrals', remainingPending);
        }

        // 6. Remove SurveyWorkflowJournal entries
        const journals = this.getWorkflowJournal();
        const remainingJournals = journals.filter(j => j.submissionId !== submissionId);
        if (remainingJournals.length !== journals.length) {
            deletedRecordCount += (journals.length - remainingJournals.length);
            await this.saveWorkflowJournal(remainingJournals);
        }

        // 7. Delete physical files from disk ONLY IF NOT SHARED with a Referral
        const isAttachmentSharedWithReferral = Boolean(
            connectedReferral && (
                (connectedReferral.referralId && sub?.referralId === connectedReferral.referralId) ||
                (connectedReferral.id && sub?.referralId === connectedReferral.id) ||
                connectedReferral.attachments?.some(a =>
                    a && (a.id === sub?.attachmentId || a.id === sub?.attachment?.id || (sub?.attachment?.fileHash && a.fileHash === sub?.attachment?.fileHash))
                )
            )
        );

        if (isAttachmentSharedWithReferral) {
            // RETAIN physical PDF files for the Referral!
            await this.recordAuditEvent({
                actorId: actorId || 'admin',
                action: 'SHARED_ATTACHMENT_RETAINED',
                submissionId,
                referralId: connectedReferral.referralId || connectedReferral.id,
                attachmentId: sub?.attachmentId || sub?.attachment?.id || null,
                result: 'SUCCESS'
            });
        } else {
            // Orphan attachment: safely delete from disk
            if (this.attachmentsDir && fs.existsSync(this.attachmentsDir)) {
                const foldersToCheck = new Set();
                if (sub?.internalSurveyId) foldersToCheck.add(sub.internalSurveyId);
                if (submissionId) foldersToCheck.add(submissionId);

                for (const folderName of foldersToCheck) {
                    const safeFolder = folderName.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
                    const targetDir = path.join(this.attachmentsDir, safeFolder);
                    if (fs.existsSync(targetDir)) {
                        try {
                            const files = fs.readdirSync(targetDir);
                            for (const f of files) {
                                fs.unlinkSync(path.join(targetDir, f));
                                deletedFileCount++;
                            }
                            fs.rmdirSync(targetDir);
                        } catch (ignore) {}
                    }
                }

                if (sub?.attachmentId) {
                    try {
                        const findAndDelete = (dir) => {
                            if (!fs.existsSync(dir)) return;
                            const items = fs.readdirSync(dir, { withFileTypes: true });
                            for (const item of items) {
                                const full = path.join(dir, item.name);
                                if (item.isDirectory()) {
                                    findAndDelete(full);
                                } else if (item.name === sub.attachmentId || item.name.includes(submissionId)) {
                                    fs.unlinkSync(full);
                                    deletedFileCount++;
                                }
                            }
                        };
                        findAndDelete(this.attachmentsDir);
                    } catch (ignore) {}
                }
            }

            await this.recordAuditEvent({
                actorId: actorId || 'admin',
                action: 'ORPHAN_ATTACHMENT_DELETED',
                submissionId,
                attachmentId: sub?.attachmentId || null,
                result: 'SUCCESS'
            });
        }

        // 8. Sanitize SurveyImportAudit to remove PII of deleted submission
        const audits = this.getAuditLogs();
        const remainingAudits = audits.filter(a => a.submissionId !== submissionId);
        if (remainingAudits.length !== audits.length) {
            await this.persistData(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT, remainingAudits);
        }

        // 9. Update stats metadata (cumulative tracker)
        const statsMeta = this.getData('WebsiteSyncMetadata', {});
        const currentStats = statsMeta.onlineSurveyStats || { cumulativeProcessed: 0, totalDeleted: 0 };
        currentStats.totalDeleted = (currentStats.totalDeleted || 0) + 1;
        statsMeta.onlineSurveyStats = currentStats;
        await this.persistData('WebsiteSyncMetadata', statsMeta);

        // 10. Record Safe Audit Event (ZERO PII)
        const deletionJobId = `del_${crypto.randomUUID()}`;
        const syntheticFlag = Boolean(isSynthetic || submissionId.startsWith('sub-demo-') || sub?.isSynthetic);

        await this.recordAuditEvent({
            actorId: actorId || 'admin',
            action: 'ONLINE_SCREENING_SUBJECT_DELETED',
            result: 'SUCCESS',
            deletionJobId,
            reason: String(reason || 'ADMIN_REQUEST').substring(0, 200),
            deletedRecordCount,
            deletedFileCount,
            isSynthetic: syntheticFlag
        });

        return {
            success: true,
            submissionId,
            deletionJobId,
            deletedRecordCount,
            deletedFileCount,
            sharedAttachmentRetained: isAttachmentSharedWithReferral,
            isSynthetic: syntheticFlag
        };
    }

    /**
     * Purge submissions whose retention period has expired (default 30 days).
     * If submission has an active Referral, the survey raw submission is purged,
     * but the Referral record, its data, and the physical PDF attachment are RETAINED.
     * If no Referral exists, the orphan PDF attachment is deleted.
     */
    async purgeExpiredSubmissions({ actorId = 'system', retentionDays = 30, dryRun = false } = {}) {
        const subs = this.getSurveySubmissions();
        const now = Date.now();
        const expiredSubs = [];

        for (const s of subs) {
            if (!s) continue;
            let isExpired = false;
            if (s.retentionUntil) {
                const t = new Date(s.retentionUntil).getTime();
                if (!Number.isNaN(t) && t > 0) {
                    isExpired = t <= now;
                }
            } else {
                // retentionUntil이 없는 레거시 레코드의 기준일도 접수일시와 동일하게
                // 실제 검사 완료 시각(screeningCompletedAt) 우선으로 판정한다.
                const rawDateStr = s.screeningCompletedAt || s.submittedAt || s.importedAt;
                if (rawDateStr) {
                    const t = new Date(rawDateStr).getTime();
                    if (!Number.isNaN(t) && t > 0) {
                        const days = Number(s.retentionDays || retentionDays) || 30;
                        isExpired = (now - t) >= (days * 24 * 60 * 60 * 1000);
                    }
                }
            }
            if (isExpired) {
                expiredSubs.push(s);
            }
        }

        if (dryRun) {
            return {
                dryRun: true,
                expiredCount: expiredSubs.length,
                expiredSubmissions: expiredSubs.map(s => ({
                    submissionId: s.submissionId,
                    hasReferral: Boolean(s.referralId)
                }))
            };
        }

        let purgedCount = 0;
        let retainedSharedPdfCount = 0;
        let deletedOrphanPdfCount = 0;
        let failedCount = 0;

        for (const expSub of expiredSubs) {
            try {
                const res = await this.deleteSubmissionCascading({
                    submissionId: expSub.submissionId,
                    actorId,
                    reason: `Retention expired (${retentionDays} days)`
                });
                purgedCount++;
                if (res.sharedAttachmentRetained) {
                    retainedSharedPdfCount++;
                } else if (res.deletedFileCount > 0) {
                    deletedOrphanPdfCount++;
                }
                await this.recordAuditEvent({
                    actorId,
                    action: 'SURVEY_RETENTION_PURGED',
                    submissionId: expSub.submissionId,
                    referralId: expSub.referralId || null,
                    result: 'SUCCESS'
                });
            } catch (err) {
                failedCount++;
                // Fail-closed: Never delete if error occurs
                await this.recordAuditEvent({
                    actorId,
                    action: 'SURVEY_RETENTION_PURGE_FAILED',
                    submissionId: expSub.submissionId,
                    result: 'FAILED',
                    reasonCode: err.code || 'PURGE_ERROR'
                });
            }
        }

        return {
            success: true,
            totalProcessed: expiredSubs.length,
            purgedCount,
            retainedSharedPdfCount,
            deletedOrphanPdfCount,
            failedCount
        };
    }

    /**
     * Purge dummy / synthetic survey submissions with dry-run support.
     * Strictly aborts if any real data is in the targets.
     */
    async purgeDemoSubmissions({ actorId = 'admin', reason = 'Demo data purge', dryRun = false }) {
        if (!reason || typeof reason !== 'string' || !reason.trim()) {
            const err = new Error('삭제 사유를 입력해야 합니다.');
            err.code = 'MISSING_DELETION_REASON';
            throw err;
        }

        const subs = this.getSurveySubmissions();
        const ledgerList = this.getImportsLedger();

        const isDemoIdentifier = (id, obj = {}) => {
            if (!id || typeof id !== 'string') return false;
            return id.startsWith('sub-demo-') || obj.isSynthetic === true || obj.synthetic === true;
        };

        const targetSubIds = new Set();
        for (const s of subs) {
            if (isDemoIdentifier(s.submissionId, s)) {
                targetSubIds.add(s.submissionId);
            }
        }
        for (const l of ledgerList) {
            if (isDemoIdentifier(l.submissionId, l)) {
                targetSubIds.add(l.submissionId);
            }
        }

        const demoIdList = Array.from(targetSubIds);

        // REAL DATA CHECK: verify EVERY candidate is truly demo
        for (const id of demoIdList) {
            if (!id.startsWith('sub-demo-')) {
                const s = subs.find(item => item.submissionId === id);
                const l = ledgerList.find(item => item.submissionId === id);
                if ((!s || !s.isSynthetic) && (!l || !l.isSynthetic)) {
                    const err = new Error(`실제 데이터가 감지되어 더미 일괄 삭제를 거부합니다: ${id}`);
                    err.code = 'DEMO_PURGE_CONTAINS_REAL_DATA';
                    throw err;
                }
            }
        }

        const referrals = this.getData('Referrals', []);
        const connectedReferrals = referrals.filter(r =>
            r && (demoIdList.includes(r.sourceSubmissionId) || demoIdList.includes(r.externalIdx))
        );

        if (dryRun) {
            return {
                dryRun: true,
                targetCount: demoIdList.length,
                submissionIds: demoIdList,
                connectedReferralsCount: connectedReferrals.length,
                connectedFilesCount: demoIdList.length,
                plannedActions: [
                    `ExternalSubmissionImports: ${demoIdList.length}건 삭제 예정`,
                    `SurveySubmissions: ${demoIdList.length}건 삭제 예정`,
                    `Referrals (연결 의뢰): ${connectedReferrals.length}건 삭제 예정`,
                    `첨부 PDF 파일 및 디렉토리 정리 예정`,
                    `감사로그: ONLINE_SCREENING_DEMO_DATA_PURGED 기록 예정`
                ],
                willExecute: false
            };
        }

        let totalDeletedRecords = 0;
        let totalDeletedFiles = 0;

        for (const subId of demoIdList) {
            const res = await this.deleteSubmissionCascading({
                submissionId: subId,
                actorId,
                reason,
                isSynthetic: true
            });
            totalDeletedRecords += (res.deletedRecordCount || 0);
            totalDeletedFiles += (res.deletedFileCount || 0);
        }

        const deletionJobId = `purge_${crypto.randomUUID()}`;
        await this.recordAuditEvent({
            actorId: actorId || 'admin',
            action: 'ONLINE_SCREENING_DEMO_DATA_PURGED',
            result: 'SUCCESS',
            deletionJobId,
            reason: String(reason).substring(0, 200),
            deletedRecordCount: totalDeletedRecords,
            deletedFileCount: totalDeletedFiles,
            isSynthetic: true
        });

        return {
            success: true,
            purgedCount: demoIdList.length,
            deletedRecordCount: totalDeletedRecords,
            deletedFileCount: totalDeletedFiles,
            deletionJobId
        };
    }

    /**
     * Compute aggregate metrics by unique submissionId.
     */
    getStatistics(userId = null) {
        const subs = this.getSurveySubmissions();
        const ledger = this.getImportsLedger();

        const uniqueSubIds = new Set();
        for (const s of subs) if (s.submissionId) uniqueSubIds.add(s.submissionId);
        for (const l of ledger) if (l.submissionId) uniqueSubIds.add(l.submissionId);

        const totalScreeningCompleted = uniqueSubIds.size;

        let consultationRequested = 0;
        let pendingStaffReview = 0;
        let myAssigned = 0;
        let reportReady = 0;

        for (const s of subs) {
            if (s.consultationRequested === true || s.requestType === 'CONSULTATION_REQUEST') {
                consultationRequested++;
                if (s.processingStatus === 'PENDING_STAFF_REVIEW' || s.assignmentStatus === 'unassigned') {
                    pendingStaffReview++;
                }
            }
            if (userId && (s.assignedUserId === userId || s.assignedUser?.id === userId)) {
                myAssigned++;
            }
            if (s.attachmentId || s.referralId || s.assessmentDataIncluded) {
                reportReady++;
            }
        }

        const consultationNotRequested = Math.max(0, totalScreeningCompleted - consultationRequested);
        const conversionRate = totalScreeningCompleted > 0
            ? Number(((consultationRequested / totalScreeningCompleted) * 100).toFixed(1))
            : 0;

        const statsMeta = this.getData('WebsiteSyncMetadata', {});
        const totalDeleted = statsMeta.onlineSurveyStats?.totalDeleted || 0;
        const cumulativeProcessed = totalScreeningCompleted + totalDeleted;

        return {
            totalScreeningCompleted,
            consultationRequested,
            consultationNotRequested,
            conversionRate,
            pendingStaffReview,
            myAssigned,
            reportReady,
            currentStoredCount: totalScreeningCompleted,
            cumulativeProcessed,
            deletedCount: totalDeleted
        };
    }

    /**
     * Soft delete a survey submission.
     * Marks deletionStatus='deleted', deletedAt, deletedBy, deleteReason, deletionType='SOFT_DELETE'.
     * Preserves records in SurveySubmissions (no splice), ledger, PDF files, and previous audits.
     * Records safe audit event: ONLINE_SCREENING_SUBJECT_SOFT_DELETED.
     */
    async softDeleteSubmission({ submissionId, actorId = 'system', reason = '' }) {
        if (!submissionId) {
            const err = new Error('제출 ID(submissionId)가 필요합니다.');
            err.code = 'INVALID_SUBMISSION_ID';
            err.status = 400;
            throw err;
        }

        const subs = this.getSurveySubmissions();
        const sub = subs.find(s => s && (s.submissionId === submissionId || s.internalSurveyId === submissionId));
        if (!sub) {
            const err = new Error('해당 설문 제출 건을 찾을 수 없습니다.');
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (sub.deletionStatus === 'deleted') {
            const err = new Error('이미 삭제 처리된 설문입니다.');
            err.code = 'ALREADY_DELETED';
            err.status = 400;
            throw err;
        }

        sub.deletionStatus = 'deleted';
        sub.deletedAt = this._nowIso();
        sub.deletedBy = actorId;
        sub.deleteReason = String(reason || '').trim();
        sub.deletionType = 'SOFT_DELETE';

        await this.persistData(SURVEY_STORAGE_FILES.SURVEY_SUBMISSIONS, subs);

        await this.recordAuditEvent({
            actorId,
            actorUserId: actorId,
            action: 'ONLINE_SCREENING_SUBJECT_SOFT_DELETED',
            target: sub.submissionId,
            submissionId: sub.submissionId,
            internalSurveyId: sub.internalSurveyId,
            reason: String(reason || '').trim().substring(0, 200),
            result: 'SUCCESS',
            deletionType: 'SOFT_DELETE'
        });

        return {
            success: true,
            submissionId: sub.submissionId,
            deletionType: 'SOFT_DELETE'
        };
    }

    /**
     * Restore a soft-deleted survey submission.
     * Reverts deletionStatus to 'active'.
     * Records safe audit event: ONLINE_SCREENING_SUBJECT_RESTORED.
     */
    async restoreSubmission({ submissionId, actorId = 'admin' }) {
        if (!submissionId) {
            const err = new Error('제출 ID(submissionId)가 필요합니다.');
            err.code = 'INVALID_SUBMISSION_ID';
            err.status = 400;
            throw err;
        }

        const subs = this.getSurveySubmissions();
        const sub = subs.find(s => s && (s.submissionId === submissionId || s.internalSurveyId === submissionId));
        if (!sub) {
            const err = new Error('해당 설문 제출 건을 찾을 수 없습니다.');
            err.code = 'NOT_FOUND';
            err.status = 404;
            throw err;
        }

        if (sub.deletionStatus !== 'deleted') {
            const err = new Error('삭제 상태가 아닌 설문 건입니다.');
            err.code = 'NOT_DELETED';
            err.status = 400;
            throw err;
        }

        sub.deletionStatus = 'active';
        sub.restoredAt = this._nowIso();
        sub.restoredBy = actorId;

        await this.persistData(SURVEY_STORAGE_FILES.SURVEY_SUBMISSIONS, subs);

        await this.recordAuditEvent({
            actorId,
            actorUserId: actorId,
            action: 'ONLINE_SCREENING_SUBJECT_RESTORED',
            target: sub.submissionId,
            submissionId: sub.submissionId,
            internalSurveyId: sub.internalSurveyId,
            result: 'SUCCESS'
        });

        return {
            success: true,
            submission: sub
        };
    }

    /**
     * Get all soft-deleted submissions.
     */
    getTrashSubmissions() {
        const subs = this.getSurveySubmissions();
        return subs.filter(s => s && s.deletionStatus === 'deleted');
    }
}

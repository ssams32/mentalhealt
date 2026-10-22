/**
 * server/survey/surveyImportRouter.js
 * Express REST API Router for internal survey management & import operations.
 */

import express from 'express';
import { SURVEY_ASSIGNMENT_PRIORITY, NOTIFICATION_TYPES, SURVEY_ERROR_CODES, CAMPAIGN_CODE_PATTERN } from './surveyConstants.js';
import { hasOnlineSurveyAccess, hasSurveyAssignmentAccess } from '../permissions/voiceCapabilities.js';
import { getKstDateRangeUtcBoundaries, formatKstDateTime } from './kstUtils.js';

/**
 * Validates and normalizes campaign filter inputs for import list and export endpoints (Calibration 4).
 * Allowed: 'all' (or empty/undefined), 'unspecified'/'none'/'미지정', or valid CAMPAIGN_CODE_PATTERN.
 */
export function validateAndNormalizeCampaignFilter(filter) {
    if (filter === undefined || filter === null) {
        return { valid: true, type: 'ALL', code: null };
    }
    const str = String(filter).trim();
    if (str === '' || str.toLowerCase() === 'all') {
        return { valid: true, type: 'ALL', code: null };
    }
    const lower = str.toLowerCase();
    if (lower === 'unspecified' || lower === 'none' || str === '미지정') {
        return { valid: true, type: 'UNSPECIFIED', code: null };
    }
    const canonical = str.toUpperCase();
    if (CAMPAIGN_CODE_PATTERN.test(canonical)) {
        return { valid: true, type: 'CODE', code: canonical };
    }
    return { valid: false, type: 'INVALID', code: null };
}

/**
 * Mask client personal name for list views (e.g. 홍길동 -> 홍*동, 이산 -> 이*)
 */
function maskName(name) {
    if (!name || typeof name !== 'string') return '-';
    const trimmed = name.trim();
    if (trimmed.length <= 1) return trimmed;
    if (trimmed.length === 2) return `${trimmed[0]}*`;
    return `${trimmed[0]}${'*'.repeat(trimmed.length - 2)}${trimmed[trimmed.length - 1]}`;
}

/**
 * Mask phone number (e.g. 010-1234-5678 -> 010-****-5678)
 */
function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '-';
    return phone.replace(/(\d{2,3})-?(\d{3,4})-?(\d{4})/, '$1-****-$3');
}

/**
 * Factory to create Survey Router
 * 
 * @param {Object} deps
 * @param {Function} deps.requireAuth
 * @param {import('./surveyImportService.js').SurveyImportService} deps.surveyImportService
 * @param {import('./surveyImportRepository.js').SurveyImportRepository} deps.surveyRepository
 * @param {import('./surveyAssignmentRepository.js').SurveyAssignmentRepository} [deps.surveyAssignmentRepository]
 * @param {import('../notifications/internalNotificationRepository.js').InternalNotificationRepository} [deps.notificationRepository]
 * @param {import('./surveyExportService.js').SurveyExportService} [deps.surveyExportService]
 * @param {Function} [deps.getUsers]
 * @param {Function} [deps.auditLogger]
 */
export function createSurveyImportRouter(deps = {}) {
    const {
        requireAuth,
        surveyImportService,
        surveyRepository,
        surveyAssignmentRepository,
        notificationRepository,
        surveyExportService,
        referralService,
        autoImportScheduler = null,
        getUsers = () => [],
        auditLogger = null
    } = deps;

    if (!requireAuth || !surveyImportService || !surveyRepository) {
        throw new Error('createSurveyImportRouter requires requireAuth, surveyImportService, and surveyRepository');
    }

    /**
     * Strict Permission guard for Online Survey feature access:
     * - Admin auto-allowed
     * - Active user with explicit ONLINE_SURVEY_ACCESS allowed
     * - Default deny for inactive, missing permission, or malformed user
     */
    function requireSurveyImportPermission(req, res, next) {
        if (!req.auth) {
            return res.status(401).json({
                error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }
            });
        }

        if (req.auth.status !== 'active') {
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth.id || req.auth.userId || 'unknown',
                    action: 'ONLINE_SURVEY_ACCESS_DENIED',
                    result: 'DENIED',
                    reasonCode: 'ACCOUNT_INACTIVE'
                });
            }
            return res.status(403).json({
                error: { code: 'FORBIDDEN', message: '비활성화된 계정은 접근할 수 없습니다.' }
            });
        }

        if (!hasOnlineSurveyAccess(req.auth)) {
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth.id || req.auth.userId || 'unknown',
                    action: 'ONLINE_SURVEY_ACCESS_DENIED',
                    result: 'DENIED',
                    reasonCode: 'NO_ONLINE_SURVEY_PERMISSION'
                });
            }
            return res.status(403).json({
                error: { code: 'FORBIDDEN', message: '온라인 설문 기능에 접근할 권한이 없습니다.' }
            });
        }

        return next();
    }

    /**
     * Permission guard for Administrator-only actions
     */
    function requireAdmin(req, res, next) {
        if (!req.auth) {
            return res.status(401).json({
                error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }
            });
        }

        const role = (req.auth.role || req.auth.userRole || 'user').toLowerCase();
        if (role !== 'admin') {
            return res.status(403).json({
                error: { code: 'FORBIDDEN', message: '관리자(Admin) 권한이 필요합니다.' }
            });
        }

        return next();
    }

    const router = express.Router();

    // 1. GET /api/surveys/status - Safe aggregate counts, per-user assignment counts, and import semaphore state
    router.get('/status', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const currentUserId = String(req.auth?.id || req.auth?.userId || '');
            const summary = surveyImportService.getStatusSummary(currentUserId);

            const subs = surveyRepository.getSurveySubmissions();
            let unassignedCount = 0;
            let myAssignedPendingCount = 0;
            let totalPendingReferralCount = 0;

            for (const s of subs) {
                if (!s || s.status === 'deleted' || s.deletionStatus === 'deleted') continue;
                const isConsultation = s.requestType === 'CONSULTATION_REQUEST' || s.consultationRequested === true;
                if (!isConsultation) continue;

                // Pending referral means not yet converted to official referral
                const isPendingReferral = !s.referralId;
                if (isPendingReferral) {
                    totalPendingReferralCount++;
                    const isUnassigned = !s.assignedUserId || s.assignmentStatus === 'unassigned';
                    if (isUnassigned) {
                        unassignedCount++;
                    } else if (String(s.assignedUserId) === currentUserId) {
                        myAssignedPendingCount++;
                    }
                }
            }

            // badgeCount 의미 (2026-10-22 변경): 관리자 포함 전 사용자 "본인에게 배정됐고 아직 의뢰 전환 안 된 건수"로 통일.
            // 예전에는 관리자에게 전체 미등록 건수(totalPendingReferralCount)를 줘서 배지가 항상 크게 떴다.
            // 전체/미배정 건수는 아래 별도 필드(unassignedCount, totalPendingReferralCount)로 계속 제공한다.
            const badgeCount = myAssignedPendingCount;

            res.json({
                ...summary,
                unassignedCount,
                myAssignedPendingCount,
                totalPendingReferralCount,
                badgeCount
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/status error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 1b. GET /api/surveys/readiness - Safe boolean-only staging/operational readiness endpoint (Admin-only)
    // Strictly reports booleans only: no secret values, no private-key content, no filesystem paths, no Track A token, no ciphertext.
    router.get('/readiness', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const mode = (deps.surveyTrackAMode || process.env.SURVEY_TRACK_A_MODE || 'mock').trim().toLowerCase();
            const modeValid = ['mock', 'staging', 'production'].includes(mode);

            let trackAUrlConfigured = false;
            if (mode === 'mock') {
                trackAUrlConfigured = true;
            } else {
                const rawUrl = deps.trackABaseUrl || process.env.TRACK_A_BASE_URL;
                try {
                    if (rawUrl) {
                        const { validateTrackABaseUrl } = await import('./surveyUrlValidator.js');
                        validateTrackABaseUrl(rawUrl, mode);
                        trackAUrlConfigured = true;
                    }
                } catch (e) {
                    trackAUrlConfigured = false;
                }
            }

            let privateKeyReadableAndParseable = false;
            const keyProvider = deps.keyProvider || surveyImportService?.decryptionService?.keyProvider;
            if (keyProvider) {
                try {
                    if (typeof keyProvider.validateKeyFilePermissions === 'function') {
                        privateKeyReadableAndParseable = keyProvider.validateKeyFilePermissions() === true;
                    } else {
                        privateKeyReadableAndParseable = true;
                    }
                } catch (e) {
                    privateKeyReadableAndParseable = false;
                }
            }

            const workerId = deps.trackBWorkerId || process.env.TRACK_B_WORKER_ID;
            const workerIdConfigured = Boolean(workerId && workerId.trim());

            const serviceSecret = deps.trackBServiceSecret || process.env.TRACK_B_SERVICE_SECRET;
            const serviceAuthConfigured = mode === 'mock' ? true : Boolean(serviceSecret && serviceSecret.trim());

            let trackACapabilityReachable = false;
            const externalApiClient = deps.externalApiClient || surveyImportService?.externalApiClient;
            if (externalApiClient) {
                try {
                    if (typeof externalApiClient.checkSubmissionGateStatus === 'function') {
                        const gate = await externalApiClient.checkSubmissionGateStatus();
                        trackACapabilityReachable = gate && gate.submissionEnabled !== false;
                    } else if (typeof externalApiClient.ping === 'function') {
                        trackACapabilityReachable = await externalApiClient.ping();
                    } else {
                        trackACapabilityReachable = true;
                    }
                } catch (e) {
                    trackACapabilityReachable = false;
                }
            }

            let reportStorageWritable = false;
            const targetDir = deps.attachmentsDir || referralService?.attachmentsDir || process.env.ATTACHMENTS_DIR;
            if (targetDir) {
                try {
                    const fsMod = await import('fs');
                    const pathMod = await import('path');
                    if (fsMod.default.existsSync(targetDir)) {
                        const testFilePath = pathMod.default.join(targetDir, `.write_test_${Date.now()}.tmp`);
                        fsMod.default.writeFileSync(testFilePath, 'probe', 'utf8');
                        fsMod.default.unlinkSync(testFilePath);
                        reportStorageWritable = true;
                    }
                } catch (e) {
                    reportStorageWritable = false;
                }
            }

            const defaultLeaseSeconds = Number(process.env.TRACK_A_DEFAULT_LEASE_SECONDS || deps.trackADefaultLeaseSeconds || 600);
            const leaseSecondsValid = defaultLeaseSeconds === 600;

            const attachmentViewerAvailable = true;

            const readiness = {
                modeValid,
                trackAUrlConfigured,
                privateKeyReadableAndParseable,
                workerIdConfigured,
                serviceAuthConfigured,
                leaseSecondsValid,
                trackACapabilityReachable,
                reportStorageWritable,
                attachmentViewerAvailable
            };

            const overallReady = Object.values(readiness).every(Boolean);

            // Live preview readiness status
            const hasLivePreviewUrl = Boolean(
                trackAUrlConfigured &&
                (deps.trackABaseUrl || process.env.TRACK_A_BASE_URL) &&
                !String(deps.trackABaseUrl || process.env.TRACK_A_BASE_URL).includes('localhost')
            );
            const liveIntegrationStatus = hasLivePreviewUrl && trackACapabilityReachable
                ? '실연동 준비완료'
                : '실연동 대기';

            res.json({
                readiness,
                overallReady,
                liveIntegrationStatus,
                mode
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/readiness error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 2. POST /api/surveys/import - Start manual import as a background job.
    // Returns 202 immediately with a jobId; the drain loop runs detached.
    // Clients poll GET /api/surveys/sync-status (manualJob) for completion.
    // This avoids the client-side 30s fetch timeout aborting long imports.
    router.post('/import', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            const batchSize = Number(req.body?.batchSize) || Number(req.body?.limit) || 10;
            const maxItems = Number(req.body?.maxItems) || 200;

            const jobId = surveyImportService.startManualImportAsync({
                actorId,
                batchSize,
                maxItems
            });

            res.status(202).json({
                success: true,
                jobId,
                message: '온라인 설문 동기화를 백그라운드에서 시작했습니다.'
            });
        } catch (err) {
            const statusCode = (err.code === 'IMPORT_ALREADY_IN_PROGRESS' || err.code === 'IMPORT_ALREADY_RUNNING') ? 409 : 500;
            res.status(statusCode).json({
                success: false,
                error: {
                    code: err.code || 'IMPORT_FAILED',
                    message: err.message
                }
            });
        }
    });

    // 2-1. GET /api/surveys/sync-status - Query server-side automatic synchronization state.
    // Also carries the current manual import job (manualJob) for 202+polling clients.
    router.get('/sync-status', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const scheduler = autoImportScheduler || null;
            const status = scheduler && typeof scheduler.getStatus === 'function'
                ? scheduler.getStatus()
                : {
                    autoSyncEnabled: false,
                    intervalMinutes: 5,
                    batchSize: 10,
                    maxItems: 100,
                    isRunning: surveyImportService.isImportRunning,
                    lastSyncAt: null,
                    lastResult: null,
                    nextScheduledAt: null,
                    lastImportedCount: 0,
                    lastFailedCount: 0
                };

            const job = surveyImportService.manualImportJob || null;

            res.json({
                success: true,
                ...status,
                manualJob: job ? {
                    status: job.status,
                    jobId: job.jobId,
                    isRunning: job.status === 'running',
                    startedAt: job.startedAt,
                    completedAt: job.completedAt,
                    summary: job.summary,
                    error: job.error
                } : null
            });
        } catch (err) {
            res.status(500).json({ error: { code: 'SYNC_STATUS_ERROR', message: err.message } });
        }
    });

    // 3. GET /api/surveys/imports - Paginated import ledger list with masked names/phones & date/status filters
    router.get('/imports', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || req.auth?.userId || 'unknown',
                    action: 'ONLINE_SURVEY_LIST_VIEWED',
                    result: 'SUCCESS'
                });
            }

            const {
                fromDate,
                toDate,
                sortBy = 'latest',
                statusFilter,
                staffFilter,
                q: searchQuery,
                campaignFilter
            } = req.query;

            // Validate campaign filter (Calibration 4)
            const campaignFilterResult = validateAndNormalizeCampaignFilter(campaignFilter);
            if (!campaignFilterResult.valid) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CAMPAIGN_FILTER',
                        message: '유효하지 않은 캠페인 코드 필터 형식입니다.'
                    }
                });
            }

            // Validate date range boundaries
            let dateBoundaries = null;
            if (fromDate || toDate) {
                try {
                    dateBoundaries = getKstDateRangeUtcBoundaries(fromDate, toDate);
                } catch (dateErr) {
                    return res.status(400).json({
                        error: {
                            code: dateErr.code || 'INVALID_DATE_RANGE',
                            message: dateErr.message
                        }
                    });
                }
            }

            const ledger = surveyRepository.getImportsLedger();
            const submissions = surveyRepository.getSurveySubmissions();
            const subMap = new Map(submissions.map(s => [s.submissionId, s]));
            const referrals = surveyRepository.getData('Referrals', []);
            const refMap = new Map(referrals.filter(r => r.sourceSubmissionId).map(r => [r.sourceSubmissionId, r]));
            const campaigns = typeof surveyRepository.getCampaigns === 'function' ? surveyRepository.getCampaigns() : [];
            const campaignMap = new Map(campaigns.map(c => [c.code.toUpperCase(), c]));

            const currentUserId = String(req.auth?.id || req.auth?.userId || '');

            // Base list from ledger
            let baseList = [...ledger];

            // Visibility is governed by requireSurveyImportPermission (hasOnlineSurveyAccess) — no assignment-based isolation.

            // 2. Canonical Date Range Filter
            // 접수일시 기준일 = 실제 검사 완료 시각(screeningCompletedAt) 우선, 없으면 동기화(import) 시각으로 폴백.
            // 목록·상세에 표시되는 접수일시와 동일한 기준을 써야 날짜 필터 결과가 화면과 일치한다.
            // DATE_FILTER_CANONICAL_FIELD: screeningCompletedAt
            // DATE_FILTER_FALLBACK_FIELD: importedAt || receivedAt
            if (dateBoundaries && (dateBoundaries.startUtcMs !== null || dateBoundaries.endUtcMs !== null)) {
                baseList = baseList.filter(item => {
                    const sub = subMap.get(item.submissionId);
                    const canonicalDateStr = sub?.screeningCompletedAt || item.screeningCompletedAt || item.importedAt || sub?.importedAt || item.receivedAt || item.submittedAt || sub?.submittedAt;
                    if (!canonicalDateStr) return false;
                    const timeMs = new Date(canonicalDateStr).getTime();
                    if (isNaN(timeMs)) return false; // fail-closed for invalid date strings

                    if (dateBoundaries.startUtcMs !== null && timeMs < dateBoundaries.startUtcMs) {
                        return false;
                    }
                    if (dateBoundaries.endUtcMs !== null && timeMs > dateBoundaries.endUtcMs) {
                        return false;
                    }
                    return true;
                });
            }

            // Map each item to safe client representation (excluding soft-deleted or deleted submissions)
            let safeList = baseList
                .filter(item => {
                    const sub = subMap.get(item.submissionId);
                    return !(sub?.deletionStatus === 'deleted' || sub?.status === 'deleted');
                })
                .map(item => {
                const sub = subMap.get(item.submissionId);
                const ref = refMap.get(item.submissionId);
                const reportAttachment = ref?.attachments?.find(a =>
                    a.type === 'application/pdf' || (a.url && a.url.startsWith('/attachments'))
                ) || sub?.attachment || null;

                const requestType = sub?.requestType || item.requestType || (sub?.consultationRequested ? 'CONSULTATION_REQUEST' : 'SCREENING_ONLY');
                const consultationRequested = sub?.consultationRequested !== undefined
                    ? Boolean(sub.consultationRequested)
                    : (item.consultationRequested !== undefined ? Boolean(item.consultationRequested) : requestType === 'CONSULTATION_REQUEST');
                const isScreeningOnly = requestType === 'SCREENING_ONLY';

                const rawCampaignCode = sub?.campaignCode || null;
                let campaignRegistrationStatus = 'ABSENT';
                let campaignName = null;
                let campaignPurpose = null;

                if (rawCampaignCode) {
                    const matchedCampaign = campaignMap.get(rawCampaignCode.toUpperCase());
                    if (matchedCampaign) {
                        campaignRegistrationStatus = 'REGISTERED';
                        campaignName = matchedCampaign.companyName || null;
                        campaignPurpose = matchedCampaign.purpose || null;
                    } else {
                        campaignRegistrationStatus = 'UNREGISTERED';
                    }
                }

                return {
                    internalImportId: item.internalImportId,
                    submissionId: item.submissionId,
                    internalSurveyId: sub?.internalSurveyId || null,
                    schemaVersion: item.schemaVersion,
                    keyVersion: item.keyVersion,
                    externalStatus: item.externalStatus,
                    internalStatus: item.internalStatus,
                    importedAt: item.importedAt,
                    acknowledgedAt: item.acknowledgedAt,
                    externalDeletedAt: item.externalDeletedAt,
                    lastErrorCode: item.lastErrorCode,
                    assessmentId: sub?.assessmentId || 'unknown',
                    isSbqrQuarantined: sub?.isSbqrQuarantined || false,
                    // Campaign fields (Contract §I.4 & Calibration 4)
                    campaignCode: rawCampaignCode,
                    campaignName,
                    campaignPurpose,
                    campaignRegistrationStatus,
                    // Data Contract Fields
                    requestType,
                    consultationRequested,
                    consultationRequestedAt: sub?.consultationRequestedAt || item.consultationRequestedAt || null,
                    screeningCompletedAt: sub?.screeningCompletedAt || item.screeningCompletedAt || sub?.importedAt || item.importedAt,
                    processingStatus: sub?.processingStatus || item.processingStatus || (isScreeningOnly ? 'SCREENING_COMPLETED' : 'PENDING_STAFF_REVIEW'),
                    assignmentStatus: sub?.assignmentStatus || item.assignmentStatus || (isScreeningOnly ? 'not_required' : 'unassigned'),
                    isSynthetic: Boolean(item.submissionId.startsWith('sub-demo-') || sub?.isSynthetic || item.isSynthetic),
                    // Masked identity fields for list view
                    maskedClientName: maskName(sub?.contact?.clientName),
                    maskedPhone: maskPhone(sub?.contact?.phone),
                    region: sub?.contact?.region || '-',
                    totalScore: sub?.assessment?.totalScore ?? null,
                    meanScore: sub?.assessment?.meanScore ?? null,
                    severity: sub?.assessment?.severity ?? null,
                    consultationStatus: sub?.consultationStatus || (isScreeningOnly ? '검사완료' : '신규접수대기'),
                    counselingRequestText: sub?.contact?.counselingRequestText || '',
                    // 접수일시 = 시민의 실제 검사 완료 시각. contact.submittedAt는 실데이터에 없어
                    // importedAt(동기화 시각)으로 떨어지던 버그 → screeningCompletedAt 우선으로 교체.
                    submittedAt: sub?.screeningCompletedAt || sub?.importedAt || item.importedAt,
                    contactOnly: sub?.contactOnly || false,
                    // Linked referral info
                    referralId: ref?.referralId || null,
                    refNo: ref?.refNo || null,
                    referralStatus: ref?.referralStatus || null,
                    closureStatus: ref?.closureStatus || null,
                    hasReport: Boolean(reportAttachment || sub?.attachmentId),
                    reportAttachment,
                    // Assignment & Retention fields
                    assignedUserId: sub?.assignedUserId || (ref ? ref.assignee : null),
                    assignedDepartmentId: sub?.assignedDepartmentId || (ref ? ref.team : null),
                    assignmentPriority: sub?.assignmentPriority || SURVEY_ASSIGNMENT_PRIORITY.NORMAL,
                    assignedAt: sub?.assignedAt || null,
                    reassignedAt: sub?.reassignedAt || null,
                    completedAt: sub?.completedAt || null,
                    assignmentNote: sub?.assignmentNote || '',
                    retentionUntil: sub?.retentionUntil || null,
                    retentionDays: sub?.retentionDays || 30,
                    version: sub?.version || 1
                };
            });

            // 3. Status Filter
            if (statusFilter && statusFilter !== 'all') {
                safeList = safeList.filter(item => {
                    if (statusFilter === 'unassigned') {
                        return (!item.assignedUserId || item.assignmentStatus === 'unassigned') && !item.referralId;
                    }
                    if (statusFilter === 'my_assigned') {
                        return String(item.assignedUserId) === currentUserId && !item.referralId;
                    }
                    if (statusFilter === 'pending_referral') {
                        return Boolean(item.assignedUserId) && !item.referralId;
                    }
                    if (statusFilter === 'registered') {
                        return Boolean(item.referralId);
                    }
                    if (statusFilter === 'expiring_soon') {
                        if (!item.retentionUntil) return false;
                        const expMs = new Date(item.retentionUntil).getTime();
                        if (isNaN(expMs)) return false;
                        const diffDays = (expMs - Date.now()) / (24 * 60 * 60 * 1000);
                        return diffDays >= 0 && diffDays <= 7;
                    }
                    if (statusFilter === 'high_risk') {
                        const sev = String(item.severity || '').toLowerCase();
                        return sev.includes('고위험') || sev.includes('심각') || (item.totalScore !== null && item.totalScore >= 15);
                    }
                    return true;
                });
            }

            // 4. Staff Filter (Admin only)
            if (staffFilter && staffFilter !== 'all') {
                if (staffFilter === 'unassigned') {
                    safeList = safeList.filter(item => !item.assignedUserId || item.assignmentStatus === 'unassigned');
                } else {
                    safeList = safeList.filter(item => String(item.assignedUserId) === String(staffFilter));
                }
            }

            // 4.5. Campaign Filter (Calibration 4)
            if (campaignFilterResult.type === 'UNSPECIFIED') {
                safeList = safeList.filter(item => !item.campaignCode);
            } else if (campaignFilterResult.type === 'CODE') {
                safeList = safeList.filter(item => item.campaignCode && item.campaignCode.toUpperCase() === campaignFilterResult.code);
            }

            // 5. Search Query Filter
            if (searchQuery && typeof searchQuery === 'string' && searchQuery.trim()) {
                const q = searchQuery.trim().toLowerCase();
                safeList = safeList.filter(item =>
                    (item.submissionId && item.submissionId.toLowerCase().includes(q)) ||
                    (item.maskedClientName && item.maskedClientName.toLowerCase().includes(q)) ||
                    (item.maskedPhone && item.maskedPhone.toLowerCase().includes(q)) ||
                    (item.region && item.region.toLowerCase().includes(q)) ||
                    (item.assessmentId && item.assessmentId.toLowerCase().includes(q)) ||
                    (item.counselingRequestText && item.counselingRequestText.toLowerCase().includes(q)) ||
                    (item.refNo && item.refNo.toLowerCase().includes(q)) ||
                    (item.campaignCode && item.campaignCode.toLowerCase().includes(q)) ||
                    (item.campaignName && item.campaignName.toLowerCase().includes(q))
                );
            }

            // 6. Sorting (접수일시 정렬은 표시와 동일하게 실제 검사 완료 시각 기준)
            safeList.sort((a, b) => {
                if (sortBy === 'oldest') {
                    const timeA = new Date(a.screeningCompletedAt || a.submittedAt || a.importedAt || 0).getTime();
                    const timeB = new Date(b.screeningCompletedAt || b.submittedAt || b.importedAt || 0).getTime();
                    return timeA - timeB;
                }
                if (sortBy === 'assignment_oldest') {
                    const timeA = a.assignedAt ? new Date(a.assignedAt).getTime() : Infinity;
                    const timeB = b.assignedAt ? new Date(b.assignedAt).getTime() : Infinity;
                    return timeA - timeB;
                }
                if (sortBy === 'expiring_soon') {
                    const timeA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                    const timeB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                    return timeA - timeB;
                }
                if (sortBy === 'risk_high') {
                    const scoreA = Number(a.totalScore) || 0;
                    const scoreB = Number(b.totalScore) || 0;
                    return scoreB - scoreA;
                }
                // Default 'latest': newest exam (screening) date first
                const timeA = new Date(a.screeningCompletedAt || a.submittedAt || a.importedAt || 0).getTime();
                const timeB = new Date(b.screeningCompletedAt || b.submittedAt || b.importedAt || 0).getTime();
                return timeB - timeA;
            });

            res.json({
                total: safeList.length,
                imports: safeList
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/imports error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 4. GET /api/surveys/assignable-staff - List of active assignable staff with survey permission & workload
    router.get('/assignable-staff', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const users = getUsers() || [];
            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            const isAdmin = role === 'admin';
            const currentUserId = String(req.auth?.id || req.auth?.userId || '');

            const subs = surveyRepository.getSurveySubmissions();
            // Workload definition: assignedUserId === staff.id AND !referralId AND not deleted/cancelled
            const workloadMap = new Map();
            for (const s of subs) {
                if (!s || s.status === 'deleted' || s.deletionStatus === 'deleted') continue;
                if (!s.referralId && s.assignedUserId) {
                    const uid = String(s.assignedUserId);
                    workloadMap.set(uid, (workloadMap.get(uid) || 0) + 1);
                }
            }

            const safeStaff = users
                .filter(u => u && u.status === 'active' && hasOnlineSurveyAccess(u))
                .map(u => {
                    const staffId = String(u.id || u.username || '');
                    const pendingAssignmentCount = workloadMap.get(staffId) || 0;
                    const staffObj = {
                        id: staffId,
                        name: u.name || u.username || '직원',
                        team: u.team || u.department || '',
                        role: u.role || 'user'
                    };
                    // Admin gets workload info for all staff. Regular users ONLY get their own workload info.
                    if (isAdmin) {
                        staffObj.pendingAssignmentCount = pendingAssignmentCount;
                        staffObj.myAssignedPendingCount = pendingAssignmentCount;
                    } else if (staffId === currentUserId) {
                        staffObj.pendingAssignmentCount = pendingAssignmentCount;
                        staffObj.myAssignedPendingCount = pendingAssignmentCount;
                    }
                    return staffObj;
                });
            res.json({ staff: safeStaff });
        } catch (err) {
            console.error('❌ GET /api/surveys/assignable-staff error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 5. GET /api/surveys/export - Permission-controlled XLSX export
    router.get('/export', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            if (!surveyExportService) {
                return res.status(500).json({ error: { code: 'SERVICE_UNAVAILABLE', message: '엑셀 내보내기 서비스가 준비되지 않았습니다.' } });
            }

            const role = (req.auth.role || 'user').toLowerCase();
            const hasIdentifiablePerm = role === 'admin' || !!(
                req.auth.permissions && (
                    req.auth.permissions.SURVEY_EXPORT_IDENTIFIABLE ||
                    req.auth.permissions.surveyExportIdentifiable
                )
            );

            // Fetch submissions (excluding deleted and soft-deleted)
            let records = surveyRepository.getSurveySubmissions().filter(r => r && r.status !== 'deleted' && r.deletionStatus !== 'deleted');

            // Filter criteria
            const { assessmentId, assignedUserId, assignmentPriority, consultationStatus, startDate, endDate, campaignCode } = req.query;

            // Validate campaign code filter (Calibration 4)
            const campaignFilterResult = validateAndNormalizeCampaignFilter(campaignCode);
            if (!campaignFilterResult.valid) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CAMPAIGN_FILTER',
                        message: '유효하지 않은 캠페인 코드 필터 형식입니다.'
                    }
                });
            }

            if (assessmentId && assessmentId !== 'all') {
                records = records.filter(r => r.assessmentId === assessmentId);
            }
            if (assignedUserId && assignedUserId !== 'all') {
                records = records.filter(r => r.assignedUserId === assignedUserId);
            }
            if (assignmentPriority && assignmentPriority !== 'all') {
                records = records.filter(r => r.assignmentPriority === assignmentPriority);
            }
            if (consultationStatus && consultationStatus !== 'all') {
                records = records.filter(r => r.consultationStatus === consultationStatus);
            }
            // 기간 필터 기준일 = 실제 검사 완료 시각(screeningCompletedAt) 우선 — 목록 필터(DATE_FILTER_CANONICAL_FIELD)와 동일 기준.
            // 임포트 시각으로 거르면 동기화가 늦은 과거 검사 건이 현재 기간으로 잘못 포함된다.
            const recordDateOf = (r) => r.screeningCompletedAt || r.submittedAt || r.importedAt || r.createdAt || '';
            if (startDate) {
                records = records.filter(r => recordDateOf(r) >= startDate);
            }
            if (endDate) {
                const endDateTime = endDate.length === 10 ? `${endDate}T23:59:59.999Z` : endDate;
                records = records.filter(r => recordDateOf(r) <= endDateTime);
            }
            if (campaignFilterResult.type === 'UNSPECIFIED') {
                records = records.filter(r => !r.campaignCode);
            } else if (campaignFilterResult.type === 'CODE') {
                records = records.filter(r => r.campaignCode && r.campaignCode.toUpperCase() === campaignFilterResult.code);
            }

            const { buffer, filename, rowCount } = surveyExportService.generateExcelBuffer(records, {
                isIdentifiable: hasIdentifiablePerm
            });

            // Emit Audit Log
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: actorId,
                    targetUserId: 'BATCH_EXPORT',
                    action: 'ONLINE_SURVEY_EXCEL_DOWNLOADED',
                    result: 'SUCCESS'
                });
            }
            await surveyRepository.recordAuditEvent({
                actorId,
                action: 'SURVEY_EXPORT_SUCCEEDED',
                submissionId: 'BATCH_EXPORT',
                result: 'EXPORTED',
                details: {
                    rowCount,
                    isIdentifiable: hasIdentifiablePerm,
                    filters: req.query
                }
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.send(buffer);
        } catch (err) {
            console.error('❌ GET /api/surveys/export error:', err.message);
            res.status(500).json({ error: { code: 'EXPORT_FAILED', message: err.message } });
        }
    });

    // ──────────────────────────────────────────────────────────
    // 5.5. Campaign Management Endpoints (Contract §I.4 & Calibrations 2, 3, 4)
    // ──────────────────────────────────────────────────────────

    // GET /api/surveys/campaigns - List campaigns with official 4-count aggregation (Calibration 3)
    router.get('/campaigns', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const campaigns = typeof surveyRepository.getCampaigns === 'function' ? surveyRepository.getCampaigns() : [];
            const submissions = typeof surveyRepository.getSurveySubmissions === 'function' ? surveyRepository.getSurveySubmissions() : [];
            const referrals = typeof surveyRepository.getData === 'function' ? surveyRepository.getData('Referrals', []) : [];

            const refMap = new Map(
                referrals
                    .filter(r => r && r.sourceSubmissionId)
                    .map(r => [r.sourceSubmissionId, r])
            );

            // Calibration 3: Explicit Allowlist (Broad conditions like !== COMPLETED are prohibited)
            // 1. Pending review allowlist: PENDING_STAFF_REVIEW, STAFF_ASSIGNED (if not yet converted to official referral)
            const PENDING_REVIEW_STATUSES = new Set([
                'PENDING_STAFF_REVIEW',
                'STAFF_ASSIGNED'
            ]);

            // 2. Completed allowlist: COMPLETED, or SCREENING_COMPLETED (screening-only submission where testing is done)
            const COMPLETED_STATUSES = new Set([
                'COMPLETED',
                'SCREENING_COMPLETED'
            ]);

            const createCounter = () => ({
                receivedCount: 0,
                pendingReviewCount: 0,
                registeredReferralCount: 0,
                completedCount: 0
            });

            const campaignCountsMap = new Map();
            const unspecifiedCounts = createCounter();
            const totalCounts = createCounter();

            for (const sub of submissions) {
                if (!sub || sub.deletionStatus === 'deleted' || sub.status === 'deleted') continue;

                const code = (sub.campaignCode && typeof sub.campaignCode === 'string')
                    ? sub.campaignCode.trim().toUpperCase()
                    : null;

                const hasReferral = Boolean(sub.referralId || refMap.has(sub.submissionId));
                const ref = refMap.get(sub.submissionId);

                const isPending = !hasReferral && PENDING_REVIEW_STATUSES.has(sub.processingStatus);
                const isCompleted = COMPLETED_STATUSES.has(sub.processingStatus) ||
                    (hasReferral && ref && (ref.closureStatus || ref.status === 'closed' || ref.referralStatus === 'COMPLETED'));

                const inc = (c) => {
                    c.receivedCount++;
                    if (isPending) c.pendingReviewCount++;
                    if (hasReferral) c.registeredReferralCount++;
                    if (isCompleted) c.completedCount++;
                };

                inc(totalCounts);

                if (code) {
                    if (!campaignCountsMap.has(code)) {
                        campaignCountsMap.set(code, createCounter());
                    }
                    inc(campaignCountsMap.get(code));
                } else {
                    inc(unspecifiedCounts);
                }
            }

            const enrichedCampaigns = campaigns.map(camp => {
                const canonicalCode = camp.code.trim().toUpperCase();
                const cnt = campaignCountsMap.get(canonicalCode) || createCounter();
                return {
                    ...camp,
                    isRegistered: true,
                    campaignRegistrationStatus: 'REGISTERED',
                    receivedCount: cnt.receivedCount,
                    pendingReviewCount: cnt.pendingReviewCount,
                    registeredReferralCount: cnt.registeredReferralCount,
                    completedCount: cnt.completedCount,
                    counts: {
                        receivedCount: cnt.receivedCount,
                        pendingReviewCount: cnt.pendingReviewCount,
                        registeredReferralCount: cnt.registeredReferralCount,
                        completedCount: cnt.completedCount
                    }
                };
            });

            const registeredCodeSet = new Set(campaigns.map(c => c.code.trim().toUpperCase()));
            const unregisteredCampaignEntries = [];
            for (const [code, cnt] of campaignCountsMap.entries()) {
                if (!registeredCodeSet.has(code)) {
                    unregisteredCampaignEntries.push({
                        code,
                        companyName: '(미등록 캠페인)',
                        purpose: null,
                        startsAt: null,
                        endsAt: null,
                        isActive: true,
                        isRegistered: false,
                        campaignRegistrationStatus: 'UNREGISTERED',
                        receivedCount: cnt.receivedCount,
                        pendingReviewCount: cnt.pendingReviewCount,
                        registeredReferralCount: cnt.registeredReferralCount,
                        completedCount: cnt.completedCount,
                        counts: {
                            receivedCount: cnt.receivedCount,
                            pendingReviewCount: cnt.pendingReviewCount,
                            registeredReferralCount: cnt.registeredReferralCount,
                            completedCount: cnt.completedCount
                        }
                    });
                }
            }
            const finalCampaignList = [...enrichedCampaigns, ...unregisteredCampaignEntries];

            return res.json({
                total: finalCampaignList.length,
                campaigns: finalCampaignList,
                unspecifiedCounts,
                totalCounts
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/campaigns error:', err.message);
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // POST /api/surveys/campaigns - Create a new campaign with strict validation & mutex protection
    router.post('/campaigns', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { code, companyName, purpose, startsAt, endsAt } = req.body || {};
            const actorId = req.auth?.id || req.auth?.userId || req.auth?.username || 'admin';

            if (!code || typeof code !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_CAMPAIGN_CODE', message: '캠페인 코드가 필요합니다.' }
                });
            }

            const canonicalCode = code.trim().toUpperCase();
            if (!CAMPAIGN_CODE_PATTERN.test(canonicalCode)) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CAMPAIGN_CODE',
                        message: '캠페인 코드 형식이 올바르지 않습니다 (2~32자, 영문 대문자/숫자로 시작, 영문대문자·숫자·하이픈만 허용).'
                    }
                });
            }

            if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
                return res.status(400).json({
                    error: { code: 'INVALID_REQUEST', message: '회사/기관명은 필수 입력 항목입니다.' }
                });
            }

            if (!purpose || typeof purpose !== 'string' || !purpose.trim()) {
                return res.status(400).json({
                    error: { code: 'INVALID_REQUEST', message: '캠페인 목적은 필수 입력 항목입니다.' }
                });
            }

            if (startsAt && isNaN(Date.parse(startsAt))) {
                return res.status(400).json({
                    error: { code: 'INVALID_DATE', message: '시작 일시 형식이 올바르지 않습니다.' }
                });
            }

            if (endsAt && isNaN(Date.parse(endsAt))) {
                return res.status(400).json({
                    error: { code: 'INVALID_DATE', message: '종료 일시 형식이 올바르지 않습니다.' }
                });
            }

            const created = await surveyRepository.createCampaign({
                code: canonicalCode,
                companyName: companyName.trim(),
                purpose: purpose.trim(),
                startsAt: startsAt || null,
                endsAt: endsAt || null,
                actorId
            });

            return res.status(201).json({
                success: true,
                campaign: created
            });
        } catch (err) {
            if (err.status === 409 || err.code === 'CONCURRENCY_CONFLICT') {
                return res.status(409).json({
                    error: { code: 'CONCURRENCY_CONFLICT', message: err.message }
                });
            }
            if (err.status === 400 || err.code === 'INVALID_CAMPAIGN_CODE') {
                return res.status(400).json({
                    error: { code: err.code || 'INVALID_REQUEST', message: err.message }
                });
            }
            console.error('❌ POST /api/surveys/campaigns error:', err.message);
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // PATCH /api/surveys/campaigns/:code - Update campaign details (code is immutable)
    router.patch('/campaigns/:code', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { code } = req.params;
            const actorId = req.auth?.id || req.auth?.userId || req.auth?.username || 'admin';
            const updates = req.body || {};

            if (!code || typeof code !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_CAMPAIGN_CODE', message: '캠페인 코드가 필요합니다.' }
                });
            }

            // Reject any code modification attempt (Code is strictly immutable)
            if (updates.code !== undefined && updates.code !== null) {
                const requestedCode = String(updates.code).trim().toUpperCase();
                if (requestedCode !== code.trim().toUpperCase()) {
                    return res.status(400).json({
                        error: {
                            code: 'CAMPAIGN_CODE_IMMUTABLE',
                            message: '캠페인 코드는 수정할 수 없습니다 (코드 불변).'
                        }
                    });
                }
            }

            const updated = await surveyRepository.updateCampaign(code, updates, actorId);

            return res.json({
                success: true,
                campaign: updated
            });
        } catch (err) {
            if (err.status === 404 || err.code === 'RECORD_NOT_FOUND') {
                return res.status(404).json({
                    error: { code: 'RECORD_NOT_FOUND', message: err.message }
                });
            }
            if (err.status === 409 || err.code === 'CONCURRENCY_CONFLICT') {
                return res.status(409).json({
                    error: { code: 'CONCURRENCY_CONFLICT', message: err.message }
                });
            }
            if (err.status === 400 || err.code === 'CAMPAIGN_CODE_IMMUTABLE' || err.code === 'INVALID_CAMPAIGN_CODE') {
                return res.status(400).json({
                    error: { code: err.code || 'INVALID_REQUEST', message: err.message }
                });
            }
            console.error('❌ PATCH /api/surveys/campaigns/:code error:', err.message);
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 5-2. POST /api/surveys/bulk-campaign - Assign/change campaign for multiple submissions (Admin only)
    //      campaignCode: registered campaign code string, or null to clear back to unspecified (일반접수)
    router.post('/bulk-campaign', requireAuth, requireSurveyImportPermission, requireAdmin, async (req, res) => {
        try {
            const { submissionIds, campaignCode } = req.body || {};
            const actorId = req.auth?.id || req.auth?.userId || req.auth?.username || 'admin';

            if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '캠페인을 지정할 설문 목록(submissionIds)이 비어있습니다.' }
                });
            }

            if (submissionIds.length > 50) {
                return res.status(400).json({
                    error: { code: 'BULK_CAMPAIGN_LIMIT_EXCEEDED', message: '캠페인 일괄 지정은 한 번에 최대 50건까지만 가능합니다.' }
                });
            }

            if (!submissionIds.every(id => typeof id === 'string' && id.trim())) {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '설문 ID(submissionIds)는 문자열 배열이어야 합니다.' }
                });
            }

            let canonicalCode = null;
            if (campaignCode !== null && campaignCode !== undefined && campaignCode !== '') {
                if (typeof campaignCode !== 'string') {
                    return res.status(400).json({
                        error: { code: 'INVALID_CAMPAIGN_CODE', message: '캠페인 코드 형식이 올바르지 않습니다.' }
                    });
                }
                canonicalCode = campaignCode.trim().toUpperCase();
                if (!CAMPAIGN_CODE_PATTERN.test(canonicalCode)) {
                    return res.status(400).json({
                        error: {
                            code: 'INVALID_CAMPAIGN_CODE',
                            message: '캠페인 코드 형식이 올바르지 않습니다 (2~32자, 영문 대문자/숫자로 시작, 영문대문자·숫자·하이픈만 허용).'
                        }
                    });
                }
            }

            const result = await surveyRepository.updateSubmissionsCampaign({
                ids: [...new Set(submissionIds)],
                campaignCode: canonicalCode,
                actorId
            });

            return res.json({ success: true, ...result });
        } catch (err) {
            if (err.status === 404 || err.code === 'CAMPAIGN_NOT_FOUND' || err.code === 'RECORD_NOT_FOUND') {
                return res.status(404).json({
                    error: { code: err.code || 'CAMPAIGN_NOT_FOUND', message: err.message }
                });
            }
            if (err.status === 400 || err.code === 'INVALID_PARAM') {
                return res.status(400).json({
                    error: { code: err.code || 'INVALID_PARAM', message: err.message }
                });
            }
            console.error('❌ POST /api/surveys/bulk-campaign error:', err.message);
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 5-3. POST /api/surveys/bulk-delete - Simplified bulk deletion with server-enforced final confirmation (Admin only)
    //      Two-step confirmation: the client must send confirmText === '삭제' (typed in the 2nd confirm dialog).
    //      Referral-converted submissions are always excluded and reported as skipped.
    router.post('/bulk-delete', requireAuth, requireSurveyImportPermission, requireAdmin, async (req, res) => {
        try {
            const { submissionIds, confirmText, reason } = req.body || {};
            const actorId = req.auth?.id || req.auth?.userId || req.auth?.username || 'admin';

            if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '삭제할 설문 목록(submissionIds)이 비어있습니다.' }
                });
            }

            if (submissionIds.length > 50) {
                return res.status(400).json({
                    error: { code: 'BULK_DELETE_LIMIT_EXCEEDED', message: '일괄 삭제는 한 번에 최대 50건까지만 가능합니다.' }
                });
            }

            if (!submissionIds.every(id => typeof id === 'string' && id.trim())) {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '설문 ID(submissionIds)는 문자열 배열이어야 합니다.' }
                });
            }

            // Final (2nd-step) confirmation is enforced on the server as well
            if (confirmText !== '삭제') {
                return res.status(400).json({
                    error: { code: 'CONFIRMATION_REQUIRED', message: '최종 확인 문구(삭제)가 입력되지 않았습니다.' }
                });
            }

            if (reason !== undefined && reason !== null) {
                if (typeof reason !== 'string' || reason.length > 200) {
                    return res.status(400).json({
                        error: { code: 'INVALID_PARAM', message: '삭제 사유는 200자 이하의 문자열이어야 합니다.' }
                    });
                }
            }

            if (surveyImportService.getStatusSummary().isImportRunning) {
                return res.status(409).json({
                    error: { code: 'PROCESSING_IN_PROGRESS', message: '설문 가져오기 작업 진행 중에는 삭제할 수 없습니다.' }
                });
            }

            const result = await surveyRepository.bulkDeleteSubmissions({
                submissionIds: [...new Set(submissionIds)],
                actorId,
                reason: typeof reason === 'string' ? reason : ''
            });

            return res.json({ success: true, ...result });
        } catch (err) {
            console.error('❌ POST /api/surveys/bulk-delete error:', err.message);
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 6. POST /api/surveys/:id/assign and /api/surveys/:id/reassign (Admin only)
    const handleAssignment = async (req, res) => {
        try {
            const { id } = req.params;
            const { assignedUserId, assignedDepartmentId, assignmentPriority, expectedVersion, reason } = req.body || {};

            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            if (role !== 'admin' && !hasSurveyAssignmentAccess(req.auth)) {
                return res.status(403).json({
                    error: { code: 'FORBIDDEN', message: '관리자(Admin) 또는 설문 담당자 배정 권한이 필요합니다.' }
                });
            }

            if (!assignedUserId || typeof assignedUserId !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '배정할 직원의 ID(assignedUserId)가 필요합니다.' }
                });
            }

            // Check if submission exists
            const existingSub = surveyRepository.findSubmissionById(id);
            if (!existingSub) {
                return res.status(404).json({
                    error: { code: SURVEY_ERROR_CODES.RECORD_NOT_FOUND, message: '해당 설문 제출 건을 찾을 수 없습니다.' }
                });
            }

            // If already converted to official referral, block reassignment via survey router
            if (existingSub.referralId) {
                return res.status(409).json({
                    error: { code: 'ALREADY_REGISTERED', message: '이미 의뢰대장이 등록된 설문은 재배정할 수 없습니다.' }
                });
            }

            // Target staff validation: Must be active and have ONLINE_SURVEY_ACCESS
            const users = getUsers() || [];
            const targetUser = users.find(u =>
                u && (String(u.id) === String(assignedUserId) || String(u.username) === String(assignedUserId))
            );

            if (!targetUser || targetUser.status !== 'active') {
                return res.status(400).json({
                    error: { code: 'USER_INACTIVE', message: '배정 대상 직원이 유효하지 않거나 비활성 상태입니다.' }
                });
            }

            if (!hasOnlineSurveyAccess(targetUser)) {
                return res.status(400).json({
                    error: { code: 'STAFF_NOT_ELIGIBLE', message: '온라인 설문 접근 권한이 없는 직원에게는 배정할 수 없습니다.' }
                });
            }

            const priority = Object.values(SURVEY_ASSIGNMENT_PRIORITY).includes(assignmentPriority)
                ? assignmentPriority
                : SURVEY_ASSIGNMENT_PRIORITY.NORMAL;

            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';

            // Assign in repository (Optimistic Concurrency check inside)
            const updated = await surveyRepository.assignStaff({
                submissionId: id,
                assignedUserId: String(targetUser.id || targetUser.username),
                assignedDepartmentId: assignedDepartmentId || targetUser.team || '',
                assignmentPriority: priority,
                actorId,
                reason: reason || '',
                expectedVersion: expectedVersion !== undefined && expectedVersion !== null ? Number(expectedVersion) : undefined
            });

            const isReassign = Boolean(updated.previousAssignedUserId);
            if (isReassign) {
                updated.reassignedAt = new Date().toISOString();
                const subs = surveyRepository.getSurveySubmissions();
                const sIdx = subs.findIndex(s => s && (s.submissionId === updated.submissionId || s.internalSurveyId === updated.submissionId));
                if (sIdx !== -1) {
                    subs[sIdx].reassignedAt = updated.reassignedAt;
                    await surveyRepository.saveSurveySubmissions(subs);
                }
            }

            // Append to assignment history
            if (surveyAssignmentRepository) {
                await surveyAssignmentRepository.recordAssignment({
                    submissionId: updated.submissionId,
                    internalSurveyId: updated.internalSurveyId,
                    previousAssignedUserId: updated.previousAssignedUserId || null,
                    assignedUserId: updated.assignedUserId,
                    assignedDepartmentId: updated.assignedDepartmentId || '',
                    previousPriority: updated.previousPriority || null,
                    priority: updated.assignmentPriority,
                    reason: reason || '',
                    actorUserId: actorId,
                    version: updated.version || 1
                });
            }

            // Synchronize with linked Referral draft if present
            let updatedReferral = null;
            if (referralService && typeof referralService.updateReferralAssignee === 'function') {
                try {
                    updatedReferral = await referralService.updateReferralAssignee({
                        submissionId: updated.submissionId,
                        internalSurveyId: updated.internalSurveyId,
                        assignedUserId: updated.assignedUserId,
                        assignedDepartmentId: updated.assignedDepartmentId,
                        actorId
                    });
                } catch (refSyncErr) {
                    console.error('Failed to sync assignment to referral draft:', refSyncErr.message);
                }
            }

            // Audit record for assignment/reassignment
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: actorId,
                    targetUserId: updated.assignedUserId,
                    internalSurveyId: updated.internalSurveyId,
                    action: isReassign ? 'ONLINE_SURVEY_REASSIGNED' : 'ONLINE_SURVEY_ASSIGNED',
                    result: 'SUCCESS'
                });
            }

            // Internal Notification Dispatch (Zero-PII Canonical Phase 14 Payload)
            if (notificationRepository) {
                const notifType = isReassign ? NOTIFICATION_TYPES.SURVEY_REASSIGNED : NOTIFICATION_TYPES.SURVEY_ASSIGNED;
                const safeTitle = isReassign ? '온라인 설문 담당자 재배정 알림' : '온라인 설문 담당자 배정 알림';
                const safeMsg = '온라인 설문 기반 상담신청 1건이 배정되었습니다.\n온라인 설문관리에서 확인해 주세요.';

                await notificationRepository.createNotification({
                    recipientUserId: updated.assignedUserId,
                    type: notifType,
                    relatedEntityType: 'survey',
                    relatedEntityId: updated.submissionId,
                    safeTitle,
                    safeMessage: safeMsg,
                    priority,
                    createdByUserId: actorId,
                    deduplicationKey: `survey_assign_${updated.submissionId}_v${updated.version || 1}`
                });
            }

            res.json({
                success: true,
                message: '담당 직원이 성공적으로 배정되었습니다.',
                submission: updated
            });
        } catch (err) {
            console.error('❌ POST /api/surveys/:id/assign error:', err.message);
            const statusCode = err.code === SURVEY_ERROR_CODES.CONCURRENCY_CONFLICT ? 409
                : err.code === SURVEY_ERROR_CODES.RECORD_NOT_FOUND ? 404
                : 500;
            res.status(statusCode).json({
                error: {
                    code: err.code || 'ASSIGN_FAILED',
                    message: err.message
                }
            });
        }
    };

    router.post('/:id/assign', requireAuth, requireSurveyImportPermission, handleAssignment);
    router.post('/:id/reassign', requireAuth, requireSurveyImportPermission, handleAssignment);

    // 6-2. POST /api/surveys/bulk-assign - Batch assign or reassign staff (Admin only)
    router.post('/bulk-assign', requireAuth, requireSurveyImportPermission, requireAdmin, async (req, res) => {
        try {
            const { submissionIds, targetUserId, mode = 'unassigned-only', note } = req.body || {};

            if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '배정할 설문 목록(submissionIds)이 비어있습니다.' }
                });
            }

            if (submissionIds.length > 50) {
                return res.status(400).json({
                    error: { code: 'BULK_ASSIGNMENT_LIMIT_EXCEEDED', message: '일괄 배정은 한 번에 최대 50건까지만 가능합니다.' }
                });
            }

            if (!['unassigned-only', 'include-reassignment'].includes(mode)) {
                return res.status(400).json({
                    error: { code: 'INVALID_MODE', message: '유효하지 않은 배정 모드입니다. unassigned-only 또는 include-reassignment를 지정하세요.' }
                });
            }

            if (!targetUserId || typeof targetUserId !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '배정 대상 직원 ID(targetUserId)가 필요합니다.' }
                });
            }

            const users = getUsers() || [];
            const targetUser = users.find(u =>
                u && (String(u.id) === String(targetUserId) || String(u.username) === String(targetUserId))
            );

            if (!targetUser || targetUser.status !== 'active') {
                return res.status(400).json({
                    error: { code: 'USER_INACTIVE', message: '배정 대상 직원이 유효하지 않거나 비활성 상태입니다.' }
                });
            }

            if (!hasOnlineSurveyAccess(targetUser)) {
                return res.status(400).json({
                    error: { code: 'STAFF_NOT_ELIGIBLE', message: '온라인 설문 접근 권한이 없는 직원에게는 배정할 수 없습니다.' }
                });
            }

            if (note !== undefined && note !== null) {
                if (typeof note !== 'string' || note.length > 200) {
                    return res.status(400).json({
                        error: { code: 'INVALID_NOTE', message: '배정 메모는 200자 이하의 문자열이어야 합니다.' }
                    });
                }
            }

            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            const bulkRequestId = `blk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

            const result = await surveyRepository.bulkAssignStaff({
                submissionIds,
                targetUserId: String(targetUser.id || targetUser.username),
                targetDepartmentId: targetUser.team || targetUser.department || '',
                mode,
                note: note || null,
                actorId,
                bulkRequestId
            });

            // Reused Internal Notification Dispatch (Zero-PII)
            const successfulCount = (result.assigned || 0) + (result.reassigned || 0);
            if (successfulCount > 0 && notificationRepository) {
                try {
                    const isOnlyReassign = (result.assigned || 0) === 0 && (result.reassigned || 0) > 0;
                    const safeTitle = isOnlyReassign ? '온라인 설문 담당자 재배정 알림' : '온라인 설문 담당자 배정 알림';
                    const safeMsg = `온라인 설문 ${successfulCount}건이 ${isOnlyReassign ? '재' : ''}배정되었습니다.\n온라인 설문관리에서 확인해 주세요.`;

                    await notificationRepository.createNotification({
                        recipientUserId: String(targetUser.id || targetUser.username),
                        type: isOnlyReassign ? NOTIFICATION_TYPES.SURVEY_REASSIGNED : NOTIFICATION_TYPES.SURVEY_ASSIGNED,
                        relatedEntityType: 'survey_bulk',
                        relatedEntityId: bulkRequestId,
                        safeTitle,
                        safeMessage: safeMsg,
                        priority: 'NORMAL',
                        createdByUserId: actorId,
                        linkPage: 'online_survey',
                        deduplicationKey: `bulk_assign_${bulkRequestId}`
                    });
                } catch (notifErr) {
                    console.error('Failed to dispatch bulk assignment internal notification:', notifErr.message);
                }
            }

            res.json(result);
        } catch (err) {
            console.error('❌ POST /api/surveys/bulk-assign error:', err.message);
            const statusCode = err.code === 'BULK_ASSIGNMENT_LIMIT_EXCEEDED' ? 400
                : err.code === 'INVALID_PARAM' ? 400
                : 500;
            res.status(statusCode).json({
                error: {
                    code: err.code || 'BULK_ASSIGN_FAILED',
                    message: err.message
                }
            });
        }
    });

    // 6-3. POST /api/surveys/:id/unassign - Safe single survey unassignment (Admin only)
    router.post('/:id/unassign', requireAuth, requireSurveyImportPermission, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            const { reason } = req.body || {};

            const result = await surveyRepository.unassignStaff({
                submissionId: id,
                actorId,
                reason: reason || '담당자 배정 취소'
            });

            res.json({
                success: true,
                message: '담당자 배정이 정상적으로 취소되었습니다.',
                submission: result.submission
            });
        } catch (err) {
            console.error('❌ POST /api/surveys/:id/unassign error:', err.message);
            const statusCode = err.code === 'ALREADY_REGISTERED' ? 409
                : err.code === 'NOT_ASSIGNED' ? 400
                : err.code === 'RECORD_NOT_FOUND' ? 404
                : 500;
            res.status(statusCode).json({
                error: {
                    code: err.code || 'UNASSIGN_FAILED',
                    message: err.message
                }
            });
        }
    });

    // 6-1. POST /api/surveys/:id/consultation-status - Update counseling progress status
    router.post('/:id/consultation-status', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { id } = req.params;
            const { consultationStatus, note } = req.body || {};

            if (!consultationStatus || typeof consultationStatus !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '변경할 상담 상태(consultationStatus)가 필요합니다.' }
                });
            }

            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            const updated = await surveyRepository.updateConsultationStatus({
                submissionId: id,
                consultationStatus,
                actorId,
                note
            });

            // Synchronize with linked Referral
            if (referralService && typeof referralService.updateReferralConsultationStatus === 'function') {
                try {
                    await referralService.updateReferralConsultationStatus({
                        submissionId: updated.submissionId,
                        internalSurveyId: updated.internalSurveyId,
                        consultationStatus,
                        actorId,
                        note
                    });
                } catch (refErr) {
                    console.error('Failed to sync consultation status to referral:', refErr.message);
                }
            }

            res.json({
                success: true,
                message: '상담 진행 상태가 성공적으로 변경되었습니다.',
                submission: updated
            });
        } catch (err) {
            console.error('❌ POST /api/surveys/:id/consultation-status error:', err.message);
            const statusCode = err.code === SURVEY_ERROR_CODES.RECORD_NOT_FOUND ? 404 : 500;
            res.status(statusCode).json({
                error: { code: err.code || 'UPDATE_STATUS_FAILED', message: err.message }
            });
        }
    });

    // 7. GET /api/surveys/:id/assignment-history - Fetch history
    router.get('/:id/assignment-history', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const { id } = req.params;
            let history = [];
            if (surveyAssignmentRepository && typeof surveyAssignmentRepository.getHistoryBySurveyId === 'function') {
                history = surveyAssignmentRepository.getHistoryBySurveyId(id);
            } else if (surveyRepository && typeof surveyRepository.getAssignmentHistory === 'function') {
                history = surveyRepository.getAssignmentHistory(id);
            }

            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth?.id || req.auth?.userId || 'unknown',
                    targetUserId: id,
                    action: 'ONLINE_SURVEY_ASSIGNMENT_VIEWED',
                    result: 'SUCCESS'
                });
            }

            res.json({ history });
        } catch (err) {
            console.error('❌ GET /api/surveys/:id/assignment-history error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 8. GET /api/surveys/submissions/:id - Single detailed view with audit log emission
    router.get('/submissions/:id', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { id } = req.params;
            const submission = surveyRepository.findSubmissionById(id);

            if (!submission || submission.deletionStatus === 'deleted' || submission.status === 'deleted') {
                return res.status(404).json({
                    error: { code: 'NOT_FOUND', message: '해당 설문 제출 건을 찾을 수 없습니다.' }
                });
            }

            const ledgerItem = surveyRepository.findBySubmissionId(submission.submissionId);
            const referrals = surveyRepository.getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === submission.submissionId || r.sourceSurveyId === submission.internalSurveyId) || null;
            const journal = surveyRepository.getWorkflowJournal ? surveyRepository.getWorkflowJournal().filter(j => j.submissionId === submission.submissionId) : [];

            // Audit record for sensitive detail inspection
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: req.auth.userId || req.auth.id || 'admin',
                    targetUserId: submission.submissionId,
                    action: 'ONLINE_SURVEY_DETAIL_VIEWED',
                    result: 'SUCCESS'
                });
            }
            await surveyRepository.recordAuditEvent({
                actorId: req.auth.userId || req.auth.id || 'admin',
                action: 'SURVEY_DETAIL_VIEWED',
                internalSurveyId: id,
                submissionId: submission.submissionId,
                result: 'VIEWED'
            });

            res.json({
                submission,
                referral: ref,
                importRecord: ledgerItem,
                workflowHistory: journal
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/submissions/:id error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 8-1. GET /api/surveys/submissions/:id/referral-draft - Authorized Draft DTO for referral registration
    router.get('/submissions/:id/referral-draft', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { id } = req.params;
            const submission = surveyRepository.findSubmissionById(id);

            if (!submission) {
                return res.status(404).json({
                    error: { code: 'NOT_FOUND', message: '해당 설문 제출 건을 찾을 수 없습니다.' }
                });
            }

            const currentUserId = String(req.auth?.id || req.auth?.userId || '');
            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            const isAdmin = role === 'admin';

            // 1. Check if assigned
            if (!submission.assignedUserId || submission.assignmentStatus === 'unassigned') {
                return res.status(400).json({
                    error: { code: 'ASSIGNMENT_REQUIRED', message: '담당자 배정 전에는 의뢰대장을 생성할 수 없습니다.' }
                });
            }

            // 2. Check authorization: Admin or assigned staff only
            const isAssigned = String(submission.assignedUserId) === currentUserId;
            if (!isAdmin && !isAssigned) {
                return res.status(403).json({
                    error: { code: 'FORBIDDEN', message: '배정된 담당자만 해당 설문의 의뢰대장 등록을 진행할 수 있습니다.' }
                });
            }

            // 3. Check if already registered
            if (submission.referralId) {
                return res.json({
                    success: true,
                    isAlreadyRegistered: true,
                    existingReferralId: submission.referralId,
                    refNo: submission.refNo,
                    draft: null
                });
            }

            // 4. Calculate Age (demographics.age 우선, birthDate 폴백)
            let calculatedAge = 0;
            const demoAge = submission.contact?.demographics?.age ?? submission.identity?.demographics?.age;
            if (demoAge !== undefined && demoAge !== null && String(demoAge).trim() !== '') {
                const parsed = parseInt(String(demoAge), 10);
                if (!isNaN(parsed) && parsed > 0 && parsed < 130) {
                    calculatedAge = parsed;
                }
            }
            if (calculatedAge === 0) {
                const birthDateStr = submission.contact?.birthDate;
                if (birthDateStr && typeof birthDateStr === 'string') {
                    const parts = birthDateStr.split('-');
                    if (parts.length >= 1) {
                        const birthYear = parseInt(parts[0], 10);
                        if (!isNaN(birthYear) && birthYear > 1900 && birthYear <= new Date().getFullYear()) {
                            calculatedAge = new Date().getFullYear() - birthYear;
                        }
                    }
                }
            }

            // 5. Lookup assignee name
            const users = getUsers() || [];
            const assigneeUser = users.find(u => u && (String(u.id) === String(submission.assignedUserId) || String(u.username) === String(submission.assignedUserId)));
            const assigneeName = assigneeUser ? (assigneeUser.name || assigneeUser.username) : submission.assignedUserId;

            // 6. Screening summary
            const assessment = submission.assessment || {};
            const scaleName = (submission.assessmentId || 'contact-only').toUpperCase();
            const totalScore = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '-';
            const severity = assessment.severity || assessment.resultLabel || '평가완료';
            const screeningSummary = `[온라인 검진 접수] 척도: ${scaleName}, 총점: ${totalScore}, 판정: ${severity}`;

            const rawGender = submission.contact?.gender ?? submission.identity?.gender;
            const genderUpper = typeof rawGender === 'string' ? rawGender.trim().toUpperCase() : '';
            const normalizedGender = (genderUpper === 'MALE' || genderUpper === 'M' || rawGender === '남성' || rawGender === '남자' || rawGender === '남')
                ? '남성'
                : ((genderUpper === 'FEMALE' || genderUpper === 'F' || rawGender === '여성' || rawGender === '여자' || rawGender === '여') ? '여성' : (rawGender || '기타'));

            const draft = {
                name: submission.contact?.clientName || '성명미상',
                phone: submission.contact?.phone || submission.contact?.phoneNumber || '',
                gender: normalizedGender,
                age: calculatedAge,
                region: submission.contact?.region || '',
                // requestDate는 KST 날짜 기준 — UTC로 자르면 자정~오전 9시 검사 건이 전날로 찍힌다.
                requestDate: formatKstDateTime(submission.screeningCompletedAt || submission.submittedAt || submission.importedAt || new Date().toISOString(), 'date'),
                referralPath: '온라인설문',
                requestAgency: '온라인 자가검진',
                problem: submission.contact?.counselingRequestText || '',
                reason: submission.contact?.counselingRequestText || '',
                team: submission.assignedDepartmentId || assigneeUser?.team || '증진팀',
                assignee: assigneeName,
                source: 'online_survey',
                sourceSubmissionId: submission.submissionId,
                sourceSurveyId: submission.internalSurveyId,
                sourceAssessmentId: submission.assessmentId || 'contact-only',
                contactOnly: Boolean(submission.contactOnly),
                assessmentScore: submission.contactOnly ? null : (submission.assessment?.totalScore ?? null),
                overallRisk: submission.overallRisk || severity,
                screeningSummary,
                consultationRequested: true,
                assignedStaffId: String(submission.assignedUserId),
                assignedStaffName: assigneeName,
                attachments: submission.attachment ? [submission.attachment] : [],
                isWebsiteReferral: true,
                referralStatus: 'PENDING_STAFF_REVIEW',
                closureStatus: '미종결',
                registrationStatus: '확인중',
                criLevel: 'c'
            };

            // Emit Audit Log
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: currentUserId,
                    targetUserId: submission.submissionId,
                    internalSurveyId: submission.internalSurveyId,
                    action: 'ONLINE_SURVEY_REFERRAL_DRAFT_OPENED',
                    result: 'SUCCESS'
                });
            }

            res.json({
                success: true,
                isAlreadyRegistered: false,
                draft
            });
        } catch (err) {
            console.error('❌ GET /api/surveys/submissions/:id/referral-draft error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 9. POST /api/surveys/retry-deletions - Manual retry for pending external deletions
    router.post('/retry-deletions', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const actorId = req.auth.userId || req.auth.id || 'admin';
            const result = await surveyImportService.retryPendingDeletions(actorId);
            res.json({
                success: true,
                message: '외부 삭제 재시도가 완료되었습니다.',
                result
            });
        } catch (err) {
            res.status(500).json({ error: { code: 'RETRY_FAILED', message: err.message } });
        }
    });

    // 10. GET /api/surveys/submissions/:id/report and /api/surveys/:id/report - Secure PDF streaming
    const handleGetReport = async (req, res) => {
        try {
            const { id } = req.params;
            const fsMod = await import('fs');
            const pathMod = await import('path');

            // Find submission or referral
            const submissions = surveyRepository.getSurveySubmissions();
            const sub = submissions.find(s => s && (s.submissionId === id || s.internalSurveyId === id));

            const referrals = surveyRepository.getData('Referrals', []);
            const ref = referrals.find(r => r && (
                r.sourceSubmissionId === id ||
                r.sourceSurveyId === id ||
                r.referralId === id ||
                r.externalIdx === id ||
                (sub && (r.sourceSubmissionId === sub.submissionId || r.sourceSurveyId === sub.internalSurveyId))
            ));

            const attachment = ref?.attachments?.find(a =>
                a.type === 'application/pdf' ||
                (a.name && String(a.name).endsWith('.pdf')) ||
                (a.id && String(a.id).endsWith('.pdf')) ||
                (a.url && String(a.url).includes('.pdf'))
            ) || sub?.attachment || null;

            const targetDir = deps.attachmentsDir || referralService?.attachmentsDir || process.env.ATTACHMENTS_DIR;
            let filePath = null;

            const foldersToSearch = [];
            if (ref?.referralId) foldersToSearch.push(ref.referralId);
            if (sub?.internalSurveyId) foldersToSearch.push(sub.internalSurveyId);
            if (sub?.submissionId) foldersToSearch.push(sub.submissionId);
            if (id) foldersToSearch.push(id);

            if (targetDir && attachment) {
                for (const f of foldersToSearch) {
                    const safeFolder = f.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
                    const candidate1 = pathMod.default.join(targetDir, safeFolder, attachment.id || 'survey-report.pdf');
                    if (fsMod.default.existsSync(candidate1)) {
                        filePath = candidate1;
                        break;
                    }
                }
                if (!filePath && attachment.id) {
                    const candidate2 = pathMod.default.join(targetDir, attachment.id);
                    if (fsMod.default.existsSync(candidate2)) {
                        filePath = candidate2;
                    }
                }
            }

            // Fallback: search safeFolder for pdf
            if (!filePath && targetDir) {
                for (const f of foldersToSearch) {
                    const safeFolder = f.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
                    const folderPath = pathMod.default.join(targetDir, safeFolder);
                    if (fsMod.default.existsSync(folderPath)) {
                        const files = fsMod.default.readdirSync(folderPath);
                        const pdfFile = files.find(file => file.endsWith('.pdf'));
                        if (pdfFile) {
                            filePath = pathMod.default.join(folderPath, pdfFile);
                            break;
                        }
                    }
                }
            }

            if (!filePath || !fsMod.default.existsSync(filePath)) {
                return res.status(404).json({
                    error: {
                        code: 'REPORT_NOT_FOUND',
                        message: '검사결과 리포트를 찾을 수 없습니다. 리포트 재생성을 요청해 주세요.'
                    }
                });
            }

            // Audit record for report view
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            if (typeof auditLogger === 'function') {
                auditLogger({
                    actorUserId: actorId,
                    targetUserId: sub?.submissionId || id,
                    action: 'ONLINE_SURVEY_PDF_DOWNLOADED',
                    result: 'SUCCESS'
                });
            }
            if (typeof surveyRepository.recordAuditEvent === 'function') {
                await surveyRepository.recordAuditEvent({
                    actorId,
                    action: 'SURVEY_REPORT_VIEWED',
                    submissionId: sub?.submissionId || id,
                    result: 'SUCCESS'
                });
            }

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(attachment?.name || 'survey-report.pdf') + '"');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');

            fsMod.default.createReadStream(filePath).pipe(res);
        } catch (err) {
            console.error('❌ GET /api/surveys/:id/report error:', err.message);
            res.status(500).json({ error: { code: 'REPORT_STREAM_FAILED', message: err.message } });
        }
    };

    router.get('/submissions/:id/report', requireAuth, requireSurveyImportPermission, handleGetReport);
    router.get('/:id/report', requireAuth, requireSurveyImportPermission, handleGetReport);

    // ──────────────────────────────────────────────────────────
    // 11. Admin Deletion Endpoints (Admin-only: 401 unauth, 403 non-admin)
    // ──────────────────────────────────────────────────────────

    // POST /api/surveys/admin/purge-demo/dry-run
    router.post('/admin/purge-demo/dry-run', requireAuth, requireAdmin, async (req, res) => {
        try {
            const actorId = req.auth.userId || req.auth.id || 'admin';
            const reason = req.body?.reason || '더미 데이터 삭제 계획 확인';
            const plan = await surveyRepository.purgeDemoSubmissions({
                actorId,
                reason,
                dryRun: true
            });
            res.json({ success: true, plan });
        } catch (err) {
            const status = err.code === 'DEMO_PURGE_CONTAINS_REAL_DATA' ? 400 : 500;
            res.status(status).json({
                error: { code: err.code || 'DRY_RUN_FAILED', message: err.message }
            });
        }
    });

    // POST /api/surveys/admin/purge-demo
    router.post('/admin/purge-demo', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { confirmation, reason, dryRun } = req.body || {};

            if (dryRun === true) {
                const actorId = req.auth.userId || req.auth.id || 'admin';
                const plan = await surveyRepository.purgeDemoSubmissions({
                    actorId,
                    reason: reason || '더미 데이터 삭제 계획 확인',
                    dryRun: true
                });
                return res.json({ success: true, plan });
            }

            if (!reason || typeof reason !== 'string' || !reason.trim()) {
                return res.status(400).json({
                    error: {
                        code: 'MISSING_DELETION_REASON',
                        message: '삭제 사유를 입력해야 합니다.'
                    }
                });
            }

            if (!confirmation || confirmation.trim() !== 'DELETE DEMO DATA') {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CONFIRMATION_PHRASE',
                        message: '확인 문구가 일치하지 않습니다. "DELETE DEMO DATA"를 정확히 입력해야 합니다.'
                    }
                });
            }

            const actorId = req.auth.userId || req.auth.id || 'admin';
            const result = await surveyRepository.purgeDemoSubmissions({
                actorId,
                reason: reason.trim(),
                dryRun: false
            });

            res.json({
                success: true,
                message: `더미 데이터 ${result.purgedCount}건이 안전하게 삭제되었습니다.`,
                result
            });
        } catch (err) {
            const status = err.code === 'DEMO_PURGE_CONTAINS_REAL_DATA' ? 400 : 500;
            res.status(status).json({
                error: { code: err.code || 'PURGE_FAILED', message: err.message }
            });
        }
    });

    // POST /api/surveys/submissions/:id/soft-delete - Staff-permitted safe soft delete
    router.post('/submissions/:id/soft-delete', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const { id } = req.params;
            const { confirmSubmissionId, reason } = req.body || {};

            if (!reason || typeof reason !== 'string' || !reason.trim()) {
                return res.status(400).json({
                    error: {
                        code: 'MISSING_DELETION_REASON',
                        message: '삭제 사유를 입력해야 합니다.'
                    }
                });
            }

            if (!confirmSubmissionId || confirmSubmissionId !== id) {
                return res.status(400).json({
                    error: {
                        code: 'SUBMISSION_ID_MISMATCH',
                        message: '확인용 submissionId가 일치하지 않습니다.'
                    }
                });
            }

            if (surveyImportService.getStatusSummary().isImportRunning) {
                return res.status(409).json({
                    error: {
                        code: 'PROCESSING_IN_PROGRESS',
                        message: '설문 가져오기 작업 진행 중에는 삭제할 수 없습니다.'
                    }
                });
            }

            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'staff';
            const result = await surveyRepository.softDeleteSubmission({
                submissionId: id,
                actorId,
                reason: reason.trim()
            });

            return res.json({
                success: true,
                message: `대상자 (${id}) 온라인 설문 결과가 안전하게 삭제(보관)되었습니다.`,
                result
            });
        } catch (err) {
            const status = err.status || (err.code === 'NOT_FOUND' ? 404 : 400);
            return res.status(status).json({
                error: { code: err.code || 'SOFT_DELETE_FAILED', message: err.message }
            });
        }
    });

    // GET /api/surveys/admin/trash - Admin only: view soft-deleted submissions
    router.get('/admin/trash', requireAuth, requireAdmin, async (req, res) => {
        try {
            const trashItems = typeof surveyRepository.getTrashSubmissions === 'function'
                ? surveyRepository.getTrashSubmissions()
                : surveyRepository.getSurveySubmissions().filter(s => s && s.deletionStatus === 'deleted');

            return res.json({
                success: true,
                total: trashItems.length,
                submissions: trashItems
            });
        } catch (err) {
            return res.status(500).json({
                error: { code: 'INTERNAL_ERROR', message: err.message }
            });
        }
    });

    // GET /api/surveys/admin/trash/:id - Admin only: view single soft-deleted submission
    router.get('/admin/trash/:id', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const subs = surveyRepository.getSurveySubmissions();
            const submission = subs.find(s => s && (s.submissionId === id || s.internalSurveyId === id) && s.deletionStatus === 'deleted');
            if (!submission) {
                return res.status(404).json({
                    error: { code: 'NOT_FOUND', message: '휴지통에서 해당 설문 제출 건을 찾을 수 없습니다.' }
                });
            }
            return res.json({
                success: true,
                submission
            });
        } catch (err) {
            return res.status(500).json({
                error: { code: 'INTERNAL_ERROR', message: err.message }
            });
        }
    });

    // POST /api/surveys/admin/submissions/:id/restore - Admin only: restore soft-deleted submission
    router.post('/admin/submissions/:id/restore', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';

            const result = await surveyRepository.restoreSubmission({
                submissionId: id,
                actorId
            });

            return res.json({
                success: true,
                message: `대상자 (${id}) 설문이 복구되었습니다.`,
                result
            });
        } catch (err) {
            const status = err.status || (err.code === 'NOT_FOUND' ? 404 : 400);
            return res.status(status).json({
                error: { code: err.code || 'RESTORE_FAILED', message: err.message }
            });
        }
    });

    // DELETE /api/surveys/admin/submissions/:id
    router.delete('/admin/submissions/:id', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { confirmSubmissionId, reason } = req.body || {};

            if (!reason || typeof reason !== 'string' || !reason.trim()) {
                return res.status(400).json({
                    error: {
                        code: 'MISSING_DELETION_REASON',
                        message: '삭제 사유를 입력해야 합니다.'
                    }
                });
            }

            if (confirmSubmissionId && confirmSubmissionId !== id) {
                return res.status(400).json({
                    error: {
                        code: 'SUBMISSION_ID_MISMATCH',
                        message: '확인용 submissionId가 일치하지 않습니다.'
                    }
                });
            }

            if (surveyImportService.getStatusSummary().isImportRunning) {
                return res.status(409).json({
                    error: {
                        code: 'PROCESSING_IN_PROGRESS',
                        message: '설문 가져오기 작업 진행 중에는 삭제할 수 없습니다.'
                    }
                });
            }

            const actorId = req.auth.userId || req.auth.id || 'admin';
            const result = await surveyRepository.deleteSubmissionCascading({
                submissionId: id,
                actorId,
                reason: reason.trim()
            });

            res.json({
                success: true,
                message: `대상자 (${id}) 삭제가 완료되었습니다.`,
                result
            });
        } catch (err) {
            const status = err.code === 'ACTIVE_LEASE_EXISTS' ? 400 : 500;
            res.status(status).json({
                error: { code: err.code || 'DELETE_FAILED', message: err.message }
            });
        }
    });

    // 12. POST /api/surveys/admin/recover-stored-submission
    // Dedicated, isolated, idempotent admin-only recovery path for stored survey submissions
    router.post('/admin/recover-stored-submission', requireAuth, requireAdmin, requireSurveyImportPermission, async (req, res) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({
                    error: {
                        code: 'ARRAY_NOT_ALLOWED',
                        message: '한 번에 1건의 설문만 복구할 수 있습니다.'
                    }
                });
            }

            const { submissionId, expectedInternalSurveyId, dryRun, confirm } = req.body;

            if (!submissionId || typeof submissionId !== 'string' || !submissionId.trim()) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_SUBMISSION_ID',
                        message: '유효한 submissionId가 필요합니다.'
                    }
                });
            }

            const isDryRun = dryRun !== false;

            if (!isDryRun && confirm !== 'RECOVER_STORED_SUBMISSION') {
                return res.status(400).json({
                    error: {
                        code: 'CONFIRMATION_REQUIRED',
                        message: '실제 복구 실행을 위해 confirm="RECOVER_STORED_SUBMISSION" 확인이 필요합니다.'
                    }
                });
            }

            const actorId = String(req.auth.userId || req.auth.id || 'admin');
            const requestId = req.headers['x-request-id'] || `req_rec_${Date.now()}`;

            const result = await surveyImportService.recoverStoredSubmission({
                submissionId: submissionId.trim(),
                expectedInternalSurveyId: expectedInternalSurveyId ? String(expectedInternalSurveyId).trim() : null,
                actorId,
                dryRun: isDryRun,
                confirm,
                requestId
            });

            return res.json(result);
        } catch (err) {
            const statusCode = err.statusCode || (err.code === 'RECOVERY_IN_PROGRESS' ? 409 : (err.code === 'INVALID_SUBMISSION_ID' || err.code === 'CONFIRMATION_REQUIRED' ? 400 : (err.code === 'RECOVERY_BLOCKED' ? 422 : 500)));
            return res.status(statusCode).json({
                error: {
                    code: err.code || 'RECOVERY_FAILED',
                    message: err.message,
                    details: err.details || undefined
                }
            });
        }
    });

    return router;
}

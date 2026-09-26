/**
 * server/survey/surveyImportRouter.js
 * Express REST API Router for internal survey management & import operations.
 */

import express from 'express';
import { SURVEY_ASSIGNMENT_PRIORITY, NOTIFICATION_TYPES, SURVEY_ERROR_CODES } from './surveyConstants.js';
import { hasOnlineSurveyAccess } from '../permissions/voiceCapabilities.js';
import { getKstDateRangeUtcBoundaries } from './kstUtils.js';

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
            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            const isAdmin = role === 'admin';
            const summary = surveyImportService.getStatusSummary(currentUserId);

            const subs = surveyRepository.getSurveySubmissions();
            let unassignedCount = 0;
            let myAssignedPendingCount = 0;
            let totalPendingReferralCount = 0;

            for (const s of subs) {
                if (!s || s.status === 'deleted') continue;
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

            const badgeCount = isAdmin ? totalPendingReferralCount : myAssignedPendingCount;

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

    // 2. POST /api/surveys/import - Trigger manual import workflow
    router.post('/import', requireAuth, requireSurveyImportPermission, async (req, res) => {
        try {
            const actorId = req.auth.userId || req.auth.id || req.auth.username || 'admin';
            const limit = Number(req.body?.limit) || 50;

            const summary = await surveyImportService.runManualImport({
                actorId,
                limit
            });

            res.json({
                success: true,
                message: '온라인 설문 가져오기가 완료되었습니다.',
                summary
            });
        } catch (err) {
            const statusCode = err.code === 'IMPORT_ALREADY_IN_PROGRESS' ? 409 : 500;
            res.status(statusCode).json({
                success: false,
                error: {
                    code: err.code || 'IMPORT_FAILED',
                    message: err.message
                }
            });
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
                q: searchQuery
            } = req.query;

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

            const currentUserId = String(req.auth?.id || req.auth?.userId || '');
            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            const isAdmin = role === 'admin';

            // Base list from ledger
            let baseList = [...ledger];

            // 1. User isolation: Regular staff can only access submissions assigned to themselves
            if (!isAdmin) {
                baseList = baseList.filter(item => {
                    const sub = subMap.get(item.submissionId);
                    return sub && String(sub.assignedUserId) === currentUserId;
                });
            }

            // 2. Canonical Date Range Filter
            // DATE_FILTER_CANONICAL_FIELD: importedAt || receivedAt
            // DATE_FILTER_FALLBACK_FIELD: submittedAt
            if (dateBoundaries && (dateBoundaries.startUtcMs !== null || dateBoundaries.endUtcMs !== null)) {
                baseList = baseList.filter(item => {
                    const sub = subMap.get(item.submissionId);
                    const canonicalDateStr = item.importedAt || sub?.importedAt || item.receivedAt || item.submittedAt || sub?.submittedAt;
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

            // Map each item to safe client representation
            let safeList = baseList.map(item => {
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
                    submittedAt: sub?.contact?.submittedAt || sub?.importedAt || item.importedAt,
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
                    (item.refNo && item.refNo.toLowerCase().includes(q))
                );
            }

            // 6. Sorting
            safeList.sort((a, b) => {
                if (sortBy === 'oldest') {
                    const timeA = new Date(a.importedAt || a.submittedAt || 0).getTime();
                    const timeB = new Date(b.importedAt || b.submittedAt || 0).getTime();
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
                // Default 'latest': newest canonical date first
                const timeA = new Date(a.importedAt || a.submittedAt || 0).getTime();
                const timeB = new Date(b.importedAt || b.submittedAt || 0).getTime();
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

            // Fetch submissions
            let records = surveyRepository.getSurveySubmissions();

            // Filter criteria
            const { assessmentId, assignedUserId, assignmentPriority, consultationStatus, startDate, endDate } = req.query;

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
            if (startDate) {
                records = records.filter(r => (r.createdAt || r.importedAt || '') >= startDate);
            }
            if (endDate) {
                const endDateTime = endDate.length === 10 ? `${endDate}T23:59:59.999Z` : endDate;
                records = records.filter(r => (r.createdAt || r.importedAt || '') <= endDateTime);
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

    // 6. POST /api/surveys/:id/assign and /api/surveys/:id/reassign (Admin only)
    const handleAssignment = async (req, res) => {
        try {
            const { id } = req.params;
            const { assignedUserId, assignedDepartmentId, assignmentPriority, expectedVersion, reason } = req.body || {};

            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            if (role !== 'admin') {
                return res.status(403).json({
                    error: { code: 'FORBIDDEN', message: '관리자(Admin)만 담당자를 배정할 수 있습니다.' }
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

            if (!submission) {
                return res.status(404).json({
                    error: { code: 'NOT_FOUND', message: '해당 설문 제출 건을 찾을 수 없습니다.' }
                });
            }

            const role = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
            const isAdmin = role === 'admin';
            const currentUserId = String(req.auth?.id || req.auth?.userId || '');

            // Non-admin can only access records assigned to themselves
            if (!isAdmin && (!submission.assignedUserId || String(submission.assignedUserId) !== currentUserId)) {
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

            // 4. Calculate Age
            let calculatedAge = 0;
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

            const rawGender = submission.contact?.gender;
            const normalizedGender = (rawGender === '남성' || rawGender === 'M' || rawGender === 'male')
                ? '남성'
                : ((rawGender === '여성' || rawGender === 'F' || rawGender === 'female') ? '여성' : (rawGender || '기타'));

            const draft = {
                name: submission.contact?.clientName || '성명미상',
                phone: submission.contact?.phone || submission.contact?.phoneNumber || '',
                gender: normalizedGender,
                age: calculatedAge,
                region: submission.contact?.region || '',
                requestDate: (submission.submittedAt || submission.importedAt || new Date().toISOString()).substring(0, 10),
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

    return router;
}

/**
 * server/survey/surveyImportRouter.js
 * Express REST API Router for internal survey management & import operations.
 */

import express from 'express';
import { SURVEY_ASSIGNMENT_PRIORITY, NOTIFICATION_TYPES, SURVEY_ERROR_CODES } from './surveyConstants.js';

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
 * Permission guard for Survey Import Manager
 */
function requireSurveyImportPermission(req, res, next) {
    if (!req.auth) {
        return res.status(401).json({
            error: { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' }
        });
    }

    const role = (req.auth.role || 'user').toLowerCase();
    const hasExplicitPerm = !!(req.auth.permissions && (
        req.auth.permissions.surveyImport ||
        req.auth.permissions.SURVEY_IMPORT_MANAGER ||
        req.auth.permissions.SURVEY_EXPORT
    ));

    // Admin, Manager, or explicit permission
    if (role === 'admin' || role === 'manager' || hasExplicitPerm) {
        return next();
    }

    return res.status(403).json({
        error: { code: 'FORBIDDEN', message: '온라인 설문 관리 및 가져오기 권한이 없습니다.' }
    });
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
        getUsers = () => []
    } = deps;

    if (!requireAuth || !surveyImportService || !surveyRepository) {
        throw new Error('createSurveyImportRouter requires requireAuth, surveyImportService, and surveyRepository');
    }

    const router = express.Router();

    // 1. GET /api/surveys/status - Safe aggregate counts and import semaphore state
    router.get('/status', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const summary = surveyImportService.getStatusSummary();
            res.json(summary);
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

    // 3. GET /api/surveys/imports - Paginated import ledger list with masked names/phones
    router.get('/imports', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const ledger = surveyRepository.getImportsLedger();
            const submissions = surveyRepository.getSurveySubmissions();
            const subMap = new Map(submissions.map(s => [s.submissionId, s]));
            const referrals = surveyRepository.getData('Referrals', []);
            const refMap = new Map(referrals.filter(r => r.sourceSubmissionId).map(r => [r.sourceSubmissionId, r]));

            // Sort descending by attempt / creation
            const sorted = [...ledger].reverse();

            const safeList = sorted.map(item => {
                const sub = subMap.get(item.submissionId);
                const ref = refMap.get(item.submissionId);
                const reportAttachment = ref?.attachments?.find(a =>
                    a.type === 'application/pdf' || (a.url && a.url.startsWith('/attachments'))
                ) || null;

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
                    // Masked identity fields for list view
                    maskedClientName: maskName(sub?.contact?.clientName),
                    maskedPhone: maskPhone(sub?.contact?.phone),
                    region: sub?.contact?.region || '-',
                    totalScore: sub?.assessment?.totalScore ?? null,
                    meanScore: sub?.assessment?.meanScore ?? null,
                    severity: sub?.assessment?.severity ?? null,
                    consultationStatus: sub?.consultationStatus || '-',
                    counselingRequestText: sub?.contact?.counselingRequestText || '',
                    submittedAt: sub?.contact?.submittedAt || sub?.importedAt || item.importedAt,
                    contactOnly: sub?.contactOnly || false,
                    // Linked referral info
                    referralId: ref?.referralId || null,
                    refNo: ref?.refNo || null,
                    referralStatus: ref?.referralStatus || null,
                    closureStatus: ref?.closureStatus || null,
                    hasReport: Boolean(reportAttachment),
                    reportAttachment,
                    // Assignment fields
                    assignedUserId: sub?.assignedUserId || (ref ? ref.assignee : null),
                    assignedDepartmentId: sub?.assignedDepartmentId || (ref ? ref.team : null),
                    assignmentPriority: sub?.assignmentPriority || SURVEY_ASSIGNMENT_PRIORITY.NORMAL,
                    assignedAt: sub?.assignedAt || null,
                    version: sub?.version || 1
                };
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

    // 4. GET /api/surveys/assignable-staff - List of active assignable staff
    router.get('/assignable-staff', requireAuth, requireSurveyImportPermission, (req, res) => {
        try {
            const users = getUsers() || [];
            const safeStaff = users
                .filter(u => u && u.status !== 'suspended' && u.status !== 'deleted')
                .map(u => ({
                    id: String(u.id || u.username || ''),
                    name: u.name || u.username || '직원',
                    team: u.team || u.department || '',
                    role: u.role || 'user'
                }));
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

    // 6. POST /api/surveys/:id/assign and /api/surveys/:id/reassign
    const handleAssignment = async (req, res) => {
        try {
            const { id } = req.params;
            const { assignedUserId, assignedDepartmentId, assignmentPriority, expectedVersion, reason } = req.body || {};

            if (!assignedUserId || typeof assignedUserId !== 'string') {
                return res.status(400).json({
                    error: { code: 'INVALID_PARAM', message: '배정할 직원의 ID(assignedUserId)가 필요합니다.' }
                });
            }

            // Target staff validation
            const users = getUsers() || [];
            const targetUser = users.find(u =>
                u && (String(u.id) === String(assignedUserId) || String(u.username) === String(assignedUserId))
            );

            if (!targetUser || targetUser.status === 'suspended' || targetUser.status === 'deleted') {
                return res.status(400).json({
                    error: { code: SURVEY_ERROR_CODES.STAFF_INACTIVE, message: '배정 대상 직원이 유효하지 않거나 비활성 상태입니다.' }
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

            // Internal Notification Dispatch (Zero-PII Canonical Phase 14 Payload)
            if (notificationRepository) {
                const isReassign = Boolean(updated.previousAssignedUserId);
                const notifType = isReassign ? NOTIFICATION_TYPES.SURVEY_REASSIGNED : NOTIFICATION_TYPES.SURVEY_ASSIGNED;
                const safeTitle = isReassign ? '의뢰 재배정 알림' : '신규 의뢰 배정 알림';
                const safeRefNo = updatedReferral?.refNo || updated.internalSurveyId || updated.submissionId.substring(0, 10);
                const safeMsg = `온라인 설문 기반 신규 의뢰 1건이 배정되었습니다.\n의뢰번호: ${safeRefNo}\n검토 우선순위: ${priority}\n의뢰대장에서 확인해 주세요.`;

                await notificationRepository.createNotification({
                    recipientUserId: updated.assignedUserId,
                    type: notifType,
                    relatedEntityType: 'referral',
                    relatedEntityId: updatedReferral?.referralId || updatedReferral?.refNo || updated.submissionId,
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
            const history = surveyAssignmentRepository ? surveyAssignmentRepository.getHistoryBySurveyId(id) : [];
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

            const ledgerItem = surveyRepository.findBySubmissionId(submission.submissionId);
            const referrals = surveyRepository.getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === submission.submissionId || r.sourceSurveyId === submission.internalSurveyId) || null;
            const journal = surveyRepository.getWorkflowJournal ? surveyRepository.getWorkflowJournal().filter(j => j.submissionId === submission.submissionId) : [];

            // Audit record for sensitive detail inspection
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

    return router;
}

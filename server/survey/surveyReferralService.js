/**
 * server/survey/surveyReferralService.js
 * Atomic conversion service that transforms an approved online survey submission
 * into a referral-register draft (PENDING_STAFF_REVIEW) with a server-generated
 * screening result PDF attachment.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SurveyReportGenerator } from './surveyReportGenerator.js';

const TEAM_CODES = {
    '정신건강증진팀': 'HB',
    '증진팀': 'HB',
    '예방관리팀': 'YP',
    '중독관리팀': 'JD',
    '회복팀': 'JD',
    '지역복지팀': 'ET',
    '기획홍보팀': 'GH',
    '아동청소년팀': 'AD',
    '아동청소년': 'AD',
    '위기관리팀': 'WG',
    '자살예방센터': 'WG',
    '남부분소': 'NB'
};

export class SurveyReferralService {
    /**
     * @param {Object} deps
     * @param {Function} deps.getData
     * @param {Function} deps.persistData
     * @param {string} deps.attachmentsDir
     * @param {SurveyReportGenerator} [deps.reportGenerator]
     * @param {Function} [deps.getUsers]
     */
    constructor(deps = {}) {
        if (!deps.getData || !deps.persistData || !deps.attachmentsDir) {
            throw new Error('SurveyReferralService requires getData, persistData, and attachmentsDir');
        }
        this.getData = deps.getData;
        this.persistData = deps.persistData;
        this.attachmentsDir = deps.attachmentsDir;
        this.reportGenerator = deps.reportGenerator || new SurveyReportGenerator();
        this.getUsers = deps.getUsers || (() => []);
        this.sourceEnvironment = deps.sourceEnvironment || 'mock';
    }

    _calculateAge(birthDateStr) {
        if (!birthDateStr || typeof birthDateStr !== 'string') return 0;
        const parts = birthDateStr.split('-');
        if (parts.length >= 1) {
            const birthYear = parseInt(parts[0], 10);
            if (!isNaN(birthYear) && birthYear > 1900 && birthYear <= new Date().getFullYear()) {
                return new Date().getFullYear() - birthYear;
            }
        }
        return 0;
    }

    _formatScreeningSummary(payload) {
        const assessment = payload.assessment || {};
        const hasSensitiveConsent = Boolean(payload.consentEvidence?.sensitiveInfoConsent);
        const assessmentId = payload.assessmentId ? String(payload.assessmentId).toLowerCase() : 'contact-only';

        if (hasSensitiveConsent && assessmentId !== 'contact-only') {
            const scaleName = assessmentId.toUpperCase();
            if (assessmentId === 'bepsi-k') {
                const meanVal = assessment.meanScore !== undefined && assessment.meanScore !== null
                    ? (typeof assessment.meanScore === 'number' ? assessment.meanScore.toFixed(2) : assessment.meanScore)
                    : (assessment.totalScore ? (assessment.totalScore / 5).toFixed(2) : '-');
                const sumVal = assessment.responseSum ?? assessment.totalScore ?? '-';
                const severity = assessment.resultLabel || assessment.severity || '평가완료';
                return `[온라인 검진 접수] 척도: BEPSI-K, 평균: ${meanVal}점 (문항합계: ${sumVal}점), 판정: ${severity} (선별검진결과지 첨부)`;
            }

            if (assessmentId === 'sbq-r') {
                const totalScore = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '-';
                const severity = assessment.severity || assessment.resultLabel || (Number(assessment.totalScore) >= 7 ? '추가 확인 권장' : '선별 기준점 미만');
                return `[온라인 검진 접수] 척도: SBQ-R, 총점: ${totalScore}, 선별결과: ${severity} (선별검진결과지 첨부)`;
            }

            if (assessmentId === 'icheon-screening-23') {
                const riskLabel = assessment.risk?.label || assessment.risk?.level || '5개 척도 종합 선별';
                return `[온라인 종합검진 접수] 5개 척도 종합검진 (PHQ-9, GAD-7, ISI-K, BEPSI-K, SBQ-R), 선별판정: ${riskLabel} (선별검진결과지 첨부)`;
            }

            const totalScore = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '-';
            const severity = assessment.severity || '미분류';
            return `[온라인 검진 접수] 척도: ${scaleName}, 총점: ${totalScore}, 심각도: ${severity} (선별검진결과지 첨부)`;
        }

        return `[온라인 상담 접수] 단순 상담 신청 (검사결과 미전송 - 민감정보 수집 미동의, 선별결과지 첨부)`;
    }

    /**
     * Generate standalone screening report PDF without creating a referral.
     */
    async generateScreeningReportOnly({
        payload,
        internalSurveyId,
        submissionId,
        refNo = 'SCREENING-ONLY',
        actorId = 'system'
    }) {
        const reportResult = this.reportGenerator.generateScreeningReportPdf({
            refNo,
            referralId: internalSurveyId || submissionId,
            internalSurveyId,
            submissionId,
            payload,
            consentEvidence: payload.consentEvidence,
            actorId
        });

        const safeFolder = (internalSurveyId || submissionId).replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
        const targetFolder = path.join(this.attachmentsDir, safeFolder);
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
        }

        const physicalFileId = reportResult.filename;
        const targetFilePath = path.join(targetFolder, physicalFileId);
        await fs.promises.writeFile(targetFilePath, reportResult.buffer);

        const readBackBuffer = await fs.promises.readFile(targetFilePath);
        if (!readBackBuffer || readBackBuffer.length !== reportResult.size) {
            throw new Error(`Screening report attachment read-back verification failed for ${targetFilePath}`);
        }

        const attachmentMetadata = {
            id: physicalFileId,
            name: '온라인 마음건강 검진 결과보고서',
            url: `/attachments/${safeFolder}/${encodeURIComponent(physicalFileId)}`,
            type: 'application/pdf',
            size: reportResult.size,
            uploadedAt: reportResult.generatedAt,
            fileHash: reportResult.fileHash
        };

        return {
            attachment: attachmentMetadata,
            filePath: targetFilePath
        };
    }

    /**
     * Create or retrieve a referral draft from a validated survey submission.
     * Enforces external submissionId idempotency and generates screening report PDF.
     */
    async createReferralFromSurvey({
        payload,
        internalSurveyId,
        submissionId,
        assignedUserId = null,
        assignedDepartmentId = null,
        assignmentPriority = 'NORMAL',
        sourceEnvironment = null,
        actorId = 'system',
        existingAttachment = null
    }) {
        if (!payload || !submissionId) {
            throw new Error('createReferralFromSurvey requires valid payload and submissionId');
        }

        const referrals = this.getData('Referrals', []);

        // 1. Idempotency check: Same submissionId returns existing referral
        const existing = referrals.find(r =>
            r && (r.sourceSubmissionId === submissionId || r.externalIdx === submissionId)
        );
        if (existing) {
            return {
                referral: existing,
                isDuplicate: true,
                message: '이미 등록된 온라인 설문 접수 건입니다.'
            };
        }

        // 2. Determine target team and assignee
        // Default assignment policy: UNASSIGNED, PENDING_STAFF_REVIEW.
        // Institutional policy does NOT permit automated admin assignment upon import.
        let targetTeam = assignedDepartmentId || '증진팀';
        let assigneeName = '';

        if (assignedUserId && assignedUserId !== 'admin' && assignedUserId !== 'system') {
            const users = this.getUsers() || [];
            const user = users.find(u => u && (String(u.id) === String(assignedUserId) || String(u.username) === String(assignedUserId)));
            if (user) {
                assigneeName = user.name || user.username || assignedUserId;
                if (!assignedDepartmentId && user.team) {
                    targetTeam = user.team;
                }
            } else {
                assigneeName = assignedUserId;
            }
        }

        // 3. Server-side Atomic Referral Number Generation
        const teamCode = TEAM_CODES[targetTeam] || 'ET';
        const now = new Date();
        const yearYY = now.getFullYear().toString().slice(-2);
        const prefix = `${teamCode}-${yearYY}-`;

        const existingSeqs = referrals
            .filter(r => r && r.refNo && String(r.refNo).startsWith(prefix))
            .map(r => {
                const parts = String(r.refNo).split('-');
                return parts.length >= 3 ? parseInt(parts[2], 10) : NaN;
            })
            .filter(n => !isNaN(n));

        const maxSeq = existingSeqs.length > 0 ? Math.max(...existingSeqs) : 0;
        const assignedRefNo = `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
        const referralId = crypto.randomUUID();

        // Source environment isolation check
        if (this.sourceEnvironment === 'production') {
            if (sourceEnvironment && sourceEnvironment !== 'production') {
                throw new Error(`[SECURITY_VIOLATION] Production mode rejected referral creation with invalid sourceEnvironment: ${sourceEnvironment}`);
            }
        }
        if (this.sourceEnvironment === 'staging') {
            if (sourceEnvironment === 'production') {
                throw new Error('[SECURITY_VIOLATION] Staging mode rejected referral creation with production sourceEnvironment');
            }
        }

        // 4 & 5. Attach PDF (Reuse existing attachment or generate new)
        let attachmentMetadata = existingAttachment;
        if (!attachmentMetadata) {
            const reportResult = this.reportGenerator.generateScreeningReportPdf({
                refNo: assignedRefNo,
                referralId,
                internalSurveyId,
                submissionId,
                payload,
                consentEvidence: payload.consentEvidence,
                actorId
            });

            const safeFolder = referralId.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
            const targetFolder = path.join(this.attachmentsDir, safeFolder);
            if (!fs.existsSync(targetFolder)) {
                fs.mkdirSync(targetFolder, { recursive: true });
            }

            const physicalFileId = reportResult.filename;
            const targetFilePath = path.join(targetFolder, physicalFileId);
            await fs.promises.writeFile(targetFilePath, reportResult.buffer);

            const readBackBuffer = await fs.promises.readFile(targetFilePath);
            if (!readBackBuffer || readBackBuffer.length !== reportResult.size) {
                throw new Error(`Screening report attachment read-back verification failed for ${targetFilePath}`);
            }

            attachmentMetadata = {
                id: physicalFileId,
                name: '온라인 마음건강 검진 결과보고서',
                url: `/attachments/${safeFolder}/${encodeURIComponent(physicalFileId)}`,
                type: 'application/pdf',
                size: reportResult.size,
                uploadedAt: reportResult.generatedAt,
                fileHash: reportResult.fileHash
            };
        }

        // 6. Build Referral Draft (PENDING_STAFF_REVIEW)
        const contact = payload.contact || {};
        const calculatedAge = this._calculateAge(contact.birthDate);
        const isoNow = now.toISOString();
        const requestDateStr = payload.submittedAt
            ? payload.submittedAt.substring(0, 10)
            : isoNow.substring(0, 10);

        const newReferral = {
            referralId,
            refNo: assignedRefNo,
            clientId: `C${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            version: 1,
            name: contact.clientName || '성명미상',
            phone: contact.phone || '',
            gender: (contact.gender === '남성' || contact.gender === '여성' || contact.gender === '기타') ? contact.gender : '기타',
            age: calculatedAge,
            region: contact.region || '',
            requestDate: requestDateStr,
            referralPath: '온라인설문',
            requestAgency: '온라인 자가검진',
            problem: contact.counselingRequestText || '',
            reason: contact.counselingRequestText || '',
            team: targetTeam,
            assignee: assigneeName,
            source: 'online_survey',
            sourceEnvironment: sourceEnvironment || this.sourceEnvironment || 'mock',
            sourceSubmissionId: submissionId,
            sourceSurveyId: internalSurveyId,
            sourceAssessmentId: payload.assessmentId || 'contact-only',
            contactOnly: Boolean(payload.contactOnly),
            assessmentScore: payload.contactOnly ? null : (payload.assessment?.totalScore ?? null),
            externalIdx: submissionId,
            referralStatus: 'PENDING_STAFF_REVIEW',
            closureStatus: '미종결',
            registrationStatus: '확인중',
            criLevel: 'c', // Default middle tier awaiting clinical interview
            policeIntervention: false,
            diagnosisProtectionRequest: false,
            writtenRequest: false,
            phoneRequest: false,
            diagnosisName: '',
            actionResult: '',
            interventionContent: this._formatScreeningSummary(payload),
            reply: false,
            attachments: [attachmentMetadata],
            notes: [{
                id: `note_${Date.now()}`,
                content: `[온라인 검진결과 자동접수] 선별결과지(${attachmentMetadata.name})가 첨부되었습니다. 담당 직원의 초기 상담 및 검토가 필요합니다.`,
                author: actorId || '시스템',
                createdAt: isoNow
            }],
            isWebsiteReferral: true,
            createdAt: isoNow,
            updatedAt: isoNow
        };

        // 7. Persist to Referrals.json
        referrals.push(newReferral);
        await this.persistData('Referrals', referrals);

        // 8. Read-back verification from JSON repository
        const updatedList = this.getData('Referrals', []);
        const verifiedRecord = updatedList.find(r => r.referralId === referralId);
        if (!verifiedRecord || verifiedRecord.refNo !== assignedRefNo) {
            throw new Error(`Referral read-back verification failed for ${referralId}`);
        }

        return {
            referral: verifiedRecord,
            attachment: attachmentMetadata,
            isDuplicate: false
        };
    }

    /**
     * Synchronize staff assignment to linked referral draft.
     */
    async updateReferralAssignee({
        submissionId,
        internalSurveyId,
        assignedUserId,
        assignedDepartmentId,
        actorId = 'system'
    }) {
        const referrals = this.getData('Referrals', []);
        const targetId = submissionId || internalSurveyId;
        const refIndex = referrals.findIndex(r =>
            r && (r.sourceSubmissionId === targetId || r.sourceSurveyId === targetId || r.externalIdx === targetId)
        );
        if (refIndex === -1) return null;

        const referral = referrals[refIndex];
        let targetTeam = assignedDepartmentId || referral.team || '증진팀';
        let assigneeName = referral.assignee || '';

        if (assignedUserId) {
            const users = this.getUsers() || [];
            const user = users.find(u => u && (String(u.id) === String(assignedUserId) || String(u.username) === String(assignedUserId)));
            if (user) {
                assigneeName = user.name || user.username || assignedUserId;
                if (!assignedDepartmentId && user.team) {
                    targetTeam = user.team;
                }
            } else {
                assigneeName = assignedUserId;
            }
        }

        const now = new Date().toISOString();
        const updatedReferral = {
            ...referral,
            team: targetTeam,
            assignee: assigneeName,
            updatedAt: now,
            notes: [
                ...(referral.notes || []),
                {
                    id: `note_${Date.now()}`,
                    content: `[담당자 배정] ${assigneeName} (${targetTeam}) 담당자로 배정되었습니다.`,
                    author: actorId || '시스템',
                    createdAt: now
                }
            ]
        };

        referrals[refIndex] = updatedReferral;
        await this.persistData('Referrals', referrals);
        return updatedReferral;
    }

    /**
     * Synchronize consultation status to linked referral draft.
     */
    async updateReferralConsultationStatus({
        submissionId,
        internalSurveyId,
        consultationStatus,
        actorId = 'system',
        note = ''
    }) {
        const referrals = this.getData('Referrals', []);
        const targetId = submissionId || internalSurveyId;
        const refIndex = referrals.findIndex(r =>
            r && (r.sourceSubmissionId === targetId || r.sourceSurveyId === targetId || r.externalIdx === targetId)
        );
        if (refIndex === -1) return null;

        const referral = referrals[refIndex];
        const now = new Date().toISOString();
        let referralStatus = referral.referralStatus;
        let closureStatus = referral.closureStatus;

        if (consultationStatus === '상담완료' || consultationStatus === '종결') {
            referralStatus = 'REVIEWED';
            closureStatus = '종결';
        } else if (consultationStatus === '상담진행') {
            referralStatus = 'IN_PROGRESS';
            closureStatus = '미종결';
        }

        const noteText = note ? `[상담상태 변경] ${consultationStatus} (메모: ${note})` : `[상담상태 변경] ${consultationStatus}`;
        const updatedReferral = {
            ...referral,
            referralStatus,
            closureStatus,
            updatedAt: now,
            notes: [
                ...(referral.notes || []),
                {
                    id: `note_${Date.now()}`,
                    content: noteText,
                    author: actorId || '시스템',
                    createdAt: now
                }
            ]
        };

        referrals[refIndex] = updatedReferral;
        await this.persistData('Referrals', referrals);
        return updatedReferral;
    }
}


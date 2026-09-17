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

        if (hasSensitiveConsent && payload.assessmentId && payload.assessmentId !== 'contact-only') {
            const scaleName = String(payload.assessmentId).toUpperCase();
            const totalScore = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '-';
            const severity = assessment.severity || '미분류';
            return `[온라인 검진 접수] 척도: ${scaleName}, 총점: ${totalScore}, 심각도: ${severity} (선별검진결과지 첨부)`;
        }

        return `[온라인 상담 접수] 단순 상담 신청 (민감정보 미동의 또는 검진척도 없음, 선별결과지 첨부)`;
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
        actorId = 'system'
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
        let targetTeam = assignedDepartmentId || '증진팀';
        let assigneeName = '';

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

        // 4. Generate Server-Side Screening Report PDF Attachment
        const reportResult = this.reportGenerator.generateScreeningReportPdf({
            refNo: assignedRefNo,
            referralId,
            internalSurveyId,
            submissionId,
            payload,
            consentEvidence: payload.consentEvidence,
            actorId
        });

        // 5. Store PDF Attachment File in ATTACHMENTS_DIR
        const safeFolder = referralId.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
        const targetFolder = path.join(this.attachmentsDir, safeFolder);
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
        }

        const physicalFileId = `${Date.now()}_${reportResult.filename}`;
        const targetFilePath = path.join(targetFolder, physicalFileId);
        await fs.promises.writeFile(targetFilePath, reportResult.buffer);

        // Read-back verification of the stored PDF file
        const readBackBuffer = await fs.promises.readFile(targetFilePath);
        if (!readBackBuffer || readBackBuffer.length !== reportResult.size) {
            throw new Error(`Screening report attachment read-back verification failed for ${targetFilePath}`);
        }

        const attachmentMetadata = {
            id: physicalFileId,
            name: `선별검진결과지_${String(payload.assessmentId || 'CONTACT').toUpperCase()}_${assignedRefNo}.pdf`,
            url: `/attachments/${safeFolder}/${encodeURIComponent(physicalFileId)}`,
            type: 'application/pdf',
            size: reportResult.size,
            uploadedAt: reportResult.generatedAt,
            fileHash: reportResult.fileHash
        };

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


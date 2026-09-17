/**
 * server/survey/surveyReportGenerator.js
 * Server-side screening report generator producing institutional PDF attachments
 * using jsPDF with full Korean font support and privacy guardrails.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate font paths for Windows and Linux environments
const SYSTEM_FONT_CANDIDATES = [
    path.join(__dirname, 'assets', 'font.ttf'),
    'C:/Windows/Fonts/malgun.ttf',
    'C:/Windows/Fonts/gulim.ttc',
    'C:/Windows/Fonts/batang.ttc',
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc'
];

let cachedFontBase64 = null;
let cachedFontName = 'Helvetica';

function loadAvailableKoreanFont() {
    if (cachedFontBase64 !== null) {
        return { fontName: cachedFontName, fontData: cachedFontBase64 };
    }

    for (const fontPath of SYSTEM_FONT_CANDIDATES) {
        try {
            if (fs.existsSync(fontPath)) {
                const buf = fs.readFileSync(fontPath);
                if (buf && buf.length > 0) {
                    cachedFontBase64 = buf.toString('base64');
                    cachedFontName = 'KoreanFont';
                    console.log(`📄 [SurveyReportGenerator] Loaded Korean font from: ${fontPath} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
                    return { fontName: cachedFontName, fontData: cachedFontBase64 };
                }
            }
        } catch (ignore) {}
    }

    console.warn('⚠️ [SurveyReportGenerator] No Korean TTF font found on host system. Falling back to default font.');
    cachedFontBase64 = false;
    cachedFontName = 'Helvetica';
    return { fontName: cachedFontName, fontData: null };
}

export class SurveyReportGenerator {
    constructor(options = {}) {
        this.institutionName = options.institutionName || '이천시정신건강복지센터';
        this.centerEnglish = options.centerEnglish || 'Icheon Mental Health Center';
        this.systemName = options.systemName || 'Mind-ERP OS Track B';
    }

    /**
     * Generate an institutional screening result PDF Buffer.
     * 
     * @param {Object} params
     * @param {string} params.refNo - Referral Number (e.g. 'ET-26-001')
     * @param {string} params.referralId - Referral UUID
     * @param {string} params.internalSurveyId - Internal Survey ID
     * @param {string} params.submissionId - External Submission ID
     * @param {Object} params.payload - Validated survey intake payload
     * @param {Object} [params.consentEvidence] - Consent evidence details
     * @param {string} [params.actorId] - Generating actor ID
     * @returns {{ buffer: Buffer, filename: string, fileHash: string, size: number, mimeType: string }}
     */
    generateScreeningReportPdf(params = {}) {
        const {
            refNo = '미채번',
            referralId = '',
            internalSurveyId = '',
            submissionId = '',
            payload = {},
            consentEvidence = {},
            actorId = 'system'
        } = params;

        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const { fontName, fontData } = loadAvailableKoreanFont();
        if (fontData) {
            doc.addFileToVFS('korean.ttf', fontData);
            doc.addFont('korean.ttf', fontName, 'normal');
            doc.setFont(fontName);
        }

        const now = new Date();
        const generatedAt = now.toISOString();
        const generatedDateStr = now.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const submittedDateStr = payload.submittedAt
            ? new Date(payload.submittedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
            : generatedDateStr;

        const contact = payload.contact || {};
        const assessment = payload.assessment || {};
        const hasSensitiveConsent = Boolean(payload.consentEvidence?.sensitiveInfoConsent ?? consentEvidence.sensitiveInfoConsent);

        // --- 1. Page Frame & Header ---
        doc.setDrawColor(44, 62, 80);
        doc.setLineWidth(0.8);
        doc.rect(12, 12, 186, 273); // Main border

        // Top Banner
        doc.setFillColor(30, 58, 138); // Deep Indigo/Navy
        doc.rect(13, 13, 184, 18, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(13);
        doc.text(`${this.institutionName} | 온라인 선별검진 및 상담접수 결과지`, 18, 24);

        // Subtitle & Reference Numbers
        doc.setTextColor(51, 65, 85);
        doc.setFontSize(9);
        doc.text(`의뢰접수번호: ${refNo}`, 18, 38);
        doc.text(`내부설문ID: ${internalSurveyId || '-'}`, 80, 38);
        doc.text(`발급일자: ${generatedDateStr}`, 145, 38);

        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.4);
        doc.line(18, 42, 192, 42);

        // --- 2. Subject Demographics Box ---
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 46, 174, 38, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.rect(18, 46, 174, 38, 'S');

        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 내담자 인적사항 및 접수정보', 22, 53);

        doc.setFontSize(9);
        doc.setTextColor(71, 85, 105);
        doc.text(`성 명: ${contact.clientName || '-'}`, 24, 61);
        doc.text(`연 락 처: ${contact.phone || '-'}`, 80, 61);
        doc.text(`성 별: ${contact.gender || '기타'}`, 140, 61);

        doc.text(`생년월일: ${contact.birthDate || '-'}`, 24, 69);
        doc.text(`거주지역: ${contact.region || '-'}`, 80, 69);
        doc.text(`접수일자: ${submittedDateStr}`, 140, 69);

        const requestNote = contact.counselingRequestText ? String(contact.counselingRequestText).substring(0, 75) : '기재 내용 없음';
        doc.text(`신청사유: ${requestNote}`, 24, 77);

        // --- 3. Consent Verification Box ---
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 88, 174, 24, 'F');
        doc.rect(18, 88, 174, 24, 'S');

        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 개인정보 및 민감정보 수집·이용 동의 확인', 22, 95);

        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        const pConsentText = payload.consentEvidence?.personalInfoConsent ? '동의 완료 (VERIFIED)' : '미동의';
        const sConsentText = hasSensitiveConsent ? '동의 완료 (VERIFIED)' : '미동의 (단순 상담)';
        doc.text(`개인정보 수집·이용 동의: ${pConsentText}`, 24, 103);
        doc.text(`민감정보(검진결과) 동의: ${sConsentText}`, 105, 103);

        // --- 4. Assessment Scale Results ---
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 116, 174, 98, 'F');
        doc.rect(18, 116, 174, 98, 'S');

        const assessmentId = payload.assessmentId ? String(payload.assessmentId).toLowerCase() : 'contact-only';
        let scaleKoreanTitle = '단순 상담 접수 (검진 미실시)';
        if (assessmentId === 'phq-9') scaleKoreanTitle = '우울 건강선별도구 (PHQ-9)';
        else if (assessmentId === 'gad-7') scaleKoreanTitle = '불안 선별도구 (GAD-7)';
        else if (assessmentId === 'isi-k') scaleKoreanTitle = '불면증 심각도 척도 (ISI-K)';
        else if (assessmentId === 'bepsi-k') scaleKoreanTitle = '한국형 스트레스 척도 (BEPSI-K)';
        else if (assessmentId === 'sbq-r') scaleKoreanTitle = '자살행동 선별질문지 (SBQ-R)';

        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text(`■ 정신건강 선별검진 평가 결과 [ ${scaleKoreanTitle} ]`, 22, 123);

        if (hasSensitiveConsent && assessmentId !== 'contact-only') {
            doc.setFontSize(9.5);
            doc.setTextColor(30, 41, 59);

            if (assessmentId === 'bepsi-k') {
                // BEPSI-K: Highlight meanScore as the primary score, show responseSum separately
                const meanVal = assessment.meanScore !== undefined && assessment.meanScore !== null
                    ? (typeof assessment.meanScore === 'number' ? assessment.meanScore.toFixed(2) : assessment.meanScore)
                    : (assessment.totalScore ? (assessment.totalScore / 5).toFixed(2) : '-');
                const sumVal = assessment.responseSum ?? assessment.totalScore ?? '-';
                const bepsiSeverity = assessment.resultLabel || assessment.severity ||
                    (parseFloat(meanVal) < 1.6 ? '저스트레스군' : parseFloat(meanVal) < 2.2 ? '중등도 스트레스군' : '고스트레스군');

                doc.setFontSize(9.5);
                doc.text(`평균 점수(주요지표): ${meanVal}점`, 24, 132);
                doc.text(`[문항합계: ${sumVal}점]`, 82, 132);
                doc.text(`스트레스 판정: ${bepsiSeverity}`, 124, 132);
            } else if (assessmentId === 'sbq-r') {
                // SBQ-R: Total score and additional review recommendation without definitive words
                const scoreText = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '-';
                const totalNum = Number(assessment.totalScore) || 0;
                const reviewRec = totalNum >= 7
                    ? '추가 확인 권장 (기준점 7점 이상)'
                    : '선별 기준점 미만 (추가 확인 권장 대상 아님)';

                doc.text(`선별 총점: ${scoreText} (범위: 3~18점)`, 24, 132);
                doc.text(`선별 결과: ${reviewRec}`, 92, 132);
            } else {
                // PHQ-9, GAD-7, ISI-K
                const scoreText = assessment.totalScore !== undefined && assessment.totalScore !== null ? `${assessment.totalScore}점` : '평가 없음';
                const severityText = assessment.severity || '판정 결과 없음';
                doc.text(`검진 총점: ${scoreText}`, 24, 132);
                doc.text(`심각도 / 선별 결과: ${severityText}`, 90, 132);
            }

            // Table Header for Questions
            doc.setFillColor(226, 232, 240);
            doc.rect(22, 137, 166, 7, 'F');
            doc.setFontSize(8.5);
            doc.setTextColor(51, 65, 85);
            doc.text('문항', 26, 142);
            doc.text('검진 항목 내용 (선별 척도 요약)', 45, 142);
            doc.text('선택 응답 / 점수', 148, 142);

            // Render Questions / Items (if present)
            const responses = Array.isArray(assessment.responses) ? assessment.responses.slice(0, 9) : [];
            let yPos = 149;

            if (responses.length > 0) {
                responses.forEach((resp, idx) => {
                    doc.setDrawColor(241, 245, 249);
                    doc.line(22, yPos + 1.5, 188, yPos + 1.5);

                    doc.setFontSize(8);
                    doc.setTextColor(71, 85, 105);
                    doc.text(`Q${idx + 1}`, 26, yPos);
                    const qLabel = resp.questionLabel ? String(resp.questionLabel).substring(0, 36) : `문항 ${idx + 1}`;
                    doc.text(qLabel, 45, yPos);
                    const scoreStr = resp.score !== undefined ? `${resp.score}점` : '-';
                    const answerLabel = resp.answerLabel ? String(resp.answerLabel).substring(0, 12) : scoreStr;
                    doc.text(`${answerLabel} (${scoreStr})`, 148, yPos);
                    yPos += 6.5;
                });
            } else {
                doc.setFontSize(9);
                doc.setTextColor(100, 116, 139);
                doc.text('상세 문항별 응답은 요약 저장 정책에 따라 총점/평균과 선별 지표로 관리됩니다.', 30, 155);
            }
        } else {
            // Contact-only or sensitive consent declined: Do NOT substitute 0, clearly display '검사결과 미전송'
            doc.setFontSize(9.5);
            doc.setTextColor(185, 28, 28);
            doc.text('검사결과: 검사결과 미전송 (민감정보 수집·이용 미동의)', 24, 132);

            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            doc.text('※ 내담자가 민감정보(정신건강 선별검진 결과) 처리에 동의하지 않았습니다.', 24, 142);
            doc.text('이에 따라 0점으로 처리하지 않고 결과 미전송으로 기록 관리하며,', 24, 150);
            doc.text('기본 인적사항 및 상담 신청사유를 바탕으로 전문요원의 기초 상담이 진행됩니다.', 24, 158);
        }

        // --- 5. Legal & Clinical Safety Disclaimer ---
        doc.setFillColor(254, 242, 242); // Light red / amber tint
        doc.rect(18, 218, 174, 30, 'F');
        doc.setDrawColor(254, 202, 202);
        doc.rect(18, 218, 174, 30, 'S');

        doc.setFontSize(9);
        doc.setTextColor(185, 28, 28);
        doc.text('【중요 안내 및 법적·임상적 안전 고지문】', 22, 225);

        doc.setFontSize(8);
        doc.setTextColor(153, 27, 27);
        doc.text('1. 본 선별검진 결과는 의학적 진단(Diagnosis)이 아니며, 상담 조기 개입을 위한 참고자료입니다.', 24, 232);
        doc.text('2. 선별 척도 점수가 낮더라도 주관적 고통 및 위기 가능성이 배제되지 않으므로 전문요원의 면담이 필수적입니다.', 24, 238);
        doc.text('3. 본 문서는 개인정보보호법에 의거하여 비밀이 보장되며, 승인된 목적 외 무단 유출 및 복제를 엄금합니다.', 24, 244);

        // Output Buffer
        const arrayBuf = doc.output('arraybuffer');
        const buffer = Buffer.from(arrayBuf);
        const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

        // Strict neutral physical filename: survey-report_<UUID>.pdf
        // Strictly excludes name, phone, assessment identifier, score, risk label, or referral number
        const reportUuid = crypto.randomUUID();
        const filename = `survey-report_${reportUuid}.pdf`;

        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text(`발급기관: ${this.institutionName} (${this.centerEnglish})`, 18, 256);
        doc.text(`전자 발급 무결성 해시: ${fileHash}`, 18, 261);
        doc.text(`발급자 ID: ${actorId} | 처리엔진: ${this.systemName} v3.1 | 문서식별자: ${reportUuid}`, 18, 266);

        return {
            buffer,
            filename,
            fileHash,
            size: buffer.length,
            mimeType: 'application/pdf',
            generatedAt
        };
    }
}

/**
 * server/survey/surveyReportGenerator.js
 * Server-side screening report generator producing institutional multi-scale PDF attachments
 * using jsPDF with Korean font support, multi-page layout, and privacy guardrails.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// KST Date Formatter (Asia/Seoul) — reuses kstUtils pattern
// Avoids system TZ dependency; explicit Intl.DateTimeFormat
// ============================================================
function formatPdfTimestamp(isoOrDate) {
    if (!isoOrDate) return '-';
    const d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return '-';
    try {
        const fmt = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const parts = fmt.formatToParts(d);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        return `${get('year')}. ${get('month')}. ${get('day')}. ${get('hour')}:${get('minute')}`;
    } catch { return '-'; }
}

function formatPdfDateOnly(dateStr) {
    if (!dateStr) return '-';
    // Date-only string (YYYY-MM-DD): preserve as-is, no timezone conversion
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).trim())) {
        const [y, m, dd] = String(dateStr).trim().split('-');
        return `${y}. ${m}. ${dd}.`;
    }
    // If it's a full timestamp, convert to KST date-only
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    try {
        const fmt = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const parts = fmt.formatToParts(d);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        return `${get('year')}. ${get('month')}. ${get('day')}.`;
    } catch { return '-'; }
}

// Project-local official Noto Sans KR font asset (SIL Open Font License 1.1)
// Bundled in server/survey/assets/fonts/ and included in Docker via COPY server/ ./server/
const PROJECT_FONT_TTF = path.join(__dirname, 'assets', 'fonts', 'NotoSansKR[wght].ttf');

let cachedFontBase64 = null;
let fontLoadAttempted = false;

function loadKoreanFont() {
    if (fontLoadAttempted) {
        return { fontData: cachedFontBase64 };
    }
    fontLoadAttempted = true;

    try {
        if (fs.existsSync(PROJECT_FONT_TTF)) {
            const buf = fs.readFileSync(PROJECT_FONT_TTF);
            if (buf && buf.length > 10000) {
                cachedFontBase64 = buf.toString('base64');
            }
        }
    } catch (ignore) {}

    // FAIL-CLOSED: If official Korean font not found, block PDF generation
    if (!cachedFontBase64) {
        throw new Error(
            'KOREAN_FONT_LOAD_FAILED: Official Korean font (NotoSansKR[wght].ttf) not found. ' +
            'PDF generation is blocked to prevent mojibake. ' +
            `Searched: ${PROJECT_FONT_TTF}`
        );
    }

    return { fontData: cachedFontBase64 };
}

function extractScaleData(payload, scaleId) {
    if (!payload) return null;
    const sId = String(scaleId).toLowerCase();

    // 1. Check assessment.scaleScores[sId]
    if (payload.assessment?.scaleScores?.[sId]) {
        return payload.assessment.scaleScores[sId];
    }
    // 2. Check scaleScores[sId]
    if (payload.scaleScores?.[sId]) {
        return payload.scaleScores[sId];
    }
    // 3. Check assessments (array or object)
    if (Array.isArray(payload.assessments)) {
        const found = payload.assessments.find(a => String(a.assessmentId || a.id).toLowerCase() === sId);
        if (found) return found;
    } else if (payload.assessments && typeof payload.assessments === 'object') {
        if (payload.assessments[sId]) return payload.assessments[sId];
    }
    // 4. Check single assessment
    if (String(payload.assessmentId || '').toLowerCase() === sId) {
        return payload.assessment || null;
    }
    if (payload.assessment && String(payload.assessment.assessmentId || '').toLowerCase() === sId) {
        return payload.assessment;
    }
    return null;
}

export class SurveyReportGenerator {
    constructor(options = {}) {
        this.institutionName = options.institutionName || '이천시정신건강복지센터';
        this.centerEnglish = options.centerEnglish || 'Icheon Mental Health Center';
        this.systemName = options.systemName || 'Mind-ERP OS';
    }

    /**
     * Generate an institutional screening result PDF Buffer.
     * Multi-page architecture:
     * - Page 1: Header, RefNo, Contact Info, Consent Verification, 5-Scale Summary Table
     * - Page 2: PHQ-9 Detail, GAD-7 Detail, ISI-K Detail
     * - Page 3: BEPSI-K Detail, SBQ-R Detail, Legal & Clinical Safety Disclaimer
     */
    generateScreeningReportPdf(params = {}) {
        const {
            refNo = '미채번',
            referralId = '',
            payload = {},
            consentEvidence = {},
            actorId = 'system'
        } = params;

        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        // FAIL-CLOSED Korean font registration (Noto Sans KR TTF)
        const { fontData } = loadKoreanFont();
        doc.addFileToVFS('NotoSansKR.ttf', fontData);
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'normal');
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'bold');
        doc.setFont('NotoSansKR', 'normal');

        // Date formatting: explicit Asia/Seoul, no system TZ dependency
        const now = new Date();
        const generatedAt = now.toISOString();
        const generatedDateStr = formatPdfTimestamp(now);
        const submittedDateStr = payload.submittedAt
            ? (/^\d{4}-\d{2}-\d{2}$/.test(String(payload.submittedAt).trim())
                ? formatPdfDateOnly(payload.submittedAt)
                : formatPdfTimestamp(payload.submittedAt))
            : generatedDateStr;

        const contact = payload.contact || {};
        const hasSensitiveConsent = Boolean(payload.consentEvidence?.sensitiveInfoConsent ?? consentEvidence.sensitiveInfoConsent);

        // Extract each of the 5 completed scales
        const phqData = extractScaleData(payload, 'phq-9');
        const gadData = extractScaleData(payload, 'gad-7');
        const isiData = extractScaleData(payload, 'isi-k');
        const bepsiData = extractScaleData(payload, 'bepsi-k');
        const sbqData = extractScaleData(payload, 'sbq-r');

        // =========================================================================
        // PAGE 1: 표지 및 종합 선별 요약
        // =========================================================================
        doc.setDrawColor(44, 62, 80);
        doc.setLineWidth(0.8);
        doc.rect(12, 12, 186, 273);

        // Top Banner
        doc.setFillColor(30, 58, 138);
        doc.rect(13, 13, 184, 18, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(13);
        doc.text(`${this.institutionName} | 온라인 마음건강 선별검진 및 상담접수 결과지`, 18, 24);

        // Subtitle & Header Meta (Strictly excludes internalSurveyId / surveyId)
        doc.setTextColor(51, 65, 85);
        doc.setFontSize(9);
        doc.text(`의뢰접수번호: ${refNo}`, 18, 38);
        doc.text(`접수일자: ${submittedDateStr}`, 90, 38);
        doc.text(`리포트 생성일자: ${generatedDateStr}`, 142, 38);

        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.4);
        doc.line(18, 42, 192, 42);

        // Section 1: 내담자 인적사항 및 접수정보
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

        const requestNote = contact.counselingRequestText ? String(contact.counselingRequestText).substring(0, 70) : '기재 내용 없음';
        doc.text(`신청사유: ${requestNote}`, 24, 77);

        // Section 2: 개인정보 및 민감정보 수집·이용 동의 확인 (Strictly excludes VERIFIED / VALIDATED)
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 88, 174, 22, 'F');
        doc.rect(18, 88, 174, 22, 'S');

        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 개인정보 및 민감정보 수집·이용 동의 확인', 22, 95);

        doc.setFontSize(8.5);
        doc.setTextColor(71, 85, 105);
        const pConsentText = payload.consentEvidence?.personalInfoConsent ? '동의 완료' : '미동의';
        const sConsentText = hasSensitiveConsent ? '동의 완료' : '미동의 (검사결과 미전송)';
        doc.text(`개인정보 수집·이용 동의: ${pConsentText}`, 24, 103);
        doc.text(`민감정보 및 검사결과 수집·이용 동의: ${sConsentText}`, 98, 103);

        // Section 3: 5개 척도 종합 선별 결과 요약표
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 114, 174, 126, 'F');
        doc.rect(18, 114, 174, 126, 'S');

        doc.setFontSize(10);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 마음건강 5개 척도 종합 선별 결과 요약', 22, 121);

        // Table Header
        doc.setFillColor(226, 232, 240);
        doc.rect(22, 126, 166, 8, 'F');
        doc.setFontSize(8.5);
        doc.setTextColor(51, 65, 85);
        doc.text('선별 도구 (척도명)', 26, 131.5);
        doc.text('평가 지표 / 점수', 78, 131.5);
        doc.text('선별 판정 결과', 122, 131.5);
        doc.text('기준 안내', 162, 131.5);

        // Helper to format scale summary row
        const summaryRows = [
            {
                name: '1. 우울 선별 (PHQ-9)',
                scale: phqData,
                format: (d) => {
                    if (!hasSensitiveConsent) return { score: '검사결과 미전송', result: '민감정보 미동의', note: '0~27점' };
                    if (!d) return { score: '검사 미실시', result: '해당 없음', note: '0~27점' };
                    const sc = d.totalScore !== undefined && d.totalScore !== null ? `${d.totalScore}점` : '미전송';
                    const res = d.severity || d.resultLabel || '분류완료';
                    return { score: sc, result: res, note: '0~27점' };
                }
            },
            {
                name: '2. 불안 선별 (GAD-7)',
                scale: gadData,
                format: (d) => {
                    if (!hasSensitiveConsent) return { score: '검사결과 미전송', result: '민감정보 미동의', note: '0~21점' };
                    if (!d) return { score: '검사 미실시', result: '해당 없음', note: '0~21점' };
                    const sc = d.totalScore !== undefined && d.totalScore !== null ? `${d.totalScore}점` : '미전송';
                    const res = d.severity || d.resultLabel || '분류완료';
                    return { score: sc, result: res, note: '0~21점' };
                }
            },
            {
                name: '3. 수면 위생 (ISI-K)',
                scale: isiData,
                format: (d) => {
                    if (!hasSensitiveConsent) return { score: '검사결과 미전송', result: '민감정보 미동의', note: '0~28점' };
                    if (!d) return { score: '검사 미실시', result: '해당 없음', note: '0~28점' };
                    const sc = d.totalScore !== undefined && d.totalScore !== null ? `${d.totalScore}점` : '미전송';
                    const res = d.severity || d.resultLabel || '분류완료';
                    return { score: sc, result: res, note: '0~28점' };
                }
            },
            {
                name: '4. 스트레스 (BEPSI-K)',
                scale: bepsiData,
                format: (d) => {
                    if (!hasSensitiveConsent) return { score: '검사결과 미전송', result: '민감정보 미동의', note: '1.6 / 2.2' };
                    if (!d) return { score: '검사 미실시', result: '해당 없음', note: '1.6 / 2.2' };
                    const meanVal = d.meanScore !== undefined && d.meanScore !== null
                        ? (typeof d.meanScore === 'number' ? d.meanScore.toFixed(2) : d.meanScore)
                        : (d.totalScore ? (d.totalScore / 5).toFixed(2) : '-');
                    const sumVal = d.responseSum ?? d.totalScore ?? '-';
                    const res = d.resultLabel || d.severity || (parseFloat(meanVal) < 1.6 ? '저스트레스군' : parseFloat(meanVal) < 2.2 ? '중등도 스트레스군' : '고스트레스군');
                    return { score: `평균 ${meanVal}점 (합계 ${sumVal})`, result: res, note: '평균 1.6/2.2' };
                }
            },
            {
                name: '5. 자살 관련 선별 (SBQ-R)',
                scale: sbqData,
                format: (d) => {
                    if (!hasSensitiveConsent) return { score: '검사결과 미전송', result: '민감정보 미동의', note: '기준점 7점' };
                    if (!d) return { score: '검사 미실시', result: '해당 없음', note: '기준점 7점' };
                    const totalVal = d.totalScore !== undefined && d.totalScore !== null ? `${d.totalScore}점` : '미전송';
                    const num = Number(d.totalScore) || 0;
                    const res = d.resultLabel || (num >= 7 ? '추가 확인 권장' : '선별 기준점 미만');
                    return { score: totalVal, result: res, note: '기준점 7점' };
                }
            }
        ];

        let summaryY = 142;
        summaryRows.forEach((row, idx) => {
            const parsed = row.format(row.scale);
            doc.setDrawColor(241, 245, 249);
            doc.line(22, summaryY + 4, 188, summaryY + 4);

            doc.setFontSize(8.5);
            doc.setTextColor(30, 41, 59);
            doc.text(row.name, 26, summaryY);
            doc.setTextColor(71, 85, 105);
            doc.text(parsed.score, 78, summaryY);

            // Highlight SBQ-R or high stress
            if (row.name.includes('SBQ-R') && parsed.result.includes('추가 확인')) {
                doc.setTextColor(190, 24, 93);
            } else if (parsed.result.includes('고스트레스') || parsed.result.includes('심한') || parsed.result.includes('중증')) {
                doc.setTextColor(185, 28, 28);
            } else {
                doc.setTextColor(51, 65, 85);
            }
            doc.text(parsed.result, 122, summaryY);

            doc.setTextColor(100, 116, 139);
            doc.setFontSize(8);
            doc.text(parsed.note, 162, summaryY);

            summaryY += 12;
        });

        // Summary Note
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text('※ 세부 문항 응답 및 척도별 상세 분석 결과는 2페이지와 3페이지에 수록되어 있습니다.', 24, 206);
        doc.text('※ 민감정보 수집에 미동의한 경우 문항 응답 및 점수를 출력하지 않고 기초 상담으로 전환됩니다.', 24, 212);
        doc.text('※ 검사하지 않은 척도는 0점으로 왜곡하지 않고 [검사 미실시]로 정확히 기록 관리합니다.', 24, 218);
        doc.text('※ 본 선별 결과지는 의학적 진단이 아니며 전문 인력의 초기 상담 및 면담용 보조자료로 활용됩니다.', 24, 224);

        // Page 1 Footer
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text(`발급기관: ${this.institutionName} (${this.centerEnglish}) | [1 / 3 페이지]`, 18, 275);

        // =========================================================================
        // PAGE 2: PHQ-9, GAD-7, ISI-K 상세 내역
        // =========================================================================
        doc.addPage();
        doc.setFont('NotoSansKR', 'normal');
        doc.setDrawColor(44, 62, 80);
        doc.setLineWidth(0.8);
        doc.rect(12, 12, 186, 273);

        // Header
        doc.setFillColor(30, 58, 138);
        doc.rect(13, 13, 184, 14, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.text(`${this.institutionName} | 온라인 선별검진 세부 결과 (우울·불안·수면)`, 18, 22);

        doc.setTextColor(71, 85, 105);
        doc.setFontSize(8.5);
        doc.text(`의뢰접수번호: ${refNo}   |   접수일자: ${submittedDateStr}   |   내담자: ${contact.clientName || '-'}`, 18, 33);
        doc.setDrawColor(226, 232, 240);
        doc.line(18, 36, 192, 36);

        const renderScaleDetail = (startY, title, data, maxScore) => {
            doc.setFillColor(248, 250, 252);
            doc.rect(18, startY, 174, 68, 'F');
            doc.setDrawColor(203, 213, 225);
            doc.rect(18, startY, 174, 68, 'S');

            doc.setFontSize(9.5);
            doc.setTextColor(15, 23, 42);
            doc.text(`■ ${title}`, 22, startY + 7);

            if (!hasSensitiveConsent) {
                doc.setFontSize(8.5);
                doc.setTextColor(185, 28, 28);
                doc.text('검사결과 미전송 (민감정보 수집·이용 미동의로 인해 점수와 응답이 비공개 처리되었습니다)', 24, startY + 16);
                return startY + 72;
            }

            if (!data) {
                doc.setFontSize(8.5);
                doc.setTextColor(100, 116, 139);
                doc.text('검사 미실시 (해당 척도 설문이 진행되지 않았습니다)', 24, startY + 16);
                return startY + 72;
            }

            const totalStr = data.totalScore !== undefined && data.totalScore !== null ? `${data.totalScore}점` : '미전송';
            const sevStr = data.severity || data.resultLabel || '분류완료';

            doc.setFontSize(9);
            doc.setTextColor(30, 41, 59);
            doc.text(`검진 총점: ${totalStr} (최대 ${maxScore}점)`, 24, startY + 15);
            doc.text(`승인된 분류 결과: ${sevStr}`, 95, startY + 15);

            // Table mini header
            doc.setFillColor(226, 232, 240);
            doc.rect(22, startY + 19, 166, 6, 'F');
            doc.setFontSize(8);
            doc.setTextColor(51, 65, 85);
            doc.text('문항', 25, startY + 23.5);
            doc.text('검진 항목 내용', 42, startY + 23.5);
            doc.text('선택 응답 / 점수', 145, startY + 23.5);

            const responses = Array.isArray(data.responses) ? data.responses.slice(0, 7) : [];
            let itemY = startY + 30;

            if (responses.length > 0) {
                responses.forEach((resp, rIdx) => {
                    doc.setFontSize(7.5);
                    doc.setTextColor(71, 85, 105);
                    doc.text(`Q${resp.questionNumber || rIdx + 1}`, 25, itemY);
                    const qText = resp.questionLabel ? String(resp.questionLabel).substring(0, 36) : `문항 ${rIdx + 1}`;
                    doc.text(qText, 42, itemY);
                    const scStr = resp.score !== undefined ? `${resp.score}점` : '-';
                    const aText = resp.answerLabel ? String(resp.answerLabel).substring(0, 12) : scStr;
                    doc.text(`${aText} (${scStr})`, 145, itemY);
                    itemY += 5.2;
                });
            } else {
                doc.setFontSize(8);
                doc.setTextColor(100, 116, 139);
                doc.text('문항별 상세 응답은 총점 요약 정책에 따라 승인된 분류 결과로 보존 관리됩니다.', 26, startY + 32);
            }

            return startY + 72;
        };

        let nextY = 40;
        nextY = renderScaleDetail(nextY, '우울 건강선별도구 (PHQ-9)', phqData, 27);
        nextY = renderScaleDetail(nextY, '불안 선별도구 (GAD-7)', gadData, 21);
        renderScaleDetail(nextY, '불면증 심각도 척도 (ISI-K)', isiData, 28);

        // Page 2 Footer
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text(`발급기관: ${this.institutionName} (${this.centerEnglish}) | [2 / 3 페이지]`, 18, 275);

        // =========================================================================
        // PAGE 3: BEPSI-K, SBQ-R 상세 및 안전 고지문
        // =========================================================================
        doc.addPage();
        doc.setFont('NotoSansKR', 'normal');
        doc.setDrawColor(44, 62, 80);
        doc.setLineWidth(0.8);
        doc.rect(12, 12, 186, 273);

        // Header
        doc.setFillColor(30, 58, 138);
        doc.rect(13, 13, 184, 14, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.text(`${this.institutionName} | 온라인 선별검진 세부 결과 (스트레스·자살행동선별)`, 18, 22);

        doc.setTextColor(71, 85, 105);
        doc.setFontSize(8.5);
        doc.text(`의뢰접수번호: ${refNo}   |   접수일자: ${submittedDateStr}   |   내담자: ${contact.clientName || '-'}`, 18, 33);
        doc.setDrawColor(226, 232, 240);
        doc.line(18, 36, 192, 36);

        // 1. BEPSI-K 스트레스 상세 섹션
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 40, 174, 66, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.rect(18, 40, 174, 66, 'S');

        doc.setFontSize(9.5);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 한국형 스트레스 척도 (BEPSI-K) 세부 결과', 22, 47);

        if (!hasSensitiveConsent) {
            doc.setFontSize(8.5);
            doc.setTextColor(185, 28, 28);
            doc.text('검사결과 미전송 (민감정보 수집·이용 미동의로 인해 점수와 응답이 비공개 처리되었습니다)', 24, 56);
        } else if (!bepsiData) {
            doc.setFontSize(8.5);
            doc.setTextColor(100, 116, 139);
            doc.text('검사 미실시 (해당 척도 설문이 진행되지 않았습니다)', 24, 56);
        } else {
            const meanVal = bepsiData.meanScore !== undefined && bepsiData.meanScore !== null
                ? (typeof bepsiData.meanScore === 'number' ? bepsiData.meanScore.toFixed(2) : bepsiData.meanScore)
                : (bepsiData.totalScore ? (bepsiData.totalScore / 5).toFixed(2) : '-');
            const sumVal = bepsiData.responseSum ?? bepsiData.totalScore ?? '-';
            const bepsiPolicy = bepsiData.scoringPolicyId || 'BEPSI_K_REVISED_QUARTILE_1_6_2_2';
            const bepsiCode = bepsiData.resultCode || (parseFloat(meanVal) < 1.6 ? 'LOW' : parseFloat(meanVal) < 2.2 ? 'MODERATE' : 'HIGH');
            const bepsiSeverity = bepsiData.resultLabel || bepsiData.severity ||
                (bepsiCode === 'LOW' ? '저스트레스군' : bepsiCode === 'MODERATE' ? '중등도 스트레스군' : '고스트레스군');

            doc.setFontSize(9);
            doc.setTextColor(30, 41, 59);
            doc.text(`평균 점수(주요지표): ${meanVal}점`, 24, 55);
            doc.text(`문항합계(responseSum): ${sumVal}점`, 82, 55);
            doc.text(`판정: ${bepsiCode} (${bepsiSeverity})`, 138, 55);

            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            doc.text(`채점 정책: ${bepsiPolicy} (사분위수 기준: < 1.6 LOW / 1.6~2.2 MODERATE / >= 2.2 HIGH)`, 24, 61);

            // Table mini header
            doc.setFillColor(226, 232, 240);
            doc.rect(22, 64, 166, 6, 'F');
            doc.setFontSize(8);
            doc.setTextColor(51, 65, 85);
            doc.text('문항', 25, 68.5);
            doc.text('스트레스 문항 내용', 42, 68.5);
            doc.text('선택 응답 / 점수', 145, 68.5);

            const bepsiResponses = Array.isArray(bepsiData.responses) ? bepsiData.responses.slice(0, 5) : [];
            let bepsiY = 74.5;
            bepsiResponses.forEach((resp, rIdx) => {
                doc.setFontSize(7.5);
                doc.setTextColor(71, 85, 105);
                doc.text(`Q${resp.questionNumber || rIdx + 1}`, 25, bepsiY);
                const qText = resp.questionLabel ? String(resp.questionLabel).substring(0, 36) : `스트레스 문항 ${rIdx + 1}`;
                doc.text(qText, 42, bepsiY);
                const scStr = resp.score !== undefined ? `${resp.score}점` : '-';
                const aText = resp.answerLabel ? String(resp.answerLabel).substring(0, 12) : scStr;
                doc.text(`${aText} (${scStr})`, 145, bepsiY);
                bepsiY += 5.2;
            });
        }

        // 2. SBQ-R 자살 관련 행동 선별 섹션
        doc.setFillColor(248, 250, 252);
        doc.rect(18, 112, 174, 66, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.rect(18, 112, 174, 66, 'S');

        doc.setFontSize(9.5);
        doc.setTextColor(15, 23, 42);
        doc.text('■ 자살 관련 행동 선별질문지 (SBQ-R) 세부 결과', 22, 119);

        if (!hasSensitiveConsent) {
            doc.setFontSize(8.5);
            doc.setTextColor(185, 28, 28);
            doc.text('검사결과 미전송 (민감정보 수집·이용 미동의로 인해 점수와 응답이 비공개 처리되었습니다)', 24, 128);
        } else if (!sbqData) {
            doc.setFontSize(8.5);
            doc.setTextColor(100, 116, 139);
            doc.text('검사 미실시 (해당 척도 설문이 진행되지 않았습니다)', 24, 128);
        } else {
            const sbqScore = sbqData.totalScore !== undefined && sbqData.totalScore !== null ? `${sbqData.totalScore}점` : '미전송';
            const totalNum = Number(sbqData.totalScore) || 0;
            const sbqPolicy = sbqData.scoringPolicyId || 'SBQR_GENERAL_POPULATION_CUTOFF_7';
            const sbqResult = totalNum >= 7
                ? '추가적인 전문 확인 권장 (선별 기준점 7점 이상)'
                : '선별 기준점 미만 (7점 미만)';

            doc.setFontSize(9);
            doc.setTextColor(totalNum >= 7 ? 190 : 30, totalNum >= 7 ? 24 : 41, totalNum >= 7 ? 93 : 59);
            doc.text(`선별 총점: ${sbqScore} (범위: 3~18점)`, 24, 127);
            doc.text(`선별 결과: ${sbqResult}`, 82, 127);

            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            doc.text(`채점 정책: ${sbqPolicy} (일반 인구 집단 기준 컷오프: 7점 이상 시 전문 상담 및 면담 확인 권장)`, 24, 133);

            // Table mini header
            doc.setFillColor(226, 232, 240);
            doc.rect(22, 136, 166, 6, 'F');
            doc.setFontSize(8);
            doc.setTextColor(51, 65, 85);
            doc.text('문항', 25, 140.5);
            doc.text('선별 문항 내용', 42, 140.5);
            doc.text('선택 응답 / 점수', 145, 140.5);

            const sbqResponses = Array.isArray(sbqData.responses) ? sbqData.responses.slice(0, 4) : [];
            let sbqY = 146.5;
            sbqResponses.forEach((resp, rIdx) => {
                doc.setFontSize(7.5);
                doc.setTextColor(71, 85, 105);
                doc.text(`Q${resp.questionNumber || rIdx + 1}`, 25, sbqY);
                const qText = resp.questionLabel ? String(resp.questionLabel).substring(0, 36) : `선별 문항 ${rIdx + 1}`;
                doc.text(qText, 42, sbqY);
                const scStr = resp.score !== undefined ? `${resp.score}점` : '-';
                const aText = resp.answerLabel ? String(resp.answerLabel).substring(0, 14) : scStr;
                doc.text(`${aText} (${scStr})`, 145, sbqY);
                sbqY += 5.2;
            });
        }

        // 3. 안내 문구 및 법적·임상적 안전 고지문
        doc.setFillColor(254, 242, 242);
        doc.rect(18, 184, 174, 58, 'F');
        doc.setDrawColor(254, 202, 202);
        doc.rect(18, 184, 174, 58, 'S');

        doc.setFontSize(9);
        doc.setTextColor(185, 28, 28);
        doc.text('【선별검사 안내 문구 및 법적·임상적 안전 고지문】', 22, 192);

        doc.setFontSize(8);
        doc.setTextColor(153, 27, 27);
        doc.text('1. 본 선별검진 결과는 의학적 진단(Diagnosis)이 아니며, 상담 조기 개입 및 심층 면담을 위한 참고자료입니다.', 24, 200);
        doc.text('2. 정신의학적 진단이나 약물 치료 필요 여부는 정신건강의학과 전문의의 정밀 임상 평가를 거쳐야 합니다.', 24, 207);
        doc.text('3. 선별 척도 점수가 기준점 미만이라 하더라도 주관적 고통이나 위기 가능성이 배제되지 않으므로,', 24, 214);
        doc.text('   내담자가 상담을 요청한 경우 정신건강 전문요원의 조기 면담 및 확인 절차가 필수적으로 진행됩니다.', 24, 221);
        doc.text('4. 본 문서는 개인정보보호법에 의거하여 비밀이 엄격히 보장되며, 승인된 목적 외 무단 열람·유출·복제를 엄금합니다.', 24, 228);
        doc.text('5. 자살 위험 신호(SBQ-R 기준점 이상 등)가 관찰되는 경우 기관 긴급위기대응 매뉴얼에 따라 즉시 연계 조치합니다.', 24, 235);

        // Neutral physical filename: survey-report_<UUID>.pdf
        const reportUuid = crypto.randomUUID();
        const filename = `survey-report_${reportUuid}.pdf`;

        // Page 3 Footer
        doc.setFontSize(7.5);
        doc.setTextColor(148, 163, 184);
        doc.text(`발급기관: ${this.institutionName} (${this.centerEnglish}) | [3 / 3 페이지]`, 18, 260);
        doc.text(`발급자 ID: ${actorId} | 처리엔진: ${this.systemName} v3.1 | 문서식별자: ${reportUuid}`, 18, 265);

        // Output Buffer
        const arrayBuf = doc.output('arraybuffer');
        const buffer = Buffer.from(arrayBuf);

        // Verification: ensure font was successfully embedded (OTF/TTF embedding produces >50KB)
        if (!buffer || buffer.length < 50000) {
            throw new Error(`KOREAN_FONT_LOAD_FAILED: PDF buffer verification failed (size: ${buffer?.length} bytes). Font embedding or rendering failed.`);
        }

        const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

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

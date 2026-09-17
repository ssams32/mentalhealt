/**
 * server/survey/surveyExportService.js
 * In-memory server-side XLSX export service with formula-injection defense (CWE-1236)
 * and permission-controlled privacy masking.
 */

import XLSX from 'xlsx';

/**
 * Formula Injection Sanitizer (CWE-1236)
 * Any string value beginning with '=', '+', '-', '@', '\t', or '\r' is escaped
 * with a leading single quote to prevent executable formula execution in spreadsheet software.
 */
export function sanitizeExcelCell(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // Check if starts with dangerous formula character (including leading spaces)
    if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(str.trimStart())) {
        return `'${str}`;
    }
    return str;
}

function maskName(name) {
    if (!name || typeof name !== 'string') return '-';
    const trimmed = name.trim();
    if (trimmed.length <= 1) return trimmed;
    if (trimmed.length === 2) return `${trimmed[0]}*`;
    return `${trimmed[0]}${'*'.repeat(trimmed.length - 2)}${trimmed[trimmed.length - 1]}`;
}

function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '-';
    return phone.replace(/(\d{2,3})-?(\d{3,4})-?(\d{4})/, '$1-****-$3');
}

export class SurveyExportService {
    /**
     * Generate an in-memory XLSX Buffer for survey submissions.
     * 
     * @param {Array<Object>} records - Merged survey submissions and ledger records
     * @param {Object} options
     * @param {boolean} options.isIdentifiable - Whether the user has permission to view unmasked PII
     * @returns {{ buffer: Buffer, filename: string, rowCount: number }}
     */
    generateExcelBuffer(records = [], { isIdentifiable = false } = {}) {
        const headers = [
            '내부접수ID',
            '외부제출ID',
            '접수일시',
            '수신일시',
            '내담자명',
            '연락처',
            '지역',
            '상담신청내용',
            '검진척도',
            '총점',
            '심각도/위험도',
            '상담진행상태',
            '담당직원',
            '배정일시',
            '배정우선순위',
            '개인정보동의',
            '민감정보동의',
            '동의버전',
            '보존만료예정일',
            '외부삭제상태'
        ];

        const rows = records.map(item => {
            const clientName = isIdentifiable
                ? item.contact?.clientName || '-'
                : maskName(item.contact?.clientName);

            const phone = isIdentifiable
                ? item.contact?.phone || '-'
                : maskPhone(item.contact?.phone);

            return [
                sanitizeExcelCell(item.internalSurveyId),
                sanitizeExcelCell(item.submissionId),
                sanitizeExcelCell(item.createdAt ? item.createdAt.substring(0, 16).replace('T', ' ') : '-'),
                sanitizeExcelCell(item.importedAt ? item.importedAt.substring(0, 16).replace('T', ' ') : '-'),
                sanitizeExcelCell(clientName),
                sanitizeExcelCell(phone), // Preserves text format & leading zeroes
                sanitizeExcelCell(item.contact?.region || '-'),
                sanitizeExcelCell(item.contact?.counselingRequestText || '-'),
                sanitizeExcelCell(item.assessmentId ? item.assessmentId.toUpperCase() : '-'),
                item.assessment?.totalScore !== undefined && item.assessment?.totalScore !== null
                    ? item.assessment.totalScore
                    : '-',
                sanitizeExcelCell(item.assessment?.severity || '-'),
                sanitizeExcelCell(item.consultationStatus || '-'),
                sanitizeExcelCell(item.assignedUserId || '미배정'),
                sanitizeExcelCell(item.assignedAt ? item.assignedAt.substring(0, 16).replace('T', ' ') : '-'),
                sanitizeExcelCell(item.assignmentPriority || 'NORMAL'),
                item.consentEvidence?.personalInfoConsent ? '동의' : '미동의',
                item.consentEvidence?.sensitiveInfoConsent ? '동의' : '미동의',
                sanitizeExcelCell(item.consentEvidence?.consentVersion || '-'),
                sanitizeExcelCell(item.retentionUntil ? item.retentionUntil.substring(0, 10) : '-'),
                sanitizeExcelCell(item.externalStatus || '-')
            ];
        });

        // Build XLSX workbook in-memory
        const sheetData = [headers, ...rows];
        const ws = (XLSX.default?.utils || XLSX.utils).aoa_to_sheet(sheetData);

        // Explicitly format column widths and text cells
        const colWidths = [
            { wch: 18 }, // 내부접수ID
            { wch: 20 }, // 외부제출ID
            { wch: 18 }, // 접수일시
            { wch: 18 }, // 수신일시
            { wch: 12 }, // 내담자명
            { wch: 16 }, // 연락처
            { wch: 14 }, // 지역
            { wch: 30 }, // 상담신청내용
            { wch: 12 }, // 검진척도
            { wch: 8 },  // 총점
            { wch: 14 }, // 심각도/위험도
            { wch: 14 }, // 상담진행상태
            { wch: 12 }, // 담당직원
            { wch: 18 }, // 배정일시
            { wch: 16 }, // 배정우선순위
            { wch: 12 }, // 개인정보동의
            { wch: 12 }, // 민감정보동의
            { wch: 10 }, // 동의버전
            { wch: 14 }, // 보존만료예정일
            { wch: 14 }  // 외부삭제상태
        ];
        ws['!cols'] = colWidths;

        const wb = (XLSX.default?.utils || XLSX.utils).book_new();
        (XLSX.default?.utils || XLSX.utils).book_append_sheet(wb, ws, '온라인설문_접수목록');

        // Write directly to in-memory Buffer (Zero temporary file on disk)
        const buffer = (XLSX.default || XLSX).write(wb, { type: 'buffer', bookType: 'xlsx' });

        // Neutral filename: online-surveys_YYYYMMDD_HHmm.xlsx
        const now = new Date();
        const yyyymmdd = now.toISOString().split('T')[0].replace(/-/g, '');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const filename = `online-surveys_${yyyymmdd}_${hh}${mm}.xlsx`;

        return {
            buffer,
            filename,
            rowCount: rows.length
        };
    }
}

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
            '이름',
            '연락처',
            '우울(PHQ-9)',
            '불안(GAD-7)',
            '수면(ISI-K)',
            '스트레스(BEPSI-K)',
            '자살위험(SBQ-R)'
        ];

        const rows = records.map(item => {
            const clientName = isIdentifiable
                ? item.contact?.clientName || '-'
                : maskName(item.contact?.clientName);

            const phone = isIdentifiable
                ? item.contact?.phone || '-'
                : maskPhone(item.contact?.phone);

            // Helper to get score if assessmentId matches (case-insensitive)
            const getScoreIfMatch = (targetId) => {
                if (!item.assessmentId) return '-';
                if (item.assessmentId.toLowerCase() === targetId.toLowerCase()) {
                    return item.assessment?.totalScore !== undefined && item.assessment?.totalScore !== null
                        ? item.assessment.totalScore
                        : '-';
                }
                return '-';
            };

            return [
                sanitizeExcelCell(clientName),
                sanitizeExcelCell(phone), // Preserves text format & leading zeroes
                sanitizeExcelCell(getScoreIfMatch('phq-9')),
                sanitizeExcelCell(getScoreIfMatch('gad-7')),
                sanitizeExcelCell(getScoreIfMatch('isi-k')),
                sanitizeExcelCell(getScoreIfMatch('bepsi-k')),
                sanitizeExcelCell(getScoreIfMatch('sbq-r'))
            ];
        });

        // Build XLSX workbook in-memory
        const sheetData = [headers, ...rows];
        const ws = (XLSX.default?.utils || XLSX.utils).aoa_to_sheet(sheetData);

        // Explicitly format column widths and text cells
        const colWidths = [
            { wch: 12 }, // 이름
            { wch: 16 }, // 연락처
            { wch: 8 },  // 우울(PHQ-9)
            { wch: 8 },  // 불안(GAD-7)
            { wch: 8 },  // 수면(ISI-K)
            { wch: 8 },  // 스트레스(BEPSI-K)
            { wch: 8 }   // 자살위험(SBQ-R)
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

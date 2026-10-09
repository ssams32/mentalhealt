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

        const rows = [];
        {
            // 1인 1행 집계: 동일인(personKey)별로 묶고,
            // 5개 점수 컬럼은 각 검사의 최신 submission의 assessment.totalScore로 채운다.
            // 응시하지 않은 검사는 '-' 유지.
            const ASSESSMENT_COLUMNS = ['phq-9', 'gad-7', 'isi-k', 'bepsi-k', 'sbq-r'];

            const digitsOf = (v) => String(v || '').replace(/\D/g, '');
            const personKeyOf = (item, index) => {
                const digits = digitsOf(item.contact?.phone);
                if (digits) return `phone:${digits}`;
                const name = String(item.contact?.clientName || '').trim();
                if (name) return `name:${name}`;
                // 식별 정보가 전혀 없으면 행별 분리 (서로 다른 익명 레코드 병합 방지)
                return `row:${index}`;
            };
            const effectiveTimeOf = (item) => {
                const t = item.importedAt || item.submittedAt || item.receivedAt;
                const ms = t ? Date.parse(t) : NaN;
                return Number.isNaN(ms) ? 0 : ms;
            };
            const scoreOf = (item, targetId) => {
                const a = item.assessment;
                if (!a || typeof a !== 'object') return '-';
                // 1. 직접 totalScore
                if (a.totalScore !== undefined && a.totalScore !== null) return a.totalScore;
                // 2. scores 서브오브젝트 (phq9, gad7, isi, bepsi, sbqr 등)
                const scores = a.scores;
                if (scores && typeof scores === 'object') {
                    const keyMap = {
                        'phq-9': ['phq9', 'phq'],
                        'gad-7': ['gad7', 'gad'],
                        'isi-k': ['isik', 'isi'],
                        'bepsi-k': ['bepsik', 'bepsi'],
                        'sbq-r': ['sbqr']
                    };
                    const keys = keyMap[targetId] || [];
                    for (const k of keys) {
                        const v = scores[k];
                        if (v !== undefined && v !== null) {
                            // 객체면 totalScore/total/mean 추출
                            if (typeof v === 'object') {
                                const inner = v.totalScore ?? v.total ?? v.meanScore ?? v.score;
                                if (inner !== undefined && inner !== null) return inner;
                            } else {
                                return v;
                            }
                        }
                    }
                }
                // 3. assessment 직접 키 (phq9, gad7 등)
                const directMap = {
                    'phq-9': ['phq9', 'phq'],
                    'gad-7': ['gad7', 'gad'],
                    'isi-k': ['isik', 'isi'],
                    'bepsi-k': ['bepsik', 'bepsi'],
                    'sbq-r': ['sbqr']
                };
                const dKeys = directMap[targetId] || [];
                for (const k of dKeys) {
                    const v = a[k];
                    if (v !== undefined && v !== null) {
                        if (typeof v === 'object') {
                            const inner = v.totalScore ?? v.total ?? v.meanScore ?? v.score;
                            if (inner !== undefined && inner !== null) return inner;
                        } else {
                            return v;
                        }
                    }
                }
                // 4. scaleScores 배열
                if (Array.isArray(a.scaleScores)) {
                    const found = a.scaleScores.find((s) =>
                        String(s.scaleId || s.id || '').toLowerCase() === targetId
                    );
                    if (found) {
                        const v = found.totalScore ?? found.total ?? found.score;
                        if (v !== undefined && v !== null) return v;
                    }
                }
                return '-';
            };

            const groups = new Map(); // personKey -> [{ item, time }]
            records.forEach((item, index) => {
                if (!item) return;
                const key = personKeyOf(item, index);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ item, time: effectiveTimeOf(item) });
            });

            for (const entries of groups.values()) {
                // 최신순 정렬 (Array.prototype.sort는 stable → 동점 시 입력 순서 유지)
                const sorted = [...entries].sort((a, b) => b.time - a.time);
                const latest = sorted[0].item;

                const clientName = isIdentifiable
                    ? latest.contact?.clientName || '-'
                    : maskName(latest.contact?.clientName);

                const phone = isIdentifiable
                    ? latest.contact?.phone || '-'
                    : maskPhone(latest.contact?.phone);

                const scoreCells = ASSESSMENT_COLUMNS.map((targetId) => {
                    const match = sorted.find(({ item }) =>
                        String(item.assessmentId || '').toLowerCase() === targetId
                    );
                    return match ? scoreOf(match.item, targetId) : '-';
                });

                rows.push([
                    sanitizeExcelCell(clientName),
                    sanitizeExcelCell(phone), // Preserves text format & leading zeroes
                    ...scoreCells.map((s) => sanitizeExcelCell(s))
                ]);
            }
        }

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

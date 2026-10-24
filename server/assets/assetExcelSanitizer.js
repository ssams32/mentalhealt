/**
 * server/assets/assetExcelSanitizer.js — Stage 3
 * utils/assetExcelSanitizer.ts의 서버(JS) 미러. Stage 1·2의 상태머신 미러와 같은
 * 이중 유지 패턴이다: 수식 주입 방어 규칙이 바뀌면 TS본과 이 파일을 함께 고친다.
 * 가져오기 검증(경고 + 중화)과 내보내기(텍스트 셀 중화, 숫자 셀은 숫자 유지)에서 쓴다.
 */

const DANGEROUS_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function sanitizeExcelCell(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.length === 0) return '';
    if (DANGEROUS_FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) {
        return `'${str}`;
    }
    return str;
}

export function containsFormulaInjectionRisk(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    return DANGEROUS_FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** 내보내기 셀: 숫자는 숫자 타입 유지, 그 외는 텍스트로 중화한다 (원본 formatExportCell). */
export function formatExportCell(value) {
    if (typeof value === 'number') return value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    return sanitizeExcelCell(value);
}

/** CSV 셀: 따옴표·쉼표·개행이 있으면 큰따옴표로 감싸고 내부 따옴표는 두 배로 한다. */
export function csvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

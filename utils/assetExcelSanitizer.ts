/**
 * assetExcelSanitizer.ts — Stage 1 이식본 (로직 무변경)
 * 원본: ~/workspace/office-asset-fullstack/src/lib/excel-sanitizer.ts
 * 수식 주입 방어. Stage 1에서는 아직 사용하지 않으며 Stage 3 엑셀 입출력에서 사용한다.
 */

const DANGEROUS_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function sanitizeExcelCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length === 0) return '';
  if (DANGEROUS_FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) {
    return `'${str}`;
  }
  return str;
}

export function containsFormulaInjectionRisk(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return DANGEROUS_FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

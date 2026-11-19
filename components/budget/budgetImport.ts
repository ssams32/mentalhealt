/**
 * Parses a money cell. Never returns NaN (unparseable -> 0).
 * A leading '-', '△', '▲' or surrounding parentheses mean negative: '(1,000)' -> -1000.
 */
export function parseAmount(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const text = String(value ?? '').trim();
    const isNegative = /^[-−△▲]/.test(text) || /^\(.*\)$/.test(text);
    const magnitude = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(magnitude)) return 0;
    return isNegative ? -magnitude : magnitude;
}

/** Date (YYYY-MM-DD) from the first 8 digits of an approval number, or '' when they are not a date. */
export function parseApprovalDate(approvalNo: string): string {
    const match = approvalNo.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!match) return '';
    const [, year, month, day] = match;
    const isCalendarDate = Number(year) >= 1900 && Number(year) <= 2100
        && Number(month) >= 1 && Number(month) <= 12
        && Number(day) >= 1 && Number(day) <= 31;
    return isCalendarDate ? `${year}-${month}-${day}` : '';
}

/**
 * Merges an uploaded proposal list into the stored one: only the years present in `incoming` are replaced.
 * Other years and hand-added rows (type '수기입력') are kept.
 */
export function mergeTransactionsByYear<T extends { type: string }>(
    existing: T[],
    incoming: T[],
    getYear: (t: T) => number
): { merged: T[]; replacedYears: number[]; keptCount: number } {
    const replacedYears = Array.from(new Set(incoming.map(getYear))).sort((a, b) => a - b);
    const kept = existing.filter(t => t.type === '수기입력' || !replacedYears.includes(getYear(t)));
    return { merged: [...incoming, ...kept], replacedYears, keptCount: kept.length };
}

export interface GridEntry {
    id: string;
    date: string;
    writer: string;
    amount: number;
    description: string;
    isPlaceholder?: boolean;
}

export function firstFilledEntry<T extends GridEntry>(entries: T[]): T | undefined {
    return entries.find(e => e.amount !== 0 || e.description.trim() !== '');
}

export type GridField = 'date' | 'writer' | 'amount' | 'description';
const GRID_FIELDS: GridField[] = ['date', 'writer', 'amount', 'description'];

/**
 * Pastes tab/newline separated rows into the grid without overwriting filled rows:
 * lines go into blank placeholder rows from the focused row onward, then into newly appended rows.
 * Returns a new array.
 */
export function pasteIntoGrid<T extends GridEntry>(
    entries: T[],
    focusedId: string,
    startField: GridField,
    lines: string[],
    makeBlankRow: (lineIndex: number) => T
): T[] {
    const result = [...entries];
    const focusedIndex = result.findIndex(e => e.id === focusedId);
    const blankRowIndexes = result
        .map((e, index) => ({ e, index }))
        .filter(({ e, index }) => index >= focusedIndex && e.isPlaceholder && e.amount === 0 && e.description.trim() === '')
        .map(({ index }) => index);

    lines.forEach((line, lineIndex) => {
        const rowIndex = lineIndex < blankRowIndexes.length ? blankRowIndexes[lineIndex] : result.length;
        const row = { ...(result[rowIndex] || makeBlankRow(lineIndex)), isPlaceholder: false };
        line.split('\t').forEach((cell, cellIndex) => {
            const field = GRID_FIELDS[GRID_FIELDS.indexOf(startField) + cellIndex];
            if (field === 'amount') row.amount = parseAmount(cell);
            else if (field) row[field] = cell.trim();
        });
        result[rowIndex] = row;
    });

    return result;
}

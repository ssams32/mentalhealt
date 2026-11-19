import type { ReferralNote } from '../types';

export const sanitizeExcelCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    const startsWithFormulaTrigger = /^[=+\-@\t\r]/.test(text) || /^[=+\-@]/.test(text.trimStart());
    return startsWithFormulaTrigger ? `'${text}` : text;
};

const sanitizeExcelValue = (value: unknown): unknown =>
    typeof value === 'string' ? sanitizeExcelCell(value) : value ?? '';

export const sanitizeExcelRows = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map(row =>
        Object.fromEntries(Object.entries(row).map(([header, value]) => [sanitizeExcelCell(header), sanitizeExcelValue(value)]))
    );

interface WorksheetCell {
    t?: string;
    v?: unknown;
    w?: string;
    f?: string;
}

export const sanitizeWorksheetStrings = (worksheet: Record<string, WorksheetCell>): void => {
    Object.entries(worksheet).forEach(([address, cell]) => {
        if (address.startsWith('!')) return;
        delete cell.f;
        if (cell.t !== 's' || typeof cell.v !== 'string') return;
        cell.v = sanitizeExcelCell(cell.v);
        cell.w = cell.v as string;
    });
};

const KOREAN_LOCALE_TIMESTAMP = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2}):(\d{2})/;

const noteTimestamp = (createdAt: string): number => {
    const korean = createdAt.match(KOREAN_LOCALE_TIMESTAMP);
    if (!korean) return new Date(createdAt).getTime();
    const [, year, month, day, meridiem, hour, minute, second] = korean;
    const hour24 = (Number(hour) % 12) + (meridiem === '오후' ? 12 : 0);
    return new Date(Number(year), Number(month) - 1, Number(day), hour24, Number(minute), Number(second)).getTime();
};

export const latestNoteContent = (notes: ReferralNote[]): string => {
    const dated = notes
        .map(note => ({ note, time: noteTimestamp(note.createdAt) }))
        .filter(entry => !Number.isNaN(entry.time));
    if (dated.length === 0) return notes[0]?.content ?? '';
    return dated.reduce((latest, entry) => (entry.time > latest.time ? entry : latest)).note.content;
};

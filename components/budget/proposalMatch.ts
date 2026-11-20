import type { BudgetTransaction } from '../../types';

export interface ManualEntryLike {
    id?: string;
    date: string;
    writer?: string;
    amount: number | string;
    description?: string;
    isPlaceholder?: boolean;
    approvalNo?: string;
}

export type ProposalMatchStatus =
    | 'skipped'     // 빈 행 (-)
    | 'matched'     // 정확 일치 (초록)
    | 'other-item'  // 다른 과목 (주황)
    | 'date-only'   // 날짜만 맞음 (노랑)
    | 'amount-only' // 금액만 맞음 (노랑)
    | 'duplicate'
    | 'no-match';   // 품의 없음 (회색)

export interface ProposalMatchResult {
    status: ProposalMatchStatus;
    badgeText: string;
    detailText: string;
    matchedProposal?: BudgetTransaction;
    matchedCount: number;
}

/**
 * 예산과목 정규화 (앞뒤 공백 제거, '외 N건' 접미사 제거)
 */
export function normalizeBudgetItem(name?: string): string {
    if (!name) return '';
    return name.trim().replace(/[\s\u00A0]*외[\s\u00A0]*\d+[\s\u00A0]*건.*$/, '').trim();
}

function normalizeDepartmentName(name?: string): string {
    const text = (name || '').trim();
    if (!text) return '';
    if (text.includes('증진')) return '증진';
    if (text.includes('회복')) return '회복';
    if (text.includes('자살')) return '자살';
    if (text.includes('남부')) return '남부';
    if (text.includes('아동')) return '아동청소년';
    return text.replace(/팀$/, '').trim();
}

/**
 * 두 예산과목이 실질적으로 동일한지 대조
 */
export function isSameBudgetItem(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    const normA = normalizeBudgetItem(a);
    const normB = normalizeBudgetItem(b);
    return normA !== '' && normA === normB;
}

/**
 * 수기 지출 내역 행을 품의 내역 목록과 크로스체크 대조하는 순수 함수.
 *
 * 규칙:
 * 1. 빈 행 건너뛰기: isPlaceholder이고 금액이 0이며 적요가 비어있으면 'skipped' ('-')
 * 2. 정확 일치 (날짜 + 금액 일치):
 *    - 모달 과목과 일치하면 'matched' ('일치' + 품의번호 + 적요)
 *    - 다른 과목에만 있으면 'other-item' ('다른 과목' + 품의번호 + 과목명)
 *    - 여러 건이면 첫 번째 표시 후 "외 N건"
 * 3. 부분 일치 (정확 일치 없을 때, 같은 과목 안에서만 탐색):
 *    - 날짜만 일치: 'date-only' ('날짜만 맞음' + 해당 품의 금액)
 *    - 금액만 일치: 'amount-only' ('금액만 맞음' + 해당 품의 날짜)
 *    - 여러 건이면 "외 N건"
 * 4. 일치 없음: 'no-match' ('품의 없음')
 *
 * 화면 표시 전용 순수 함수 (저장/수정/삭제 부수효과 없음).
 */
export function matchManualEntryToProposal(
    entry: ManualEntryLike | null | undefined,
    transactions: BudgetTransaction[] = [],
    budgetItem?: string,
    department?: string,
    usedProposals?: Set<BudgetTransaction>
): ProposalMatchResult {
    if (!entry) {
        return {
            status: 'skipped',
            badgeText: '-',
            detailText: '',
            matchedCount: 0
        };
    }

    const isPlaceholder = Boolean(entry.isPlaceholder);
    const entryAmount = Number(entry.amount) || 0;
    const isAmountZero = entryAmount === 0;
    const isDescEmpty = !entry.description || entry.description.trim() === '';

    // 1. 빈 행 건너뛰기
    if (isPlaceholder && isAmountZero && isDescEmpty) {
        return {
            status: 'skipped',
            badgeText: '-',
            detailText: '',
            matchedCount: 0
        };
    }

    const entryDate = typeof entry.date === 'string' ? entry.date.trim() : '';
    const entryDepartment = normalizeDepartmentName(department);
    const safeTransactions = (Array.isArray(transactions) ? transactions : [])
        .filter(t => !entryDepartment || normalizeDepartmentName(t.department) === entryDepartment);

    // 2. 정확 일치 (날짜 + 금액 동시 일치)
    const exactMatches = safeTransactions.filter(t => {
        if (!t || !t.date) return false;
        return t.date.trim() === entryDate && Number(t.amount) === entryAmount;
    });

    if (exactMatches.length > 0) {
        const hasBudgetItemFilter = Boolean(budgetItem && budgetItem.trim() !== '');
        const sameItemMatches = hasBudgetItemFilter
            ? exactMatches.filter(t => isSameBudgetItem(t.budgetItem, budgetItem))
            : exactMatches;

        const freeItemMatches = sameItemMatches.filter(t => !usedProposals || !usedProposals.has(t));

        if (sameItemMatches.length > 0 && freeItemMatches.length === 0) {
            const primary = sameItemMatches[0];
            const appNo = primary.approvalNo ? primary.approvalNo.trim() : '';
            return {
                status: 'duplicate',
                badgeText: '중복 의심',
                detailText: appNo ? `${appNo} 이미 다른 행과 일치` : '이미 다른 행과 일치',
                matchedProposal: primary,
                matchedCount: 0
            };
        }

        if (freeItemMatches.length > 0) {
            const primary = freeItemMatches[0];
            const extra = freeItemMatches.length - 1;
            const appNo = primary.approvalNo ? primary.approvalNo.trim() : '';
            const desc = primary.description ? primary.description.trim() : '';

            let detail = appNo ? (desc ? `${appNo} ${desc}` : appNo) : desc;
            if (extra > 0) {
                detail = detail ? `${detail} 외 ${extra}건` : `외 ${extra}건`;
            }

            return {
                status: 'matched',
                badgeText: '일치',
                detailText: detail,
                matchedProposal: primary,
                matchedCount: freeItemMatches.length
            };
        }

        // 같은 과목에는 없고 다른 과목에만 있음
        const primary = exactMatches[0];
        const extra = exactMatches.length - 1;
        const appNo = primary.approvalNo ? primary.approvalNo.trim() : '';
        const item = primary.budgetItem ? primary.budgetItem.trim() : '다른 과목';

        let detail = appNo ? `${appNo} (${item})` : `(${item})`;
        if (extra > 0) {
            detail = `${detail} 외 ${extra}건`;
        }

        return {
            status: 'other-item',
            badgeText: '다른 과목',
            detailText: detail,
            matchedProposal: primary,
            matchedCount: exactMatches.length
        };
    }

    // 3. 부분 일치 (정확 일치가 없을 때만, 같은 과목 안에서만 탐색)
    const hasBudgetItemFilter = Boolean(budgetItem && budgetItem.trim() !== '');
    const candidatePool = hasBudgetItemFilter
        ? safeTransactions.filter(t => isSameBudgetItem(t.budgetItem, budgetItem))
        : safeTransactions;

    // 3-1. 날짜만 일치 (금액 다름)
    const dateMatches = candidatePool.filter(t => {
        if (!t || !t.date || !entryDate) return false;
        return t.date.trim() === entryDate && Number(t.amount) !== entryAmount;
    });

    if (dateMatches.length > 0) {
        const primary = dateMatches[0];
        const extra = dateMatches.length - 1;
        const amtStr = `${Number(primary.amount || 0).toLocaleString()}원`;
        const detail = extra > 0 ? `${amtStr} 외 ${extra}건` : amtStr;

        return {
            status: 'date-only',
            badgeText: '날짜만 맞음',
            detailText: detail,
            matchedProposal: primary,
            matchedCount: dateMatches.length
        };
    }

    // 3-2. 금액만 일치 (금액은 0이 아니고, 날짜가 다름)
    const amountMatches = candidatePool.filter(t => {
        if (!t || entryAmount === 0) return false;
        const tDate = t.date ? t.date.trim() : '';
        return Number(t.amount) === entryAmount && tDate !== entryDate;
    });

    if (amountMatches.length > 0) {
        const primary = amountMatches[0];
        const extra = amountMatches.length - 1;
        const dateStr = primary.date ? primary.date.trim() : '';
        const detail = extra > 0 ? `${dateStr} 외 ${extra}건` : dateStr;

        return {
            status: 'amount-only',
            badgeText: '금액만 맞음',
            detailText: detail,
            matchedProposal: primary,
            matchedCount: amountMatches.length
        };
    }

    // 4. 일치 없음
    return {
        status: 'no-match',
        badgeText: '품의 없음',
        detailText: '',
        matchedCount: 0
    };
}

export interface BuiltManualEntry {
    id: string;
    date: string;
    writer: string;
    amount: number;
    description: string;
    approvalNo: string;
}

/**
 * 품의 1건을 수기 지출 내역 행으로 변환한다 (1클릭 자동 입력용).
 * - date / writer / amount는 품의 값을 그대로 복사 (amount는 숫자로 변환).
 * - description: 품의번호가 있으면 `[품의번호] 적요` 형태, 없으면 적요 그대로.
 *   적요가 비어 있으면 품의번호만 `[품의번호]`로 둔다.
 * - id는 기존 수기 행 생성 방식(Date.now 기반)을 따른다.
 * - isPlaceholder는 넣지 않는다 (바로 저장되는 실제 행이기 때문).
 */
export function buildManualEntryFromProposal(t: BudgetTransaction): BuiltManualEntry {
    const appNo = t.approvalNo ? t.approvalNo.trim() : '';
    const desc = t.description ? t.description.trim() : '';
    const description = appNo ? (desc ? `[${appNo}] ${desc}` : `[${appNo}]`) : desc;
    return {
        id: Date.now().toString(),
        date: typeof t.date === 'string' ? t.date.trim() : '',
        writer: t.writer || '',
        amount: Number(t.amount) || 0,
        description,
        approvalNo: appNo
    };
}

/**
 * 해당 품의와 날짜+금액이 같은 수기 행이 이미 있는지 찾는다 (이중 입력 방지용).
 * - 빈 행(금액 0 + 적요 없음)과 placeholder 행은 무시한다.
 * - 금액은 숫자로, 날짜는 문자열 그대로 비교한다.
 * - 과목 스코프는 호출하는 쪽에서 이미 해당 과목의 manualEntries만 넘기므로
 *   이 함수 안에서는 과목 비교를 하지 않는다.
 * - 있으면 그 행, 없으면 null을 반환한다.
 */
export function findManualEntryForProposal(
    t: BudgetTransaction | null | undefined,
    manualEntries: ManualEntryLike[] = []
): ManualEntryLike | null {
    if (!t) return null;
    const tDate = typeof t.date === 'string' ? t.date.trim() : '';
    const tAmount = Number(t.amount);
    if (!tDate || Number.isNaN(tAmount)) return null;
    const list = Array.isArray(manualEntries) ? manualEntries : [];
    for (const e of list) {
        if (!e || e.isPlaceholder) continue;
        const eAmount = Number(e.amount) || 0;
        const eDescEmpty = !e.description || e.description.trim() === '';
        if (eAmount === 0 && eDescEmpty) continue; // 빈 행 무시
        const eDate = typeof e.date === 'string' ? e.date.trim() : '';
        if (eDate === tDate && eAmount === tAmount) return e;
    }
    return null;
}

/**
 * Cross-checks all manual rows at once so that one proposal is matched by at most one row.
 * Rows are paired earliest date first; a row whose proposals are all taken gets status 'duplicate'.
 * Results are returned in the order of `entries`.
 */
export function matchManualEntriesToProposals(
    entries: ManualEntryLike[],
    transactions: BudgetTransaction[],
    budgetItem?: string,
    department?: string
): ProposalMatchResult[] {
    const usedProposals = new Set<BudgetTransaction>();
    const results: ProposalMatchResult[] = [];
    entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.index - b.index)
        .forEach(({ entry, index }) => {
            const result = matchManualEntryToProposal(entry, transactions, budgetItem, department, usedProposals);
            if (result.status === 'matched' && result.matchedProposal) usedProposals.add(result.matchedProposal);
            results[index] = result;
        });
    return results;
}

/**
 * Whether proposal `t` already has its own manual row, given the proposals sharing its plan, date and amount.
 * A row tagged `[approvalNo]` belongs to that proposal; untagged rows are assigned to the remaining proposals in order.
 */
export function isProposalEntered(
    t: BudgetTransaction,
    manualEntries: ManualEntryLike[],
    sameCellProposals: BudgetTransaction[]
): boolean {
    const isTaggedWith = (e: ManualEntryLike, p: BudgetTransaction) =>
        p.approvalNo.trim() !== '' && (e.description || '').includes(`[${p.approvalNo.trim()}]`);
    const matchingEntries = manualEntries.filter(e => findManualEntryForProposal(t, [e]) !== null);
    if (matchingEntries.some(e => isTaggedWith(e, t))) return true;

    const otherProposals = sameCellProposals.filter(p => p !== t);
    const untaggedEntries = matchingEntries.filter(e => !otherProposals.some(p => isTaggedWith(e, p)));
    const proposalsAheadOfThis = otherProposals
        .slice(0, Math.max(sameCellProposals.indexOf(t), 0))
        .filter(p => !matchingEntries.some(e => isTaggedWith(e, p)));
    return proposalsAheadOfThis.length < untaggedEntries.length;
}

import type { BudgetTransaction } from '../../types';

export interface ManualEntryLike {
    id?: string;
    date: string;
    writer?: string;
    amount: number | string;
    description?: string;
    isPlaceholder?: boolean;
}

export type ProposalMatchStatus =
    | 'skipped'     // 빈 행 (-)
    | 'matched'     // 정확 일치 (초록)
    | 'other-item'  // 다른 과목 (주황)
    | 'date-only'   // 날짜만 맞음 (노랑)
    | 'amount-only' // 금액만 맞음 (노랑)
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
    let normalized = name.trim();
    if (normalized.includes(' 외 ')) {
        normalized = normalized.split(' 외 ')[0].trim();
    } else {
        normalized = normalized.replace(/[\s\u00A0]*외[\s\u00A0]*\d+[\s\u00A0]*건\s*$/, '').trim();
    }
    return normalized;
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
    budgetItem?: string
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
    const safeTransactions = Array.isArray(transactions) ? transactions : [];

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

        if (sameItemMatches.length > 0) {
            const primary = sameItemMatches[0];
            const extra = sameItemMatches.length - 1;
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
                matchedCount: sameItemMatches.length
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

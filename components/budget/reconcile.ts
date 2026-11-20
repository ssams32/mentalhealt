import type { BudgetTransaction } from '../../types';
import { getPlanYear, getTransactionYear, normalizeBudgetItem, normalizeDepartmentName } from './budgetYear';

export interface ReconcileEntry {
    id: string;
    date: string;
    writer?: string;
    amount: number | string;
    description?: string;
    isPlaceholder?: boolean;
    approvalNo?: string;
}

export interface ReconcilePlan {
    department: string;
    budgetItem: string;
    manualEntries?: ReconcileEntry[];
    year?: number;
}

export type LinkSource = 'linked' | 'tagged' | 'auto';

export interface SpendingRow {
    plan: ReconcilePlan;
    entry: ReconcileEntry;
    amount: number;
    linkSource?: LinkSource;
}

export type ProposalStatus = 'matched' | 'amount-diff' | 'proposal-only';

export interface ProposalRow {
    proposal: BudgetTransaction;
    status: ProposalStatus;
    spendings: SpendingRow[];
    spent: number;
    difference: number;
    hasPlan: boolean;
}

export interface UnlinkedSpendingRow extends SpendingRow {
    suggestions: BudgetTransaction[];
}

export interface ReconcileResult {
    proposals: ProposalRow[];
    unlinkedSpendings: UnlinkedSpendingRow[];
}

export const MANUAL_TRANSACTION_TYPE = '수기입력';
const APPROVAL_TAG = /\[([^\]]+)\]/;
const MAX_SUGGESTIONS = 3;

const sameCell = (plan: ReconcilePlan, proposal: BudgetTransaction) =>
    normalizeDepartmentName(plan.department) === normalizeDepartmentName(proposal.department) &&
    normalizeBudgetItem(plan.budgetItem) !== '' &&
    normalizeBudgetItem(plan.budgetItem) === normalizeBudgetItem(proposal.budgetItem);

const isRealEntry = (entry: ReconcileEntry) =>
    !entry.isPlaceholder && (Number(entry.amount) !== 0 || (entry.description || '').trim() !== '');

const daysBetween = (a: string, b: string) => {
    const diff = Date.parse(a) - Date.parse(b);
    return Number.isNaN(diff) ? Number.MAX_SAFE_INTEGER : Math.abs(diff) / 86_400_000;
};

/**
 * The approval number a spending row points at, if any.
 * `approvalNo === ''` means a staff member explicitly unlinked the row, so neither the
 * description tag nor automatic date+amount matching may link it again.
 */
export function linkedApprovalNo(entry: ReconcileEntry): string | null | undefined {
    if (entry.approvalNo === '') return null;
    if (entry.approvalNo) return entry.approvalNo.trim();
    const tag = (entry.description || '').match(APPROVAL_TAG);
    return tag ? tag[1].trim() : undefined;
}

/**
 * Pairs the ERP proposals of `year` with the spending rows staff entered for that year.
 * A row links to a proposal by its stored approval number, then by a `[번호]` tag in its
 * description, then automatically when department, budget item, date and amount are all equal
 * (at most one automatic row per proposal). One proposal may collect several rows (split payments).
 */
export function reconcileBudget(
    year: number,
    transactions: BudgetTransaction[],
    plans: ReconcilePlan[]
): ReconcileResult {
    const proposals = transactions.filter(t => t.type !== MANUAL_TRANSACTION_TYPE && getTransactionYear(t) === year);
    const yearPlans = plans.filter(p => getPlanYear(p) === year);

    const proposalByNo = new Map<string, BudgetTransaction>();
    proposals.forEach(p => {
        const no = (p.approvalNo || '').trim();
        if (no && !proposalByNo.has(no)) proposalByNo.set(no, p);
    });

    const spendingsByProposal = new Map<BudgetTransaction, SpendingRow[]>(proposals.map(p => [p, []]));
    const unlinked: SpendingRow[] = [];
    const waitingForAutoMatch: SpendingRow[] = [];

    yearPlans.forEach(plan => {
        (plan.manualEntries || []).filter(isRealEntry).forEach(entry => {
            const row: SpendingRow = { plan, entry, amount: Number(entry.amount) || 0 };
            const no = linkedApprovalNo(entry);
            const target = no ? proposalByNo.get(no) : undefined;
            if (target) {
                spendingsByProposal.get(target)!.push({ ...row, linkSource: entry.approvalNo ? 'linked' : 'tagged' });
            } else if (no === null) {
                unlinked.push(row);
            } else {
                waitingForAutoMatch.push(row);
            }
        });
    });

    waitingForAutoMatch
        .sort((a, b) => a.entry.date.localeCompare(b.entry.date))
        .forEach(row => {
            const target = proposals.find(p =>
                !spendingsByProposal.get(p)!.some(s => s.linkSource === 'auto') &&
                sameCell(row.plan, p) &&
                (p.date || '').trim() === (row.entry.date || '').trim() &&
                Number(p.amount) === row.amount
            );
            if (target) spendingsByProposal.get(target)!.push({ ...row, linkSource: 'auto' });
            else unlinked.push(row);
        });

    const proposalRows: ProposalRow[] = proposals.map(proposal => {
        const spendings = spendingsByProposal.get(proposal)!;
        const spent = spendings.reduce((sum, s) => sum + s.amount, 0);
        const difference = (Number(proposal.amount) || 0) - spent;
        const status: ProposalStatus = spendings.length === 0 ? 'proposal-only' : difference === 0 ? 'matched' : 'amount-diff';
        return { proposal, status, spendings, spent, difference, hasPlan: yearPlans.some(plan => sameCell(plan, proposal)) };
    });

    const remainingByProposal = new Map(proposalRows.map(r => [r.proposal, r.difference]));
    const unlinkedSpendings = [...unlinked].sort((a, b) => a.entry.date.localeCompare(b.entry.date)).map(row => ({
        ...row,
        suggestions: proposals
            .filter(p => sameCell(row.plan, p))
            .sort((a, b) =>
                Math.abs(remainingByProposal.get(a)! - row.amount) - Math.abs(remainingByProposal.get(b)! - row.amount) ||
                daysBetween(a.date, row.entry.date) - daysBetween(b.date, row.entry.date))
            .slice(0, MAX_SUGGESTIONS),
    }));

    return { proposals: proposalRows, unlinkedSpendings };
}

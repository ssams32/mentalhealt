import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import type { BudgetTransaction } from '../../types';
import { sanitizeExcelRows } from '../../utils/excelSanitize';
import { normalizeBudgetItem, normalizeDepartmentName } from './budgetYear';
import type { ProposalRow, ProposalStatus, ReconcilePlan, ReconcileResult, SpendingRow, UnlinkedSpendingRow } from './reconcile';

type View = ProposalStatus | 'spending-only' | 'all';

interface BudgetReconcileTabProps {
    year: number;
    result: ReconcileResult;
    departments?: string[];
    savingProposalId: string | null;
    onEnterProposal: (proposal: BudgetTransaction) => void;
    onLinkSpending: (plan: ReconcilePlan, entryId: string, approvalNo: string) => Promise<void>;
}

const VIEWS: { view: View; label: string; hint: string; tone: string }[] = [
    { view: 'proposal-only', label: '품의만 있음', hint: '품의는 있는데 지출 기록이 없음', tone: 'rose' },
    { view: 'spending-only', label: '지출만 있음', hint: '지출은 적었는데 연결된 품의가 없음', tone: 'amber' },
    { view: 'amount-diff', label: '금액 차이', hint: '품의 금액과 실제 지출 합계가 다름', tone: 'orange' },
    { view: 'matched', label: '일치', hint: '품의 금액과 지출 합계가 같음', tone: 'emerald' },
    { view: 'all', label: '전체 품의', hint: '이 연도의 ERP 품의 전체', tone: 'slate' },
];

const TONE: Record<string, { card: string; badge: string }> = {
    rose: { card: 'border-rose-300 bg-rose-50', badge: 'bg-rose-100 text-rose-700' },
    amber: { card: 'border-amber-300 bg-amber-50', badge: 'bg-amber-100 text-amber-700' },
    orange: { card: 'border-orange-300 bg-orange-50', badge: 'bg-orange-100 text-orange-700' },
    emerald: { card: 'border-emerald-300 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700' },
    slate: { card: 'border-slate-300 bg-slate-50', badge: 'bg-slate-100 text-slate-700' },
};

const STATUS_VIEW: Record<ProposalStatus, (typeof VIEWS)[number]> = {
    'proposal-only': VIEWS[0],
    'amount-diff': VIEWS[2],
    matched: VIEWS[3],
};

const LINK_SOURCE_LABEL: Record<NonNullable<SpendingRow['linkSource']>, string> = {
    linked: '직접 연결',
    tagged: '품의번호 표기',
    auto: '날짜·금액 자동',
};

const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
const monthOf = (date: string) => (date || '').slice(0, 7);

function StatusBadge({ status }: { status: ProposalStatus }) {
    const v = STATUS_VIEW[status];
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${TONE[v.tone].badge}`}>{v.label}</span>;
}

export default function BudgetReconcileTab({
    year, result, departments, savingProposalId, onEnterProposal, onLinkSpending,
}: BudgetReconcileTabProps) {
    const [view, setView] = useState<View>('proposal-only');
    const [month, setMonth] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [chosenProposal, setChosenProposal] = useState<Record<string, string>>({});
    const [linkingEntryId, setLinkingEntryId] = useState<string | null>(null);

    const departmentFilter = (departments || []).map(normalizeDepartmentName);
    const keyword = search.trim().toLowerCase();
    const passes = (department: string, date: string, texts: (string | undefined)[]) =>
        (departmentFilter.length === 0 || departmentFilter.includes(normalizeDepartmentName(department))) &&
        (!month || monthOf(date) === month) &&
        (!keyword || texts.some(t => (t || '').toLowerCase().includes(keyword)));

    const proposalRows = result.proposals.filter(r => passes(r.proposal.department, r.proposal.date,
        [r.proposal.approvalNo, r.proposal.description, r.proposal.budgetItem, r.proposal.vendor, r.proposal.writer]));
    const spendingRows = result.unlinkedSpendings.filter(r => passes(r.plan.department, r.entry.date,
        [r.entry.description, r.plan.budgetItem, r.entry.writer]));

    const counts: Record<View, { count: number; amount: number }> = {
        'proposal-only': { count: 0, amount: 0 },
        'amount-diff': { count: 0, amount: 0 },
        matched: { count: 0, amount: 0 },
        all: { count: proposalRows.length, amount: proposalRows.reduce((s, r) => s + (Number(r.proposal.amount) || 0), 0) },
        'spending-only': { count: spendingRows.length, amount: spendingRows.reduce((s, r) => s + r.amount, 0) },
    };
    proposalRows.forEach(r => {
        counts[r.status].count += 1;
        counts[r.status].amount += r.status === 'amount-diff' ? Math.abs(r.difference) : Number(r.proposal.amount) || 0;
    });

    const months = useMemo(() => {
        const set = new Set<string>();
        result.proposals.forEach(r => set.add(monthOf(r.proposal.date)));
        result.unlinkedSpendings.forEach(r => set.add(monthOf(r.entry.date)));
        return [...set].filter(Boolean).sort();
    }, [result]);

    const visibleProposals = view === 'all' ? proposalRows : proposalRows.filter(r => r.status === view);

    const link = async (row: SpendingRow, approvalNo: string) => {
        setLinkingEntryId(row.entry.id);
        try {
            await onLinkSpending(row.plan, row.entry.id, approvalNo);
        } finally {
            setLinkingEntryId(null);
        }
    };

    const linkOptionsFor = (row: UnlinkedSpendingRow) => {
        const suggested = new Set(row.suggestions);
        const sameDepartment = result.proposals
            .map(r => r.proposal)
            .filter(p => !suggested.has(p) && normalizeDepartmentName(p.department) === normalizeDepartmentName(row.plan.department))
            .sort((a, b) => a.date.localeCompare(b.date));
        return { suggested: row.suggestions, others: sameDepartment };
    };

    const proposalLabel = (p: BudgetTransaction) =>
        `${p.approvalNo} · ${p.date} · ${normalizeBudgetItem(p.budgetItem)} · ${won(Number(p.amount) || 0)}${p.description ? ` · ${p.description}` : ''}`;

    const exportIssues = () => {
        const rows: Record<string, unknown>[] = [];
        proposalRows.filter(r => r.status !== 'matched').forEach(r => rows.push({
            구분: STATUS_VIEW[r.status].label,
            품의번호: r.proposal.approvalNo,
            날짜: r.proposal.date,
            부서: r.proposal.department,
            예산과목: r.proposal.budgetItem,
            '적요/내용': r.proposal.description,
            품의금액: Number(r.proposal.amount) || 0,
            실사용: r.spent,
            차액: r.difference,
            결재상태: r.proposal.approvalStatus,
        }));
        spendingRows.forEach(r => rows.push({
            구분: '지출만 있음',
            품의번호: '',
            날짜: r.entry.date,
            부서: r.plan.department,
            예산과목: r.plan.budgetItem,
            '적요/내용': r.entry.description,
            품의금액: 0,
            실사용: r.amount,
            차액: -r.amount,
            결재상태: '',
        }));
        const sheet = XLSX.utils.json_to_sheet(sanitizeExcelRows(rows));
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '검수 확인 필요');
        XLSX.writeFile(book, `예산_품의검수_${year}${month ? `_${month}` : ''}.xlsx`);
    };

    const renderSpending = (s: SpendingRow) => (
        <div key={s.entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] py-1.5 border-t border-gray-100 first:border-t-0">
            <span className="font-mono text-gray-500">{s.entry.date}</span>
            <span className="font-bold text-gray-800">{won(s.amount)}</span>
            <span className="text-gray-600 flex-1 min-w-[120px]">{s.entry.description}</span>
            {s.linkSource && <span className="text-[10px] text-gray-400">{LINK_SOURCE_LABEL[s.linkSource]}</span>}
            <button
                type="button"
                disabled={linkingEntryId === s.entry.id}
                onClick={() => link(s, '')}
                className="text-[11px] font-bold text-gray-500 hover:text-rose-600 disabled:opacity-40"
            >
                연결 해제
            </button>
        </div>
    );

    const renderProposalRow = (r: ProposalRow) => {
        const isOpen = expanded === r.proposal.id;
        const amount = Number(r.proposal.amount) || 0;
        const canEnter = r.status === 'proposal-only' && r.hasPlan;
        return (
            <React.Fragment key={r.proposal.id}>
                <tr
                    className={`border-b border-gray-100 hover:bg-gray-50 ${r.spendings.length ? 'cursor-pointer' : ''}`}
                    onClick={() => r.spendings.length && setExpanded(isOpen ? null : r.proposal.id)}
                >
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap">{r.proposal.approvalNo}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-gray-500 whitespace-nowrap">{r.proposal.date}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.proposal.department}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{normalizeBudgetItem(r.proposal.budgetItem)}</td>
                    <td className="px-3 py-2 text-gray-600 max-w-[260px] truncate" title={r.proposal.description}>{r.proposal.description}</td>
                    <td className="px-3 py-2 text-right font-mono">{amount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.spent ? r.spent.toLocaleString() : '-'}</td>
                    <td className={`px-3 py-2 text-right font-mono font-bold ${r.difference === 0 ? 'text-gray-300' : r.difference > 0 ? 'text-blue-600' : 'text-rose-600'}`}>
                        {r.difference === 0 ? '0' : (r.difference > 0 ? '+' : '') + r.difference.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                        {r.status === 'proposal-only' && (canEnter ? (
                            <button
                                type="button"
                                disabled={savingProposalId === r.proposal.id}
                                onClick={() => onEnterProposal(r.proposal)}
                                className="px-2.5 py-1 rounded-lg bg-blue-600 text-white text-[11px] font-bold hover:bg-blue-700 disabled:opacity-50"
                            >
                                {savingProposalId === r.proposal.id ? '입력 중…' : '지출로 입력'}
                            </button>
                        ) : (
                            <span className="text-[11px] text-gray-400" title="예산 현황에 이 부서·과목이 없습니다">과목 없음</span>
                        ))}
                        {r.spendings.length > 0 && (
                            <span className="text-[11px] text-gray-500">지출 {r.spendings.length}건 {isOpen ? '▲' : '▼'}</span>
                        )}
                    </td>
                </tr>
                {isOpen && (
                    <tr className="bg-gray-50/70">
                        <td colSpan={10} className="px-6 py-2">{r.spendings.map(renderSpending)}</td>
                    </tr>
                )}
            </React.Fragment>
        );
    };

    const renderSpendingOnlyRow = (r: UnlinkedSpendingRow) => {
        const { suggested, others } = linkOptionsFor(r);
        const chosen = chosenProposal[r.entry.id] ?? suggested[0]?.approvalNo ?? '';
        return (
            <tr key={`${r.plan.department}-${r.plan.budgetItem}-${r.entry.id}`} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-[12px] text-gray-500 whitespace-nowrap">{r.entry.date}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.plan.department}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.plan.budgetItem}</td>
                <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate" title={r.entry.description}>{r.entry.description}</td>
                <td className="px-3 py-2 text-right font-mono">{r.amount.toLocaleString()}</td>
                <td className="px-3 py-2">
                    {suggested.length + others.length === 0 ? (
                        <span className="text-[11px] text-gray-400">같은 부서 품의 없음</span>
                    ) : (
                        <div className="flex items-center gap-2">
                            <select
                                value={chosen}
                                onChange={e => setChosenProposal(prev => ({ ...prev, [r.entry.id]: e.target.value }))}
                                className="max-w-[340px] text-[12px] border border-gray-200 rounded-lg px-2 py-1 bg-white"
                            >
                                <option value="">품의 선택…</option>
                                {suggested.length > 0 && (
                                    <optgroup label="추천 (같은 과목, 금액·날짜 가까운 순)">
                                        {suggested.map(p => <option key={p.id} value={p.approvalNo}>{proposalLabel(p)}</option>)}
                                    </optgroup>
                                )}
                                {others.length > 0 && (
                                    <optgroup label="같은 부서의 다른 품의">
                                        {others.map(p => <option key={p.id} value={p.approvalNo}>{proposalLabel(p)}</option>)}
                                    </optgroup>
                                )}
                            </select>
                            <button
                                type="button"
                                disabled={!chosen || linkingEntryId === r.entry.id}
                                onClick={() => link(r, chosen)}
                                className="px-2.5 py-1 rounded-lg bg-amber-500 text-white text-[11px] font-bold hover:bg-amber-600 disabled:opacity-40 whitespace-nowrap"
                            >
                                {linkingEntryId === r.entry.id ? '연결 중…' : '연결'}
                            </button>
                        </div>
                    )}
                </td>
            </tr>
        );
    };

    return (
        <div className="flex-1 flex flex-col gap-4 overflow-hidden min-h-0">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 shrink-0">
                {VIEWS.map(v => (
                    <button
                        key={v.view}
                        type="button"
                        onClick={() => { setView(v.view); setExpanded(null); }}
                        title={v.hint}
                        className={`text-left rounded-2xl border-2 p-3 transition-all ${view === v.view ? TONE[v.tone].card : 'border-transparent bg-white hover:border-gray-200'}`}
                    >
                        <div className="text-[12px] font-bold text-gray-500">{v.label}</div>
                        <div className="text-2xl font-black text-gray-900">{counts[v.view].count.toLocaleString()}<span className="text-sm font-bold text-gray-400 ml-0.5">건</span></div>
                        <div className="text-[11px] text-gray-400 font-mono">
                            {v.view === 'amount-diff' ? `차액 합 ${won(counts[v.view].amount)}` : won(counts[v.view].amount)}
                        </div>
                    </button>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <select value={month} onChange={e => setMonth(e.target.value)} className="text-[13px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
                    <option value="">{year}년 전체 월</option>
                    {months.map(m => <option key={m} value={m}>{Number(m.slice(5))}월</option>)}
                </select>
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="품의번호·적요·과목·작성자 검색"
                    className="flex-1 min-w-[200px] text-[13px] border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
                />
                <button
                    type="button"
                    onClick={exportIssues}
                    className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-[12px] font-bold hover:bg-black"
                >
                    확인 필요 목록 엑셀
                </button>
            </div>

            <p className="text-[12px] text-gray-500 shrink-0">{VIEWS.find(v => v.view === view)!.hint}</p>

            <div className="flex-1 min-h-0 max-h-[calc(100vh-320px)] overflow-y-auto overflow-x-auto bg-white rounded-2xl border border-gray-100">
                {view === 'spending-only' ? (
                    <table className="w-full text-[13px]">
                        <thead className="sticky top-0 bg-gray-50 text-[11px] text-gray-500">
                            <tr>
                                <th className="px-3 py-2 text-left">날짜</th>
                                <th className="px-3 py-2 text-left">부서</th>
                                <th className="px-3 py-2 text-left">예산과목</th>
                                <th className="px-3 py-2 text-left">내용</th>
                                <th className="px-3 py-2 text-right">지출액</th>
                                <th className="px-3 py-2 text-left">연결할 품의</th>
                            </tr>
                        </thead>
                        <tbody>
                            {spendingRows.length === 0
                                ? <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-400">품의 없이 적힌 지출이 없습니다.</td></tr>
                                : spendingRows.map(renderSpendingOnlyRow)}
                        </tbody>
                    </table>
                ) : (
                    <table className="w-full text-[13px]">
                        <thead className="sticky top-0 bg-gray-50 text-[11px] text-gray-500">
                            <tr>
                                <th className="px-3 py-2 text-left">상태</th>
                                <th className="px-3 py-2 text-left">품의번호</th>
                                <th className="px-3 py-2 text-left">작성일</th>
                                <th className="px-3 py-2 text-left">부서</th>
                                <th className="px-3 py-2 text-left">예산과목</th>
                                <th className="px-3 py-2 text-left">적요</th>
                                <th className="px-3 py-2 text-right">품의금액</th>
                                <th className="px-3 py-2 text-right">실사용</th>
                                <th className="px-3 py-2 text-right" title="품의금액 − 실사용">차액</th>
                                <th className="px-3 py-2 text-right">작업</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleProposals.length === 0
                                ? <tr><td colSpan={10} className="px-3 py-10 text-center text-gray-400">해당하는 품의가 없습니다.</td></tr>
                                : visibleProposals.map(renderProposalRow)}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

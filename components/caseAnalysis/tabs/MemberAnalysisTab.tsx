import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Table, Tooltip, Select, Button, Badge, Tag, Input, Space } from 'antd';
import { FileText, UserCheck, Activity, AlertCircle, CheckCircle2, XCircle, Search, RefreshCw, TrendingUp } from 'lucide-react';
import { apiClient } from '../../../services/apiClient';
import { MemberPerformance } from '../../../types';
import { 
    IspAchievementYearlyResponse, 
    IspMemberEvaluation, 
    IspMonthlyEvaluation, 
    IspEvaluationResult, 
    IspDetailLevel 
} from '../types';

interface MemberAnalysisTabProps {
    data: MemberPerformance[];
    dateRange: { start: string; end: string };
}

/**
 * [Stabilization] Evaluation Label Mapping
 */
const evaluationBadgeMap: Record<IspEvaluationResult, {
    label: string;
    className: string;
    status: 'success' | 'error' | 'processing' | 'default' | 'warning';
}> = {
    NOT_EVALUATED: {
        label: '미평가',
        className: 'bg-gray-50 text-gray-500 border-gray-200',
        status: 'default'
    },
    FUTURE_NOT_DUE: {
        label: '평가전',
        className: 'bg-slate-50 text-slate-500 border-slate-200',
        status: 'default'
    },
    IN_PROGRESS: {
        label: '진행중',
        className: 'bg-blue-50 text-blue-600 border-blue-200',
        status: 'processing'
    },
    FAIL: {
        label: '미달',
        className: 'bg-red-50 text-red-600 border-red-200',
        status: 'error'
    },
    SUCCESS: {
        label: '달성',
        className: 'bg-green-50 text-green-600 border-green-200',
        status: 'success'
    },
    WARNING: {
        label: '과잉',
        className: 'bg-orange-50 text-orange-600 border-orange-200',
        status: 'warning'
    }
};

function parseCountValue(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (value === '-') return 0;

  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function useDebouncedValue<T>(value: T, delay = 150): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

function getMonthlyValue(row: any, month: number): number {
  const candidates = [
    row?.monthly?.[month],
    row?.monthly?.[month - 1],
    row?.months?.[month - 1],
    row?.monthlyData?.[month - 1],
    row?.values?.[month - 1],
    row?.monthValues?.[month - 1],
    row?.counts?.[month - 1],
    row?.[`month${month}`],
    row?.[`m${month}`],
    row?.[`${month}월`],
    row?.[String(month)]
  ];

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      return parseCountValue(value);
    }
  }

  return 0;
}

const CATEGORY_LABEL_MAP: Record<string, string> = {
  individual: '개별상담',
  resource: '자원조정',
  '개별상담': '개별상담',
  '자원조정': '자원조정'
};

const COUNSELING_TYPE_LABEL_MAP: Record<string, string> = {
  inOffice: '내소',
  visit: '방문',
  phone: '전화',
  online: '온라인',
  내소: '내소',
  방문: '방문',
  전화: '전화',
  온라인: '온라인'
};

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim();
}

function getSessionCategory(session: any): string {
  const raw = normalizeKey(
    session?.category ??
    session?.majorCategory ??
    session?.mainCategory ??
    session?.대분류 ??
    session?.구분
  );

  return CATEGORY_LABEL_MAP[raw] || raw;
}

function getSessionType(session: any): string {
  const raw = normalizeKey(
    session?.type ??
    session?.subCategory ??
    session?.subType ??
    session?.소분류 ??
    session?.label
  );

  return COUNSELING_TYPE_LABEL_MAP[raw] || raw;
}

function getSessionMonth(session: any): number | null {
  const raw = session?.month ?? session?.월 ?? session?.monthIndex;
  const month = Number(raw);
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : null;
}

function getSessionCount(session: any): number {
  const raw =
    session?.count ??
    session?.value ??
    session?.건수 ??
    session?.total;

  if (raw === null || raw === undefined || raw === '') {
    return 1;
  }

  if (raw === '-') return 0;

  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 1;
}

function getDetailedSessions(record: any): any[] {
  if (Array.isArray(record?.detailedSessions)) return record.detailedSessions;

  const candidates = [
    record?.children,
    record?.rows,
    record?.details,
    record?.performanceRows,
    record?.items,
    record?.monthlyRows
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  return [];
}

function buildMonthlyPerformanceMatrix(record: any) {
  const sessions = getDetailedSessions(record);

  const individual = {
    내소: Array(12).fill(0),
    방문: Array(12).fill(0),
    전화: Array(12).fill(0),
    온라인: Array(12).fill(0)
  };

  const resourceRows: Record<string, number[]> = {};

  for (const session of sessions) {
    const month = getSessionMonth(session);
    if (!month) continue;

    const monthIndex = month - 1;
    const category = getSessionCategory(session);
    const type = getSessionType(session);
    
    // Exclude system/plan rows
    if (category.includes('ISP') || type.includes('ISP')) continue;
    if (category.includes('기록') || type.includes('기록')) continue;

    const count = getSessionCount(session);

    if (category === '개별상담') {
      if (type === '내소' || type === '방문' || type === '전화' || type === '온라인') {
        individual[type as keyof typeof individual][monthIndex] += count;
      }
    } else if (category === '자원조정') {
      const resourceType = type || '기타';
      if (!resourceRows[resourceType]) {
        resourceRows[resourceType] = Array(12).fill(0);
      }
      resourceRows[resourceType][monthIndex] += count;
    }
  }

  const individualTotal = Array.from({ length: 12 }, (_, i) =>
    individual.내소[i] + individual.방문[i] + individual.전화[i] + individual.온라인[i]
  );

  const resourceTotal = Array.from({ length: 12 }, (_, i) =>
    Object.values(resourceRows).reduce((sum, row) => sum + (row[i] || 0), 0)
  );

  const totalIntervention = Array.from({ length: 12 }, (_, i) =>
    individualTotal[i] + resourceTotal[i]
  );

  return {
    individual,
    individualTotal,
    resourceRows,
    resourceTotal,
    totalIntervention
  };
}

function getMemberPerformanceRows(record: any): any[] {
  const candidates = [
    record?.children,
    record?.rows,
    record?.details,
    record?.performanceRows,
    record?.items,
    record?.monthlyRows,
    record?.detailedSessions
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  if (Array.isArray(record)) return record;

  return [];
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[()]/g, '');
}

function getMajorCategory(row: any): string {
  return normalizeText(
    row?.majorCategory ??
    row?.mainCategory ??
    row?.category ??
    row?.group ??
    row?.대분류 ??
    row?.구분
  );
}

function getSubCategory(row: any): string {
  return normalizeText(
    row?.subCategory ??
    row?.subType ??
    row?.type ??
    row?.label ??
    row?.name ??
    row?.소분류 ??
    row?.상세구분
  );
}

function isIndividualCounselingRow(row: any): boolean {
  const category = getSessionCategory(row);
  const type = getSessionType(row);
  
  if (category.includes('ISP') || type.includes('ISP')) return false;
  if (category.includes('기록') || type.includes('기록')) return false;

  return category === '개별상담' && ['내소', '방문', '전화', '온라인'].includes(type);
}

function isResourceCoordinationRow(row: any): boolean {
  const category = getSessionCategory(row);
  if (category.includes('ISP')) return false;
  return category === '자원조정';
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '');
}

function normalizeMemberRegistrationNoForSearch(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/\.0$/, '');
}

function getDisplaySequence(record: any, index?: number): string {
  const value =
    record?.sequenceNo ??
    record?.연번 ??
    record?.no ??
    record?.memberNo ??
    record?.registrationNo ??
    record?.memberRegistrationNo ??
    (typeof index === 'number' ? index + 1 : '');

  if (value === null || value === undefined || value === '') {
    return '-';
  }

  return String(value);
}

function getPrimaryStaffName(record: any): string {
  const value =
    record?.mainCounselor ??
    record?.counselorName ??
    record?.counselor ??
    record?.managerName ??
    record?.staffName ??
    record?.담당자 ??
    record?.상담자 ??
    record?.등록자;

  const text = String(value ?? '').trim();
  return text || '-';
}

function getRecordSearchFields(record: any) {
  const memberFields = [
    record?.memberName,
    record?.name,
    record?.clientName,
    record?.targetName,
    record?.대상자,
    record?.내담자,
    record?.회원명,
    record?.이름
  ];

  const registrationFields = [
    record?.memberRegistrationNo,
    record?.registrationNo,
    record?.memberNo,
    record?.회원등록번호,
    record?.등록번호
  ];

  const counselorFields = [
    record?.mainCounselor,
    record?.counselorName,
    record?.counselor,
    record?.counselor_name,
    record?.managerName,
    record?.manager,
    record?.manager_name,
    record?.consultantName,
    record?.consultant,
    record?.advisorName,
    record?.staffName,
    record?.담당자,
    record?.상담자,
    record?.등록자,
    record?.createdBy,
    record?.registeredBy
  ];

  const rows = getMemberPerformanceRows(record);

  for (const row of rows) {
    counselorFields.push(
      row?.mainCounselor,
      row?.counselorName,
      row?.counselor,
      row?.counselor_name,
      row?.managerName,
      row?.manager,
      row?.manager_name,
      row?.consultantName,
      row?.consultant,
      row?.advisorName,
      row?.staffName,
      row?.담당자,
      row?.상담자,
      row?.등록자,
      row?.createdBy,
      row?.registeredBy
    );

    memberFields.push(
      row?.memberName,
      row?.name,
      row?.clientName,
      row?.targetName,
      row?.대상자,
      row?.내담자,
      row?.회원명,
      row?.이름
    );

    registrationFields.push(
      row?.memberRegistrationNo,
      row?.registrationNo,
      row?.memberNo,
      row?.회원등록번호,
      row?.등록번호
    );
  }

  return {
    memberText: memberFields.map(normalizeSearchText).filter(Boolean).join(' '),
    registrationText: registrationFields.map(normalizeMemberRegistrationNoForSearch).filter(Boolean).join(' '),
    counselorText: counselorFields.map(normalizeSearchText).filter(Boolean).join(' '),
    allText: [
      ...memberFields.map(normalizeSearchText),
      ...registrationFields.map(normalizeMemberRegistrationNoForSearch),
      ...counselorFields.map(normalizeSearchText)
    ].filter(Boolean).join(' ')
  };
}

function getRecordKey(record: any): string {
  return String(
    record?.id ??
    record?.memberId ??
    record?.memberRegistrationNo ??
    record?.registrationNo ??
    record?.memberName ??
    record?.name ??
    (record?.registrationNo || record?.memberName)
  );
}

function buildMemberEvaluationKeyFromRecord(record: any): string {
  const memberId = record?.memberId ?? record?.id;
  if (memberId !== undefined && memberId !== null && String(memberId).trim()) {
    return `id:${String(memberId).trim()}`;
  }

  const reg = normalizeMemberRegistrationNoForSearch(
    record?.memberRegistrationNo ??
    record?.registrationNo ??
    record?.memberNo ??
    record?.회원등록번호
  );

  const name = normalizeSearchText(
    record?.memberName ??
    record?.name ??
    record?.clientName ??
    record?.targetName ??
    record?.회원명 ??
    record?.이름
  );

  return `mp:${reg || 'no-reg'}:${name || 'no-name'}`;
}

function isIspEvaluationResult(value: unknown): value is IspEvaluationResult {
    return typeof value === 'string' && [
        'NOT_EVALUATED',
        'FUTURE_NOT_DUE',
        'IN_PROGRESS',
        'FAIL',
        'SUCCESS',
        'WARNING'
    ].includes(value);
}

const MemberAnalysisTab: React.FC<MemberAnalysisTabProps> = ({ data }) => {
    const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());
    const [ispEvaluationMap, setIspEvaluationMap] = useState<Record<string, IspMemberEvaluation>>({});
    const [ispLoadingMap, setIspLoadingMap] = useState<Record<string, boolean>>({});
    const [memberDataMap, setMemberDataMap] = useState<Record<string, { loaded: boolean; error?: string; detailedSessions?: any[]; ispEvaluation?: any }>>({});


    const [searchTerm, setSearchTerm] = useState('');
    const [searchScope, setSearchScope] = useState<'ALL' | 'MEMBER' | 'REGISTRATION_NO' | 'COUNSELOR' | 'REGISTERED_BY'>('ALL');


    // [Stabilization] Map source data with stable original indices for reliable key generation
    const sourceDataWithIndices = useMemo(() => {
        return (Array.isArray(data) ? data : []).map((record, index) => ({
            ...record,
            _originalIndex: index
        }));
    }, [data]);

    const duplicateRegistrationNos = useMemo(() => {
        const counts = new Map<string, number>();
        for (const record of sourceDataWithIndices) {
            const reg = normalizeMemberRegistrationNoForSearch(
                record?.memberRegistrationNo ??
                record?.registrationNo ??
                record?.memberNo
            );
            if (!reg) continue;
            counts.set(reg, (counts.get(reg) || 0) + 1);
        }
        return counts;
    }, [sourceDataWithIndices]);

    // Year-based batch cache to avoid redundant full-year API calls
    const yearlyDataCache = useRef<Record<string, any>>({});

    /**
     * [Logic] Normalize 12 months data even if partial
     */
    const normalizeIspMonthlyData = useCallback((monthlyData: Record<number, IspMonthlyEvaluation> | IspMonthlyEvaluation[] | undefined): IspMonthlyEvaluation[] => {
        let safeData: IspMonthlyEvaluation[] = [];
        
        if (Array.isArray(monthlyData)) {
            safeData = monthlyData;
        } else if (monthlyData && typeof monthlyData === 'object') {
            safeData = Object.values(monthlyData);
        }

        return Array.from({ length: 12 }, (_, index) => {
            const month = index + 1;
            const found = safeData.find(m => Number(m.month) === month);
            
            if (found) {
                const res = found.evaluationResult as any;
                let validResult: IspEvaluationResult = isIspEvaluationResult(res) ? res : 
                                                        (res === 'success' ? 'SUCCESS' : 
                                                         res === 'fail' ? 'FAIL' : 
                                                         res === 'future' ? 'FUTURE_NOT_DUE' : 
                                                         res === 'inprogress' ? 'IN_PROGRESS' : 'NOT_EVALUATED');

                // Overwrite SUCCESS if targetCount > 0 and actualCount is 0
                if (validResult === 'SUCCESS' && found.targetCount > 0 && found.actualCount === 0) {
                    validResult = 'FAIL';
                }

                return {
                    ...found,
                    month,
                    managementTypeSummary: found.managementTypeSummary || '-',
                    targetCount: Number(found.targetCount || 0),
                    actualCount: Number(found.actualCount || 0),
                    evaluationResult: validResult,
                    evaluationLabel: found.evaluationLabel || evaluationBadgeMap[validResult].label
                };
            }

            return {
                month,
                managementTypeSummary: '-',
                targetCount: 0,
                actualCount: 0,
                evaluationResult: 'NOT_EVALUATED',
                evaluationLabel: '미평가'
            };
        });
    }, []);

    /**
     * [UI Component] Granular performance matrix for expanded view
     */
    const ExpandedMemberDetail = React.memo(({ 
        record, 
        ispEvaluation, 
        year 
    }: { 
        record: MemberPerformance, 
        ispEvaluation: IspMemberEvaluation | undefined,
        year: string
    }) => {
        const matrix = React.useMemo(() => buildMonthlyPerformanceMatrix(record), [record]);
        const counselingTypes = ['내소', '방문', '전화', '온라인'] as const;
        const months = Array.from({ length: 12 }, (_, i) => i + 1);

        const totalInterventionByMonth = matrix.totalIntervention;

        const currentMonth = new Date().getMonth() + 1;
        const currentYear = new Date().getFullYear();
        const isSelectedYearCurrent = parseInt(year) === currentYear;

        const normalizedMonthly = React.useMemo(() => {
            const baseData = normalizeIspMonthlyData(ispEvaluation?.monthly);
            return baseData.map((d, i) => {
                const actualCount = totalInterventionByMonth[i];
                const targetCount = d.targetCount;
                
                let result: IspEvaluationResult = 'NOT_EVALUATED';
                const isFuture = parseInt(year) > currentYear || (isSelectedYearCurrent && d.month > currentMonth);
                const isCurrent = isSelectedYearCurrent && d.month === currentMonth;

                if (isFuture) {
                    result = 'FUTURE_NOT_DUE';
                } else if (isCurrent) {
                    result = 'IN_PROGRESS';
                    // Optional: If actualCount >= targetCount, could show SUCCESS but requirement says IN_PROGRESS
                } else if (targetCount > 0) {
                    result = actualCount >= targetCount ? 'SUCCESS' : 'FAIL';
                } else if (targetCount === 0) {
                    // targetCount가 0이면 미평가 또는 대상아님
                    result = 'NOT_EVALUATED';
                }

                return {
                    ...d,
                    actualCount,
                    evaluationResult: result,
                    evaluationLabel: evaluationBadgeMap[result].label
                };
            });
        }, [ispEvaluation?.monthly, totalInterventionByMonth, year, isSelectedYearCurrent, currentMonth, currentYear]);

        const formatCount = (val: number) => (val > 0 ? val : '-');

        return (
            <div className="m-4 bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 space-y-8">
                {/* Header Section */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-3 bg-indigo-50 rounded-2xl">
                            <FileText className="w-5 h-5 text-indigo-500" />
                        </div>
                        <div>
                            <h4 className="text-sm font-black text-slate-800 tracking-tight">
                                {record.memberName} 회원 {year}년 상세 분석 리포트
                            </h4>
                            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Granular Performance Analysis Matrix</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-2xl border border-slate-100">
                        <span className="text-[10px] font-black text-slate-400 uppercase mr-2">ISP 매칭</span>
                        {renderIspMatchBadge(ispEvaluation)}
                    </div>
                </div>

                {/* Section 1: Counseling Performance Matrix (개별상담) */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="w-1 h-3 bg-blue-500 rounded-full" />
                        <span className="text-xs font-black text-slate-700">상담 실적 분석 (개별상담)</span>
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-slate-100">
                        <table className="w-full text-[11px] border-collapse">
                            <thead>
                                <tr className="bg-slate-50/50">
                                    <th className="px-4 py-2 text-left font-black text-slate-400 border-b border-slate-100">구분</th>
                                    {months.map(m => (
                                        <th key={m} className="px-2 py-2 text-center font-black text-slate-400 border-b border-slate-100">{m}월</th>
                                    ))}
                                    <th className="px-4 py-2 text-center font-black text-slate-600 border-b border-slate-100 bg-slate-100/50">합계</th>
                                </tr>
                            </thead>
                            <tbody>
                                {counselingTypes.map(type => {
                                    let rowTotal = 0;
                                    return (
                                        <tr key={type} className="hover:bg-slate-50/30 transition-colors">
                                            <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50">{type}</td>
                                            {months.map(m => {
                                                const count = matrix.individual[type][m - 1];
                                                rowTotal += count;
                                                return <td key={m} className="px-2 py-2 text-center text-slate-400 border-b border-slate-50">{formatCount(count)}</td>
                                            })}
                                            <td className="px-4 py-2 text-center font-bold text-slate-700 border-b border-slate-50 bg-slate-50/30">{formatCount(rowTotal)}</td>
                                        </tr>
                                    );
                                })}
                                <tr className="bg-blue-50/30 font-black">
                                    <td className="px-4 py-2 text-blue-700 border-t border-blue-100">개별상담 합계</td>
                                    {months.map(m => (
                                        <td key={m} className="px-2 py-2 text-center text-blue-600 border-t border-blue-100">{formatCount(matrix.individualTotal[m-1])}</td>
                                    ))}
                                    <td className="px-4 py-2 text-center text-blue-800 border-t border-blue-100 bg-blue-100/20">
                                        {formatCount(matrix.individualTotal.reduce((a, b) => a + b, 0))}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Section 2: Resource Coordination Matrix (자원조정) */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="w-1 h-3 bg-purple-500 rounded-full" />
                        <span className="text-xs font-black text-slate-700">자원조정 분석</span>
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-slate-100">
                        {Object.keys(matrix.resourceRows).length > 0 ? (
                            <table className="w-full text-[11px] border-collapse">
                                <thead>
                                    <tr className="bg-slate-50/50">
                                        <th className="px-4 py-2 text-left font-black text-slate-400 border-b border-slate-100">구분</th>
                                        {months.map(m => (
                                            <th key={m} className="px-2 py-2 text-center font-black text-slate-400 border-b border-slate-100">{m}월</th>
                                        ))}
                                        <th className="px-4 py-2 text-center font-black text-slate-600 border-b border-slate-100 bg-slate-100/50">합계</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {Object.entries(matrix.resourceRows).map(([type, row], idx) => {
                                        let rowTotal = 0;
                                        return (
                                            <tr key={idx} className="hover:bg-slate-50/30 transition-colors">
                                                <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50">{type}</td>
                                                {months.map(m => {
                                                    const count = row[m - 1];
                                                    rowTotal += count;
                                                    return <td key={m} className="px-2 py-2 text-center text-slate-400 border-b border-slate-50">{formatCount(count)}</td>
                                                })}
                                                <td className="px-4 py-2 text-center font-bold text-slate-700 border-b border-slate-50 bg-slate-50/30">{formatCount(rowTotal)}</td>
                                            </tr>
                                        );
                                    })}
                                    <tr className="bg-purple-50/30 font-black">
                                        <td className="px-4 py-2 text-purple-700 border-t border-purple-100">자원조정 합계</td>
                                        {months.map(m => (
                                            <td key={m} className="px-2 py-2 text-center text-purple-600 border-t border-purple-100">{formatCount(matrix.resourceTotal[m-1])}</td>
                                        ))}
                                        <td className="px-4 py-2 text-center text-purple-800 border-t border-purple-100 bg-purple-100/20">
                                            {formatCount(matrix.resourceTotal.reduce((a, b) => a + b, 0))}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        ) : (
                            <div className="p-4 text-center bg-slate-50/50 rounded-xl border border-dashed border-slate-200">
                                <p className="text-[10px] text-slate-400 font-medium">자원조정 데이터가 없습니다.</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Section 3: ISP Performance Analysis Matrix */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="w-1 h-3 bg-emerald-500 rounded-full" />
                        <span className="text-xs font-black text-slate-700">ISP 실적 분석 Matrix</span>
                        {!ispEvaluation && <span className="text-[10px] text-slate-400 font-medium ml-2">(데이터 로드 필요)</span>}
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-slate-100">
                        {!ispEvaluation || ispEvaluation.ispMatchStatus === 'NOT_FOUND' ? (
                            <div className="p-8 text-center bg-slate-50/30">
                                <TrendingUp className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                                <p className="text-xs text-slate-500 font-bold">ISP 매칭 데이터가 존재하지 않습니다</p>
                                <p className="text-[10px] text-slate-400 mt-1">이름 또는 등록번호와 매칭되는 ISP 수립 내역이 없습니다.</p>
                            </div>
                        ) : (
                            <table className="w-full text-[11px] border-collapse">
                                <thead>
                                    <tr className="bg-slate-50/50">
                                        <th className="px-4 py-2 text-left font-black text-slate-400 border-b border-slate-100">분석 항목</th>
                                        {months.map(m => (
                                            <th key={m} className="px-2 py-2 text-center font-black text-slate-400 border-b border-slate-100">{m}월</th>
                                        ))}
                                        <th className="px-4 py-2 text-center font-black text-slate-600 border-b border-slate-100 bg-slate-100/50">연간</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr className="hover:bg-slate-50/30 transition-colors">
                                        <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50">관리구분</td>
                                        {normalizedMonthly.map(d => (
                                            <td key={d.month} className="px-2 py-2 text-center text-slate-500 border-b border-slate-50">{d.managementTypeSummary}</td>
                                        ))}
                                        <td className="px-4 py-2 text-center font-bold text-slate-700 border-b border-slate-50 bg-slate-50/30">-</td>
                                    </tr>
                                    <tr className="hover:bg-slate-50/30 transition-colors">
                                        <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50">목표횟수</td>
                                        {normalizedMonthly.map(d => (
                                            <td key={d.month} className="px-2 py-2 text-center text-slate-400 border-b border-slate-50">{formatCount(d.targetCount)}</td>
                                        ))}
                                        <td className="px-4 py-2 text-center font-bold text-slate-700 border-b border-slate-50 bg-slate-50/30">
                                            {formatCount(normalizedMonthly.reduce((acc, d) => acc + d.targetCount, 0))}
                                        </td>
                                    </tr>
                                    <tr className="hover:bg-slate-50/30 transition-colors">
                                        <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50">실적</td>
                                        {normalizedMonthly.map(d => {
                                            return (
                                                <td key={d.month} className="px-2 py-2 text-center font-bold border-b border-slate-50 text-slate-700">
                                                    <Tooltip title={d.actualCount !== Number(d.actualCount || 0) ? `서버 데이터(${d.actualCount})와 화면 집계가 다를 수 있습니다.` : undefined}>
                                                        {formatCount(d.actualCount)}
                                                    </Tooltip>
                                                </td>
                                            );
                                        })}
                                        <td className="px-4 py-2 text-center font-bold text-slate-800 border-b border-slate-50 bg-slate-50/30">
                                            {formatCount(normalizedMonthly.reduce((a, b) => a + b.actualCount, 0))}
                                        </td>
                                    </tr>
                                    <tr className="hover:bg-slate-50/30 transition-colors">
                                        <td className="px-4 py-2 font-bold text-slate-600 border-b border-slate-50 rounded-bl-2xl">개입평가</td>
                                        {normalizedMonthly.map(d => (
                                            <td key={d.month} className="px-2 py-2 text-center border-b border-slate-50">
                                                {renderEvaluationBadge(d.evaluationResult, d.evaluationLabel)}
                                            </td>
                                        ))}
                                        <td className="px-4 py-2 text-center font-bold text-slate-700 border-b border-slate-50 bg-slate-50/30 rounded-br-2xl">-</td>
                                    </tr>
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
        );
    });

    const renderEvaluationBadge = (result: IspEvaluationResult | string | undefined, label: string | undefined) => {
        const key: IspEvaluationResult = isIspEvaluationResult(result) ? result : 
                                        (result === 'SUCCESS' || result === 'success' ? 'SUCCESS' : 
                                         result === 'FAIL' || result === 'fail' ? 'FAIL' : 
                                         result === 'FUTURE_NOT_DUE' || result === 'future' ? 'FUTURE_NOT_DUE' : 
                                         result === 'IN_PROGRESS' || result === 'inprogress' ? 'IN_PROGRESS' : 'NOT_EVALUATED');
        
        const config = evaluationBadgeMap[key];
        return <Badge status={config.status} text={label || config.label} />;
    };

    const renderIspMatchBadge = (member?: IspMemberEvaluation) => {
        const status = member?.ispMatchStatus;
        const method = member?.ispMatchMethod;

        // 1. 등록번호로 유일하게 매칭
        if (status === 'MATCHED' && method === 'NORMALIZED_MEMBER_REGISTRATION_NO') {
            return (
                <Tooltip title="회원등록번호 기준으로 ISP수립내역을 매칭했습니다.">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold bg-blue-50 text-blue-700 border-blue-200 cursor-help">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        회원번호매칭
                    </span>
                </Tooltip>
            );
        }

        // 2. 이름으로 유일하게 매칭
        if (status === 'MATCHED') {
            return (
                <Tooltip title="회원등록번호 대신 이름 기준으로 ISP 이력을 매칭했습니다.">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold bg-cyan-50 text-cyan-700 border-cyan-200 cursor-help">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        이름매칭
                    </span>
                </Tooltip>
            );
        }

        // 3. registrationNo 중복으로 자동매칭 차단
        if (status === 'DUPLICATE_REG_BLOCKED' || member?.ispMatchReason === 'DUPLICATE_REGISTRATION_NO') {
            return (
                <Tooltip title="동일한 등록번호를 가진 회원이 있어 등록번호 단독 매칭을 차단했습니다.">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold bg-orange-50 text-orange-700 border-orange-200 cursor-help">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        식별자중복
                    </span>
                </Tooltip>
            );
        }

        // 4. 이름 중복
        if (status === 'AMBIGUOUS' || status === 'AMBIGUOUS_NAME_CANDIDATES') {
            return (
                <Tooltip title="같은 이름 후보가 여러 명 있어 자동 매칭하지 않았습니다.">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold bg-yellow-50 text-yellow-700 border-yellow-200 cursor-help">
                        <AlertCircle className="w-3 h-3 mr-1" />
                        이름중복
                    </span>
                </Tooltip>
            );
        }

        // 5. 실제 ISP 수립내역 없음 (기본값)
        return (
            <Tooltip title="이름과 등록번호에 해당하는 ISP수립내역이 없습니다.">
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold bg-slate-50 text-slate-500 border-slate-200 cursor-help">
                    <XCircle className="w-3 h-3 mr-1" />
                    매칭실패
                </span>
            </Tooltip>
        );
    };

    const fetchIspEvaluationYearly = useCallback(async (memberName: string, year: string, registrationNo?: string, originalIndex?: number) => {
        if (originalIndex === undefined) return;
        
        const record = sourceDataWithIndices[originalIndex];
        const evaluationKey = buildMemberEvaluationKeyFromRecord(record);
        const key = `${evaluationKey}-${year}`;
        
        if (memberDataMap[key]?.loaded || ispLoadingMap[key]) return;

        setIspLoadingMap((prev) => ({ ...prev, [key]: true }));
        try {
            const controller = new AbortController();
            const { signal } = controller;

            // 1. GET current analysis API 호출
            const currentData = await apiClient.getAnalysisCurrent();
            let detailedSessions = record.detailedSessions || [];
            
            if (currentData && currentData.memberPerformance) {
                // 현재 회원의 detailedSessions 확인
                const foundMember = currentData.memberPerformance.find((m: any) => 
                    buildMemberEvaluationKeyFromRecord(m) === evaluationKey || 
                    (registrationNo && m.registrationNo === registrationNo)
                );
                if (foundMember && foundMember.detailedSessions) {
                    detailedSessions = foundMember.detailedSessions;
                }
            }

            // 2. GET isp-achievement-yearly 호출
            const cacheKey = `${year}:summary`;
            let res = yearlyDataCache.current[cacheKey];
            
            if (!res) {
                console.info(`[ISP UI] Cache miss on expand, fetching batch for ${year}`);
                res = await apiClient.getISPAchievementYearly(year, { detailLevel: 'summary', signal });
                yearlyDataCache.current[cacheKey] = res;
            }

            let memberEval = null;
            if (res && res.data) {
                memberEval = res.data[evaluationKey];
                if (!memberEval && Array.isArray(res.members)) {
                    memberEval = res.members[originalIndex];
                }
            }

            if (!memberEval) {
                // Create dummy entry for not found
                memberEval = { 
                    ispMatched: false, 
                    ispMatchStatus: 'NOT_FOUND', 
                    ispMatchMethod: 'NONE', 
                    monthly: [] 
                };
            }

            // 3. state 저장
            setMemberDataMap(prev => ({
                ...prev,
                [key]: {
                    loaded: true,
                    detailedSessions,
                    ispEvaluation: memberEval
                }
            }));
            
            // 호환성 유지용 (뱃지 등)
            setIspEvaluationMap(prev => ({ ...prev, [key]: memberEval }));

        } catch (error: any) {
            if (error.name === 'AbortError') return;
            console.error('ISP evaluation fetch error:', error);
            setMemberDataMap(prev => ({
                ...prev,
                [key]: {
                    loaded: false,
                    error: '분석 데이터 로드 실패: 백엔드 연결 또는 데이터 확인 필요'
                }
            }));
        } finally {
            setIspLoadingMap((prev) => ({ ...prev, [key]: false }));
        }
    }, [ispEvaluationMap, sourceDataWithIndices, memberDataMap, ispLoadingMap]);

    useEffect(() => {
        // Pre-fetch for the selected year
        const controller = new AbortController();
        const year = selectedYear;
        
        const cacheKey = `${year}:summary`;
        if (!yearlyDataCache.current[cacheKey]) {
            apiClient.getISPAchievementYearly(year, { detailLevel: 'summary', signal: controller.signal })
                .then(res => {
                    yearlyDataCache.current[cacheKey] = res;
                    if (res && res.data) {
                        setIspEvaluationMap(prev => {
                            const newMap = { ...prev };
                            // Load all available evaluation keys from the data map
                            Object.entries(res.data).forEach(([id, evalData]) => {
                                newMap[`${id}-${year}`] = evalData as any;
                            });
                            // If members array exists, ensure index-based fallback mapping
                            if (Array.isArray(res.members)) {
                                res.members.forEach((m: any, idx: number) => {
                                    if (m.memberEvaluationKey) {
                                        newMap[`${m.memberEvaluationKey}-${year}`] = m;
                                    }
                                    // Also allow index-based key if needed
                                    newMap[`mp-idx:${idx}-${year}`] = m;
                                });
                            }
                            return newMap;
                        });
                    }
                })
                .catch(err => {
                    if (err.name !== 'AbortError') console.error('Prefetch error:', err);
                });
        }

        return () => controller.abort();
    }, [selectedYear]);

    const debouncedSearchTerm = useDebouncedValue(searchTerm, 150);

    const columns = React.useMemo(() => [
        {
            title: '회원명',
            dataIndex: 'memberName',
            key: 'memberName',
            render: (text: string, record: any, index: number) => {
                const displaySequence = getDisplaySequence(record, record._originalIndex ?? index);
                const primaryStaffName = getPrimaryStaffName(record);
                return (
                    <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-slate-900">{text}</span>
                        <span className="text-xs text-slate-500">
                            연번: {displaySequence} · 담당자: {primaryStaffName}
                        </span>
                    </div>
                );
            }
        },
        {
            title: '매칭상태',
            key: 'ispMatchStatus',
            width: 120,
            render: (_: any, record: any) => {
                const evaluationKey = buildMemberEvaluationKeyFromRecord(record);
                const key = `${evaluationKey}-${selectedYear}`;
                const memberEval = ispEvaluationMap[key];
                return renderIspMatchBadge(memberEval);
            }
        },
        {
            title: `${selectedYear}년 실적 분석`,
            key: 'monthlySummary',
            render: (_: any, record: any) => {
                const evaluationKey = buildMemberEvaluationKeyFromRecord(record);
                const ispKey = `${evaluationKey}-${selectedYear}`;
                const memberDataState = memberDataMap[ispKey];
                
                if (!memberDataState?.loaded) {
                    return (
                        <Button 
                            size="small" 
                            type="text"
                            className="text-blue-600 hover:bg-blue-50"
                            loading={ispLoadingMap[ispKey]} 
                            onClick={(e) => {
                                e.stopPropagation();
                                fetchIspEvaluationYearly(record.memberName, selectedYear, record.registrationNo, record._originalIndex);
                            }}
                        >
                            분석 데이터 로드
                        </Button>
                    );
                }

                const memberEval = memberDataState.ispEvaluation;
                if (!memberEval || !memberEval.monthly) return null;

                const normalizedMonthly = normalizeIspMonthlyData(memberEval.monthly);
                const totalActual = normalizedMonthly.reduce((acc, d) => acc + d.actualCount, 0);
                const totalTarget = normalizedMonthly.reduce((acc, d) => acc + d.targetCount, 0);

                return (
                    <div className="flex items-center gap-2">
                        <Tag color="blue" className="rounded-full px-3 py-1 border-none bg-blue-50 text-blue-600 font-bold">
                            연간 실적 {totalActual}건 / 목표 {totalTarget}건
                        </Tag>
                        {totalTarget > 0 && (
                            <span className="text-[10px] text-slate-400 font-medium">
                                (이행률 {Math.round((totalActual / totalTarget) * 100)}%)
                            </span>
                        )}
                    </div>
                );
            }
        }
    ], [selectedYear, ispEvaluationMap, ispLoadingMap, memberDataMap, fetchIspEvaluationYearly, normalizeIspMonthlyData]);

    // Search optimization: memoized index and filtered data
    const searchIndex = React.useMemo(() => {
        const map = new Map<string, ReturnType<typeof getRecordSearchFields>>();
        for (const record of sourceDataWithIndices) {
            const key = getRecordKey(record);
            map.set(key, getRecordSearchFields(record));
        }
        return map;
    }, [sourceDataWithIndices]);

    const filteredData = React.useMemo(() => {
        if (import.meta.env.DEV) {
            console.time('[MemberAnalysisTab] filterData');
        }
        const source = sourceDataWithIndices;
        const keyword = normalizeSearchText(debouncedSearchTerm).toLowerCase();
        const normalizedRegKeyword = normalizeMemberRegistrationNoForSearch(debouncedSearchTerm);

        if (!keyword && !normalizedRegKeyword) {
            if (import.meta.env.DEV) console.timeEnd('[MemberAnalysisTab] filterData');
            return source;
        }

        const result = source.filter((record) => {
            const key = getRecordKey(record);
            const fields = searchIndex.get(key);
            if (!fields) return false;

            if (searchScope === 'MEMBER') {
                return fields.memberText.toLowerCase().includes(keyword);
            }
            if (searchScope === 'REGISTRATION_NO') {
                return fields.registrationText.includes(normalizedRegKeyword);
            }
            if (searchScope === 'COUNSELOR' || searchScope === 'REGISTERED_BY') {
                return fields.counselorText.toLowerCase().includes(keyword);
            }

            return fields.allText.toLowerCase().includes(keyword) || fields.registrationText.includes(normalizedRegKeyword);
        });

        if (import.meta.env.DEV) console.timeEnd('[MemberAnalysisTab] filterData');
        return result;
    }, [data, debouncedSearchTerm, searchScope, searchIndex]);

    const expandableConfig = React.useMemo(() => ({
        expandedRowRender: (record: any) => {
            const evaluationKey = buildMemberEvaluationKeyFromRecord(record);
            const ispKey = `${evaluationKey}-${selectedYear}`;
            const isLoading = ispLoadingMap[ispKey];
            const memberDataState = memberDataMap[ispKey];

            if (isLoading) {
                return (
                    <div className="p-12 text-center bg-slate-50/50 rounded-xl m-4 border border-dashed border-slate-200">
                        <RefreshCw className="w-8 h-8 text-blue-400 mx-auto mb-2 animate-spin" />
                        <p className="text-xs text-slate-400 font-medium">분석 데이터를 불러오는 중입니다.</p>
                    </div>
                );
            }

            if (memberDataState?.error) {
                return (
                    <div className="p-12 text-center bg-red-50/50 rounded-xl m-4 border border-dashed border-red-200">
                        <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
                        <p className="text-xs text-red-500 font-medium">{memberDataState.error}</p>
                    </div>
                );
            }

            if (!memberDataState?.loaded) {
                return (
                    <div className="p-12 text-center bg-slate-50/50 rounded-xl m-4 border border-dashed border-slate-200">
                        <Activity className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                        <p className="text-xs text-slate-400 font-medium">우측의 '분석 데이터 로드' 버튼을 클릭하여 데이터를 불러오세요.</p>
                    </div>
                );
            }

            const sessions = memberDataState.detailedSessions || [];

            return (
                <ExpandedMemberDetail 
                    record={{ ...record, detailedSessions: sessions }} 
                    ispEvaluation={memberDataState.ispEvaluation} 
                    year={selectedYear} 
                />
            );
        },
        rowExpandable: () => true
    }), [selectedYear, ispEvaluationMap, ispLoadingMap, memberDataMap]);

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-50 rounded-2xl">
                        <UserCheck className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-slate-800">회원별 ISP 실적 분석</h2>
                        <p className="text-xs text-slate-400 font-medium">ISP 수립 주기와 실제 개입 실적을 비교 분석합니다.</p>
                    </div>
                </div>
                
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-2xl border border-slate-200 shadow-sm transition-all hover:border-blue-300 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
                        <Search className="w-4 h-4 text-slate-400" />
                        <Input 
                            placeholder="회원명, 등록번호, 상담자 검색" 
                            variant="borderless"
                            className="text-xs font-bold w-48 p-0"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            allowClear
                        />
                        <div className="w-px h-4 bg-slate-200 mx-1" />
                        <Select 
                            value={searchScope}
                            onChange={(val: any) => setSearchScope(val)}
                            variant="borderless"
                            className="text-xs font-black text-blue-600 min-w-[100px]"
                            options={[
                                { value: 'ALL', label: '전체' },
                                { value: 'MEMBER', label: '회원명' },
                                { value: 'REGISTRATION_NO', label: '등록번호' },
                                { value: 'COUNSELOR', label: '상담자/담당자' },
                                { value: 'REGISTERED_BY', label: '등록자' }
                            ]}
                        />
                    </div>

                    <div className="flex items-center gap-3 bg-slate-50 p-1.5 rounded-2xl border border-slate-100">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider ml-2">분석 연도</span>
                        <Select 
                            value={selectedYear} 
                            variant="borderless"
                            className="font-bold text-slate-700"
                            onChange={(val) => {
                                setSelectedYear(val);
                            }}
                            style={{ width: 110 }}
                            options={[
                                { value: '2025', label: '2025년' },
                                { value: '2026', label: '2026년' },
                                { value: '2027', label: '2027년' }
                            ]}
                        />
                    </div>
                </div>
            </div>

            <div className="px-6 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Badge count={filteredData.length} overflowCount={9999} color="#3b82f6" />
                    <span className="text-xs font-bold text-slate-500">결과 표시 중 (총 {data.length}명)</span>
                </div>
                {searchTerm && (
                    <Button 
                        type="text" 
                        size="small" 
                        onClick={() => setSearchTerm('')}
                        className="text-[10px] font-bold text-blue-500 hover:text-blue-600 p-0 h-auto"
                    >
                        필터 초기화
                    </Button>
                )}
            </div>

            <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 overflow-hidden">
                <Table 
                    dataSource={filteredData} 
                    columns={columns} 
                    rowKey={(record) => getRecordKey(record)}
                    pagination={{ pageSize: 10, showSizeChanger: true }}
                    className="isp-analysis-table"
                    expandable={expandableConfig}
                    tableLayout="fixed"
                />
            </div>
        </div>
    );
};

export default MemberAnalysisTab;

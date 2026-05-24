import React, { useMemo, useState } from 'react';
import { Referral, SuicideAttempterReferral, Team, User } from '../../types';
import { TEAM_CODES, DIAGNOSIS_OPTIONS, NAMBU_SUB_TEAMS } from '../../constants';
import {
    PieChart, Pie, Cell, Tooltip, Legend,
    BarChart, Bar, XAxis, YAxis, CartesianGrid,
    ResponsiveContainer, TooltipProps, LabelList,
    AreaChart, Area
} from 'recharts';
import html2canvas from 'html2canvas';

import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { Printer, FileDown, LayoutDashboard, Calendar, Users, TrendingUp } from 'lucide-react';
import ReportChart from './ReportChart';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';

// --- Constants ---
const POLICE_REGEX = /경찰|지구대|파출소|112|117|치안|순찰|수사|형사|공무원|순경|경장|경사|경위|경감|경정|김태헌/;
const FIRE_REGEX = /소방|119/;

const COLORS_PROCESS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444'];
const COLORS_REG = ['#f472b6', '#3b82f6', '#fbbf24', '#9ca3af'];

// --- Top-level Helper Functions for Readability ---
function truncateLabel(label: string, maxLength = 6) {
    if (!label) return '미입력';
    const s = String(label).trim();
    return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
}

function shouldShowPieLabel(percent: number) {
    return percent >= 0.05;
}

// --- Segment Classification Utility Functions ---
function normalizeReportText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function getNumericAge(record: any): number | null {
  const age = Number(record?.age ?? record?.나이);
  return Number.isFinite(age) ? age : null;
}

function isYouthAge(age: number | null): boolean {
  return age !== null && age >= 19 && age <= 34;
}

function isChildYouthAge(age: number | null): boolean {
  return age !== null && age < 19;
}

// --- Users based assignee team lookup ---
function buildUserTeamMap(users: any[] = []) {
  const map = new Map<string, string>();

  for (const user of users) {
    const name = normalizeReportText(user?.name ?? user?.username ?? user?.displayName);
    const team = String(user?.team ?? user?.department ?? '').trim();

    if (name && team) {
      map.set(name, team);
    }
  }

  return map;
}

function getAssigneeTeam(record: any, userTeamMap: Map<string, string>): string {
  const assignee = normalizeReportText(
    record?.assignee ??
    record?.담당자 ??
    record?.managerName
  );

  return assignee ? (userTeamMap.get(assignee) || '') : '';
}

// --- Referral Segment Classifier ---
function isSouthReferral(record: any): boolean {
  const text = [
    record?.team,
    record?.subTeam,
    record?.region,
    record?.department,
    record?.branch,
    record?.center,
    record?.담당부서,
    record?.권역,
    record?.지역
  ].map(normalizeReportText).join(' ');

  return text.includes('남부') || text.includes('남부분소');
}

function isRecoveryReferral(record: any): boolean {
  const text = [
    record?.team,
    record?.subTeam,
    record?.department,
    record?.caseType,
    record?.category,
    record?.분류
  ].map(normalizeReportText).join(' ');

  return text.includes('회복') || text.includes('회복팀');
}

function isSuicideReferral(record: any): boolean {
  const text = [
    record?.team,
    record?.subTeam,
    record?.type,
    record?.caseType,
    record?.referralType,
    record?.category,
    record?.riskType,
    record?.의뢰유형,
    record?.분류
  ].map(normalizeReportText).join(' ');

  return text.includes('자살') || text.includes('자살예방') || text.includes('suicide');
}

function isYouthReferral(record: any): boolean {
  const text = [
    record?.subTeam,
    record?.targetGroup,
    record?.ageGroup,
    record?.category,
    record?.대상군,
    record?.연령대,
    record?.분류
  ].map(normalizeReportText).join(' ');

  return text.includes('청년') || isYouthAge(getNumericAge(record));
}

function isChildYouthReferral(record: any): boolean {
  const text = [
    record?.team,
    record?.subTeam,
    record?.targetGroup,
    record?.ageGroup,
    record?.category,
    record?.대상군,
    record?.연령대,
    record?.분류
  ].map(normalizeReportText).join(' ');

  return (
    text.includes('아청') ||
    text.includes('아동청소년') ||
    text.includes('청소년') ||
    text.includes('아동') ||
    isChildYouthAge(getNumericAge(record))
  );
}

// --- Suicide Attempter Segment Classifier ---
function isSouthSuicideAttempter(record: any, userTeamMap: Map<string, string>): boolean {
  const team = normalizeReportText(getAssigneeTeam(record, userTeamMap));

  const text = [
    team,
    record?.region,
    record?.담당부서,
    record?.권역,
    record?.지역
  ].map(normalizeReportText).join(' ');

  return text.includes('남부') || text.includes('남부분소');
}

function isRecoverySuicideAttempter(record: any, userTeamMap: Map<string, string>): boolean {
  const team = normalizeReportText(getAssigneeTeam(record, userTeamMap));
  return team.includes('회복') || team.includes('회복팀');
}

function isSuicideSuicideAttempter(record: any): boolean {
  return true;
}

function isYouthSuicideAttempter(record: any): boolean {
  return isYouthAge(getNumericAge(record));
}

function isChildYouthSuicideAttempter(record: any, userTeamMap: Map<string, string>): boolean {
  const team = normalizeReportText(getAssigneeTeam(record, userTeamMap));

  const text = [
    team,
    record?.targetGroup,
    record?.ageGroup,
    record?.대상군,
    record?.연령대
  ].map(normalizeReportText).join(' ');

  return (
    text.includes('아청') ||
    text.includes('아동청소년') ||
    text.includes('청소년') ||
    text.includes('아동') ||
    isChildYouthAge(getNumericAge(record))
  );
}

// --- Summary Builders ---
function buildReferralSegmentSummary(records: any[]) {
  const safeRecords = Array.isArray(records) ? records : [];
  const southRecords = safeRecords.filter(isSouthReferral);

  return {
    total: southRecords.length,
    south: southRecords.length,
    recovery: southRecords.filter(isRecoveryReferral).length,
    suicide: southRecords.filter(isSuicideReferral).length,
    youth: southRecords.filter(isYouthReferral).length,
    childYouth: southRecords.filter(isChildYouthReferral).length
  };
}

function buildSuicideSegmentSummary(
  records: any[],
  userTeamMap: Map<string, string>
) {
  const safeRecords = Array.isArray(records) ? records : [];
  const southRecords = safeRecords.filter((record) =>
    isSouthSuicideAttempter(record, userTeamMap)
  );

  return {
    total: southRecords.length,
    south: southRecords.length,
    recovery: southRecords.filter((record) =>
      isRecoverySuicideAttempter(record, userTeamMap)
    ).length,
    suicide: southRecords.filter(isSuicideSuicideAttempter).length,
    youth: southRecords.filter(isYouthSuicideAttempter).length,
    childYouth: southRecords.filter((record) =>
      isChildYouthSuicideAttempter(record, userTeamMap)
    ).length
  };
}

// --- Memoized Sub-components ---

const SuicideDonutChart = React.memo(({ title, data, colors, chartId, downloadImage, downloadExcel }: any) => {
    const totalN = useMemo(() => data ? data.reduce((acc: number, curr: any) => acc + (curr.value || 0), 0) : 0, [data]);
    const isEmpty = !data || data.length === 0 || totalN === 0;
    
    return (
        <div id={chartId} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col h-[400px]">
            <div className="w-full flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-slate-700">{title}</h4>
                    {!isEmpty && <span className="text-[10px] font-black text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">N={totalN}</span>}
                </div>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600">📷</button>
                        <button onClick={() => downloadExcel(data, title)} className="text-xs text-slate-400 hover:text-slate-600">📥</button>
                    </div>
                )}
            </div>
            <div className="flex-1 min-h-0 relative flex items-center justify-center">
                {isEmpty ? (
                    <div className="flex flex-col items-center justify-center text-slate-400 text-sm gap-2">
                        <span>📊</span>
                        <span>표시할 통계 데이터가 없습니다.</span>
                    </div>
                ) : (
                    <div className="w-full h-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="40%"
                                    innerRadius={40}
                                    outerRadius={65}
                                    paddingAngle={5}
                                    dataKey="value"
                                    label={({ name, percent }) => 
                                        shouldShowPieLabel(percent) 
                                            ? `${truncateLabel(name, 6)} ${(percent * 100).toFixed(0)}%` 
                                            : ""
                                    }
                                    labelLine={true}
                                >
                                    {data.map((entry: any, index: number) => (
                                        <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend 
                                    verticalAlign="bottom" 
                                    align="center" 
                                    iconSize={8} 
                                    formatter={(value) => truncateLabel(value, 8)}
                                    wrapperStyle={{ 
                                        fontSize: '11px',
                                        paddingTop: 10,
                                        lineHeight: '16px'
                                    }} 
                                />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>
        </div>
    );
});

const SuicideStatRow = React.memo(({ label, data, isQuarter = false }: any) => {
    const totalCount = data.total;
    const agreeRate = totalCount > 0 ? Math.round(((data.process.consent || 0) / totalCount) * 100) : 0;
    const isTotal = label === '총 합계';

    return (
        <tr className={`text-center text-xs border-b ${isTotal ? 'bg-slate-200 font-extrabold text-slate-900' : isQuarter ? 'bg-slate-100 font-bold' : 'bg-white hover:bg-slate-50'}`} key={label}>
            <td className="py-2 border-r font-medium text-center">{label}</td>
            <td className="border-r bg-slate-50/50 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.agency.police}</td>
            <td className="border-r text-center">{data.agency.fire}</td>
            <td className="border-r text-center">{data.agency.other}</td>
            <td className="border-r bg-pink-50/20 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.gender.male}</td>
            <td className="border-r text-center">{data.gender.female}</td>
            <td className="border-r text-center">{data.gender.unknown}</td>
            <td className="border-r bg-slate-50/50 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.target.self}</td>
            <td className="border-r text-center">{data.target.family}</td>
            <td className="border-r text-center">{data.target.bereaved}</td>
            <td className="border-r text-center">{data.target.unknown}</td>
            <td className="border-r bg-slate-50/50 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.age.tens}</td>
            <td className="border-r text-center">{data.age.twenties}</td>
            <td className="border-r text-center">{data.age.thirties}</td>
            <td className="border-r text-center">{data.age.forties}</td>
            <td className="border-r text-center">{data.age.fifties}</td>
            <td className="border-r text-center">{data.age.sixties}</td>
            <td className="border-r text-center">{data.age.seventies}</td>
            <td className="border-r text-center">{data.age.eightiesOver}</td>
            <td className="border-r text-center">{data.age.unknown}</td>
            <td className="border-r bg-slate-50/50 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.process.disposal}</td>
            <td className="border-r text-center">{data.process.consent}</td>
            <td className="border-r text-center">{data.process.processing}</td>
            <td className="border-r bg-slate-50/50 text-center">{totalCount}</td>
            <td className="border-r text-center">{data.intervention.general}</td>
            <td className="border-r text-center">{data.intervention.crisis}</td>
            <td className="border-r text-center">{data.intervention.deregistered}</td>
            <td className="border-r text-center">{data.intervention.linked}</td>
            <td className="border-r text-center">{data.intervention.none}</td>
            <td className="border-r bg-slate-50/50 text-center">{data.process.disposal}</td>
            <td className="border-r text-center">{data.destroyReason.reject}</td>
            <td className="border-r text-center">{data.destroyReason.request}</td>
            <td className="border-r text-center">{data.destroyReason.error}</td>
            <td className="border-r text-center">{data.destroyReason.absence}</td>
            <td className="border-r text-center">{data.destroyReason.other}</td>
            <td className="font-bold text-blue-600 text-center">{agreeRate}%</td>
        </tr>
    );
});

const SuicideReportDashboard = React.memo(({ stats, downloadImage, downloadExcel, downloadTableAsExcel }: any) => {
    if (!stats) return null;

    const { monthly, q1, q2, q3, q4, total, processingDistribution, registrationDistribution } = stats;
    const quarters = [
        { label: '1분기 요약', data: q1, color: 'bg-blue-50 text-blue-700' },
        { label: '2분기 요약', data: q2, color: 'bg-indigo-50 text-indigo-700' },
        { label: '3분기 요약', data: q3, color: 'bg-purple-50 text-purple-700' },
        { label: '4분기 요약', data: q4, color: 'bg-green-50 text-green-700' },
    ];

    return (
        <div className="space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <SuicideDonutChart title="처리구분별 분포" data={processingDistribution} colors={COLORS_PROCESS} chartId="suicide-chart-processing" downloadImage={downloadImage} downloadExcel={downloadExcel} />
                <SuicideDonutChart title="등록 여부별 분포" data={registrationDistribution} colors={COLORS_REG} chartId="suicide-chart-registration" downloadImage={downloadImage} downloadExcel={downloadExcel} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {quarters.map((q, idx) => (
                    <div key={idx} className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 flex flex-col justify-between transition-all hover:shadow-md">
                        <div>
                            <h4 className={`text-sm font-bold mb-4 ${q.color.split(' ')[1]}`}>{q.label}</h4>
                            <div className="flex items-baseline gap-1 mb-6">
                                <span className="text-4xl font-extrabold text-slate-800">{q.data.total}</span>
                                <span className="text-sm text-slate-500">건</span>
                            </div>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between text-xs text-slate-500 mb-1">
                                    <span>서비스 동의율</span>
                                    <span className="font-bold text-slate-700">{q.data.agreeRate}%</span>
                                </div>
                                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${q.data.agreeRate > 50 ? 'bg-green-500' : 'bg-blue-500'}`}
                                        style={{ width: `${q.data.agreeRate}%` }}
                                    ></div>
                                </div>
                            </div>
                            <div className="flex justify-between items-center pt-2 border-t border-slate-50">
                                <span className="text-xs text-slate-500">최다 연령층</span>
                                <span className={`text-sm font-bold ${q.color.split(' ')[1]}`}>{q.data.maxAge}</span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden p-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold text-slate-700">상세 통계</h3>
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage('suicide-stats-table', '자살시도자_통계')} className="text-xs text-slate-400 hover:text-slate-600">📷</button>
                        <button onClick={() => downloadTableAsExcel('suicide-stats-table', '자살시도자_통계')} className="text-xs text-slate-400 hover:text-slate-600">📥</button>
                    </div>
                </div>
                <div className="overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0">
                    <table id="suicide-stats-table" className="w-full min-w-[1000px] md:min-w-[1200px] border-collapse">
                        <thead>
                            <tr className="bg-slate-50 text-xs text-slate-500 border-b">
                                <th rowSpan={2} className="py-2 px-3 border-r font-medium text-center">구분</th>
                                <th colSpan={4} className="py-2 border-r font-medium text-blue-600 bg-blue-50/30 text-center">정보제공</th>
                                <th colSpan={4} className="py-2 border-r font-medium text-pink-600 bg-pink-50/30 text-center">성별</th>
                                <th colSpan={5} className="py-2 border-r font-medium text-indigo-600 bg-indigo-50/30 text-center">대상</th>
                                <th colSpan={10} className="py-2 border-r font-medium text-purple-600 bg-purple-50/30 text-center">연령대</th>
                                <th colSpan={4} className="py-2 border-r font-medium text-orange-600 bg-orange-50/30 text-center">처리</th>
                                <th colSpan={6} className="py-2 border-r font-medium text-green-600 bg-green-50/30 text-center">개입</th>
                                <th colSpan={6} className="py-2 border-r font-medium text-red-600 bg-red-50/30 text-center">파기사유</th>
                                <th rowSpan={2} className="py-2 px-3 font-medium text-slate-700 bg-slate-100 text-center">동의율</th>
                            </tr>
                            <tr className="bg-slate-50 text-[10px] text-slate-400 border-b">
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">경찰</th><th className="py-1 border-r text-center">소방</th><th className="py-1 border-r text-center">기타</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">남</th><th className="py-1 border-r text-center">여</th><th className="py-1 border-r text-center">미상</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">시도자</th><th className="py-1 border-r text-center">가족</th><th className="py-1 border-r text-center">유족</th><th className="py-1 border-r text-center">미상</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">10대</th><th className="py-1 border-r text-center">20대</th><th className="py-1 border-r text-center">30대</th><th className="py-1 border-r text-center">40대</th><th className="py-1 border-r text-center">50대</th><th className="py-1 border-r text-center">60대</th><th className="py-1 border-r text-center">70대</th><th className="py-1 border-r text-center">80대↑</th><th className="py-1 border-r text-center">미상</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">파기</th><th className="py-1 border-r text-center">동의</th><th className="py-1 border-r text-center">처리중</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">일반</th><th className="py-1 border-r text-center">위기</th><th className="py-1 border-r text-center">퇴록</th><th className="py-1 border-r text-center">연계</th><th className="py-1 border-r text-center">미기재</th>
                                <th className="py-1 border-r text-center font-bold">총</th><th className="py-1 border-r text-center">거부</th><th className="py-1 border-r text-center">요청</th><th className="py-1 border-r text-center">오류</th><th className="py-1 border-r text-center">부재</th><th className="py-1 border-r text-center">기타</th>
                            </tr>
                        </thead>
                        <tbody>
                            {monthly.slice(0, 3).map((m: any) => <SuicideStatRow key={m.month} label={`${m.month}월`} data={m} />)}
                            <SuicideStatRow label="1분기" data={q1} isQuarter />
                            {monthly.slice(3, 6).map((m: any) => <SuicideStatRow key={m.month} label={`${m.month}월`} data={m} />)}
                            <SuicideStatRow label="2분기" data={q2} isQuarter />
                            {monthly.slice(6, 9).map((m: any) => <SuicideStatRow key={m.month} label={`${m.month}월`} data={m} />)}
                            <SuicideStatRow label="3분기" data={q3} isQuarter />
                            {monthly.slice(9, 12).map((m: any) => <SuicideStatRow key={m.month} label={`${m.month}월`} data={m} />)}
                            <SuicideStatRow label="4분기" data={q4} isQuarter />
                            <SuicideStatRow label="총 합계" data={total} isQuarter />
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
});

interface SegmentSummary {
  total: number;
  south: number;
  recovery: number;
  suicide: number;
  youth: number;
  childYouth: number;
}

const SegmentSummaryPanel = React.memo(({
  referralSummary,
  suicideSummary,
  hasUsersMap
}: {
  referralSummary: SegmentSummary;
  suicideSummary: SegmentSummary;
  hasUsersMap: boolean;
}) => {
  return (
    <div className="bg-white p-8 rounded-[2.5rem] border-2 border-slate-50 shadow-sm mb-12 animate-load no-print" style={{ animationDelay: '0.35s' }}>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h3 className="text-xl font-black text-slate-800 tracking-tight">남부 의뢰 대상자 세부분류 통계</h3>
          <p className="text-xs font-bold text-slate-400 mt-1">남부 의뢰 대상자 중 회복·자살·청년·아청 해당 건수입니다.</p>
        </div>
        <div className="text-[10px] text-slate-400 bg-slate-50 px-3 py-1.5 rounded-xl font-bold leading-relaxed max-w-md">
          * 각 항목은 중복 포함 기준입니다. 예: 남부 청년 대상자는 남부 전체와 청년 항목에 함께 포함될 수 있습니다.
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-100">
        <table className="w-full text-xs text-center border-collapse">
          <thead>
            <tr className="bg-slate-50 text-slate-500 font-black border-b border-slate-100">
              <th className="py-3 px-4 text-left font-bold border-r border-slate-100">구분</th>
              <th className="py-3 px-4 font-bold border-r border-slate-100 bg-slate-100/50">남부 전체</th>
              <th className="py-3 px-4 font-bold border-r border-slate-100 text-emerald-600 bg-emerald-50/20">회복</th>
              <th className="py-3 px-4 font-bold border-r border-slate-100 text-rose-600 bg-rose-50/20">자살</th>
              <th className="py-3 px-4 font-bold border-r border-slate-100 text-amber-600 bg-amber-50/20">청년 (만19~34세)</th>
              <th className="py-3 px-4 font-bold text-sky-600 bg-sky-50/20">아청 (만19세미만)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            <tr className="hover:bg-slate-50/50 transition-colors">
              <td className="py-3.5 px-4 text-left font-black border-r border-slate-100 bg-slate-50/30">일반 의뢰</td>
              <td className="py-3.5 px-4 font-extrabold border-r border-slate-100 bg-slate-50/10 text-slate-800">{referralSummary.total}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-emerald-700">{referralSummary.recovery}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-rose-700">{referralSummary.suicide}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-amber-700">{referralSummary.youth}건</td>
              <td className="py-3.5 px-4 font-bold text-sky-700">{referralSummary.childYouth}건</td>
            </tr>
            <tr className="hover:bg-slate-50/50 transition-colors">
              <td className="py-3.5 px-4 text-left font-black border-r border-slate-100 bg-slate-50/30">자살시도자</td>
              <td className="py-3.5 px-4 font-extrabold border-r border-slate-100 bg-slate-50/10 text-slate-800">{suicideSummary.total}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-emerald-700">{suicideSummary.recovery}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-rose-700">{suicideSummary.suicide}건</td>
              <td className="py-3.5 px-4 font-bold border-r border-slate-100 text-amber-700">{suicideSummary.youth}건</td>
              <td className="py-3.5 px-4 font-bold text-sky-700">{suicideSummary.childYouth}건</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-400 font-bold mt-3 text-right">
        {hasUsersMap
          ? "* 자살시도자의 남부/회복 분류는 담당자 소속팀 기준으로 집계됩니다."
          : "* 자살시도자의 남부/회복 분류는 담당자 팀 정보 연동 시 더 정확해질 수 있습니다."}
      </p>
    </div>
  );
});;

interface ReportsPageProps {
    referrals: Referral[];
    suicideAttempterReferrals: SuicideAttempterReferral[];
    sortedTeamTabs: Team[];
    users?: User[];
}

// --- Reports Page ---
type TabType = 'all' | 'team' | 'suicide' | 'nambu';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#8dd1e1', '#a4de6c', '#d0ed57'];

const AGE_LABEL_MAP: Record<string, string> = {
    'tens': '10대',
    'twenties': '20대',
    'thirties': '30대',
    'forties': '40대',
    'fifties': '50대',
    'sixties': '60대',
    'seventies': '70대',
    'eightiesOver': '80대↑',
    'unknown': '미상'
};

const CustomTooltip = React.memo(({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const dataItem = payload[0];
        const name = dataItem.name || label || '미입력';
        const value = dataItem.value ?? 0;
        
        let percentStr = '';
        if (dataItem.percent !== undefined) {
            percentStr = ` (${(dataItem.percent * 100).toFixed(1)}%)`;
        } else if (dataItem.payload && dataItem.payload.percent !== undefined) {
            percentStr = ` (${(dataItem.payload.percent * 100).toFixed(1)}%)`;
        }

        return (
            <div className="bg-white p-3 border border-slate-200 shadow-lg rounded-xl">
                <p className="font-bold text-slate-800 text-sm mb-1">{name}</p>
                <p className="text-sm font-semibold text-indigo-600">
                    {`건수 : ${value}건${percentStr}`}
                </p>
            </div>
        );
    }
    return null;
});

const ReportPieChart = React.memo(({ title, data, colorIndexOffset = 0, downloadImage, downloadExcel }: any) => {
    const chartId = `chart-${title.replace(/\s+/g, '-')}`;
    const isEmpty = !data || data.length === 0;

    return (
        <div id={chartId} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[400px] chart-wrapper max-w-[100vw] overflow-hidden">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm md:text-lg font-bold text-slate-700 truncate">{title}</h3>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600">📷</button>
                        <button onClick={() => downloadExcel(data, title)} className="text-xs text-slate-400 hover:text-slate-600">📥</button>
                    </div>
                )}
            </div>
            <div className="flex-1 min-h-0 relative flex items-center justify-center">
                {isEmpty ? (
                    <div className="flex flex-col items-center justify-center text-slate-400 text-sm gap-2">
                        <span>📊</span>
                        <span>표시할 통계 데이터가 없습니다.</span>
                    </div>
                ) : (
                    <div className="w-full h-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart margin={{ top: 10, right: 10, bottom: 30, left: 10 }}>
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="40%"
                                    innerRadius="35%"
                                    outerRadius="55%"
                                    paddingAngle={5}
                                    dataKey="value"
                                    label={({ name, percent }) =>
                                        shouldShowPieLabel(percent) ? `${truncateLabel(name, 6)} ${(percent * 100).toFixed(0)}%` : ""
                                    }
                                    labelLine={true}
                                >
                                    {data.map((entry: any, index: number) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[(index + colorIndexOffset) % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend 
                                    verticalAlign="bottom"
                                    align="center"
                                    iconSize={8}
                                    formatter={(value) => truncateLabel(value, 8)}
                                    wrapperStyle={{
                                        fontSize: 11,
                                        paddingTop: 10,
                                        lineHeight: '16px'
                                    }}
                                />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>
        </div>
    );
});

const ReportBarChart = React.memo(({ title, data, color = "#8884d8", downloadImage, downloadExcel }: any) => {
    const chartId = `chart-${title.replace(/\s+/g, '-')}`;
    const isEmpty = !data || data.length === 0;

    return (
        <div id={chartId} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[400px]">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm md:text-lg font-bold text-slate-700 truncate">{title}</h3>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600">📷</button>
                        <button onClick={() => downloadExcel(data, title)} className="text-xs text-slate-400 hover:text-slate-600">📥</button>
                    </div>
                )}
            </div>
            <div className="flex-1 min-h-0 relative flex items-center justify-center">
                {isEmpty ? (
                    <div className="flex flex-col items-center justify-center text-slate-400 text-sm gap-2">
                        <span>📊</span>
                        <span>표시할 통계 데이터가 없습니다.</span>
                    </div>
                ) : (
                    <div className="w-full h-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ top: 10, right: 45, left: 10, bottom: 10 }}>
                                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                                <XAxis type="number" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={{ stroke: '#cbd5e1' }} />
                                <YAxis 
                                    dataKey="name" 
                                    type="category" 
                                    width={110} 
                                    tick={{ fontSize: 11, fill: '#475569', fontWeight: 600 }} 
                                    interval={0} 
                                    tickFormatter={(val) => truncateLabel(val, 12)}
                                    axisLine={{ stroke: '#cbd5e1' }}
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="value" fill={color} barSize={16} radius={[0, 4, 4, 0]}>
                                    <LabelList dataKey="value" position="right" fontSize={11} fontWeight="bold" fill="#334155" formatter={(v: number) => `${v}건`} />
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </div>
        </div>
    );
});

export default function ReportsPage({ referrals, suicideAttempterReferrals, sortedTeamTabs, users }: ReportsPageProps) {
    const downloadImage = async (elementId: string, fileName: string) => {
        const element = document.getElementById(elementId);
        if (!element) return;
        try {
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 2 });
            const dataUrl = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.href = dataUrl;
            link.download = `${fileName}.png`;
            link.click();
        } catch (error) {
            console.error('Image download failed:', error);
        }
    };

    const downloadExcel = (data: any[], fileName: string) => {
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        saveAs(new Blob([wbout], { type: 'application/octet-stream' }), `${fileName}.xlsx`);
    };

    const downloadTableAsExcel = (tableId: string, fileName: string) => {
        const table = document.getElementById(tableId);
        if (!table) return;
        const wb = XLSX.utils.table_to_book(table);
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        saveAs(new Blob([wbout], { type: 'application/octet-stream' }), `${fileName}.xlsx`);
    };
    const [activeTab, setActiveTab] = useState<TabType>('all');
    const [selectedTeam, setSelectedTeam] = useState<string>('전체');

    // 기간 필터 상태 (대시보드와 정합성을 위해 기본값은 빈 값 = 전체 기간)
    const [startDate, setStartDate] = useState<string>('');
    const [endDate, setEndDate] = useState<string>('');

    // 데이터 필터링 및 중복 제거 로직 (ReferralDashboardV2와 일치)
    const filteredReferrals = useMemo(() => {
        if (activeTab === 'suicide') return []; // Short-circuit
        if (!referrals || referrals.length === 0) return [];

        // 1. 중복 제거 (clientId 또는 refNo_name_date 기준)
        const seen = new Set();
        const uniqueData = referrals
            .filter(r => {
                const key = r.clientId || `${r.refNo}_${r.name}_${r.requestDate}`;
                if (!key || key.startsWith('NO ID')) return true;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        let data = [...uniqueData];

        // 2. 기간 필터 적용
        if (startDate) {
            data = data.filter(r => r.requestDate >= startDate);
        }
        if (endDate) {
            data = data.filter(r => r.requestDate <= endDate);
        }

        // 3. 탭/팀 필터 적용
        if (activeTab === 'team' && selectedTeam !== '전체') {
            data = data.filter(r =>
                r.team === selectedTeam ||
                (r.team === '남부분소' && r.subTeam === selectedTeam)
            );
        }

        return data;
    }, [referrals, activeTab, selectedTeam, startDate, endDate]);

    // 자살시도자 데이터 (탭에 따라 필터링) - Optimized short-circuit
    const filteredSaReferrals = useMemo(() => {
        if (activeTab !== 'suicide' && activeTab !== 'all' && activeTab !== 'nambu') return [];
        if (!suicideAttempterReferrals || suicideAttempterReferrals.length === 0) return [];
        let data = [...suicideAttempterReferrals];

        // 기간 필터 적용 - receiptDate 기준
        if (startDate) {
            data = data.filter(r => (r.receiptDate || '') >= startDate);
        }
        if (endDate) {
            data = data.filter(r => (r.receiptDate || '') <= endDate);
        }

        if (activeTab === 'nambu') {
            data = data.filter(r => (r.region || '').includes('남부'));
        }
        return data;
    }, [suicideAttempterReferrals, activeTab, startDate, endDate]);

    const userTeamMap = useMemo(() => {
        return buildUserTeamMap(users || []);
    }, [users]);

    const referralSegmentSummary = useMemo(() => {
        const summary = buildReferralSegmentSummary(filteredReferrals);
        console.log('[Referral Segment Summary]', summary);
        return summary;
    }, [filteredReferrals]);

    const suicideSegmentSummary = useMemo(() => {
        const summary = buildSuicideSegmentSummary(filteredSaReferrals, userTeamMap);
        console.log('[Suicide Attempter Segment Summary]', summary);
        return summary;
    }, [filteredSaReferrals, userTeamMap]);

    // 12. 진단명 현황 (실제 데이터 집계 + 정규화)
    const diagnosisData = useMemo(() => {
        if (activeTab === 'suicide') return []; // Short-circuit
        // 1. 모든 표준 진단명에 대해 초기값 0 설정
        const counts: Record<string, number> = {};
        DIAGNOSIS_OPTIONS.forEach(option => {
            counts[option] = 0;
        });

        if (!filteredReferrals) return [];

        filteredReferrals.forEach(r => {
            const raw = (r.diagnosisName || '').trim().toLowerCase();
            if (!raw) return; // 빈 값은 패스 (또는 '미입력'으로 처리할 수도 있음)

            let matched = false;

            // 정규화 로직
            if (raw.includes('우울')) {
                counts['우울증']++;
                matched = true;
            } else if (raw.includes('조현') || raw.includes('schizo')) {
                counts['조현병']++;
                matched = true;
            } else if (raw.includes('조울') || raw.includes('양극성') || raw.includes('bipolar')) {
                counts['조울증']++;
                matched = true;
            } else if (raw.includes('불안') || raw.includes('공황')) {
                counts['불안장애']++;
                matched = true;
            } else if (raw.includes('치매') || raw.includes('인지') || raw.includes('알츠하이머')) {
                counts['치매']++;
                matched = true;
            } else if (raw.includes('알코올') || raw.includes('알콜') || raw.includes('마약') || raw.includes('약물') || (raw.includes('중독') && !raw.includes('도박') && !raw.includes('게임') && !raw.includes('인터넷'))) {
                // 중독인데 행위중독 키워드가 없으면 물질중독으로 간주
                counts['물질중독']++;
                matched = true;
            } else if (raw.includes('도박') || raw.includes('게임') || raw.includes('인터넷') || raw.includes('스마트폰') || raw.includes('쇼핑')) {
                counts['행위중독']++;
                matched = true;
            } else if (raw.includes('아동') || raw.includes('adhd') || raw.includes('주의력') || raw.includes('틱') || raw.includes('품행')) {
                counts['아동기정신질환 및 정신건강문제']++;
                matched = true;
            } else if (raw.includes('미정') || raw.includes('불명') || raw.includes('구분하기 어려움')) {
                counts['구분하기 어려움']++;
                matched = true;
            }

            // 매칭되지 않은 경우 기타질환
            if (!matched) {
                // 이미 DIAGNOSIS_OPTIONS에 '기타질환'이 있는지 확인. 
                // constants.ts에 의하면 '기타질환'이 있음.
                counts['기타질환']++;
            }
        });

        return Object.keys(counts)
            .map(d => ({ name: d, value: counts[d] }))
            // 0인 항목도 보여줄지 여부는 기획에 따라 다르지만 "항목이 전부 들어가있고"라고 했으므로 0이라도 포함.
            // 정렬은 값이 큰 순서대로, 값이 같으면 가나다순? 
            // 일단 값이 큰 순서대로 정렬하되, 사용자가 정의한 순서를 유지하고 싶다면 정렬을 빼야 함.
            // 하지만 보통 파이차트는 큰게 먼저 보이는게 좋음. 
            // "이항목이 전부 들어가있고" -> This implies they want to SEE the list. 
            // I will sort by value descending.
            .sort((a, b) => b.value - a.value);
    }, [filteredReferrals]);


    // --- 차트 데이터 생성 (filteredReferrals 기반) ---

    // 1. 팀별 의뢰 건수
    const teamData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const teamName = r.team || '미지정';
            counts[teamName] = (counts[teamName] || 0) + 1;
        });
        return Object.keys(counts).map(team => ({ name: team, value: counts[team] }));
    }, [filteredReferrals]);

    // 2. 월별 의뢰 추이
    const monthlyData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            if (r.requestDate) {
                const month = r.requestDate.substring(0, 7); // YYYY-MM
                counts[month] = (counts[month] || 0) + 1;
            }
        });
        return Object.keys(counts).sort().map(month => ({ name: month, value: counts[month] }));
    }, [filteredReferrals]);

    // 3. 의뢰 경로
    const pathData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const path = r.referralPath || '기타';
            counts[path] = (counts[path] || 0) + 1;
        });
        return Object.keys(counts)
            .map(path => ({ name: path, value: counts[path] }))
            .sort((a, b) => b.value - a.value);
    }, [filteredReferrals]);

    // 4. 성별 분포
    const genderData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const gender = r.gender || '미상';
            counts[gender] = (counts[gender] || 0) + 1;
        });
        return Object.keys(counts).map(g => ({ name: g, value: counts[g] }));
    }, [filteredReferrals]);

    // 5. 연령대 분포 (Binned: 10대, 20대, 30대, 40대, 50대, 60대, 65세 이상)
    const ageData = useMemo(() => {
        const AGE_BINS = ['10대 미만', '10대', '20대', '30대', '40대', '50대', '60대', '65세 이상', '미상'];
        const counts: Record<string, number> = {};
        AGE_BINS.forEach(bin => { counts[bin] = 0; });

        filteredReferrals.forEach(r => {
            const raw = r.age;
            let label = '미상';
            if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
                const s = String(raw).trim();
                if (s.includes('대')) {
                    label = s;
                } else {
                    const n = Number(s.replace(/[^0-9.-]/g, ''));
                    if (!isNaN(n)) {
                        if (n < 10) label = '10대 미만';
                        else if (n >= 65) label = '65세 이상';
                        else label = `${Math.floor(n / 10) * 10}대`;
                    }
                }
            }
            counts[label] = (counts[label] || 0) + 1;
        });

        return AGE_BINS.map(age => ({ name: age, value: counts[age] }));
    }, [filteredReferrals]);

    // 6. 지역별 분포
    const regionData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const region = r.region || '미상';
            counts[region] = (counts[region] || 0) + 1;
        });
        return Object.keys(counts).map(r => ({ name: r, value: counts[r] })).sort((a, b) => b.value - a.value);
    }, [filteredReferrals]);

    // 7. 위기 등급
    const criData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const level = r.criLevel ? r.criLevel.toUpperCase() : '미정';
            counts[level] = (counts[level] || 0) + 1;
        });
        return Object.keys(counts).sort().map(l => ({ name: l, value: counts[l] }));
    }, [filteredReferrals]);

    // 8. 종결 상태
    const closureData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            const status = r.closureStatus || '미종결';
            counts[status] = (counts[status] || 0) + 1;
        });
        return Object.keys(counts).map(s => ({ name: s, value: counts[s] }));
    }, [filteredReferrals]);

    // 9. 경찰 개입 여부
    const policeData = useMemo(() => {
        const counts: Record<string, number> = { '개입': 0, '미개입': 0 };
        filteredReferrals.forEach(r => {
            if (r.policeIntervention) counts['개입']++;
            else counts['미개입']++;
        });
        return Object.keys(counts).map(k => ({ name: k, value: counts[k] }));
    }, [filteredReferrals]);

    // 담당자별 현황 데이터
    const counselorData = useMemo(() => {
        const stats: { [key: string]: { total: number; ongoing: number } } = {};

        filteredReferrals.forEach(r => {
            const counselor = r.assignee || '미지정';
            if (!stats[counselor]) {
                stats[counselor] = { total: 0, ongoing: 0 };
            }
            stats[counselor].total += 1;
            if (r.closureStatus === '미종결') {
                stats[counselor].ongoing += 1;
            }
        });

        return Object.entries(stats)
            .map(([name, data]) => ({ name, ...data }))
            .sort((a, b) => b.total - a.total);
    }, [filteredReferrals]);

    // 10. 자살시도자 개입 상태 (filteredSaReferrals 기반)
    const saStatusData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredSaReferrals.forEach(s => {
            const status = s.interventionStatus || '미정';
            counts[status] = (counts[status] || 0) + 1;
        });
        return Object.keys(counts).map(status => ({ name: status, value: counts[status] }));
    }, [filteredSaReferrals]);

    // 11. 조치 결과 (일반 의뢰) - '등록관리' 관련 항목 정규화
    const actionResultData = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredReferrals.forEach(r => {
            let result = r.actionResult || '미입력';
            // '등록관리'가 포함된 모든 결과(예: 등록관리(기등록 포함))를 '등록관리'로 통합하여 통계 산출
            if (result.includes('등록관리')) {
                result = '등록관리';
            }
            counts[result] = (counts[result] || 0) + 1;
        });
        return Object.keys(counts).map(r => ({ name: r, value: counts[r] }));
    }, [filteredReferrals]);


    // --- 자살시도자 통계 전용 로직 ---
    const suicideStats = useMemo(() => {
        if (activeTab !== 'suicide') return null;

        // 월별 데이터 초기화 (1~12월)
        const createZeroStat = () => ({
            total: 0,
            agency: { police: 0, fire: 0, other: 0 },
            gender: { male: 0, female: 0, unknown: 0 },
            target: { self: 0, family: 0, bereaved: 0, unknown: 0 },
            age: { tens: 0, twenties: 0, thirties: 0, forties: 0, fifties: 0, sixties: 0, seventies: 0, eightiesOver: 0, unknown: 0 },
            process: { disposal: 0, consent: 0, processing: 0 },
            intervention: { general: 0, crisis: 0, deregistered: 0, linked: 0, none: 0 },
            destroyReason: { reject: 0, request: 0, error: 0, absence: 0, other: 0 }
        });

        const monthlyStats = Array.from({ length: 12 }, (_, i) => ({
            month: i + 1,
            ...createZeroStat()
        }));

        // 도넛 차트용 데이터 초기화
        const processingCounts: Record<string, number> = {};
        const registrationCounts: Record<string, number> = {};

        // 데이터 집계
        filteredSaReferrals.forEach(r => {
            // 처리구분별 분포 (processingStatus)
            const pStatus = r.processingStatus || '미상';
            processingCounts[pStatus] = (processingCounts[pStatus] || 0) + 1;

            // 등록 여부별 분포 (registrationStatus)
            const rStatus = r.registrationStatus || '미상';
            registrationCounts[rStatus] = (registrationCounts[rStatus] || 0) + 1;

            if (!r.receiptDate) return;
            const month = parseInt(r.receiptDate.split('-')[1]);
            if (isNaN(month) || month < 1 || month > 12) return;

            const monthIndex = month - 1;
            const stat = monthlyStats[monthIndex];
            stat.total++;

            // 정보제공 (requestAgency + pic)
            const combinedAgency = ((r.requestAgency || '') + (r.pic || '')).replace(/\s/g, '').normalize('NFC');

            if (POLICE_REGEX.test(combinedAgency)) stat.agency.police++;
            else if (FIRE_REGEX.test(combinedAgency)) stat.agency.fire++;
            else stat.agency.other++;

            // 성별 (gender)
            const gender = (r.gender || '').trim();
            if (gender === '남성' || gender === '남') stat.gender.male++;
            else if (gender === '여성' || gender === '여') stat.gender.female++;
            else stat.gender.unknown++;

            // 대상 (infoTarget)
            if (r.infoTarget === '자살시도자' || r.infoTarget === '본인') stat.target.self++;
            else if (r.infoTarget === '가족') stat.target.family++;
            else if (r.infoTarget === '유족') stat.target.bereaved++;
            else stat.target.unknown++;

            // 연령대
            let bucket = 'unknown';
            const rawAge = String(r.age || '').trim();
            if (rawAge) {
                if (rawAge.includes('대')) {
                    if (rawAge.includes('10')) bucket = 'tens';
                    else if (rawAge.includes('20')) bucket = 'twenties';
                    else if (rawAge.includes('30')) bucket = 'thirties';
                    else if (rawAge.includes('40')) bucket = 'forties';
                    else if (rawAge.includes('50')) bucket = 'fifties';
                    else if (rawAge.includes('60')) bucket = 'sixties';
                    else if (rawAge.includes('70')) bucket = 'seventies';
                    else if (/8\d|80/.test(rawAge)) bucket = 'eightiesOver';
                } else {
                    const n = Number(rawAge.replace(/[^0-9.-]/g, ''));
                    if (!isNaN(n) && n >= 10) {
                        if (n >= 80) bucket = 'eightiesOver';
                        else bucket = ['tens', 'twenties', 'thirties', 'forties', 'fifties', 'sixties', 'seventies'][Math.floor(n / 10) - 1] || 'unknown';
                    }
                }
            }
            if (bucket !== 'unknown') (stat.age as any)[bucket]++;
            else stat.age.unknown++;

            // 처리
            if (r.processingStatus === '개인정보파기' || r.processingStatus === '거부') stat.process.disposal++;
            else if (r.processingStatus === '서비스동의') stat.process.consent++;
            else if (r.processingStatus === '처리중') stat.process.processing++;

            // 개입
            const intv = (r.interventionStatus || '').trim();
            if (intv.includes('일반상담')) stat.intervention.general++;
            else if (intv.includes('자살위기')) stat.intervention.crisis++;
            else if (intv.includes('퇴록')) stat.intervention.deregistered++;
            else if (intv.includes('연계')) stat.intervention.linked++;
            else stat.intervention.none++;

            // 파기사유
            if (r.disposalReason === '서비스거부') stat.destroyReason.reject++;
            else if (r.disposalReason === '개인정보파기요청') stat.destroyReason.request++;
            else if (r.disposalReason === '연락처오류') stat.destroyReason.error++;
            else if (r.disposalReason === '부재') stat.destroyReason.absence++;
            else if (r.disposalReason === '기타') stat.destroyReason.other++;
        });

        const processingDistribution = Object.entries(processingCounts).map(([name, value]) => ({ name, value }));
        const registrationDistribution = Object.entries(registrationCounts).map(([name, value]) => ({ name, value }));

        const getQuarterStats = (startMonth: number, endMonth: number) => {
            const quarterData = monthlyStats.slice(startMonth - 1, endMonth).reduce((acc, curr) => {
                const addObj = (target: any, source: any) => {
                    Object.keys(source).forEach(k => target[k] = (target[k] || 0) + source[k]);
                };
                acc.total += curr.total;
                addObj(acc.agency, curr.agency);
                addObj(acc.gender, curr.gender);
                addObj(acc.target, curr.target);
                addObj(acc.age, curr.age);
                addObj(acc.process, curr.process);
                addObj(acc.intervention, curr.intervention);
                addObj(acc.destroyReason, curr.destroyReason);
                return acc;
            }, createZeroStat());

            let maxAge = '미상', maxCount = -1;
            Object.entries(quarterData.age).forEach(([age, count]) => {
                if ((count as number) > maxCount) { maxCount = count as number; maxAge = AGE_LABEL_MAP[age] || age; }
            });
            return { ...quarterData, maxAge, agreeRate: quarterData.total > 0 ? Math.round((quarterData.process.consent / quarterData.total) * 100) : 0 };
        };

        return {
            monthly: monthlyStats,
            q1: getQuarterStats(1, 3), q2: getQuarterStats(4, 6), q3: getQuarterStats(7, 9), q4: getQuarterStats(10, 12),
            total: getQuarterStats(1, 12),
            processingDistribution, registrationDistribution
        };
    }, [filteredSaReferrals, activeTab]);


    // SuicideReportDashboard component moved outside

    // --- 테이블 데이터 생성 ---

    // 지역 / 월별 현황 데이터 (Optimized O(N))
    const regionMonthData = useMemo(() => {
        if (activeTab === 'suicide') return { data: [], totalRow: {}, months: [] }; // Short-circuit
        const regions = Array.from(new Set(filteredReferrals.map(r => r.region || '미상'))) as string[];
        regions.sort((a, b) => {
            if (a === '기타' || a === '미상') return 1;
            if (b === '기타' || b === '미상') return -1;
            return a.localeCompare(b);
        });
        
        const allMonths = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
        
        // Single pass aggregation
        const counts: Record<string, Record<string, number>> = {};
        regions.forEach(r => {
            counts[r] = {};
            allMonths.forEach(m => { counts[r][m] = 0; });
        });

        filteredReferrals.forEach(r => {
            const region = r.region || '미상';
            const month = r.requestDate ? r.requestDate.substring(5, 7) : null;
            if (month && counts[region]) {
                counts[region][month]++;
            }
        });

        const data = regions.map(region => {
            const row: any = { region };
            let total = 0;
            allMonths.forEach(month => {
                const count = counts[region][month] || 0;
                row[month] = count;
                total += count;
            });
            row.total = total;
            return row;
        });

        const totalRow: any = { region: '월별 총합' };
        let grandTotal = 0;
        allMonths.forEach(month => {
            const sum = data.reduce((acc, curr) => acc + (curr[month] || 0), 0);
            totalRow[month] = sum;
            grandTotal += sum;
        });
        totalRow.total = grandTotal;

        return { data, totalRow, months: allMonths };
    }, [filteredReferrals]);

    // 지역 / 연령별 현황 데이터 (Optimized O(N))
    const regionAgeData = useMemo(() => {
        if (activeTab === 'suicide') return { data: [], totalRow: {}, ageGroups: [] }; // Short-circuit
        const regions = Array.from(new Set(filteredReferrals.map(r => r.region || '미상'))) as string[];
        regions.sort((a, b) => {
            if (a === '기타' || a === '미상') return 1;
            if (b === '기타' || b === '미상') return -1;
            return a.localeCompare(b);
        });
        const ageGroups = ['10대', '20대', '30대', '40대', '50대', '60대', '65세 이상', '아동', '미상'];

        // Single pass aggregation
        const counts: Record<string, Record<string, number>> = {};
        regions.forEach(r => {
            counts[r] = {};
            ageGroups.forEach(g => { counts[r][g] = 0; });
        });

        filteredReferrals.forEach(r => {
            const region = r.region || '미상';
            if (!counts[region]) return;

            let ageGroup = '미상';
            if (!r.age) ageGroup = '미상';
            else if (r.age < 10) ageGroup = '아동';
            else if (r.age >= 65) ageGroup = '65세 이상';
            else ageGroup = Math.floor(r.age / 10) * 10 + '대';

            if (counts[region][ageGroup] !== undefined) {
                counts[region][ageGroup]++;
            }
        });

        const data = regions.map(region => {
            const row: any = { region };
            let total = 0;
            ageGroups.forEach(group => {
                const count = counts[region][group] || 0;
                row[group] = count;
                total += count;
            });
            row.total = total;
            return row;
        });

        const totalRow: any = { region: '연령별 총합' };
        let grandTotal = 0;
        ageGroups.forEach(group => {
            const sum = data.reduce((acc, curr) => acc + (curr[group] || 0), 0);
            totalRow[group] = sum;
            grandTotal += sum;
        });
        totalRow.total = grandTotal;

        return { data, totalRow, ageGroups };
    }, [filteredReferrals]);

    // Chart wrappers removed from component body and moved to top level as memoized components


    return (
        <div className="h-full w-full overflow-y-auto bg-[#f1f5f9]/50 p-6 md:p-10 custom-scrollbar lg:max-w-7xl lg:mx-auto">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-8 mb-16 no-print">
                <div className="animate-load">
                    <div className="flex items-center gap-4 mb-4">
                        <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg shadow-indigo-200">
                            <LayoutDashboard className="text-white" size={28} />
                        </div>
                        <div>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-500 bg-indigo-50 px-3 py-1 rounded-full">Executive Intelligence</span>
                            <h1 className="text-4xl font-black text-slate-900 tracking-tighter mt-1">통계 및 보고서</h1>
                        </div>
                    </div>
                    <p className="text-slate-400 font-bold ml-1">의사결정을 위한 데이터 시각화 및 전문 분석 리포트</p>
                </div>

                <div className="flex flex-col md:flex-row items-center gap-4 animate-load" style={{ animationDelay: '0.1s' }}>
                    {/* Period Filter */}
                    <div className="flex items-center gap-4 bg-white/80 backdrop-blur-xl p-3 px-5 rounded-[2rem] border-2 border-slate-50 shadow-xl shadow-slate-200/50 group transition-all hover:border-indigo-100">
                        <Calendar size={18} className="text-slate-300 group-hover:text-indigo-500 transition-colors" />
                        <div className="flex items-center gap-3">
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="bg-transparent border-none text-sm font-black text-slate-700 outline-none focus:ring-0 cursor-pointer"
                            />
                            <span className="text-slate-200 font-black">/</span>
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="bg-transparent border-none text-sm font-black text-slate-700 outline-none focus:ring-0 cursor-pointer"
                            />
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => window.print()}
                            className="flex items-center gap-3 px-6 py-4 bg-white text-slate-600 rounded-[1.5rem] font-black text-sm border-2 border-slate-50 shadow-lg shadow-slate-100 hover:bg-slate-50 transition-all hover:-translate-y-1 active:scale-95"
                        >
                            <Printer size={20} />
                            <span>인쇄</span>
                        </button>
                        <button
                            onClick={() => downloadExcel(filteredReferrals, '전체데이터')}
                            className="flex items-center gap-3 px-6 py-4 bg-indigo-600 text-white rounded-[1.5rem] font-black text-sm shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all hover:-translate-y-1 active:scale-95"
                        >
                            <FileDown size={20} />
                            <span>엑셀 다운로드</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Quick Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12 animate-load no-print" style={{ animationDelay: '0.2s' }}>
                <div className="bg-white p-8 rounded-[2.5rem] border-2 border-slate-50 shadow-sm flex items-center justify-between group hover:border-indigo-100 transition-all duration-500">
                    <div>
                        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">전체 의뢰</p>
                        <h4 className="text-3xl font-black text-slate-900 tracking-tighter">{filteredReferrals.length}</h4>
                    </div>
                    <div className="p-4 bg-indigo-50 rounded-2xl text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-500">
                        <Users size={24} />
                    </div>
                </div>
                <div className="bg-white p-8 rounded-[2.5rem] border-2 border-slate-50 shadow-sm flex items-center justify-between group hover:border-rose-100 transition-all duration-500">
                    <div>
                        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">자살 시도자</p>
                        <h4 className="text-3xl font-black text-slate-900 tracking-tighter">{filteredSaReferrals.length}</h4>
                    </div>
                    <div className="p-4 bg-rose-50 rounded-2xl text-rose-600 group-hover:bg-rose-600 group-hover:text-white transition-all duration-500">
                        <TrendingUp size={24} />
                    </div>
                </div>
                <div className="bg-white p-8 rounded-[2.5rem] border-2 border-slate-50 shadow-sm flex items-center justify-between group hover:border-emerald-100 transition-all duration-500">
                    <div>
                        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">종결율</p>
                        <h4 className="text-3xl font-black text-slate-900 tracking-tighter">
                            {filteredReferrals.length > 0 ? Math.round((filteredReferrals.filter(r => r.closureStatus === '종결').length / filteredReferrals.length) * 100) : 0}%
                        </h4>
                    </div>
                    <div className="p-4 bg-emerald-50 rounded-2xl text-emerald-600 group-hover:bg-emerald-600 group-hover:text-white transition-all duration-500">
                        <div className="font-black">OK</div>
                    </div>
                </div>
            </div>

            <SegmentSummaryPanel
                referralSummary={referralSegmentSummary}
                suicideSummary={suicideSegmentSummary}
                hasUsersMap={!!users && users.length > 0}
            />

            {/* Navigation Tabs */}
            <div className="flex items-center gap-2 bg-slate-200/50 backdrop-blur-md p-1.5 rounded-[2rem] border-2 border-white/50 w-fit mb-12 animate-load no-print" style={{ animationDelay: '0.3s' }}>
                {[
                    { id: 'all', label: '일반 의뢰', icon: '📊' },
                    { id: 'suicide', label: '자살시도자', icon: '🚨' },
                    { id: 'nambu', label: '남부분소', icon: '📍' },
                    { id: 'team', label: '팀별 분석', icon: '👥' }
                ].map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as TabType)}
                        className={`flex items-center gap-3 px-8 py-3 rounded-2xl text-sm font-black transition-all duration-300 ${activeTab === tab.id
                            ? 'bg-white text-indigo-700 shadow-xl shadow-indigo-100/50'
                            : 'text-slate-500 hover:text-slate-800'
                            }`}
                    >
                        <span>{tab.icon}</span>
                        {tab.label}
                    </button>
                ))}

                {activeTab === 'team' && (
                    <div className="border-l-2 border-slate-300 ml-2 pl-4 pr-2">
                        <select
                            value={selectedTeam}
                            onChange={(e) => setSelectedTeam(e.target.value)}
                            className="bg-transparent border-none text-sm font-black text-indigo-700 outline-none focus:ring-0 cursor-pointer"
                        >
                            <option value="전체">전체 팀</option>
                            {sortedTeamTabs.map(team => (
                                <option key={team} value={team}>{team}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>

            {/* Content Area */}
            <div className="animate-load" style={{ animationDelay: '0.4s' }}>
                {activeTab === 'suicide' ? (
                    <SuicideReportDashboard 
                        stats={suicideStats} 
                        filteredSaReferrals={filteredSaReferrals}
                        downloadImage={downloadImage}
                        downloadExcel={downloadExcel}
                        downloadTableAsExcel={downloadTableAsExcel}
                    />
                ) : (
                    <div className="space-y-12 pb-20">
                        {/* Interactive Chart Grid */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
                            {activeTab === 'nambu' && (
                                <ReportPieChart title="남부분소 세부 분류 현황" data={filteredReferrals} dataKey="subTeam" type="pie" downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            )}
                            <ReportPieChart title="의뢰 사유/경로 분석" data={pathData} colorIndexOffset={0} downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportPieChart title="진단명 분포 (전문가용)" data={diagnosisData} downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportPieChart title="위기 등급 현황" data={criData} colorIndexOffset={2} downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportPieChart title="팀별 의뢰 점유율" data={teamData} colorIndexOffset={4} downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportBarChart title="연령대별 분포" data={ageData} color="#10b981" downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportPieChart title="성별 분포" data={genderData} colorIndexOffset={8} downloadImage={downloadImage} downloadExcel={downloadExcel} />
                            <ReportBarChart title="조치결과 분석" data={actionResultData} color="#f59e0b" downloadImage={downloadImage} downloadExcel={downloadExcel} />
                        </div>


                        {/* Data Tables (Summary) */}
                        <div className="space-y-8">
                            <div className="bg-white p-10 rounded-[3rem] border-2 border-slate-50 shadow-sm overflow-hidden">
                                <div className="flex justify-between items-center mb-10">
                                    <h3 className="text-2xl font-black text-slate-900 tracking-tight">담당자별 의뢰 개입현황</h3>
                                    <span className="text-xs font-black text-slate-400 uppercase bg-slate-50 px-3 py-1 rounded-full">Report Ready</span>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm text-left">
                                        <thead>
                                            <tr className="border-b-2 border-slate-50 text-[11px] font-black text-slate-400 uppercase tracking-widest bg-slate-50/50">
                                                <th className="px-6 py-5 rounded-tl-2xl">담당 매니저</th>
                                                <th className="px-6 py-5 text-center">총 의뢰</th>
                                                <th className="px-6 py-5 text-center">미종결 건수</th>
                                                <th className="px-6 py-5 text-center rounded-tr-2xl">종결율 (%)</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-50">
                                            {counselorData.map((c, i) => (
                                                <tr key={i} className="hover:bg-slate-50 transition-colors group">
                                                    <td className="px-6 py-6 font-bold text-slate-800">{c.name}</td>
                                                    <td className="px-6 py-6 text-center text-slate-500 font-bold">{c.total}건</td>
                                                    <td className="px-6 py-6 text-center">
                                                        <span className="px-3 py-1 bg-rose-50 text-rose-600 rounded-full font-black text-[10px]">
                                                            {c.ongoing} 건
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-6 text-center">
                                                        <div className="flex items-center justify-center gap-3">
                                                            <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-indigo-500 rounded-full transition-all duration-1000"
                                                                    style={{ width: `${Math.round(((c.total - c.ongoing) / c.total) * 100 || 0)}%` }}
                                                                />
                                                            </div>
                                                            <span className="font-black text-indigo-700">{Math.round(((c.total - c.ongoing) / c.total) * 100 || 0)}%</span>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="bg-white p-10 rounded-[3rem] border-2 border-slate-50 shadow-sm overflow-hidden">
                                <h3 className="text-2xl font-black text-slate-900 mb-10 tracking-tight">지역 / 월별 추이 분석</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-[11px] border-collapse">
                                        <thead>
                                            <tr className="bg-indigo-900 text-white font-black tracking-tighter">
                                                <th className="px-4 py-5 text-left first:rounded-tl-2xl">지역 구분</th>
                                                {regionMonthData.months.map(m => <th key={m} className="px-2 py-5 text-center font-bold">{m}월</th>)}
                                                <th className="px-4 py-5 text-center last:rounded-tr-2xl bg-indigo-950">총계</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {regionMonthData.data.map((row: any, i) => (
                                                <tr key={i} className="hover:bg-indigo-50/30 transition-colors">
                                                    <td className="px-4 py-5 font-black text-slate-700">{row.region}</td>
                                                    {regionMonthData.months.map(m => (
                                                        <td key={m} className={`px-2 py-5 text-center ${row[m] > 5 ? 'font-black text-indigo-600' : 'text-slate-400'}`}>
                                                            {row[m] || 0}
                                                        </td>
                                                    ))}
                                                    <td className="px-4 py-5 text-center bg-slate-50 font-black text-slate-900">{row.total}</td>
                                                </tr>
                                            ))}
                                            <tr className="bg-slate-900 text-white font-black">
                                                <td className="px-4 py-5 rounded-bl-2xl">Total</td>
                                                {regionMonthData.months.map(m => (
                                                    <td key={m} className="px-2 py-5 text-center font-bold">
                                                        {regionMonthData.totalRow[m]}
                                                    </td>
                                                ))}
                                                <td className="px-4 py-5 text-center bg-indigo-600 rounded-br-2xl">{regionMonthData.totalRow.total}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        {/* 지역 / 연령별 현황 테이블 */}
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                            <h3 className="text-lg font-bold text-slate-700 mb-4">지역 / 연령별 현황</h3>
                            <div className="overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0">
                                <div className="md:hidden text-right text-xs text-slate-400 mb-1 flex items-center justify-end gap-1">
                                    <span>👉 옆으로 스크롤하여 확인</span>
                                </div>
                                <table className="w-full text-xs text-center text-slate-500 border-collapse">
                                    <thead className="text-xs text-slate-700 uppercase bg-slate-100">
                                        <tr>
                                            <th className="px-3 py-2 border border-slate-200 text-center">지역 / 구분</th>
                                            {regionAgeData.ageGroups.map(age => (
                                                <th key={age} className="px-3 py-2 border border-slate-200 text-center">{age}</th>
                                            ))}
                                            <th className="px-3 py-2 border border-slate-200 bg-slate-200 text-center">지역별 총합</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {regionAgeData.data.map((row: any) => (
                                            <tr key={row.region} className="bg-white hover:bg-slate-50">
                                                <td className="px-3 py-2 border border-slate-200 font-medium text-slate-900 text-center">{row.region}</td>
                                                {regionAgeData.ageGroups.map(age => (
                                                    <td key={age} className={`px-3 py-2 border border-slate-200 text-center ${row[age] > 0 ? 'bg-indigo-50 text-indigo-600 font-bold' : ''}`}>
                                                        {row[age]}
                                                    </td>
                                                ))}
                                                <td className="px-3 py-2 border border-slate-200 font-bold bg-slate-50 text-center">{row.total}</td>
                                            </tr>
                                        ))}
                                        <tr className="bg-slate-100 font-bold">
                                            <td className="px-3 py-2 border border-slate-200 text-center">연령별 총합</td>
                                            {regionAgeData.ageGroups.map(age => (
                                                <th key={age} className="px-3 py-2 border border-slate-200 text-center font-bold">{regionAgeData.totalRow[age]}</th>
                                            ))}
                                            <td className="px-3 py-2 border border-slate-200 bg-slate-200 text-center">{regionAgeData.totalRow.total}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

import React, { useMemo } from 'react';
import {
    PieChart, Pie, Cell, Tooltip, Legend,
    BarChart, Bar, XAxis, YAxis, CartesianGrid,
    ResponsiveContainer, LabelList
} from 'recharts';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { SurveyImportItem } from '../../types';

// --- Constants & Palette (ReportsPage.tsx:553 스펙 그대로) ---
export const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#8dd1e1', '#a4de6c', '#d0ed57'];

// --- Helper Functions for Labels ---
export function truncateLabel(label: string, maxLength = 6): string {
    if (!label) return '미입력';
    const s = String(label).trim();
    return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
}

export function shouldShowPieLabel(percent: number): boolean {
    return percent >= 0.05;
}

// --- CustomTooltip (ReportsPage.tsx:567-590 스펙 그대로) ---
export const CustomTooltip = React.memo(({ active, payload, label }: any) => {
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

// --- ReportPieChart (ReportsPage.tsx:592-653 스펙 그대로) ---
export const ReportPieChart = React.memo(({ title, data, colorIndexOffset = 0, downloadImage, downloadExcel }: any) => {
    const chartId = `chart-${title.replace(/\s+/g, '-')}`;
    const isEmpty = !data || data.length === 0;

    return (
        <div id={chartId} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[400px] chart-wrapper max-w-[100vw] overflow-hidden">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm md:text-lg font-bold text-slate-700 truncate">{title}</h3>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600" title="이미지 다운로드">📷</button>
                        <button onClick={() => downloadExcel(data, title)} className="text-xs text-slate-400 hover:text-slate-600" title="엑셀 다운로드">📥</button>
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
                                    label={({ name, percent }: any) =>
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

// --- ReportBarChart (ReportsPage.tsx:655-702 스펙 그대로) ---
export const ReportBarChart = React.memo(({ title, data, color = "#8884d8", downloadImage, downloadExcel }: any) => {
    const chartId = `chart-${title.replace(/\s+/g, '-')}`;
    const isEmpty = !data || data.length === 0;

    return (
        <div id={chartId} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[400px]">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm md:text-lg font-bold text-slate-700 truncate">{title}</h3>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => downloadImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600" title="이미지 다운로드">📷</button>
                        <button onClick={() => downloadExcel(data, title)} className="text-xs text-slate-400 hover:text-slate-600" title="엑셀 다운로드">📥</button>
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

// --- Download Functions (ReportsPage.tsx:705-726 스펙 그대로) ---
export const downloadImage = async (elementId: string, fileName: string) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    try {
        const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 2 } as any);
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${fileName}.png`;
        link.click();
    } catch (error) {
        console.error('Image download failed:', error);
    }
};

export const downloadExcel = (data: any[], fileName: string) => {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([wbout], { type: 'application/octet-stream' }), `${fileName}.xlsx`);
};

// --- Dedup & Classification Helpers (SurveyManagementPage.tsx:918-980 스펙 동일) ---
export const isConsultationRequest = (item: any): boolean => {
    if (!item) return false;
    return item.consultationRequested === true || item.requestType === 'CONSULTATION_REQUEST';
};

export const isInvalidSurveyRecord = (item: any): boolean => {
    if (!item || !item.submissionId) return true;
    const hasRequestType = item.requestType !== undefined && item.requestType !== null && item.requestType !== '';
    const hasConsultationRequested = item.consultationRequested !== undefined && item.consultationRequested !== null;
    if (!hasRequestType && !hasConsultationRequested) return true;
    if (!item.assessmentId || item.assessmentId === 'UNKNOWN') return true;
    return false;
};

export const isScreeningOnly = (item: any): boolean => {
    if (isInvalidSurveyRecord(item)) return false;
    if (isConsultationRequest(item)) return false;
    return item.requestType === 'SCREENING_ONLY';
};

export const getRecordTimestamp = (item: any): number => {
    const dates = [item?.updatedAt, item?.importedAt, item?.submittedAt, item?.createdAt];
    for (const d of dates) {
        if (d) {
            const time = new Date(d).getTime();
            if (!isNaN(time) && time > 0) return time;
        }
    }
    return 0;
};

export const getConsultationTime = (item: any): number => {
    if (item?.consultationRequestedAt) {
        const time = new Date(item.consultationRequestedAt).getTime();
        if (!isNaN(time) && time > 0) return time;
    }
    return 0;
};

export const shouldReplaceRepresentative = (current: any, candidate: any): boolean => {
    const currentIsReq = isConsultationRequest(current);
    const candIsReq = isConsultationRequest(candidate);
    if (candIsReq && !currentIsReq) return true;
    if (!candIsReq && currentIsReq) return false;

    const candReqTime = getConsultationTime(candidate);
    const currReqTime = getConsultationTime(current);
    if (candReqTime !== currReqTime) {
        return candReqTime > currReqTime;
    }

    const candTime = getRecordTimestamp(candidate);
    const currTime = getRecordTimestamp(current);
    if (candTime !== currTime) {
        return candTime > currTime;
    }

    return false;
};

export const getValidUniqueSurveyItems = (items: SurveyImportItem[] = []): SurveyImportItem[] => {
    const subMap = new Map<string, SurveyImportItem>();
    items.forEach(item => {
        if (!item?.submissionId) return;
        const existing = subMap.get(item.submissionId);
        if (!existing) {
            subMap.set(item.submissionId, item);
        } else if (shouldReplaceRepresentative(existing, item)) {
            subMap.set(item.submissionId, item);
        }
    });
    const uniqueItems = Array.from(subMap.values());
    return uniqueItems.filter(i => !isInvalidSurveyRecord(i));
};

// --- Aggregation Functions (§3 차트 4종) ---

/** ① 상담신청/미신청 분포 (Pie) */
export const aggregateConsultation = (validUniqueItems: SurveyImportItem[]): { name: string; value: number }[] => {
    const requested = validUniqueItems.filter(isConsultationRequest).length;
    const notRequested = validUniqueItems.filter(isScreeningOnly).length;
    const result: { name: string; value: number }[] = [];
    if (requested > 0) result.push({ name: '상담신청', value: requested });
    if (notRequested > 0) result.push({ name: '검사만', value: notRequested });
    return result;
};

/** ② 처리상태별 분포 (Bar, vertical) */
export const aggregateStatus = (validUniqueItems: SurveyImportItem[]): { name: string; value: number }[] => {
    const counts: Record<string, number> = {};
    validUniqueItems.forEach(item => {
        const status = (item.consultationStatus && String(item.consultationStatus).trim()) || '미입력';
        counts[status] = (counts[status] || 0) + 1;
    });
    return Object.keys(counts)
        .map(status => ({ name: status, value: counts[status] }))
        .sort((a, b) => b.value - a.value);
};

/** ③ 중증도별 분포 (Pie, 상위 N개+기타 묶음) */
export const aggregateSeverity = (validUniqueItems: SurveyImportItem[], topN = 5): { name: string; value: number }[] => {
    const counts: Record<string, number> = {};
    validUniqueItems.forEach(item => {
        const sev = (item.severity && String(item.severity).trim()) || '미입력';
        counts[sev] = (counts[sev] || 0) + 1;
    });
    const sorted = Object.keys(counts)
        .map(sev => ({ name: sev, value: counts[sev] }))
        .sort((a, b) => b.value - a.value);

    if (sorted.length <= topN + 1) {
        return sorted;
    }
    const topItems = sorted.slice(0, topN);
    const otherCount = sorted.slice(topN).reduce((sum, item) => sum + item.value, 0);
    if (otherCount > 0) {
        topItems.push({ name: '기타', value: otherCount });
    }
    return topItems;
};

/** ④ 기간별 검사 완료 추이 (Bar, 월별) */
export const aggregateMonthlyTrend = (validUniqueItems: SurveyImportItem[]): { name: string; value: number }[] => {
    const counts: Record<string, number> = {};
    validUniqueItems.forEach(item => {
        const dateStr = item.screeningCompletedAt || item.importedAt || (item as any).submittedAt || (item as any).createdAt;
        if (!dateStr) {
            counts['미입력'] = (counts['미입력'] || 0) + 1;
            return;
        }
        const month = String(dateStr).substring(0, 7);
        if (/^\d{4}-\d{2}$/.test(month)) {
            counts[month] = (counts[month] || 0) + 1;
        } else {
            counts['기타'] = (counts['기타'] || 0) + 1;
        }
    });
    return Object.keys(counts)
        .sort((a, b) => a.localeCompare(b))
        .map(month => ({ name: month, value: counts[month] }));
};

export interface SurveyChartsProps {
    imports: SurveyImportItem[];
}

export default function SurveyCharts({ imports }: SurveyChartsProps) {
    const validUniqueItems = useMemo(() => getValidUniqueSurveyItems(imports), [imports]);

    const consultationData = useMemo(() => aggregateConsultation(validUniqueItems), [validUniqueItems]);
    const statusData = useMemo(() => aggregateStatus(validUniqueItems), [validUniqueItems]);
    const severityData = useMemo(() => aggregateSeverity(validUniqueItems, 5), [validUniqueItems]);
    const monthlyTrendData = useMemo(() => aggregateMonthlyTrend(validUniqueItems), [validUniqueItems]);

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-8">
            <ReportPieChart
                title="상담신청/미신청 분포"
                data={consultationData}
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
            <ReportBarChart
                title="처리상태별 분포"
                data={statusData}
                color="#8884d8"
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
            <ReportPieChart
                title="중증도별 분포"
                data={severityData}
                colorIndexOffset={2}
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
            <ReportBarChart
                title="기간별 검사 완료 추이"
                data={monthlyTrendData}
                color="#3b82f6"
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
        </div>
    );
}

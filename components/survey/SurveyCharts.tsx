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
        <div id={chartId} className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-200 flex flex-col h-[400px] chart-wrapper max-w-[100vw] overflow-hidden">
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
        <div id={chartId} className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-200 flex flex-col h-[400px]">
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

// --- Unified Severity Tooltip & Chart Components ---
export const UnifiedSeverityTooltip = React.memo(({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const validPayload = payload.filter((p: any) => p.value > 0);
        if (validPayload.length === 0) return null;

        const first = validPayload[0];
        const row = first.payload;
        return (
            <div className="bg-white p-3 border border-slate-200 shadow-lg rounded-xl max-w-xs">
                <p className="font-bold text-slate-800 text-sm mb-2 border-b border-slate-100 pb-1">
                    {row.testLabel} (총 {row.total}명)
                </p>
                <div className="space-y-1">
                    {validPayload.map((entry: any, i: number) => {
                        const gradeItem = (row.grades || []).find((g: any) => `${row.testId}__${g.grade}` === entry.dataKey);
                        const gradeName = gradeItem?.grade || entry.name;
                        const count = gradeItem?.count ?? entry.value;
                        const percent = gradeItem?.percent ?? Math.round(entry.value);
                        return (
                            <div key={i} className="flex items-center justify-between text-xs gap-3">
                                <span className="flex items-center gap-1.5 font-medium text-slate-600">
                                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                                    {gradeName}
                                </span>
                                <span className="font-semibold text-slate-800">
                                    {count}명 ({percent}%)
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }
    return null;
});

// --- ReportUnifiedSeverityBarChart: 5개 검사의 중증도를 하나의 가로 스택 막대로 통합한 차트 ---
export const ReportUnifiedSeverityBarChart = React.memo(({
    title,
    data,
    downloadImage: dlImage,
    downloadExcel: dlExcel
}: {
    title: string;
    data: UnifiedSeverityItem[];
    downloadImage: (id: string, name: string) => void;
    downloadExcel: (data: any[], name: string) => void;
}) => {
    const chartId = `chart-${title.replace(/\s+/g, '-')}`;
    const totalRecords = useMemo(() => (data || []).reduce((sum, item) => sum + item.total, 0), [data]);
    const isEmpty = !data || data.length === 0 || totalRecords === 0;

    const handleDownloadExcel = () => {
        const rows: any[] = [];
        (data || []).forEach(test => {
            (test.grades || []).forEach(g => {
                if (g.count > 0) {
                    rows.push({
                        '검사': test.testLabel,
                        '등급': g.grade,
                        '건수': g.count,
                        '비율': `${g.percent}%`
                    });
                }
            });
        });
        dlExcel(rows, title);
    };

    // 고유 세그먼트 키 목록 추출
    const segmentKeys = useMemo(() => {
        const segs: { key: string; testId: string; grade: string; fill: string }[] = [];
        (data || []).forEach(item => {
            (item.grades || []).forEach(g => {
                const key = `${item.testId}__${g.grade}`;
                if (!segs.find(s => s.key === key)) {
                    segs.push({
                        key,
                        testId: item.testId,
                        grade: g.grade,
                        fill: g.fill
                    });
                }
            });
        });
        return segs;
    }, [data]);

    const renderSegmentLabel = (props: any, seg: { key: string; grade: string; fill: string; testId: string }) => {
        const { x, y, width, height, index } = props;
        if (!width || width < 25) return null;

        const row = data[index];
        if (!row || row.testId !== seg.testId) return null;

        const gradeItem = row.grades.find(g => g.grade === seg.grade);
        if (!gradeItem || gradeItem.count === 0) return null;

        const labelText = gradeItem.label;
        const isBright = seg.fill === '#eab308' || seg.fill === '#f59e0b';
        const textColor = isBright ? '#1e293b' : '#ffffff';
        const displayText = width < 75 ? `${gradeItem.count}명 (${gradeItem.percent}%)` : labelText;

        return (
            <text
                x={x + width / 2}
                y={y + height / 2}
                fill={textColor}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight="bold"
                style={{
                    pointerEvents: 'none',
                    textShadow: isBright ? 'none' : '0 1px 2px rgba(0,0,0,0.45)'
                }}
            >
                {displayText}
            </text>
        );
    };

    return (
        <div id={chartId} className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-200 flex flex-col h-[400px] lg:col-span-2 xl:col-span-2">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm md:text-lg font-bold text-slate-700 truncate">{title}</h3>
                {!isEmpty && (
                    <div className="flex gap-2">
                        <button onClick={() => dlImage(chartId, title)} className="text-xs text-slate-400 hover:text-slate-600" title="이미지 다운로드">📷</button>
                        <button onClick={handleDownloadExcel} className="text-xs text-slate-400 hover:text-slate-600" title="엑셀 다운로드">📥</button>
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
                            <BarChart
                                data={data}
                                layout="vertical"
                                margin={{ top: 10, right: 25, left: 10, bottom: 10 }}
                            >
                                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                                <XAxis
                                    type="number"
                                    domain={[0, 100]}
                                    tickFormatter={(v) => `${v}%`}
                                    tick={{ fontSize: 10, fill: '#64748b' }}
                                    axisLine={{ stroke: '#cbd5e1' }}
                                />
                                <YAxis
                                    dataKey="testLabel"
                                    type="category"
                                    width={115}
                                    tick={{ fontSize: 11, fill: '#475569', fontWeight: 600 }}
                                    interval={0}
                                    axisLine={{ stroke: '#cbd5e1' }}
                                />
                                <Tooltip content={<UnifiedSeverityTooltip />} />
                                {segmentKeys.map(seg => (
                                    <Bar
                                        key={seg.key}
                                        dataKey={seg.key}
                                        stackId="unifiedSeverity"
                                        fill={seg.fill}
                                        barSize={24}
                                        isAnimationActive={false}
                                    >
                                        <LabelList
                                            content={(props: any) => renderSegmentLabel(props, seg)}
                                        />
                                    </Bar>
                                ))}
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

// --- Severity Classification Constants & Helpers ---
export const SEVERITY_MAP: Record<string, Record<string, string>> = {
    'phq-9': {
        '정상': '정상',
        '경도 우울': '경도 우울',
        '중등도 우울': '중등도 우울',
        '중간 정도의 우울': '중등도 우울',
        '심한 우울': '중증 우울',
        '심한 우울 (우선검토 권장)': '중증 우울',
        '중증 우울': '중증 우울',
    },
    'gad-7': {
        '정상': '정상',
        '경도 불안': '경도 불안',
        '경미한 불안': '경도 불안',
        '중등도 불안': '중등도 불안',
        '중간 정도의 불안': '중등도 불안',
        '심한 불안': '중증 불안',
        '중증 불안': '중증 불안',
    },
    'bepsi-k': {
        '저스트레스군': '저스트레스군',
        '고스트레스군': '고스트레스군',
    },
    'sbq-r': {
        '저위험군': '저위험군',
        '중위험군': '중위험군',
        '고위험군': '고위험군',
    },
    'isi-k': {
        '정상': '정상',
        '경도 불면': '경도 불면',
        '경미한 불면': '경도 불면',
        '중등도 불면': '중등도 불면',
        '중간 정도의 불면': '중등도 불면',
        '심한 불면': '중증 불면',
        '중증 불면': '중증 불면',
    },
};

export function classifySeverity(assessmentId?: string, rawSeverity?: string | null): string {
    const aid = (assessmentId || '').toLowerCase().trim();
    if (aid === 'contact-only') {
        return '해당없음';
    }
    if (rawSeverity === undefined || rawSeverity === null) {
        return '미입력';
    }
    const rawTrimmed = String(rawSeverity).trim();
    if (!rawTrimmed) {
        return '미입력';
    }
    const scaleMap = SEVERITY_MAP[aid];
    if (scaleMap) {
        if (scaleMap[rawTrimmed]) {
            return scaleMap[rawTrimmed];
        }
        const cleaned = rawTrimmed.replace(/\s*(\([^)]*\)|（[^）]*）)/g, '').trim();
        if (cleaned && scaleMap[cleaned]) {
            return scaleMap[cleaned];
        }
    }
    return rawTrimmed;
}

// --- Assessment Labels Mapping & Helper ---
export const ASSESSMENT_LABEL_MAP: Record<string, string> = {
    'phq-9': 'PHQ-9 우울',
    'gad-7': 'GAD-7 불안',
    'bepsi-k': 'BEPSI-K 스트레스',
    'sbq-r': 'SBQ-R 자살',
    'isi-k': 'ISI-K 불면',
    'contact-only': '상담신청(검사없음)',
};

export function getAssessmentLabel(assessmentId?: string): string {
    if (!assessmentId) return '미상';
    const normalized = String(assessmentId).toLowerCase().trim();
    return ASSESSMENT_LABEL_MAP[normalized] || ASSESSMENT_LABEL_MAP[assessmentId] || assessmentId;
}

// --- Age Bands Order ---
export const AGE_BAND_ORDER = [
    '10대 미만',
    '10대',
    '20대',
    '30대',
    '40대',
    '50대',
    '60대',
    '65세 이상',
    '미상',
];

// --- Standard Grade Order per Assessment ---
export const STANDARD_GRADE_ORDER: Record<string, string[]> = {
    'phq-9': ['정상', '경도 우울', '중등도 우울', '중증 우울'],
    'gad-7': ['정상', '경도 불안', '중등도 불안', '중증 불안'],
    'bepsi-k': ['저스트레스군', '고스트레스군'],
    'sbq-r': ['저위험군', '중위험군', '고위험군'],
    'isi-k': ['정상', '경도 불면', '중등도 불면', '중증 불면']
};

// --- Grade Color Palette ---
export const GRADE_COLOR_MAP: Record<string, string> = {
    // 정상 / 저스트레스군 / 저위험군 = 녹색 계열
    '정상': '#10b981',
    '저스트레스군': '#10b981',
    '저위험군': '#10b981',

    // 경도 / 중위험군 = 노란/연두 계열
    '경도 우울': '#eab308',
    '경도 불안': '#eab308',
    '경도 불면': '#eab308',
    '중위험군': '#f59e0b',

    // 중등도 = 주황 계열
    '중등도 우울': '#f97316',
    '중등도 불안': '#f97316',
    '중등도 불면': '#f97316',

    // 중증 / 고스트레스군 / 고위험군 = 붉은 계열
    '중증 우울': '#ef4444',
    '중증 불안': '#ef4444',
    '중증 불면': '#ef4444',
    '고스트레스군': '#ef4444',
    '고위험군': '#ef4444',

    // 해당없음 / 미입력 / 미분류 = 회색 계열
    '해당없음': '#94a3b8',
    '미입력': '#94a3b8',
    '기타': '#94a3b8',
};

export function getGradeColor(grade: string): string {
    if (GRADE_COLOR_MAP[grade]) {
        return GRADE_COLOR_MAP[grade];
    }
    if (grade.includes('정상') || grade.includes('저스트레스') || grade.includes('저위험')) return '#10b981';
    if (grade.includes('경도') || grade.includes('경미')) return '#eab308';
    if (grade.includes('중등도') || grade.includes('중간')) return '#f97316';
    if (grade.includes('중위험')) return '#f59e0b';
    if (grade.includes('중증') || grade.includes('고스트레스') || grade.includes('고위험') || grade.includes('심한')) return '#ef4444';
    return '#94a3b8';
}

// --- Data Types for Unified Severity ---
export const TARGET_ASSESSMENTS = [
    { id: 'phq-9', label: 'PHQ-9 우울' },
    { id: 'gad-7', label: 'GAD-7 불안' },
    { id: 'bepsi-k', label: 'BEPSI-K 스트레스' },
    { id: 'sbq-r', label: 'SBQ-R 자살' },
    { id: 'isi-k', label: 'ISI-K 불면' },
];

export interface UnifiedSeverityGrade {
    grade: string;
    count: number;
    percent: number;
    fill: string;
    label: string;
}

export interface UnifiedSeverityItem {
    testId: string;
    testLabel: string;
    total: number;
    grades: UnifiedSeverityGrade[];
    [key: string]: any;
}

// --- Aggregation Functions (§3 차트 7종 + 신규 검사별 차트) ---

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

/** ⑤ 연령별 분포 (Bar, 연령대 밴드 고정 순서) */
export const aggregateAgeBand = (validUniqueItems: SurveyImportItem[]): { name: string; value: number }[] => {
    if (!validUniqueItems || validUniqueItems.length === 0) return [];
    const counts: Record<string, number> = {};
    AGE_BAND_ORDER.forEach(band => {
        counts[band] = 0;
    });
    validUniqueItems.forEach(item => {
        const band = (item as any).ageBand || '미상';
        counts[band] = (counts[band] || 0) + 1;
    });
    return AGE_BAND_ORDER.map(name => ({ name, value: counts[name] || 0 }));
};


/** ⑦ 성별 분포 (Pie) */
export const aggregateGender = (validUniqueItems: SurveyImportItem[]): { name: string; value: number }[] => {
    const counts: Record<string, number> = { '남성': 0, '여성': 0, '미상': 0 };
    validUniqueItems.forEach(item => {
        const g = (item as any).gender || '미상';
        counts[g] = (counts[g] || 0) + 1;
    });
    return Object.keys(counts)
        .filter(name => counts[name] > 0)
        .map(name => ({ name, value: counts[name] }));
};

/** ⑧ 검사 종류별 중증도 분포 집계 (5개 검사 통합) */
export const aggregateUnifiedSeverity = (validUniqueItems: SurveyImportItem[]): UnifiedSeverityItem[] => {
    const testMap: Record<string, { total: number; counts: Record<string, number>; rawExtraOrder: string[] }> = {};
    TARGET_ASSESSMENTS.forEach(t => {
        testMap[t.id] = { total: 0, counts: {}, rawExtraOrder: [] };
    });

    validUniqueItems.forEach(item => {
        const aid = (item.assessmentId || '').toLowerCase().trim();
        if (!testMap[aid]) {
            return;
        }

        const grade = classifySeverity(item.assessmentId, item.severity);
        testMap[aid].total += 1;
        testMap[aid].counts[grade] = (testMap[aid].counts[grade] || 0) + 1;

        const stdGrades = STANDARD_GRADE_ORDER[aid] || [];
        if (!stdGrades.includes(grade) && !testMap[aid].rawExtraOrder.includes(grade)) {
            testMap[aid].rawExtraOrder.push(grade);
        }
    });

    return TARGET_ASSESSMENTS.map(test => {
        const { total, counts, rawExtraOrder } = testMap[test.id];
        const stdGrades = STANDARD_GRADE_ORDER[test.id] || [];
        const allGrades = [...stdGrades, ...rawExtraOrder];

        const grades: UnifiedSeverityGrade[] = [];
        const rowData: UnifiedSeverityItem = {
            testId: test.id,
            testLabel: test.label,
            total,
            grades: []
        };

        allGrades.forEach(grade => {
            const count = counts[grade] || 0;
            const percent = total > 0 ? Math.round((count / total) * 100) : 0;
            const rawPercent = total > 0 ? (count / total) * 100 : 0;
            const fill = getGradeColor(grade);
            const label = `${grade} ${count}명 (${percent}%)`;

            grades.push({
                grade,
                count,
                percent,
                fill,
                label
            });

            const segmentKey = `${test.id}__${grade}`;
            rowData[segmentKey] = count > 0 ? rawPercent : 0;
        });

        rowData.grades = grades;
        return rowData;
    });
};

export interface SurveyChartsProps {
    imports: SurveyImportItem[];
}

export default function SurveyCharts({ imports }: SurveyChartsProps) {
    const validUniqueItems = useMemo(() => getValidUniqueSurveyItems(imports), [imports]);

    const consultationData = useMemo(() => aggregateConsultation(validUniqueItems), [validUniqueItems]);
    const statusData = useMemo(() => aggregateStatus(validUniqueItems), [validUniqueItems]);
    const ageBandData = useMemo(() => aggregateAgeBand(validUniqueItems), [validUniqueItems]);
    const genderData = useMemo(() => aggregateGender(validUniqueItems), [validUniqueItems]);
    const unifiedSeverityData = useMemo(() => aggregateUnifiedSeverity(validUniqueItems), [validUniqueItems]);

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-[13px]">
            <ReportPieChart
                title="성별 분포"
                data={genderData}
                colorIndexOffset={8}
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
            <ReportBarChart
                title="연령별 분포"
                data={ageBandData}
                color="#10b981"
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
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
            <ReportUnifiedSeverityBarChart
                title="검사 종류별 중증도 분포"
                data={unifiedSeverityData}
                downloadImage={downloadImage}
                downloadExcel={downloadExcel}
            />
        </div>
    );
}

import React, { useMemo } from 'react';
import { CounselorPerformance } from '../../../types';
import AnalysisChart from '../AnalysisChart';
import _ from 'lodash';

interface GeneralAnalysisTabProps {
    data: CounselorPerformance[];
    dateRange: { start: string; end: string };
}

const GeneralAnalysisTab: React.FC<GeneralAnalysisTabProps> = ({ data, dateRange }) => {

    const { processedData, totalStats } = useMemo(() => {
        const startDate = dateRange.start;
        const endDate = dateRange.end;

        let grandTotals = {
            totalGeneral: 0,
            emergency: 0,
            phone: 0,
            visit: 0,
            inOffice: 0,
            online: 0
        };

        const filtered = data.map(c => {
            const validSessions = (c.allSessions || []).filter(s => {
                if (!s.date) return false;
                // 일반상담 분석은 파일 3(일반상담) 세션만 집계한다.
                // category가 없는 레거시 세션은 개별/자원조정으로 간주하므로 여기서 제외한다.
                if (s.category !== 'general') return false;
                return s.date >= startDate && s.date <= endDate;
            });

            const counts = {
                totalGeneral: validSessions.length,
                emergency: validSessions.filter(s => s.type === 'emergency').length,
                phone: validSessions.filter(s => s.type === 'phone').length,
                visit: validSessions.filter(s => s.type === 'visit').length,
                inOffice: validSessions.filter(s => s.type === 'inOffice').length,
                online: validSessions.filter(s => s.type === 'online').length,
            };

            // Accumulate Grand Totals
            grandTotals.totalGeneral += counts.totalGeneral;
            grandTotals.emergency += counts.emergency;
            grandTotals.phone += counts.phone;
            grandTotals.visit += counts.visit;
            grandTotals.inOffice += counts.inOffice;
            grandTotals.online += counts.online;

            return {
                ...c,
                ...counts
            };
        }).sort((a, b) => b.totalGeneral - a.totalGeneral);

        const counselorCount = data.length || 1;
        const averages = {
            totalGeneral: (grandTotals.totalGeneral / counselorCount).toFixed(1),
            emergency: (grandTotals.emergency / counselorCount).toFixed(1),
            phone: (grandTotals.phone / counselorCount).toFixed(1),
            visit: (grandTotals.visit / counselorCount).toFixed(1),
            inOffice: (grandTotals.inOffice / counselorCount).toFixed(1),
            online: (grandTotals.online / counselorCount).toFixed(1),
        };

        return { processedData: filtered, totalStats: { totals: grandTotals, averages } };
    }, [data, dateRange]);

    const typeChartData = useMemo(() => {
        const t = totalStats.totals;
        return {
            labels: ['유선', '방문', '내소', '온라인', '응급'],
            datasets: [{
                label: '상담 유형',
                data: [t.phone, t.visit, t.inOffice, t.online, t.emergency],
                backgroundColor: ['#60a5fa', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171'],
                borderRadius: 8,
                barPercentage: 0.6
            }]
        }
    }, [totalStats]);

    const departmentData = useMemo(() => {
        const grouped = _.groupBy(processedData, 'department');
        return {
            labels: Object.keys(grouped),
            datasets: [{
                data: Object.values(grouped).map((g: any) => _.sumBy(g, 'totalGeneral')),
                backgroundColor: ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6'],
                borderWidth: 0
            }]
        };
    }, [processedData]);

    const counselorChartData = useMemo(() => {
        return {
            labels: processedData.map(d => d.counselorName),
            datasets: [
                { label: '유선', data: processedData.map(d => d.phone), backgroundColor: '#60a5fa' },
                { label: '방문', data: processedData.map(d => d.visit), backgroundColor: '#a78bfa' },
                { label: '내소', data: processedData.map(d => d.inOffice), backgroundColor: '#fb923c' },
                { label: '온라인', data: processedData.map(d => d.online), backgroundColor: '#2dd4bf' },
                { label: '응급', data: processedData.map(d => d.emergency), backgroundColor: '#f87171' },
            ]
        };
    }, [processedData]);

    const chartHeight = Math.max(500, processedData.length * 40);

    // [Stabilization] Memoize Chart Options to prevent flickering/re-creation loops
    const typeChartOptions = useMemo(() => ({
        plugins: {
            legend: { display: false },
            datalabels: {
                display: true,
                color: '#1e293b',
                anchor: 'end' as const,
                align: 'top' as const,
                font: { weight: 'bold' as const },
                formatter: (value: any) => value > 0 ? value : ''
            }
        }
    }), []);

    const departmentChartOptions = useMemo(() => ({
        plugins: {
            legend: {
                position: 'right' as const,
                labels: {
                    boxWidth: 12,
                    padding: 15,
                    font: { size: 11, weight: 600 }
                }
            },
            datalabels: {
                display: true,
                color: 'white',
                font: { weight: 'bold' as const },
                formatter: (value: any) => value > 0 ? value : ''
            }
        }
    }), []);

    const counselorChartOptions = useMemo(() => ({
        indexAxis: 'y' as const,
        scales: { x: { stacked: true }, y: { stacked: true } },
        plugins: {
            legend: { position: 'bottom' as const },
            datalabels: {
                display: true,
                color: 'white',
                font: { weight: 'bold' as const, size: 10 },
                formatter: (value: any) => value > 0 ? value : ''
            }
        }
    }), []);

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
            {/* Top Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="h-[400px]">
                    <AnalysisChart
                        title={`상담 유형별 건수 (${dateRange.start} ~ ${dateRange.end})`}
                        type="bar"
                        data={typeChartData}
                        options={typeChartOptions}
                    />
                </div>
                <div className="h-[400px]">
                    <AnalysisChart
                        title={`부서별 일반상담 건수 (${dateRange.start} ~ ${dateRange.end})`}
                        type="pie"
                        data={departmentData}
                        options={departmentChartOptions}
                    />
                </div>
            </div>

            {/* Counselor Chart */}
            <div style={{ height: `${chartHeight}px` }}>
                <AnalysisChart
                    title={`상담사별 일반상담 실적 (${dateRange.start} ~ ${dateRange.end})`}
                    type="bar"
                    data={counselorChartData}
                    options={counselorChartOptions}
                />
            </div>

            {/* Detailed Table */}
            <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-100 flex items-center gap-2 bg-slate-50/50">
                    <span className="w-1 h-4 bg-indigo-500 rounded-full"></span>
                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide">상담사별 일반상담 상세 실적</h3>
                </div>

                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-100">
                        <thead className="bg-slate-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-wider">상담사</th>
                                <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-wider">부서</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">총 건수</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">응급</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">유선</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">방문</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">내소</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">온라인</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-slate-50">
                            {processedData.map((d, idx) => (
                                <tr key={idx} className="hover:bg-indigo-50/30 transition-colors group">
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs font-bold text-slate-700 group-hover:text-indigo-700">{d.counselorName}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-500">{d.department}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs font-black text-slate-800 text-right">{d.totalGeneral}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-rose-500 text-right font-medium">{d.emergency || '-'}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-400 text-right">{d.phone || '-'}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-400 text-right">{d.visit || '-'}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-400 text-right">{d.inOffice || '-'}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-400 text-right">{d.online || '-'}</td>
                                </tr>
                            ))}
                            {processedData.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="px-6 py-8 text-center text-slate-400 font-medium">데이터가 없습니다.</td>
                                </tr>
                            )}
                        </tbody>
                        <tfoot className="bg-slate-50 border-t border-slate-100 font-bold">
                            <tr>
                                <td colSpan={2} className="px-6 py-3.5 text-center text-xs text-slate-600">전체 평균 (1인당)</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.totalGeneral}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.emergency}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.phone}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.visit}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.inOffice}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.averages.online}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default GeneralAnalysisTab;

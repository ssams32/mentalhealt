import React, { useMemo } from 'react';
import { CounselorPerformance } from '../../../types';
import AnalysisChart from '../AnalysisChart';
declare var _: any;

interface CounselorPerformanceTabProps {
    data: CounselorPerformance[];
    dateRange: { start: string; end: string };
}

const CounselorPerformanceTab: React.FC<CounselorPerformanceTabProps> = ({ data, dateRange }) => {
    const totalSessions = useMemo(() => _.sumBy(data, 'totalSessions'), [data]);

    // Chart Data (Overall / Raw Data)
    const stackedBarChartData = useMemo(() => {
        const sortedData = [...data].sort((a, b) => _.sum(Object.values(b.types)) - _.sum(Object.values(a.types)));
        const counselingTypes = { inOffice: '내소', visit: '방문', online: '온라인', emergency: '응급', phone: '전화' };
        const colors = { inOffice: '#6366f1', visit: '#8b5cf6', online: '#10b981', emergency: '#f43f5e', phone: '#f59e0b' }; // Adjusted for Bento palette
        return {
            labels: sortedData.map(d => d.counselorName),
            datasets: Object.keys(counselingTypes).map(typeKey => ({
                label: (counselingTypes as any)[typeKey],
                data: sortedData.map(d => (d.types as any)[typeKey]),
                backgroundColor: (colors as any)[typeKey],
                barPercentage: 0.6,
                categoryPercentage: 0.8,
                borderRadius: 4,
            }))
        };
    }, [data]);

    const { stats: faceToFaceStats, total: totalStats } = useMemo(() => {
        const startDate = dateRange.start;
        const endDate = dateRange.end;

        if (!startDate || !endDate) return { stats: [], total: { total: 0, avgTotal: '0.0', monthlyAvg: '0.0', weeklyAvg: '0.0' } };

        const startPeriod = new Date(startDate);
        const endPeriod = new Date(endDate);
        const daysPassed = Math.floor((endPeriod.getTime() - startPeriod.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        const weeksPassed = Math.max(1, daysPassed / 7);
        const monthsPassed = Math.max(1, daysPassed / 30.44);

        let grandTotal = 0;
        let grandMonthlyTotal = 0;
        let grandWeeklyTotal = 0;

        const stats = data.map(c => {
            const validSessions = c.faceToFaceSessions.filter(s => {
                if (!s.date) return false;
                return s.date >= startDate && s.date <= endDate;
            });

            const total = validSessions.length;
            const monthlyAvg = parseFloat((total / monthsPassed).toFixed(1));
            const weeklyAvg = parseFloat((total / weeksPassed).toFixed(1));

            grandTotal += total;
            grandMonthlyTotal += monthlyAvg;
            grandWeeklyTotal += weeklyAvg;

            return {
                counselorName: c.counselorName,
                department: c.department,
                total,
                monthlyAvg: monthlyAvg.toFixed(1),
                weeklyAvg: weeklyAvg.toFixed(1)
            };
        }).sort((a, b) => b.total - a.total);

        const counselorCount = data.length || 1;

        const totalStats = {
            total: grandTotal,
            avgTotal: (grandTotal / counselorCount).toFixed(1),
            monthlyAvg: (grandMonthlyTotal / counselorCount).toFixed(1),
            weeklyAvg: (grandWeeklyTotal / counselorCount).toFixed(1)
        };

        return { stats, total: totalStats };
    }, [data, dateRange]);

    const chartHeight = Math.max(600, data.length * 40);

    // [Stabilization] Memoize Chart Options to prevent flickering/re-creation loops
    const chartOptions = useMemo(() => ({
        indexAxis: 'y' as const,
        scales: { x: { stacked: true }, y: { stacked: true } },
        plugins: {
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
            {/* Chart Section */}
            <div style={{ height: `${chartHeight}px` }}> {/* Height controlled by content */}
                <AnalysisChart
                    title={`상담사 유형별 실적 (총 ${totalSessions.toLocaleString()}건) - 전체 기간`}
                    type="bar"
                    data={stackedBarChartData}
                    options={chartOptions}
                />
            </div>

            {/* Table Section */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50/50">
                    <div className="flex items-center gap-2">
                        <span className="w-1 h-4 bg-indigo-500 rounded-full"></span>
                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide">대면 실적 분석 (내소 + 방문)</h3>
                    </div>
                    <span className="px-3 py-1 bg-indigo-50 text-indigo-600 text-[10px] font-bold rounded-full border border-indigo-100">
                        기간: {dateRange.start} ~ {dateRange.end}
                    </span>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-slate-50 border-b border-slate-100">
                            <tr>
                                <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-wider">상담사</th>
                                <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-wider">부서</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">총 대면 건수</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">월 평균</th>
                                <th className="px-6 py-3 text-right text-[10px] font-black text-slate-400 uppercase tracking-wider">주 평균</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {faceToFaceStats.map((stat, idx) => (
                                <tr key={idx} className="group hover:bg-indigo-50/30 transition-colors">
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs font-bold text-slate-700 group-hover:text-indigo-700">{stat.counselorName}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-500">{stat.department}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs font-black text-slate-800 text-right">{stat.total}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-500 text-right">{stat.monthlyAvg}</td>
                                    <td className="px-6 py-3.5 whitespace-nowrap text-xs text-slate-500 text-right">{stat.weeklyAvg}</td>
                                </tr>
                            ))}
                            {faceToFaceStats.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-xs text-slate-400 font-medium">데이터가 없습니다. 날짜 범위를 확인하세요.</td>
                                </tr>
                            )}
                        </tbody>
                        <tfoot className="bg-slate-50/50 border-t border-slate-100 font-bold">
                            <tr>
                                <td colSpan={2} className="px-6 py-3.5 text-center text-xs text-slate-600">전체 평균 (1인당)</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">
                                    {totalStats.avgTotal}
                                    <span className="text-[10px] text-slate-400 font-normal ml-1">(총 {totalStats.total}건)</span>
                                </td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.monthlyAvg}</td>
                                <td className="px-6 py-3.5 text-right text-xs text-indigo-600">{totalStats.weeklyAvg}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default CounselorPerformanceTab;

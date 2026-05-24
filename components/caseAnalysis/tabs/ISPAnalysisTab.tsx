import React, { useState, useEffect } from 'react';
import { 
    Play, 
    FileSpreadsheet, 
    AlertCircle as AlertCircleIcon, 
    CheckCircle as CheckCircleIcon, 
    XCircle as XCircleIcon, 
    Calendar, 
    Target, 
    Award, 
    Users, 
    TrendingUp, 
    Search 
} from 'lucide-react';
import { apiClient } from '../../../services/apiClient';
// @ts-ignore - Legacy type
import { ISPAchievement } from '../../../types';

interface ISPSummary {
    denominator: number;
    numerator: number;
    rate: string;
    totalScore: string;
}

const ISPAnalysisTab: React.FC = () => {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [summary, setSummary] = useState<ISPSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Achievement State
    const [achievements, setAchievements] = useState<ISPAchievement[]>([]);
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
    const [isAchievementLoading, setIsAchievementLoading] = useState(false);

    useEffect(() => {
        loadAchievements();
    }, [selectedMonth]);

    const loadAchievements = async () => {
        setIsAchievementLoading(true);
        try {
            const res = await apiClient.getISPAchievement(selectedMonth);
            if (res.success) {
                setAchievements(res.data);
            }
        } catch (err) {
            console.error("Failed to load achievements:", err);
        } finally {
            setIsAchievementLoading(false);
        }
    };

    const handleRunAnalysis = () => {
        setIsAnalyzing(true);
        setError(null);
        setSummary(null);

        // Standard ISP Compliance Analysis (Keep existing logic or migrate to API if needed)
        // For now, keeping as is but we can migrate to a backend endpoint later
        setTimeout(() => {
            setSummary({
                denominator: 120,
                numerator: 115,
                rate: '95.8%',
                totalScore: '7.0'
            });
            setIsAnalyzing(false);
        }, 1000);
    };

    const StatCard = ({ label, value, color, icon: Icon }: { label: string, value: string, color: string, icon: any }) => (
        <div className={`p-6 rounded-2xl border transition-all duration-300 hover:shadow-lg hover:-translate-y-1 ${color === 'indigo' ? 'bg-indigo-50/50 border-indigo-100 text-indigo-900 ring-indigo-200' :
                color === 'emerald' ? 'bg-emerald-50/50 border-emerald-100 text-emerald-900 ring-emerald-200' :
                    color === 'amber' ? 'bg-amber-50/50 border-amber-100 text-amber-900 ring-amber-200' :
                        'bg-rose-50/50 border-rose-100 text-rose-900 ring-rose-200 ring-2 ring-offset-2'
            }`}>
            <div className="flex items-center justify-between mb-2">
                <span className={`text-[10px] font-black uppercase tracking-wider ${color === 'indigo' ? 'text-indigo-500' :
                        color === 'emerald' ? 'text-emerald-500' :
                            color === 'amber' ? 'text-amber-500' :
                                'text-rose-500'
                    }`}>{label}</span>
                <Icon size={16} className={`opacity-50 ${color === 'indigo' ? 'text-indigo-500' :
                        color === 'emerald' ? 'text-emerald-500' :
                            color === 'amber' ? 'text-amber-500' :
                                'text-rose-500'
                    }`} />
            </div>
            <p className="text-3xl font-black">{value}</p>
        </div>
    );

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500 pb-20">
            {/* 1. ISP Compliance Evaluation Section */}
            <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100">
                <header className="mb-10 text-center max-w-2xl mx-auto">
                    <h2 className="text-2xl font-black text-slate-800 mb-2">ISP 수립 및 준수율 평가</h2>
                    <p className="text-slate-500 text-sm font-medium leading-relaxed">
                        기준일 회원 및 퇴록 내역을 바탕으로 180일 주기를 준수했는지 자동 계산합니다.
                    </p>
                </header>

                <div className="flex justify-center mb-10">
                    <button
                        onClick={handleRunAnalysis}
                        disabled={isAnalyzing}
                        className="
                            relative disabled:opacity-70 disabled:cursor-not-allowed
                            bg-slate-900 hover:bg-indigo-600 text-white font-bold py-4 px-10 rounded-2xl shadow-xl shadow-slate-200 
                            flex items-center gap-3 transition-all duration-300 active:scale-95 group hover:shadow-indigo-200 hover:-translate-y-1
                        "
                    >
                        {isAnalyzing ? (
                            <>
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white/80"></div>
                                <span className="text-white/90">계산 중...</span>
                            </>
                        ) : (
                            <>
                                <Play size={20} className="group-hover:translate-x-0.5 transition-transform text-indigo-300 group-hover:text-white" fill="currentColor" />
                                ISP 준수율 평가 실행
                            </>
                        )}
                    </button>
                </div>

                {summary && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-in zoom-in-95 duration-500">
                        <StatCard label="분모 대상자" value={`${summary.denominator}명`} color="indigo" icon={Users} />
                        <StatCard label="분자 (준수자)" value={`${summary.numerator}명`} color="emerald" icon={CheckCircleIcon} />
                        <StatCard label="ISP 준수율" value={summary.rate} color="amber" icon={Target} />
                        <StatCard label="최종 점수" value={`${summary.totalScore}점`} color="rose" icon={Award} />
                    </div>
                )}
            </div>

            {/* 2. ISP Intervention Achievement (Monthly) Section */}
            <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-slate-100">
                <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
                    <div>
                        <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                            <TrendingUp className="text-indigo-600" />
                            ISP 수립 관리구분 대비 개입 달성도
                        </h3>
                        <p className="text-slate-500 text-xs font-medium mt-1">
                            관리구분별(집중/일시) 목표 상담 횟수 충족 여부를 확인합니다.
                        </p>
                    </div>

                    <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-xl">
                        <input
                            type="month"
                            value={selectedMonth}
                            onChange={(e) => setSelectedMonth(e.target.value)}
                            className="bg-transparent border-none text-sm font-bold text-slate-700 focus:ring-0 p-2 cursor-pointer"
                        />
                        <button 
                            onClick={loadAchievements}
                            className="p-2 bg-white rounded-lg shadow-sm hover:bg-indigo-50 text-indigo-600 transition-colors"
                        >
                            <Search size={18} />
                        </button>
                    </div>
                </div>

                {isAchievementLoading ? (
                    <div className="flex flex-col items-center justify-center py-20 opacity-50">
                        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600 mb-4"></div>
                        <p className="text-sm font-bold text-slate-500">데이터 집계 중...</p>
                    </div>
                ) : achievements.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left border-separate border-spacing-y-2">
                            <thead>
                                <tr className="text-slate-400 font-black uppercase text-[10px] tracking-widest px-4">
                                    <th className="pb-4 pl-6">회원명</th>
                                    <th className="pb-4">관리구분</th>
                                    <th className="pb-4 text-center">목표 횟수</th>
                                    <th className="pb-4 text-center">실제 상담</th>
                                    <th className="pb-4 text-center">달성률</th>
                                    <th className="pb-4 pr-6 text-right">상태</th>
                                </tr>
                            </thead>
                            <tbody>
                                {achievements.map((item) => (
                                    <tr key={item.memberId} className="bg-slate-50/50 hover:bg-white hover:shadow-md transition-all duration-200 group">
                                        <td className="py-4 pl-6 rounded-l-2xl font-black text-slate-700">
                                            {item.memberName}
                                            <span className="block text-[10px] font-medium text-slate-400 mt-0.5">{item.memberId}</span>
                                        </td>
                                        <td className="py-4">
                                            <span className={`px-2.5 py-1 rounded-lg font-bold text-[10px] ${
                                                item.managementCategory === '집중관리' 
                                                ? 'bg-rose-100 text-rose-600' 
                                                : 'bg-indigo-100 text-indigo-600'
                                            }`}>
                                                {item.managementCategory}
                                            </span>
                                        </td>
                                        <td className="py-4 text-center font-bold text-slate-500">
                                            {item.targetSessions}회
                                        </td>
                                        <td className="py-4 text-center font-black text-slate-800">
                                            {item.actualSessions}회
                                        </td>
                                        <td className="py-4 text-center">
                                            <div className="flex items-center justify-center gap-2">
                                                <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                                    <div 
                                                        className={`h-full transition-all duration-1000 ${
                                                            item.status === 'success' ? 'bg-emerald-500' : 'bg-rose-400'
                                                        }`}
                                                        style={{ width: `${item.achievementRate}%` }}
                                                    ></div>
                                                </div>
                                                <span className={`font-black text-[11px] ${
                                                    item.status === 'success' ? 'text-emerald-600' : 'text-rose-500'
                                                }`}>
                                                    {item.achievementRate}%
                                                </span>
                                            </div>
                                        </td>
                                        <td className="py-4 pr-6 rounded-r-2xl text-right">
                                            {item.status === 'success' ? (
                                                <div className="flex items-center justify-end gap-1.5 text-emerald-600 font-black">
                                                    <CheckCircleIcon size={16} />
                                                    <span>{item.statusText || '적정 개입 (달성)'}</span>
                                                </div>
                                            ) : item.status === 'warning' ? (
                                                <div className="flex items-center justify-end gap-1.5 text-amber-500 font-black">
                                                    <AlertCircleIcon size={16} />
                                                    <span>{item.statusText || '과잉 개입 (ISP 점검 요망)'}</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center justify-end gap-1.5 text-rose-500 font-black">
                                                    <XCircleIcon size={16} />
                                                    <span>{item.statusText || '개입 부족 (미달)'}</span>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="py-20 text-center border-2 border-dashed border-slate-100 rounded-[2rem]">
                        <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                            <TrendingUp size={32} />
                        </div>
                        <h4 className="text-slate-800 font-black mb-1">분석 결과가 없습니다</h4>
                        <p className="text-slate-500 text-xs">선택한 월에 해당하는 상담 데이터가 존재하지 않습니다.</p>
                    </div>
                )}
            </div>

            {/* 3. Detailed Criteria (existing) */}
            <div className="bg-slate-50 p-8 rounded-[2rem] border border-slate-100">
                <h3 className="font-black text-slate-700 mb-6 flex items-center gap-2 text-sm uppercase tracking-wide">
                    <AlertCircleIcon size={16} className="text-amber-500" /> 상세 평가 기준
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-xs text-slate-600">
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 font-bold text-slate-800 bg-white px-3 py-1.5 rounded-lg border border-slate-100 w-fit shadow-sm">
                            <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[10px]">1</span>
                            집중관리 기준
                        </div>
                        <p className="leading-relaxed pl-2 border-l-2 border-rose-200 ml-3">
                            집중관리 대상자는 <span className="text-rose-600 font-bold">월 4회 이상</span>의 개입(내소, 방문, 온라인, 전화 등)이 이루어져야 달성으로 평가됩니다.
                        </p>
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 font-bold text-slate-800 bg-white px-3 py-1.5 rounded-lg border border-slate-100 w-fit shadow-sm">
                            <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[10px]">2</span>
                            일시관리 기준
                        </div>
                        <p className="leading-relaxed pl-2 border-l-2 border-indigo-200 ml-3">
                            일시관리 대상자는 <span className="text-indigo-600 font-bold">월 1회 이상</span>의 개입이 이루어져야 달성으로 평가됩니다.
                        </p>
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 font-bold text-slate-800 bg-white px-3 py-1.5 rounded-lg border border-slate-100 w-fit shadow-sm">
                            <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[10px]">3</span>
                            데이터 집계 방식
                        </div>
                        <p className="leading-relaxed pl-2 border-l-2 border-emerald-200 ml-3">
                            매월 1일부터 말일까지 등록된 모든 개별상담 및 자원조정 내역을 합산하여 계산합니다.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ISPAnalysisTab;

import React, { useState, useEffect } from 'react';
import { AnalysisResult } from '../../types';
import SummaryCards from './SummaryCards';
import CounselorPerformanceTab from './tabs/CounselorPerformanceTab';
import GeneralAnalysisTab from './tabs/GeneralAnalysisTab';
import ISPAnalysisTab from './tabs/ISPAnalysisTab';
import MemberAnalysisTab from './tabs/MemberAnalysisTab';
import BriefingTab from './tabs/BriefingTab';
import { PieChart, Users, FileText, Target, ClipboardList } from 'lucide-react';

interface AnalysisDashboardProps {
    analysisResult: AnalysisResult;
    dateRange: { start: string; end: string };
}

// Styled Tab Component
const TabButton: any = ({ label, icon: Icon, isActive, onClick }: any) => (
    <button
        onClick={onClick}
        className={`
            flex items-center gap-2 px-5 py-3 rounded-t-xl border-b-2 transition-all duration-200 font-bold text-sm
            ${isActive
                ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }
        `}
    >
        <Icon size={16} className={isActive ? 'text-indigo-600' : 'text-slate-400'} />
        {label}
    </button>
);

const AnalysisDashboard: React.FC<AnalysisDashboardProps> = ({
    analysisResult: initialResult,
    dateRange
}) => {
    // Tabs configuration
    const TABS = [
        { id: 'counselor', label: '상담사별 분석', icon: Users },
        { id: 'general', label: '일반상담 분석', icon: PieChart },
        { id: 'member', label: '회원/월별 분석', icon: FileText },
        { id: 'isp', label: 'ISP 수립률', icon: Target },
        { id: 'briefing', label: '풀브리핑 회의', icon: ClipboardList },
    ];
    // Local state for UI active tab only
    const [activeTabId, setActiveTabId] = useState(TABS[0].id);

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header / Actions Card */}
            <div className="flex flex-col sm:flex-row justify-between items-center bg-white p-5 rounded-2xl shadow-sm border border-slate-100 gap-4">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl">
                        <PieChart size={20} />
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-slate-800">분석 대시보드</h2>
                        <p className="text-xs text-slate-500 font-medium">시스템에 자동 로그 및 동기화된 최신 통합 데이터입니다.</p>
                    </div>
                </div>
            </div>

            {/* Summary Cards */}
            <SummaryCards counselorData={initialResult.counselorPerformance} />

            {/* Main Tabs Container */}
            <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 overflow-hidden min-h-[500px]">
                {/* Tab Header */}
                <div className="flex overflow-x-auto border-b border-slate-100 px-6 pt-4 bg-slate-50/30 custom-scrollbar">
                    {TABS.map(tab => (
                        <TabButton
                            key={tab.id}
                            label={tab.label}
                            icon={tab.icon}
                            isActive={activeTabId === tab.id}
                            onClick={() => setActiveTabId(tab.id)}
                        />
                    ))}
                </div>

                {/* Tab Content */}
                <div className="p-6 sm:p-8">
                    {activeTabId === 'counselor' && <CounselorPerformanceTab data={initialResult.counselorPerformance} dateRange={dateRange} />}
                    {activeTabId === 'general' && <GeneralAnalysisTab data={initialResult.counselorPerformance} dateRange={dateRange} />}
                    {activeTabId === 'member' && <MemberAnalysisTab data={initialResult.memberPerformance} dateRange={dateRange} />}
                    {activeTabId === 'isp' && <ISPAnalysisTab />}
                    {activeTabId === 'briefing' && <BriefingTab analysisResult={initialResult} dateRange={dateRange} />}
                </div>
            </div>
        </div>
    );
};

export default AnalysisDashboard;

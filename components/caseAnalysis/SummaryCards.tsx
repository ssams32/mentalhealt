
import React from 'react';
import { CounselorPerformance } from '../../types';
import { FileSignature, MessageSquare, Users, BarChart3 } from 'lucide-react';

import _ from 'lodash';

interface SummaryCardsProps {
    counselorData: CounselorPerformance[];
}

const SummaryCards: React.FC<SummaryCardsProps> = ({ counselorData }) => {
    const safeCounselorData = Array.isArray(counselorData) ? counselorData : [];
    const grandTotal = _.sumBy(safeCounselorData, (c: any) => (Array.isArray(c.allSessions) ? c.allSessions : []).length);
    const registrantTotal = _.sumBy(safeCounselorData, (c: any) => (Array.isArray(c.allSessions) ? c.allSessions : []).filter((s: any) => s.category === 'individual' || s.category === 'resource').length);
    const generalTotal = _.sumBy(safeCounselorData, (c: any) => (Array.isArray(c.allSessions) ? c.allSessions : []).filter((s: any) => s.category === 'general').length);
    const totalCounselors = new Set(safeCounselorData.map(c => c.counselorName)).size;

    const registrantRatio = grandTotal > 0 ? Math.round((registrantTotal / grandTotal) * 100) : 0;
    const generalRatio = grandTotal > 0 ? Math.round((generalTotal / grandTotal) * 100) : 0;

    return (
        <div className="mb-8">
            <h2 className="text-xl font-black text-slate-800 mb-5 tracking-tight">분석결과 요약</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {/* Card 1: 등록자 상담 건수 (Primary) */}
                <div className="relative bg-white rounded-2xl p-6 border-2 border-indigo-100 shadow-sm hover:shadow-lg transition-all duration-300 group overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-indigo-50 to-transparent rounded-bl-[3rem] opacity-60 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10">
                        <div className="flex items-center justify-between mb-4">
                            <div className="w-11 h-11 rounded-xl bg-indigo-50 flex items-center justify-center">
                                <FileSignature className="text-indigo-600" size={22} />
                            </div>
                            <span className="text-[10px] font-black text-indigo-500 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider">Registrant</span>
                        </div>
                        <p className="text-xs font-bold text-slate-400 mb-1 uppercase tracking-wider">등록자 상담 건수</p>
                        <div className="flex items-baseline gap-2">
                            <span className="text-3xl font-black text-slate-900">{registrantTotal.toLocaleString()}</span>
                            <span className="text-sm font-bold text-indigo-500">{registrantRatio}%</span>
                        </div>
                        <div className="mt-3 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500 rounded-full transition-all duration-1000" style={{ width: `${registrantRatio}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* Card 2: 일반 상담 건수 (Secondary) */}
                <div className="relative bg-white rounded-2xl p-6 border-2 border-emerald-100 shadow-sm hover:shadow-lg transition-all duration-300 group overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-emerald-50 to-transparent rounded-bl-[3rem] opacity-60 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10">
                        <div className="flex items-center justify-between mb-4">
                            <div className="w-11 h-11 rounded-xl bg-emerald-50 flex items-center justify-center">
                                <MessageSquare className="text-emerald-600" size={22} />
                            </div>
                            <span className="text-[10px] font-black text-emerald-500 bg-emerald-50 px-2.5 py-1 rounded-full uppercase tracking-wider">General</span>
                        </div>
                        <p className="text-xs font-bold text-slate-400 mb-1 uppercase tracking-wider">일반 상담 건수</p>
                        <div className="flex items-baseline gap-2">
                            <span className="text-3xl font-black text-slate-900">{generalTotal.toLocaleString()}</span>
                            <span className="text-sm font-bold text-emerald-500">{generalRatio}%</span>
                        </div>
                        <div className="mt-3 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-all duration-1000" style={{ width: `${generalRatio}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* Card 3: 총 상담 건수 */}
                <div className="relative bg-white rounded-2xl p-6 border-2 border-slate-100 shadow-sm hover:shadow-lg transition-all duration-300 group overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-slate-50 to-transparent rounded-bl-[3rem] opacity-60 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10">
                        <div className="flex items-center justify-between mb-4">
                            <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center">
                                <BarChart3 className="text-slate-600" size={22} />
                            </div>
                        </div>
                        <p className="text-xs font-bold text-slate-400 mb-1 uppercase tracking-wider">총 상담 건수</p>
                        <span className="text-3xl font-black text-slate-900">{grandTotal.toLocaleString()}</span>
                        <p className="text-[11px] text-slate-400 mt-2 font-medium">등록자 + 일반 합계</p>
                    </div>
                </div>

                {/* Card 4: 총 상담자 수 */}
                <div className="relative bg-white rounded-2xl p-6 border-2 border-slate-100 shadow-sm hover:shadow-lg transition-all duration-300 group overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-amber-50 to-transparent rounded-bl-[3rem] opacity-60 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10">
                        <div className="flex items-center justify-between mb-4">
                            <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center">
                                <Users className="text-amber-600" size={22} />
                            </div>
                        </div>
                        <p className="text-xs font-bold text-slate-400 mb-1 uppercase tracking-wider">총 상담자 수</p>
                        <span className="text-3xl font-black text-slate-900">{totalCounselors.toLocaleString()}</span>
                        <p className="text-[11px] text-slate-400 mt-2 font-medium">분석 기간 내 활동</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SummaryCards;

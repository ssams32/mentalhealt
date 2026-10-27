import React from 'react';
import { AnalysisResult } from '../../types';
import _ from 'lodash';

interface DiagnosticsPanelProps {
    analysisResult: AnalysisResult;
    dateRange: { start: string; end: string };
}

/**
 * 건수 진단 패널 — 엑셀 행수와 화면 건수의 차이를 사유별로 보여준다.
 * 개인정보(이름·내용)는 일절 표시하지 않고 사유별 건수만 집계한다.
 * - 파싱 집계: 기간 필터 적용 전, 파서가 allSessions에 넣은 행수
 * - 화면 표시: 상단 분석 기간 필터 적용 후 대시보드 카드에 표시되는 건수
 * - 차이(파싱 집계 - 화면 표시) = 기간 필터 효과
 */
const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({ analysisResult, dateRange }) => {
    const diagnostics = analysisResult.diagnostics;
    if (!diagnostics || !Array.isArray(diagnostics.files) || diagnostics.files.length === 0) {
        return null;
    }

    const safeCounselorData = Array.isArray(analysisResult.counselorPerformance) ? analysisResult.counselorPerformance : [];
    const displayedByCategory = (category: string) =>
        _.sumBy(safeCounselorData, (c: any) => (Array.isArray(c.allSessions) ? c.allSessions : []).filter((s: any) => s.category === category).length);
    const displayedMap: Record<string, number> = {
        '1.개별상담': displayedByCategory('individual'),
        '2.자원조정': displayedByCategory('resource'),
        '3.일반상담': displayedByCategory('general'),
    };

    return (
        <div className="bg-white rounded-[24px] p-[21px] border border-slate-100 shadow-sm">
            <div className="flex flex-col sm:flex-row justify-between gap-2 mb-4">
                <h3 className="text-[15px] font-black text-slate-800">건수 진단 — 파일별 행수 대조</h3>
                <span className="text-[11px] text-slate-400 font-medium">개인정보 없음 · 사유별 건수만 표시 · 분석 기간 {dateRange.start} ~ {dateRange.end}</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-100">
                        <tr>
                            <th className="px-3 py-2 text-left font-black text-slate-400">파일</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">엑셀 행수</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">파싱 집계</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">화면 표시</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">제외: 상담사 없음</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">제외: 팀구별 없음</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">제외: 날짜 오류</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">제외: 유형 미매칭</th>
                            <th className="px-3 py-2 text-right font-black text-slate-400">그중 부재 포함</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {diagnostics.files.map((f) => (
                            <tr key={f.fileLabel}>
                                <td className="px-3 py-2 font-bold text-slate-700 whitespace-nowrap">{f.fileLabel}</td>
                                <td className="px-3 py-2 text-right text-slate-800">{f.totalRows.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right font-bold text-slate-800">{f.counted.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right font-bold text-indigo-600">{(displayedMap[f.fileLabel] ?? 0).toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{f.dropNoCounselor.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{f.dropCounselorNotInTeam.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{f.dropBadDate.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{f.dropTypeUnknown.toLocaleString()}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{f.absentCounted.toLocaleString()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-[11px] text-slate-400 font-medium mt-3">
                엑셀 행수 = 파싱 집계 + 제외 4종 합계입니다. 파싱 집계와 화면 표시의 차이 = 상단 분석 기간 필터 효과입니다.
            </p>
        </div>
    );
};

export default DiagnosticsPanel;

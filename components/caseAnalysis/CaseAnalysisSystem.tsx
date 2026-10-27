import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { AnalysisResult, User } from '../../types';
import { analyzeAllFiles } from '../../services/excelAnalysisService';
import { apiClient } from '../../services/apiClient';
import PageContainer from '../layout/PageContainer';
import FileUploadArea from './FileUploadArea';
import FilterControls from './FilterControls';
import AnalysisDashboard from './AnalysisDashboard';
import StaffSettingsPanel, { StaffEntry } from './StaffSettingsPanel';
import { Loader2, AlertTriangle, FileSpreadsheet } from 'lucide-react';

interface CaseAnalysisSystemProps {
    currentUser?: User;
}

const TEAM_TO_DEPT_MAP: Record<string, string[]> = {
    '자살예방센터': ['자살팀', '자살예방센터'],
    '증진팀': ['증진팀'],
    '회복팀': ['회복팀'],
    '남부분소': ['남부분소'],
    '아동청소년': ['아동청소년', '아청팀']
};

const CaseAnalysisSystem: React.FC<CaseAnalysisSystemProps> = ({ currentUser }) => {
    // [Role & Team Isolation]
    const isRestrictedUser = Boolean(currentUser && currentUser.role === 'user');
    const userAllowedDepts = useMemo(() => {
        if (!isRestrictedUser || !currentUser?.team) return null;
        return TEAM_TO_DEPT_MAP[currentUser.team] || [currentUser.team];
    }, [isRestrictedUser, currentUser?.team]);

    // --- State ---
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analyzeError, setAnalyzeError] = useState<string | null>(null);

    // Filters
    const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
    const [selectedCounselors, setSelectedCounselors] = useState<string[]>([]);
    const [dateRange, setDateRange] = useState({ start: '', end: '' });

    // Global State Initial Load
    const [isInitialLoading, setIsInitialLoading] = useState(true);

    // 직원 명단 (팀 구분 기준): 시스템 등록 직원 + 설정에서 추가한 직원
    const [systemStaff, setSystemStaff] = useState<StaffEntry[]>([]);
    const [extraStaff, setExtraStaff] = useState<StaffEntry[]>([]);

    // [2026-10-27 jun 지시] 팀 구분 명단을 시스템에서 불러온다 (팀구별 엑셀 불필요)
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/users', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    const users = Array.isArray(data) ? data : (data.users || []);
                    setSystemStaff(users
                        .filter((u: any) => u && u.name)
                        .map((u: any) => ({ name: String(u.name).trim(), team: u.team || '부서정보없음' })));
                }
            } catch { /* 명단 로드 실패 시 빈 명단으로 진행 (건수에는 영향 없음) */ }
            try {
                const res = await fetch('/api/settings', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    const extra = Array.isArray(data.caseAnalysisExtraStaff) ? data.caseAnalysisExtraStaff : [];
                    setExtraStaff(extra.filter((s: any) => s && s.name).map((s: any) => ({ name: String(s.name).trim(), team: s.team || '부서정보없음' })));
                }
            } catch { /* 설정 로드 실패 시 빈 목록으로 진행 */ }
        })();
    }, []);

    // --- Actions ---
    const handleFilesUpload = useCallback(async (uploadedFiles: File[]) => {
        if (uploadedFiles.length === 0) return;
        setIsAnalyzing(true);
        setAnalyzeError(null);
        setAnalysisResult(null);

        try {
            const results = await analyzeAllFiles(uploadedFiles, { systemStaff, extraStaff });
            setAnalysisResult(results);
            initializeFilters(results);

            // 분석 결과 자동 저장 (설정 실패는 조용히 무시)
            try {
                await apiClient.saveAnalysisCurrent(results);
            } catch (saveErr) {
                console.warn("[CaseAnalysis] 자동저장 실패 (ignore):", saveErr);
            }
        } catch (err: any) {
            console.error(err);
            setAnalyzeError(err instanceof Error ? err.message : '분석 중 알 수 없는 오류가 발생했습니다.');
            setAnalysisResult(null);
        } finally {
            setIsAnalyzing(false);
        }
    }, [systemStaff, extraStaff]);

    const initializeFilters = (results: AnalysisResult) => {
        const counselorPerf = Array.isArray(results.counselorPerformance) ? results.counselorPerformance : [];
        let allDepts = Array.from(new Set(counselorPerf.map(c => c.department))).sort();

        if (userAllowedDepts && userAllowedDepts.length > 0) {
            const matching = allDepts.filter(d => userAllowedDepts.includes(d));
            allDepts = matching.length > 0 ? matching : userAllowedDepts;
        }

        const validCounselors = counselorPerf
            .filter(c => allDepts.includes(c.department))
            .map(c => c.counselorName)
            .sort();

        setSelectedDepartments(allDepts);
        setSelectedCounselors(validCounselors);

        // Date Range Auto-detect
        const allDates = counselorPerf.flatMap(c => (Array.isArray(c.faceToFaceSessions) ? c.faceToFaceSessions : []).map(s => s.date)).filter(Boolean);
        let year = new Date().getFullYear();
        if (allDates.length > 0) {
            const years = allDates.map(d => parseInt(d.split('-')[0]));
            year = Math.max(...years);
        }
        const start = `${year}-01-01`;
        const end = year === new Date().getFullYear()
            ? new Date().toISOString().split('T')[0]
            : `${year}-12-31`;
        setDateRange({ start, end });
    };

    // --- Lifecycle ---
    useEffect(() => {
        const loadGlobalData = async () => {
            try {
                const json = await apiClient.getAnalysisCurrent();
                if (json && json.success && json.data) {
                    setAnalysisResult(json.data);
                    initializeFilters(json.data);
                }
            } catch (err) {
                console.warn("[CaseAnalysis] 글로벌 상태 로드 실패 (ignore):", err);
            } finally {
                setIsInitialLoading(false);
            }
        };
        loadGlobalData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- Derived State for Filters ---
    // (Optimization: Only recalculate available options when raw result changes)
    const availableDepartments = useMemo(() => {
        if (!analysisResult) return [];
        const counselorPerf = Array.isArray(analysisResult.counselorPerformance) ? analysisResult.counselorPerformance : [];
        const depts = Array.from(new Set(counselorPerf.map(c => c.department))).sort();
        if (userAllowedDepts && userAllowedDepts.length > 0) {
            const matching = depts.filter(d => userAllowedDepts.includes(d));
            return matching.length > 0 ? matching : userAllowedDepts;
        }
        return depts;
    }, [analysisResult, userAllowedDepts]);

    const availableCounselors = useMemo(() => {
        if (!analysisResult) return [];
        const counselorPerf = Array.isArray(analysisResult.counselorPerformance) ? analysisResult.counselorPerformance : [];
        return counselorPerf
            .filter(c => selectedDepartments.includes(c.department))
            .map(c => c.counselorName)
            .sort();
    }, [analysisResult, selectedDepartments]);

    // Update selected counselors when departments change
    useEffect(() => {
        if (analysisResult) {
            const safeCounselorPerf = Array.isArray(analysisResult.counselorPerformance) ? analysisResult.counselorPerformance : [];
            const validCounselors = new Set<string>(
                safeCounselorPerf
                    .filter(c => selectedDepartments.includes(c.department))
                    .map(c => String(c.counselorName))
            );

            // Calculate what the new selection should be
            let newSelected: string[];
            const currentFiltered = selectedCounselors.filter(c => validCounselors.has(c));
            
            if (currentFiltered.length === 0 && validCounselors.size > 0) {
                // If nothing is selected or previous selections are all invalid, select all valid ones
                newSelected = Array.from(validCounselors);
            } else {
                // Keep currently selected ones that are still valid
                newSelected = currentFiltered;
            }

            // Only update if the selection actually changed (content-wise)
            const isSame = newSelected.length === selectedCounselors.length && 
                          newSelected.every(v => selectedCounselors.includes(v));

            if (!isSame) {
                setSelectedCounselors(newSelected);
            }
        }
    }, [selectedDepartments, analysisResult, selectedCounselors]); // Added selectedCounselors to deps for correctness, with guard

    // Apply Filters to Data
    const filteredResults = useMemo((): AnalysisResult | null => {
        if (!analysisResult) return null;

        const { start, end } = dateRange;
        const startDate = start ? new Date(start) : new Date('1900-01-01');
        const endDate = end ? new Date(end) : new Date('2100-12-31');
        endDate.setHours(23, 59, 59, 999);

        const isDateInRange = (dateStr: string) => {
            if (!dateStr) return false;
            const d = new Date(dateStr);
            return d >= startDate && d <= endDate;
        };

        const filterBySelection = (item: any): boolean => {
            let mainCounselor: string;
            if (item.counselorName) mainCounselor = item.counselorName;
            else if (item.mainCounselor) mainCounselor = item.mainCounselor;
            else if (item.registrant) mainCounselor = item.registrant;
            else return false;

            const counselorInfo = analysisResult.counselorPerformance.find(c => c.counselorName === mainCounselor);
            const department = counselorInfo ? counselorInfo.department : item.department;

            return selectedDepartments.includes(department) && selectedCounselors.includes(mainCounselor);
        };

        // Deep Filter Logic (Copied/Refined from previous)
        const safeCounselorPerf = Array.isArray(analysisResult.counselorPerformance) ? analysisResult.counselorPerformance : [];
        const filteredCounselorPerformance = safeCounselorPerf
            .filter(filterBySelection)
            .map(c => {
                const inRangeSessions = (c.allSessions || []).filter(s => isDateInRange(s.date));
                // 상담사별 집계(types·합계)는 개별상담+자원조정만 대상으로 한다.
                // 일반상담(category 'general')은 '일반상담 분석' 탭에서만 집계한다.
                // category가 없는 레거시 세션은 개별/자원조정으로 간주한다.
                const validSessions = inRangeSessions.filter(s => s.category !== 'general');
                const newTypes = { inOffice: 0, visit: 0, online: 0, emergency: 0, phone: 0 };
                validSessions.forEach(s => {
                    const type = s.type as keyof typeof newTypes;
                    if (newTypes[type] !== undefined) newTypes[type]++;
                });
                const total = Object.values(newTypes).reduce((a, b) => a + b, 0);

                return {
                    ...c,
                    types: newTypes,
                    totalSessions: total,
                    totalEmergency: newTypes.emergency,
                    // 서비스 초기 집계와 동일: 개별+자원조정의 유형 판정 세션 수(응급 포함)
                    totalGeneral: total,
                    // allSessions는 일반상담 탭·요약 카드가 category로 나눠 쓰므로 전 category를 유지한다
                    allSessions: inRangeSessions,
                    faceToFaceSessions: (c.faceToFaceSessions || []).filter(s => isDateInRange(s.date))
                };
            });

        const safeMemberPerf = Array.isArray(analysisResult.memberPerformance) ? analysisResult.memberPerformance : [];
        const filteredMemberPerformance = safeMemberPerf.filter(filterBySelection);
        // Note: Detailed filtering for members omitted for performance/complexity balance as per previous logic

        const safeISP = Array.isArray(analysisResult.ispExpiringMembers) ? analysisResult.ispExpiringMembers : [];
        const filteredISP = safeISP.filter(filterBySelection).filter(item => isDateInRange(item.date));

        return {
            counselorPerformance: filteredCounselorPerformance,
            memberPerformance: filteredMemberPerformance,
            ispExpiringMembers: filteredISP,
            ispPlans: analysisResult?.ispPlans || [],
            briefingMembers: analysisResult?.briefingMembers || [],
            briefingComments: analysisResult?.briefingComments || {},
            deregisteredRegNos: analysisResult?.deregisteredRegNos || [],
            diagnostics: analysisResult?.diagnostics
        };
    }, [analysisResult, selectedDepartments, selectedCounselors, dateRange]);


    return (
        <PageContainer title="사례 분석 시스템" subtitle="엑셀 데이터 리포트 및 심층 분석">
            <div className="space-y-[var(--space-7,34px)] pb-20">

                {/* 1. File Upload Section */}
                <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                    <FileUploadArea onFilesUpload={handleFilesUpload} isLoading={isAnalyzing} />
                </div>

                {/* 1-2. Staff Settings (team division roster) */}
                <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                    <StaffSettingsPanel
                        systemStaff={systemStaff}
                        extraStaff={extraStaff}
                        onExtraStaffChange={setExtraStaff}
                    />
                </div>

                {/* Loading / Error States */}
                {isAnalyzing && (
                    <div className="flex flex-col items-center justify-center py-20 animate-pulse">
                        <Loader2 className="animate-spin text-indigo-600 mb-4" size={48} />
                        <p className="text-lg font-bold text-slate-700">데이터 구조 분석 중...</p>
                        <p className="text-sm text-slate-400">파일 크기에 따라 시간이 소요될 수 있습니다.</p>
                    </div>
                )}

                {analyzeError && (
                    <div className="bg-rose-50 border border-rose-100 rounded-2xl p-6 flex items-start gap-4">
                        <div className="p-2 bg-rose-100 text-rose-600 rounded-lg shrink-0">
                            <AlertTriangle size={24} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-rose-700 mb-1">분석 오류 발생</h3>
                            <p className="text-sm text-rose-600 mb-4">{analyzeError}</p>
                            <button
                                onClick={() => setAnalyzeError(null)}
                                className="px-4 py-2 bg-white border border-rose-200 text-rose-600 rounded-lg text-xs font-bold hover:bg-rose-50"
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                )}

                {/* 2. Results Dashboard */}
                {!isAnalyzing && !analyzeError && filteredResults && (
                    <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 space-y-[var(--space-7,34px)]">
                        <FilterControls
                            departments={availableDepartments}
                            counselors={availableCounselors}
                            selectedDepartments={selectedDepartments}
                            setSelectedDepartments={setSelectedDepartments}
                            selectedCounselors={selectedCounselors}
                            setSelectedCounselors={setSelectedCounselors}
                            dateRange={dateRange}
                            setDateRange={setDateRange}
                            isRestrictedUser={isRestrictedUser}
                            userTeam={currentUser?.team}
                        />

                        <AnalysisDashboard
                            analysisResult={filteredResults}
                            dateRange={dateRange}
                        />
                    </div>
                )}

                {/* 3. Empty State */}
                {isInitialLoading && !analysisResult && (
                    <div className="flex flex-col items-center justify-center py-20 animate-pulse">
                        <Loader2 className="animate-spin text-indigo-600 mb-4" size={48} />
                        <p className="text-lg font-bold text-slate-700">기존 분석 데이터 불러오는 중...</p>
                    </div>
                )}

                {!isInitialLoading && !isAnalyzing && !analyzeError && !analysisResult && (
                    <div className="flex justify-center animate-in fade-in duration-1000 delay-300">
                        <div className="text-center py-12 px-4 max-w-lg">
                            <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-6">
                                <FileSpreadsheet size={32} className="text-indigo-600" />
                            </div>
                            <h3 className="text-xl font-black text-slate-800 mb-2">저장된 분석 결과가 없습니다</h3>
                            <p className="text-sm text-slate-500 font-medium">
                                상단의 파일 업로드 영역에 엑셀 데이터를 드래그하여 드롭하면, <br />
                                데이터를 분석하여 리포트를 생성하고 <strong className="text-indigo-600">자동으로 시스템에 영구 저장</strong>합니다.
                            </p>
                        </div>
                    </div>
                )}

            </div>
        </PageContainer>
    );
};

export default CaseAnalysisSystem;

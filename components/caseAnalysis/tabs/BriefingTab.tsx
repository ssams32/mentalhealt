import React, { useState, useMemo, useEffect } from 'react';
import { AnalysisResult, BriefingComment } from '../../../types';
import {
    joinBriefingData,
    JoinedBriefingItem,
    exportBriefingToExcel,
    normalizePersonName
} from '../../../utils/briefingUtils';
import { apiClient } from '../../../services/apiClient';
import {
    Search,
    FileSpreadsheet,
    Calendar,
    User,
    Building2,
    Clock,
    AlertCircle,
    ChevronDown,
    ChevronUp,
    Send,
    Edit3,
    Trash2,
    Check,
    X,
    Filter
} from 'lucide-react';

interface BriefingTabProps {
    analysisResult: AnalysisResult;
    dateRange: { start: string; end: string };
    currentUser?: any;
}

export const BriefingTab: React.FC<BriefingTabProps> = ({
    analysisResult,
    dateRange,
    currentUser
}) => {
    // 1. 상담사 매핑 (counselorPerformance로부터 부서 매핑 구성)
    const counselorMap = useMemo(() => {
        const map: Record<string, string> = {};
        (analysisResult?.counselorPerformance || []).forEach(c => {
            if (c.counselorName) {
                map[c.counselorName] = c.department || '부서정보없음';
            }
        });
        return map;
    }, [analysisResult]);

    // 2. 조인된 브리핑 전체 데이터 (순수 함수)
    const allJoinedMembers = useMemo(() => {
        return joinBriefingData({
            ispPlans: analysisResult?.ispPlans || [],
            briefingMembers: analysisResult?.briefingMembers || [],
            counselorMap,
            dateRange,
            today: new Date()
        });
    }, [analysisResult, counselorMap, dateRange]);

    // 3. 필터 및 검색 상태
    const [searchQuery, setSearchQuery] = useState('');
    const [suitabilityFilter, setSuitabilityFilter] = useState<'전체' | '적정' | '부족' | '개입없음'>('전체');
    const [categoryFilter, setCategoryFilter] = useState<string>('전체');
    const [departmentFilter, setDepartmentFilter] = useState<string>('전체');

    // 사용 가능한 부서 목록
    const departments = useMemo(() => {
        const depts = new Set<string>();
        allJoinedMembers.forEach(m => {
            if (m.department && m.department !== '부서정보없음') depts.add(m.department);
        });
        return ['전체', ...Array.from(depts).sort()];
    }, [allJoinedMembers]);

    // 4. 검색 및 필터 적용 (설계서 §3: 요약 바와 목록은 반드시 같은 필터 결과/모수를 사용)
    const filteredMembers = useMemo(() => {
        const cleanQuery = searchQuery.trim().replace(/\s+/g, '').toLowerCase();

        return allJoinedMembers.filter(member => {
            // 검색: 대상자명 또는 담당자명 부분일치 (공백 무시)
            if (cleanQuery) {
                const nameMatch = member.normalizedName.toLowerCase().includes(cleanQuery);
                const counselorMatch = normalizePersonName(member.counselor).toLowerCase().includes(cleanQuery);
                if (!nameMatch && !counselorMatch) return false;
            }

            // 적절성 필터
            if (suitabilityFilter !== '전체') {
                if (suitabilityFilter === '개입없음' && member.suitability !== '개입없음') return false;
                if (suitabilityFilter === '부족' && member.suitability !== '부족') return false;
                if (suitabilityFilter === '적정' && member.suitability !== '적정') return false;
            }

            // 관리구분 필터
            if (categoryFilter !== '전체') {
                if (member.normalizedCategory !== categoryFilter) return false;
            }

            // 부서 필터
            if (departmentFilter !== '전체') {
                if (member.department !== departmentFilter) return false;
            }

            return true;
        });
    }, [allJoinedMembers, searchQuery, suitabilityFilter, categoryFilter, departmentFilter]);

    // 5. 선택된 대상자 상태
    const [selectedMemberId, setSelectedMemberId] = useState<string>('');

    // 목록이 변경되었을 때 첫 번째 대상자 자동 선택
    useEffect(() => {
        if (filteredMembers.length > 0) {
            const exists = filteredMembers.some(m => m.id === selectedMemberId);
            if (!exists) {
                setSelectedMemberId(filteredMembers[0].id);
            }
        } else {
            setSelectedMemberId('');
        }
    }, [filteredMembers, selectedMemberId]);

    const selectedMember = useMemo(() => {
        return filteredMembers.find(m => m.id === selectedMemberId) || null;
    }, [filteredMembers, selectedMemberId]);

    // 6. 요약 바 수치 계산 (필터 적용된 집합 기준 — 설계서 §3.1, §98)
    const summaryStats = useMemo(() => {
        const total = filteredMembers.length;
        const good = filteredMembers.filter(m => m.suitability === '적정').length;
        const warn = filteredMembers.filter(m => m.suitability === '부족').length;
        const none = filteredMembers.filter(m => m.suitability === '개입없음').length;
        // 재수립 도래: 오늘 기준 30일 이내 또는 경과 (기간 필터와 무관)
        const due = filteredMembers.filter(m => m.isExpiring).length;
        return { total, good, warn, none, due };
    }, [filteredMembers]);

    // 7. 타임라인 상세 보기 토글 (세션 인덱스별)
    const [expandedSessionIdx, setExpandedSessionIdx] = useState<Record<number, boolean>>({});
    const toggleSessionDetail = (idx: number) => {
        setExpandedSessionIdx(prev => ({ ...prev, [idx]: !prev[idx] }));
    };

    // 8. 상태평가 0점 영역 토글
    const [showZeroNeeds, setShowZeroNeeds] = useState(false);

    // 9. 수퍼비전 코멘트 로컬 상태
    const [commentsMap, setCommentsMap] = useState<Record<string, BriefingComment[]>>(() => {
        return analysisResult?.briefingComments || {};
    });

    useEffect(() => {
        if (analysisResult?.briefingComments) {
            setCommentsMap(prev => ({
                ...analysisResult.briefingComments,
                ...prev
            }));
        }
    }, [analysisResult?.briefingComments]);

    const [commentInput, setCommentInput] = useState('');
    const [isSavingComment, setIsSavingComment] = useState(false);
    const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState('');

    const currentMemberComments = useMemo(() => {
        if (!selectedMember) return [];
        return commentsMap[selectedMember.id] || [];
    }, [commentsMap, selectedMember]);

    // 코멘트 저장 핸들러
    const handleSaveComment = async () => {
        if (!selectedMember || !commentInput.trim()) return;
        const text = commentInput.trim();
        setIsSavingComment(true);

        const currentAuthor = currentUser?.name || currentUser?.username || '상담사';

        try {
            // 서버 세션 사용자 기준 API 호출
            const res = await apiClient.addBriefingComment(selectedMember.id, text);
            if (res && res.success && res.comments) {
                setCommentsMap(prev => ({
                    ...prev,
                    [selectedMember.id]: res.comments
                }));
            } else {
                // 로컬 폴백
                const fallbackComment: BriefingComment = {
                    id: `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                    text,
                    author: currentAuthor,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                setCommentsMap(prev => ({
                    ...prev,
                    [selectedMember.id]: [...(prev[selectedMember.id] || []), fallbackComment]
                }));
            }
            setCommentInput('');
        } catch (err) {
            console.warn('[BriefingTab] 코멘트 서버 저장 실패, 로컬 반영:', err);
            const fallbackComment: BriefingComment = {
                id: `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                text,
                author: currentAuthor,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            setCommentsMap(prev => ({
                ...prev,
                [selectedMember.id]: [...(prev[selectedMember.id] || []), fallbackComment]
            }));
            setCommentInput('');
        } finally {
            setIsSavingComment(false);
        }
    };

    // 코멘트 수정 핸들러
    const handleUpdateComment = async (commentId: string) => {
        if (!selectedMember || !editingText.trim()) return;
        try {
            const res = await apiClient.updateBriefingComment(selectedMember.id, commentId, editingText.trim());
            if (res && res.success && res.comments) {
                setCommentsMap(prev => ({ ...prev, [selectedMember.id]: res.comments }));
            } else {
                setCommentsMap(prev => {
                    const list = prev[selectedMember.id] || [];
                    return {
                        ...prev,
                        [selectedMember.id]: list.map(c => c.id === commentId ? { ...c, text: editingText.trim(), updatedAt: new Date().toISOString() } : c)
                    };
                });
            }
            setEditingCommentId(null);
            setEditingText('');
        } catch (err) {
            console.warn('[BriefingTab] 코멘트 수정 실패:', err);
            setEditingCommentId(null);
        }
    };

    // 코멘트 삭제 핸들러
    const handleDeleteComment = async (commentId: string) => {
        if (!selectedMember) return;
        if (!window.confirm('이 수퍼비전 코멘트를 삭제하시겠습니까?')) return;
        try {
            const res = await apiClient.deleteBriefingComment(selectedMember.id, commentId);
            if (res && res.success && res.comments) {
                setCommentsMap(prev => ({ ...prev, [selectedMember.id]: res.comments }));
            } else {
                setCommentsMap(prev => {
                    const list = prev[selectedMember.id] || [];
                    return {
                        ...prev,
                        [selectedMember.id]: list.filter(c => c.id !== commentId)
                    };
                });
            }
        } catch (err) {
            console.warn('[BriefingTab] 코멘트 삭제 실패:', err);
        }
    };

    // 엑셀 다운로드 핸들러 (설계서 §3.4: 4개 열 강제, 익명화)
    const handleExcelDownload = () => {
        exportBriefingToExcel({
            members: filteredMembers,
            comments: commentsMap
        });
    };

    return (
        <div className="space-y-4 text-[#1E2A33] font-sans">
            {/* 1. 상단 요약 바 (시안 v4 스타일: 가운데 정렬, 상단 색상 바 띠) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {/* 1) 브리핑 대상자 */}
                <div className="bg-white border border-[#E4E1D9] border-t-4 border-t-[#0E5E7E] rounded-xl p-3 text-center shadow-xs">
                    <span className="block text-2xl font-black text-[#0E5E7E] tracking-tight">{summaryStats.total}명</span>
                    <span className="block text-xs font-bold text-[#5C6B76] mt-1">브리핑 대상자</span>
                </div>

                {/* 2) 적정 */}
                <div className="bg-white border border-[#E4E1D9] border-t-4 border-t-[#17705A] rounded-xl p-3 text-center shadow-xs">
                    <span className="block text-2xl font-black text-[#17705A] tracking-tight">{summaryStats.good}명</span>
                    <span className="block text-xs font-bold text-[#5C6B76] mt-1">적정</span>
                </div>

                {/* 3) 부족 */}
                <div className="bg-white border border-[#E4E1D9] border-t-4 border-t-[#A96F14] rounded-xl p-3 text-center shadow-xs">
                    <span className="block text-2xl font-black text-[#A96F14] tracking-tight">{summaryStats.warn}명</span>
                    <span className="block text-xs font-bold text-[#5C6B76] mt-1">부족</span>
                </div>

                {/* 4) 개입 없음 */}
                <div className="bg-white border border-[#E4E1D9] border-t-4 border-t-[#B3402C] rounded-xl p-3 text-center shadow-xs">
                    <span className="block text-2xl font-black text-[#B3402C] tracking-tight">{summaryStats.none}명</span>
                    <span className="block text-xs font-bold text-[#5C6B76] mt-1">개입 없음</span>
                </div>

                {/* 5) ISP 재수립 도래 */}
                <div className="bg-white border border-[#E4E1D9] border-t-4 border-t-[#8C6A1D] rounded-xl p-3 text-center shadow-xs">
                    <span className="block text-2xl font-black text-[#8C6A1D] tracking-tight">{summaryStats.due}명</span>
                    <span className="block text-xs font-bold text-[#5C6B76] mt-1">ISP 재수립 도래</span>
                </div>

                {/* 6) 엑셀 다운로드 (재수립 도래 오른쪽 배치) */}
                <button
                    type="button"
                    onClick={handleExcelDownload}
                    className="flex items-center justify-center gap-2.5 bg-[#14663C] hover:bg-[#0f5230] text-white rounded-xl p-3 text-left shadow-xs transition-colors cursor-pointer group"
                    title="현재 검색·필터 적용 대상자 목록을 엑셀로 내려받습니다 (수퍼비전 내용 포함)"
                >
                    <FileSpreadsheet size={24} className="text-white/90 group-hover:scale-105 transition-transform shrink-0" />
                    <div>
                        <span className="block text-xs font-black leading-tight text-white">엑셀 다운로드</span>
                        <span className="block text-[10px] font-semibold text-[#BFE3CF] mt-0.5">수퍼비전 포함</span>
                    </div>
                </button>
            </div>

            {/* 안내 뱃지 / 알림 */}
            <div className="flex flex-wrap items-center justify-between text-xs text-[#5C6B76] bg-[#F7F6F2] px-3.5 py-2 rounded-lg border border-[#E4E1D9]">
                <div className="flex items-center gap-2">
                    <span className="font-bold text-[#0E5E7E]">회의 기준:</span>
                    <span>개별상담+자원조정 합산 (집중 월 4회 / 유지·일시 월 1회, 노쇼 건 제외).</span>
                </div>
                <div className="text-[11px] text-[#8C6A1D]">
                    * 재수립 도래는 오늘 기준(수립+180일) 산정이며 선택 기간 필터와 무관합니다.
                </div>
            </div>

            {/* 2. 본문 2단 구성 (한 화면 2단 레이아웃) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                {/* [좌측 패널]: 검색·필터 + 대상자 목록 (4칸 또는 350px) */}
                <div className="lg:col-span-4 bg-white border border-[#E4E1D9] rounded-2xl flex flex-col shadow-xs overflow-hidden">
                    {/* 상단 검색 및 칩 */}
                    <div className="p-3.5 border-b border-[#EFEEE8] space-y-2.5 bg-[#FAF9F5]">
                        {/* 검색창 */}
                        <div className="relative flex items-center">
                            <Search size={15} className="absolute left-3 text-[#9AA7AF]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="대상자명 또는 담당자명 검색"
                                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-[#E4E1D9] rounded-lg focus:outline-none focus:border-[#0E5E7E] placeholder:text-[#9AA7AF]"
                            />
                            {searchQuery && (
                                <button
                                    onClick={() => setSearchQuery('')}
                                    className="absolute right-2.5 text-[#9AA7AF] hover:text-[#5C6B76]"
                                >
                                    <X size={13} />
                                </button>
                            )}
                        </div>

                        {/* 필터 칩 */}
                        <div className="flex flex-wrap items-center gap-1.5">
                            {(['전체', '개입없음', '부족', '적정'] as const).map(f => (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => setSuitabilityFilter(f)}
                                    className={`px-2.5 py-1 text-[11px] font-extrabold rounded-full transition-colors cursor-pointer ${
                                        suitabilityFilter === f
                                            ? 'bg-[#E7F0F4] text-[#0E5E7E] border border-[#BFD9E4]'
                                            : 'bg-[#F0EFE9] text-[#5C6B76] border border-transparent hover:bg-[#EAE8E0]'
                                    }`}
                                >
                                    {f === '개입없음' ? '개입 없음' : f}
                                </button>
                            ))}

                            {/* 부서 선택 */}
                            <select
                                value={departmentFilter}
                                onChange={e => setDepartmentFilter(e.target.value)}
                                className="ml-auto text-[11px] font-bold text-[#5C6B76] bg-transparent border-none focus:outline-none cursor-pointer"
                            >
                                {departments.map(d => (
                                    <option key={d} value={d}>부서: {d}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* 대상자 목록 (스크롤 가능) */}
                    <div className="overflow-y-auto max-h-[660px] p-2 space-y-1.5 custom-scrollbar">
                        {filteredMembers.length === 0 ? (
                            <div className="py-12 text-center text-xs text-[#9AA7AF]">
                                조건에 일치하는 대상자가 없습니다.
                            </div>
                        ) : (
                            filteredMembers.map(member => {
                                const isSelected = member.id === selectedMemberId;

                                // 배지 스타일
                                let suitBadgeBg = 'bg-[#F9E0D9] text-[#9C3524]'; // none
                                if (member.suitability === '적정') suitBadgeBg = 'bg-[#DDF0E4] text-[#175C40]';
                                else if (member.suitability === '부족') suitBadgeBg = 'bg-[#F9E7D8] text-[#9A5410]';
                                else if (member.suitability === '판정제외') suitBadgeBg = 'bg-[#F0EFE9] text-[#5C6B76]';

                                let catBadgeBg = 'bg-[#E7F0F4] text-[#0E5E7E]';
                                if (member.normalizedCategory === '유지관리') catBadgeBg = 'bg-[#DDF0E4] text-[#175C40]';
                                else if (member.normalizedCategory === '일시관리') catBadgeBg = 'bg-[#F7EBCB] text-[#7A5A10]';

                                return (
                                    <div
                                        key={member.id}
                                        onClick={() => setSelectedMemberId(member.id)}
                                        className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                                            isSelected
                                                ? 'bg-[#E7F0F4] border-[#BFD9E4] shadow-xs'
                                                : 'bg-white border-transparent hover:bg-[#FAF9F5] hover:border-[#EFEEE8]'
                                        }`}
                                    >
                                        {/* 1행: 이름, 등록번호 뒷자리, 관리구분, 적절성 배지 */}
                                        <div className="flex items-center gap-1.5">
                                            <span className="font-extrabold text-sm text-[#1E2A33]">{member.memberName}</span>
                                            {member.maskedRegNo && (
                                                <span className="text-[10px] text-[#9AA7AF] font-mono">{member.maskedRegNo}</span>
                                            )}
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${catBadgeBg}`}>
                                                {member.managementCategory}
                                            </span>
                                            <span className={`ml-auto text-[10px] font-extrabold px-2 py-0.5 rounded-full ${suitBadgeBg}`}>
                                                {member.suitability}
                                            </span>
                                        </div>

                                        {/* 2행: 담당/부서, 개별/자원 건수, 최근 개입일 */}
                                        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] text-[#5C6B76]">
                                            <span>
                                                담당 <b>{member.counselor}</b> · {member.department}
                                            </span>
                                            <span className="text-[#9AA7AF]">|</span>
                                            <span>
                                                개별 {member.individualCount} · 자원 {member.resourceCount}
                                            </span>
                                            {member.latestSessionDate && (
                                                <span className="ml-auto text-[10px] text-[#0E5E7E] font-medium">
                                                    최근 {member.latestSessionDate.slice(5)}
                                                </span>
                                            )}
                                        </div>

                                        {/* 재수립 도래 표시 (해당 시) */}
                                        {member.isExpiring && (
                                            <div className="mt-1 text-[10px] font-bold text-[#B3402C] flex items-center gap-1">
                                                <Clock size={11} />
                                                {member.daysUntilReview < 0
                                                    ? `ISP 재수립 ${Math.abs(member.daysUntilReview)}일 경과`
                                                    : `ISP 재수립 D-${member.daysUntilReview}`}
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* [우측 패널]: 대상자 상세 (8칸) */}
                <div className="lg:col-span-8 bg-white border border-[#E4E1D9] rounded-2xl flex flex-col shadow-xs overflow-hidden">
                    {selectedMember ? (
                        <>
                            {/* 상세 헤더 (dhead) */}
                            <div className="p-4 border-b border-[#EFEEE8] bg-[#FAF9F5] flex flex-wrap items-center gap-2.5">
                                <span className="text-xl font-black tracking-tight text-[#1E2A33]">
                                    {selectedMember.memberName}
                                </span>

                                <span className="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-[#DCE9F5] text-[#17557E]">
                                    {selectedMember.managementCategory}
                                </span>

                                <span className={`text-xs font-extrabold px-2.5 py-0.5 rounded-full ${
                                    selectedMember.suitability === '적정'
                                        ? 'bg-[#DDF0E4] text-[#175C40]'
                                        : selectedMember.suitability === '부족'
                                            ? 'bg-[#F9E7D8] text-[#9A5410]'
                                            : 'bg-[#F9E0D9] text-[#9C3524]'
                                }`}>
                                    {selectedMember.suitability}
                                </span>

                                {selectedMember.hasHighSuicideRisk && (
                                    <span className="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
                                        자살 고위험 신호
                                    </span>
                                )}

                                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-[#5C6B76]">
                                    <span>담당 <b>{selectedMember.counselor}</b> {selectedMember.registrant && selectedMember.registrant !== selectedMember.counselor && `(등록자 ${selectedMember.registrant})`}</span>
                                    {selectedMember.counselorChanged && (
                                        <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                                            담당 변경 가능
                                        </span>
                                    )}
                                    <span>수립 <b>{selectedMember.establishedDate || '기록 없음'}</b></span>
                                    {selectedMember.reviewDueDate && (
                                        <span className={selectedMember.isExpiring ? 'text-[#B3402C] font-bold' : ''}>
                                            재수립 <b>{selectedMember.reviewDueDate} {selectedMember.daysUntilReview < 0 ? '경과' : `(D-${selectedMember.daysUntilReview})`}</b>
                                        </span>
                                    )}
                                    {selectedMember.diagnosis && (
                                        <span>진단 <b>{selectedMember.diagnosis}</b></span>
                                    )}
                                </div>
                            </div>

                            {/* 상세 본문 (2단 서브 그리드: 좌=ISP/욕구/코멘트, 우=타임라인/판정) */}
                            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#EFEEE8] p-4 gap-4">
                                {/* 좌측 컬럼: 욕구, ISP 결과, 장단기 목표, 수퍼비전 코멘트 */}
                                <div className="space-y-3.5 pr-0 md:pr-1">
                                    {/* 1) 미충족 욕구 (상태평가 1점 이상) */}
                                    <div className="bg-[#FAF1ED] rounded-xl p-3 border border-[#F3DFD8]">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-black tracking-wider text-[#9C4A38]">
                                                미충족 욕구 · 상태평가 1점 이상
                                            </span>
                                            {selectedMember.zeroNeeds.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setShowZeroNeeds(!showZeroNeeds)}
                                                    className="text-[10px] font-bold text-[#9C4A38] hover:underline cursor-pointer"
                                                >
                                                    {showZeroNeeds ? '0점 영역 접기' : `0점 영역 (${selectedMember.zeroNeeds.length}) 보기`}
                                                </button>
                                            )}
                                        </div>

                                        {selectedMember.needs.length === 0 ? (
                                            <div className="text-xs text-[#8A7A76] py-1">
                                                상태평가 기록이 없거나 1점 이상 항목이 없습니다.
                                            </div>
                                        ) : (
                                            <div className="flex flex-wrap gap-1.5">
                                                {selectedMember.needs.map((item, idx) => (
                                                    <span
                                                        key={idx}
                                                        className="bg-white border border-[#EBCFC6] text-[#9C4A38] text-[11px] font-bold px-2.5 py-1 rounded-full shadow-2xs"
                                                    >
                                                        {item.label} ({item.score})
                                                    </span>
                                                ))}
                                            </div>
                                        )}

                                        {/* 0점 영역 토글 노출 */}
                                        {showZeroNeeds && selectedMember.zeroNeeds.length > 0 && (
                                            <div className="mt-2.5 pt-2 border-t border-[#EBCFC6]/60 flex flex-wrap gap-1">
                                                {selectedMember.zeroNeeds.map((item, idx) => (
                                                    <span
                                                        key={idx}
                                                        className="bg-white/80 border border-slate-200 text-slate-500 text-[10px] font-medium px-2 py-0.5 rounded-full"
                                                    >
                                                        {item.label} (0)
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* 2) ISP 결과 · P열 원문 전체 표시 */}
                                    <div className="bg-[#F8F4E9] rounded-xl p-3 border border-[#EFE8D3]">
                                        <div className="text-xs font-black tracking-wider text-[#8A6D1F] mb-1.5">
                                            ISP 결과 · P열 원문
                                        </div>
                                        <div className="bg-white border border-[#EAE4D2] rounded-lg p-2.5 text-xs text-[#4A5860] leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap custom-scrollbar">
                                            {selectedMember.ispResultText || '기록된 ISP 결과 내용이 없습니다.'}
                                        </div>
                                    </div>

                                    {/* 3) 장단기 목표 · Q열 */}
                                    <div className="bg-[#EBF2F5] rounded-xl p-3 border border-[#D5E4EC]">
                                        <div className="text-xs font-black tracking-wider text-[#0E5E7E] mb-1.5">
                                            장단기 목표 · Q열
                                        </div>
                                        {selectedMember.isGoalSplit ? (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                <div className="bg-white border border-[#D8E5EB] rounded-lg p-2.5 text-xs text-[#33424E] leading-relaxed">
                                                    <div className="text-[10px] font-black text-[#0E5E7E] mb-1">장기목표</div>
                                                    <div className="whitespace-pre-wrap">{selectedMember.longTermGoal}</div>
                                                </div>
                                                <div className="bg-white border border-[#D8E5EB] rounded-lg p-2.5 text-xs text-[#33424E] leading-relaxed">
                                                    <div className="text-[10px] font-black text-[#0E5E7E] mb-1">단기목표</div>
                                                    <div className="whitespace-pre-wrap">{selectedMember.shortTermGoal}</div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="bg-white border border-[#D8E5EB] rounded-lg p-2.5 text-xs text-[#33424E] leading-relaxed whitespace-pre-wrap max-h-28 overflow-y-auto custom-scrollbar">
                                                {selectedMember.goalsRaw || '기록된 목표가 없습니다.'}
                                            </div>
                                        )}
                                    </div>

                                    {/* 4) 수퍼비전 코멘트 (설계서 §3.3 6, §4.5) */}
                                    <div className="bg-[#EDF4EE] rounded-xl p-3 border border-[#D5E6D8] space-y-2.5">
                                        <div className="text-xs font-black tracking-wider text-[#2F6B4F]">
                                            수퍼비전 코멘트
                                        </div>

                                        {/* 기존 코멘트 목록 (이력) */}
                                        <div className="space-y-2 max-h-36 overflow-y-auto custom-scrollbar">
                                            {currentMemberComments.length === 0 ? (
                                                <div className="text-[11px] text-[#7A8A7E] py-1 bg-white/70 p-2 rounded-lg border border-[#D5E4D9]">
                                                    등록된 수퍼비전 코멘트가 없습니다. 회의 중 논의 내용을 작성하세요.
                                                </div>
                                            ) : (
                                                currentMemberComments.map(c => {
                                                    const isAuthor = currentUser && (c.author === currentUser.name || c.author === currentUser.username);
                                                    const isEditing = editingCommentId === c.id;

                                                    return (
                                                        <div key={c.id} className="bg-white border border-[#D5E4D9] rounded-lg p-2.5 text-xs text-[#33424E] space-y-1">
                                                            <div className="flex items-center justify-between text-[10px] text-[#9AA7AF]">
                                                                <span className="font-extrabold text-[#2F6B4F]">{c.author}</span>
                                                                <span>{c.createdAt ? c.createdAt.slice(0, 16).replace('T', ' ') : ''}</span>
                                                            </div>

                                                            {isEditing ? (
                                                                <div className="space-y-1.5 pt-1">
                                                                    <textarea
                                                                        value={editingText}
                                                                        onChange={e => setEditingText(e.target.value)}
                                                                        className="w-full text-xs p-1.5 border border-[#BFD9C8] rounded focus:outline-none focus:border-[#0E5E7E]"
                                                                        rows={2}
                                                                    />
                                                                    <div className="flex justify-end gap-1">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleUpdateComment(c.id)}
                                                                            className="px-2 py-0.5 bg-[#0E5E7E] text-white text-[10px] font-bold rounded"
                                                                        >
                                                                            수정완료
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setEditingCommentId(null)}
                                                                            className="px-2 py-0.5 bg-slate-200 text-slate-700 text-[10px] font-bold rounded"
                                                                        >
                                                                            취소
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            ) : (
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <p className="whitespace-pre-wrap leading-relaxed flex-1">{c.text}</p>
                                                                    {(isAuthor || currentUser?.role === 'admin') && (
                                                                        <div className="flex items-center gap-1 shrink-0 opacity-70 hover:opacity-100">
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => {
                                                                                    setEditingCommentId(c.id);
                                                                                    setEditingText(c.text);
                                                                                }}
                                                                                className="text-slate-500 hover:text-[#0E5E7E]"
                                                                                title="수정"
                                                                            >
                                                                                <Edit3 size={11} />
                                                                            </button>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleDeleteComment(c.id)}
                                                                                className="text-slate-500 hover:text-rose-600"
                                                                                title="삭제"
                                                                            >
                                                                                <Trash2 size={11} />
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>

                                        {/* 새 코멘트 입력창 */}
                                        <div className="flex gap-2 items-end pt-1">
                                            <textarea
                                                value={commentInput}
                                                onChange={e => setCommentInput(e.target.value)}
                                                placeholder="회의 중 논의 내용을 바로 적어주세요…"
                                                rows={2}
                                                className="flex-1 bg-white border border-[#BFD9C8] rounded-lg p-2 text-xs focus:outline-none focus:border-[#0E5E7E] placeholder:text-[#9AA7AF]"
                                            />
                                            <button
                                                type="button"
                                                onClick={handleSaveComment}
                                                disabled={isSavingComment || !commentInput.trim()}
                                                className="bg-[#0E5E7E] hover:bg-[#0c4e69] disabled:bg-slate-300 text-white font-extrabold text-xs px-3.5 py-2.5 rounded-lg shrink-0 transition-colors cursor-pointer"
                                            >
                                                {isSavingComment ? '저장중…' : '코멘트 저장'}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* 우측 컬럼: 개입 내역 타임라인 + 적절성 판정 */}
                                <div className="space-y-3.5 pl-0 md:pl-1">
                                    {/* 5) 개입 내역 타임라인 (제목만 표시, 상세는 버튼 토글) */}
                                    <div className="bg-[#EEF3F7] rounded-xl p-3 border border-[#D7E3EC]">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-black tracking-wider text-[#33566B]">
                                                개입 내역 · 개별상담 + 자원조정
                                            </span>
                                            <span className="text-[11px] font-bold text-[#5C6B76]">
                                                총 {selectedMember.totalInterventionCount}건 (개별 {selectedMember.individualCount} · 자원 {selectedMember.resourceCount})
                                            </span>
                                        </div>

                                        <div className="space-y-1.5 max-h-[360px] overflow-y-auto custom-scrollbar">
                                            {selectedMember.filteredSessions.length === 0 ? (
                                                <div className="bg-white rounded-lg p-4 text-center text-xs text-[#9AA7AF] border border-[#D8E5EB]">
                                                    선택 기간 내 개입 내역이 없습니다 (개입 없음).
                                                </div>
                                            ) : (
                                                selectedMember.filteredSessions.map((session, idx) => {
                                                    const isDetailOpen = Boolean(expandedSessionIdx[idx]);
                                                    const isAbsent = session.absent;

                                                    return (
                                                        <div
                                                            key={idx}
                                                            className={`bg-white rounded-lg p-2 border transition-all ${
                                                                isAbsent
                                                                    ? 'opacity-65 border-dashed border-[#D5DEE4] bg-[#FAF9F7]'
                                                                    : 'border-[#D8E5EB] shadow-2xs'
                                                            }`}
                                                        >
                                                            {/* 타임라인 요약 행 */}
                                                            <div className="flex items-center gap-2 text-xs">
                                                                <span className="font-extrabold text-[#33424E] w-[75px] shrink-0 font-mono text-[11px]">
                                                                    {session.date}
                                                                </span>

                                                                <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded ${
                                                                    session.category === 'individual'
                                                                        ? 'bg-[#DCE9F5] text-[#17557E]'
                                                                        : 'bg-[#E4EFE6] text-[#2F6B4F]'
                                                                }`}>
                                                                    {session.category === 'individual' ? '개별' : '자원'}
                                                                </span>

                                                                <span className="text-[11px] text-[#5C6B76] shrink-0">
                                                                    {session.rawType || session.type}
                                                                </span>

                                                                {isAbsent && (
                                                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                                                                        부재
                                                                    </span>
                                                                )}

                                                                {session.emergency && (
                                                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
                                                                        응급
                                                                    </span>
                                                                )}

                                                                <span className="text-xs text-[#4A5860] truncate flex-1" title={session.topic}>
                                                                    {session.topic || '상담 진행'}
                                                                </span>

                                                                <button
                                                                    type="button"
                                                                    onClick={() => toggleSessionDetail(idx)}
                                                                    className={`shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                                                        isDetailOpen
                                                                            ? 'bg-[#0E5E7E] text-white border-[#0E5E7E]'
                                                                            : 'bg-white text-[#0E5E7E] border-[#BFD9E4] hover:bg-[#E7F0F4]'
                                                                    }`}
                                                                >
                                                                    {isDetailOpen ? '상세 닫기' : '상세 보기'}
                                                                </button>
                                                            </div>

                                                            {/* 펼침 상세 영역 */}
                                                            {isDetailOpen && (
                                                                <div className="mt-2 pt-2 border-t border-[#D8E5EB] text-[11px] text-[#4A5860] space-y-1 bg-[#FAFBFD] p-2 rounded">
                                                                    {session.content && (
                                                                        <div>
                                                                            <span className="font-extrabold text-[#33424E]">상담내용: </span>
                                                                            <span className="whitespace-pre-wrap">{session.content}</span>
                                                                        </div>
                                                                    )}
                                                                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[#5C6B76]">
                                                                        {session.problemArea && <span><b>문제영역:</b> {session.problemArea}</span>}
                                                                        {session.needItem && <span><b>욕구항목:</b> {session.needItem}</span>}
                                                                        <span><b>상담자:</b> {session.counselor}</span>
                                                                        {isAbsent && <span className="text-amber-700 font-bold">* 부재(노쇼) 건은 통계·적절성 판정에서 제외됩니다.</span>}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>

                                    {/* 6) 적절성 판정 박스 (설계서 §3.3 5, §6) */}
                                    <div className="bg-[#FAF2E4] rounded-xl p-3 border border-[#EDDCB8] space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-black tracking-wider text-[#96690F]">
                                                적절성 판정
                                            </span>
                                            {selectedMember.isExcessive && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                                                    과다 개입 (참고)
                                                </span>
                                            )}
                                        </div>

                                        <div className="bg-white border border-[#EDDCB8] rounded-lg p-3 text-xs text-[#6B5312] leading-relaxed">
                                            <p>{selectedMember.suitabilityEval.verdictText}</p>

                                            {/* 월별 달성 현황 미니 바 */}
                                            {selectedMember.suitabilityEval.monthlyAchievements.length > 0 && (
                                                <div className="mt-2.5 pt-2 border-t border-[#EDDCB8]/60">
                                                    <span className="block text-[10px] font-extrabold text-[#96690F] mb-1">
                                                        월별 개입 달성 현황 (목표 월 {selectedMember.suitabilityEval.targetMonthly}회):
                                                    </span>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {selectedMember.suitabilityEval.monthlyAchievements.map(m => (
                                                            <div
                                                                key={m.yearMonth}
                                                                className={`px-2 py-1 rounded text-[10px] font-bold border ${
                                                                    m.achieved
                                                                        ? 'bg-[#DDF0E4] text-[#175C40] border-[#B8DEC3]'
                                                                        : 'bg-[#F9E7D8] text-[#9A5410] border-[#F2CFB3]'
                                                                }`}
                                                            >
                                                                {m.yearMonth.slice(5)}월: {m.actual}회 {m.achieved ? '✓' : '✗'}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="py-24 text-center text-sm text-[#9AA7AF]">
                            좌측 목록에서 브리핑할 대상자를 선택해주세요.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BriefingTab;


import React, { useState, useMemo, useCallback } from 'react';
import { Referral, User, Team, Attachment } from '../../types';
import { Search, Plus, Filter, FileUp, Loader2, Trash2, UserCheck, Calendar } from 'lucide-react';
import PageContainer from '../layout/PageContainer';
import ReferralTable from './ReferralTable';
import ReferralFormModal from './ReferralFormModal';
import DocumentAttachmentModal from '../common/document-modal/DocumentAttachmentModal';
import { CRI_LEVELS, REFERRAL_EXCEL_HEADERS } from '../../constants';
import { getTeams, getTeamsConfig, getSubTeamParent } from '../../services/orgConfig';
import * as XLSX from 'xlsx';
import { apiClient } from '../../services/apiClient';

declare var _: any;
declare const google: any;

interface ReferralsPageProps {
    allReferrals: Referral[];
    setAllReferrals: React.Dispatch<React.SetStateAction<Referral[]>>;
    currentUser: User;
    selectedTeam: Team | 'all';
    setSelectedTeam: (team: Team | 'all') => void;
    sortedTeamTabs: Team[];
    onAddNewReferral: (newReferral: Omit<Referral, 'refNo' | 'clientId' | 'attachments'>) => void;
    onUpdateReferral: (updatedReferral: Referral, originalRefNo?: string) => void;
    onDeleteReferral: (refNo: string) => void;
    showToast: (message: string) => void;
    users: User[];
}

const ReferralsPage: React.FC<ReferralsPageProps> = ({
    allReferrals,
    setAllReferrals,
    currentUser,
    selectedTeam,
    setSelectedTeam,
    sortedTeamTabs,
    onAddNewReferral,
    onUpdateReferral,
    onDeleteReferral,
    showToast,
    users,
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [assigneeSearch, setAssigneeSearch] = useState('');
    const [criFilter, setCriFilter] = useState<'all' | 'a' | 'b' | 'c' | 'd' | 'e'>('all');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'ongoing' | 'closed'>('all');
    const [includeNambu, setIncludeNambu] = useState(true);
    const [showFilters, setShowFilters] = useState(false); // Mobile filter toggle

    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingReferral, setEditingReferral] = useState<Referral | null>(null);
    const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
    const [selectedReferralForAttachment, setSelectedReferralForAttachment] = useState<Referral | null>(null);
    const [isImporting, setIsImporting] = useState(false);

    const debouncedSetSearchTerm = useMemo(() => _.debounce((value: string) => setSearchTerm(value), 300), []);

    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const { value } = e.target;
        setSearchInput(value);
        debouncedSetSearchTerm(value);
    }, [debouncedSetSearchTerm]);

    const filteredReferrals = useMemo(() => {
        let teamFiltered;
        if (selectedTeam === 'all') {
            teamFiltered = allReferrals;
        } else if (getTeams().includes(selectedTeam)) {
            if (includeNambu) {
                teamFiltered = allReferrals.filter(r => r.team === selectedTeam || (r.team === getSubTeamParent() && r.subTeam === selectedTeam));
            } else {
                teamFiltered = allReferrals.filter(r => r.team === selectedTeam);
            }
        } else {
            teamFiltered = allReferrals.filter(r => r.team === selectedTeam);
        }

        let result = teamFiltered;
        if (searchTerm) {
            result = result.filter(r => r.name.toLowerCase().includes(searchTerm.toLowerCase()));
        }
        if (assigneeSearch) {
            result = result.filter(r => r.assignee && r.assignee.toLowerCase().includes(assigneeSearch.toLowerCase()));
        }
        if (criFilter !== 'all') {
            result = result.filter(r => r.criLevel === criFilter);
        }
        if (startDate) result = result.filter(r => r.requestDate >= startDate);
        if (endDate) result = result.filter(r => r.requestDate <= endDate);

        if (statusFilter === 'ongoing') result = result.filter(r => r.closureStatus === '미종결');
        if (statusFilter === 'closed') result = result.filter(r => r.closureStatus !== '미종결');

        return result.sort((a, b) => {
            // 1. 종결 건 또는 등록관리 건은 후순위(하단)로 이동
            const aCompleted = Boolean(
                (a.closureStatus && a.closureStatus !== '미종결') ||
                (a.actionResult && (a.actionResult.includes('등록관리') || a.actionResult.includes('종결')))
            );
            const bCompleted = Boolean(
                (b.closureStatus && b.closureStatus !== '미종결') ||
                (b.actionResult && (b.actionResult.includes('등록관리') || b.actionResult.includes('종결')))
            );

            // 미종결/진행중 건(false) 우선, 종결/등록관리 건(true)은 후순위
            if (aCompleted !== bCompleted) {
                return aCompleted ? 1 : -1;
            }

            // 동일 그룹 내에서는 최신 의뢰일자 순(내림차순)
            const dateA = a.requestDate ? new Date(a.requestDate).getTime() : 0;
            const dateB = b.requestDate ? new Date(b.requestDate).getTime() : 0;
            
            if (dateA !== dateB) return dateB - dateA;
            
            // 날짜가 같으면 refNo로 정렬 (내림차순)
            const refA = a.refNo || '';
            const refB = b.refNo || '';
            return refB.localeCompare(refA);
        });
    }, [allReferrals, selectedTeam, searchTerm, assigneeSearch, criFilter, startDate, endDate, statusFilter, includeNambu]);

    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const handleToggleSelect = useCallback((id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleToggleSelectAll = useCallback(() => {
        setSelectedIds(prev => {
            if (prev.size === filteredReferrals.length) return new Set();
            return new Set(filteredReferrals.map(r => r.refNo));
        });
    }, [filteredReferrals]);

    const handleDeleteSelected = useCallback(() => {
        if (selectedIds.size === 0) return;
        if (!confirm(`선택한 ${selectedIds.size}건의 데이터를 삭제하시겠습니까?`)) return;

        const idsToDelete = Array.from(selectedIds);
        if ((window as any).google && (window as any).google.script) {
            google.script.run
                .withSuccessHandler(async (res: any) => {
                    if (res.success) {
                        showToast(`${idsToDelete.length}건이 삭제되었습니다.`);
                        setAllReferrals(prev => prev.filter(r => !selectedIds.has(r.refNo)));
                        setSelectedIds(new Set());
                        await apiClient.logActivity(currentUser.name, '의뢰 일괄 삭제', `${idsToDelete.length}건 삭제 (${idsToDelete.join(', ')})`);
                    } else {
                        alert("삭제 실패: " + res.error);
                    }
                })
                .withFailureHandler((err: any) => alert("삭제 중 오류가 발생했습니다: " + err))
                .deleteReferralsBulk(idsToDelete);
        } else {
            setAllReferrals(prev => prev.filter(r => !selectedIds.has(r.refNo)));
            setSelectedIds(new Set());
            showToast("로컬 삭제 완료");
        }
    }, [selectedIds, setAllReferrals, showToast, currentUser.name]);

    const handleOpenAddModal = useCallback(() => setIsAddModalOpen(true), []);
    const handleCloseAddModal = useCallback(() => setIsAddModalOpen(false), []);

    const handleOpenEditModal = useCallback((referral: Referral) => {
        setEditingReferral(referral);
        setIsEditModalOpen(true);
    }, []);

    const handleCloseEditModal = useCallback(() => {
        setEditingReferral(null);
        setIsEditModalOpen(false);
    }, []);

    const handleOpenAttachmentModal = useCallback((referral: Referral) => {
        setSelectedReferralForAttachment(referral);
        setIsAttachmentModalOpen(true);
    }, []);

    const handleUpdateAttachments = useCallback((refNo: string, updatedAttachments: Attachment[]) => {
        setAllReferrals(prev => prev.map(r => r.refNo === refNo ? { ...r, attachments: updatedAttachments } : r));
    }, [setAllReferrals]);

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!confirm('엑셀 데이터를 불러오겠습니까? 기존 데이터가 업데이트되거나 추가될 수 있습니다.')) {
            e.target.value = '';
            return;
        }
        setIsImporting(true);
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const bstr = evt.target?.result;
                const wb = XLSX.read(bstr, { type: 'binary' });
                const wsname = wb.SheetNames[0];
                const ws = wb.Sheets[wsname];
                const jsonData = XLSX.utils.sheet_to_json(ws);
                const headerMap: Record<string, string> = {};
                Object.entries(REFERRAL_EXCEL_HEADERS).forEach(([key, label]) => {
                    headerMap[label] = key;
                });
                const parsedData = jsonData.map((row: any) => {
                    const newObj: any = {};
                    Object.keys(row).forEach(header => {
                        const key = headerMap[header];
                        if (key) {
                            let value = row[header];
                            if (value === 'Y') value = true;
                            if (value === 'N') value = false;
                            newObj[key] = value;
                        }
                    });
                    delete newObj.attachments;
                    return newObj;
                });
                if ((window as any).google && (window as any).google.script) {
                    google.script.run
                        .withSuccessHandler(async (res: any) => {
                            setIsImporting(false);
                            if (res.success) {
                                alert(res.message);
                                await apiClient.logActivity(currentUser.name, '의뢰 엑셀 가져오기', res.message);
                                window.location.reload();
                            } else {
                                alert("Import Failed: " + res.error);
                            }
                        })
                        .withFailureHandler((err: any) => {
                            setIsImporting(false);
                            alert("Import Error: " + err);
                        })
                        .importReferrals(parsedData, currentUser.name);
                } else {
                    setIsImporting(false);
                    showToast("로컬 테스트: 콘솔 확인");
                }
            } catch (error) {
                setIsImporting(false);
                alert("파일 처리 중 오류가 발생했습니다.");
            }
            e.target.value = '';
        };
        reader.readAsBinaryString(file);
    };

    const handleUpdateField = useCallback((refNo: string, field: keyof Referral, value: any) => {
        const target = allReferrals.find(r => r.refNo === refNo);
        if (target) {
            const updated = { ...target, [field]: value };
            onUpdateReferral(updated);
        }
    }, [allReferrals, onUpdateReferral]);

    const headerContent = (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1 rounded-full shadow-sm">
                <span className="text-[10px] font-black text-slate-400">Total</span>
                <span className="text-xs font-black text-slate-900">{allReferrals.length}</span>
                <div className="w-[1px] h-3 bg-slate-200 mx-0.5"></div>
                <span className="text-[10px] font-black text-blue-600">Filt</span>
                <span className="text-xs font-black text-blue-900">{filteredReferrals.length}</span>
            </div>
            {currentUser.role === 'admin' && (
                <div className="relative group">
                    <input type="file" accept=".xlsx, .xls" onChange={handleImport} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" disabled={isImporting} title="가져오기" />
                    <button disabled={isImporting} className="p-1.5 bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-lg hover:bg-emerald-100 transition-all active:scale-95">
                        {isImporting ? <Loader2 className="animate-spin" size={16} /> : <FileUp size={16} />}
                    </button>
                </div>
            )}
        </div>
    );

    const titlePrefix = (
        <button
            onClick={handleOpenAddModal}
            className="px-4 py-2 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 transition-all active:scale-95 flex items-center justify-center gap-2 -ml-1 md:-ml-2"
            title="신규 의뢰 등록"
        >
            <Plus size={18} />
            <span className="text-xs font-black">신규 등록</span>
        </button>
    );

    return (
        <PageContainer
            title={(
                <div className="flex items-center gap-3">
                    {titlePrefix}
                    <span>의뢰 관리</span>
                </div>
            ) as any}
            subtitle="팀별 의뢰 현황 및 상세 정보 관리"
            headerContent={headerContent}
        >
            <div className="space-y-4">
                <div className="flex flex-col gap-2 md:gap-3">
                    {/* Team Tabs & Mobile Filter Toggle */}
                    <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2">
                        <div className="bg-slate-50/50 p-1 rounded-2xl md:p-1.5 md:rounded-2xl border border-slate-100 flex-1 overflow-x-auto no-scrollbar">
                            <div className="flex space-x-1 min-w-max px-1">
                                <button onClick={() => setSelectedTeam('all')} className={`px-3 py-2 md:px-4 md:py-2 rounded-xl text-[11px] md:text-xs font-black transition-all ${selectedTeam === 'all' ? 'bg-slate-900 text-white shadow-md' : 'text-slate-500 hover:bg-white'}`}>전체 팀</button>
                                {sortedTeamTabs.map(team => (
                                    <button key={team} onClick={() => setSelectedTeam(team)} className={`px-3 py-2 md:px-4 md:py-2 rounded-xl text-[11px] md:text-xs font-black transition-all ${selectedTeam === team ? 'bg-slate-900 text-white shadow-md' : 'text-slate-500 hover:bg-white'}`}>
                                        {getTeamsConfig()[team]?.title || team}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className={`lg:hidden flex items-center justify-center gap-2 px-4 py-3 rounded-2xl font-black text-xs transition-all border ${showFilters ? 'bg-indigo-600 text-white border-indigo-700 shadow-lg' : 'bg-white text-slate-600 border-slate-200'}`}
                        >
                            <Filter size={16} />
                            <span>{showFilters ? '필터 숨기기' : '필터 검색'}</span>
                        </button>
                    </div>

                    {/* Filter Grid (Collapsible on Mobile, always visible on Desktop) */}
                    <div className={`${showFilters ? 'grid' : 'hidden'} lg:grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 p-3 bg-white rounded-2xl border border-slate-100 shadow-md`}>
                        {/* Shrunken Search */}
                        <div className="flex flex-col gap-1 col-span-2 md:col-span-1">
                            <label className="text-[9px] font-black text-slate-400 uppercase ml-1">이름 검색</label>
                            <div className="relative group">
                                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-blue-500 transition-colors" />
                                <input
                                    type="text"
                                    className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[11px] font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-400 transition-all font-sans"
                                    placeholder="대상자..."
                                    value={searchInput}
                                    onChange={handleSearchChange}
                                />
                            </div>
                        </div>

                        {/* Assignee Search */}
                        <div className="flex flex-col gap-1 col-span-1">
                            <label className="text-[9px] font-black text-slate-400 uppercase ml-1">담당자</label>
                            <div className="relative group">
                                <UserCheck size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-blue-500 transition-colors" />
                                <input
                                    type="text"
                                    className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[11px] font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-400 transition-all font-sans"
                                    placeholder="담당자..."
                                    value={assigneeSearch}
                                    onChange={(e) => setAssigneeSearch(e.target.value)}
                                />
                            </div>
                        </div>

                        {/* Compact Date Range */}
                        <div className="flex flex-col gap-1 col-span-2 md:col-span-1">
                            <label className="text-[9px] font-black text-slate-400 uppercase ml-1">의뢰 일자</label>
                            <div className="flex items-center gap-1 bg-slate-50 px-2 py-1.5 rounded-xl border border-slate-100">
                                <input type="date" className="bg-transparent border-none focus:ring-0 text-[10px] font-black text-slate-700 p-0 flex-1 min-w-0 font-sans" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                                <span className="text-slate-300">~</span>
                                <input type="date" className="bg-transparent border-none focus:ring-0 text-[10px] font-black text-slate-700 p-0 flex-1 min-w-0 font-sans" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                            </div>
                        </div>

                        {/* CRI Filter (Compact Pill list) */}
                        <div className="flex flex-col gap-1 col-span-2 md:col-span-1">
                            <label className="text-[9px] font-black text-slate-400 uppercase ml-1">CRI Level</label>
                            <div className="flex gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100 overflow-x-auto no-scrollbar">
                                {(['all', ...Object.keys(CRI_LEVELS)] as const).map(level => (
                                    <button
                                        key={level}
                                        onClick={() => setCriFilter(level as any)}
                                        className={`flex-1 min-w-[32px] px-2 py-1 rounded-lg text-[9px] font-black transition-all ${criFilter === level ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:bg-white'}`}
                                    >
                                        {level.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Additional Options (Status + Nambu) */}
                        <div className="flex items-center gap-2 col-span-2 md:col-span-1">
                            <div className="flex-1">
                                <label className="text-[9px] font-black text-slate-400 uppercase ml-1">상태</label>
                                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="w-full bg-slate-50 border border-slate-100 text-slate-700 text-[10px] font-black rounded-xl px-2 py-1.5 appearance-none outline-none font-sans">
                                    <option value="all">전체</option>
                                    <option value="ongoing">미종결</option>
                                    <option value="closed">종결</option>
                                </select>
                            </div>
                            {selectedTeam !== 'all' && getTeams().includes(selectedTeam) && (
                                <div className="mt-4 shrink-0">
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                        <input type="checkbox" checked={includeNambu} onChange={(e) => setIncludeNambu(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                                        <span className="text-[10px] font-black text-slate-600">남부</span>
                                    </label>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between px-2">
                    {selectedIds.size > 0 && (
                        <button onClick={handleDeleteSelected} className="bg-rose-500 hover:bg-rose-600 text-white px-3 py-1.5 rounded-xl font-black text-[10px] shadow-lg flex items-center gap-1.5 transition-all">
                            <Trash2 size={12} />
                            <span>{selectedIds.size}건 삭제</span>
                        </button>
                    )}
                </div>

                <ReferralTable
                    referrals={filteredReferrals}
                    selectedIds={selectedIds}
                    onToggleSelect={handleToggleSelect}
                    onToggleSelectAll={handleToggleSelectAll}
                    onEdit={handleOpenEditModal}
                    onOpenAttachments={handleOpenAttachmentModal}
                    onUpdateField={handleUpdateField}
                    currentUser={currentUser}
                    users={users}
                />
            </div>

            {isAddModalOpen && (
                <ReferralFormModal isEditing={false} isOpen={isAddModalOpen} onClose={handleCloseAddModal} onSubmit={onAddNewReferral} currentUser={currentUser} showToast={showToast} users={users} />
            )}
            {isEditModalOpen && editingReferral && (
                <ReferralFormModal isEditing={true} isOpen={isEditModalOpen} onClose={handleCloseEditModal} onSubmit={onUpdateReferral} onDelete={onDeleteReferral} referralData={editingReferral} currentUser={currentUser} showToast={showToast} users={users} />
            )}
            {isAttachmentModalOpen && selectedReferralForAttachment && (
                <DocumentAttachmentModal isOpen={isAttachmentModalOpen} onClose={() => setIsAttachmentModalOpen(false)} referralId={selectedReferralForAttachment.refNo} currentUser={currentUser} onUpdateAttachments={(updated) => handleUpdateAttachments(selectedReferralForAttachment.refNo, updated)} initialAttachments={selectedReferralForAttachment.attachments || []} />
            )}
        </PageContainer>
    );
};

export default ReferralsPage;
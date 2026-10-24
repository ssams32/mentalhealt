
import React, { useState, useMemo, useCallback } from 'react';
import { SuicideAttempterReferral, User, ReferralNote, Attachment } from '../../types';
import { apiClient } from '../../services/apiClient';
import PageContainer from '../layout/PageContainer';
import SuicideAttempterTable from './SuicideAttempterTable';
import SuicideAttempterFormModal from './SuicideAttempterFormModal';
import NotesModal from '../common/NotesModal';
import DocumentAttachmentModal from '../common/document-modal/DocumentAttachmentModal';
import { Plus, Search, Filter, Trash2, FileText, Paperclip, Calendar, UserCheck, Activity } from 'lucide-react';
import { INFO_TARGET_OPTIONS, PROCESSING_STATUS_OPTIONS } from '../../constants';
import { getRegions } from '../../services/orgConfig';

declare var _: any;
declare const google: any;

interface SuicideAttemptersPageProps {
    allReferrals: SuicideAttempterReferral[];
    setAllReferrals: React.Dispatch<React.SetStateAction<SuicideAttempterReferral[]>>;
    onAddNewSAReferral: (newReferral: Omit<SuicideAttempterReferral, 'uid' | 'notes' | 'attachments'> & { uid: string, notes: ReferralNote[], attachments: Attachment[] }) => void;
    onUpdateSAReferral: (updatedReferral: SuicideAttempterReferral) => void;
    onDeleteSAReferral: (uid: string) => void;
    showToast: (message: string) => void;
    currentUser: User;
    users: User[];
    onTransferToReferral?: (sa: SuicideAttempterReferral) => void;
}

const SuicideAttemptersPage: React.FC<SuicideAttemptersPageProps> = ({
    allReferrals,
    setAllReferrals,
    onAddNewSAReferral,
    onUpdateSAReferral,
    onDeleteSAReferral,
    showToast,
    currentUser,
    users,
    onTransferToReferral,
}) => {
    const [searchInput, setSearchInput] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    // Filters
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [agencyFilter, setAgencyFilter] = useState('all');
    const [targetFilter, setTargetFilter] = useState('all');
    const [regionFilter, setRegionFilter] = useState('all');
    const [assigneeFilter, setAssigneeFilter] = useState('all');
    const [processingStatusFilter, setProcessingStatusFilter] = useState('all');
    const [showFilters, setShowFilters] = useState(false); // Mobile filter toggle

    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editingReferral, setEditingReferral] = useState<SuicideAttempterReferral | null>(null);
    const [isNotesModalOpen, setIsNotesModalOpen] = useState(false);
    const [selectedReferralForNotes, setSelectedReferralForNotes] = useState<SuicideAttempterReferral | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
    const [selectedReferralForAttachment, setSelectedReferralForAttachment] = useState<SuicideAttempterReferral | null>(null);

    const debouncedSetSearchTerm = useMemo(() => _.debounce((value: string) => setSearchTerm(value), 300), []);

    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const { value } = e.target;
        setSearchInput(value);
        debouncedSetSearchTerm(value);
    }, [debouncedSetSearchTerm]);

    const agencyOptions = useMemo(() => {
        const agencies = allReferrals
            .map(r => r.requestAgency)
            .filter(Boolean)
            .map(a => a.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, '').trim());
        return Array.from(new Set(agencies)).sort();
    }, [allReferrals]);

    const assigneeOptions = useMemo(() => {
        const assignees = allReferrals.map(r => r.assignee).filter(Boolean);
        return Array.from(new Set(assignees)).sort();
    }, [allReferrals]);

    const filteredReferrals = useMemo(() => {
        return allReferrals.filter(item => {
            const matchesSearch =
                item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (item.sn && item.sn.toLowerCase().includes(searchTerm.toLowerCase()));
            let matchesAgency = agencyFilter === 'all';
            if (!matchesAgency) {
                const agency = item.requestAgency || '';
                if (agencyFilter === 'police') matchesAgency = agency.includes('경찰');
                else if (agencyFilter === 'fire') matchesAgency = agency.includes('소방');
                else if (agencyFilter === 'medical') matchesAgency = agency.includes('의료') || agency.includes('병원');
                else if (agencyFilter === 'etc') matchesAgency = !agency.includes('경찰') && !agency.includes('소방') && !agency.includes('의료') && !agency.includes('병원');
                else matchesAgency = agency.includes(agencyFilter);
            }
            const matchesTarget = targetFilter === 'all' || item.infoTarget === targetFilter;
            const matchesRegion = regionFilter === 'all' || item.region === regionFilter;
            const matchesAssignee = assigneeFilter === 'all' || item.assignee === assigneeFilter;
            const matchesStatus = processingStatusFilter === 'all' || item.processingStatus === processingStatusFilter;
            const matchesDate = (!startDate || item.receiptDate >= startDate) && (!endDate || item.receiptDate <= endDate);
            return matchesSearch && matchesAgency && matchesTarget && matchesRegion && matchesAssignee && matchesStatus && matchesDate;
        }).sort((a, b) => new Date(b.receiptDate).getTime() - new Date(a.receiptDate).getTime());
    }, [allReferrals, searchTerm, agencyFilter, targetFilter, regionFilter, assigneeFilter, processingStatusFilter, startDate, endDate]);

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
            return new Set(filteredReferrals.map(r => r.uid));
        });
    }, [filteredReferrals]);

    const handleDeleteSelected = useCallback(async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`선택한 ${selectedIds.size}건의 데이터를 삭제하시겠습니까?`)) return;

        const idsToDelete = Array.from(selectedIds);
        try {
            if (apiClient.isAvailable()) {
                await apiClient.deleteSuicideAttemptersBulk(idsToDelete as string[]);
                showToast(`${idsToDelete.length}건이 삭제되었습니다.`);
                setAllReferrals(prev => prev.filter(r => !selectedIds.has(r.uid)));
                setSelectedIds(new Set());
                await apiClient.logActivity(currentUser.name, '자살시도자 일괄 삭제', `${idsToDelete.length}건 삭제`);
            } else {
                // Background GAS fallback if needed, though apiClient handles mapping
                setAllReferrals(prev => prev.filter(r => !selectedIds.has(r.uid)));
                setSelectedIds(new Set());
                showToast("로컬 삭제 완료 (API 서버 연결 없음)");
            }
        } catch (err) {
            console.error("Bulk delete error:", err);
            alert("삭제 중 오류가 발생했습니다: " + err);
        }
    }, [selectedIds, setAllReferrals, showToast, currentUser.name]);

    const handleOpenAddModal = useCallback(() => setIsAddModalOpen(true), []);
    const handleCloseAddModal = useCallback(() => setIsAddModalOpen(false), []);

    const handleEdit = useCallback((item: SuicideAttempterReferral) => {
        setEditingReferral(item);
        setIsEditModalOpen(true);
    }, []);

    const handleOpenNotes = useCallback((item: SuicideAttempterReferral) => {
        setSelectedReferralForNotes(item);
        setIsNotesModalOpen(true);
    }, []);

    const handleOpenAttachments = useCallback((item: SuicideAttempterReferral) => {
        setSelectedReferralForAttachment(item);
        setIsAttachmentModalOpen(true);
    }, []);

    const handleUpdateNotes = useCallback((uid: string, updatedNotes: ReferralNote[]) => {
        setAllReferrals(prev => prev.map(r => r.uid === uid ? { ...r, notes: updatedNotes } : r));
    }, [setAllReferrals]);

    const handleUpdateAttachments = useCallback((uid: string, updatedAttachments: Attachment[]) => {
        setAllReferrals(prev => prev.map(r => r.uid === uid ? { ...r, attachments: updatedAttachments } : r));
    }, [setAllReferrals]);

    const handleUpdateField = useCallback((uid: string, field: keyof SuicideAttempterReferral, value: any) => {
        const target = allReferrals.find(r => r.uid === uid);
        if (target) {
            const updated = { ...target, [field]: value };
            onUpdateSAReferral(updated);
        }
    }, [allReferrals, onUpdateSAReferral]);

    const headerContent = (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-full shadow-sm">
                <span className="text-[10px] font-black text-indigo-600 uppercase tracking-tighter">Total</span>
                <span className="text-xs font-black text-indigo-900">{allReferrals.length}</span>
                <div className="w-[1px] h-3 bg-indigo-200 mx-0.5"></div>
                <span className="text-[10px] font-black text-emerald-600 uppercase tracking-tighter">Filt</span>
                <span className="text-xs font-black text-emerald-900">{filteredReferrals.length}</span>
            </div>
        </div>
    );

    const titlePrefix = (
        <button
            onClick={handleOpenAddModal}
            className="px-4 py-2 bg-black text-white rounded-xl shadow-lg hover:bg-slate-800 transition-all active:scale-95 flex items-center justify-center gap-2 -ml-1 md:-ml-2"
            title="신규 대상자 등록"
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
                    <span>자살시도자 관리</span>
                </div>
            )}
            subtitle="자살시도자 응급개입 대장"
            headerContent={headerContent}
        >
            <div className="space-y-2 md:space-y-3">
                <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className={`flex items-center gap-2 px-[var(--space-3)] py-[var(--space-2)] rounded-xl font-black text-[10px] md:text-[10px] transition-all border ${showFilters ? 'bg-indigo-600 text-white border-indigo-700 shadow-md' : 'bg-white text-indigo-500 border-indigo-100 hover:bg-indigo-50'}`}
                        >
                            <Filter size={14} />
                            <span>{showFilters ? '필터 검색 닫기' : '상세 필터 검색'}</span>
                        </button>
                    </div>
                    {currentUser.role === 'admin' && selectedIds.size > 0 && (
                        <button
                            onClick={handleDeleteSelected}
                            className="bg-rose-500 hover:bg-rose-600 text-white px-3 py-2 rounded-xl font-black text-[10px] shadow-lg shadow-rose-200 flex items-center gap-2 transition-all active:scale-95"
                        >
                            <Trash2 size={14} />
                            <span>{selectedIds.size}건 삭제</span>
                        </button>
                    )}
                </div>

                <div className={`${showFilters ? 'grid' : 'hidden'} lg:grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-[var(--space-3)] p-[var(--space-3)] bg-white rounded-2xl border border-slate-100 shadow-lg transition-all`}>
                    {/* Compact Search */}
                    <div className="flex flex-col gap-1 col-span-2 md:col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">대상자 검색</label>
                        <div className="relative group">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-indigo-500 transition-colors" />
                            <input
                                type="text"
                                className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[length:var(--font-base)] font-bold text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-4 focus:ring-indigo-50 focus:border-indigo-400 transition-all font-sans"
                                placeholder="이름..."
                                value={searchInput}
                                onChange={handleSearchChange}
                            />
                        </div>
                    </div>
                    {/* Compact Date Range */}
                    <div className="col-span-2 md:col-span-1 lg:col-span-1 flex flex-col gap-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">접수 기간</label>
                        <div className="flex items-center gap-1 bg-slate-50/80 px-2 py-1.5 rounded-xl border border-slate-100 shadow-inner">
                            <input type="date" className="bg-transparent border-none focus:ring-0 text-[length:var(--font-base)] font-black text-slate-700 p-0 flex-1 min-w-0 font-sans" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                            <span className="text-slate-300">~</span>
                            <input type="date" className="bg-transparent border-none focus:ring-0 text-[length:var(--font-base)] font-black text-slate-700 p-0 flex-1 min-w-0 font-sans" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                        </div>
                    </div>
                    {/* Optimized Agency & Target Filters */}
                    <div className="flex flex-col gap-1 col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">의뢰 기관</label>
                        <select
                            value={agencyFilter}
                            onChange={(e) => setAgencyFilter(e.target.value)}
                            className="w-full bg-slate-50/80 border border-slate-100 text-slate-700 text-[length:var(--font-base)] font-black rounded-xl px-3 py-2 appearance-none focus:ring-4 focus:ring-indigo-50/30 outline-none font-sans cursor-pointer hover:bg-white transition-all shadow-sm"
                        >
                            <option value="all">📁 전체 기관</option>
                            <option value="police">🚨 경찰</option>
                            <option value="fire">🚑 소방</option>
                            <option value="medical">🏥 의료기관</option>
                            <option value="etc">🏠 본인/기타</option>
                            {/* Dynamically detected agencies if any */}
                            {allReferrals.length > 0 && agencyOptions
                                .filter(opt => !['경찰', '소방', '의료', '의료기관', '본인', '기타'].some(k => opt.includes(k)))
                                .map(opt => <option key={opt} value={opt}>📍 {opt}</option>)}
                        </select>
                    </div>
                    {/* Compact Assignee */}
                    <div className="flex flex-col gap-1 col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">담당자</label>
                        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="w-full bg-slate-50/80 border border-slate-100 text-slate-700 text-[length:var(--font-base)] font-black rounded-xl px-3 py-2 appearance-none focus:ring-4 focus:ring-indigo-50/30 outline-none font-sans">
                            <option value="all">전체</option>
                            {assigneeOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                    </div>
                    {/* Compact Target */}
                    <div className="flex flex-col gap-1 col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">구분</label>
                        <select value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)} className="w-full bg-slate-50/80 border border-slate-100 text-slate-700 text-[length:var(--font-base)] font-black rounded-xl px-3 py-2 appearance-none focus:ring-4 focus:ring-indigo-50/30 outline-none font-sans">
                            <option value="all">전체</option>
                            {INFO_TARGET_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                    </div>
                    {/* Compact Region */}
                    <div className="flex flex-col gap-1 col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">지역</label>
                        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="w-full bg-slate-50/80 border border-slate-100 text-slate-700 text-[length:var(--font-base)] font-black rounded-xl px-3 py-2 appearance-none focus:ring-4 focus:ring-indigo-50/30 outline-none font-sans">
                            <option value="all">전체</option>
                            {getRegions().map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                    </div>
                    {/* Compact Processing Status */}
                    <div className="flex flex-col gap-1 col-span-1">
                        <label className="text-[length:var(--font-xs)] font-black text-slate-400 uppercase ml-1">조치 결과</label>
                        <select value={processingStatusFilter} onChange={(e) => setProcessingStatusFilter(e.target.value)} className="w-full bg-slate-50/80 border border-slate-100 text-slate-700 text-[length:var(--font-base)] font-black rounded-xl px-3 py-2 appearance-none focus:ring-4 focus:ring-indigo-50/30 outline-none font-sans">
                            <option value="all">전체 내역</option>
                            {PROCESSING_STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                    </div>
                </div>
            </div>

            <div className="overflow-y-auto max-h-[72vh] custom-scrollbar pr-[var(--space-3)] pb-[var(--space-5)]">
                <SuicideAttempterTable
                    data={filteredReferrals}
                    onEdit={handleEdit}
                    onOpenNotes={handleOpenNotes}
                    selectedIds={selectedIds}
                    onToggleSelect={handleToggleSelect}
                    onToggleSelectAll={handleToggleSelectAll}
                    onOpenAttachments={handleOpenAttachments}
                    onUpdateField={handleUpdateField}
                    currentUser={currentUser}
                    users={users}
                    onTransferToReferral={onTransferToReferral}
                />
            </div>

            <div className="mt-4 flex items-center justify-between px-[var(--space-5)] py-[var(--space-3)] bg-white/50 backdrop-blur-sm rounded-3xl border border-slate-100">
                <div className="text-[length:var(--font-base)] font-black text-slate-400">
                    Showing <span className="text-slate-900">All</span> of <span className="text-slate-900">{filteredReferrals.length}</span> records
                </div>
            </div>

            {isAddModalOpen && (
                <SuicideAttempterFormModal
                    isOpen={isAddModalOpen}
                    onClose={handleCloseAddModal}
                    onSubmit={onAddNewSAReferral}
                    currentUser={currentUser}
                    isEditing={false}
                    allReferrals={allReferrals}
                    showToast={showToast}
                    users={users}
                />
            )}

            {isEditModalOpen && editingReferral && (
                <SuicideAttempterFormModal
                    isOpen={isEditModalOpen}
                    onClose={() => { setEditingReferral(null); setIsEditModalOpen(false); }}
                    onSubmit={onUpdateSAReferral}
                    onDelete={onDeleteSAReferral}
                    referralData={editingReferral}
                    currentUser={currentUser}
                    isEditing={true}
                    allReferrals={allReferrals}
                    showToast={showToast}
                    users={users}
                />
            )}

            {isNotesModalOpen && selectedReferralForNotes && (
                <NotesModal
                    isOpen={isNotesModalOpen}
                    onClose={() => { setSelectedReferralForNotes(null); setIsNotesModalOpen(false); }}
                    onUpdateNotes={(updated) => handleUpdateNotes(selectedReferralForNotes.uid, updated)}
                    currentUser={currentUser}
                    patientName={selectedReferralForNotes.name}
                    referralId={selectedReferralForNotes.uid}
                    initialNotes={selectedReferralForNotes.notes || []}
                />
            )}

            {isAttachmentModalOpen && selectedReferralForAttachment && (
                <DocumentAttachmentModal
                    isOpen={isAttachmentModalOpen}
                    onClose={() => setIsAttachmentModalOpen(false)}
                    referralId={selectedReferralForAttachment.uid}
                    currentUser={currentUser}
                    onUpdateAttachments={(updated) => handleUpdateAttachments(selectedReferralForAttachment.uid, updated)}
                    initialAttachments={selectedReferralForAttachment.attachments || []}
                />
            )}
        </PageContainer>
    );
};

export default SuicideAttemptersPage;
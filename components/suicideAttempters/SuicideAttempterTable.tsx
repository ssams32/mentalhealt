import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import _ from 'lodash';
import { SuicideAttempterReferral, User, ReferralNote } from '../../types';
import {
    PROCESSING_STATUS_OPTIONS, REGISTRATION_STATUS_OPTIONS,
    INFO_TARGET_OPTIONS, DISPOSAL_REASON_OPTIONS, STAFF_LIST, INTERVENTION_STATUS_OPTIONS
} from '../../constants';
import {
    Phone, Building2, User as UserIcon, MapPin, Tag, FileText, Edit2, Trash2,
    MoreHorizontal, CheckCircle2, AlertCircle, Plus, Paperclip, Calendar,
    ClipboardList, Briefcase, Search, Loader2, ChevronDown, Settings, ArrowRightCircle
} from 'lucide-react';

interface SuicideAttempterTableProps {
    data: SuicideAttempterReferral[];
    onEdit: (referral: SuicideAttempterReferral) => void;
    onOpenNotes: (referral: SuicideAttempterReferral) => void;
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    onToggleSelectAll: () => void;
    onOpenAttachments: (referral: SuicideAttempterReferral) => void;
    onUpdateField?: (uid: string, field: keyof SuicideAttempterReferral, value: any) => void;
    currentUser?: User;
    users?: User[];
    onTransferToReferral?: (sa: SuicideAttempterReferral) => void;
}

const SuicideAttempterTable: React.FC<SuicideAttempterTableProps> = React.memo(({
    data,
    onEdit,
    onOpenNotes,
    selectedIds,
    onToggleSelect,
    onToggleSelectAll,
    onOpenAttachments,
    onUpdateField,
    currentUser,
    users = [],
    onTransferToReferral,
}) => {
    const [newNotes, setNewNotes] = useState<Record<string, string>>({});
    const [isSavingNote, setIsSavingNote] = useState<Record<string, boolean>>({});
    const [isTyping, setIsTyping] = useState<Record<string, boolean>>({});
    const typingTimers = useRef<Record<string, NodeJS.Timeout>>({});

    // Sync local newNotes with incoming props to ensure modal updates reflect immediately
    useEffect(() => {
        setNewNotes(prev => {
            const updated = { ...prev };
            let hasChange = false;
            data.forEach(item => {
                const latestNoteContent = item.notes && item.notes.length > 0 ? item.notes[item.notes.length - 1].content : '';
                // If local draft exists and matches what's now in the props (meaning it was just saved/synced), clear the draft
                if (updated[item.uid] === latestNoteContent) {
                    delete updated[item.uid];
                    hasChange = true;
                }
            });
            return hasChange ? updated : prev;
        });
    }, [data]);

    // Debounced Note Save Logic — 마지막 노트를 업데이트(덮어쓰기), 새 노트는 작성자가 다르거나 처음일 때만 추가
    const debouncedSave = useCallback(
        _.debounce(async (item: SuicideAttempterReferral, content: string) => {
            if (!content.trim()) return;

            setIsSavingNote(prev => ({ ...prev, [item.uid]: true }));

            const author = currentUser?.name || '상담원';
            const now = new Date().toLocaleString('ko-KR');
            const existingNotes = item.notes || [];
            const lastNote = existingNotes.length > 0 ? existingNotes[existingNotes.length - 1] : null;

            let updatedNotes: ReferralNote[];

            // 마지막 노트가 같은 작성자라면 덮어쓰기 (새 노트 추가 방지)
            if (lastNote && lastNote.author === author) {
                updatedNotes = [
                    ...existingNotes.slice(0, -1),
                    { ...lastNote, content: content.trim(), createdAt: now }
                ];
            } else {
                // 작성자가 다르거나 노트가 없을 때만 새 노트 추가
                const newNote: ReferralNote = {
                    id: `note_${Date.now()}`,
                    content: content.trim(),
                    createdAt: now,
                    author
                };
                updatedNotes = [...existingNotes, newNote];
            }

            if (onUpdateField) {
                onUpdateField(item.uid, 'notes', updatedNotes);
            }

            setTimeout(() => {
                setIsSavingNote(prev => ({ ...prev, [item.uid]: false }));
            }, 1000);
        }, 800),
        [onUpdateField, currentUser]
    );

    const duplicateData = useMemo(() => {
        const groups = new Map<string, SuicideAttempterReferral[]>();
        data.forEach(r => {
            const key = `${r.name}-${r.birthDate}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(r);
        });

        const dupSet = new Set<string>();
        const mergedNotesMap = new Map<string, (ReferralNote & { sourceUid: string, infoTarget?: string })[]>();

        groups.forEach((group, key) => {
            if (group.length > 1) {
                group.forEach(r => dupSet.add(r.uid));
            }

            const allNotes: (ReferralNote & { sourceUid: string, infoTarget?: string })[] = [];
            group.forEach(r => {
                if (r.notes) {
                    allNotes.push(...r.notes.map(n => ({ ...n, sourceUid: r.uid, infoTarget: r.infoTarget })));
                }
            });
            allNotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            mergedNotesMap.set(key, allNotes);
        });

        return { dupSet, mergedNotesMap };
    }, [data]);

    const { dupSet: duplicates, mergedNotesMap } = duplicateData;

    const handleFieldChange = (uid: string, field: keyof SuicideAttempterReferral, value: any) => {
        if (onUpdateField) onUpdateField(uid, field, value);
    };

    if (data.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 bg-slate-50/50 rounded-3xl border border-slate-100 border-dashed">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4"><i className="fas fa-inbox text-slate-300 text-2xl"></i></div>
                <p className="text-slate-500 font-bold text-lg">등록된 자살시도자가 없습니다.</p>
                <p className="text-slate-400 text-sm mt-1">새로운 사례를 등록해주세요.</p>
            </div>
        );
    }

    const getStatusColor = (field: string, value: string) => {
        if (field === 'processingStatus') {
            switch (value) {
                case '처리중': return 'bg-blue-100 text-blue-700 border-blue-200';
                case '개인정보파기': return 'bg-slate-100 text-slate-600 border-slate-200';
                case '거부': return 'bg-rose-100 text-rose-700 border-rose-200';
                case '서비스동의': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
                default: return 'bg-slate-50 text-slate-500 border-slate-100';
            }
        }
        if (field === 'registrationStatus') {
            switch (value) {
                case '등록': return 'bg-indigo-100 text-indigo-700 border-indigo-200';
                case '종결': return 'bg-teal-100 text-teal-700 border-teal-200';
                case '미등록': return 'bg-slate-100 text-slate-500 border-slate-200';
                default: return 'bg-slate-50 text-slate-500 border-slate-100';
            }
        }
        return 'bg-slate-50 text-slate-500 border-slate-100';
    };

    return (
        <div className="w-full pb-20 px-2 flex flex-col gap-3">
            {data.map((item) => {
                const isSelected = selectedIds.has(item.uid);
                const isDuplicate = duplicates.has(item.uid);

                return (
                    <div
                        key={item.uid}
                        className={`group relative bg-white rounded-[24px] border transition-all duration-300 hover:shadow-[0_15px_40px_rgba(0,0,0,0.06)] flex ${isSelected ? 'border-indigo-500 shadow-[0_10px_30px_rgba(79,70,229,0.08)] ring-1 ring-indigo-500/20' : 'border-slate-100 shadow-sm'}`}
                        onClick={() => onToggleSelect(item.uid)}
                    >
                        {/* 0. Minimal Status Sidebar */}
                        <div className={`absolute left-0 top-4 bottom-4 w-1.5 rounded-r-lg transition-all duration-300 ${item.processingStatus === '서비스동의' ? 'bg-emerald-500' :
                            item.processingStatus === '처리중' ? 'bg-blue-600' :
                                item.processingStatus === '거부' ? 'bg-rose-500' :
                                    item.processingStatus === '개인정보파기' ? 'bg-slate-400' :
                                        'bg-slate-200'
                            }`} />

                        <div className="flex w-full min-h-[120px] items-center relative overflow-hidden">
                            {/* 1. SLIM PROFILE (LEFT) - V14.0 Masterpiece Layout */}
                            <div className="w-[240px] px-5 flex flex-col justify-center gap-1 shrink-0">
                                <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1.5 h-5">
                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight shrink-0">SN:</span>
                                        <input
                                            type="text"
                                            value={item.sn || item.uid}
                                            onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'sn', e.target.value); }}
                                            className="w-20 h-5 bg-transparent border-none rounded text-[10px] font-bold text-slate-400 focus:ring-1 focus:ring-indigo-400 focus:bg-white transition-all uppercase px-1 -ml-1 cursor-text"
                                            onClick={(e) => e.stopPropagation()}
                                            title="연번 수정"
                                        />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <h3 className={`text-[16px] font-extrabold tracking-tight truncate ${isDuplicate ? 'text-rose-600 underline decoration-rose-200 underline-offset-4' : 'text-slate-800'}`}>{item.name}</h3>
                                        <span className="text-[12px] font-semibold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-lg whitespace-nowrap">
                                            [{item.gender || '미상'} / {item.age || '??'}세]
                                        </span>
                                        {isDuplicate && (
                                            <span title="중복 대상자 (!)">
                                                <AlertCircle size={15} className="text-rose-500 shrink-0 animate-pulse" />
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 text-[11px] text-slate-500 font-semibold whitespace-nowrap mt-1">
                                    <Phone size={10} className="text-indigo-400" />
                                    <span>{item.phoneNumber || '연락처 미상'}</span>
                                </div>
                                <div className="flex items-center gap-2 text-[11px] text-slate-400 font-medium">
                                    <Building2 size={10} className="text-slate-300" />
                                    <span className="truncate max-w-[160px]">{item.requestAgency || '기관미상'} | {item.pic || '요청자미상'}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-1">
                                    <div className="text-[10px] text-indigo-600 font-bold flex items-center gap-1 bg-indigo-50 px-1.5 py-0.5 rounded whitespace-nowrap shrink-0">
                                        <MapPin size={9} />
                                        <span className="whitespace-nowrap">{item.region || '지역미상'}</span>
                                    </div>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            // Clear local draft when opening details to prevent stale overrides
                                            setNewNotes(prev => {
                                                const updated = { ...prev };
                                                delete updated[item.uid];
                                                return updated;
                                            });
                                            onEdit(item);
                                        }}
                                        className="text-[9px] px-2 py-0.5 bg-slate-800 text-white rounded font-bold hover:bg-slate-700 transition-colors uppercase tracking-tight shrink-0"
                                    >
                                        상세보기
                                    </button>

                                </div>
                            </div>

                            {/* 2. 2x3 HYPER-CONTROL MATRIX (MIDDLE) - V15.0 Expanded */}
                            <div className="w-[420px] flex items-center px-4 border-l border-slate-50 shrink-0">
                                <div className="grid grid-cols-3 grid-rows-2 gap-1.5 w-full">
                                    {/* Row 1 */}
                                    <select
                                        value={item.processingStatus}
                                        onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'processingStatus', e.target.value); }}
                                        className={`w-full pl-2 pr-6 py-1.5 rounded-lg border text-[10px] font-bold cursor-pointer shadow-sm appearance-none ${getStatusColor('processingStatus', item.processingStatus)}`}
                                        title="서비스 동의 (처리구분)"
                                    >
                                        {PROCESSING_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>

                                    <select
                                        value={item.registrationStatus}
                                        onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'registrationStatus', e.target.value); }}
                                        className={`w-full pl-2 pr-6 py-1.5 rounded-lg border text-[10px] font-bold cursor-pointer shadow-sm appearance-none ${getStatusColor('registrationStatus', item.registrationStatus)}`}
                                        title="등록 상태"
                                    >
                                        {REGISTRATION_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>

                                    <select
                                        value={item.interventionStatus || ''}
                                        onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'interventionStatus', e.target.value); }}
                                        className="w-full pl-2 pr-6 py-1.5 rounded-lg border border-slate-200 bg-white text-[10px] font-bold text-slate-700 cursor-pointer shadow-sm appearance-none"
                                        title="개입 현황 (진행상태)"
                                    >
                                        <option value="">개입현황 미정</option>
                                        {INTERVENTION_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>

                                    {/* Row 2 */}
                                    <div className="relative">
                                        <select
                                            value={item.assignee || ''}
                                            onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'assignee', e.target.value); }}
                                            className="w-full pl-2 pr-6 py-1.5 rounded-lg border border-indigo-100 bg-indigo-50 text-[10px] font-bold text-indigo-700 cursor-pointer shadow-sm appearance-none"
                                            title="센터 담당자"
                                        >
                                            <option value="">담당자 미정</option>
                                            {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                                        </select>
                                        <ChevronDown size={8} className="absolute right-2 top-1/2 -translate-y-1/2 text-indigo-400 pointer-events-none" />
                                    </div>

                                    <div className="relative">
                                        <select
                                            value={item.infoTarget || ''}
                                            onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'infoTarget', e.target.value); }}
                                            className="w-full pl-2 pr-6 py-1.5 rounded-lg border border-slate-100 bg-slate-50 text-[10px] font-bold text-slate-600 cursor-pointer shadow-sm appearance-none"
                                            title="대상 구분 (정보제공대상)"
                                        >
                                            <option value="">구분 미정</option>
                                            {INFO_TARGET_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                        </select>
                                        <ChevronDown size={8} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                                    </div>

                                    <select
                                        value={item.disposalReason || ''}
                                        onChange={(e) => { e.stopPropagation(); handleFieldChange(item.uid, 'disposalReason', e.target.value); }}
                                        disabled={item.processingStatus !== '거부' && item.processingStatus !== '개인정보파기'}
                                        className={`w-full pl-2 pr-6 py-1.5 rounded-lg border text-[10px] font-bold cursor-pointer shadow-sm appearance-none transition-all ${(item.processingStatus === '거부' || item.processingStatus === '개인정보파기')
                                            ? 'bg-rose-50 border-rose-200 text-rose-700'
                                            : 'bg-slate-50 border-slate-100 text-slate-300 opacity-50 cursor-not-allowed'
                                            }`}
                                        title="미동의/미연계 사유"
                                    >
                                        <option value="">미연계 사유</option>
                                        {DISPOSAL_REASON_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                </div>
                            </div>

                            {/* 3. REALTIME NOTE EDITOR */}
                            <div className="flex-grow px-3 flex flex-col justify-center relative h-full border-l border-slate-100 group/editor min-w-[160px] max-w-[560px]">
                                <div className="relative w-full">
                                    <textarea
                                        value={newNotes[item.uid] ?? (item.notes && item.notes.length > 0 ? item.notes[item.notes.length - 1].content : '')}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            setNewNotes(prev => ({ ...prev, [item.uid]: val }));
                                            setIsTyping(prev => ({ ...prev, [item.uid]: true }));
                                            if (typingTimers.current[item.uid]) clearTimeout(typingTimers.current[item.uid]);
                                            typingTimers.current[item.uid] = setTimeout(() => setIsTyping(prev => ({ ...prev, [item.uid]: false })), 1500);
                                            debouncedSave(item, val);
                                        }}
                                        className="w-full h-[80px] bg-slate-50 group-hover/editor:bg-white rounded-xl px-3 py-2 border border-slate-200 focus:border-indigo-400 focus:bg-white outline-none resize-none text-[12.5px] font-medium text-slate-700 placeholder:text-slate-400 transition-all focus:shadow-md leading-[1.5] tracking-tight custom-scrollbar shadow-inner"
                                        placeholder="상담 메모 입력..."
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                    <div className="absolute right-2 -bottom-1 flex items-center gap-1.5 pointer-events-none transition-opacity duration-300">
                                        <div className="flex items-center gap-1 bg-white/90 backdrop-blur-sm px-1.5 py-0.5 rounded-full border border-slate-100 shadow-sm">
                                            {(isTyping[item.uid] || isSavingNote[item.uid]) ? (
                                                <>
                                                    <div className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
                                                    <span className="text-[8.5px] font-bold text-amber-600 tracking-tight whitespace-nowrap italic">저장 중...</span>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="w-1 h-1 rounded-full bg-emerald-500" />
                                                    <span className="text-[8.5px] font-bold text-emerald-600 tracking-tight whitespace-nowrap">동기화 완료</span>
                                                </>
                                            )}
                                        </div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                                            className="opacity-0 group-hover/editor:opacity-100 w-5 h-5 rounded bg-slate-900 text-white flex items-center justify-center hover:bg-slate-800 transition-all pointer-events-auto"
                                            title="상세설정"
                                        >
                                            <Settings size={11} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Removed Old Centered Ghost History Snippet (V14.0 Moving to Left Panel) */}
                        </div>

                        {/* 4. TRANSFER BUTTON (FAR RIGHT) */}
                        {onTransferToReferral && (
                            <div className="shrink-0 w-[72px] flex flex-col items-center justify-center border-l border-slate-100 h-full">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (window.confirm(`'${item.name}'을(를) 의뢰대장으로 이동하여 신규 의뢰를 작성하시겠습니까?`)) {
                                            onTransferToReferral(item);
                                        }
                                    }}
                                    className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700 transition-all group/transfer"
                                    title="의뢰대장으로 의뢰 작성"
                                >
                                    <ArrowRightCircle size={22} strokeWidth={2} className="group-hover/transfer:scale-110 transition-transform" />
                                    <span className="text-[10px] font-black leading-tight text-center">의뢰대장으로<br />작성하기</span>
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
});

export default SuicideAttempterTable;
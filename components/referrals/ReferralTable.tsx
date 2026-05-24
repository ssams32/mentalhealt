
import React, { useState } from 'react';
import { Referral, User } from '../../types';
import { CRI_LEVELS, ACTION_RESULT_OPTIONS, TEAMS_CONFIG } from '../../constants';
import {
    Phone, Calendar, User as UserIcon, MapPin, Tag, ClipboardList,
    FileText, Edit2, Trash2, CheckCircle2, AlertCircle, Building2,
    Briefcase, Paperclip, Loader2
} from 'lucide-react';

interface ReferralTableProps {
    referrals: Referral[];
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    onToggleSelectAll: () => void;
    onEdit: (referral: Referral) => void;
    onOpenAttachments: (referral: Referral) => void;
    onUpdateField?: (refNo: string, field: keyof Referral, value: any) => void;
    currentUser?: User;
    users?: User[];
}

const getCriColor = (level: string) => {
    switch (level) {
        case 'a': return 'bg-rose-600 border-rose-700 shadow-rose-200';
        case 'b': return 'bg-orange-500 border-orange-600 shadow-orange-200';
        case 'c': return 'bg-amber-400 border-amber-500 shadow-amber-200';
        case 'd':
        case 'e':
        default: return 'bg-yellow-300 border-yellow-400 shadow-yellow-100';
    }
};

const ReferralTable: React.FC<ReferralTableProps> = React.memo(({
    referrals,
    selectedIds,
    onToggleSelect,
    onToggleSelectAll,
    onEdit,
    onOpenAttachments,
    onUpdateField,
    currentUser,
    users = []
}) => {
    const [newNotes, setNewNotes] = useState<Record<string, string>>({});
    const [isSavingNote, setIsSavingNote] = useState<Record<string, boolean>>({});

    const handleFieldChange = (uid: string, field: keyof Referral, value: any) => {
        if (onUpdateField) onUpdateField(uid, field, value);
    };

    const onAddNote = async (refNo: string) => {
        const content = newNotes[refNo];
        if (!content?.trim() || !onUpdateField) return;

        setIsSavingNote(prev => ({ ...prev, [refNo]: true }));
        try {
            const item = referrals.find(r => r.refNo === refNo);
            if (!item) return;

            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const newNote = {
                id: Date.now().toString(),
                content: content.trim(),
                createdAt: dateStr,
                author: currentUser?.name || '담당자'
            };

            const updatedNotes = [...(item.notes || []), newNote];
            await onUpdateField(refNo, 'notes', updatedNotes);
            await onUpdateField(refNo, 'latestNote', content.trim());
            setNewNotes(prev => ({ ...prev, [refNo]: '' }));
        } finally {
            setIsSavingNote(prev => ({ ...prev, [refNo]: false }));
        }
    };

    if (referrals.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 bg-slate-50/50 rounded-3xl border border-slate-100 border-dashed">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4"><i className="fas fa-inbox text-slate-300 text-2xl"></i></div>
                <p className="text-slate-500 font-bold text-lg">의뢰 데이터가 없습니다.</p>
                <p className="text-slate-400 text-sm mt-1">새로운 의뢰를 등록해주세요.</p>
            </div>
        );
    }

    return (
        <div className="w-full overflow-x-auto pb-12 custom-scrollbar px-1">
            <table className="w-full border-separate border-spacing-y-0">
                <thead className="sticky top-0 z-20">
                    <tr className="bg-slate-50/60 backdrop-blur-2xl">
                        <th className="px-6 py-5 text-left first:rounded-l-3xl">
                            <input
                                type="checkbox"
                                checked={referrals.length > 0 && selectedIds.size === referrals.length}
                                onChange={onToggleSelectAll}
                                className="w-5 h-5 rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 transition-all cursor-pointer shadow-sm"
                            />
                        </th>
                        <th colSpan={10} className="px-4 py-1.5 text-left border-b border-slate-50"></th>
                    </tr>
                </thead>
                <tbody>
                    {referrals.map((item) => {
                        const isSelected = selectedIds.has(item.refNo);
                        const isClosed = item.closureStatus === '종결';

                        return (
                            <tr key={item.refNo} className="transition-all duration-300">
                                <td colSpan={10} className="px-1 py-1 md:py-3">
                                    <div className={`group relative rounded-[2rem] md:rounded-[2.5rem] overflow-hidden border transition-all duration-500 ${isSelected ? 'border-indigo-400 ring-4 ring-indigo-50 shadow-2xl lg:scale-[1.01]' : 'border-slate-100 shadow-lg hover:shadow-2xl md:hover:translate-y-[-4px] bg-white'}`}>
                                        <div className="flex flex-col lg:flex-row lg:h-[480px]">
                                            {/* SECTOR 1: PROFILE & CRI */}
                                            <div className={`flex-none w-full lg:w-[180px] p-5 flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r border-slate-50 relative ${isSelected ? 'bg-indigo-50/30' : 'bg-slate-50/30'}`}>
                                                <div className="absolute top-4 left-4 lg:top-6 lg:left-6">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => onToggleSelect(item.refNo)}
                                                        className="w-5 h-5 md:w-6 md:h-6 rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 transition-all cursor-pointer shadow-inner"
                                                    />
                                                </div>

                                                <div className={`w-12 h-12 md:w-16 md:h-16 rounded-2xl ${getCriColor(item.criLevel)} flex items-center justify-center text-white text-xl md:text-3xl font-black mb-3 shadow-lg transform group-hover:rotate-6 transition-all duration-500 border-2 border-white`}>
                                                    {item.criLevel.toUpperCase()}
                                                </div>

                                                <div className="flex items-center gap-2 mb-1">
                                                    <h3 className="text-lg md:text-xl font-black text-slate-900 tracking-tighter">{item.name}</h3>
                                                    {item.actionResult?.includes('등록관리') && (
                                                        <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 border border-emerald-200/50 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm shrink-0">
                                                            <CheckCircle2 size={10} strokeWidth={3} /> 등록관리
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 text-slate-400 font-bold text-[10px] md:text-[11px] mb-4">
                                                    <span>{item.gender}</span>
                                                    <span className="w-1 h-1 md:w-1.5 md:h-1.5 bg-slate-200 rounded-full"></span>
                                                    <span>{item.age}세</span>
                                                </div>

                                                <div className="w-full grid grid-cols-2 lg:grid-cols-1 gap-2 mt-auto">
                                                    <div className="flex justify-between items-center px-3 py-2 bg-white/80 rounded-xl border border-slate-100 shadow-sm">
                                                        <span className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-tighter">의뢰 번호</span>
                                                        <span className="text-[9px] md:text-xs font-mono font-bold text-slate-600">{item.refNo}</span>
                                                    </div>
                                                    <div className="flex justify-between items-center px-3 py-2 bg-white/80 rounded-xl border border-slate-100 shadow-sm">
                                                        <span className="text-[8px] md:text-[9px] font-black text-slate-400 uppercase tracking-tighter">진단/병명</span>
                                                        <span className="text-[9px] md:text-[10px] font-bold text-slate-900 truncate max-w-[50px]">{item.diagnosisName || '미지정'}</span>
                                                    </div>
                                                </div>

                                                <button
                                                    onClick={() => onEdit(item)}
                                                    className="w-full mt-3 py-2.5 bg-slate-900 hover:bg-black text-white rounded-xl text-[10px] md:text-[11px] font-black transition-all flex items-center justify-center gap-1.5 shadow-md"
                                                >
                                                    의뢰 상세 정보
                                                </button>
                                            </div>

                                            {/* SECTOR 2 & 3: DETAILS (Contact, Team, Path) */}
                                            <div className="flex-grow p-4 md:p-6 flex flex-col gap-4 border-b lg:border-b-0 lg:border-r border-slate-50 bg-white min-w-0">
                                                {/* Top Grid: 2x2 Info Cards */}
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                    {/* 연락처 / 거주지 */}
                                                    <div className="bg-indigo-50/30 rounded-2xl p-4 border border-indigo-100/30 flex flex-col justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <span className="p-1.5 bg-indigo-500 rounded-lg text-white"><Phone size={14} /></span>
                                                                <span className="text-[10px] font-black text-indigo-900">연락처 및 거주지</span>
                                                            </div>
                                                            <p className="text-sm md:text-lg font-black text-slate-800 tracking-tight">{item.phone || '전화번호 미기재'}</p>
                                                        </div>
                                                        <div className="flex items-center gap-1.5 mt-2 text-indigo-600">
                                                            <MapPin size={12} />
                                                            <p className="text-[11px] font-bold">{item.region || '지역 미기재'}</p>
                                                        </div>
                                                    </div>

                                                    {/* 관리 팀 */}
                                                    <div className="bg-blue-50/30 rounded-2xl p-4 border border-blue-100/30 flex flex-col justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <span className="p-1.5 bg-blue-500 rounded-lg text-white"><Briefcase size={14} /></span>
                                                                <span className="text-[10px] font-black text-blue-900">관리 부서 및 팀</span>
                                                            </div>
                                                            <p className="text-sm md:text-lg font-black text-slate-800 tracking-tight">{TEAMS_CONFIG[item.team]?.title || item.team}</p>
                                                        </div>
                                                        <p className="text-[11px] font-bold text-blue-600 mt-2">{item.subTeam || '일반 사례'}</p>
                                                    </div>

                                                    {/* 의뢰 기관 */}
                                                    <div className="bg-emerald-50/30 rounded-2xl p-4 border border-emerald-100/30 flex flex-col justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <span className="p-1.5 bg-emerald-500 rounded-lg text-white"><Building2 size={14} /></span>
                                                                <span className="text-[10px] font-black text-emerald-900">의뢰 기관</span>
                                                            </div>
                                                            <p className="text-sm md:text-lg font-black text-slate-800 truncate">{item.requestAgency || '기관 미지재'}</p>
                                                        </div>
                                                        <p className="text-[11px] font-bold text-emerald-600 mt-2">📅 {item.requestDate}</p>
                                                    </div>

                                                    {/* 의뢰 경로 */}
                                                    <div className="bg-slate-50/50 rounded-2xl p-4 border border-slate-100 flex flex-col justify-between">
                                                        <div>
                                                            <div className="flex items-center gap-2 mb-2">
                                                                <span className="p-1.5 bg-slate-500 rounded-lg text-white"><ClipboardList size={14} /></span>
                                                                <span className="text-[10px] font-black text-slate-900">의뢰 경로 및 정보</span>
                                                            </div>
                                                            <p className="text-sm md:text-lg font-black text-slate-800 truncate">{item.referralPath || '본인'}</p>
                                                        </div>
                                                        <p className="text-[11px] font-bold text-slate-400 mt-2">입수 경로 정보</p>
                                                    </div>
                                                </div>

                                                {/* 상담/개입 내용 입력 (Inline Editing) */}
                                                <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm relative group/input">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <span className="p-1.5 bg-indigo-500 rounded-lg text-white"><FileText size={14} /></span>
                                                        <span className="text-[10px] font-black text-indigo-900">상담 및 개입 내용</span>
                                                    </div>
                                                    <div className="relative">
                                                        <textarea
                                                            defaultValue={item.interventionContent || ''}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                // Debounce logic
                                                                const timeoutKey = `timeout_content_${item.refNo}`;
                                                                if ((window as any)[timeoutKey]) clearTimeout((window as any)[timeoutKey]);

                                                                (window as any)[timeoutKey] = setTimeout(() => {
                                                                    handleFieldChange(item.refNo, 'interventionContent', val);
                                                                }, 1000);
                                                            }}
                                                            placeholder="상담 및 개입 내용을 입력하세요 (자동저장)..."
                                                            className="w-full min-h-[80px] text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-3 focus:ring-4 focus:ring-indigo-50 focus:border-indigo-400 outline-none transition-all resize-y"
                                                        />
                                                        <div className="absolute bottom-2 right-2 opacity-0 group-hover/input:opacity-100 transition-opacity pointer-events-none">
                                                            <span className="text-[9px] text-slate-400 font-bold">입력 시 자동 저장 (1초)</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Bottom Bar: Assignee & Actions */}
                                                <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200/50 flex items-center justify-between">
                                                    <div className="flex items-center gap-4 flex-1">
                                                        <div className="flex items-center gap-2 shrink-0">
                                                            <div className="w-10 h-10 rounded-full bg-white border border-slate-100 flex items-center justify-center text-slate-300">
                                                                <UserIcon size={18} />
                                                            </div>
                                                            <div>
                                                                <p className="text-[9px] font-black text-slate-400 uppercase leading-none mb-1">Current Assignee</p>
                                                                <select
                                                                    value={item.assignee || ''}
                                                                    onChange={(e) => handleFieldChange(item.refNo, 'assignee', e.target.value)}
                                                                    className="text-base font-black text-slate-900 bg-transparent border-none p-0 focus:ring-0 cursor-pointer font-sans h-6 leading-none"
                                                                >
                                                                    <option value="">담당자 미배정</option>
                                                                    {users.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                                                                </select>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-2 shrink-0">
                                                        <button onClick={(e) => { e.stopPropagation(); onEdit(item); }} className="w-10 h-10 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-900 hover:text-white transition-all shadow-sm">
                                                            <Edit2 size={16} />
                                                        </button>
                                                        <button onClick={(e) => { e.stopPropagation(); onOpenAttachments(item); }} className="w-10 h-10 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-slate-400 hover:bg-blue-600 hover:text-white transition-all shadow-sm">
                                                            <Paperclip size={16} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* SECTOR 4: STATUS & QUICK INFO */}
                                            <div className="flex-none w-full lg:w-[220px] p-4 md:p-6 flex flex-row lg:flex-col gap-3 bg-slate-50/10 border-b lg:border-b-0 lg:border-r border-slate-50">
                                                {/* 진행 상태 */}
                                                <div className={`flex-1 rounded-2xl p-4 border shadow-sm flex flex-col justify-center transition-all ${isClosed ? 'bg-emerald-600 border-emerald-700 text-white' : 'bg-white border-indigo-100'}`}>
                                                    <p className={`text-[8px] md:text-[9px] font-black mb-1 uppercase tracking-widest ${isClosed ? 'text-emerald-100' : 'text-slate-400'}`}>진행 상태</p>
                                                    <select
                                                        value={item.closureStatus}
                                                        onChange={(e) => handleFieldChange(item.refNo, 'closureStatus', e.target.value)}
                                                        className={`text-sm md:text-base font-black bg-transparent border-none p-0 focus:ring-0 cursor-pointer leading-tight font-sans ${isClosed ? 'text-white' : 'text-indigo-600'}`}
                                                    >
                                                        <option value="미종결">진행중</option>
                                                        <option value="종결">완료</option>
                                                    </select>
                                                </div>

                                                {/* 조치 결과 */}
                                                <div className="flex-1 bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col justify-center">
                                                    <p className="text-[8px] md:text-[9px] font-black text-slate-400 mb-1 uppercase tracking-widest">결과</p>
                                                    <select
                                                        value={item.actionResult || ''}
                                                        onChange={(e) => handleFieldChange(item.refNo, 'actionResult', e.target.value)}
                                                        className="text-[10px] md:text-[11px] font-black text-slate-900 bg-transparent border-none p-0 focus:ring-0 cursor-pointer font-sans"
                                                    >
                                                        <option value="">- 조치 선택 -</option>
                                                        {ACTION_RESULT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                                    </select>
                                                </div>

                                                {/* Meta Info */}
                                                <div className="hidden lg:flex flex-col gap-2 mt-auto">
                                                    <div className="flex items-center justify-between px-3 py-2 bg-slate-100/50 rounded-xl border border-dashed border-slate-200">
                                                        <span className="text-[9px] font-black text-slate-400 uppercase leading-none">🚔 현장</span>
                                                        <span className={`text-[10px] font-black ${item.policeIntervention ? 'text-rose-500' : 'text-slate-300'}`}>{item.policeIntervention ? 'Y' : 'N'}</span>
                                                    </div>
                                                    <div className="flex items-center justify-between px-3 py-2 bg-slate-100/50 rounded-xl border border-dashed border-slate-200">
                                                        <span className="text-[9px] font-black text-slate-400 uppercase leading-none">📂 공문</span>
                                                        <span className={`text-[10px] font-black ${item.writtenRequest ? 'text-blue-500' : 'text-slate-300'}`}>{item.writtenRequest ? 'Y' : 'N'}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* SECTOR 5: CASE LOGS (FULL HEIGHT) */}
                                            <div className="flex-none w-full lg:w-[350px] p-4 md:p-6 bg-slate-50/5 flex flex-col">
                                                <div className="flex items-center justify-between mb-3 md:mb-4">
                                                    <div className="flex items-center gap-2">
                                                        <span className="p-2 bg-indigo-600 rounded-xl text-white shadow-md"><ClipboardList size={15} /></span>
                                                        <span className="text-sm font-black text-indigo-900 tracking-tight">상담/개입내역</span>
                                                    </div>
                                                    <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-[9px] font-black border border-indigo-200">
                                                        {item.notes.length} Logs
                                                    </span>
                                                </div>

                                                <div
                                                    className="h-40 lg:flex-1 bg-white rounded-2xl md:rounded-3xl border border-indigo-100/30 p-4 md:p-5 shadow-inner overflow-y-auto custom-scrollbar mb-3 md:mb-4"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {item.notes.length > 0 ? (
                                                        <div className="space-y-3 md:space-y-4">
                                                            {item.notes.slice().reverse().map((note, idx) => (
                                                                <div key={note.id} className={`pb-3 md:pb-4 ${idx !== item.notes.length - 1 ? 'border-b border-slate-50' : ''}`}>
                                                                    <div className="flex justify-between items-center mb-1 md:mb-1.5 font-sans">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full"></span>
                                                                            <span className="text-[10px] font-black text-slate-900">{note.author}</span>
                                                                        </div>
                                                                        <span className="text-[9px] font-bold text-slate-300">{note.createdAt}</span>
                                                                    </div>
                                                                    <p className="text-[10px] md:text-[11px] font-medium text-slate-500 leading-relaxed whitespace-pre-wrap pl-3.5 border-l border-indigo-100 ml-[3px]">{note.content}</p>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <div className="h-full flex flex-col items-center justify-center text-slate-200 gap-2">
                                                            <div className="p-3 bg-slate-50 rounded-full border border-slate-100">
                                                                <AlertCircle size={24} className="opacity-20" />
                                                            </div>
                                                            <p className="text-[9px] font-black uppercase tracking-[0.1em] italic">No logs</p>
                                                        </div>
                                                    )}
                                                </div>

                                                <div className="relative group/input" onClick={(e) => e.stopPropagation()}>
                                                    <textarea
                                                        placeholder="로그 작성..."
                                                        className="w-full h-20 md:h-24 bg-white border border-slate-200 rounded-2xl p-3 md:p-4 text-[10px] md:text-[11px] font-medium focus:ring-8 focus:ring-indigo-50 focus:border-indigo-400 outline-none transition-all placeholder:text-slate-300 resize-none shadow-sm font-sans"
                                                        value={newNotes[item.refNo] || ''}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            setNewNotes(prev => ({ ...prev, [item.refNo]: val }));

                                                            const timeoutKey = `timeout_${item.refNo}`;
                                                            if ((window as any)[timeoutKey]) clearTimeout((window as any)[timeoutKey]);

                                                            (window as any)[timeoutKey] = setTimeout(() => {
                                                                if (val.trim()) {
                                                                    onAddNote(item.refNo);
                                                                }
                                                            }, 2000);
                                                        }}
                                                    />
                                                    {isSavingNote[item.refNo] && (
                                                        <div className="absolute right-3 bottom-3 flex items-center gap-1.5 px-2 py-1 bg-indigo-50 rounded-lg border border-indigo-100 animate-pulse">
                                                            <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
                                                            <span className="text-[8px] font-black text-indigo-600 uppercase">Saving</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
});

export default ReferralTable;
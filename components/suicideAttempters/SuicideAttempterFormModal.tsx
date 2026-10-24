import React, { useState, useEffect, useCallback } from 'react';
import { SuicideAttempterReferral, ReferralNote, Attachment, User } from '../../types';
import { GENDER_OPTIONS, PROCESSING_STATUS_OPTIONS, DISPOSAL_REASON_OPTIONS, INTERVENTION_STATUS_OPTIONS, REGISTRATION_STATUS_OPTIONS, DIAGNOSIS_OPTIONS, INFO_TARGET_OPTIONS } from '../../constants';
import { getRegions } from '../../services/orgConfig';
import DocumentAttachmentModal from '../common/document-modal/DocumentAttachmentModal';


interface SuicideAttempterFormModalProps {
    isOpen: boolean;
    isEditing: boolean;
    onClose: () => void;
    onSubmit: (referral: any) => void;
    onDelete?: (uid: string) => void;
    referralData?: SuicideAttempterReferral | null;
    allReferrals: SuicideAttempterReferral[];
    currentUser: User;
    showToast: (message: string) => void;
    users: User[];
}

const SuicideAttempterFormModal: React.FC<SuicideAttempterFormModalProps> = ({
    isOpen,
    isEditing,
    onClose,
    onSubmit,
    onDelete,
    referralData,
    allReferrals,
    currentUser,
    showToast,
    users
}) => {
    const [formData, setFormData] = useState<Partial<SuicideAttempterReferral>>({});
    const [error, setError] = useState('');
    const [currentNote, setCurrentNote] = useState('');
    const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);

    // Note Editing State
    const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
    const [editedNoteContent, setEditedNoteContent] = useState('');

    const staffList = users.map(u => ({ name: u.name, team: u.team }));
    const [isGenderCustom, setIsGenderCustom] = useState(false);
    const [isRequestAgencyCustom, setIsRequestAgencyCustom] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false); // [v5.5] Delete guard


    // [v5.1 Fix] Handle form initialization and prevent data loss from background updates
    useEffect(() => {
        if (!isOpen) {
            setIsInitialized(false);
            return;
        }

        // Only initialize once per modal open session
        if (!isInitialized) {
            if (isEditing && referralData) {
                setFormData(referralData);
                // "Other" detection for Gender
                if (referralData.gender && !GENDER_OPTIONS.includes(referralData.gender as any)) {
                    setIsGenderCustom(true);
                }
                // "Other" detection for Request Agency
                if (referralData.requestAgency && !['경찰', '소방'].includes(referralData.requestAgency)) {
                    setIsRequestAgencyCustom(true);
                }
            } else {
                // Try to recover from sessionStorage first for new records
                const saved = sessionStorage.getItem('pending_sa_registration');
                if (saved) {
                    try {
                        const parsed = JSON.parse(saved);
                        // If it's a different year or something, we might want to refresh the ID, 
                        // but usually, we want to keep it.
                        setFormData(parsed);
                    } catch (e) {
                        console.error('Failed to recover form data', e);
                    }
                } else {
                    // Auto-generate Case ID for new records
                    const year = new Date().getFullYear();
                    const existingIds = allReferrals
                        .map(r => r.uid)
                        .filter(id => id && id.startsWith(`${year}-`));

                    let nextSequence = 1;
                    if (existingIds.length > 0) {
                        const maxSeq = Math.max(...existingIds.map(id => parseInt(id.split('-')[1] || '0', 10)));
                        nextSequence = maxSeq + 1;
                    }
                    const newCaseId = `${year}-${String(nextSequence).padStart(3, '0')}`;

                    setFormData({
                        uid: newCaseId,
                        sn: '',
                        receiptDate: new Date().toISOString().split('T')[0],
                        gender: '기타',
                        region: getRegions()[0],
                        processingStatus: '처리중',
                        interventionStatus: '일반상담(미등록)',
                        registrationStatus: '미등록',
                        requestAgency: '경찰',
                        notes: [],
                        attachments: []
                    });
                }
            }
            setIsInitialized(true);
        }

        setError('');
    }, [isOpen, isEditing, referralData, allReferrals, isInitialized]);

    // Backup to sessionStorage when formData changes (only for new records)
    useEffect(() => {
        if (isOpen && !isEditing && Object.keys(formData).length > 0) {
            sessionStorage.setItem('pending_sa_registration', JSON.stringify(formData));
        }
    }, [formData, isOpen, isEditing]);

    // Clear backup on successful submit or explicit close
    const handleModalClose = () => {
        if (!isEditing) sessionStorage.removeItem('pending_sa_registration');
        onClose();
    };

    if (!isOpen) return null;

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;

        if (name === 'gender') {
            if (value === 'direct_input') {
                setIsGenderCustom(true);
                setFormData(prev => ({ ...prev, gender: '' }));
            } else {
                setIsGenderCustom(false);
                setFormData(prev => ({ ...prev, gender: value }));
            }
        } else if (name === 'requestAgencyDropdown') { // Changed name from 'requestAgency'
            if (value === 'direct_input') {
                setIsRequestAgencyCustom(true);
                setFormData(prev => ({ ...prev, requestAgency: '' }));
            } else {
                setIsRequestAgencyCustom(false);
                setFormData(prev => ({ ...prev, requestAgency: value }));
            }
        } else if (name === 'birthDate') {
            // Auto-calculate Age
            const cleaned = value.replace(/[^0-9]/g, '');
            let calculatedAge = formData.age;
            if (cleaned.length >= 4) {
                const year = parseInt(cleaned.substring(0, 4), 10);
                const currentYear = new Date().getFullYear();
                if (!isNaN(year)) {
                    calculatedAge = currentYear - year;
                }
            }
            setFormData(prev => ({ ...prev, [name]: value, age: calculatedAge }));
        } else if (name === 'processingStatus') {
            // [v5.0 Automation] Service Agreement -> Auto-set Path
            let updates: any = { processingStatus: value };
            if (value === '서비스동의') {
                updates.interventionStatus = '자살위기지원서비스(등록_미등록)';
            }
            setFormData(prev => ({ ...prev, ...updates }));
        } else {
            setFormData(prev => ({ ...prev, [name]: value }));
        }
    };

    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isSubmitting) return;

        setError('');

        const requiredFields = [
            { key: 'uid', label: '의뢰번호' },
            { key: 'name', label: '대상자 성명' },
            { key: 'receiptDate', label: '접수 일자' },
            { key: 'assignee', label: '담당자' },
            { key: 'age', label: '나이' }
        ];

        for (const field of requiredFields) {
            const value = formData[field.key as keyof SuicideAttempterReferral];
            if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
                setError(`${field.label}은(는) 필수 항목입니다.`);
                return;
            }
            if (field.key === 'age' && isNaN(Number(value))) {
                setError('나이는 숫자만 입력 가능합니다.');
                return;
            }
        }

        const isDuplicate = allReferrals.some(
            r => r.uid === formData.uid && r.uid !== referralData?.uid
        );
        if (isDuplicate) {
            setError('이미 사용 중인 의뢰번호입니다.');
            return;
        }

        const finalFormData = { ...formData };
        if (currentNote.trim()) {
            const newNote: ReferralNote = {
                id: `note_${Date.now()}`,
                content: currentNote,
                createdAt: new Date().toLocaleString('ko-KR'),
                author: currentUser.name,
            };
            finalFormData.notes = [...(finalFormData.notes || []), newNote];
        }

        setIsSubmitting(true);
        try {
            await onSubmit(finalFormData);
            if (!isEditing) sessionStorage.removeItem('pending_sa_registration');
            onClose();
        } catch (err) {
            console.error('Submit error:', err);
            setError(`저장 중 오류가 발생했습니다: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setIsSubmitting(false);
        }
    };


    const handleDelete = async () => {
        if (onDelete && formData.uid && !isDeleting) {
            setIsDeleting(true);
            try {
                await onDelete(formData.uid);
                if (!isEditing) sessionStorage.removeItem('pending_sa_registration');
                onClose();
            } catch (err) {
                console.error('Delete error:', err);
                showToast('삭제 중 오류가 발생했습니다.');
                setIsDeleting(false);
            }
        }
    };

    const handleUpdateAttachments = useCallback((uid: string, updatedAttachments: Attachment[]) => {
        setFormData(prev => ({ ...prev, attachments: updatedAttachments }));
    }, []);

    // Note Action Handlers
    const handleEditStart = (note: ReferralNote) => {
        setEditingNoteId(note.id);
        setEditedNoteContent(note.content);
    };

    const handleEditCancel = () => {
        setEditingNoteId(null);
        setEditedNoteContent('');
    };

    const handleEditSave = () => {
        if (!editingNoteId || !editedNoteContent.trim()) return;

        const updatedNotes = (formData.notes || []).map(n =>
            n.id === editingNoteId
                ? { ...n, content: editedNoteContent, createdAt: `${n.createdAt} (수정됨)` }
                : n
        );

        setFormData(prev => ({ ...prev, notes: updatedNotes }));
        setEditingNoteId(null);
        setEditedNoteContent('');
    };

    const handleDeleteNote = (noteId: string) => {
        if (!confirm('정말 이 노트를 삭제하시겠습니까?')) return;
        const updatedNotes = (formData.notes || []).filter(n => n.id !== noteId);
        setFormData(prev => ({ ...prev, notes: updatedNotes }));
    };

    if (!isOpen) return null;

    const inputClass = "w-full p-4 rounded-2xl border-2 border-slate-200 bg-white text-sm font-bold focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all placeholder:text-slate-300";
    const labelClass = "block text-[11px] font-black text-slate-500 mb-2 uppercase tracking-widest pl-1";
    const sectionHeaderClass = "col-span-12 mt-6 mb-2 flex items-center gap-3";
    const sectionTitleClass = "text-sm font-black uppercase tracking-tight px-4 py-2 rounded-xl shadow-sm border-b-2";

    return (
        <>
            <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-[var(--modal-padding)] transition-opacity duration-300">
                <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[var(--modal-w-lg)] max-h-[var(--modal-max-h)] overflow-hidden flex flex-col transform transition-all duration-300 scale-100">
                    <div className="p-[var(--modal-padding)] border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
                        <div>
                            <h2 className="text-2xl font-black text-slate-900 tracking-tight">
                                {isEditing ? '자살시도자 정보 수정' : '자살시도자 신규 등록'}
                            </h2>
                            <p className="text-sm text-slate-500 mt-1 font-medium">
                                {isEditing ? '등록된 정보를 수정하고 관리합니다.' : '새로운 자살시도자 정보를 등록합니다.'}
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-2xl border border-slate-200/50 shadow-sm mr-2">
                                {/* Action Buttons Anchored to Header - V15.1 */}
                                <button
                                    type="button"
                                    onClick={() => setIsAttachmentModalOpen(true)}
                                    className="flex items-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-xl font-bold text-xs transition-all border border-indigo-100"
                                >
                                    <i className="fas fa-paperclip"></i>
                                    첨부파일 관리
                                    {formData.attachments && formData.attachments.length > 0 && (
                                        <span className="bg-indigo-600 text-white text-[10px] w-5 h-5 flex items-center justify-center rounded-full border-2 border-white font-black">
                                            {formData.attachments.length}
                                        </span>
                                    )}
                                </button>

                                <div className="h-6 w-px bg-slate-200 mx-1"></div>

                                {isEditing && currentUser.role === 'admin' && (
                                    <button type="button" onClick={handleDelete} disabled={isDeleting} className="px-4 py-2 bg-rose-50 text-rose-600 hover:bg-rose-100 rounded-xl font-black transition-all text-xs border border-rose-100 disabled:opacity-50">
                                        {isDeleting ? '삭제 중...' : '삭제'}
                                    </button>
                                )}
                                <button type="button" onClick={handleModalClose} disabled={isSubmitting} className="px-4 py-2 bg-slate-200 text-slate-600 hover:bg-slate-300 rounded-xl font-black transition-all text-xs border border-slate-300/50 disabled:opacity-50">
                                    취소
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.preventDefault();
                                        const form = e.currentTarget.closest('div')?.parentElement?.parentElement?.nextElementSibling as HTMLFormElement;
                                        if (form) form.requestSubmit();
                                    }}
                                    disabled={isSubmitting}
                                    className="px-6 py-2 bg-slate-900 text-white hover:bg-slate-800 rounded-xl font-black shadow-lg shadow-slate-900/10 transition-all text-xs border border-slate-900 disabled:bg-slate-500 disabled:border-slate-500 flex items-center gap-2"
                                >
                                    {isSubmitting && <i className="fas fa-spinner fa-spin"></i>}
                                    {isSubmitting ? '저장 중...' : '저장하기'}
                                </button>
                            </div>

                            <button onClick={handleModalClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                                <i className="fas fa-times text-slate-400 text-xl"></i>
                            </button>
                        </div>
                    </div>
                    <form onSubmit={handleSubmit} className="space-y-0 p-10 overflow-y-auto flex-grow bg-slate-50/30">
                        {error && <div className="bg-red-50 p-5 rounded-3xl border-2 border-red-100 mb-8 animation-shake"><p className="text-red-600 font-black text-sm flex items-center gap-2"><i className="fas fa-exclamation-circle"></i> {error}</p></div>}

                        <div className="grid grid-cols-12 gap-x-5 gap-y-6">

                            {/* SECTION 1: IDENTITY */}
                            <div className={sectionHeaderClass}>
                                <span className={`${sectionTitleClass} bg-blue-600 text-white border-blue-800`}><i className="fas fa-user-circle mr-2"></i> 대상자 인적사항</span>
                                <div className="h-0.5 flex-1 bg-gradient-to-r from-blue-100 to-transparent rounded-full"></div>
                            </div>

                            {/* ROW 1: Identity (Manual SN Added) */}
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>연번 (수동번호)</label>
                                <input type="text" name="sn" value={formData.sn || ''} onChange={handleInputChange} className={`${inputClass} !bg-slate-100 !border-slate-300 focus:!bg-white focus:!border-indigo-500`} placeholder="예: 24-001" />
                            </div>
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>대상자 성명 <span className="text-red-500">*</span></label>
                                <input type="text" name="name" value={formData.name || ''} onChange={handleInputChange} className={inputClass} required />
                            </div>
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>생년월일</label>
                                <input type="text" name="birthDate" value={formData.birthDate || ''} onChange={handleInputChange} placeholder="YYYY-MM-DD" className={inputClass} />
                            </div>
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>나이 <span className="text-red-500">*</span></label>
                                <input type="number" name="age" value={formData.age || ''} onChange={handleInputChange} className={`${inputClass} !text-[16px] !bg-indigo-50 !border-indigo-200 focus:!bg-white focus:!border-indigo-500`} required />
                            </div>
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>성별</label>
                                <select name="gender"
                                    value={isGenderCustom ? 'direct_input' : (formData.gender || '기타')}
                                    onChange={handleInputChange}
                                    className={inputClass}>
                                    {GENDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                    <option value="direct_input">직접 입력</option>
                                </select>
                            </div>
                            <div className="col-span-12 md:col-span-2">
                                <label className={labelClass}>연락처</label>
                                <input type="text" name="phoneNumber" value={formData.phoneNumber || ''} onChange={handleInputChange} className={inputClass} placeholder="010-0000-0000" />
                            </div>

                            {/* SECTION 2: AGENCY & STAFF */}
                            <div className={sectionHeaderClass}>
                                <span className={`${sectionTitleClass} bg-emerald-600 text-white border-emerald-800`}><i className="fas fa-hospital mr-2"></i> 의뢰 및 담당자 정보</span>
                                <div className="h-0.5 flex-1 bg-gradient-to-r from-emerald-100 to-transparent rounded-full"></div>
                            </div>
                            <div className="col-span-12 md:col-span-3">
                                <label className={labelClass}>의뢰기관명</label>
                                <select name="requestAgencyDropdown"
                                    value={isRequestAgencyCustom ? 'direct_input' : (formData.requestAgency || '경찰')}
                                    onChange={handleInputChange}
                                    className={inputClass}>
                                    <option value="경찰">경찰</option>
                                    <option value="소방">소방</option>
                                    <option value="direct_input">직접 입력</option>
                                </select>
                                {isRequestAgencyCustom && (
                                    <input type="text" name="requestAgency" value={formData.requestAgency || ''} onChange={handleInputChange} className={`${inputClass} mt-1`} placeholder="의뢰기관명 입력" />
                                )}
                            </div>

                            <div className="col-span-12 md:col-span-3">
                                <label className={labelClass}>의뢰기관 담당자 (실명)</label>
                                <input type="text" name="pic" value={formData.pic || ''} onChange={handleInputChange} className={inputClass} placeholder="예: 김경찰" />
                            </div>

                            <div className="col-span-12 md:col-span-3">
                                <label className={labelClass}>센터 담당자 <span className="text-red-500">*</span></label>
                                <select name="assignee" value={formData.assignee || ''} onChange={handleInputChange} className={inputClass} required>
                                    <option value="">담당자 선택</option>
                                    {staffList.map(staff => (
                                        <option key={staff.name} value={staff.name}>{staff.name} ({staff.team})</option>
                                    ))}
                                </select>
                            </div>

                            <div className="col-span-12 md:col-span-3">
                                <label className={labelClass}>정보제공 대상</label>
                                <select name="infoTarget" value={formData.infoTarget || ''} onChange={handleInputChange} className={inputClass}>
                                    <option value="">선택</option>
                                    {INFO_TARGET_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>

                            {/* SECTION 3: LOCATION & STATUS */}
                            <div className={sectionHeaderClass}>
                                <span className={`${sectionTitleClass} bg-indigo-600 text-white border-indigo-800`}><i className="fas fa-map-marked-alt mr-2"></i> 거주지 및 서비스 상태</span>
                                <div className="h-0.5 flex-1 bg-gradient-to-r from-indigo-100 to-transparent rounded-full"></div>
                            </div>
                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>주소(읍면동)</label>
                                <select name="region" value={formData.region || getRegions()[0]} onChange={handleInputChange} className={inputClass}>
                                    {getRegions().map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </div>

                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>개인정보 취득일자 <span className="text-red-500">*</span></label>
                                <input type="date" name="privacyAcquisitionDate" value={formData.privacyAcquisitionDate || ''} onChange={handleInputChange} className={inputClass} required />
                            </div>

                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>서비스 동의여부 (처리구분)</label>
                                <select name="processingStatus" value={formData.processingStatus || '처리중'} onChange={handleInputChange} className={`${inputClass} !bg-violet-50 !border-violet-200 !text-violet-900 !ring-violet-500/10`}>
                                    {PROCESSING_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>

                            {/* SECTION 4: PATH & FOLLOW-UP */}
                            <div className={sectionHeaderClass}>
                                <span className={`${sectionTitleClass} bg-slate-700 text-white border-slate-900`}><i className="fas fa-stream mr-2"></i> 개입 경로 및 사후 상태</span>
                                <div className="h-0.5 flex-1 bg-gradient-to-r from-slate-200 to-transparent rounded-full"></div>
                            </div>
                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>등록 경로 (개입현황)</label>
                                <select name="interventionStatus" value={formData.interventionStatus || ''} onChange={handleInputChange} className={inputClass}>
                                    <option value="">선택</option>
                                    {INTERVENTION_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>
                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>등록 상태</label>
                                <select name="registrationStatus" value={formData.registrationStatus || '미등록'} onChange={handleInputChange} className={inputClass}>
                                    {REGISTRATION_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>
                            <div className="col-span-12 md:col-span-4">
                                <label className={labelClass}>미동의/미연계 사유</label>
                                <select name="disposalReason" value={formData.disposalReason || ''} onChange={handleInputChange} className={inputClass}>
                                    <option value="">선택</option>
                                    {DISPOSAL_REASON_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>

                            {/* Hidden/Aux Fields (Required by Schema but less important visually or Auto-filled) */}
                            <div className="hidden">
                                <input type="date" name="receiptDate" value={formData.receiptDate || ''} readOnly />
                                <input type="text" name="uid" value={formData.uid || ''} readOnly />
                                <select name="requestAgency" value={formData.requestAgency} onChange={() => { }}></select>
                                <select name="assignee" value={formData.assignee} onChange={() => { }}></select>
                            </div>

                            {/* Note: Specific Request Agency and Assignee seem to be missing from the user's NEW Layout Request.
                                 However, they are REQUIRED fields. I should check if I missed them in the prompt.
                                 Prompt said: Row 2: Region, InfoTarget, Privacy, ServiceAgree.
                                 It did NOT mention 'Assignee' or 'Request Agency'.
                                 BUT 'Assignee' is required. 'Request Agency' is important.
                                 I will ADD them to Row 1 extension or Row 2 extension to ensure the form works.
                                 Actually, Row 1 has Name/Birth/Age/Gender/Phone (12).
                                 Row 2 has Region/InfoTarget/Privacy/ServiceAgree (12).
                                 Row 3 has Intervention/Registration/Disposal (12).
                                 Where is Assignee and Request Agency?
                                 I MUST include them. I will distribute them in Row 2 or create a Row 1.5.
                                 User said "Row 2: Region, InfoTarget, Privacy, ServiceAgree".
                                 I will add RequestAgency and Assignee back, probably in Row 1.5 or squeeze them.
                                 Let's make Row 1.5: RequestAgency(6), Assignee(6).
                                 Or add to Row 2: Region(3) -> Region(2), InfoTarget(2), Privacy(2), ServiceAgree(2), RequestAgency(2), Assignee(2). Total 12.
                                 That fits 6 items of col-span-2.
                            */}




                            {/* SECTION 5: NOTES */}
                            <div className={sectionHeaderClass}>
                                <span className={`${sectionTitleClass} bg-amber-500 text-white border-amber-700`}><i className="fas fa-edit mr-2"></i> 상담/개입내역 기록</span>
                                <div className="h-0.5 flex-1 bg-gradient-to-r from-amber-100 to-transparent rounded-full"></div>
                            </div>

                            <div className="col-span-12 md:col-span-12 flex flex-col h-full pt-2">
                                <label className="flex items-center justify-between text-[11px] font-black text-slate-400 mb-3 uppercase pl-1">
                                    <span><i className="fas fa-history mr-1 opacity-50"></i> 과거 기록 아카이브</span>
                                    <span className="font-bold">기록 담당: {currentUser.name}</span>
                                </label>

                                <div className="flex-grow flex flex-col gap-3">
                                    {(formData.notes && formData.notes.length > 0) && (
                                        <div className="bg-amber-50 rounded-xl p-3 border border-amber-100 max-h-[120px] overflow-y-auto custom-scrollbar">
                                            <ul className="space-y-2">
                                                {formData.notes.map((note) => (
                                                    <li key={note.id} className="text-sm bg-white p-2.5 rounded-lg border border-amber-200/50 shadow-sm relative group">
                                                        <div className="flex justify-between items-center mb-1">
                                                            <div className="text-xs font-bold text-amber-600/80">{note.author} <span className="text-slate-400 font-normal ml-1">{note.createdAt}</span></div>
                                                            {editingNoteId !== note.id && (
                                                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <button type="button" onClick={() => handleEditStart(note)} className="text-slate-400 hover:text-blue-500"><i className="fas fa-pen text-[10px]"></i></button>
                                                                    <button type="button" onClick={() => handleDeleteNote(note.id)} className="text-slate-400 hover:text-red-500"><i className="fas fa-trash text-[10px]"></i></button>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {editingNoteId === note.id ? (
                                                            <div className="space-y-2">
                                                                <textarea value={editedNoteContent} onChange={(e) => setEditedNoteContent(e.target.value)} className="w-full p-2 text-sm border border-blue-300 rounded" rows={2} />
                                                                <div className="flex justify-end gap-1"><button onClick={handleEditCancel} className="text-xs bg-slate-200 px-2 py-1 rounded">취소</button><button onClick={handleEditSave} className="text-xs bg-blue-500 text-white px-2 py-1 rounded">저장</button></div>
                                                            </div>
                                                        ) : (
                                                            <p className="text-slate-700 whitespace-pre-line text-xs">{note.content}</p>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    <textarea
                                        value={currentNote}
                                        onChange={(e) => setCurrentNote(e.target.value)}
                                        className="w-full p-3 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all flex-grow min-h-[140px] resize-none border-slate-300 focus:border-indigo-500"
                                        placeholder="상담/개입 내용을 입력하세요..."
                                    />
                                </div>
                            </div>

                        </div>

                        {/* SECTION 6: ATTACHMENTS (V15.1 Minimalist) */}
                        <div className="col-span-12 mt-6">
                            <div className={`${sectionHeaderClass} bg-slate-50/50 p-4 rounded-2xl border border-slate-100`}>
                                <div className="flex items-center gap-3">
                                    <span className={`${sectionTitleClass} bg-indigo-600 text-white border-indigo-800`}>
                                        <i className="fas fa-paperclip mr-2"></i> 첨부파일 일람
                                    </span>
                                    {formData.attachments && formData.attachments.length > 0 ? (
                                        <div className="flex flex-wrap gap-2 ml-4">
                                            {formData.attachments.map(att => (
                                                <span key={att.id} className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-500 shadow-sm flex items-center gap-1">
                                                    <i className="fas fa-file text-indigo-400"></i>
                                                    {att.name}
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-xs text-slate-300 font-medium italic pl-4">첨부된 파일이 없습니다.</span>
                                    )}
                                </div>
                            </div>
                        </div>

                    </form>

                    {/* Attachment Modal */}
                    {isAttachmentModalOpen && (
                        <DocumentAttachmentModal
                            isOpen={isAttachmentModalOpen}
                            onClose={() => setIsAttachmentModalOpen(false)}
                            referralId={formData.uid || 'new-sa'}
                            currentUser={currentUser}
                            onUpdateAttachments={(updated) => handleUpdateAttachments(formData.uid || 'new-sa', updated)}
                            initialAttachments={formData.attachments || []}
                            folderType="suicideAttempter"
                            referralName={formData.name}
                        />
                    )}
                </div>
            </div>
        </>
    );
};

export default SuicideAttempterFormModal;
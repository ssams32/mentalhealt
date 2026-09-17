import React, { useState, useEffect, useRef } from 'react';
import { Referral, User, Attachment, Note, ReferralNote } from '../../types';
import { GENDER_OPTIONS, ICHEON_REGIONS, DIAGNOSIS_OPTIONS, REFERRAL_PATH_OPTIONS, CRI_LEVELS, INTERVENTION_GUIDE_TEXT, MAIN_TEAMS, ALL_TEAMS, ACTION_RESULT_OPTIONS, NAMBU_SUB_TEAMS } from '../../constants';
import { 
    X, Check, Save, Share2, Printer, AlertCircle, FileText, Download, Trash2, 
    MessageSquare, Clock, User as UserIcon, Phone, MapPin, Building2, Calendar, 
    MoreHorizontal, ChevronDown, ChevronRight, Edit2, History, Paperclip, 
    Sparkles, Eye, Loader2, Plus, Search, Star, CheckCircle2, PhoneCall, 
    Filter, LayoutGrid, List, FileUp, Pencil, ArrowRightCircle, RotateCcw, 
    Monitor, UserCheck, ChevronLeft
} from 'lucide-react';
import html2canvas from 'html2canvas';
import ToggleSwitch from '../common/ToggleSwitch';
import DocumentAttachmentModal from '../common/document-modal/DocumentAttachmentModal';
import FilePreviewModal from '../common/FilePreviewModal';
import { apiClient } from '../../services/apiClient';

declare var _: any;

interface ReferralEditorProps {
    referralData?: Referral | null;
    currentUser: User;
    onSubmit: (referral: any, originalRefNo?: string) => Promise<any> | void;
    onDelete?: (refNo: string) => void;
    onCancel?: () => void;
    users: User[];
    showToast: (message: string) => void;
    isEditing: boolean;
    // Optional props for layout control
    hideCancelButton?: boolean;
    mode?: 'modal' | 'workspace';
    onPreviewRequest?: (file: Attachment) => void;
}

const INTERVENTION_TEMPLATE = `자살시도력: (+) 1st 2022년 1월 Wrist cutting, 2nd 2022년 2월 농약음독, 3rd 2022 7월 투신하려다 경찰신고
정신과 약물복용 및 치료여부: 2022년 1월 수원아주다남병원 응급입원 후 퇴원, 2022년 원주기독병원 위세척 후 귀가.입원에 거부적이며 2월까지정신과 약물 복용했으나 2022년 6월 임의 중단
음주여부: 매일 소주 2병씩 / 식사 및 수면: 2~3시간 잤다가 깨어남.
    진단명 : 양극성 정동장애
약물: (아침) 아리피졸정 2mg, 명인벤즈트로핀메실레이트정 1mg, 데파킨크로노정 300mg, 리보트릴정, 스리반정 0.5mg
    (저녁) 데타킨크로노정 300mg, 팔리스펜서방정3mg, 리보트릴정, 스리반정 0.5mg
외래병원: 하은정신의학과의원
보호요인: 거북이 / 지지체계 : 초등학교 동창생
주호소 및 개입내용: 1인 가구이며 고등학교 졸업 후 이천으로 왔으나 뚜렷한 직장없이 집에서 은둔.최근 2개월간 무분별한 지출과 폭음 증가.정신과적 문제가 있으나 약물을 임의 중단하여 하은정신의학과의원에 연계하였으며 주 1회 외래동행하여 상담 및 약물 처방 중, 경제적 문제로 이천시청에서 경기도형 긴급생계비 지원, 신체치료(어깨 탈골)을 위해 이천의료원 공공사업과 자원 연계
현상황: 등록을 위해 초기 상담 중`;

const ReferralEditor: React.FC<ReferralEditorProps> = ({
    referralData,
    currentUser,
    onSubmit,
    onDelete,
    onCancel,
    users,
    showToast,
    isEditing,
    hideCancelButton = false,
    mode = 'modal',
    onPreviewRequest
}) => {
    // 폼 전체 데이터를 관리하는 상태
    const [formData, setFormData] = useState<Partial<Referral>>({});
    // 첨부파일 모달의 표시 여부를 관리하는 상태
    const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
    const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null); // [NEW] Canvas Ref for PDF
    // 폼 유효성 검사 오류 메시지를 관리하는 상태
    const [error, setError] = useState('');
    const [currentNote, setCurrentNote] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // [NEW] PDF Rendering Logic
    // [NEW] PDF Rendering Logic
    useEffect(() => {
        if (!previewFile || !canvasRef.current) return;

        // Only trigger for PDF Content (Base64)
        if (previewFile.content && (previewFile.type === 'application/pdf' || previewFile.type?.includes('pdf') || previewFile.name.toLowerCase().endsWith('.pdf'))) {
            const renderPdf = async () => {
                try {
                    let pdfjsLib = (window as any).pdfjsLib;

                    // Dynamically load PDF.js if not present
                    if (!pdfjsLib) {
                        try {
                            await new Promise<void>((resolve, reject) => {
                                const script = document.createElement('script');
                                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
                                script.onload = () => resolve();
                                script.onerror = () => reject(new Error('PDF.js loading failed'));
                                document.head.appendChild(script);
                            });
                            // Wait a tiny bit for window.pdfjsLib to be available
                            await new Promise(r => setTimeout(r, 100));
                            pdfjsLib = (window as any).pdfjsLib;
                        } catch (err) {
                            console.error('Failed to load PDF.js:', err);
                            return;
                        }
                    }

                    if (!pdfjsLib) return;

                    // Ensure worker is set
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

                    // Convert Base64 to Unit8Array handled by pdf.js getDocument
                    // pdf.js can handle base64 string natively check
                    let data: any = previewFile.content;
                    // If content is pure base64 string without data URI prefix, pdf.js might need Uint8Array or specific handling
                    // But getDocument usually handles data URIs or ArrayBuffers.
                    // If content comes from FileReader.readAsDataURL, it is a data URI.

                    const loadingTask = pdfjsLib.getDocument(data);
                    const pdf = await loadingTask.promise;
                    const page = await pdf.getPage(1);

                    const canvas = canvasRef.current;
                    if (!canvas) return;

                    const context = canvas.getContext('2d');
                    // Adjust scale for better quality
                    const viewport = page.getViewport({ scale: 1.5 });

                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    if (context) {
                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                    }
                } catch (e) {
                    console.error('PDF Render Error:', e);
                }
            };
            renderPdf();
        }
    }, [previewFile]);

    // [NEW] PDF Rendering Logic - Reverted to Native Embed
    // No specific effect needed for native embed

    // [NEW] Ref for hidden summary renderer
    const summaryRef = useRef<HTMLDivElement>(null);
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);

    // [NEW] Editing State
    const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
    const [editedNoteContent, setEditedNoteContent] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    // Debounced Auto-Save
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
    // In-flight save guard to prevent concurrent race conditions between auto-save & manual save
    const isSavingRef = useRef<boolean>(false);

    // Ref to track the last referralData we initialized from (prevents re-init on every render)
    const lastInitializedRef = useRef<string | null>(null);

    // [NEW] Ref to track latest formData for cleanup save
    const latestFormDataRef = useRef<Partial<Referral>>({});
    useEffect(() => {
        latestFormDataRef.current = formData;
    }, [formData]);

    // 모달이 열리거나 편집 데이터가 변경될 때 폼 데이터를 초기화하는 Hook
    useEffect(() => {
        // [MODIFIED] Use ID-based check to ensure fresh initialization for every new external referral import
        const initId = referralData?.externalIdx || referralData?.refNo || 'new';
        if (lastInitializedRef.current === initId) {
            // [CRITICAL] 같은 의뢰이지만 부모/서버에서 version 또는 notes가 갱신된 경우:
            // 사용자가 타이핑 중인 입력값(formData)은 보존하고 version과 서버 필드만 안전하게 동기화!
            if (referralData && referralData.version !== undefined && referralData.version !== formData.version) {
                setFormData(prev => ({
                    ...prev,
                    version: referralData.version,
                    notes: (referralData.notes && referralData.notes.length > (prev.notes?.length || 0)) ? referralData.notes : prev.notes,
                    updatedAt: referralData.updatedAt
                }));
                latestFormDataRef.current = {
                    ...latestFormDataRef.current,
                    version: referralData.version,
                    notes: (referralData.notes && referralData.notes.length > (latestFormDataRef.current.notes?.length || 0)) ? referralData.notes : latestFormDataRef.current.notes,
                    updatedAt: referralData.updatedAt
                };
            }
            return;
        }
        lastInitializedRef.current = initId;
        
        setError('');
        setCurrentNote('');

        if (referralData) {
            // Auto-detect region from address
            let detectedRegion = referralData.region;
            if (referralData.address && (!detectedRegion || detectedRegion === ICHEON_REGIONS[ICHEON_REGIONS.length - 1] || detectedRegion === ICHEON_REGIONS[0])) {
                const found = ICHEON_REGIONS.find(r => r !== '기타' && referralData.address?.includes(r));
                if (found) detectedRegion = found;
            }

            // Consolidate all external fields into a summary block
            const summaryParts = [
                `[홈페이지 의뢰 상세 정보]`,
                `등록번호: ${referralData.externalIdx || '미상'}`,
                referralData.problem ? `주문제: ${referralData.problem}` : '',
                referralData.medicalInsurance ? `의료보장: ${referralData.medicalInsurance}` : '',
                referralData.disabilityStatus ? `장애등록여부: ${referralData.disabilityStatus}` : '',
                `보호자유무: ${referralData.guardianPresence || 'N'}`,
                referralData.guardianName ? `보호자: ${referralData.guardianName} (${referralData.guardianRelation || '관계미상'}) / ${referralData.guardianPhone || '연락처없음'}` : '',
                referralData.guardianNotes ? `보호자 비고: ${referralData.guardianNotes}` : '',
                `의뢰동의여부: ${referralData.consentToReferral || '미상'} ${referralData.consentNotes ? `(${referralData.consentNotes})` : ''}`,
                `\n[의뢰인 정보]`,
                `의뢰처: ${referralData.agency || '미상'}`,
                `의뢰인: ${referralData.requesterName || '미상'} (${referralData.requesterPhone || '연락처없음'})`,
                referralData.requesterFax ? `팩스: ${referralData.requesterFax}` : '',
                referralData.requesterEmail ? `이메일: ${referralData.requesterEmail}` : '',
                `\n[의뢰이유]\n${referralData.reason || '내용없음'}`
            ].filter(Boolean).join('\n');

            // [FIXED] Always create a note for external referrals, not just when reason is present
            const isExternal = !!(referralData.externalIdx || referralData.isWebsiteReferral);
            const initialNotes: ReferralNote[] = (referralData.reason || isExternal) ? [{
                id: `note_${Date.now()}`,
                content: summaryParts,
                createdAt: new Date().toISOString(),
                author: currentUser?.name || '시스템'
            }] : [];

            // Merge incoming data with defaults to ensure all fields exist
            setFormData({
                requestDate: new Date().toISOString().split('T')[0],
                team: currentUser?.team || '증진팀',
                gender: '남성',
                closureStatus: '미종결',
                diagnosisProtectionRequest: false,
                writtenRequest: false,
                phoneRequest: false,
                policeIntervention: false,
                reply: false,
                isWebsiteReferral: isExternal,
                criLevel: 'c',
                attachments: [], // [CLEANUP] Remove summaryAttachment (HTML version)
                ...referralData, // spread incoming data
                notes: (referralData.notes && referralData.notes.length > 0) ? referralData.notes : initialNotes,
                interventionContent: '', // [CLEANUP] Redundant field removed from UI
                requestAgency: referralData.agency || referralData.requestAgency || '', 
                region: detectedRegion || ICHEON_REGIONS[ICHEON_REGIONS.length - 1]
            });

            setPreviewFile(null);
            
            // [NEW] Trigger PNG Summary Generation for new external imports
            // Only trigger if it's a NEW import (not editing) and doesn't already have the summary
            const hasExistingSummary = referralData.attachments?.some((a: any) => a.name && a.name.startsWith('[홈페이지의뢰요약]'));
            if (referralData.externalIdx && !hasExistingSummary && (!isEditing || !referralData.refNo)) {
                setTimeout(() => setIsGeneratingImage(true), 1000);
            }
        } else if (!isEditing) {
            setFormData({
                requestDate: new Date().toISOString().split('T')[0],
                team: currentUser?.team || '증진팀',
                gender: '기타',
                region: ICHEON_REGIONS[0],
                closureStatus: '미종결',
                diagnosisProtectionRequest: false,
                writtenRequest: false,
                phoneRequest: false,
                policeIntervention: false,
                reply: false,
                criLevel: 'c',
                attachments: [],
                notes: []
            });
        }
    }, [isEditing, referralData, currentUser]);

    // [NEW] Effect to capture the hidden summary div and convert to PNG
    useEffect(() => {
        if (isGeneratingImage && summaryRef.current) {
            const capture = async () => {
                try {
                    const canvas = await html2canvas(summaryRef.current!, {
                        backgroundColor: '#ffffff',
                        scale: 2, // High quality
                        logging: false,
                        useCORS: true
                    });
                    
                    const base64 = canvas.toDataURL('image/png');
                    const fileName = `[홈페이지의뢰요약]_${formData.name || '미상'}.png`;
                    
                    const newAttachment: Attachment = {
                        id: `summary_img_${Date.now()}`,
                        name: fileName,
                        type: 'image/png',
                        size: Math.round(base64.length * 0.75),
                        content: base64, // Keep in memory for preview
                        uploadedAt: new Date().toISOString(),
                        url: '#'
                    };
                    
                    setFormData(prev => {
                        // Prevent duplicates if it was already generated
                        const exists = prev.attachments?.some(a => a.name && a.name.startsWith('[홈페이지의뢰요약]'));
                        if (exists) return prev;
                        
                        return {
                            ...prev,
                            attachments: [...(prev.attachments || []), newAttachment]
                        };
                    });
                    
                    console.log("PNG Summary generated successfully");
                } catch (err) {
                    console.error("Failed to generate PNG summary", err);
                } finally {
                    setIsGeneratingImage(false);
                }
            };
            capture();
        }
    }, [isGeneratingImage]);

    const performSave = async (dataToSave: Partial<Referral> = latestFormDataRef.current) => {
        if (!isEditing || !dataToSave.refNo) return;
        
        // Clear timer if exists
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }

        if (isSavingRef.current) {
            // 이미 저장 진행 중이면 잠시 후 재시도
            autoSaveTimerRef.current = setTimeout(() => performSave(latestFormDataRef.current), 500);
            return;
        }

        isSavingRef.current = true;
        setSaveStatus('saving');
        try {
            // Call the onSubmit function strictly for background syncing
            const saved = await onSubmit(dataToSave, dataToSave.refNo);
            
            // [CRITICAL] 최신 버전 및 서버 상태 즉각 동기화
            if (saved && saved.version !== undefined) {
                setFormData(prev => ({
                    ...prev,
                    version: saved.version,
                    notes: saved.notes || prev.notes,
                    updatedAt: saved.updatedAt
                }));
                latestFormDataRef.current = {
                    ...latestFormDataRef.current,
                    version: saved.version,
                    notes: saved.notes || latestFormDataRef.current.notes,
                    updatedAt: saved.updatedAt
                };
            }

            setSaveStatus('saved');
            setTimeout(() => setSaveStatus('idle'), 2500);
            return saved;
        } catch (err) {
            console.error("Auto-save failed", err);
            setSaveStatus('error');
        } finally {
            isSavingRef.current = false;
        }
    };

    const triggerAutoSave = (dataToSave: Partial<Referral>, immediate: boolean = false) => {
        // Only autosave existing records, not new ones
        if (!isEditing || !dataToSave.refNo) return;

        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);

        if (immediate) {
            performSave(dataToSave);
        } else {
            setSaveStatus('saving');
            // 변경사항 입력이 멈춘 후 1초(1000ms) 뒤에 서버 동기화를 수행합니다.
            autoSaveTimerRef.current = setTimeout(() => performSave(dataToSave), 1000);
        }
    };

    // [NEW] Cleanup effect to ensure pending saves are completed
    useEffect(() => {
        return () => {
            if (autoSaveTimerRef.current) {
                console.log("[ReferralEditor] Unmount: Triggering pending auto-save");
                performSave(latestFormDataRef.current);
            }
        };
    }, []);

    const handleCancelWithSave = async () => {
        if (autoSaveTimerRef.current) {
            showToast('변경사항 저장 중...');
            await performSave(latestFormDataRef.current);
        }
        if (onCancel) onCancel();
    };

    // Generate staff list from registered users
    const staffList = users.map(u => ({ name: u.name, team: u.team }));

    // Official Document Attachment Handlers
    const officialDocInputRef = useRef<HTMLInputElement>(null);

    const handleOfficialDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        showToast('의뢰공문 업로드 중...');

        let folder = formData.clientId;
        if (!folder) {
            folder = `C-${Date.now()}`;
        }

        try {
            const reader = new FileReader();
            const uploadedFile = await new Promise<Attachment>((resolve, reject) => {
                reader.onload = async (event) => {
                    try {
                        const base64 = (event.target?.result as string).split(',')[1];
                        const result = await apiClient.uploadFile({
                            base64: base64,
                            filename: file.name,
                            mimeType: file.type,
                            folderType: folder
                        });

                        if (result && result.status === 'success') {
                            resolve({
                                id: result.fileId,
                                name: result.filename,
                                type: file.type,
                                size: file.size,
                                url: result.fileUrl,
                                uploadedAt: new Date().toISOString()
                            });
                        } else {
                            reject(new Error(result?.message || result?.error || '업로드 실패'));
                        }
                    } catch (err) {
                        reject(err);
                    }
                };
                reader.onerror = reject;
            });

            reader.readAsDataURL(file);

            setFormData(prev => {
                const updated = {
                    ...prev,
                    clientId: prev.clientId || folder,
                    officialDoc: uploadedFile
                };
                setPreviewFile(uploadedFile); // 신규 첨부 시에만 팝업 노출
                triggerAutoSave(updated);
                return updated;
            });
            showToast('의뢰공문 첨부 완료');
        } catch (error) {
            console.error('Official doc upload error:', error);
            showToast('의뢰공문 첨부에 실패했습니다.');
        }

        if (officialDocInputRef.current) {
            officialDocInputRef.current.value = '';
        }
    };

    const handleOfficialDocDelete = async () => {
        if (!formData.officialDoc) return;
        if (!confirm('의뢰공문을 삭제하시겠습니까?')) return;

        try {
            const file = formData.officialDoc;
            let folder = formData.refNo?.replace(/[^a-z0-9-]/gi, '_') || 'unsorted';
            let fileId = file.id;

            if (file.url && file.url.startsWith('/attachments/')) {
                const parts = file.url.split('/');
                if (parts.length >= 4) {
                    folder = parts[2];
                    fileId = parts[3];
                }
            }

            if (!file.id.startsWith('local_')) {
                await apiClient.deleteFile(folder, fileId);
            }

            setFormData(prev => {
                const updated = { ...prev };
                delete updated.officialDoc;
                triggerAutoSave(updated);
                return updated;
            });

            if (previewFile?.id === file.id) {
                setPreviewFile(null);
            }
            showToast('의뢰공문 삭제 완료');
        } catch (error) {
            console.error('Delete official doc error:', error);
            alert('의뢰공문 삭제 중 오류가 발생했습니다.');
        }
    };

    // Helper for GAS calls
    const runGAS = (funcName: string, ...args: any[]) => {
        return new Promise<any>((resolve, reject) => {
            if (!(window as any).google || !(window as any).google.script) {
                console.warn('GAS environment not detected. Mocking response.');
                setTimeout(() => resolve({ status: 'success' }), 500);
                return;
            }

            try {
                const runner = ((window as any).google.script.run as any);
                if (!runner || typeof runner.withSuccessHandler !== 'function') {
                    reject(new Error('GAS runner invalid in ReferralEditor'));
                    return;
                }
                runner.withSuccessHandler(resolve).withFailureHandler(reject)[funcName](...args);
            } catch (e) {
                console.error('GAS Call Error in ReferralEditor:', e);
                reject(e);
            }
        });
    };

    // 입력 필드(input, select, textarea) 값 변경 핸들러
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        
        setFormData(prev => {
            const updated = { ...prev, [name]: value };
            
            // [NEW] Auto-populate requestAgency for '가족' or '본인' per user request
            if (name === 'referralPath' && (value === '가족' || value === '본인')) {
                updated.requestAgency = value;
            }

            // [NEW] Clear subTeam if team is changed away from 남부분소
            if (name === 'team' && value !== '남부분소') {
                updated.subTeam = '';
            }

            // Auto-save logic
            if (isEditing) {
                triggerAutoSave(updated);
            }
            return updated;
        });
    };

    // 토글 스위치 값 변경 핸들러
    const handleToggleChange = (name: keyof Referral, checked: boolean) => {
        setFormData(prev => {
            const updated = { ...prev, [name]: checked };
            if (isEditing) {
                triggerAutoSave(updated);
            }
            return updated;
        });
    };

    // 폼 제출 핸들러
    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (isSubmitting) return;

        const requiredFields = [
            { key: 'name', label: '대상자 성명' },
            { key: 'phone', label: '연락처' },
            { key: 'gender', label: '성별' },
            { key: 'region', label: '거주 지역' },
            { key: 'diagnosisName', label: '주 진단명' },
            { key: 'requestAgency', label: '의뢰 기관' },
            { key: 'team', label: '담당팀' },
            { key: 'actionResult', label: '조치 결과' },
            { key: 'closureStatus', label: '종결 상태' },
            { key: 'requestDate', label: '의뢰 접수일' },
            { key: 'assignee', label: '담당자' },
            { key: 'criLevel', label: 'CRI (위험도)' },
        ];

        for (const field of requiredFields) {
            const value = formData[field.key as keyof Referral];
            if (typeof value === 'string' && !value.trim()) {
                setError(`${field.label} 은(는) 필수 항목입니다.`);
                return;
            }
            if (value === null || value === undefined || value === '') {
                setError(`${field.label} 은(는) 필수 항목입니다.`);
                return;
            }
        }

        setError('');
        setIsSubmitting(true);

        try {
            // 진행 중인 디바운스 자동저장 타이머 즉시 취소
            if (autoSaveTimerRef.current) {
                clearTimeout(autoSaveTimerRef.current);
                autoSaveTimerRef.current = null;
            }

            const submissionData: Partial<Referral> = { ...formData };
            if (submissionData.referralStatus === 'PENDING_STAFF_REVIEW') {
                submissionData.referralStatus = 'REGISTERED';
            }
            if (currentNote.trim()) {
                const timestamp = new Date().toLocaleString('ko-KR');
                const newNote: ReferralNote = {
                    id: `note_${Date.now()}`,
                    content: currentNote,
                    createdAt: timestamp,
                    author: currentUser.name,
                };
                submissionData.notes = [newNote, ...(submissionData.notes || [])];
                submissionData.latestNote = currentNote;
                submissionData.latestNoteDate = timestamp;
            }

            const originalRefNo = isEditing && referralData && referralData.refNo !== submissionData.refNo
                ? referralData.refNo
                : undefined;

            isSavingRef.current = true;
            const saved = await onSubmit(submissionData, originalRefNo);
            
            // [CRITICAL] 수동 저장 성공 후에도 최신 version 및 갱신 상태 즉시 반영
            if (saved && saved.version !== undefined) {
                setFormData(prev => ({
                    ...prev,
                    ...submissionData,
                    version: saved.version,
                    notes: saved.notes || submissionData.notes,
                    updatedAt: saved.updatedAt
                }));
                latestFormDataRef.current = {
                    ...latestFormDataRef.current,
                    ...submissionData,
                    version: saved.version,
                    notes: saved.notes || submissionData.notes,
                    updatedAt: saved.updatedAt
                };
            }

            setCurrentNote(''); // Clear note after manual save
            setSaveStatus('saved');
            setTimeout(() => setSaveStatus('idle'), 2500);

            if (!isEditing) {
                // PDF background generation if needed
                runGAS('saveReferralPdf', formData)
                    .then(res => {
                        if (res.status === 'success') {
                            showToast('PDF가 드라이브에 생성되었습니다.');
                        }
                    }).catch(() => {});
            }
        } catch (err: any) {
            console.error('Submit error in editor:', err);
            setSaveStatus('error');
            setError(err?.message || '저장 중 오류가 발생했습니다. 다시 시도해주세요.');
        } finally {
            isSavingRef.current = false;
            setIsSubmitting(false);
        }
    };

    const handleDelete = () => {
        if (!confirm('정말 이 의뢰 기록을 삭제하시겠습니까?')) return;
        if (onDelete && formData.refNo) {
            onDelete(formData.refNo);
        }
    }

    const handleDeleteAttachment = async (file: Attachment) => {
        if (!confirm(`'${file.name}' 파일을 삭제하시겠습니까?`)) return;

        try {
            // 1. If it's a server file (has 'nas_' prefix or proper structure), call API
            // Note: server.js expects folder/fileId. Folder is usually referralId (refNo) or 'unsorted'
            // But we might need to parse it from the URL if we lost track.
            // URL format: /attachments/{folder}/{filename}
            // Or we use referralData.refNo if available.

            // Try to extract folder from URL if possible, otherwise guess.
            let folder = referralData?.refNo?.replace(/[^a-z0-9-]/gi, '_') || 'unsorted';
            let fileId = file.id;

            // Heuristic to check if it's a real server file
            if (file.url && file.url.startsWith('/attachments/')) {
                const parts = file.url.split('/');
                if (parts.length >= 4) {
                    folder = parts[2];
                    fileId = parts[3];
                }
            }

            // Only call server if it looks like a server ID (not local_mock)
            if (!file.id.startsWith('local_')) {
                await apiClient.deleteFile(folder, fileId);
            }

            setFormData(prev => ({
                ...prev,
                attachments: prev.attachments?.filter(att => att.id !== file.id)
            }));

            if (previewFile?.id === file.id) {
                setPreviewFile(null);
            }
            showToast('파일이 삭제되었습니다.');

        } catch (error) {
            console.error('Delete file error:', error);
            alert('파일 삭제 중 오류가 발생했습니다.');
        }
    };

    const handleUpdateAttachments = (updatedAttachments: Attachment[]) => {
        setFormData(prev => ({ ...prev, attachments: updatedAttachments }));
    };

    // Note Editing Handlers
    const handleEditStart = (note: ReferralNote) => {
        setEditingNoteId(note.id);
        setEditedNoteContent(note.content);
    };

    const handleEditCancel = () => {
        setEditingNoteId(null);
        setEditedNoteContent('');
    };

    const handleEditSave = () => {
        if (!editingNoteId) return;

        setFormData(prev => {
            const updatedNotes = prev.notes?.map(note =>
                note.id === editingNoteId
                    ? { ...note, content: editedNoteContent }
                    : note
            );
            const updatedData = { ...prev, notes: updatedNotes };
            if (isEditing) triggerAutoSave(updatedData, true); // Immediate save on note edit
            return updatedData;
        });

        setEditingNoteId(null);
        setEditedNoteContent('');
        showToast('내용이 수정 및 자동 저장되었습니다.');
    };

    const handleDeleteNote = (noteId: string) => {
        if (!confirm('정말 이 상담 내용을 삭제하시겠습니까?')) return;

        setFormData(prev => {
            const updatedData = {
                ...prev,
                notes: prev.notes?.filter(n => n.id !== noteId)
            };
            if (isEditing) triggerAutoSave(updatedData, true); // Immediate save on note delete
            return updatedData;
        });
    };

    const handleAddNewNote = () => {
        if (!currentNote.trim()) {
            showToast('기록할 내용을 입력해주세요.');
            return;
        }

        const timestamp = new Date().toLocaleString('ko-KR');
        const newNote: ReferralNote = {
            id: `note_${Date.now()}`,
            content: currentNote,
            createdAt: timestamp,
            author: currentUser.name,
        };

        setFormData(prev => {
            const updatedData = {
                ...prev,
                notes: [newNote, ...(prev.notes || [])],
                latestNote: currentNote,
                latestNoteDate: timestamp
            };
            // [Modified] Immediate save when a note is explicitly added via button
            if (isEditing) triggerAutoSave(updatedData, true);
            return updatedData;
        });
        setCurrentNote('');
        showToast('기록이 추가 및 자동 저장되었습니다.');
    };

    const inputClass = "w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold focus:ring-2 focus:ring-blue-500/10 focus:bg-white transition-all outline-none text-xs";
    const labelClass = "block text-[10px] font-black text-slate-400 uppercase tracking-tight mb-1 ml-0.5";

    // CRI 등급에 따른 헤더 테마 색상 결정
    const getHeaderTheme = (level?: string) => {
        const lv = (level || 'c').toLowerCase();
        switch (lv) {
            case 'a': return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900', accent: 'bg-red-500', badge: 'bg-red-100 text-red-600' };
            case 'b': return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-900', accent: 'bg-orange-500', badge: 'bg-orange-100 text-orange-600' };
            case 'c': return { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-900', accent: 'bg-amber-500', badge: 'bg-amber-100 text-amber-600' };
            case 'd':
            case 'e': return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-900', accent: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-600' };
            default: return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-900', accent: 'bg-slate-500', badge: 'bg-slate-100 text-slate-600' };
        }
    };

    const theme = getHeaderTheme(formData.criLevel);

    return (
        <form onSubmit={handleSubmit} className={`relative flex flex-col flex-1 h-full bg-white ${mode === 'workspace' ? '' : 'rounded-[2.5rem] overflow-hidden'}`}>
            {/* Header / Command Bar - Unified for Workspace or Modal */}
            <div className={`relative z-30 ${theme.bg} border-b ${theme.border} shadow-sm flex flex-col px-6 py-4 shrink-0 transition-all duration-500`}>
                <div className={`flex items-center justify-between mb-3 border-b ${theme.border}/60 pb-3`}>
                    <div className="flex items-center gap-3">
                        <div className={`w-1.5 h-5 ${theme.accent} rounded-full shadow-sm`}></div>
                        <h2 className="text-xl font-black text-slate-800 leading-none">
                            {isEditing ? (formData.name || '대상자 정보') : '신규 의뢰 등록'}
                            {isEditing && (
                                <div className="inline-flex items-center gap-1.5 ml-3 align-middle">
                                    <span className={`px-2 py-0.5 ${theme.badge} text-[10px] font-bold rounded-md shadow-sm border ${theme.border}/50`}>
                                        의뢰번호: {formData.refNo || 'NO ID'}
                                    </span>
                                    {formData.externalIdx && (
                                        <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 text-[10px] font-black rounded-md shadow-sm">
                                            홈페이지 일련번호: {formData.externalIdx}
                                        </span>
                                    )}
                                    {formData.referralStatus === 'PENDING_STAFF_REVIEW' && (
                                        <span className="px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-black rounded-md shadow-sm">
                                            온라인검진 자동접수 (검토대기)
                                        </span>
                                    )}
                                </div>
                            )}
                        </h2>
                    </div>
                    <div className="flex items-start gap-2 pt-1 h-[56px]">
                        <div className="flex flex-col items-end justify-center mr-2 h-[38px]">
                            {/* Status moved below manual save button */}
                        </div>

                        {/* Original Official Doc UI was removed per user request */}
                        {isEditing && (
                            <button
                                type="button"
                                onClick={handleDelete}
                                className={`flex items-center gap-1.5 px-3 py-1.5 h-9 ${theme.text} hover:bg-white/50 rounded-lg font-black text-xs transition-all`}
                            >
                                <Trash2 size={14} />
                                <span>기록 삭제</span>
                            </button>
                        )}
                        {onCancel && (
                            <button
                                type="button"
                                onClick={handleCancelWithSave}
                                className="px-4 py-1.5 h-9 text-slate-500 hover:bg-slate-100/50 rounded-lg font-black text-xs transition-all"
                            >
                                취소
                            </button>
                        )}
                        <div className="relative flex flex-col items-center justify-start ml-2 w-[130px] shrink-0">
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className={`flex items-center justify-center gap-1.5 px-3 h-10 ${isSubmitting ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 active:scale-95'} text-white rounded-xl shadow-xl shadow-blue-200 transition-all w-full shrink-0 relative z-10`}
                            >
                                {isSubmitting ? (
                                    <Loader2 size={16} className="animate-spin shrink-0" />
                                ) : (
                                    <Check size={16} className="shrink-0" />
                                )}
                                <span className="font-black text-sm whitespace-nowrap">
                                    {isSubmitting ? '저장 중...' : (isEditing ? '수동 저장' : '등록')}
                                </span>
                            </button>
                            {isEditing && (
                                <div className="absolute top-full left-0 right-0 flex items-center justify-center text-[11px] font-black tracking-tight w-full whitespace-nowrap mt-1.5 opacity-90 z-20">
                                    {saveStatus === 'idle' && <span className="text-slate-400 flex items-center gap-1"><Check size={10} strokeWidth={3} /> 자동저장 준비됨</span>}
                                    {saveStatus === 'saving' && <span className="text-indigo-600 flex items-center gap-1 animate-pulse"><Loader2 size={12} className="animate-spin" /> 입력 중...</span>}
                                    {saveStatus === 'saved' && <span className="text-emerald-500 flex items-center gap-1"><Check size={12} strokeWidth={3} /> 자동 저장됨</span>}
                                    {saveStatus === 'error' && <span className="text-rose-500 flex items-center gap-1"><AlertCircle size={12} strokeWidth={3} /> 저장 실패</span>}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Inline Basic Info in Header */}
                <div className="grid grid-cols-6 lg:grid-cols-12 gap-3 pb-1">
                    <div className="col-span-3 lg:col-span-2">
                        <label className={`${labelClass} text-rose-800`}>대상자 성명 <span className="text-rose-500">*</span></label>
                        <input type="text" name="name" value={formData.name || ''} onChange={handleInputChange} className={`${inputClass} border-rose-200 focus:ring-rose-500/20 shadow-sm`} required placeholder="성명" />
                    </div>
                    <div className="col-span-3 lg:col-span-2">
                        <label className={`${labelClass} text-rose-800`}>연락처 <span className="text-rose-500">*</span></label>
                        <input type="tel" name="phone" value={formData.phone || ''} onChange={handleInputChange} className={`${inputClass} border-rose-200 focus:ring-rose-500/20 shadow-sm`} placeholder="010-0000-0000" />
                    </div>
                    <div className="col-span-2 lg:col-span-1">
                        <label className={`${labelClass} text-rose-800`}>성별 <span className="text-rose-500">*</span></label>
                        <select name="gender" value={formData.gender || '기타'} onChange={handleInputChange} className={`${inputClass} border-rose-200 focus:ring-rose-500/20 shadow-sm`}>
                            {GENDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                    </div>
                    <div className="col-span-2 lg:col-span-1">
                        <label className={`${labelClass} text-rose-800`}>연령 <span className="text-rose-500">*</span></label>
                        <input type="number" name="age" value={formData.age || ''} onChange={handleInputChange} className={`${inputClass} border-rose-200 focus:ring-rose-500/20 shadow-sm`} placeholder="세" />
                    </div>
                    <div className="col-span-2 lg:col-span-2">
                        <label className={`${labelClass} text-rose-800`}>거주 지역 <span className="text-rose-500">*</span></label>
                        <select name="region" value={formData.region || ICHEON_REGIONS[0]} onChange={handleInputChange} className={`${inputClass} border-rose-200 focus:ring-rose-500/20 shadow-sm`}>
                            {ICHEON_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </div>

                    <div className="col-span-6 lg:col-span-4">
                        <label className={`${labelClass} text-rose-800`}>주 진단명 <span className="text-rose-500">*</span></label>
                        <div className="flex gap-2">
                            <select
                                name="diagnosisName"
                                value={DIAGNOSIS_OPTIONS.includes(formData.diagnosisName || '') ? formData.diagnosisName : '기타질환'}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setFormData(prev => {
                                        const updated = { ...prev, diagnosisName: val === '기타질환' ? '' : val };
                                        if (isEditing) triggerAutoSave(updated);
                                        return updated;
                                    });
                                }}
                                className={`${inputClass} !w-1/2 border-rose-200 focus:ring-rose-500/20 shadow-sm`}
                            >
                                {DIAGNOSIS_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            {(formData.diagnosisName === '' || !DIAGNOSIS_OPTIONS.includes(formData.diagnosisName || '')) && (
                                <input
                                    type="text"
                                    value={formData.diagnosisName || ''}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setFormData(prev => {
                                            const updated = { ...prev, diagnosisName: val };
                                            if (isEditing) triggerAutoSave(updated);
                                            return updated;
                                        });
                                    }}
                                    className={`${inputClass} !flex-1 animate-in slide-in-from-left-2 border-rose-200 focus:ring-rose-500/20 shadow-sm`}
                                    placeholder="직접 입력"
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4 bg-slate-50/20">
                {/* 유효성 검사 오류 메시지 표시 영역 */}
                {error && <div className="bg-red-50 p-3 rounded-xl border border-red-100 animate-shake"><p className="text-red-600 text-[11px] font-bold flex items-center gap-2"><i className="fas fa-exclamation-circle"></i> {error}</p></div>}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                    {/* 의뢰 상세가 앞으로 옴 */}

                    {/* 의뢰 상세 */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-slate-50 pb-2">
                            <div className="w-1 h-3 bg-indigo-500 rounded-full"></div>
                            <h3 className="text-sm font-black text-slate-900">의뢰 상세</h3>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>의뢰 접수일 <span className="text-red-500">*</span></label>
                                <input type="date" name="requestDate" value={formData.requestDate || ''} onChange={handleInputChange} className={inputClass} required />
                            </div>
                            <div>
                                <label className={labelClass}>의뢰 경로</label>
                                <select name="referralPath" value={formData.referralPath || '기타'} onChange={handleInputChange} className={inputClass}>
                                    {REFERRAL_PATH_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>의뢰 기관 (직접 입력) <span className="text-red-500">*</span></label>
                            <input type="text" name="requestAgency" value={formData.requestAgency || ''} onChange={handleInputChange} className={inputClass} placeholder="기관명 입력" />
                        </div>

                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 bg-slate-50/50 p-3 rounded-2xl border border-slate-100">
                            <div className="flex items-center justify-between py-1 border-b border-slate-100/50">
                                <span className="text-[11px] font-black text-slate-700">진단.보호 의뢰서</span>
                                <ToggleSwitch checked={!!formData.diagnosisProtectionRequest} onChange={(val) => handleToggleChange('diagnosisProtectionRequest', val)} />
                            </div>
                            <div className="flex items-center justify-between py-1 border-b border-slate-100/50">
                                <span className="text-[11px] font-black text-slate-700">공문 접수</span>
                                <ToggleSwitch checked={!!formData.writtenRequest} onChange={(val) => handleToggleChange('writtenRequest', val)} />
                            </div>
                            <div className="flex items-center justify-between py-1">
                                <span className="text-[11px] font-black text-slate-700">전화 접수</span>
                                <ToggleSwitch checked={!!formData.phoneRequest} onChange={(val) => handleToggleChange('phoneRequest', val)} />
                            </div>
                            <div className="flex items-center justify-between py-1">
                                <span className="text-[11px] font-black text-slate-700">경찰 동행</span>
                                <ToggleSwitch checked={!!formData.policeIntervention} onChange={(val) => handleToggleChange('policeIntervention', val)} />
                            </div>
                            <div className="flex items-center justify-between py-1">
                                <span className="text-[11px] font-black text-indigo-700">홈페이지 의뢰</span>
                                <ToggleSwitch checked={!!formData.isWebsiteReferral} onChange={(val) => handleToggleChange('isWebsiteReferral', val)} />
                            </div>
                        </div>

                    </div>

                    {/* 조치 결과 (오밀조밀하게 우측 배치) */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 border-b border-slate-50 pb-2">
                            <div className="w-1 h-3 bg-emerald-500 rounded-full"></div>
                            <h3 className="text-sm font-black text-slate-900">개입 결과</h3>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>담당팀 <span className="text-red-500">*</span></label>
                                <select name="team" value={formData.team || '증진팀'} onChange={handleInputChange} className={inputClass}>
                                    {ALL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                            </div>
                            {formData.team === '남부분소' && (
                                <div className="animate-in slide-in-from-top-1 duration-300">
                                    <label className={labelClass}>남부분소 세부 분류 <span className="text-red-500">*</span></label>
                                    <select name="subTeam" value={formData.subTeam || ''} onChange={handleInputChange} className={`${inputClass} border-indigo-200 bg-indigo-50/30`}>
                                        <option value="">분류 선택</option>
                                        {NAMBU_SUB_TEAMS.map(st => <option key={st} value={st}>{st}</option>)}
                                    </select>
                                </div>
                            )}
                            <div>
                                <label className={labelClass}>담당자 <span className="text-red-500">*</span></label>
                                <select name="assignee" value={formData.assignee || ''} onChange={handleInputChange} className={inputClass} required>
                                    <option value="">담당자 선택</option>
                                    {staffList.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>CRI <span className="text-red-500">*</span></label>
                                <select name="criLevel" value={formData.criLevel || 'c'} onChange={handleInputChange} className={inputClass} required>
                                    {Object.entries(CRI_LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>조치 결과 <span className="text-red-500">*</span></label>
                                <select
                                    name="actionResult"
                                    value={formData.actionResult || ''}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        setFormData(prev => {
                                            const updated = {
                                                ...prev,
                                                actionResult: val,
                                                ...(val.includes('종결') ? { closureStatus: '종결' as const } : {})
                                            };
                                            if (isEditing) triggerAutoSave(updated);
                                            return updated;
                                        });
                                    }}
                                    className={inputClass}
                                >
                                    <option value="">선택</option>
                                    {ACTION_RESULT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 bg-emerald-50/30 p-3 rounded-2xl border border-emerald-100">
                            <div className="flex items-center justify-between py-1">
                                <span className="text-[11px] font-black text-slate-700">회신 여부</span>
                                <div className="flex items-center gap-2">
                                    <span className={`text-[10px] font-black ${formData.reply ? 'text-emerald-600' : 'text-slate-400'}`}>
                                        {formData.reply ? '진행' : '없음'}
                                    </span>
                                    <ToggleSwitch checked={!!formData.reply} onChange={(val) => handleToggleChange('reply', val)} />
                                </div>
                            </div>
                            <div className="flex items-center justify-between py-1">
                                <span className="text-[11px] font-black text-slate-700">종결 상태</span>
                                <div className="flex items-center gap-2">
                                    <span className={`text-[10px] font-black ${formData.closureStatus === '종결' ? 'text-blue-600' : 'text-slate-400'}`}>
                                        {formData.closureStatus === '종결' ? '종결' : '미종결'}
                                    </span>
                                    <ToggleSwitch
                                        checked={formData.closureStatus === '종결'}
                                        onChange={(checked) => setFormData(prev => {
                                            const updated = { ...prev, closureStatus: checked ? '종결' as const : '미종결' as const };
                                            if (isEditing) triggerAutoSave(updated);
                                            return updated;
                                        })}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 상담/개입 이력 (고성능 오밀조밀 버전) */}
                <div className="space-y-3 pt-4 border-t border-slate-100">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-4 bg-slate-900 rounded-full"></div>
                            <h3 className="text-base font-black text-slate-900">상담/개입 이력</h3>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setCurrentNote(prev => prev ? prev + '\n' + INTERVENTION_TEMPLATE : INTERVENTION_TEMPLATE)}
                                className="px-3 py-1.5 text-xs font-black text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all"
                            >
                                템플릿
                            </button>
                            <button
                                type="button"
                                onClick={handleAddNewNote}
                                className="px-4 py-1.5 bg-slate-900 text-white rounded-xl text-xs font-black shadow-lg transition-all hover:bg-slate-800 active:scale-95"
                            >
                                기록 추가
                            </button>
                        </div>
                    </div>

                    {/* Inline Add Note Form */}
                    <div className="relative">
                        <textarea
                            value={currentNote}
                            onChange={(e) => {
                                setCurrentNote(e.target.value);
                            }}
                            className="w-full p-4 bg-white border-2 border-slate-200 rounded-2xl text-sm font-bold text-slate-700 min-h-[100px] focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all outline-none resize-none shadow-sm"
                            placeholder="변경하거나 추가할 내용을 입력하세요..."
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                        {formData.notes?.map((note) => (
                            <div key={note.id} className="bg-slate-50/50 border border-slate-100 rounded-xl p-3 hover:bg-white hover:shadow-sm transition-all group">
                                {editingNoteId === note.id ? (
                                    <div className="space-y-2">
                                        <textarea
                                            value={editedNoteContent}
                                            onChange={(e) => setEditedNoteContent(e.target.value)}
                                            className="w-full p-2 bg-white border border-blue-200 rounded-lg text-xs font-bold text-slate-700 min-h-[100px] outline-none"
                                        />
                                        <div className="flex justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={handleEditCancel}
                                                className="px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-100 rounded"
                                            >
                                                취소
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleEditSave}
                                                className="px-2 py-1 text-[10px] font-black bg-indigo-600 text-white rounded hover:bg-indigo-700"
                                            >
                                                내용수정 완료
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className="flex justify-between items-center mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-black text-slate-900">{note.author}</span>
                                                <span className="text-[11px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{note.createdAt}</span>
                                            </div>
                                            <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button type="button" onClick={() => handleEditStart(note)} className="p-1.5 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"><Edit2 size={14} /></button>
                                                <button type="button" onClick={() => handleDeleteNote(note.id)} className="p-1.5 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"><Trash2 size={14} /></button>
                                            </div>
                                        </div>
                                        <p className="text-[13px] font-bold text-slate-700 whitespace-pre-wrap leading-relaxed bg-white border border-slate-100 rounded-lg p-3 shadow-sm">{note.content}</p>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* 첨부파일 목록 (스크롤 끝에 표시) */}
                <div className="pt-4 border-t border-slate-100 pb-10">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-1 h-3 bg-blue-500 rounded-full"></div>
                        <h3 className="text-sm font-black text-slate-900">첨부된 파일</h3>
                    </div>
                    {formData.attachments && formData.attachments.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {formData.attachments.map((file) => (
                                <div key={file.id} className="group flex items-center justify-between p-2 bg-white border border-slate-100 rounded-xl hover:border-blue-200 hover:shadow-sm transition-all">
                                    <div
                                        className="flex items-center gap-2 flex-1 cursor-pointer overflow-hidden"
                                        onClick={() => setPreviewFile(file)}
                                    >
                                        <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
                                            {file.type?.startsWith('image/') ? <Sparkles size={14} /> : <FileText size={14} />}
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] font-bold text-slate-700 truncate">{file.name}</span>
                                            <span className="text-[9px] text-slate-400 font-medium">{(file.size / 1024).toFixed(1)}KB</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button type="button" onClick={() => setPreviewFile(file)} className="p-1.5 text-slate-400 hover:text-blue-600 transition-all"><Eye size={12} /></button>
                                        <button type="button" onClick={() => handleDeleteAttachment(file)} className="p-1.5 text-slate-400 hover:text-rose-600 transition-all"><Trash2 size={12} /></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="p-6 bg-slate-50/50 rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400">
                            <Paperclip size={24} className="mb-2 opacity-20" />
                            <span className="text-[10px] font-bold">첨부된 파일이 없습니다</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Sticky Attachment Footer */}
            <div className="sticky bottom-0 z-40 bg-white border-t border-slate-200 px-6 py-2.5 flex items-center justify-between shadow-[0_-4px_12px_rgba(0,0,0,0.03)]">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-4 bg-blue-600 rounded-full shadow-sm shadow-blue-100"></div>
                    <h3 className="text-xs font-black text-slate-900 tracking-tight">공식문서 / 첨부파일</h3>
                    {formData.attachments && formData.attachments.length > 0 && (
                        <span className="px-1.5 py-0.5 bg-blue-50 text-[10px] font-black text-blue-600 rounded-md ml-1 border border-blue-100">
                            {formData.attachments.length}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    <input
                        type="file"
                        id="direct-file-upload"
                        className="hidden"
                        accept=".pdf"
                        onChange={async (e) => {
                            const files = e.target.files;
                            if (!files || files.length === 0) return;
                            const file = files[0];
                            if (file.size > 50 * 1024 * 1024) {
                                alert(`${file.name} 파일이 50MB를 초과합니다.`);
                                return;
                            }
                            const reader = new FileReader();
                            reader.onload = async (ev) => {
                                const base64Content = ev.target?.result as string;
                                const base64Data = base64Content.split(',')[1];
                                try {
                                    showToast('파일 업로드 중...');
                                    const response = await apiClient.uploadFile({
                                        base64: base64Data,
                                        filename: file.name,
                                        mimeType: file.type,
                                        referralId: formData.refNo || referralData?.refNo || 'temp',
                                        referralName: formData.name || 'unknown'
                                    });
                                    if (response && response.success) {
                                        const newAttachment: Attachment = {
                                            id: response.fileId || `nas_${Date.now()}`,
                                            name: file.name,
                                            type: file.type,
                                            size: file.size,
                                            content: base64Content,
                                            url: response.fileUrl,
                                            uploadedAt: new Date().toISOString()
                                        };
                                        setFormData(prev => {
                                            const updated = { ...prev, attachments: [...(prev.attachments || []), newAttachment] };
                                            if (isEditing) triggerAutoSave(updated);
                                            return updated;
                                        });
                                        setPreviewFile(newAttachment);
                                        showToast('파일이 업로드되었습니다.');
                                    } else {
                                        alert('파일 업로드 실패: ' + (response?.error || 'Unknown error'));
                                    }
                                } catch (error) {
                                    alert('파일 업로드 중 오류가 발생했습니다.');
                                }
                            };
                            reader.readAsDataURL(file);
                            e.target.value = '';
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => document.getElementById('direct-file-upload')?.click()}
                        className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white hover:bg-blue-700 rounded-xl font-black text-xs transition-all shadow-lg shadow-blue-100 active:scale-95"
                    >
                        <Plus size={14} strokeWidth={3} />
                        <span>파일 추가</span>
                    </button>
                </div>

                {/* Inline Previewer (Slide-up from footer) */}
                {previewFile && (
                    <div className="absolute bottom-[calc(100%+8px)] left-4 right-4 bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-300 z-50 ring-1 ring-black/5">
                        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="p-1 bg-blue-100 text-blue-600 rounded">
                                    <Eye size={12} />
                                </div>
                                <span className="text-[11px] font-black text-slate-700 truncate max-w-[250px]">{previewFile.name}</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setPreviewFile(null)}
                                className="p-1 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"
                            >
                                <X size={14} />
                            </button>
                        </div>
                        <div className="aspect-[16/10] w-full bg-slate-100 relative">
                            {(() => {
                                const isHwp = previewFile.name.toLowerCase().endsWith('.hwp') || previewFile.name.toLowerCase().endsWith('.hwpx');
                                const isDriveFile = previewFile.id && !previewFile.id.includes('_') && !previewFile.url?.startsWith('/attachments');
                                const isPdf = previewFile.type === 'application/pdf' || previewFile.type?.includes('pdf') || previewFile.name.toLowerCase().endsWith('.pdf');

                                if (isDriveFile && isHwp) {
                                    return <iframe src={`https://drive.google.com/file/d/${previewFile.id}/preview`} className="w-full h-full border-none" title="Document Preview" />;
                                }
                                
                                // [NEW] Image Preview Support
                                if (previewFile.type?.startsWith('image/') || previewFile.name.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/)) {
                                    let srcUrl = previewFile.url || '';
                                    if (previewFile.content && previewFile.content.startsWith('data:')) {
                                        srcUrl = previewFile.content;
                                    }
                                    return (
                                        <div className="w-full h-full bg-slate-50 flex items-center justify-center overflow-auto p-4">
                                            <img src={srcUrl} alt={previewFile.name} className="max-w-full max-h-full object-contain shadow-md rounded-lg" />
                                        </div>
                                    );
                                }

                                if (isPdf && (previewFile.content || (previewFile.url && previewFile.url !== '#' && previewFile.url !== ''))) {
                                    let srcUrl = previewFile.url || '';
                                    if (previewFile.content && previewFile.content.startsWith('data:')) {
                                        srcUrl = previewFile.content;
                                    }
                                    return (
                                        <div className="w-full h-full bg-slate-50 flex flex-col overflow-hidden">
                                            <iframe src={srcUrl} className="w-full h-full border-none" title="PDF Preview" />
                                        </div>
                                    );
                                }
                                return (
                                    <div className="flex flex-col items-center justify-center h-full bg-slate-50 text-slate-400 p-8 rounded-2xl">
                                        <p className="mb-4 font-bold text-center text-xs">미리보기를 불러올 수 없거나 지원하지 않는 형식입니다.</p>
                                        <a href={previewFile.url} download={previewFile.name} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-bold text-xs shadow-lg">
                                            <Download size={14} /> 파일 다운로드
                                        </a>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                )}
                </div>

            {/* 첨부파일 모달 렌더링 */}
            {isAttachmentModalOpen && (
                <DocumentAttachmentModal
                    isOpen={isAttachmentModalOpen}
                    onClose={() => setIsAttachmentModalOpen(false)}
                    referralId={formData.refNo || 'new-referral'}
                    currentUser={currentUser}
                    onUpdateAttachments={handleUpdateAttachments}
                    initialAttachments={formData.attachments || []}
                    folderType="referral"
                    referralName={formData.name}
                />
            )}

            {/* FilePreviewModal is now only for modal mode if needed, but we keep it here as a safety fallback or remove if we prefer purely inline. 
                Let's keep it but only trigger if NOT in workspace mode? 
                Actually, the user wants it inline, so we can hide the global modal in workspace mode.
            */}
            {mode !== 'workspace' && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

            {/* [NEW] Hidden Summary Renderer for PNG Export */}
            <div className="fixed -left-[9999px] top-0 pointer-events-none">
                <div 
                    ref={summaryRef} 
                    style={{ 
                        width: '600px', 
                        padding: '40px', 
                        background: '#ffffff',
                        fontFamily: 'sans-serif'
                    }}
                >
                    <div style={{ padding: '40px', border: '2px solid #e2e8f0', borderRadius: '16px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '30px', borderBottom: '4px solid #6366f1', paddingBottom: '15px' }}>
                            <h1 style={{ fontSize: '28px', fontWeight: '900', color: '#0f172a', margin: 0 }}>홈페이지 의뢰 상세</h1>
                            <div style={{ background: '#eef2ff', color: '#4338ca', padding: '6px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: '800' }}>홈페이지 연동 건</div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px' }}>
                            <div>
                                <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '4px' }}>대상자 성명</label>
                                <div style={{ fontSize: '18px', fontWeight: '900', color: '#1e293b' }}>{formData.name || '미상'}</div>
                            </div>
                            <div>
                                <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '4px' }}>의뢰번호</label>
                                <div style={{ fontSize: '18px', fontWeight: '900', color: '#1e293b' }}>{formData.externalIdx || '-'}</div>
                            </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px', background: '#f8fafc', padding: '15px', borderRadius: '12px' }}>
                            <div>
                                <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '4px' }}>연락처</label>
                                <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>{formData.phone || '미상'}</div>
                            </div>
                            <div>
                                <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '4px' }}>성별/연령</label>
                                <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>{formData.gender}/{formData.age}세</div>
                            </div>
                        </div>

                        <div style={{ marginBottom: '30px' }}>
                            <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '4px' }}>주소</label>
                            <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>{formData.address || '미상'}</div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '30px' }}>
                            <div style={{ background: '#fff7ed', padding: '10px', borderRadius: '8px', border: '1px solid #ffedd5' }}>
                                <label style={{ fontSize: '10px', color: '#9a3412', fontWeight: '800' }}>의료보장</label>
                                <div style={{ fontSize: '13px', fontWeight: '700', color: '#c2410c' }}>{formData.medicalInsurance || '미상'}</div>
                            </div>
                            <div style={{ background: '#f0fdf4', padding: '10px', borderRadius: '8px', border: '1px solid #dcfce7' }}>
                                <label style={{ fontSize: '10px', color: '#166534', fontWeight: '800' }}>장애여부</label>
                                <div style={{ fontSize: '13px', fontWeight: '700', color: '#15803d' }}>{formData.disabilityStatus || '미상'}</div>
                            </div>
                            <div style={{ background: '#f5f3ff', padding: '10px', borderRadius: '8px', border: '1px solid #ede9fe' }}>
                                <label style={{ fontSize: '10px', color: '#5b21b6', fontWeight: '800' }}>의뢰동의</label>
                                <div style={{ fontSize: '13px', fontWeight: '700', color: '#6d28d9' }}>{formData.consentToReferral || '미상'}</div>
                            </div>
                        </div>

                        {formData.guardianName && (
                            <div style={{ marginBottom: '30px', padding: '15px', background: '#f1f5f9', borderRadius: '12px' }}>
                                <label style={{ fontSize: '11px', color: '#475569', fontWeight: '800', display: 'block', marginBottom: '8px' }}>보호자 정보 (유무: {formData.guardianPresence})</label>
                                <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>
                                    {formData.guardianName} ({formData.guardianRelation || '관계미상'}) / {formData.guardianPhone || '연락처없음'}
                                </div>
                                {formData.guardianNotes && <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>비고: {formData.guardianNotes}</div>}
                            </div>
                        )}

                        <div style={{ marginBottom: '30px' }}>
                            <label style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', display: 'block', marginBottom: '10px', borderLeft: '3px solid #6366f1', paddingLeft: '8px' }}>의뢰 사유 및 정보</label>
                            <div style={{ fontSize: '13px', fontWeight: '700', color: '#334155', lineHeight: '1.6', background: '#f8fafc', padding: '15px', borderRadius: '12px', whiteSpace: 'pre-wrap' }}>
                                {formData.reason || '내용없음'}
                            </div>
                        </div>

                        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '700' }}>의뢰 기관/담당자</div>
                                <div style={{ fontSize: '13px', fontWeight: '800', color: '#475569' }}>{formData.agency || '미상'} / {formData.requesterName || '미상'}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '700' }}>수집 일시</div>
                                <div style={{ fontSize: '13px', fontWeight: '800', color: '#475569' }}>{new Date().toLocaleString()}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </form>
    );
};

export default ReferralEditor;

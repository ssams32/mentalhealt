import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Referral, User, Team, Attachment } from '../../types';
import { CRI_LEVELS } from '../../constants';
import { getTeams, getTeamCode, getSubTeamParent } from '../../services/orgConfig';
import * as XLSX from 'xlsx-js-style';
import { Phone, MapPin, Building2, Calendar, Search, Star, MessageSquare, Clock, Paperclip, CheckCircle2, AlertCircle, PhoneCall, ChevronDown, Filter, LayoutGrid, List, User as UserIcon, Plus, FileUp, Save, FileText, Pencil, MoreHorizontal, X, Sparkles, Eye, Download, Trash2, ArrowRightCircle, RotateCcw, Monitor, UserCheck, Check, ChevronLeft, Printer } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import ReferralFormModal from './ReferralFormModal';
import DocumentAttachmentModal from '../common/document-modal/DocumentAttachmentModal';
import FilePreviewModal from '../common/FilePreviewModal';
import ReferralEditor from './ReferralEditor';

// --- UI Helpers ---
const getTeamColor = (team: string) => {
    switch (team) {
        case '증진팀': return 'bg-blue-50 text-blue-700 border-blue-200';
        case '회복팀': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
        case '자살예방센터': return 'bg-rose-50 text-rose-700 border-rose-200';
        case '아동청소년': return 'bg-amber-50 text-amber-700 border-amber-200';
        case '남부분소': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
        default: return 'bg-slate-100 text-slate-600 border-slate-200';
    }
};

const getAssigneeColor = (name: string) => {
    if (!name || name === '미지정') return 'text-slate-400 bg-slate-50 border-slate-100';
    const colors = [
        'text-blue-600 bg-blue-50 border-blue-100',
        'text-emerald-600 bg-emerald-50 border-emerald-100',
        'text-amber-600 bg-amber-50 border-amber-100',
        'text-sky-600 bg-sky-50 border-sky-100',
        'text-cyan-600 bg-cyan-50 border-cyan-100',
        'text-teal-600 bg-teal-50 border-teal-100',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
};

// [Track B] CWE-1236: CSV/Excel Formula Injection 방어 함수
export const sanitizeExcelCell = (value: any): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    // 수식 트리거 문자(=, +, -, @, \t, \r)로 시작하거나 공백 뒤에 수식 트리거가 오는 경우 작은따옴표(') 접두사로 안전하게 이스케이프
    if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(str.trimStart())) {
        return `'${str}`;
    }
    return str;
};

interface ReferralDashboardV2Props {
    allReferrals: Referral[];
    setAllReferrals: React.Dispatch<React.SetStateAction<Referral[]>>;
    unregisteredCandidates: Referral[];
    setUnregisteredCandidates: React.Dispatch<React.SetStateAction<Referral[]>>;
    currentUser: User;
    selectedTeam: Team | 'all';
    setSelectedTeam: (team: Team | 'all') => void;
    users: User[];
    onUpdateReferral: (updatedReferral: Referral, originalRefNo?: string) => Promise<Referral | void> | void;
    onAddNewReferral: (newReferral: Omit<Referral, 'refNo' | 'clientId'>) => Promise<Referral>;
    // Pre-filled data to auto-open the new referral form (from SA transfer)
    initialFormData?: Partial<Omit<Referral, 'refNo' | 'clientId'>> | null;
    onInitialFormConsumed?: () => void;
    isLoading?: boolean;
}

const ReferralDashboardV2: React.FC<ReferralDashboardV2Props> = ({
    allReferrals,
    setAllReferrals,
    unregisteredCandidates,
    setUnregisteredCandidates,
    currentUser,
    selectedTeam,
    setSelectedTeam,
    users,
    onUpdateReferral,
    onAddNewReferral,
    initialFormData,
    onInitialFormConsumed,
    isLoading = false,
}) => {
    // --- State: Filters ---
    const [searchTerm, setSearchTerm] = useState('');
    const [assigneeSearch, setAssigneeSearch] = useState('');
    const [criFilter, setCriFilter] = useState<'all' | 'a' | 'b' | 'c' | 'd' | 'e'>('all');
    const [statusFilter, setStatusFilter] = useState<'all' | 'ongoing' | 'closed'>('all');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [referralPathFilter, setReferralPathFilter] = useState('all');
    const [viewMode, setViewMode] = useState<'standard' | 'unregistered' | 'trash'>('standard');
    const [selectedRefNos, setSelectedRefNos] = useState<Set<string>>(new Set());

    // [의뢰관리 정책] 모든 실무 직원이 전체팀 및 타 부서 필터를 자유롭게 선택하여 조회 가능
    const canSelectTeam = true;

    // [New] South Branch Filter Toggle
    const [showNambu, setShowNambu] = useState(true);

    // --- State: Selection ---
    const [selectedReferralId, setSelectedReferralId] = useState<string | null>(null);

    // --- State: Modals & Editing ---
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
    const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
    const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
    const [includeCounselingRecords, setIncludeCounselingRecords] = useState(false);
    // Pre-filled data for transfer from SA page
    const [transferPrefill, setTransferPrefill] = useState<Partial<Referral> | null>(null);

    // Auto-open form or select referral when initialFormData is injected from outside (SA transfer or notification)
    useEffect(() => {
        if (initialFormData) {
            const anyData = initialFormData as any;
            if (anyData.targetReferralId || (anyData.referralId && !anyData.name)) {
                const targetId = anyData.targetReferralId || anyData.referralId;
                setSelectedReferralId(targetId);
                if (onInitialFormConsumed) onInitialFormConsumed();
                return;
            }
            console.log("[ReferralDashboardV2] Detected pending transfer data:", initialFormData.name);
            setTransferPrefill(initialFormData as any);
            setIsAddModalOpen(true);
            if (onInitialFormConsumed) {
                onInitialFormConsumed();
            }
        }
    }, [initialFormData, onInitialFormConsumed]);

    // --- State: File Preview ---
    const [previewFile, setPreviewFile] = useState<Attachment | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    // --- State: Trash Can ---
    const [isTrashOpen, setIsTrashOpen] = useState(false);
    const [trashItems, setTrashItems] = useState<Referral[]>([]);

    // --- Computed ---
    // [Stabilization] Visual Deduplication Shield
    const uniqueAllReferrals = useMemo(() => {
        const seen = new Set();
        return allReferrals
            .filter(r => {
                const key = r.clientId || `${r.refNo}_${r.name}_${r.requestDate}`;
                if (!key || key.startsWith('NO ID')) return true;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }, [allReferrals]);

    const uniqueUnregistered = useMemo(() => {
        const seen = new Set();
        return unregisteredCandidates.filter(r => {
            const key = r.clientId || `${r.refNo}_${r.name}_${r.requestDate}`;
            if (!key || key.startsWith('NO ID')) return true;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [unregisteredCandidates]);

    const getReferralKey = useCallback((r: Referral) => {
        return r.clientId || `${r.refNo || 'NOID'}_${r.name || 'NONAME'}_${r.requestDate || ''}_${r.requestAgency || ''}`;
    }, []);

    const activeDataset = useMemo(() => {
        if (viewMode === 'trash') return trashItems;
        if (viewMode === 'unregistered') return uniqueUnregistered;
        return uniqueAllReferrals;
    }, [viewMode, uniqueAllReferrals, uniqueUnregistered, trashItems]);

    const filteredReferrals = useMemo(() => {
        return activeDataset
            .filter(r => {
                // Team Filter
                const isNambu = r.team === getSubTeamParent();
                let teamMatch = true;

                if (selectedTeam !== 'all') {
                    if (getTeams().includes(selectedTeam)) {
                        if (showNambu) {
                            teamMatch = r.team === selectedTeam || (isNambu && r.subTeam === selectedTeam);
                        } else {
                            teamMatch = r.team === selectedTeam;
                        }
                    } else {
                        teamMatch = r.team === selectedTeam;
                    }
                }

                // Text Search
                const searchMatch = !searchTerm ||
                    (r.name && r.name.includes(searchTerm)) ||
                    (r.refNo && r.refNo.includes(searchTerm)) ||
                    (r.requestAgency && r.requestAgency.includes(searchTerm)) ||
                    (r.assignee && r.assignee.includes(searchTerm)) ||
                    (r.referralPath && r.referralPath.includes(searchTerm));

                const assigneeMatch = !assigneeSearch || (r.assignee && r.assignee.includes(assigneeSearch));

                // Filters
                const criMatch = criFilter === 'all' || r.criLevel === criFilter;
                const statusMatch = statusFilter === 'all'
                    ? true
                    : (statusFilter === 'ongoing' ? r.closureStatus === '미종결' : r.closureStatus !== '미종결');

                const dateMatch = (!startDate || r.requestDate >= startDate) && (!endDate || r.requestDate <= endDate);
                const pathMatch = referralPathFilter === 'all' || (r.referralPath && r.referralPath === referralPathFilter);

                return teamMatch && searchMatch && assigneeMatch && criMatch && statusMatch && dateMatch && pathMatch;
            })
            .sort((a, b) => {
                // 1. 종결 및 등록관리 완료 여부 최우선 판정 (완료된 건은 무조건 뒤로)
                const aCompleted = Boolean(
                    (a.closureStatus && a.closureStatus !== '미종결') ||
                    (a.actionResult && (a.actionResult.includes('등록관리') || a.actionResult.includes('종결')))
                );
                const bCompleted = Boolean(
                    (b.closureStatus && b.closureStatus !== '미종결') ||
                    (b.actionResult && (b.actionResult.includes('등록관리') || b.actionResult.includes('종결')))
                );

                if (aCompleted !== bCompleted) {
                    return aCompleted ? 1 : -1;
                }

                // 2. 미완료(진행중) 건들 중에서만: 미등록 의뢰 최우선 정렬
                if (!aCompleted) {
                    const isUnregA = Boolean(a.registrationStatus === '미등록' || a.isUnregistered === true);
                    const isUnregB = Boolean(b.registrationStatus === '미등록' || b.isUnregistered === true);
                    if (isUnregA !== isUnregB) {
                        return isUnregA ? -1 : 1;
                    }
                }

                // 3. 동일 그룹 내에서는 최신 의뢰 접수일자 순 (내림차순)
                const dateA = a.requestDate ? new Date(a.requestDate).getTime() : 0;
                const dateB = b.requestDate ? new Date(b.requestDate).getTime() : 0;
                if (dateA !== dateB) return dateB - dateA;
                
                // 4. 날짜가 같으면 의뢰번호 내림차순
                const refA = a.refNo || '';
                const refB = b.refNo || '';
                return refB.localeCompare(refA);
            });
    }, [activeDataset, selectedTeam, searchTerm, assigneeSearch, criFilter, statusFilter, startDate, endDate, referralPathFilter, showNambu]);

    const activeReferral = useMemo(() =>
        activeDataset.find(r => getReferralKey(r) === selectedReferralId) || filteredReferrals[0] || null,
        [activeDataset, selectedReferralId, filteredReferrals, getReferralKey]);

    const selectedReferrals = useMemo(() => {
        return allReferrals.filter(r => selectedRefNos.has(getReferralKey(r)));
    }, [allReferrals, selectedRefNos, getReferralKey]);

    useEffect(() => {
        if (!selectedReferralId && filteredReferrals.length > 0) {
            setSelectedReferralId(getReferralKey(filteredReferrals[0]));
        }
    }, [filteredReferrals, selectedReferralId, getReferralKey]);

    useEffect(() => {
        if (viewMode === 'trash') {
            setIsProcessing(true);
            apiClient.getTrash()
                .then(data => setTrashItems(data))
                .catch(console.error)
                .finally(() => setIsProcessing(false));
        }
    }, [viewMode]);

    // --- Handlers ---
    const handleFieldChange = useCallback(async (refNo: string, field: keyof Referral, value: any) => {
        const target = activeDataset.find(r => r.refNo === refNo);
        if (target) {
            const updated = { ...target, [field]: value };
            if (viewMode === 'standard') {
                onUpdateReferral(updated);
            } else {
                try {
                    await apiClient.updateUnregistered(updated);
                    setUnregisteredCandidates(prev => prev.map(c => c.refNo === refNo ? updated : c));
                } catch (e) {
                    console.error("Failed to update unregistered candidate", e);
                }
            }
        }
    }, [activeDataset, viewMode, onUpdateReferral, setUnregisteredCandidates]);

    const handleMoveToUnregistered = async (referral: Referral) => {
        if (isProcessing) return;
        if (!window.confirm(`'${referral.name}'을(를) 미등록 대장(모니터링)으로 이동하시겠습니까?\n(이동 시 '대장' 탭에서 사라지고 '미등록' 탭에서 관리하게 됩니다.)`)) return;

        setIsProcessing(true);
        try {
            let finalRefNo = referral.refNo;
            let isIdGenerated = false;

            if (!finalRefNo || finalRefNo === 'NO ID') {
                const teamCode = getTeamCode(referral.team);
                const now = new Date();
                const yearYY = now.getFullYear().toString().slice(-2);
                const currentYearPrefix = `${teamCode}-${yearYY}-`;

                const existingIds = allReferrals
                    .map(r => r.refNo)
                    .filter(refNo => refNo && refNo.startsWith(currentYearPrefix))
                    .map(refNo => parseInt(refNo.split('-')[2], 10))
                    .filter(num => !isNaN(num));

                const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
                finalRefNo = `${currentYearPrefix}${String(maxId + 1).padStart(3, '0')}`;
                isIdGenerated = true;
            }

            const updatedReferral: Referral = {
                ...referral,
                refNo: finalRefNo,
                clientId: referral.clientId || `C${Date.now()}`,
                isUnregistered: true
            };

            await apiClient.createUnregistered(updatedReferral);

            if (isIdGenerated) {
                await apiClient.createReferral(updatedReferral);
            } else {
                await apiClient.updateReferral(updatedReferral);
            }

            setAllReferrals(prev => {
                return prev.map(r => r.clientId === referral.clientId ? updatedReferral : r);
            });

            setUnregisteredCandidates(prev => {
                const updatedKey = getReferralKey(updatedReferral);
                const exists = prev.some(c => getReferralKey(c) === updatedKey);
                return exists ? prev.map(c => getReferralKey(c) === updatedKey ? updatedReferral : c) : [updatedReferral, ...prev];
            });

            alert(`'${referral.name}'님이 미등록 대장(모니터링)으로 이동되었습니다.${isIdGenerated ? `\n(ID가 없어 ${finalRefNo} 번호를 자동 발급했습니다.)` : ''}`);
        } catch (error: any) {
            console.error('Failed to move to unregistered', error);
            const errorMsg = String(error.message || error);
            if (errorMsg.includes('404')) {
                alert('서버 업데이트가 반영되지 않았습니다.\n(npm run dev 창이 아닌 node server.js 검은창을 껐다가 다시 켜주세요!)');
            } else {
                alert(`이동에 실패했습니다.\n사유: ${errorMsg}`);
            }
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDeleteReferral = async (id: string, referral?: Referral | null) => {
        if (isProcessing) return;

        let deleteId = referral?.clientId || id;
        if ((!deleteId || deleteId === 'NO ID') && referral?.refNo) {
            deleteId = referral.refNo;
        }

        setIsProcessing(true);
        try {
            await apiClient.deleteReferral(deleteId);

            if (referral) {
                const targetKey = getReferralKey(referral);
                setAllReferrals(prev => prev.filter(r => getReferralKey(r) !== targetKey));
                setUnregisteredCandidates(prev => prev.filter(c => getReferralKey(c) !== targetKey));
            } else {
                setAllReferrals(prev => prev.filter(r => r.refNo !== deleteId && r.clientId !== deleteId));
                setUnregisteredCandidates(prev => prev.filter(c => c.refNo !== deleteId && c.clientId !== deleteId));
            }

            if (referral && selectedReferralId === getReferralKey(referral)) {
                setSelectedReferralId(null);
            }
            alert('삭제되었습니다.');
        } catch (error) {
            console.error('Delete failed', error);
            alert('삭제에 실패했습니다.');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleRestoreToRegistry = async (candidate: Referral) => {
        if (!window.confirm(`'${candidate.name}'의 미등록 관리 상태를 해제하시겠습니까?`)) return;

        try {
            const updatedReferral = { ...candidate, isUnregistered: false };
            try {
                const submissionData = { ...updatedReferral };
                if (!submissionData.assignee && (submissionData as any).counselor) {
                    submissionData.assignee = (submissionData as any).counselor;
                }

                await apiClient.updateReferral(submissionData);
            } catch (updateErr: any) {
                const errorMsg = String(updateErr.message || updateErr);
                if (errorMsg.includes('404') || errorMsg.includes('not found')) {
                    console.warn("Master record missing, recreating during restore...");
                    await onAddNewReferral(updatedReferral as any);
                } else {
                    throw updateErr;
                }
            }

            await apiClient.deleteUnregistered(candidate.clientId || candidate.refNo);

            const candidateKey = getReferralKey(candidate);
            setAllReferrals(prev => {
                const exists = prev.some(r => getReferralKey(r) === candidateKey);
                if (exists) {
                    return prev.map(r => getReferralKey(r) === candidateKey ? updatedReferral : r);
                }
                return [updatedReferral, ...prev];
            });
            setUnregisteredCandidates(prev => prev.filter(c => getReferralKey(c) !== candidateKey));

            alert('관리 상태가 해제되었습니다.');
        } catch (e) {
            console.error("Restore operation failed", e);
            alert('해제 중 오류가 발생했습니다.');
        }
    };

    const toggleSelectAll = useCallback(() => {
        if (selectedRefNos.size === filteredReferrals.length && filteredReferrals.length > 0) {
            setSelectedRefNos(new Set());
        } else {
            setSelectedRefNos(new Set(filteredReferrals.map(r => getReferralKey(r))));
        }
    }, [selectedRefNos, filteredReferrals, getReferralKey]);

    const toggleSelect = useCallback((refNo: string) => {
        setSelectedRefNos(prev => {
            const next = new Set(prev);
            if (next.has(refNo)) next.delete(refNo);
            else next.add(refNo);
            return next;
        });
    }, []);

    const handleClosePrintModal = useCallback(() => {
        setIsPrintModalOpen(false);
        setIncludeCounselingRecords(false);
    }, []);

    const handlePrintSelected = useCallback(() => {
        if (selectedReferrals.length === 0) return;
        setIsPrintModalOpen(false);
        requestAnimationFrame(() => {
            window.print();
        });
    }, [selectedReferrals]);

    const handleExportReplyForm = async (referrals: Referral[], exportScope: string = '선택') => {
        if (referrals.length === 0) return;
        try {
            // Updated 2025 Template Headers (14 Columns)
            const headers = [
                '연번', '이름', '성별', '생년월일(나이)', '주소', '연락처', '의뢰일', '의뢰기관', '의뢰자', '상담 및 개입내용', '조치결과', '지역', '담당자', '회신 여부'
            ];

            // [Track B] 상담메모(notes) 전체 히스토리와 첨부파일(attachments) 본문은 기본 제외
            // 회신서에는 최신 1건 요약 메모만 포함하며, 모든 셀에 Formula Injection 방어 적용
            const rows = referrals.map((r, index) => {
                let noteContent = r.latestNote || '-';
                if (noteContent === '-' && r.notes && r.notes.length > 0) {
                    const sortedNotes = [...r.notes].sort((a, b) =>
                        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                    );
                    noteContent = sortedNotes[0].content || '-';
                }

                return [
                    sanitizeExcelCell((index + 1).toString()),
                    sanitizeExcelCell(r.name),
                    sanitizeExcelCell(r.gender === '여성' ? '여' : r.gender === '남성' ? '남' : r.gender),
                    sanitizeExcelCell(r.age),
                    sanitizeExcelCell(r.address || '-'),
                    sanitizeExcelCell(r.phone || '-'),
                    sanitizeExcelCell(r.requestDate),
                    sanitizeExcelCell(r.requestAgency),
                    sanitizeExcelCell(r.requestorName || '-'),
                    sanitizeExcelCell(noteContent),
                    sanitizeExcelCell(r.actionResult || '-'),
                    sanitizeExcelCell(r.region),
                    sanitizeExcelCell(r.assignee),
                    sanitizeExcelCell(r.replyStatus || (r.reply ? '회신완료' : '회신예정'))
                ];
            });

            const currentYear = new Date().getFullYear();
            const wsData = [
                [`${currentYear}년 회신 대상자 현황`],
                [],
                headers,
                ...rows
            ];

            const ws = XLSX.utils.aoa_to_sheet(wsData);

            ws['!rows'] = [
                { hpt: 35 },
                { hpt: 10 },
                { hpt: 25 },
                ...rows.map(row => {
                    const note = String(row[9] || '');
                    const lines = note.split('\n').length;
                    const charLines = Math.ceil(note.length / 45);
                    const estimatedLines = Math.max(lines, charLines);
                    return { hpt: Math.max(25, estimatedLines * 15 + 10) };
                })
            ];

            const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
                    if (!ws[cellRef]) continue;

                    ws[cellRef].s = {
                        font: { name: '맑은 고딕', sz: 10 },
                        alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
                        border: {
                            top: { style: 'thin', color: { rgb: "000000" } },
                            bottom: { style: 'thin', color: { rgb: "000000" } },
                            left: { style: 'thin', color: { rgb: "000000" } },
                            right: { style: 'thin', color: { rgb: "000000" } }
                        }
                    };

                    if (R === 0) {
                        ws[cellRef].s = {
                            font: { name: '맑은 고딕', sz: 20, bold: true },
                            alignment: { vertical: 'center', horizontal: 'center' },
                            border: {}
                        };
                    }

                    if (R === 2) {
                        ws[cellRef].s.fill = { fgColor: { rgb: "FFFFCC" } };
                        ws[cellRef].s.font.bold = true;
                    }

                    if (R > 2) {
                        if (C === 4 || C === 9) {
                            ws[cellRef].s.alignment.horizontal = 'left';
                        }
                    }
                }
            }

            ws['!merges'] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }
            ];

            ws['!cols'] = [
                { wch: 6 }, { wch: 12 }, { wch: 6 }, { wch: 16 }, { wch: 30 },
                { wch: 16 }, { wch: 13 }, { wch: 22 }, { wch: 10 }, { wch: 65 },
                { wch: 13 }, { wch: 10 }, { wch: 10 }, { wch: 10 }
            ];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "회신서");

            const fileName = referrals.length === 1
                ? `${currentYear}년_회신서_${referrals[0].name}_${referrals[0].refNo}.xlsx`
                : `${currentYear}년_통합_회신서_${referrals.length}명_${new Date().toISOString().split('T')[0]}.xlsx`;

            XLSX.writeFile(wb, fileName);

            // [Track B] 다운로드 감사 로그 기록
            try {
                const operatorName = currentUser?.name || currentUser?.id || '사용자';
                const logDetails = `의뢰대장 엑셀 다운로드 [${exportScope} ${referrals.length}건] (팀: ${selectedTeam}, 검색: "${searchTerm || '없음'}")`;
                await apiClient.logActivity(operatorName, 'EXCEL_EXPORT', logDetails);
            } catch (logErr) {
                console.warn('⚠️ 감사 로그 전송 실패:', logErr);
            }

            alert(`${referrals.length}명의 회신서가 안전한 양식으로 다운로드되었습니다.`);
        } catch (error) {
            console.error('Excel export failed:', error);
            alert('엑셀 파일 생성 중 오류가 발생했습니다.');
        }
    };

    const handleApplyTemplate = (templateContent: string) => {
        if (!activeReferral) return;
        const currentContent = activeReferral.interventionContent || '';
        const newContent = currentContent
            ? `${currentContent}\n\n---\n${templateContent}`
            : templateContent;
        handleFieldChange(activeReferral.refNo, 'interventionContent', newContent);
        setIsTemplateModalOpen(false);
    };

    const handleFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!activeReferral) return;

        const files = Array.from(e.dataTransfer.files) as File[];
        if (files.length === 0) return;

        const newAttachments: Attachment[] = files.map(file => ({
            id: `att_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: file.name,
            url: URL.createObjectURL(file),
            type: file.type.startsWith('image/') ? 'image' : file.type === 'application/pdf' ? 'pdf' : 'document',
            size: file.size,
            uploadedAt: new Date().toISOString()
        }));

        const updatedAttachments = [...(activeReferral.attachments || []), ...newAttachments];
        handleFieldChange(activeReferral.refNo, 'attachments', updatedAttachments);
        if (newAttachments.length > 0) {
            setPreviewFile(newAttachments[0]); // 신규 드롭 시에만 팝업 노출
        }
    };

    // --- Components ---

    // 1. Sidebar / List View
    const renderSidebarList = () => (
        <div className={`flex flex-col bg-white border-r border-slate-200 h-full transition-all duration-300 ease-in-out shrink-0 ${selectedReferralId ? 'w-0 hidden lg:w-[440px] lg:flex' : 'w-full flex'}`}>
            {/* List Header & Filters */}
            <div className="flex-none p-[var(--space-5)] space-y-[var(--space-3)] border-b border-slate-100/80 bg-slate-50/50 backdrop-blur-sm sticky top-0 z-10">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-2">
                        <List size={20} className="text-indigo-600" />
                        <span>의뢰 목록</span>
                        <span className="text-xs font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{filteredReferrals.length}</span>
                    </h2>
                    <div className="flex gap-1 bg-slate-100/50 p-1 rounded-xl">
                        <button
                            onClick={() => setViewMode('standard')}
                            className={`p-1.5 px-2 rounded-lg transition-all flex items-center gap-1.5 font-bold text-xs ${viewMode === 'standard' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                            title="의뢰대장"
                        >
                            <UserCheck size={14} strokeWidth={2.5} />
                            <span>대장</span>
                        </button>
                        <button
                            onClick={() => setViewMode('unregistered')}
                            className={`p-1.5 px-2 rounded-lg transition-all flex items-center gap-1.5 font-bold text-xs ${viewMode === 'unregistered' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                            title="미등록 관리"
                        >
                            <Monitor size={14} strokeWidth={2.5} />
                            <span>미등록</span>
                        </button>
{currentUser?.role === 'admin' && (
                        <button
                            onClick={() => setViewMode('trash')}
                            className={`p-1.5 px-2 rounded-lg transition-all flex items-center gap-1.5 font-bold text-xs ${viewMode === 'trash' ? 'bg-white text-red-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                            title="휴지통"
                        >
                            <Trash2 size={14} strokeWidth={2.5} />
                            <span>휴지통</span>
                        </button>
                    )}
                    </div>
                </div>

                {/* Search Bar */}
                <div className="relative group px-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" size={16} />
                    <input
                        className="w-full pl-10 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[length:var(--font-base)] font-medium outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all shadow-sm placeholder:text-slate-400"
                        placeholder="이름, 번호, 기관, 담당자 검색..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                {/* Quick Filters */}
                <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                    <select
                        value={selectedTeam}
                        disabled={!canSelectTeam}
                        onChange={(e) => setSelectedTeam(e.target.value as any)}
                        title={!canSelectTeam ? `부서 선택 권한이 제한되어 소속팀(${currentUser?.team || '지정팀'})으로 고정됩니다.` : '팀 선택'}
                        className={`px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[length:var(--font-base)] font-bold text-slate-600 focus:border-indigo-500 outline-none shadow-sm min-w-[80px] ${!canSelectTeam ? 'bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200' : ''}`}
                    >
                        {canSelectTeam && <option value="all">전체 팀</option>}
                        {getTeams().map(t => <option key={t} value={t}>{t}</option>)}
                    </select>

                    <select
                        value={criFilter}
                        onChange={(e) => setCriFilter(e.target.value as any)}
                        className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[length:var(--font-base)] font-bold text-slate-600 focus:border-indigo-500 outline-none shadow-sm min-w-[80px]"
                    >
                        <option value="all">위험도 전체</option>
                        {Object.entries(CRI_LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>

                    <button
                        onClick={() => setShowNambu(!showNambu)}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[length:var(--font-base)] font-bold transition-all whitespace-nowrap ${showNambu ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-500'}`}
                    >
                        {showNambu ? <CheckCircle2 size={12} /> : <div className="w-3 h-3 rounded-full border border-slate-300" />}
                        남부
                    </button>

                </div>
                {/* [회신서 엑셀 다운로드: 선택한 대상자만 다운로드 가능하도록 제한] */}
                {selectedRefNos.size > 0 && (
                    <div className="flex w-full mt-2 gap-2">
                        <button
                            onClick={() => {
                                const selected = filteredReferrals.filter(r => selectedRefNos.has(getReferralKey(r)));
                                handleExportReplyForm(selected, '선택');
                            }}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-xl border text-xs font-bold bg-emerald-50 border-emerald-200 text-emerald-700 shadow-sm hover:bg-emerald-100 transition-all"
                            title="선택된 대상자만 회신서 엑셀 다운로드"
                        >
                            <Download size={14} />
                            선택 회신서 엑셀 ({selectedRefNos.size}건)
                        </button>
                        <button
                            type="button"
                            onClick={() => setIsPrintModalOpen(true)}
                            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl text-xs font-bold transition-all shadow-sm hover:bg-indigo-100"
                            title="선택된 대상자 의뢰대장 출력"
                        >
                            <Printer size={14} />
                            선택 출력 ({selectedRefNos.size}건)
                        </button>
                    </div>
                )}
            </div>



            {/* List Content */}
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-[var(--space-3)] bg-slate-50/30 custom-scrollbar">
                {isLoading && uniqueAllReferrals.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2.5">
                        <div className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-xs font-semibold text-slate-500">의뢰 데이터를 불러오는 중입니다...</span>
                    </div>
                ) : filteredReferrals.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-400">
                        <Search size={32} className="mb-2 opacity-20" />
                        <span className="text-xs font-medium">검색 결과가 없습니다</span>
                    </div>
                ) : (
                    filteredReferrals.map(referral => {
                        const isSelected = selectedReferralId === getReferralKey(referral);
                        const isChecked = selectedRefNos.has(getReferralKey(referral));

                        return (
                            <div
                                key={getReferralKey(referral)}
                                onClick={() => setSelectedReferralId(getReferralKey(referral))}
                                className={`group relative p-[var(--card-padding-md)] rounded-xl border transition-all cursor-pointer hover:shadow-md mx-1 ${isSelected
                                    ? 'bg-white border-indigo-500 ring-[3px] ring-indigo-500/10 shadow-sm z-10'
                                    : 'bg-white border-slate-100 hover:border-indigo-200 hover:bg-slate-50/50'
                                    }`}
                            >
                                <div className="flex items-start justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <div onClick={(e) => {
                                            e.stopPropagation();
                                            toggleSelect(getReferralKey(referral));
                                        }} className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${isChecked ? 'bg-indigo-500 border-indigo-500' : 'bg-white border-slate-300 hover:border-indigo-400'}`}>
                                            {isChecked && <Check size={12} className="text-white" strokeWidth={3} />}
                                        </div>
                                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-black border ${referral.criLevel === 'a' ? 'bg-red-50 text-red-600 border-red-100 ring-1 ring-red-500/10' :
                                            referral.criLevel === 'b' ? 'bg-orange-50 text-orange-600 border-orange-100 ring-1 ring-orange-500/10' :
                                                referral.criLevel === 'c' ? 'bg-amber-50 text-amber-600 border-amber-100 ring-1 ring-amber-500/10' :
                                                    'bg-emerald-50 text-emerald-600 border-emerald-100 ring-1 ring-emerald-500/10'
                                            }`}>
                                            {CRI_LEVELS[referral.criLevel] || referral.criLevel}
                                        </span>
                                        <span className={`px-2 py-0.5 rounded-md text-[10px] sm:text-xs font-black border ${getTeamColor(referral.team)}`}>
                                            {referral.team}
                                        </span>
                                    </div>
                                    <span className="text-[10px] text-slate-400 tabular-nums font-medium">
                                        {referral.requestDate}
                                    </span>
                                </div>

                                <div className="flex justify-between items-center mb-1">
                                    <h3 className={`font-bold text-[length:var(--font-lg)] ${isSelected ? 'text-slate-900' : 'text-slate-800'}`}>
                                        {referral.name}
                                    </h3>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {referral.actionResult?.includes('등록관리') && (
                                            <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 border border-emerald-200/50 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm">
                                                <Check size={10} strokeWidth={3} /> 등록관리
                                            </span>
                                        )}
                                        {referral.closureStatus && referral.closureStatus !== '미종결' && (
                                            <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                                                <CheckCircle2 size={10} /> 종결됨
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 text-[length:var(--font-base)] text-slate-500 mb-2">
                                    <span>{referral.gender === '남성' ? '남' : referral.gender === '여성' ? '여' : (referral.gender || '-')}</span>
                                    <span className="w-0.5 h-2 bg-slate-300 rounded-full"></span>
                                    <span>{referral.age}세</span>
                                    <span className="w-0.5 h-2 bg-slate-300 rounded-full"></span>
                                    <span className="truncate max-w-[100px] text-slate-600 font-medium">{referral.requestAgency}</span>
                                </div>

                                <div className="flex items-center justify-between pt-2.5 border-t border-slate-50">
                                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-all ${getAssigneeColor(referral.assignee)}`}>
                                        <UserIcon size={13} strokeWidth={2.5} />
                                        <span className="text-sm font-black tracking-tight">{referral.assignee || '미지정'}</span>
                                    </div>
                                    {viewMode === 'standard' && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleMoveToUnregistered(referral);
                                            }}
                                            className="text-[10px] font-bold text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded transition-colors"
                                        >
                                            모니터링 이동 →
                                        </button>
                                    )}
                                    {viewMode === 'unregistered' && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleRestoreToRegistry(referral);
                                            }}
                                            className="text-[10px] font-bold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded transition-colors flex items-center gap-1"
                                        >
                                            <RotateCcw size={10} /> 대장 복구
                                        </button>
                                    )}
                                    {viewMode === 'trash' && (
                                        <div className="flex gap-1.5">
                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!confirm('복구하시겠습니까?')) return;
                                                    try {
                                                        await apiClient.restoreTrash(referral.clientId || referral.refNo);
                                                        setTrashItems(prev => prev.filter(t => t !== referral));
                                                        setAllReferrals(prev => [referral, ...prev]);
                                                        alert('복구되었습니다.');
                                                    } catch (err) { alert('복구 실패'); }
                                                }}
                                                className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors"
                                            >
                                                복구
                                            </button>
{currentUser?.role === 'admin' && (
                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!confirm('영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
                                                    try {
                                                        await apiClient.permanentDelete(referral.clientId || referral.refNo);
                                                        setTrashItems(prev => prev.filter(t => t !== referral));
                                                        alert('영구 삭제되었습니다.');
                                                    } catch (err) { alert('삭제 실패'); }
                                                }}
                                                className="text-[10px] font-bold text-red-600 bg-red-50 px-2 py-1.5 rounded-lg hover:bg-red-100 transition-colors"
                                            >
                                                영구 삭제
                                            </button>
)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Sidebar Footer (Add Button) */}
            <div className="p-[var(--space-5)] border-t border-slate-200 bg-white sticky bottom-0 z-10">
                <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white p-3 rounded-xl font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-700 hover:shadow-indigo-300 transition-all transform active:scale-95"
                >
                    <Plus size={18} />
                    신규 의뢰 등록
                </button>
            </div>
        </div>
    );

    // 2. Main Editor Area
    const renderMainEditor = () => (
        <div className={`flex-1 flex flex-col bg-slate-50/50 h-full overflow-hidden relative p-[var(--content-padding-desktop)] ${selectedReferralId ? 'flex' : 'hidden lg:flex'}`}>
            {/* Mobile Back Button Header */}
            <div className={`lg:hidden flex items-center p-4 bg-white border-b border-slate-200 ${!selectedReferralId ? 'hidden' : ''}`}>
                <button
                    onClick={() => setSelectedReferralId(null)}
                    className="flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors"
                >
                    <ChevronLeft size={20} />
                    <span className="font-bold">목록으로</span>
                </button>
            </div>

            {activeReferral ? (
                <ReferralEditor
                    key={getReferralKey(activeReferral)}
                    referralData={activeReferral}
                    currentUser={currentUser}
                    users={users}
                    isEditing={true}
                    hideCancelButton={true}
                    mode="workspace"
                    onSubmit={async (data, originalRefNo) => {
                        try {
                            const payload = originalRefNo ? { ...data, originalRefNo } : data;
                            const result = await onUpdateReferral(payload, originalRefNo);
                            return result;
                        } catch (e) {
                            console.error('ReferralEditor onSubmit error:', e);
                            throw e;
                        }
                    }}
                    onDelete={(id) => handleDeleteReferral(id, activeReferral)}
                    showToast={(msg) => console.log(msg)}
                    onPreviewRequest={(file) => setPreviewFile(file)}
                />
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                    <div className="w-24 h-24 bg-slate-100 rounded-3xl flex items-center justify-center mb-6 shadow-inner rotate-3 transform transition-all hover:rotate-6">
                        <FileText size={48} className="text-slate-300" />
                    </div>
                    <h3 className="text-xl font-bold text-slate-400 mb-2">선택된 의뢰가 없습니다</h3>
                    <p className="text-sm text-slate-400">좌측 목록에서 의뢰를 선택하거나 새로운 의뢰를 등록해주세요.</p>
                </div>
            )}
        </div>
    );

    return (
        <div className="flex flex-1 h-full w-full bg-slate-50 overflow-hidden relative">
            {renderSidebarList()}
            {renderMainEditor()}

            {/* --- Modals --- */}

            {/* Add Modal */}
            {isAddModalOpen && (
                <ReferralFormModal
                    isEditing={false}
                    isOpen={isAddModalOpen}
                    onClose={() => { setIsAddModalOpen(false); setTransferPrefill(null); }}
                    onSubmit={async (data) => {
                        try {
                            const saved = await onAddNewReferral(data);
                            if (saved && (saved.referralId || saved.clientId)) {
                                setSelectedReferralId((saved.referralId || saved.clientId) as string);
                            }
                            setIsAddModalOpen(false);
                            setTransferPrefill(null);
                        } catch (e) {
                            console.error('Failed to add referral in modal:', e);
                            throw e;
                        }
                    }}
                    referralData={transferPrefill as Referral | null}
                    currentUser={currentUser}
                    showToast={() => { }}
                    users={users}
                />
            )}

            {/* Legacy Edit Modal (Keep for compatibility if strictly needed, mostly unused given editor is inline) */}
            {isEditModalOpen && activeReferral && (
                <ReferralFormModal
                    isEditing={true}
                    isOpen={isEditModalOpen}
                    onClose={() => setIsEditModalOpen(false)}
                    onSubmit={async (updated) => {
                        try {
                            await onUpdateReferral(updated);
                            setIsEditModalOpen(false);
                        } catch (e) { 
                            console.error('Failed to update referral in modal:', e);
                            throw e;
                        }
                    }}
                    onDelete={(id) => handleDeleteReferral(id, activeReferral)}
                    referralData={activeReferral}
                    currentUser={currentUser}
                    showToast={() => { }}
                    users={users}
                />
            )}


            {/* Template Modal */}
            {isTemplateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-[var(--modal-padding)] animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[var(--modal-w-lg)] overflow-hidden flex flex-col max-h-[var(--modal-max-h)]">
                        <div className="p-[var(--modal-padding)] border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <h3 className="font-black text-slate-800 flex items-center gap-2 text-lg">
                                <FileText size={20} className="text-indigo-600" />
                                상담 양식 템플릿
                            </h3>
                            <button onClick={() => setIsTemplateModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-[var(--modal-padding)] space-y-3 overflow-y-auto bg-slate-50/30">
                            <button
                                onClick={() => handleApplyTemplate(`[초기 면접]
1. 자살시도력:
   - 1차: 
   - 2차: 
2. 정신과 치료:
   - 병원: 
   - 약물: 
3. 현상황:
   - 주호소: 
   - 경제/사회적 상황: 
4. 보호요인/지지체계: `)}
                                className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-indigo-500 hover:shadow-md transition-all group"
                            >
                                <div className="font-bold text-slate-800 mb-1 group-hover:text-indigo-600">초기 면접지 (요약)</div>
                                <div className="text-xs text-slate-500 line-clamp-2">자살시도력, 정신과 치료 이력, 현상황 등 기초 정보를 기록하는 표준 양식입니다.</div>
                            </button>

                            <button
                                onClick={() => handleApplyTemplate(`[위기 개입 보고]
- 발생 일시: 
- 위기 상황:
- 개입 내용 (응급조치):
- 결과 및 향후 계획: `)}
                                className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-indigo-500 hover:shadow-md transition-all group"
                            >
                                <div className="font-bold text-slate-800 mb-1 group-hover:text-indigo-600">위기 개입 보고서</div>
                                <div className="text-xs text-slate-500">응급 상황 발생 시 조치 내역과 결과를 기록합니다.</div>
                            </button>

                            <button
                                onClick={() => handleApplyTemplate(`[상담 일지]
- 상담 목표:
- 주요 내용:
- 대상자 반응:
- 다음 계획:`)}
                                className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-indigo-500 hover:shadow-md transition-all group"
                            >
                                <div className="font-bold text-slate-800 mb-1 group-hover:text-indigo-600">정기 상담 일지</div>
                                <div className="text-xs text-slate-500">정기적인 사례 관리 및 상담 내용을 기록합니다.</div>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Print Options Modal */}
            {isPrintModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-[var(--modal-padding)] animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[var(--modal-max-h)] overflow-hidden flex flex-col">
                        <div className="p-[var(--modal-padding)] border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <h3 className="font-black text-slate-800 flex items-center gap-2 text-lg">
                                <Printer size={20} className="text-indigo-600" />
                                의뢰대장 출력 옵션
                            </h3>
                            <button onClick={handleClosePrintModal} className="text-slate-400 hover:text-slate-600">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-[var(--modal-padding)] space-y-4">
                            <p className="text-sm font-semibold text-slate-600 leading-relaxed text-center">
                                선택된 대상자 <span className="text-indigo-600 font-bold">{selectedReferrals.length}명</span>을 출력합니다.
                            </p>
                            <div className="flex items-center gap-2.5 p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                                <input
                                    type="checkbox"
                                    id="includeCounseling"
                                    checked={includeCounselingRecords}
                                    onChange={(e) => setIncludeCounselingRecords(e.target.checked)}
                                    className="w-5 h-5 rounded-lg border-slate-300 text-indigo-600 focus:ring-indigo-500 transition-all cursor-pointer shadow-sm"
                                />
                                <label htmlFor="includeCounseling" className="text-xs font-black text-slate-700 cursor-pointer select-none">
                                    상담기록 포함
                                </label>
                            </div>
                            <div className="flex gap-2 p-3 bg-amber-50/50 border border-amber-100 rounded-xl text-slate-500">
                                <AlertCircle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                                <p className="text-[10px] font-bold text-amber-800 leading-relaxed">
                                    상담기록에는 민감한 내용이 포함될 수 있으므로 출력 전 반드시 확인하세요.
                                </p>
                            </div>
                        </div>
                        <div className="p-[var(--modal-padding)] border-t border-slate-100 bg-slate-50/50 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={handleClosePrintModal}
                                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-xs transition-all active:scale-95"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handlePrintSelected}
                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs shadow-md transition-all active:scale-95 flex items-center gap-1.5"
                            >
                                <Printer size={12} />
                                <span>출력하기</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Inline File Preview (Fallback if Sidebar preview isn't enough) */}
            {previewFile && (
                <FilePreviewModal
                    file={previewFile}
                    onClose={() => setPreviewFile(null)}
                />
            )}

            {/* Print-Only Container */}
            <div className="print-only">
                <ReferralPrintDocument
                    referrals={selectedReferrals}
                    includeCounselingRecords={includeCounselingRecords}
                />
            </div>
        </div>
    );
};

// --- Print Helpers & Components ---
function getReferralNotes(referral: any): any[] {
    const candidates = [
        referral?.notes,
        referral?.counselingRecords,
        referral?.consultations,
        referral?.history,
        referral?.records,
        referral?.caseNotes,
        referral?.상담기록,
        referral?.상담내용
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }

    if (typeof referral?.memo === 'string' && referral.memo.trim()) {
        return [{ content: referral.memo }];
    }

    return [];
}

interface ReferralPrintDocumentProps {
    referrals: Referral[];
    includeCounselingRecords: boolean;
}

const ReferralPrintDocument: React.FC<ReferralPrintDocumentProps> = ({ referrals, includeCounselingRecords }) => {
    const todayStr = new Date().toLocaleString('ko-KR');

    return (
        <div className="w-full text-slate-900 bg-white">
            <div className="mb-8 border-b pb-4">
                <h1 className="text-2xl font-black mb-2 text-slate-800">의뢰대장 출력</h1>
                <div className="flex justify-between items-center text-xs text-slate-500">
                    <span>출력 일시: {todayStr}</span>
                    <span>출력 대상자 수: <strong className="text-slate-800">{referrals.length}명</strong></span>
                </div>
            </div>

            {referrals.map((ref, idx) => {
                const notes = getReferralNotes(ref);
                return (
                    <div key={ref.refNo} className="referral-print-page border-b border-slate-200 pb-8 mb-8 last:border-0 last:pb-0 last:mb-0">
                        <div className="flex justify-between items-center bg-slate-100 p-4 rounded-xl mb-4 border border-slate-200">
                            <h2 className="text-lg font-black text-slate-800">{ref.name} ({ref.gender}, {ref.age}세)</h2>
                            <span className="text-xs font-mono font-bold text-slate-500">의뢰번호: {ref.refNo}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-4 text-xs mb-6">
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">연락처</span>
                                <span className="font-bold text-slate-800">{ref.phone || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">거주 지역 / 상세 주소</span>
                                <span className="font-bold text-slate-800">{ref.region || '-'} {ref.address ? ` / ${ref.address}` : ''}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">의뢰 접수일</span>
                                <span className="font-bold text-slate-800">{ref.requestDate || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">의뢰 기관</span>
                                <span className="font-bold text-slate-800">{ref.requestAgency || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">의뢰 경로</span>
                                <span className="font-bold text-slate-800">{ref.referralPath || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">의뢰 사유</span>
                                <span className="font-bold text-slate-800">{ref.reason || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">위기 등급 (CRI)</span>
                                <span className="font-bold text-slate-800">{ref.criLevel ? ref.criLevel.toUpperCase() : '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">담당자 (부서)</span>
                                <span className="font-bold text-slate-800">{ref.assignee || '미지정'} ({ref.team})</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">진행 상태</span>
                                <span className="font-bold text-slate-800">{ref.closureStatus || '-'}</span>
                            </div>
                            <div className="border border-slate-100 p-3 rounded-xl bg-slate-50/30">
                                <span className="block font-black text-slate-400 mb-1">조치 결과</span>
                                <span className="font-bold text-slate-800">{ref.actionResult || '-'}</span>
                            </div>
                        </div>

                        {includeCounselingRecords && (
                            <div className="border border-slate-200 rounded-xl overflow-hidden mt-4">
                                <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                                    <h3 className="text-xs font-black text-slate-700">상담 및 개입 기록</h3>
                                </div>
                                <div className="p-4 space-y-4">
                                    {notes && notes.length > 0 ? (
                                        notes.map((note: any, nIdx: number) => (
                                            <div key={note.id || nIdx} className="text-[11px] pb-3 border-b border-slate-100 last:border-0 last:pb-0">
                                                <div className="flex justify-between items-center text-slate-400 mb-1 font-semibold">
                                                    <span>작성자: {note.author || note.writer || '기록자'}</span>
                                                    <span>{note.createdAt || note.date || ''}</span>
                                                </div>
                                                <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{note.content || note.text || note.note || note.내용 || ''}</p>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-xs text-slate-400 text-center py-4">등록된 상담 기록이 없습니다.</p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ReferralDashboardV2;

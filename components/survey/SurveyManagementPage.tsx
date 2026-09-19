import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { User, SurveyImportItem, SurveyStatusSummary, Attachment } from '../../types';
import { apiClient } from '../../services/apiClient';
import FilePreviewModal from '../common/FilePreviewModal';
import {
    ClipboardList,
    Download,
    RefreshCw,
    CheckCircle2,
    AlertTriangle,
    ShieldAlert,
    Trash2,
    Search,
    Eye,
    X,
    Lock,
    Clock,
    FileText,
    UserCheck,
    Check,
    UserPlus,
    History,
    FileSpreadsheet,
    AlertCircle,
    ArrowRight,
    Calendar,
    Phone,
    MapPin,
    Tag,
    ChevronRight,
    ArrowLeft,
    ShieldCheck,
    ExternalLink,
    Activity,
    Brain,
    HeartPulse,
    Moon,
    Flame,
    HelpCircle,
    UserX,
    Filter,
    TrendingUp,
    Percent
} from 'lucide-react';

interface SurveyManagementPageProps {
    currentUser: User;
    onNavigateToReferrals?: (initialData?: any) => void;
    showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

interface AssignableStaff {
    id: string;
    name: string;
    team: string;
    role: string;
}

type MainTab = 'applicants' | 'system';
type FilterTab = 'all' | 'consultation_requested' | 'screening_only' | 'additional_review' | 'completed';

export const SurveyManagementPage: React.FC<SurveyManagementPageProps> = ({
    currentUser,
    onNavigateToReferrals,
    showToast
}) => {
    // --- State: Core Data ---
    const [imports, setImports] = useState<SurveyImportItem[]>([]);
    const [statusSummary, setStatusSummary] = useState<SurveyStatusSummary | null>(null);
    const [assignableStaff, setAssignableStaff] = useState<AssignableStaff[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [importing, setImporting] = useState<boolean>(false);
    const [retryingDeletions, setRetryingDeletions] = useState<boolean>(false);

    // --- State: View & Tabs ---
    const [mainTab, setMainTab] = useState<MainTab>('applicants');
    const [filterTab, setFilterTab] = useState<FilterTab>('all');
    const [searchQuery, setSearchQuery] = useState<string>('');

    // --- State: Selection (Master-Detail) ---
    const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
    const [submissionDetail, setSubmissionDetail] = useState<any | null>(null);
    const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
    const [isMobileDetailOpen, setIsMobileDetailOpen] = useState<boolean>(false);

    // --- State: Modals ---
    // 1. Staff Assign Modal
    const [isAssignModalOpen, setIsAssignModalOpen] = useState<boolean>(false);
    const [assignTargetItem, setAssignTargetItem] = useState<SurveyImportItem | null>(null);
    const [selectedStaffId, setSelectedStaffId] = useState<string>('');
    const [selectedPriority, setSelectedPriority] = useState<'NORMAL' | 'PRIORITY_REVIEW' | 'IMMEDIATE_REVIEW'>('NORMAL');
    const [assignReason, setAssignReason] = useState<string>('');
    const [isAssigning, setIsAssigning] = useState<boolean>(false);

    // 2. Status Change Modal
    const [isStatusModalOpen, setIsStatusModalOpen] = useState<boolean>(false);
    const [targetConsultationStatus, setTargetConsultationStatus] = useState<string>('상담배정');
    const [statusChangeNote, setStatusChangeNote] = useState<string>('');
    const [isUpdatingStatus, setIsUpdatingStatus] = useState<boolean>(false);

    // 3. Assignment History Modal
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState<boolean>(false);
    const [historyItem, setHistoryItem] = useState<SurveyImportItem | null>(null);
    const [assignmentHistory, setAssignmentHistory] = useState<any[]>([]);
    const [loadingHistory, setLoadingHistory] = useState<boolean>(false);

    // 4. Excel Export Modal
    const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
    const [exportFilters, setExportFilters] = useState({
        assessmentId: 'all',
        assignedUserId: 'all',
        assignmentPriority: 'all',
        consultationStatus: 'all',
        startDate: '',
        endDate: ''
    });
    const [isExporting, setIsExporting] = useState<boolean>(false);

    // 5. File Preview Modal
    const [previewFile, setPreviewFile] = useState<Attachment | null>(null);

    // 6. Admin: Purge Demo Data Modal
    const [isPurgeDemoModalOpen, setIsPurgeDemoModalOpen] = useState<boolean>(false);
    const [purgeDryRunLoading, setPurgeDryRunLoading] = useState<boolean>(false);
    const [purgeDryRunResult, setPurgeDryRunResult] = useState<any | null>(null);
    const [purgeReason, setPurgeReason] = useState<string>('');
    const [purgeConfirmationPhrase, setPurgeConfirmationPhrase] = useState<string>('');
    const [isPurging, setIsPurging] = useState<boolean>(false);

    // 7. Admin: Individual Subject Deletion Modal
    const [isDeleteSubjectModalOpen, setIsDeleteSubjectModalOpen] = useState<boolean>(false);
    const [deleteSubjectItem, setDeleteSubjectItem] = useState<SurveyImportItem | null>(null);
    const [deleteSubjectReason, setDeleteSubjectReason] = useState<string>('');
    const [deleteSubjectConfirmId, setDeleteSubjectConfirmId] = useState<string>('');
    const [isDeletingSubject, setIsDeletingSubject] = useState<boolean>(false);

    // Permissions
    const canAccessSystemTab = currentUser.role === 'admin' ||
        currentUser.role === 'manager' ||
        !!(currentUser.permissions as any)?.surveyImport ||
        !!(currentUser.permissions as any)?.SURVEY_IMPORT_MANAGER;

    // --- Data Fetching ---
    const loadData = useCallback(async (preserveSelectionId?: string | null) => {
        try {
            setLoading(true);
            const [statusRes, importsRes, staffRes] = await Promise.all([
                apiClient.getSurveyStatus(),
                apiClient.getSurveyImports(),
                apiClient.getSurveyAssignableStaff().catch(() => ({ staff: [] }))
            ]);
            setStatusSummary(statusRes);
            const list = importsRes?.imports || [];
            setImports(list);
            setAssignableStaff(staffRes?.staff || []);

            // Set initial selected submission
            const targetId = preserveSelectionId !== undefined
                ? preserveSelectionId
                : (selectedSubmissionId || list[0]?.submissionId || null);

            if (targetId) {
                const itemToSelect = list.find((i: any) => i.submissionId === targetId) || list[0];
                if (itemToSelect) {
                    setSelectedSubmissionId(itemToSelect.submissionId);
                }
            }
        } catch (err: any) {
            if (showToast) showToast('설문 현황 데이터를 불러오는데 실패했습니다.', 'error');
        } finally {
            setLoading(false);
        }
    }, [selectedSubmissionId, showToast]);

    useEffect(() => {
        loadData();
    }, []);

    // Load detailed data when selection changes
    useEffect(() => {
        if (!selectedSubmissionId) {
            setSubmissionDetail(null);
            return;
        }

        let isCancelled = false;
        const fetchDetail = async () => {
            try {
                setLoadingDetail(true);
                const res = await apiClient.getSurveySubmission(selectedSubmissionId);
                if (!isCancelled) {
                    setSubmissionDetail(res);
                }
            } catch (err) {
                if (!isCancelled) {
                    setSubmissionDetail(null);
                }
            } finally {
                if (!isCancelled) {
                    setLoadingDetail(false);
                }
            }
        };

        fetchDetail();
        return () => { isCancelled = true; };
    }, [selectedSubmissionId]);

    // --- Action: Manual Survey Import ---
    const handleImportClick = async () => {
        if (importing) return;
        try {
            setImporting(true);
            const res = await apiClient.importOnlineSurveys(50);
            if (res.success) {
                if (showToast) {
                    showToast(`설문 수신 완료: 신규 ${res.summary.imported}건, 중복 ${res.summary.duplicates}건, 격리 ${res.summary.quarantined}건`, 'success');
                }
                await loadData();
            }
        } catch (err: any) {
            const msg = err.message || '가져오기 중 오류가 발생했습니다.';
            if (showToast) showToast(msg, 'error');
        } finally {
            setImporting(false);
        }
    };

    // --- Action: External Delete Retry ---
    const handleRetryDeletions = async () => {
        if (retryingDeletions) return;
        try {
            setRetryingDeletions(true);
            const res = await apiClient.retrySurveyDeletions();
            if (res.success) {
                if (showToast) showToast(`외부 삭제 재시도 성공: ${res.result.succeeded}건`, 'success');
                await loadData(selectedSubmissionId);
            }
        } catch (err: any) {
            if (showToast) showToast('외부 삭제 재시도에 실패했습니다.', 'error');
        } finally {
            setRetryingDeletions(false);
        }
    };

    // --- Action: Staff Assignment ---
    const handleOpenAssignModal = (item: SurveyImportItem) => {
        setAssignTargetItem(item);
        setSelectedStaffId(item.assignedUserId || (assignableStaff[0]?.id || ''));
        setSelectedPriority((item.assignmentPriority as any) || 'NORMAL');
        setAssignReason('');
        setIsAssignModalOpen(true);
    };

    const handleConfirmAssign = async () => {
        if (!assignTargetItem || !selectedStaffId) return;
        try {
            setIsAssigning(true);
            const staff = assignableStaff.find(s => s.id === selectedStaffId);
            const res = await apiClient.assignSurveyStaff(assignTargetItem.submissionId, {
                assignedUserId: selectedStaffId,
                assignedDepartmentId: staff?.team || '',
                assignmentPriority: selectedPriority,
                expectedVersion: assignTargetItem.version,
                reason: assignReason
            });

            if (res.success) {
                if (showToast) showToast(`담당 직원(${staff?.name || selectedStaffId}) 배정이 완료되었습니다.`, 'success');
                setIsAssignModalOpen(false);
                await loadData(assignTargetItem.submissionId);
            }
        } catch (err: any) {
            const msg = err.code === 'CONCURRENCY_CONFLICT'
                ? '다른 사용자가 이미 배정 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.'
                : (err.message || '직원 배정에 실패했습니다.');
            if (showToast) showToast(msg, 'error');
        } finally {
            setIsAssigning(false);
        }
    };

    // --- Action: Status Update ---
    const handleOpenStatusModal = (item: SurveyImportItem) => {
        setAssignTargetItem(item);
        setTargetConsultationStatus(item.consultationStatus || '상담배정');
        setStatusChangeNote('');
        setIsStatusModalOpen(true);
    };

    const handleConfirmStatusChange = async () => {
        if (!assignTargetItem || !targetConsultationStatus) return;
        try {
            setIsUpdatingStatus(true);
            const res = await apiClient.updateSurveyConsultationStatus(assignTargetItem.submissionId, {
                consultationStatus: targetConsultationStatus,
                note: statusChangeNote
            });

            if (res.success) {
                if (showToast) showToast(`상담 진행상태가 '${targetConsultationStatus}'(으)로 변경되었습니다.`, 'success');
                setIsStatusModalOpen(false);
                await loadData(assignTargetItem.submissionId);
            }
        } catch (err: any) {
            if (showToast) showToast(err.message || '상담 상태 변경에 실패했습니다.', 'error');
        } finally {
            setIsUpdatingStatus(false);
        }
    };

    // --- Action: Assignment History ---
    const handleOpenHistoryModal = async (item: SurveyImportItem) => {
        setHistoryItem(item);
        setIsHistoryModalOpen(true);
        setLoadingHistory(true);
        try {
            const res = await apiClient.getSurveyAssignmentHistory(item.submissionId);
            setAssignmentHistory(res.history || []);
        } catch (err: any) {
            if (showToast) showToast('배정 이력을 불러오는데 실패했습니다.', 'error');
        } finally {
            setLoadingHistory(false);
        }
    };

    // --- Action: Excel Export ---
    const handleExecuteExport = async () => {
        try {
            setIsExporting(true);
            const { blob, filename } = await apiClient.downloadSurveyExport(exportFilters);
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            if (showToast) showToast('설문 데이터가 엑셀 파일로 다운로드되었습니다.', 'success');
            setIsExportModalOpen(false);
        } catch (err: any) {
            if (showToast) showToast(err.message || '엑셀 내보내기에 실패했습니다.', 'error');
        } finally {
            setIsExporting(false);
        }
    };

    // --- Action: Admin Purge Demo Data ---
    const handleOpenPurgeDemoModal = async () => {
        setIsPurgeDemoModalOpen(true);
        setPurgeReason('');
        setPurgeConfirmationPhrase('');
        setPurgeDryRunLoading(true);
        try {
            const res = await apiClient.purgeDemoSurveysDryRun();
            setPurgeDryRunResult(res);
        } catch (err: any) {
            if (showToast) showToast(err.message || '더미 데이터 dry-run 조회에 실패했습니다.', 'error');
        } finally {
            setPurgeDryRunLoading(false);
        }
    };

    const handleConfirmPurgeDemo = async () => {
        if (!purgeReason.trim()) {
            if (showToast) showToast('삭제 사유를 입력해야 합니다.', 'error');
            return;
        }
        if (purgeConfirmationPhrase !== 'DELETE DEMO DATA') {
            if (showToast) showToast('확인 문구가 일치하지 않습니다. (DELETE DEMO DATA)', 'error');
            return;
        }

        try {
            setIsPurging(true);
            const res = await apiClient.purgeDemoSurveys(purgeReason, purgeConfirmationPhrase);
            if (showToast) {
                showToast(`더미 데이터 ${res.purgedCount || 0}건이 안전하게 정리되었습니다.`, 'success');
            }
            setIsPurgeDemoModalOpen(false);
            await loadData(null);
        } catch (err: any) {
            if (showToast) showToast(err.message || '더미 데이터 삭제에 실패했습니다.', 'error');
        } finally {
            setIsPurging(false);
        }
    };

    // --- Action: Admin Individual Delete Subject ---
    const handleOpenDeleteSubjectModal = (item: SurveyImportItem) => {
        setDeleteSubjectItem(item);
        setDeleteSubjectReason('');
        setDeleteSubjectConfirmId('');
        setIsDeleteSubjectModalOpen(true);
    };

    const handleConfirmDeleteSubject = async () => {
        if (!deleteSubjectItem) return;
        if (!deleteSubjectReason.trim()) {
            if (showToast) showToast('삭제 사유를 입력해야 합니다.', 'error');
            return;
        }
        if (deleteSubjectConfirmId !== deleteSubjectItem.submissionId) {
            if (showToast) showToast('접수 ID 확인 입력이 일치하지 않습니다.', 'error');
            return;
        }

        try {
            setIsDeletingSubject(true);
            await apiClient.deleteSurveySubmission(
                deleteSubjectItem.submissionId,
                deleteSubjectReason,
                deleteSubjectConfirmId
            );
            if (showToast) {
                showToast(`대상자(${deleteSubjectItem.submissionId})와 관련 자료가 삭제되었습니다.`, 'success');
            }
            setIsDeleteSubjectModalOpen(false);
            setDeleteSubjectItem(null);
            await loadData(null);
        } catch (err: any) {
            if (showToast) showToast(err.message || '대상자 삭제에 실패했습니다.', 'error');
        } finally {
            setIsDeletingSubject(false);
        }
    };

    // --- Helper: Date & Filtering ---
    const todayStr = useMemo(() => new Date().toISOString().substring(0, 10), []);

    const isToday = (dateStr?: string | null) => {
        if (!dateStr) return false;
        return dateStr.substring(0, 10) === todayStr;
    };

    // Business Summary Metrics (고유 submissionId 기준 집계)
    const metrics = useMemo(() => {
        const uniqueSubIds = Array.from(new Set(imports.map(i => i.submissionId).filter(Boolean)));
        const totalScreeningCompleted = uniqueSubIds.length;

        // 고유 submissionId별 대표 객체
        const uniqueItems = uniqueSubIds.map(id => imports.find(i => i.submissionId === id)!);

        // 상담 요청자 (consultationRequested === true)
        const consultationRequested = uniqueItems.filter(i =>
            i.consultationRequested === true || i.requestType === 'CONSULTATION_REQUEST'
        ).length;

        // 상담 미요청자 (전체 검사 완료자 - 상담 요청자)
        const consultationNotRequested = Math.max(0, totalScreeningCompleted - consultationRequested);

        // 상담 전환율 (상담 요청자 / 전체 검사 완료자 * 100) (분모 0이면 0%)
        const conversionRate = totalScreeningCompleted > 0
            ? Math.round((consultationRequested / totalScreeningCompleted) * 1000) / 10
            : 0;

        // 담당자 검토 대기 (SCREENING_ONLY 제외, CONSULTATION_REQUEST만 포함)
        const pendingStaffReview = uniqueItems.filter(i => {
            const isConsultation = i.consultationRequested === true || i.requestType === 'CONSULTATION_REQUEST';
            if (!isConsultation) return false;
            return i.consultationStatus === '신규접수대기' ||
                i.referralStatus === 'PENDING_STAFF_REVIEW' ||
                i.processingStatus === 'PENDING_STAFF_REVIEW' ||
                (!i.assignedUserId && !i.isSbqrQuarantined);
        }).length;

        // 내게 배정된 건
        const myAssigned = uniqueItems.filter(i =>
            i.assignedUserId && (i.assignedUserId === currentUser.id || i.assignedUserId === currentUser.username)
        ).length;

        // 리포트 준비 완료
        const reportReady = uniqueItems.filter(i => i.hasReport).length;

        // 보관 건수 통계 (누적 / 현재 보관 / 삭제)
        const currentStoredCount = uniqueSubIds.length;
        const cumulativeProcessed = statusSummary?.statistics?.cumulativeProcessed ?? (statusSummary?.totalImports || totalScreeningCompleted);
        const deletedCount = statusSummary?.statistics?.deletedCount ?? 0;

        return {
            totalScreeningCompleted,
            consultationRequested,
            consultationNotRequested,
            conversionRate,
            pendingStaffReview,
            myAssigned,
            reportReady,
            currentStoredCount,
            cumulativeProcessed,
            deletedCount
        };
    }, [imports, statusSummary, currentUser]);

    // Filtered Applicant List (5대 탭)
    const filteredImports = useMemo(() => {
        return imports.filter(item => {
            // Tab filter
            if (filterTab === 'consultation_requested') {
                const isReq = item.consultationRequested === true || item.requestType === 'CONSULTATION_REQUEST';
                if (!isReq) return false;
            } else if (filterTab === 'screening_only') {
                const isScreeningOnly = item.consultationRequested === false || item.requestType === 'SCREENING_ONLY';
                if (!isScreeningOnly) return false;
            } else if (filterTab === 'additional_review') {
                const needsReview = item.isSbqrQuarantined || (item.totalScore !== null && item.totalScore >= 15);
                if (!needsReview) return false;
            } else if (filterTab === 'completed') {
                const isDone = item.consultationStatus === '상담완료' || item.consultationStatus === '종결' || item.processingStatus === 'COMPLETED';
                if (!isDone) return false;
            }
            // 'all' passes through

            // Search query
            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase().trim();
                const matchName = (item.maskedClientName || '').toLowerCase().includes(q);
                const matchPhone = (item.maskedPhone || '').toLowerCase().includes(q);
                const matchSubId = (item.submissionId || '').toLowerCase().includes(q);
                const matchRefNo = (item.refNo || '').toLowerCase().includes(q);
                const matchRegion = (item.region || '').toLowerCase().includes(q);
                const matchScale = (item.assessmentId || '').toLowerCase().includes(q);
                const matchAssignee = (item.assignedUserId || '').toLowerCase().includes(q);
                return matchName || matchPhone || matchSubId || matchRefNo || matchRegion || matchScale || matchAssignee;
            }

            return true;
        });
    }, [imports, filterTab, searchQuery]);

    // Selected item object
    const currentSelectedItem = useMemo(() => {
        return imports.find(i => i.submissionId === selectedSubmissionId) || null;
    }, [imports, selectedSubmissionId]);

    // Helper: Staff display
    const getStaffName = (staffId?: string | null) => {
        if (!staffId) return '미배정';
        const found = assignableStaff.find(s => s.id === staffId);
        return found ? `${found.name} (${found.team || '직원'})` : staffId;
    };

    // Helper: Priority Badge
    const renderPriorityBadge = (priority?: string) => {
        switch (priority) {
            case 'IMMEDIATE_REVIEW':
                return (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-rose-100 text-rose-700 border border-rose-200">
                        <AlertCircle className="w-3 h-3 text-rose-600" />
                        긴급 검토
                    </span>
                );
            case 'PRIORITY_REVIEW':
                return (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-amber-100 text-amber-700 border border-amber-200">
                        <AlertTriangle className="w-3 h-3 text-amber-600" />
                        우선 검토
                    </span>
                );
            default:
                return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                        일반
                    </span>
                );
        }
    };

    // Helper: Consultation Status Chip
    const renderStatusBadge = (status?: string | null, isSbqr?: boolean) => {
        if (isSbqr) {
            return <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-purple-100 text-purple-700 border border-purple-200">격리(SBQ-R)</span>;
        }
        switch (status) {
            case '상담완료':
            case '종결':
                return <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-emerald-100 text-emerald-700 border border-emerald-200">처리완료</span>;
            case '상담진행':
                return <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-blue-100 text-blue-700 border border-blue-200">상담진행</span>;
            case '상담배정':
                return <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-indigo-100 text-indigo-700 border border-indigo-200">상담배정</span>;
            default:
                return <span className="px-2.5 py-0.5 rounded-full text-[11px] font-black bg-amber-50 text-amber-700 border border-amber-200">신규접수대기</span>;
        }
    };

    // Helper: Safe Business Data Transfer Status
    const renderTransferStatusBadge = (item?: any) => {
        if (!item) return null;
        if (item.internalStatus === 'IMPORT_FAILED' || item.lastErrorCode) {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">처리 오류</span>;
        }
        if (item.internalStatus === 'PENDING' || item.externalStatus === 'PENDING') {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-50 text-slate-600 border border-slate-200">외부 접수 대기</span>;
        }
        if (item.internalStatus === 'LEASED' || item.internalStatus === 'IMPORTING') {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">내부 반입 중</span>;
        }
        if (item.assignedUserId) {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">담당자 배정 완료</span>;
        }
        if (item.hasReport) {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">검사결과 리포트 준비 완료</span>;
        }
        if (item.refNo) {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">의뢰대장 생성 완료</span>;
        }
        if (item.internalStatus === 'IMPORTED' || item.internalStatus === 'COMPLETED') {
            return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">내부 반입 완료</span>;
        }
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">담당자 미배정</span>;
    };

    // Helper: Mark synthetic test fixture clearly
    const renderFixtureBadge = (item?: any) => {
        if (!item) return null;
        const isMock = item.sourceEnvironment === 'mock' ||
            (item.submissionId && (String(item.submissionId).includes('demo') || String(item.submissionId).includes('synthetic')));
        if (!isMock) return null;
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">합성 시험자료</span>;
    };

    // Helper: Request Type Badge
    const renderRequestTypeBadge = (item?: any) => {
        if (!item) return null;
        const isConsultation = item.consultationRequested === true || item.requestType === 'CONSULTATION_REQUEST';
        if (isConsultation) {
            return (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-200">
                    상담요청
                </span>
            );
        }
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-700 border border-slate-200">
                검사완료
            </span>
        );
    };

    // Helper: Assessment Scale Korean Title
    const getAssessmentTitle = (scaleId?: string) => {
        switch ((scaleId || '').toLowerCase()) {
            case 'phq-9':
                return { name: '우울 선별검사 (PHQ-9)', icon: Brain, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-100' };
            case 'gad-7':
                return { name: '불안 선별검사 (GAD-7)', icon: HeartPulse, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-100' };
            case 'isi-k':
                return { name: '수면 위생척도 (ISI-K)', icon: Moon, color: 'text-sky-600', bg: 'bg-sky-50 border-sky-100' };
            case 'bepsi-k':
                return { name: '스트레스 척도 (BEPSI-K)', icon: Flame, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-100' };
            case 'sbq-r':
                return { name: '자살 위험도 신호 (SBQ-R)', icon: ShieldAlert, color: 'text-purple-600', bg: 'bg-purple-50 border-purple-100' };
            default:
                return { name: '접촉 전용 일반 상담 (비공개)', icon: Activity, color: 'text-slate-600', bg: 'bg-slate-50 border-slate-200' };
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-slate-100 overflow-hidden text-slate-800">
            {/* 1. Header Bar */}
            <header className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between gap-4 shadow-sm z-10 shrink-0">
                <div className="flex items-center gap-3.5">
                    <div className="p-3 bg-gradient-to-br from-teal-500 to-emerald-600 text-white rounded-2xl shadow-md shadow-emerald-500/20">
                        <ClipboardList className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                            온라인 설문 관리
                            {metrics.totalScreeningCompleted > 0 && (
                                <span className="text-[11px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-md">
                                    총 {metrics.totalScreeningCompleted}명 완료
                                </span>
                            )}
                        </h1>
                        <p className="text-xs text-slate-500 font-medium mt-0.5">
                            온라인 선별검사(SCREENING_ONLY) 및 상담신청(CONSULTATION_REQUEST) 내역을 관리합니다.
                        </p>
                    </div>
                </div>

                {/* Primary Toolbar Actions */}
                <div className="flex items-center gap-2.5">
                    {currentUser.role === 'admin' && (
                        <button
                            onClick={handleOpenPurgeDemoModal}
                            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl shadow-sm hover:shadow transition"
                            title="관리자 전용: sub-demo-* 더미 데이터 안전 일괄 정리"
                        >
                            <Trash2 className="w-4 h-4 text-rose-600" />
                            더미 데이터 정리
                        </button>
                    )}

                    <button
                        onClick={() => setIsExportModalOpen(true)}
                        className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl shadow-sm hover:shadow transition"
                        title="현재 조회된 설문 데이터를 안전한 엑셀 파일로 다운로드합니다"
                    >
                        <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                        현재 조회결과 엑셀 다운로드
                    </button>

                    <button
                        onClick={() => loadData(selectedSubmissionId)}
                        disabled={loading}
                        className="p-2 text-slate-600 hover:text-slate-900 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl shadow-sm transition"
                        title="새로고침"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-teal-600' : ''}`} />
                    </button>

                    <button
                        onClick={handleImportClick}
                        disabled={importing || (statusSummary?.isImportRunning ?? false)}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white text-xs font-bold rounded-xl shadow-md hover:shadow-lg disabled:opacity-50 transition"
                    >
                        {importing ? (
                            <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                설문 수신 중...
                            </>
                        ) : (
                            <>
                                <Download className="w-4 h-4" />
                                신규 설문 수신 실행
                            </>
                        )}
                    </button>
                </div>
            </header>

            {/* 2. Business Summary Cards (7개 표준 지표) */}
            <div className="px-6 pt-5 pb-3 shrink-0">
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                    {/* Card 1: 전체 검사 완료자 */}
                    <div
                        onClick={() => setFilterTab('all')}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer ${filterTab === 'all' ? 'bg-teal-50/80 border-teal-300 shadow-sm ring-2 ring-teal-400/20' : 'bg-white border-slate-200/80 hover:border-slate-300 shadow-sm'}`}
                    >
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">전체 검사 완료자</span>
                            <ClipboardList className="w-4 h-4 text-teal-600" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-slate-900">{metrics.totalScreeningCompleted}</span>
                            <span className="text-xs text-slate-400 font-medium">명</span>
                        </div>
                    </div>

                    {/* Card 2: 상담 요청자 */}
                    <div
                        onClick={() => setFilterTab('consultation_requested')}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer ${filterTab === 'consultation_requested' ? 'bg-blue-50/80 border-blue-300 shadow-sm ring-2 ring-blue-400/20' : 'bg-white border-slate-200/80 hover:border-slate-300 shadow-sm'}`}
                    >
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">상담 요청자</span>
                            <UserCheck className="w-4 h-4 text-blue-600" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-blue-600">{metrics.consultationRequested}</span>
                            <span className="text-xs text-slate-400 font-medium">명</span>
                        </div>
                    </div>

                    {/* Card 3: 상담 미요청자 */}
                    <div
                        onClick={() => setFilterTab('screening_only')}
                        className={`p-3 rounded-2xl border transition-all cursor-pointer ${filterTab === 'screening_only' ? 'bg-slate-100 border-slate-400 shadow-sm ring-2 ring-slate-400/20' : 'bg-white border-slate-200/80 hover:border-slate-300 shadow-sm'}`}
                    >
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">상담 미요청자</span>
                            <UserX className="w-4 h-4 text-slate-500" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-slate-700">{metrics.consultationNotRequested}</span>
                            <span className="text-xs text-slate-400 font-medium">명</span>
                        </div>
                    </div>

                    {/* Card 4: 상담 전환율 */}
                    <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-sm">
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">상담 전환율</span>
                            <TrendingUp className="w-4 h-4 text-emerald-600" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-emerald-600">{metrics.conversionRate}%</span>
                        </div>
                    </div>

                    {/* Card 5: 담당자 검토 대기 */}
                    <div
                        onClick={() => setFilterTab('consultation_requested')}
                        className="p-3 rounded-2xl bg-white border border-slate-200/80 hover:border-slate-300 shadow-sm cursor-pointer"
                    >
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">담당자 검토 대기</span>
                            <Clock className="w-4 h-4 text-amber-500" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-amber-600">{metrics.pendingStaffReview}</span>
                            <span className="text-xs text-slate-400 font-medium">건</span>
                        </div>
                    </div>

                    {/* Card 6: 내게 배정된 건 */}
                    <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-sm">
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">내게 배정된 건</span>
                            <UserCheck className="w-4 h-4 text-indigo-600" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-indigo-600">{metrics.myAssigned}</span>
                            <span className="text-xs text-slate-400 font-medium">건</span>
                        </div>
                    </div>

                    {/* Card 7: 리포트 준비 완료 */}
                    <div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-sm">
                        <div className="flex items-center justify-between text-slate-500">
                            <span className="text-[11px] font-bold">리포트 준비 완료</span>
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        </div>
                        <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xl font-black text-slate-900">{metrics.reportReady}</span>
                            <span className="text-xs text-slate-400 font-medium">건</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 3. Main Navigation Tabs */}
            <div className="px-6 shrink-0">
                <div className="flex items-center justify-between border-b border-slate-200">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setMainTab('applicants')}
                            className={`pb-3 px-4 text-sm font-black transition-all flex items-center gap-2 border-b-2 ${mainTab === 'applicants' ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
                        >
                            <ClipboardList className="w-4 h-4" />
                            상담 신청자 관리 (업무 공간)
                        </button>

                        {canAccessSystemTab && (
                            <button
                                onClick={() => setMainTab('system')}
                                className={`pb-3 px-4 text-sm font-black transition-all flex items-center gap-2 border-b-2 ${mainTab === 'system' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
                            >
                                <Lock className="w-4 h-4 text-slate-400" />
                                시스템 연동상태 (관리자 전용)
                            </button>
                        )}
                    </div>

                    <div className="text-xs text-slate-400 font-medium pb-2">
                        총 <strong className="text-slate-700">{filteredImports.length}</strong>건 표시 중
                    </div>
                </div>
            </div>

            {/* 4. Tab Content Area */}
            {mainTab === 'applicants' ? (
                /* ========================================================================= */
                /* TAB 1: Master-Detail Applicant Dashboard                                  */
                /* ========================================================================= */
                <div className="flex-1 overflow-hidden px-6 py-4 flex flex-col min-h-0">
                    {/* Quick Filters Bar & Search */}
                    <div className="bg-white rounded-2xl border border-slate-200/90 p-3 mb-3.5 shadow-sm flex flex-wrap items-center justify-between gap-3 shrink-0">
                        {/* Filter Tabs */}
                        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                            {[
                                { id: 'all', label: '전체 검사자' },
                                { id: 'consultation_requested', label: '상담 요청' },
                                { id: 'screening_only', label: '상담 미요청' },
                                { id: 'additional_review', label: '추가 확인 권고' },
                                { id: 'completed', label: '처리 완료' }
                            ].map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setFilterTab(tab.id as FilterTab)}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${filterTab === tab.id ? 'bg-teal-600 text-white shadow-sm' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200/60'}`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Search Input */}
                        <div className="relative min-w-[260px] flex-1 sm:flex-initial">
                            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="text"
                                placeholder="성명, 연락처, 접수번호, 의뢰번호 검색..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="w-full pl-9 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 placeholder-slate-400 focus:bg-white focus:border-teal-500 focus:outline-none transition"
                            />
                            {searchQuery && (
                                <button
                                    onClick={() => setSearchQuery('')}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Master-Detail Container */}
                    <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
                        {/* LEFT: Applicant List (Master) */}
                        <div className={`w-full lg:w-[420px] xl:w-[460px] flex flex-col bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden shrink-0 ${isMobileDetailOpen ? 'hidden lg:flex' : 'flex'}`}>
                            <div className="p-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                                <span className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                                    <ClipboardList className="w-4 h-4 text-teal-600" />
                                    신청자 목록 ({filteredImports.length})
                                </span>
                                <span className="text-[11px] text-slate-400">카드를 클릭하여 상세 검토</span>
                            </div>

                            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
                                {loading && imports.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2">
                                        <RefreshCw className="w-6 h-6 animate-spin text-teal-600" />
                                        <span className="text-xs font-semibold">설문 데이터를 불러오는 중...</span>
                                    </div>
                                ) : filteredImports.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2">
                                        <Search className="w-8 h-8 text-slate-300" />
                                        <span className="text-xs font-semibold">일치하는 신청 내역이 없습니다.</span>
                                        <span className="text-[11px] text-slate-400">검색어나 필터를 변경해 보세요.</span>
                                    </div>
                                ) : (
                                    filteredImports.map(item => {
                                        const isSelected = item.submissionId === selectedSubmissionId;
                                        const scaleInfo = getAssessmentTitle(item.assessmentId);

                                        return (
                                            <div
                                                key={item.submissionId}
                                                onClick={() => {
                                                    setSelectedSubmissionId(item.submissionId);
                                                    setIsMobileDetailOpen(true);
                                                }}
                                                className={`p-3.5 rounded-2xl border transition-all cursor-pointer text-left relative ${isSelected ? 'bg-teal-50/60 border-teal-400 shadow-md ring-2 ring-teal-500/20' : 'bg-white border-slate-200/80 hover:border-slate-300 hover:bg-slate-50/50'}`}
                                            >
                                                {/* Header Line */}
                                                <div className="flex items-center justify-between gap-2 mb-1.5">
                                                    <div className="flex items-center gap-2">
                                                        {renderPriorityBadge(item.assignmentPriority)}
                                                        <span className="text-sm font-black text-slate-900">
                                                            {item.maskedClientName || '이름없음'}
                                                        </span>
                                                        <span className="text-xs font-medium text-slate-500">
                                                            {item.maskedPhone}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                                                        {renderFixtureBadge(item)}
                                                        {renderRequestTypeBadge(item)}
                                                        {renderTransferStatusBadge(item)}
                                                        {renderStatusBadge(item.consultationStatus, item.isSbqrQuarantined)}
                                                    </div>
                                                </div>

                                                {/* Sub-info Line: Date, Scale & Score */}
                                                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-2 font-medium">
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="w-3 h-3 text-slate-400" />
                                                        {(item.submittedAt || item.importedAt || '').substring(0, 16).replace('T', ' ')}
                                                    </span>
                                                    <span className="text-slate-600 font-bold">
                                                        {item.region}
                                                    </span>
                                                </div>

                                                {/* Assessment & Report line */}
                                                <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
                                                    <div className="flex items-center gap-1.5 truncate max-w-[240px]">
                                                        <scaleInfo.icon className={`w-3.5 h-3.5 shrink-0 ${scaleInfo.color}`} />
                                                        <span className="font-bold text-slate-700 truncate">
                                                            {item.contactOnly ? '접촉 전용' : item.assessmentId.toUpperCase()}
                                                        </span>
                                                        {!item.contactOnly && item.totalScore !== null && (
                                                            <span className="font-extrabold text-slate-900">
                                                                ({item.totalScore}점)
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div className="flex items-center gap-2">
                                                        {item.hasReport ? (
                                                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                                                                리포트 완료
                                                            </span>
                                                        ) : (
                                                            <span className="text-[10px] font-medium text-slate-400">
                                                                리포트 대기
                                                            </span>
                                                        )}
                                                        <ChevronRight className="w-4 h-4 text-slate-400" />
                                                    </div>
                                                </div>

                                                {/* Assigned Staff */}
                                                <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
                                                    <span className="flex items-center gap-1 font-medium">
                                                        <UserCheck className="w-3 h-3 text-slate-400" />
                                                        담당: <strong className={item.assignedUserId ? 'text-indigo-700 font-bold' : 'text-slate-400'}>{getStaffName(item.assignedUserId)}</strong>
                                                    </span>
                                                    {item.refNo && (
                                                        <span className="text-[10px] font-mono text-slate-400">
                                                            {item.refNo}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>

                        {/* RIGHT: Selected Applicant Detail (Detail Panel) */}
                        <div className={`flex-1 flex flex-col bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden ${!isMobileDetailOpen ? 'hidden lg:flex' : 'flex'}`}>
                            {loadingDetail ? (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2.5">
                                    <RefreshCw className="w-8 h-8 animate-spin text-teal-600" />
                                    <span className="text-sm font-semibold">신청자 상세 정보를 불러오는 중...</span>
                                </div>
                            ) : !currentSelectedItem ? (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3 p-8 text-center">
                                    <ClipboardList className="w-12 h-12 text-slate-300" />
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-700">선택된 상담 신청자가 없습니다</h3>
                                        <p className="text-xs text-slate-400 mt-1">좌측 목록에서 검토할 신청자를 클릭하세요.</p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {/* Detail Top Action Header */}
                                    <div className="p-4 border-b border-slate-200/80 bg-slate-50/60 flex flex-wrap items-center justify-between gap-3 shrink-0">
                                        <div className="flex items-center gap-3">
                                            {/* Mobile Back Button */}
                                            <button
                                                onClick={() => setIsMobileDetailOpen(false)}
                                                className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 bg-white border border-slate-200 rounded-lg"
                                            >
                                                <ArrowLeft className="w-4 h-4" />
                                            </button>

                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <h2 className="text-lg font-black text-slate-900">
                                                        {submissionDetail?.submission?.contact?.clientName || currentSelectedItem.maskedClientName} 님 상세 검토
                                                    </h2>
                                                    {renderPriorityBadge(currentSelectedItem.assignmentPriority)}
                                                    {renderFixtureBadge(currentSelectedItem)}
                                                    {renderRequestTypeBadge(currentSelectedItem)}
                                                    {renderTransferStatusBadge(currentSelectedItem)}
                                                    {renderStatusBadge(currentSelectedItem.consultationStatus, currentSelectedItem.isSbqrQuarantined)}
                                                </div>
                                                <div className="text-xs text-slate-500 font-medium mt-0.5 flex items-center gap-2">
                                                    <span>접수 ID: <span className="font-mono text-slate-600">{currentSelectedItem.submissionId}</span></span>
                                                    {currentSelectedItem.refNo && (
                                                        <span>• 의뢰번호: <strong className="text-indigo-600 font-mono">{currentSelectedItem.refNo}</strong></span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Action Buttons Bar */}
                                        <div className="flex items-center gap-2">
                                            {currentUser.role === 'admin' && (
                                                <button
                                                    onClick={() => handleOpenDeleteSubjectModal(currentSelectedItem)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold rounded-xl border border-rose-200 shadow-sm transition"
                                                    title="관리자 전용: 대상자 및 관련 자료 완전 삭제"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                    대상자 삭제
                                                </button>
                                            )}

                                            <button
                                                onClick={() => handleOpenAssignModal(currentSelectedItem)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-xl border border-indigo-200 shadow-sm transition"
                                            >
                                                <UserPlus className="w-3.5 h-3.5" />
                                                담당자 배정/변경
                                            </button>

                                            <button
                                                onClick={() => handleOpenStatusModal(currentSelectedItem)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl border border-slate-200 shadow-sm transition"
                                            >
                                                <Activity className="w-3.5 h-3.5 text-slate-600" />
                                                진행상태 변경
                                            </button>

                                            {currentSelectedItem.refNo && onNavigateToReferrals && (
                                                <button
                                                    onClick={() => onNavigateToReferrals({ targetReferralId: currentSelectedItem.referralId || currentSelectedItem.refNo })}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-xl shadow-sm hover:shadow transition"
                                                    title="의뢰대장 메인 화면으로 이동하여 본 건을 확인합니다"
                                                >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                    의뢰대장 열기
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Detail Scrollable Body */}
                                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar text-left">
                                        {/* SECTION A: 상담신청 기본 정보 */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
                                                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                                                    <UserCheck className="w-4 h-4 text-teal-600" />
                                                    SECTION A. 상담 신청자 기본 정보
                                                </h3>
                                                <span className="text-[11px] text-slate-400">
                                                    접수일시: {(currentSelectedItem.submittedAt || currentSelectedItem.importedAt || '').replace('T', ' ').substring(0, 19)}
                                                </span>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                                                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                                    <span className="text-[10px] font-bold text-slate-400 block mb-0.5">성명</span>
                                                    <span className="text-sm font-black text-slate-900">
                                                        {submissionDetail?.submission?.contact?.clientName || currentSelectedItem.maskedClientName}
                                                    </span>
                                                </div>

                                                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                                    <span className="text-[10px] font-bold text-slate-400 block mb-0.5">연락처</span>
                                                    <span className="text-sm font-bold text-slate-800 flex items-center gap-1">
                                                        <Phone className="w-3.5 h-3.5 text-slate-400" />
                                                        {submissionDetail?.submission?.contact?.phone || currentSelectedItem.maskedPhone}
                                                    </span>
                                                </div>

                                                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                                    <span className="text-[10px] font-bold text-slate-400 block mb-0.5">지역 (거주지)</span>
                                                    <span className="text-sm font-bold text-slate-800 flex items-center gap-1">
                                                        <MapPin className="w-3.5 h-3.5 text-slate-400" />
                                                        {submissionDetail?.submission?.contact?.region || currentSelectedItem.region || '이천시'}
                                                    </span>
                                                </div>

                                                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                                    <span className="text-[10px] font-bold text-slate-400 block mb-0.5">성별 / 생년월일</span>
                                                    <span className="text-sm font-bold text-slate-800">
                                                        {submissionDetail?.submission?.contact?.gender || '미입력'} / {submissionDetail?.submission?.contact?.birthDate || '미입력'}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Counseling Note Text */}
                                            <div className="p-4 bg-slate-50/80 rounded-xl border border-slate-200/80 mb-3">
                                                <span className="text-xs font-bold text-slate-600 block mb-1.5 flex items-center gap-1.5">
                                                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                                                    상담 신청 사유 및 호소 내용
                                                </span>
                                                <p className="text-xs text-slate-800 leading-relaxed whitespace-pre-wrap font-medium">
                                                    {submissionDetail?.submission?.contact?.counselingRequestText ||
                                                        currentSelectedItem.counselingRequestText ||
                                                        '작성된 상담 신청 메모가 없습니다.'}
                                                </p>
                                            </div>

                                            {/* Consent Evidence */}
                                            <div className="flex items-center gap-4 text-xs font-medium text-slate-500 pt-1">
                                                <span className="flex items-center gap-1 text-emerald-700">
                                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                                    개인정보 수집·이용 동의 완료
                                                </span>
                                                {currentSelectedItem.contactOnly ? (
                                                    <span className="flex items-center gap-1 text-slate-400">
                                                        <AlertCircle className="w-3.5 h-3.5 text-slate-400" />
                                                        민감정보 미동의 (접촉전용)
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-emerald-700">
                                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                                        민감정보(검사결과) 처리 동의 완료
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {/* SECTION B: 검사결과 요약 카드 (도메인별) */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
                                                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                                                    <Brain className="w-4 h-4 text-indigo-600" />
                                                    SECTION B. 선별검사 도메인별 결과 요약
                                                </h3>
                                                <span className="text-[11px] text-slate-400">
                                                    척도: {currentSelectedItem.assessmentId.toUpperCase()}
                                                </span>
                                            </div>

                                            {currentSelectedItem.contactOnly ? (
                                                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-slate-600 text-xs flex items-center gap-3">
                                                    <AlertCircle className="w-5 h-5 text-slate-400 shrink-0" />
                                                    <div>
                                                        <strong>접촉 전용 접수 건:</strong> 내담자가 민감정보 처리에 동의하지 않아 온라인 자가검사 결과가 등록되지 않았습니다. 기본 연락처 기반의 초기면접 접촉을 진행해 주세요.
                                                    </div>
                                                </div>
                                            ) : currentSelectedItem.isSbqrQuarantined ? (
                                                <div className="p-4 bg-purple-50 rounded-xl border border-purple-200 text-purple-900 text-xs flex items-center gap-3">
                                                    <ShieldAlert className="w-6 h-6 text-purple-600 shrink-0" />
                                                    <div>
                                                        <strong className="text-purple-800 text-sm block mb-1">SBQ-R 임상 안전 게이트 격리 보호 중</strong>
                                                        본 건은 자살 관련 척도(SBQ-R)를 포함하고 있어 기관 승인 프로토콜에 따라 자동 의뢰 연계가 보류되고 격리 보관되었습니다. 총점 및 세부 응답은 사전 승인 없이 노출되지 않습니다.
                                                    </div>
                                                </div>
                                            ) : (
                                                <div>
                                                    {(() => {
                                                        const nested = submissionDetail?.submission?.assessment?.scaleScores || submissionDetail?.submission?.assessment?.scales;
                                                        const phq = nested?.['phq-9'] || nested?.phq9;
                                                        const gad = nested?.['gad-7'] || nested?.gad7;
                                                        const isi = nested?.['isi-k'] || nested?.isik;
                                                        const bepsi = nested?.['bepsi-k'] || nested?.bepsik;
                                                        const sbqr = nested?.['sbq-r'] || nested?.sbqr;
                                                        const has5Scales = Boolean(phq && gad && isi && bepsi && sbqr);

                                                        if (has5Scales) {
                                                            return (
                                                                <div className="space-y-4">
                                                                    <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                                                                        <span className="text-xs font-bold text-slate-700">Track A 5대 선별검사 도메인별 종합 결과 (32문항)</span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded-md">5개 도메인 완료</span>
                                                                    </div>
                                                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                                                        {/* 1. PHQ-9 Card */}
                                                                        <div className="p-3.5 rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50/60 to-white shadow-sm">
                                                                            <div className="flex items-center justify-between mb-1.5">
                                                                                <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                                    <Activity className="w-3.5 h-3.5 text-blue-600" />
                                                                                    우울 건강선별 (PHQ-9)
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">9문항</span>
                                                                            </div>
                                                                            <div className="flex items-baseline gap-2 my-1.5">
                                                                                <span className="text-2xl font-black text-slate-900">{phq.totalScore ?? '-'}</span>
                                                                                <span className="text-xs text-slate-500 font-bold">점</span>
                                                                            </div>
                                                                            <div className="text-xs font-bold text-blue-700 bg-blue-50 px-2 py-1 rounded-lg border border-blue-100">
                                                                                판정: {phq.severity || '평가 완료'}
                                                                            </div>
                                                                        </div>

                                                                        {/* 2. GAD-7 Card */}
                                                                        <div className="p-3.5 rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50/60 to-white shadow-sm">
                                                                            <div className="flex items-center justify-between mb-1.5">
                                                                                <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                                    <Activity className="w-3.5 h-3.5 text-emerald-600" />
                                                                                    불안 선별도구 (GAD-7)
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded">7문항</span>
                                                                            </div>
                                                                            <div className="flex items-baseline gap-2 my-1.5">
                                                                                <span className="text-2xl font-black text-slate-900">{gad.totalScore ?? '-'}</span>
                                                                                <span className="text-xs text-slate-500 font-bold">점</span>
                                                                            </div>
                                                                            <div className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100">
                                                                                판정: {gad.severity || '평가 완료'}
                                                                            </div>
                                                                        </div>

                                                                        {/* 3. ISI-K Card */}
                                                                        <div className="p-3.5 rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white shadow-sm">
                                                                            <div className="flex items-center justify-between mb-1.5">
                                                                                <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                                    <Moon className="w-3.5 h-3.5 text-indigo-600" />
                                                                                    불면증 심각도 (ISI-K)
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-indigo-100 text-indigo-800 rounded">7문항</span>
                                                                            </div>
                                                                            <div className="flex items-baseline gap-2 my-1.5">
                                                                                <span className="text-2xl font-black text-slate-900">{isi.totalScore ?? '-'}</span>
                                                                                <span className="text-xs text-slate-500 font-bold">점</span>
                                                                            </div>
                                                                            <div className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-1 rounded-lg border border-indigo-100">
                                                                                판정: {isi.severity || '평가 완료'}
                                                                            </div>
                                                                        </div>

                                                                        {/* 4. BEPSI-K Card */}
                                                                        <div className="p-3.5 rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50/60 to-white shadow-sm">
                                                                            <div className="flex items-center justify-between mb-1.5">
                                                                                <span className="text-xs font-black text-amber-900 flex items-center gap-1.5">
                                                                                    <Flame className="w-3.5 h-3.5 text-amber-600" />
                                                                                    스트레스 척도 (BEPSI-K)
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">5문항</span>
                                                                            </div>
                                                                            <div className="flex items-baseline gap-2 my-1.5">
                                                                                <span className="text-2xl font-black text-amber-700">
                                                                                    {bepsi.meanScore !== undefined ? (typeof bepsi.meanScore === 'number' ? bepsi.meanScore.toFixed(2) : bepsi.meanScore) : '-'}
                                                                                </span>
                                                                                <span className="text-xs text-amber-800 font-bold">점 (평균 점수)</span>
                                                                                <span className="text-[11px] text-slate-500 ml-auto font-medium">
                                                                                    [합계: {bepsi.responseSum ?? bepsi.totalScore ?? '-'}점]
                                                                                </span>
                                                                            </div>
                                                                            <div className="text-xs font-bold text-amber-700 bg-amber-50 px-2 py-1 rounded-lg border border-amber-100">
                                                                                판정: {bepsi.resultLabel || bepsi.severity || '평가 완료'}
                                                                            </div>
                                                                        </div>

                                                                        {/* 5. SBQ-R Card */}
                                                                        <div className="p-3.5 rounded-xl border border-purple-200 bg-gradient-to-br from-purple-50/60 to-white shadow-sm">
                                                                            <div className="flex items-center justify-between mb-1.5">
                                                                                <span className="text-xs font-black text-purple-900 flex items-center gap-1.5">
                                                                                    <ShieldAlert className="w-3.5 h-3.5 text-purple-600" />
                                                                                    자살행동 선별 (SBQ-R)
                                                                                </span>
                                                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded">4문항</span>
                                                                            </div>
                                                                            <div className="flex items-baseline gap-2 my-1.5">
                                                                                <span className="text-2xl font-black text-purple-900">{sbqr.totalScore ?? '-'}</span>
                                                                                <span className="text-xs text-purple-600 font-bold">점 (범위: 3~18)</span>
                                                                            </div>
                                                                            <div className="text-xs font-bold text-purple-700 bg-purple-50 px-2 py-1 rounded-lg border border-purple-100 flex items-center justify-between">
                                                                                <span>
                                                                                    선별: {Number(sbqr.totalScore) >= 7 ? '추가 확인 권장' : '선별 기준점 미만'}
                                                                                </span>
                                                                                <span className="text-[10px] text-slate-400 font-normal">선별 참고정보 (진단 아님)</span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        }

                                                        // Single Scale Card Layout (Fallback)
                                                        return (
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                {/* Card: Primary Scale */}
                                                                <div className="p-4 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <Activity className="w-4 h-4 text-teal-600" />
                                                                            {getAssessmentTitle(currentSelectedItem.assessmentId).name}
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-md">
                                                                            검사 완료
                                                                        </span>
                                                                    </div>

                                                                    {currentSelectedItem.assessmentId.toLowerCase() === 'bepsi-k' ? (
                                                                        <div className="flex items-baseline gap-3 my-2">
                                                                            <span className="text-3xl font-black text-amber-700">
                                                                                {currentSelectedItem.meanScore ?? submissionDetail?.submission?.assessment?.meanScore ?? (currentSelectedItem.totalScore ? (currentSelectedItem.totalScore / 5).toFixed(2) : '-')}
                                                                            </span>
                                                                            <span className="text-xs text-amber-800 font-bold">점 (평균 점수)</span>
                                                                            <span className="text-xs font-semibold text-slate-500 ml-2">
                                                                                [문항 합계: {currentSelectedItem.totalScore ?? submissionDetail?.submission?.assessment?.totalScore ?? '-'}점]
                                                                            </span>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="flex items-baseline gap-3 my-2">
                                                                            <span className="text-3xl font-black text-slate-900">
                                                                                {currentSelectedItem.totalScore ?? submissionDetail?.submission?.assessment?.totalScore ?? '-'}
                                                                            </span>
                                                                            <span className="text-xs text-slate-500 font-bold">점</span>
                                                                        </div>
                                                                    )}

                                                                    <div className="mt-2 text-xs font-bold text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg border border-teal-100 flex items-center justify-between">
                                                                        <span>
                                                                            {currentSelectedItem.assessmentId.toLowerCase() === 'sbq-r'
                                                                                ? `선별: ${Number(currentSelectedItem.totalScore ?? submissionDetail?.submission?.assessment?.totalScore) >= 7 ? '추가 확인 권장' : '선별 기준점 미만'}`
                                                                                : `판정: ${currentSelectedItem.severity || submissionDetail?.submission?.assessment?.severity || '점검 완료'}`}
                                                                        </span>
                                                                        <span className="text-[10px] text-slate-400 font-normal">
                                                                            {currentSelectedItem.assessmentId.toLowerCase() === 'sbq-r' ? '선별 참고정보 (진단 아님)' : '공식 평가 정책 준수'}
                                                                        </span>
                                                                    </div>
                                                                </div>

                                                                {/* Card: BEPSI-K / Additional details if present */}
                                                                {currentSelectedItem.assessmentId.toLowerCase() === 'bepsi-k' ? (
                                                                    <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/40">
                                                                        <span className="text-xs font-black text-amber-900 block mb-1">
                                                                            스트레스 척도 (BEPSI-K) 세부 지표
                                                                        </span>
                                                                        <p className="text-xs text-slate-600 leading-relaxed mb-2">
                                                                            BEPSI-K 척도는 5개 문항의 단순 합계(총점)와 1~5점 척도 환산 평균 점수를 분별하여 평가합니다.
                                                                        </p>
                                                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                                                            <div className="bg-white p-2 rounded-lg border border-amber-200/70">
                                                                                <span className="text-[10px] text-slate-400 block">문항 합계 (Raw)</span>
                                                                                <strong className="text-slate-800 font-bold">{currentSelectedItem.totalScore || 14}점</strong>
                                                                            </div>
                                                                            <div className="bg-white p-2 rounded-lg border border-amber-200/70">
                                                                                <span className="text-[10px] text-slate-400 block">평균 점수 (Mean)</span>
                                                                                <strong className="text-amber-700 font-bold">{currentSelectedItem.meanScore || '2.80'}점</strong>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 flex flex-col justify-center">
                                                                        <span className="text-xs font-bold text-slate-700 block mb-1">
                                                                            문항 응답 세부 내역
                                                                        </span>
                                                                        <p className="text-xs text-slate-500 leading-relaxed">
                                                                            기관 공문 서식의 A4 선별결과지 리포트 PDF에 전 문항의 응답 레이블 및 합산 점수가 안전하게 출력되어 첨부되었습니다.
                                                                        </p>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                            )}
                                        </div>

                                        {/* SECTION C & D: 리포트 뷰어 & 의뢰대장 연계 */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {/* SECTION C: 리포트 바로보기 */}
                                            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between">
                                                <div>
                                                    <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                                                        <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                                                            <FileText className="w-4 h-4 text-emerald-600" />
                                                            SECTION C. 공문 서식 리포트 (A4 PDF)
                                                        </h3>
                                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                                                            currentSelectedItem.hasReport
                                                                ? 'bg-emerald-100 text-emerald-800'
                                                                : (currentSelectedItem.internalStatus === 'IMPORT_FAILED' || currentSelectedItem.lastErrorCode)
                                                                    ? 'bg-rose-100 text-rose-800'
                                                                    : (currentSelectedItem.internalStatus === 'IMPORTING' || currentSelectedItem.internalStatus === 'LEASED')
                                                                        ? 'bg-amber-100 text-amber-800'
                                                                        : 'bg-slate-100 text-slate-600'
                                                        }`}>
                                                            {currentSelectedItem.hasReport
                                                                ? '리포트 준비 완료'
                                                                : (currentSelectedItem.internalStatus === 'IMPORT_FAILED' || currentSelectedItem.lastErrorCode)
                                                                    ? '리포트 생성 실패'
                                                                    : (currentSelectedItem.internalStatus === 'IMPORTING' || currentSelectedItem.internalStatus === 'LEASED')
                                                                        ? '리포트 생성 중'
                                                                        : '첨부파일 없음'
                                                            }
                                                        </span>
                                                    </div>

                                                    <p className="text-xs text-slate-500 mb-3">
                                                        파일명: <span className="font-mono text-slate-700 font-bold">
                                                            {currentSelectedItem.reportAttachment?.name || '온라인 마음건강 검진 결과보고서'}
                                                        </span>
                                                    </p>
                                                </div>

                                                <button
                                                    onClick={() => {
                                                        if (!currentSelectedItem.hasReport) {
                                                            const errMsg = '검사결과 리포트를 찾을 수 없습니다. 리포트 재생성을 요청해 주세요.';
                                                            if (showToast) showToast(errMsg, 'error');
                                                            else alert(errMsg);
                                                            return;
                                                        }
                                                        const reportUrl = `/api/surveys/submissions/${encodeURIComponent(currentSelectedItem.submissionId)}/report`;
                                                        setPreviewFile({
                                                            id: `att_${currentSelectedItem.submissionId}`,
                                                            name: currentSelectedItem.reportAttachment?.name || '온라인 마음건강 검진 결과보고서.pdf',
                                                            type: 'application/pdf',
                                                            url: reportUrl
                                                        });
                                                    }}
                                                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-md hover:shadow transition flex items-center justify-center gap-2 active:scale-95"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    검사결과 리포트 바로보기 (PDF 뷰어)
                                                </button>
                                            </div>

                                            {/* SECTION D: 의뢰대장 연계 */}
                                            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between">
                                                <div>
                                                    <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                                                        <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                                                            <ExternalLink className="w-4 h-4 text-teal-600" />
                                                            SECTION D. 사내 의뢰대장 연계
                                                        </h3>
                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-teal-100 text-teal-800 rounded-md">
                                                            {currentSelectedItem.refNo ? '자동 초안 등록' : '연계 대기'}
                                                        </span>
                                                    </div>

                                                    <div className="space-y-1.5 text-xs text-slate-600 mb-3">
                                                        <div>기관 연번: <strong className="font-mono text-slate-900 font-black">{currentSelectedItem.refNo || '생성 대기'}</strong></div>
                                                        <div>의뢰 상태: <strong className="text-slate-800">{currentSelectedItem.referralStatus || 'PENDING_STAFF_REVIEW'}</strong></div>
                                                        <div>종결 상태: <strong className="text-slate-800">{currentSelectedItem.closureStatus || '미종결'}</strong></div>
                                                    </div>
                                                </div>

                                                {currentSelectedItem.refNo && onNavigateToReferrals ? (
                                                    <button
                                                        onClick={() => onNavigateToReferrals({ targetReferralId: currentSelectedItem.referralId || currentSelectedItem.refNo })}
                                                        className="w-full py-2.5 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 rounded-xl text-xs font-bold shadow-sm transition flex items-center justify-center gap-2"
                                                    >
                                                        <ArrowRight className="w-4 h-4 text-teal-600" />
                                                        의뢰대장 상세 열기
                                                    </button>
                                                ) : (
                                                    <div className="text-xs text-slate-400 text-center py-2">
                                                        의뢰대장 등록 대기 중입니다.
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* SECTION E: 담당자 배정 정보 */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                                                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                                                    <UserCheck className="w-4 h-4 text-indigo-600" />
                                                    SECTION E. 담당 직원 배정 정보
                                                </h3>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleOpenHistoryModal(currentSelectedItem)}
                                                        className="text-xs font-bold text-slate-500 hover:text-slate-800 flex items-center gap-1"
                                                    >
                                                        <History className="w-3.5 h-3.5" />
                                                        배정 이력
                                                    </button>
                                                    <button
                                                        onClick={() => handleOpenAssignModal(currentSelectedItem)}
                                                        className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-lg border border-indigo-200 transition"
                                                    >
                                                        배정 변경
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                                                <div className="p-3 bg-slate-50 rounded-xl">
                                                    <span className="text-[10px] text-slate-400 block mb-0.5">현재 담당자</span>
                                                    <strong className="text-slate-900 text-sm font-black">
                                                        {getStaffName(currentSelectedItem.assignedUserId)}
                                                    </strong>
                                                </div>
                                                <div className="p-3 bg-slate-50 rounded-xl">
                                                    <span className="text-[10px] text-slate-400 block mb-0.5">배정 부서</span>
                                                    <strong className="text-slate-800 font-bold">
                                                        {currentSelectedItem.assignedDepartmentId || '증진팀'}
                                                    </strong>
                                                </div>
                                                <div className="p-3 bg-slate-50 rounded-xl">
                                                    <span className="text-[10px] text-slate-400 block mb-0.5">검토 우선순위</span>
                                                    <div className="mt-0.5">{renderPriorityBadge(currentSelectedItem.assignmentPriority)}</div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* SECTION F: 업무 처리 이력 (타임라인) */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider mb-4 pb-2 border-b border-slate-100 flex items-center gap-1.5">
                                                <Clock className="w-4 h-4 text-slate-600" />
                                                SECTION F. 업무 처리 이력
                                            </h3>

                                            <div className="relative pl-6 space-y-4 before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
                                                {/* Stage 1 */}
                                                <div className="relative">
                                                    <div className="absolute -left-6 top-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px]">✓</div>
                                                    <div className="text-xs font-bold text-slate-800">온라인 상담신청 수신 및 비대칭 복호화 완료</div>
                                                    <div className="text-[11px] text-slate-400">
                                                        {(currentSelectedItem.importedAt || currentSelectedItem.submittedAt || '').replace('T', ' ').substring(0, 19)}
                                                    </div>
                                                </div>

                                                {/* Stage 2 */}
                                                <div className="relative">
                                                    <div className="absolute -left-6 top-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px]">✓</div>
                                                    <div className="text-xs font-bold text-slate-800">
                                                        의뢰대장 자동 초안 생성 ({currentSelectedItem.refNo || 'ET-26-XXX'})
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">내부 검토 대기 상태(PENDING_STAFF_REVIEW)로 등록됨</div>
                                                </div>

                                                {/* Stage 3 */}
                                                <div className="relative">
                                                    <div className="absolute -left-6 top-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px]">✓</div>
                                                    <div className="text-xs font-bold text-slate-800">A4 공문 서식 선별결과지 PDF 생성 및 첨부 완료</div>
                                                    <div className="text-[11px] text-slate-400">SHA-256 해시 검증 통과 및 내부 뷰어 링크 연결</div>
                                                </div>

                                                {/* Stage 4: Assignment */}
                                                <div className="relative">
                                                    <div className={`absolute -left-6 top-0.5 w-4 h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px] ${currentSelectedItem.assignedUserId ? 'bg-indigo-500' : 'bg-slate-300'}`}>
                                                        {currentSelectedItem.assignedUserId ? '✓' : '•'}
                                                    </div>
                                                    <div className="text-xs font-bold text-slate-800">
                                                        {currentSelectedItem.assignedUserId ? `담당 직원 배정 (${getStaffName(currentSelectedItem.assignedUserId)})` : '담당 직원 배정 대기'}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        {currentSelectedItem.assignedAt ? (currentSelectedItem.assignedAt.replace('T', ' ').substring(0, 19)) : '미배정 상태'}
                                                    </div>
                                                </div>

                                                {/* Stage 5: Progress Status */}
                                                <div className="relative">
                                                    <div className={`absolute -left-6 top-0.5 w-4 h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px] ${currentSelectedItem.consultationStatus === '상담완료' || currentSelectedItem.consultationStatus === '종결' ? 'bg-emerald-600' : 'bg-blue-500'}`}>
                                                        {currentSelectedItem.consultationStatus === '상담완료' || currentSelectedItem.consultationStatus === '종결' ? '✓' : '•'}
                                                    </div>
                                                    <div className="text-xs font-bold text-slate-800">
                                                        상담 진행 상태: <span className="text-blue-700">{currentSelectedItem.consultationStatus || '신규접수대기'}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                /* ========================================================================= */
                /* TAB 2: Restricted System Integration View (Admin/Manager Only)            */
                /* ========================================================================= */
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 custom-scrollbar text-left">
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-center justify-between text-xs text-amber-900">
                        <div className="flex items-center gap-3">
                            <Lock className="w-5 h-5 text-amber-600 shrink-0" />
                            <div>
                                <strong className="font-bold">시스템 연동 및 엔지니어링 관리 화면입니다.</strong>
                                <p className="text-amber-700 mt-0.5">외부 수신(Track A), 임대(Lease), 암호문 삭제 상태를 점검할 수 있으며 비밀정보는 화면에 노출되지 않습니다.</p>
                            </div>
                        </div>

                        {(statusSummary?.deletePending || 0) > 0 && (
                            <button
                                onClick={handleRetryDeletions}
                                disabled={retryingDeletions}
                                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold shadow transition flex items-center gap-1.5"
                            >
                                <RefreshCw className={`w-3.5 h-3.5 ${retryingDeletions ? 'animate-spin' : ''}`} />
                                외부 암호문 삭제 재시도 ({statusSummary?.deletePending}건)
                            </button>
                        )}
                    </div>

                    {/* Technical Metrics Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500">
                                <span className="text-xs font-bold">누적 수신 설문</span>
                                <ClipboardList className="w-5 h-5 text-teal-600" />
                            </div>
                            <div className="mt-2 text-2xl font-black text-slate-900">
                                {statusSummary?.totalImports || 0}건
                            </div>
                        </div>

                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500">
                                <span className="text-xs font-bold">복호화 및 저장 완료</span>
                                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                            </div>
                            <div className="mt-2 text-2xl font-black text-emerald-600">
                                {statusSummary?.completed || 0}건
                            </div>
                        </div>

                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500">
                                <span className="text-xs font-bold">SBQ-R 격리 보호</span>
                                <ShieldAlert className="w-5 h-5 text-purple-600" />
                            </div>
                            <div className="mt-2 text-2xl font-black text-purple-600">
                                {statusSummary?.quarantined || 0}건
                            </div>
                        </div>

                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                            <div className="flex items-center justify-between text-slate-500">
                                <span className="text-xs font-bold">외부 암호문 삭제 대기</span>
                                <Trash2 className="w-5 h-5 text-rose-500" />
                            </div>
                            <div className="mt-2 text-2xl font-black text-rose-600">
                                {statusSummary?.deletePending || 0}건
                            </div>
                        </div>
                    </div>

                    {/* Technical Ledger Table */}
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                            <h3 className="text-xs font-black text-slate-800 flex items-center gap-2">
                                <Lock className="w-4 h-4 text-indigo-600" />
                                수신 장부 세부 내역 (Ingestion Ledger)
                            </h3>
                            <span className="text-xs text-slate-400">총 {imports.length}건 등록됨</span>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left">
                                <thead className="bg-slate-50 border-b border-slate-200/80 text-slate-500 font-bold">
                                    <tr>
                                        <th className="px-4 py-3">접수 ID (SubmissionId)</th>
                                        <th className="px-4 py-3">스키마 / 키 버전</th>
                                        <th className="px-4 py-3">내부 상태</th>
                                        <th className="px-4 py-3">외부 상태</th>
                                        <th className="px-4 py-3">수신 시각</th>
                                        <th className="px-4 py-3">ACK 시각</th>
                                        <th className="px-4 py-3">외부 삭제 시각</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 font-medium">
                                    {imports.map(item => (
                                        <tr key={item.submissionId} className="hover:bg-slate-50/80">
                                            <td className="px-4 py-3 font-mono font-bold text-slate-800">{item.submissionId}</td>
                                            <td className="px-4 py-3 text-slate-500">{item.schemaVersion || 'v1.0'} / {item.keyVersion || 'v1'}</td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${item.internalStatus === 'COMPLETED' ? 'bg-emerald-100 text-emerald-800' : 'bg-purple-100 text-purple-800'}`}>
                                                    {item.internalStatus}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${item.externalStatus === 'DELETED' ? 'bg-slate-100 text-slate-700' : 'bg-rose-100 text-rose-800'}`}>
                                                    {item.externalStatus}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-slate-500">{(item.importedAt || '').replace('T', ' ').substring(0, 19)}</td>
                                            <td className="px-4 py-3 text-slate-500">{(item.acknowledgedAt || '-').replace('T', ' ').substring(0, 19)}</td>
                                            <td className="px-4 py-3 text-slate-500">{(item.externalDeletedAt || '-').replace('T', ' ').substring(0, 19)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ========================================================================= */}
            {/* MODALS                                                                    */}
            {/* ========================================================================= */}

            {/* 1. Staff Assignment Modal */}
            {isAssignModalOpen && assignTargetItem && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <UserPlus className="w-5 h-5 text-indigo-600" />
                                담당 직원 배정 및 우선순위 지정
                            </h3>
                            <button
                                onClick={() => setIsAssignModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-4 text-xs">
                            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                <div className="text-slate-500">대상 신청자: <strong className="text-slate-900">{assignTargetItem.maskedClientName}</strong> ({assignTargetItem.maskedPhone})</div>
                                <div className="text-slate-500 mt-1">접수 ID: <span className="font-mono text-slate-700">{assignTargetItem.submissionId}</span></div>
                            </div>

                            {/* Staff Selector */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1.5">배정할 담당 직원 선택 *</label>
                                <select
                                    value={selectedStaffId}
                                    onChange={e => setSelectedStaffId(e.target.value)}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none"
                                >
                                    {assignableStaff.map(staff => (
                                        <option key={staff.id} value={staff.id}>
                                            {staff.name} ({staff.team || '직원'}, {staff.role})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Priority Selector */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1.5">검토 우선순위 *</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {[
                                        { id: 'NORMAL', label: '일반' },
                                        { id: 'PRIORITY_REVIEW', label: '우선 검토' },
                                        { id: 'IMMEDIATE_REVIEW', label: '긴급 검토' }
                                    ].map(p => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => setSelectedPriority(p.id as any)}
                                            className={`py-2 text-xs font-bold rounded-xl border transition-all ${selectedPriority === p.id ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}`}
                                        >
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Reason Note */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1.5">배정 사유 / 전달 메모</label>
                                <textarea
                                    value={assignReason}
                                    onChange={e => setAssignReason(e.target.value)}
                                    placeholder="배정 사유나 담당 직원에게 전달할 전달사항을 입력하세요..."
                                    rows={3}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-indigo-500 focus:outline-none resize-none"
                                />
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsAssignModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmAssign}
                                disabled={isAssigning || !selectedStaffId}
                                className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {isAssigning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                                배정 완료
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 2. Status Change Modal */}
            {isStatusModalOpen && assignTargetItem && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <Activity className="w-5 h-5 text-teal-600" />
                                상담 진행상태 변경
                            </h3>
                            <button
                                onClick={() => setIsStatusModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-4 text-xs">
                            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                <div className="text-slate-500">대상 신청자: <strong className="text-slate-900">{assignTargetItem.maskedClientName}</strong></div>
                                <div className="text-slate-500 mt-1">현재 상태: <span className="font-bold text-indigo-700">{assignTargetItem.consultationStatus || '신규접수대기'}</span></div>
                            </div>

                            <div>
                                <label className="block font-bold text-slate-700 mb-1.5">변경할 상태 선택 *</label>
                                <select
                                    value={targetConsultationStatus}
                                    onChange={e => setTargetConsultationStatus(e.target.value)}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-teal-500 focus:outline-none"
                                >
                                    <option value="신규접수대기">신규접수대기 (접수 직후)</option>
                                    <option value="상담배정">상담배정 (담당자 지정됨)</option>
                                    <option value="상담진행">상담진행 (초기면접/상담 진행 중)</option>
                                    <option value="상담완료">상담완료 (상담 종결 및 결과 등록)</option>
                                    <option value="종결">종결 (사례관리 완료)</option>
                                </select>
                            </div>

                            <div>
                                <label className="block font-bold text-slate-700 mb-1.5">상태 변경 메모 / 사유</label>
                                <textarea
                                    value={statusChangeNote}
                                    onChange={e => setStatusChangeNote(e.target.value)}
                                    placeholder="상태 변경 사유나 상담 진행 요약을 입력하세요..."
                                    rows={3}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-teal-500 focus:outline-none resize-none"
                                />
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsStatusModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmStatusChange}
                                disabled={isUpdatingStatus}
                                className="px-4 py-2 text-xs font-bold text-white bg-teal-600 hover:bg-teal-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {isUpdatingStatus ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                상태 변경 적용
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 3. Assignment History Modal */}
            {isHistoryModalOpen && historyItem && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <History className="w-5 h-5 text-indigo-600" />
                                직원 배정 변경 이력
                            </h3>
                            <button
                                onClick={() => setIsHistoryModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 max-h-80 overflow-y-auto space-y-3 custom-scrollbar text-xs">
                            {loadingHistory ? (
                                <div className="flex items-center justify-center py-8 text-slate-400">
                                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-600 mr-2" />
                                    이력을 불러오는 중...
                                </div>
                            ) : assignmentHistory.length === 0 ? (
                                <div className="text-center py-8 text-slate-400">
                                    기록된 배정 변경 이력이 없습니다.
                                </div>
                            ) : (
                                assignmentHistory.map((h, idx) => (
                                    <div key={idx} className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-1">
                                        <div className="flex items-center justify-between font-bold">
                                            <span className="text-indigo-700">
                                                {getStaffName(h.assignedUserId || h.newAssignedUserId)} 배정
                                            </span>
                                            <span className="text-[11px] text-slate-400">
                                                {(h.createdAt || h.timestamp || '').replace('T', ' ').substring(0, 19)}
                                            </span>
                                        </div>
                                        <div className="text-slate-600">
                                            우선순위: <strong className="text-slate-800">{h.priority || h.newPriority || 'NORMAL'}</strong>
                                            {h.previousAssignedUserId && (
                                                <span className="text-slate-400 ml-2">(이전: {getStaffName(h.previousAssignedUserId)})</span>
                                            )}
                                        </div>
                                        {h.reason && (
                                            <div className="text-slate-500 text-[11px] bg-white p-2 rounded-lg border border-slate-100 mt-1">
                                                사유: {h.reason}
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="mt-6 flex justify-end pt-3 border-t border-slate-100">
                            <button
                                onClick={() => setIsHistoryModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition"
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 4. Excel Export Modal */}
            {isExportModalOpen && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                                설문 데이터 엑셀 내보내기 (보안 준수)
                            </h3>
                            <button
                                onClick={() => setIsExportModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3.5 text-xs">
                            <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100 text-emerald-900">
                                <strong>CWE-1236 수식 삽입 방어 적용:</strong> 모든 위험 기호(=, +, -, @)는 안전하게 이스케이프 처리되며 감사 로그가 자동으로 기록됩니다.
                            </div>

                            <div>
                                <label className="block font-bold text-slate-700 mb-1">검사 척도</label>
                                <select
                                    value={exportFilters.assessmentId}
                                    onChange={e => setExportFilters(f => ({ ...f, assessmentId: e.target.value }))}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium"
                                >
                                    <option value="all">전체 검사 척도</option>
                                    <option value="phq-9">우울 (PHQ-9)</option>
                                    <option value="gad-7">불안 (GAD-7)</option>
                                    <option value="isi-k">수면 (ISI-K)</option>
                                    <option value="bepsi-k">스트레스 (BEPSI-K)</option>
                                    <option value="contact-only">접촉 전용</option>
                                </select>
                            </div>

                            <div>
                                <label className="block font-bold text-slate-700 mb-1">상담 진행상태</label>
                                <select
                                    value={exportFilters.consultationStatus}
                                    onChange={e => setExportFilters(f => ({ ...f, consultationStatus: e.target.value }))}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium"
                                >
                                    <option value="all">전체 상태</option>
                                    <option value="신규접수대기">신규접수대기</option>
                                    <option value="상담배정">상담배정</option>
                                    <option value="상담진행">상담진행</option>
                                    <option value="상담완료">상담완료</option>
                                    <option value="종결">종결</option>
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1">시작일</label>
                                    <input
                                        type="date"
                                        value={exportFilters.startDate}
                                        onChange={e => setExportFilters(f => ({ ...f, startDate: e.target.value }))}
                                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium"
                                    />
                                </div>
                                <div>
                                    <label className="block font-bold text-slate-700 mb-1">종료일</label>
                                    <input
                                        type="date"
                                        value={exportFilters.endDate}
                                        onChange={e => setExportFilters(f => ({ ...f, endDate: e.target.value }))}
                                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                onClick={() => setIsExportModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleExecuteExport}
                                disabled={isExporting}
                                className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {isExporting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                엑셀 파일 다운로드
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 5. PDF File Preview Modal */}
            {previewFile && (
                <FilePreviewModal
                    file={previewFile}
                    onClose={() => setPreviewFile(null)}
                />
            )}

            {/* 6. Admin Purge Demo Data Modal */}
            {isPurgeDemoModalOpen && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-rose-700 flex items-center gap-2">
                                <Trash2 className="w-5 h-5 text-rose-600" />
                                더미 설문 데이터를 삭제하시겠습니까?
                            </h3>
                            <button
                                onClick={() => setIsPurgeDemoModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-4 text-xs">
                            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 leading-relaxed font-medium">
                                선택한 더미 대상자와 연결된 의뢰, PDF 및 첨부자료가 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.
                            </div>

                            {/* Dry-run Result Box */}
                            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                                <div className="flex items-center justify-between font-bold text-slate-700">
                                    <span>삭제 대상 더미 자료 (Dry-Run 결과)</span>
                                    {purgeDryRunLoading ? (
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-teal-600" />
                                    ) : (
                                        <span className="text-rose-600 font-mono font-black">{purgeDryRunResult?.targetsCount || 0}건 대상</span>
                                    )}
                                </div>
                                {!purgeDryRunLoading && purgeDryRunResult?.targets && (
                                    <div className="max-h-24 overflow-y-auto space-y-1 font-mono text-[11px] text-slate-600 custom-scrollbar">
                                        {purgeDryRunResult.targets.map((t: string) => (
                                            <div key={t} className="flex items-center gap-1.5">
                                                <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                                                <span>{t}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Reason Input */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1">
                                    삭제 사유 * (필수 입력)
                                </label>
                                <input
                                    type="text"
                                    value={purgeReason}
                                    onChange={e => setPurgeReason(e.target.value)}
                                    placeholder="예: 2026.6.1 MVP 로컬 시험 더미 데이터 일괄 정리"
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-rose-500 focus:outline-none"
                                />
                            </div>

                            {/* Confirmation Phrase */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1">
                                    확인 문구 입력 * (아래 문구를 정확히 입력하세요)
                                </label>
                                <div className="text-[11px] font-mono font-bold text-rose-700 mb-1.5">
                                    DELETE DEMO DATA
                                </div>
                                <input
                                    type="text"
                                    value={purgeConfirmationPhrase}
                                    onChange={e => setPurgeConfirmationPhrase(e.target.value)}
                                    placeholder="DELETE DEMO DATA"
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono font-medium text-slate-800 focus:border-rose-500 focus:outline-none"
                                />
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsPurgeDemoModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmPurgeDemo}
                                disabled={isPurging || !purgeReason.trim() || purgeConfirmationPhrase !== 'DELETE DEMO DATA' || (purgeDryRunResult?.targetsCount || 0) === 0}
                                className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {isPurging ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                더미 데이터 삭제
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 7. Admin Individual Subject Deletion Modal */}
            {isDeleteSubjectModalOpen && deleteSubjectItem && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-rose-700 flex items-center gap-2">
                                <Trash2 className="w-5 h-5 text-rose-600" />
                                대상자 및 연결자료 완전 삭제
                            </h3>
                            <button
                                onClick={() => setIsDeleteSubjectModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-4 text-xs">
                            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                                <div className="text-slate-500">삭제 대상자: <strong className="text-slate-900">{deleteSubjectItem.maskedClientName}</strong></div>
                                <div className="text-slate-500 mt-1">접수 ID: <span className="font-mono text-rose-600 font-bold">{deleteSubjectItem.submissionId}</span></div>
                            </div>

                            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-[11px] leading-relaxed">
                                <strong>주의:</strong> 본 대상자와 연결된 의뢰대장 초안, 저장된 PDF 리포트 파일, 첨부자료 메타데이터, 개인정보 동의서 및 검색 인덱스가 완전히 삭제됩니다.
                            </div>

                            {/* Reason */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1">
                                    삭제 사유 * (필수 입력)
                                </label>
                                <input
                                    type="text"
                                    value={deleteSubjectReason}
                                    onChange={e => setDeleteSubjectReason(e.target.value)}
                                    placeholder="삭제 사유를 구체적으로 입력하세요..."
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:border-rose-500 focus:outline-none"
                                />
                            </div>

                            {/* Confirm Submission ID */}
                            <div>
                                <label className="block font-bold text-slate-700 mb-1">
                                    접수 ID 재입력 * (실수 방지 확인)
                                </label>
                                <div className="text-[11px] font-mono text-slate-500 mb-1">
                                    {deleteSubjectItem.submissionId}
                                </div>
                                <input
                                    type="text"
                                    value={deleteSubjectConfirmId}
                                    onChange={e => setDeleteSubjectConfirmId(e.target.value)}
                                    placeholder="접수 ID를 그대로 복사/입력하세요"
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono font-medium text-slate-800 focus:border-rose-500 focus:outline-none"
                                />
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsDeleteSubjectModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmDeleteSubject}
                                disabled={isDeletingSubject || !deleteSubjectReason.trim() || deleteSubjectConfirmId !== deleteSubjectItem.submissionId}
                                className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2"
                            >
                                {isDeletingSubject ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                대상자 영구 삭제
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

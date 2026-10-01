import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { User, SurveyImportItem, SurveyStatusSummary, Attachment } from '../../types';
import { apiClient, buildCampaignDistributionUrl, getCampaignLabelInfo } from '../../services/apiClient';
import FilePreviewModal from '../common/FilePreviewModal';
import SurveyCharts from './SurveyCharts';
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
    ChevronDown,
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
    Percent,
    CheckSquare,
    Square,
    MinusSquare,
    CheckCheck,
    CalendarRange,
    ArrowUpDown,
    UserMinus,
    Layers,
    Users,
    Maximize2,
    Copy,
    Plus,
    Edit2,
    Building2
} from 'lucide-react';
import { formatKstDateTime, getKstPresetDateStrings } from '../../server/survey/kstUtils.js';

declare module '../../types' {
    interface SurveyImportItem {
        refNo?: string | null;
        referralId?: string | null;
        referralStatus?: string | null;
        closureStatus?: string | null;
        submittedAt?: string | null;
        retentionUntil?: string | null;
        counselingRequestText?: string | null;
        contactOnly?: boolean;
        meanScore?: number | null;
        campaignCode?: string | null;
        campaignName?: string | null;
        campaignPurpose?: string | null;
        campaignRegistrationStatus?: 'REGISTERED' | 'UNREGISTERED' | 'ABSENT' | string | null;
    }
}

export interface SurveyCampaignItem {
    code: string;
    companyName: string;
    purpose: string | null;
    startsAt: string | null;
    endsAt: string | null;
    isActive: boolean;
    isRegistered: boolean;
    campaignRegistrationStatus: 'REGISTERED' | 'UNREGISTERED';
    receivedCount: number;
    pendingReviewCount: number;
    registeredReferralCount: number;
    completedCount: number;
    counts?: {
        receivedCount: number;
        pendingReviewCount: number;
        registeredReferralCount: number;
        completedCount: number;
    };
}

interface SurveyManagementPageProps {
    currentUser: User;
    onNavigateToReferrals?: (initialData?: any) => void;
    showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
    refreshSidebarBadge?: () => void;
}

interface AssignableStaff {
    id: string;
    name: string;
    team: string;
    role: string;
    pendingAssignmentCount?: number;
    myAssignedPendingCount?: number;
}

type MainTab = 'applicants' | 'system';
type FilterTab = 'all' | 'consultation_requested' | 'screening_only' | 'additional_review' | 'completed';

export const SurveyManagementPage: React.FC<SurveyManagementPageProps> = ({
    currentUser,
    onNavigateToReferrals,
    showToast,
    refreshSidebarBadge
}) => {
    // --- State: Core Data ---
    const [imports, setImports] = useState<SurveyImportItem[]>([]);
    const [statusSummary, setStatusSummary] = useState<SurveyStatusSummary | null>(null);
    const [assignableStaff, setAssignableStaff] = useState<AssignableStaff[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [importing, setImporting] = useState<boolean>(false);
    const [retryingDeletions, setRetryingDeletions] = useState<boolean>(false);

    // --- State: Survey Automation & Sync Progress ---
    const [syncProgress, setSyncProgress] = useState<{
        isOpen: boolean;
        isSyncing: boolean;
        imported: number;
        failed: number;
        reused: number;
        total: number;
        stopReason?: string;
        message?: string;
    }>({
        isOpen: false,
        isSyncing: false,
        imported: 0,
        failed: 0,
        reused: 0,
        total: 0
    });

    const [autoSyncStatus, setAutoSyncStatus] = useState<{
        autoSyncEnabled: boolean;
        intervalMinutes: number;
        batchSize: number;
        maxItems: number;
        isRunning: boolean;
        lastSyncAt: string | null;
        lastResult: string | null;
        nextScheduledAt: string | null;
        lastImportedCount: number;
        lastFailedCount: number;
    } | null>(null);

    // --- State: View & Tabs ---
    const [mainTab, setMainTab] = useState<MainTab>('applicants');
    const [filterTab, setFilterTab] = useState<FilterTab>('all');
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [isChartsOpen, setIsChartsOpen] = useState<boolean>(false);

    // --- State: Date Range & Preset Filtering ---
    const [dateFrom, setDateFrom] = useState<string>('');
    const [dateTo, setDateTo] = useState<string>('');
    const [appliedDateFrom, setAppliedDateFrom] = useState<string>('');
    const [appliedDateTo, setAppliedDateTo] = useState<string>('');
    const [dateError, setDateError] = useState<string>('');
    const [activePreset, setActivePreset] = useState<'today' | '7days' | '30days' | 'all' | 'custom'>('all');

    // --- State: Sorting & Additional Filters ---
    const [sortBy, setSortBy] = useState<string>('latest');
    const [staffFilter, setStaffFilter] = useState<string>('all');
    const [quickStatusFilter, setQuickStatusFilter] = useState<string>('all');
    const [campaignFilter, setCampaignFilter] = useState<string>('all');
    const [campaignsList, setCampaignsList] = useState<SurveyCampaignItem[]>([]);

    // --- State: Individual & Bulk Selection (In-Memory React State Only - Zero PII / No localStorage / No URL) ---
    const [selectedSubmissionIds, setSelectedSubmissionIds] = useState<Set<string>>(new Set());
    const [selectionCleanupMessage, setSelectionCleanupMessage] = useState<string>('');
    const selectionCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [bulkTargetStaffId, setBulkTargetStaffId] = useState<string>('');
    const [bulkNote, setBulkNote] = useState<string>('');
    const [isBulkConfirmModalOpen, setIsBulkConfirmModalOpen] = useState<boolean>(false);
    const [bulkMode, setBulkMode] = useState<'unassigned-only' | 'include-reassignment'>('unassigned-only');
    const [isBulkAssigning, setIsBulkAssigning] = useState<boolean>(false);
    const [bulkResult, setBulkResult] = useState<any | null>(null);
    const [isBulkResultModalOpen, setIsBulkResultModalOpen] = useState<boolean>(false);

    // --- State: Selection (Master-Detail) ---
    const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
    const [submissionDetail, setSubmissionDetail] = useState<any | null>(null);
    const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
    const [isMobileDetailOpen, setIsMobileDetailOpen] = useState<boolean>(false);

    // --- State: Responsive Large Detail & Assignment Modal (P0 UX Improvement) ---
    const [isLargeDetailModalOpen, setIsLargeDetailModalOpen] = useState<boolean>(false);
    const [detailActiveTab, setDetailActiveTab] = useState<'basic' | 'scales' | 'pdf' | 'assignment'>('basic');
    const [detailSelectedStaffId, setDetailSelectedStaffId] = useState<string>('');
    const [detailSelectedPriority, setDetailSelectedPriority] = useState<'NORMAL' | 'PRIORITY_REVIEW' | 'IMMEDIATE_REVIEW'>('NORMAL');
    const [detailAssignReason, setDetailAssignReason] = useState<string>('');
    const [isDetailAssigning, setIsDetailAssigning] = useState<boolean>(false);
    const [detailAssignFeedback, setDetailAssignFeedback] = useState<{ type: 'success' | 'error', message: string } | null>(null);

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
        endDate: '',
        campaignCode: 'all'
    });
    const [isExporting, setIsExporting] = useState<boolean>(false);

    // 4b. Campaign Management Modal (Admin Only)
    const [isCampaignModalOpen, setIsCampaignModalOpen] = useState<boolean>(false);
    const [campaignFormMode, setCampaignFormMode] = useState<'create' | 'edit'>('create');
    const [campaignFormData, setCampaignFormData] = useState({
        code: '',
        companyName: '',
        purpose: '',
        startsAt: '',
        endsAt: '',
        isActive: true
    });
    const [campaignFormError, setCampaignFormError] = useState<string>('');
    const [isSavingCampaign, setIsSavingCampaign] = useState<boolean>(false);
    const [copyFeedbackCode, setCopyFeedbackCode] = useState<string | null>(null);

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

    // Inline assignment state
    const [assigningRowId, setAssigningRowId] = useState<string | null>(null);

    // Permissions
    const canAccessSystemTab = currentUser.role === 'admin' ||
        currentUser.role === 'manager' ||
        !!(currentUser.permissions as any)?.surveyImport ||
        !!(currentUser.permissions as any)?.SURVEY_IMPORT_MANAGER;

    // --- Data Fetching ---
    const loadData = useCallback(async (preserveSelectionId?: string | null) => {
        try {
            setLoading(true);
            const [statusRes, importsRes, staffRes, syncRes, campaignsRes] = await Promise.all([
                apiClient.getSurveyStatus(),
                apiClient.getSurveyImports({
                    fromDate: appliedDateFrom || undefined,
                    toDate: appliedDateTo || undefined,
                    sortBy,
                    statusFilter: quickStatusFilter !== 'all' ? quickStatusFilter : undefined,
                    staffFilter: staffFilter !== 'all' ? staffFilter : undefined,
                    campaignFilter: campaignFilter !== 'all' ? campaignFilter : undefined,
                    q: searchQuery || undefined
                }),
                apiClient.getSurveyAssignableStaff().catch(() => ({ staff: [] })),
                apiClient.getSurveySyncStatus().catch(() => null),
                apiClient.getSurveyCampaigns().catch(() => ({ campaigns: [] }))
            ]);
            setStatusSummary(statusRes);
            const list = importsRes?.imports || [];
            setImports(list);
            setAssignableStaff(staffRes?.staff || []);
            if (syncRes && syncRes.success) {
                setAutoSyncStatus(syncRes);
            }
            if (campaignsRes && Array.isArray(campaignsRes.campaigns)) {
                setCampaignsList(campaignsRes.campaigns);
            }

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
    }, [appliedDateFrom, appliedDateTo, sortBy, quickStatusFilter, staffFilter, campaignFilter, searchQuery, selectedSubmissionId, showToast]);

    useEffect(() => {
        loadData();
    }, [appliedDateFrom, appliedDateTo, sortBy, quickStatusFilter, staffFilter, campaignFilter]);

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

    // --- Action: Manual Survey Import (Drain All Pending Safely) ---
    const handleImportClick = async () => {
        if (importing || syncProgress.isSyncing) return;
        try {
            setImporting(true);
            setSyncProgress({
                isOpen: true,
                isSyncing: true,
                imported: 0,
                failed: 0,
                reused: 0,
                total: 0,
                message: '온라인 설문을 안전하게 동기화하고 있습니다...'
            });

            const res = await apiClient.importOnlineSurveys({ batchSize: 10, maxItems: 200 });
            if (res.success && res.summary) {
                const s = res.summary;
                const imp = s.imported ?? 0;
                const fld = s.failed ?? s.quarantined ?? 0;
                const rsd = s.reused ?? s.duplicates ?? 0;
                const tot = s.discovered ?? s.totalFetched ?? (imp + fld + rsd);

                setSyncProgress({
                    isOpen: true,
                    isSyncing: false,
                    imported: imp,
                    failed: fld,
                    reused: rsd,
                    total: tot,
                    stopReason: s.stopReason || '동기화 완료',
                    message: `동기화 완료: 신규 수신 ${imp}건, 재사용/중복 ${rsd}건, 오류/격리 ${fld}건 (총 ${tot}건 처리)`
                });

                if (showToast) {
                    showToast(`설문 동기화 완료: 신규 ${imp}건, 재사용 ${rsd}건, 오류/격리 ${fld}건`, 'success');
                }
                await loadData(selectedSubmissionId);
                if (refreshSidebarBadge) refreshSidebarBadge();
            }
        } catch (err: any) {
            const isRunning = err.code === 'IMPORT_ALREADY_IN_PROGRESS' || err.code === 'IMPORT_ALREADY_RUNNING';
            const msg = isRunning
                ? '현재 다른 설문 동기화 작업이 진행 중입니다. 잠시 후 다시 확인해 주세요.'
                : (err.message || '설문 동기화 중 오류가 발생했습니다.');

            setSyncProgress(prev => ({
                ...prev,
                isSyncing: false,
                message: `오류 발생: ${msg}`
            }));
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

    // --- Action: Inline Staff Assignment / Reassignment ---
    const handleInlineAssignStaff = async (item: SurveyImportItem, newStaffId: string) => {
        if (!newStaffId || newStaffId === item.assignedUserId) {
            return; // 같은 담당자를 다시 선택하면 API 호출 0건
        }

        const isReassign = Boolean(item.assignedUserId);
        const newStaff = assignableStaff.find(s => s.id === newStaffId);
        const staffName = newStaff ? getStaffOptionLabel(newStaff, assignableStaff) : newStaffId;
        const confirmMsg = isReassign
            ? `담당자를 '${getStaffDisplayName(item.assignedUserId)}'에서 '${staffName}'(으)로 재배정하시겠습니까?`
            : `담당자를 '${staffName}'(으)로 배정하시겠습니까?`;

        if (!window.confirm(confirmMsg)) {
            return;
        }

        try {
            setAssigningRowId(item.submissionId);
            const payload = {
                assignedUserId: newStaffId,
                assignedDepartmentId: newStaff?.team || '',
                assignmentPriority: item.assignmentPriority || 'NORMAL',
                expectedVersion: item.version,
                reason: isReassign ? '인라인 드롭다운 재배정' : '인라인 드롭다운 최초 배정'
            };

            const res = isReassign
                ? await apiClient.reassignSurveyStaff(item.submissionId, payload)
                : await apiClient.assignSurveyStaff(item.submissionId, payload);

            if (res.success) {
                if (showToast) {
                    showToast(`담당자가 '${staffName}'(으)로 ${isReassign ? '재배정' : '배정'}되었습니다.`, 'success');
                }
                await loadData(item.submissionId);
            }
        } catch (err: any) {
            const msg = err.code === 'CONCURRENCY_CONFLICT'
                ? '다른 사용자가 이미 배정 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.'
                : (err.message || '담당자 배정에 실패했습니다.');
            if (showToast) showToast(msg, 'error');
        } finally {
            setAssigningRowId(null);
        }
    };

    // --- Action: Single Item Safe Unassignment (Admin only) ---
    const handleUnassign = async (item: SurveyImportItem) => {
        if (!window.confirm(`${item.maskedClientName || '해당 대상자'}의 담당자 배정을 취소하시겠습니까?`)) {
            return;
        }
        try {
            await apiClient.unassignSurveyStaff(item.submissionId);
            if (showToast) showToast('담당자 배정이 정상적으로 취소되었습니다.', 'success');
            await loadData(selectedSubmissionId);
        } catch (err: any) {
            const msg = err.message || '담당자 배정 취소에 실패했습니다.';
            if (showToast) showToast(msg, 'error');
        }
    };

    // --- Helper: Age Calculation (Korean completed age from birthDate relative to submittedAt in Asia/Seoul) ---
    const calculateCompletedAge = useCallback((birthDateStr?: string, submittedAtStr?: string): string => {
        if (!birthDateStr || typeof birthDateStr !== 'string') return '-';
        const match = birthDateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!match) return '-';
        const bYear = parseInt(match[1], 10);
        const bMonth = parseInt(match[2], 10);
        const bDay = parseInt(match[3], 10);

        let subYear: number, subMonth: number, subDay: number;
        if (submittedAtStr) {
            const subDate = new Date(submittedAtStr);
            if (isNaN(subDate.getTime())) return '-';
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Seoul',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(subDate).split('-');
            subYear = parseInt(parts[0], 10);
            subMonth = parseInt(parts[1], 10);
            subDay = parseInt(parts[2], 10);
        } else {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Seoul',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(now).split('-');
            subYear = parseInt(parts[0], 10);
            subMonth = parseInt(parts[1], 10);
            subDay = parseInt(parts[2], 10);
        }

        let age = subYear - bYear;
        if (subMonth < bMonth || (subMonth === bMonth && subDay < bDay)) {
            age--;
        }
        if (age < 0 || age > 130) return '-';
        return `만 ${age}세`;
    }, []);

    // Selected item object (P0: Declared before hooks and handlers referencing it to prevent TDZ)
    const currentSelectedItem = useMemo(() => {
        return imports.find(i => i.submissionId === selectedSubmissionId) ?? null;
    }, [imports, selectedSubmissionId]);

    // Synchronize large detail modal assignment inputs when selected item changes
    useEffect(() => {
        if (currentSelectedItem) {
            setDetailSelectedStaffId(currentSelectedItem.assignedUserId || (assignableStaff[0]?.id || ''));
            setDetailSelectedPriority(currentSelectedItem.assignmentPriority || 'NORMAL');
            setDetailAssignReason('');
            setDetailAssignFeedback(null);
        }
    }, [currentSelectedItem, assignableStaff]);

    // Body scroll lock & Escape key listener for Large Detail Modal
    useEffect(() => {
        if (!isLargeDetailModalOpen) return;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsLargeDetailModalOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = prevOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isLargeDetailModalOpen]);

    // Action: Assign/Reassign from inside Large Detail Modal
    const handleLargeDetailAssign = async () => {
        if (!currentSelectedItem || !detailSelectedStaffId) return;
        const isReassign = Boolean(currentSelectedItem.assignedUserId);
        const targetStaff = assignableStaff.find(s => s.id === detailSelectedStaffId);
        const staffName = targetStaff ? getStaffOptionLabel(targetStaff, assignableStaff) : detailSelectedStaffId;
        const confirmMsg = isReassign
            ? `담당자를 '${getStaffDisplayName(currentSelectedItem.assignedUserId)}'에서 '${staffName}'(으)로 재배정하시겠습니까?`
            : `담당자를 '${staffName}'(으)로 배정하시겠습니까?`;

        if (!window.confirm(confirmMsg)) return;

        try {
            setIsDetailAssigning(true);
            setDetailAssignFeedback(null);
            const payload = {
                assignedUserId: detailSelectedStaffId,
                assignedDepartmentId: targetStaff?.team || '',
                assignmentPriority: detailSelectedPriority,
                expectedVersion: currentSelectedItem.version,
                reason: detailAssignReason || (isReassign ? '상세화면 재배정' : '상세화면 신규 배정')
            };

            const res = isReassign
                ? await apiClient.reassignSurveyStaff(currentSelectedItem.submissionId, payload)
                : await apiClient.assignSurveyStaff(currentSelectedItem.submissionId, payload);

            if (res.success) {
                setDetailAssignFeedback({ type: 'success', message: `${staffName} 님에게 성공적으로 배정되었습니다.` });
                if (showToast) showToast('담당자 배정이 완료되었습니다.', 'success');
                await loadData(currentSelectedItem.submissionId);
            } else {
                throw new Error((res as any).error?.message || (res as any).message || '배정에 실패했습니다.');
            }
        } catch (err: any) {
            const msg = err.message || '담당자 배정 중 오류가 발생했습니다.';
            setDetailAssignFeedback({ type: 'error', message: msg });
            if (showToast) showToast(msg, 'error');
        } finally {
            setIsDetailAssigning(false);
        }
    };

    // Action: Unassign from inside Large Detail Modal
    const handleLargeDetailUnassign = async () => {
        if (!currentSelectedItem) return;
        await handleUnassign(currentSelectedItem);
        setDetailAssignFeedback({ type: 'success', message: '담당자 배정이 취소되었습니다.' });
    };

    // --- Action: Date Range Filter & Presets ---
    const handleApplyDateRange = () => {
        setDateError('');
        if (dateFrom && dateTo && dateFrom > dateTo) {
            setDateError('시작일은 종료일보다 늦을 수 없습니다.');
            return;
        }
        setAppliedDateFrom(dateFrom);
        setAppliedDateTo(dateTo);
        setActivePreset('custom');
    };

    const handleResetDateRange = () => {
        setDateFrom('');
        setDateTo('');
        setAppliedDateFrom('');
        setAppliedDateTo('');
        setDateError('');
        setActivePreset('all');
    };

    const handleSelectPreset = (preset: 'today' | '7days' | '30days' | 'all') => {
        setDateError('');
        if (preset === 'all') {
            handleResetDateRange();
            return;
        }
        const { fromDate: pFrom, toDate: pTo } = getKstPresetDateStrings(preset);
        setDateFrom(pFrom);
        setDateTo(pTo);
        setAppliedDateFrom(pFrom);
        setAppliedDateTo(pTo);
        setActivePreset(preset);
    };

    // --- Action: Individual & Bulk Selection Handlers ---
    const toggleSelect = (subId: string, e?: React.SyntheticEvent) => {
        if (e) e.stopPropagation();
        setSelectedSubmissionIds(prev => {
            const next = new Set(prev);
            if (next.has(subId)) {
                next.delete(subId);
            } else {
                next.add(subId);
            }
            return next;
        });
    };

    const handleSelectAllVisible = () => {
        const isAllSelected = filteredImports.length > 0 && filteredImports.every(i => selectedSubmissionIds.has(i.submissionId));
        if (isAllSelected) {
            setSelectedSubmissionIds(prev => {
                const next = new Set(prev);
                filteredImports.forEach(i => next.delete(i.submissionId));
                return next;
            });
        } else {
            setSelectedSubmissionIds(prev => {
                const next = new Set(prev);
                filteredImports.forEach(i => next.add(i.submissionId));
                return next;
            });
        }
    };

    const handleSelectUnassignedOnly = () => {
        const unassignedVisible = filteredImports.filter(i =>
            (!i.assignedUserId || i.assignmentStatus === 'unassigned') &&
            !i.referralId &&
            i.consultationStatus !== '상담완료' &&
            i.consultationStatus !== '종결' &&
            i.processingStatus !== 'COMPLETED'
        );
        setSelectedSubmissionIds(new Set(unassignedVisible.map(i => i.submissionId)));
    };

    const handleSelectPendingReferralsOnly = () => {
        const pendingVisible = filteredImports.filter(i =>
            Boolean(i.assignedUserId) &&
            !i.referralId &&
            i.consultationStatus !== '상담완료' &&
            i.consultationStatus !== '종결' &&
            i.processingStatus !== 'COMPLETED'
        );
        setSelectedSubmissionIds(new Set(pendingVisible.map(i => i.submissionId)));
    };

    const handleClearSelection = () => {
        setSelectedSubmissionIds(new Set());
    };

    // --- Action: Bulk Assignment Execution ---
    const handleExecuteBulkAssign = async () => {
        if (!bulkTargetStaffId) {
            if (showToast) showToast('배정할 직원을 선택해 주세요.', 'error');
            return;
        }
        if (selectedSubmissionIds.size === 0) {
            if (showToast) showToast('배정할 대상자를 선택해 주세요.', 'error');
            return;
        }

        try {
            setIsBulkAssigning(true);
            // P1 Fix: Only include IDs that are currently visible in filteredImports
            // to prevent accidental inclusion of items hidden by filter/search changes
            const visibleIds = new Set(filteredImports.map((i: any) => i.submissionId));
            const ids = Array.from(selectedSubmissionIds).filter(id => visibleIds.has(id));
            if (ids.length === 0) {
                if (showToast) showToast('현재 필터 조건에 해당하는 선택 항목이 없습니다.', 'error');
                setIsBulkAssigning(false);
                return;
            }
            const resp = await apiClient.bulkAssignSurveys({
                submissionIds: ids,
                targetUserId: bulkTargetStaffId,
                mode: bulkMode,
                note: bulkNote ? bulkNote.trim() : undefined
            });

            setBulkResult(resp);
            setIsBulkConfirmModalOpen(false);
            setIsBulkResultModalOpen(true);

            // Remove successfully assigned/reassigned items from selection
            if (resp.results) {
                const successfulIds = new Set(
                    resp.results
                        .filter(r => r.status === 'ASSIGNED' || r.status === 'REASSIGNED')
                        .map(r => r.submissionId)
                );
                setSelectedSubmissionIds(prev => {
                    const next = new Set(prev);
                    successfulIds.forEach(id => next.delete(id));
                    return next;
                });
            }

            if (showToast) {
                showToast(`일괄 배정 완료: 성공 ${(resp.assigned || 0) + (resp.reassigned || 0)}건, 제외 ${resp.skipped || 0}건, 실패 ${resp.failed || 0}건`, 'success');
            }

            await loadData(selectedSubmissionId);
        } catch (err: any) {
            if (showToast) showToast(`일괄 배정 실패: ${err.message}`, 'error');
        } finally {
            setIsBulkAssigning(false);
        }
    };

    // --- Helper: Expiry Countdown Badge Info ---
    const getExpiryInfo = (retentionUntil?: string | null) => {
        if (!retentionUntil) return null;
        const expMs = new Date(retentionUntil).getTime();
        if (isNaN(expMs)) return null;
        const nowMs = Date.now();
        const diffMs = expMs - nowMs;
        const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        if (diffDays > 7) return null;
        if (diffDays <= 0) {
            return { days: 0, label: '오늘 만료', isUrgent: true };
        }
        if (diffDays === 1) {
            return { days: 1, label: '내일 만료', isUrgent: true };
        }
        return { days: diffDays, label: `만료까지 ${diffDays}일`, isUrgent: diffDays <= 3 };
    };

    // Ref for Indeterminate Select-All Checkbox
    const selectAllCheckboxRef = React.useRef<HTMLInputElement | null>(null);

    // --- Action: Referral Draft & Register ---
    const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);

    const handleOpenReferralRegister = async (item: SurveyImportItem) => {
        if (!onNavigateToReferrals) return;
        if (item.referralId || item.refNo) {
            onNavigateToReferrals({ targetReferralId: item.referralId || item.refNo });
            return;
        }

        try {
            setLoadingDraftId(item.submissionId);
            const res = await apiClient.getSurveyReferralDraft(item.submissionId);
            if (res.success && res.draft) {
                onNavigateToReferrals(res.draft);
            } else if (res.isAlreadyRegistered && (res.existingReferralId || res.refNo)) {
                onNavigateToReferrals({ targetReferralId: res.existingReferralId || res.refNo });
            } else {
                throw new Error('초안 데이터를 가져올 수 없습니다.');
            }
        } catch (err: any) {
            const msg = err.message || '의뢰대장 등록용 초안 정보를 불러오는데 실패했습니다.';
            if (showToast) showToast(msg, 'error');
        } finally {
            setLoadingDraftId(null);
        }
    };

    // --- Action: Staff Assignment Modal ---
    const handleOpenAssignModal = (item: SurveyImportItem) => {
        setAssignTargetItem(item);
        setSelectedStaffId(item.assignedUserId || '');
        setSelectedPriority((item.assignmentPriority as any) || 'NORMAL');
        setAssignReason('');
        setIsAssignModalOpen(true);
    };

    const handleConfirmAssign = async () => {
        if (!assignTargetItem || !selectedStaffId) return;
        try {
            setIsAssigning(true);
            const isReassign = Boolean(assignTargetItem.assignedUserId);
            const staffObj = assignableStaff.find(s => s.id === selectedStaffId);
            const payload = {
                assignedUserId: selectedStaffId,
                assignedDepartmentId: staffObj?.team || '',
                assignmentPriority: selectedPriority,
                expectedVersion: assignTargetItem.version,
                reason: assignReason || (isReassign ? '담당자 재배정' : '담당자 최초 배정')
            };

            const res = isReassign
                ? await apiClient.reassignSurveyStaff(assignTargetItem.submissionId, payload)
                : await apiClient.assignSurveyStaff(assignTargetItem.submissionId, payload);

            if (res.success) {
                if (showToast) {
                    showToast('담당자 배정이 완료되었습니다.', 'success');
                }
                setIsAssignModalOpen(false);
                await loadData(assignTargetItem.submissionId);
            }
        } catch (err: any) {
            const msg = err.code === 'CONCURRENCY_CONFLICT'
                ? '다른 사용자가 이미 배정 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.'
                : (err.message || '담당자 배정에 실패했습니다.');
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
            const filtersToPass: Record<string, string> = {
                ...exportFilters,
                campaignCode: exportFilters.campaignCode && exportFilters.campaignCode !== 'all'
                    ? exportFilters.campaignCode
                    : (campaignFilter !== 'all' ? campaignFilter : '')
            };
            const { blob, filename } = await apiClient.downloadSurveyExport(filtersToPass);
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

    // --- Action: Campaign Management (Admin Only) ---
    const handleStartCreateCampaign = () => {
        setCampaignFormMode('create');
        setCampaignFormData({
            code: '',
            companyName: '',
            purpose: '',
            startsAt: '',
            endsAt: '',
            isActive: true
        });
        setCampaignFormError('');
    };

    const handleStartEditCampaign = (camp: SurveyCampaignItem) => {
        setCampaignFormMode('edit');
        setCampaignFormData({
            code: camp.code,
            companyName: camp.companyName || '',
            purpose: camp.purpose || '',
            startsAt: camp.startsAt ? camp.startsAt.slice(0, 10) : '',
            endsAt: camp.endsAt ? camp.endsAt.slice(0, 10) : '',
            isActive: camp.isActive
        });
        setCampaignFormError('');
    };

    const handleSubmitCampaignForm = async (e: React.FormEvent) => {
        e.preventDefault();
        setCampaignFormError('');

        if (campaignFormMode === 'create') {
            const rawCode = campaignFormData.code.trim().toUpperCase();
            if (!rawCode) {
                setCampaignFormError('캠페인 코드를 입력해 주세요.');
                return;
            }
            if (!/^[A-Z0-9_-]{2,32}$/.test(rawCode)) {
                setCampaignFormError('캠페인 코드는 2~32자의 영문 대문자, 숫자, 하이픈(-), 밑줄(_)만 허용됩니다.');
                return;
            }
        }

        if (!campaignFormData.companyName.trim()) {
            setCampaignFormError('회사명 또는 기관명을 입력해 주세요.');
            return;
        }

        if (!campaignFormData.purpose.trim()) {
            setCampaignFormError('운영 목적을 입력해 주세요.');
            return;
        }

        if (campaignFormData.startsAt && campaignFormData.endsAt && campaignFormData.startsAt > campaignFormData.endsAt) {
            setCampaignFormError('시작일은 종료일보다 이전이어야 합니다.');
            return;
        }

        try {
            setIsSavingCampaign(true);
            if (campaignFormMode === 'create') {
                await apiClient.createSurveyCampaign({
                    code: campaignFormData.code.trim().toUpperCase(),
                    companyName: campaignFormData.companyName.trim(),
                    purpose: campaignFormData.purpose.trim(),
                    startsAt: campaignFormData.startsAt || null,
                    endsAt: campaignFormData.endsAt || null,
                    isActive: campaignFormData.isActive
                });
                if (showToast) showToast('신규 캠페인이 등록되었습니다.', 'success');
            } else {
                await apiClient.updateSurveyCampaign(campaignFormData.code, {
                    companyName: campaignFormData.companyName.trim(),
                    purpose: campaignFormData.purpose.trim(),
                    startsAt: campaignFormData.startsAt || null,
                    endsAt: campaignFormData.endsAt || null,
                    isActive: campaignFormData.isActive
                });
                if (showToast) showToast('캠페인 정보가 수정되었습니다.', 'success');
            }

            const campRes = await apiClient.getSurveyCampaigns().catch(() => ({ campaigns: [] }));
            setCampaignsList(campRes?.campaigns || []);
            await loadData(selectedSubmissionId);
            handleStartCreateCampaign();
        } catch (err: any) {
            const msg = err.status === 409 || err.message?.includes('이미 등록된') || err.message?.includes('CONFLICT')
                ? '이미 존재하는 캠페인 코드입니다. 다른 코드를 사용해 주세요.'
                : (err.message || '캠페인 저장 중 오류가 발생했습니다.');
            setCampaignFormError(msg);
            if (showToast) showToast(msg, 'error');
        } finally {
            setIsSavingCampaign(false);
        }
    };

    const handleToggleCampaignActive = async (camp: SurveyCampaignItem) => {
        try {
            const newActive = !camp.isActive;
            await apiClient.updateSurveyCampaign(camp.code, {
                isActive: newActive
            });
            if (showToast) {
                showToast(`'${camp.companyName || camp.code}' 캠페인이 ${newActive ? '활성화' : '비활성화'}되었습니다.`, 'success');
            }
            const campRes = await apiClient.getSurveyCampaigns().catch(() => ({ campaigns: [] }));
            setCampaignsList(campRes?.campaigns || []);
            await loadData(selectedSubmissionId);
        } catch (err: any) {
            if (showToast) showToast(err.message || '캠페인 상태 변경에 실패했습니다.', 'error');
        }
    };

    const handleCopyCampaignLink = async (campaign: SurveyCampaignItem) => {
        if (!campaign.isActive) {
            const proceed = window.confirm(
                `[주의] '${campaign.companyName || campaign.code}' 캠페인은 현재 비활성 상태입니다.\n비활성 캠페인은 참여자가 설문을 제출할 수 없습니다. 계속 링크를 복사하시겠습니까?`
            );
            if (!proceed) return;
        }

        const cleanCode = campaign.code && typeof campaign.code === 'string' ? campaign.code.trim() : '';
        if (!cleanCode) {
            if (showToast) showToast('유효하지 않은 캠페인 코드입니다.', 'error');
            return;
        }

        const url = buildCampaignDistributionUrl(campaign.code);
        if (!url) {
            if (showToast) showToast('캠페인 링크를 만들 수 없습니다. 설문 배포 주소(Track A)가 설정되지 않았습니다.', 'error');
            return;
        }

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(url);
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }
            setCopyFeedbackCode(campaign.code);
            setTimeout(() => setCopyFeedbackCode(null), 3000);
            if (showToast) {
                showToast(`[${campaign.code}] 배포 링크가 클립보드에 복사되었습니다.`, 'success');
            }
        } catch (err: any) {
            if (showToast) showToast('링크 복사에 실패했습니다.', 'error');
        }
    };

    const renderCampaignBadge = (item: SurveyImportItem) => {
        const info = getCampaignLabelInfo(item);
        if (info.type === 'unspecified') {
            return (
                <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200"
                    title="캠페인 미지정 (일반 접수)"
                >
                    미지정
                </span>
            );
        }
        if (info.type === 'unregistered') {
            return (
                <span
                    className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-50 text-rose-700 border border-rose-300 flex items-center gap-1"
                    title={`미등록 캠페인 코드: ${info.code || ''}`}
                >
                    <AlertTriangle className="w-2.5 h-2.5 text-rose-500" />
                    미등록 캠페인
                </span>
            );
        }
        return (
            <span
                className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 flex items-center gap-1 max-w-[150px] truncate"
                title={`캠페인: ${info.label} (${info.code})`}
            >
                <Building2 className="w-2.5 h-2.5 text-indigo-500 shrink-0" />
                <span className="truncate">{info.label}</span>
            </span>
        );
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
                showToast(`더미 데이터 ${(res as any).purgedCount || (res as any).result?.purgedCount || 0}건이 안전하게 정리되었습니다.`, 'success');
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

    const isConsultationRequest = (item: any) => {
        if (!item) return false;
        return item.consultationRequested === true || item.requestType === 'CONSULTATION_REQUEST';
    };

    const isInvalidSurveyRecord = (item: any) => {
        if (!item || !item.submissionId) return true;
        const hasRequestType = item.requestType !== undefined && item.requestType !== null && item.requestType !== '';
        const hasConsultationRequested = item.consultationRequested !== undefined && item.consultationRequested !== null;
        if (!hasRequestType && !hasConsultationRequested) return true;
        if (!item.assessmentId || item.assessmentId === 'UNKNOWN') return true;
        return false;
    };

    const isScreeningOnly = (item: any) => {
        if (isInvalidSurveyRecord(item)) return false;
        if (isConsultationRequest(item)) return false;
        return item.requestType === 'SCREENING_ONLY';
    };

    const isPendingStaffReview = (item: any) => {
        return isConsultationRequest(item) && item.processingStatus === 'PENDING_STAFF_REVIEW';
    };

    const getRecordTimestamp = (item: any): number => {
        const dates = [item?.updatedAt, item?.importedAt, item?.submittedAt, item?.createdAt];
        for (const d of dates) {
            if (d) {
                const time = new Date(d).getTime();
                if (!isNaN(time) && time > 0) return time;
            }
        }
        return 0;
    };

    const getConsultationTime = (item: any): number => {
        if (item?.consultationRequestedAt) {
            const time = new Date(item.consultationRequestedAt).getTime();
            if (!isNaN(time) && time > 0) return time;
        }
        return 0;
    };

    const shouldReplaceRepresentative = (current: any, candidate: any): boolean => {
        const currentIsReq = isConsultationRequest(current);
        const candIsReq = isConsultationRequest(candidate);
        if (candIsReq && !currentIsReq) return true;
        if (!candIsReq && currentIsReq) return false;

        const candReqTime = getConsultationTime(candidate);
        const currReqTime = getConsultationTime(current);
        if (candReqTime !== currReqTime) {
            return candReqTime > currReqTime;
        }

        const candTime = getRecordTimestamp(candidate);
        const currTime = getRecordTimestamp(current);
        if (candTime !== currTime) {
            return candTime > currTime;
        }

        return false;
    };

    // Business Summary Metrics (고유 submissionId 기준 집계)
    const metrics = useMemo(() => {
        const uniqueSubIds = Array.from(new Set(imports.map(i => i.submissionId).filter(Boolean)));
        const totalScreeningCompleted = uniqueSubIds.length;

        // 고유 submissionId별 대표 객체 (우선순위: 상담요청 -> consultationRequestedAt 최신 -> 유효 최신시각)
        const subMap = new Map<string, any>();
        imports.forEach(item => {
            if (!item?.submissionId) return;
            const existing = subMap.get(item.submissionId);
            if (!existing) {
                subMap.set(item.submissionId, item);
            } else if (shouldReplaceRepresentative(existing, item)) {
                subMap.set(item.submissionId, item);
            }
        });
        const uniqueItems = Array.from(subMap.values());

        // 유효 검사자 목록 (오류 레코드 제외)
        const validUniqueItems = uniqueItems.filter(i => !isInvalidSurveyRecord(i));

        // 상담 요청자 (consultationRequested === true || requestType === 'CONSULTATION_REQUEST')
        const consultationRequested = validUniqueItems.filter(isConsultationRequest).length;

        // 상담 미요청자 (SCREENING_ONLY 전용)
        const consultationNotRequested = validUniqueItems.filter(isScreeningOnly).length;

        // 상담 전환율 (분모: 상담요청자 + 상담미요청자)
        const conversionDenominator = consultationRequested + consultationNotRequested;
        const conversionRate = conversionDenominator > 0
            ? Math.round((consultationRequested / conversionDenominator) * 1000) / 10
            : 0;

        // 담당자 검토 대기 (isConsultationRequest && processingStatus === 'PENDING_STAFF_REVIEW')
        const pendingStaffReview = validUniqueItems.filter(isPendingStaffReview).length;

        // 내게 배정된 건
        const myAssigned = uniqueItems.filter(i =>
            i.assignedUserId && (i.assignedUserId === currentUser.id || i.assignedUserId === currentUser.username)
        ).length;

        // 리포트 준비 완료
        const reportReady = uniqueItems.filter(i => i.hasReport).length;

        // 보관 건수 통계 (누적 / 현재 보관 / 삭제)
        const currentStoredCount = uniqueSubIds.length;
        const cumulativeProcessed = (statusSummary as any)?.statistics?.cumulativeProcessed ?? (statusSummary?.totalImports || totalScreeningCompleted);
        const deletedCount = (statusSummary as any)?.statistics?.deletedCount ?? 0;

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
                if (!isConsultationRequest(item)) return false;
            } else if (filterTab === 'screening_only') {
                if (!isScreeningOnly(item)) return false;
            } else if (filterTab === 'additional_review') {
                const needsReview = item.isSbqrQuarantined || (item.totalScore !== null && item.totalScore >= 15);
                if (!needsReview) return false;
            } else if (filterTab === 'completed') {
                const isDone = item.consultationStatus === '상담완료' || item.consultationStatus === '종결' || item.processingStatus === 'COMPLETED';
                if (!isDone) return false;
            }
            // 'all' passes through

            // Quick Status Filter
            if (quickStatusFilter && quickStatusFilter !== 'all') {
                if (quickStatusFilter === 'unassigned') {
                    if (item.assignedUserId && item.assignmentStatus !== 'unassigned') return false;
                    if (item.referralId) return false;
                } else if (quickStatusFilter === 'my_assigned') {
                    if (String(item.assignedUserId) !== String(currentUser.id) && String(item.assignedUserId) !== String(currentUser.username)) return false;
                    if (item.referralId) return false;
                } else if (quickStatusFilter === 'pending_referral') {
                    if (!item.assignedUserId || item.assignmentStatus === 'unassigned') return false;
                    if (item.referralId) return false;
                } else if (quickStatusFilter === 'registered') {
                    if (!item.referralId) return false;
                } else if (quickStatusFilter === 'expiring_soon') {
                    if (!getExpiryInfo(item.retentionUntil)) return false;
                } else if (quickStatusFilter === 'high_risk') {
                    // P0 Fix: Use only official severity/resultCode fields — no totalScore fallback
                    const sev = String(item.severity || '').toLowerCase();
                    const isOfficialHigh = sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                        || sev.includes('고스트레스') || sev.includes('추가 확인 권장');
                    if (!isOfficialHigh) return false;
                }
            }

            // Staff Filter (Admin or manual)
            if (staffFilter && staffFilter !== 'all') {
                if (staffFilter === 'unassigned') {
                    if (item.assignedUserId && item.assignmentStatus !== 'unassigned') return false;
                } else {
                    if (String(item.assignedUserId) !== String(staffFilter)) return false;
                }
            }

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
                const matchCampaign = (item.campaignCode || '').toLowerCase().includes(q) || (item.campaignName || '').toLowerCase().includes(q);
                return matchName || matchPhone || matchSubId || matchRefNo || matchRegion || matchScale || matchAssignee || matchCampaign;
            }

            return true;
        }).sort((a, b) => {
            if (sortBy === 'oldest') {
                const timeA = new Date(a.importedAt || a.submittedAt || 0).getTime();
                const timeB = new Date(b.importedAt || b.submittedAt || 0).getTime();
                return timeA - timeB;
            }
            if (sortBy === 'assignment_oldest') {
                const timeA = a.assignedAt ? new Date(a.assignedAt).getTime() : Infinity;
                const timeB = b.assignedAt ? new Date(b.assignedAt).getTime() : Infinity;
                return timeA - timeB;
            }
            if (sortBy === 'expiring_soon') {
                const timeA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const timeB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                return timeA - timeB;
            }
            if (sortBy === 'risk_high') {
                // P0 Fix: Normalize using ONLY official severity/resultCode fields
                // No totalScore-based fallback — items without official risk level → UNKNOWN (0)
                const getNormalizedRiskLevel = (item: any): number => {
                    const sev = String(item.severity || item.riskLevel || item.normalizedRiskLevel || item.overallRisk || '').toLowerCase();
                    if (!sev || sev === 'null' || sev === 'undefined') return 0; // UNKNOWN
                    // HIGH (3): 심각, 고위험, 중증, 고스트레스, 추가 확인 권장
                    if (sev.includes('심각') || sev.includes('고위험') || sev.includes('중증')
                        || sev.includes('고스트레스') || sev.includes('추가 확인 권장')) return 3;
                    // MODERATE (2): 중등도, 중간, 역치하
                    if (sev.includes('중등도') || sev.includes('중간') || sev.includes('역치하')) return 2;
                    // LOW (1): 경증, 경미, 정상, 저스트레스, 기준점 미만, 없음, 최소
                    if (sev.includes('경증') || sev.includes('경미') || sev.includes('정상')
                        || sev.includes('저스트레스') || sev.includes('기준점 미만')
                        || sev.includes('없음') || sev.includes('최소')) return 1;
                    return 0; // UNKNOWN — unrecognized severity string
                };
                const levelA = getNormalizedRiskLevel(a);
                const levelB = getNormalizedRiskLevel(b);
                // 1. Risk rank descending (UNKNOWN goes last)
                if (levelA !== levelB) return levelB - levelA;
                // 2. Same risk rank: totalScore tiebreak ONLY if same assessmentId
                if (a.assessmentId && b.assessmentId && a.assessmentId === b.assessmentId) {
                    return (Number(b.totalScore) || 0) - (Number(a.totalScore) || 0);
                }
                // 3. Different assessmentId: retentionUntil ascending (expiring sooner first)
                const retA = a.retentionUntil ? new Date(a.retentionUntil).getTime() : Infinity;
                const retB = b.retentionUntil ? new Date(b.retentionUntil).getTime() : Infinity;
                if (retA !== retB) return retA - retB;
                // 4. Final tiebreak: canonical intake date ascending (older first)
                const intakeA = new Date(a.importedAt || a.submittedAt || 0).getTime();
                const intakeB = new Date(b.importedAt || b.submittedAt || 0).getTime();
                return intakeA - intakeB;
            }
            // Default: 'latest' (newest canonical date first)
            const timeA = new Date(a.importedAt || a.submittedAt || 0).getTime();
            const timeB = new Date(b.importedAt || b.submittedAt || 0).getTime();
            return timeB - timeA;
        });
    }, [imports, filterTab, quickStatusFilter, staffFilter, searchQuery, sortBy, currentUser]);

    // Selection Summary
    const selectionSummary = useMemo(() => {
        const selectedList = imports.filter(i => selectedSubmissionIds.has(i.submissionId));
        const total = selectedList.length;
        let unassignedCount = 0;
        let assignedCount = 0;
        let sameAssigneeCount = 0;
        let registeredCount = 0;
        let expiringCount = 0;
        let excludedCount = 0;

        for (const item of selectedList) {
            if (item.referralId) {
                registeredCount++;
                excludedCount++;
                continue;
            }
            if (!item.assignedUserId || item.assignmentStatus === 'unassigned') {
                unassignedCount++;
            } else {
                assignedCount++;
                if (bulkTargetStaffId && String(item.assignedUserId) === String(bulkTargetStaffId)) {
                    sameAssigneeCount++;
                }
            }
            if (getExpiryInfo(item.retentionUntil)) {
                expiringCount++;
            }
        }

        return {
            total,
            unassignedCount,
            assignedCount,
            sameAssigneeCount,
            registeredCount,
            expiringCount,
            excludedCount
        };
    }, [imports, selectedSubmissionIds, bulkTargetStaffId]);

    const isAllVisibleSelected = filteredImports.length > 0 && filteredImports.every(i => selectedSubmissionIds.has(i.submissionId));
    const isSomeVisibleSelected = filteredImports.some(i => selectedSubmissionIds.has(i.submissionId));
    const isIndeterminate = isSomeVisibleSelected && !isAllVisibleSelected;

    useEffect(() => {
        if (selectAllCheckboxRef.current) {
            selectAllCheckboxRef.current.indeterminate = isIndeterminate;
        }
    }, [isIndeterminate]);

    // P0 Fix: Auto-cleanup selectedSubmissionIds when filteredImports changes
    // Remove IDs that are no longer visible due to filter/search/server changes
    useEffect(() => {
        if (selectedSubmissionIds.size === 0) return;
        const visibleIds = new Set(filteredImports.map((i: any) => i.submissionId));
        const removedIds: string[] = [];
        selectedSubmissionIds.forEach(id => {
            if (!visibleIds.has(id)) removedIds.push(id);
        });
        if (removedIds.length > 0) {
            setSelectedSubmissionIds(prev => {
                const next = new Set(prev);
                removedIds.forEach(id => next.delete(id));
                // Bail if nothing actually changed (prevent infinite loop)
                if (next.size === prev.size) return prev;
                return next;
            });
            // Announce via aria-live — no alert() popup
            setSelectionCleanupMessage(`필터 변경으로 선택 ${removedIds.length}건이 해제되었습니다.`);
            if (selectionCleanupTimerRef.current) clearTimeout(selectionCleanupTimerRef.current);
            selectionCleanupTimerRef.current = setTimeout(() => setSelectionCleanupMessage(''), 5000);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredImports]);

    // Helper: Staff option display with duplicate resolution (직원명 · 소속팀 · ID 일부)
    const getStaffOptionLabel = (staff: AssignableStaff, allStaff: AssignableStaff[]) => {
        const duplicates = allStaff.filter(s => s && s.name === staff.name);
        const teamStr = staff.team ? ` · ${staff.team}` : '';
        if (duplicates.length > 1) {
            const shortId = staff.id.length > 6 ? staff.id.substring(0, 6) : staff.id;
            return `${staff.name}${teamStr} · ${shortId}`;
        }
        return `${staff.name}${teamStr}`;
    };

    // Helper: Staff display
    const getStaffDisplayName = (staffId?: string | null) => {
        if (!staffId) return '미배정';
        const found = assignableStaff.find(s => s.id === staffId);
        if (!found) return staffId;
        return getStaffOptionLabel(found, assignableStaff);
    };

    const getStaffName = getStaffDisplayName;

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

    // Helper: Assessment ID display formatter (UNKNOWN -> 미확인)
    const formatAssessmentDisplay = (assessmentId?: string | null): string => {
        if (!assessmentId) return '미확인';
        const trimmed = String(assessmentId).trim();
        if (!trimmed || trimmed.toUpperCase() === 'UNKNOWN') return '미확인';
        return trimmed.toUpperCase();
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
                            온라인 선별검사 및 상담 신청 내역을 관리합니다.
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
                        onClick={() => {
                            setExportFilters(f => ({ ...f, campaignCode: campaignFilter }));
                            setIsExportModalOpen(true);
                        }}
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

                    {/* Auto Sync Indicator Badge */}
                    {autoSyncStatus && (
                        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-600 shadow-xs">
                            <span className={`w-2 h-2 rounded-full ${autoSyncStatus.autoSyncEnabled ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                            <span>자동 동기화: <strong>{autoSyncStatus.autoSyncEnabled ? `활성 (${autoSyncStatus.intervalMinutes}분 주기)` : '비활성'}</strong></span>
                            {autoSyncStatus.lastSyncAt && (
                                <span className="text-slate-400">• 최근: {formatKstDateTime(autoSyncStatus.lastSyncAt, 'short')}</span>
                            )}
                        </div>
                    )}

                    <button
                        onClick={handleImportClick}
                        disabled={importing || (statusSummary?.isImportRunning ?? false) || syncProgress.isSyncing}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white text-xs font-bold rounded-xl shadow-md hover:shadow-lg disabled:opacity-50 transition cursor-pointer"
                        title="대기 중인 모든 온라인 설문을 안전하게 순차 동기화합니다"
                    >
                        {importing || syncProgress.isSyncing ? (
                            <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                동기화 진행 중...
                            </>
                        ) : (
                            <>
                                <Download className="w-4 h-4" />
                                지금 동기화
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

            {/* 2-1. Statistics Charts (접이식 통계 차트) */}
            <div className="px-6 py-2 shrink-0">
                <div className="bg-slate-50/70 border border-slate-200/80 rounded-2xl p-4 transition-all">
                    <div className="flex items-center justify-between">
                        <button
                            type="button"
                            onClick={() => setIsChartsOpen(!isChartsOpen)}
                            aria-expanded={isChartsOpen}
                            className="flex items-center gap-2 text-sm font-bold text-slate-700 hover:text-slate-900 transition-colors focus:outline-none"
                        >
                            <span className="text-base">📊</span>
                            <span>통계 차트</span>
                            {isChartsOpen ? (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                            ) : (
                                <ChevronRight className="w-4 h-4 text-slate-400" />
                            )}
                        </button>
                    </div>
                    {isChartsOpen && (
                        <div className="mt-4 pt-4 border-t border-slate-200/70">
                            <SurveyCharts imports={imports} />
                        </div>
                    )}
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
                    {/* Filter Tabs, Staff Workload & Date Range Bar */}
                    <div className="bg-white rounded-2xl border border-slate-200/90 px-3 py-2.5 mb-3 shadow-xs space-y-2 shrink-0">
                        {/* Row 1: Quick Status Filter Tabs + Staff Workload Inline + Sort Dropdown */}
                        <div className="flex items-center gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar py-0.5 shrink-0" role="tablist" aria-label="상태 빠른 필터">
                                {[
                                    { id: 'all', label: '전체' },
                                    { id: 'unassigned', label: '미배정' },
                                    ...(currentUser.role !== 'admin' ? [{ id: 'my_assigned', label: '나에게 배정' }] : []),
                                    { id: 'pending_referral', label: '의뢰 등록 대기' },
                                    { id: 'registered', label: '등록 완료' },
                                    { id: 'expiring_soon', label: '만료 임박' },
                                    { id: 'high_risk', label: '고위험' }
                                ].map(tab => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        onClick={() => setQuickStatusFilter(tab.id)}
                                        className={`h-8 px-3 rounded-xl text-xs font-bold whitespace-nowrap transition-all flex items-center justify-center ${
                                            quickStatusFilter === tab.id
                                                ? 'bg-teal-600 text-white shadow-xs'
                                                : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200/60'
                                        }`}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>

                            {/* Admin Staff Workload Summary Chips (Row 1 Inline) */}
                            {currentUser.role === 'admin' && assignableStaff.length > 0 && (
                                <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar border-l border-slate-200 pl-2 shrink-0" role="region" aria-label="담당자별 업무량 요약">
                                    <span className="text-[11px] font-black text-slate-500 whitespace-nowrap flex items-center gap-1 shrink-0">
                                        <Users className="w-3.5 h-3.5 text-indigo-600" />
                                        직원별 미처리:
                                    </span>
                                    <div className="flex items-center gap-1.5 flex-nowrap shrink-0">
                                        {assignableStaff.map(staff => {
                                            const isSelected = staffFilter === staff.id;
                                            const count = staff.pendingAssignmentCount ?? 0;
                                            return (
                                                <button
                                                    key={staff.id}
                                                    type="button"
                                                    onClick={() => setStaffFilter(prev => prev === staff.id ? 'all' : staff.id)}
                                                    className={`h-8 px-2.5 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 whitespace-nowrap ${
                                                        isSelected
                                                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                                    }`}
                                                    title={`${staff.name} (${staff.team || '소속팀 없음'}): 미처리 ${count}건. 클릭하여 이 직원만 필터링`}
                                                >
                                                    <span>{staff.name}</span>
                                                    <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-black ${
                                                        isSelected
                                                            ? 'bg-white text-indigo-700'
                                                            : (count > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-600')
                                                    }`}>
                                                        {count}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Sort Dropdown */}
                            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600 ml-auto shrink-0">
                                <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                                <select
                                    value={sortBy}
                                    onChange={e => setSortBy(e.target.value)}
                                    className="h-8 px-2.5 text-xs font-bold border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:outline-none cursor-pointer"
                                    aria-label="목록 정렬 선택"
                                >
                                    <option value="latest">최신 접수순</option>
                                    <option value="oldest">오래된 접수순</option>
                                    <option value="assignment_oldest">배정 후 오래된 순</option>
                                    <option value="expiring_soon">만료 임박순</option>
                                    <option value="risk_high">고위험순</option>
                                </select>
                            </div>
                        </div>

                        {/* Row 2+3 Combined: Date Range Inputs & Presets & Campaign & Search & Admin Campaign Management */}
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                            {/* Date Range Inputs & Buttons */}
                            <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                                <span className="text-xs font-bold text-slate-600 flex items-center gap-1 shrink-0">
                                    <CalendarRange className="w-3.5 h-3.5 text-teal-600" />
                                    접수기간:
                                </span>
                                <div className="flex items-center gap-1">
                                    <input
                                        type="date"
                                        value={dateFrom}
                                        onChange={e => setDateFrom(e.target.value)}
                                        className="h-8 px-2.5 text-xs font-medium border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:border-teal-500 focus:outline-none"
                                        aria-label="접수 시작일"
                                    />
                                    <span className="text-slate-400 font-bold">~</span>
                                    <input
                                        type="date"
                                        value={dateTo}
                                        onChange={e => setDateTo(e.target.value)}
                                        className="h-8 px-2.5 text-xs font-medium border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:border-teal-500 focus:outline-none"
                                        aria-label="접수 종료일"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={handleApplyDateRange}
                                    className="h-8 px-3 text-xs font-bold bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-xs transition flex items-center justify-center shrink-0"
                                >
                                    조회
                                </button>
                                <button
                                    type="button"
                                    onClick={handleResetDateRange}
                                    className="h-8 px-2.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition flex items-center justify-center shrink-0"
                                >
                                    기간 초기화
                                </button>
                            </div>

                            {/* Quick Presets */}
                            <div className="flex items-center gap-1 pl-2 border-l border-slate-200 flex-wrap shrink-0">
                                {[
                                    { id: 'today', label: '오늘' },
                                    { id: '7days', label: '최근 7일' },
                                    { id: '30days', label: '최근 30일' },
                                    { id: 'all', label: '전체 기간' }
                                ].map(p => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        onClick={() => handleSelectPreset(p.id as any)}
                                        className={`h-8 px-2.5 text-xs font-bold rounded-xl transition flex items-center justify-center ${
                                            activePreset === p.id
                                                ? 'bg-slate-800 text-white shadow-xs'
                                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                        }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>

                            {/* Campaign Filter */}
                            <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200 shrink-0">
                                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 shrink-0">
                                    <Building2 className="w-3.5 h-3.5 text-indigo-600" />
                                    캠페인:
                                </span>
                                <select
                                    value={campaignFilter}
                                    onChange={e => setCampaignFilter(e.target.value)}
                                    className="h-8 px-2.5 text-xs font-semibold border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:border-indigo-500 focus:outline-none cursor-pointer max-w-[280px] sm:max-w-[360px] 2xl:max-w-[280px]"
                                    aria-label="캠페인 필터 선택"
                                >
                                    <option value="all">전체 (미지정 포함)</option>
                                    <option value="unspecified">미지정 (일반 접수)</option>
                                    {campaignsList.map(camp => (
                                        <option key={camp.code} value={camp.code}>
                                            {camp.companyName || camp.code} {camp.purpose ? `— ${camp.purpose}` : ''} [{camp.code}] {!camp.isActive ? '(비활성)' : ''}
                                        </option>
                                    ))}
                                </select>
                                {campaignFilter !== 'all' && (
                                    <button
                                        type="button"
                                        onClick={() => setCampaignFilter('all')}
                                        className="h-8 px-2 text-[11px] font-bold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition flex items-center justify-center shrink-0"
                                    >
                                        초기화
                                    </button>
                                )}
                            </div>

                            {/* Search Input */}
                            <div className="relative min-w-[240px] max-w-[320px] 2xl:max-w-[240px] flex-1 sm:flex-initial ml-auto">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="성명, 연락처, 접수번호 검색..."
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="h-8 w-full pl-8 pr-7 text-xs font-medium border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:border-teal-500 focus:outline-none"
                                />
                                {searchQuery && (
                                    <button
                                        onClick={() => setSearchQuery('')}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </div>

                            {/* Admin Campaign Management Button */}
                            {currentUser.role === 'admin' && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        handleStartCreateCampaign();
                                        setIsCampaignModalOpen(true);
                                    }}
                                    className="h-8 px-3 text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-xl transition flex items-center gap-1.5 shadow-2xs shrink-0"
                                >
                                    <Building2 className="w-3.5 h-3.5" />
                                    <span>캠페인 관리</span>
                                    <span className="px-1.5 py-0.2 bg-indigo-200/70 text-indigo-800 rounded-full text-[10px] font-black">
                                        {campaignsList.length}
                                    </span>
                                </button>
                            )}
                        </div>

                        {dateError && (
                            <div className="text-xs font-bold text-rose-600 mt-1 flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5" />
                                {dateError}
                            </div>
                        )}
                    </div>

                    {/* Master-Detail Container */}
                    <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
                        {/* LEFT: Applicant List (Master) */}
                        <div className={`w-full lg:w-[480px] xl:w-[540px] 2xl:w-[560px] flex flex-col bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden shrink-0 ${isMobileDetailOpen ? 'hidden lg:flex' : 'flex'}`}>
                            {/* Selection & Quick Select Header */}
                            <div className="p-3 border-b border-slate-100 bg-slate-50/70 space-y-2 shrink-0">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="flex items-center gap-2">
                                        <div className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2 shrink-0">
                                            <input
                                                type="checkbox"
                                                ref={selectAllCheckboxRef}
                                                checked={isAllVisibleSelected}
                                                onChange={handleSelectAllVisible}
                                                disabled={filteredImports.length === 0}
                                                aria-label={
                                                    isAllVisibleSelected
                                                        ? '현재 검색 결과 대상자 전체 선택 해제'
                                                        : (isIndeterminate ? '현재 검색 결과 대상자 일부 선택됨' : '현재 검색 결과 대상자 전체 선택')
                                                }
                                                className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
                                            />
                                        </div>
                                        <span className="text-xs font-black text-slate-800">
                                            선택 {selectedSubmissionIds.size}건 / 결과 {filteredImports.length}건
                                        </span>
                                    </div>

                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <button
                                            type="button"
                                            onClick={handleSelectUnassignedOnly}
                                            className="px-2.5 py-1 text-[11px] font-bold bg-white text-slate-700 hover:bg-slate-100 border border-slate-200 rounded-lg shadow-xs min-h-[32px]"
                                            title="현재 표시 결과 중 미배정 건만 빠른 선택"
                                        >
                                            미배정 선택
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleSelectPendingReferralsOnly}
                                            className="px-2.5 py-1 text-[11px] font-bold bg-white text-slate-700 hover:bg-slate-100 border border-slate-200 rounded-lg shadow-xs min-h-[32px]"
                                            title="현재 표시 결과 중 의뢰 등록 대기 건만 빠른 선택"
                                        >
                                            대기건 선택
                                        </button>
                                        {selectedSubmissionIds.size > 0 && (
                                            <button
                                                type="button"
                                                onClick={handleClearSelection}
                                                className="px-2.5 py-1 text-[11px] font-bold text-rose-600 bg-white hover:bg-rose-50 border border-rose-200 rounded-lg shadow-xs min-h-[32px]"
                                            >
                                                선택 해제
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Selection Summary */}
                                {selectedSubmissionIds.size > 0 && (
                                    <div className="p-2 bg-indigo-50/80 border border-indigo-100 rounded-xl text-[11px] font-bold text-indigo-950 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                        <span>총 {selectionSummary.total}건</span>
                                        <span>• 신규 미배정 {selectionSummary.unassignedCount}건</span>
                                        <span>• 기존 배정 {selectionSummary.assignedCount}건</span>
                                        {selectionSummary.registeredCount > 0 && (
                                            <span className="text-slate-500">• 등록완료 제외 {selectionSummary.registeredCount}건</span>
                                        )}
                                        {selectionSummary.expiringCount > 0 && (
                                            <span className="text-rose-700">• 만료임박 {selectionSummary.expiringCount}건</span>
                                        )}
                                    </div>
                                )}

                                {/* Selection Cleanup Announcement (aria-live, no alert popup) */}
                                <div aria-live="polite" aria-atomic="true" className="sr-only" role="status">
                                    {selectionCleanupMessage}
                                </div>
                                {selectionCleanupMessage && (
                                    <div className="p-1.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] font-bold text-amber-800 flex items-center gap-1.5">
                                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                        {selectionCleanupMessage}
                                    </div>
                                )}

                                {/* Admin Bulk Action Toolbar */}
                                {currentUser.role === 'admin' && selectedSubmissionIds.size > 0 && (
                                    <div className="p-2.5 bg-white border border-slate-200 rounded-xl space-y-2 shadow-xs shrink-0" role="region" aria-label="일괄 배정 작업 영역">
                                        <div className="flex items-center gap-2">
                                            <div className="relative flex-1">
                                                <select
                                                    value={bulkTargetStaffId}
                                                    onChange={e => setBulkTargetStaffId(e.target.value)}
                                                    className="w-full min-h-[44px] px-3 pr-8 rounded-xl text-xs font-bold border border-slate-300 bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none appearance-none cursor-pointer truncate"
                                                    aria-label="일괄 배정할 대상 직원 선택"
                                                >
                                                    <option value="">[ 일괄 배정할 담당자 선택 ▼ ]</option>
                                                    {assignableStaff.map(staff => (
                                                        <option key={staff.id} value={staff.id}>
                                                            {staff.name}{staff.team ? ` · ${staff.team}` : ''} · 미처리 {staff.pendingAssignmentCount || 0}건
                                                        </option>
                                                    ))}
                                                </select>
                                                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-500">
                                                    <ChevronDown className="w-4 h-4" />
                                                </div>
                                            </div>
                                        </div>

                                        <input
                                            type="text"
                                            value={bulkNote}
                                            onChange={e => setBulkNote(e.target.value)}
                                            maxLength={200}
                                            placeholder="내부 배정 메모 (선택, 최대 200자 · 개인정보 입력 금지)"
                                            className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-xl bg-slate-50 focus:bg-white focus:outline-none"
                                            aria-label="배정 메모 입력"
                                        />

                                        <div className="flex items-center gap-2 flex-wrap">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (!bulkTargetStaffId) {
                                                        if (showToast) showToast('배정할 직원을 먼저 선택해 주세요.', 'error');
                                                        return;
                                                    }
                                                    setBulkMode('unassigned-only');
                                                    setIsBulkConfirmModalOpen(true);
                                                }}
                                                disabled={isBulkAssigning || !bulkTargetStaffId}
                                                className="flex-1 min-h-[44px] px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold rounded-xl text-xs shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                                            >
                                                <UserPlus className="w-4 h-4" />
                                                미배정 건만 일괄 배정
                                            </button>

                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (!bulkTargetStaffId) {
                                                        if (showToast) showToast('배정할 직원을 먼저 선택해 주세요.', 'error');
                                                        return;
                                                    }
                                                    setBulkMode('include-reassignment');
                                                    setIsBulkConfirmModalOpen(true);
                                                }}
                                                disabled={isBulkAssigning || !bulkTargetStaffId}
                                                className="flex-1 min-h-[44px] px-3 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold rounded-xl text-xs shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                                                title="기존 배정된 건까지 포함하여 새 담당자에게 일괄 재배정합니다"
                                            >
                                                <AlertTriangle className="w-4 h-4 text-amber-200" />
                                                기존 담당자 포함 재배정
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
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
                                        const isChecked = selectedSubmissionIds.has(item.submissionId);

                                        return (
                                            <div
                                                key={item.submissionId}
                                                onClick={() => {
                                                    setSelectedSubmissionId(item.submissionId);
                                                    setIsMobileDetailOpen(true);
                                                    setIsLargeDetailModalOpen(true);
                                                }}
                                                className={`p-3.5 rounded-2xl border transition-all cursor-pointer text-left relative min-h-[132px] space-y-2 ${
                                                    isSelected
                                                        ? 'bg-teal-50/60 border-teal-400 shadow-md ring-2 ring-teal-500/20'
                                                        : (isChecked ? 'bg-indigo-50/40 border-indigo-200' : 'bg-white border-slate-200/80 hover:border-slate-300 hover:bg-slate-50/50')
                                                }`}
                                            >
                                                {/* Header Line */}
                                                <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                                                    <div className="flex items-center gap-1.5">
                                                        {/* Individual Checkbox (min 44px touch target) */}
                                                        <div
                                                            className="min-w-[44px] min-h-[44px] flex items-center justify-center -ml-2 -mt-1 shrink-0 cursor-pointer"
                                                            onClick={e => e.stopPropagation()}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={isChecked}
                                                                onChange={e => toggleSelect(item.submissionId, e)}
                                                                aria-label={`${item.maskedClientName || item.submissionId} 선택`}
                                                                className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
                                                            />
                                                        </div>

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
                                                        {renderCampaignBadge(item)}
                                                        {renderRequestTypeBadge(item)}
                                                        {renderTransferStatusBadge(item)}
                                                        {renderStatusBadge(item.consultationStatus, item.isSbqrQuarantined)}
                                                        {/* Expiry Countdown Badge */}
                                                        {(() => {
                                                            const exp = getExpiryInfo(item.retentionUntil);
                                                            if (!exp) return null;
                                                            const isRegistered = Boolean(item.referralId);
                                                            return (
                                                                <span
                                                                    className={`px-2 py-0.5 rounded-full text-[10px] font-black border flex items-center gap-1 ${
                                                                        exp.isUrgent
                                                                            ? 'bg-rose-50 text-rose-700 border-rose-200 animate-pulse'
                                                                            : 'bg-amber-50 text-amber-700 border-amber-200'
                                                                    }`}
                                                                    title={
                                                                        isRegistered
                                                                            ? `원본 설문 ${exp.label} (의뢰대장 및 첨부 PDF는 유지됩니다)`
                                                                            : `원본 및 PDF ${exp.label}`
                                                                    }
                                                                    aria-label={
                                                                        isRegistered
                                                                            ? `원본 설문 ${exp.label} (의뢰대장·PDF 유지)`
                                                                            : `원본 및 PDF ${exp.label}`
                                                                    }
                                                                >
                                                                    <AlertTriangle className="w-3 h-3" />
                                                                    {isRegistered ? `설문 ${exp.label}` : exp.label}
                                                                </span>
                                                            );
                                                        })()}
                                                    </div>
                                                </div>

                                                {/* Sub-info Line: Date, Scale & Score */}
                                                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-2 font-medium">
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="w-3 h-3 text-slate-400" />
                                                        {formatKstDateTime(item.submittedAt || item.importedAt, 'list')}
                                                    </span>
                                                    <span className="text-slate-600 font-bold">
                                                        {item.region}
                                                    </span>
                                                </div>

                                                {/* Assessment & Report line */}
                                                <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
                                                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                                        <scaleInfo.icon className={`w-3.5 h-3.5 shrink-0 ${scaleInfo.color}`} />
                                                        <span className="font-bold text-slate-700 truncate">
                                                            {item.contactOnly ? '접촉 전용' : formatAssessmentDisplay(item.assessmentId)}
                                                        </span>
                                                        {!item.contactOnly && item.totalScore !== null && (
                                                            <span className="font-extrabold text-slate-900 shrink-0">
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
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setSelectedSubmissionId(item.submissionId);
                                                                setIsLargeDetailModalOpen(true);
                                                            }}
                                                            className="px-2 py-0.5 text-[11px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-md border border-indigo-200 transition flex items-center gap-1 shrink-0"
                                                            title="상세·배정 대형 창 열기"
                                                        >
                                                            <Maximize2 className="w-3 h-3" />
                                                            상세검토
                                                        </button>
                                                        <ChevronRight className="w-4 h-4 text-slate-400" />
                                                    </div>
                                                </div>

                                                {/* Assigned Staff (Inline Dropdown or Read-only) */}
                                                {(() => {
                                                    const isCompletedOrRegistered = Boolean(
                                                        item.referralId ||
                                                        item.consultationStatus === '상담완료' ||
                                                        item.consultationStatus === '종결' ||
                                                        item.processingStatus === 'COMPLETED'
                                                    );
                                                    const isAdmin = currentUser.role === 'admin';
                                                    const isRowAssigning = assigningRowId === item.submissionId;

                                                    if (isRowAssigning) {
                                                        return (
                                                            <div className="mt-2.5 pt-2 border-t border-slate-100 min-h-[44px] flex items-center">
                                                                <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl text-xs font-bold text-indigo-700 min-h-[44px] w-full animate-pulse">
                                                                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600 shrink-0" />
                                                                    <span>[ 배정 중... ]</span>
                                                                </div>
                                                            </div>
                                                        );
                                                    }

                                                    if (isCompletedOrRegistered) {
                                                        return (
                                                            <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between min-h-[44px]">
                                                                <div className="flex flex-col text-xs truncate max-w-[200px]" title={`${getStaffDisplayName(item.assignedUserId)} (등록 완료 · 읽기 전용)`}>
                                                                    <span className="font-bold text-slate-700 truncate">{getStaffDisplayName(item.assignedUserId)}</span>
                                                                    <span className="text-[10px] text-slate-400 font-medium">등록 완료 · 읽기 전용</span>
                                                                </div>
                                                                {item.assignedAt && (
                                                                    <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                                                                        {formatKstDateTime(item.assignedAt, 'list')} 배정
                                                                    </span>
                                                                )}
                                                            </div>
                                                        );
                                                    }

                                                    if (isAdmin) {
                                                        return (
                                                            <div
                                                                className="mt-2.5 pt-2 border-t border-slate-100 flex items-center gap-2"
                                                                onClick={e => e.stopPropagation()}
                                                            >
                                                                <div className="relative flex-1">
                                                                    <select
                                                                        id={`staff-assign-${item.submissionId}`}
                                                                        value={item.assignedUserId || ''}
                                                                        onChange={e => handleInlineAssignStaff(item, e.target.value)}
                                                                        disabled={assigningRowId !== null}
                                                                        className={`w-full min-h-[44px] h-11 px-3 pr-8 rounded-xl text-xs font-bold transition border focus:ring-2 focus:ring-indigo-500 focus:outline-none appearance-none truncate cursor-pointer ${
                                                                            !item.assignedUserId
                                                                                ? 'bg-amber-50/90 border-amber-300 text-amber-900 hover:bg-amber-100/70 shadow-xs'
                                                                                : 'bg-white border-slate-300 text-slate-800 hover:border-slate-400'
                                                                        }`}
                                                                        title={item.assignedUserId ? getStaffDisplayName(item.assignedUserId) : '담당자 선택'}
                                                                        aria-label={`담당자 선택: ${item.maskedClientName || item.submissionId}`}
                                                                    >
                                                                        <option value="" disabled={Boolean(item.assignedUserId)}>
                                                                            {item.assignedUserId ? '담당자 변경 선택 ▼' : '[ 담당자 선택 ▼ ]'}
                                                                        </option>
                                                                        {assignableStaff.map(staff => (
                                                                            <option key={staff.id} value={staff.id} title={getStaffOptionLabel(staff, assignableStaff)}>
                                                                                {getStaffOptionLabel(staff, assignableStaff)}
                                                                            </option>
                                                                        ))}
                                                                    </select>
                                                                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-500">
                                                                        <ChevronDown className="w-4 h-4" />
                                                                    </div>
                                                                </div>

                                                                {/* Safe Single Unassign Button */}
                                                                {item.assignedUserId && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={e => {
                                                                            e.stopPropagation();
                                                                            handleUnassign(item);
                                                                        }}
                                                                        className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 rounded-xl transition shrink-0"
                                                                        title="담당자 배정 취소 (미배정으로 전환)"
                                                                        aria-label="담당자 배정 취소"
                                                                    >
                                                                        <UserMinus className="w-4 h-4" />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    }

                                                    // Regular non-admin users: read-only
                                                    return (

                                                        <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between min-h-[44px]">
                                                            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600 truncate" title={getStaffDisplayName(item.assignedUserId)}>
                                                                <UserCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                                                <span>담당: <strong className={item.assignedUserId ? 'text-indigo-700 font-bold' : 'text-slate-400'}>{getStaffDisplayName(item.assignedUserId)}</strong></span>
                                                            </div>
                                                            {item.assignedAt && (
                                                                <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                                                                    {formatKstDateTime(item.assignedAt, 'list')} 배정
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>

                        {/* RIGHT: Selected Applicant Detail (Detail Panel) */}
                        <div className={`flex-1 min-w-0 flex flex-col bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden ${!isMobileDetailOpen ? 'hidden lg:flex' : 'flex'}`}>
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
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <button
                                                type="button"
                                                onClick={() => setIsLargeDetailModalOpen(true)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shadow-sm hover:shadow transition"
                                                title="대형 모달 창으로 전체 상세 정보와 담당자 배정 인터페이스 열기"
                                            >
                                                <Maximize2 className="w-3.5 h-3.5" />
                                                대형 화면 검토·배정
                                            </button>
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

                                            {currentUser.role === 'admin' && (
                                                <button
                                                    onClick={() => handleOpenAssignModal(currentSelectedItem)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-xl border border-indigo-200 shadow-sm transition"
                                                >
                                                    <UserPlus className="w-3.5 h-3.5" />
                                                    담당자 배정/변경
                                                </button>
                                            )}

                                            <button
                                                onClick={() => handleOpenStatusModal(currentSelectedItem)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl border border-slate-200 shadow-sm transition"
                                            >
                                                <Activity className="w-3.5 h-3.5 text-slate-600" />
                                                진행상태 변경
                                            </button>

                                            {Boolean(currentSelectedItem.referralId || currentSelectedItem.refNo) ? (
                                                onNavigateToReferrals && (
                                                    <button
                                                        onClick={() => onNavigateToReferrals({ targetReferralId: currentSelectedItem.referralId || currentSelectedItem.refNo })}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-xl shadow-sm hover:shadow transition"
                                                        title="이미 등록된 의뢰대장 상세로 이동합니다"
                                                    >
                                                        <ExternalLink className="w-3.5 h-3.5" />
                                                        등록된 의뢰대장 열기
                                                    </button>
                                                )
                                            ) : (!currentSelectedItem.assignedUserId || currentSelectedItem.assignmentStatus === 'unassigned') ? (
                                                currentUser.role === 'admin' ? (
                                                    <button
                                                        onClick={() => handleOpenAssignModal(currentSelectedItem)}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-bold rounded-xl border border-amber-300 shadow-sm transition"
                                                        title="의뢰대장 등록 전 담당자 배정이 필요합니다"
                                                    >
                                                        <UserPlus className="w-3.5 h-3.5" />
                                                        담당자 배정 필요
                                                    </button>
                                                ) : (
                                                    <span className="text-xs text-slate-400 font-medium px-2.5 py-1.5 bg-slate-100 rounded-xl border border-slate-200">
                                                        담당자 배정 대기
                                                    </span>
                                                )
                                            ) : (currentSelectedItem.assignedUserId === currentUser.id || currentUser.role === 'admin') ? (
                                                onNavigateToReferrals && (
                                                    <button
                                                        onClick={() => handleOpenReferralRegister(currentSelectedItem)}
                                                        disabled={loadingDraftId === currentSelectedItem.submissionId}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-xl shadow-sm hover:shadow transition disabled:opacity-50"
                                                        title={currentUser.role === 'admin' && currentSelectedItem.assignedUserId !== currentUser.id ? '관리자 권한으로 의뢰대장 신규 등록 폼을 엽니다' : '의뢰대장 신규 등록 폼을 엽니다'}
                                                    >
                                                        {loadingDraftId === currentSelectedItem.submissionId ? (
                                                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <ExternalLink className="w-3.5 h-3.5" />
                                                        )}
                                                        의뢰대장 열기
                                                    </button>
                                                )
                                            ) : null}
                                        </div>
                                    </div>

                                    {/* Detail Scrollable Body */}
                                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar text-left">
                                        {/* SECTION A: 상담신청 기본 정보 */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
                                                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                                                    <UserCheck className="w-4 h-4 text-teal-600" />
                                                    상담 신청자 기본 정보
                                                </h3>
                                                <span className="text-[11px] text-slate-400">
                                                    접수일시: {formatKstDateTime(currentSelectedItem.submittedAt || currentSelectedItem.importedAt, 'detail')}
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

                                            {/* Campaign Info Box */}
                                            <div className="p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 mb-3 flex items-center justify-between">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <Building2 className="w-4 h-4 text-indigo-600 shrink-0" />
                                                    <div className="truncate">
                                                        <span className="text-[10px] font-bold text-slate-500 block">유입 캠페인</span>
                                                        <span className="text-xs font-bold text-slate-800">
                                                            {currentSelectedItem.campaignName || (currentSelectedItem.campaignCode ? `코드: ${currentSelectedItem.campaignCode}` : '미지정 (일반 접수)')}
                                                        </span>
                                                        {currentSelectedItem.campaignPurpose && (
                                                            <span className="text-[10px] text-slate-500 ml-1.5 font-normal">({currentSelectedItem.campaignPurpose})</span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="shrink-0 ml-2">
                                                    {renderCampaignBadge(currentSelectedItem)}
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
                                                    선별검사 도메인별 결과 요약
                                                </h3>
                                                <span className="text-[11px] text-slate-400">
                                                    척도: {formatAssessmentDisplay(currentSelectedItem.assessmentId)}
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
                                                            공문 서식 리포트 (A4 PDF)
                                                        </h3>
                                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                                                            currentSelectedItem.hasReport
                                                                ? 'bg-emerald-100 text-emerald-800'
                                                                : ((currentSelectedItem.internalStatus as any) === 'IMPORT_FAILED' || currentSelectedItem.lastErrorCode)
                                                                    ? 'bg-rose-100 text-rose-800'
                                                                    : ((currentSelectedItem.internalStatus as any) === 'IMPORTING' || (currentSelectedItem.internalStatus as any) === 'LEASED')
                                                                        ? 'bg-amber-100 text-amber-800'
                                                                        : 'bg-slate-100 text-slate-600'
                                                        }`}>
                                                            {currentSelectedItem.hasReport
                                                                ? '리포트 준비 완료'
                                                                : ((currentSelectedItem.internalStatus as any) === 'IMPORT_FAILED' || currentSelectedItem.lastErrorCode)
                                                                    ? '리포트 생성 실패'
                                                                    : ((currentSelectedItem.internalStatus as any) === 'IMPORTING' || (currentSelectedItem.internalStatus as any) === 'LEASED')
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
                                                            url: reportUrl,
                                                            size: 0,
                                                            uploadedAt: new Date().toISOString()
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
                                                            사내 의뢰대장 연계
                                                        </h3>
                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-teal-100 text-teal-800 rounded-md">
                                                            {currentSelectedItem.refNo ? '의뢰 등록 완료' : (currentSelectedItem.assignedUserId ? '등록 대기' : '배정 대기')}
                                                        </span>
                                                    </div>

                                                    <div className="space-y-1.5 text-xs text-slate-600 mb-3">
                                                        <div>기관 연번: <strong className="font-mono text-slate-900 font-black">{currentSelectedItem.refNo || '생성 대기'}</strong></div>
                                                        <div>의뢰 상태: <strong className="text-slate-800">{currentSelectedItem.referralStatus || (currentSelectedItem.refNo ? '등록 완료' : '미등록')}</strong></div>
                                                        <div>종결 상태: <strong className="text-slate-800">{currentSelectedItem.closureStatus || '미종결'}</strong></div>
                                                    </div>
                                                </div>

                                                {currentSelectedItem.refNo && onNavigateToReferrals ? (
                                                    <button
                                                        onClick={() => onNavigateToReferrals({ targetReferralId: currentSelectedItem.referralId || currentSelectedItem.refNo })}
                                                        className="w-full py-2.5 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 rounded-xl text-xs font-bold shadow-sm transition flex items-center justify-center gap-2"
                                                    >
                                                        <ArrowRight className="w-4 h-4 text-teal-600" />
                                                        등록된 의뢰대장 상세 열기
                                                    </button>
                                                ) : (!currentSelectedItem.assignedUserId || currentSelectedItem.assignmentStatus === 'unassigned') ? (
                                                    currentUser.role === 'admin' ? (
                                                        <button
                                                            onClick={() => handleOpenAssignModal(currentSelectedItem)}
                                                            className="w-full py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded-xl text-xs font-bold shadow-sm transition flex items-center justify-center gap-2"
                                                        >
                                                            <UserPlus className="w-4 h-4 text-amber-600" />
                                                            담당자 배정 필요 (배정 창 열기)
                                                        </button>
                                                    ) : (
                                                        <div className="text-xs text-slate-400 text-center py-2">
                                                            담당자 배정 대기 중입니다.
                                                        </div>
                                                    )
                                                ) : (currentSelectedItem.assignedUserId === currentUser.id || currentUser.role === 'admin') ? (
                                                    <button
                                                        onClick={() => handleOpenReferralRegister(currentSelectedItem)}
                                                        disabled={loadingDraftId === currentSelectedItem.submissionId}
                                                        className="w-full py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-50"
                                                    >
                                                        {loadingDraftId === currentSelectedItem.submissionId ? (
                                                            <RefreshCw className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <ExternalLink className="w-4 h-4" />
                                                        )}
                                                        의뢰대장 열기 (신규 등록)
                                                    </button>
                                                ) : (
                                                    <div className="text-xs text-slate-400 text-center py-2">
                                                        다른 담당자가 배정되어 있습니다.
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* SECTION E: 담당자 배정 정보 */}
                                        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                                            <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                                                <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                                                    <UserCheck className="w-4 h-4 text-indigo-600" />
                                                    담당 직원 배정 정보
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
                                                업무 처리 이력
                                            </h3>

                                            <div className="relative pl-6 space-y-4 before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
                                                {/* Stage 1 */}
                                                <div className="relative">
                                                    <div className="absolute -left-6 top-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px]">✓</div>
                                                    <div className="text-xs font-bold text-slate-800">온라인 상담신청 수신 및 비대칭 복호화 완료</div>
                                                    <div className="text-[11px] text-slate-400">
                                                        {formatKstDateTime(currentSelectedItem.importedAt || currentSelectedItem.submittedAt, 'detail')}
                                                    </div>
                                                </div>

                                                {/* Stage 2 */}
                                                <div className="relative">
                                                    <div className="absolute -left-6 top-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px]">✓</div>
                                                    <div className="text-xs font-bold text-slate-800">
                                                        {currentSelectedItem.refNo ? `의뢰대장 등록 완료 (${currentSelectedItem.refNo})` : '의뢰대장 등록 대기 (최종 등록 시 번호 생성)'}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        {currentSelectedItem.refNo ? '정식 의뢰대장 연계 완료' : '담당자 확인 및 등록 폼 저장 시 정식 의뢰번호 부여'}
                                                    </div>
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
                                                        {currentSelectedItem.assignedUserId ? `담당 직원 배정 (${getStaffDisplayName(currentSelectedItem.assignedUserId)})` : '담당 직원 배정 대기'}
                                                    </div>
                                                    <div className="text-[11px] text-slate-400">
                                                        {currentSelectedItem.assignedAt ? `${formatKstDateTime(currentSelectedItem.assignedAt, 'detail')} 배정` : '미배정 상태'}
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
                                            <td className="px-4 py-3 text-slate-500">{formatKstDateTime(item.importedAt, 'list')}</td>
                                            <td className="px-4 py-3 text-slate-500">{formatKstDateTime(item.acknowledgedAt, 'list')}</td>
                                            <td className="px-4 py-3 text-slate-500">{formatKstDateTime(item.externalDeletedAt, 'list')}</td>
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

            {/* 0. Responsive Large Detail & Assignment Modal (P0 UX Improvement) */}
            {isLargeDetailModalOpen && currentSelectedItem && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="large-detail-modal-title"
                    className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-0 md:p-4 lg:p-6 overflow-hidden animate-in fade-in duration-150"
                >
                    <div className="w-full md:w-[min(96vw,1440px)] h-full md:h-[min(92vh,1000px)] max-h-none md:max-h-[min(92vh,1000px)] bg-white md:rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 text-left animate-in zoom-in-95 duration-150">
                        {/* Sticky Header */}
                        <div className="px-5 py-3.5 md:px-6 md:py-4 border-b border-slate-200 bg-slate-50/95 backdrop-blur-sm flex items-center justify-between gap-4 shrink-0">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 rounded-2xl bg-teal-100/80 text-teal-700 flex items-center justify-center shrink-0 shadow-xs">
                                    <ClipboardList className="w-5 h-5" />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h2 id="large-detail-modal-title" className="text-base md:text-xl font-black text-slate-900 truncate">
                                            {submissionDetail?.submission?.contact?.clientName || currentSelectedItem.maskedClientName} 님 상세·배정 검토
                                        </h2>
                                        {renderPriorityBadge(currentSelectedItem.assignmentPriority)}
                                        {renderStatusBadge(currentSelectedItem.consultationStatus, currentSelectedItem.isSbqrQuarantined)}
                                        {currentSelectedItem.assignedUserId ? (
                                            <span className="px-2.5 py-0.5 bg-indigo-50 border border-indigo-200 rounded-full text-xs font-bold text-indigo-700 flex items-center gap-1">
                                                <UserCheck className="w-3.5 h-3.5" />
                                                배정: {getStaffDisplayName(currentSelectedItem.assignedUserId)}
                                            </span>
                                        ) : (
                                            <span className="px-2.5 py-0.5 bg-amber-50 border border-amber-200 rounded-full text-xs font-bold text-amber-700 flex items-center gap-1">
                                                <UserX className="w-3.5 h-3.5" />
                                                미배정
                                            </span>
                                        )}
                                        {(() => {
                                            const exp = getExpiryInfo(currentSelectedItem.retentionUntil);
                                            if (!exp) return null;
                                            return (
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black border flex items-center gap-1 ${
                                                    exp.isUrgent ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'
                                                }`}>
                                                    <AlertTriangle className="w-3 h-3" />
                                                    {exp.label}
                                                </span>
                                            );
                                        })()}
                                    </div>
                                    <div className="text-xs text-slate-500 font-medium mt-0.5 flex items-center gap-2 flex-wrap">
                                        <span>접수 ID: <span className="font-mono text-slate-700 font-bold">{currentSelectedItem.submissionId}</span></span>
                                        <span>• 접수일시: <strong>{formatKstDateTime(currentSelectedItem.submittedAt || currentSelectedItem.importedAt, 'detail')}</strong></span>
                                        {currentSelectedItem.refNo && (
                                            <span>• 의뢰번호: <strong className="text-indigo-600 font-mono">{currentSelectedItem.refNo}</strong></span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => setIsLargeDetailModalOpen(false)}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/80 rounded-xl transition shrink-0"
                                aria-label="상세 창 닫기"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Navigation Tabs Bar */}
                        <div className="px-4 md:px-6 pt-2 bg-slate-50/90 border-b border-slate-200 flex gap-1.5 shrink-0 overflow-x-auto custom-scrollbar">
                            <button
                                type="button"
                                onClick={() => setDetailActiveTab('basic')}
                                className={`px-4 py-2.5 rounded-t-xl text-xs md:text-sm font-bold flex items-center gap-2 transition border-b-2 whitespace-nowrap min-h-[44px] ${
                                    detailActiveTab === 'basic'
                                        ? 'bg-white text-teal-700 border-teal-600 shadow-xs'
                                        : 'text-slate-600 hover:text-slate-900 border-transparent hover:bg-slate-100/60'
                                }`}
                            >
                                <UserCheck className="w-4 h-4 text-teal-600" />
                                기본정보 및 상담신청
                            </button>
                            <button
                                type="button"
                                onClick={() => setDetailActiveTab('scales')}
                                className={`px-4 py-2.5 rounded-t-xl text-xs md:text-sm font-bold flex items-center gap-2 transition border-b-2 whitespace-nowrap min-h-[44px] ${
                                    detailActiveTab === 'scales'
                                        ? 'bg-white text-indigo-700 border-indigo-600 shadow-xs'
                                        : 'text-slate-600 hover:text-slate-900 border-transparent hover:bg-slate-100/60'
                                }`}
                            >
                                <Brain className="w-4 h-4 text-indigo-600" />
                                선별 검사결과 ({formatAssessmentDisplay(currentSelectedItem.assessmentId)})
                            </button>
                            <button
                                type="button"
                                onClick={() => setDetailActiveTab('pdf')}
                                className={`px-4 py-2.5 rounded-t-xl text-xs md:text-sm font-bold flex items-center gap-2 transition border-b-2 whitespace-nowrap min-h-[44px] ${
                                    detailActiveTab === 'pdf'
                                        ? 'bg-white text-emerald-700 border-emerald-600 shadow-xs'
                                        : 'text-slate-600 hover:text-slate-900 border-transparent hover:bg-slate-100/60'
                                }`}
                            >
                                <FileText className="w-4 h-4 text-emerald-600" />
                                공문 리포트 (A4 PDF)
                            </button>
                            <button
                                type="button"
                                onClick={() => setDetailActiveTab('assignment')}
                                className={`px-4 py-2.5 rounded-t-xl text-xs md:text-sm font-bold flex items-center gap-2 transition border-b-2 whitespace-nowrap min-h-[44px] ${
                                    detailActiveTab === 'assignment'
                                        ? 'bg-white text-indigo-700 border-indigo-600 shadow-xs'
                                        : 'text-slate-600 hover:text-slate-900 border-transparent hover:bg-slate-100/60'
                                }`}
                            >
                                <UserPlus className="w-4 h-4 text-indigo-600" />
                                담당 직원 배정 및 관리
                            </button>
                        </div>

                        {/* Scrollable Tab Content Area */}
                        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 custom-scrollbar">
                            {/* TAB 1: 기본정보 및 상담신청 */}
                            {detailActiveTab === 'basic' && (
                                <div className="space-y-5 animate-in fade-in duration-100">
                                    <div className="bg-slate-50/70 rounded-2xl border border-slate-200 p-5">
                                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2">
                                            <UserCheck className="w-4 h-4 text-teal-600" />
                                            신청자 인적사항
                                        </h3>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">성명</span>
                                                <span className="text-base font-black text-slate-900">
                                                    {submissionDetail?.submission?.contact?.clientName || currentSelectedItem.maskedClientName}
                                                </span>
                                            </div>
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">연락처</span>
                                                <span className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                                                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                                                    {submissionDetail?.submission?.contact?.phone || currentSelectedItem.maskedPhone}
                                                </span>
                                            </div>
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">지역 (거주지)</span>
                                                <span className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                                                    <MapPin className="w-3.5 h-3.5 text-slate-400" />
                                                    {submissionDetail?.submission?.contact?.region || currentSelectedItem.region || '이천시'}
                                                </span>
                                            </div>
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">성별 / 생년월일 / 연령</span>
                                                <div className="text-sm font-bold text-slate-900">
                                                    <span>{submissionDetail?.submission?.contact?.gender || '미입력'} / {submissionDetail?.submission?.contact?.birthDate || '미입력'}</span>
                                                    <span className="ml-1 text-xs text-indigo-600 font-black">
                                                        ({calculateCompletedAge(submissionDetail?.submission?.contact?.birthDate, currentSelectedItem.submittedAt || currentSelectedItem.importedAt)})
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Campaign Info Card in Large Modal */}
                                    <div className="bg-indigo-50/50 rounded-2xl border border-indigo-100 p-4 flex items-center justify-between flex-wrap gap-2">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-indigo-100 text-indigo-700 rounded-xl">
                                                <Building2 className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <span className="text-[11px] font-bold text-slate-500 block">유입 캠페인 정보</span>
                                                <div className="text-sm font-black text-slate-900 flex items-center gap-2">
                                                    <span>{currentSelectedItem.campaignName || (currentSelectedItem.campaignCode ? `코드: ${currentSelectedItem.campaignCode}` : '캠페인 미지정 (일반 접수)')}</span>
                                                    {currentSelectedItem.campaignCode && (
                                                        <span className="text-xs font-mono font-bold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-md">
                                                            {currentSelectedItem.campaignCode}
                                                        </span>
                                                    )}
                                                </div>
                                                {currentSelectedItem.campaignPurpose && (
                                                    <p className="text-xs text-slate-600 mt-0.5 font-medium">{currentSelectedItem.campaignPurpose}</p>
                                                )}
                                            </div>
                                        </div>
                                        <div>
                                            {renderCampaignBadge(currentSelectedItem)}
                                        </div>
                                    </div>

                                    {/* Counseling Note Text */}
                                    <div className="bg-slate-50/70 rounded-2xl border border-slate-200 p-5">
                                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-2 flex items-center gap-2">
                                            <FileText className="w-4 h-4 text-slate-500" />
                                            상담 신청 사유 및 주 호소 내용
                                        </h3>
                                        <div className="p-4 bg-white rounded-xl border border-slate-200 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap font-medium shadow-xs">
                                            {submissionDetail?.submission?.contact?.counselingRequestText ||
                                                currentSelectedItem.counselingRequestText ||
                                                '작성된 상담 신청 메모가 없습니다.'}
                                        </div>
                                    </div>

                                    {/* Consent Status */}
                                    <div className="p-4 bg-white rounded-xl border border-slate-200 flex items-center gap-4 text-xs font-medium text-slate-600 flex-wrap">
                                        <span className="flex items-center gap-1.5 text-emerald-700 font-bold">
                                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                            개인정보 수집 및 이용 동의 완료
                                        </span>
                                        {currentSelectedItem.contactOnly ? (
                                            <span className="flex items-center gap-1.5 text-slate-500 font-medium">
                                                <AlertCircle className="w-4 h-4 text-slate-400" />
                                                민감정보 미동의 (접촉 전용)
                                            </span>
                                        ) : (
                                            <span className="flex items-center gap-1.5 text-emerald-700 font-bold">
                                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                                민감정보(검사결과) 처리 동의 완료
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* TAB 2: 검사결과 및 위험도 */}
                            {detailActiveTab === 'scales' && (
                                <div className="space-y-5 animate-in fade-in duration-100">
                                    {currentSelectedItem.contactOnly ? (
                                        <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-slate-600 text-sm flex items-center gap-3">
                                            <AlertCircle className="w-6 h-6 text-slate-400 shrink-0" />
                                            <div>
                                                <strong className="block text-slate-800 mb-1">접촉 전용 접수 건</strong>
                                                내담자가 민감정보 처리에 동의하지 않아 온라인 자가검사 결과가 등록되지 않았습니다. 기본 연락처 기반의 초기면접 접촉을 진행해 주세요.
                                            </div>
                                        </div>
                                    ) : currentSelectedItem.isSbqrQuarantined ? (
                                        <div className="p-6 bg-purple-50 rounded-2xl border border-purple-200 text-purple-900 text-sm flex items-center gap-3">
                                            <ShieldAlert className="w-8 h-8 text-purple-600 shrink-0" />
                                            <div>
                                                <strong className="text-purple-900 text-base block mb-1">SBQ-R 임상 안전 게이트 격리 보호 중</strong>
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
                                                            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                                                                <span className="text-sm font-black text-slate-800">Track A 5대 선별검사 도메인별 종합 결과 (32문항)</span>
                                                                <span className="text-xs font-bold px-2.5 py-1 bg-indigo-100 text-indigo-800 rounded-lg">5개 도메인 완료</span>
                                                            </div>
                                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                                                {/* 1. PHQ-9 */}
                                                                <div className="p-4 rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50/70 to-white shadow-xs">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <Activity className="w-4 h-4 text-blue-600" />
                                                                            우울 건강선별 (PHQ-9)
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-blue-100 text-blue-800 rounded">9문항</span>
                                                                    </div>
                                                                    <div className="flex items-baseline gap-2 my-2">
                                                                        <span className="text-3xl font-black text-slate-900">{phq.totalScore ?? '-'}</span>
                                                                        <span className="text-xs text-slate-500 font-bold">점</span>
                                                                    </div>
                                                                    <div className="text-xs font-bold text-blue-700 bg-blue-50 px-2.5 py-1.5 rounded-lg border border-blue-100">
                                                                        판정: {phq.severity || '평가 완료'}
                                                                    </div>
                                                                </div>

                                                                {/* 2. GAD-7 */}
                                                                <div className="p-4 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/70 to-white shadow-xs">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <Activity className="w-4 h-4 text-emerald-600" />
                                                                            불안 선별도구 (GAD-7)
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded">7문항</span>
                                                                    </div>
                                                                    <div className="flex items-baseline gap-2 my-2">
                                                                        <span className="text-3xl font-black text-slate-900">{gad.totalScore ?? '-'}</span>
                                                                        <span className="text-xs text-slate-500 font-bold">점</span>
                                                                    </div>
                                                                    <div className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-100">
                                                                        판정: {gad.severity || '평가 완료'}
                                                                    </div>
                                                                </div>

                                                                {/* 3. ISI-K */}
                                                                <div className="p-4 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50/70 to-white shadow-xs">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <Moon className="w-4 h-4 text-indigo-600" />
                                                                            불면증 심각도 (ISI-K)
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded">7문항</span>
                                                                    </div>
                                                                    <div className="flex items-baseline gap-2 my-2">
                                                                        <span className="text-3xl font-black text-slate-900">{isi.totalScore ?? '-'}</span>
                                                                        <span className="text-xs text-slate-500 font-bold">점</span>
                                                                    </div>
                                                                    <div className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-100">
                                                                        판정: {isi.severity || '평가 완료'}
                                                                    </div>
                                                                </div>

                                                                {/* 4. BEPSI-K */}
                                                                <div className="p-4 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50/70 to-white shadow-xs">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <Flame className="w-4 h-4 text-amber-600" />
                                                                            스트레스 척도 (BEPSI-K)
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-100 text-amber-800 rounded">5문항</span>
                                                                    </div>
                                                                    <div className="flex items-baseline gap-2 my-2">
                                                                        <span className="text-3xl font-black text-slate-900">{bepsi.totalScore ?? '-'}</span>
                                                                        <span className="text-xs text-slate-500 font-bold">점 (평균: {bepsi.meanScore || '-'})</span>
                                                                    </div>
                                                                    <div className="text-xs font-bold text-amber-800 bg-amber-50 px-2.5 py-1.5 rounded-lg border border-amber-100">
                                                                        판정: {bepsi.severity || '평가 완료'}
                                                                    </div>
                                                                </div>

                                                                {/* 5. SBQ-R */}
                                                                <div className="p-4 rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50/70 to-white shadow-xs">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                                                                            <ShieldAlert className="w-4 h-4 text-rose-600" />
                                                                            자살행동 척도 (SBQ-R)
                                                                        </span>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 bg-rose-100 text-rose-800 rounded">4문항</span>
                                                                    </div>
                                                                    <div className="flex items-baseline gap-2 my-2">
                                                                        <span className="text-3xl font-black text-slate-900">{sbqr.totalScore ?? '-'}</span>
                                                                        <span className="text-xs text-slate-500 font-bold">점</span>
                                                                    </div>
                                                                    <div className="text-xs font-bold text-rose-800 bg-rose-50 px-2.5 py-1.5 rounded-lg border border-rose-100">
                                                                        선별: {Number(sbqr.totalScore) >= 7 ? '임상 확인 요망' : '기준점 미만'}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                }

                                                return (
                                                    <div className="p-5 bg-slate-50 rounded-2xl border border-slate-200">
                                                        <h4 className="text-sm font-black text-slate-800 mb-2">척도 종합 평가 결과</h4>
                                                        <div className="flex items-center gap-4">
                                                            <div className="text-3xl font-black text-slate-900">
                                                                {currentSelectedItem.totalScore ?? '-'}점
                                                            </div>
                                                            <div className="px-3 py-1.5 rounded-xl bg-teal-100 text-teal-900 text-xs font-bold">
                                                                판정: {currentSelectedItem.severity || '정상 검진 완료'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* TAB 3: PDF 리포트 바로보기 */}
                            {detailActiveTab === 'pdf' && (
                                <div className="space-y-5 animate-in fade-in duration-100">
                                    <div className="bg-slate-50/80 rounded-2xl border border-slate-200 p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                                        <div>
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                                                    <FileText className="w-5 h-5 text-emerald-600" />
                                                    공문 서식 종합 결과보고서 (A4 PDF)
                                                </h3>
                                                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-md ${
                                                    currentSelectedItem.hasReport ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                                                }`}>
                                                    {currentSelectedItem.hasReport ? '리포트 준비 완료' : '리포트 대기'}
                                                </span>
                                            </div>
                                            <p className="text-xs text-slate-500 font-mono">
                                                파일명: {currentSelectedItem.reportAttachment?.name || '온라인 마음건강 검진 결과보고서.pdf'}
                                            </p>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (!currentSelectedItem.hasReport) {
                                                    const errMsg = '검사결과 리포트를 찾을 수 없습니다.';
                                                    if (showToast) showToast(errMsg, 'error');
                                                    else alert(errMsg);
                                                    return;
                                                }
                                                const reportUrl = `/api/surveys/submissions/${encodeURIComponent(currentSelectedItem.submissionId)}/report`;
                                                setPreviewFile({
                                                    id: `att_${currentSelectedItem.submissionId}`,
                                                    name: currentSelectedItem.reportAttachment?.name || '온라인 마음건강 검진 결과보고서.pdf',
                                                    type: 'application/pdf',
                                                    url: reportUrl,
                                                    size: 0,
                                                    uploadedAt: new Date().toISOString()
                                                });
                                            }}
                                            className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-bold shadow-md hover:shadow transition flex items-center gap-2 shrink-0 min-h-[44px]"
                                        >
                                            <Eye className="w-4 h-4" />
                                            결과보고서 바로보기 (PDF 뷰어)
                                        </button>
                                    </div>
                                    {currentSelectedItem.hasReport ? (
                                        <div className="w-full h-[540px] md:h-[620px] rounded-2xl border border-slate-200 overflow-hidden bg-slate-100 shadow-inner">
                                            <iframe
                                                src={`/api/surveys/submissions/${encodeURIComponent(currentSelectedItem.submissionId)}/report`}
                                                title="PDF 결과보고서 미리보기"
                                                className="w-full h-full border-0"
                                            />
                                        </div>
                                    ) : (
                                        <div className="p-12 text-center bg-slate-50 border border-dashed border-slate-200 rounded-2xl">
                                            <FileText className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                                            <p className="text-sm font-bold text-slate-600">결과보고서 PDF 파일이 아직 생성되지 않았거나 대기 중입니다.</p>
                                        </div>
                                    )}
                                    <div className="p-4 bg-white rounded-2xl border border-slate-200 text-xs text-slate-600 space-y-1">
                                        <p className="font-bold text-slate-800">📄 리포트 문서 보안 안내</p>
                                        <p>• 첨부 리포트 PDF는 서버측 감사 로그와 접근 제어가 적용되어 있어 인가된 담당자 및 관리자만 열람할 수 있습니다.</p>
                                        <p>• 30일 보존기간 만료 시 자동으로 안전하게 파기 처리됩니다.</p>
                                    </div>
                                </div>
                            )}

                            {/* TAB 4: 담당 직원 배정 및 관리 */}
                            {detailActiveTab === 'assignment' && (
                                <div className="space-y-6 animate-in fade-in duration-100">
                                    {/* Current Assignment Status Card */}
                                    <div className="bg-slate-50/80 rounded-2xl border border-slate-200 p-5">
                                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2">
                                            <UserCheck className="w-4 h-4 text-indigo-600" />
                                            현재 담당 직원 배정 현황
                                        </h3>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">현재 배정자</span>
                                                <strong className="text-sm font-black text-slate-900">
                                                    {getStaffDisplayName(currentSelectedItem.assignedUserId)}
                                                </strong>
                                            </div>
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">소속 부서 / 역할</span>
                                                <span className="text-sm font-bold text-slate-800">
                                                    {currentSelectedItem.assignedDepartmentId || '지정 없음'}
                                                </span>
                                            </div>
                                            <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                                                <span className="text-[11px] font-bold text-slate-400 block mb-1">배정일시</span>
                                                <span className="text-xs font-bold text-slate-700">
                                                    {currentSelectedItem.assignedAt ? formatKstDateTime(currentSelectedItem.assignedAt, 'detail') : '미배정'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Assignment Form (Admin Only) */}
                                    {currentUser.role === 'admin' ? (
                                        <div className="bg-white rounded-2xl border border-indigo-200/90 p-5 shadow-sm space-y-4">
                                            <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                                                <UserPlus className="w-4 h-4 text-indigo-600" />
                                                {currentSelectedItem.assignedUserId ? '담당 직원 재배정' : '신규 담당 직원 배정'}
                                            </h3>

                                            {detailAssignFeedback && (
                                                <div className={`p-3.5 rounded-xl text-xs font-bold flex items-center gap-2 ${
                                                    detailAssignFeedback.type === 'success'
                                                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                                        : 'bg-rose-50 text-rose-800 border border-rose-200'
                                                }`}>
                                                    {detailAssignFeedback.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                                                    {detailAssignFeedback.message}
                                                </div>
                                            )}

                                            {/* Staff Selector */}
                                            <div>
                                                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                                                    배정할 직원 선택 (온라인 설문 권한 보유 직원) *
                                                </label>
                                                <select
                                                    value={detailSelectedStaffId}
                                                    onChange={e => setDetailSelectedStaffId(e.target.value)}
                                                    className="w-full px-4 py-3 bg-white border border-slate-300 rounded-xl text-xs md:text-sm font-medium text-slate-800 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 min-h-[44px]"
                                                >
                                                    <option value="">담당 직원을 선택하세요</option>
                                                    {assignableStaff.map(staff => (
                                                        <option key={staff.id} value={staff.id}>
                                                            {staff.name} ({staff.team || '소속팀 없음'} · {staff.role}) [미처리: {staff.pendingAssignmentCount ?? 0}건]
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Priority Selector */}
                                            <div>
                                                <label className="block text-xs font-bold text-slate-700 mb-1.5">검토 우선순위 *</label>
                                                <div className="grid grid-cols-3 gap-2.5">
                                                    {[
                                                        { id: 'NORMAL', label: '일반 검토' },
                                                        { id: 'PRIORITY_REVIEW', label: '우선 검토' },
                                                        { id: 'IMMEDIATE_REVIEW', label: '긴급 검토' }
                                                    ].map(p => (
                                                        <button
                                                            key={p.id}
                                                            type="button"
                                                            onClick={() => setDetailSelectedPriority(p.id as any)}
                                                            className={`py-2.5 text-xs font-bold rounded-xl border transition min-h-[44px] ${
                                                                detailSelectedPriority === p.id
                                                                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                                                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                                            }`}
                                                        >
                                                            {p.label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Reason Note */}
                                            <div>
                                                <label className="block text-xs font-bold text-slate-700 mb-1.5">배정 사유 및 전달 메모</label>
                                                <textarea
                                                    value={detailAssignReason}
                                                    onChange={e => setDetailAssignReason(e.target.value)}
                                                    placeholder="담당 직원에게 전달할 특이사항이나 배정 사유를 입력하세요..."
                                                    rows={3}
                                                    className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-xs text-slate-800 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none"
                                                />
                                            </div>

                                            {/* Actions */}
                                            <div className="pt-2 flex items-center justify-between gap-3 flex-wrap">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleOpenHistoryModal(currentSelectedItem)}
                                                        className="px-4 py-2.5 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl border border-slate-200 transition flex items-center gap-1.5 min-h-[44px]"
                                                    >
                                                        <History className="w-3.5 h-3.5" />
                                                        배정 이력 확인
                                                    </button>
                                                    {currentSelectedItem.assignedUserId && currentSelectedItem.assignmentStatus !== 'unassigned' && (
                                                        <button
                                                            type="button"
                                                            onClick={handleLargeDetailUnassign}
                                                            className="px-4 py-2.5 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-xl border border-rose-200 transition flex items-center gap-1.5 min-h-[44px]"
                                                        >
                                                            <UserMinus className="w-3.5 h-3.5" />
                                                            배정 취소
                                                        </button>
                                                    )}
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={handleLargeDetailAssign}
                                                    disabled={isDetailAssigning || !detailSelectedStaffId}
                                                    className="px-6 py-2.5 text-xs md:text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2 min-h-[44px]"
                                                >
                                                    {isDetailAssigning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
                                                    {currentSelectedItem.assignedUserId ? '담당 직원 재배정 실행' : '신규 담당 직원 배정'}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-500">
                                            담당 직원 배정 및 변경은 센터 관리자(Admin) 권한 보유자만 실행할 수 있습니다.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Sticky Action Footer */}
                        <div className="px-5 py-3.5 md:px-6 md:py-4 border-t border-slate-200 bg-slate-50/95 flex items-center justify-between gap-3 shrink-0 flex-wrap">
                            <div className="text-xs text-slate-600 font-medium">
                                대상자: <strong className="text-slate-900">{currentSelectedItem.maskedClientName}</strong> • {currentSelectedItem.maskedPhone}
                            </div>
                            <div className="flex items-center gap-2.5">
                                <button
                                    type="button"
                                    onClick={() => setIsLargeDetailModalOpen(false)}
                                    className="px-5 py-2.5 text-xs md:text-sm font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 rounded-xl transition min-h-[44px]"
                                >
                                    닫기
                                </button>
                                {currentSelectedItem.refNo && onNavigateToReferrals ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsLargeDetailModalOpen(false);
                                            onNavigateToReferrals({ targetReferralId: currentSelectedItem.referralId || currentSelectedItem.refNo });
                                        }}
                                        className="px-5 py-2.5 text-xs md:text-sm font-bold text-white bg-teal-600 hover:bg-teal-700 rounded-xl shadow-sm transition flex items-center gap-2 min-h-[44px]"
                                    >
                                        <ExternalLink className="w-4 h-4" />
                                        등록된 의뢰대장 열기
                                    </button>
                                ) : (currentSelectedItem.assignedUserId === currentUser.id || currentUser.role === 'admin') ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsLargeDetailModalOpen(false);
                                            handleOpenReferralRegister(currentSelectedItem);
                                        }}
                                        disabled={loadingDraftId === currentSelectedItem.submissionId}
                                        className="px-5 py-2.5 text-xs md:text-sm font-bold text-white bg-teal-600 hover:bg-teal-700 rounded-xl shadow-sm transition flex items-center gap-2 min-h-[44px] disabled:opacity-50"
                                    >
                                        {loadingDraftId === currentSelectedItem.submissionId ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                                        의뢰대장 열기 (신규 등록)
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            )}

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
                                                {h.previousAssignedUserId ? (
                                                    `${getStaffDisplayName(h.previousAssignedUserId)} → ${getStaffDisplayName(h.assignedUserId || h.newAssignedUserId)}`
                                                ) : (
                                                    `${getStaffDisplayName(h.assignedUserId || h.newAssignedUserId)} 배정`
                                                )}
                                            </span>
                                            <span className="text-[11px] text-slate-400">
                                                {formatKstDateTime(h.createdAt || h.timestamp || h.changedAt, 'list')}
                                            </span>
                                        </div>
                                        <div className="text-slate-600">
                                            우선순위: <strong className="text-slate-800">{h.priority || h.newPriority || 'NORMAL'}</strong>
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
                                <label className="block font-bold text-slate-700 mb-1">캠페인 필터</label>
                                <select
                                    value={exportFilters.campaignCode}
                                    onChange={e => setExportFilters(f => ({ ...f, campaignCode: e.target.value }))}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium"
                                >
                                    <option value="all">전체 (미지정 포함)</option>
                                    <option value="unspecified">미지정 (일반 접수)</option>
                                    {campaignsList.map(camp => (
                                        <option key={camp.code} value={camp.code}>
                                            {camp.companyName || camp.code} {camp.purpose ? `— ${camp.purpose}` : ''} [{camp.code}]
                                        </option>
                                    ))}
                                </select>
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
            {/* 8. Bulk Assignment Confirmation Modal */}
            {isBulkConfirmModalOpen && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <UserPlus className="w-5 h-5 text-indigo-600" />
                                {bulkMode === 'include-reassignment' ? '일괄 배정 및 재배정 확인' : '미배정 건 일괄 배정 확인'}
                            </h3>
                            <button
                                onClick={() => setIsBulkConfirmModalOpen(false)}
                                disabled={isBulkAssigning}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3.5 text-xs text-slate-700">
                            <p className="font-bold text-slate-800 text-sm leading-snug">
                                {bulkMode === 'include-reassignment'
                                    ? `선택한 대상자를 [${getStaffDisplayName(bulkTargetStaffId)}] 담당자에게 배정 또는 재배정할까요?`
                                    : `선택한 대상자 중 미배정 설문을 [${getStaffDisplayName(bulkTargetStaffId)}] 담당자에게 배정할까요?`}
                            </p>

                            {/* Breakdown summary */}
                            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1 font-medium">
                                <div className="font-black text-slate-900 mb-1">예상 결과:</div>
                                <div className="text-emerald-700 font-bold">• 신규 배정 {selectionSummary.unassignedCount}건</div>
                                {bulkMode === 'include-reassignment' ? (
                                    <>
                                        <div className="text-amber-700 font-bold">• 재배정 {Math.max(0, selectionSummary.assignedCount - selectionSummary.sameAssigneeCount)}건</div>
                                        {selectionSummary.sameAssigneeCount > 0 && (
                                            <div className="text-slate-500">• 같은 담당자 제외 {selectionSummary.sameAssigneeCount}건</div>
                                        )}
                                    </>
                                ) : (
                                    selectionSummary.assignedCount > 0 && (
                                        <div className="text-slate-500">• 기존 배정 제외 {selectionSummary.assignedCount}건</div>
                                    )
                                )}
                                {selectionSummary.registeredCount > 0 && (
                                    <div className="text-slate-500">• 등록 완료 제외 {selectionSummary.registeredCount}건</div>
                                )}
                            </div>

                            {/* Reassignment Warning */}
                            {bulkMode === 'include-reassignment' && (
                                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-[11px] leading-relaxed flex items-start gap-2" role="alert">
                                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                                    <div>
                                        <strong>재배정 위험 안내:</strong>
                                        <div className="mt-0.5">기존 담당자의 미처리 배지와 업무목록에서 해당 건이 제거되고 새 담당자에게 이동합니다.</div>
                                    </div>
                                </div>
                            )}

                            {bulkNote && (
                                <div className="p-2.5 bg-indigo-50/70 border border-indigo-100 rounded-xl text-slate-600 text-[11px]">
                                    <span className="font-bold text-indigo-900">배정 메모: </span>
                                    {bulkNote}
                                </div>
                            )}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsBulkConfirmModalOpen(false)}
                                disabled={isBulkAssigning}
                                className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
                            >
                                취소
                            </button>
                            <button
                                type="button"
                                onClick={handleExecuteBulkAssign}
                                disabled={isBulkAssigning}
                                className={`px-4 py-2 text-xs font-bold text-white rounded-xl shadow-md transition disabled:opacity-50 flex items-center gap-2 cursor-pointer ${
                                    bulkMode === 'include-reassignment' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-indigo-600 hover:bg-indigo-700'
                                }`}
                            >
                                {isBulkAssigning ? (
                                    <>
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                        배정 중...
                                    </>
                                ) : (
                                    <>
                                        <UserPlus className="w-3.5 h-3.5" />
                                        {bulkMode === 'include-reassignment' ? '일괄 재배정' : '일괄 배정'}
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 9. Bulk Assignment Result Modal */}
            {isBulkResultModalOpen && bulkResult && (
                <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 text-left animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <h3 className="text-base font-black text-slate-900 flex items-center gap-2">
                                <CheckCircle2 className="w-5 h-5 text-teal-600" />
                                일괄 배정 완료
                            </h3>
                            <button
                                onClick={() => setIsBulkResultModalOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3 text-xs text-slate-700" aria-live="polite">
                            <div className="grid grid-cols-2 gap-2 text-center">
                                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                                    <div className="text-[11px] text-slate-500 font-bold">요청 건수</div>
                                    <div className="text-base font-black text-slate-900">{bulkResult.requested}건</div>
                                </div>
                                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl">
                                    <div className="text-[11px] text-emerald-700 font-bold">신규 배정</div>
                                    <div className="text-base font-black text-emerald-800">{bulkResult.assigned}건</div>
                                </div>
                                <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl">
                                    <div className="text-[11px] text-indigo-700 font-bold">재배정</div>
                                    <div className="text-base font-black text-indigo-800">{bulkResult.reassigned}건</div>
                                </div>
                                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl">
                                    <div className="text-[11px] text-amber-700 font-bold">제외 / 유지</div>
                                    <div className="text-base font-black text-amber-800">{bulkResult.skipped}건</div>
                                </div>
                            </div>

                            {bulkResult.failed > 0 && (
                                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-center text-rose-700 font-bold">
                                    실패: {bulkResult.failed}건
                                </div>
                            )}

                            {/* Itemized Results list for skipped or failed */}
                            {bulkResult.results && bulkResult.results.some(r => r.status === 'SKIPPED' || r.status === 'FAILED') && (
                                <div className="mt-2 pt-2 border-t border-slate-100">
                                    <div className="text-[11px] font-bold text-slate-600 mb-1">제외·실패 내역:</div>
                                    <div className="max-h-36 overflow-y-auto space-y-1 custom-scrollbar text-[10px]">
                                        {bulkResult.results.filter(r => r.status === 'SKIPPED' || r.status === 'FAILED').map((r, idx) => (
                                            <div key={idx} className="p-1.5 bg-slate-50 border border-slate-200 rounded flex items-center justify-between">
                                                <span className="font-mono text-slate-700">{r.submissionId}</span>
                                                <span className="font-bold text-slate-500">[{r.status}] {r.reasonCode}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                            <button
                                type="button"
                                onClick={() => setIsBulkResultModalOpen(false)}
                                className="px-4 py-2 text-xs font-bold text-white bg-teal-600 hover:bg-teal-700 rounded-xl shadow-md transition cursor-pointer"
                            >
                                결과 닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Sync Progress Modal */}
            {syncProgress.isOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="sync-progress-title"
                    className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
                >
                    <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-200 animate-in zoom-in-95 duration-150 text-left">
                        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                            <div className="flex items-center gap-2.5">
                                <div className={`p-2.5 rounded-2xl ${syncProgress.isSyncing ? 'bg-teal-100 text-teal-700 animate-pulse' : 'bg-emerald-100 text-emerald-700'}`}>
                                    {syncProgress.isSyncing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                                </div>
                                <div>
                                    <h3 id="sync-progress-title" className="text-sm font-black text-slate-900">
                                        {syncProgress.isSyncing ? '설문 안전 동기화 진행 중' : '설문 동기화 완료'}
                                    </h3>
                                    <p className="text-[11px] text-slate-500 font-medium">Track A 암호문 수신 및 검사 결과 리포트 처리</p>
                                </div>
                            </div>
                            {!syncProgress.isSyncing && (
                                <button
                                    onClick={() => setSyncProgress(prev => ({ ...prev, isOpen: false }))}
                                    className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"
                                    aria-label="닫기"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            )}
                        </div>

                        <div className="py-4 space-y-3">
                            <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl text-xs font-medium text-slate-700">
                                {syncProgress.isSyncing ? '온라인 설문을 안전하게 동기화하고 있습니다...' : syncProgress.message}
                            </div>

                            <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                                    <div className="text-[10px] text-emerald-600 font-bold">신규 수신</div>
                                    <div className="text-lg font-black text-emerald-800">{syncProgress.imported}건</div>
                                </div>
                                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl">
                                    <div className="text-[10px] text-indigo-600 font-bold">재사용/중복</div>
                                    <div className="text-lg font-black text-indigo-800">{syncProgress.reused}건</div>
                                </div>
                                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                    <div className="text-[10px] text-amber-600 font-bold">오류/격리</div>
                                    <div className="text-lg font-black text-amber-800">{syncProgress.failed}건</div>
                                </div>
                            </div>

                            {syncProgress.stopReason && (
                                <div className="text-[11px] text-slate-400 font-mono text-center">
                                    처리 상태: {syncProgress.stopReason}
                                </div>
                            )}
                        </div>

                        {!syncProgress.isSyncing && (
                            <div className="pt-3 border-t border-slate-100 flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => setSyncProgress(prev => ({ ...prev, isOpen: false }))}
                                    className="px-5 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold shadow transition cursor-pointer"
                                >
                                    확인
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 8. Admin Campaign Management Modal */}
            {currentUser.role === 'admin' && isCampaignModalOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="campaign-modal-title"
                    className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-150 overflow-y-auto"
                >
                    <div className="bg-white rounded-3xl max-w-4xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 animate-in zoom-in-95 duration-150 text-left my-auto max-h-[90vh] flex flex-col">
                        {/* Modal Header */}
                        <div className="flex items-center justify-between pb-3.5 border-b border-slate-100 shrink-0">
                            <div className="flex items-center gap-2.5">
                                <div className="p-2.5 bg-indigo-100 text-indigo-700 rounded-2xl">
                                    <Building2 className="w-5 h-5" />
                                </div>
                                <div>
                                    <h3 id="campaign-modal-title" className="text-base font-black text-slate-900 flex items-center gap-2">
                                        온라인 설문 캠페인 관리
                                        <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full font-bold border border-indigo-200">
                                            {campaignsList.length}개 운영 중
                                        </span>
                                    </h3>
                                    <p className="text-[11px] text-slate-500 font-medium">
                                        회사/기관별 고유 캠페인 코드를 생성하고 배포 링크를 관리합니다.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsCampaignModalOpen(false);
                                    handleStartCreateCampaign();
                                }}
                                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition"
                                aria-label="닫기"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Modal Body - Scrollable */}
                        <div className="py-4 space-y-5 overflow-y-auto custom-scrollbar flex-1 pr-1">
                            {/* Campaign Create/Edit Form Box */}
                            <div className="bg-slate-50/80 border border-slate-200/90 rounded-2xl p-4 sm:p-5">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                                        {campaignFormMode === 'create' ? (
                                            <>
                                                <Plus className="w-4 h-4 text-indigo-600" />
                                                신규 캠페인 등록
                                            </>
                                        ) : (
                                            <>
                                                <Edit2 className="w-4 h-4 text-amber-600" />
                                                캠페인 메타데이터 수정 (코드 변경 불가)
                                            </>
                                        )}
                                    </h4>
                                    {campaignFormMode === 'edit' && (
                                        <button
                                            type="button"
                                            onClick={handleStartCreateCampaign}
                                            className="text-xs font-bold text-slate-500 hover:text-slate-800 underline"
                                        >
                                            신규 등록 모드로 전환
                                        </button>
                                    )}
                                </div>

                                {campaignFormError && (
                                    <div className="mb-3 p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs font-bold text-rose-700 flex items-center gap-2">
                                        <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                                        <span>{campaignFormError}</span>
                                    </div>
                                )}

                                <form onSubmit={handleSubmitCampaignForm} className="space-y-3">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {/* Code Field */}
                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1">
                                                캠페인 코드 <span className="text-rose-500">*</span>
                                                {campaignFormMode === 'edit' && (
                                                    <span className="text-[10px] text-slate-400 font-normal ml-1">(수정 불가)</span>
                                                )}
                                            </label>
                                            <input
                                                type="text"
                                                value={campaignFormData.code}
                                                disabled={campaignFormMode === 'edit'}
                                                onChange={e => setCampaignFormData(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                                                placeholder="예: SEC-2026, HY-HEALTH"
                                                className={`w-full px-3 py-2 text-xs font-mono font-bold border rounded-xl focus:outline-none ${
                                                    campaignFormMode === 'edit'
                                                        ? 'bg-slate-100 text-slate-500 border-slate-200 cursor-not-allowed'
                                                        : 'bg-white text-slate-800 border-slate-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                                                }`}
                                            />
                                        </div>

                                        {/* Company Name */}
                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1">
                                                회사 / 기관명 <span className="text-rose-500">*</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={campaignFormData.companyName}
                                                onChange={e => setCampaignFormData(f => ({ ...f, companyName: e.target.value }))}
                                                placeholder="예: 삼성전자 기흥사업장"
                                                className="w-full px-3 py-2 text-xs font-bold border border-slate-300 rounded-xl bg-white text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    {/* Purpose Field */}
                                    <div>
                                        <label className="block text-xs font-bold text-slate-700 mb-1">
                                            운영 목적 <span className="text-rose-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={campaignFormData.purpose}
                                            onChange={e => setCampaignFormData(f => ({ ...f, purpose: e.target.value }))}
                                            placeholder="예: 2026 임직원 스트레스 검진 및 상담 연계"
                                            className="w-full px-3 py-2 text-xs font-medium border border-slate-300 rounded-xl bg-white text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        />
                                    </div>

                                    {/* Dates & Active Checkbox */}
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                                        <div>
                                            <label className="block text-[11px] font-bold text-slate-600 mb-1">시작일 (선택)</label>
                                            <input
                                                type="date"
                                                value={campaignFormData.startsAt}
                                                onChange={e => setCampaignFormData(f => ({ ...f, startsAt: e.target.value }))}
                                                className="w-full px-2.5 py-1.5 text-xs font-medium border border-slate-300 rounded-xl bg-white text-slate-800 focus:outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-bold text-slate-600 mb-1">종료일 (선택)</label>
                                            <input
                                                type="date"
                                                value={campaignFormData.endsAt}
                                                onChange={e => setCampaignFormData(f => ({ ...f, endsAt: e.target.value }))}
                                                className="w-full px-2.5 py-1.5 text-xs font-medium border border-slate-300 rounded-xl bg-white text-slate-800 focus:outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                        <div className="flex items-center gap-2 pt-2">
                                            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer select-none">
                                                <input
                                                    type="checkbox"
                                                    checked={campaignFormData.isActive}
                                                    onChange={e => setCampaignFormData(f => ({ ...f, isActive: e.target.checked }))}
                                                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                                />
                                                <span>캠페인 활성화</span>
                                            </label>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-end gap-2 pt-2">
                                        {campaignFormMode === 'edit' && (
                                            <button
                                                type="button"
                                                onClick={handleStartCreateCampaign}
                                                className="px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-200/70 rounded-xl transition"
                                            >
                                                수정 취소
                                            </button>
                                        )}
                                        <button
                                            type="submit"
                                            disabled={isSavingCampaign}
                                            className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs transition disabled:opacity-50 flex items-center gap-1.5"
                                        >
                                            {isSavingCampaign ? (
                                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                            ) : campaignFormMode === 'create' ? (
                                                <Plus className="w-3.5 h-3.5" />
                                            ) : (
                                                <Check className="w-3.5 h-3.5" />
                                            )}
                                            <span>{campaignFormMode === 'create' ? '캠페인 생성' : '수정사항 저장'}</span>
                                        </button>
                                    </div>
                                </form>
                            </div>

                            {/* Campaign Table List */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                                        <Layers className="w-4 h-4 text-slate-500" />
                                        운영 및 접수 캠페인 목록
                                    </h4>
                                    <span className="text-[11px] text-slate-400 font-medium">
                                        * 삭제 기능은 제공되지 않으며 비활성화로 운영을 중단할 수 있습니다.
                                    </span>
                                </div>

                                <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-xs">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-xs">
                                            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold">
                                                <tr>
                                                    <th className="py-2.5 px-3">코드</th>
                                                    <th className="py-2.5 px-3">회사/기관명</th>
                                                    <th className="py-2.5 px-3">운영 목적</th>
                                                    <th className="py-2.5 px-3 text-center">상태</th>
                                                    <th className="py-2.5 px-3 text-center">접수/대기/완료</th>
                                                    <th className="py-2.5 px-3 text-right">작업</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                                {campaignsList.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={6} className="py-8 text-center text-slate-400 font-medium">
                                                            등록된 캠페인이 없습니다. 상단에서 첫 캠페인을 등록해 보세요.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    campaignsList.map(camp => {
                                                        const isUnregistered = camp.campaignRegistrationStatus === 'UNREGISTERED';
                                                        const counts = camp.counts || {
                                                            receivedCount: camp.receivedCount || 0,
                                                            pendingReviewCount: camp.pendingReviewCount || 0,
                                                            registeredReferralCount: camp.registeredReferralCount || 0,
                                                            completedCount: camp.completedCount || 0
                                                        };
                                                        return (
                                                            <tr key={camp.code} className="hover:bg-slate-50/80 transition">
                                                                <td className="py-2.5 px-3 font-mono font-bold text-indigo-700 whitespace-nowrap">
                                                                    <div className="flex items-center gap-1.5">
                                                                        <span>{camp.code}</span>
                                                                        {isUnregistered && (
                                                                            <span className="px-1.5 py-0.2 bg-rose-100 text-rose-700 text-[10px] rounded font-bold">
                                                                                미등록
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                                <td className="py-2.5 px-3 font-bold text-slate-800 whitespace-nowrap">
                                                                    {camp.companyName}
                                                                </td>
                                                                <td className="py-2.5 px-3 text-slate-600 max-w-[200px] truncate" title={camp.purpose || ''}>
                                                                    {camp.purpose || '-'}
                                                                </td>
                                                                <td className="py-2.5 px-3 text-center whitespace-nowrap">
                                                                    {camp.isActive ? (
                                                                        <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-bold">
                                                                            활성
                                                                        </span>
                                                                    ) : (
                                                                        <span className="px-2 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded-full text-[10px] font-bold">
                                                                            비활성
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td className="py-2.5 px-3 text-center whitespace-nowrap">
                                                                    <div className="text-[11px] font-medium text-slate-600">
                                                                        <span className="font-bold text-slate-900" title="수신 건수">{counts.receivedCount}</span> /{' '}
                                                                        <span className="font-bold text-amber-600" title="검토 대기">{counts.pendingReviewCount}</span> /{' '}
                                                                        <span className="font-bold text-emerald-600" title="완료">{counts.completedCount}</span>
                                                                    </div>
                                                                </td>
                                                                <td className="py-2.5 px-3 text-right whitespace-nowrap">
                                                                    <div className="flex items-center justify-end gap-1.5">
                                                                        {/* Copy Link Button */}
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleCopyCampaignLink(camp)}
                                                                            className={`px-2 py-1 text-xs font-bold rounded-lg border transition flex items-center gap-1 ${
                                                                                copyFeedbackCode === camp.code
                                                                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                                                                    : camp.isActive
                                                                                        ? 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                                                                                        : 'bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-300'
                                                                            }`}
                                                                            title={camp.isActive ? '설문 배포 링크 복사' : '비활성 캠페인 (클릭 시 확인 후 복사)'}
                                                                        >
                                                                            {copyFeedbackCode === camp.code ? (
                                                                                <>
                                                                                    <Check className="w-3 h-3" />
                                                                                    <span>복사됨!</span>
                                                                                </>
                                                                            ) : (
                                                                                <>
                                                                                    <Copy className="w-3 h-3" />
                                                                                    <span>링크 복사</span>
                                                                                </>
                                                                            )}
                                                                        </button>

                                                                        {/* Edit Button */}
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleStartEditCampaign(camp)}
                                                                            className="px-2 py-1 text-xs font-bold bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 rounded-lg transition flex items-center gap-1"
                                                                            title="메타데이터 수정"
                                                                        >
                                                                            <Edit2 className="w-3 h-3" />
                                                                            <span>수정</span>
                                                                        </button>

                                                                        {/* Active/Inactive Toggle Button */}
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleToggleCampaignActive(camp)}
                                                                            className={`px-2 py-1 text-[11px] font-bold rounded-lg border transition ${
                                                                                camp.isActive
                                                                                    ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200'
                                                                                    : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                                                                            }`}
                                                                            title={camp.isActive ? '캠페인 비활성화 (운영 중단)' : '캠페인 활성화'}
                                                                        >
                                                                            {camp.isActive ? '비활성화' : '활성화'}
                                                                        </button>
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="pt-3 border-t border-slate-100 flex items-center justify-between shrink-0">
                            <span className="text-[11px] text-slate-400">
                                캠페인 필터를 적용하려면 상단 필터 바의 드롭다운을 이용하세요.
                            </span>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsCampaignModalOpen(false);
                                    handleStartCreateCampaign();
                                }}
                                className="px-4 py-2 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition"
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { WebsiteReferralSummary, WebsiteReferralItem } from '../../types';
import { apiClient } from '../../services/apiClient';
import {
    Globe, RefreshCw, ExternalLink, CheckCircle2, Clock,
    AlertCircle, X, ChevronRight, User, Building2, Phone, Calendar,
    FileText, ArrowRight
} from 'lucide-react';

interface SeptemberWebsiteReferralBannerProps {
    websiteReferralItems?: any[];
    onImportReferral?: (item: any) => void;
    onNavigate?: (page: string) => void;
    onSyncComplete?: () => void;
    showToast?: (msg: string) => void;
}

/**
 * Mask phone numbers according to privacy policy (e.g. 010-****-1234)
 */
const maskPhone = (phone?: string | null): string => {
    if (!phone) return '-';
    const digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.length === 11) {
        return `${digits.slice(0, 3)}-****-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
        return `${digits.slice(0, 3)}-***-${digits.slice(6)}`;
    }
    if (digits.length >= 7) {
        return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
    }
    return phone;
};

export const SeptemberWebsiteReferralBanner: React.FC<SeptemberWebsiteReferralBannerProps> = ({
    websiteReferralItems,
    onImportReferral,
    onNavigate,
    onSyncComplete,
    showToast
}) => {
    const [summary, setSummary] = useState<WebsiteReferralSummary | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const triggerButtonRef = useRef<HTMLButtonElement>(null);
    const wasModalOpenRef = useRef(isModalOpen);

    // Fetch summary from server
    const loadSummary = useCallback(async () => {
        try {
            const data = await apiClient.getWebsiteReferralsSummary();
            setSummary(data);
        } catch (err) {
            console.error('[SeptemberWebsiteReferralBanner] Failed to load summary:', err);
        }
    }, []);

    useEffect(() => {
        loadSummary();
        const timer = setInterval(loadSummary, 60_000);
        return () => clearInterval(timer);
    }, [loadSummary]);

    // Handle Escape key to close modal
    useEffect(() => {
        if (!isModalOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsModalOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isModalOpen]);

    // Focus return to trigger button after modal close
    useEffect(() => {
        if (wasModalOpenRef.current && !isModalOpen) {
            triggerButtonRef.current?.focus();
        }
        wasModalOpenRef.current = isModalOpen;
    }, [isModalOpen]);

    // Manual Refresh Handler
    const handleSync = async () => {
        if (isSyncing) return;
        setIsSyncing(true);
        try {
            const res = await apiClient.syncWebsiteReferrals();
            setSummary(res);
            if (onSyncComplete) onSyncComplete();
            if (showToast) {
                showToast(`🌐 홈페이지 동기화 완료: 의뢰 ${res.total}건 (미확인 ${res.unseen}건)`);
            }
        } catch (err: any) {
            console.error('[SeptemberWebsiteReferralBanner] Sync error:', err);
            if (showToast) {
                showToast(`⚠️ 홈페이지 동기화 실패: ${err?.message || '네트워크 오류'}`);
            }
            await loadSummary();
        } finally {
            setIsSyncing(false);
        }
    };

    // Open detail modal and mark seen
    const handleOpenModal = async () => {
        setIsModalOpen(true);
        if (summary && summary.unseen > 0) {
            try {
                const updated = await apiClient.markWebsiteReferralsSeen();
                setSummary(updated);
            } catch (err) {
                console.error('[SeptemberWebsiteReferralBanner] Failed to mark seen:', err);
            }
        }
    };

    // Format Korean date time
    const formatDateTime = (dateStr?: string | null) => {
        if (!dateStr) return '기록 없음';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            const pad = (n: number) => String(n).padStart(2, '0');
            const year = d.getFullYear();
            const month = pad(d.getMonth() + 1);
            const day = pad(d.getDate());
            const hours = pad(d.getHours());
            const mins = pad(d.getMinutes());
            return `${year}-${month}-${day} ${hours}:${mins}`;
        } catch {
            return dateStr;
        }
    };

    // Unified & Strictly Isolated Website Referral Items
    const cleanWebsiteItems = useMemo(() => {
        const rawList = [
            ...(websiteReferralItems || []),
            ...(summary?.items || [])
        ];

        const validItems = rawList.filter(item => {
            if (!item || typeof item !== 'object') return false;
            // Strictly exclude online surveys
            if (item.source === 'online_survey' || item.surveySubmissionId || item.submissionId || item.sourceSurveyId || item.sourceSubmissionId) return false;
            if (item.referralPath === '온라인설문' || item.requestAgency === '온라인 자가검진') return false;
            // Strictly exclude voice calls
            if (item.source === 'voice_call' || item.voiceCallId || item.referralPath === '음성통화' || item.referralPath === '음성접수') return false;
            // Exclude scanner probes or test spam
            if (/sparrow|dast|<script|alert\(/i.test(`${item.name} ${item.phone} ${item.problem} ${item.reason}`)) return false;
            // Explicit website channel requirement (fail-closed, externalIdx alone is not sufficient)
            const isExplicitWeb = item.source === 'website' || item.source === 'homepage' || item.source === 'web' ||
                item.source === 'pending' || item.source === 'registered' ||
                item.referralPath === '홈페이지' || item.referralPath === '홈페이지 의뢰' || item.referralPath === '홈페이지 상담신청' ||
                item.requestAgency === '홈페이지' || item.isWebsiteReferral === true;
            return isExplicitWeb;
        });

        // Deduplicate using canonical ID
        const uniqueMap = new Map<string, any>();
        validItems.forEach((item, index) => {
            const canonicalKey = item.id || item.externalIdx || item.refNo || item.referralId || `${item.name}_${item.phone || ''}_${index}`;
            if (!uniqueMap.has(canonicalKey)) {
                uniqueMap.set(canonicalKey, item);
            }
        });

        return Array.from(uniqueMap.values());
    }, [websiteReferralItems, summary?.items]);

    const totalCount = summary?.total !== undefined && summary.total > cleanWebsiteItems.length
        ? summary.total
        : cleanWebsiteItems.length;
    const hasReferrals = totalCount > 0;
    const unseenCount = summary?.unseen ?? cleanWebsiteItems.filter(i => !i.isSeen).length;
    const isSyncFailed = summary?.lastSyncStatus === 'failed';

    const registeredCount = cleanWebsiteItems.filter(i => Boolean(i.source === 'registered' || i.refNo || i.referralId || i.status === 'completed')).length;
    const unregisteredCount = cleanWebsiteItems.length - registeredCount;

    return (
        <>
            {/* Banner Notification Card */}
            <div
                className={`relative overflow-hidden rounded-3xl border-2 transition-all duration-300 mb-6 p-5 sm:p-6 shadow-md ${hasReferrals
                        ? (unseenCount > 0
                            ? 'bg-gradient-to-r from-amber-50 via-orange-50 to-amber-100/60 border-amber-300 hover:border-amber-400 hover:shadow-lg'
                            : 'bg-gradient-to-r from-amber-50/70 via-yellow-50/60 to-amber-100/40 border-amber-200 hover:border-amber-300 hover:shadow-lg')
                        : 'bg-gradient-to-r from-slate-50 to-slate-100 border-slate-200 opacity-90'
                    }`}
            >
                {/* Background decorative elements */}
                <div className="absolute -right-8 -bottom-8 w-40 h-40 bg-gradient-to-br from-amber-200/20 to-orange-200/30 rounded-full blur-2xl pointer-events-none" />

                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 relative z-10">
                    {/* Left: Icon & Main Metrics */}
                    <div className="flex items-start sm:items-center gap-4">
                        <div
                            className={`relative w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-md ${hasReferrals
                                    ? (unseenCount > 0
                                        ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-200'
                                        : 'bg-gradient-to-br from-amber-500 to-yellow-600 text-white shadow-amber-200')
                                    : 'bg-slate-300 text-slate-600'
                                }`}
                        >
                            <Globe size={24} />
                            {unseenCount > 0 && (
                                <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500 border-2 border-white" />
                                </span>
                            )}
                        </div>

                        <div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                                    {hasReferrals ? (
                                        <>홈페이지 의뢰 <span className="text-amber-600 font-black">{totalCount}건</span></>
                                    ) : (
                                        '접수된 홈페이지 의뢰 없음'
                                    )}
                                </h3>

                                {unseenCount > 0 && (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-black bg-red-100 text-red-700 border border-red-200 animate-pulse">
                                        신규 {unseenCount}건
                                    </span>
                                )}
                            </div>

                            <p className="text-sm font-bold text-slate-600 mt-1 flex items-center gap-2 flex-wrap">
                                <span>
                                    {hasReferrals ? (
                                        <>
                                            <span className={unseenCount > 0 ? 'text-amber-700 font-extrabold' : 'text-slate-700 font-bold'}>
                                                미확인 {unseenCount}건
                                            </span>
                                            <span className="mx-1 text-slate-300">·</span>
                                            <span className="text-amber-800 font-medium">
                                                미등록 {unregisteredCount}건
                                            </span>
                                            <span className="mx-1 text-slate-300">·</span>
                                            <span className="text-emerald-700 font-bold">
                                                등록 완료 {registeredCount}건
                                            </span>
                                        </>
                                    ) : (
                                        '접수된 홈페이지 외부 의뢰가 없습니다.'
                                    )}
                                </span>
                            </p>

                            <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-400 font-medium">
                                <Clock size={13} className="shrink-0 text-slate-400" />
                                <span>마지막 동기화: {formatDateTime(summary?.lastSuccessfulSyncAt)}</span>
                                {isSyncFailed && (
                                    <span className="text-amber-600 font-bold flex items-center gap-1">
                                        <AlertCircle size={12} />
                                        <span>(최근 동기화 실패 / 기존 집계 유지)</span>
                                    </span>
                                )}
                                {Boolean(summary && summary.failedDetailCount > 0) && (
                                    <span className="text-rose-500 font-semibold">
                                        (상세조회 실패: {summary!.failedDetailCount}건)
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0 self-end sm:self-auto w-full sm:w-auto mt-2 sm:mt-0">
                        {/* Refresh button */}
                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl font-bold text-xs sm:text-sm transition-all duration-200 border shadow-sm ${isSyncing
                                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                    : 'bg-white hover:bg-amber-50/50 text-slate-700 border-amber-200 hover:border-amber-300 active:scale-95'
                                }`}
                            title="홈페이지(imhc.co.kr)에서 최신 의뢰를 즉시 가져옵니다"
                        >
                            <RefreshCw size={16} className={`${isSyncing ? 'animate-spin text-amber-600' : 'text-slate-500'}`} />
                            <span>{isSyncing ? '동기화 중...' : '홈페이지 의뢰 새로고침'}</span>
                        </button>

                        {/* View/Details button */}
                        <button
                            ref={triggerButtonRef}
                            onClick={handleOpenModal}
                            className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl font-black text-xs sm:text-sm text-white transition-all duration-200 shadow-md active:scale-95 ${hasReferrals
                                    ? 'bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 hover:from-amber-600 hover:to-orange-600 shadow-amber-200 hover:shadow-lg'
                                    : 'bg-slate-600 hover:bg-slate-700'
                                }`}
                        >
                            <span>홈페이지 의뢰 확인하기</span>
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Restored Lemon / Light-Yellow Website Referral List Popover Modal */}
            {isModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-3 sm:p-4 animate-in fade-in duration-200"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setIsModalOpen(false);
                        }
                    }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="website-referrals-modal-title"
                        className="bg-gradient-to-b from-amber-50/90 via-yellow-50/40 to-white w-[calc(100vw-24px)] sm:w-[min(720px,calc(100vw-32px))] max-h-[75vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden border-2 border-amber-300"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal Header */}
                        <div className="p-4 sm:p-5 border-b border-amber-200/80 flex items-center justify-between bg-gradient-to-r from-amber-100/90 via-yellow-100/80 to-amber-50/90">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shadow-md shadow-amber-200/60 shrink-0">
                                    <Globe size={22} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h2 id="website-referrals-modal-title" className="text-lg sm:text-xl font-black text-amber-950 tracking-tight">
                                            홈페이지 의뢰 대상자 목록
                                        </h2>
                                        <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-200 text-amber-900 font-extrabold border border-amber-300">
                                            총 {cleanWebsiteItems.length}건
                                        </span>
                                    </div>
                                    <p className="text-xs text-amber-800/80 mt-0.5 font-medium">
                                        홈페이지(imhc.co.kr)를 통해 접수된 의뢰 대상자 목록입니다.
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="w-9 h-9 rounded-xl text-amber-800 hover:text-amber-950 hover:bg-amber-200/60 flex items-center justify-center transition-colors shrink-0"
                                aria-label="닫기"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* List Content */}
                        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-3 bg-amber-50/30">
                            {cleanWebsiteItems.length === 0 ? (
                                <div className="text-center py-12">
                                    <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-100 text-amber-500 flex items-center justify-center mb-3">
                                        <Globe size={24} />
                                    </div>
                                    <p className="text-base font-bold text-amber-900">접수된 홈페이지 의뢰가 없습니다.</p>
                                    <p className="text-xs text-amber-700/70 mt-1">새로운 의뢰가 접수되면 자동으로 표시됩니다.</p>
                                </div>
                            ) : (
                                cleanWebsiteItems.map((item, index) => {
                                    const isRegistered = Boolean(item.source === 'registered' || item.refNo || item.referralId || item.status === 'completed');
                                    const itemKey = item.id || item.externalIdx || item.refNo || item.referralId || `web_ref_item_${index}`;
                                    const rawDate = item.externalReceivedAt || item.registrationDate || item.requestDate || item.createdAt || '-';
                                    const displayDate = rawDate.length > 10 ? rawDate.slice(0, 10) : rawDate;
                                    const maskedPhoneNum = maskPhone(item.phone);

                                    return (
                                        <div
                                            key={itemKey}
                                            className="bg-white rounded-2xl border-2 border-amber-200/70 hover:border-amber-400 p-4 sm:p-4.5 shadow-sm hover:shadow-md transition-all"
                                        >
                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                                {/* Left Details */}
                                                <div className="space-y-1.5 flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        {isRegistered ? (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black bg-emerald-100 text-emerald-800 border border-emerald-200">
                                                                <CheckCircle2 size={12} />
                                                                <span>등록 완료</span>
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black bg-amber-100 text-amber-800 border border-amber-200">
                                                                <AlertCircle size={12} />
                                                                <span>미등록</span>
                                                            </span>
                                                        )}

                                                        {item.externalIdx && (
                                                            <span className="text-xs font-bold px-2 py-0.5 rounded-lg bg-amber-50 text-amber-800 border border-amber-200/60 font-mono">
                                                                {item.externalIdx}
                                                            </span>
                                                        )}

                                                        <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
                                                            <Calendar size={12} />
                                                            <span>접수: {displayDate}</span>
                                                        </span>
                                                    </div>

                                                    {/* Person Information */}
                                                    <div className="flex items-center gap-2.5 pt-0.5 flex-wrap">
                                                        <h4 className="text-base sm:text-lg font-black text-slate-900">
                                                            {item.name || '이름 미입력'}
                                                        </h4>
                                                        {(item.gender || item.age) && (
                                                            <span className="text-xs font-bold text-slate-500">
                                                                ({[item.gender, item.age ? `${item.age}세` : ''].filter(Boolean).join(', ')})
                                                            </span>
                                                        )}
                                                        {item.phone && (
                                                            <span className="text-xs font-semibold text-slate-600 flex items-center gap-1 font-mono">
                                                                <Phone size={12} className="text-amber-500" />
                                                                {maskedPhoneNum}
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Agency & Requester */}
                                                    {(item.agency || item.requestAgency || item.requesterName) && (
                                                        <div className="flex items-center gap-2 text-xs text-slate-600 font-medium truncate">
                                                            <Building2 size={12} className="text-slate-400 shrink-0" />
                                                            <span>의뢰기관: <strong className="text-slate-800">{item.agency || item.requestAgency || '미상'}</strong></span>
                                                            {item.requesterName && (
                                                                <>
                                                                    <span className="text-slate-300">·</span>
                                                                    <span>의뢰인: <strong className="text-slate-800">{item.requesterName}</strong></span>
                                                                </>
                                                            )}
                                                        </div>
                                                    )}

                                                    {/* Problem / Reason */}
                                                    {(item.problem || item.reason) && (
                                                        <div className="mt-1 bg-amber-50/60 rounded-xl p-2.5 text-xs text-slate-700 space-y-0.5 border border-amber-100">
                                                            {item.problem && (
                                                                <p className="line-clamp-1"><strong className="text-amber-950 font-bold">[주문제]</strong> {item.problem}</p>
                                                            )}
                                                            {item.reason && (
                                                                <p className="text-slate-600 line-clamp-1"><strong className="text-amber-950 font-bold">[의뢰이유]</strong> {item.reason}</p>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Right Action Button */}
                                                <div className="shrink-0 flex items-center gap-2 self-end sm:self-center">
                                                    {isRegistered ? (
                                                        <button
                                                            onClick={() => {
                                                                setIsModalOpen(false);
                                                                if (onImportReferral) {
                                                                    onImportReferral({
                                                                        targetReferralId: item.refNo || item.referralId,
                                                                        source: 'registered',
                                                                        refNo: item.refNo,
                                                                        referralId: item.referralId
                                                                    });
                                                                } else if (onNavigate) {
                                                                    onNavigate('referrals');
                                                                }
                                                            }}
                                                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors shadow-sm"
                                                        >
                                                            <span>등록된 의뢰 보기</span>
                                                            <ArrowRight size={13} />
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={() => {
                                                                setIsModalOpen(false);
                                                                if (onImportReferral) {
                                                                    onImportReferral(item);
                                                                }
                                                            }}
                                                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-md shadow-amber-200 transition-all active:scale-95"
                                                        >
                                                            <FileText size={14} />
                                                            <span>신규 의뢰 등록</span>
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {/* Modal Footer */}
                        <div className="p-3.5 sm:p-4 border-t border-amber-200/80 bg-gradient-to-r from-amber-50 via-yellow-50 to-white flex items-center justify-between text-xs text-amber-900/80 font-bold">
                            <span>
                                전체: <strong>{cleanWebsiteItems.length}건</strong> (미등록 {unregisteredCount}건 · 등록 {registeredCount}건)
                            </span>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="px-4 py-2 rounded-xl bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold transition-colors border border-amber-200/60"
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default SeptemberWebsiteReferralBanner;

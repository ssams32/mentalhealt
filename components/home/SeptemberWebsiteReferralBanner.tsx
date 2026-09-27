import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { WebsiteReferralSummary, WebsiteReferralItem } from '../../types';
import { apiClient } from '../../services/apiClient';
import {
    Globe, RefreshCw, ExternalLink, CheckCircle2, Clock,
    AlertCircle, X, ChevronRight, User, Building2, Phone, Calendar,
    Sparkles, Eye, ShieldAlert, FileText, ArrowRight
} from 'lucide-react';

interface SeptemberWebsiteReferralBannerProps {
    onImportReferral?: (item: any) => void;
    onNavigate?: (page: string) => void;
    onSyncComplete?: () => void;
    showToast?: (msg: string) => void;
}

export const SeptemberWebsiteReferralBanner: React.FC<SeptemberWebsiteReferralBannerProps> = ({
    onImportReferral,
    onNavigate,
    onSyncComplete,
    showToast
}) => {
    const [summary, setSummary] = useState<WebsiteReferralSummary | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [activeFilter, setActiveFilter] = useState<'all' | 'unseen' | 'processing' | 'completed'>('all');

    // Fetch summary
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
        // Periodic refresh every 60 seconds
        const timer = setInterval(loadSummary, 60_000);
        return () => clearInterval(timer);
    }, [loadSummary]);

    // Manual Refresh Handler
    const handleSync = async () => {
        if (isSyncing) return;
        setIsSyncing(true);
        try {
            const res = await apiClient.syncWebsiteReferrals();
            setSummary(res);
            if (onSyncComplete) onSyncComplete();
            if (showToast) {
                showToast(`🌐 홈페이지 동기화 완료: 9월 의뢰 ${res.total}건 (미확인 ${res.unseen}건)`);
            }
        } catch (err: any) {
            console.error('[SeptemberWebsiteReferralBanner] Sync error:', err);
            if (showToast) {
                showToast(`⚠️ 홈페이지 동기화 실패: ${err?.message || '네트워크 오류'}`);
            }
            // Re-fetch to display error status without wiping existing data
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

    // Filtered items in detail modal (strictly isolating website referrals)
    const filteredItems = useMemo(() => {
        if (!summary || !summary.items) return [];
        const baseItems = summary.items.filter(item => {
            if (!item || typeof item !== 'object') return false;
            // Strictly exclude online surveys
            if (item.source === 'online_survey' || item.surveySubmissionId || item.submissionId || item.sourceSurveyId || item.sourceSubmissionId) return false;
            if (item.referralPath === '온라인설문' || item.requestAgency === '온라인 자가검진') return false;
            // Strictly exclude voice calls
            if (item.source === 'voice_call' || item.voiceCallId || item.referralPath === '음성통화' || item.referralPath === '음성접수') return false;
            // Explicit website channel requirement (fail-closed, externalIdx alone is not sufficient)
            const isExplicitWeb = item.source === 'website' || item.source === 'homepage' || item.source === 'web' || item.source === 'pending' ||
                item.referralPath === '홈페이지' || item.referralPath === '홈페이지 의뢰' || item.referralPath === '홈페이지 상담신청' ||
                item.requestAgency === '홈페이지' || item.isWebsiteReferral === true;
            return isExplicitWeb;
        });

        switch (activeFilter) {
            case 'unseen':
                return baseItems.filter(item => !item.isSeen);
            case 'processing':
                return baseItems.filter(item => item.status === 'processing' || item.status === 'pending');
            case 'completed':
                return baseItems.filter(item => item.status === 'completed');
            case 'all':
            default:
                return baseItems;
        }
    }, [summary, activeFilter]);

    if (!summary) return null;

    const hasSeptemberReferrals = summary.total > 0;
    const hasUnseen = summary.unseen > 0;
    const isSyncFailed = summary.lastSyncStatus === 'failed';

    return (
        <>
            {/* Banner Notification Card */}
            <div
                className={`relative overflow-hidden rounded-3xl border-2 transition-all duration-300 mb-6 p-5 sm:p-6 shadow-md ${hasSeptemberReferrals
                        ? (hasUnseen
                            ? 'bg-gradient-to-r from-amber-50 via-orange-50 to-amber-100/60 border-amber-300 hover:border-amber-400 hover:shadow-lg'
                            : 'bg-gradient-to-r from-slate-50 via-indigo-50/40 to-blue-50/60 border-indigo-200 hover:border-indigo-300 hover:shadow-lg')
                        : 'bg-gradient-to-r from-slate-50 to-slate-100 border-slate-200 opacity-90'
                    }`}
            >
                {/* Background decorative elements */}
                <div className="absolute -right-8 -bottom-8 w-40 h-40 bg-gradient-to-br from-amber-200/20 to-orange-200/30 rounded-full blur-2xl pointer-events-none" />

                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 relative z-10">
                    {/* Left: Icon & Main Metrics */}
                    <div className="flex items-start sm:items-center gap-4">
                        <div
                            className={`relative w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-md ${hasSeptemberReferrals
                                    ? (hasUnseen ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-200' : 'bg-gradient-to-br from-indigo-600 to-blue-600 text-white shadow-indigo-200')
                                    : 'bg-slate-300 text-slate-600'
                                }`}
                        >
                            <Globe size={24} />
                            {hasUnseen && (
                                <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500 border-2 border-white" />
                                </span>
                            )}
                        </div>

                        <div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                                    {hasSeptemberReferrals ? (
                                        <>홈페이지 9월 의뢰 <span className="text-amber-600 font-black">{summary.total}건</span></>
                                    ) : (
                                        '2026년 9월 홈페이지 의뢰 없음'
                                    )}
                                </h3>

                                {hasUnseen && (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-black bg-red-100 text-red-700 border border-red-200 animate-pulse">
                                        신규 {summary.unseen}건
                                    </span>
                                )}
                            </div>

                            <p className="text-sm font-bold text-slate-600 mt-1 flex items-center gap-2 flex-wrap">
                                <span>
                                    {hasSeptemberReferrals ? (
                                        <>
                                            <span className={hasUnseen ? 'text-amber-700 font-extrabold' : 'text-slate-700 font-bold'}>
                                                미확인 {summary.unseen}건
                                            </span>
                                            <span className="mx-1 text-slate-300">·</span>
                                            <span className="text-slate-600 font-medium">
                                                처리 대기 {summary.pending}건
                                            </span>
                                            <span className="mx-1 text-slate-300">·</span>
                                            <span className="text-emerald-700 font-bold">
                                                처리 완료 {summary.completed}건
                                            </span>
                                        </>
                                    ) : (
                                        '접수된 홈페이지 외부 의뢰가 없습니다.'
                                    )}
                                </span>
                            </p>

                            <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-400 font-medium">
                                <Clock size={13} className="shrink-0 text-slate-400" />
                                <span>마지막 동기화: {formatDateTime(summary.lastSuccessfulSyncAt)}</span>
                                {isSyncFailed && (
                                    <span className="text-amber-600 font-bold flex items-center gap-1">
                                        <AlertCircle size={12} />
                                        <span>(최근 동기화 실패 / 기존 집계 유지)</span>
                                    </span>
                                )}
                                {summary.failedDetailCount > 0 && (
                                    <span className="text-rose-500 font-semibold">
                                        (상세조회 실패: {summary.failedDetailCount}건)
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
                                    : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300 active:scale-95'
                                }`}
                            title="홈페이지(imhc.co.kr)에서 최신 의뢰를 즉시 가져옵니다"
                        >
                            <RefreshCw size={16} className={`${isSyncing ? 'animate-spin text-indigo-600' : 'text-slate-500'}`} />
                            <span>{isSyncing ? '동기화 중...' : '홈페이지 의뢰 새로고침'}</span>
                        </button>

                        {/* View/Details button */}
                        <button
                            onClick={handleOpenModal}
                            className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl font-black text-xs sm:text-sm text-white transition-all duration-200 shadow-md active:scale-95 ${hasSeptemberReferrals
                                    ? 'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 shadow-indigo-200 hover:shadow-lg'
                                    : 'bg-slate-600 hover:bg-slate-700'
                                }`}
                        >
                            <span>홈페이지 의뢰 확인하기</span>
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Modal: 2026년 9월 홈페이지 의뢰 상세 목록 */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
                        {/* Modal Header */}
                        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-slate-50 to-indigo-50/30">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md">
                                    <Globe size={22} />
                                </div>
                                <div>
                                    <h2 className="text-xl font-black text-slate-900 flex items-center gap-2">
                                        2026년 9월 홈페이지 접수 의뢰 상세
                                        <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-extrabold">
                                            총 {summary.total}건
                                        </span>
                                    </h2>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                        2026-09-01 00:00:00 (Asia/Seoul) 이후 홈페이지(imhc.co.kr)를 통해 접수된 의뢰 목록입니다.
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="w-9 h-9 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition-colors"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* Filter Tabs */}
                        <div className="px-6 pt-4 pb-2 border-b border-slate-100 bg-white flex items-center gap-2 overflow-x-auto">
                            <button
                                onClick={() => setActiveFilter('all')}
                                className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${activeFilter === 'all'
                                        ? 'bg-slate-900 text-white shadow-sm'
                                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                전체 ({summary.total})
                            </button>
                            <button
                                onClick={() => setActiveFilter('unseen')}
                                className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 ${activeFilter === 'unseen'
                                        ? 'bg-amber-600 text-white shadow-sm'
                                        : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                                    }`}
                            >
                                <span>미확인</span>
                                <span className={`px-1.5 py-0.2 rounded-full text-[11px] font-black ${activeFilter === 'unseen' ? 'bg-amber-700 text-white' : 'bg-amber-200 text-amber-800'}`}>
                                    {summary.unseen}
                                </span>
                            </button>
                            <button
                                onClick={() => setActiveFilter('processing')}
                                className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${activeFilter === 'processing'
                                        ? 'bg-indigo-600 text-white shadow-sm'
                                        : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                                    }`}
                            >
                                처리 대기/진행 ({summary.pending + summary.processing})
                            </button>
                            <button
                                onClick={() => setActiveFilter('completed')}
                                className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${activeFilter === 'completed'
                                        ? 'bg-emerald-600 text-white shadow-sm'
                                        : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                    }`}
                            >
                                처리 완료 ({summary.completed})
                            </button>
                        </div>

                        {/* List Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/50">
                            {filteredItems.length === 0 ? (
                                <div className="text-center py-16">
                                    <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
                                        <Globe size={28} />
                                    </div>
                                    <p className="text-base font-bold text-slate-700">해당 조건의 홈페이지 의뢰가 없습니다.</p>
                                    <p className="text-xs text-slate-400 mt-1">새로운 의뢰가 접수되면 자동으로 표시됩니다.</p>
                                </div>
                            ) : (
                                filteredItems.map((item, index) => {
                                    const isPending = item.status === 'pending';
                                    const isProcessing = item.status === 'processing';
                                    const isCompleted = item.status === 'completed';
                                    const itemKey = item.id || item.externalIdx || `web_ref_item_${index}`;

                                    return (
                                        <div
                                            key={itemKey}
                                            className="bg-white rounded-2xl border border-slate-200 hover:border-indigo-300 p-5 shadow-sm hover:shadow-md transition-all"
                                        >
                                            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                                                {/* Left Details */}
                                                <div className="space-y-2 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        {/* Status Badges */}
                                                        {isCompleted ? (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black bg-emerald-100 text-emerald-800">
                                                                <CheckCircle2 size={12} />
                                                                <span>처리 완료</span>
                                                            </span>
                                                        ) : isProcessing ? (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black bg-indigo-100 text-indigo-800">
                                                                <Clock size={12} />
                                                                <span>처리 중</span>
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-black bg-amber-100 text-amber-800">
                                                                <AlertCircle size={12} />
                                                                <span>처리 대기</span>
                                                            </span>
                                                        )}

                                                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 font-mono">
                                                            {item.externalIdx}
                                                        </span>

                                                        <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
                                                            <Calendar size={12} />
                                                            <span>접수: {item.externalReceivedAt}</span>
                                                        </span>
                                                    </div>

                                                    {/* Person Information */}
                                                    <div className="flex items-center gap-3 pt-1">
                                                        <h4 className="text-lg font-black text-slate-900">
                                                            {item.name || '이름 미입력'}
                                                        </h4>
                                                        {(item.gender || item.age) && (
                                                            <span className="text-xs font-bold text-slate-500">
                                                                ({[item.gender, item.age ? `${item.age}세` : ''].filter(Boolean).join(', ')})
                                                            </span>
                                                        )}
                                                        {item.phone && (
                                                            <span className="text-xs font-semibold text-slate-600 flex items-center gap-1 font-mono">
                                                                <Phone size={12} className="text-slate-400" />
                                                                {item.phone}
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Agency & Requester */}
                                                    {(item.agency || item.requesterName) && (
                                                        <div className="flex items-center gap-2 text-xs text-slate-600 font-medium">
                                                            <Building2 size={13} className="text-slate-400 shrink-0" />
                                                            <span>의뢰기관: <strong className="text-slate-800">{item.agency || '미상'}</strong></span>
                                                            {item.requesterName && (
                                                                <>
                                                                    <span className="text-slate-300">·</span>
                                                                    <span>의뢰인: <strong className="text-slate-800">{item.requesterName}</strong></span>
                                                                </>
                                                            )}
                                                            {item.agencyPhone && (
                                                                <span className="text-slate-400 font-mono">({item.agencyPhone})</span>
                                                            )}
                                                        </div>
                                                    )}

                                                    {/* Problem / Reason */}
                                                    {(item.problem || item.reason) && (
                                                        <div className="mt-2 bg-slate-50 rounded-xl p-3 text-xs text-slate-700 space-y-1 border border-slate-100">
                                                            {item.problem && (
                                                                <p><strong className="text-slate-900 font-bold">[주문제]</strong> {item.problem}</p>
                                                            )}
                                                            {item.reason && (
                                                                <p className="text-slate-600 line-clamp-2"><strong className="text-slate-900 font-bold">[의뢰이유]</strong> {item.reason}</p>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Right Action Button */}
                                                <div className="shrink-0 flex items-center gap-2 self-end md:self-center">
                                                    {isPending ? (
                                                        <button
                                                            onClick={() => {
                                                                setIsModalOpen(false);
                                                                if (onImportReferral) {
                                                                    onImportReferral(item);
                                                                }
                                                            }}
                                                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm hover:shadow transition-all"
                                                        >
                                                            <FileText size={14} />
                                                            <span>의뢰서 작성으로 가져오기</span>
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={() => {
                                                                setIsModalOpen(false);
                                                                if (onNavigate) {
                                                                    onNavigate('referrals');
                                                                }
                                                            }}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                                                        >
                                                            <span>의뢰대장에서 보기</span>
                                                            <ArrowRight size={13} />
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
                        <div className="p-4 border-t border-slate-100 bg-white flex items-center justify-between text-xs text-slate-500 font-medium">
                            <span>
                                조건 필터 목록: <strong>{filteredItems.length}건</strong> (9월 전체: {summary.total}건)
                            </span>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition-colors"
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

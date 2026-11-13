import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    User,
    ExternalApiConfig,
    ExternalApiStatus,
    ExternalApiHistoryItem,
    ExternalApiTestResult,
    ExternalApiSyncJob
} from '../../types';
import { apiClient } from '../../services/apiClient';
import PageContainer from '../layout/PageContainer';
import {
    Activity,
    CheckCircle2,
    XCircle,
    AlertCircle,
    AlertTriangle,
    RefreshCw,
    Play,
    ShieldCheck,
    Key,
    Settings,
    Clock,
    RotateCcw,
    Loader2,
    WifiOff,
    Trash2
} from 'lucide-react';

interface ExternalApiAdminPageProps {
    currentUser: User;
    showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export const ExternalApiAdminPage: React.FC<ExternalApiAdminPageProps> = ({ currentUser, showToast }) => {
    // ----------------------------------------------------
    // 기본 상태 및 네트워크 상태
    // ----------------------------------------------------
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isOffline, setIsOffline] = useState(!navigator.onLine);
    const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

    // 엔진 데이터 상태
    const [config, setConfig] = useState<ExternalApiConfig | null>(null);
    const [status, setStatus] = useState<ExternalApiStatus | null>(null);
    const [historyItems, setHistoryItems] = useState<ExternalApiHistoryItem[]>([]);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [historyLimit, setHistoryLimit] = useState(50);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    // S2 연결 설정 폼 상태
    const [baseUrlInput, setBaseUrlInput] = useState('');
    const [orgIdInput, setOrgIdInput] = useState('');
    const [isSavingConfig, setIsSavingConfig] = useState(false);
    const [configMessage, setConfigMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

    // S4 연결 테스트 상태
    const [isRunningTest, setIsRunningTest] = useState(false);
    const [testResult, setTestResult] = useState<ExternalApiTestResult | null>(null);
    const [testError, setTestError] = useState<string | null>(null);

    // S5 자동 수신 폼 상태
    const [pollEnabledInput, setPollEnabledInput] = useState(false);
    const [pollIntervalInput, setPollIntervalInput] = useState(60);
    const [isSavingPoll, setIsSavingPoll] = useState(false);
    const [pollMessage, setPollMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

    // S6 수동 동기화 잡 상태
    const [isManualSyncing, setIsManualSyncing] = useState(false);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const [syncJobResult, setSyncJobResult] = useState<ExternalApiSyncJob | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);

    // S3 인증키 입력/관리 상태
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [isRegisteringKey, setIsRegisteringKey] = useState(false);
    const [isDeletingKey, setIsDeletingKey] = useState(false);
    const [keyMessage, setKeyMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

    // S7 재시도 상태
    const [retryingExternalId, setRetryingExternalId] = useState<string | null>(null);
    const [retryMessage, setRetryMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

    // 타이머 ref
    const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const jobPollingTimerRef = useRef<NodeJS.Timeout | null>(null);

    // ----------------------------------------------------
    // 온라인 / 오프라인 감지
    // ----------------------------------------------------
    useEffect(() => {
        const handleOnline = () => setIsOffline(false);
        const handleOffline = () => setIsOffline(true);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // ----------------------------------------------------
    // 데이터 새로고침 함수들
    // ----------------------------------------------------
    const fetchStatusOnly = useCallback(async () => {
        if (isOffline) return;
        try {
            const statusRes = await apiClient.getExternalApiStatus();
            setStatus(statusRes);
            setLastCheckedAt(new Date().toISOString());
        } catch (err: any) {
            console.error('Failed to fetch external API status:', err);
        }
    }, [isOffline]);

    const fetchHistory = useCallback(async (limit: number) => {
        if (isOffline) return;
        setIsLoadingHistory(true);
        try {
            const historyRes = await apiClient.getExternalApiHistory(limit);
            setHistoryItems(historyRes.items || []);
            setHistoryTotal(historyRes.total || 0);
        } catch (err: any) {
            console.error('Failed to fetch external API history:', err);
        } finally {
            setIsLoadingHistory(false);
        }
    }, [isOffline]);

    const fetchAllInitialData = useCallback(async () => {
        if (isOffline) {
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setLoadError(null);

        try {
            const [configRes, statusRes, historyRes] = await Promise.all([
                apiClient.getExternalApiConfig(),
                apiClient.getExternalApiStatus(),
                apiClient.getExternalApiHistory(historyLimit)
            ]);

            setConfig(configRes);
            setBaseUrlInput(configRes.baseUrl || '');
            setOrgIdInput(configRes.orgId || '');
            setPollEnabledInput(Boolean(configRes.pollEnabled));
            setPollIntervalInput(configRes.pollIntervalSeconds || 60);

            setStatus(statusRes);
            setHistoryItems(historyRes.items || []);
            setHistoryTotal(historyRes.total || 0);
            setLastCheckedAt(new Date().toISOString());
        } catch (err: any) {
            console.error('Failed to load external API initial data:', err);
            setLoadError(err.message || '설정을 불러오지 못했습니다. 네트워크 상태 또는 서버 권한을 확인해주세요.');
        } finally {
            setIsLoading(false);
        }
    }, [isOffline, historyLimit]);

    useEffect(() => {
        fetchAllInitialData();
    }, [fetchAllInitialData]);

    // ----------------------------------------------------
    // 상태 주기적 폴링 (동기화 중: 3초, 평상시: 30초)
    // ----------------------------------------------------
    const isSyncActive = isManualSyncing ||
        status?.syncInProgress ||
        (status as any)?.lastSync?.lastSyncStatus === 'running';

    useEffect(() => {
        if (isLoading || isOffline) return;

        const intervalMs = isSyncActive ? 3000 : 30000;

        pollingTimerRef.current = setInterval(() => {
            fetchStatusOnly();
        }, intervalMs);

        return () => {
            if (pollingTimerRef.current) {
                clearInterval(pollingTimerRef.current);
            }
        };
    }, [isLoading, isOffline, isSyncActive, fetchStatusOnly]);

    // ----------------------------------------------------
    // S2 연결 설정 저장 핸들러
    // ----------------------------------------------------
    const handleSaveConfig = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isOffline || isSavingConfig) return;

        const trimmedBaseUrl = baseUrlInput.trim();
        const trimmedOrgId = orgIdInput.trim();

        if (!trimmedBaseUrl) {
            setConfigMessage({ text: 'API 주소를 입력해주세요.', type: 'error' });
            return;
        }

        if (!trimmedOrgId) {
            setConfigMessage({ text: '기관 식별값을 입력해주세요.', type: 'error' });
            return;
        }

        setIsSavingConfig(true);
        setConfigMessage(null);

        try {
            const res = await apiClient.saveExternalApiConfig({
                baseUrl: trimmedBaseUrl,
                orgId: trimmedOrgId
            });

            if (res.config) {
                setConfig(res.config);
                setBaseUrlInput(res.config.baseUrl || '');
                setOrgIdInput(res.config.orgId || '');
            }

            setConfigMessage({ text: '연결 설정이 성공적으로 저장되었습니다.', type: 'success' });
            showToast?.('연결 설정이 저장되었습니다.', 'success');
            await fetchStatusOnly();
        } catch (err: any) {
            const errMsg = err.message || '설정 저장 중 오류가 발생했습니다.';
            setConfigMessage({ text: errMsg, type: 'error' });
            showToast?.(errMsg, 'error');
        } finally {
            setIsSavingConfig(false);
        }
    };

    // ----------------------------------------------------
    // S3 인증키 등록/변경 핸들러
    // ----------------------------------------------------
    const handleRegisterKey = async (e: React.FormEvent) => {
        e.preventDefault();
        const keyToSubmit = apiKeyInput.trim();
        // 제출 즉시 입력 state 클리어 (보안: 평문 키 즉시 폐기)
        setApiKeyInput('');

        if (isOffline || isRegisteringKey || !keyToSubmit) return;

        setIsRegisteringKey(true);
        setKeyMessage(null);

        try {
            await apiClient.registerExternalApiKey(keyToSubmit);
            setKeyMessage({ text: 'API 키가 성공적으로 등록되었습니다.', type: 'success' });
            showToast?.('API 키가 등록되었습니다.', 'success');
            await fetchAllInitialData();
        } catch (err: any) {
            const errMsg = err?.message || 'API 키 등록 중 오류가 발생했습니다.';
            setKeyMessage({ text: errMsg, type: 'error' });
            showToast?.(errMsg, 'error');
        } finally {
            setIsRegisteringKey(false);
        }
    };

    // ----------------------------------------------------
    // S3 인증키 폐기 핸들러
    // ----------------------------------------------------
    const handleDeleteKey = async () => {
        if (isOffline || isDeletingKey || !config?.keyPresent) return;

        if (!window.confirm('등록된 API 키를 폐기하시겠습니까? 폐기 후 홈페이지 자동 수신이 중단됩니다.')) {
            return;
        }

        setIsDeletingKey(true);
        setKeyMessage(null);

        try {
            await apiClient.deleteExternalApiKey();
            setApiKeyInput('');
            setKeyMessage({ text: 'API 키가 성공적으로 폐기되었습니다.', type: 'success' });
            showToast?.('API 키가 폐기되었습니다.', 'info');
            await fetchAllInitialData();
        } catch (err: any) {
            const errMsg = err?.message || 'API 키 폐기 중 오류가 발생했습니다.';
            setKeyMessage({ text: errMsg, type: 'error' });
            showToast?.(errMsg, 'error');
        } finally {
            setIsDeletingKey(false);
        }
    };

    // ----------------------------------------------------
    // S4 연결 테스트 핸들러
    // ----------------------------------------------------
    const handleTestConnection = async () => {
        if (isOffline || isRunningTest || isUnconfigured) return;

        setIsRunningTest(true);
        setTestError(null);
        setTestResult(null);

        try {
            const result = await apiClient.testExternalApiConnection();
            setTestResult(result);
            if (result.success) {
                showToast?.('연결 테스트에 성공했습니다.', 'success');
            } else {
                showToast?.('연결 테스트에 실패했습니다.', 'error');
            }
        } catch (err: any) {
            const msg = err.message || '연결 테스트 중 오류가 발생했습니다.';
            setTestError(msg);
            showToast?.(msg, 'error');
        } finally {
            setIsRunningTest(false);
        }
    };

    // ----------------------------------------------------
    // S5 자동 수신 설정 저장 핸들러
    // ----------------------------------------------------
    const handleSavePoll = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isOffline || isSavingPoll || isUnconfigured) return;

        if (pollIntervalInput < 60) {
            setPollMessage({ text: '자동 수신 주기는 최소 60초 이상이어야 합니다 (60~3600초).', type: 'error' });
            return;
        }

        if (pollIntervalInput > 3600) {
            setPollMessage({ text: '자동 수신 주기는 최대 3600초 이하이어야 합니다.', type: 'error' });
            return;
        }

        setIsSavingPoll(true);
        setPollMessage(null);

        try {
            const res = await apiClient.saveExternalApiConfig({
                pollEnabled: pollEnabledInput,
                pollIntervalSeconds: Number(pollIntervalInput)
            });

            if (res.config) {
                setConfig(res.config);
                setPollEnabledInput(Boolean(res.config.pollEnabled));
                setPollIntervalInput(res.config.pollIntervalSeconds || 60);
            }

            setPollMessage({ text: '자동 수신 설정이 저장되었습니다.', type: 'success' });
            showToast?.('자동 수신 설정이 저장되었습니다.', 'success');
            await fetchStatusOnly();
        } catch (err: any) {
            const errMsg = err.message || '자동 수신 설정 저장 실패';
            setPollMessage({ text: errMsg, type: 'error' });
            showToast?.(errMsg, 'error');
        } finally {
            setIsSavingPoll(false);
        }
    };

    // ----------------------------------------------------
    // S6 수동 동기화 및 3초 폴링 (최대 10분 = 200회)
    // ----------------------------------------------------
    const handleManualSync = async () => {
        if (isOffline || isManualSyncing || isUnconfigured) return;

        setIsManualSyncing(true);
        setSyncError(null);
        setSyncJobResult(null);

        try {
            const triggerRes = await apiClient.triggerExternalApiSync();
            const jobId = triggerRes.jobId;
            setActiveJobId(jobId);
            showToast?.('수동 동기화 작업을 시작했습니다.', 'info');

            // 잡 상태 폴링 시작 (최대 200회 = 10분)
            let pollCount = 0;
            const maxPolls = 200;

            if (jobPollingTimerRef.current) {
                clearInterval(jobPollingTimerRef.current);
            }

            jobPollingTimerRef.current = setInterval(async () => {
                pollCount += 1;
                try {
                    const job = await apiClient.getExternalApiSyncJob(jobId);

                    if (job.status === 'completed' || job.status === 'failed') {
                        if (jobPollingTimerRef.current) {
                            clearInterval(jobPollingTimerRef.current);
                            jobPollingTimerRef.current = null;
                        }
                        setSyncJobResult(job);
                        setIsManualSyncing(false);
                        setActiveJobId(null);

                        if (job.status === 'completed') {
                            showToast?.('동기화 작업이 완료되었습니다.', 'success');
                        } else {
                            showToast?.(`동기화 실패: ${job.error || '알 수 없는 오류'}`, 'error');
                        }

                        // 최신 상태 및 이력 갱신
                        await Promise.all([fetchStatusOnly(), fetchHistory(historyLimit)]);
                    } else if (pollCount >= maxPolls) {
                        if (jobPollingTimerRef.current) {
                            clearInterval(jobPollingTimerRef.current);
                            jobPollingTimerRef.current = null;
                        }
                        setIsManualSyncing(false);
                        setSyncError('동기화 작업 대기 시간이 초과되었습니다 (10분).');
                        showToast?.('동기화 대기 시간 초과', 'error');
                    }
                } catch (pollErr: any) {
                    console.error('Sync job polling error:', pollErr);
                }
            }, 3000);
        } catch (err: any) {
            setIsManualSyncing(false);
            const msg = err.message || '수동 동기화 요청 실패';
            setSyncError(msg);
            showToast?.(msg, 'error');
        }
    };

    // 언마운트 시 잡 폴링 정리
    useEffect(() => {
        return () => {
            if (jobPollingTimerRef.current) {
                clearInterval(jobPollingTimerRef.current);
            }
        };
    }, []);

    // ----------------------------------------------------
    // S7 격리 항목 재처리 핸들러
    // ----------------------------------------------------
    const handleRetryQuarantinedItem = async (externalId: string) => {
        if (isOffline || retryingExternalId) return;

        setRetryingExternalId(externalId);
        setRetryMessage(null);

        try {
            await apiClient.retryExternalApiHistoryItem(externalId);
            setRetryMessage({ text: `항목 [${externalId}] 재처리가 요청되었습니다.`, type: 'success' });
            showToast?.(`항목 [${externalId}] 재처리 완료`, 'success');
            await Promise.all([fetchStatusOnly(), fetchHistory(historyLimit)]);
        } catch (err: any) {
            const msg = err.message || `항목 [${externalId}] 재처리 실패`;
            setRetryMessage({ text: msg, type: 'error' });
            showToast?.(msg, 'error');
        } finally {
            setRetryingExternalId(null);
        }
    };

    // ----------------------------------------------------
    // 미설정 여부 및 상태 판정 헬퍼
    // ----------------------------------------------------
    const isUnconfigured = !config?.baseUrl || !config?.orgId || !config?.keyPresent;

    const computeStatusMeta = () => {
        if (isUnconfigured) {
            return {
                text: '미설정',
                color: 'bg-slate-400',
                textColor: 'text-slate-600',
                bgBadge: 'bg-slate-100 text-slate-700',
                pulse: false
            };
        }

        if (isSyncActive) {
            return {
                text: '동기화 중',
                color: 'bg-sky-500',
                textColor: 'text-sky-600',
                bgBadge: 'bg-sky-100 text-sky-800',
                pulse: true
            };
        }

        const lastSyncStatus = (status as any)?.lastSync?.lastSyncStatus ?? status?.lastSyncStatus;
        const failedCount = (status as any)?.lastSync?.lastFailedCount ?? status?.failedCount ?? 0;
        const consecutiveFailures = (status as any)?.lastSync?.consecutiveFailures ?? 0;

        if (lastSyncStatus === 'failed' || consecutiveFailures > 0 || failedCount > 0) {
            return {
                text: '실패',
                color: 'bg-rose-500',
                textColor: 'text-rose-600',
                bgBadge: 'bg-rose-100 text-rose-800',
                pulse: false
            };
        }

        return {
            text: '정상',
            color: 'bg-emerald-500',
            textColor: 'text-emerald-600',
            bgBadge: 'bg-emerald-100 text-emerald-800',
            pulse: false
        };
    };

    const statusMeta = computeStatusMeta();

    // 시간 포맷 헬퍼
    const formatDateTime = (isoString?: string | null) => {
        if (!isoString) return '-';
        try {
            const date = new Date(isoString);
            if (isNaN(date.getTime())) return isoString;
            return date.toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } catch {
            return isoString;
        }
    };

    // 마지막 성공 시각
    const lastSuccessAt = (status as any)?.lastSync?.lastSuccessfulSyncAt ?? status?.lastSuccessfulSyncAt;

    // 이번 주기 수신 건수
    const currentCycleCount = (status as any)?.lastSync?.lastReceivedCount ??
        ((status?.receivedReferrals || 0) + (status?.receivedAssessments || 0));

    // 다음 예정 시각
    const nextScheduledTime = (status as any)?.scheduler?.nextScheduledAt ??
        status?.nextScheduledAt;

    // 스크레이퍼 상태
    const scraperConflict = (status as any)?.lastSync?.scraperConflict;

    return (
        <PageContainer
            title="홈페이지 API 연동"
            subtitle="외부 홈페이지 접수 데이터 자동 수신 엔진 관리"
            headerContent={
                <div className="flex items-center gap-3">
                    {lastCheckedAt && (
                        <span className="text-xs text-slate-400 hidden sm:inline">
                            마지막 확인: {formatDateTime(lastCheckedAt)}
                        </span>
                    )}
                    <button
                        onClick={() => {
                            fetchAllInitialData();
                        }}
                        disabled={isLoading || isOffline}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                        title="전체 새로고침"
                    >
                        <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                        새로고침
                    </button>
                </div>
            }
        >
            {/* 오프라인 배너 */}
            {isOffline && (
                <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm">
                    <WifiOff size={18} className="shrink-0 text-amber-600" />
                    <div className="flex-1">
                        <span className="font-bold">오프라인 모드:</span> 네트워크 연결이 끊겼습니다. 마지막 확인 시각({formatDateTime(lastCheckedAt)}) 기준 캐시된 데이터가 표시되며, 모든 설정 및 동작 버튼이 비활성화됩니다.
                    </div>
                </div>
            )}

            {/* 초기 로딩 실패 배너 */}
            {loadError && (
                <div className="flex items-center gap-2 p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-sm">
                    <AlertCircle size={20} className="shrink-0 text-rose-600" />
                    <div>
                        <p className="font-bold">설정을 불러오지 못했습니다.</p>
                        <p className="text-xs mt-0.5 text-rose-700">{loadError}</p>
                    </div>
                </div>
            )}

            {/* 첫 진입 로딩 스피너 */}
            {isLoading && (
                <div className="flex flex-col items-center justify-center py-16 bg-white border border-slate-200 rounded-xl">
                    <Loader2 size={36} className="animate-spin text-sky-600 mb-3" />
                    <p className="text-sm font-medium text-slate-600">홈페이지 API 연동 설정을 불러오는 중입니다...</p>
                </div>
            )}

            {!isLoading && (
                <div className="space-y-6">
                    {/* ======================================================== */}
                    {/* S1. 연동 상태 가로 스트립 (페이지 상단) */}
                    {/* ======================================================== */}
                    <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            {/* 상태 점 + 상태 말 */}
                            <div className="flex items-center gap-3">
                                <div className="relative flex items-center justify-center">
                                    <span
                                        className={`w-3.5 h-3.5 rounded-full ${statusMeta.color} ${statusMeta.pulse ? 'animate-pulse' : ''}`}
                                    />
                                    {statusMeta.pulse && (
                                        <span className="absolute w-3.5 h-3.5 rounded-full bg-sky-400 opacity-75 animate-ping" />
                                    )}
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-semibold text-slate-400">연동 상태</span>
                                        <span className={`text-xs font-black px-2 py-0.5 rounded-full ${statusMeta.bgBadge}`}>
                                            {statusMeta.text}
                                        </span>
                                    </div>
                                    <p className="text-sm font-bold text-slate-800 mt-0.5">
                                        {isUnconfigured
                                            ? '외부 API 설정이 완료되지 않았습니다'
                                            : statusMeta.text === '동기화 중'
                                                ? '외부 홈페이지와 데이터 동기화 진행 중'
                                                : statusMeta.text === '실패'
                                                    ? '동기화 중 오류가 감지되었습니다'
                                                    : '홈페이지 연동 정상 작동 중'}
                                    </p>
                                </div>
                            </div>

                            {/* 세부 상태 메트릭 */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
                                <div className="border-l border-slate-200 pl-3">
                                    <p className="text-slate-400">마지막 성공 시각</p>
                                    <p className="font-semibold text-slate-700 mt-0.5">
                                        {lastSuccessAt ? formatDateTime(lastSuccessAt) : '없음'}
                                    </p>
                                </div>
                                <div className="border-l border-slate-200 pl-3">
                                    <p className="text-slate-400">이번 주기 수신 건수</p>
                                    <p className="font-semibold text-slate-700 mt-0.5">
                                        {currentCycleCount}건
                                    </p>
                                </div>
                                <div className="border-l border-slate-200 pl-3 col-span-2 sm:col-span-1">
                                    <p className="text-slate-400">다음 예정 시각</p>
                                    <p className="font-semibold text-slate-700 mt-0.5">
                                        {nextScheduledTime
                                            ? formatDateTime(nextScheduledTime)
                                            : config?.pollEnabled
                                                ? '예약 대기'
                                                : '자동 수신 꺼짐'}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* S1 하단: 기존 스크레이퍼 상태 (읽기 전용) */}
                        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                            <div className="flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                <span>
                                    기존 홈페이지 수집(스크레이퍼):{' '}
                                    <strong className={scraperConflict ? 'text-rose-600' : 'text-slate-700'}>
                                        {scraperConflict ? '켜짐 (충돌 방지로 엔진 정지)' : '꺼짐'}
                                    </strong>
                                </span>
                            </div>
                            <span className="text-[11px] text-slate-400">이 페이지에서는 스크레이퍼를 켜거나 끌 수 없습니다</span>
                        </div>
                    </section>

                    {/* ======================================================== */}
                    {/* S2 & S3: 연결 설정 & 인증키 정보 (2컬럼 그리드) */}
                    {/* ======================================================== */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* S2. 연결 설정 */}
                        <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-4">
                                    <Settings size={18} className="text-sky-600" />
                                    <h3 className="text-base font-bold text-slate-800">연결 설정</h3>
                                </div>

                                <form onSubmit={handleSaveConfig} className="space-y-4">
                                    <div>
                                        <label htmlFor="baseUrlInput" className="block text-xs font-bold text-slate-700 mb-1">
                                            홈페이지 API 기본 주소 (Base URL) <span className="text-rose-500">*</span>
                                        </label>
                                        <input
                                            id="baseUrlInput"
                                            type="text"
                                            value={baseUrlInput}
                                            onChange={(e) => setBaseUrlInput(e.target.value)}
                                            disabled={isOffline || isSavingConfig}
                                            placeholder="예: https://api.example-center.kr"
                                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-50 disabled:text-slate-400"
                                        />
                                        <p className="text-[11px] text-slate-400 mt-1">
                                            외부 홈페이지에서 제공한 API 서버의 루트 URL을 입력합니다. (운영 환경: HTTPS 필수)
                                        </p>
                                    </div>

                                    <div>
                                        <label htmlFor="orgIdInput" className="block text-xs font-bold text-slate-700 mb-1">
                                            기관 식별값 (Org ID) <span className="text-rose-500">*</span>
                                        </label>
                                        <input
                                            id="orgIdInput"
                                            type="text"
                                            value={orgIdInput}
                                            onChange={(e) => setOrgIdInput(e.target.value)}
                                            disabled={isOffline || isSavingConfig}
                                            placeholder="예: icheon-mhc"
                                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-50 disabled:text-slate-400"
                                        />
                                        <p className="text-[11px] text-slate-400 mt-1">
                                            홈페이지 시스템에 등록된 고유 기관 식별값입니다.
                                        </p>
                                    </div>

                                    {configMessage && (
                                        <div
                                            className={`p-2.5 rounded-lg text-xs font-medium ${configMessage.type === 'success'
                                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                                    : 'bg-rose-50 text-rose-700 border border-rose-200'
                                                }`}
                                        >
                                            {configMessage.text}
                                        </div>
                                    )}

                                    <div className="pt-2 flex justify-end">
                                        <button
                                            type="submit"
                                            disabled={isOffline || isSavingConfig}
                                            className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold hover:bg-slate-700 disabled:opacity-50 transition-colors"
                                        >
                                            {isSavingConfig ? (
                                                <>
                                                    <Loader2 size={14} className="animate-spin" />
                                                    저장 중...
                                                </>
                                            ) : (
                                                '연결 설정 저장'
                                            )}
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </section>

                        {/* S3. 인증키 관리 (직접 입력·변경·폐기) */}
                        <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                            <div>
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <Key size={18} className="text-sky-600" />
                                        <h3 className="text-base font-bold text-slate-800">인증키 관리</h3>
                                    </div>
                                    <span
                                        className={`text-xs font-black px-2.5 py-0.5 rounded-full ${config?.keyPresent
                                                ? 'bg-emerald-100 text-emerald-800'
                                                : 'bg-rose-100 text-rose-800'
                                            }`}
                                    >
                                        {config?.keyPresent ? '등록됨' : '미등록'}
                                    </span>
                                </div>

                                <div className="space-y-3">
                                    {/* 키 상태 표시 (지문 8자, 등록 시각) */}
                                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-slate-500 font-medium">인증키 지문 (Fingerprint):</span>
                                            <span className="font-mono font-bold text-slate-800 bg-white px-2 py-0.5 border border-slate-200 rounded">
                                                {config?.keyPresent && config.keyFingerprint
                                                    ? `${config.keyFingerprint.slice(0, 8)}...`
                                                    : '미등록'}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="text-slate-500 font-medium">등록 시각:</span>
                                            <span className="text-slate-700 font-medium">
                                                {config?.keyPresent && config.keyRegisteredAt
                                                    ? new Date(config.keyRegisteredAt).toLocaleString('ko-KR')
                                                    : config?.keyPresent
                                                        ? '환경변수/파일 로드됨'
                                                        : '-'}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-slate-400">
                                            보안을 위해 인증키의 원문이나 길이는 화면에 표시되지 않으며, SHA-256 해시 지문의 앞 8자리만 표시됩니다.
                                        </div>
                                    </div>

                                    {/* 마스터 키 미설정 경고 안내 */}
                                    {config?.masterKeyConfigured === false && (
                                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 leading-relaxed flex items-start gap-2">
                                            <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                                            <div>
                                                <p className="font-bold text-amber-950">암호화 마스터 키 미설정</p>
                                                <p className="mt-0.5 text-amber-800">
                                                    NAS에 암호화 마스터 키를 먼저 설정해야 합니다. (환경변수 <code>HOMEPAGE_KEY_ENCRYPTION_KEY</code> 설정 필요)
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {/* 저장된 키 복호화 실패 경고 안내 */}
                                    {config?.keyDecryptFailed && (
                                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 leading-relaxed flex items-start gap-2">
                                            <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                                            <div>
                                                <p className="font-bold text-amber-950">저장된 키를 열 수 없음</p>
                                                <p className="mt-0.5 text-amber-800">
                                                    저장된 키를 열 수 없습니다. 암호화 마스터 키가 바뀌었으면 키를 다시 입력해 주세요.
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {/* 키 액션 결과 메시지 */}
                                    {keyMessage && (
                                        <div
                                            className={`p-3 rounded-lg text-xs flex items-center gap-2 ${keyMessage.type === 'success'
                                                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                                    : 'bg-rose-50 text-rose-800 border border-rose-200'
                                                }`}
                                        >
                                            {keyMessage.type === 'success' ? (
                                                <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                                            ) : (
                                                <XCircle size={16} className="text-rose-600 shrink-0" />
                                            )}
                                            <span>{keyMessage.text}</span>
                                        </div>
                                    )}

                                    {/* 인증키 입력 폼 */}
                                    <form onSubmit={handleRegisterKey} className="space-y-3 pt-1">
                                        <div>
                                            <label htmlFor="apiKeyInput" className="block text-xs font-bold text-slate-700 mb-1">
                                                {config?.keyPresent ? '새 인증키 입력 (변경 시)' : '인증키 입력'}
                                            </label>
                                            <input
                                                id="apiKeyInput"
                                                type="password"
                                                autoComplete="new-password"
                                                value={apiKeyInput}
                                                onChange={(e) => setApiKeyInput(e.target.value)}
                                                disabled={config?.masterKeyConfigured === false || isRegisteringKey || isDeletingKey || isOffline}
                                                placeholder={
                                                    config?.masterKeyConfigured === false
                                                        ? 'NAS에 암호화 마스터 키를 먼저 설정해야 합니다'
                                                        : 'API 키 입력 (8~512자, 공백 불가)'
                                                }
                                                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono disabled:bg-slate-100 disabled:text-slate-400"
                                            />
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <button
                                                type="submit"
                                                disabled={
                                                    config?.masterKeyConfigured === false ||
                                                    !apiKeyInput.trim() ||
                                                    isRegisteringKey ||
                                                    isDeletingKey ||
                                                    isOffline
                                                }
                                                className="flex-1 px-4 py-2 bg-sky-600 hover:bg-sky-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                                            >
                                                {isRegisteringKey ? (
                                                    <>
                                                        <Loader2 size={14} className="animate-spin" />
                                                        {config?.keyPresent ? '변경 중...' : '등록 중...'}
                                                    </>
                                                ) : (
                                                    config?.keyPresent ? '인증키 변경' : '인증키 등록'
                                                )}
                                            </button>

                                            {config?.keyPresent && (
                                                <button
                                                    type="button"
                                                    onClick={handleDeleteKey}
                                                    disabled={isRegisteringKey || isDeletingKey || isOffline}
                                                    className="px-3 py-2 border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                                                >
                                                    {isDeletingKey ? (
                                                        <>
                                                            <Loader2 size={14} className="animate-spin" />
                                                            폐기 중...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Trash2 size={13} />
                                                            폐기
                                                        </>
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </form>
                                </div>
                            </div>

                            <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                                <span>인증 방식: {config?.authScheme || 'api-key'} ({config?.apiKeyHeader || 'X-Api-Key'})</span>
                                <span>AES-256-GCM 암호화 보관</span>
                            </div>
                        </section>
                    </div>

                    {/* ======================================================== */}
                    {/* S4, S5, S6: 연결 테스트, 자동 수신, 수동 동기화 (3컬럼 그리드) */}
                    {/* ======================================================== */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* S4. 연결 테스트 */}
                        <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <Activity size={18} className="text-sky-600" />
                                    <h3 className="text-base font-bold text-slate-800">연결 테스트</h3>
                                </div>
                                <p className="text-xs text-slate-500 mb-4">
                                    실제 데이터를 가져오지 않고, 서버 간 통신 및 인증키 유효성을 사전 점검합니다.
                                </p>

                                <button
                                    type="button"
                                    onClick={handleTestConnection}
                                    disabled={isOffline || isRunningTest || isUnconfigured}
                                    className="w-full py-2 px-3 bg-sky-600 text-white rounded-lg text-xs font-bold hover:bg-sky-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                                >
                                    {isRunningTest ? (
                                        <>
                                            <Loader2 size={14} className="animate-spin" />
                                            연결 테스트 진행 중...
                                        </>
                                    ) : (
                                        <>
                                            <Activity size={14} />
                                            연결 테스트 실행
                                        </>
                                    )}
                                </button>

                                {isUnconfigured && (
                                    <p className="text-[11px] text-amber-600 mt-2 text-center">
                                        연결 설정 및 인증키가 등록되어야 테스트할 수 있습니다.
                                    </p>
                                )}

                                {/* 테스트 결과 패널 */}
                                {testResult && (
                                    <div
                                        className={`mt-4 p-3 rounded-lg border text-xs space-y-1.5 ${testResult.success
                                                ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
                                                : 'bg-rose-50/80 border-rose-200 text-rose-950'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between font-bold">
                                            <span className="flex items-center gap-1.5">
                                                {testResult.success ? (
                                                    <CheckCircle2 size={16} className="text-emerald-600" />
                                                ) : (
                                                    <XCircle size={16} className="text-rose-600" />
                                                )}
                                                {testResult.success ? '연결 성공' : '연결 실패'}
                                            </span>
                                            <span className="text-[11px] font-mono">HTTP {testResult.httpStatus}</span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-600 pt-1 border-t border-slate-200/50">
                                            <span>응답 시간: {testResult.latencyMs}ms</span>
                                            <span>인증: {testResult.authPassed ? '통과' : '실패'}</span>
                                        </div>
                                        {testResult.error && (
                                            <p className="text-[11px] text-rose-700 font-medium pt-1">
                                                오류: {testResult.error}
                                            </p>
                                        )}
                                        <p className="text-[10px] text-slate-400 text-right">
                                            테스트 시각: {formatDateTime(testResult.testedAt)}
                                        </p>
                                    </div>
                                )}

                                {testError && (
                                    <div className="mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                                        <p className="font-bold">테스트 오류</p>
                                        <p className="mt-0.5">{testError}</p>
                                    </div>
                                )}
                            </div>

                            <p className="text-[11px] text-slate-400 mt-4 pt-2 border-t border-slate-100">
                                속도 제한: 관리자당 분당 최대 5회
                            </p>
                        </section>

                        {/* S5. 자동 수신 설정 */}
                        <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <Clock size={18} className="text-sky-600" />
                                    <h3 className="text-base font-bold text-slate-800">자동 수신 (스케줄러)</h3>
                                </div>
                                <p className="text-xs text-slate-500 mb-4">
                                    설정된 주기마다 외부 홈페이지 신규 접수 내역을 백그라운드에서 자동 수신합니다.
                                </p>

                                <form onSubmit={handleSavePoll} className="space-y-4">
                                    {/* ON/OFF 토글 */}
                                    <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
                                        <div>
                                            <p className="text-xs font-bold text-slate-800">자동 수신 활성화</p>
                                            <p className="text-[11px] text-slate-400">기본값: OFF</p>
                                        </div>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={pollEnabledInput}
                                                onChange={(e) => setPollEnabledInput(e.target.checked)}
                                                disabled={isOffline || isSavingPoll || isUnconfigured}
                                                className="sr-only peer"
                                            />
                                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600 peer-disabled:opacity-50"></div>
                                        </label>
                                    </div>

                                    {/* 주기 설정 */}
                                    <div>
                                        <label htmlFor="pollIntervalInput" className="block text-xs font-bold text-slate-700 mb-1">
                                            수신 주기 (단위: 초, 60~3600)
                                        </label>
                                        <input
                                            id="pollIntervalInput"
                                            type="number"
                                            min={60}
                                            max={3600}
                                            value={pollIntervalInput}
                                            onChange={(e) => setPollIntervalInput(Math.max(0, parseInt(e.target.value) || 0))}
                                            disabled={isOffline || isSavingPoll || isUnconfigured}
                                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-50 disabled:text-slate-400"
                                        />
                                        <p className="text-[11px] text-slate-400 mt-1">
                                            60초 미만은 서버 부하 방지를 위해 입력할 수 없습니다. (권장: 60초)
                                        </p>
                                    </div>

                                    {pollMessage && (
                                        <div
                                            className={`p-2.5 rounded-lg text-xs font-medium ${pollMessage.type === 'success'
                                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                                    : 'bg-rose-50 text-rose-700 border border-rose-200'
                                                }`}
                                        >
                                            {pollMessage.text}
                                        </div>
                                    )}

                                    <button
                                        type="submit"
                                        disabled={isOffline || isSavingPoll || isUnconfigured}
                                        className="w-full py-2 px-3 bg-slate-800 text-white rounded-lg text-xs font-bold hover:bg-slate-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
                                    >
                                        {isSavingPoll ? (
                                            <>
                                                <Loader2 size={14} className="animate-spin" />
                                                저장 중...
                                            </>
                                        ) : (
                                            '자동 수신 설정 저장'
                                        )}
                                    </button>
                                </form>
                            </div>

                            {isUnconfigured && (
                                <p className="text-[11px] text-amber-600 mt-4 pt-2 border-t border-slate-100 text-center">
                                    연결 설정 완료 후 자동 수신을 켤 수 있습니다.
                                </p>
                            )}
                        </section>

                        {/* S6. 수동 동기화 */}
                        <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <RefreshCw size={18} className="text-sky-600" />
                                    <h3 className="text-base font-bold text-slate-800">수동 동기화</h3>
                                </div>
                                <p className="text-xs text-slate-500 mb-4">
                                    스케줄러 주기와 무관하게 즉시 1회 수신 사이클을 실행합니다.
                                </p>

                                <button
                                    type="button"
                                    onClick={handleManualSync}
                                    disabled={isOffline || isManualSyncing || isUnconfigured}
                                    className="w-full py-2.5 px-3 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shadow-sm"
                                >
                                    {isManualSyncing ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            수동 동기화 진행 중 (폴링 중)...
                                        </>
                                    ) : (
                                        <>
                                            <Play size={14} />
                                            지금 동기화 실행
                                        </>
                                    )}
                                </button>

                                {isUnconfigured && (
                                    <p className="text-[11px] text-amber-600 mt-2 text-center">
                                        연결 설정 완료 후 동기화할 수 있습니다.
                                    </p>
                                )}

                                {/* 잡 실행 결과 표시 */}
                                {syncJobResult && (
                                    <div
                                        className={`mt-4 p-3 rounded-lg border text-xs space-y-1.5 ${syncJobResult.status === 'completed'
                                                ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
                                                : 'bg-rose-50/80 border-rose-200 text-rose-950'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between font-bold">
                                            <span>
                                                {syncJobResult.status === 'completed' ? '동기화 완료' : '동기화 실패'}
                                            </span>
                                            <span className="text-[10px] font-mono text-slate-500">
                                                ID: {syncJobResult.jobId}
                                            </span>
                                        </div>

                                        {syncJobResult.summary && (
                                            <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-700 pt-1 border-t border-slate-200/50">
                                                <span>받은 건수: {syncJobResult.summary.received ?? 0}건</span>
                                                <span>저장 건수: {syncJobResult.summary.stored ?? 0}건</span>
                                                <span>중복 스킵: {syncJobResult.summary.duplicates ?? 0}건</span>
                                                <span>격리/오류: {(syncJobResult.summary.quarantined ?? 0) + (syncJobResult.summary.failed ?? 0)}건</span>
                                            </div>
                                        )}

                                        {syncJobResult.error && (
                                            <p className="text-[11px] text-rose-700 font-medium pt-1">
                                                사유: {syncJobResult.error}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {syncError && (
                                    <div className="mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                                        <p className="font-bold">동기화 요청 실패</p>
                                        <p className="mt-0.5">{syncError}</p>
                                    </div>
                                )}
                            </div>

                            <p className="text-[11px] text-slate-400 mt-4 pt-2 border-t border-slate-100">
                                속도 제한: 전역 10초 간격 / 관리자당 분당 최대 2회
                            </p>
                        </section>
                    </div>

                    {/* ======================================================== */}
                    {/* S7. 수신 이력 및 격리 오류 관리 */}
                    {/* ======================================================== */}
                    <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h3 className="text-base font-bold text-slate-800">수신 이력 및 오류 내역</h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    최근 동기화 사이클 요약과 검증 오류로 격리된 항목을 확인하고 수동 재처리할 수 있습니다. (개인정보 미표시)
                                </p>
                            </div>
                            <span className="text-xs text-slate-500 font-medium">
                                총 {historyTotal}건의 사이클 이력
                            </span>
                        </div>

                        {retryMessage && (
                            <div
                                className={`p-3 rounded-lg text-xs font-medium flex items-center justify-between ${retryMessage.type === 'success'
                                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                        : 'bg-rose-50 text-rose-800 border border-rose-200'
                                    }`}
                            >
                                <span>{retryMessage.text}</span>
                                <button
                                    onClick={() => setRetryMessage(null)}
                                    className="text-xs underline ml-2 opacity-75 hover:opacity-100"
                                >
                                    닫기
                                </button>
                            </div>
                        )}

                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                            <table className="w-full text-left text-xs">
                                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                                    <tr>
                                        <th className="py-2.5 px-3">시각</th>
                                        <th className="py-2.5 px-3">종류</th>
                                        <th className="py-2.5 px-3">결과</th>
                                        <th className="py-2.5 px-3 text-right">받은 건수</th>
                                        <th className="py-2.5 px-3 text-right">중복 스킵</th>
                                        <th className="py-2.5 px-3">오류 / 중단 사유</th>
                                        <th className="py-2.5 px-3 text-center">격리 항목 및 재처리</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {historyItems.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="py-8 text-center text-slate-400">
                                                {isLoadingHistory ? '이력을 불러오는 중...' : '동기화 이력이 없습니다.'}
                                            </td>
                                        </tr>
                                    ) : (
                                        historyItems.map((item, idx) => {
                                            const hasQuarantined = item.quarantinedDetails && item.quarantinedDetails.length > 0;
                                            const errorDisplay = item.lastErrorCode ||
                                                item.stopReason ||
                                                (item.errors && Object.keys(item.errors).length > 0
                                                    ? Object.entries(item.errors).map(([k, v]) => `${k}(${v})`).join(', ')
                                                    : '-');

                                            return (
                                                <tr key={item.cycleId || idx} className="hover:bg-slate-50/80 transition-colors">
                                                    <td className="py-2.5 px-3 whitespace-nowrap text-slate-700 font-medium">
                                                        {formatDateTime(item.startedAt)}
                                                    </td>
                                                    <td className="py-2.5 px-3 whitespace-nowrap">
                                                        <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                                                            {item.trigger === 'scheduled'
                                                                ? '자동(예약)'
                                                                : item.trigger === 'manual'
                                                                    ? '수동'
                                                                    : item.trigger === 'retry'
                                                                        ? '재시도'
                                                                        : item.trigger}
                                                        </span>
                                                    </td>
                                                    <td className="py-2.5 px-3 whitespace-nowrap">
                                                        <span
                                                            className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${item.status === 'success'
                                                                    ? 'bg-emerald-100 text-emerald-800'
                                                                    : 'bg-rose-100 text-rose-800'
                                                                }`}
                                                        >
                                                            {item.status === 'success' ? '성공' : '실패'}
                                                        </span>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-medium text-slate-800">
                                                        {item.received ?? 0}건
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right text-slate-500">
                                                        {item.duplicates ?? 0}건
                                                    </td>
                                                    <td className="py-2.5 px-3 text-slate-600 max-w-[200px] truncate" title={errorDisplay}>
                                                        {errorDisplay !== '-' ? (
                                                            <span className="text-rose-600 font-medium">{errorDisplay}</span>
                                                        ) : (
                                                            <span className="text-slate-400">-</span>
                                                        )}
                                                    </td>
                                                    <td className="py-2.5 px-3 text-center">
                                                        {hasQuarantined ? (
                                                            <div className="flex flex-col gap-1 items-center">
                                                                {item.quarantinedDetails.map((detail, dIdx) => (
                                                                    <div key={dIdx} className="flex items-center gap-1.5 text-[11px]">
                                                                        <span className="font-mono text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded" title={detail.reason}>
                                                                            {detail.externalId}
                                                                        </span>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleRetryQuarantinedItem(detail.externalId)}
                                                                            disabled={isOffline || retryingExternalId === detail.externalId}
                                                                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500 hover:bg-amber-600 text-white rounded text-[11px] font-bold disabled:opacity-50 transition-colors"
                                                                            title={`사유: ${detail.reason}`}
                                                                        >
                                                                            {retryingExternalId === detail.externalId ? (
                                                                                <Loader2 size={10} className="animate-spin" />
                                                                            ) : (
                                                                                <RotateCcw size={10} />
                                                                            )}
                                                                            재처리
                                                                        </button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <span className="text-slate-300">-</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* 더 보기 버튼 */}
                        {historyTotal > historyItems.length && (
                            <div className="text-center pt-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const nextLimit = historyLimit + 50;
                                        setHistoryLimit(nextLimit);
                                        fetchHistory(nextLimit);
                                    }}
                                    disabled={isLoadingHistory || isOffline}
                                    className="px-4 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                                >
                                    {isLoadingHistory ? <Loader2 size={12} className="animate-spin" /> : null}
                                    이력 더 보기 ({historyItems.length} / {historyTotal})
                                </button>
                            </div>
                        )}
                    </section>
                </div>
            )}
        </PageContainer>
    );
};

export default ExternalApiAdminPage;

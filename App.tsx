import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { User, Referral, SuicideAttempterReferral, Log, Team, Page, Note, Attachment, AnyLog } from './types';
import { initialUsers, initialReferrals, initialSuicideAttempterReferrals, ALL_TEAMS, TEAM_CODES, PAGES_CONFIG, ICHEON_REGIONS, MAIN_TEAMS } from './constants';
import { apiClient } from './services/apiClient';
import { safeLocalStorage, safeSessionStorage } from './utils/safeLocalStorage';
import LoginScreen from './components/auth/LoginScreen';
import Sidebar from './components/layout/Sidebar';
import ReferralDashboardV2 from './components/referrals/ReferralDashboardV2';

// ...

import SuicideAttemptersPage from './components/suicideAttempters/SuicideAttemptersPage';
import CaseAnalysisSystem from './components/caseAnalysis/CaseAnalysisSystem';
import DataManagementPage from './components/data/DataManagementPage';
import ReportsPage from './components/reports/ReportsPage';
import AccountsPage from './components/accounts/AccountsPage';

import { BudgetPage } from './components/budget/BudgetPage';
import { AgentChat } from './components/agent/AgentChat';
import InactivityTimer from './components/auth/InactivityTimer';
import Toast from './components/common/Toast';
import AntiGravityDashboard from './components/antigravity/AntiGravityDashboard';
import HomePage from './components/home/HomePage';
import { CallAutomationPage } from './components/calls/CallAutomationPage';
import { SurveyManagementPage } from './components/survey/SurveyManagementPage';
// import OfficialDocumentPage from './components/officialDocuments/OfficialDocumentPage';

declare var _: any;

// --- Error Boundary Component ---
interface ErrorBoundaryProps {
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error: any) { return { hasError: true, error }; }
    componentDidCatch(error: any, errorInfo: any) { console.error("Global React Error:", error, errorInfo); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center h-screen bg-red-50 p-10 text-center">
                    <h1 className="text-2xl font-bold text-red-600 mb-4">애플리케이션 오류 발생</h1>
                    <pre className="bg-white p-4 rounded-xl border border-red-200 text-left text-xs overflow-auto max-w-2xl">
                        {this.state.error?.toString()}
                    </pre>
                    <button onClick={() => window.location.reload()} className="mt-6 px-6 py-2 bg-red-600 text-white rounded-xl font-bold">새로고침</button>
                </div>
            );
        }
        return this.props.children;
    }
}

function App() {
    const [currentUser, setCurrentUser] = useState<User | null>(() => {
        try {
            const savedUser = safeSessionStorage.getItem('currentUser');
            return savedUser ? JSON.parse(savedUser) : null;
        } catch (e) {
            console.error("Failed to parse user from sessionStorage", e);
            return null;
        }
    });



    const [users, setUsers] = useState<User[]>([]);

    const [referrals, setReferrals] = useState<Referral[]>(() => { try { const saved = safeLocalStorage.getItem('referrals'); return saved ? JSON.parse(saved) : initialReferrals; } catch (e) { return initialReferrals; } });
    const [unregisteredCandidates, setUnregisteredCandidates] = useState<Referral[]>(() => { try { const saved = safeLocalStorage.getItem('unregisteredCandidates'); return saved ? JSON.parse(saved) : []; } catch (e) { return []; } });
    const [suicideAttempterReferrals, setSuicideAttempterReferrals] = useState<SuicideAttempterReferral[]>(() => { try { const saved = safeLocalStorage.getItem('suicideAttempterReferrals'); return saved ? JSON.parse(saved) : initialSuicideAttempterReferrals; } catch (e) { return initialSuicideAttempterReferrals; } });
    const [logs, setLogs] = useState<AnyLog[]>([]);

    const [isLoadingData, setIsLoadingData] = useState(true);
    const [isReferralsLoading, setIsReferralsLoading] = useState(true);

    const [activePage, setActivePage] = useState<Page>('home');
    const [selectedTeam, setSelectedTeam] = useState<Team | 'all'>('all');

    // 토스트 메시지 상태와 핸들러 추가
    const [toastMessage, setToastMessage] = useState('');
    const [isAgentOpen, setIsAgentOpen] = useState(false);
    // Pending transfer from 자살시도자 → 의뢰대장
    const [pendingTransfer, setPendingTransfer] = useState<Partial<Omit<Referral, 'refNo' | 'clientId'>> | null>(null);

    // [State Separation] Website referrals, voice AI calls, online surveys
    const [websiteReferralItems, setWebsiteReferralItems] = useState<any[]>([]);
    const [voicePendingCount, setVoicePendingCount] = useState<number>(0);
    const [surveyPendingCount, setSurveyPendingCount] = useState<number>(0);
    // ref로 referrals 최신값 유지 (폴링 의존성 배열에 referrals 포함 시 연쇄 재시작 방지)
    const referralsRef = useRef(referrals);
    useEffect(() => { referralsRef.current = referrals; }, [referrals]);

    // Route guard for direct URL / hash navigation to voice features
    useEffect(() => {
        const handleRouteCheck = () => {
            const path = window.location.pathname.toLowerCase();
            const hash = window.location.hash.toLowerCase();
            const isVoiceRoute = path.includes('/voice') || path.includes('/recording') || path.includes('/ai-analysis') || hash.includes('voice') || hash.includes('recording');
            if (isVoiceRoute) {
                const canAccess = currentUser && currentUser.status === 'active' && (
                    currentUser.role === 'admin' ||
                    (Array.isArray(currentUser.permissions)
                        ? (currentUser.permissions.includes('VOICE_RECORDING_AI_ACCESS') || currentUser.permissions.includes('voiceCalls'))
                        : Boolean((currentUser.permissions as any)?.VOICE_RECORDING_AI_ACCESS || (currentUser.permissions as any)?.voiceCalls))
                );
                if (canAccess) {
                    setActivePage('voiceCalls');
                } else {
                    setActivePage('home');
                    if (currentUser) {
                        showToast('음성 녹음 분석(AI) 화면에 접근할 권한이 없습니다.', 'error');
                    }
                }
            }
        };
        handleRouteCheck();
        window.addEventListener('popstate', handleRouteCheck);
        window.addEventListener('hashchange', handleRouteCheck);
        return () => {
            window.removeEventListener('popstate', handleRouteCheck);
            window.removeEventListener('hashchange', handleRouteCheck);
        };
    }, [currentUser]);

    // Load data from Google Sheets on mount
    const [isOfflineFallback, setIsOfflineFallback] = useState(false);

    useEffect(() => {
        console.log("Frontend Version: 2.2.5 (Performance Optimized)");

        // Emergency Escape Hatch: If loading takes > 15 seconds, reveal cached UI and mark offline
        const escapeHatch = setTimeout(() => {
            setIsLoadingData(prev => {
                if (prev) {
                    console.warn("[App] Emergency Escape Hatch Triggered: Loading took > 15s. Switching to offline cache.");
                    setIsOfflineFallback(true);
                    return false;
                }
                return prev;
            });
        }, 15000);

        const loadData = async () => {
            try {
                if (apiClient.isAvailable()) {
                    // 1. Critical Data: Users (Required for Login)
                    console.log("Stage 1: Loading users...");
                    const loadedUsers = await apiClient.getUsers();
                    if (loadedUsers && Array.isArray(loadedUsers) && loadedUsers.length > 0) {
                        console.log(`Loaded ${loadedUsers.length} users.`);
                        setUsers(loadedUsers);
                    } else {
                        console.warn("No users found on server or invalid response, using local fallback.");
                        const saved = safeLocalStorage.getItem('users');
                        setUsers(saved ? JSON.parse(saved) : initialUsers);
                        setIsOfflineFallback(true);
                    }

                    // [Track A1] Verify and restore active session via HttpOnly cookie
                    try {
                        const meRes = await apiClient.getMe();
                        if (meRes && meRes.success && meRes.user) {
                            console.log('[Auth] Active session verified for user:', meRes.user.name);
                            setCurrentUser(meRes.user);
                            safeSessionStorage.setItem('currentUser', JSON.stringify(meRes.user));
                        } else {
                            safeSessionStorage.removeItem('currentUser');
                            setCurrentUser(null);
                        }
                    } catch (authErr) {
                        // Unauthenticated or expired session -> clear client cache
                        safeSessionStorage.removeItem('currentUser');
                        setCurrentUser(null);
                    }

                    setIsLoadingData(false); // Unblock UI!

                    // 2. High Priority: Referrals (화면 즉시 표시를 위해 최우선 비동기 로드)
                    console.log("Stage 2: Fetching referrals with top priority...");
                    apiClient.getReferrals().then(loadedReferrals => {
                        if (Array.isArray(loadedReferrals)) {
                            const referralsToSet = loadedReferrals.length > 0 ? loadedReferrals : initialReferrals;
                            setReferrals(referralsToSet);
                            safeLocalStorage.setItem('referrals', JSON.stringify(referralsToSet));
                            setIsOfflineFallback(false);
                            console.log(`[App] Server referrals (${referralsToSet.length} items) successfully synced.`);
                        } else if (loadedReferrals === null) {
                            setIsOfflineFallback(true);
                        }
                    }).catch(e => {
                        console.error("Referrals fetch failed", e);
                        setIsOfflineFallback(true);
                    }).finally(() => {
                        setIsReferralsLoading(false);
                    });

                    // 3. Background Data: Logs, SAs, Unregistered (독립적 병렬 로드 - 서로 블로킹 없음)
                    apiClient.getLogs().then(loadedLogs => {
                        if (Array.isArray(loadedLogs)) {
                            setLogs(loadedLogs);
                            safeLocalStorage.setItem('logs', JSON.stringify(loadedLogs));
                        }
                    }).catch(e => console.error("Logs fetch failed", e));

                    apiClient.getSuicideAttempters().then(loadedSAs => {
                        if (Array.isArray(loadedSAs)) {
                            const parseUid = (uid: string) => {
                                if (!uid) return { year: 0, num: 0 };
                                const parts = uid.split('-');
                                if (parts.length < 2) return { year: 0, num: 0 };
                                let year = parseInt(parts[0]);
                                if (year < 100) year += 2000;
                                const num = parseInt(parts[1]);
                                return { year, num };
                            };
                            const sortedSAs = [...loadedSAs].sort((a, b) => {
                                const valA = parseUid(a.uid || "");
                                const valB = parseUid(b.uid || "");
                                if (valB.year !== valA.year) return valB.year - valA.year;
                                return valB.num - valA.num;
                            });
                            setSuicideAttempterReferrals(sortedSAs.length > 0 ? sortedSAs : initialSuicideAttempterReferrals);
                        }
                    }).catch(e => console.error("SAs fetch failed", e));

                    apiClient.getUnregistered().then(loadedUnregistered => {
                        if (Array.isArray(loadedUnregistered)) setUnregisteredCandidates(loadedUnregistered);
                    }).catch(e => console.error("Unregistered fetch failed", e));

                    console.log("Stage 3: Background data pipelines initialized.");
                } else {
                    // Fallback to localStorage
                    const saved = safeLocalStorage.getItem('users');
                    setUsers(saved ? JSON.parse(saved) : initialUsers);
                    setIsLoadingData(false); // Unblock UI

                    const savedLogs = safeLocalStorage.getItem('logs');
                    setLogs(savedLogs ? JSON.parse(savedLogs) : []);
                    const savedRef = safeLocalStorage.getItem('referrals');
                    setReferrals(savedRef ? JSON.parse(savedRef) : initialReferrals);
                    const savedSA = safeLocalStorage.getItem('suicideAttempterReferrals');
                    if (savedSA) {
                        const parsedSAs = JSON.parse(savedSA);
                        const sortedSAs = [...parsedSAs].sort((a, b) => (b.uid || "").localeCompare(a.uid || ""));
                        setSuicideAttempterReferrals(sortedSAs);
                    } else {
                        setSuicideAttempterReferrals(initialSuicideAttempterReferrals);
                    }
                }
            } catch (error) {
                console.error('Error loading data:', error);
                // Fallback on error
                const saved = safeLocalStorage.getItem('users');
                setUsers(saved ? JSON.parse(saved) : initialUsers);
                setIsLoadingData(false); // Unblock UI

                const savedLogs = safeLocalStorage.getItem('logs');
                setLogs(savedLogs ? JSON.parse(savedLogs) : []);
                const savedRef = safeLocalStorage.getItem('referrals');
                setReferrals(savedRef ? JSON.parse(savedRef) : initialReferrals);
                const savedSA = safeLocalStorage.getItem('suicideAttempterReferrals');
                setSuicideAttempterReferrals(savedSA ? JSON.parse(savedSA) : initialSuicideAttempterReferrals);
            }
        };

        loadData().finally(() => {
            clearTimeout(escapeHatch);
        });

        return () => {
            clearTimeout(escapeHatch);
        };
    }, []); // Run exactly once on mount!

    // Periodic fetch for website referrals (notifications) with syncRequest integration
    useEffect(() => {
        const fetchPending = async () => {
            try {
                const rawData = await apiClient.getPendingReferrals();
                if (!Array.isArray(rawData)) {
                    setWebsiteReferralItems([]);
                    return;
                }

                // Strictly filter to website referrals and exclude scanner probes/spam/surveys/voice
                const data = rawData.filter(p => {
                    if (!p || typeof p !== 'object') return false;
                    // Strictly exclude online surveys
                    if (p.source === 'online_survey' || p.surveySubmissionId || p.submissionId || p.sourceSurveyId) return false;
                    if (p.referralPath === '온라인설문' || p.requestAgency === '온라인 자가검진') return false;
                    // Strictly exclude voice calls
                    if (p.source === 'voice_call' || p.voiceCallId || p.referralPath === '음성통화' || p.referralPath === '음성접수') return false;
                    // Filter out scanner probes / spam
                    if (/sparrow|dast|<script|alert\(/i.test(`${p.name} ${p.phone} ${p.problem} ${p.reason}`)) return false;
                    // Explicit website channel requirement (fail-closed, externalIdx alone is not sufficient)
                    const isExplicitWeb = p.source === 'website' || p.source === 'homepage' || p.source === 'web' ||
                        p.referralPath === '홈페이지' || p.referralPath === '홈페이지 의뢰' || p.referralPath === '홈페이지 상담신청' ||
                        p.requestAgency === '홈페이지' || p.isWebsiteReferral === true;
                    return isExplicitWeb;
                });

                // Stage 2: Parallel sync using syncRequest
                // referralsRef.current 사용 → referrals 변경 시 interval 재시작 없이 최신값 참조
                const syncResults = await Promise.all(data.map(async (pending) => {
                    try {
                        const syncResult = await apiClient.syncRequest(pending, referralsRef.current);
                        return { pending, alert: syncResult.alert };
                    } catch (syncErr) {
                        return { pending, alert: true };
                    }
                }));

                const alertItems = syncResults.filter(r => r.alert).map(r => r.pending);

                // [De-duplication] Merge by immutable ID or name + phone
                const uniqueMap = new Map();
                alertItems.forEach(item => {
                    const key = item.id || item.externalIdx || `${item.name}_${item.phone || ''}`;
                    if (!uniqueMap.has(key)) {
                        uniqueMap.set(key, item);
                    }
                });
                const finalData = Array.from(uniqueMap.values());

                setWebsiteReferralItems(finalData);
            } catch (err) {
                console.error("[App] Failed to periodic fetch pending website referrals", err);
            }
        };

        fetchPending();

        // Polling every 1 minute — 의존성 배열 [] 고정: 마운트 1회만 시작
        const interval = setInterval(fetchPending, 60_000);

        return () => {
            clearInterval(interval);
        };
    }, []); // [Fix] [] 고정: referrals 변경마다 interval 재시작하는 연쇄 트리거 차단

    // Periodic fetch for voice call stats (voicePendingCount)
    useEffect(() => {
        const fetchVoiceStats = async () => {
            try {
                const s = await apiClient.getVoiceCallStats();
                if (s && typeof s.pendingClassification === 'number') {
                    setVoicePendingCount(s.pendingClassification);
                }
            } catch (e) {
                // Ignore silent fetch failures
            }
        };
        fetchVoiceStats();
        const vInterval = setInterval(fetchVoiceStats, 30000);
        return () => clearInterval(vInterval);
    }, []);

    // Periodic fetch for online survey badge count (red menu badge)
    useEffect(() => {
        const fetchSurveyStats = async () => {
            try {
                const res = await fetch('/api/surveys/status', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    if (data && typeof data.badgeCount === 'number') {
                        setSurveyPendingCount(data.badgeCount);
                    } else if (data && typeof data.unassignedCount === 'number') {
                        setSurveyPendingCount(data.unassignedCount);
                    }
                }
            } catch (e) {
                // Ignore silent fetch failures
            }
        };
        fetchSurveyStats();
        const sInterval = setInterval(fetchSurveyStats, 30000);
        return () => clearInterval(sInterval);
    }, [currentUser]);

    // Notification effect when new website referrals arrive
    useEffect(() => {
        if (websiteReferralItems.length > 0) {
            const lastSeenCount = Number(safeSessionStorage.getItem('lastSeenPendingCount') || 0);
            if (websiteReferralItems.length > lastSeenCount) {
                setToastMessage(`📢 홈페이지에서 ${websiteReferralItems.length - lastSeenCount}건의 신규 의뢰가 접수되었습니다.`);
                safeSessionStorage.setItem('lastSeenPendingCount', String(websiteReferralItems.length));
            }
        } else {
            safeSessionStorage.setItem('lastSeenPendingCount', '0');
        }
    }, [websiteReferralItems.length]);

    // Keep localStorage as backup
    useEffect(() => { safeLocalStorage.setItem('referrals', JSON.stringify(referrals)); }, [referrals]);
    useEffect(() => { safeLocalStorage.setItem('suicideAttempterReferrals', JSON.stringify(suicideAttempterReferrals)); }, [suicideAttempterReferrals]);

    // 토스트 메시지를 표시하는 함수
    const showToast = useCallback((message: string) => {
        setToastMessage(message);
    }, []);

    const handleToastClose = useCallback(() => {
        setToastMessage('');
    }, []);


    const handleLogin = async (user: User) => {
        safeSessionStorage.setItem('currentUser', JSON.stringify(user));
        setCurrentUser(user);
        setSelectedTeam('all'); // 로그인 시 전체팀 의뢰가 기본으로 한눈에 보이도록 설정
        const newLog: Log = { logId: `log_${Date.now()}`, userId: user.id, loginTime: new Date().toLocaleString('ko-KR'), logoutTime: null };
        setLogs(prevLogs => [newLog, ...prevLogs]);

        // Save to Sheets
        if (apiClient.isAvailable()) {
            await apiClient.createLog(newLog);
        }
    };

    // 공통 로그아웃 로직
    const performLogout = useCallback(async () => {
        const updatedLogs = logs.map(log =>
            'userId' in log && log.userId === currentUser?.id && !log.logoutTime
                ? { ...log, logoutTime: new Date().toLocaleString('ko-KR') } as Log
                : log
        );

        setLogs(updatedLogs);

        // Update in Sheets
        if (apiClient.isAvailable()) {
            const logToUpdate = updatedLogs.find(log =>
                log.userId === currentUser?.id && log.logoutTime
            );
            if (logToUpdate) {
                await apiClient.updateLog(logToUpdate as Log);
            }
        }

        // [Track A1] Revoke server session cookie
        try {
            await apiClient.logout();
        } catch (logoutErr) {
            console.warn('[Auth] Server logout error:', logoutErr);
        }

        safeSessionStorage.removeItem('currentUser');
        setCurrentUser(null);
        setActivePage('referrals');
        showToast('로그아웃 되었습니다.');
    }, [currentUser, logs, showToast]);

    // 수동 로그아웃 핸들러
    const handleLogout = useCallback(() => {
        if (window.confirm('정말로 로그아웃 하시겠습니까?')) {
            performLogout();
        }
    }, [performLogout]);

    // 자동 로그아웃 핸들러
    const handleAutoLogout = useCallback(() => {
        performLogout();
    }, [performLogout]);

    const sortedTeamTabs = useMemo(() => {
        if (!currentUser || !currentUser.team) return ALL_TEAMS;
        const userTeam = currentUser.team;
        return [userTeam, ...ALL_TEAMS.filter(t => t !== userTeam)];
    }, [currentUser]);

    const handleAddNewReferral = useCallback(async (newReferral: Omit<Referral, 'refNo' | 'clientId'>): Promise<Referral> => {
        if (isOfflineFallback) {
            const msg = '현재 오프라인 캐시 모드이므로 신규 저장이 제한됩니다. 백엔드 서버(Port 8889) 상태를 확인해주세요.';
            showToast(msg);
            throw new Error(msg);
        }

        try {
            // Send creation request to server; Server assigns refNo and referralId atomically
            const res = await apiClient.createReferral(newReferral);
            if (!res || !res.success || !res.data) {
                throw new Error('서버 저장 응답에 실패했습니다.');
            }

            const savedReferral: Referral = res.data;
            showToast(`의뢰가 등록되었습니다. [${savedReferral.refNo}]`);

            // Deletion logic for imported external referrals
            const externalId = (newReferral as any).externalIdx || (newReferral as any).id;
            if (externalId && String(externalId).startsWith('ext_')) {
                try {
                    await fetch(`/api/pending-referrals/${externalId}`, { method: 'DELETE' });
                    setWebsiteReferralItems(prev => prev.filter(p => p.id !== externalId));
                } catch (delErr) {
                    console.error("Cleanup of pending referral failed:", delErr);
                }
            }

            // Survey referral link completion logic
            if ((savedReferral as any).sourceSubmissionId || (savedReferral as any).sourceSurveyId) {
                setSurveyPendingCount(prev => Math.max(0, prev - 1));
            }

            // Update UI state ONLY AFTER confirmed persistent write
            setReferrals(prev => [savedReferral, ...prev]);
            return savedReferral;
        } catch (error: any) {
            console.error('Save error:', error);
            const errMsg = error?.message || '저장에 실패했습니다.';
            showToast(errMsg);
            throw error; // Re-throw so modal/form remains open with error state
        }
    }, [isOfflineFallback, showToast]);

    const handleUpdateReferral = useCallback(async (updatedReferral: Referral, originalRefNo?: string) => {
        if (isOfflineFallback) {
            const msg = '현재 오프라인 캐시 모드이므로 수정이 제한됩니다.';
            showToast(msg);
            throw new Error(msg);
        }

        try {
            if (originalRefNo && originalRefNo !== updatedReferral.refNo) {
                // ID Change Logic
                const createRes = await apiClient.createReferral(updatedReferral);
                const saved = createRes.data || updatedReferral;
                await apiClient.deleteReferral(originalRefNo);
                showToast('의뢰번호가 성공적으로 변경되었습니다.');

                setReferrals(prev => {
                    const others = prev.filter(r => r.refNo !== originalRefNo && (!r.referralId || r.referralId !== updatedReferral.referralId));
                    return [saved, ...others];
                });
                return saved;
            } else {
                // Normal Update with OCC
                const updateRes = await apiClient.updateReferral(updatedReferral);
                const saved = updateRes.data || updatedReferral;
                showToast('의뢰가 수정되었습니다.');

                setReferrals(prev => prev.map(r => {
                    const matchById = saved.referralId && r.referralId && r.referralId === saved.referralId;
                    const matchByRefNo = r.refNo === saved.refNo;
                    return (matchById || matchByRefNo) ? saved : r;
                }));
                return saved;
            }
        } catch (error: any) {
            console.error('Update error:', error);
            const errMsg = error?.code === 'VERSION_CONFLICT'
                ? '다른 사용자가 이미 의뢰를 수정했습니다. 화면을 새로고침하여 최신 정보를 확인해주세요.'
                : (error?.message || '수정에 실패했습니다.');
            showToast(errMsg);
            throw error;
        }
    }, [isOfflineFallback, showToast]);

    const handleDeleteReferral = useCallback(async (refNoOrId: string) => {
        if (isOfflineFallback) {
            showToast('현재 오프라인 캐시 모드이므로 삭제가 제한됩니다.');
            return;
        }

        if (window.confirm('정말로 이 의뢰를 삭제하시겠습니까?')) {
            try {
                await apiClient.deleteReferral(refNoOrId);
                setReferrals(prev => prev.filter(r => r.referralId !== refNoOrId && r.refNo !== refNoOrId && r.clientId !== refNoOrId));
                showToast('의뢰가 삭제되었습니다.');
            } catch (error: any) {
                console.error('Delete error:', error);
                showToast(`삭제 실패: ${error?.message || error}`);
            }
        }
    }, [isOfflineFallback, showToast]);

    const handleAddNewSAReferral = useCallback(async (newReferral: SuicideAttempterReferral): Promise<SuicideAttempterReferral> => {
        try {
            // [v5.11 ID UNIFICATION] Send all possible ID variants to ensure compatibility
            const idValue = String(newReferral.uid || '');
            const sanitizedReferral = {
                ...newReferral,
                // Unified IDs
                uid: idValue,
                refNo: idValue,
                id: idValue,

                // Explicit string force
                name: String(newReferral.name || ''),
                age: Number(newReferral.age || 0),
                gender: String(newReferral.gender || ''),
                receiptDate: String(newReferral.receiptDate || ''),

                // Ensure other fields are at least empty strings
                sn: String(newReferral.sn || ''),
                birthDate: String(newReferral.birthDate || ''),
                phoneNumber: String(newReferral.phoneNumber || ''),
                region: String(newReferral.region || ''),
                requestAgency: String(newReferral.requestAgency || ''),
                pic: String(newReferral.pic || ''),

                // Restore Notes & Attachments
                notes: newReferral.notes || [],
                attachments: (newReferral.attachments || []).map(att => {
                    const { content, data, ...rest } = att as any;
                    return rest;
                })
            };

            const payloadStr = JSON.stringify(sanitizedReferral);
            console.log(`🚀 [App] Final Payload Size: ${payloadStr.length} bytes`);
            console.log('🚀 [App] Data:', sanitizedReferral);

            if (apiClient.isAvailable()) {
                // 1. Primary Action: Create the record
                await apiClient.createSuicideAttempter(sanitizedReferral);

                // 2. Secondary Action: Log activity (Don't let this fail the whole UI flow)
                try {
                    await apiClient.logActivity(currentUser?.name || 'Unknown', '자살시도자 등록', `신규 등록: ${newReferral.name}`);
                } catch (logError) {
                    console.warn('⚠️ [App] Activity logging failed (non-critical):', logError);
                }
            }

            setSuicideAttempterReferrals(prev => [newReferral, ...prev]);
            showToast('신규 자살시도자가 등록되었습니다.');
            return newReferral;
        } catch (error) {
            console.error('[App] handleAddNewSAReferral error:', error);
            showToast(`등록 실패: ${error instanceof Error ? error.message : '서버 오류'}`);
            throw error; // Re-throw to keep modal open
        }
    }, [currentUser, showToast]);

    const mapWebsiteReferralToInitialForm = useCallback((item: any): Partial<Omit<Referral, 'refNo' | 'clientId'>> => {
        if (!item || typeof item !== 'object') return {};

        // If already registered, pass through targetReferralId
        if (item.targetReferralId || item.refNo || (item.source === 'registered' && item.referralId)) {
            return { targetReferralId: item.targetReferralId || item.refNo || item.referralId } as any;
        }

        const cleanStr = (val: any): string => {
            if (val === undefined || val === null) return '';
            const s = String(val).trim();
            if (s === 'undefined' || s === 'null' || s === '미상') return '';
            return s;
        };

        const validGender = (item.gender === '남성' || item.gender === '여성' || item.gender === '기타') ? item.gender : undefined;

        let validAge: number | undefined = undefined;
        if (typeof item.age === 'number' && !isNaN(item.age) && item.age > 0) {
            validAge = item.age;
        } else if (item.age) {
            const parsed = parseInt(String(item.age).replace(/[^0-9]/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0 && parsed <= 130) {
                validAge = parsed;
            }
        }

        let receiptDate = '';
        const rawDate = item.externalReceivedAt || item.registrationDate || item.createdAt || '';
        if (rawDate) {
            const dateMatch = String(rawDate).match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
                receiptDate = dateMatch[1];
            }
        }

        const stableId = cleanStr(item.id || item.externalIdx);

        return {
            id: stableId,
            externalIdx: cleanStr(item.externalIdx || item.id),
            externalReferralId: cleanStr(item.externalReferralId || (item.externalIdx ? item.externalIdx.replace(/^ext_/, '') : (item.id ? String(item.id).replace(/^ext_/, '') : ''))),
            name: cleanStr(item.name),
            phone: cleanStr(item.phone),
            ...(validGender ? { gender: validGender } : {}),
            ...(validAge !== undefined ? { age: validAge } : {}),
            birthDate: cleanStr(item.birthDate),
            address: cleanStr(item.address),
            region: cleanStr(item.region),
            agency: cleanStr(item.agency || item.requestAgency),
            requestAgency: cleanStr(item.agency || item.requestAgency),
            requesterName: cleanStr(item.requesterName || item.requestorName),
            requestorName: cleanStr(item.requesterName || item.requestorName),
            requesterPhone: cleanStr(item.requesterPhone || item.agencyPhone),
            problem: cleanStr(item.problem),
            reason: cleanStr(item.reason),
            requestDate: receiptDate,
            referralPath: cleanStr(item.referralPath) || '홈페이지',
            isWebsiteReferral: true,
            source: 'website'
        };
    }, []);

    const handleInitialFormConsumed = useCallback(() => {
        console.log("[App] Multi-Step Transfer: initialFormData consumed.");
        setPendingTransfer(null);
    }, []);

    const handleTransferToReferral = useCallback((sa: SuicideAttempterReferral) => {
        console.log("[App] Multi-Step Transfer: Initiating for", sa.name);
        const today = new Date().toISOString().split('T')[0];

        // 마지막 노트(최신 상담이력)만 이전: 모든 중간 편집본 제외
        let combinedNoteContent = `[자살시도자 이력 이전]\n접수일: ${sa.receiptDate || '미상'} | 의뢰기관: ${sa.requestAgency || '미상'} | 담당자: ${sa.pic || '미상'}`;
        if (sa.notes && sa.notes.length > 0) {
            // 마지막 노트만 사용 (중복·중간 편집본 제외)
            const lastNote = sa.notes[sa.notes.length - 1];
            if (lastNote.content?.trim()) {
                combinedNoteContent += `\n\n[상담이력 (최종본)]\n${lastNote.content.trim()}`;
            }
        }


        const transferData: Partial<Omit<Referral, 'refNo' | 'clientId'>> = {
            name: sa.name,
            phone: sa.phoneNumber || '',
            gender: (sa.gender === '남성' || sa.gender === '여성' || sa.gender === '기타') ? sa.gender : '기타',
            age: sa.age || 0,
            requestDate: today,
            requestAgency: sa.requestAgency || '',
            region: sa.region || '',
            assignee: sa.assignee || '',
            team: currentUser?.team || '증진팀',
            closureStatus: '미종결',
            criLevel: 'c',
            referralPath: '직접의뢰',
            reply: false,
            attachments: [],
            // 모든 이전 이력을 단 하나의 노트로 요약
            notes: [{
                id: `trans_${Date.now()}`,
                content: combinedNoteContent,
                author: currentUser?.name || '시스템',
                createdAt: today
            }]
        };
        setPendingTransfer(transferData);
        setActivePage('referrals');
        showToast(`${sa.name}님의 정보를 의뢰대장으로 이동합니다.`);
    }, [currentUser, showToast]);

    const handleUpdateSAReferral = useCallback(async (updatedReferral: SuicideAttempterReferral) => {
        // 1. Optimistic UI Update (Instant response)
        setSuicideAttempterReferrals(prev => prev.map(r => r.uid === updatedReferral.uid ? updatedReferral : r));

        // 2. Background Sync to Sheets
        if (apiClient.isAvailable()) {
            try {
                const sanitizedReferral = {
                    ...updatedReferral,
                    attachments: updatedReferral.attachments?.map(att => {
                        const { content, data, ...rest } = att as any;
                        return rest;
                    }) || []
                };
                await apiClient.updateSuicideAttempter(sanitizedReferral);
                await apiClient.logActivity(currentUser?.name || 'Unknown', '자살시도자 수정', `정보 수정: ${updatedReferral.name} (${updatedReferral.uid})`);
            } catch (error) {
                console.error('Update background error:', error);
                // In a production app, we might want to roll back or notify the user
            }
        }
    }, [currentUser]);

    const handleDeleteSAReferral = useCallback(async (uid: string) => {
        if (window.confirm('정말로 이 정보를 삭제하시겠습니까?')) {
            try {
                // Updated to use SheetsService instead of Supabase
                if (apiClient.isAvailable()) {
                    await apiClient.deleteSuicideAttempter(uid);
                }
                setSuicideAttempterReferrals(prev => prev.filter(r => r.uid !== uid));
                showToast('자살시도자 정보가 삭제되었습니다.');
            } catch (error) {
                console.error('Delete error:', error);
                showToast(`삭제 실패: ${error}`);
            }
        }
    }, [showToast]);

    if (isLoadingData) {
        return (
            <div className="flex items-center justify-center h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
                <div className="text-center">
                    <div className="inline-block animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mb-4"></div>
                    <p className="text-xl font-bold text-slate-700">데이터 로딩 중...</p>
                    <p className="text-sm text-slate-500 mt-2">Google Sheets에서 데이터를 가져오고 있습니다</p>
                </div>
            </div>
        );
    }

    if (!currentUser) {
        return <LoginScreen onLogin={handleLogin} users={users} />;
    }

    const renderPage = () => {
        switch (activePage) {
            case 'home':
                return <HomePage
                    referrals={referrals}
                    suicideAttempters={suicideAttempterReferrals}
                    unregistered={unregisteredCandidates}
                    trashCount={0}
                    currentUser={currentUser}
                    users={users}
                    onNavigate={(page) => setActivePage(page as Page)}
                    onAddReferral={handleAddNewReferral as any}
                    onImportReferral={(pendingData) => {
                        const prefill = mapWebsiteReferralToInitialForm(pendingData);
                        setPendingTransfer(prefill);
                        setActivePage('referrals');
                    }}
                    websiteReferralItems={websiteReferralItems}
                    setWebsiteReferralItems={setWebsiteReferralItems}
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
                    showToast={showToast}
                />;
            case 'referrals':
                return <ReferralDashboardV2
                    allReferrals={referrals}
                    setAllReferrals={setReferrals}
                    unregisteredCandidates={unregisteredCandidates}
                    setUnregisteredCandidates={setUnregisteredCandidates}
                    currentUser={currentUser}
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
                    users={users}
                    onUpdateReferral={handleUpdateReferral}
                    onAddNewReferral={handleAddNewReferral}
                    initialFormData={pendingTransfer}
                    onInitialFormConsumed={handleInitialFormConsumed}
                    isLoading={isReferralsLoading}
                />;
            case 'suicideAttempters':
                return <SuicideAttemptersPage
                    allReferrals={suicideAttempterReferrals}
                    setAllReferrals={setSuicideAttempterReferrals}
                    onAddNewSAReferral={handleAddNewSAReferral}
                    onUpdateSAReferral={handleUpdateSAReferral}
                    onDeleteSAReferral={handleDeleteSAReferral}
                    currentUser={currentUser}
                    showToast={showToast}
                    users={users}
                    onTransferToReferral={handleTransferToReferral}
                />;
            case 'caseAnalysis':
                return <CaseAnalysisSystem currentUser={currentUser} />;
            case 'data':
                return <DataManagementPage
                    referrals={referrals}
                    suicideAttempterReferrals={suicideAttempterReferrals}
                    activePage={activePage}
                />;
            case 'reports':
                return <ReportsPage
                    referrals={referrals}
                    suicideAttempterReferrals={suicideAttempterReferrals}
                    sortedTeamTabs={sortedTeamTabs}
                    users={users}
                />;

            case 'budget':
                return <BudgetPage currentUser={currentUser} showToast={showToast} />;
            case 'voiceCalls': {
                const isVoiceAiPermitted = currentUser && currentUser.status === 'active' && (
                    currentUser.role === 'admin' ||
                    (Array.isArray(currentUser.permissions)
                        ? (currentUser.permissions.includes('VOICE_RECORDING_AI_ACCESS') || currentUser.permissions.includes('voiceCalls'))
                        : Boolean((currentUser.permissions as any)?.VOICE_RECORDING_AI_ACCESS || (currentUser.permissions as any)?.voiceCalls))
                );

                if (!isVoiceAiPermitted) {
                    setTimeout(() => {
                        showToast('음성 녹음 분석(AI) 기능에 접근할 권한이 없습니다.', 'error');
                        setActivePage('home');
                    }, 0);
                    return (
                        <div className="flex flex-col items-center justify-center h-full p-12 text-center bg-slate-50">
                            <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-2xl flex items-center justify-center mb-4 text-2xl font-bold">
                                403
                            </div>
                            <h2 className="text-xl font-bold text-slate-800 mb-2">접근 권한 제한</h2>
                            <p className="text-slate-500 text-sm mb-6">음성 녹음 분석(AI) 기능은 관리자 또는 승인된 사용자만 접근할 수 있습니다.</p>
                            <button
                                onClick={() => setActivePage('home')}
                                className="px-5 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-700"
                            >
                                홈으로 돌아가기
                            </button>
                        </div>
                    );
                }

                return <CallAutomationPage
                    currentUser={currentUser}
                    referrals={referrals}
                    onNavigateToReferrals={(initialData) => {
                        setPendingTransfer(initialData);
                        setActivePage('referrals');
                    }}
                    showToast={showToast}
                />;
            }
            case 'surveyManagement': {
                const isSurveyPermitted = currentUser && currentUser.status === 'active' && (
                    currentUser.role === 'admin' ||
                    (Array.isArray(currentUser.permissions)
                        ? currentUser.permissions.includes('ONLINE_SURVEY_ACCESS')
                        : Boolean((currentUser.permissions as any)?.ONLINE_SURVEY_ACCESS))
                );

                if (!isSurveyPermitted) {
                    setTimeout(() => {
                        showToast('온라인 설문 기능에 접근할 권한이 없습니다.', 'error');
                        setActivePage('home');
                    }, 0);
                    return (
                        <div className="flex flex-col items-center justify-center h-full p-12 text-center bg-slate-50">
                            <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-2xl flex items-center justify-center mb-4 text-2xl font-bold">
                                403
                            </div>
                            <h2 className="text-xl font-bold text-slate-800 mb-2">접근 권한 제한</h2>
                            <p className="text-slate-500 text-sm mb-6">온라인 설문 기능은 관리자 또는 승인된 사용자만 접근할 수 있습니다.</p>
                            <button
                                onClick={() => setActivePage('home')}
                                className="px-5 py-2.5 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-700"
                            >
                                홈으로 돌아가기
                            </button>
                        </div>
                    );
                }

                return <SurveyManagementPage
                    currentUser={currentUser}
                    onNavigateToReferrals={(initialData) => {
                        setPendingTransfer(initialData);
                        setActivePage('referrals');
                    }}
                    showToast={showToast}
                />;
            }
            case 'accounts':
                return <AccountsPage
                    users={users}
                    setUsers={setUsers}
                    logs={logs}
                    currentUser={currentUser}
                    onForceLogout={handleAutoLogout}
                    showToast={showToast}
                />;
            case 'antiGravity':
                return <AntiGravityDashboard />;
            // case 'officialDocuments':
            //     return <OfficialDocumentPage />;
            default:
                return <HomePage
                    referrals={referrals}
                    suicideAttempters={suicideAttempterReferrals}
                    unregistered={unregisteredCandidates}
                    trashCount={0}
                    currentUser={currentUser}
                    users={users}
                    onNavigate={(page) => setActivePage(page as Page)}
                    onAddReferral={handleAddNewReferral as any}
                    onImportReferral={(pendingData) => {
                        const prefill = mapWebsiteReferralToInitialForm(pendingData);
                        setPendingTransfer(prefill);
                        setActivePage('referrals');
                    }}
                    websiteReferralItems={websiteReferralItems}
                    setWebsiteReferralItems={setWebsiteReferralItems}
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
                    showToast={showToast}
                />;
        }
    };

    return (
        <ErrorBoundary>
            <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] bg-[#F2F2F7] text-slate-800 font-sans overflow-hidden">
                <InactivityTimer onLogout={handleAutoLogout} />
                <Sidebar
                    currentUser={currentUser}
                    activePage={activePage}
                    setActivePage={setActivePage}
                    onNavigateToReferral={(targetReferralId) => {
                        setPendingTransfer({ targetReferralId } as any);
                        setActivePage('referrals');
                    }}
                    onLogout={handleLogout}
                    onToggleAgent={() => setIsAgentOpen(prev => !prev)}
                    pendingCount={websiteReferralItems.length}
                    voicePendingCount={voicePendingCount}
                    surveyPendingCount={surveyPendingCount}
                />
                <main className="flex-1 flex flex-col min-w-0 min-h-0 relative overflow-hidden text-left">
                    {isOfflineFallback && (
                        <div className="bg-amber-500 text-white px-4 py-2 text-xs font-bold flex items-center justify-between shadow-md z-40">
                            <span className="flex items-center gap-2">
                                <span>⚠️</span>
                                <span>[오프라인 캐시 모드] 서버 응답이 지연되어 로컬에 캐시된 정보를 읽기 전용으로 표시하고 있습니다. 데이터 무결성을 위해 신규 저장/수정이 제한됩니다.</span>
                            </span>
                            <button
                                onClick={() => window.location.reload()}
                                className="bg-amber-600 hover:bg-amber-700 px-3 py-1 rounded-lg text-[11px] transition-colors"
                            >
                                서버 재연결 시도
                            </button>
                        </div>
                    )}
                    {renderPage()}
                </main>
                <AgentChat
                    isOpen={isAgentOpen}
                    onClose={() => setIsAgentOpen(false)}
                    currentUser={currentUser}
                    showToast={showToast}
                />
                <Toast message={toastMessage} onClose={handleToastClose} />
            </div>
        </ErrorBoundary>
    );
}

export default App;
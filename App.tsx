import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
// import OfficialDocumentPage from './components/officialDocuments/OfficialDocumentPage';

declare var _: any;

// --- Error Boundary Component ---
class ErrorBoundary extends (React.Component as any) {
    constructor(props: any) {
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

    const [activePage, setActivePage] = useState<Page>('home');
    const [selectedTeam, setSelectedTeam] = useState<Team | 'all'>('all');

    // 토스트 메시지 상태와 핸들러 추가
    const [toastMessage, setToastMessage] = useState('');
    const [isAgentOpen, setIsAgentOpen] = useState(false);
    // Pending transfer from 자살시도자 → 의뢰대장 
    const [pendingTransfer, setPendingTransfer] = useState<Partial<Omit<Referral, 'refNo' | 'clientId'>> | null>(null);

    // [New] Pending referrals for notification badge and inbox
    const [pendingReferrals, setPendingReferrals] = useState<any[]>([]);

    // Load data from Google Sheets on mount
    useEffect(() => {
        console.log("Frontend Version: 2.2.5 (Performance Optimized)");

        // Emergency Escape Hatch: If loading takes > 15 seconds, FORCE it to stop
        const escapeHatch = setTimeout(() => {
            setIsLoadingData(prev => {
                if (prev) {
                    console.warn("[App] Emergency Escape Hatch Triggered: Loading took > 15s. Forcing UI reveal.");
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
                    }
                    setIsLoadingData(false); // Unblock UI!

                    // 2. Background Data: Logs, Referrals, etc. (Heavy)
                    console.log("Stage 2: Fetching heavy data in background...");
                    const [loadedLogs, loadedReferrals, loadedSAs, loadedUnregistered] = await Promise.all([
                        apiClient.getLogs().catch(e => { console.error("Logs fetch failed", e); return []; }),
                        apiClient.getReferrals().catch(e => { console.error("Referrals fetch failed", e); return []; }),
                        apiClient.getSuicideAttempters().catch(e => { console.error("SAs fetch failed", e); return []; }),
                        apiClient.getUnregistered().catch(e => { console.error("Unregistered fetch failed", e); return []; })
                    ]);

                    if (Array.isArray(loadedLogs)) setLogs(loadedLogs);
                    if (Array.isArray(loadedReferrals)) setReferrals(loadedReferrals.length > 0 ? loadedReferrals : initialReferrals);
                    
                    if (Array.isArray(loadedSAs)) {
                        // Ultra-Robust Numeric Sorting: Handle mixed year formats perfectly
                        const parseUid = (uid: string) => {
                            if (!uid) return { year: 0, num: 0 };
                            const parts = uid.split('-');
                            if (parts.length < 2) return { year: 0, num: 0 };
                            let year = parseInt(parts[0]);
                            if (year < 100) year += 2000; // Handle "26" as 2026
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
                    } else {
                        setSuicideAttempterReferrals(initialSuicideAttempterReferrals);
                    }
                    if (Array.isArray(loadedUnregistered)) setUnregisteredCandidates(loadedUnregistered);

                    console.log("Stage 3: Background data load complete.");
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

    // Periodic fetch for pending referrals (notifications) with syncRequest integration
    useEffect(() => {
        const fetchPending = async () => {
            try {
                const data = await apiClient.getPendingReferrals();
                if (!Array.isArray(data)) {
                    setPendingReferrals([]);
                    return;
                }

                // Stage 2: Parallel sync using syncRequest
                const syncResults = await Promise.all(data.map(async (pending) => {
                    try {
                        const syncResult = await apiClient.syncRequest(pending, referrals);
                        return { pending, alert: syncResult.alert };
                    } catch (syncErr) {
                        console.error("[App] Sync failed for item:", pending.name || pending.id, syncErr);
                        return { pending, alert: true }; // Default to alert on error to avoid loss
                    }
                }));

                const alertItems = syncResults.filter(r => r.alert).map(r => r.pending);

                console.log(`[App] Periodic Referral Sync: ${data.length} found, ${alertItems.length} alerts triggered`);
                
                // [De-duplication] Merge by name + phone
                const uniqueMap = new Map();
                alertItems.forEach(item => {
                    const key = `${item.name}_${item.phone || ''}`;
                    if (!uniqueMap.has(key)) {
                        uniqueMap.set(key, item);
                    }
                });
                const finalData = Array.from(uniqueMap.values());
                
                setPendingReferrals(finalData);
            } catch (err) {
                console.error("[App] Failed to periodic fetch pending referrals", err);
            }
        };

        fetchPending();
        
        // Polling every 1 minute
        const interval = setInterval(fetchPending, 1 * 60 * 1000);
        
        return () => {
            clearInterval(interval);
        };
    }, [referrals]); // Only run when referrals change, perfectly safe since loadData is mount-isolated!

    // [New] Notification effect when new pending referrals arrive
    useEffect(() => {
        if (pendingReferrals.length > 0) {
            // Check if this is a fresh batch (comparing against previous count would be better, 
            // but for now, any non-zero state on this poller can trigger once if not already seen)
            const lastSeenCount = Number(safeSessionStorage.getItem('lastSeenPendingCount') || 0);
            if (pendingReferrals.length > lastSeenCount) {
                setToastMessage(`📢 홈페이지에서 ${pendingReferrals.length - lastSeenCount}건의 신규 의뢰가 접수되었습니다.`);
                safeSessionStorage.setItem('lastSeenPendingCount', String(pendingReferrals.length));
            }
        } else {
            safeSessionStorage.setItem('lastSeenPendingCount', '0');
        }
    }, [pendingReferrals.length]);

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
        setSelectedTeam(user.team || 'all');
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
        const teamCode = TEAM_CODES[newReferral.team] || 'ET';
        const now = new Date();
        const yearYY = now.getFullYear().toString().slice(-2); // "26"

        // Search for existing IDs with format: Code-YY-Seq (e.g. ET-26-001)
        // Or legacy format: CodeSeq (e.g. ET001) - We will ignore legacy for max calculation of new format if possible, or migrate? 
        // Strategy: Only look for patterns matching Current Year format to increment sequence.

        const currentYearPrefix = `${teamCode}-${yearYY}-`; // "ET-26-"

        // Filter referrals that match the current year's pattern
        const existingIds = referrals
            .map(r => r.refNo)
            .filter(refNo => refNo && refNo.startsWith(currentYearPrefix))
            .map(refNo => parseInt(refNo.split('-')[2], 10)) // Extract sequence
            .filter(num => !isNaN(num));

        const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
        const newRefNo = `${currentYearPrefix}${String(maxId + 1).padStart(3, '0')}`; // ET-26-001
        const finalReferral: Referral = {
            ...newReferral,
            refNo: newRefNo,
            clientId: `C${Date.now()}`,
        };

        // Create Referral
        try {
            await apiClient.createReferral(finalReferral);
            showToast('의뢰가 등록되었습니다.');

            // Deletion logic for imported external referrals (moved from HomePage)
            // This ensures data is ONLY removed after successful persistence in the main registry.
            const externalId = (newReferral as any).externalIdx || (newReferral as any).id;
            if (externalId && String(externalId).startsWith('ext_')) {
                try {
                    await fetch(`/api/pending-referrals/${externalId}`, { method: 'DELETE' });
                    setPendingReferrals(prev => prev.filter(p => p.id !== externalId));
                    console.log(`[App] Successfully deleted pending referral ${externalId} after registration.`);
                } catch (delErr) {
                    console.error("Cleanup of pending referral failed:", delErr);
                }
            }
        } catch (error) {
            console.error('Save error:', error);
            showToast('저장에 실패했습니다.');
        }

        setReferrals(prev => [finalReferral, ...prev]);
        return finalReferral;
    }, [referrals, showToast]);

    const handleUpdateReferral = useCallback(async (updatedReferral: Referral, originalRefNo?: string) => {
        try {
            if (originalRefNo && originalRefNo !== updatedReferral.refNo) {
                // ID Change Logic: Create New -> Delete Old
                await apiClient.createReferral(updatedReferral);
                await apiClient.deleteReferral(originalRefNo);
                showToast('의뢰번호가 성공적으로 변경되었습니다.');

                setReferrals(prev => {
                    const others = prev.filter(r => r.refNo !== originalRefNo);
                    return [...others, updatedReferral];
                });
                return;
            } else {
                // Normal Update
                await apiClient.updateReferral(updatedReferral);
                // Toast removed for smoother auto-save experience, or kept minimal
                // showToast('의뢰가 수정되었습니다.'); 
            }
        } catch (error) {
            console.error('Update error:', error);
            showToast('수정에 실패했습니다.');
            return;
        }

        setReferrals(prev => prev.map(r => r.refNo === updatedReferral.refNo ? updatedReferral : r));
    }, [showToast]);

    const handleDeleteReferral = useCallback(async (refNo: string) => {
        if (window.confirm('정말로 이 의뢰를 삭제하시겠습니까?')) {
            try {
                await apiClient.deleteReferral(refNo);
                setReferrals(prev => prev.filter(r => r.refNo !== refNo));
                showToast('의뢰가 삭제되었습니다.');
            } catch (error) {
                console.error('Delete error:', error);
                showToast(`삭제 실패: ${error}`);
            }
        }
    }, [showToast]);

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
                        setPendingTransfer(pendingData);
                        setActivePage('referrals');
                    }}
                    pendingReferrals={pendingReferrals}
                    setPendingReferrals={setPendingReferrals}
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
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
                return (currentUser.role === 'admin' || currentUser.role === 'manager') ? <CaseAnalysisSystem /> : null;
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
                        setPendingTransfer(pendingData);
                        setActivePage('referrals');
                    }}
                    pendingReferrals={pendingReferrals}
                    setPendingReferrals={setPendingReferrals}
                    selectedTeam={selectedTeam}
                    setSelectedTeam={setSelectedTeam}
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
                    onLogout={handleLogout}
                    onToggleAgent={() => setIsAgentOpen(prev => !prev)}
                    pendingCount={pendingReferrals.length}
                />
                <main className="flex-1 flex flex-col min-w-0 min-h-0 relative overflow-hidden text-left">
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
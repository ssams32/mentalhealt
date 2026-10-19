import React, { useState, useEffect, useMemo, useRef } from 'react';
import { VoiceCallItem, User, Referral, Team } from '../../types';
import { STAFF_LIST } from '../../constants';
import { apiClient } from '../../services/apiClient';
import { getTeams } from '../../services/orgConfig';
import {
    PhoneCall,
    Clock,
    Play,
    Pause,
    Volume2,
    RefreshCw,
    CheckCircle2,
    AlertCircle,
    Building2,
    UserCheck,
    FileSpreadsheet,
    Search,
    UserPlus,
    Link2,
    FolderSync,
    Layers,
    Sparkles,
    Calendar,
    Send,
    FileAudio,
    Tag,
    ChevronRight,
    X,
    Filter
} from 'lucide-react';

interface CallAutomationPageProps {
    currentUser: User;
    referrals: Referral[];
    users?: User[];
    onNavigateToReferrals?: (initialData?: any) => void;
    showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type TabType = 'all' | 'pending' | 'administrative' | 'individual' | 'intake' | 'completed';

export const CallAutomationPage: React.FC<CallAutomationPageProps> = ({
    currentUser,
    referrals,
    users: usersProp,
    onNavigateToReferrals,
    showToast
}) => {
    // State
    const [calls, setCalls] = useState<VoiceCallItem[]>([]);
    const [stats, setStats] = useState<any>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [syncing, setSyncing] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState<TabType>('pending');
    const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [departmentFilter, setDepartmentFilter] = useState<string>('all');
    const [assignmentFilter, setAssignmentFilter] = useState<string>('all');

    // Selected call inspection & editing state
    const [selectedCallNotes, setSelectedCallNotes] = useState<string>('');
    const [selectedCallCaller, setSelectedCallCaller] = useState<string>('');
    const [selectedCallClient, setSelectedCallClient] = useState<string>('');
    const [assignDept, setAssignDept] = useState<string>(() => getTeams()[0] || '');
    const [assignStaff, setAssignStaff] = useState<string>('');

    // Audio playback state
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [audioCurrentTime, setAudioCurrentTime] = useState<number>(0);
    const [audioDuration, setAudioDuration] = useState<number>(0);
    const [playbackRate, setPlaybackRate] = useState<number>(1.0);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Modal state for linking referral
    const [isLinkModalOpen, setIsLinkModalOpen] = useState<boolean>(false);
    const [referralSearchQuery, setReferralSearchQuery] = useState<string>('');

    // Load calls and stats
    const fetchCallsAndStats = async () => {
        try {
            setLoading(true);
            const [callRes, statsRes] = await Promise.all([
                apiClient.getVoiceCalls({
                    tab: activeTab,
                    search: searchQuery || undefined,
                    department: departmentFilter !== 'all' ? departmentFilter : undefined,
                    assignment: assignmentFilter !== 'all' ? assignmentFilter : undefined
                }),
                apiClient.getVoiceCallStats()
            ]);

            setCalls(callRes.calls || []);
            setStats(statsRes);

            // Auto-select first call if none selected
            if (callRes.calls && callRes.calls.length > 0) {
                if (!selectedCallId || !callRes.calls.some((c: VoiceCallItem) => c.id === selectedCallId)) {
                    selectCall(callRes.calls[0]);
                }
            } else {
                setSelectedCallId(null);
            }
        } catch (err: any) {
            console.error('Failed to load voice calls:', err);
            showToast?.('통화 목록을 불러오는 중 오류가 발생했습니다.', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCallsAndStats();
    }, [activeTab, departmentFilter, assignmentFilter]);

    // Select a call and initialize inspection states
    const selectCall = (call: VoiceCallItem) => {
        setSelectedCallId(call.id);
        setSelectedCallNotes(call.notes || '');
        setSelectedCallCaller(call.callerPhoneNumber || '');
        setSelectedCallClient(call.clientName || '');
        setAssignDept(call.assignedDepartmentId || getTeams()[0] || '');
        setAssignStaff(call.assignedUserName || '');
        setIsPlaying(false);
        setAudioCurrentTime(0);

        if (audioRef.current) {
            audioRef.current.currentTime = 0;
        }
    };

    const selectedCall = useMemo(() => {
        return calls.find(c => c.id === selectedCallId) || null;
    }, [calls, selectedCallId]);

    // Trigger NAS JoyCall Sync
    const handleSync = async () => {
        try {
            setSyncing(true);
            const res = await apiClient.syncVoiceCalls();
            showToast?.(res.message, 'success');
            await fetchCallsAndStats();
        } catch (err: any) {
            console.error('Sync failed:', err);
            showToast?.('동기화 실패: ' + err.message, 'error');
        } finally {
            setSyncing(false);
        }
    };

    // Seed test samples if no calls exist
    const handleSeedSamples = async () => {
        try {
            setLoading(true);
            const res = await apiClient.seedSampleVoiceCalls();
            showToast?.(res.message, 'success');
            await fetchCallsAndStats();
        } catch (err: any) {
            showToast?.('샘플 생성 실패: ' + err.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    // Handle Manual Classification (행정전화 / 개별상담 / 접수상담)
    const handleClassify = async (type: 'administrative_call' | 'individual_counseling' | 'intake_counseling') => {
        if (!selectedCall) return;
        try {
            const res = await apiClient.classifyVoiceCall(selectedCall.id, {
                callRecordType: type,
                notes: selectedCallNotes,
                callerPhoneNumber: selectedCallCaller,
                clientName: selectedCallClient
            });

            const typeLabel = 
                type === 'administrative_call' ? '행정전화' :
                type === 'individual_counseling' ? '개별상담' : '접수상담';

            showToast?.(`[${typeLabel}] 유형으로 분류되었습니다.`, 'success');
            await fetchCallsAndStats();
        } catch (err: any) {
            showToast?.('분류 처리 실패: ' + err.message, 'error');
        }
    };

    // Handle Staff Assignment
    const handleAssign = async () => {
        if (!selectedCall) return;
        try {
            await apiClient.assignVoiceCall(selectedCall.id, {
                assignedDepartmentId: assignDept,
                assignedUserName: assignStaff || undefined
            });
            showToast?.(`담당자가 [${assignDept} ${assignStaff || ''}]으로 배정되었습니다.`, 'success');
            await fetchCallsAndStats();
        } catch (err: any) {
            showToast?.('배정 실패: ' + err.message, 'error');
        }
    };

    // Handle Link to Referral
    const handleLinkToReferral = async (ref: Referral) => {
        if (!selectedCall) return;
        try {
            await apiClient.linkVoiceCall(selectedCall.id, {
                referralId: ref.referralId || ref.id,
                refNo: ref.refNo,
                clientId: ref.clientId,
                clientName: ref.name
            });
            showToast?.(`[${ref.name} / ${ref.refNo}] 의뢰와 연결되었습니다.`, 'success');
            setIsLinkModalOpen(false);
            await fetchCallsAndStats();
        } catch (err: any) {
            showToast?.('의뢰 연동 실패: ' + err.message, 'error');
        }
    };

    // Forward to new referral registration form
    const handleCreateNewReferralFromCall = () => {
        if (!selectedCall) return;
        const initialData = {
            name: selectedCall.clientName || '',
            contact: selectedCall.callerPhoneNumber || '',
            requestDate: selectedCall.receivedAt ? selectedCall.receivedAt.split('T')[0] : new Date().toISOString().split('T')[0],
            referralPath: '본인',
            notes: selectedCall.notes ? [{
                id: `note_call_${Date.now()}`,
                content: `[전화녹음 ${selectedCall.originalFileName}] ${selectedCall.notes}`,
                author: currentUser.name,
                timestamp: new Date().toISOString()
            }] : []
        };
        onNavigateToReferrals?.(initialData);
    };

    // Audio Playback Helpers
    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            audioRef.current.play().catch(e => console.error('Audio play error:', e));
            setIsPlaying(true);
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = Number(e.target.value);
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            setAudioCurrentTime(time);
        }
    };

    const handlePlaybackRateChange = (rate: number) => {
        setPlaybackRate(rate);
        if (audioRef.current) {
            audioRef.current.playbackRate = rate;
        }
    };

    const formatSeconds = (sec: number) => {
        if (isNaN(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const formatFileSize = (bytes: number) => {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    // Filter referrals for linking modal
    const filteredReferrals = useMemo(() => {
        if (!referralSearchQuery.trim()) return referrals.slice(0, 15);
        const q = referralSearchQuery.toLowerCase();
        return referrals.filter(r => 
            (r.name && r.name.toLowerCase().includes(q)) ||
            (r.refNo && r.refNo.toLowerCase().includes(q)) ||
            (r.contact && r.contact.includes(q))
        ).slice(0, 20);
    }, [referrals, referralSearchQuery]);

    // Available staff for selected team: 센터 계정(users) 우선, 폴백 STAFF_LIST
    const [fetchedUsers, setFetchedUsers] = useState<User[] | null>(null);
    useEffect(() => {
        if (!usersProp) {
            apiClient.getUsers().then(setFetchedUsers).catch(() => setFetchedUsers([]));
        }
    }, [usersProp]);
    const availableStaffList = useMemo(() => {
        const list = usersProp || fetchedUsers;
        if (list && list.length > 0) {
            return list
                .filter(u => u.status === 'active' && u.team === assignDept)
                .map(u => ({ name: u.name, team: u.team }));
        }
        return STAFF_LIST.filter(s => s.team === assignDept);
    }, [assignDept, usersProp, fetchedUsers]);

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
            {/* 1. Header & Quick Actions */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 shadow-sm">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="p-2 bg-violet-100 text-violet-700 rounded-lg">
                                <PhoneCall className="w-5 h-5" />
                            </div>
                            <h1 className="text-xl font-bold text-slate-800">상담 / 행정전화 관리</h1>
                            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-violet-50 text-violet-700 border border-violet-200">
                                JoyCall 연동
                            </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                            수신된 음성 통화 녹음을 청취하고, 행정전화 및 상담전화(개별·접수)로 분류하여 의뢰대장과 연계합니다.
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        {(!calls || calls.length === 0) && (
                            <button
                                onClick={handleSeedSamples}
                                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-300 rounded-lg hover:bg-amber-100 transition shadow-sm"
                            >
                                <Sparkles className="w-4 h-4" />
                                <span>테스트 샘플 생성</span>
                            </button>
                        )}
                        <button
                            onClick={handleSync}
                            disabled={syncing}
                            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 active:scale-95 transition shadow-sm disabled:opacity-50"
                        >
                            <FolderSync className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                            <span>{syncing ? '동기화 중...' : '조이콜 녹음 가져오기'}</span>
                        </button>
                        <button
                            onClick={fetchCallsAndStats}
                            disabled={loading}
                            className="p-2 text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
                            title="새로고침"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* 2. Metrics Bar */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
                    <div 
                        onClick={() => setActiveTab('all')}
                        className={`p-3 rounded-xl border transition cursor-pointer ${activeTab === 'all' ? 'bg-violet-50/70 border-violet-300 shadow-sm' : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/60'}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-slate-500">전체 수신</span>
                            <PhoneCall className="w-4 h-4 text-violet-500" />
                        </div>
                        <div className="text-xl font-bold text-slate-800 mt-1">{stats?.total || 0}건</div>
                    </div>

                    <div 
                        onClick={() => setActiveTab('pending')}
                        className={`p-3 rounded-xl border transition cursor-pointer ${activeTab === 'pending' ? 'bg-amber-50 border-amber-300 shadow-sm ring-1 ring-amber-400' : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/60'}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-amber-700">분류 대기</span>
                            <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                            </span>
                        </div>
                        <div className="text-xl font-extrabold text-amber-700 mt-1">{stats?.pendingClassification || 0}건</div>
                    </div>

                    <div 
                        onClick={() => setActiveTab('administrative')}
                        className={`p-3 rounded-xl border transition cursor-pointer ${activeTab === 'administrative' ? 'bg-blue-50 border-blue-300 shadow-sm' : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/60'}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-blue-600">행정전화</span>
                            <Building2 className="w-4 h-4 text-blue-500" />
                        </div>
                        <div className="text-xl font-bold text-blue-700 mt-1">{stats?.administrative || 0}건</div>
                    </div>

                    <div 
                        onClick={() => setActiveTab('individual')}
                        className={`p-3 rounded-xl border transition cursor-pointer ${activeTab === 'individual' ? 'bg-emerald-50 border-emerald-300 shadow-sm' : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/60'}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-emerald-600">개별상담</span>
                            <UserCheck className="w-4 h-4 text-emerald-500" />
                        </div>
                        <div className="text-xl font-bold text-emerald-700 mt-1">{stats?.individualCounseling || 0}건</div>
                    </div>

                    <div 
                        onClick={() => setActiveTab('intake')}
                        className={`p-3 rounded-xl border transition cursor-pointer ${activeTab === 'intake' ? 'bg-cyan-50 border-cyan-300 shadow-sm' : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/60'}`}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-cyan-600">접수상담</span>
                            <FileSpreadsheet className="w-4 h-4 text-cyan-500" />
                        </div>
                        <div className="text-xl font-bold text-cyan-700 mt-1">{stats?.intakeCounseling || 0}건</div>
                    </div>
                </div>

                {/* 3. Sub-Tabs & Filters */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mt-4 pt-3 border-t border-slate-100">
                    {/* Navigation Tabs */}
                    <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0">
                        <button
                            onClick={() => setActiveTab('pending')}
                            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition whitespace-nowrap ${activeTab === 'pending' ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            분류 대기 ({stats?.pendingClassification || 0})
                        </button>
                        <button
                            onClick={() => setActiveTab('all')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${activeTab === 'all' ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            전체 수신함
                        </button>
                        <button
                            onClick={() => setActiveTab('administrative')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${activeTab === 'administrative' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            행정전화 ({stats?.administrative || 0})
                        </button>
                        <button
                            onClick={() => setActiveTab('individual')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${activeTab === 'individual' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            개별상담 ({stats?.individualCounseling || 0})
                        </button>
                        <button
                            onClick={() => setActiveTab('intake')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${activeTab === 'intake' ? 'bg-cyan-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            접수상담 ({stats?.intakeCounseling || 0})
                        </button>
                        <button
                            onClick={() => setActiveTab('completed')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${activeTab === 'completed' ? 'bg-violet-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        >
                            처리 완료
                        </button>
                    </div>

                    {/* Search & Select Filters */}
                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && fetchCallsAndStats()}
                                placeholder="번호, 성명, 파일명..."
                                className="pl-8 pr-3 py-1.5 text-xs bg-slate-100 border border-slate-200 rounded-lg w-40 sm:w-48 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            />
                        </div>

                        <select
                            value={departmentFilter}
                            onChange={(e) => setDepartmentFilter(e.target.value)}
                            className="text-xs px-2 py-1.5 bg-slate-100 border border-slate-200 rounded-lg text-slate-700 focus:bg-white focus:outline-none"
                        >
                            <option value="all">전체 부서</option>
                            {getTeams().map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                </div>
            </div>

            {/* 4. Split Workspace (Left: Call List, Right: Inspector & Audio Player) */}
            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                {/* Left Panel: Call List */}
                <div className="lg:w-7/12 flex-1 flex flex-col border-r border-slate-200 bg-white overflow-hidden">
                    <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                        {loading && calls.length === 0 ? (
                            <div className="flex items-center justify-center h-48 text-slate-400 text-xs">
                                <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                                통화 녹음 데이터를 로딩 중입니다...
                            </div>
                        ) : calls.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-64 text-center p-6 text-slate-400">
                                <FileAudio className="w-12 h-12 text-slate-300 mb-2" />
                                <p className="text-sm font-medium text-slate-600">해당 조건의 통화 녹음이 없습니다.</p>
                                <p className="text-xs text-slate-400 mt-1">상단의 [조이콜 녹음 가져오기] 또는 [테스트 샘플 생성]을 눌러보세요.</p>
                            </div>
                        ) : (
                            calls.map((call) => {
                                const isSelected = call.id === selectedCallId;
                                const isUnclassified = !call.callRecordType || call.classificationStatus === 'pending';

                                return (
                                    <div
                                        key={call.id}
                                        onClick={() => selectCall(call)}
                                        className={`p-4 transition cursor-pointer hover:bg-slate-50 flex items-start justify-between gap-3 ${isSelected ? 'bg-violet-50/50 border-l-4 border-l-violet-600' : ''}`}
                                    >
                                        <div className="flex items-start gap-3 min-w-0">
                                            <div className={`p-2 rounded-lg mt-0.5 ${
                                                call.callRecordType === 'administrative_call' ? 'bg-blue-100 text-blue-700' :
                                                call.callRecordType === 'individual_counseling' ? 'bg-emerald-100 text-emerald-700' :
                                                call.callRecordType === 'intake_counseling' ? 'bg-cyan-100 text-cyan-700' :
                                                'bg-amber-100 text-amber-700'
                                            }`}>
                                                {call.callRecordType === 'administrative_call' ? (
                                                    <Building2 className="w-4 h-4" />
                                                ) : call.callRecordType === 'individual_counseling' ? (
                                                    <UserCheck className="w-4 h-4" />
                                                ) : call.callRecordType === 'intake_counseling' ? (
                                                    <FileSpreadsheet className="w-4 h-4" />
                                                ) : (
                                                    <AlertCircle className="w-4 h-4" />
                                                )}
                                            </div>

                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-semibold text-sm text-slate-800 truncate">
                                                        {call.clientName || call.callerPhoneNumber || call.originalFileName}
                                                    </span>

                                                    {/* Classification Badge */}
                                                    {isUnclassified ? (
                                                        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                                                            미분류
                                                        </span>
                                                    ) : call.callRecordType === 'administrative_call' ? (
                                                        <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700 border border-blue-200">
                                                            행정전화
                                                        </span>
                                                    ) : call.callRecordType === 'individual_counseling' ? (
                                                        <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                                                            개별상담
                                                        </span>
                                                    ) : (
                                                        <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-cyan-100 text-cyan-700 border border-cyan-200">
                                                            접수상담
                                                        </span>
                                                    )}

                                                    {/* Referral Linked Badge */}
                                                    {call.referralId && (
                                                        <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-purple-100 text-purple-700 border border-purple-200 flex items-center gap-1">
                                                            <Link2 className="w-3 h-3" />
                                                            <span>의뢰 연동</span>
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="text-xs text-slate-500 flex items-center gap-3 mt-1.5 flex-wrap">
                                                    <span className="flex items-center gap-1">
                                                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                                                        {call.receivedAt ? call.receivedAt.replace('T', ' ').substring(0, 16) : call.createdAt.substring(0, 10)}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                                                        {formatSeconds(call.durationSeconds || 0)}
                                                    </span>
                                                    <span>{formatFileSize(call.fileSize)}</span>
                                                    {call.assignedDepartmentId && (
                                                        <span className="text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">
                                                            {call.assignedDepartmentId} {call.assignedUserName ? `· ${call.assignedUserName}` : ''}
                                                        </span>
                                                    )}
                                                </div>

                                                {call.notes && (
                                                    <p className="text-xs text-slate-600 mt-1 line-clamp-1 italic bg-slate-50 p-1 rounded">
                                                        "{call.notes}"
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        <ChevronRight className="w-4 h-4 text-slate-300 self-center shrink-0" />
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Right Panel: Call Details, Audio Player, Classification & Actions */}
                <div className="lg:w-5/12 bg-slate-50 flex flex-col overflow-y-auto">
                    {selectedCall ? (
                        <div className="p-6 space-y-6">
                            {/* Audio Player Card */}
                            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                                            <FileAudio className="w-5 h-5" />
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-bold text-slate-800">통화 녹음 청취</h3>
                                            <p className="text-[11px] text-slate-400 font-mono">{selectedCall.originalFileName}</p>
                                        </div>
                                    </div>

                                    {/* Playback Rate */}
                                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                                        {[1.0, 1.25, 1.5].map((rate) => (
                                            <button
                                                key={rate}
                                                onClick={() => handlePlaybackRateChange(rate)}
                                                className={`px-2 py-0.5 text-[11px] font-bold rounded ${playbackRate === rate ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}
                                            >
                                                {rate}x
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* HTML5 Audio Element */}
                                <audio
                                    ref={audioRef}
                                    src={`/api/voice-calls/${selectedCall.id}/audio`}
                                    onTimeUpdate={() => audioRef.current && setAudioCurrentTime(audioRef.current.currentTime)}
                                    onLoadedMetadata={() => audioRef.current && setAudioDuration(audioRef.current.duration)}
                                    onEnded={() => setIsPlaying(false)}
                                    onError={(e) => console.log('Audio loading:', e)}
                                />

                                {/* Waveform/Progress Bar */}
                                <div className="space-y-1.5">
                                    <input
                                        type="range"
                                        min={0}
                                        max={audioDuration || selectedCall.durationSeconds || 100}
                                        value={audioCurrentTime}
                                        onChange={handleSeek}
                                        className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                                    />
                                    <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                                        <span>{formatSeconds(audioCurrentTime)}</span>
                                        <span>{formatSeconds(audioDuration || selectedCall.durationSeconds || 0)}</span>
                                    </div>
                                </div>

                                {/* Player Controls */}
                                <div className="flex items-center justify-center gap-4 pt-1">
                                    <button
                                        onClick={togglePlay}
                                        className="w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center shadow-md active:scale-95 transition"
                                    >
                                        {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                                    </button>
                                </div>
                            </div>

                            {/* Classification Actions Card */}
                            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                                    <div className="flex items-center gap-2">
                                        <Tag className="w-4 h-4 text-slate-500" />
                                        <h3 className="text-sm font-bold text-slate-800">통화 유형 수동 분류</h3>
                                    </div>
                                    <span className="text-[11px] text-slate-400">담당자 직접 선택</span>
                                </div>

                                <p className="text-xs text-slate-600">
                                    녹음 청취 후 해당 통화의 적절한 성격을 선택해 주십시오. (정책상 자동분류를 금지하고 담당자 수동 확인을 진행합니다)
                                </p>

                                <div className="grid grid-cols-3 gap-2.5">
                                    <button
                                        onClick={() => handleClassify('administrative_call')}
                                        className={`p-3 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                                            selectedCall.callRecordType === 'administrative_call'
                                                ? 'bg-blue-600 text-white border-blue-600 shadow-sm ring-2 ring-blue-200'
                                                : 'bg-white hover:bg-blue-50 text-slate-700 border-slate-200 hover:border-blue-200'
                                        }`}
                                    >
                                        <Building2 className="w-5 h-5" />
                                        <span className="text-xs font-bold">행정전화</span>
                                        <span className={`text-[10px] ${selectedCall.callRecordType === 'administrative_call' ? 'text-blue-100' : 'text-slate-400'}`}>
                                            단순문의/행정
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => handleClassify('individual_counseling')}
                                        className={`p-3 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                                            selectedCall.callRecordType === 'individual_counseling'
                                                ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm ring-2 ring-emerald-200'
                                                : 'bg-white hover:bg-emerald-50 text-slate-700 border-slate-200 hover:border-emerald-200'
                                        }`}
                                    >
                                        <UserCheck className="w-5 h-5" />
                                        <span className="text-xs font-bold">개별상담</span>
                                        <span className={`text-[10px] ${selectedCall.callRecordType === 'individual_counseling' ? 'text-emerald-100' : 'text-slate-400'}`}>
                                            사례관리 대상자
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => handleClassify('intake_counseling')}
                                        className={`p-3 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition active:scale-95 ${
                                            selectedCall.callRecordType === 'intake_counseling'
                                                ? 'bg-cyan-600 text-white border-cyan-600 shadow-sm ring-2 ring-cyan-200'
                                                : 'bg-white hover:bg-cyan-50 text-slate-700 border-slate-200 hover:border-cyan-200'
                                        }`}
                                    >
                                        <FileSpreadsheet className="w-5 h-5" />
                                        <span className="text-xs font-bold">접수상담</span>
                                        <span className={`text-[10px] ${selectedCall.callRecordType === 'intake_counseling' ? 'text-cyan-100' : 'text-slate-400'}`}>
                                            초기 의뢰/접수
                                        </span>
                                    </button>
                                </div>

                                {/* Caller & Client & Notes */}
                                <div className="space-y-3 pt-2">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <label className="text-[11px] font-semibold text-slate-600">발신번호</label>
                                            <input
                                                type="text"
                                                value={selectedCallCaller}
                                                onChange={(e) => setSelectedCallCaller(e.target.value)}
                                                placeholder="예: 010-1234-5678"
                                                className="w-full mt-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[11px] font-semibold text-slate-600">내담자/기관명</label>
                                            <input
                                                type="text"
                                                value={selectedCallClient}
                                                onChange={(e) => setSelectedCallClient(e.target.value)}
                                                placeholder="예: 홍길동 또는 기관명"
                                                className="w-full mt-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="text-[11px] font-semibold text-slate-600">통화 특이사항 / 메모</label>
                                        <textarea
                                            value={selectedCallNotes}
                                            onChange={(e) => setSelectedCallNotes(e.target.value)}
                                            rows={3}
                                            placeholder="주요 통화 요점, 요청사항, 후속 조치 메모를 입력하세요..."
                                            className="w-full mt-1 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Staff Assignment Card */}
                            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                                    <div className="flex items-center gap-2">
                                        <UserCheck className="w-4 h-4 text-slate-500" />
                                        <h3 className="text-sm font-bold text-slate-800">담당자 및 부서 배정</h3>
                                    </div>
                                    {selectedCall.assignedDepartmentId && (
                                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                            {selectedCall.assignedDepartmentId} {selectedCall.assignedUserName ? `· ${selectedCall.assignedUserName}` : ''}
                                        </span>
                                    )}
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[11px] font-medium text-slate-500">배정 부서</label>
                                        <select
                                            value={assignDept}
                                            onChange={(e) => {
                                                setAssignDept(e.target.value);
                                                setAssignStaff('');
                                            }}
                                            className="w-full mt-1 text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white"
                                        >
                                            {getTeams().map(t => <option key={t} value={t}>{t}</option>)}
                                        </select>
                                    </div>

                                    <div>
                                        <label className="text-[11px] font-medium text-slate-500">담당 직원</label>
                                        <select
                                            value={assignStaff}
                                            onChange={(e) => setAssignStaff(e.target.value)}
                                            className="w-full mt-1 text-xs px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white"
                                        >
                                            <option value="">담당자 선택</option>
                                            {availableStaffList.map((s) => (
                                                <option key={s.name} value={s.name}>{s.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <button
                                    onClick={handleAssign}
                                    className="w-full py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-900 text-white rounded-lg transition active:scale-95"
                                >
                                    담당자 배정 저장
                                </button>
                            </div>

                            {/* Referral Integration Card */}
                            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                                    <div className="flex items-center gap-2">
                                        <Link2 className="w-4 h-4 text-purple-600" />
                                        <h3 className="text-sm font-bold text-slate-800">의뢰대장 연계</h3>
                                    </div>
                                    {selectedCall.referralId && (
                                        <span className="text-xs font-semibold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                                            연동됨 ({selectedCall.refNo || selectedCall.referralId})
                                        </span>
                                    )}
                                </div>

                                <p className="text-xs text-slate-500">
                                    이 통화를 기존에 접수된 의뢰대장 내담자와 연결하거나, 신규 의뢰서로 바로 등록할 수 있습니다.
                                </p>

                                <div className="grid grid-cols-2 gap-2 pt-1">
                                    <button
                                        onClick={() => setIsLinkModalOpen(true)}
                                        className="py-2.5 px-3 text-xs font-semibold bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-xl flex items-center justify-center gap-1.5 transition active:scale-95"
                                    >
                                        <Link2 className="w-3.5 h-3.5" />
                                        <span>기존 의뢰와 연결</span>
                                    </button>

                                    <button
                                        onClick={handleCreateNewReferralFromCall}
                                        className="py-2.5 px-3 text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-xl flex items-center justify-center gap-1.5 transition active:scale-95"
                                    >
                                        <UserPlus className="w-3.5 h-3.5" />
                                        <span>신규 의뢰 등록</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400">
                            <PhoneCall className="w-12 h-12 text-slate-300 mb-3" />
                            <p className="text-sm font-semibold text-slate-600">통화를 선택하세요</p>
                            <p className="text-xs text-slate-400 mt-1">
                                좌측 목록에서 통화 항목을 클릭하면 녹음 청취 및 유형 분류를 진행할 수 있습니다.
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* 5. Link Referral Modal */}
            {isLinkModalOpen && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden flex flex-col max-h-[85vh]">
                        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                            <div className="flex items-center gap-2">
                                <Link2 className="w-5 h-5 text-purple-600" />
                                <h3 className="text-sm font-bold text-slate-800">의뢰대장 내담자 연결</h3>
                            </div>
                            <button
                                onClick={() => setIsLinkModalOpen(false)}
                                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 border-b border-slate-100">
                            <div className="relative">
                                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="text"
                                    value={referralSearchQuery}
                                    onChange={(e) => setReferralSearchQuery(e.target.value)}
                                    placeholder="성명, 의뢰번호(JJ-26-...), 연락처 검색..."
                                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-purple-400"
                                />
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-2 divide-y divide-slate-100">
                            {filteredReferrals.length === 0 ? (
                                <div className="text-center py-8 text-xs text-slate-400">
                                    일치하는 의뢰 내담자가 없습니다.
                                </div>
                            ) : (
                                filteredReferrals.map((ref) => (
                                    <div
                                        key={ref.referralId || ref.id}
                                        onClick={() => handleLinkToReferral(ref)}
                                        className="p-3 hover:bg-purple-50/50 rounded-xl transition cursor-pointer flex items-center justify-between gap-3"
                                    >
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-xs text-slate-800">{ref.name}</span>
                                                <span className="text-[11px] font-mono text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-200">
                                                    {ref.refNo}
                                                </span>
                                                <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                                                    {ref.team}
                                                </span>
                                            </div>
                                            <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-2">
                                                <span>접수일: {ref.requestDate}</span>
                                                {ref.contact && <span>· 연락처: {ref.contact}</span>}
                                            </div>
                                        </div>

                                        <button className="px-2.5 py-1 text-xs font-semibold bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition">
                                            연결
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="p-3 bg-slate-50 border-t border-slate-100 text-right">
                            <button
                                onClick={() => setIsLinkModalOpen(false)}
                                className="px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded-lg transition"
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

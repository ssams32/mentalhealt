
import React, { useMemo, useState, useEffect } from 'react';
import { Referral, SuicideAttempterReferral, User, Team } from '../../types';
import { apiClient } from '../../services/apiClient';
import { MAIN_TEAMS } from '../../constants';
import {
    FileText, Users, AlertTriangle, Trash2, Monitor, Bell,
    ArrowRight, TrendingUp, Clock, CheckCircle2, AlertCircle, BarChart3
} from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import ReferralInbox from './ReferralInbox';

interface HomePageProps {
    referrals: Referral[];
    suicideAttempters: SuicideAttempterReferral[];
    unregistered: Referral[];
    trashCount: number;
    currentUser: User;
    users: User[];
    onNavigate: (page: string) => void;
    onAddReferral: (referral: Referral) => void;
    onImportReferral: (pendingData: any) => void;
    pendingReferrals: any[];
    setPendingReferrals: React.Dispatch<React.SetStateAction<any[]>>;
    selectedTeam: Team | 'all';
    setSelectedTeam: (team: Team | 'all') => void;
}

const HomePage: React.FC<HomePageProps> = ({
    referrals,
    suicideAttempters,
    unregistered,
    trashCount,
    currentUser,
    users,
    onNavigate,
    onAddReferral,
    onImportReferral,
    pendingReferrals,
    setPendingReferrals,
    selectedTeam,
    setSelectedTeam
}) => {
    // [Removed] Local state lifted to App.tsx
    // const [pendingReferrals, setPendingReferrals] = useState<any[]>([]);

    // [Removed] Initial fetch moved to App.tsx
    // useEffect(() => {
    //     sheetsService.getPendingReferrals()
    //         .then(data => setPendingReferrals(Array.isArray(data) ? data : []))
    //         .catch(() => setPendingReferrals([]));
    // }, []);

    const handleAcceptReferral = async (pending: any, team: string, assignee: string) => {
        const newReferral: Referral = {
            ...pending,
            team: team as any,
            assignee,
            refNo: pending.refNo || `REF-${Date.now()}`,
            clientId: pending.clientId || `CL-${Date.now()}`
        };
        onAddReferral(newReferral);
        // 백엔드에서 pending 항목 삭제 (실패해도 무시)
        try { await fetch(`/api/pending-referrals/${pending.id}`, { method: 'DELETE' }); } catch { }
        setPendingReferrals(prev => prev.filter(p => p.id !== pending.id));
    };

    const handleDismissReferral = async (id: string) => {
        if (!window.confirm('이 홈페이지 의뢰를 정말 삭제하시겠습니까? (삭제하면 의뢰대장에 추가할 수 없게 됩니다.)')) return;
        await fetch(`/api/pending-referrals/${id}`, { method: 'DELETE' });
        setPendingReferrals(prev => prev.filter(p => p.id !== id));
    };

    const handleImportReferral = async (pending: any) => {
        // Just navigate and set transfer data. Deletion will happen on successful save.
        onImportReferral(pending);
        // [REMOVED] Premature deletion
        // await fetch(`/api/pending-referrals/${pending.id}`, { method: 'DELETE' });
        // setPendingReferrals(prev => prev.filter(p => p.id !== pending.id));
    };
    // Statistics (중복 제거 적용하여 대시보드/보고서와 정합성 통일)
    const stats = useMemo(() => {
        // 중복 제거 로직
        const seen = new Set();
        const uniqueReferrals = referrals
            .filter(r => {
                const key = r.clientId || `${r.refNo}_${r.name}_${r.requestDate}`;
                if (!key || key.startsWith('NO ID')) return true;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        // 미등록 대상자 중복 제거
        const seenUnregistered = new Set();
        const uniqueUnregistered = unregistered.filter(r => {
            const key = r.clientId || `${r.refNo}_${r.name}_${r.requestDate}`;
            if (!key || key.startsWith('NO ID')) return true;
            if (seenUnregistered.has(key)) return false;
            seenUnregistered.add(key);
            return true;
        });

        // 자살시도자 중복 제거 (uid 기준)
        const seenSuicide = new Set();
        const uniqueSuicide = suicideAttempters.filter(r => {
            if (!r.uid) return true;
            if (seenSuicide.has(r.uid)) return false;
            seenSuicide.add(r.uid);
            return true;
        });

        const filteredByTeam = selectedTeam === 'all'
            ? uniqueReferrals
            : uniqueReferrals.filter(r => r.team === selectedTeam);

        const ongoing = filteredByTeam.filter(r => r.closureStatus === '미종결').length;
        const closed = filteredByTeam.filter(r => r.closureStatus !== '미종결').length;
        const thisMonth = filteredByTeam.filter(r => {
            const date = new Date(r.requestDate);
            const now = new Date();
            return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
        }).length;

        return {
            total: filteredByTeam.length,
            ongoing,
            closed,
            thisMonth,
            suicideTotal: uniqueSuicide.length,
            unregisteredCount: uniqueUnregistered.length,
            trashCount
        };
    }, [referrals, suicideAttempters, unregistered, trashCount]);

    const StatCard = ({
        title, value, subValue, icon: Icon, color, onClick
    }: {
        title: string; value: number; subValue?: string; icon: any; color: string; onClick: () => void
    }) => (
        <button
            onClick={onClick}
            className={`bento-card group relative p-6 text-left w-full overflow-hidden hover:ring-2 hover:ring-${color}-500/20`}
        >
            <div className={`absolute -right-4 -top-4 w-32 h-32 bg-${color}-50 rounded-full opacity-0 group-hover:opacity-100 transition-all duration-500 blur-2xl`} />
            <div className="relative z-10">
                <div className={`w-12 h-12 rounded-xl bg-${color}-50 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className={`text-${color}-600`} size={24} />
                </div>
                <div className="text-3xl font-black text-slate-800 mb-1 tracking-tight">{value.toLocaleString()}</div>
                <div className="text-sm font-bold text-slate-500">{title}</div>
                {subValue && <div className="text-xs text-slate-400 mt-1 font-medium">{subValue}</div>}
            </div>
            <div className={`absolute bottom-4 right-4 w-8 h-8 rounded-full bg-${color}-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0`}>
                <ArrowRight className={`text-${color}-600`} size={14} />
            </div>
        </button>
    );

    return (
        <div className="h-full overflow-y-auto bg-transparent p-6 animate-entrance">
            {/* Header */}
            <div className="mb-8 pl-1">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg text-white font-black text-xl">
                        IC
                    </div>
                    <div>
                        <h2 className="text-sm font-bold text-indigo-600 uppercase tracking-widest">Icheon Center</h2>
                        <h1 className="text-3xl font-black text-slate-900 tracking-tight">의뢰관리 시스템 대시보드</h1>
                    </div>
                </div>
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 mb-2 tracking-tight">
                            안녕하세요, {currentUser?.name || '사용자'}님 👋
                        </h2>
                        <p className="text-slate-500 font-medium">오늘도 안전한 하루 되세요.</p>
                    </div>
                </div>
            </div>

            {/* Pending Referrals Inbox */}
            <ReferralInbox
                pendingReferrals={pendingReferrals}
                onAccept={handleAcceptReferral}
                onDismiss={handleDismissReferral}
                onImport={handleImportReferral}
                users={users.map(u => ({ name: u.name, team: u.team }))}
            />

            {/* Stat Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
                <StatCard
                    title="전체 의뢰"
                    value={stats.total}
                    subValue={`진행중 ${stats.ongoing} / 종결 ${stats.closed}`}
                    icon={FileText}
                    color="blue"
                    onClick={() => onNavigate('referrals')}
                />
                <StatCard
                    title="자살시도자"
                    value={stats.suicideTotal}
                    subValue="집중 사례관리 대상"
                    icon={AlertTriangle}
                    color="rose"
                    onClick={() => onNavigate('suicideAttempters')}
                />
                <StatCard
                    title="미등록 모니터링"
                    value={stats.unregisteredCount}
                    subValue="추후 관리 대상"
                    icon={Monitor}
                    color="emerald"
                    onClick={() => onNavigate('referrals')}
                />
                <StatCard
                    title="통계/보고서"
                    value={stats.total}
                    subValue="데이터 분석 리포트"
                    icon={BarChart3}
                    color="violet"
                    onClick={() => onNavigate('reports')}
                />
            </div>

            {/* Quick Stats Row (Bento Style) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
                <div className="bento-card p-5 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center shrink-0">
                        <TrendingUp className="text-indigo-600" size={24} />
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">이번 달 신규</div>
                        <div className="text-2xl font-black text-slate-800">{stats.thisMonth}건</div>
                    </div>
                </div>

                <div className="bento-card p-5 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center shrink-0">
                        <Clock className="text-amber-600" size={24} />
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">진행중</div>
                        <div className="text-2xl font-black text-slate-800">{stats.ongoing}건</div>
                    </div>
                </div>

                <div className="bento-card p-5 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="text-emerald-600" size={24} />
                    </div>
                    <div>
                        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">종결 완료</div>
                        <div className="text-2xl font-black text-slate-800">{stats.closed}건</div>
                    </div>
                </div>
            </div>

            {/* Trash (Subtle) */}
            {stats.trashCount > 0 && (
                <div className="flex justify-end">
                    <button
                        onClick={() => onNavigate('referrals')}
                        className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-rose-500 transition-colors bg-slate-50 px-3 py-2 rounded-lg"
                    >
                        <Trash2 size={14} />
                        휴지통 ({stats.trashCount})
                    </button>
                </div>
            )}

        </div>
    );
};

export default HomePage;

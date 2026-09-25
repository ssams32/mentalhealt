
import React from 'react';
import { User, Page } from '../../types';
import { PAGES_CONFIG } from '../../constants';
import {
    Users,
    HeartPulse,
    FileSearch,
    Database,
    PieChart,
    UserCog,
    LogOut,
    Bot,
    Calculator,
    FileText,
    Calendar,
    Monitor,
    Map,
    Rocket,
    Clock,
    Home, // [New] Icon for Home
    PhoneCall, // [New] Icon for Voice Calls
    ClipboardList // [Track B] Icon for Survey Management
} from 'lucide-react';

import { NotificationBell } from '../notifications/NotificationBell';

interface SidebarProps {
    currentUser: User;
    activePage: Page;
    setActivePage: (page: Page) => void;
    onNavigateToReferral?: (referralId: string) => void;
    onLogout: () => void;
    onToggleAgent: () => void;
    sessionTime?: number;
    pendingCount?: number;
    voicePendingCount?: number;
    surveyPendingCount?: number;
}

const PAGE_ICONS: Record<Page, React.ElementType> = {
    home: Home,
    referrals: Users,
    suicideAttempters: HeartPulse,
    caseAnalysis: FileSearch,
    data: Database,
    reports: PieChart,
    accounts: UserCog,
    aiNotepad: FileText,
    budget: Calculator,
    calendar: Calendar,
    assets: Map,
    antiGravity: Rocket,
    voiceCalls: PhoneCall,
    surveyManagement: ClipboardList,
    //  officialDocuments: FileText,
};

const Sidebar: React.FC<SidebarProps> = ({ currentUser, activePage, setActivePage, onNavigateToReferral, onLogout, onToggleAgent, sessionTime, pendingCount, voicePendingCount, surveyPendingCount = 0 }) => {
    const isCollapsed = false; // 항상 확장된 상태 유지

    // Helper to format time
    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    return (
        <>
            {/* Desktop Sidebar - "Floating" Design */}
            <aside className={`hidden md:flex ${isCollapsed ? 'w-24' : 'w-72'} h-screen py-4 pl-4 transition-all duration-300 z-30`}>
                <div className={`flex flex-col h-full bg-white rounded-[var(--radius-xl)] shadow-[var(--shadow-item)] border border-slate-100 transition-all duration-300 ${isCollapsed ? 'items-center px-2' : ''}`}>

                    {/* Header */}
                    <div className={`p-6 ${isCollapsed ? 'px-2 flex justify-center' : 'px-6'}`}>
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg text-white font-black text-lg shrink-0">
                                    IC
                                </div>
                                {!isCollapsed && (
                                    <div className="animate-entrance">
                                        <h2 className="text-lg font-black text-slate-900 tracking-tight leading-none">
                                            이천센터<br />
                                            <span className="text-[var(--brand-primary)]">의뢰관리</span>
                                        </h2>
                                    </div>
                                )}
                            </div>
                            {!isCollapsed && (
                                <NotificationBell onNavigate={setActivePage} onNavigateToReferral={onNavigateToReferral} />
                            )}
                        </div>
                    </div>

                    {/* Navigation */}
                    <nav className="flex-1 px-3 space-y-1 overflow-y-auto custom-scrollbar">
                        {(['home', 'referrals', 'suicideAttempters', 'caseAnalysis', 'voiceCalls', 'surveyManagement', 'data', 'reports', 'budget', 'accounts'] as Page[]).filter(p => {
                            if (p === 'accounts') return true;
                            if (p === 'caseAnalysis') return true; // 모든 실무 직원이 사례분석시스템 메뉴 접근 가능
                            if (p === 'voiceCalls') {
                                // 음성 녹음 분석(AI): 관리자 또는 VOICE_RECORDING_AI_ACCESS 명시적 권한 사용자에게만 노출
                                if (!currentUser || currentUser.status !== 'active') return false;
                                const isAdmin = currentUser.role === 'admin';
                                const hasPermission = Array.isArray(currentUser.permissions)
                                    ? currentUser.permissions.includes('VOICE_RECORDING_AI_ACCESS') || currentUser.permissions.includes('voiceCalls')
                                    : Boolean((currentUser.permissions as any)?.VOICE_RECORDING_AI_ACCESS || (currentUser.permissions as any)?.voiceCalls);
                                return isAdmin || hasPermission;
                            }
                            if (p === 'surveyManagement') {
                                // 관리자, 매니저 또는 설문가져오기 권한 사용자에게 노출
                                return currentUser.role === 'admin' || currentUser.role === 'manager' || (currentUser.permissions as any)?.surveyImport || (currentUser.permissions as any)?.SURVEY_IMPORT_MANAGER;
                            }
                            if (p === 'data') return currentUser.role === 'admin';
                            return true;
                        }).map((page) => {
                            const config = PAGES_CONFIG[page];
                            const pageTitle = page === 'voiceCalls' ? '음성 녹음 분석(AI)' : (config?.title || '');
                            const isActive = activePage === page;
                            const IconComponent = PAGE_ICONS[page];

                            return (
                                <button key={page} onClick={() => setActivePage(page)}
                                    className={`w-full flex items-center ${isCollapsed ? 'justify-center py-3' : 'justify-start px-4 py-3'} rounded-xl transition-all duration-200 group relative
                                    ${isActive
                                            ? 'bg-[var(--brand-light)] text-[var(--brand-primary)] font-bold shadow-sm'
                                            : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                                    title={isCollapsed ? pageTitle : ''}
                                >
                                    <IconComponent size={20} className={`shrink-0 ${isActive ? 'text-[var(--brand-primary)]' : 'text-slate-400 group-hover:text-slate-600'}`} />

                                    {!isCollapsed && (
                                        <span className="ml-3 text-sm truncate">{pageTitle}</span>
                                    )}

                                    {page === 'home' && pendingCount && pendingCount > 0 && (
                                        <span className={`absolute ${isCollapsed ? 'top-1 right-1' : 'top-3 right-3'} w-5 h-5 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center shadow-md animate-pulse`}>
                                            {pendingCount > 9 ? '9+' : pendingCount}
                                        </span>
                                    )}

                                    {page === 'voiceCalls' && voicePendingCount !== undefined && voicePendingCount > 0 && (
                                        <span className={`absolute ${isCollapsed ? 'top-1 right-1' : 'top-3 right-3'} px-1.5 py-0.5 bg-amber-500 text-white text-[10px] font-black rounded-full flex items-center justify-center shadow-md animate-pulse`}>
                                            {voicePendingCount > 99 ? '99+' : voicePendingCount}
                                        </span>
                                    )}

                                    {page === 'surveyManagement' && surveyPendingCount !== undefined && surveyPendingCount > 0 && (
                                        <span className={`absolute ${isCollapsed ? 'top-1 right-1' : 'top-3 right-3'} px-1.5 py-0.5 bg-emerald-600 text-white text-[10px] font-black rounded-full flex items-center justify-center shadow-md animate-pulse`}>
                                            {surveyPendingCount > 99 ? '99+' : surveyPendingCount}
                                        </span>
                                    )}
                                </button>
                            )
                        })}
                    </nav>

                    {/* Footer / User Profile */}
                    <div className="p-4 mt-auto">
                        <div className={`rounded-2xl bg-slate-50 border border-slate-100 p-3 ${isCollapsed ? 'flex flex-col items-center gap-2' : ''}`}>

                            {/* Session Timer */}
                            {sessionTime !== undefined && (
                                <div className={`flex items-center gap-2 mb-3 text-xs font-mono font-bold ${isCollapsed ? 'justify-center' : ''} ${sessionTime < 300 ? 'text-rose-600 animate-pulse' : 'text-slate-400'}`}>
                                    <Clock size={12} />
                                    {!isCollapsed && <span>{formatTime(sessionTime)}</span>}
                                </div>
                            )}

                            <div className={`flex items-center gap-3 ${isCollapsed ? 'justify-center flex-col' : ''}`}>
                                <div className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-600 font-bold text-xs shadow-sm shrink-0">
                                    {currentUser.name[0]}
                                </div>
                                {!isCollapsed && (
                                    <div className="overflow-hidden">
                                        <p className="text-sm font-bold text-slate-800 truncate">{currentUser.name}</p>
                                        <p className="text-[10px] text-slate-400 truncate">{currentUser.team}</p>
                                    </div>
                                )}
                            </div>

                            <button
                                onClick={onLogout}
                                className={`mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors text-xs font-bold`}
                            >
                                <LogOut size={14} />
                                {!isCollapsed && "로그아웃"}
                            </button>
                        </div>
                        {!isCollapsed && (
                            <div className="text-center mt-2">
                                <span className="text-[10px] text-slate-300 font-mono">v3.1.0 Pro</span>
                            </div>
                        )}
                    </div>
                </div>
            </aside>

            {/* Mobile Bottom Navigation (Glassmorphism) */}
            <div className="md:hidden fixed bottom-4 left-4 right-4 bg-white/90 backdrop-blur-lg border border-white/50 shadow-2xl rounded-2xl z-50 px-2 py-1">
                <nav className="flex items-center justify-around h-16">
                    {(['home', 'referrals', 'suicideAttempters', 'reports', 'budget'] as Page[]).map((page) => {
                        const config = PAGES_CONFIG[page];
                        const isActive = activePage === page;
                        const IconComponent = PAGE_ICONS[page];

                        return (
                            <button key={page} onClick={() => setActivePage(page)}
                                className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl transition-all duration-200
                                ${isActive ? 'text-[var(--brand-primary)] bg-[var(--brand-light)]' : 'text-slate-400'}`}>
                                <IconComponent size={20} className={isActive ? 'animate-bounce-subtle' : ''} />
                            </button>
                        )
                    })}
                    <button onClick={onLogout} className="flex flex-col items-center justify-center w-12 h-12 rounded-xl text-slate-300 hover:text-rose-500">
                        <LogOut size={20} />
                    </button>
                </nav>
            </div>
        </>
    );
};

export default Sidebar;

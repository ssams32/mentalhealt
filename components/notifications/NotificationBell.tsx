/**
 * components/notifications/NotificationBell.tsx
 * In-app notification bell with periodic unread polling, popover drawer,
 * and zero-PII safe navigation.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, CheckCheck, X, AlertCircle, Clock, ExternalLink } from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import { Page } from '../../types';

interface NotificationItem {
    id: string;
    recipientUserId: string;
    type: string;
    relatedEntityType: string;
    relatedEntityId: string;
    safeTitle: string;
    safeMessage: string;
    priority: 'NORMAL' | 'PRIORITY_REVIEW' | 'IMMEDIATE_REVIEW';
    isRead: boolean;
    readAt?: string;
    createdAt: string;
}

interface NotificationBellProps {
    onNavigate?: (page: Page) => void;
    onNavigateToReferral?: (referralId: string) => void;
}

export const NotificationBell: React.FC<NotificationBellProps> = ({ onNavigate, onNavigateToReferral }) => {
    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [isOpen, setIsOpen] = useState<boolean>(false);
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

    // Dynamic viewport-safe positioning calculation
    const updatePosition = useCallback(() => {
        if (!buttonRef.current) return;
        const rect = buttonRef.current.getBoundingClientRect();
        const isMobile = window.innerWidth < 640;
        const width = Math.min(window.innerWidth - 24, 380);

        let top = rect.bottom + 8;
        let left = rect.left;

        if (isMobile) {
            left = Math.max(12, (window.innerWidth - width) / 2);
        } else {
            // Desktop: if overflowing right edge, align with right boundary
            if (left + width > window.innerWidth - 12) {
                left = window.innerWidth - width - 12;
            }
            if (left < 12) {
                left = 12;
            }
        }

        // Avoid overflowing viewport bottom
        const maxH = Math.min(window.innerHeight * 0.7, 500);
        if (top + maxH > window.innerHeight - 12) {
            top = Math.max(12, rect.top - maxH - 8);
        }

        setPopoverStyle({
            position: 'fixed',
            top: `${top}px`,
            left: `${left}px`,
            width: `${width}px`,
            maxWidth: 'min(calc(100vw - 24px), 380px)',
            zIndex: 9999
        });
    }, []);

    // Poll unread count every 30s
    const fetchUnreadCount = useCallback(async () => {
        try {
            const res = await apiClient.getUnreadNotificationCount();
            if (res && typeof res.unreadCount === 'number') {
                setUnreadCount(res.unreadCount);
            }
        } catch (ignore) {
            // Silently ignore network failures during background polling
        }
    }, []);

    useEffect(() => {
        fetchUnreadCount();
        const intervalId = setInterval(fetchUnreadCount, 30000);
        return () => clearInterval(intervalId);
    }, [fetchUnreadCount]);

    // Fetch full notification list when popover is opened
    const fetchNotifications = useCallback(async () => {
        setIsLoading(true);
        try {
            const res = await apiClient.getInternalNotifications({ limit: 30, includeRead: true });
            if (res && Array.isArray(res.notifications)) {
                setNotifications(res.notifications);
            }
        } catch (err) {
            console.error('Failed to fetch notifications:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const toggleOpen = () => {
        if (!isOpen) {
            fetchNotifications();
            updatePosition();
            setIsOpen(true);
        } else {
            setIsOpen(false);
        }
    };

    // Close on click outside, Escape key, or window resize/scroll
    useEffect(() => {
        if (!isOpen) return;

        updatePosition();

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            if (
                popoverRef.current &&
                !popoverRef.current.contains(target) &&
                buttonRef.current &&
                !buttonRef.current.contains(target)
            ) {
                setIsOpen(false);
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsOpen(false);
            }
        };

        const handleResize = () => updatePosition();
        const handleScroll = () => updatePosition();

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleResize);
        window.addEventListener('scroll', handleScroll, true);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('scroll', handleScroll, true);
        };
    }, [isOpen, updatePosition]);

    const handleMarkAsRead = async (item: NotificationItem) => {
        try {
            await apiClient.markNotificationAsRead(item.id);
            setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, isRead: true } : n));
            setUnreadCount(prev => Math.max(0, prev - 1));
            setIsOpen(false);

            // P0-2: Survey notifications route strictly to Online Survey Management
            if (item.type?.startsWith('SURVEY_') || item.type?.startsWith('survey_') || item.relatedEntityType === 'survey') {
                if (onNavigate) {
                    onNavigate('surveyManagement');
                }
            } else if (item.relatedEntityType === 'referral' && item.relatedEntityId) {
                if (onNavigateToReferral) {
                    onNavigateToReferral(item.relatedEntityId);
                } else if (onNavigate) {
                    onNavigate('referrals');
                }
            }
        } catch (err) {
            console.error('Failed to mark notification read:', err);
        }
    };

    const handleMarkAllAsRead = async () => {
        try {
            await apiClient.markAllNotificationsAsRead();
            setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
            setUnreadCount(0);
        } catch (err) {
            console.error('Failed to mark all notifications read:', err);
        }
    };

    const handleDismiss = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        try {
            await apiClient.dismissNotification(id);
            setNotifications(prev => prev.filter(n => n.id !== id));
            fetchUnreadCount();
        } catch (err) {
            console.error('Failed to dismiss notification:', err);
        }
    };

    const formatRelativeTime = (iso: string) => {
        if (!iso) return '-';
        const diffMs = Date.now() - new Date(iso).getTime();
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffSec < 60) return '방금 전';
        if (diffMin < 60) return `${diffMin}분 전`;
        if (diffHour < 24) return `${diffHour}시간 전`;
        return `${diffDay}일 전`;
    };

    const getPriorityBadge = (priority: string) => {
        switch (priority) {
            case 'IMMEDIATE_REVIEW':
                return <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-rose-100 text-rose-700 border border-rose-200">긴급검토</span>;
            case 'PRIORITY_REVIEW':
                return <span className="px-1.5 py-0.5 rounded text-[10px] font-black bg-amber-100 text-amber-700 border border-amber-200">우선검토</span>;
            default:
                return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600">일반검토</span>;
        }
    };

    return (
        <div className="relative inline-block">
            <button
                ref={buttonRef}
                type="button"
                onClick={toggleOpen}
                className="relative p-2 rounded-xl text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/80 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                title="사내 알림함"
                aria-label="사내 알림"
            >
                <Bell size={20} className={unreadCount > 0 ? 'text-indigo-600 animate-wiggle' : ''} />
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-black text-white shadow-md ring-2 ring-white animate-pulse">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {/* Popover Dropdown */}
            {isOpen && (
                <div
                    ref={popoverRef}
                    style={popoverStyle}
                    className="rounded-2xl bg-white shadow-2xl border border-slate-200/90 py-2 animate-in fade-in slide-in-from-top-2 duration-150"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                            <span className="font-black text-sm text-slate-800">사내 알림</span>
                            {unreadCount > 0 && (
                                <span className="bg-indigo-100 text-indigo-700 text-xs font-black px-2 py-0.5 rounded-full">
                                    {unreadCount}건 미확인
                                </span>
                            )}
                        </div>
                        {unreadCount > 0 && (
                            <button
                                onClick={handleMarkAllAsRead}
                                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 hover:underline transition-colors"
                            >
                                <CheckCheck size={14} />
                                모두 읽음
                            </button>
                        )}
                    </div>

                    {/* List */}
                    <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-100">
                        {isLoading ? (
                            <div className="py-8 text-center text-slate-400 text-xs">
                                <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-indigo-600 border-t-transparent mb-2"></div>
                                <p>알림을 불러오는 중...</p>
                            </div>
                        ) : notifications.length === 0 ? (
                            <div className="py-10 text-center text-slate-400 text-xs">
                                <Bell size={28} className="mx-auto mb-2 text-slate-300" />
                                <p>새로운 알림이 없습니다.</p>
                            </div>
                        ) : (
                            notifications.map(item => (
                                <div
                                    key={item.id}
                                    onClick={() => handleMarkAsRead(item)}
                                    className={`px-4 py-3 cursor-pointer transition-colors relative group flex items-start justify-between gap-3 ${
                                        item.isRead ? 'bg-white hover:bg-slate-50' : 'bg-indigo-50/40 hover:bg-indigo-50/70'
                                    }`}
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            {getPriorityBadge(item.priority)}
                                            <span className={`text-xs font-bold truncate ${item.isRead ? 'text-slate-700' : 'text-slate-900 font-black'}`}>
                                                {item.safeTitle}
                                            </span>
                                            {!item.isRead && (
                                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 shrink-0"></span>
                                            )}
                                        </div>
                                        <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed mb-1.5">
                                            {item.safeMessage}
                                        </p>
                                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                                            <Clock size={11} />
                                            <span>{formatRelativeTime(item.createdAt)}</span>
                                            {item.relatedEntityType === 'survey' && (
                                                <span className="text-indigo-600 font-bold flex items-center gap-0.5 ml-auto group-hover:underline">
                                                    확인하기 <ExternalLink size={10} />
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(e) => handleDismiss(e, item.id)}
                                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200 transition-all shrink-0"
                                        title="삭제"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

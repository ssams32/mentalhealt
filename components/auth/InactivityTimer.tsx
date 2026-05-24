
import React, { useState, useEffect, useCallback, useRef } from 'react';

interface InactivityTimerProps {
    onLogout: () => void;
    onTimeUpdate?: (seconds: number) => void;
}

// 60분 (초 단위)
const INACTIVITY_TIMEOUT_SECONDS = 60 * 60;
// 30초 (초 단위)
const WARNING_COUNTDOWN_SECONDS = 30;

const InactivityTimer: React.FC<InactivityTimerProps> = ({ onLogout, onTimeUpdate }) => {
    // 경고 모달 표시 여부 상태
    const [showWarning, setShowWarning] = useState(false);
    // 경고 모달의 30초 카운트다운 상태
    const [warningCountdown, setWarningCountdown] = useState(WARNING_COUNTDOWN_SECONDS);
    // 주 카운트다운 상태
    const [mainCountdown, setMainCountdown] = useState(INACTIVITY_TIMEOUT_SECONDS);

    // 타이머 ID를 저장하기 위한 Ref
    const mainIntervalRef = useRef<number | null>(null);
    const warningIntervalRef = useRef<number | null>(null);
    // Throttle: only reset timer every 10 seconds max for mouse/keyboard events
    const lastResetRef = useRef<number>(Date.now());

    // Report time changes to parent
    useEffect(() => {
        if (onTimeUpdate) {
            onTimeUpdate(mainCountdown);
        }
    }, [mainCountdown, onTimeUpdate]);

    // 로그아웃을 실행하는 함수
    const performLogout = useCallback(() => {
        if (mainIntervalRef.current) clearInterval(mainIntervalRef.current);
        if (warningIntervalRef.current) clearInterval(warningIntervalRef.current);
        onLogout();
    }, [onLogout]);

    // 경고 모달을 표시하고 30초 카운트다운을 시작하는 함수
    const startWarningCountdown = useCallback(() => {
        setShowWarning(true);
        setWarningCountdown(WARNING_COUNTDOWN_SECONDS);

        warningIntervalRef.current = window.setInterval(() => {
            setWarningCountdown(prev => {
                if (prev <= 1) {
                    performLogout();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [performLogout]);

    // 주 타이머를 리셋하고 다시 시작하는 함수
    const resetMainTimer = useCallback(() => {
        if (mainIntervalRef.current) clearInterval(mainIntervalRef.current);
        if (warningIntervalRef.current) clearInterval(warningIntervalRef.current);

        setShowWarning(false);
        setMainCountdown(INACTIVITY_TIMEOUT_SECONDS);

        mainIntervalRef.current = window.setInterval(() => {
            setMainCountdown(prev => {
                if (prev <= 1) {
                    if (mainIntervalRef.current) clearInterval(mainIntervalRef.current);
                    startWarningCountdown();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [startWarningCountdown]);

    // 컴포넌트 마운트 시 이벤트 리스너 설정 및 타이머 시작
    useEffect(() => {
        const activityEvents: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll'];

        // Throttled activity handler — only reset if at least 10s since last reset
        const activityHandler = () => {
            const now = Date.now();
            if (now - lastResetRef.current > 10000) {
                lastResetRef.current = now;
                resetMainTimer();
            }
        };

        activityEvents.forEach(event => {
            window.addEventListener(event, activityHandler);
        });

        resetMainTimer();

        return () => {
            activityEvents.forEach(event => {
                window.removeEventListener(event, activityHandler);
            });
            if (mainIntervalRef.current) clearInterval(mainIntervalRef.current);
            if (warningIntervalRef.current) clearInterval(warningIntervalRef.current);
        };
    }, [resetMainTimer]);

    // 세션 연장 버튼
    const handleStay = () => {
        lastResetRef.current = Date.now();
        resetMainTimer();
    };

    return (
        <>
            {/* Timer display is now handled by Sidebar — no fixed-position badge here */}

            {/* 경고 모달 */}
            {showWarning && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] animate-fade-in">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 text-center w-full max-w-sm animate-scale-in">
                        <h2 className="text-xl font-bold text-slate-800 mb-2">세션 만료 경고</h2>
                        <p className="text-slate-600 mb-6">
                            활동이 없어 <span className="font-bold text-red-500">{warningCountdown}초</span> 후 자동으로 로그아웃됩니다.
                        </p>
                        <button
                            onClick={handleStay}
                            className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition-colors"
                        >
                            세션 연장
                        </button>
                    </div>
                </div>
            )}
        </>
    );
};

export default InactivityTimer;

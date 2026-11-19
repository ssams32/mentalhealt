
import React, { useState, useEffect, useCallback, useRef } from 'react';

interface InactivityTimerProps {
    onLogout: () => void;
}

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const WARNING_COUNTDOWN_MS = 30 * 1000;
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll'];

const InactivityTimer: React.FC<InactivityTimerProps> = ({ onLogout }) => {
    const [secondsUntilLogout, setSecondsUntilLogout] = useState<number | null>(null);
    const lastActivityAtRef = useRef(Date.now());
    const hasLoggedOutRef = useRef(false);

    const checkIdleTime = useCallback(() => {
        if (hasLoggedOutRef.current) return;
        const msUntilLogout = INACTIVITY_TIMEOUT_MS + WARNING_COUNTDOWN_MS - (Date.now() - lastActivityAtRef.current);
        if (msUntilLogout <= 0) {
            hasLoggedOutRef.current = true;
            setSecondsUntilLogout(null);
            onLogout();
        } else if (msUntilLogout <= WARNING_COUNTDOWN_MS) {
            setSecondsUntilLogout(Math.ceil(msUntilLogout / 1000));
        } else {
            setSecondsUntilLogout(null);
        }
    }, [onLogout]);

    const recordActivity = useCallback(() => {
        const idleLimitAlreadyPassed = Date.now() - lastActivityAtRef.current >= INACTIVITY_TIMEOUT_MS + WARNING_COUNTDOWN_MS;
        if (!idleLimitAlreadyPassed) lastActivityAtRef.current = Date.now();
        checkIdleTime();
    }, [checkIdleTime]);

    useEffect(() => {
        const intervalId = window.setInterval(checkIdleTime, 1000);
        document.addEventListener('visibilitychange', checkIdleTime);
        ACTIVITY_EVENTS.forEach(event => window.addEventListener(event, recordActivity));
        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', checkIdleTime);
            ACTIVITY_EVENTS.forEach(event => window.removeEventListener(event, recordActivity));
        };
    }, [checkIdleTime, recordActivity]);

    return (
        <>
            {secondsUntilLogout !== null && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] animate-fade-in">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 text-center w-full max-w-sm animate-scale-in">
                        <h2 className="text-xl font-bold text-slate-800 mb-2">세션 만료 경고</h2>
                        <p className="text-slate-600 mb-6">
                            활동이 없어 <span className="font-bold text-red-500">{secondsUntilLogout}초</span> 후 자동으로 로그아웃됩니다.
                        </p>
                        <button
                            onClick={recordActivity}
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

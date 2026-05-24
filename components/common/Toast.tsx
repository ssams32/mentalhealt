import React, { useEffect, useState, useRef } from 'react';

interface ToastProps {
    message: string;
    onClose: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
    const [visible, setVisible] = useState(false);
    const mainTimerRef = useRef<NodeJS.Timeout | null>(null);
    const animationTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastMessageRef = useRef<string>('');

    useEffect(() => {
        // Only trigger timer if message exists AND it's different from the last one handled
        // Or if we are coming from an empty state
        if (message && message !== lastMessageRef.current) {
            lastMessageRef.current = message;
            
            // Clear any existing timers
            if (mainTimerRef.current) clearTimeout(mainTimerRef.current);
            if (animationTimerRef.current) clearTimeout(animationTimerRef.current);

            // Trigger enter animation
            setVisible(false);
            const startTimer = setTimeout(() => setVisible(true), 10);

            // Stage 1: 5s display duration
            mainTimerRef.current = setTimeout(() => {
                setVisible(false);
                
                // Stage 2: 300ms exit animation duration
                animationTimerRef.current = setTimeout(() => {
                    lastMessageRef.current = ''; // Reset tracking
                    onClose();
                }, 300);
            }, 5000);

            return () => {
                clearTimeout(startTimer);
                if (mainTimerRef.current) clearTimeout(mainTimerRef.current);
                if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
            };
        } else if (!message) {
            lastMessageRef.current = '';
            setVisible(false);
        }
    }, [message, onClose]);

    if (!message) return null;

    return (
        <div 
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 transition-all duration-300 ease-out z-[100] ${
                visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}
        >
            <div className="bg-slate-900/90 backdrop-blur-md text-white text-sm font-bold px-8 py-4 rounded-2xl shadow-2xl border border-white/10 flex items-center gap-3">
                <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                {message}
            </div>
        </div>
    );
};

export default Toast;

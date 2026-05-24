
import React, { useState } from 'react';
import { User } from '../../types';

interface LoginScreenProps {
    onLogin: (user: User) => void;
    users: User[]; // Loaded from App.tsx (via Google Sheets)
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, users }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loginError, setLoginError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setLoginError('');

        try {
            // Local Validation Logic for GAS Deployment
            // 1. Find user by "Email" (Username matching)
            const normalizedEmail = email.trim();
            const usernameInput = normalizedEmail.includes('@') ? normalizedEmail.split('@')[0] : normalizedEmail;

            const foundUser = users.find(u => u.username === usernameInput || u.id === usernameInput);

            if (!foundUser) {
                setLoginError('등록되지 않은 사용자입니다.');
                setLoading(false);
                return;
            }

            // 2. Validate Password (Simple check for now, matching GAS implementation)
            // In a real simplified GAS app, we might compare against loaded password
            if (foundUser.password !== password) {
                setLoginError('비밀번호가 올바르지 않습니다.');
                setLoading(false);
                return;
            }

            // 3. Success
            onLogin(foundUser);

        } catch (err) {
            setLoginError('로그인 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center ios-mesh-bg relative overflow-hidden font-sans">
            <div className="w-full max-w-md p-6 relative z-10">
                <div className="glass rounded-[2.5rem] shadow-2xl p-10 text-center relative overflow-hidden border border-white/60">
                    <div className="mb-12">
                        <h1 className="text-3xl font-extrabold tracking-tight mb-2 text-slate-800">
                            이천센터 의뢰관리 대장
                        </h1>
                        <p className="text-slate-500 text-sm font-medium">
                            Icheon City Mental Health Center
                        </p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-5">
                        {loginError && (
                            <div className="bg-red-50 border border-red-100 text-red-500 text-xs font-bold py-3 rounded-2xl">
                                {loginError}
                            </div>
                        )}
                        <div className="space-y-3">
                            <input
                                type="text"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-100/50 border-none rounded-2xl text-slate-800 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/50 focus:bg-white transition-all text-sm font-bold"
                                placeholder="아이디"
                                autoFocus
                            />
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-5 py-4 bg-slate-100/50 border-none rounded-2xl text-slate-800 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/50 focus:bg-white transition-all text-sm font-bold"
                                placeholder="비밀번호"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 hover:scale-[1.02] transition-all duration-300 shadow-lg shadow-slate-900/20 text-sm disabled:opacity-50"
                        >
                            {loading ? '인증 중...' : '시스템 접속'}
                        </button>
                    </form>

                    <div className="mt-10 flex items-center justify-center gap-2 text-[10px] text-slate-400 font-bold tracking-widest uppercase">
                        <i className="fas fa-lock"></i> Authorized Access Only
                    </div>
                </div>
            </div>
            <div className="absolute bottom-6 right-6 text-slate-400/50 text-xs font-bold">
                제작자: ssams
            </div>
        </div>
    );
};

export default LoginScreen;

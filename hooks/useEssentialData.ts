import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../services/apiClient';
import { safeLocalStorage } from '../utils/safeLocalStorage';
import { User, Referral, SuicideAttempterReferral, AnyLog } from '../types';
import { initialUsers, initialReferrals, initialSuicideAttempterReferrals } from '../constants';

export const useEssentialData = () => {
    const [users, setUsers] = useState<User[]>([]);
    const [logs, setLogs] = useState<AnyLog[]>([]);
    const [referrals, setReferrals] = useState<Referral[]>(() => {
        try { return JSON.parse(safeLocalStorage.getItem('referrals') || 'null') || initialReferrals; } catch { return initialReferrals; }
    });
    const [unregisteredCandidates, setUnregisteredCandidates] = useState<Referral[]>(() => {
        try { return JSON.parse(safeLocalStorage.getItem('unregisteredCandidates') || 'null') || []; } catch { return []; }
    });
    const [suicideAttempterReferrals, setSuicideAttempterReferrals] = useState<SuicideAttempterReferral[]>(() => {
        try { return JSON.parse(safeLocalStorage.getItem('suicideAttempterReferrals') || 'null') || initialSuicideAttempterReferrals; } catch { return initialSuicideAttempterReferrals; }
    });

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const loadData = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        // Emergency Force Exit (15s timeout)
        const timeoutId = setTimeout(() => {
            console.warn("[Stability] Data load timeout. Forcing UI.");
            setIsLoading(false);
        }, 15000);

        try {
            console.log("[Stability] Starting robust data load via ApiClient...");

            // 1. Critical: Users
            const loadedUsers = await apiClient.getUsers().catch(() => null);
            if (loadedUsers?.length) {
                setUsers(loadedUsers);
                safeLocalStorage.setItem('users', JSON.stringify(loadedUsers));
            } else {
                // Fallback
                const saved = safeLocalStorage.getItem('users');
                setUsers(saved ? JSON.parse(saved) : initialUsers);
            }

            // Unblock UI early after critical data
            setIsLoading(false);
            clearTimeout(timeoutId);

            // 2. Background: Heavy Data
            const [loadedLogs, loadedRefs, loadedSAs, loadedUnreg] = await Promise.all([
                apiClient.getLogs().catch(e => { console.warn("Logs fail", e); return []; }),
                apiClient.getReferrals().catch(e => { console.warn("Refs fail", e); return []; }),
                apiClient.getSuicideAttempters().catch(e => { console.warn("SAs fail", e); return []; }),
                apiClient.getUnregistered().catch(e => { console.warn("Unreg fail", e); return []; })
            ]);

            if (Array.isArray(loadedLogs)) setLogs(loadedLogs);
            if (Array.isArray(loadedRefs) && loadedRefs.length) setReferrals(loadedRefs);
            if (Array.isArray(loadedSAs) && loadedSAs.length) setSuicideAttempterReferrals(loadedSAs);
            if (Array.isArray(loadedUnreg)) setUnregisteredCandidates(loadedUnreg);

            console.log("[Stability] Background load complete.");

        } catch (err) {
            console.error("[Stability] Critical Load Error:", err);
            setError(err as Error);

            // Ultimate Fallback
            const savedUsers = safeLocalStorage.getItem('users');
            setUsers(savedUsers ? JSON.parse(savedUsers) : initialUsers);
            setIsLoading(false);
        } finally {
            clearTimeout(timeoutId);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    return {
        users,
        logs,
        referrals,
        unregisteredCandidates,
        suicideAttempterReferrals,
        isLoading,
        error,
        setReferrals,
        setSuicideAttempterReferrals,
        setUnregisteredCandidates,
        setUsers,
        setLogs,
        reload: loadData
    };
};

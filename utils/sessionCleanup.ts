import { safeLocalStorage, safeSessionStorage } from './safeLocalStorage';

const LEDGER_CACHE_KEYS = ['referrals', 'unregisteredCandidates', 'suicideAttempterReferrals', 'logs', 'users'];
const CASE_ANALYSIS_DRAFT_KEY = 'caseAnalysis.savedResults';
const SESSION_KEYS = ['currentUser', 'pending_sa_registration', 'lastSeenPendingCount'];

export function removeLedgerCacheLeftByOlderVersions(): void {
    LEDGER_CACHE_KEYS.forEach(safeLocalStorage.removeItem);
}

export function clearBrowserStoredClientData(): void {
    removeLedgerCacheLeftByOlderVersions();
    safeLocalStorage.removeItem(CASE_ANALYSIS_DRAFT_KEY);
    SESSION_KEYS.forEach(safeSessionStorage.removeItem);
}

export const safeLocalStorage = {
    getItem: (key: string): string | null => {
        try {
            if (typeof window === 'undefined' || !window.localStorage) return null;
            return localStorage.getItem(key);
        } catch (error) {
            console.warn(`[SafeLocalStorage] Failed to getItem for key "${key}":`, error);
            return null;
        }
    },

    setItem: (key: string, value: string): void => {
        try {
            if (typeof window === 'undefined' || !window.localStorage) return;
            localStorage.setItem(key, value);
        } catch (error: any) {
            if (
                error.name === 'QuotaExceededError' ||
                error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || // Firefox
                (error.code === 22) || // Chrome/Firefox code
                (error.code === 1014) // Webkit quota exceeded
            ) {
                console.warn(`[SafeLocalStorage] QuotaExceededError for key "${key}". Data not saved locally.`);
                // Notify user subtly if needed, but for now just prevent crash
            } else {
                console.error(`[SafeLocalStorage] Failed to setItem for key "${key}":`, error);
            }
        }
    },

    removeItem: (key: string): void => {
        try {
            if (typeof window === 'undefined' || !window.localStorage) return;
            localStorage.removeItem(key);
        } catch (error) {
            console.warn(`[SafeLocalStorage] Failed to removeItem for key "${key}":`, error);
        }
    },

    clear: (): void => {
        try {
            if (typeof window === 'undefined' || !window.localStorage) return;
            localStorage.clear();
        } catch (error) {
            console.warn(`[SafeLocalStorage] Failed to clear storage:`, error);
        }
    }
};

export const safeSessionStorage = {
    getItem: (key: string): string | null => {
        try {
            if (typeof window === 'undefined' || !window.sessionStorage) {
                return null;
            }
            return sessionStorage.getItem(key);
        } catch (e) {
            console.warn(`[SafeSessionStorage] Failed to getItem for key "${key}":`, e);
            return null;
        }
    },

    setItem: (key: string, value: string): void => {
        try {
            if (typeof window === 'undefined' || !window.sessionStorage) return;
            sessionStorage.setItem(key, value);
        } catch (e: any) {
            if (e.name === 'QuotaExceededError' ||
                e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                e.code === 22 ||
                e.code === 1014) {
                console.warn(`[SafeSessionStorage] QuotaExceededError for key "${key}". Data not saved locally.`);
            } else {
                console.error(`[SafeSessionStorage] Failed to setItem for key "${key}":`, e);
            }
        }
    },

    removeItem: (key: string): void => {
        try {
            if (typeof window === 'undefined' || !window.sessionStorage) return;
            sessionStorage.removeItem(key);
        } catch (e) {
            console.warn(`[SafeSessionStorage] Failed to removeItem for key "${key}":`, e);
        }
    },

    clear: (): void => {
        try {
            if (typeof window === 'undefined' || !window.sessionStorage) return;
            sessionStorage.clear();
        } catch (e) {
            console.warn("[SafeSessionStorage] Failed to clear storage:", e);
        }
    }
};

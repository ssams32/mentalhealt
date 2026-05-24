import { useState, useEffect, useCallback } from 'react';
import { AnalysisResult } from '../../types';

declare const google: any;

const CASE_ANALYSIS_STORAGE_KEY = 'caseAnalysis.savedResults';
const CASE_ANALYSIS_API = '/api/analysis-results';

export interface AnalysisStorageItem {
    id: string;
    name: string;
    createdAt: string;
    data?: AnalysisResult; // Local items have data, server items fetch on demand
}

const loadLocalSavedResults = (): AnalysisStorageItem[] => {
    try {
        const raw = localStorage.getItem(CASE_ANALYSIS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const saveLocalSavedResults = (items: AnalysisStorageItem[]) => {
    localStorage.setItem(CASE_ANALYSIS_STORAGE_KEY, JSON.stringify(items));
};

const normalizeSavedItem = (item: any, index: number): AnalysisStorageItem => {
    const resolvedId = item?.id ?? item?._id ?? `unknown_${Date.now()}_${index}`;
    const resolvedName = item?.name ?? item?.title ?? `저장 항목 ${index + 1}`;
    const resolvedCreatedAt = item?.createdAt ?? item?.created_at ?? new Date().toISOString();

    return {
        id: String(resolvedId),
        name: String(resolvedName),
        createdAt: String(resolvedCreatedAt),
        data: item.data // Optional
    };
};

const toSavedListArray = (payload: any): AnalysisStorageItem[] => {
    const source = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.list)
                ? payload.list
                : [];

    return source
        .filter(item => item && typeof item === 'object')
        .map((item, index) => normalizeSavedItem(item, index));
};

const mergeSavedLists = (remotePayload: any): AnalysisStorageItem[] => {
    const remote = toSavedListArray(remotePayload);
    const local = loadLocalSavedResults();
    const merged = [...remote];

    // Add local items only if ID doesn't conflict with remote (simulate sync or just aggregation)
    local.forEach(localItem => {
        if (!merged.some(remoteItem => remoteItem.id === localItem.id)) {
            merged.push(localItem);
        }
    });

    // Sort by createdAt descending
    return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

const getSafeAnalysisData = (data: any): AnalysisResult => ({
    counselorPerformance: Array.isArray(data?.counselorPerformance) ? data.counselorPerformance : [],
    memberPerformance: Array.isArray(data?.memberPerformance) ? data.memberPerformance : [],
    ispExpiringMembers: Array.isArray(data?.ispExpiringMembers) ? data.ispExpiringMembers : [],
    ispPlans: Array.isArray(data?.ispPlans) ? data.ispPlans : [],
});

export const useAnalysisStorage = () => {
    const [savedList, setSavedList] = useState<AnalysisStorageItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Initial load of list
    const refreshList = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        const hasGas = typeof google !== 'undefined' && google?.script?.run;

        if (!hasGas) {
            // Web Mode (API or Mock)
            try {
                // Try fetching from API
                const response = await fetch(CASE_ANALYSIS_API);
                if (response.ok) {
                    const data = await response.json();
                    console.log('CASE ANALYSIS FETCH LOAD:', data);
                    const merged = mergeSavedLists(data);
                    console.log('MERGED LIST:', merged);
                    setSavedList(merged);
                } else {
                    console.error('API FETCH FAILED STATUS:', response.status);
                    throw new Error('API fetch failed');
                }
            } catch (e) {
                console.error('FETCH CATCH ERROR:', e);
                // Fallback to local storage only
                const local = loadLocalSavedResults();
                setSavedList(toSavedListArray(local));
            } finally {
                setIsLoading(false);
            }
            return;
        }

        // GAS Mode
        return new Promise<void>((resolve) => {
            google.script.run
                .withSuccessHandler((list: any) => {
                    setSavedList(mergeSavedLists(list));
                    setIsLoading(false);
                    resolve();
                })
                .withFailureHandler((err: any) => {
                    console.error('GAS List Load Error:', err);
                    // Fallback to local
                    const local = loadLocalSavedResults();
                    setSavedList(toSavedListArray(local));
                    setIsLoading(false);
                    resolve();
                })
                .getAnalysisDataList();
        });
    }, []);

    // Load a specific item
    const loadItem = useCallback(async (id: string): Promise<AnalysisResult | null> => {
        setIsLoading(true);
        setError(null);

        // Check if it's a local item first
        const localItems = loadLocalSavedResults();
        const localItem = localItems.find(item => item.id === id);
        if (localItem?.data) {
            setIsLoading(false);
            return getSafeAnalysisData(localItem.data);
        }

        const hasGas = typeof google !== 'undefined' && google?.script?.run;

        if (!hasGas) {
            try {
                const response = await fetch(`${CASE_ANALYSIS_API}/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error('Failed to load from server');
                const res = await response.json();
                setIsLoading(false);
                return getSafeAnalysisData(res.data || res);
            } catch (e) {
                setIsLoading(false);
                setError('불러오기 실패');
                return null;
            }
        }

        return new Promise<AnalysisResult | null>((resolve) => {
            google.script.run
                .withSuccessHandler((res: any) => {
                    setIsLoading(false);
                    if (res.success) {
                        resolve(getSafeAnalysisData(res.data));
                    } else {
                        setError(res.error || 'Server error');
                        resolve(null);
                    }
                })
                .withFailureHandler((err: any) => {
                    setIsLoading(false);
                    setError(String(err));
                    resolve(null);
                })
                .loadAnalysisData(id);
        });
    }, []);

    // Save
    const saveItem = useCallback(async (name: string, data: AnalysisResult): Promise<boolean> => {
        setIsLoading(true);
        const hasGas = typeof google !== 'undefined' && google?.script?.run;

        const saveToLocal = () => {
            const list = loadLocalSavedResults();
            const newItem: AnalysisStorageItem = {
                id: `local_${Date.now()}`,
                name,
                createdAt: new Date().toISOString(),
                data
            };
            const next = [newItem, ...list];
            saveLocalSavedResults(next);
            setSavedList(mergeSavedLists(next)); // Update state
        };

        if (!hasGas) {
            try {
                const response = await fetch(CASE_ANALYSIS_API, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, data })
                });
                if (response.ok) {
                    await refreshList();
                    setIsLoading(false);
                    return true;
                } else {
                    throw new Error('Server returned error');
                }
            } catch (e) {
                console.warn('Server save failed, saving locally', e);
                saveToLocal();
                setIsLoading(false);
                return true; // Treat local save as success fallback
            }
        }

        return new Promise<boolean>((resolve) => {
            google.script.run
                .withSuccessHandler((res: any) => {
                    if (res.success) {
                        refreshList().then(() => {
                            setIsLoading(false);
                            resolve(true);
                        });
                    } else {
                        // Fallback
                        saveToLocal();
                        setIsLoading(false);
                        resolve(true);
                    }
                })
                .withFailureHandler((err: any) => {
                    // Fallback
                    saveToLocal();
                    setIsLoading(false);
                    resolve(true);
                })
                .saveAnalysisData(name, data);
        });
    }, [refreshList]);

    // Delete
    const deleteItem = useCallback(async (id: string): Promise<boolean> => {
        setIsLoading(true);
        const hasGas = typeof google !== 'undefined' && google?.script?.run;

        const deleteFromLocal = () => {
            const list = loadLocalSavedResults();
            const next = list.filter(item => item.id !== id);
            saveLocalSavedResults(next);
            setSavedList(prev => prev.filter(i => i.id !== id));
        };

        if (!hasGas) {
            try {
                await fetch(`${CASE_ANALYSIS_API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
                await refreshList();
            } catch {
                deleteFromLocal();
            }
            setIsLoading(false);
            return true;
        }

        return new Promise<boolean>((resolve) => {
            google.script.run
                .withSuccessHandler((res: any) => {
                    if (res.success) {
                        setSavedList(prev => prev.filter(item => item.id !== id));
                    } else {
                        deleteFromLocal();
                    }
                    setIsLoading(false);
                    resolve(true);
                })
                .withFailureHandler(() => {
                    deleteFromLocal();
                    setIsLoading(false);
                    resolve(true);
                })
                .deleteAnalysisData(id);
        });
    }, [refreshList]);

    useEffect(() => {
        refreshList();
    }, [refreshList]);

    return {
        savedList,
        isLoading,
        error,
        refreshList,
        loadItem,
        saveItem,
        deleteItem
    };
};

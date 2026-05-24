import { User, Log, Referral, SuicideAttempterReferral, ToDo, CalendarEvent, Note, ActivityLog } from '../types';

import { 
    IspAchievementYearlyResponse, 
    IspDetailLevel 
} from '../components/caseAnalysis/types';

/**
 * [ApiClient] 
 * GAS 레거시를 탈피하고 시놀로지 나스(Port 8888) REST API와 직접 통신하는 현대적인 통신 모듈입니다.
 * 408 타임아웃 방지를 위한 지수 백오프 재시도 로직과 중앙집중형 에러 핸들링을 포함합니다.
 */
class ApiClient {
    private baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
    private loadingListeners: ((isLoading: boolean) => void)[] = [];
    private activeRequests = 0;
    private recentRequests: Map<string, number> = new Map(); // [v5.5] Deduplication


    addLoadingListener(listener: (isLoading: boolean) => void) {
        this.loadingListeners.push(listener);
    }

    removeLoadingListener(listener: (isLoading: boolean) => void) {
        this.loadingListeners = this.loadingListeners.filter(l => l !== listener);
    }

    private notifyLoading(isLoading: boolean) {
        this.loadingListeners.forEach(l => l(isLoading));
    }

    private async wait(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 중앙집중형 요청 처리 함수 (지수 백오프 포함)
     */
    private async request<T>(url: string, options: RequestInit = {}, retryCount = 0): Promise<T> {
        // [v5.5] Request Deduplication for DELETE/POST (prevent ghost errors)
        const requestKey = `${options.method || 'GET'}:${url}`;
        const now = Date.now();
        if (options.method && ['DELETE', 'POST'].includes(options.method)) {
            const lastTime = this.recentRequests.get(requestKey);
            if (lastTime && (now - lastTime < 500)) {
                console.warn(`[API] Deduplicating redundant request: ${requestKey}`);
                return Promise.resolve({ success: true, duplicated: true } as any);
            }
            this.recentRequests.set(requestKey, now);
        }

        if (this.activeRequests === 0) this.notifyLoading(true);
        this.activeRequests++;

        let response: Response | null = null;
        const fullUrl = `${this.baseUrl}${url}`;
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 기본 타임아웃
            
            response = await fetch(fullUrl, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers,
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            // 408 Request Timeout 발생 시 지수 백오프 재시도 (최대 3회)
            if (response.status === 408 && retryCount < 3) {
                console.warn(`[API] 408 Timeout detected. Retrying... (${retryCount + 1}/3)`);
                this.activeRequests--; // 재시도 전 카운트 감소
                const delay = Math.pow(2, retryCount) * 1000;
                await this.wait(delay);
                return this.request<T>(url, options, retryCount + 1);
            }

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return data as T;

        } catch (error: any) {
            console.error(`[API Error] ${options.method || 'GET'} ${fullUrl}:`, error);
            
            // "Failed to fetch" (서버 오프라인) 처리
            if (error instanceof TypeError && error.message === 'Failed to fetch') {
                throw new Error('서버 연결 실패: 백엔드 서버(Port 8889)가 실행 중인지 확인해주세요.');
            }
            
            throw error;
        } finally {
            this.activeRequests--;
            if (this.activeRequests === 0) this.notifyLoading(false);
        }
    }

    // --- 인터페이스 호환성 유지 메서드 (SheetsService와 동일한 시그니처) ---

    // Users
    async getUsers(): Promise<User[]> { return this.request<User[]>('/users'); }
    async createUser(user: User): Promise<any> { return this.request('/users', { method: 'POST', body: JSON.stringify(user) }); }
    async updateUser(user: User): Promise<any> { return this.request('/users', { method: 'PUT', body: JSON.stringify(user) }); }
    async deleteUser(userId: string): Promise<any> { return this.request(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }); }
    async changeMyPassword(userId: string, oldPassword: string, newPassword: string): Promise<any> {
        return this.request('/users/change-password', { method: 'POST', body: JSON.stringify({ userId, oldPassword, newPassword }) });
    }
    async resetUserPassword(adminId: string, targetId: string, newPassword: string): Promise<any> {
        return this.request('/users/reset-password', { method: 'POST', body: JSON.stringify({ adminId, targetId, newPassword }) });
    }
    async importUsers(users: any[]): Promise<any> { 
        return this.request('/users/import', { method: 'POST', body: JSON.stringify(users) }); 
    }

    // Referrals
    async getReferrals(): Promise<Referral[]> { return this.request<Referral[]>('/referrals'); }
    async createReferral(referral: Referral): Promise<any> { return this.request('/referrals', { method: 'POST', body: JSON.stringify(referral) }); }
    async updateReferral(referral: Referral): Promise<any> { return this.request('/referrals', { method: 'PUT', body: JSON.stringify(referral) }); }
    async deleteReferral(id: string): Promise<any> { return this.request(`/referrals/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    async deleteReferralsBulk(ids: string[]): Promise<any> { return this.request('/referrals/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }); }

    // Unregistered (Monitoring)
    async getUnregistered(): Promise<Referral[]> { return this.request<Referral[]>('/unregistered'); }
    async createUnregistered(data: Referral): Promise<any> { return this.request('/unregistered', { method: 'POST', body: JSON.stringify(data) }); }
    async updateUnregistered(data: Referral): Promise<any> { return this.request('/unregistered', { method: 'PUT', body: JSON.stringify(data) }); }
    async deleteUnregistered(id: string): Promise<any> { return this.request(`/unregistered/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

    // Pending Referrals (Website)
    async getPendingReferrals(): Promise<any[]> {
        const rawData = await this.request<any[]>('/pending-referrals');
        return (rawData || []).map(item => ({
            ...item,
            id: item.id || item.externalIdx || `pend_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: item.name || item.SameName || item.requesterName || '이름 미입력',
            phone: item.phone || item.agencyPhone || item.phoneNumber || '',
            age: item.age || '',
            gender: item.gender || '미상',
            createdAt: item.createdAt || new Date().toISOString()
        }));
    }

    // Budget
    async getBudgetHierarchy(): Promise<any[]> { return this.request<any[]>('/budget/hierarchy'); }
    async saveBudgetHierarchy(hierarchy: any[]): Promise<any> { return this.request('/budget/hierarchy', { method: 'POST', body: JSON.stringify(hierarchy) }); }
    async getBudgetPlans(): Promise<Record<string, any>> { return this.request<Record<string, any>>('/budget/plans'); }
    async saveBudgetPlans(plans: Record<string, any>): Promise<any> { return this.request('/budget/plans', { method: 'POST', body: JSON.stringify(plans) }); }
    async getBudgetTransactions(): Promise<any[]> { return this.request<any[]>('/budget/transactions'); }
    async saveBudgetTransactions(transactions: any[]): Promise<any> { return this.request('/budget/transactions', { method: 'POST', body: JSON.stringify(transactions) }); }
    async getBudgetMetadata(): Promise<any> { return this.request('/budget/metadata'); }
    async saveBudgetMetadata(metadata: any): Promise<any> { return this.request('/budget/metadata', { method: 'POST', body: JSON.stringify(metadata) }); }

    // Trash
    async getTrash(): Promise<any[]> { return this.request<any[]>('/trash'); }
    async restoreTrash(id: string): Promise<any> { return this.request('/trash/restore', { method: 'POST', body: JSON.stringify({ id }) }); }
    async permanentDelete(id: string): Promise<any> { return this.request(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

    // Notes
    async saveNotes(refNo: string, notes: Note[]): Promise<any> { return this.request('/saveNotes', { method: 'POST', body: JSON.stringify({ refNo, notes }) }); }

    // Logs
    async getLogs(): Promise<Log[]> { return this.request<Log[]>('/logs'); }
    async createLog(log: Log | ActivityLog): Promise<any> { return this.request('/logs', { method: 'POST', body: JSON.stringify(log) }); }
    async updateLog(log: Log): Promise<any> { return this.request('/logs', { method: 'PUT', body: JSON.stringify(log) }); }
    async logActivity(user: string, action: string, details: string): Promise<any> {
        const activityLog: ActivityLog = {
            id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            user, action, details,
            timestamp: new Date().toLocaleString('ko-KR')
        };
        return this.createLog(activityLog);
    }

    // Suicide Attempters
    async getSuicideAttempters(): Promise<SuicideAttempterReferral[]> { return this.request<SuicideAttempterReferral[]>('/suicideattempters'); }
    async createSuicideAttempter(sa: SuicideAttempterReferral): Promise<any> { return this.request('/suicideattempters', { method: 'POST', body: JSON.stringify(sa) }); }
    async updateSuicideAttempter(sa: SuicideAttempterReferral): Promise<any> { return this.request('/suicideattempters', { method: 'PUT', body: JSON.stringify(sa) }); }
    async deleteSuicideAttempter(id: string): Promise<any> { return this.request(`/suicideattempters/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    async deleteSuicideAttemptersBulk(uids: string[]): Promise<any> { return this.request('/suicideattempters/bulk-delete', { method: 'POST', body: JSON.stringify({ uids }) }); }

    // Misc
    async getAnalysisCurrent(): Promise<any> { try { return await this.request('/analysis/current'); } catch { return null; } }
    async saveAnalysisCurrent(data: any): Promise<any> { return this.request('/analysis/current', { method: 'POST', body: JSON.stringify({ data }) }); }
    async getISPAchievement(month: string): Promise<any> { 
        return this.request(`/analysis/isp-achievement?month=${encodeURIComponent(month)}`); 
    }

    async getISPAchievementYearly(
        year: string | number,
        options?: {
            detailLevel?: IspDetailLevel;
            signal?: AbortSignal;
        }
    ): Promise<IspAchievementYearlyResponse> {
        const detailLevel = options?.detailLevel || 'summary';
        const query = new URLSearchParams({
            year: String(year),
            detailLevel
        });

        return this.request<IspAchievementYearlyResponse>(`/analysis/isp-achievement-yearly?${query.toString()}`, {
            signal: options?.signal
        });
    }
    
    // ToDos & Calendar
    async getTodos(): Promise<ToDo[]> { return this.request<ToDo[]>('/todos'); }
    async createTodo(todo: ToDo): Promise<any> { return this.request('/todos', { method: 'POST', body: JSON.stringify(todo) }); }
    async updateTodo(todo: ToDo): Promise<any> { return this.request('/todos', { method: 'PUT', body: JSON.stringify(todo) }); }
    async deleteTodo(id: string): Promise<any> { return this.request(`/todos/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    
    async getCalendarEvents(start: string, end: string): Promise<CalendarEvent[]> { 
        return this.request<CalendarEvent[]>(`/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`); 
    }
    async createCalendarEvent(event: any): Promise<any> { return this.request('/calendar', { method: 'POST', body: JSON.stringify(event) }); }
    async deleteCalendarEvent(id: string): Promise<any> { return this.request(`/calendar/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

    // Files
    async uploadFile(data: any): Promise<any> { return this.request('/upload', { method: 'POST', body: JSON.stringify(data) }); }
    async deleteFile(folder: string, fileId: string): Promise<any> { 
        return this.request(`/deleteFile/${encodeURIComponent(folder)}/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); 
    }

    // Official Documents
    async getOfficialDocuments(): Promise<any[]> { return this.request<any[]>('/official-documents'); }
    async syncOfficialDocumentEmails(start: string, end: string): Promise<string> {
        const result = await this.request<{ message: string }>('/official-documents/sync', {
            method: 'POST',
            body: JSON.stringify({ start, end })
        });
        return result.message;
    }
    async updateOfficialDocumentStatus(mailId: string, status: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('/official-documents/status', {
            method: 'POST',
            body: JSON.stringify({ mailId, status })
        });
        return result.success;
    }

    // AI
    async callGeminiApi(prompt: string): Promise<string> {
        const result = await this.request<{ response: string }>('/ai/gemini', { 
            method: 'POST', 
            body: JSON.stringify({ prompt }) 
        });
        return result.response;
    }
    
    /**
     * Stage 2: Data Synchronization & Comparison Logic
     * 홈페이지 인입 데이터와 기존 의뢰대장을 비교하여 동기화합니다.
     */
    async syncRequest(incoming: any, existingReferrals: Referral[]): Promise<{ updated: boolean; alert: boolean; error?: string }> {
        try {
            if (!incoming.name || !incoming.age || !incoming.phone) {
                console.warn('[Sync] 필수 데이터(이름, 연령, 연락처)가 누락되어 동기화를 건너뜁니다:', incoming);
                return { updated: false, alert: false };
            }

            const incomingName = incoming.name.trim();
            const incomingAge = Number(incoming.age);
            const incomingPhone = (incoming.phone || '').replace(/[^0-9]/g, '');
            const incomingDate = incoming.requestDate || incoming.registrationDate;

            // 1. 이름, 연령, 연락처가 일치하는 기존 기록 찾기
            const match = existingReferrals.find(r => 
                r.name.trim() === incomingName && 
                Number(r.age) === incomingAge && 
                (r.phone || '').replace(/[^0-9]/g, '') === incomingPhone
            );

            if (match) {
                // 2. 의뢰날짜까지 동일한지 확인
                if (match.requestDate === incomingDate) {
                    // 동일 기록: 대장 업데이트 (필요 시) 후 알림 스킵
                    console.log(`[Sync] Match found (Same Date): ${incomingName}. Updating record, skipping alert.`);
                    await this.updateReferral({ ...match, ...incoming, refNo: match.refNo });
                    return { updated: true, alert: false };
                } else {
                    // 날짜 다름: 대장 업데이트 후 알림 생성
                    console.log(`[Sync] Match found (Different Date): ${incomingName}. Updating record, triggering alert.`);
                    await this.updateReferral({ ...match, ...incoming, refNo: match.refNo });
                    return { updated: true, alert: true };
                }
            } else {
                // 3. 신규 기록: 생성 후 알림 생성
                console.log(`[Sync] No match found: ${incomingName}. Creating new record, triggering alert.`);
                return { updated: false, alert: true };
            }
        } catch (error) {
            console.error('[Sync] Error during syncRequest:', error);
            return { updated: false, alert: true, error: String(error) };
        }
    }

    // 호환성 유지용 빈 함수
    isAvailable(): boolean { return true; }
}

export const apiClient = new ApiClient();

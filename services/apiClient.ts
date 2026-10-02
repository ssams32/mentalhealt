import { User, Log, Referral, SuicideAttempterReferral, ToDo, CalendarEvent, Note, ActivityLog, WebsiteReferralSummary } from '../types';

import {
    IspAchievementYearlyResponse,
    IspDetailLevel
} from '../components/caseAnalysis/types';

type SessionExpiredHandler = () => void;
let sessionExpiredHandler: SessionExpiredHandler | null = null;
let isSessionExpiredNotified = false;

export function registerSessionExpiredHandler(handler: SessionExpiredHandler) {
    sessionExpiredHandler = handler;
}

export function notifySessionExpired() {
    if (!isSessionExpiredNotified) {
        isSessionExpiredNotified = true;
        if (sessionExpiredHandler) {
            sessionExpiredHandler();
        }
    }
}

export function resetSessionExpiredGuard() {
    isSessionExpiredNotified = false;
}

/**
 * [ApiClient]
 * GAS 레거시를 탈피하고 시놀로지 나스(Port 8888) REST API와 직접 통신하는 현대적인 통신 모듈입니다.
 * 408 타임아웃 방지를 위한 지수 백오프 재시도 로직과 중앙집중형 에러 핸들링을 포함합니다.
 */
class ApiClient {
    private baseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
    private loadingListeners: ((isLoading: boolean) => void)[] = [];
    private activeRequests = 0;


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

    private getAuthHeaders(): Record<string, string> {
        const headers: Record<string, string> = {};
        try {
            if (typeof window !== 'undefined' && window.sessionStorage) {
                const saved = window.sessionStorage.getItem('currentUser');
                if (saved) {
                    const user = JSON.parse(saved);
                    if (user?.id) headers['x-user-id'] = user.id;
                    if (user?.role) headers['x-user-role'] = user.role;
                    if (user?.team) headers['x-user-team'] = encodeURIComponent(user.team);
                }
            }
        } catch (ignore) {}
        return headers;
    }

    /**
     * 중앙집중형 요청 처리 함수
     */
    private async request<T>(url: string, options: RequestInit = {}, retryCount = 0): Promise<T> {
        if (this.activeRequests === 0) this.notifyLoading(true);
        this.activeRequests++;

        let response: Response | null = null;
        const fullUrl = `${this.baseUrl}${url}`;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 기본 타임아웃

            response = await fetch(fullUrl, {
                credentials: 'include',
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...this.getAuthHeaders(),
                    ...options.headers,
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 408 Request Timeout 처리:
            // GET 요청이거나 Idempotency-Key 헤더가 명시된 경우에만 안전하게 재시도 (최대 3회)
            const isIdempotent = !options.method || options.method === 'GET' || (options.headers && (options.headers as any)['Idempotency-Key']);
            if (response.status === 408 && isIdempotent && retryCount < 3) {
                console.warn(`[API] 408 Timeout detected on idempotent request. Retrying... (${retryCount + 1}/3)`);
                this.activeRequests--;
                const delay = Math.pow(2, retryCount) * 1000 + Math.floor(Math.random() * 200);
                await this.wait(delay);
                return this.request<T>(url, options, retryCount + 1);
            }

            if (!response.ok) {
                if (response.status === 401) {
                    const isAuthBypassUrl = url === '/auth/login' || url === '/auth/logout' || url === '/auth/me';
                    if (!isAuthBypassUrl) {
                        notifySessionExpired();
                    }
                }

                let errorBody: any = null;
                try {
                    errorBody = await response.json();
                } catch (ignore) {}

                const structuredError = errorBody?.error;
                let errMsg: string;
                if (typeof structuredError === 'string') {
                    errMsg = structuredError;
                } else if (typeof structuredError?.message === 'string') {
                    errMsg = structuredError.message;
                } else if (typeof errorBody?.message === 'string') {
                    errMsg = errorBody.message;
                } else {
                    errMsg = `HTTP Error: ${response.status} ${response.statusText}`;
                }
                const err = new Error(errMsg) as any;
                err.status = response.status;
                err.code = structuredError?.code || errorBody?.code;
                err.serverItem = structuredError?.serverItem || errorBody?.serverItem;
                err.currentVersion = structuredError?.currentVersion || errorBody?.currentVersion;
                throw err;
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

    // --- 인터페이스 호환성 유지 메서드 ---

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
    async patchVoiceAccess(userId: string, granted: boolean): Promise<any> {
        return this.request(`/users/${encodeURIComponent(userId)}/voice-access`, {
            method: 'PATCH',
            body: JSON.stringify({ granted })
        });
    }
    async patchOnlineSurveyAccess(userId: string, granted: boolean): Promise<any> {
        return this.request(`/users/${encodeURIComponent(userId)}/online-survey-access`, {
            method: 'PATCH',
            body: JSON.stringify({ granted })
        });
    }

    // Referrals
    async getReferrals(params?: { team?: string; closureStatus?: string; registrationStatus?: string; view?: string }): Promise<Referral[]> {
        let query = '';
        if (params) {
            const searchParams = new URLSearchParams();
            if (params.team) searchParams.set('team', params.team);
            if (params.closureStatus) searchParams.set('closureStatus', params.closureStatus);
            if (params.registrationStatus) searchParams.set('registrationStatus', params.registrationStatus);
            if (params.view) searchParams.set('view', params.view);
            const qs = searchParams.toString();
            if (qs) query = `?${qs}`;
        }
        return this.request<Referral[]>(`/referrals${query}`);
    }

    async createReferral(referral: Partial<Referral>, idempotencyKey?: string): Promise<{ success: boolean; data: Referral }> {
        const headers: Record<string, string> = {};
        const effectiveKey = idempotencyKey || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        headers['Idempotency-Key'] = effectiveKey;

        return this.request<{ success: boolean; data: Referral }>('/referrals', {
            method: 'POST',
            headers,
            body: JSON.stringify(referral)
        });
    }

    async updateReferral(referral: Partial<Referral>, idempotencyKey?: string): Promise<{ success: boolean; data: Referral }> {
        const targetId = referral.referralId || referral.refNo || referral.clientId;
        const url = targetId ? `/referrals/${encodeURIComponent(targetId)}` : '/referrals';
        const headers: Record<string, string> = {};
        if (idempotencyKey) {
            headers['Idempotency-Key'] = idempotencyKey;
        }
        return this.request<{ success: boolean; data: Referral }>(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify(referral)
        });
    }

    async deleteReferral(id: string): Promise<any> {
        return this.request(`/referrals/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async deleteReferralsBulk(ids: string[]): Promise<any> {
        return this.request('/referrals/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    }

    async saveNotes(refNo: string, notes: any[], referralId?: string, idempotencyKey?: string, version?: number): Promise<{ success: boolean; data: Referral }> {
        const headers: Record<string, string> = {};
        if (idempotencyKey) {
            headers['Idempotency-Key'] = idempotencyKey;
        }
        return this.request<{ success: boolean; data: Referral }>('/saveNotes', {
            method: 'POST',
            headers,
            body: JSON.stringify({ refNo, notes, referralId, version })
        });
    }

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

    // Website Referrals (External imhc.co.kr sync & 9월 notification)
    async getWebsiteReferralsSummary(): Promise<WebsiteReferralSummary> {
        return this.request<WebsiteReferralSummary>('/website-referrals/summary');
    }

    async syncWebsiteReferrals(): Promise<WebsiteReferralSummary> {
        return this.request<WebsiteReferralSummary>('/website-referrals/sync', {
            method: 'POST'
        });
    }

    async markWebsiteReferralsSeen(ids?: string[]): Promise<WebsiteReferralSummary> {
        return this.request<WebsiteReferralSummary>('/website-referrals/mark-seen', {
            method: 'POST',
            body: JSON.stringify({ ids })
        });
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
        // Dual audit logging: /activity (dedicated ActivityLogs.json) & /logs fallback
        try {
            await this.request('/activity', { method: 'POST', body: JSON.stringify({ user, action, details }) });
        } catch (e) {
            console.warn('[AuditLog] /activity failed, falling back to /logs:', e);
        }
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
            // 이름조차 없는 완전 유효하지 않은 데이터만 필터링하도록 완화
            if (!incoming || !incoming.name) {
                console.warn('[Sync] 필수 데이터(이름)가 누락되어 동기화를 건너뜁니다:', incoming);
                return { updated: false, alert: false };
            }

            const incomingName = incoming.name.trim();
            const incomingAge = Number(incoming.age) || 0;
            const incomingPhone = (incoming.phone || '').replace(/[^0-9]/g, '');
            const incomingDate = incoming.requestDate || incoming.registrationDate;

            // 1. 이름과 나이가 일치하는 기존 의뢰대장 기록 찾기 (나이/이름 대조)
            // 나이가 0인 유효하지 않은 항목은 대조군에서 제외하여 중복 스킵 버그 방지
            const samePersonMatches = existingReferrals.filter(r =>
                r.name.trim() === incomingName &&
                (incomingAge > 0 ? Number(r.age) === incomingAge : true)
            );

            if (samePersonMatches.length > 0 && incomingAge > 0) {
                // 2. 이미 등록되어 있는 사람 중, 연락처가 같거나 30일(약 한 달) 이내에 이중 의뢰된 건이 있는지 체크
                const isDuplicateOrRecent = samePersonMatches.some(r => {
                    const existingPhone = (r.phone || '').replace(/[^0-9]/g, '');
                    if (incomingPhone && existingPhone && incomingPhone === existingPhone) {
                        return true;
                    }

                    if (r.requestDate && incomingDate) {
                        const d1 = new Date(r.requestDate);
                        const d2 = new Date(incomingDate);
                        if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
                            const diffTime = Math.abs(d2.getTime() - d1.getTime());
                            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                            if (diffDays <= 30) {
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (isDuplicateOrRecent) {
                    console.log(`[Sync] Skip alert for duplicate or recent referral within 30 days: ${incomingName}`);
                    const match = samePersonMatches[0];
                    await this.updateReferral({ ...match, ...incoming, refNo: match.refNo });
                    return { updated: true, alert: false };
                }
            }

            // 3. 신규 기록 또는 검증에 안 걸린 항목: 알림 생성 허용
            console.log(`[Sync] Triggering alert for: ${incomingName}`);
            return { updated: false, alert: true };
        } catch (error) {
            console.error('[Sync] Error during syncRequest:', error);
            // 에러 시 동기화를 차단하지 않고 무조건 알림창에 렌더링되도록 true 반환
            return { updated: false, alert: true, error: String(error) };
        }
    }

    // ──────────────────────────────────────────────────────────
    // [Track A1 & A2] Authentication & Capability API
    // ──────────────────────────────────────────────────────────
    async login(username: string, password: string): Promise<{ success: boolean; user: User }> {
        return this.request<{ success: boolean; user: User }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
    }

    async logout(): Promise<{ success: boolean; message: string }> {
        return this.request<{ success: boolean; message: string }>('/auth/logout', {
            method: 'POST'
        });
    }

    async getMe(): Promise<{ success: boolean; user: User }> {
        return this.request<{ success: boolean; user: User }>('/auth/me');
    }

    async getVoiceCapabilities(): Promise<{ success: boolean; user: User; capabilities: string[] }> {
        return this.request<{ success: boolean; user: User; capabilities: string[] }>('/auth/capabilities');
    }

    // ──────────────────────────────────────────────────────────
    // [Voice Calls] 상담/행정전화 관리 API
    // ──────────────────────────────────────────────────────────
    async getVoiceCalls(params?: {
        tab?: string;
        category?: string;
        assignment?: string;
        search?: string;
        startDate?: string;
        endDate?: string;
        department?: string;
    }): Promise<{ total: number; calls: any[] }> {
        const query = new URLSearchParams();
        if (params) {
            Object.entries(params).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') query.append(k, String(v));
            });
        }
        const qs = query.toString() ? `?${query.toString()}` : '';
        return this.request<{ total: number; calls: any[] }>(`/voice-calls${qs}`);
    }

    async getVoiceCallStats(): Promise<{
        total: number;
        pendingClassification: number;
        administrative: number;
        individualCounseling: number;
        intakeCounseling: number;
        totalCounseling: number;
        unassigned: number;
        assigned: number;
        linkedToReferral: number;
    }> {
        return this.request('/voice-calls/stats');
    }

    async getVoiceCall(id: string): Promise<any> {
        return this.request(`/voice-calls/${id}`);
    }

    async classifyVoiceCall(id: string, data: {
        callRecordType: 'administrative_call' | 'individual_counseling' | 'intake_counseling';
        notes?: string;
        callerPhoneNumber?: string;
        clientName?: string;
    }): Promise<{ success: boolean; message: string; call: any }> {
        return this.request(`/voice-calls/${id}/classify`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async assignVoiceCall(id: string, data: {
        assignedDepartmentId?: string;
        assignedUserId?: string;
        assignedUserName?: string;
    }): Promise<{ success: boolean; message: string; call: any }> {
        return this.request(`/voice-calls/${id}/assign`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async linkVoiceCall(id: string, data: {
        referralId?: string;
        refNo?: string;
        clientId?: string;
        clientName?: string;
    }): Promise<{ success: boolean; message: string; call: any }> {
        return this.request(`/voice-calls/${id}/link`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async syncVoiceCalls(): Promise<{
        success: boolean;
        message: string;
        scanned: number;
        imported: number;
        skipped: number;
    }> {
        return this.request('/voice-calls/sync', {
            method: 'POST'
        });
    }

    async seedSampleVoiceCalls(): Promise<{
        success: boolean;
        message: string;
        count: number;
    }> {
        return this.request('/voice-calls/seed-samples', {
            method: 'POST'
        });
    }

    // ──────────────────────────────────────────────────────────
    // [Track B: Surveys] 온라인 설문 수신 및 관리 API
    // ──────────────────────────────────────────────────────────
    async getSurveyStatus(): Promise<any> {
        return this.request('/surveys/status');
    }

    async importOnlineSurveys(options?: number | { batchSize?: number; maxItems?: number }): Promise<{
        success: boolean;
        message: string;
        summary: {
            jobId?: string;
            batchId: string;
            discovered?: number;
            totalFetched: number;
            imported: number;
            reused?: number;
            duplicates: number;
            failed?: number;
            quarantined: number;
            acknowledged?: number;
            deleted?: number;
            skipped?: number;
            stopReason?: string;
            ackPending: number;
            deletePending: number;
        };
    }> {
        const body = typeof options === 'number'
            ? { limit: options }
            : (options || {});
        return this.request('/surveys/import', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async getSurveySyncStatus(): Promise<{
        success: boolean;
        autoSyncEnabled: boolean;
        intervalMinutes: number;
        batchSize: number;
        maxItems: number;
        isRunning: boolean;
        lastSyncAt: string | null;
        lastResult: string | null;
        nextScheduledAt: string | null;
        lastImportedCount: number;
        lastFailedCount: number;
    }> {
        return this.request('/surveys/sync-status');
    }

    async getSurveyImports(params?: {
        fromDate?: string;
        toDate?: string;
        sortBy?: string;
        statusFilter?: string;
        staffFilter?: string;
        campaignFilter?: string;
        q?: string;
    }): Promise<{ total: number; imports: any[] }> {
        const queryParams = new URLSearchParams();
        if (params) {
            if (params.fromDate) queryParams.set('fromDate', params.fromDate);
            if (params.toDate) queryParams.set('toDate', params.toDate);
            if (params.sortBy) queryParams.set('sortBy', params.sortBy);
            if (params.statusFilter) queryParams.set('statusFilter', params.statusFilter);
            if (params.staffFilter) queryParams.set('staffFilter', params.staffFilter);
            if (params.campaignFilter && params.campaignFilter !== 'all') queryParams.set('campaignFilter', params.campaignFilter);
            if (params.q) queryParams.set('q', params.q);
        }
        const qs = queryParams.toString();
        return this.request(`/surveys/imports${qs ? `?${qs}` : ''}`);
    }

    async getSurveySubmission(id: string): Promise<{ submission: any }> {
        return this.request(`/surveys/submissions/${id}`);
    }

    async retrySurveyDeletions(): Promise<{ success: boolean; result: { total: number; succeeded: number; failed: number } }> {
        return this.request('/surveys/retry-deletions', {
            method: 'POST'
        });
    }

    async getSurveyAssignableStaff(): Promise<{
        staff: Array<{
            id: string;
            name: string;
            team: string;
            role: string;
            pendingAssignmentCount?: number;
            myAssignedPendingCount?: number;
        }>
    }> {
        return this.request('/surveys/assignable-staff');
    }

    async assignSurveyStaff(id: string, payload: {
        assignedUserId: string;
        assignedDepartmentId?: string;
        assignmentPriority?: 'NORMAL' | 'PRIORITY_REVIEW' | 'IMMEDIATE_REVIEW';
        expectedVersion?: number;
        reason?: string;
    }): Promise<{ success: boolean; message: string; submission: any }> {
        return this.request(`/surveys/${id}/assign`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async reassignSurveyStaff(id: string, payload: {
        assignedUserId: string;
        assignedDepartmentId?: string;
        assignmentPriority?: 'NORMAL' | 'PRIORITY_REVIEW' | 'IMMEDIATE_REVIEW';
        expectedVersion?: number;
        reason?: string;
    }): Promise<{ success: boolean; message: string; submission: any }> {
        return this.request(`/surveys/${id}/reassign`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async bulkAssignSurveys(payload: {
        submissionIds: string[];
        targetUserId: string;
        mode?: 'unassigned-only' | 'include-reassignment';
        note?: string;
    }): Promise<{
        requested: number;
        assigned: number;
        reassigned: number;
        skipped: number;
        failed: number;
        results: Array<{ submissionId: string; status: 'ASSIGNED' | 'REASSIGNED' | 'SKIPPED' | 'FAILED'; reasonCode: string }>;
        bulkRequestId?: string;
    }> {
        return this.request('/surveys/bulk-assign', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async unassignSurveyStaff(id: string, reason?: string): Promise<{ success: boolean; message: string; submission: any }> {
        return this.request(`/surveys/${id}/unassign`, {
            method: 'POST',
            body: JSON.stringify({ reason })
        });
    }

    async updateSurveyConsultationStatus(id: string, payload: {
        consultationStatus: string;
        note?: string;
    }): Promise<{ success: boolean; message: string; submission: any }> {
        return this.request(`/surveys/${id}/consultation-status`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async getSurveyAssignmentHistory(id: string): Promise<{ history: any[] }> {
        return this.request(`/surveys/${id}/assignment-history`);
    }

    async getSurveyReferralDraft(id: string): Promise<{ success: boolean; isAlreadyRegistered?: boolean; existingReferralId?: string; refNo?: string; draft?: any }> {
        return this.request(`/surveys/submissions/${encodeURIComponent(id)}/referral-draft`);
    }

    async downloadSurveyExport(filters: Record<string, string> = {}): Promise<{ blob: Blob; filename: string }> {
        const queryParams = new URLSearchParams();
        Object.entries(filters).forEach(([k, v]) => {
            if (v && v !== 'all') queryParams.append(k, v);
        });
        const url = `${this.baseUrl}/surveys/export${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;

        const resp = await fetch(url, {
            credentials: 'include',
            headers: {
                ...this.getAuthHeaders()
            }
        });

        if (!resp.ok) {
            let errorMsg = `Export failed with HTTP ${resp.status}`;
            try {
                const errJson = await resp.json();
                errorMsg = errJson.error?.message || errJson.message || errorMsg;
            } catch (ignore) {}
            throw new Error(errorMsg);
        }

        const disposition = resp.headers.get('Content-Disposition');
        let filename = 'online-surveys.xlsx';
        if (disposition && disposition.includes('filename=')) {
            const match = disposition.match(/filename="?([^"]+)"?/);
            if (match && match[1]) filename = match[1];
        }

        const blob = await resp.blob();
        return { blob, filename };
    }

    async purgeDemoSurveysDryRun(reason: string = '더미 데이터 삭제 계획 확인'): Promise<{ success: boolean; plan: any }> {
        return this.request('/surveys/admin/purge-demo/dry-run', {
            method: 'POST',
            body: JSON.stringify({ reason })
        });
    }

    async purgeDemoSurveys(reason: string, confirmation: string): Promise<{ success: boolean; message: string; result: any }> {
        return this.request('/surveys/admin/purge-demo', {
            method: 'POST',
            body: JSON.stringify({ reason, confirmation })
        });
    }

    async deleteSurveySubmission(id: string, reason: string, confirmSubmissionId?: string): Promise<{ success: boolean; message: string; result: any }> {
        return this.request(`/surveys/admin/submissions/${id}`, {
            method: 'DELETE',
            body: JSON.stringify({ reason, confirmSubmissionId: confirmSubmissionId || id })
        });
    }

    async softDeleteSurveySubmission(id: string, reason: string, confirmSubmissionId?: string): Promise<{ success: boolean; message: string; result: any }> {
        return this.request(`/surveys/submissions/${id}/soft-delete`, {
            method: 'POST',
            body: JSON.stringify({ reason, confirmSubmissionId: confirmSubmissionId || id })
        });
    }

    async getTrashSurveySubmissions(): Promise<{ success: boolean; total: number; submissions: any[] }> {
        return this.request('/surveys/admin/trash');
    }

    async restoreSurveySubmission(id: string): Promise<{ success: boolean; message: string; submission: any }> {
        return this.request(`/surveys/admin/submissions/${id}/restore`, {
            method: 'POST'
        });
    }

    // ──────────────────────────────────────────────────────────
    // [Track B: Campaigns] 온라인 설문 캠페인 관리 API
    // ──────────────────────────────────────────────────────────
    async getSurveyCampaigns(): Promise<{
        total: number;
        campaigns: Array<{
            code: string;
            companyName: string;
            purpose: string | null;
            startsAt: string | null;
            endsAt: string | null;
            isActive: boolean;
            isRegistered: boolean;
            campaignRegistrationStatus: 'REGISTERED' | 'UNREGISTERED';
            receivedCount: number;
            pendingReviewCount: number;
            registeredReferralCount: number;
            completedCount: number;
            counts: {
                receivedCount: number;
                pendingReviewCount: number;
                registeredReferralCount: number;
                completedCount: number;
            };
        }>;
        unspecifiedCounts: {
            receivedCount: number;
            pendingReviewCount: number;
            registeredReferralCount: number;
            completedCount: number;
        };
        totalCounts: {
            receivedCount: number;
            pendingReviewCount: number;
            registeredReferralCount: number;
            completedCount: number;
        };
    }> {
        return this.request('/surveys/campaigns');
    }

    async createSurveyCampaign(payload: {
        code: string;
        companyName: string;
        purpose: string;
        startsAt?: string | null;
        endsAt?: string | null;
        isActive?: boolean;
    }): Promise<{ success: boolean; campaign: any }> {
        return this.request('/surveys/campaigns', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async updateSurveyCampaign(code: string, payload: {
        companyName?: string;
        purpose?: string;
        startsAt?: string | null;
        endsAt?: string | null;
        isActive?: boolean;
    }): Promise<{ success: boolean; campaign: any }> {
        return this.request(`/surveys/campaigns/${encodeURIComponent(code)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
        });
    }

    // ──────────────────────────────────────────────────────────
    // [Track B: Notifications] 사내 인앱 알림 API
    // ──────────────────────────────────────────────────────────
    async getInternalNotifications(params: { limit?: number; includeRead?: boolean } = {}): Promise<{ notifications: any[] }> {
        const query = new URLSearchParams();
        if (params.limit) query.append('limit', String(params.limit));
        if (params.includeRead !== undefined) query.append('includeRead', String(params.includeRead));
        const qs = query.toString();
        return this.request(`/notifications${qs ? `?${qs}` : ''}`);
    }

    async getUnreadNotificationCount(): Promise<{ unreadCount: number }> {
        return this.request('/notifications/unread-count');
    }

    async markNotificationAsRead(id: string): Promise<{ success: boolean; notification: any }> {
        return this.request(`/notifications/${id}/read`, {
            method: 'POST'
        });
    }

    async markAllNotificationsAsRead(): Promise<{ success: boolean; updatedCount: number }> {
        return this.request('/notifications/read-all', {
            method: 'POST'
        });
    }

    async dismissNotification(id: string): Promise<{ success: boolean }> {
        return this.request(`/notifications/${id}/dismiss`, {
            method: 'POST'
        });
    }

    // 호환성 유지용 빈 함수
    isAvailable(): boolean { return true; }
}

/**
 * [Campaign Link Helper]
 * Track A 설문 기본 URL과 캠페인 코드를 결합하여 배포 링크를 안전하게 생성합니다.
 * 환경 변수(VITE_TRACK_A_BASE_URL 등) 또는 전달된 기본 URL을 기반으로 생성하며,
 * 배포 주소가 미설정된 경우 빈 문자열을 반환합니다 (fail-closed).
 */
export function buildCampaignDistributionUrl(campaignCode: string, customBaseUrl?: string): string {
    if (!campaignCode || typeof campaignCode !== 'string') return '';
    const cleanCode = campaignCode.trim().toUpperCase();
    if (!cleanCode) return '';
    const encoded = encodeURIComponent(cleanCode);

    let baseUrl = (customBaseUrl && customBaseUrl.trim()) ||
        (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_TRACK_A_BASE_URL) ||
        (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SURVEY_BASE_URL) ||
        (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SURVEY_URL) ||
        '';

    if (!baseUrl) return '';

    baseUrl = baseUrl.replace(/\/+$/, '');
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}c=${encoded}`;
}

/**
 * [Campaign Label Helper]
 * 접수 항목의 캠페인 상태에 따른 레이블 및 스타일 분류를 반환합니다.
 */
export function getCampaignLabelInfo(item: {
    campaignCode?: string | null;
    campaignName?: string | null;
    campaignRegistrationStatus?: string | null;
}): {
    label: string;
    code: string | null;
    type: 'registered' | 'unregistered' | 'unspecified';
    isWarning: boolean;
} {
    const code = item?.campaignCode ? String(item.campaignCode).trim().toUpperCase() : null;
    if (!code) {
        return {
            label: '미지정',
            code: null,
            type: 'unspecified',
            isWarning: false
        };
    }

    if (item.campaignRegistrationStatus === 'UNREGISTERED') {
        return {
            label: '미등록 캠페인',
            code,
            type: 'unregistered',
            isWarning: true
        };
    }

    const companyName = item.campaignName && item.campaignName.trim() ? item.campaignName.trim() : code;
    return {
        label: companyName,
        code,
        type: 'registered',
        isWarning: false
    };
}

export { ApiClient };
export const apiClient = new ApiClient();

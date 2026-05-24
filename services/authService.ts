/**
 * Auth Service - JWT Token Management for Flask Backend
 * Handles login, logout, token storage, and automatic refresh
 */

interface AuthTokens {
    access_token: string;
    refresh_token: string;
}

interface LoginResponse {
    success: boolean;
    access_token?: string;
    refresh_token?: string;
    user?: any;
    error?: string;
}

class AuthService {
    private static readonly ACCESS_TOKEN_KEY = 'flask_access_token';
    private static readonly REFRESH_TOKEN_KEY = 'flask_refresh_token';
    private static readonly USER_KEY = 'flask_current_user';

    // Flask backend URL - change this for production
    private apiBase = import.meta.env.VITE_FLASK_API_URL || 'http://localhost:5000';

    /**
     * Login with user credentials
     */
    async login(id: string, password: string): Promise<LoginResponse> {
        try {
            const response = await fetch(`${this.apiBase}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, password })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                this.setTokens({
                    access_token: data.access_token,
                    refresh_token: data.refresh_token
                });
                this.setUser(data.user);
                return data;
            }

            return { success: false, error: data.error || 'Login failed' };
        } catch (error) {
            console.error('Login error:', error);
            return { success: false, error: String(error) };
        }
    }

    /**
     * Logout - clear tokens and notify server
     */
    async logout(): Promise<void> {
        try {
            const token = this.getAccessToken();
            if (token) {
                await fetch(`${this.apiBase}/api/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
            }
        } catch (e) {
            console.warn('Logout notification failed:', e);
        } finally {
            this.clearTokens();
        }
    }

    /**
     * Refresh access token using refresh token
     */
    async refreshAccessToken(): Promise<boolean> {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) return false;

        try {
            const response = await fetch(`${this.apiBase}/api/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${refreshToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                localStorage.setItem(AuthService.ACCESS_TOKEN_KEY, data.access_token);
                return true;
            }

            // Refresh failed - clear tokens
            this.clearTokens();
            return false;
        } catch (error) {
            console.error('Token refresh failed:', error);
            return false;
        }
    }

    /**
     * Get authorization header for API calls
     */
    getAuthHeader(): Record<string, string> {
        const token = this.getAccessToken();
        return token ? { 'Authorization': `Bearer ${token}` } : {};
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated(): boolean {
        return !!this.getAccessToken();
    }

    /**
     * Get current user from storage
     */
    getCurrentUser(): any | null {
        const userStr = localStorage.getItem(AuthService.USER_KEY);
        return userStr ? JSON.parse(userStr) : null;
    }

    // Token storage helpers
    private setTokens(tokens: AuthTokens): void {
        localStorage.setItem(AuthService.ACCESS_TOKEN_KEY, tokens.access_token);
        localStorage.setItem(AuthService.REFRESH_TOKEN_KEY, tokens.refresh_token);
    }

    private setUser(user: any): void {
        localStorage.setItem(AuthService.USER_KEY, JSON.stringify(user));
    }

    getAccessToken(): string | null {
        return localStorage.getItem(AuthService.ACCESS_TOKEN_KEY);
    }

    private getRefreshToken(): string | null {
        return localStorage.getItem(AuthService.REFRESH_TOKEN_KEY);
    }

    private clearTokens(): void {
        localStorage.removeItem(AuthService.ACCESS_TOKEN_KEY);
        localStorage.removeItem(AuthService.REFRESH_TOKEN_KEY);
        localStorage.removeItem(AuthService.USER_KEY);
    }

    /**
     * Make authenticated API call with automatic token refresh
     */
    async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
        const headers = {
            'Content-Type': 'application/json',
            ...this.getAuthHeader(),
            ...(options.headers || {})
        };

        let response = await fetch(url, { ...options, headers });

        // If 401, try to refresh token and retry
        if (response.status === 401) {
            const refreshed = await this.refreshAccessToken();
            if (refreshed) {
                const newHeaders = {
                    ...headers,
                    ...this.getAuthHeader()
                };
                response = await fetch(url, { ...options, headers: newHeaders });
            }
        }

        return response;
    }

    /**
     * Get Flask API base URL
     */
    getApiBase(): string {
        return this.apiBase;
    }
}

export const authService = new AuthService();

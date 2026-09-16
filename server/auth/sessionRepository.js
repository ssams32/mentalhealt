import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

/**
 * server/auth/sessionRepository.js
 * In-memory Cache & Atomic File Persistence for Authentication Sessions.
 * Follows the existing Mind-ERP OS persistData & memoryCache pattern.
 * Non-destructive fail-closed handling on session store corruption.
 */

const SESSION_FILE = 'AuthSessions';
const DEFAULT_TTL_HOURS = parseInt(process.env.AUTH_SESSION_TTL_HOURS || '12', 10);
const THROTTLE_TOUCH_MS = 5 * 60 * 1000; // Throttle lastSeenAt updates to once per 5 minutes

export class SessionRepository {
    constructor(getDataFn, persistDataFn) {
        this.getData = getDataFn;
        this.persistData = persistDataFn;
        this.lastTouchMap = new Map(); // sessionId -> timestamp
        this.isCorrupted = false;
    }

    /**
     * Operator recovery: reset corruption state after restoring AuthSessions.json.
     */
    resetCorruptionState() {
        this.isCorrupted = false;
    }

    _getAllSessions() {
        if (this.isCorrupted) {
            return [];
        }
        try {
            const sessions = this.getData(SESSION_FILE, []);
            if (!Array.isArray(sessions)) {
                throw new Error('AuthSessions data is not an array');
            }
            return sessions;
        } catch (err) {
            this.isCorrupted = true;
            console.error('❌ [AUTH_STORE_CORRUPTION] Session repository corrupted, entering non-destructive fail-closed state:', err.message);
            return [];
        }
    }

    _hashToken(token) {
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    /**
     * Create a new secure session record.
     * Blocks creation if repository is corrupted to avoid overwriting damaged file on disk.
     */
    async createSession(userId, options = {}) {
        if (this.isCorrupted) {
            const err = new Error('세션 저장소가 일시적으로 사용 불가능합니다. 관리자에게 문의하세요.');
            err.code = 'AUTH_SESSION_STORE_UNAVAILABLE';
            err.status = 503;
            throw err;
        }

        if (!userId) throw new Error('userId is required to create session');

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = this._hashToken(token);
        const ttlHours = options.ttlHours || DEFAULT_TTL_HOURS;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

        const newSession = {
            id: crypto.randomUUID(),
            sessionTokenHash: tokenHash,
            userId: String(userId),
            issuedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            lastSeenAt: now.toISOString(),
            revokedAt: null,
            sessionVersion: 1
        };

        const sessions = this._getAllSessions();
        if (this.isCorrupted) {
            const err = new Error('세션 저장소가 일시적으로 사용 불가능합니다. 관리자에게 문의하세요.');
            err.code = 'AUTH_SESSION_STORE_UNAVAILABLE';
            err.status = 503;
            throw err;
        }

        sessions.push(newSession);
        await this.persistData(SESSION_FILE, sessions);

        return { token, session: newSession };
    }

    /**
     * Find active session by raw session token (hashed internally).
     * Returns null (fail closed) if repository is corrupted.
     */
    findSessionByToken(token) {
        if (!token || this.isCorrupted) return null;
        const tokenHash = this._hashToken(token);
        const sessions = this._getAllSessions();
        if (this.isCorrupted) return null;

        const now = new Date().getTime();

        const session = sessions.find(s => 
            s && s.sessionTokenHash === tokenHash && 
            !s.revokedAt && 
            new Date(s.expiresAt).getTime() > now
        );

        return session || null;
    }

    /**
     * Touch session lastSeenAt with throttling to reduce disk I/O.
     */
    async touchSession(sessionId) {
        if (!sessionId || this.isCorrupted) return;
        const now = Date.now();
        const lastTouch = this.lastTouchMap.get(sessionId) || 0;

        if (now - lastTouch < THROTTLE_TOUCH_MS) {
            return; // Throttled
        }

        this.lastTouchMap.set(sessionId, now);
        const sessions = this._getAllSessions();
        if (this.isCorrupted) return;

        const session = sessions.find(s => s && s.id === sessionId);
        if (session) {
            session.lastSeenAt = new Date(now).toISOString();
            await this.persistData(SESSION_FILE, sessions);
        }
    }

    /**
     * Explicitly revoke a session.
     */
    async revokeSessionByToken(token) {
        if (!token || this.isCorrupted) return false;
        const tokenHash = this._hashToken(token);
        const sessions = this._getAllSessions();
        if (this.isCorrupted) return false;

        const session = sessions.find(s => s && s.sessionTokenHash === tokenHash);

        if (session && !session.revokedAt) {
            session.revokedAt = new Date().toISOString();
            await this.persistData(SESSION_FILE, sessions);
            return true;
        }
        return false;
    }

    /**
     * Cleanup expired or revoked sessions older than 7 days.
     */
    async cleanupExpiredSessions() {
        if (this.isCorrupted) return;
        const sessions = this._getAllSessions();
        if (this.isCorrupted) return;

        const now = Date.now();
        const retentionCutoff = now - (7 * 24 * 60 * 60 * 1000);

        const activeOrRecent = sessions.filter(s => {
            if (!s) return false;
            const expTime = new Date(s.expiresAt).getTime();
            const revTime = s.revokedAt ? new Date(s.revokedAt).getTime() : null;
            if (revTime && revTime < retentionCutoff) return false;
            if (expTime < retentionCutoff) return false;
            return true;
        });

        if (activeOrRecent.length !== sessions.length) {
            await this.persistData(SESSION_FILE, activeOrRecent);
        }
    }
}

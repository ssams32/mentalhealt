/**
 * server/auth/authService.js
 * Core authentication logic and user credential verification.
 * Strictly avoids exposing passwords in memory or return objects.
 */

export class AuthService {
    constructor(sessionRepository, getUsersFn) {
        this.sessionRepo = sessionRepository;
        this.getUsers = getUsersFn;
    }

    _sanitizeUser(user) {
        if (!user) return null;
        // Strip password and any sensitive internals
        const { password, ...safeUser } = user;
        return {
            id: safeUser.id,
            username: safeUser.username || safeUser.id,
            name: safeUser.name,
            role: safeUser.role || 'user',
            team: safeUser.team,
            status: safeUser.status || 'active',
            permissions: safeUser.permissions || null
        };
    }

    /**
     * Authenticate credentials against Users.json.
     * Throws unified INVALID_CREDENTIALS to prevent user enumeration.
     */
    async login(username, password) {
        if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
            const err = new Error('아이디 또는 비밀번호를 확인해 주세요.');
            err.code = 'INVALID_CREDENTIALS';
            err.status = 400;
            throw err;
        }

        const trimmedUser = username.trim();
        // Handle input format like email 'username@domain.com'
        const normalized = trimmedUser.includes('@') ? trimmedUser.split('@')[0] : trimmedUser;

        const users = this.getUsers();
        const user = users.find(u => 
            u && (String(u.username) === normalized || String(u.id) === normalized)
        );

        if (!user) {
            const err = new Error('아이디 또는 비밀번호를 확인해 주세요.');
            err.code = 'INVALID_CREDENTIALS';
            err.internalReason = 'USER_NOT_FOUND';
            err.status = 401;
            throw err;
        }

        // Account status check: Unified response to prevent enumeration
        if (user.status && user.status !== 'active') {
            const err = new Error('아이디 또는 비밀번호를 확인해 주세요.');
            err.code = 'INVALID_CREDENTIALS';
            err.internalReason = 'ACCOUNT_INACTIVE';
            err.status = 401;
            throw err;
        }

        // Legacy plaintext password check (Preserves compatibility without auto-modifying stored file)
        const storedPwd = String(user.password || '');
        const inputPwd = String(password);

        if (storedPwd !== inputPwd) {
            const err = new Error('아이디 또는 비밀번호를 확인해 주세요.');
            err.code = 'INVALID_CREDENTIALS';
            err.internalReason = 'PASSWORD_MISMATCH';
            err.status = 401;
            throw err;
        }

        // Create secure session
        const { token, session } = await this.sessionRepo.createSession(user.id);
        const safeUser = this._sanitizeUser(user);

        return { token, session, user: safeUser };
    }

    /**
     * Validate session token from request cookie.
     * Returns sanitized user attached with session context.
     */
    async authenticateSession(token) {
        if (!token) return null;

        const session = this.sessionRepo.findSessionByToken(token);
        if (!session) return null;

        const users = this.getUsers();
        const user = users.find(u => u && String(u.id) === String(session.userId));

        if (!user || (user.status && user.status !== 'active')) {
            return null;
        }

        // Touch session asynchronously (throttled)
        this.sessionRepo.touchSession(session.id).catch(err => {
            console.error('Session touch error:', err);
        });

        return this._sanitizeUser(user);
    }

    /**
     * Revoke active session on logout.
     */
    async logout(token) {
        if (!token) return true;
        return await this.sessionRepo.revokeSessionByToken(token);
    }
}

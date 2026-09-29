import { Router } from 'express';
import { parseSessionCookie } from './authMiddleware.js';
import { verifyStateChangingOrigin } from './csrfProtection.js';

/**
 * server/auth/authRouter.js
 * Express router handling login, logout, and session verification.
 */

export function createAuthRouter(authService, requireAuthMiddleware, options = {}) {
    const router = Router();
    // [P0-D2] 최초 관리자 bootstrap 콜백 (server.js에서 주입). Users가 비어있을 때만 동작.
    const { ensureInitialAdmin } = options;

    const COOKIE_NAME = 'mind_session';
    const TTL_HOURS = parseInt(process.env.AUTH_SESSION_TTL_HOURS || '12', 10);
    const MAX_AGE_SEC = TTL_HOURS * 3600;
    const IS_PROD = process.env.NODE_ENV === 'production';
    // Only force Secure if explicitly configured or running under HTTPS
    const IS_SECURE = process.env.AUTH_COOKIE_SECURE === 'true';

    function buildCookieHeader(token, maxAgeSec = MAX_AGE_SEC) {
        let cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
        if (IS_SECURE) {
            cookie += '; Secure';
        }
        return cookie;
    }

    // Apply CSRF & Origin verification to all mutating methods (POST, PUT, DELETE)
    router.use(verifyStateChangingOrigin);

    /**
     * POST /api/auth/login
     */
    router.post('/login', async (req, res) => {
        try {
            const { username, password } = req.body || {};

            if (!username || !password) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CREDENTIALS',
                        message: '아이디 또는 비밀번호를 입력해 주세요.'
                    }
                });
            }

            // Length limits to defend against DoS
            if (String(username).length > 100 || String(password).length > 200) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_CREDENTIALS',
                        message: '입력 길이가 허용 범위를 초과했습니다.'
                    }
                });
            }

            // Session Fixation Defense: Revoke any existing session before creating a fresh one
            const oldToken = parseSessionCookie(req.headers.cookie);
            if (oldToken) {
                try {
                    await authService.logout(oldToken);
                } catch (ignore) {}
            }

            // [P0-D2] 최초 관리자 bootstrap: Users가 비어있으면 여기서만 생성.
            // ADMIN_INIT_PASSWORD 미설정 시 fail-closed (503, 값 노출 없음).
            if (typeof ensureInitialAdmin === 'function') {
                const boot = await ensureInitialAdmin();
                if (boot && boot.blocked) {
                    if (boot.reason === 'PERSIST_FAILED') {
                        return res.status(503).json({
                            error: {
                                code: 'ADMIN_INIT_FAILED',
                                message: '초기 관리자 생성에 실패했습니다. 관리자에게 문의하세요.'
                            }
                        });
                    }
                    return res.status(503).json({
                        error: {
                            code: 'ADMIN_INIT_NOT_CONFIGURED',
                            message: '초기 관리자 비밀번호가 설정되지 않았습니다. 관리자에게 문의하세요.'
                        }
                    });
                }
            }

            const { token, user } = await authService.login(username, password);

            // Set HttpOnly session cookie
            res.setHeader('Set-Cookie', buildCookieHeader(token, MAX_AGE_SEC));

            return res.json({
                success: true,
                user // Strictly sanitized: password and token excluded
            });
        } catch (err) {
            const status = err.status || 401;
            return res.status(status).json({
                error: {
                    code: err.code || 'INVALID_CREDENTIALS',
                    message: err.message || '로그인에 실패했습니다.'
                }
            });
        }
    });

    /**
     * POST /api/auth/logout
     */
    router.post('/logout', async (req, res) => {
        try {
            const token = parseSessionCookie(req.headers.cookie);
            if (token) {
                await authService.logout(token);
            }
        } catch (ignore) {}

        // Expire cookie with exact matching attributes
        res.setHeader('Set-Cookie', buildCookieHeader('', 0));

        return res.json({
            success: true,
            message: '성공적으로 로그아웃되었습니다.'
        });
    });

    /**
     * GET /api/auth/me
     * Protected endpoint returning the active user's session profile.
     */
    router.get('/me', requireAuthMiddleware, (req, res) => {
        return res.json({
            success: true,
            user: req.auth
        });
    });

    return router;
}

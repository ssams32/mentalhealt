/**
 * server/auth/authMiddleware.js
 * Cookie parsing & session verification middleware for Express.
 * No external cookie-parser dependency needed (Option B minimal parser).
 */

const COOKIE_NAME = 'mind_session';

/**
 * Minimal, secure cookie parser specifically for the session cookie.
 */
export function parseSessionCookie(cookieHeader) {
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    const cookies = cookieHeader.split(';');
    for (let c of cookies) {
        const [key, ...valParts] = c.trim().split('=');
        if (key === COOKIE_NAME) {
            return decodeURIComponent(valParts.join('='));
        }
    }
    return null;
}

export function createAuthMiddleware(authService) {
    const extractToken = (req) => {
        let token = parseSessionCookie(req.headers.cookie);
        if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            token = req.headers.authorization.slice(7).trim();
        }
        return token;
    };

    /**
     * Mandatory authentication middleware.
     * Blocks unauthenticated requests with 401 UNAUTHENTICATED.
     */
    const requireAuth = async (req, res, next) => {
        const token = extractToken(req);

        if (!token) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '로그인이 필요합니다.'
                }
            });
        }

        try {
            const user = await authService.authenticateSession(token);
            if (!user) {
                return res.status(401).json({
                    error: {
                        code: 'UNAUTHENTICATED',
                        message: '세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.'
                    }
                });
            }

            // Bind sanitized user to request context (server-trusted)
            req.auth = user;
            req.sessionToken = token;
            next();
        } catch (err) {
            console.error('❌ [AUTH_MIDDLEWARE_ERROR]:', err.message);
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '인증 확인 중 오류가 발생했습니다.'
                }
            });
        }
    };

    /**
     * Optional authentication middleware.
     * Attaches req.auth if session is valid, but does not block.
     */
    const optionalAuth = async (req, res, next) => {
        const token = extractToken(req);
        if (token) {
            try {
                const user = await authService.authenticateSession(token);
                if (user) {
                    req.auth = user;
                    req.sessionToken = token;
                }
            } catch (ignore) {}
        }
        next();
    };

    /**
     * Admin-only middleware.
     * Requires authentication first, then role === 'admin'.
     * 401 UNAUTHENTICATED when not logged in, 403 when not admin.
     */
    function requireAdmin(req, res, next) {
        requireAuth(req, res, () => {
            if (!req.auth || req.auth.role !== 'admin') {
                return res.status(403).json({ success: false, error: "관리자 권한이 필요합니다." });
            }
            next();
        });
    }

    return { requireAuth, optionalAuth, requireAdmin };
}

import { parseAllowedOrigins } from '../config/corsPolicy.js';

/**
 * server/auth/csrfProtection.js
 * Origin verification & cross-site mutation defense middleware.
 * Strictly enforces Origin allowlist and strict Content-Type for auth endpoints.
 */

export function verifyStateChangingOrigin(req, res, next) {
    const method = req.method.toUpperCase();

    // Safe read-only methods are not state-changing mutations
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return next();
    }

    // 1. Sec-Fetch-Site check: immediate defense against cross-site requests
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite === 'cross-site') {
        return res.status(403).json({
            error: {
                code: 'CSRF_BLOCKED',
                message: 'Cross-site 상태 변경 요청은 허용되지 않습니다.'
            }
        });
    }

    // 2. Origin-less mutation policy in production
    const origin = req.headers['origin'];
    const host = req.headers['host'];
    const isProd = process.env.NODE_ENV === 'production';
    const allowOriginless = process.env.ALLOW_ORIGINLESS_MUTATIONS === 'true';

    if (!origin) {
        // In strict production, an origin-less mutating request is blocked unless explicitly enabled or verified same-origin
        if (isProd && !allowOriginless && secFetchSite !== 'same-origin') {
            return res.status(403).json({
                error: {
                    code: 'ORIGIN_REQUIRED',
                    message: '상태 변경 요청에는 Origin 또는 Sec-Fetch-Site 헤더가 필요합니다.'
                }
            });
        }
    } else {
        // 3. Origin header verification against Host and CORS allowlist
        const cleanOrigin = origin.trim().replace(/\/+$/, '');
        const allowed = parseAllowedOrigins();

        let originMatchesHost = false;
        try {
            const urlObj = new URL(cleanOrigin);
            originMatchesHost = (urlObj.host === host);
        } catch (e) {}

        const isAllowed = originMatchesHost || allowed.includes(cleanOrigin);
        const isDevLocal = !isProd &&
                           allowed.length === 0 &&
                           /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin);

        if (!isAllowed && !isDevLocal) {
            return res.status(403).json({
                error: {
                    code: 'CSRF_BLOCKED',
                    message: '허용되지 않은 요청 출처(Origin)입니다.'
                }
            });
        }
    }

    // 4. Strict Content-Type enforcement for auth endpoints
    // Login strictly requires application/json (charset allowed); multipart, urlencoded, text/plain rejected.
    // Logout permits application/json or bodyless POST; multipart, urlencoded, text/plain strictly rejected.
    const rawContentType = req.headers['content-type'] || '';
    const contentType = rawContentType.toLowerCase().trim();
    const reqPath = (req.path || '').toLowerCase();
    const isLogin = reqPath === '/login' || reqPath.endsWith('/auth/login');
    const isLogout = reqPath === '/logout' || reqPath.endsWith('/auth/logout');

    const FORBIDDEN_CONTENT_TYPES = [
        'multipart/form-data',
        'application/x-www-form-urlencoded',
        'text/plain'
    ];

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
        // Explicitly block dangerous or legacy form formats
        if (FORBIDDEN_CONTENT_TYPES.some(t => contentType.startsWith(t))) {
            return res.status(415).json({
                error: {
                    code: 'UNSUPPORTED_MEDIA_TYPE',
                    message: '지원되지 않는 요청 본문 형식입니다. application/json 형식이 필요합니다.'
                }
            });
        }

        if (isLogin) {
            // Login requires a valid JSON payload with application/json (charset allowed)
            if (!contentType.startsWith('application/json')) {
                return res.status(415).json({
                    error: {
                        code: 'UNSUPPORTED_MEDIA_TYPE',
                        message: '로그인 요청은 application/json 형식이 필수입니다.'
                    }
                });
            }
        } else if (isLogout) {
            // Logout permits no content-type (bodyless) OR application/json
            if (contentType && !contentType.startsWith('application/json')) {
                return res.status(415).json({
                    error: {
                        code: 'UNSUPPORTED_MEDIA_TYPE',
                        message: '로그아웃 요청은 application/json 또는 빈 본문만 허용됩니다.'
                    }
                });
            }
        } else if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
            if (!contentType.startsWith('application/json')) {
                return res.status(415).json({
                    error: {
                        code: 'UNSUPPORTED_MEDIA_TYPE',
                        message: 'application/json 형식이 필요합니다.'
                    }
                });
            }
        }
    }

    next();
}

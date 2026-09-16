/**
 * server/config/corsPolicy.js
 * Explicit Allowlist CORS Configuration for Mind-ERP OS.
 * Strictly avoids arbitrary origin reflection and disallows credentials with wildcard origins.
 */

/**
 * Parse comma-separated allowed origins from environment variable.
 */
export function parseAllowedOrigins() {
    const raw = process.env.CORS_ALLOWED_ORIGINS || '';
    return raw
        .split(',')
        .map(o => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

/**
 * Factory for Express cors middleware options.
 */
export function createCorsOptions() {
    return {
        origin: (origin, callback) => {
            const allowedOrigins = parseAllowedOrigins();
            const isProd = process.env.NODE_ENV === 'production';

            // 1. Same-Origin or direct non-browser requests (no Origin header sent)
            if (!origin) {
                return callback(null, true);
            }

            const cleanOrigin = origin.trim().replace(/\/+$/, '');

            // 2. Exact match in explicit allowlist
            if (allowedOrigins.includes(cleanOrigin)) {
                return callback(null, true);
            }

            // 3. Development fallback only when CORS_ALLOWED_ORIGINS is not set
            if (!isProd && allowedOrigins.length === 0) {
                const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin);
                if (isLocalhost) {
                    return callback(null, true);
                }
            }

            // 4. Deny: Do not provide Access-Control-Allow-Origin header
            return callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'x-user-id',
            'x-user-role',
            'x-user-team',
            'Idempotency-Key'
        ]
    };
}

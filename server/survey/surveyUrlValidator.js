/**
 * server/survey/surveyUrlValidator.js
 * Strict URL security validation for TRACK_A_BASE_URL.
 * 
 * Enforces:
 * - HTTPS in staging and production
 * - No path traversal (.. or \\)
 * - No embedded credentials (username/password)
 * - No malformed trailing paths
 * - Disallows localhost / 127.0.0.1 / ::1 / .local / .localhost in production
 * - Requires staging deployment URL (e.g. Vercel) in staging
 */

export function validateTrackABaseUrl(rawUrl, mode = 'mock') {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('TRACK_A_BASE_URL is required and must be a valid string');
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        throw new Error('TRACK_A_BASE_URL cannot be empty');
    }

    // Path traversal check
    if (trimmed.includes('..') || trimmed.includes('\\')) {
        throw new Error('TRACK_A_BASE_URL contains forbidden path traversal characters');
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (e) {
        throw new Error(`TRACK_A_BASE_URL is not a valid URL: "${trimmed}"`);
    }

    // Embedded credentials check
    if (parsed.username || parsed.password) {
        throw new Error('TRACK_A_BASE_URL must not contain embedded user credentials');
    }

    // Protocol check: staging and production MUST use HTTPS
    if (mode === 'staging' || mode === 'production') {
        if (parsed.protocol !== 'https:') {
            throw new Error(`TRACK_A_BASE_URL must use HTTPS protocol in ${mode} mode (received: ${parsed.protocol})`);
        }
    }

    const hostname = parsed.hostname.toLowerCase();

    // Production environment restrictions
    if (mode === 'production') {
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname.endsWith('.localhost') ||
            hostname.endsWith('.local')
        ) {
            throw new Error(`TRACK_A_BASE_URL in production mode cannot be localhost or .local domain: ${hostname}`);
        }
    }

    // Staging environment restrictions
    if (mode === 'staging') {
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname.endsWith('.localhost')
        ) {
            throw new Error(`TRACK_A_BASE_URL in staging mode must use actual staging HTTPS deployment URL, not localhost: ${hostname}`);
        }
    }

    // Return sanitized origin + normalized pathname (without trailing slash)
    const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${normalizedPath}`;
}

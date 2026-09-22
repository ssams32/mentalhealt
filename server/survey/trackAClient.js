/**
 * server/survey/trackAClient.js
 * Centralized, secure HTTP client for Track A canonical screening collection service.
 * Enforces strict bearer authentication, worker ownership, bounded timeouts,
 * request-path sanitization, and credential-safe typed error mapping.
 */

import { TrackAIntegrationError } from './surveyErrors.js';
import { TRACK_A_FAILURE_CATEGORIES } from './surveyConstants.js';

export class TrackAClient {
    /**
     * @param {Object} config
     * @param {string} config.baseUrl - Canonical Track A service URL (e.g. https://track-a.vercel.app)
     * @param {string} config.serviceSecret - TRACK_B_SERVICE_SECRET
     * @param {string} config.workerId - TRACK_B_WORKER_ID
     * @param {number} [config.timeoutMs=10000] - Bounded request timeout in milliseconds
     * @param {number} [config.defaultLeaseSeconds=300] - Default lease duration
     */
    constructor(config = {}) {
        if (!config.baseUrl) {
            throw new Error('TrackAClient requires baseUrl');
        }
        if (!config.serviceSecret) {
            throw new Error('TrackAClient requires serviceSecret (TRACK_B_SERVICE_SECRET)');
        }
        if (!config.workerId) {
            throw new Error('TrackAClient requires workerId (TRACK_B_WORKER_ID)');
        }

        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.serviceSecret = config.serviceSecret;
        this.workerId = config.workerId;
        this.timeoutMs = Number(config.timeoutMs) || 10000;
        this.defaultLeaseSeconds = Number(config.defaultLeaseSeconds) || 300;
        this.vercelBypassSecret = (config.vercelBypassSecret || process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();

        // Security check: enforce HTTPS in production
        if (process.env.NODE_ENV === 'production' && !this.baseUrl.startsWith('https://')) {
            throw new Error('TrackAClient requires HTTPS in production environment');
        }
    }

    _sanitizeId(id) {
        if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
            throw new TrackAIntegrationError({
                message: 'Invalid submission ID format',
                trackACode: 'INVALID_ID_FORMAT',
                statusCode: 400
            });
        }
        return encodeURIComponent(id);
    }

    async _request(endpointPath, { method = 'GET', body = null, submissionId = null } = {}) {
        const url = `${this.baseUrl}${endpointPath}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers = {
            'Authorization': `Bearer ${this.serviceSecret}`,
            'x-worker-id': this.workerId,
            'Accept': 'application/json'
        };

        if (this.vercelBypassSecret) {
            headers['x-vercel-protection-bypass'] = this.vercelBypassSecret;
        }

        if (body) {
            headers['Content-Type'] = 'application/json';
        }

        try {
            const resp = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            clearTimeout(timer);

            let data;
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                data = await resp.json().catch(() => null);
            } else {
                const text = await resp.text().catch(() => '');
                const isVercelBlocked = text.includes('data-dpl-id') || text.includes('dash') || text.includes('login') || resp.headers.get('x-matched-path') === '/login';
                throw new TrackAIntegrationError({
                    message: isVercelBlocked
                        ? 'PREVIEW_DEPLOYMENT_PROTECTION_BLOCKED'
                        : `Unexpected response format from Track A (HTTP ${resp.status}): not JSON`,
                    trackACode: isVercelBlocked ? 'PREVIEW_DEPLOYMENT_PROTECTION_BLOCKED' : 'NON_JSON_RESPONSE',
                    statusCode: resp.status,
                    submissionId
                });
            }

            if (!resp.ok) {
                const trackACode = data?.error?.code || data?.code || (data?.error ? String(data.error) : 'HTTP_ERROR');
                const trackAMsg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
                throw new TrackAIntegrationError({
                    message: `Track A request failed (${trackACode}): ${trackAMsg}`,
                    trackACode,
                    statusCode: resp.status,
                    submissionId,
                    details: { trackACode, statusCode: resp.status }
                });
            }

            return data;
        } catch (err) {
            clearTimeout(timer);
            if (err instanceof TrackAIntegrationError) {
                throw err;
            }

            const isAbort = err.name === 'AbortError' || err.message?.includes('aborted');
            throw new TrackAIntegrationError({
                message: isAbort ? 'Track A request timed out' : 'Network error connecting to Track A',
                trackACode: isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
                statusCode: isAbort ? 504 : 503,
                submissionId
            });
        }
    }

    /**
     * Check Track A service capabilities.
     * Validates:
     * - HTTP 200
     * - Content-Type application/json
     * - encryptedCounselingSubmissionAvailable === true
     * - storageStatus === 'READY'
     * - vercelEnv === 'preview'
     */
    async checkCapabilities() {
        const data = await this._request('/api/v1/capabilities', { method: 'GET' });
        const vercelEnv = data?.vercelEnv || data?.safeMeta?.vercelEnv;
        const valid = Boolean(
            data &&
            data.encryptedCounselingSubmissionAvailable === true &&
            data.storageStatus === 'READY' &&
            vercelEnv === 'preview'
        );
        return {
            valid,
            data,
            encryptedCounselingSubmissionAvailable: data?.encryptedCounselingSubmissionAvailable,
            storageStatus: data?.storageStatus,
            vercelEnv
        };
    }

    /**
     * Connectivity ping alias delegating to checkCapabilities().
     */
    async ping() {
        const cap = await this.checkCapabilities();
        return cap.valid;
    }

    /**
     * Inspect if counseling submission is enabled on Track A.
     * Prevents starting import when COUNSELING_SUBMISSION_ENABLED=false.
     */
    async checkSubmissionGateStatus() {
        try {
            const data = await this._request('/api/v1/internal/status', { method: 'GET' });
            if (data && data.counselingSubmissionEnabled === false) {
                return { enabled: false, message: data.message || 'COUNSELING_SUBMISSION_DISABLED' };
            }
            return { enabled: true };
        } catch (err) {
            if (err.trackACode === 'COUNSELING_SUBMISSION_DISABLED') {
                return { enabled: false, message: err.message };
            }
            // If /status is not present or returns 404, assume enabled unless code is explicit
            return { enabled: true };
        }
    }

    /**
     * Pull leased pending encrypted submissions.
     * GET /api/v1/internal/submissions/pending?limit=<limit>&leaseSeconds=<leaseSeconds>
     */
    async leasePendingSubmissions({ limit = 50, leaseSeconds = this.defaultLeaseSeconds } = {}) {
        const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
        const boundedLease = Math.max(30, Math.min(3600, Number(leaseSeconds) || this.defaultLeaseSeconds));

        const data = await this._request(
            `/api/v1/internal/submissions/pending?limit=${boundedLimit}&leaseSeconds=${boundedLease}`,
            { method: 'GET' }
        );

        return {
            success: Boolean(data?.success),
            count: data?.count || (Array.isArray(data?.submissions) ? data.submissions.length : 0),
            submissions: Array.isArray(data?.submissions) ? data.submissions : []
        };
    }

    /**
     * Send external ACK after verified internal referral & report creation.
     * POST /api/v1/internal/submissions/:id/ack
     */
    async acknowledgeSubmission(submissionId, { leaseId, workerId = this.workerId, requestId }) {
        const safeId = this._sanitizeId(submissionId);
        if (!leaseId) {
            throw new TrackAIntegrationError({
                message: 'leaseId is mandatory for ACK request',
                trackACode: 'MISSING_LEASE_ID',
                statusCode: 400,
                submissionId
            });
        }
        if (!requestId) {
            throw new TrackAIntegrationError({
                message: 'requestId is mandatory for ACK request',
                trackACode: 'MISSING_REQUEST_ID',
                statusCode: 400,
                submissionId
            });
        }

        const body = {
            leaseId,
            workerId: workerId || this.workerId,
            requestId
        };

        return this._request(`/api/v1/internal/submissions/${safeId}/ack`, {
            method: 'POST',
            body,
            submissionId
        });
    }

    /**
     * Report failed or quarantined processing to Track A.
     * POST /api/v1/internal/submissions/:id/failed
     */
    async reportSubmissionFailed(submissionId, {
        leaseId,
        workerId = this.workerId,
        requestId,
        category = TRACK_A_FAILURE_CATEGORIES.RETRYABLE,
        reason = 'PROCESSING_ERROR'
    }) {
        const safeId = this._sanitizeId(submissionId);
        if (!leaseId) {
            throw new TrackAIntegrationError({
                message: 'leaseId is mandatory for failed report',
                trackACode: 'MISSING_LEASE_ID',
                statusCode: 400,
                submissionId
            });
        }

        const safeCategory = [TRACK_A_FAILURE_CATEGORIES.RETRYABLE, TRACK_A_FAILURE_CATEGORIES.QUARANTINED].includes(category)
            ? category
            : TRACK_A_FAILURE_CATEGORIES.RETRYABLE;

        const body = {
            leaseId,
            workerId: workerId || this.workerId,
            requestId: requestId || `req_fail_${Date.now()}`,
            category: safeCategory,
            reason: String(reason).replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64)
        };

        return this._request(`/api/v1/internal/submissions/${safeId}/failed`, {
            method: 'POST',
            body,
            submissionId
        });
    }

    /**
     * Request deletion of Track A ciphertext after ACK success (state: IMPORTED).
     * POST /api/v1/internal/submissions/:id/delete
     */
    async deleteImportedSubmission(submissionId, { leaseId, workerId = this.workerId, requestId } = {}) {
        const safeId = this._sanitizeId(submissionId);
        const body = {
            leaseId: leaseId || undefined,
            workerId: workerId || this.workerId,
            requestId: requestId || `req_del_${Date.now()}`
        };

        return this._request(`/api/v1/internal/submissions/${safeId}/delete`, {
            method: 'POST',
            body,
            submissionId
        });
    }
}

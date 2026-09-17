/**
 * server/survey/surveyErrors.js
 * Error definitions with strict information hiding and path/secret redaction.
 */

import { SURVEY_ERROR_CODES } from './surveyConstants.js';

function redactSensitiveData(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/(?:[a-zA-Z]:|\/)[^\s:;"'<>]+/g, '[REDACTED_PATH]')
        .replace(/ghp_[A-Za-z0-9_]{36,}/g, '[REDACTED_TOKEN]')
        .replace(/01[016789]-?\d{3,4}-?\d{4}/g, '[REDACTED_PHONE]')
        .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

export class SurveyOperationError extends Error {
    constructor(code, message, details = {}) {
        const safeMessage = redactSensitiveData(message);
        super(safeMessage);
        this.name = 'SurveyOperationError';
        this.code = code || SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA;
        
        // Redact details recursively
        this.details = this._redactObject(details);
    }

    _redactObject(obj) {
        if (!obj || typeof obj !== 'object') {
            return redactSensitiveData(obj);
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this._redactObject(item));
        }
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
            // Prohibit logging private keys, ciphertext, answers
            if (['privateKey', 'ciphertext', 'answers', 'phone', 'clientName'].includes(k)) {
                cleaned[k] = '[REDACTED]';
            } else if (typeof v === 'string') {
                cleaned[k] = redactSensitiveData(v);
            } else if (typeof v === 'object') {
                cleaned[k] = this._redactObject(v);
            } else {
                cleaned[k] = v;
            }
        }
        return cleaned;
    }
}

export class TrackAIntegrationError extends Error {
    constructor({
        message,
        trackACode = 'UNKNOWN_TRACK_A_ERROR',
        statusCode = 500,
        submissionId = null,
        details = {}
    }) {
        const safeMessage = redactSensitiveData(message || `Track A request failed with code ${trackACode}`);
        super(safeMessage);
        this.name = 'TrackAIntegrationError';
        this.trackACode = trackACode;
        this.statusCode = statusCode;
        this.submissionId = submissionId;
        this.isLeaseExpired = [
            'LEASE_EXPIRED',
            'LEASE_MISMATCH',
            'WORKER_MISMATCH',
            'CANNOT_ACK_UNLEASED',
            'CANNOT_FAIL_UNLEASED'
        ].includes(trackACode);
        this.isRetryable = statusCode >= 500 || statusCode === 429 || this.isLeaseExpired;
        this.details = details;
    }
}


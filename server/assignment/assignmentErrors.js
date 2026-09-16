/**
 * server/assignment/assignmentErrors.js
 * Error Domain Model for VoiceCall Assignment and Routing.
 * Mind-ERP OS Track A10.
 * 
 * BOUNDARY NOTICE:
 * - Sanitized message guarantee: Error messages never echo input data, PII, tokens, or filesystem paths.
 */

import { ASSIGNMENT_ERROR_CODES } from './assignmentConstants.js';

export class AssignmentError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssignmentError';
        this.code = code || ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID;
        this.status = status;
        this.details = details ? AssignmentError._sanitizeDetails(details) : null;
    }

    static _sanitizeDetails(details) {
        if (!details || typeof details !== 'object') return null;
        if (Array.isArray(details)) {
            return details.map(item => {
                if (typeof item === 'object' && item !== null) {
                    return {
                        field: String(item.field || 'unknown'),
                        reason: String(item.reason || 'INVALID')
                    };
                }
                return String(item);
            });
        }
        const safe = {};
        for (const [k, v] of Object.entries(details)) {
            if (['field', 'reason', 'code', 'stage', 'resourceId', 'callId'].includes(k)) {
                safe[k] = String(v);
            }
        }
        return safe;
    }
}

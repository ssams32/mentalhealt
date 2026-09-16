/**
 * server/voice-access/voiceAccessValidator.js
 * Schema Validation and PII-shielding for Voice System Access Grants and History.
 */

import {
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    ALL_VOICE_ACCESS_CAPABILITIES,
    VOICE_ACCESS_CAPABILITIES,
    HISTORY_ACTIONS,
    PROHIBITED_PAYLOAD_KEYS
} from './voiceAccessConstants.js';
import { VoiceAccessError, VOICE_ACCESS_ERROR_CODES } from './voiceAccessErrors.js';

export function isNonEmptyString(val) {
    return typeof val === 'string' && val.trim().length > 0;
}

export function isValidIsoDate(val) {
    if (typeof val !== 'string') return false;
    const d = new Date(val);
    return !isNaN(d.getTime()) && val.includes('T');
}

/**
 * Checks if a string or object contains prohibited PII keywords.
 */
export function containsProhibitedPII(input) {
    if (!input) return false;
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    const lower = str.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const key of PROHIBITED_PAYLOAD_KEYS) {
        if (lower.includes(key)) {
            return true;
        }
    }
    return false;
}

/**
 * Validate input when creating or updating a grant.
 */
export function validateGrantInput(input, isCreate = true) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new VoiceAccessError(
            VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
            'Grant payload must be a non-null object',
            400
        );
    }

    if (isCreate) {
        if (!isNonEmptyString(input.userId)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                'userId must be a non-empty string',
                400
            );
        }
    }

    if (input.capabilities !== undefined) {
        if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                'capabilities must be a non-empty array of strings',
                400
            );
        }

        for (const cap of input.capabilities) {
            if (!isNonEmptyString(cap) || !ALL_VOICE_ACCESS_CAPABILITIES.includes(cap)) {
                throw new VoiceAccessError(
                    VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                    `Unknown capability: [${String(cap)}]`,
                    400
                );
            }
        }

        // Must include foundational capability
        if (!input.capabilities.includes(VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.FOUNDATIONAL_ACCESS_REQUIRED,
                `capabilities must include [${VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS}]`,
                400
            );
        }
    }

    if (input.scope !== undefined) {
        if (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                'scope must be an object with valid type',
                400
            );
        }
        const validScopeTypes = Object.values(ACCESS_SCOPE_TYPE);
        if (!validScopeTypes.includes(input.scope.type)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                `scope.type must be one of: ${validScopeTypes.join(', ')}`,
                400
            );
        }
        if (input.scope.type === ACCESS_SCOPE_TYPE.DEPARTMENT && input.scope.departmentId !== undefined) {
            if (typeof input.scope.departmentId !== 'string') {
                throw new VoiceAccessError(
                    VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                    'scope.departmentId must be a string if provided',
                    400
                );
            }
        }
    }

    if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (!isValidIsoDate(input.expiresAt)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                'expiresAt must be a valid ISO date string or null',
                400
            );
        }
    }

    if (input.reason !== undefined && input.reason !== null) {
        if (typeof input.reason !== 'string' || input.reason.length > 300) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.INVALID_ARGUMENT,
                'reason must be a string up to 300 characters',
                400
            );
        }
        if (containsProhibitedPII(input.reason)) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.PROHIBITED_PAYLOAD,
                'Prohibited PII detected in grant reason',
                400
            );
        }
    }
}

/**
 * Validate stored grant entry on disk.
 */
export function validateStoredGrant(grant) {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
        return { valid: false, reason: 'Grant is not an object' };
    }
    if (!isNonEmptyString(grant.id)) {
        return { valid: false, reason: 'Missing or invalid id' };
    }
    if (!isNonEmptyString(grant.userId)) {
        return { valid: false, reason: 'Missing or invalid userId' };
    }
    if (!Object.values(GRANT_STATUS).includes(grant.status)) {
        return { valid: false, reason: `Invalid status: ${grant.status}` };
    }
    if (!Array.isArray(grant.capabilities)) {
        return { valid: false, reason: 'capabilities must be an array' };
    }
    if (!grant.scope || typeof grant.scope !== 'object') {
        return { valid: false, reason: 'scope must be an object' };
    }
    if (!Object.values(ACCESS_SCOPE_TYPE).includes(grant.scope.type)) {
        return { valid: false, reason: `Invalid scope type: ${grant.scope.type}` };
    }
    if (!isNonEmptyString(grant.grantedBy)) {
        return { valid: false, reason: 'Missing or invalid grantedBy' };
    }
    if (!isValidIsoDate(grant.grantedAt)) {
        return { valid: false, reason: 'Missing or invalid grantedAt' };
    }
    if (!isValidIsoDate(grant.updatedAt)) {
        return { valid: false, reason: 'Missing or invalid updatedAt' };
    }
    if (typeof grant.version !== 'number' || grant.version < 1 || !Number.isInteger(grant.version)) {
        return { valid: false, reason: 'version must be a positive integer' };
    }
    if (grant.reason && containsProhibitedPII(grant.reason)) {
        return { valid: false, reason: 'PII detected in stored grant reason' };
    }
    return { valid: true };
}

/**
 * Validate stored history entry on disk.
 */
export function validateStoredHistory(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { valid: false, reason: 'History entry is not an object' };
    }
    if (!isNonEmptyString(entry.id)) {
        return { valid: false, reason: 'Missing history id' };
    }
    if (!isNonEmptyString(entry.grantId)) {
        return { valid: false, reason: 'Missing history grantId' };
    }
    if (!isNonEmptyString(entry.userId)) {
        return { valid: false, reason: 'Missing history userId' };
    }
    if (!Object.values(HISTORY_ACTIONS).includes(entry.action)) {
        return { valid: false, reason: `Invalid history action: ${entry.action}` };
    }
    if (!isNonEmptyString(entry.performedBy)) {
        return { valid: false, reason: 'Missing performedBy' };
    }
    if (!isValidIsoDate(entry.performedAt)) {
        return { valid: false, reason: 'Missing or invalid performedAt' };
    }
    if (entry.reason && containsProhibitedPII(entry.reason)) {
        return { valid: false, reason: 'PII detected in history reason' };
    }
    return { valid: true };
}

/**
 * server/voice-access/voiceAccessConstants.js
 * Core Constants, Capabilities, Scopes, and Check Codes for Mind-ERP OS Restricted Voice Access Gate.
 */

import { VOICE_CAPABILITIES } from '../permissions/voiceCapabilities.js';

export const GRANTS_FILE_NAME = 'VoiceSystemAccessGrants.json';
export const HISTORY_FILE_NAME = 'VoiceSystemAccessHistory.json';

export const GRANT_STATUS = Object.freeze({
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    REVOKED: 'revoked'
});

export const ACCESS_SCOPE_TYPE = Object.freeze({
    ALL: 'all',
    DEPARTMENT: 'department',
    ASSIGNED_ONLY: 'assigned_only'
});

export const HISTORY_ACTIONS = Object.freeze({
    CREATE: 'CREATE',
    UPDATE_CAPABILITIES: 'UPDATE_CAPABILITIES',
    UPDATE_SCOPE: 'UPDATE_SCOPE',
    SUSPEND: 'SUSPEND',
    REACTIVATE: 'REACTIVATE',
    REVOKE: 'REVOKE',
    EXPIRE: 'EXPIRE'
});

/**
 * Voice Access Capabilities.
 * Merges foundational gatekeeping capabilities with existing voice capability constants without duplication.
 */
export const VOICE_ACCESS_CAPABILITIES = Object.freeze({
    SYSTEM_ACCESS: 'voice_system.access',
    MANAGE_ACCESS: 'voice_system.manage_access',
    VIEW: 'voice_call.view',
    UPLOAD: 'voice_call.upload',
    PLAY_AUDIO: VOICE_CAPABILITIES.PLAY_AUDIO,
    DOWNLOAD_AUDIO: VOICE_CAPABILITIES.DOWNLOAD_AUDIO,
    ASSIGN: VOICE_CAPABILITIES.ASSIGN,
    REASSIGN: VOICE_CAPABILITIES.REASSIGN,
    REVIEW: 'voice_call.review',
    NOTIFICATION_READ: 'voice_notification.read'
});

export const ALL_VOICE_ACCESS_CAPABILITIES = Object.freeze(
    Object.values(VOICE_ACCESS_CAPABILITIES)
);

/**
 * Prohibited PII property names in any grant metadata or reasons.
 */
export const PROHIBITED_PAYLOAD_KEYS = Object.freeze([
    'clientname',
    'residentnumber',
    'residentregistrationnumber',
    'phonenumber',
    'address',
    'counselingtext',
    'transcript',
    'summary',
    'password',
    'authtoken',
    'bearertoken'
]);

/**
 * 14 Reconciliation Check Codes for Restricted Voice Access Gate.
 */
export const VOICE_ACCESS_CHECK_CODES = Object.freeze({
    VOICE_ACCESS_GRANT_STORE_MISSING: 'VOICE_ACCESS_GRANT_STORE_MISSING',
    VOICE_ACCESS_GRANT_STORE_CORRUPTED: 'VOICE_ACCESS_GRANT_STORE_CORRUPTED',
    VOICE_ACCESS_HISTORY_STORE_MISSING: 'VOICE_ACCESS_HISTORY_STORE_MISSING',
    VOICE_ACCESS_HISTORY_STORE_CORRUPTED: 'VOICE_ACCESS_HISTORY_STORE_CORRUPTED',
    VOICE_ACCESS_DUPLICATE_ACTIVE_GRANT: 'VOICE_ACCESS_DUPLICATE_ACTIVE_GRANT',
    VOICE_ACCESS_GRANT_EXPIRED_ACTIVE: 'VOICE_ACCESS_GRANT_EXPIRED_ACTIVE',
    VOICE_ACCESS_GRANT_SCOPE_EXPANSION: 'VOICE_ACCESS_GRANT_SCOPE_EXPANSION',
    VOICE_ACCESS_GRANT_USER_NOT_FOUND: 'VOICE_ACCESS_GRANT_USER_NOT_FOUND',
    VOICE_ACCESS_GRANT_USER_INACTIVE: 'VOICE_ACCESS_GRANT_USER_INACTIVE',
    VOICE_ACCESS_UNKNOWN_CAPABILITY: 'VOICE_ACCESS_UNKNOWN_CAPABILITY',
    VOICE_ACCESS_HISTORY_ORPHANED: 'VOICE_ACCESS_HISTORY_ORPHANED',
    VOICE_ACCESS_HISTORY_SEQUENCE_ANOMALY: 'VOICE_ACCESS_HISTORY_SEQUENCE_ANOMALY',
    VOICE_ACCESS_GRANT_PROHIBITED_PII: 'VOICE_ACCESS_GRANT_PROHIBITED_PII',
    VOICE_ACCESS_ZERO_ACTIVE_GRANTS: 'VOICE_ACCESS_ZERO_ACTIVE_GRANTS'
});

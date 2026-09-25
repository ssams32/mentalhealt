/**
 * server/permissions/voiceCapabilities.js
 * Centralized Voice-Call Capability Definitions & Strict Default-Deny Evaluation.
 * Enforces exact lowercase role matches and strict department presence.
 */

export const VOICE_CAPABILITIES = {
    READ_ASSIGNED: 'voice_call.read_assigned',
    READ_DEPARTMENT: 'voice_call.read_department',
    PLAY_AUDIO: 'voice_call.play_audio',
    DOWNLOAD_AUDIO: 'voice_call.download_audio',
    READ_TRANSCRIPT: 'voice_call.read_transcript',
    REVIEW_SUMMARY: 'voice_call.review_summary',
    ASSIGN: 'voice_call.assign',
    REASSIGN: 'voice_call.reassign',
    UNASSIGN: 'voice_call.unassign',
    LINK_SUBJECT: 'voice_call.link_subject',
    CONVERT_ADMINISTRATIVE: 'voice_call.convert_administrative',
    RETRY_PROCESSING: 'voice_call.retry_processing',
    MANAGE_SETTINGS: 'voice_call.manage_settings'
};

export const VOICE_RECORDING_AI_ACCESS = 'VOICE_RECORDING_AI_ACCESS';
export const ONLINE_SURVEY_ACCESS = 'ONLINE_SURVEY_ACCESS';

/**
 * Check foundational Online Survey feature access:
 * isAdministrator === true OR (authenticatedUser.status === 'active' AND permissions includes ONLINE_SURVEY_ACCESS)
 */
export function hasOnlineSurveyAccess(user) {
    if (!user || user.status !== 'active') {
        return false;
    }
    if (user.role === 'admin') {
        return true;
    }
    if (!user.permissions) {
        return false;
    }
    if (Array.isArray(user.permissions)) {
        return user.permissions.includes(ONLINE_SURVEY_ACCESS);
    }
    if (typeof user.permissions === 'object' && user.permissions !== null) {
        if (typeof user.permissions[ONLINE_SURVEY_ACCESS] === 'boolean') {
            return user.permissions[ONLINE_SURVEY_ACCESS];
        }
        if (typeof user.permissions.ONLINE_SURVEY_ACCESS === 'boolean') {
            return user.permissions.ONLINE_SURVEY_ACCESS;
        }
        return false;
    }
    return false;
}

/**
 * Check foundational Voice Recording AI feature access:
 * isAdministrator === true OR authenticatedUser.permissions includes VOICE_RECORDING_AI_ACCESS
 */
export function hasVoiceAiAccess(user) {
    if (!user || user.status !== 'active') {
        return false;
    }
    if (user.role === 'admin') {
        return true;
    }
    if (!user.permissions) {
        return false;
    }
    if (Array.isArray(user.permissions)) {
        return user.permissions.includes(VOICE_RECORDING_AI_ACCESS);
    }
    if (typeof user.permissions === 'object' && user.permissions !== null) {
        if (typeof user.permissions[VOICE_RECORDING_AI_ACCESS] === 'boolean') {
            return user.permissions[VOICE_RECORDING_AI_ACCESS];
        }
        if (typeof user.permissions.VOICE_RECORDING_AI_ACCESS === 'boolean') {
            return user.permissions.VOICE_RECORDING_AI_ACCESS;
        }
        return Boolean(user.permissions.voiceCalls);
    }
    return false;
}

const ALL_CAPABILITIES = Object.values(VOICE_CAPABILITIES);

/**
 * Dynamically evaluate effective capabilities based on user role, team, and active status.
 * Strict Default-Deny: Returns [] on any unexpected, undefined, malformed, or casing mismatch.
 */
export function getEffectiveVoiceCapabilities(user, options = {}) {
    // 1. Missing user or inactive status -> Deny all
    if (!user || user.status !== 'active') {
        return [];
    }

    // 2. Strict role type check: Must be a non-empty string
    if (typeof user.role !== 'string' || user.role.trim() === '') {
        return [];
    }

    const role = user.role; // Exact match without loose .toLowerCase() or trimming

    // 3. Admin: Must be EXACT lowercase string 'admin' (rejects 'Admin', 'administrator', 'admin ')
    if (role === 'admin') {
        return [...ALL_CAPABILITIES];
    }

    // 4. Permissions object/array validation (when permissions is defined or strictly enforced)
    if (user.permissions !== undefined) {
        if (!user.permissions || (typeof user.permissions !== 'object' && !Array.isArray(user.permissions))) {
            // Malformed permissions -> Strict Default Deny
            return [];
        }
        const hasPerm = Array.isArray(user.permissions)
            ? (user.permissions.includes(VOICE_RECORDING_AI_ACCESS) || user.permissions.includes('voiceCalls'))
            : (typeof user.permissions[VOICE_RECORDING_AI_ACCESS] === 'boolean'
                ? user.permissions[VOICE_RECORDING_AI_ACCESS]
                : (typeof user.permissions.VOICE_RECORDING_AI_ACCESS === 'boolean'
                    ? user.permissions.VOICE_RECORDING_AI_ACCESS
                    : Boolean(user.permissions.voiceCalls)));
        if (!hasPerm) {
            return [];
        }
    } else if (options && options.requirePermissions) {
        // Permissions required but undefined -> Strict Default Deny
        return [];
    }

    // 4. Manager: Must be EXACT lowercase string 'manager' AND have a valid, non-empty team
    if (role === 'manager') {
        if (!user.team || typeof user.team !== 'string' || user.team.trim() === '') {
            // Manager without a valid assigned department is denied capabilities
            return [];
        }

        return [
            VOICE_CAPABILITIES.READ_ASSIGNED,
            VOICE_CAPABILITIES.READ_DEPARTMENT,
            VOICE_CAPABILITIES.PLAY_AUDIO,
            VOICE_CAPABILITIES.READ_TRANSCRIPT,
            VOICE_CAPABILITIES.REVIEW_SUMMARY,
            VOICE_CAPABILITIES.ASSIGN,
            VOICE_CAPABILITIES.REASSIGN,
            VOICE_CAPABILITIES.LINK_SUBJECT,
            VOICE_CAPABILITIES.CONVERT_ADMINISTRATIVE,
            VOICE_CAPABILITIES.RETRY_PROCESSING
        ];
    }

    // 5. User: Must be EXACT lowercase string 'user'
    if (role === 'user') {
        return [
            VOICE_CAPABILITIES.READ_ASSIGNED,
            VOICE_CAPABILITIES.PLAY_AUDIO,
            VOICE_CAPABILITIES.READ_TRANSCRIPT,
            VOICE_CAPABILITIES.REVIEW_SUMMARY,
            VOICE_CAPABILITIES.LINK_SUBJECT
        ];
    }

    // 6. Unknown role, partial matches, or unauthorized strings -> Strict Default Deny
    return [];
}

/**
 * Check if user possesses a specific capability.
 */
export function hasVoiceCapability(user, requiredCapability, options = {}) {
    if (!requiredCapability || typeof requiredCapability !== 'string') {
        return false;
    }
    const caps = getEffectiveVoiceCapabilities(user, options);
    return caps.includes(requiredCapability);
}

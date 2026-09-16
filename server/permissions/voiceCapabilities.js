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

    // 4. Permissions object validation (when permissions is defined or strictly enforced)
    if (user.permissions !== undefined) {
        if (typeof user.permissions !== 'object' || user.permissions === null || Array.isArray(user.permissions)) {
            // Malformed permissions -> Strict Default Deny
            return [];
        }
        // Permission.voiceCalls check (must be explicitly true when permissions are defined)
        if (!user.permissions.voiceCalls) {
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

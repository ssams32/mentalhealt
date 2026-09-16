/**
 * server/voice-access/voiceAccessConfig.js
 * Configuration Parsing and Validation for Mind-ERP OS Restricted Voice Access Gate.
 * Strict Separation between Configuration Parsing and Validation.
 * Prohibits logging or exposing bootstrap administrator identifiers.
 */

import path from 'path';

/**
 * @typedef {Object} VoiceAccessConfig
 * @property {boolean} enabled - Whether voice system functionality is enabled
 * @property {string} accessMode - Access control mode (must be 'allowlist')
 * @property {string|null} dataDir - Storage directory for voice access grant files
 * @property {string|null} bootstrapAdminUserId - Internal user ID authorized for initial grant
 */

/**
 * Parse environment variables into a typed configuration object.
 * Does not throw errors; returns structured configuration for validation.
 * 
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {VoiceAccessConfig}
 */
export function parseVoiceAccessConfig(env = process.env) {
    const rawEnabled = env.VOICE_SYSTEM_ENABLED;
    const rawMode = env.VOICE_SYSTEM_ACCESS_MODE;
    const rawDataDir = env.VOICE_SYSTEM_ACCESS_DATA_DIR;
    const rawBootstrapId = env.VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID || env.VOICE_ACCESS_BOOTSTRAP_ADMIN_ID;

    const enabled = String(rawEnabled).toLowerCase() === 'true';
    let accessMode = null;
    if (typeof rawMode === 'string' && rawMode.trim().length > 0) {
        const norm = rawMode.trim().toLowerCase();
        if (norm === 'strict') {
            accessMode = 'allowlist'; // Backward compatibility: map strict to allowlist without weaker behavior
        } else {
            accessMode = norm;
        }
    }

    const dataDir = typeof rawDataDir === 'string' && rawDataDir.trim().length > 0 
        ? path.resolve(rawDataDir.trim()) 
        : null;
    const bootstrapAdminUserId = typeof rawBootstrapId === 'string' && rawBootstrapId.trim().length > 0
        ? rawBootstrapId.trim()
        : null;

    return Object.freeze({
        enabled,
        accessMode,
        mode: accessMode,
        dataDir,
        bootstrapAdminUserId
    });
}

/**
 * Validate parsed configuration against strict security rules.
 * 
 * @param {VoiceAccessConfig} config
 * @param {Object} [options]
 * @param {boolean} [options.requireBootstrapAdmin=false]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateVoiceAccessConfig(config, options = {}) {
    const errors = [];

    if (!config || typeof config !== 'object') {
        return { valid: false, errors: ['Configuration must be a non-null object'] };
    }

    const mode = config.accessMode || config.mode;
    if (!mode || typeof mode !== 'string' || mode.trim().length === 0) {
        errors.push('VOICE_SYSTEM_ACCESS_MODE is required');
    } else {
        const rawMode = mode.trim().toLowerCase();
        if (['audit', 'permissive', 'role_only'].includes(rawMode)) {
            errors.push(`Prohibited access mode [${mode}]: audit, permissive, and role_only modes are strictly forbidden`);
        } else if (rawMode !== 'allowlist' && rawMode !== 'strict') {
            errors.push(`Invalid access mode [${mode}]: only 'allowlist' is supported`);
        }
    }

    if (config.enabled) {
        if (!config.dataDir || typeof config.dataDir !== 'string' || config.dataDir.trim().length === 0) {
            errors.push('VOICE_SYSTEM_ACCESS_DATA_DIR is required when voice system is enabled');
        }
    }

    if (options.requireBootstrapAdmin) {
        if (!config.bootstrapAdminUserId || typeof config.bootstrapAdminUserId !== 'string' || config.bootstrapAdminUserId.trim().length === 0) {
            errors.push('VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID is required');
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Determine if the voice access subsystem is operational based on validated config.
 * 
 * @param {VoiceAccessConfig} config
 * @returns {boolean}
 */
export function isVoiceSubsystemOperational(config) {
    if (!config) return false;
    const val = validateVoiceAccessConfig(config);
    return config.enabled === true && val.valid;
}

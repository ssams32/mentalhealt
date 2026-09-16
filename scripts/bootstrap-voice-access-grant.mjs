/**
 * scripts/bootstrap-voice-access-grant.mjs
 * Mind-ERP OS Track A10.6: Pilot Voice Access Bootstrap Foundation.
 * 
 * One-time initial grant bootstrap utility, safe configuration validation,
 * and dry-run verification without production grant exposure.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    parseVoiceAccessConfig
} from '../server/voice-access/voiceAccessConfig.js';
import {
    VOICE_ACCESS_CAPABILITIES,
    GRANTS_FILE_NAME,
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    HISTORY_ACTIONS
} from '../server/voice-access/voiceAccessConstants.js';
import {
    VoiceAccessRepository
} from '../server/voice-access/voiceAccessRepository.js';
import {
    VoiceAccessHistoryRepository
} from '../server/voice-access/voiceAccessHistoryRepository.js';
import {
    VoiceAccessAuthorizer
} from '../server/voice-access/voiceAccessAuthorizer.js';
import {
    VoiceAccessService
} from '../server/voice-access/voiceAccessService.js';

/**
 * Default Pilot Capabilities (6 capabilities)
 * Explicitly excludes download_audio and manage_access.
 */
export const DEFAULT_PILOT_CAPABILITIES = Object.freeze([
    VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS,     // 'voice_system.access'
    VOICE_ACCESS_CAPABILITIES.VIEW,              // 'voice_call.view'
    VOICE_ACCESS_CAPABILITIES.UPLOAD,            // 'voice_call.upload'
    VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO,        // 'voice_call.play_audio'
    VOICE_ACCESS_CAPABILITIES.REVIEW,            // 'voice_call.review'
    VOICE_ACCESS_CAPABILITIES.NOTIFICATION_READ  // 'voice_notification.read'
]);

/**
 * Optional capabilities not granted by default.
 */
export const OPTIONAL_CAPABILITIES = Object.freeze([
    VOICE_ACCESS_CAPABILITIES.ASSIGN,            // 'voice_call.assign'
    VOICE_ACCESS_CAPABILITIES.REASSIGN,          // 'voice_call.reassign'
    VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO,    // 'voice_call.download_audio'
    VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS      // 'voice_system.manage_access'
]);

/**
 * Validate configuration for bootstrap eligibility.
 * 
 * @param {Object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBootstrapConfig(config) {
    const errors = [];

    if (!config || typeof config !== 'object') {
        return { valid: false, errors: ['Configuration must be a non-null object'] };
    }

    if (config.enabled !== true) {
        errors.push('VOICE_SYSTEM_ENABLED must be true');
    }

    const mode = config.accessMode || config.mode;
    if (!mode || typeof mode !== 'string' || mode.trim().length === 0) {
        errors.push('VOICE_SYSTEM_ACCESS_MODE is required');
    } else {
        const rawMode = mode.trim().toLowerCase();
        if (['audit', 'permissive', 'role_only'].includes(rawMode)) {
            errors.push(`Prohibited access mode [${mode}]: audit, permissive, and role_only are strictly forbidden`);
        } else if (rawMode !== 'allowlist' && rawMode !== 'strict') {
            errors.push(`Invalid access mode [${mode}]: only 'allowlist' is supported`);
        }
    }

    if (!config.dataDir || typeof config.dataDir !== 'string' || config.dataDir.trim().length === 0) {
        errors.push('VOICE_SYSTEM_ACCESS_DATA_DIR is required');
    }

    if (!config.bootstrapAdminUserId || typeof config.bootstrapAdminUserId !== 'string' || config.bootstrapAdminUserId.trim().length === 0) {
        errors.push('VOICE_SYSTEM_BOOTSTRAP_ADMIN_USER_ID is required');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate target bootstrap user eligibility.
 * 
 * @param {Object} user
 * @param {string} bootstrapAdminId
 * @returns {{ valid: boolean, error?: string, message?: string }}
 */
export function validateBootstrapUser(user, bootstrapAdminId) {
    if (!user || typeof user !== 'object') {
        return {
            valid: false,
            error: 'USER_NOT_FOUND',
            message: 'Bootstrap user does not exist'
        };
    }

    if (user.id !== bootstrapAdminId) {
        return {
            valid: false,
            error: 'USER_ID_MISMATCH',
            message: 'User identity does not match bootstrap administrator ID'
        };
    }

    if (user.isDeleted === true) {
        return {
            valid: false,
            error: 'USER_DELETED',
            message: 'Bootstrap user account is deleted'
        };
    }

    if (user.status === 'suspended' || user.isSuspended === true) {
        return {
            valid: false,
            error: 'USER_SUSPENDED',
            message: 'Bootstrap user account is suspended'
        };
    }

    if (user.status !== 'active') {
        return {
            valid: false,
            error: 'USER_INACTIVE',
            message: 'Bootstrap user account is inactive'
        };
    }

    if (user.role !== 'admin') {
        return {
            valid: false,
            error: 'USER_ROLE_INVALID',
            message: 'Bootstrap user must have administrator role'
        };
    }

    return { valid: true };
}

/**
 * Check if the grant store in the target directory is empty and uncorrupted.
 * 
 * @param {string} dataDir
 * @returns {{ eligible: boolean, empty: boolean, count: number, corrupted: boolean, exists: boolean, error?: string }}
 */
export function checkGrantStoreStatus(dataDir) {
    if (!dataDir) {
        return { eligible: false, empty: false, count: 0, corrupted: true, exists: false, error: 'DATA_DIR_REQUIRED' };
    }

    const grantsFile = path.join(dataDir, GRANTS_FILE_NAME);
    if (!fs.existsSync(grantsFile)) {
        return { eligible: true, empty: true, count: 0, corrupted: false, exists: false };
    }

    try {
        const content = fs.readFileSync(grantsFile, 'utf8').trim();
        if (content === '' || content === '[]') {
            return { eligible: true, empty: true, count: 0, corrupted: false, exists: true };
        }
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
            return { eligible: false, empty: false, count: 0, corrupted: true, exists: true, error: 'STORE_CORRUPTED' };
        }
        if (parsed.length === 0) {
            return { eligible: true, empty: true, count: 0, corrupted: false, exists: true };
        }
        return { eligible: false, empty: false, count: parsed.length, corrupted: false, exists: true, error: 'STORE_NOT_EMPTY' };
    } catch {
        return { eligible: false, empty: false, count: 0, corrupted: true, exists: true, error: 'STORE_CORRUPTED' };
    }
}

/**
 * Load users safely from file or store.
 * 
 * @param {string} [usersFilePath]
 * @returns {Array<Object>}
 */
export function loadUsers(usersFilePath) {
    if (!usersFilePath || !fs.existsSync(usersFilePath)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(usersFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Core Bootstrap Execution Engine.
 * 
 * @param {Object} [options]
 * @param {Record<string, string|undefined>} [options.env=process.env]
 * @param {Array<Object>} [options.users]
 * @param {string} [options.usersFilePath]
 * @param {boolean} [options.apply=false]
 * @param {Array<string>} [options.capabilities]
 * @param {boolean} [options.silent=false]
 * @returns {Promise<Object>}
 */
export async function executeBootstrap(options = {}) {
    const env = options.env || process.env;
    const isApply = options.apply === true;
    const auditSink = options.auditSink || null;
    const capabilities = Array.isArray(options.capabilities) && options.capabilities.length > 0
        ? options.capabilities
        : DEFAULT_PILOT_CAPABILITIES;

    const recordAuditSafe = async (params) => {
        if (!auditSink) return null;
        if (typeof auditSink.recordBootstrap === 'function') {
            return await auditSink.recordBootstrap(params);
        }
        if (typeof auditSink.record === 'function') {
            return await auditSink.record(params);
        }
        return null;
    };

    // 1. Parse and validate configuration
    const config = parseVoiceAccessConfig(env);
    const configVal = validateBootstrapConfig(config);

    if (!configVal.valid) {
        const errResult = {
            configurationValid: false,
            bootstrapEligible: false,
            targetUserExists: false,
            targetUserActive: false,
            grantStoreEmpty: false,
            proposedCapabilityCount: capabilities.length,
            applyRequired: !isApply,
            errors: configVal.errors
        };
        if (isApply) {
            try {
                await recordAuditSafe({
                    outcome: 'denied',
                    actorId: config?.bootstrapAdminUserId || 'unknown',
                    reasonCode: 'BOOTSTRAP_CONFIG_INVALID',
                    safeMetadata: { safeReason: 'BOOTSTRAP_VALIDATION_FAILED' }
                });
            } catch {
                // Non-blocking failure isolation
            }
        }
        if (!options.silent) {
            console.error(JSON.stringify(errResult, null, 2));
        }
        const err = new Error('Configuration validation failed');
        err.result = errResult;
        throw err;
    }

    // 2. Check store status
    const storeStatus = checkGrantStoreStatus(config.dataDir);
    if (storeStatus.corrupted) {
        const errResult = {
            configurationValid: true,
            bootstrapEligible: false,
            targetUserExists: false,
            targetUserActive: false,
            grantStoreEmpty: false,
            proposedCapabilityCount: capabilities.length,
            applyRequired: !isApply,
            errors: ['Grant store is corrupted; refusing automatic overwrite']
        };
        if (isApply) {
            try {
                await recordAuditSafe({
                    outcome: 'denied',
                    actorId: config?.bootstrapAdminUserId || 'unknown',
                    reasonCode: 'BOOTSTRAP_STORE_CORRUPTED',
                    safeMetadata: { safeReason: 'GRANT_STORE_CORRUPTED' }
                });
            } catch {
                // Non-blocking isolation
            }
        }
        if (!options.silent) {
            console.error(JSON.stringify(errResult, null, 2));
        }
        const err = new Error('Grant store corrupted');
        err.result = errResult;
        throw err;
    }

    if (!storeStatus.empty) {
        const errResult = {
            configurationValid: true,
            bootstrapEligible: false,
            targetUserExists: false,
            targetUserActive: false,
            grantStoreEmpty: false,
            proposedCapabilityCount: capabilities.length,
            applyRequired: !isApply,
            errors: ['Grant store is not empty; bootstrap already initialized or existing grants found']
        };
        if (isApply) {
            try {
                await recordAuditSafe({
                    outcome: 'denied',
                    actorId: config?.bootstrapAdminUserId || 'unknown',
                    reasonCode: 'BOOTSTRAP_ALREADY_INITIALIZED',
                    safeMetadata: { safeReason: 'GRANT_STORE_NOT_EMPTY' }
                });
            } catch {
                // Non-blocking isolation
            }
        }
        if (!options.silent) {
            console.error(JSON.stringify(errResult, null, 2));
        }
        const err = new Error('Grant store not empty');
        err.result = errResult;
        throw err;
    }

    // 3. User Resolution and Verification
    let users = options.users;
    if (!Array.isArray(users)) {
        const usersFile = options.usersFilePath || (env.DATA_DIR ? path.join(env.DATA_DIR, 'Users.json') : null);
        users = loadUsers(usersFile);
    }

    const targetUser = users.find(u => u && u.id === config.bootstrapAdminUserId);
    const userVal = validateBootstrapUser(targetUser, config.bootstrapAdminUserId);

    if (!userVal.valid) {
        const errResult = {
            configurationValid: true,
            bootstrapEligible: false,
            targetUserExists: !!targetUser,
            targetUserActive: targetUser ? (targetUser.status === 'active' && !targetUser.isDeleted && targetUser.status !== 'suspended') : false,
            grantStoreEmpty: true,
            proposedCapabilityCount: capabilities.length,
            applyRequired: !isApply,
            errors: [userVal.message || 'Bootstrap user invalid']
        };
        if (isApply) {
            try {
                await recordAuditSafe({
                    outcome: 'denied',
                    actorId: targetUser?.id || config?.bootstrapAdminUserId || 'unknown',
                    reasonCode: 'BOOTSTRAP_USER_INVALID',
                    safeMetadata: { safeReason: userVal.error || 'BOOTSTRAP_USER_INELIGIBLE' }
                });
            } catch {
                // Non-blocking isolation
            }
        }
        if (!options.silent) {
            console.error(JSON.stringify(errResult, null, 2));
        }
        const err = new Error(userVal.message || 'Bootstrap user invalid');
        err.result = errResult;
        throw err;
    }

    // 4. Dry-run execution (guaranteed zero audit records)
    if (!isApply) {
        const dryRunSummary = {
            configurationValid: true,
            bootstrapEligible: true,
            targetUserExists: true,
            targetUserActive: true,
            grantStoreEmpty: true,
            proposedCapabilityCount: capabilities.length,
            applyRequired: true
        };
        if (!options.silent) {
            console.log(JSON.stringify(dryRunSummary, null, 2));
        }
        return dryRunSummary;
    }

    // 5. Real apply execution
    // Pre-flight check: ensure directory exists
    if (!fs.existsSync(config.dataDir)) {
        fs.mkdirSync(config.dataDir, { recursive: true });
    }

    const repo = new VoiceAccessRepository({ dataDir: config.dataDir });
    const histRepo = new VoiceAccessHistoryRepository({ dataDir: config.dataDir });
    const authorizer = new VoiceAccessAuthorizer({ repository: repo, mode: config.mode });
    const service = new VoiceAccessService({
        voiceAccessRepo: repo,
        voiceAccessHistoryRepo: histRepo,
        voiceAccessAuthorizer: authorizer,
        config
    });

    // Execute atomic creation through service
    const createdGrant = await service.initializeBootstrapGrant(targetUser, {
        capabilities,
        scope: { type: ACCESS_SCOPE_TYPE.ALL },
        reason: 'Safe Pilot Bootstrap Grant'
    });

    const applySummary = {
        success: true,
        action: 'BOOTSTRAP_GRANT_CREATED',
        grantCreated: true,
        historyRecorded: true,
        capabilitiesCount: createdGrant.capabilities.length,
        status: createdGrant.status,
        auditRecorded: false
    };

    // Record bootstrap success audit after grant and history persist
    if (auditSink) {
        try {
            const auditRes = await recordAuditSafe({
                outcome: 'success',
                actorId: targetUser.id,
                grantId: createdGrant.id,
                reasonCode: 'BOOTSTRAP_GRANT_INITIALIZED',
                safeMetadata: {
                    capabilityCount: createdGrant.capabilities.length,
                    grantScopeType: createdGrant.scope?.type || 'all',
                    bootstrapAction: 'INITIAL_GRANT_CREATED'
                }
            });
            if (auditRes && auditRes.recorded === false && auditRes.error) {
                applySummary.auditRecorded = false;
                applySummary.auditError = auditRes.error;
            } else {
                applySummary.auditRecorded = true;
            }
        } catch (auditErr) {
            applySummary.auditRecorded = false;
            applySummary.auditError = auditErr.message;
        }
    }

    if (!options.silent) {
        console.log(JSON.stringify(applySummary, null, 2));
    }

    return applySummary;
}

// CLI Execution Support
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) {
    const args = process.argv.slice(2);
    const hasApply = args.includes('--apply');
    const isDryRun = args.includes('--dry-run') || !hasApply;

    executeBootstrap({
        apply: hasApply && !isDryRun,
        silent: false
    }).then(() => {
        process.exit(0);
    }).catch(() => {
        process.exit(1);
    });
}

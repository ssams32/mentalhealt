/**
 * server/voice-access/voiceAccessService.js
 * Business Logic and Lifecycle Management for Voice System Access Grants.
 * Enforces Bootstrap Gate, OCC Versioning, Soft Revocation, and Safe UI Summary Generation.
 */

import {
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    VOICE_ACCESS_CAPABILITIES,
    HISTORY_ACTIONS
} from './voiceAccessConstants.js';
import { VoiceAccessError, VOICE_ACCESS_ERROR_CODES } from './voiceAccessErrors.js';
import { validateGrantInput } from './voiceAccessValidator.js';

export class VoiceAccessService {
    /**
     * @param {Object} deps
     * @param {import('./voiceAccessRepository.js').VoiceAccessRepository} deps.voiceAccessRepo
     * @param {import('./voiceAccessHistoryRepository.js').VoiceAccessHistoryRepository} deps.voiceAccessHistoryRepo
     * @param {import('./voiceAccessAuthorizer.js').VoiceAccessAuthorizer} deps.voiceAccessAuthorizer
     */
    constructor(deps = {}) {
        if (!deps.voiceAccessRepo || !deps.voiceAccessHistoryRepo || !deps.voiceAccessAuthorizer) {
            throw new Error('VoiceAccessService requires voiceAccessRepo, voiceAccessHistoryRepo, and voiceAccessAuthorizer');
        }
        this.voiceAccessRepo = deps.voiceAccessRepo;
        this.voiceAccessHistoryRepo = deps.voiceAccessHistoryRepo;
        this.voiceAccessAuthorizer = deps.voiceAccessAuthorizer;
        this.config = deps.config || null;
        this.auditAdapter = deps.auditAdapter || deps.auditSink || null;
    }

    /**
     * Check if an actor has administrative permission to manage grants.
     * @private
     */
    async _assertCanManageAccess(actor) {
        if (!actor || !actor.id) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.UNAUTHENTICATED,
                'Authentication required',
                401
            );
        }
        const auth = await this.voiceAccessAuthorizer.authorize(
            actor,
            VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS
        );
        if (!auth.allowed) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.ACCESS_DENIED,
                'Actor lacks voice_system.manage_access permission',
                403
            );
        }
    }

    /**
     * Alias for createInitialBootstrapGrant with auto userId fallback.
     */
    async initializeBootstrapGrant(actor, grantData = {}) {
        const payload = {
            ...grantData,
            userId: grantData.userId || actor?.id
        };
        return this.createInitialBootstrapGrant(actor, payload);
    }

    /**
     * Initialize the first grant via Bootstrap Administrator.
     * Only permitted if the grant store is empty (0 grants exist).
     */
    async createInitialBootstrapGrant(actor, grantData) {
        if (!actor || !actor.id || actor.role !== 'admin') {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_UNAUTHORIZED,
                'Only an internal administrator can execute bootstrap grant initialization',
                403
            );
        }

        const configuredBootstrapId = this.config?.bootstrapAdminUserId;
        if (!configuredBootstrapId || typeof configuredBootstrapId !== 'string' || configuredBootstrapId.trim().length === 0) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_UNAUTHORIZED,
                'Bootstrap administrator user ID is not configured: first-grant initialization denied',
                403
            );
        }

        if (actor.id !== configuredBootstrapId.trim()) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_UNAUTHORIZED,
                'Only the configured bootstrap administrator can initialize bootstrap grants',
                403
            );
        }

        const totalGrants = await this.voiceAccessRepo.count();
        if (totalGrants > 0) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.BOOTSTRAP_ALREADY_INITIALIZED,
                'Bootstrap grant initialization is only permitted when the grant store is empty',
                409
            );
        }

        validateGrantInput(grantData, true);

        const now = new Date().toISOString();
        const grant = {
            id: `grant_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            userId: grantData.userId,
            status: GRANT_STATUS.ACTIVE,
            capabilities: grantData.capabilities,
            scope: grantData.scope || { type: ACCESS_SCOPE_TYPE.ALL },
            grantedBy: actor.id,
            grantedAt: now,
            updatedAt: now,
            expiresAt: grantData.expiresAt || null,
            version: 1,
            reason: grantData.reason || 'Initial bootstrap grant'
        };

        const saved = await this.voiceAccessRepo.saveGrantAtomic(grant);

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: saved.id,
            userId: saved.userId,
            action: HISTORY_ACTIONS.CREATE,
            performedBy: actor.id,
            performedAt: now,
            changes: { initialCapabilities: saved.capabilities, initialScope: saved.scope },
            reason: saved.reason
        });

        return saved;
    }

    /**
     * Create a new access grant. Requires voice_system.manage_access.
     */
    async createGrant(actor, grantData) {
        await this._assertCanManageAccess(actor);
        validateGrantInput(grantData, true);

        const now = new Date().toISOString();
        const grant = {
            id: `grant_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            userId: grantData.userId,
            status: GRANT_STATUS.ACTIVE,
            capabilities: grantData.capabilities,
            scope: grantData.scope || { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY },
            grantedBy: actor.id,
            grantedAt: now,
            updatedAt: now,
            expiresAt: grantData.expiresAt || null,
            version: 1,
            reason: grantData.reason || null
        };

        const saved = await this.voiceAccessRepo.saveGrantAtomic(grant);

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: saved.id,
            userId: saved.userId,
            action: HISTORY_ACTIONS.CREATE,
            performedBy: actor.id,
            performedAt: now,
            changes: { capabilities: saved.capabilities, scope: saved.scope },
            reason: saved.reason
        });

        return saved;
    }

    /**
     * Update grant capabilities with OCC protection.
     */
    async updateGrantCapabilities(actor, grantId, capabilities, expectedVersion, reason = null) {
        await this._assertCanManageAccess(actor);
        validateGrantInput({ capabilities, reason }, false);

        const current = await this.voiceAccessRepo.findById(grantId);
        if (!current) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.NOT_FOUND,
                `Grant [${grantId}] not found`,
                404
            );
        }

        const prevCapabilities = [...current.capabilities];
        current.capabilities = capabilities;
        current.reason = reason;

        const updated = await this.voiceAccessRepo.saveGrantAtomic(current, { expectedVersion });

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: updated.id,
            userId: updated.userId,
            action: HISTORY_ACTIONS.UPDATE_CAPABILITIES,
            performedBy: actor.id,
            performedAt: new Date().toISOString(),
            changes: { prevCapabilities, newCapabilities: capabilities },
            reason
        });

        return updated;
    }

    /**
     * Update grant scope with OCC protection.
     */
    async updateGrantScope(actor, grantId, scope, expectedVersion, reason = null) {
        await this._assertCanManageAccess(actor);
        validateGrantInput({ scope, reason }, false);

        const current = await this.voiceAccessRepo.findById(grantId);
        if (!current) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.NOT_FOUND,
                `Grant [${grantId}] not found`,
                404
            );
        }

        const prevScope = { ...current.scope };
        current.scope = scope;
        current.reason = reason;

        const updated = await this.voiceAccessRepo.saveGrantAtomic(current, { expectedVersion });

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: updated.id,
            userId: updated.userId,
            action: HISTORY_ACTIONS.UPDATE_SCOPE,
            performedBy: actor.id,
            performedAt: new Date().toISOString(),
            changes: { prevScope, newScope: scope },
            reason
        });

        return updated;
    }

    /**
     * Suspend an active grant with OCC.
     */
    async suspendGrant(actor, grantId, expectedVersion, reason = null) {
        await this._assertCanManageAccess(actor);

        const current = await this.voiceAccessRepo.findById(grantId);
        if (!current) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.NOT_FOUND,
                `Grant [${grantId}] not found`,
                404
            );
        }

        const prevStatus = current.status;
        current.status = GRANT_STATUS.SUSPENDED;
        current.reason = reason;

        const updated = await this.voiceAccessRepo.saveGrantAtomic(current, { expectedVersion });

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: updated.id,
            userId: updated.userId,
            action: HISTORY_ACTIONS.SUSPEND,
            performedBy: actor.id,
            performedAt: new Date().toISOString(),
            changes: { prevStatus, newStatus: GRANT_STATUS.SUSPENDED },
            reason
        });

        return updated;
    }

    /**
     * Reactivate a suspended grant with OCC.
     */
    async reactivateGrant(actor, grantId, expectedVersion, reason = null) {
        await this._assertCanManageAccess(actor);

        const current = await this.voiceAccessRepo.findById(grantId);
        if (!current) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.NOT_FOUND,
                `Grant [${grantId}] not found`,
                404
            );
        }

        const prevStatus = current.status;
        current.status = GRANT_STATUS.ACTIVE;
        current.reason = reason;

        const updated = await this.voiceAccessRepo.saveGrantAtomic(current, { expectedVersion });

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: updated.id,
            userId: updated.userId,
            action: HISTORY_ACTIONS.REACTIVATE,
            performedBy: actor.id,
            performedAt: new Date().toISOString(),
            changes: { prevStatus, newStatus: GRANT_STATUS.ACTIVE },
            reason
        });

        return updated;
    }

    /**
     * Soft Revoke a grant with OCC. Does not hard-delete records.
     */
    async revokeGrant(actor, grantId, expectedVersion, reason = null) {
        await this._assertCanManageAccess(actor);

        const current = await this.voiceAccessRepo.findById(grantId);
        if (!current) {
            throw new VoiceAccessError(
                VOICE_ACCESS_ERROR_CODES.NOT_FOUND,
                `Grant [${grantId}] not found`,
                404
            );
        }

        const prevStatus = current.status;
        current.status = GRANT_STATUS.REVOKED;
        current.reason = reason;

        const updated = await this.voiceAccessRepo.saveGrantAtomic(current, { expectedVersion });

        await this.voiceAccessHistoryRepo.appendEntry({
            grantId: updated.id,
            userId: updated.userId,
            action: HISTORY_ACTIONS.REVOKE,
            performedBy: actor.id,
            performedAt: new Date().toISOString(),
            changes: { prevStatus, newStatus: GRANT_STATUS.REVOKED },
            reason
        });

        return updated;
    }

    /**
     * Generate Safe UI Summary for Menu Visibility.
     * Exposes ONLY boolean flags. Zero grant IDs, grantedBy, bootstrap IDs, or full arrays.
     * 
     * @param {Object} user
     * @param {Object} [options]
     * @param {boolean} [options.voiceSystemEnabled]
     * @returns {Promise<Object>}
     */
    async getSafeAccessSummary(user, options = {}) {
        const isEnabled = options.voiceSystemEnabled !== undefined 
            ? Boolean(options.voiceSystemEnabled) 
            : (this.config ? Boolean(this.config.enabled) : true);

        const defaultDenySummary = {
            voiceSystemEnabled: isEnabled,
            hasVoiceSystemAccess: false,
            canView: false,
            canUpload: false,
            canPlayAudio: false,
            canDownloadAudio: false,
            canAssign: false,
            canReassign: false,
            canReview: false,
            canReadNotifications: false,
            // Aliases for compatibility
            canAccessVoiceSystem: false,
            canViewCalls: false,
            canUploadCalls: false,
            canAssignCalls: false,
            canReviewCalls: false,
            canManageAccess: false
        };

        if (!isEnabled) {
            return defaultDenySummary;
        }

        const gate = await this.voiceAccessAuthorizer.canAccessVoiceSystem(user);
        if (!gate.allowed) {
            return defaultDenySummary;
        }

        const grant = gate.grant;
        const effectiveCaps = this.voiceAccessAuthorizer.getEffectiveCapabilities(user, grant);

        const canView = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.VIEW);
        const canUpload = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.UPLOAD);
        const canPlay = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.PLAY_AUDIO);
        const canDownload = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.DOWNLOAD_AUDIO);
        const canAssign = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.ASSIGN);
        const canReassign = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.REASSIGN);
        const canReview = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.REVIEW);
        const canReadNotifs = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.NOTIFICATION_READ);
        const canManage = effectiveCaps.includes(VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS);

        return {
            voiceSystemEnabled: true,
            hasVoiceSystemAccess: true,
            canView,
            canUpload,
            canPlayAudio: canPlay,
            canDownloadAudio: canDownload,
            canAssign,
            canReassign,
            canReview,
            canReadNotifications: canReadNotifs,
            // Aliases for compatibility
            canAccessVoiceSystem: true,
            canViewCalls: canView,
            canUploadCalls: canUpload,
            canAssignCalls: canAssign,
            canReviewCalls: canReview,
            canManageAccess: canManage
        };
    }
}


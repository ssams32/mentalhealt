/**
 * server/voice-access/voiceAccessAuthorizer.js
 * Central Authorization Engine for Mind-ERP OS Restricted Voice Access Gate.
 * Enforces Default-Deny, Role ∩ Grant Capability Intersection, Scope Restriction, and Fail-Closed Storage.
 */

import {
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    VOICE_ACCESS_CAPABILITIES
} from './voiceAccessConstants.js';
import { VoiceAccessError, VOICE_ACCESS_ERROR_CODES } from './voiceAccessErrors.js';
import { getEffectiveVoiceCapabilities } from '../permissions/voiceCapabilities.js';

export class VoiceAccessAuthorizer {
    /**
     * @param {Object} deps
     * @param {import('./voiceAccessRepository.js').VoiceAccessRepository} deps.voiceAccessRepo
     */
    constructor(deps = {}) {
        const repo = deps.voiceAccessRepo || deps.repository;
        if (!repo) {
            throw new Error('VoiceAccessAuthorizer requires deps.voiceAccessRepo or deps.repository');
        }
        this.voiceAccessRepo = repo;
        this.auditAdapter = deps.auditAdapter || deps.auditSink || null;
    }

    /**
     * Determine if a user's account itself is valid and active.
     * Denies inactive, suspended, or deleted accounts.
     * @param {Object} user
     * @returns {{ valid: boolean, reason?: string }}
     */
    isAccountActive(user) {
        if (!user || typeof user !== 'object') {
            return { valid: false, reason: 'UNAUTHENTICATED' };
        }
        if (!user.id || typeof user.id !== 'string') {
            return { valid: false, reason: 'INVALID_USER_ID' };
        }
        if (user.status !== 'active') {
            return { valid: false, reason: 'ACCOUNT_NOT_ACTIVE' };
        }
        if (user.isDeleted === true) {
            return { valid: false, reason: 'ACCOUNT_DELETED' };
        }
        if (user.isSuspended === true) {
            return { valid: false, reason: 'ACCOUNT_SUSPENDED' };
        }
        return { valid: true };
    }

    /**
     * Compose effective scope: Grant scope must NEVER expand Role scope.
     * - User role ceiling: ASSIGNED_ONLY
     * - Manager role ceiling: DEPARTMENT (bound to user.team)
     * - Admin role ceiling: ALL
     * @param {Object} user
     * @param {Object} grant
     * @returns {{ allowed: boolean, type?: string, departmentId?: string, reason?: string }}
     */
    resolveEffectiveScope(user, grant) {
        const role = user.role;
        const grantScope = grant.scope || { type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY };

        if (role === 'user') {
            // User ceiling is ASSIGNED_ONLY regardless of grant
            return {
                allowed: true,
                type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY
            };
        }

        if (role === 'manager') {
            const userDept = user.team;
            if (!userDept || typeof userDept !== 'string' || userDept.trim() === '') {
                return { allowed: false, reason: 'MANAGER_DEPARTMENT_MISSING' };
            }

            // If grant is assigned_only, manager is restricted to assigned_only
            if (grantScope.type === ACCESS_SCOPE_TYPE.ASSIGNED_ONLY) {
                return {
                    allowed: true,
                    type: ACCESS_SCOPE_TYPE.ASSIGNED_ONLY
                };
            }

            // If grant specifies a department, it MUST match the manager's department
            if (grantScope.type === ACCESS_SCOPE_TYPE.DEPARTMENT) {
                if (grantScope.departmentId && grantScope.departmentId !== userDept) {
                    return { allowed: false, reason: 'GRANT_DEPARTMENT_MISMATCH' };
                }
            }

            // Manager ceiling is DEPARTMENT (cannot be ALL)
            return {
                allowed: true,
                type: ACCESS_SCOPE_TYPE.DEPARTMENT,
                departmentId: userDept
            };
        }

        if (role === 'admin') {
            // Admin can have whatever scope the grant specifies
            return {
                allowed: true,
                type: grantScope.type,
                departmentId: grantScope.departmentId
            };
        }

        // Unknown role
        return { allowed: false, reason: 'UNKNOWN_ROLE' };
    }

    /**
     * Evaluates effective capabilities: Intersection of Role Capabilities and Grant Capabilities.
     * @param {Object} user
     * @param {Object} grant
     * @returns {string[]}
     */
    getEffectiveCapabilities(user, grant) {
        if (!grant || grant.status !== GRANT_STATUS.ACTIVE) {
            return [];
        }

        // Role capabilities from standard voice permissions
        const roleCaps = getEffectiveVoiceCapabilities(user);

        // Grant capabilities array
        const grantCaps = Array.isArray(grant.capabilities) ? grant.capabilities : [];

        // Check foundational access in grant
        if (!grantCaps.includes(VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS)) {
            return [];
        }

        // Intersection for feature capabilities
        // Note: Foundational and management capabilities are evaluated through grant if role allows
        const effective = [];

        for (const cap of grantCaps) {
            if (cap === VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS) {
                effective.push(cap);
            } else if (cap === VOICE_ACCESS_CAPABILITIES.MANAGE_ACCESS) {
                // Only admin role may have manage_access
                if (user.role === 'admin') {
                    effective.push(cap);
                }
            } else if (cap === VOICE_ACCESS_CAPABILITIES.VIEW || cap === VOICE_ACCESS_CAPABILITIES.REVIEW || cap === VOICE_ACCESS_CAPABILITIES.NOTIFICATION_READ) {
                // View/Review/Notification mapping
                effective.push(cap);
            } else if (roleCaps.includes(cap)) {
                // Must be allowed by role
                effective.push(cap);
            }
        }

        return effective;
    }

    /**
     * Foundational Gate Check: Can the user access the voice system at all?
     * @param {Object} user
     * @returns {Promise<{ allowed: boolean, reason?: string, grant?: Object }>}
     */
    async canAccessVoiceSystem(user) {
        // 1. Account Active Check
        const acct = this.isAccountActive(user);
        if (!acct.valid) {
            return { allowed: false, reason: acct.reason };
        }

        // 2. Fetch Grant (Active or latest, Fail-Closed if corrupted)
        let grant;
        try {
            grant = await this.voiceAccessRepo.findActiveByUserId(user.id, { includeExpired: true });
            if (!grant) {
                const userGrants = await this.voiceAccessRepo.findByUserId(user.id);
                if (userGrants && userGrants.length > 0) {
                    grant = userGrants[userGrants.length - 1];
                }
            }
        } catch (err) {
            return { allowed: false, reason: 'STORE_CORRUPTED' };
        }

        if (!grant) {
            return { allowed: false, reason: 'GRANT_NOT_FOUND' };
        }

        // 3. Expiration Check
        if (grant.expiresAt) {
            const exp = new Date(grant.expiresAt);
            if (new Date() > exp) {
                return { allowed: false, reason: 'GRANT_EXPIRED' };
            }
        }

        // 4. Status Check
        if (grant.status !== GRANT_STATUS.ACTIVE) {
            return { allowed: false, reason: `GRANT_${grant.status.toUpperCase()}` };
        }

        // 5. Foundational Capability Check
        if (!Array.isArray(grant.capabilities) || !grant.capabilities.includes(VOICE_ACCESS_CAPABILITIES.SYSTEM_ACCESS)) {
            return { allowed: false, reason: 'FOUNDATIONAL_ACCESS_REQUIRED' };
        }

        return { allowed: true, grant };
    }

    /**
     * Authorize an action on a specific capability and optional resource.
     * @param {Object} user
     * @param {string} requiredCapability
     * @param {Object} [resource]
     * @returns {Promise<{ allowed: boolean, reason?: string, effectiveScope?: Object }>}
     */
    async authorize(user, requiredCapability, resource = null) {
        // 1. Foundational Gate
        const gate = await this.canAccessVoiceSystem(user);
        if (!gate.allowed) {
            return { allowed: false, reason: gate.reason };
        }

        const grant = gate.grant;

        // 2. Check if required capability is present in effective capabilities
        const effectiveCaps = this.getEffectiveCapabilities(user, grant);
        if (!effectiveCaps.includes(requiredCapability)) {
            return { allowed: false, reason: 'CAPABILITY_DENIED' };
        }

        // 3. Scope Resolution
        const scopeRes = this.resolveEffectiveScope(user, grant);
        if (!scopeRes.allowed) {
            return { allowed: false, reason: scopeRes.reason };
        }

        // 4. Resource Clearance (if a specific resource is provided)
        if (resource) {
            if (scopeRes.type === ACCESS_SCOPE_TYPE.ASSIGNED_ONLY) {
                const assignedUser = resource.assignedUserId;
                if (!assignedUser || assignedUser !== user.id) {
                    return { allowed: false, reason: 'RESOURCE_ASSIGNMENT_MISMATCH' };
                }
            } else if (scopeRes.type === ACCESS_SCOPE_TYPE.DEPARTMENT) {
                const resourceDept = resource.assignedDepartmentId || resource.assignedDepartment;
                if (!resourceDept || resourceDept !== scopeRes.departmentId) {
                    return { allowed: false, reason: 'RESOURCE_DEPARTMENT_MISMATCH' };
                }
            }
        }

        return {
            allowed: true,
            effectiveScope: scopeRes
        };
    }
}

/**
 * server/permissions/resourceScope.js
 * Resource Scope Access Control (Separation of Capability vs Resource Scope).
 * Enforces that having a capability (e.g. play_audio) does NOT grant access to resources
 * outside the user's assigned or department boundary.
 * Strict default-deny on unknown roles, missing teams, and unknown actions.
 */

import { resolveCanonicalDepartmentId } from './canonicalDepartment.js';

export const RESOURCE_SCOPES = {
    ALL: 'all',
    DEPARTMENT: 'department',
    ASSIGNED_TO_ME: 'assigned_to_me',
    NONE: 'none'
};

export const VALID_RESOURCE_ACTIONS = [
    'read',
    'play',
    'download',
    'assign',
    'reassign',
    'unassign',
    'link',
    'review'
];

/**
 * Determine maximum allowable resource scope for a user based on strict server-verified identity.
 */
export function getUserResourceScope(user) {
    if (!user || user.status !== 'active') {
        return RESOURCE_SCOPES.NONE;
    }

    // Strict role check without loose lowercasing
    const role = user.role;

    if (role === 'admin') {
        return RESOURCE_SCOPES.ALL;
    }

    if (role === 'manager') {
        if (!user.team || typeof user.team !== 'string' || user.team.trim() === '') {
            return RESOURCE_SCOPES.NONE;
        }
        return RESOURCE_SCOPES.DEPARTMENT;
    }

    if (role === 'user') {
        return RESOURCE_SCOPES.ASSIGNED_TO_ME;
    }

    return RESOURCE_SCOPES.NONE;
}

/**
 * Authorize access to a specific resource record.
 * Uses trusted server-loaded database record; strictly ignores spoofed request parameters.
 * 
 * @param {Object} user - Sanitized user object from req.auth
 * @param {Object} resource - Loaded database record (e.g. VoiceCallRecord or Referral)
 * @param {string} [action='read'] - Requested action (e.g. 'read', 'play', 'assign')
 * @returns {{ allowed: boolean, scope: string, reason?: string, auditRequired?: boolean }}
 */
export function authorizeResourceAccess(user, resource, action = 'read') {
    // 1. Validate action
    if (!VALID_RESOURCE_ACTIONS.includes(action)) {
        return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: `Unknown resource action: ${action}` };
    }

    // 2. Validate user active status
    if (!user || user.status !== 'active') {
        return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: 'Inactive or missing user' };
    }

    // 3. Validate resource presence
    if (!resource || typeof resource !== 'object' || Object.keys(resource).length === 0) {
        return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: 'Resource not found or empty' };
    }

    // 4. Deleted / archived resource policy: inactive resources are denied by default
    if (resource.isDeleted === true || resource.status === 'deleted') {
        return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: 'Resource is deleted or archived' };
    }

    const userScope = getUserResourceScope(user);
    if (userScope === RESOURCE_SCOPES.NONE) {
        return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: 'User has no valid resource scope' };
    }

    // 5. Admin: Unrestricted scope, but audit log is always mandatory
    if (userScope === RESOURCE_SCOPES.ALL) {
        return { allowed: true, scope: RESOURCE_SCOPES.ALL, auditRequired: true };
    }

    // 6. Manager: Department scope
    if (userScope === RESOURCE_SCOPES.DEPARTMENT) {
        const rawResourceDept = resource.assignedDepartmentId || resource.owningDepartmentId || resource.intakeDepartmentId || resource.assignedDepartment || resource.team || resource.department;
        const resourceDeptId = resolveCanonicalDepartmentId(rawResourceDept);
        const userDeptId = resolveCanonicalDepartmentId(user.team);

        if (!resourceDeptId) {
            return { allowed: false, scope: RESOURCE_SCOPES.DEPARTMENT, reason: 'Resource lacks valid assigned department' };
        }
        if (!userDeptId) {
            return { allowed: false, scope: RESOURCE_SCOPES.DEPARTMENT, reason: 'User lacks valid department team' };
        }

        if (resourceDeptId === userDeptId) {
            return { allowed: true, scope: RESOURCE_SCOPES.DEPARTMENT, auditRequired: true };
        }

        return { 
            allowed: false, 
            scope: RESOURCE_SCOPES.DEPARTMENT, 
            reason: `Resource department (${resourceDeptId}) does not match manager department (${userDeptId})` 
        };
    }

    // 7. Regular User: Assigned-only scope
    if (userScope === RESOURCE_SCOPES.ASSIGNED_TO_ME) {
        const resourceAssigneeId = resource.assignedUserId || resource.assigneeId;

        if (!resourceAssigneeId || String(resourceAssigneeId).trim() === '') {
            return { allowed: false, scope: RESOURCE_SCOPES.ASSIGNED_TO_ME, reason: 'Resource lacks assignedUserId or is unassigned' };
        }

        if (String(resourceAssigneeId) === String(user.id)) {
            return { allowed: true, scope: RESOURCE_SCOPES.ASSIGNED_TO_ME, auditRequired: true };
        }

        return { 
            allowed: false, 
            scope: RESOURCE_SCOPES.ASSIGNED_TO_ME, 
            reason: 'Resource is not assigned to the requesting user' 
        };
    }

    return { allowed: false, scope: RESOURCE_SCOPES.NONE, reason: 'Access denied by default' };
}

/**
 * Middleware factory to enforce resource-level authorization.
 * 
 * @param {Function} loadResourceFn - async (req) => Promise<resourceRecord | null>
 * @param {string} [action='read']
 */
export function requireResourceAccess(loadResourceFn, action = 'read') {
    return async (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '로그인이 필요합니다.'
                }
            });
        }

        try {
            const resource = await loadResourceFn(req);
            if (!resource) {
                return res.status(404).json({
                    error: {
                        code: 'NOT_FOUND',
                        message: '요청한 리소스를 찾을 수 없습니다.'
                    }
                });
            }

            const authResult = authorizeResourceAccess(req.auth, resource, action);
            if (!authResult.allowed) {
                return res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: '이 리소스에 접근할 권한이 없습니다.'
                    }
                });
            }

            req.resource = resource;
            req.resourceScope = authResult.scope;
            req.auditRequired = authResult.auditRequired;
            next();
        } catch (err) {
            console.error('Resource authorization error:', err);
            return res.status(500).json({
                error: {
                    code: 'INTERNAL_ERROR',
                    message: '권한 검사 중 오류가 발생했습니다.'
                }
            });
        }
    };
}

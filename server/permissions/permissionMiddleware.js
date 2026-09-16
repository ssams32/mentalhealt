import { hasVoiceCapability, getEffectiveVoiceCapabilities } from './voiceCapabilities.js';

/**
 * server/permissions/permissionMiddleware.js
 * Authorization guard middlewares for Voice Call endpoints and capabilities.
 */

/**
 * Enforce a specific Voice Call capability.
 * Returns 403 FORBIDDEN if user lacks capability.
 */
export function requireVoiceCapability(requiredCapability) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '로그인이 필요합니다.'
                }
            });
        }

        if (!hasVoiceCapability(req.auth, requiredCapability)) {
            return res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: '이 작업을 수행할 권한이 없습니다.'
                }
            });
        }

        next();
    };
}

/**
 * Enforce minimum role access (e.g. ['admin'], ['admin', 'manager'])
 */
export function requireRole(allowedRoles = []) {
    const normalized = allowedRoles.map(r => String(r).toLowerCase());

    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '로그인이 필요합니다.'
                }
            });
        }

        const userRole = String(req.auth.role || 'user').toLowerCase();
        if (!normalized.includes(userRole)) {
            return res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: '이 작업을 수행할 권한이 없습니다.'
                }
            });
        }

        next();
    };
}

/**
 * Enforce resource-level department isolation.
 * Admin can access all. Manager can only access their own team's resource.
 * User can only access assigned resource.
 */
export function requireDepartmentScope(getResourceTeamFn, getResourceAssigneeFn) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({
                error: {
                    code: 'UNAUTHENTICATED',
                    message: '로그인이 필요합니다.'
                }
            });
        }

        const role = String(req.auth.role || 'user').toLowerCase();
        if (role === 'admin') {
            return next(); // Full scope
        }

        const resourceTeam = typeof getResourceTeamFn === 'function' ? getResourceTeamFn(req) : null;
        const resourceAssignee = typeof getResourceAssigneeFn === 'function' ? getResourceAssigneeFn(req) : null;

        if (role === 'manager') {
            if (resourceTeam && resourceTeam !== req.auth.team) {
                return res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: '타 부서의 리소스에 접근할 권한이 없습니다.'
                    }
                });
            }
            return next();
        }

        // Regular user: must be assigned
        if (resourceAssignee && String(resourceAssignee) !== String(req.auth.userId) && String(resourceAssignee) !== String(req.auth.name)) {
            return res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: '본인에게 배정되지 않은 리소스입니다.'
                }
            });
        }

        next();
    };
}

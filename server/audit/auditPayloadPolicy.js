/**
 * server/audit/auditPayloadPolicy.js
 * Payload minimization and strict privacy policy enforcement for A11 Persistent Audit Log.
 */

import { AUDIT_LIMITS } from './auditConstants.js';
import { AuditError, AUDIT_ERROR_CODES } from './auditErrors.js';

export const SAFE_METADATA_KEY_ALLOWLIST = Object.freeze(new Set([
    'sourceEventCode',
    'assignmentReasonCode',
    'departmentCanonicalId',
    'jobType',
    'notificationType',
    'streamDisposition',
    'rangeRequestKind',
    'operationStatus',
    'previousAssignmentStatus',
    'nextAssignmentStatus',
    'safeResultCode',
    'playbackSessionId',
    'retryCount',
    'pipelineRevision',
    'grantScopeType',
    'capabilityCount',
    'actionCode',
    'grantVersion',
    'debounceApplied',
    'bootstrapAction',
    'safeReasonCode',
    'safeReason'
]));

export const PROHIBITED_PAYLOAD_KEYS = Object.freeze(new Set([
    'name',
    'targetname',
    'subjectname',
    'phone',
    'mobile',
    'residentnumber',
    'birthdate',
    'address',
    'transcript',
    'summary',
    'note',
    'prompt',
    'response',
    'audiopath',
    'storagekey',
    'contenthash',
    'originalfilename',
    'requestbody',
    'responsebody',
    'authorization',
    'session',
    'cookie',
    'password',
    'token',
    'leasetoken',
    'leasetokenhash',
    'stack',
    'fulluseragent',
    'fullipaddress',
    'email',
    'smsbody',
    'bootstrapid',
    'bootstrapadminuserid',
    'capabilities',
    'rawcapabilities',
    'grantstorepath',
    'grantpath',
    'headers',
    'requestheaders',
    'querystring',
    'params'
]));

/**
 * Validates and normalizes safeMetadata against the privacy allowlist.
 * Rejects any prohibited PII keys or unauthorized metadata keys.
 * Error messages NEVER echo sensitive keys or input values.
 *
 * @param {Record<string, unknown> | null | undefined} metadata
 * @returns {Record<string, unknown> | null}
 */
export function validateSafeMetadata(metadata) {
    if (metadata === undefined || metadata === null) {
        return null;
    }

    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
            'Audit safeMetadata must be a plain object or null'
        );
    }

    const keys = Object.keys(metadata);
    if (keys.length > AUDIT_LIMITS.MAX_SAFE_METADATA_KEYS) {
        throw new AuditError(
            AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
            `Audit safeMetadata exceeds maximum key count limit of ${AUDIT_LIMITS.MAX_SAFE_METADATA_KEYS}`
        );
    }

    const sanitized = {};

    for (const key of keys) {
        const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');

        // 1. Check prohibited PII and secret keys
        if (PROHIBITED_PAYLOAD_KEYS.has(lowerKey)) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                'Audit safeMetadata contains a prohibited sensitive key'
            );
        }

        // 2. Strict allowlist validation
        if (!SAFE_METADATA_KEY_ALLOWLIST.has(key)) {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                'Audit safeMetadata contains an unapproved metadata key'
            );
        }

        const value = metadata[key];

        // 3. Prohibit nested objects and arrays
        if (value !== null && typeof value === 'object') {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                'Audit safeMetadata must be flat; nested objects or arrays are strictly prohibited'
            );
        }

        // 4. Validate value types (string, safe integer, boolean, null)
        if (value === null) {
            sanitized[key] = null;
        } else if (typeof value === 'boolean') {
            sanitized[key] = value;
        } else if (typeof value === 'number') {
            if (!Number.isSafeInteger(value)) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                    'Audit safeMetadata numerical value must be a safe integer'
                );
            }
            sanitized[key] = value;
        } else if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.length > AUDIT_LIMITS.MAX_SAFE_METADATA_STRING_LENGTH) {
                throw new AuditError(
                    AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                    `Audit safeMetadata string value exceeds maximum length of ${AUDIT_LIMITS.MAX_SAFE_METADATA_STRING_LENGTH}`
                );
            }
            sanitized[key] = trimmed.normalize('NFC');
        } else {
            throw new AuditError(
                AUDIT_ERROR_CODES.AUDIT_PAYLOAD_UNSAFE,
                'Audit safeMetadata value has an unsupported type'
            );
        }
    }

    return Object.freeze(sanitized);
}

/**
 * server/assignment/assignmentValidator.js
 * Schema and Command Validators for VoiceCall Assignment & Routing.
 * Mind-ERP OS Track A10.
 */

import {
    ASSIGNMENT_ERROR_CODES,
    ASSIGNMENT_REASON_CODES,
    OPERATION_STATUS,
    ASSIGNMENT_LIMITS
} from './assignmentConstants.js';
import { AssignmentError } from './assignmentErrors.js';
import { resolveCanonicalDepartmentId } from '../permissions/canonicalDepartment.js';

const UUID_OR_SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?([+-]\d{2}:\d{2})?$/;

export const PROHIBITED_ASSIGNMENT_FIELDS = Object.freeze(new Set([
    'actorRole',
    'actorTeam',
    'capability',
    'currentAssignedUserId',
    'currentAssignedDepartmentId',
    'currentVersion',
    'previousAssignment',
    'assignmentStatus',
    'notificationRecipient',
    // PII and sensitive data
    'name',
    'targetName',
    'subjectName',
    'phone',
    'mobile',
    'residentNumber',
    'transcript',
    'summary',
    'note',
    'prompt',
    'response',
    'audioPath',
    'storageKey',
    'contentHash',
    'originalFileName',
    'emailBody',
    'smsBody',
    'session',
    'cookie',
    'password',
    'token',
    'leaseToken',
    'stack'
]));

export function isValidId(str) {
    if (typeof str !== 'string') return false;
    return UUID_OR_SAFE_ID_REGEX.test(str.trim());
}

export function isValidIsoDate(str) {
    if (typeof str !== 'string') return false;
    return ISO_DATE_REGEX.test(str) && !Number.isNaN(new Date(str).getTime());
}

/**
 * Validates incoming assignment command against allowlist, types, and invariants.
 */
export function validateAssignmentCommand(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'Assignment command must be a valid JSON object'
        );
    }

    // 1. Check prohibited / client-spoofed fields
    for (const key of Object.keys(command)) {
        if (PROHIBITED_ASSIGNMENT_FIELDS.has(key)) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
                'Prohibited or unauthorized field detected in command'
            );
        }
    }

    // 2. Validate callId
    if (!command.callId || typeof command.callId !== 'string' || !isValidId(command.callId)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'Invalid or missing callId in assignment command'
        );
    }

    // 3. Validate operationId
    if (!command.operationId || typeof command.operationId !== 'string' || !isValidId(command.operationId)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'Invalid or missing operationId in assignment command'
        );
    }

    // 4. Validate expectedVersion
    if (command.expectedVersion === undefined || command.expectedVersion === null) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'expectedVersion is required in assignment command'
        );
    }
    const expVer = Number(command.expectedVersion);
    if (!Number.isSafeInteger(expVer) || expVer < 1) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'expectedVersion must be a positive integer >= 1'
        );
    }

    // 5. Validate requestedDepartmentId
    if (!command.requestedDepartmentId || typeof command.requestedDepartmentId !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_DEPARTMENT_INVALID,
            'requestedDepartmentId is required'
        );
    }
    const canonicalDept = resolveCanonicalDepartmentId(command.requestedDepartmentId);
    if (!canonicalDept) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_DEPARTMENT_INVALID,
            'Unrecognized or invalid canonical department'
        );
    }

    // 6. Validate requestedUserId
    if (!command.requestedUserId || typeof command.requestedUserId !== 'string' || command.requestedUserId.trim() === '') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'requestedUserId must be a non-empty string'
        );
    }

    // 7. Validate reasonCode
    if (!command.reasonCode || typeof command.reasonCode !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'reasonCode is required in assignment command'
        );
    }
    if (!Object.values(ASSIGNMENT_REASON_CODES).includes(command.reasonCode)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
            'Invalid reasonCode: not in approved allowlist'
        );
    }

    // 8. Optional noteCode check
    if (command.noteCode !== undefined && command.noteCode !== null) {
        if (typeof command.noteCode !== 'string' || command.noteCode.length > ASSIGNMENT_LIMITS.MAX_NOTE_LENGTH) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_COMMAND_INVALID,
                'noteCode must be a string within maximum length'
            );
        }
    }

    return true;
}

import crypto from 'crypto';

/**
 * Compute deterministic SHA-256 fingerprint from canonical assignment command fields.
 * Includes actorUserId to guarantee actor-bound idempotency.
 */
export function computeAssignmentFingerprint(params = {}) {
    const {
        operationType = 'ASSIGN',
        callId = '',
        actorUserId = '',
        requestedDepartmentId = '',
        requestedUserId = '',
        expectedVersion = 1,
        reasonCode = '',
        noteCode = ''
    } = params;

    const canonicalObj = {
        actorUserId: String(actorUserId).trim(),
        callId: String(callId).trim(),
        expectedVersion: Number(expectedVersion),
        noteCode: noteCode ? String(noteCode).trim() : '',
        operationType: String(operationType).trim(),
        reasonCode: String(reasonCode).trim(),
        requestedDepartmentId: String(requestedDepartmentId).trim(),
        requestedUserId: String(requestedUserId).trim()
    };

    const canonicalJson = JSON.stringify(canonicalObj, Object.keys(canonicalObj).sort());
    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Adapter for real Users.json / User schema.
 * Normalizes user record, validates active and assignable states, and strips passwords and sensitive fields.
 */
export function normalizeAssignableUser(user) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
        return null;
    }

    const id = String(user.id || user.username || '').trim();
    if (!id) return null;

    const role = String(user.role || 'user').trim();
    const canonicalDepartmentId = resolveCanonicalDepartmentId(user.team || user.department);

    const isDeleted = user.isDeleted === true || user.status === 'deleted';
    const isSuspended = user.status === 'suspended';
    const isActive = (user.status === 'active' || (!user.status && !isSuspended && !isDeleted)) && !isDeleted && !isSuspended;
    const isAssignable = isActive && !isSuspended && !isDeleted && Boolean(canonicalDepartmentId);

    return {
        id,
        role,
        canonicalDepartmentId,
        isActive,
        isDeleted,
        isSuspended,
        isAssignable
    };
}

/**
 * Validates an AssignmentOperation record schema and invariants.
 */
export function validateAssignmentOperation(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'AssignmentOperation must be an object'
        );
    }

    if (!op.id || typeof op.id !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'Operation id is required'
        );
    }

    if (!op.operationId || typeof op.operationId !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'operationId is required'
        );
    }

    if (!op.callId || typeof op.callId !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'callId is required'
        );
    }

    if (!op.actorUserId || typeof op.actorUserId !== 'string') {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'actorUserId is required'
        );
    }

    if (!Object.values(OPERATION_STATUS).includes(op.status)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            `Invalid operation status: ${op.status}`
        );
    }

    if (!Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 1) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'expectedVersion must be positive integer'
        );
    }

    if (op.requestFingerprint !== undefined && op.requestFingerprint !== null) {
        if (typeof op.requestFingerprint !== 'string' || op.requestFingerprint.length !== 64) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                'requestFingerprint must be 64-character sha256 hex string'
            );
        }
    }

    if (!isValidIsoDate(op.createdAt) || !isValidIsoDate(op.updatedAt)) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'createdAt and updatedAt must be ISO dates'
        );
    }

    if (!Number.isSafeInteger(op.version) || op.version < 1) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
            'version must be positive integer'
        );
    }

    return true;
}

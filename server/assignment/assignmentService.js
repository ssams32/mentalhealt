/**
 * server/assignment/assignmentService.js
 * Manual VoiceCall Assignment and Reassignment Service with OCC and Multi-Store Outbox Recovery.
 * Mind-ERP OS Track A10.
 * 
 * BOUNDARY NOTICE:
 * - NO AI Auto-Assignment: Only manual operator/manager/admin assignment.
 * - Multi-Store Consistency: Uses AssignmentOperation for cross-store partial failure recovery.
 * - Privacy: Absolutely zero client PII, transcripts, or summaries stored or echoed.
 */

import crypto from 'crypto';
import {
    ASSIGNMENT_STATUS,
    OPERATION_STATUS,
    ASSIGNMENT_ERROR_CODES,
    ASSIGNMENT_REASON_CODES
} from './assignmentConstants.js';
import { AssignmentError } from './assignmentErrors.js';
import {
    validateAssignmentCommand,
    computeAssignmentFingerprint,
    normalizeAssignableUser
} from './assignmentValidator.js';
import { resolveCanonicalDepartmentId } from '../permissions/canonicalDepartment.js';
import { VOICE_CAPABILITIES, hasVoiceCapability } from '../permissions/voiceCapabilities.js';
import { NOTIFICATION_TYPES } from '../notifications/notificationConstants.js';

export class AssignmentService {
    /**
     * @param {Object} deps
     * @param {Object} deps.voiceCallRepo
     * @param {Object} deps.assignmentHistoryRepo
     * @param {Object} deps.assignmentOperationRepo
     * @param {Object} deps.outboxRepo
     * @param {Function} [deps.getUserByIdFn] - async (id) => user
     * @param {Function} [deps.getUsersFn] - () => user[]
     */
    constructor(deps = {}) {
        this.voiceCallRepo = deps.voiceCallRepo || null;
        this.assignmentHistoryRepo = deps.assignmentHistoryRepo || null;
        this.assignmentOperationRepo = deps.assignmentOperationRepo || null;
        this.outboxRepo = deps.outboxRepo || null;
        this.getUserById = deps.getUserByIdFn || null;
        this.getUsers = deps.getUsersFn || null;
        this.auditSink = deps.auditSink || null;
        this.voiceAccessAuthorizer = deps.voiceAccessAuthorizer || null;
    }

    async _recordAudit(eventParams) {
        if (this.auditSink && typeof this.auditSink.record === 'function') {
            try {
                await this.auditSink.record(eventParams);
            } catch {
                // Non-blocking isolation: audit append failure does not fail or rollback assignment
            }
        }
    }

    async _resolveTargetUser(userId) {
        if (this.getUserById && typeof this.getUserById === 'function') {
            const u = await this.getUserById(userId);
            if (u) return u;
        }
        if (this.getUsers && typeof this.getUsers === 'function') {
            const list = this.getUsers();
            if (Array.isArray(list)) {
                const found = list.find(u => u && (String(u.id) === String(userId) || String(u.username) === String(userId)));
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Execute assignment or reassignment command.
     */
    async assignCall(command, actorContext) {
        // 1. Validate Command Syntactically and Schema Allowlist
        validateAssignmentCommand(command);

        try {
            return await this._executeAssignCall(command, actorContext);
        } catch (err) {
            const actorUserId = actorContext?.id || actorContext?.userId || null;
            let eventType = 'ASSIGNMENT_FAILED';
            let outcome = 'failed';

            if (
                err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN ||
                err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_CROSS_DEPARTMENT_FORBIDDEN
            ) {
                eventType = 'ASSIGNMENT_DENIED';
                outcome = 'denied';
            } else if (err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT) {
                eventType = 'ASSIGNMENT_VERSION_CONFLICT';
                outcome = 'conflict';
            } else if (
                err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_INCOMPLETE ||
                err.code === ASSIGNMENT_ERROR_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS
            ) {
                eventType = 'ASSIGNMENT_INCOMPLETE';
                outcome = 'incomplete';
            }

            await this._recordAudit({
                eventType,
                actorId: actorUserId,
                resourceId: command?.callId || 'unknown',
                operationId: command?.operationId || null,
                outcome,
                reasonCode: command?.reasonCode || err.code || null,
                beforeVersion: command?.expectedVersion !== undefined ? Number(command.expectedVersion) : null,
                afterVersion: err.currentVersion !== undefined ? Number(err.currentVersion) : null
            });

            throw err;
        }
    }

    async _executeAssignCall(command, actorContext) {
        // 2. Validate Actor Authentication Context (Server-trusted boundary only)
        if (!actorContext || typeof actorContext !== 'object') {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_UNAUTHENTICATED,
                'Authentication required to execute assignment',
                401
            );
        }

        const actorUserId = actorContext.id || actorContext.userId;
        const actorRole = actorContext.role;
        const actorTeam = actorContext.team;

        if (!actorUserId || typeof actorRole !== 'string') {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_UNAUTHENTICATED,
                'Invalid actor context: missing user identification or role',
                401
            );
        }

        if (actorContext.status && actorContext.status !== 'active') {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                'Inactive actor accounts are not permitted to perform assignments',
                403
            );
        }

        // 3. Capability Check (Default-Deny)
        const canAssign = hasVoiceCapability(actorContext, VOICE_CAPABILITIES.ASSIGN);
        const canReassign = hasVoiceCapability(actorContext, VOICE_CAPABILITIES.REASSIGN);

        if (!canAssign && !canReassign) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                'Actor lacks voice call assignment capabilities',
                403
            );
        }

        // 3.1 Restricted Voice Access Gate (Mandatory Authorizer)
        if (!this.voiceAccessAuthorizer) {
            throw new AssignmentError(
                'VOICE_SYSTEM_UNAVAILABLE',
                'Voice access authorizer is missing or unavailable',
                503
            );
        }

        const voiceAuth = await this.voiceAccessAuthorizer.authorize(
            actorContext,
            VOICE_CAPABILITIES.ASSIGN
        );
        if (!voiceAuth.allowed) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                `Actor is denied by restricted voice access gate: ${voiceAuth.reason || 'FORBIDDEN'}`,
                403
            );
        }

        // 4. Load VoiceCall Record
        if (!this.voiceCallRepo) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_FAILED,
                'VoiceCall repository is unavailable',
                503
            );
        }

        const call = this.voiceCallRepo.findById(command.callId, { includeDeleted: true });
        if (!call || call.isDeleted === true) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_RESOURCE_NOT_FOUND,
                `VoiceCall [${command.callId}] not found or deleted`,
                404
            );
        }

        if (call.processingStatus === 'rejected') {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                'Rejected calls cannot be assigned',
                400
            );
        }

        // 5. Resource Scope & Department Validation
        const isReassignment = Boolean(call.assignedUserId) ||
                               call.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED ||
                               call.assignmentStatus === ASSIGNMENT_STATUS.REASSIGNED;
        const isUnassigned = !isReassignment;

        const canonicalReqDept = resolveCanonicalDepartmentId(command.requestedDepartmentId);
        if (!canonicalReqDept) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_DEPARTMENT_INVALID,
                'Requested department is not a recognized canonical department',
                400
            );
        }

        if (actorRole === 'manager') {
            const managerDept = resolveCanonicalDepartmentId(actorTeam);
            if (!managerDept) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                    'Manager lacks valid canonical department assignment',
                    403
                );
            }

            if (isUnassigned) {
                // Determine pre-assignment ownership department
                const rawOwningDept = call.owningDepartmentId || call.intakeDepartmentId;
                const owningDept = resolveCanonicalDepartmentId(rawOwningDept);
                if (!owningDept) {
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                        'Unassigned call lacks owning department scope: Manager assignment forbidden',
                        403
                    );
                }
                if (owningDept !== managerDept) {
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                        'Managers cannot assign unassigned calls owned by another department',
                        403
                    );
                }
            } else {
                // Reassignment: check current assigned or owning department
                const rawCallDept = call.assignedDepartmentId || call.owningDepartmentId || call.recommendedDepartmentId || call.department;
                const callDept = resolveCanonicalDepartmentId(rawCallDept);

                if (callDept && callDept !== managerDept) {
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                        'Managers cannot assign calls outside their department',
                        403
                    );
                }
            }

            // Manager cannot reassign across departments
            if (canonicalReqDept !== managerDept) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_CROSS_DEPARTMENT_FORBIDDEN,
                    'Cross-department transfers require Administrator privileges',
                    403
                );
            }
        } else if (actorRole !== 'admin') {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_FORBIDDEN,
                'Only Administrators and authorized Managers may assign calls',
                403
            );
        }

        // 6. Target User Validation with Real User Directory Normalization Adapter
        const rawTargetUser = await this._resolveTargetUser(command.requestedUserId);
        if (!rawTargetUser) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_TARGET_USER_NOT_FOUND,
                `Target user [${command.requestedUserId}] not found in directory`,
                404
            );
        }

        const normalizedUser = normalizeAssignableUser(rawTargetUser);
        if (!normalizedUser) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_TARGET_USER_SCHEMA_INVALID,
                `Target user [${command.requestedUserId}] schema is invalid`,
                400
            );
        }

        if (!normalizedUser.isAssignable || !normalizedUser.isActive || normalizedUser.isSuspended || normalizedUser.isDeleted) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_TARGET_USER_INACTIVE,
                'Target user is suspended, deleted, or inactive',
                400
            );
        }

        if (normalizedUser.canonicalDepartmentId !== canonicalReqDept) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_DEPARTMENT_MISMATCH,
                'Target user department does not match requested department',
                400
            );
        }

        // 7. Deterministic Request Fingerprint Generation (Actor-Bound Idempotency)
        const requestFingerprint = computeAssignmentFingerprint({
            operationType: 'ASSIGN',
            callId: command.callId,
            actorUserId: String(actorUserId),
            requestedDepartmentId: canonicalReqDept,
            requestedUserId: String(command.requestedUserId),
            expectedVersion: Number(command.expectedVersion),
            reasonCode: command.reasonCode,
            noteCode: command.noteCode || ''
        });

        // 8. Operation Record (Idempotency Key Tracking & Recovery)
        if (!this.assignmentOperationRepo) {
            throw new AssignmentError(
                ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OPERATION_STORE_FAILED,
                'AssignmentOperation repository is unavailable',
                503
            );
        }

        const existingOp = this.assignmentOperationRepo.findByOperationId(command.operationId);
        if (existingOp) {
            // Compare fingerprints or canonical attributes
            if (existingOp.requestFingerprint && existingOp.requestFingerprint !== requestFingerprint) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT,
                    'OperationId already exists with differing fingerprint or actor context',
                    409
                );
            }

            if (
                existingOp.callId !== command.callId ||
                existingOp.actorUserId !== String(actorUserId) ||
                existingOp.requestedUserId !== String(command.requestedUserId) ||
                existingOp.requestedDepartmentId !== canonicalReqDept ||
                Number(existingOp.expectedVersion) !== Number(command.expectedVersion)
            ) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_IDEMPOTENCY_CONFLICT,
                    'OperationId already exists with differing command parameters',
                    409
                );
            }

            // If already completed, return safe cached result immediately
            if (existingOp.status === OPERATION_STATUS.COMPLETED) {
                return {
                    status: 'COMPLETED',
                    idempotent: true,
                    operationId: existingOp.operationId,
                    callId: existingOp.callId,
                    assignedUserId: existingOp.requestedUserId,
                    assignedDepartmentId: existingOp.requestedDepartmentId,
                    resultingVersion: existingOp.resultingCallVersion
                };
            }

            if (existingOp.status === OPERATION_STATUS.CONFLICT || existingOp.status === OPERATION_STATUS.FAILED) {
                throw new AssignmentError(
                    existingOp.lastErrorCode || ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT,
                    'Operation previously terminated in conflict or failure',
                    409
                );
            }

            if (existingOp.status === OPERATION_STATUS.INCOMPLETE) {
                throw new AssignmentError(
                    existingOp.lastErrorCode || ASSIGNMENT_ERROR_CODES.ASSIGNMENT_INCOMPLETE,
                    'Operation is in incomplete ambiguous state requiring reconciliation',
                    409
                );
            }
        }

        let operation = existingOp;

        // 9. Call Updated Stage Failure Recovery Detection
        // Check if VoiceCall already reflects this operation on disk
        const callHasThisOp = (call.lastAssignmentOperationId === command.operationId);
        let callAlreadyUpdatedByThisOp = (existingOp && existingOp.status !== OPERATION_STATUS.PENDING) || callHasThisOp;

        if (callHasThisOp) {
            const matchesExpected = (
                String(call.assignedUserId) === String(command.requestedUserId) &&
                resolveCanonicalDepartmentId(call.assignedDepartmentId) === canonicalReqDept &&
                Number(call.version) === Number(command.expectedVersion) + 1
            );

            if (matchesExpected) {
                // Safe Recovery: VoiceCall change succeeded before stage persist failure
                if (!operation) {
                    operation = await this.assignmentOperationRepo.createOperation({
                        operationId: command.operationId,
                        callId: command.callId,
                        actorUserId: String(actorUserId),
                        requestedDepartmentId: canonicalReqDept,
                        requestedUserId: String(command.requestedUserId),
                        expectedVersion: Number(command.expectedVersion),
                        reasonCode: command.reasonCode,
                        requestFingerprint
                    });
                }
                operation = await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.CALL_UPDATED, {
                    resultingCallVersion: call.version,
                    requestFingerprint
                });
                callAlreadyUpdatedByThisOp = true;
            } else {
                // Ambiguous state: VoiceCall has this operationId but mismatched version or target
                if (operation) {
                    await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.INCOMPLETE, {
                        lastErrorCode: ASSIGNMENT_ERROR_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS
                    });
                }
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS,
                    'Ambiguous assignment application state: VoiceCall attributes do not match expected operation parameters',
                    409
                );
            }
        }

        if (!callAlreadyUpdatedByThisOp) {
            // 10. Optimistic Concurrency Control (OCC)
            if (Number(call.version) !== Number(command.expectedVersion)) {
                const err = new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT,
                    'Optimistic concurrency conflict: call version has changed',
                    409
                );
                err.currentVersion = call.version;
                throw err;
            }
        }

        if (!operation) {
            operation = await this.assignmentOperationRepo.createOperation({
                operationId: command.operationId,
                callId: command.callId,
                actorUserId: String(actorUserId),
                requestedDepartmentId: canonicalReqDept,
                requestedUserId: String(command.requestedUserId),
                expectedVersion: Number(command.expectedVersion),
                reasonCode: command.reasonCode,
                requestFingerprint
            });
        }

        // 11. Check NO_CHANGE condition (only applicable for fresh operations where call was not updated by this op)
        const isExactSameAssignee = (
            (!existingOp || existingOp.status === OPERATION_STATUS.PENDING) &&
            String(call.assignedUserId) === String(command.requestedUserId) &&
            resolveCanonicalDepartmentId(call.assignedDepartmentId) === canonicalReqDept
        );

        if (isExactSameAssignee && !callHasThisOp) {
            await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.COMPLETED, {
                resultingCallVersion: call.version,
                requestFingerprint
            });

            await this._recordAudit({
                eventType: 'ASSIGNMENT_NO_CHANGE',
                actorId: actorUserId,
                resourceId: call.id,
                operationId: command.operationId,
                outcome: 'success',
                reasonCode: command.reasonCode,
                beforeVersion: call.version,
                afterVersion: call.version,
                safeMetadata: {
                    assignmentReasonCode: command.reasonCode,
                    departmentCanonicalId: canonicalReqDept,
                    previousAssignmentStatus: call.assignmentStatus,
                    nextAssignmentStatus: call.assignmentStatus
                }
            });

            return {
                status: 'NO_CHANGE',
                idempotent: true,
                operationId: command.operationId,
                callId: call.id,
                assignedUserId: call.assignedUserId,
                assignedDepartmentId: call.assignedDepartmentId,
                version: call.version
            };
        }

        // 12. Multi-Store State Machine Progression
        const nextStatus = isReassignment ? ASSIGNMENT_STATUS.REASSIGNED : ASSIGNMENT_STATUS.ASSIGNED;

        // Stage 1: Update VoiceCall
        if (operation.status === OPERATION_STATUS.PENDING) {
            let updatedCall;
            try {
                updatedCall = await this.voiceCallRepo.applyAssignmentChange({
                    callId: call.id,
                    operationId: command.operationId,
                    expectedVersion: command.expectedVersion,
                    nextDepartmentId: canonicalReqDept,
                    nextUserId: String(command.requestedUserId),
                    assignmentStatus: nextStatus,
                    actorUserId: String(actorUserId)
                });
            } catch (err) {
                if (err.code === 'VOICE_CALL_VERSION_CONFLICT' || err.code === 'VERSION_CONFLICT') {
                    // Update operation status to conflict so it does not remain pending indefinitely
                    await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.CONFLICT, {
                        lastErrorCode: ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT
                    });
                    const occErr = new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_VERSION_CONFLICT,
                        err.message,
                        409
                    );
                    occErr.currentVersion = err.currentVersion;
                    throw occErr;
                }
                throw err;
            }

            operation = await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.CALL_UPDATED, {
                resultingCallVersion: updatedCall.version,
                requestFingerprint
            });
        }

        // Stage 2: Record Assignment History
        if (operation.status === OPERATION_STATUS.CALL_UPDATED) {
            if (!this.assignmentHistoryRepo) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_HISTORY_FAILED,
                    'AssignmentHistory repository is unavailable',
                    503
                );
            }

            let historyRecord;
            try {
                historyRecord = await this.assignmentHistoryRepo.recordAssignment({
                    callId: call.id,
                    operationId: command.operationId,
                    previousUserId: call.assignedUserId || undefined,
                    nextUserId: String(command.requestedUserId),
                    previousDepartmentId: call.assignedDepartmentId || undefined,
                    nextDepartmentId: canonicalReqDept,
                    reason: command.reasonCode,
                    assignedBy: String(actorUserId),
                    resultingVersion: operation.resultingCallVersion
                });
            } catch (histErr) {
                if (histErr.code === 'ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT') {
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT,
                        histErr.message,
                        409
                    );
                }
                throw histErr;
            }

            operation = await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.HISTORY_RECORDED, {
                historyRecordId: historyRecord.id
            });
        }

        // Stage 3: Emit Outbox Event
        if (operation.status === OPERATION_STATUS.HISTORY_RECORDED) {
            if (!this.outboxRepo) {
                throw new AssignmentError(
                    ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OUTBOX_FAILED,
                    'Outbox repository is unavailable',
                    503
                );
            }

            const outboxEventType = isReassignment
                ? NOTIFICATION_TYPES.VOICE_CALL_REASSIGNED
                : NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED;

            let outboxEvent;
            try {
                outboxEvent = await this.outboxRepo.createEvent({
                    eventType: outboxEventType,
                    aggregateType: 'voice_call',
                    aggregateId: call.id,
                    recipientUserId: String(command.requestedUserId),
                    sourceVersion: operation.resultingCallVersion,
                    idempotentResume: true,
                    payload: {
                        notificationType: outboxEventType,
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        messageCode: isReassignment ? 'VOICE_CALL_REASSIGNED' : 'VOICE_CALL_ASSIGNED',
                        severity: 'info',
                        safeMetadata: {
                            assignmentVersion: operation.resultingCallVersion,
                            departmentCanonicalId: canonicalReqDept,
                            sourceEventCode: command.reasonCode
                        }
                    }
                });
            } catch (outboxErr) {
                if (
                    outboxErr.code === 'OUTBOX_IDEMPOTENCY_CONFLICT' ||
                    outboxErr.code === 'ASSIGNMENT_OUTBOX_IDEMPOTENCY_CONFLICT'
                ) {
                    throw new AssignmentError(
                        ASSIGNMENT_ERROR_CODES.ASSIGNMENT_OUTBOX_IDEMPOTENCY_CONFLICT,
                        outboxErr.message,
                        409
                    );
                }
                throw outboxErr;
            }

            operation = await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.OUTBOX_RECORDED, {
                outboxEventId: outboxEvent.id
            });
        }

        // Stage 4: Complete Operation
        if (operation.status === OPERATION_STATUS.OUTBOX_RECORDED) {
            operation = await this.assignmentOperationRepo.updateStage(operation.id, OPERATION_STATUS.COMPLETED);
        }

        await this._recordAudit({
            eventType: isReassignment ? 'REASSIGNMENT_SUCCEEDED' : 'ASSIGNMENT_SUCCEEDED',
            actorId: actorUserId,
            resourceId: operation.callId,
            operationId: operation.operationId,
            outcome: 'success',
            reasonCode: command.reasonCode,
            beforeVersion: Number(command.expectedVersion),
            afterVersion: operation.resultingCallVersion,
            safeMetadata: {
                assignmentReasonCode: command.reasonCode,
                departmentCanonicalId: canonicalReqDept,
                previousAssignmentStatus: call.assignmentStatus,
                nextAssignmentStatus: nextStatus
            }
        });

        return {
            status: 'COMPLETED',
            idempotent: false,
            operationId: operation.operationId,
            callId: operation.callId,
            assignedUserId: operation.requestedUserId,
            assignedDepartmentId: operation.requestedDepartmentId,
            assignmentStatus: nextStatus,
            resultingVersion: operation.resultingCallVersion
        };
    }

    /**
     * Unassign voice call (Policy Decision: Currently BLOCKED_BY_POLICY).
     * 미배정 복귀에 대한 기관 내부 업무정책이 확인되지 않아 A10에서는 보수적으로 BLOCKED_BY_POLICY 처리한다.
     */
    async unassignCall(command, actorContext) {
        throw new AssignmentError(
            ASSIGNMENT_ERROR_CODES.ASSIGNMENT_UNASSIGN_POLICY_BLOCKED,
            '미배정 복귀에 대한 기관 내부 업무정책이 확인되지 않아 A10에서는 보수적으로 BLOCKED_BY_POLICY 처리한다.',
            400
        );
    }
}

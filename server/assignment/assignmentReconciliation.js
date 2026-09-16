/**
 * server/assignment/assignmentReconciliation.js
 * Read-Only Cross-Store Auditor for VoiceCall Assignment, History, Operations, and Outbox.
 * Mind-ERP OS Track A10.
 * 
 * BOUNDARY NOTICE:
 * - Read-only: Does NOT mutate any repository or perform automatic repair.
 * - Privacy: Findings contain ONLY resource IDs and diagnostic codes (no PII, transcripts, or notes).
 */

import {
    ASSIGNMENT_RECONCILIATION_CHECK_CODES,
    OPERATION_STATUS,
    ASSIGNMENT_STATUS,
    ASSIGNMENT_LIMITS
} from './assignmentConstants.js';
import { resolveCanonicalDepartmentId } from '../permissions/canonicalDepartment.js';

export const SEVERITY = Object.freeze({
    CRITICAL: 'CRITICAL',
    WARNING: 'WARNING',
    INFO: 'INFO'
});

export async function runAssignmentReconciliation(params = {}) {
    const findings = [];
    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
    const nowMs = now.getTime();

    const {
        voiceCallRepo,
        assignmentHistoryRepo,
        assignmentOperationRepo,
        outboxRepo,
        users = []
    } = params;

    let calls = [];
    let operations = [];
    let histories = [];
    let outboxEvents = [];

    // 1. Safe Load Operations
    if (assignmentOperationRepo) {
        try {
            operations = assignmentOperationRepo.list();
        } catch {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_STORE_CORRUPTED,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operations_store',
                resourceId: 'VoiceCallAssignmentOperations',
                repairable: false,
                safeMessage: 'AssignmentOperations store is corrupted or unreadable'
            });
        }
    }

    // 2. Safe Load VoiceCalls
    if (voiceCallRepo) {
        try {
            calls = voiceCallRepo.list({ includeDeleted: true });
        } catch {
            // voice call repo loading error
        }
    }

    // 3. Safe Load History
    if (assignmentHistoryRepo && typeof assignmentHistoryRepo._getAllHistory === 'function') {
        try {
            histories = assignmentHistoryRepo._getAllHistory() || [];
        } catch {
            // history loading error
        }
    }

    // 4. Safe Load Outbox
    if (outboxRepo && typeof outboxRepo.list === 'function') {
        try {
            outboxEvents = outboxRepo.list() || [];
        } catch {
            // outbox loading error
        }
    }

    const callMap = new Map(calls.map(c => [c.id, c]));
    const opMap = new Map();
    const opDedupKeyMap = new Map();
    const userMap = new Map((Array.isArray(users) ? users : []).map(u => [String(u.id), u]));

    // Check Operations
    for (const op of operations) {
        // Duplicate ID check
        if (opMap.has(op.id)) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_DUPLICATE_ID,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'Duplicate assignment operation id detected'
            });
        } else {
            opMap.set(op.id, op);
        }

        // Duplicate OperationId key check
        if (opDedupKeyMap.has(op.operationId)) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_DUPLICATE_KEY,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'Duplicate assignment operationId detected'
            });
        } else {
            opDedupKeyMap.set(op.operationId, op);
        }

        // Orphan Call check
        if (!callMap.has(op.callId)) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_ORPHAN_CALL,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'Operation references non-existent call'
            });
        }

        // Target Mismatch check (if user is known)
        if (userMap.has(op.requestedUserId)) {
            const u = userMap.get(op.requestedUserId);
            const uDept = resolveCanonicalDepartmentId(u.team || u.department);
            if (uDept && uDept !== op.requestedDepartmentId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_TARGET_MISMATCH,
                    severity: SEVERITY.WARNING,
                    resourceType: 'assignment_operation',
                    resourceId: op.id,
                    repairable: false,
                    safeMessage: 'Operation target user department differs from requested department'
                });
            }
        }

        // Actor Mismatch / Missing check
        if (op.actorUserId && userMap.size > 0 && !userMap.has(op.actorUserId)) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_ACTOR_MISMATCH,
                severity: SEVERITY.WARNING,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'Operation actorUserId is not registered in user directory'
            });
        }

        // Conflict Left Pending check
        if (op.status === OPERATION_STATUS.PENDING && op.lastErrorCode === 'ASSIGNMENT_VERSION_CONFLICT') {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_CONFLICT_LEFT_PENDING,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'OCC conflict operation was left in pending status'
            });
        }

        // Incomplete Ambiguous Operation check
        if (op.status === OPERATION_STATUS.INCOMPLETE || op.lastErrorCode === 'ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS') {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS,
                severity: SEVERITY.CRITICAL,
                resourceType: 'assignment_operation',
                resourceId: op.id,
                repairable: false,
                safeMessage: 'Operation is flagged with ambiguous application state requiring manual reconciliation'
            });
        }

        // Call Updated but History Missing
        if (op.status === OPERATION_STATUS.CALL_UPDATED && !op.historyRecordId) {
            const hasHistory = histories.some(h => h.operationId === op.operationId);
            if (!hasHistory) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_CALL_UPDATED_HISTORY_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'assignment_operation',
                    resourceId: op.id,
                    repairable: false,
                    safeMessage: 'Call was updated but assignment history record is missing'
                });
            }
        }

        // Completed but Outbox Missing
        if (op.status === OPERATION_STATUS.COMPLETED && op.outboxEventId) {
            const hasOutbox = outboxEvents.some(e => e.id === op.outboxEventId);
            if (!hasOutbox) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_COMPLETED_OUTBOX_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'assignment_operation',
                    resourceId: op.id,
                    repairable: false,
                    safeMessage: 'Completed operation references missing outbox event'
                });
            }
        }

        // Stale & Incomplete checks
        if (
            op.status !== OPERATION_STATUS.COMPLETED &&
            op.status !== OPERATION_STATUS.FAILED &&
            op.status !== OPERATION_STATUS.CONFLICT
        ) {
            const opAgeMs = nowMs - new Date(op.createdAt).getTime();
            if (opAgeMs > ASSIGNMENT_LIMITS.STALE_OPERATION_AGE_MS) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_STALE,
                    severity: SEVERITY.WARNING,
                    resourceType: 'assignment_operation',
                    resourceId: op.id,
                    repairable: false,
                    safeMessage: 'Operation is stale and remains uncompleted'
                });
            } else {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OPERATION_INCOMPLETE,
                    severity: SEVERITY.INFO,
                    resourceType: 'assignment_operation',
                    resourceId: op.id,
                    repairable: false,
                    safeMessage: 'Operation is in progress or incomplete'
                });
            }
        }
    }

    // Check History without Operation & Version Mismatch
    const historyOpMap = new Map();
    for (const h of histories) {
        if (h.operationId) {
            if (!opDedupKeyMap.has(h.operationId)) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_HISTORY_WITHOUT_OPERATION,
                    severity: SEVERITY.WARNING,
                    resourceType: 'assignment_history',
                    resourceId: h.id,
                    repairable: false,
                    safeMessage: 'Assignment history record references unknown operationId'
                });
            }
            if (historyOpMap.has(h.operationId)) {
                const prev = historyOpMap.get(h.operationId);
                if (prev.nextUserId !== h.nextUserId || prev.callId !== h.callId) {
                    findings.push({
                        checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_HISTORY_IDEMPOTENCY_CONFLICT,
                        severity: SEVERITY.CRITICAL,
                        resourceType: 'assignment_history',
                        resourceId: h.id,
                        repairable: false,
                        safeMessage: 'Multiple history records for same operationId have differing contents'
                    });
                }
            } else {
                historyOpMap.set(h.operationId, h);
            }
        }
        if (callMap.has(h.callId)) {
            const c = callMap.get(h.callId);
            if (h.resultingVersion > c.version) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_HISTORY_VERSION_MISMATCH,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'assignment_history',
                    resourceId: h.id,
                    repairable: false,
                    safeMessage: 'History resultingVersion exceeds current call version'
                });
            }
        }
    }

    // Check Outbox Recipient Mismatch & Without Operation & Idempotency
    const outboxDedupMap = new Map();
    for (const ev of outboxEvents) {
        if (ev.deduplicationKey) {
            if (outboxDedupMap.has(ev.deduplicationKey)) {
                const prev = outboxDedupMap.get(ev.deduplicationKey);
                if (JSON.stringify(prev.payload) !== JSON.stringify(ev.payload)) {
                    findings.push({
                        checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OUTBOX_IDEMPOTENCY_CONFLICT,
                        severity: SEVERITY.CRITICAL,
                        resourceType: 'outbox_event',
                        resourceId: ev.id,
                        repairable: false,
                        safeMessage: 'Multiple outbox events for same deduplicationKey have differing payloads'
                    });
                }
            } else {
                outboxDedupMap.set(ev.deduplicationKey, ev);
            }
        }

        if (ev.aggregateType === 'voice_call' && (ev.eventType === 'voice_call_assigned' || ev.eventType === 'voice_call_reassigned')) {
            const matchingOp = operations.find(o => o.callId === ev.aggregateId && o.outboxEventId === ev.id);
            if (!matchingOp && operations.length > 0) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OUTBOX_WITHOUT_OPERATION,
                    severity: SEVERITY.INFO,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Assignment outbox event lacks matching operation link'
                });
            } else if (matchingOp && matchingOp.requestedUserId !== ev.recipientUserId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_OUTBOX_RECIPIENT_MISMATCH,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'outbox_event',
                    resourceId: ev.id,
                    repairable: false,
                    safeMessage: 'Outbox event recipient does not match operation requested user'
                });
            }
        }
    }

    // Check Call-Level Integrity
    for (const call of calls) {
        const isAssigned = call.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED ||
                           call.assignmentStatus === ASSIGNMENT_STATUS.REASSIGNED;

        if (isAssigned) {
            if (!call.assignedUserId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNED_CALL_USER_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: 'Call is marked assigned but assignedUserId is missing'
                });
            }
            if (!call.assignedDepartmentId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNED_CALL_DEPARTMENT_MISSING,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: 'Call is marked assigned but assignedDepartmentId is missing'
                });
            }

            // Check lastAssignmentOperationId reference
            if (!call.lastAssignmentOperationId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_LAST_OPERATION_REF_MISSING,
                    severity: SEVERITY.WARNING,
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: 'Assigned call lacks lastAssignmentOperationId audit reference'
                });
            } else if (operations.length > 0 && !opDedupKeyMap.has(call.lastAssignmentOperationId)) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_LAST_OPERATION_REF_INVALID,
                    severity: SEVERITY.CRITICAL,
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: 'Call lastAssignmentOperationId references unknown operation'
                });
            } else if (opDedupKeyMap.has(call.lastAssignmentOperationId)) {
                const op = opDedupKeyMap.get(call.lastAssignmentOperationId);
                if (op.status === OPERATION_STATUS.PENDING) {
                    findings.push({
                        checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_APPLIED_OPERATION_STAGE_MISSING,
                        severity: SEVERITY.CRITICAL,
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: 'Call was applied but referenced operation remains in pending status'
                    });
                }
            }

            if (call.assignedUserId && userMap.has(call.assignedUserId)) {
                const u = userMap.get(call.assignedUserId);
                if (u.status !== 'active') {
                    findings.push({
                        checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNED_CALL_USER_INACTIVE,
                        severity: SEVERITY.WARNING,
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: 'Assignee user is inactive in user directory'
                    });
                }
                const uDept = resolveCanonicalDepartmentId(u.team || u.department);
                const callDept = resolveCanonicalDepartmentId(call.assignedDepartmentId);
                if (uDept && callDept && uDept !== callDept) {
                    findings.push({
                        checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNED_CALL_DEPARTMENT_MISMATCH,
                        severity: SEVERITY.WARNING,
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: 'Assignee user department differs from call assigned department'
                    });
                }
            }
        }

        // Unassigned call ownership scope check
        if (call.assignmentStatus === ASSIGNMENT_STATUS.UNASSIGNED && !call.isDeleted && call.processingStatus !== 'rejected') {
            if (!call.owningDepartmentId && !call.intakeDepartmentId) {
                findings.push({
                    checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_UNASSIGNED_OWNERSHIP_MISSING,
                    severity: SEVERITY.WARNING,
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: 'Active unassigned call lacks owningDepartmentId and intakeDepartmentId'
                });
            }
        }

        if (call.assignmentStatus === ASSIGNMENT_STATUS.UNASSIGNED && (call.assignedUserId || call.assignedDepartmentId)) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.UNASSIGNED_CALL_HAS_ASSIGNEE,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call',
                resourceId: call.id,
                repairable: false,
                safeMessage: 'Call is marked unassigned but retains assigned user or department'
            });
        }

        if (call.processingStatus === 'rejected' && isAssigned) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.REJECTED_CALL_HAS_ASSIGNMENT,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call',
                resourceId: call.id,
                repairable: false,
                safeMessage: 'Rejected call has active assignment status'
            });
        }

        if (call.isDeleted === true && isAssigned) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.DELETED_CALL_HAS_ACTIVE_ASSIGNMENT,
                severity: SEVERITY.CRITICAL,
                resourceType: 'voice_call',
                resourceId: call.id,
                repairable: false,
                safeMessage: 'Deleted call has active assignment status'
            });
        }
    }

    // Check User Directory Schema Integrity
    for (const [uid, u] of userMap.entries()) {
        if (!u || typeof u !== 'object') continue;
        const canonical = resolveCanonicalDepartmentId(u.team || u.department);
        if (!canonical || !u.role) {
            findings.push({
                checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_TARGET_USER_SCHEMA_INVALID,
                severity: SEVERITY.WARNING,
                resourceType: 'user_directory',
                resourceId: uid,
                repairable: false,
                safeMessage: `User ${uid} lacks valid role or recognized canonical department team`
            });
        }
    }

    // Size warning
    const serializedBytes = JSON.stringify(operations).length;
    if (serializedBytes > 5 * 1024 * 1024) {
        findings.push({
            checkCode: ASSIGNMENT_RECONCILIATION_CHECK_CODES.ASSIGNMENT_STORE_SIZE_WARNING,
            severity: SEVERITY.WARNING,
            resourceType: 'assignment_operations_store',
            resourceId: 'VoiceCallAssignmentOperations',
            repairable: false,
            safeMessage: `AssignmentOperations store exceeds 5MB (${serializedBytes} bytes)`
        });
    }

    return {
        timestamp: now.toISOString(),
        totalFindings: findings.length,
        criticalCount: findings.filter(f => f.severity === SEVERITY.CRITICAL).length,
        warningCount: findings.filter(f => f.severity === SEVERITY.WARNING).length,
        infoCount: findings.filter(f => f.severity === SEVERITY.INFO).length,
        findings
    };
}

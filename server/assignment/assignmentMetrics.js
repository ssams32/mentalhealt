/**
 * server/assignment/assignmentMetrics.js
 * Read-Only Diagnostics and Metric Snapshot Calculator for VoiceCall Assignment.
 * Mind-ERP OS Track A10.
 * 
 * BOUNDARY NOTICE:
 * - Read-only: Does NOT mutate repositories or expose per-user data.
 * - Privacy: Zero PII, phone numbers, recipient lists, or transcripts included in metrics.
 */

import {
    OPERATION_STATUS,
    ASSIGNMENT_STATUS,
    ASSIGNMENT_LIMITS
} from './assignmentConstants.js';

export function getAssignmentMetricsSnapshot(params = {}) {
    const now = params.now instanceof Date && !Number.isNaN(params.now.getTime()) ? params.now : new Date();
    const nowMs = now.getTime();

    const {
        voiceCallRepo,
        assignmentHistoryRepo,
        assignmentOperationRepo,
        outboxRepo
    } = params;

    let operations = [];
    let calls = [];
    let historyCount = 0;
    let outboxPendingCount = 0;

    if (assignmentOperationRepo && typeof assignmentOperationRepo.list === 'function') {
        try {
            operations = assignmentOperationRepo.list();
        } catch {
            operations = [];
        }
    }

    if (voiceCallRepo && typeof voiceCallRepo.list === 'function') {
        try {
            calls = voiceCallRepo.list({ includeDeleted: false });
        } catch {
            calls = [];
        }
    }

    if (assignmentHistoryRepo && typeof assignmentHistoryRepo._getAllHistory === 'function') {
        try {
            const h = assignmentHistoryRepo._getAllHistory();
            historyCount = Array.isArray(h) ? h.length : 0;
        } catch {
            historyCount = 0;
        }
    }

    if (outboxRepo && typeof outboxRepo.list === 'function') {
        try {
            const evs = outboxRepo.list();
            outboxPendingCount = evs.filter(e => e.status === 'pending' || e.status === 'retry_wait').length;
        } catch {
            outboxPendingCount = 0;
        }
    }

    let pendingOperations = 0;
    let completedOperations = 0;
    let incompleteOperations = 0;
    let failedOperations = 0;
    let conflictOperations = 0;
    let ambiguousOperations = 0;
    let staleOperations = 0;

    for (const op of operations) {
        if (op.status === OPERATION_STATUS.PENDING) pendingOperations++;
        if (op.status === OPERATION_STATUS.COMPLETED) completedOperations++;
        if (op.status === OPERATION_STATUS.FAILED) failedOperations++;
        if (op.status === OPERATION_STATUS.CONFLICT) conflictOperations++;
        if (op.status === OPERATION_STATUS.INCOMPLETE || op.lastErrorCode === 'ASSIGNMENT_APPLICATION_STATE_AMBIGUOUS') ambiguousOperations++;

        if (
            op.status !== OPERATION_STATUS.COMPLETED &&
            op.status !== OPERATION_STATUS.FAILED &&
            op.status !== OPERATION_STATUS.CONFLICT
        ) {
            incompleteOperations++;
            const ageMs = nowMs - new Date(op.createdAt).getTime();
            if (ageMs > ASSIGNMENT_LIMITS.STALE_OPERATION_AGE_MS) {
                staleOperations++;
            }
        }
    }

    let assignedCallCount = 0;
    let unassignedCallCount = 0;
    let reassignedCallCount = 0;
    let appliedButStageMissingCount = 0;
    let unassignedOwnershipMissingCount = 0;

    const opMap = new Map(operations.map(o => [o.operationId, o]));

    for (const c of calls) {
        if (c.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED) assignedCallCount++;
        else if (c.assignmentStatus === ASSIGNMENT_STATUS.REASSIGNED) reassignedCallCount++;
        else if (c.assignmentStatus === ASSIGNMENT_STATUS.UNASSIGNED) {
            unassignedCallCount++;
            if (!c.owningDepartmentId && !c.intakeDepartmentId) {
                unassignedOwnershipMissingCount++;
            }
        }

        if (c.lastAssignmentOperationId && opMap.has(c.lastAssignmentOperationId)) {
            const op = opMap.get(c.lastAssignmentOperationId);
            if (op.status === OPERATION_STATUS.PENDING) {
                appliedButStageMissingCount++;
            }
        }
    }

    const serializedBytes = JSON.stringify(operations).length;

    return {
        timestamp: now.toISOString(),
        totalOperations: operations.length,
        pendingOperations,
        completedOperations,
        incompleteOperations,
        failedOperations,
        conflictOperations,
        ambiguousOperations,
        staleOperations,
        assignedCallCount,
        unassignedCallCount,
        reassignedCallCount,
        appliedButStageMissingCount,
        unassignedOwnershipMissingCount,
        assignmentHistoryCount: historyCount,
        assignmentOutboxPendingCount: outboxPendingCount,
        operationStoreSerializedBytesEstimate: serializedBytes
    };
}

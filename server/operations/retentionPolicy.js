/**
 * server/operations/retentionPolicy.js
 * Read-only retention policy contract for Mind-ERP OS voice data.
 * 
 * BOUNDARY NOTICE:
 * - Retention policy is UNSET by default.
 * - Automatic retention deletion is STRICTLY FORBIDDEN (ALLOW_RETENTION_DELETE=false).
 * - No automatic archiving or purging of audit logs, voice calls, or audio files.
 */

import { OperationError, OPERATION_ERROR_CODES } from './operationErrors.js';

export const RETENTION_MODES = Object.freeze({
    UNSET: 'UNSET',
    LEGAL_HOLD: 'LEGAL_HOLD',
    CUSTOM_POLICY: 'CUSTOM_POLICY'
});

export class RetentionPolicyManager {
    constructor(config = {}) {
        this.retentionMode = config.retentionMode || RETENTION_MODES.UNSET;
        this.retentionDays = config.retentionDays || null;
        this.allowDelete = false; // Hardcoded safety constraint: deletion is NEVER permitted in this foundation
    }

    /**
     * Get the current retention policy configuration.
     */
    getPolicy() {
        return {
            retentionMode: this.retentionMode,
            retentionDays: this.retentionDays,
            allowAutomaticDelete: false,
            legalHoldEnforced: true,
            status: 'RETENTION_UNSET_PRESERVE_ALL'
        };
    }

    /**
     * Evaluate retention status for a record without modifying or deleting anything.
     */
    evaluateRecordRetention(recordTimestamp) {
        return {
            eligibleForDeletion: false,
            action: 'PRESERVE',
            reason: 'AUTOMATIC_DELETION_DISABLED_IN_A12',
            recordAgeDays: recordTimestamp ? Math.floor((Date.now() - new Date(recordTimestamp).getTime()) / (1000 * 60 * 60 * 24)) : null
        };
    }

    /**
     * Any invocation attempting execution of retention deletion throws an explicit error.
     */
    executeRetentionPurge() {
        throw new OperationError(
            OPERATION_ERROR_CODES.INVALID_RETENTION_POLICY,
            'Retention purge is strictly prohibited: ALLOW_RETENTION_DELETE=false'
        );
    }
}

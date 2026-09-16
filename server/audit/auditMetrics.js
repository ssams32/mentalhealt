/**
 * server/audit/auditMetrics.js
 * Read-only metrics and aggregated statistics snapshot for Track A11 Audit Log.
 */

import {
    AUDIT_STORAGE_FILE,
    AUDIT_HEAD_STORAGE_FILE,
    AUDIT_CATEGORIES,
    AUDIT_OUTCOMES
} from './auditConstants.js';
import { verifyHashChainLink } from './auditHashChain.js';

/**
 * Computes an aggregated read-only metrics snapshot of the Audit subsystem.
 * Contains ZERO PII, ZERO raw tokens, and ZERO actor personal data.
 *
 * @param {object} auditRepo
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getAuditMetricsSnapshot(auditRepo) {
    if (!auditRepo || typeof auditRepo.getData !== 'function') {
        return {
            totalEntries: 0,
            firstSequence: null,
            lastSequence: null,
            chainValid: false,
            headStatus: 'unavailable',
            entriesByCategory: {},
            entriesByOutcome: {},
            deniedCount: 0,
            failedCount: 0,
            incompleteCount: 0,
            conflictCount: 0,
            assignmentEventCount: 0,
            audioAccessEventCount: 0,
            integrityIssueCount: 1,
            oldestEntryAgeSeconds: null,
            retentionCandidateCount: 0,
            auditStoreSerializedBytesEstimate: 0,
            lastRecordedAt: null
        };
    }

    const entries = auditRepo.getData(AUDIT_STORAGE_FILE, []);
    if (!Array.isArray(entries)) {
        return {
            totalEntries: 0,
            firstSequence: null,
            lastSequence: null,
            chainValid: false,
            headStatus: 'corrupted',
            entriesByCategory: {},
            entriesByOutcome: {},
            deniedCount: 0,
            failedCount: 0,
            incompleteCount: 0,
            conflictCount: 0,
            assignmentEventCount: 0,
            audioAccessEventCount: 0,
            integrityIssueCount: 1,
            oldestEntryAgeSeconds: null,
            retentionCandidateCount: 0,
            auditStoreSerializedBytesEstimate: 0,
            lastRecordedAt: null
        };
    }

    const entriesByCategory = {};
    for (const cat of Object.values(AUDIT_CATEGORIES)) {
        entriesByCategory[cat] = 0;
    }

    const entriesByOutcome = {};
    for (const out of Object.values(AUDIT_OUTCOMES)) {
        entriesByOutcome[out] = 0;
    }

    let chainValid = true;
    let integrityIssueCount = 0;
    let retentionCandidateCount = 0;
    let prev = null;
    const now = Date.now();

    for (const entry of entries) {
        if (!entry) {
            integrityIssueCount++;
            chainValid = false;
            continue;
        }

        if (entry.category && entriesByCategory[entry.category] !== undefined) {
            entriesByCategory[entry.category]++;
        }
        if (entry.outcome && entriesByOutcome[entry.outcome] !== undefined) {
            entriesByOutcome[entry.outcome]++;
        }

        const link = verifyHashChainLink(entry, prev);
        if (!link.valid) {
            chainValid = false;
            integrityIssueCount++;
        }

        if (entry.recordedAt) {
            const ageDays = (now - Date.parse(entry.recordedAt)) / (1000 * 60 * 60 * 24);
            if (ageDays > 90) {
                retentionCandidateCount++;
            }
        }

        prev = entry;
    }

    // Determine Head status
    let headStatus = 'missing';
    try {
        const head = auditRepo.getData(AUDIT_HEAD_STORAGE_FILE, null);
        if (head && typeof head === 'object') {
            const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
            if (!lastEntry) {
                headStatus = head.lastSequence === 0 ? 'synced' : 'mismatch';
            } else if (head.lastSequence < lastEntry.sequence) {
                headStatus = 'behind';
            } else if (head.lastSequence > lastEntry.sequence) {
                headStatus = 'ahead';
            } else if (head.lastEntryHash !== lastEntry.entryHash) {
                headStatus = 'mismatch';
            } else {
                headStatus = 'synced';
            }
        }
    } catch {
        headStatus = 'corrupted';
    }

    const firstSequence = entries.length > 0 ? entries[0].sequence : null;
    const lastSequence = entries.length > 0 ? entries[entries.length - 1].sequence : null;
    const lastRecordedAt = entries.length > 0 ? entries[entries.length - 1].recordedAt : null;

    let oldestEntryAgeSeconds = null;
    if (entries.length > 0 && entries[0].recordedAt) {
        oldestEntryAgeSeconds = Math.max(0, Math.floor((now - Date.parse(entries[0].recordedAt)) / 1000));
    }

    let auditStoreSerializedBytesEstimate = 0;
    try {
        auditStoreSerializedBytesEstimate = Buffer.byteLength(JSON.stringify(entries), 'utf8');
    } catch {
        auditStoreSerializedBytesEstimate = 0;
    }

    return {
        totalEntries: entries.length,
        firstSequence,
        lastSequence,
        chainValid,
        headStatus,
        entriesByCategory,
        entriesByOutcome,
        deniedCount: entriesByOutcome.denied || 0,
        failedCount: entriesByOutcome.failed || 0,
        incompleteCount: entriesByOutcome.incomplete || 0,
        conflictCount: entriesByOutcome.conflict || 0,
        assignmentEventCount: entriesByCategory.assignment || 0,
        audioAccessEventCount: entriesByCategory.audio_access || 0,
        integrityIssueCount,
        oldestEntryAgeSeconds,
        retentionCandidateCount,
        auditStoreSerializedBytesEstimate,
        lastRecordedAt
    };
}

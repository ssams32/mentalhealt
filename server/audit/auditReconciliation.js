/**
 * server/audit/auditReconciliation.js
 * Read-only reconciliation and tamper detection engine for Mind-ERP OS Track A11 Audit Log.
 *
 * LOCKING BOUNDARY STATEMENT:
 * withFileLock protects concurrent asynchronous operations inside one Node.js process only.
 * It does not protect:
 * - multiple Node.js processes
 * - multiple containers
 * - multiple hosts
 * - shared NAS writers
 *
 * RETENTION POLICY NOTICE:
 * Operational retention policy is unset by default.
 * No legal retention period is claimed.
 * Candidate classification only occurs when an explicit threshold is injected for testing.
 * Automatic deletion and automatic archival are strictly disabled.
 */

import {
    AUDIT_STORAGE_FILE,
    AUDIT_HEAD_STORAGE_FILE,
    AUDIT_SCHEMA_VERSION,
    GENESIS_HASH,
    AUDIT_CATEGORIES,
    AUDIT_EVENT_TYPES,
    EVENT_TYPE_TO_CATEGORY,
    AUDIT_LIMITS,
    AUDIT_RECONCILIATION_CHECK_CODES
} from './auditConstants.js';
import { validateStoredAuditEntry } from './auditValidator.js';
import { verifyEntryHash, verifyHashChainLink } from './auditHashChain.js';
import { PROHIBITED_PAYLOAD_KEYS } from './auditPayloadPolicy.js';

/**
 * Runs a comprehensive read-only audit of the Audit subsystem.
 *
 * @param {object} params
 * @param {object} params.auditRepo
 * @param {object} [params.externalRefs]
 * @param {number} [params.retentionThresholdDays] - Optional test-only threshold. Unset by default.
 * @returns {Promise<{ timestamp: string, totalRecords: number, issuesCount: number, issues: Array<object> }>}
 */
export async function runAuditReconciliation({ auditRepo, externalRefs = {}, retentionThresholdDays } = {}) {
    const issues = [];
    const timestamp = new Date().toISOString();

    if (!auditRepo) {
        return {
            timestamp,
            totalRecords: 0,
            issuesCount: 1,
            issues: [{
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_CORRUPTED,
                severity: 'error',
                resourceType: 'audit_store',
                resourceId: 'unknown',
                repairable: false,
                safeMessage: 'AuditRepository dependency is missing or null'
            }]
        };
    }

    // 1. AuditEntries store inspection
    let entries = [];
    try {
        const raw = auditRepo.getData(AUDIT_STORAGE_FILE, null);
        if (raw === null || raw === undefined) {
            entries = [];
        } else if (Array.isArray(raw)) {
            entries = raw;
        } else {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_CORRUPTED,
                severity: 'error',
                resourceType: 'audit_store',
                resourceId: AUDIT_STORAGE_FILE,
                repairable: false,
                safeMessage: 'AuditEntries store is not a valid JSON array'
            });
            return {
                timestamp,
                totalRecords: 0,
                issuesCount: issues.length,
                issues
            };
        }
    } catch {
        issues.push({
            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_CORRUPTED,
            severity: 'error',
            resourceType: 'audit_store',
            resourceId: AUDIT_STORAGE_FILE,
            repairable: false,
            safeMessage: 'Exception occurred while reading AuditEntries store'
        });
        return {
            timestamp,
            totalRecords: 0,
            issuesCount: issues.length,
            issues
        };
    }

    // 2. Capacity warning check
    if (entries.length > AUDIT_LIMITS.MAX_ENTRIES_WARNING) {
        issues.push({
            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_SIZE_WARNING,
            severity: 'warning',
            resourceType: 'audit_store',
            resourceId: AUDIT_STORAGE_FILE,
            repairable: false,
            safeMessage: `Audit store entries count (${entries.length}) exceeds warning threshold (${AUDIT_LIMITS.MAX_ENTRIES_WARNING})`
        });
    }

    // 3. Sequential entry validation & chain verification
    const seenIds = new Set();
    const seenSequences = new Set();
    const seenEventIdentities = new Set();
    let prevEntry = null;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const entryResourceId = entry && entry.id ? String(entry.id) : `index_${i}`;

        // Validate basic structural object sanity
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.id || !Number.isSafeInteger(entry.sequence)) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_CORRUPTED,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: 'Stored entry failed basic structural validation'
            });
            continue;
        }

        // Check schema version
        if (entry.schemaVersion !== AUDIT_SCHEMA_VERSION) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SCHEMA_VERSION_UNSUPPORTED,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: `Unsupported audit schema version: ${entry.schemaVersion}`
            });
        }

        // Check duplicate entry ID
        if (seenIds.has(entry.id)) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_DUPLICATE_ID,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: 'Duplicate audit entry ID detected'
            });
        }
        seenIds.add(entry.id);

        // Check duplicate sequence
        if (seenSequences.has(entry.sequence)) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_DUPLICATE,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: `Duplicate sequence number detected: ${entry.sequence}`
            });
        }
        seenSequences.add(entry.sequence);

        // Check sequence progression
        if (prevEntry) {
            if (entry.sequence <= prevEntry.sequence) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_OUT_OF_ORDER,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: `Sequence out of order: ${entry.sequence} <= ${prevEntry.sequence}`
                });
            } else if (entry.sequence > prevEntry.sequence + 1) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_GAP,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: `Sequence gap detected: expected ${prevEntry.sequence + 1}, found ${entry.sequence}`
                });
            }
        } else {
            // First entry sequence must be 1
            if (entry.sequence !== 1) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_OUT_OF_ORDER,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: `Genesis entry sequence must be 1, found ${entry.sequence}`
                });
            }
        }

        // Check Genesis hash
        if (i === 0) {
            if (entry.previousEntryHash !== GENESIS_HASH) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_GENESIS_HASH_INVALID,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: 'First entry previousEntryHash is not GENESIS_HASH'
                });
            }
        } else if (prevEntry) {
            // Check previous hash link
            if (entry.previousEntryHash !== prevEntry.entryHash) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_PREVIOUS_HASH_MISMATCH,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: 'previousEntryHash does not match previous entry entryHash'
                });
            }
        }

        // Check entryHash format
        if (typeof entry.entryHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.entryHash)) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_HASH_INVALID,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: 'entryHash is not a valid 64-char lowercase hex digest'
            });
        } else {
            // Verify computed entryHash
            if (!verifyEntryHash(entry)) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_HASH_MISMATCH,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: 'entryHash digest mismatch (entry has been modified or tampered with)'
                });
            }
        }

        // Check event type allowlist
        if (!AUDIT_EVENT_TYPES[entry.eventType]) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_UNKNOWN_EVENT_TYPE,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: `Unknown audit eventType: ${entry.eventType}`
            });
        }

        // Check category-event correlation
        const expectedCat = EVENT_TYPE_TO_CATEGORY[entry.eventType];
        if (expectedCat && entry.category !== expectedCat) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_CATEGORY_EVENT_MISMATCH,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: `Event category mismatch for ${entry.eventType}`
            });
        }

        // Check metadata safety (no prohibited keys)
        if (entry.safeMetadata && typeof entry.safeMetadata === 'object') {
            for (const key of Object.keys(entry.safeMetadata)) {
                const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (PROHIBITED_PAYLOAD_KEYS.has(lower)) {
                    issues.push({
                        checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_PAYLOAD_UNSAFE,
                        severity: 'error',
                        resourceType: 'audit_entry',
                        resourceId: entryResourceId,
                        repairable: false,
                        safeMessage: 'Prohibited sensitive key detected in safeMetadata'
                    });
                    break;
                }
            }
        }

        // Check identifier validity
        if (entry.actorId && (entry.actorId.includes('@') || entry.actorId.includes(' '))) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_IDENTIFIER_INVALID,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: 'actorId contains invalid characters (spaces or email format)'
            });
        }

        // Check timestamp validity
        if (Number.isNaN(Date.parse(entry.occurredAt)) || Number.isNaN(Date.parse(entry.recordedAt))) {
            issues.push({
                checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_TIMESTAMP_INVALID,
                severity: 'error',
                resourceType: 'audit_entry',
                resourceId: entryResourceId,
                repairable: false,
                safeMessage: 'Invalid timestamp format in occurredAt or recordedAt'
            });
        }

        // Check version transition validity
        if (entry.beforeVersion !== null && entry.afterVersion !== null) {
            if (entry.afterVersion < entry.beforeVersion) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_VERSION_TRANSITION_INVALID,
                    severity: 'error',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: 'afterVersion cannot be less than beforeVersion'
                });
            }
        }

        // Check duplicate event identity
        if (entry.operationId && entry.outcome === 'success') {
            const identityKey = `${entry.eventType}:${entry.resourceType}:${entry.resourceId}:${entry.operationId}:${entry.afterVersion}`;
            if (seenEventIdentities.has(identityKey)) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_DUPLICATE_EVENT_IDENTITY,
                    severity: 'warning',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: 'Duplicate successful event identity detected for same operation and version'
                });
            }
            seenEventIdentities.add(identityKey);
        }

        // Check external resource references if provided
        if (externalRefs) {
            if (entry.category === AUDIT_CATEGORIES.ASSIGNMENT && entry.operationId && externalRefs.assignmentOperations) {
                const opList = Array.isArray(externalRefs.assignmentOperations)
                    ? externalRefs.assignmentOperations
                    : (typeof externalRefs.assignmentOperations.list === 'function' ? externalRefs.assignmentOperations.list() : []);
                const foundOp = opList.find(op => op && (op.operationId === entry.operationId || op.id === entry.operationId));
                if (!foundOp) {
                    issues.push({
                        checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ASSIGNMENT_OPERATION_MISSING,
                        severity: 'warning',
                        resourceType: 'audit_entry',
                        resourceId: entryResourceId,
                        repairable: false,
                        safeMessage: 'Referenced assignment operation does not exist in operations store'
                    });
                }
            }

            if (entry.resourceType === 'voice_call' && externalRefs.voiceCalls) {
                const callList = Array.isArray(externalRefs.voiceCalls)
                    ? externalRefs.voiceCalls
                    : (typeof externalRefs.voiceCalls.list === 'function' ? externalRefs.voiceCalls.list({ includeDeleted: true }) : []);
                const foundCall = callList.find(c => c && c.id === entry.resourceId);
                if (!foundCall) {
                    issues.push({
                        checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_RESOURCE_REFERENCE_MISSING,
                        severity: 'warning',
                        resourceType: 'audit_entry',
                        resourceId: entryResourceId,
                        repairable: false,
                        safeMessage: 'Referenced voice_call resource does not exist in storage'
                    });
                }
            }
        }

        // Retention policy: unset by default.
        // No legal retention period is claimed.
        // Candidate classification only occurs when an explicit threshold is injected for testing.
        // Automatic deletion and automatic archival are strictly disabled.
        if (typeof retentionThresholdDays === 'number' && retentionThresholdDays > 0) {
            const ageDays = (Date.now() - Date.parse(entry.recordedAt)) / (1000 * 60 * 60 * 24);
            if (ageDays > retentionThresholdDays) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_RETENTION_CANDIDATE,
                    severity: 'info',
                    resourceType: 'audit_entry',
                    resourceId: entryResourceId,
                    repairable: false,
                    safeMessage: `Entry exceeds injected retention threshold (${retentionThresholdDays} days; age: ${Math.floor(ageDays)} days)`
                });
            }
        }

        prevEntry = entry;
    }

    // 4. AuditHead store validation
    try {
        const head = auditRepo.getData(AUDIT_HEAD_STORAGE_FILE, null);
        if (head) {
            if (typeof head !== 'object' || Array.isArray(head)) {
                issues.push({
                    checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_CORRUPTED,
                    severity: 'error',
                    resourceType: 'audit_head',
                    resourceId: AUDIT_HEAD_STORAGE_FILE,
                    repairable: false,
                    safeMessage: 'AuditHead is not a valid JSON object'
                });
            } else {
                const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

                if (lastEntry) {
                    if (head.lastSequence < lastEntry.sequence) {
                        issues.push({
                            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_BEHIND,
                            severity: 'warning',
                            resourceType: 'audit_head',
                            resourceId: AUDIT_HEAD_STORAGE_FILE,
                            repairable: false,
                            safeMessage: `AuditHead lastSequence (${head.lastSequence}) is behind entries (${lastEntry.sequence})`
                        });
                    } else if (head.lastSequence > lastEntry.sequence) {
                        issues.push({
                            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_AHEAD,
                            severity: 'error',
                            resourceType: 'audit_head',
                            resourceId: AUDIT_HEAD_STORAGE_FILE,
                            repairable: false,
                            safeMessage: `AuditHead lastSequence (${head.lastSequence}) is ahead of entries (${lastEntry.sequence}) - truncation suspected`
                        });
                    }

                    if (head.lastEntryHash && head.lastEntryHash !== lastEntry.entryHash) {
                        issues.push({
                            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_HASH_MISMATCH,
                            severity: 'error',
                            resourceType: 'audit_head',
                            resourceId: AUDIT_HEAD_STORAGE_FILE,
                            repairable: false,
                            safeMessage: 'AuditHead lastEntryHash does not match tail entryHash'
                        });
                    }
                }
            }
        }
    } catch {
        issues.push({
            checkCode: AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_HEAD_CORRUPTED,
            severity: 'error',
            resourceType: 'audit_head',
            resourceId: AUDIT_HEAD_STORAGE_FILE,
            repairable: false,
            safeMessage: 'Exception occurred while reading AuditHead store'
        });
    }

    return {
        timestamp,
        totalRecords: entries.length,
        issuesCount: issues.length,
        issues
    };
}

/**
 * Primary read-only contract for audit log reconciliation.
 * Strictly read-only: never alters stored entries or heads.
 */
export const reconcileAuditLog = runAuditReconciliation;

/**
 * Read-only repair preview for AuditHead.json.
 * Validates full hash chain integrity before recommending any repair.
 * Never allows repair if the hash chain contains errors or tampering.
 *
 * @param {object} params
 * @param {object} params.auditRepo
 * @returns {Promise<{ repairable: boolean, reason?: string, currentHead?: object, proposedHead?: object, warning?: string }>}
 */
export async function previewAuditHeadRepair({ auditRepo } = {}) {
    if (!auditRepo) {
        return { repairable: false, reason: 'AuditRepository is required' };
    }

    const report = await runAuditReconciliation({ auditRepo });

    // Check if there are any fatal chain corruption or tampering issues
    const unrepairableCodes = new Set([
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_STORE_CORRUPTED,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_HASH_INVALID,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_HASH_MISMATCH,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_PREVIOUS_HASH_MISMATCH,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_GENESIS_HASH_INVALID,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_GAP,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_OUT_OF_ORDER,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_SEQUENCE_DUPLICATE,
        AUDIT_RECONCILIATION_CHECK_CODES.AUDIT_ENTRY_DUPLICATE_ID
    ]);

    const hasChainError = report.issues.some(issue => unrepairableCodes.has(issue.checkCode));
    if (hasChainError) {
        return {
            repairable: false,
            reason: 'Audit hash chain contains corruption or hash errors; repair is strictly prohibited'
        };
    }

    // Inspect entries to determine tail
    let rawEntries = [];
    try {
        rawEntries = auditRepo.getData(AUDIT_STORAGE_FILE, []);
    } catch {
        return { repairable: false, reason: 'Failed to read audit entries store' };
    }

    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        return { repairable: false, reason: 'No audit entries available to construct head' };
    }

    const lastEntry = rawEntries[rawEntries.length - 1];
    let currentHead = null;
    try {
        currentHead = auditRepo.getData(AUDIT_HEAD_STORAGE_FILE, null);
    } catch {
        currentHead = null;
    }

    // If head already matches tail exactly, repair is unnecessary
    if (
        currentHead &&
        currentHead.lastSequence === lastEntry.sequence &&
        currentHead.lastEntryHash === lastEntry.entryHash
    ) {
        return {
            repairable: false,
            reason: 'AuditHead is already synchronized with tail entry',
            currentHead
        };
    }

    const previewId = `preview_${lastEntry.sequence}_${lastEntry.entryHash.slice(0, 16)}`;
    const previewTimestamp = new Date().toISOString();

    const proposedHead = {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        lastSequence: lastEntry.sequence,
        lastEntryHash: lastEntry.entryHash,
        updatedAt: lastEntry.recordedAt || previewTimestamp
    };

    return {
        repairable: true,
        previewId,
        previewTimestamp,
        currentHead,
        proposedHead,
        warning: 'Cross-store repair is not ACID. withFileLock protects concurrent asynchronous operations inside one Node.js process only. It does not protect multiple Node.js processes, multiple containers, multiple hosts, or shared NAS writers.'
    };
}

/**
 * Restricted repair execution for AuditHead.json.
 * Strict conditions:
 * - Requires explicit internal administrative context (actorContext.role === 'admin')
 * - Requires dedicated repair capability ('audit.repair_head' or permissions.auditRepair)
 * - Requires explicit reasonCode
 * - Requires validated current preview identity
 * - Verifies unchanged entries and head since preview
 * - Requires validated full-chain result (never repair chain with hash errors)
 * - Never silently repair on startup
 * - Reports that cross-store repair is not ACID
 *
 * @param {object} params
 * @param {object} params.auditRepo
 * @param {object} params.actorContext
 * @param {string} params.reasonCode
 * @param {string} [params.previewId]
 * @param {object} [params.preview]
 * @returns {Promise<{ success: boolean, head: object, acidGuaranteed: boolean, notice: string }>}
 */
export async function executeAuditHeadRepair({
    auditRepo,
    actorContext,
    reasonCode,
    previewId,
    preview
} = {}) {
    if (!actorContext || actorContext.role !== 'admin') {
        throw new Error('Administrative authorization required: only admin role can execute audit head repair');
    }

    const hasRepairCapability = Boolean(
        actorContext.capabilities?.includes('audit.repair_head') ||
        actorContext.permissions?.auditRepair === true ||
        actorContext.permissions?.canRepairAuditHead === true ||
        actorContext.allowAuditRepair === true ||
        actorContext.capabilities?.includes('voice_system.repair_audit_head')
    );
    if (!hasRepairCapability) {
        throw new Error('Dedicated repair capability (audit.repair_head) is required for audit head repair execution');
    }

    if (!reasonCode || typeof reasonCode !== 'string' || reasonCode.trim().length === 0) {
        throw new Error('Explicit reasonCode is required for audit head repair execution');
    }

    const freshPreview = await previewAuditHeadRepair({ auditRepo });
    if (!freshPreview.repairable) {
        throw new Error(`Audit head repair rejected: ${freshPreview.reason}`);
    }

    const targetPreview = preview || freshPreview;
    const expectedId = previewId || targetPreview.previewId;
    if (expectedId && expectedId !== freshPreview.previewId) {
        throw new Error('Audit head repair rejected: preview identity mismatch or store state modified since preview');
    }

    // Verify entries have not changed since preview
    const currentTail = await auditRepo.getEntryBySequence(freshPreview.proposedHead.lastSequence);
    if (!currentTail || currentTail.entryHash !== freshPreview.proposedHead.lastEntryHash) {
        throw new Error('Audit head repair rejected: audit entries changed since preview generation');
    }

    const saved = await auditRepo.persistData(AUDIT_HEAD_STORAGE_FILE, freshPreview.proposedHead);
    if (!saved) {
        throw new Error('Failed to persist repaired AuditHead to disk');
    }

    return {
        success: true,
        head: freshPreview.proposedHead,
        acidGuaranteed: false,
        notice: 'Cross-store repair is not ACID. withFileLock protects concurrent asynchronous operations inside one Node.js process only. It does not protect multiple Node.js processes, multiple containers, multiple hosts, or shared NAS writers.'
    };
}

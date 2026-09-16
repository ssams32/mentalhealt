/**
 * server/voice-access/voiceAccessReconciliation.js
 * Read-Only Diagnostic Reconciler for Voice Access Grants and History Stores.
 * Covers 14 Check Codes with Zero PII Leakage and Zero Disk Mutations.
 */

import fs from 'fs';
import path from 'path';
import {
    GRANTS_FILE_NAME,
    HISTORY_FILE_NAME,
    GRANT_STATUS,
    ACCESS_SCOPE_TYPE,
    ALL_VOICE_ACCESS_CAPABILITIES,
    VOICE_ACCESS_CHECK_CODES
} from './voiceAccessConstants.js';
import { containsProhibitedPII } from './voiceAccessValidator.js';

export class VoiceAccessReconciliation {
    /**
     * @param {Object} [options]
     * @param {string} [options.dataDir]
     * @param {string} [options.grantsFilePath]
     * @param {string} [options.historyFilePath]
     * @param {Object} [options.userRepo]
     */
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.resolve(process.cwd(), 'server', 'data');
        this.grantsFilePath = options.grantsFilePath || path.join(this.dataDir, GRANTS_FILE_NAME);
        this.historyFilePath = options.historyFilePath || path.join(this.dataDir, HISTORY_FILE_NAME);
        this.userRepo = options.userRepo || null;
    }

    /**
     * Run read-only consistency audit across grants and history files.
     * @returns {Promise<{ isHealthy: boolean, totalIssues: number, issues: Array<Object>, summary: Object }>}
     */
    async reconcile() {
        const issues = [];
        let grants = [];
        let history = [];

        // 1. Grants Store Existence & Syntax Check
        if (!fs.existsSync(this.grantsFilePath)) {
            issues.push({
                code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_STORE_MISSING,
                severity: 'WARNING',
                message: 'Voice access grants file does not exist'
            });
        } else {
            try {
                const raw = await fs.promises.readFile(this.grantsFilePath, 'utf-8');
                if (raw.trim().length > 0) {
                    const parsed = JSON.parse(raw);
                    if (!Array.isArray(parsed)) {
                        issues.push({
                            code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_STORE_CORRUPTED,
                            severity: 'ERROR',
                            message: 'Grants store root is not an array'
                        });
                    } else {
                        grants = parsed;
                    }
                }
            } catch (err) {
                issues.push({
                    code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_STORE_CORRUPTED,
                    severity: 'ERROR',
                    message: 'Grants store JSON failed to parse'
                });
            }
        }

        // 2. History Store Existence & Syntax Check
        if (!fs.existsSync(this.historyFilePath)) {
            issues.push({
                code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_HISTORY_STORE_MISSING,
                severity: 'WARNING',
                message: 'Voice access history file does not exist'
            });
        } else {
            try {
                const raw = await fs.promises.readFile(this.historyFilePath, 'utf-8');
                if (raw.trim().length > 0) {
                    const parsed = JSON.parse(raw);
                    if (!Array.isArray(parsed)) {
                        issues.push({
                            code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_HISTORY_STORE_CORRUPTED,
                            severity: 'ERROR',
                            message: 'History store root is not an array'
                        });
                    } else {
                        history = parsed;
                    }
                }
            } catch (err) {
                issues.push({
                    code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_HISTORY_STORE_CORRUPTED,
                    severity: 'ERROR',
                    message: 'History store JSON failed to parse'
                });
            }
        }

        // 3. Evaluate Grants
        const activeUsers = new Set();
        const now = new Date();
        let totalActiveGrants = 0;

        for (const grant of grants) {
            if (!grant || typeof grant !== 'object') continue;

            // Check PII
            if (grant.reason && containsProhibitedPII(grant.reason)) {
                issues.push({
                    code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_PROHIBITED_PII,
                    severity: 'ERROR',
                    message: `Prohibited PII detected in grant reason [grantId=${grant.id}]`,
                    grantId: grant.id
                });
            }

            // Check Capabilities
            if (Array.isArray(grant.capabilities)) {
                for (const cap of grant.capabilities) {
                    if (!ALL_VOICE_ACCESS_CAPABILITIES.includes(cap)) {
                        issues.push({
                            code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_UNKNOWN_CAPABILITY,
                            severity: 'WARNING',
                            message: `Unknown capability [${String(cap)}] in grant [grantId=${grant.id}]`,
                            grantId: grant.id
                        });
                    }
                }
            }

            // Active grant checks
            if (grant.status === GRANT_STATUS.ACTIVE) {
                totalActiveGrants++;

                // Duplicate active grant check
                if (activeUsers.has(grant.userId)) {
                    issues.push({
                        code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_DUPLICATE_ACTIVE_GRANT,
                        severity: 'ERROR',
                        message: `Multiple active grants detected for userId [${grant.userId}]`,
                        grantId: grant.id
                    });
                }
                activeUsers.add(grant.userId);

                // Expired active check
                if (grant.expiresAt) {
                    const exp = new Date(grant.expiresAt);
                    if (now > exp) {
                        issues.push({
                            code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_EXPIRED_ACTIVE,
                            severity: 'WARNING',
                            message: `Grant [${grant.id}] is expired but still marked active`,
                            grantId: grant.id
                        });
                    }
                }
            }

            // External User Cross-Reference Check (if userRepo provided)
            if (this.userRepo && typeof this.userRepo.findById === 'function') {
                const user = this.userRepo.findById(grant.userId);
                if (!user) {
                    issues.push({
                        code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_USER_NOT_FOUND,
                        severity: 'WARNING',
                        message: `User not found for grant [${grant.id}]`,
                        grantId: grant.id
                    });
                } else {
                    if (user.status !== 'active' || user.isDeleted === true || user.isSuspended === true) {
                        if (grant.status === GRANT_STATUS.ACTIVE) {
                            issues.push({
                                code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_USER_INACTIVE,
                                severity: 'ERROR',
                                message: `Active grant [${grant.id}] references inactive/suspended user`,
                                grantId: grant.id
                            });
                        }
                    }

                    // Scope expansion check against user role
                    if (user.role === 'user' && grant.scope && grant.scope.type !== ACCESS_SCOPE_TYPE.ASSIGNED_ONLY) {
                        issues.push({
                            code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_GRANT_SCOPE_EXPANSION,
                            severity: 'ERROR',
                            message: `Regular user has wider grant scope [${grant.scope.type}] than role ceiling [assigned_only]`,
                            grantId: grant.id
                        });
                    }
                }
            }
        }

        if (totalActiveGrants === 0 && grants.length > 0) {
            issues.push({
                code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_ZERO_ACTIVE_GRANTS,
                severity: 'INFO',
                message: 'No active grants currently in store'
            });
        }

        // 4. Evaluate History
        const grantIdSet = new Set(grants.map(g => g.id));
        let lastPerformedAt = 0;

        for (const entry of history) {
            if (!entry || typeof entry !== 'object') continue;

            // Orphan check
            if (grantIdSet.size > 0 && !grantIdSet.has(entry.grantId)) {
                issues.push({
                    code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_HISTORY_ORPHANED,
                    severity: 'WARNING',
                    message: `History entry [${entry.id}] references non-existent grantId [${entry.grantId}]`,
                    historyId: entry.id
                });
            }

            // Sequence / timestamp anomaly check
            if (entry.performedAt) {
                const ts = new Date(entry.performedAt).getTime();
                if (ts < lastPerformedAt) {
                    issues.push({
                        code: VOICE_ACCESS_CHECK_CODES.VOICE_ACCESS_HISTORY_SEQUENCE_ANOMALY,
                        severity: 'WARNING',
                        message: `History entry [${entry.id}] timestamp is earlier than preceding record`,
                        historyId: entry.id
                    });
                }
                lastPerformedAt = ts;
            }
        }

        const hasErrors = issues.some(i => i.severity === 'ERROR');

        return {
            isHealthy: !hasErrors,
            totalIssues: issues.length,
            issues,
            summary: {
                totalGrants: grants.length,
                activeGrants: totalActiveGrants,
                totalHistoryEntries: history.length,
                uniqueUsersWithActiveGrants: activeUsers.size
            }
        };
    }
}

/**
 * server/voice-access/voiceAccessMetrics.js
 * Read-Only Operational Metrics Snapshot for Voice System Access Subsystem.
 * Exposes Zero PII, Zero User Identifiers, and Zero Secret Information.
 */

import { GRANT_STATUS } from './voiceAccessConstants.js';

export class VoiceAccessMetrics {
    /**
     * @param {Object} deps
     * @param {import('./voiceAccessRepository.js').VoiceAccessRepository} deps.voiceAccessRepo
     * @param {import('./voiceAccessHistoryRepository.js').VoiceAccessHistoryRepository} deps.voiceAccessHistoryRepo
     */
    constructor(deps = {}) {
        this.voiceAccessRepo = deps.voiceAccessRepo;
        this.voiceAccessHistoryRepo = deps.voiceAccessHistoryRepo;
    }

    /**
     * Generate an operational metrics snapshot.
     * @returns {Promise<Object>}
     */
    async getMetricsSnapshot() {
        let grants = [];
        let historyCount = 0;
        let isHealthy = true;

        try {
            grants = await this.voiceAccessRepo.findAll();
        } catch {
            isHealthy = false;
        }

        try {
            historyCount = await this.voiceAccessHistoryRepo.count();
        } catch {
            isHealthy = false;
        }

        const now = new Date();
        let activeCount = 0;
        let suspendedCount = 0;
        let revokedCount = 0;
        let expiredCount = 0;
        const uniqueActiveUsers = new Set();

        for (const grant of grants) {
            if (grant.status === GRANT_STATUS.ACTIVE) {
                if (grant.expiresAt && new Date(grant.expiresAt) < now) {
                    expiredCount++;
                } else {
                    activeCount++;
                    uniqueActiveUsers.add(grant.userId);
                }
            } else if (grant.status === GRANT_STATUS.SUSPENDED) {
                suspendedCount++;
            } else if (grant.status === GRANT_STATUS.REVOKED) {
                revokedCount++;
            }
        }

        return {
            timestamp: new Date().toISOString(),
            isStoreHealthy: isHealthy,
            totalGrants: grants.length,
            activeGrantsCount: activeCount,
            suspendedGrantsCount: suspendedCount,
            revokedGrantsCount: revokedCount,
            expiredGrantsCount: expiredCount,
            totalHistoryRecords: historyCount,
            usersWithAccessCount: uniqueActiveUsers.size
        };
    }
}

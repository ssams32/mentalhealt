/**
 * Referrals mutation engine (production).
 *
 * Extracted verbatim from server.js so that the integrity-verification engine can be
 * exercised directly by test harnesses without booting the HTTP server. This module
 * contains NO test-only code, NO test-only routes, and NO environment backdoors.
 *
 * server.js wires it with its own getData/persistData/referralAuditLogger closures:
 *   const { mutateReferrals } = createReferralMutationEngine({ getData, persistData, referralAuditLogger });
 */
import crypto from 'crypto';

class AsyncMutex {
    constructor() {
        this._queue = Promise.resolve();
    }
    async runExclusive(task) {
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        const previous = this._queue;
        this._queue = wait;
        try {
            await previous;
            return await task();
        } finally {
            release();
        }
    }
}

export class ReferralIntegrityError extends Error {
    constructor(message, code = 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
        super(message);
        this.name = 'ReferralIntegrityError';
        this.code = code;
    }
}

const canonicalRecordHash = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const key of sortedKeys) {
        sortedObj[key] = obj[key];
    }
    return crypto.createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
};

export const restoreCacheInPlace = (targetArray, snapshotArray) => {
    targetArray.length = 0;
    for (let i = 0; i < snapshotArray.length; i++) {
        targetArray.push(snapshotArray[i]);
    }
};

/**
 * Common mutation engine for Referrals.
 * Enforces:
 * 1. Single-process async mutex (F5)
 * 2. Pre-mutation snapshot (stable IDs, canonical hash map, deep copy)
 * 3. Post-mutation pre-persist integrity verification (F1)
 * 4. In-place cache rollback on integrity violation or persist failure
 */
export function createReferralMutationEngine({ getData, persistData, referralAuditLogger }) {
    const referralsMutex = new AsyncMutex();

    const mutateReferrals = async (options, mutationFn) => {
        return referralsMutex.runExclusive(async () => {
            const referrals = getData('Referrals', []);
            const snapshot = JSON.parse(JSON.stringify(referrals));
            const beforeIds = new Set(snapshot.map(r => r && r.referralId).filter(Boolean));
            const beforeCount = snapshot.length;
            const beforeHashMap = new Map(snapshot.map(r => [r && r.referralId, canonicalRecordHash(r)]));

            let result;
            try {
                result = await mutationFn(referrals);
            } catch (err) {
                restoreCacheInPlace(referrals, snapshot);
                throw err;
            }

            const afterCount = referrals.length;
            const afterIds = new Set(referrals.map(r => r && r.referralId).filter(Boolean));
            const afterHashMap = new Map(referrals.map(r => [r && r.referralId, canonicalRecordHash(r)]));

            let isValid = true;
            let violationReason = '';
            const opType = options.opType;

            if (opType === 'CREATE') {
                // beforeIds ⊆ afterIds AND afterCount == beforeCount + 1
                const subsetCheck = [...beforeIds].every(id => afterIds.has(id));
                if (!subsetCheck || afterCount !== beforeCount + 1) {
                    isValid = false;
                    violationReason = `CREATE: before=${beforeCount}, after=${afterCount}, subset=${subsetCheck}`;
                }
            } else if (['UPDATE', 'NOTES', 'ASSIGNEE', 'STATUS'].includes(opType)) {
                // ID 집합 동일 AND count 동일 AND 변경된 레코드가 정확히 대상 1건
                const sameCount = (beforeCount === afterCount);
                const idsEqual = (beforeIds.size === afterIds.size) && [...beforeIds].every(id => afterIds.has(id));

                const changedIds = [];
                for (const [id, beforeHash] of beforeHashMap.entries()) {
                    const afterHash = afterHashMap.get(id);
                    if (beforeHash !== afterHash) {
                        changedIds.push(id);
                    }
                }

                const targetId = options.targetId;
                const changedTargetMatch = (changedIds.length === 1 && (!targetId || changedIds[0] === targetId));

                if (!sameCount || !idsEqual || !changedTargetMatch) {
                    isValid = false;
                    violationReason = `${opType}: sameCount=${sameCount}, idsEqual=${idsEqual}, changedCount=${changedIds.length}, target=${targetId}`;
                }
            } else if (['DELETE', 'BULK_DELETE'].includes(opType)) {
                // 호출자가 expectedRemovalIds 명시 선언 AND 실제 ID 차이와 일치
                const expectedRemovals = new Set(options.expectedRemovalIds || []);
                const removedIds = [...beforeIds].filter(id => !afterIds.has(id));

                const removedMatches = (removedIds.length === expectedRemovals.size) &&
                    removedIds.every(id => expectedRemovals.has(id));
                const countMatches = (afterCount === beforeCount - expectedRemovals.size);

                let othersUnchanged = true;
                for (const [id, beforeHash] of beforeHashMap.entries()) {
                    if (!expectedRemovals.has(id)) {
                        if (afterHashMap.get(id) !== beforeHash) {
                            othersUnchanged = false;
                            break;
                        }
                    }
                }

                if (!removedMatches || !countMatches || !othersUnchanged) {
                    isValid = false;
                    violationReason = `${opType}: removedMatches=${removedMatches}, countMatches=${countMatches}, othersUnchanged=${othersUnchanged}`;
                }
            } else if (opType === 'RESTORE') {
                const expectedAdditions = new Set(options.expectedAdditionIds || []);
                const addedIds = [...afterIds].filter(id => !beforeIds.has(id));

                const addedMatches = (addedIds.length === expectedAdditions.size) &&
                    addedIds.every(id => expectedAdditions.has(id));
                const countMatches = (afterCount === beforeCount + expectedAdditions.size);

                let existingUnchanged = true;
                for (const [id, beforeHash] of beforeHashMap.entries()) {
                    if (afterHashMap.get(id) !== beforeHash) {
                        existingUnchanged = false;
                        break;
                    }
                }

                if (!addedMatches || !countMatches || !existingUnchanged) {
                    isValid = false;
                    violationReason = `RESTORE: addedMatches=${addedMatches}, countMatches=${countMatches}, existingUnchanged=${existingUnchanged}`;
                }
            } else {
                isValid = false;
                violationReason = `Unknown opType: ${opType}`;
            }

            if (!isValid) {
                restoreCacheInPlace(referrals, snapshot);
                const diffCount = Math.abs(afterCount - beforeCount);
                await referralAuditLogger({
                    actorUserId: options.actorUserId || 'system',
                    action: 'REFERRAL_DATA_INTEGRITY_VIOLATION',
                    targetId: `count:${diffCount}`,
                    result: 'BLOCKED',
                    reasonCode: opType
                });
                throw new ReferralIntegrityError(`데이터 무결성 검증 실패: ${violationReason}`, 'REFERRAL_DATA_INTEGRITY_VIOLATION');
            }

            try {
                await persistData('Referrals', referrals);
            } catch (persistErr) {
                restoreCacheInPlace(referrals, snapshot);
                throw persistErr;
            }

            return result;
        });
    };

    return { mutateReferrals };
}

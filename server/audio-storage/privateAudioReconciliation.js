/**
 * server/audio-storage/privateAudioReconciliation.js
 * Read-only Integrity & Consistency Auditor for Mind-ERP OS Private Audio Storage.
 * Evaluates all 18 Canonical Storage Reconciliation Checks without mutations or deletes.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { STORAGE_RECONCILIATION_CHECKS } from './privateAudioStorageConstants.js';
import { isSafePrivateStorageKey } from './privateAudioStorageKey.js';
import { PROCESSING_STATUS } from '../voice-calls/voiceCallConstants.js';

export class PrivateAudioReconciliationService {
    /**
     * @param {Object} deps
     * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepo
     * @param {import('./privateAudioStorage.js').PrivateAudioStorage} deps.audioStorage
     */
    constructor(deps = {}) {
        this.voiceCallRepo = deps.voiceCallRepo;
        this.audioStorage = deps.audioStorage;
    }

    /**
     * Run non-destructive consistency audit across database records and physical audio directories.
     * @returns {Promise<{ timestamp: string, issuesCount: number, issues: Array }>}
     */
    async runReconciliation() {
        const issues = [];
        const calls = this.voiceCallRepo ? this.voiceCallRepo.list({ includeDeleted: true }) : [];

        const callMap = new Map();
        const storageKeyMap = new Map(); // storageKey -> callId
        const activeCalls = [];

        for (const call of calls) {
            if (!call || !call.id) continue;
            callMap.set(call.id, call);
            if (!call.isDeleted) activeCalls.push(call);

            // Check 8: DUPLICATE_STORAGE_KEY
            if (call.storageKey && call.storageKey.startsWith('private-audio/')) {
                if (storageKeyMap.has(call.storageKey)) {
                    issues.push({
                        checkCode: STORAGE_RECONCILIATION_CHECKS.DUPLICATE_STORAGE_KEY,
                        severity: 'error',
                        resourceType: 'storage_key',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: '동일한 영구 저장소 키(storageKey)를 둘 이상의 통화 레코드가 참조하고 있습니다.'
                    });
                } else {
                    storageKeyMap.set(call.storageKey, call.id);
                }
            }

            // Check 5: INVALID_PRIVATE_STORAGE_KEY
            if (call.storageKey && call.storageKey.startsWith('private-audio/') && !isSafePrivateStorageKey(call.storageKey)) {
                issues.push({
                    checkCode: STORAGE_RECONCILIATION_CHECKS.INVALID_PRIVATE_STORAGE_KEY,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: '통화 레코드의 영구 저장소 키가 보안 규칙 또는 구문 규격을 위반했습니다.'
                });
            }

            // Check 12: REJECTED_CALL_HAS_NORMAL_STORAGE
            if (call.processingStatus === PROCESSING_STATUS.REJECTED && call.storageKey) {
                issues.push({
                    checkCode: STORAGE_RECONCILIATION_CHECKS.REJECTED_CALL_HAS_NORMAL_STORAGE,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: '거부(rejected) 상태인 통화 레코드에 정상 영구 저장소 키가 연결되어 있습니다.'
                });
            }

            // Check 13: VALID_CALL_HAS_QUARANTINE_STORAGE
            if (call.processingStatus !== PROCESSING_STATUS.REJECTED && call.quarantineStorageKey) {
                issues.push({
                    checkCode: STORAGE_RECONCILIATION_CHECKS.VALID_CALL_HAS_QUARANTINE_STORAGE,
                    severity: 'warning',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: '정상 통화 레코드에 격리 저장소 키(quarantineStorageKey)가 남아있습니다.'
                });
            }

            // Check 15: PENDING_STORAGE_LINK_STALE
            if (call.pendingStorageKey) {
                issues.push({
                    checkCode: STORAGE_RECONCILIATION_CHECKS.PENDING_STORAGE_LINK_STALE,
                    severity: 'warning',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: '통화 레코드에 완료되지 않은 보류 중인 승격 키(pendingStorageKey)가 존재합니다.'
                });
            }

            // Check 17: STORAGE_PROMOTION_INCOMPLETE
            if (call.storagePromotionStatus === 'incomplete' || call.storagePromotionStatus === 'failed') {
                issues.push({
                    checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_PROMOTION_INCOMPLETE,
                    severity: 'warning',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: `오디오 승격 작업이 불완전(incomplete/failed) 상태로 종료되었습니다.`
                });
            }

            // Check 1: STORAGE_KEY_WITHOUT_FILE
            // Check 3: STORAGE_HASH_MISMATCH
            // Check 4: STORAGE_SIZE_MISMATCH
            if (call.storageKey && call.storageKey.startsWith('private-audio/') && this.audioStorage) {
                let diskPath;
                try {
                    const resolved = resolveAndValidatePath(this.audioStorage.config.privateAudioRoot, call.storageKey);
                    diskPath = resolved.resolvedPath;
                } catch (err) {
                    diskPath = path.resolve(this.audioStorage.config.privateAudioRoot, call.storageKey);
                }
                if (!fs.existsSync(diskPath)) {
                    issues.push({
                        checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_KEY_WITHOUT_FILE,
                        severity: 'error',
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: '통화 레코드에 영구 저장소 키가 등록되어 있으나 실제 오디오 파일이 디스크에 존재하지 않습니다.'
                    });
                } else {
                    try {
                        const lstat = fs.lstatSync(diskPath);
                        // Check 6: STORAGE_FILE_IS_SYMLINK
                        if (lstat.isSymbolicLink()) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_FILE_IS_SYMLINK,
                                severity: 'error',
                                resourceType: 'storage_file',
                                resourceId: call.id,
                                repairable: false,
                                safeMessage: '영구 저장소 오디오 파일이 허용되지 않은 심볼릭 링크입니다.'
                            });
                        }
                        // Check 7: STORAGE_FILE_NOT_REGULAR
                        if (!lstat.isFile()) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_FILE_NOT_REGULAR,
                                severity: 'error',
                                resourceType: 'storage_file',
                                resourceId: call.id,
                                repairable: false,
                                safeMessage: '영구 저장소의 대상이 일반 파일이 아닙니다.'
                            });
                        }
                        // Check 4: STORAGE_SIZE_MISMATCH
                        if (call.fileSize !== undefined && lstat.size !== Number(call.fileSize)) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_SIZE_MISMATCH,
                                severity: 'warning',
                                resourceType: 'voice_call',
                                resourceId: call.id,
                                repairable: false,
                                safeMessage: '디스크에 존재하는 영구 오디오 파일의 크기가 레코드 메타데이터와 불일치합니다.'
                            });
                        }
                        // Check 3: STORAGE_HASH_MISMATCH
                        if (call.contentHash) {
                            const actualHash = crypto.createHash('sha256').update(fs.readFileSync(diskPath)).digest('hex').toLowerCase();
                            if (actualHash !== call.contentHash.toLowerCase().trim()) {
                                issues.push({
                                    checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_HASH_MISMATCH,
                                    severity: 'error',
                                    resourceType: 'voice_call',
                                    resourceId: call.id,
                                    repairable: false,
                                    safeMessage: '디스크의 영구 오디오 파일 해시가 등록된 contentHash와 일치하지 않습니다.'
                                });
                            }
                        }
                    } catch (readErr) {
                        issues.push({
                            checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_METADATA_LINK_MISMATCH,
                            severity: 'error',
                            resourceType: 'storage_file',
                            resourceId: call.id,
                            repairable: false,
                            safeMessage: '영구 오디오 파일 검사 중 디스크 읽기 오류가 발생했습니다.'
                        });
                    }
                }
            }
        }

        // 2. Physical File Scan on privateAudioRoot:
        // Check 2: FILE_WITHOUT_VOICE_CALL (Orphan audio file)
        // Check 11: PROMOTION_PARTIAL_FILE
        if (this.audioStorage && fs.existsSync(this.audioStorage.config.privateAudioRoot)) {
            const scanDir = (dir) => {
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    return;
                }

                for (const entry of entries) {
                    const fullP = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanDir(fullP);
                    } else if (entry.isFile()) {
                        // Check 11: PROMOTION_PARTIAL_FILE
                        if (entry.name.includes('.part_')) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.PROMOTION_PARTIAL_FILE,
                                severity: 'warning',
                                resourceType: 'temporary_file',
                                resourceId: entry.name,
                                repairable: true,
                                safeMessage: '승격 도중 중단되었거나 잔류된 부분 파일(.part)이 감지되었습니다.'
                            });
                            continue;
                        }

                        const relKey = path.relative(this.audioStorage.config.privateAudioRoot, fullP).replace(/\\/g, '/');
                        const matchedCallId = storageKeyMap.get(relKey) || 
                            storageKeyMap.get(`private-audio/${relKey}`) ||
                            storageKeyMap.get(relKey.replace(/^private-audio\//, ''));
                        if (!matchedCallId) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.FILE_WITHOUT_VOICE_CALL,
                                severity: 'warning',
                                resourceType: 'orphan_file',
                                resourceId: entry.name,
                                repairable: false,
                                safeMessage: '디스크에 영구 오디오 파일이 존재하나 연결된 VoiceCall 레코드가 없습니다.'
                            });
                        }
                    }
                }
            };
            scanDir(this.audioStorage.config.privateAudioRoot);
        }

        // 3. Physical Scan on quarantineAudioRoot:
        // Check 14: QUARANTINE_FILE_WITHOUT_REJECTED_RECORD
        if (this.audioStorage && fs.existsSync(this.audioStorage.config.quarantineAudioRoot)) {
            const scanQuarantine = (dir) => {
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    return;
                }

                for (const entry of entries) {
                    const fullP = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanQuarantine(fullP);
                    } else if (entry.isFile()) {
                        const relKey = path.relative(this.audioStorage.config.quarantineAudioRoot, fullP).replace(/\\/g, '/');
                        const isReferenced = calls.some(c => c.quarantineStorageKey && c.quarantineStorageKey.endsWith(relKey));
                        if (!isReferenced) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.QUARANTINE_FILE_WITHOUT_REJECTED_RECORD,
                                severity: 'warning',
                                resourceType: 'quarantine_file',
                                resourceId: entry.name,
                                repairable: false,
                                safeMessage: '격리 저장소에 파일이 존재하나 참조하는 거부(rejected) 레코드가 없습니다.'
                            });
                        }
                    }
                }
            };
            scanQuarantine(this.audioStorage.config.quarantineAudioRoot);
        }

        // 4. Physical Scan on temporaryAudioRoot:
        // Check 9: TEMP_FILE_EXPIRED
        // Check 10: TEMP_FILE_WITHOUT_INTAKE
        if (this.audioStorage && fs.existsSync(this.audioStorage.config.temporaryAudioRoot)) {
            try {
                const tempEntries = fs.readdirSync(this.audioStorage.config.temporaryAudioRoot, { withFileTypes: true });
                const now = Date.now();
                for (const te of tempEntries) {
                    if (te.isFile() && te.name.endsWith('.part')) {
                        const fp = path.join(this.audioStorage.config.temporaryAudioRoot, te.name);
                        const stat = fs.statSync(fp);
                        const ageMinutes = (now - stat.mtimeMs) / (1000 * 60);

                        // If temp file older than 60 minutes, report expired
                        if (ageMinutes > 60) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.TEMP_FILE_EXPIRED,
                                severity: 'warning',
                                resourceType: 'temporary_file',
                                resourceId: te.name,
                                repairable: true,
                                safeMessage: `임시 오디오 파일의 보존 시간(${Math.round(ageMinutes)}분)이 만료되었습니다.`
                            });
                        }

                        // Check 10: TEMP_FILE_WITHOUT_INTAKE
                        const isReferenced = calls.some(c => 
                            (c.storageKey && c.storageKey.includes(te.name)) ||
                            (c.pendingStorageKey && c.pendingStorageKey.includes(te.name)) ||
                            (c.intakeReference && c.intakeReference.includes(te.name))
                        );
                        if (!isReferenced) {
                            issues.push({
                                checkCode: STORAGE_RECONCILIATION_CHECKS.TEMP_FILE_WITHOUT_INTAKE,
                                severity: 'warning',
                                resourceType: 'temporary_file',
                                resourceId: te.name,
                                repairable: true,
                                safeMessage: '임시 저장소에 파일이 존재하나 연결된 Intake 또는 VoiceCall 레코드가 없습니다.'
                            });
                        }
                    }
                }
            } catch (ignore) {}
        }

        // 5. Storage Capacity Health Check:
        // Check 16: STORAGE_CAPACITY_WARNING
        if (this.audioStorage && typeof this.audioStorage.checkCapacity === 'function') {
            try {
                const cap = await this.audioStorage.checkCapacity(0);
                if (cap && cap.verified && !cap.available) {
                    issues.push({
                        checkCode: STORAGE_RECONCILIATION_CHECKS.STORAGE_CAPACITY_WARNING,
                        severity: 'warning',
                        resourceType: 'storage_root',
                        resourceId: 'privateAudioRoot',
                        repairable: true,
                        safeMessage: '저장소 가용 용량이 최소 안전 기준치(minimumFreeSpaceBytes) 미만입니다.'
                    });
                }
            } catch (ignore) {}
        }

        return {
            timestamp: new Date().toISOString(),
            issuesCount: issues.length,
            issues
        };
    }
}

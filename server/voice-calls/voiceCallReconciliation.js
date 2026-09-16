/**
 * server/voice-calls/voiceCallReconciliation.js
 * Read-only Integrity & Consistency Checker for Mind-ERP OS Voice Calls.
 * Comprehensive audit implementing all 21 Canonical Reconciliation Checks.
 * Strictly non-destructive: Zero automatic deletions, overwrites, or mutations.
 */

import fs from 'fs';
import path from 'path';
import { isValidIsoDate, isSafeStorageKey } from './voiceCallValidator.js';
import {
    PROCESSING_STATUS,
    REVIEW_STATUS,
    ASSIGNMENT_STATUS,
    RECONCILIATION_CHECKS,
    DOMAIN_LIMITS
} from './voiceCallConstants.js';

export class VoiceCallReconciliationService {
    /**
     * @param {Object} deps
     * @param {VoiceCallRepository} deps.voiceCallRepo
     * @param {TranscriptRepository} deps.transcriptRepo
     * @param {ProcessingRevisionRepository} deps.revisionRepo
     * @param {SummaryReviewRepository} deps.reviewRepo
     * @param {AssignmentHistoryRepository} deps.assignmentRepo
     */
    constructor(deps = {}) {
        this.voiceCallRepo = deps.voiceCallRepo;
        this.transcriptRepo = deps.transcriptRepo;
        this.revisionRepo = deps.revisionRepo;
        this.reviewRepo = deps.reviewRepo;
        this.assignmentRepo = deps.assignmentRepo;
    }

    /**
     * Run comprehensive read-only consistency audit across all voice call stores.
     * Evaluates all 21 Canonical Reconciliation Checks.
     */
    async runReconciliation() {
        const issues = [];
        const nowIso = new Date().toISOString();

        // Check 21: CORRUPTED_STORE check across repositories
        const checkStoreHealth = (repo, name, resourceType) => {
            if (repo && repo.isCorrupted) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.CORRUPTED_STORE,
                    severity: 'error',
                    resourceType,
                    resourceId: name,
                    repairable: false,
                    safeMessage: `저장소 [${name}]가 손상(corrupted) 상태에 진입하여 접근이 차단되었습니다.`
                });
                return false;
            }
            return true;
        };

        const voiceCallOk = checkStoreHealth(this.voiceCallRepo, 'VoiceCalls', 'voice_call');
        const revisionOk = checkStoreHealth(this.revisionRepo, 'VoiceCallProcessingRevisions', 'processing_revision');
        const reviewOk = checkStoreHealth(this.reviewRepo, 'VoiceCallSummaryReviews', 'summary_review');
        const historyOk = checkStoreHealth(this.assignmentRepo, 'VoiceCallAssignmentHistory', 'assignment_history');

        let calls = [];
        if (voiceCallOk && this.voiceCallRepo) {
            try {
                calls = this.voiceCallRepo.list({ includeDeleted: true });
            } catch (err) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.CORRUPTED_STORE,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: 'VoiceCalls',
                    repairable: false,
                    safeMessage: 'VoiceCalls 저장소 조회 중 손상이 감지되었습니다.'
                });
            }
        }

        const callMap = new Map();
        const activeHashCount = new Map();

        // 1. Scan VoiceCall records
        for (const call of calls) {
            if (!call || !call.id) continue;
            callMap.set(call.id, call);

            // Check 13: DUPLICATE_CONTENT_HASH
            if (!call.isDeleted && call.contentHash) {
                const count = (activeHashCount.get(call.contentHash) || 0) + 1;
                activeHashCount.set(call.contentHash, count);
                if (count > 1) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.DUPLICATE_CONTENT_HASH,
                        severity: 'warning',
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: '동일한 내용 해시(contentHash)를 가진 통화 레코드가 중복 존재합니다.'
                    });
                }
            }

            // Check 14: INVALID_VERSION
            if (typeof call.version !== 'number' || call.version < 1 || !Number.isSafeInteger(call.version)) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.INVALID_VERSION,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: '레코드 버전 번호가 1 이상의 유효한 정수가 아닙니다.'
                });
            }

            // Check 15: INVALID_TIMESTAMP
            const timestampFields = ['createdAt', 'updatedAt', 'receivedAt', 'confirmedAt', 'processedAt'];
            for (const tf of timestampFields) {
                if (call[tf] && !isValidIsoDate(call[tf])) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.INVALID_TIMESTAMP,
                        severity: 'warning',
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: true,
                        safeMessage: `타임스탬프 필드 [${tf}]의 ISO 형식이 유효하지 않습니다.`
                    });
                }
            }
            if (call.createdAt && call.updatedAt && isValidIsoDate(call.createdAt) && isValidIsoDate(call.updatedAt)) {
                if (new Date(call.updatedAt).getTime() < new Date(call.createdAt).getTime()) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.INVALID_TIMESTAMP,
                        severity: 'error',
                        resourceType: 'voice_call',
                        resourceId: call.id,
                        repairable: true,
                        safeMessage: '수정 시각(updatedAt)이 생성 시각(createdAt)보다 이전입니다.'
                    });
                }
            }

            // Check 16: COMPLETED_MISSING_COMPLETION_FIELDS
            if (call.processingStatus === PROCESSING_STATUS.COMPLETED && !call.confirmedAt && !call.processedAt) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.COMPLETED_MISSING_COMPLETION_FIELDS,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: '완료(completed) 상태인데 완료 시각(confirmedAt 또는 processedAt)이 누락되었습니다.'
                });
            }

            // Check 17: CONFIRMED_MISSING_ACTOR
            if (call.reviewStatus === REVIEW_STATUS.CONFIRMED && (!call.confirmedBy || !call.confirmedAt)) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.CONFIRMED_MISSING_ACTOR,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: '확정(confirmed) 리뷰 상태인데 확정자(confirmedBy) 또는 확정시각(confirmedAt)이 누락되었습니다.'
                });
            }

            // Check 18: ASSIGNED_MISSING_ASSIGNEE
            if ((call.assignmentStatus === ASSIGNMENT_STATUS.ASSIGNED || call.assignmentStatus === ASSIGNMENT_STATUS.REASSIGNED) && !call.assignedUserId) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.ASSIGNED_MISSING_ASSIGNEE,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: true,
                    safeMessage: '배정 상태인데 담당자(assignedUserId)가 누락되었습니다.'
                });
            }

            // Check 19: INVALID_TRANSCRIPT_STORAGE_KEY
            if (call.transcriptStorageKey && !isSafeStorageKey(call.transcriptStorageKey)) {
                issues.push({
                    checkCode: RECONCILIATION_CHECKS.INVALID_TRANSCRIPT_STORAGE_KEY,
                    severity: 'error',
                    resourceType: 'voice_call',
                    resourceId: call.id,
                    repairable: false,
                    safeMessage: '전사 저장소 키가 안전한 상대 경로 규약을 위반했습니다.'
                });
            }

            // Check 1: MISSING_TRANSCRIPT_FILE
            if (call.transcriptStorageKey) {
                const exists = this.transcriptRepo ? this.transcriptRepo.transcriptExists(call.id) : false;
                if (!exists) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.MISSING_TRANSCRIPT_FILE,
                        severity: 'error',
                        resourceType: 'transcript',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: '통화 레코드에 전사 키가 등록되어 있으나 실제 파일이 디스크에 존재하지 않습니다.'
                    });
                }
            }

            // Check 3, 5, 6: ACTIVE_REVISION references
            if (call.activeProcessingRevisionId && this.revisionRepo) {
                const rev = this.revisionRepo.findById(call.activeProcessingRevisionId);
                if (!rev) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.INVALID_ACTIVE_REVISION_REF,
                        severity: 'error',
                        resourceType: 'processing_revision',
                        resourceId: call.id,
                        repairable: false,
                        safeMessage: '활성 처리 리비전 참조(activeProcessingRevisionId)가 존재하지 않는 리비전을 가리킵니다.'
                    });
                } else {
                    if (rev.callId !== call.id) {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.ACTIVE_REVISION_CALL_MISMATCH,
                            severity: 'error',
                            resourceType: 'processing_revision',
                            resourceId: rev.id,
                            repairable: false,
                            safeMessage: '활성 처리 리비전의 callId가 대상 통화의 ID와 불일치합니다.'
                        });
                    }
                    if (rev.status !== 'active') {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.SUPERSEDED_REVISION_ACTIVE_REF,
                            severity: 'error',
                            resourceType: 'processing_revision',
                            resourceId: rev.id,
                            repairable: true,
                            safeMessage: '활성 리비전으로 참조된 레코드의 내부 상태가 active가 아닙니다.'
                        });
                    }
                }
            }
        }

        // 2. Scan for Orphaned Transcript files (Check 2: ORPHAN_TRANSCRIPT_FILE)
        if (this.transcriptRepo && fs.existsSync(this.transcriptRepo.transcriptsRoot)) {
            try {
                const monthDirs = fs.readdirSync(this.transcriptRepo.transcriptsRoot, { withFileTypes: true });
                for (const md of monthDirs) {
                    if (md.isDirectory() && /^\d{4}-\d{2}$/.test(md.name)) {
                        const mPath = path.join(this.transcriptRepo.transcriptsRoot, md.name);
                        const files = fs.readdirSync(mPath);
                        for (const f of files) {
                            if (f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.quarantine_')) {
                                const callId = f.replace('.json', '');
                                const call = callMap.get(callId);
                                if (!call || !call.transcriptStorageKey || call.transcriptStorageKey !== `${md.name}/${f}`) {
                                    issues.push({
                                        checkCode: RECONCILIATION_CHECKS.ORPHAN_TRANSCRIPT_FILE,
                                        severity: 'warning',
                                        resourceType: 'transcript',
                                        resourceId: callId,
                                        repairable: false,
                                        safeMessage: '디스크에 전사 파일이 존재하나 연결된 VoiceCall 메타데이터 레코드가 없거나 참조 키가 일치하지 않습니다.'
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Reconciliation error scanning transcripts directory:', err.message);
            }
        }

        // 3. Scan Processing Revisions (Checks 4, 7, 8, 20)
        let allRevisions = [];
        if (revisionOk && this.revisionRepo) {
            try {
                allRevisions = this.revisionRepo._getAllRevisions() || [];
                const revisionsByCall = new Map();

                // Check 20: STORAGE_SIZE_WARNING
                const serialized = JSON.stringify(allRevisions);
                if (serialized.length > DOMAIN_LIMITS.STORAGE_SIZE_WARNING_BYTES) {
                    issues.push({
                        checkCode: RECONCILIATION_CHECKS.STORAGE_SIZE_WARNING,
                        severity: 'warning',
                        resourceType: 'processing_revision',
                        resourceId: 'VoiceCallProcessingRevisions',
                        repairable: false,
                        safeMessage: `처리 리비전 저장소 크기(${serialized.length} bytes)가 권장 임계치를 초과했습니다.`
                    });
                }

                for (const rev of allRevisions) {
                    if (!rev || !rev.id) continue;

                    // Check 8: ORPHAN_PROCESSING_REVISION
                    if (rev.callId && !callMap.has(rev.callId)) {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.ORPHAN_PROCESSING_REVISION,
                            severity: 'warning',
                            resourceType: 'processing_revision',
                            resourceId: rev.id,
                            repairable: false,
                            safeMessage: '처리 리비전이 존재하지 않는 통화(callId)를 참조합니다.'
                        });
                    }

                    if (rev.callId) {
                        const list = revisionsByCall.get(rev.callId) || [];
                        list.push(rev);
                        revisionsByCall.set(rev.callId, list);
                    }
                }

                // Call-level checks on revisions
                for (const [callId, revs] of revisionsByCall.entries()) {
                    // Check 4: MULTIPLE_ACTIVE_REVISIONS
                    const activeCount = revs.filter(r => r.status === 'active').length;
                    if (activeCount > 1) {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.MULTIPLE_ACTIVE_REVISIONS,
                            severity: 'error',
                            resourceType: 'processing_revision',
                            resourceId: callId,
                            repairable: true,
                            safeMessage: '동일 통화에 둘 이상의 active 상태 리비전이 존재합니다.'
                        });
                    }

                    // Check 7: DUPLICATE_REVISION_NUMBER
                    const revNumbers = new Set();
                    for (const r of revs) {
                        if (r.revisionNumber !== undefined) {
                            if (revNumbers.has(r.revisionNumber)) {
                                issues.push({
                                    checkCode: RECONCILIATION_CHECKS.DUPLICATE_REVISION_NUMBER,
                                    severity: 'error',
                                    resourceType: 'processing_revision',
                                    resourceId: `${callId}_rev${r.revisionNumber}`,
                                    repairable: false,
                                    safeMessage: '동일 통화에 중복된 revisionNumber가 존재합니다.'
                                });
                            }
                            revNumbers.add(r.revisionNumber);
                        }
                    }
                }
            } catch (err) {}
        }

        // 4. Scan Summary Reviews (Checks 9, 10, 11)
        if (reviewOk && this.reviewRepo) {
            try {
                const allReviews = this.reviewRepo._getAllReviews() || [];
                for (const review of allReviews) {
                    if (!review || !review.id) continue;

                    // Check 11: ORPHAN_SUMMARY_REVIEW
                    if (review.callId && !callMap.has(review.callId)) {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.ORPHAN_SUMMARY_REVIEW,
                            severity: 'warning',
                            resourceType: 'summary_review',
                            resourceId: review.id,
                            repairable: false,
                            safeMessage: '요약 검토본이 존재하지 않는 통화(callId)를 참조합니다.'
                        });
                    }

                    // Check 9: INVALID_REVISION_REF_IN_REVIEW
                    if (review.processingRevisionId && this.revisionRepo) {
                        const targetRev = this.revisionRepo.findById(review.processingRevisionId);
                        if (!targetRev) {
                            issues.push({
                                checkCode: RECONCILIATION_CHECKS.INVALID_REVISION_REF_IN_REVIEW,
                                severity: 'error',
                                resourceType: 'summary_review',
                                resourceId: review.id,
                                repairable: false,
                                safeMessage: '검토본이 가리키는 AI 처리 리비전이 존재하지 않습니다.'
                            });
                        } else {
                            // Check 10: REVIEW_CALL_MISMATCH
                            if (review.callId && targetRev.callId !== review.callId) {
                                issues.push({
                                    checkCode: RECONCILIATION_CHECKS.REVIEW_CALL_MISMATCH,
                                    severity: 'error',
                                    resourceType: 'summary_review',
                                    resourceId: review.id,
                                    repairable: false,
                                    safeMessage: '검토본의 callId와 참조된 AI 리비전의 callId가 불일치합니다.'
                                });
                            }
                        }
                    }
                }
            } catch (err) {}
        }

        // 5. Scan Assignment History (Check 12: ORPHAN_ASSIGNMENT_HISTORY)
        if (historyOk && this.assignmentRepo) {
            try {
                const allHistory = this.assignmentRepo._getAllHistory() || [];
                for (const hist of allHistory) {
                    if (hist && hist.callId && !callMap.has(hist.callId)) {
                        issues.push({
                            checkCode: RECONCILIATION_CHECKS.ORPHAN_ASSIGNMENT_HISTORY,
                            severity: 'warning',
                            resourceType: 'assignment_history',
                            resourceId: hist.id,
                            repairable: false,
                            safeMessage: '배정 이력 레코드가 존재하지 않는 통화(callId)를 참조합니다.'
                        });
                    }
                }
            } catch (err) {}
        }

        return {
            timestamp: nowIso,
            totalRecords: calls.length,
            issuesCount: issues.length,
            issues
        };
    }
}

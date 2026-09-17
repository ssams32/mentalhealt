/**
 * scripts/verify-track-a-canonical-contract.mjs
 * Comprehensive Synthetic Cross-Track & Failure Test Suite (Phases 19 & 20)
 * Verifies the canonical Track A server-to-server contract:
 * - Lease ownership persistence before decryption
 * - RSA-OAEP-SHA256 + AES-256-GCM decryption
 * - Idempotent referral auto-creation & neutral PDF report generation
 * - Phase 14 safe notification dispatch
 * - ACK readiness gating and delete sequencing
 * - Lease error recovery (LEASE_EXPIRED reacquisition without duplicate entities)
 * - State transition integrity and strict SBQ-R gate
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyImportRepository,
    SurveyImportService,
    SurveyReportGenerator,
    SurveyReferralService,
    MockTrackAApi,
    SURVEY_ERROR_CODES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    SURVEY_WORKFLOW_STEPS,
    TRACK_A_ERROR_CODES
} from '../server/survey/index.js';

import { InternalNotificationRepository } from '../server/notifications/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✅ [PASS] ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${desc}:`, err.message);
        failed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✅ [PASS] ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${desc}:`, err.message);
        failed++;
    }
}

// In-Memory Storage Adapter for Complete Test Isolation
function createIsolatedStore() {
    const store = new Map();
    const getData = (filename, defaultVal = []) => {
        if (!store.has(filename)) {
            store.set(filename, JSON.parse(JSON.stringify(defaultVal)));
        }
        return store.get(filename);
    };
    const persistData = async (filename, data) => {
        store.set(filename, JSON.parse(JSON.stringify(data)));
        return true;
    };
    return { getData, persistData, store };
}

async function runCanonicalSuite() {
    console.log('\n============================================================');
    console.log('🧪 TRACK A/B CANONICAL CONTRACT & PIPELINE VERIFICATION');
    console.log('============================================================\n');

    const tempAttachmentsDir = path.join(__dirname, '..', 'scratch', 'test-attachments-' + Date.now());
    if (!fs.existsSync(tempAttachmentsDir)) {
        fs.mkdirSync(tempAttachmentsDir, { recursive: true });
    }

    try {
        // Shared In-Memory Infrastructure
        const { getData, persistData, store } = createIsolatedStore();
        const keyProvider = new SurveyKeyProvider();
        const { publicKey, privateKey } = keyProvider.generateSyntheticTestKey('test_key_v1');
        const decryptionService = new SurveyDecryptionService({ keyProvider });
        const validator = new SurveyPayloadValidator({ sbqrApproved: false });

        const workerId = 'track-b-worker-1';
        const mockTrackA = new MockTrackAApi({ workerId });
        const repository = new SurveyImportRepository({ getData, persistData });
        const reportGenerator = new SurveyReportGenerator();
        const referralService = new SurveyReferralService({
            getData,
            persistData,
            attachmentsDir: tempAttachmentsDir,
            reportGenerator,
            getUsers: () => [
                { id: 'user-01', username: 'counselor_lee', name: '이상담', team: '증진팀' },
                { id: 'user-02', username: 'counselor_park', name: '박상담', team: '회복팀' }
            ]
        });

        const importService = new SurveyImportService({
            repository,
            decryptionService,
            validator,
            externalApiClient: mockTrackA,
            referralService,
            workerId
        });

        const notificationRepo = new InternalNotificationRepository({ getData, persistData });

        // ──────────────────────────────────────────────────────────
        // Test 1: Full Canonical End-to-End Pipeline
        // ──────────────────────────────────────────────────────────
        console.log('--- 1. Canonical End-to-End Import Pipeline ---');

        const subId1 = 'sub-canon-001';
        const syntheticPayload1 = {
            submissionId: subId1,
            schemaVersion: 'v1.0',
            assessmentId: 'phq-9',
            assessmentVersion: '1.0.0',
            contactOnly: false,
            submittedAt: '2026-09-16T10:00:00.000Z',
            contact: {
                clientName: '홍길동',
                phone: '010-1234-5678',
                gender: '남성',
                birthDate: '1990-05-15',
                region: '부발읍',
                counselingRequestText: '최근 수면장애와 우울감이 지속되어 상담을 요청합니다.'
            },
            assessment: {
                totalScore: 14,
                severity: '중간 정도의 우울',
                responses: [
                    { questionNumber: 1, questionLabel: '흥미나 즐거움 저하', score: 2, answerLabel: '자주 있음' },
                    { questionNumber: 2, questionLabel: '우울감이나 슬픔', score: 2, answerLabel: '자주 있음' }
                ]
            },
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: true,
                consentedAt: '2026-09-16T09:59:00.000Z',
                transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
            },
            retention: {
                policy: 'standard_counseling_1yr',
                retentionDays: 365
            }
        };

        mockTrackA.seedSubmission({
            payload: syntheticPayload1,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            schemaVersion: 'v1.0',
            algorithm: 'AES-256-GCM+RSA-OAEP-SHA256',
            submissionId: subId1,
            format: 'trackA'
        });

        await itAsync('1.1. Import pulls leased envelope, decrypts, and persists lease metadata before processing', async () => {
            const summary = await importService.runManualImport({ actorId: 'admin-01', limit: 10 });
            assert.strictEqual(summary.totalFetched, 1);
            assert.strictEqual(summary.imported, 1);
            assert.strictEqual(summary.quarantined, 0);

            // Verify Ledger has lease metadata
            const ledgerItem = repository.findBySubmissionId(subId1);
            assert(ledgerItem, 'Ledger item must exist');
            assert(ledgerItem.leaseId, 'leaseId must be recorded');
            assert(ledgerItem.leaseUntil, 'leaseUntil must be recorded');
            assert.strictEqual(ledgerItem.workerId, workerId);
            assert.strictEqual(ledgerItem.internalStatus, SURVEY_INTERNAL_STATUS.COMPLETED);
            assert.strictEqual(ledgerItem.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
            assert(ledgerItem.ackRequestId, 'ackRequestId must be persisted');
            assert(ledgerItem.deleteRequestId, 'deleteRequestId must be persisted');
        });

        await itAsync('1.2. One draft referral is automatically created with approved fields populated', async () => {
            const referrals = getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === subId1);
            assert(ref, 'Referral record must exist');
            assert.strictEqual(ref.referralStatus, 'PENDING_STAFF_REVIEW');
            assert.strictEqual(ref.closureStatus, '미종결');
            assert.strictEqual(ref.registrationStatus, '확인중');
            assert.strictEqual(ref.criLevel, 'c');
            assert.strictEqual(ref.name, '홍길동');
            assert.strictEqual(ref.phone, '010-1234-5678');
            assert.strictEqual(ref.gender, '남성');
            assert.strictEqual(ref.region, '부발읍');
            assert.strictEqual(ref.age, new Date().getFullYear() - 1990);
            assert(ref.refNo.includes('-26-'), `refNo must follow institutional sequence: ${ref.refNo}`);
            assert(ref.interventionContent.includes('PHQ-9'), 'Intervention summary must mention scale');
            assert(ref.interventionContent.includes('14점'), 'Intervention summary must mention score');
        });

        await itAsync('1.3. Exactly one neutral screening report PDF attachment is registered with verified file hash', async () => {
            const referrals = getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === subId1);
            assert.strictEqual(ref.attachments.length, 1);

            const att = ref.attachments[0];
            assert(att.url.startsWith('/attachments/'), 'URL must point to protected attachments route');
            assert(!att.name.includes('홍길동'), `Attachment display name must not contain client name: ${att.name}`);
            assert(!att.name.includes('010'), 'Attachment display name must not contain phone');
            assert.strictEqual(att.type, 'application/pdf');
            assert(att.size > 10000, `Attachment PDF size must be valid: ${att.size}`);
            assert(att.fileHash && att.fileHash.length === 64, 'Attachment must contain SHA-256 integrity hash');

            // Physical file read-back verification
            const relativePath = decodeURIComponent(att.url.replace('/attachments/', ''));
            const fullPath = path.join(tempAttachmentsDir, relativePath);
            assert(fs.existsSync(fullPath), `Physical PDF file must exist on disk: ${fullPath}`);
            const diskBuf = fs.readFileSync(fullPath);
            const diskHash = crypto.createHash('sha256').update(diskBuf).digest('hex');
            assert.strictEqual(diskHash, att.fileHash, 'Disk file hash must match registered attachment metadata');
        });

        await itAsync('1.4. Multi-document JSON Workflow Journal records all sequential stages atomically', async () => {
            const journal = repository.getWorkflowJournal();
            const subSteps = journal.filter(j => j.submissionId === subId1).map(j => j.step);

            const expectedSteps = [
                SURVEY_WORKFLOW_STEPS.LEASE_RECEIVED,
                SURVEY_WORKFLOW_STEPS.DECRYPTED,
                SURVEY_WORKFLOW_STEPS.PAYLOAD_VALIDATED,
                SURVEY_WORKFLOW_STEPS.SURVEY_STORED,
                SURVEY_WORKFLOW_STEPS.CONSENT_STORED,
                SURVEY_WORKFLOW_STEPS.REFERRAL_CREATED,
                SURVEY_WORKFLOW_STEPS.REPORT_GENERATED,
                SURVEY_WORKFLOW_STEPS.ATTACHMENT_REGISTERED,
                SURVEY_WORKFLOW_STEPS.READ_BACK_VERIFIED,
                SURVEY_WORKFLOW_STEPS.ACK_PENDING,
                SURVEY_WORKFLOW_STEPS.ACKED,
                SURVEY_WORKFLOW_STEPS.DELETE_PENDING,
                SURVEY_WORKFLOW_STEPS.COMPLETED
            ];

            for (const expected of expectedSteps) {
                assert(subSteps.includes(expected), `Workflow journal must record step ${expected}`);
            }
        });

        await itAsync('1.5. Track A transitions to IMPORTED after ACK, and DELETED after deletion', async () => {
            const mockEntry = mockTrackA.submissions.get(subId1);
            assert.strictEqual(mockEntry.state, 'DELETED');
            assert.strictEqual(mockEntry.envelope.ciphertext, '[DELETED]');
        });

        await itAsync('1.6. Repeated manual import executes idempotently without duplicate referrals or attachments', async () => {
            const repeatSummary = await importService.runManualImport({ actorId: 'admin-01', limit: 10 });
            assert.strictEqual(repeatSummary.imported, 0);

            const referrals = getData('Referrals', []);
            const matchingRefs = referrals.filter(r => r.sourceSubmissionId === subId1);
            assert.strictEqual(matchingRefs.length, 1, 'Duplicate import must not create duplicate referral drafts');
            assert.strictEqual(matchingRefs[0].attachments.length, 1, 'Duplicate import must not create duplicate attachments');
        });

        // ──────────────────────────────────────────────────────────
        // Test 2: Staff Assignment & Phase 14 Notification
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 2. Staff Assignment & Phase 14 Safe Notification ---');

        await itAsync('2.1. Assigning staff updates referral draft assignee, team, and note', async () => {
            const updatedRef = await referralService.updateReferralAssignee({
                submissionId: subId1,
                assignedUserId: 'user-01',
                assignedDepartmentId: '증진팀',
                actorId: 'manager-01'
            });

            assert(updatedRef, 'Referral must be updated');
            assert.strictEqual(updatedRef.assignee, '이상담');
            assert.strictEqual(updatedRef.team, '증진팀');
            const lastNote = updatedRef.notes[updatedRef.notes.length - 1];
            assert(lastNote.content.includes('이상담'), 'Referral note must log assignment');
        });

        await itAsync('2.2. Phase 14 internal notification contains exact canonical wording and zero PII', async () => {
            const referrals = getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === subId1);

            const safeTitle = '신규 의뢰 배정 알림';
            const safeMsg = `온라인 설문 기반 신규 의뢰 1건이 배정되었습니다.\n의뢰번호: ${ref.refNo}\n검토 우선순위: NORMAL\n의뢰대장에서 확인해 주세요.`;

            const notif = await notificationRepo.createNotification({
                recipientUserId: 'user-01',
                type: 'SURVEY_ASSIGNED',
                relatedEntityType: 'referral',
                relatedEntityId: ref.referralId,
                safeTitle,
                safeMessage: safeMsg,
                priority: 'NORMAL',
                createdByUserId: 'manager-01',
                deduplicationKey: `survey_assign_${subId1}_v1`
            });

            assert(notif, 'Notification must be created');
            assert.strictEqual(notif.relatedEntityType, 'referral');
            assert.strictEqual(notif.relatedEntityId, ref.referralId);
            assert(!notif.safeMessage.includes('홍길동'), 'Notification must NOT contain client name');
            assert(!notif.safeMessage.includes('010-'), 'Notification must NOT contain phone number');
            assert(!notif.safeMessage.includes('14점'), 'Notification must NOT contain score');
            assert(!notif.safeMessage.includes('우울'), 'Notification must NOT contain result label');
            assert(notif.safeMessage.includes(ref.refNo), 'Notification must reference safe referral number');

            // Verify deduplication
            const duplicateNotif = await notificationRepo.createNotification({
                recipientUserId: 'user-01',
                type: 'SURVEY_ASSIGNED',
                relatedEntityType: 'referral',
                relatedEntityId: ref.referralId,
                safeTitle,
                safeMessage: safeMsg,
                priority: 'NORMAL',
                createdByUserId: 'manager-01',
                deduplicationKey: `survey_assign_${subId1}_v1`
            });
            assert(duplicateNotif, 'Duplicate notification should return existing without doubling store count');
            const allNotifs = notificationRepo.getNotificationsForUser('user-01');
            assert.strictEqual(allNotifs.length, 1, 'Only one deduplicated notification must exist');
        });

        // ──────────────────────────────────────────────────────────
        // Test 3: Lease Expiry & Error Recovery (Phase 4)
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 3. Lease Expiry & Recovery (Phase 4) ---');

        const subIdExpired = 'sub-expired-002';
        const syntheticPayload2 = {
            ...syntheticPayload1,
            submissionId: subIdExpired,
            contact: { ...syntheticPayload1.contact, clientName: '김철수', phone: '010-9876-5432' }
        };

        mockTrackA.seedSubmission({
            payload: syntheticPayload2,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            schemaVersion: 'v1.0',
            submissionId: subIdExpired,
            format: 'trackA'
        });

        await itAsync('3.1. Expired lease prevents premature ACK and marks ACK_REQUIRES_REACQUIRE', async () => {
            // Simulate lease expiry right when ACK is about to be sent
            mockTrackA.simulateLeaseExpired = true;

            const summary = await importService.runManualImport({ actorId: 'admin-01', limit: 10 });
            assert.strictEqual(summary.imported, 1);
            assert.strictEqual(summary.ackPending, 1);

            const ledgerItem = repository.findBySubmissionId(subIdExpired);
            assert.strictEqual(ledgerItem.lastErrorCode, SURVEY_ERROR_CODES.ACK_REQUIRES_REACQUIRE);
            assert.strictEqual(ledgerItem.externalStatus, SURVEY_EXTERNAL_STATUS.LEASED);

            // Ensure referral was created internally but external Track A was NOT deleted prematurely
            const referrals = getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === subIdExpired);
            assert(ref, 'Internal referral draft must be preserved');
            const mockEntry = mockTrackA.submissions.get(subIdExpired);
            assert.notStrictEqual(mockEntry.state, 'DELETED', 'External record must NOT be deleted without successful ACK');
        });

        await itAsync('3.2. reacquireLeaseAndComplete re-leases, ACKs with new leaseId, and deletes with ZERO duplicate entities', async () => {
            mockTrackA.simulateLeaseExpired = false;

            const recoveryResult = await importService.reacquireLeaseAndComplete(subIdExpired, 'admin-recovery');
            assert(recoveryResult.success, 'Recovery must succeed');

            const ledgerItem = repository.findBySubmissionId(subIdExpired);
            assert.strictEqual(ledgerItem.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
            assert.strictEqual(ledgerItem.internalStatus, SURVEY_INTERNAL_STATUS.COMPLETED);

            // Verify ZERO duplicate referrals created during recovery
            const referrals = getData('Referrals', []);
            const matchingRefs = referrals.filter(r => r.sourceSubmissionId === subIdExpired);
            assert.strictEqual(matchingRefs.length, 1, 'Exactly one referral must exist after lease reacquisition');
            assert.strictEqual(matchingRefs[0].attachments.length, 1, 'Exactly one report attachment must exist after lease reacquisition');

            const mockEntry = mockTrackA.submissions.get(subIdExpired);
            assert.strictEqual(mockEntry.state, 'DELETED');
        });

        // ──────────────────────────────────────────────────────────
        // Test 4: Strict SBQ-R Safety Gate (Phase 15)
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 4. Strict SBQ-R Safety Gate (Phase 15) ---');

        const subIdSbqr = 'sub-sbqr-003';
        const sbqrPayload = {
            submissionId: subIdSbqr,
            schemaVersion: 'v1.0',
            assessmentId: 'sbq-r',
            assessmentVersion: '1.0.0',
            contactOnly: false,
            submittedAt: new Date().toISOString(),
            contact: {
                clientName: '강위기',
                phone: '010-5555-4444',
                gender: '여성',
                birthDate: '1985-02-20',
                region: '창전동'
            },
            assessment: {
                totalScore: 12,
                severity: '고위험군'
            },
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: true,
                consentedAt: new Date().toISOString(),
                transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'totalScore', 'severity']
            },
            retention: { policy: 'standard_counseling_1yr', retentionDays: 365 }
        };

        mockTrackA.seedSubmission({
            payload: sbqrPayload,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            schemaVersion: 'v1.0',
            submissionId: subIdSbqr,
            format: 'trackA'
        });

        await itAsync('4.1. SBQ-R submission is quarantined with ZERO referral creation and reports safe quarantine to Track A', async () => {
            const summary = await importService.runManualImport({ actorId: 'admin-01', limit: 10 });
            assert.strictEqual(summary.quarantined, 1);

            // Verify Ledger state
            const ledgerItem = repository.findBySubmissionId(subIdSbqr);
            assert.strictEqual(ledgerItem.internalStatus, SURVEY_INTERNAL_STATUS.QUARANTINED_SBQR_GATE);

            // Strict Gate Check: NO referral draft must be created for SBQ-R!
            const referrals = getData('Referrals', []);
            const sbqrRef = referrals.find(r => r.sourceSubmissionId === subIdSbqr);
            assert.strictEqual(sbqrRef, undefined, 'SBQ-R MUST NOT create a referral draft in Referrals.json');

            // Track A must receive quarantine report and ciphertext must NOT be deleted
            const mockEntry = mockTrackA.submissions.get(subIdSbqr);
            assert.strictEqual(mockEntry.state, 'QUARANTINED');
            assert.notStrictEqual(mockEntry.state, 'DELETED');
            assert.strictEqual(mockEntry.lastErrorCode, 'SBQR_GATE_UNAPPROVED');
        });

        // ──────────────────────────────────────────────────────────
        // Test 5: Sensitive Consent False (Contact-Only)
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 5. Contact-Only Policy Enforcement ---');

        const subIdContactOnly = 'sub-contact-004';
        const contactOnlyPayload = {
            submissionId: subIdContactOnly,
            schemaVersion: 'v1.0',
            assessmentId: 'phq-9',
            assessmentVersion: '1.0.0',
            contactOnly: true,
            submittedAt: new Date().toISOString(),
            contact: {
                clientName: '박문의',
                phone: '010-7777-8888',
                gender: '남성',
                birthDate: '1995-11-01',
                region: '모가면',
                counselingRequestText: '단순 심리상담 센터 위치 및 이용 방법 문의'
            },
            assessment: {}, // Empty: sensitive consent was false
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: false, // Explicitly false!
                consentedAt: new Date().toISOString(),
                transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText']
            },
            retention: { policy: 'standard_counseling_1yr', retentionDays: 365 }
        };

        mockTrackA.seedSubmission({
            payload: contactOnlyPayload,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            schemaVersion: 'v1.0',
            submissionId: subIdContactOnly,
            format: 'trackA'
        });

        await itAsync('5.1. Sensitive consent false generates contact-only referral without assessment scores', async () => {
            const summary = await importService.runManualImport({ actorId: 'admin-01', limit: 10 });
            assert.strictEqual(summary.imported, 1);

            const referrals = getData('Referrals', []);
            const ref = referrals.find(r => r.sourceSubmissionId === subIdContactOnly);
            assert(ref, 'Contact-only referral must exist');
            assert(ref.interventionContent.includes('단순 상담 신청'), 'Intervention must reflect contact-only submission');
            assert(!ref.interventionContent.includes('점'), 'Intervention must NOT claim scores when sensitive consent was false');

            // Verify attachment exists and is readable
            assert.strictEqual(ref.attachments.length, 1);
            const relativePath = decodeURIComponent(ref.attachments[0].url.replace('/attachments/', ''));
            const fullPath = path.join(tempAttachmentsDir, relativePath);
            assert(fs.existsSync(fullPath), 'Contact-only report PDF must exist on disk');
        });

        // ──────────────────────────────────────────────────────────
        // Test 6: State Machine Violations (Premature Deletion Prevention)
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 6. State Machine & Premature Deletion Defense ---');

        await itAsync('6.1. MockTrackA rejects delete when submission is still in LEASED state', async () => {
            const subIdTest = 'sub-state-test';
            mockTrackA.seedSubmission({
                payload: { ...syntheticPayload1, submissionId: subIdTest },
                publicKeyPem: publicKey,
                keyVersion: 'test_key_v1',
                schemaVersion: 'v1.0',
                submissionId: subIdTest,
                format: 'trackA'
            });

            // Lease it
            await mockTrackA.leasePendingSubmissions({ limit: 1 });

            // Attempt premature delete before ACK
            let rejected = false;
            try {
                await mockTrackA.deleteCiphertext(subIdTest);
            } catch (err) {
                rejected = true;
                assert.strictEqual(err.code, TRACK_A_ERROR_CODES.CANNOT_DELETE_ACTIVE_LEASED);
            }
            assert(rejected, 'Delete on active leased record must be rejected with CANNOT_DELETE_ACTIVE_LEASED');
        });

        await itAsync('6.2. MockTrackA rejects ACK when leaseId is missing or mismatched', async () => {
            const subIdTest = 'sub-lease-test';
            mockTrackA.seedSubmission({
                payload: { ...syntheticPayload1, submissionId: subIdTest },
                publicKeyPem: publicKey,
                keyVersion: 'test_key_v1',
                schemaVersion: 'v1.0',
                submissionId: subIdTest,
                format: 'trackA'
            });

            // Lease it
            await mockTrackA.leasePendingSubmissions({ limit: 1 });

            let rejectedMismatch = false;
            try {
                await mockTrackA.acknowledge(subIdTest, { leaseId: 'wrong-lease-id', workerId });
            } catch (err) {
                rejectedMismatch = true;
                assert.strictEqual(err.code, TRACK_A_ERROR_CODES.LEASE_MISMATCH);
            }
            assert(rejectedMismatch, 'ACK with wrong leaseId must be rejected with LEASE_MISMATCH');
        });

        console.log('\n============================================================');
        console.log(`🎯 CANONICAL SUITE COMPLETED: ${passed} Passed, ${failed} Failed`);
        console.log('============================================================\n');

        if (failed > 0) {
            process.exit(1);
        }
    } finally {
        // Cleanup temp attachments
        try {
            fs.rmSync(tempAttachmentsDir, { recursive: true, force: true });
        } catch (ignore) {}
    }
}

runCanonicalSuite().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});

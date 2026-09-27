/**
 * scripts/verify-survey-drain-and-auto-sync.mjs
 * Dedicated verification suite for Phase 3 (Import All Pending Surveys Safely)
 * and Phase 4 (Automatic Server-Side Survey Synchronization).
 *
 * Strict Safety:
 * - Uses in-memory repositories and mock Track A clients only.
 * - Zero production data access or mutation.
 * - Zero real Track A network requests.
 */

import assert from 'assert';
import crypto from 'crypto';
import {
    SurveyImportService,
    SurveyImportRepository,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyKeyProvider,
    SurveyAutoImportScheduler,
    SURVEY_INTERNAL_STATUS,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_ERROR_CODES
} from '../server/survey/index.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function testCase(name, fn) {
    totalTests++;
    process.stdout.write(`  ⏳ ${name}... `);
    try {
        await fn();
        passedTests++;
        console.log('✅ PASS');
    } catch (err) {
        failedTests++;
        console.log(`❌ FAIL: [${name}]\n    -> ${err.message}`);
    }
}

// In-Memory Survey Repository for Isolated Testing
class InMemorySurveyRepository {
    constructor() {
        this.records = new Map();
        this.submissions = [];
        this.workflowSteps = [];
        this.auditEvents = [];
    }
    findBySubmissionId(subId) {
        return this.records.get(subId) || null;
    }
    findSubmissionById(id) {
        return this.submissions.find(s => s.submissionId === id || s.internalSurveyId === id) || null;
    }
    getSurveySubmissions() {
        return this.submissions;
    }
    async saveSurveySubmissions(subs) {
        this.submissions = subs;
    }
    async createOrUpdateImportRecord(record) {
        const existing = this.records.get(record.submissionId) || {};
        const updated = { ...existing, ...record };
        this.records.set(record.submissionId, updated);
        return updated;
    }
    async recordWorkflowStep(step) {
        this.workflowSteps.push(step);
    }
    async recordAuditEvent(event) {
        this.auditEvents.push(event);
    }
    async persistSurveyIntake({ envelope, payload, isSbqrQuarantined, quarantineReason, actorId, batchId }) {
        const internalSurveyId = `surv_${crypto.randomUUID().substring(0, 8)}`;
        const sub = {
            internalSurveyId,
            submissionId: envelope.submissionId,
            contact: payload.contact,
            submittedAt: payload.submittedAt || new Date().toISOString(),
            isSbqrQuarantined,
            quarantineReason,
            consultationStatus: '신규접수대기',
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned'
        };
        this.submissions.push(sub);
        return { internalSurveyId };
    }
}

// Mock Track A Client with Configurable Queues and Error Injections
class MockTrackAQueueClient {
    constructor(queue = []) {
        this.queue = [...queue];
        this.acked = new Set();
        this.deleted = new Set();
        this.failPdf = false;
        this.failAck = false;
        this.failDelete = false;
        this.callCounts = {
            checkGate: 0,
            lease: 0,
            ack: 0,
            delete: 0
        };
    }
    async checkSubmissionGateStatus() {
        this.callCounts.checkGate++;
        return { enabled: true };
    }
    async leasePendingSubmissions({ limit = 10, leaseSeconds = 300 } = {}) {
        this.callCounts.lease++;
        const batch = this.queue.splice(0, limit);
        return {
            success: true,
            count: batch.length,
            submissions: batch
        };
    }
    async acknowledgeSubmission(subId, { leaseId, requestId }) {
        this.callCounts.ack++;
        if (this.failAck) {
            throw new Error('MOCK_ACK_FAILED');
        }
        this.acked.add(subId);
        return { success: true, acknowledged: true };
    }
    async deleteImportedSubmission(subId, { leaseId, requestId }) {
        this.callCounts.delete++;
        if (this.failDelete) {
            throw new Error('MOCK_DELETE_FAILED');
        }
        if (!this.acked.has(subId)) {
            throw new Error('DELETE_BEFORE_ACK_VIOLATION');
        }
        this.deleted.add(subId);
        return { success: true, deleted: true };
    }
}

// Synthetic envelope generator
function createMockEnvelope(subId, isConsultation = true) {
    return {
        submissionId: subId,
        schemaVersion: 'v1.0',
        keyVersion: 'k2026_01',
        requestType: isConsultation ? 'CONSULTATION_REQUEST' : 'SCREENING_ONLY',
        consultationRequested: isConsultation,
        consultationRequestedAt: isConsultation ? '2026-09-25T15:30:00.000Z' : undefined,
        lease: {
            leaseId: `lease_${subId}`,
            leasedAt: new Date().toISOString(),
            leaseUntil: new Date(Date.now() + 600000).toISOString()
        }
    };
}

// Mock Decryption Service
class MockDecryptionService {
    constructor() {
        this.failSubIds = new Set();
    }
    decryptEnvelope(env) {
        if (this.failSubIds.has(env.submissionId)) {
            const err = new Error('TAMPERED_CIPHERTEXT');
            err.code = SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED;
            throw err;
        }
        const isConsultation = (env.requestType || 'CONSULTATION_REQUEST') === 'CONSULTATION_REQUEST';
        return {
            submissionId: env.submissionId,
            schemaVersion: '1.0.0',
            assessmentId: 'phq-9',
            requestType: isConsultation ? 'CONSULTATION_REQUEST' : 'SCREENING_ONLY',
            consultationRequested: isConsultation,
            consultationRequestedAt: isConsultation ? '2026-09-25T15:30:00.000Z' : undefined,
            submittedAt: '2026-09-25T15:30:00.000Z',
            contact: {
                clientName: '홍길동',
                phone: '010-1234-5678',
                gender: '남성',
                birthDate: '1990-05-15',
                region: '이천시'
            },
            consentEvidence: {
                personalInfoConsent: true,
                sensitiveInfoConsent: true
            },
            assessment: {
                answers: [1, 2, 1, 0, 0, 1, 2, 1, 0],
                totalScore: 8,
                severity: 'mild'
            }
        };
    }
}

// Mock Referral & Report Service
class MockReferralService {
    constructor() {
        this.failPdfSubIds = new Set();
    }
    async generateScreeningReportOnly({ payload, internalSurveyId, submissionId, actorId }) {
        if (this.failPdfSubIds.has(submissionId)) {
            throw new Error('PDF_GENERATION_FAILED');
        }
        return {
            attachment: {
                id: `att_${submissionId}`,
                name: '온라인 마음건강 검진 결과보고서.pdf',
                size: 1024
            }
        };
    }
    async generateScreeningOnlyReport(opts) {
        return this.generateScreeningReportOnly(opts);
    }
}

async function run() {
    console.log('====================================================');
    console.log('🧪 Track B Phase 3 & Phase 4 Drain Loop & Auto-Sync Verification');
    console.log('====================================================\n');

    const validator = new SurveyPayloadValidator();
    const decrypter = new MockDecryptionService();

    // -------------------------------------------------------------
    // SECTION 1: Phase 3 Drain Loop Tests
    // -------------------------------------------------------------
    console.log('--- 1. Phase 3 Safe Bounded Drain Loop Tests ---');

    await testCase('1.1 Empty queue: drains immediately with stopReason=QUEUE_DRAINED and 0 imported', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([]);
        const refService = new MockReferralService();
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: refService
        });

        const summary = await service.runManualImport({ actorId: 'admin_test', batchSize: 10 });
        assert.strictEqual(summary.discovered, 0);
        assert.strictEqual(summary.imported, 0);
        assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED');
        assert.strictEqual(service.isImportRunning, false);
    });

    await testCase('1.2 Single item: full atomic pipeline (persisted, report, ACKed, deleted)', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([createMockEnvelope('sub-single-001')]);
        const refService = new MockReferralService();
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: refService
        });

        const summary = await service.runManualImport({ actorId: 'admin_test', batchSize: 10 });
        assert.strictEqual(summary.discovered, 1);
        assert.strictEqual(summary.imported, 1);
        assert.strictEqual(summary.acknowledged, 1);
        assert.strictEqual(summary.deleted, 1);
        assert.strictEqual(client.acked.has('sub-single-001'), true);
        assert.strictEqual(client.deleted.has('sub-single-001'), true);
        assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED');
    });

    await testCase('1.3 Multi-batch drain: 25 items drained across batches (batchSize: 10 -> 3 batches)', async () => {
        const repo = new InMemorySurveyRepository();
        const queue = Array.from({ length: 25 }, (_, i) => createMockEnvelope(`sub-batch-${i + 1}`));
        const client = new MockTrackAQueueClient(queue);
        const refService = new MockReferralService();
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: refService
        });

        const summary = await service.runManualImport({
            actorId: 'admin_test',
            batchSize: 10,
            maxItems: 200,
            delayBetweenBatchesMs: 5
        });

        assert.strictEqual(summary.discovered, 25);
        assert.strictEqual(summary.imported, 25);
        assert.strictEqual(summary.acknowledged, 25);
        assert.strictEqual(summary.deleted, 25);
        assert.strictEqual(summary.requestedBatches, 3);
        assert.strictEqual(client.queue.length, 0);
        assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED');
    });

    await testCase('1.4 PDF Generation Gate: Failure stops ACK and Delete for that item', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([
            createMockEnvelope('sub-pdf-fail-001'),
            createMockEnvelope('sub-pdf-ok-002')
        ]);
        const refService = new MockReferralService();
        refService.failPdfSubIds.add('sub-pdf-fail-001');

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: refService
        });

        const summary = await service.runManualImport({ actorId: 'admin_test', batchSize: 10 });
        assert.strictEqual(summary.imported, 1);
        assert.strictEqual(summary.failed, 1);
        assert.strictEqual(client.acked.has('sub-pdf-fail-001'), false, 'Failed PDF item must NOT be ACKed');
        assert.strictEqual(client.deleted.has('sub-pdf-fail-001'), false, 'Failed PDF item must NOT be Deleted');
        assert.strictEqual(client.acked.has('sub-pdf-ok-002'), true, 'Successful item must be ACKed');
        assert.strictEqual(client.deleted.has('sub-pdf-ok-002'), true, 'Successful item must be Deleted');
    });

    await testCase('1.5 ACK Failure Gate: Prevents deletion and tracks ackPending', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([createMockEnvelope('sub-ack-fail-001')]);
        client.failAck = true;
        const refService = new MockReferralService();

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: refService
        });

        const summary = await service.runManualImport({ actorId: 'admin_test', batchSize: 10 });
        assert.strictEqual(summary.ackPending, 1);
        assert.strictEqual(summary.deleted, 0);
        assert.strictEqual(client.deleted.has('sub-ack-fail-001'), false, 'Must NOT delete if ACK fails');
    });

    await testCase('1.6 Infinite loop guard: repeated failed submission breaks loop with FAILED_ITEM_LOOP_PREVENTED', async () => {
        const repo = new InMemorySurveyRepository();
        // Client returns the exact same failed item repeatedly
        const client = {
            async checkSubmissionGateStatus() { return { enabled: true }; },
            async leasePendingSubmissions({ limit = 5 } = {}) {
                return {
                    success: true,
                    count: limit,
                    submissions: Array.from({ length: limit }, () => createMockEnvelope('sub-stuck-001'))
                };
            }
        };
        const failingDecrypter = new MockDecryptionService();
        failingDecrypter.failSubIds.add('sub-stuck-001');

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: failingDecrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        const summary = await service.runManualImport({ actorId: 'admin_test', batchSize: 1 });
        assert.strictEqual(summary.failed, 1);
        assert.strictEqual(summary.stopReason, 'FAILED_ITEM_LOOP_PREVENTED');
    });

    await testCase('1.7 Concurrency guard: second concurrent import is rejected with IMPORT_ALREADY_IN_PROGRESS', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([createMockEnvelope('sub-slow-001')]);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        // Artificially hold lock
        service._acquireLock();
        assert.strictEqual(service.isImportRunning, true);

        let rejected = false;
        try {
            await service.runManualImport({ actorId: 'admin_concurrent' });
        } catch (err) {
            rejected = true;
            assert.strictEqual(err.code, SURVEY_ERROR_CODES.IMPORT_ALREADY_IN_PROGRESS);
        }
        assert.strictEqual(rejected, true, 'Concurrent run must be rejected');
        service._releaseLock();
        assert.strictEqual(service.isImportRunning, false);
    });

    await testCase('1.8 Max items limit: ceases fetching once maxItems count is reached', async () => {
        const repo = new InMemorySurveyRepository();
        const queue = Array.from({ length: 30 }, (_, i) => createMockEnvelope(`sub-limit-${i + 1}`));
        const client = new MockTrackAQueueClient(queue);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        const summary = await service.runManualImport({
            actorId: 'admin_test',
            batchSize: 5,
            maxItems: 12,
            delayBetweenBatchesMs: 1
        });

        assert.strictEqual(summary.imported, 12);
        assert.strictEqual(summary.stopReason, 'MAX_ITEMS_EXCEEDED');
    });

    // -------------------------------------------------------------
    // SECTION 2: Phase 4 Autonomous Scheduler Tests
    // -------------------------------------------------------------
    console.log('\n--- 2. Phase 4 Server-Side Auto-Sync Scheduler Tests ---');

    await testCase('2.1 AUTO_IMPORT_ENV_MISSING -> enabled=false, Track A calls=0, lease=0, ack=0, delete=0', async () => {
        const savedEnv = process.env.SURVEY_AUTO_IMPORT_ENABLED;
        delete process.env.SURVEY_AUTO_IMPORT_ENABLED;
        try {
            const repo = new InMemorySurveyRepository();
            const client = new MockTrackAQueueClient([createMockEnvelope('sub-auto-env-001')]);
            const service = new SurveyImportService({
                repository: repo,
                decryptionService: decrypter,
                validator,
                externalApiClient: client,
                referralService: new MockReferralService()
            });

            const scheduler = new SurveyAutoImportScheduler({
                surveyImportService: service,
                repository: repo,
                externalApiClient: client
            });

            assert.strictEqual(scheduler.enabled, false, 'Auto-import must default to disabled when env is missing');
            scheduler.start();
            assert.strictEqual(scheduler.enabled, false);
            assert.strictEqual(scheduler._timer, null, 'Disabled mode must not register active timer');
            assert.strictEqual(scheduler.getStatus().autoSyncEnabled, false);
            assert.strictEqual(client.callCounts.checkGate, 0, 'Must make 0 Track A calls when disabled');
            assert.strictEqual(client.callCounts.lease, 0, 'Must make 0 lease calls when disabled');
            assert.strictEqual(client.callCounts.ack, 0, 'Must make 0 ACK calls when disabled');
            assert.strictEqual(client.callCounts.delete, 0, 'Must make 0 delete calls when disabled');
            scheduler.stop();
        } finally {
            if (savedEnv !== undefined) process.env.SURVEY_AUTO_IMPORT_ENABLED = savedEnv;
        }
    });

    await testCase('2.2 Explicitly enabled scheduler sets nextScheduledAt with initial delay and does not run immediately at startup', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([]);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        const scheduler = new SurveyAutoImportScheduler({
            surveyImportService: service,
            enabled: true,
            initialDelaySeconds: 60,
            intervalMinutes: 5,
            batchSize: 10,
            maxItems: 100
        });

        scheduler.start();
        const status = scheduler.getStatus();
        assert.strictEqual(status.autoSyncEnabled, true);
        assert.strictEqual(status.isRunning, false);
        assert.ok(status.nextScheduledAt !== null, 'nextScheduledAt must be set');
        assert.strictEqual(scheduler.lastSyncAt, null, 'Must NOT run immediately at startup');
        scheduler.stop();
    });

    await testCase('2.3 EXISTING_INCOMPLETE_SUBMISSION_DUPLICATION_BLOCKED: existing stored submission is never re-persisted or duplicated', async () => {
        const repo = new InMemorySurveyRepository();
        let persistCallCount = 0;
        const origPersist = repo.persistSurveyIntake.bind(repo);
        repo.persistSurveyIntake = async (args) => {
            persistCallCount++;
            return origPersist(args);
        };

        const client = new MockTrackAQueueClient([
            createMockEnvelope('sub-dup-existing-001'),
            createMockEnvelope('sub-dup-existing-001')
        ]);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        // 1st run: processes and persists record
        const run1 = await service.runManualImport({ actorId: 'admin_test', batchSize: 5 });
        assert.strictEqual(run1.imported, 1);
        assert.strictEqual(persistCallCount, 1);
        const internalId1 = repo.getSurveySubmissions()[0].internalSurveyId;

        // 2nd run with same submissionId in queue
        client.queue.push(createMockEnvelope('sub-dup-existing-001'));
        const run2 = await service.runManualImport({ actorId: 'admin_test', batchSize: 5 });
        assert.strictEqual(run2.reused, 1);
        assert.strictEqual(persistCallCount, 1, 'persistSurveyIntake must NOT be called again');
        assert.strictEqual(repo.getSurveySubmissions().length, 1, 'Must NOT create duplicate SurveySubmission');
        assert.strictEqual(repo.getSurveySubmissions()[0].internalSurveyId, internalId1, 'Must NOT create second internalSurveyId');
    });

    await testCase('2.4 Overlapping cycle blocked: Scheduler skips execution if service is already running', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([]);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        const scheduler = new SurveyAutoImportScheduler({
            surveyImportService: service,
            enabled: true,
            initialDelaySeconds: 1,
            intervalMinutes: 1
        });

        // Manually hold lock to simulate running manual import
        service._acquireLock();
        await scheduler._runCycle();

        assert.strictEqual(scheduler.isRunning, false);
        assert.strictEqual(scheduler.lastSyncAt, null, 'Must have skipped cycle');
        const auditEvent = repo.auditEvents.find(e => e.action === 'SURVEY_IMPORT_SKIPPED_ALREADY_RUNNING');
        assert.ok(auditEvent, 'Must record SURVEY_IMPORT_SKIPPED_ALREADY_RUNNING audit event');

        service._releaseLock();
        scheduler.stop();
    });

    await testCase('2.5 Autonomous cycle execution: successfully processes queue via runAutoImportCycle', async () => {
        const repo = new InMemorySurveyRepository();
        const client = new MockTrackAQueueClient([createMockEnvelope('sub-auto-001')]);
        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: client,
            referralService: new MockReferralService()
        });

        const scheduler = new SurveyAutoImportScheduler({
            surveyImportService: service,
            enabled: true,
            initialDelaySeconds: 1,
            intervalMinutes: 5
        });

        await scheduler._runCycle();
        const status = scheduler.getStatus();
        assert.strictEqual(status.lastImportedCount, 1);
        assert.strictEqual(status.lastResult, 'SUCCESS');
        assert.strictEqual(client.acked.has('sub-auto-001'), true);
        assert.strictEqual(client.deleted.has('sub-auto-001'), true);
        scheduler.stop();
    });

    await testCase('2.6 Failure resilience: Upstream error does not crash scheduler, re-schedules next cycle', async () => {
        const repo = new InMemorySurveyRepository();
        const failingClient = {
            async checkSubmissionGateStatus() { return { enabled: true }; },
            async leasePendingSubmissions() {
                throw new Error('TRACK_A_OFFLINE');
            }
        };

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: decrypter,
            validator,
            externalApiClient: failingClient,
            referralService: new MockReferralService()
        });

        const scheduler = new SurveyAutoImportScheduler({
            surveyImportService: service,
            enabled: true,
            initialDelaySeconds: 1,
            intervalMinutes: 5
        });

        // Should not throw or crash
        await scheduler._runCycle();
        const status = scheduler.getStatus();
        assert.strictEqual(status.lastResult, 'ERROR');
        assert.ok(status.nextScheduledAt !== null, 'Next cycle must be scheduled despite error');
        scheduler.stop();
    });

    console.log('\n====================================================');
    console.log(`📊 Summary: ${passedTests} Passed, ${failedTests} Failed (Total: ${totalTests})`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

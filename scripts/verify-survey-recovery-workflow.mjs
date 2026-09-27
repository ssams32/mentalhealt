/**
 * scripts/verify-survey-recovery-workflow.mjs
 * Comprehensive Synthetic Verification Suite for Track B Stored Survey Recovery Implementation.
 *
 * Verifies all 10 mandatory criteria (A through J):
 *  A. Existing PDF Normal: Valid attachment verified, reused without regeneration, dryRun safe, 0 new internal records
 *  B. Missing PDF: Attachment missing, PDF generated exactly once in execution mode, bound to existing submission, 0 duplicate records
 *  C. Corrupted PDF: Magic bytes or hash mismatch blocks recovery, RECOVERY_ATTACHMENT_INVALID, 0 ACK, 0 Delete
 *  D. Duplicate Internal Records: >1 matching SurveySubmissions blocks recovery, 0 modifications
 *  E. Lease Target Mismatch: Target submission not available in pending lease -> DETERMINISTIC_REACQUIRE_NOT_AVAILABLE, 0 ACK/delete
 *  F. ACK Failure: ACK failure halts workflow, 0 delete calls, PDF and internal record preserved
 *  G. Delete Failure: Delete failure leaves ledger ACKNOWLEDGED, delete retryable, 0 duplicate ACK
 *  H. Re-invocation: Completed record returns ALREADY_COMPLETED, 0 PDF regen, 0 ACK/delete
 *  I. Permissions & Guards: Regular user 403, inactive admin 403, missing permission 403, admin allowed
 *  J. Dry-Run Isolation: dryRun has zero file writes, zero JSON writes, zero Track A network calls
 */

import express from 'express';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
    ONLINE_SURVEY_ACCESS,
    hasOnlineSurveyAccess
} from '../server/permissions/voiceCapabilities.js';
import { createSurveyImportRouter } from '../server/survey/surveyImportRouter.js';
import { SurveyImportService } from '../server/survey/surveyImportService.js';
import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import {
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    SURVEY_STORAGE_FILES
} from '../server/survey/surveyConstants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TEST_ATTACHMENTS_DIR = path.join(ROOT_DIR, 'scratch', 'test-recovery-attachments');
if (!fs.existsSync(TEST_ATTACHMENTS_DIR)) {
    fs.mkdirSync(TEST_ATTACHMENTS_DIR, { recursive: true });
}

let passed = 0;
let failed = 0;

async function testCase(name, fn) {
    process.stdout.write(`  ⏳ ${name}... `);
    try {
        await fn();
        console.log('✅ PASS');
        passed++;
    } catch (err) {
        console.log(`❌ FAIL: ${err.message}`);
        console.error(err);
        failed++;
    }
}

// In-Memory Storage Mock Factory
function createMockStore() {
    const store = {
        ExternalSubmissionImports: [],
        SurveySubmissions: [],
        SurveyConsentEvidence: [],
        PendingReferrals: [],
        SurveyWorkflowJournal: [],
        SurveyImportAudit: [],
        Users: []
    };

    return {
        getData: (key, def = []) => JSON.parse(JSON.stringify(store[key] || def)),
        persistData: (key, val) => {
            store[key] = JSON.parse(JSON.stringify(val));
            return Promise.resolve(true);
        },
        rawStore: store
    };
}

// Minimal Synthetic PDF Generator for Test
function createSyntheticPdfBuffer() {
    return Buffer.from('%PDF-1.4\n%synthetic-pdf-test-content\n%%EOF');
}

console.log('====================================================');
console.log('🧪 Starting Track B Stored Survey Recovery Test Suite');
console.log('====================================================\n');

async function runAllTests() {
    // --- Test A: Existing PDF Normal ---
    await testCase('A. Existing PDF Normal: Reused without regeneration, 0 new internal records', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-a';
        const testInternalId = 'surv_test_a_uuid';
        const testAttId = 'screening_report_test_a.pdf';

        // Prepare physical valid PDF
        const targetFolder = path.join(TEST_ATTACHMENTS_DIR, testInternalId);
        fs.mkdirSync(targetFolder, { recursive: true });
        const pdfBuf = createSyntheticPdfBuffer();
        const pdfHash = crypto.createHash('sha256').update(pdfBuf).digest('hex');
        const pdfFilePath = path.join(targetFolder, testAttId);
        fs.writeFileSync(pdfFilePath, pdfBuf);

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            attachmentId: testAttId,
            attachment: {
                id: testAttId,
                name: '온라인 마음건강 검진 결과보고서',
                size: pdfBuf.length,
                fileHash: pdfHash
            }
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
            leaseId: 'lease_test_a',
            leaseUntil: new Date(Date.now() + 600000).toISOString()
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            consentVersion: 'v1.0'
        }];

        let pdfGenCalls = 0;
        const mockReferralService = {
            attachmentsDir: TEST_ATTACHMENTS_DIR,
            generateScreeningReportOnly: async () => {
                pdfGenCalls++;
                return { attachment: { id: 'new.pdf' } };
            }
        };

        let leaseCalls = 0;
        let ackCalls = 0;
        let deleteCalls = 0;
        const mockExternalClient = {
            leasePendingSubmissions: async () => { leaseCalls++; return { submissions: [] }; },
            leaseSubmissionById: async () => { leaseCalls++; return { submissions: [] }; },
            acknowledgeSubmission: async () => { ackCalls++; return { success: true }; },
            deleteImportedSubmission: async () => { deleteCalls++; return { success: true }; }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient,
            referralService: mockReferralService
        });

        // 1. Dry run test
        const dryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: true
        });

        assert.strictEqual(dryRes.safeToExecute, true);
        assert.strictEqual(dryRes.attachmentState, 'VALID_EXISTING');
        assert.ok(dryRes.plannedActions.includes('REUSE_EXISTING_LEASE'));
        assert.ok(dryRes.plannedActions.includes('REUSE_EXISTING_PDF'));
        assert.strictEqual(leaseCalls, 0, 'Valid existing lease must not trigger any lease calls in dry-run');
        assert.strictEqual(pdfGenCalls, 0, 'PDF generation must not be called in dry-run');
        assert.strictEqual(ackCalls, 0);
        assert.strictEqual(deleteCalls, 0);

        // 2. Real execution test
        const execRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: false,
            confirm: 'RECOVER_STORED_SUBMISSION'
        });

        assert.strictEqual(execRes.success, true);
        assert.strictEqual(execRes.attachmentState, 'VALID_EXISTING');
        assert.ok(execRes.executedActions.includes('REUSE_EXISTING_LEASE'));
        assert.ok(execRes.executedActions.includes('REUSE_EXISTING_PDF'));
        assert.strictEqual(leaseCalls, 0, 'Valid existing lease must not trigger any lease calls in execution');
        assert.strictEqual(pdfGenCalls, 0, 'Existing valid PDF must be reused without regeneration');
        assert.strictEqual(ackCalls, 1);
        assert.strictEqual(deleteCalls, 1);

        // Verify zero new internal records
        const freshSubs = repo.getSurveySubmissions();
        assert.strictEqual(freshSubs.length, 1);
        assert.strictEqual(freshSubs[0].internalSurveyId, testInternalId);
    });

    // --- Test B: Missing PDF ---
    await testCase('B. Missing PDF: Generated exactly once in execution mode, bound to existing record', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-b';
        const testInternalId = 'surv_test_b_uuid';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            assessmentId: 'phq-9',
            assessment: { totalScore: 12 },
            contact: { clientName: '홍길동' },
            attachmentId: null,
            attachment: null
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
            leaseId: 'lease_test_b',
            leaseUntil: new Date(Date.now() + 600000).toISOString()
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            consentVersion: 'v1.0'
        }];

        let pdfGenCalls = 0;
        const mockReferralService = {
            attachmentsDir: TEST_ATTACHMENTS_DIR,
            generateScreeningReportOnly: async ({ internalSurveyId, submissionId }) => {
                pdfGenCalls++;
                const newAttId = 'gen_report_test_b.pdf';
                const folder = path.join(TEST_ATTACHMENTS_DIR, internalSurveyId);
                fs.mkdirSync(folder, { recursive: true });
                const buf = createSyntheticPdfBuffer();
                fs.writeFileSync(path.join(folder, newAttId), buf);
                return {
                    attachment: {
                        id: newAttId,
                        name: '온라인 마음건강 검진 결과보고서',
                        size: buf.length,
                        fileHash: crypto.createHash('sha256').update(buf).digest('hex')
                    }
                };
            }
        };

        const mockExternalClient = {
            acknowledgeSubmission: async () => ({ success: true }),
            deleteImportedSubmission: async () => ({ success: true })
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient,
            referralService: mockReferralService
        });

        // 1. Dry run
        const dryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: true
        });

        assert.strictEqual(dryRes.safeToExecute, true);
        assert.strictEqual(dryRes.attachmentState, 'MISSING');
        assert.ok(dryRes.plannedActions.includes('GENERATE_SCREENING_PDF'));
        assert.strictEqual(pdfGenCalls, 0, 'Dry-run must not generate PDF');

        // 2. Real execution
        const execRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: false,
            confirm: 'RECOVER_STORED_SUBMISSION'
        });

        assert.strictEqual(execRes.success, true);
        assert.strictEqual(pdfGenCalls, 1, 'PDF must be generated exactly once');

        // Verify attachment bound to existing SurveySubmission
        const freshSubs = repo.getSurveySubmissions();
        assert.strictEqual(freshSubs.length, 1);
        assert.strictEqual(freshSubs[0].internalSurveyId, testInternalId);
        assert.strictEqual(freshSubs[0].attachmentId, 'gen_report_test_b.pdf');
        assert.ok(freshSubs[0].attachment);

        // Verify 0 duplicate consents
        assert.strictEqual(repo.getConsentEvidenceList().length, 1);
    });

    // --- Test C: Corrupted PDF ---
    await testCase('C. Corrupted PDF: Magic bytes mismatch blocks recovery with RECOVERY_ATTACHMENT_INVALID', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-c';
        const testInternalId = 'surv_test_c_uuid';
        const testAttId = 'corrupt_report.pdf';

        const targetFolder = path.join(TEST_ATTACHMENTS_DIR, testInternalId);
        fs.mkdirSync(targetFolder, { recursive: true });
        const corruptBuf = Buffer.from('NOT_A_PDF_FILE_HEADER_TEXT');
        fs.writeFileSync(path.join(targetFolder, testAttId), corruptBuf);

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: testAttId,
            attachment: { id: testAttId }
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        let ackCalls = 0;
        let deleteCalls = 0;
        const mockExternalClient = {
            acknowledgeSubmission: async () => { ackCalls++; return { success: true }; },
            deleteImportedSubmission: async () => { deleteCalls++; return { success: true }; }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient
        });

        const dryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            dryRun: true
        });

        assert.strictEqual(dryRes.safeToExecute, false);
        assert.strictEqual(dryRes.attachmentState, 'INVALID');
        assert.ok(dryRes.blockingReasons.includes('RECOVERY_ATTACHMENT_INVALID'));
        assert.strictEqual(ackCalls, 0);
        assert.strictEqual(deleteCalls, 0);

        // Execution mode must throw
        await assert.rejects(
            async () => {
                await service.recoverStoredSubmission({
                    submissionId: testSubId,
                    dryRun: false,
                    confirm: 'RECOVER_STORED_SUBMISSION'
                });
            },
            err => err.code === 'RECOVERY_ATTACHMENT_INVALID'
        );
        assert.strictEqual(ackCalls, 0);
        assert.strictEqual(deleteCalls, 0);
    });

    // --- Test D: Duplicate Internal Records ---
    await testCase('D. Duplicate Internal Records: Blocked when >1 internal record exists for submissionId', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-d';

        mockStore.rawStore.SurveySubmissions = [
            { submissionId: testSubId, internalSurveyId: 'surv_d1' },
            { submissionId: testSubId, internalSurveyId: 'surv_d2' }
        ];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: 'surv_d1'
        }];

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: {}
        });

        const dryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            dryRun: true
        });

        assert.strictEqual(dryRes.safeToExecute, false);
        assert.ok(dryRes.blockingReasons.includes('DUPLICATE_INTERNAL_RECORDS_DETECTED'));
    });

    // --- Test E: Expired Lease Fail-Closed Guard ---
    await testCase('E. Expired Lease Guard: Fail-closed without targeted reacquire; 0 Track A calls, 0 ACK/delete even with valid PDF', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-e';
        const testInternalId = 'surv_test_e';
        const testAttId = 'valid_report_e.pdf';

        // Set up valid PDF on disk
        const targetFolder = path.join(TEST_ATTACHMENTS_DIR, testInternalId);
        fs.mkdirSync(targetFolder, { recursive: true });
        const pdfBuf = createSyntheticPdfBuffer();
        const pdfHash = crypto.createHash('sha256').update(pdfBuf).digest('hex');
        fs.writeFileSync(path.join(targetFolder, testAttId), pdfBuf);

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            assignmentStatus: 'unassigned',
            attachmentId: testAttId,
            attachment: {
                id: testAttId,
                name: '온라인 마음건강 검진 결과보고서',
                size: pdfBuf.length,
                fileHash: pdfHash
            }
        }];

        // Expired lease in ledger
        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
            leaseId: 'old_lease_expired',
            leaseUntil: new Date(Date.now() - 100000).toISOString()
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            consentVersion: 'v1.0'
        }];

        let genericPendingLeaseCalls = 0;
        let targetedLeaseCalls = 0;
        let ackCalls = 0;
        let deleteCalls = 0;

        // Mock external client ONLY has generic pending lease, NO targeted reacquire endpoint
        const mockExternalClient = {
            leasePendingSubmissions: async () => {
                genericPendingLeaseCalls++;
                // If called, this would dangerously lease an unrelated pending submission!
                return { submissions: [{ submissionId: 'unrelated-pending-survey-999', lease: { leaseId: 'unrelated_lease' } }] };
            },
            acknowledgeSubmission: async () => { ackCalls++; return { success: true }; },
            deleteImportedSubmission: async () => { deleteCalls++; return { success: true }; }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient
        });

        // 1. Dry run verification
        const dryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: true
        });

        assert.strictEqual(dryRes.safeToExecute, false, 'Expired lease without targeted reacquire must not be safe to execute');
        assert.strictEqual(dryRes.attachmentState, 'VALID_EXISTING', 'Attachment is valid');
        assert.ok(dryRes.blockingReasons.includes('DETERMINISTIC_REACQUIRE_NOT_AVAILABLE'));
        assert.strictEqual(genericPendingLeaseCalls, 0, 'Generic pending lease must NEVER be called');
        assert.strictEqual(ackCalls, 0, 'ACK must not be called in dry-run');
        assert.strictEqual(deleteCalls, 0, 'Delete must not be called in dry-run');

        // 2. Real execution verification (must fail closed before touching external client)
        await assert.rejects(
            async () => {
                await service.recoverStoredSubmission({
                    submissionId: testSubId,
                    expectedInternalSurveyId: testInternalId,
                    dryRun: false,
                    confirm: 'RECOVER_STORED_SUBMISSION'
                });
            },
            err => err.code === 'DETERMINISTIC_REACQUIRE_NOT_AVAILABLE'
        );

        // Crucial assertions: zero Track A calls, zero unrelated submissions leased, zero ACK, zero delete
        assert.strictEqual(genericPendingLeaseCalls, 0, 'No bypass via generic pending lease allowed; must be 0 calls');
        assert.strictEqual(ackCalls, 0, 'ACK must be 0 calls when blocked');
        assert.strictEqual(deleteCalls, 0, 'Delete must be 0 calls when blocked');

        // Internal records must remain intact
        const ledger = repo.findBySubmissionId(testSubId);
        assert.strictEqual(ledger.externalStatus, SURVEY_EXTERNAL_STATUS.LEASED);
    });

    // --- Test F: ACK Failure ---
    await testCase('F. ACK Failure: Delete is not called, PDF and internal survey preserved', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-f';
        const testInternalId = 'surv_test_f';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: null
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
            leaseId: 'lease_active',
            leaseUntil: new Date(Date.now() + 600000).toISOString()
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        let deleteCalls = 0;
        const mockExternalClient = {
            acknowledgeSubmission: async () => ({ success: false }), // fails!
            deleteImportedSubmission: async () => { deleteCalls++; return { success: true }; }
        };

        const mockReferralService = {
            attachmentsDir: TEST_ATTACHMENTS_DIR,
            generateScreeningReportOnly: async ({ internalSurveyId }) => {
                const folder = path.join(TEST_ATTACHMENTS_DIR, internalSurveyId);
                fs.mkdirSync(folder, { recursive: true });
                const buf = createSyntheticPdfBuffer();
                fs.writeFileSync(path.join(folder, 'rep_f.pdf'), buf);
                return { attachment: { id: 'rep_f.pdf', fileHash: crypto.createHash('sha256').update(buf).digest('hex') } };
            }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient,
            referralService: mockReferralService
        });

        await assert.rejects(
            async () => {
                await service.recoverStoredSubmission({
                    submissionId: testSubId,
                    expectedInternalSurveyId: testInternalId,
                    dryRun: false,
                    confirm: 'RECOVER_STORED_SUBMISSION'
                });
            }
        );

        assert.strictEqual(deleteCalls, 0, 'Delete must NEVER be called when ACK fails');
        const ledger = repo.findBySubmissionId(testSubId);
        assert.notStrictEqual(ledger.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
    });

    // --- Test G: Delete Failure ---
    await testCase('G. Delete Failure: ACK status preserved, delete retryable without duplicate ACK', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-g';
        const testInternalId = 'surv_test_g';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: null
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR,
            leaseId: 'lease_active_g',
            leaseUntil: new Date(Date.now() + 600000).toISOString()
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        let ackCalls = 0;
        let deleteCalls = 0;
        let deleteShouldFail = true;

        const mockExternalClient = {
            acknowledgeSubmission: async () => { ackCalls++; return { success: true }; },
            deleteImportedSubmission: async () => {
                deleteCalls++;
                if (deleteShouldFail) return { success: false };
                return { success: true };
            }
        };

        const mockReferralService = {
            attachmentsDir: TEST_ATTACHMENTS_DIR,
            generateScreeningReportOnly: async ({ internalSurveyId }) => {
                const folder = path.join(TEST_ATTACHMENTS_DIR, internalSurveyId);
                fs.mkdirSync(folder, { recursive: true });
                const buf = createSyntheticPdfBuffer();
                fs.writeFileSync(path.join(folder, 'rep_g.pdf'), buf);
                return { attachment: { id: 'rep_g.pdf', fileHash: crypto.createHash('sha256').update(buf).digest('hex') } };
            }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient,
            referralService: mockReferralService
        });

        // First attempt: Delete fails
        await assert.rejects(
            async () => {
                await service.recoverStoredSubmission({
                    submissionId: testSubId,
                    expectedInternalSurveyId: testInternalId,
                    dryRun: false,
                    confirm: 'RECOVER_STORED_SUBMISSION'
                });
            }
        );

        assert.strictEqual(ackCalls, 1);
        assert.strictEqual(deleteCalls, 1);
        assert.strictEqual(repo.findBySubmissionId(testSubId).externalStatus, SURVEY_EXTERNAL_STATUS.ACKNOWLEDGED);

        // Second attempt: Delete retry succeeds, ACK must NOT be re-called
        deleteShouldFail = false;
        const retryRes = await service.recoverStoredSubmission({
            submissionId: testSubId,
            expectedInternalSurveyId: testInternalId,
            dryRun: false,
            confirm: 'RECOVER_STORED_SUBMISSION'
        });

        assert.strictEqual(retryRes.success, true);
        assert.strictEqual(ackCalls, 1, 'ACK must not be called again on delete retry');
        assert.strictEqual(deleteCalls, 2);
        assert.strictEqual(repo.findBySubmissionId(testSubId).externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
    });

    // --- Test H: Re-invocation on Completed Record ---
    await testCase('H. Re-invocation: Completed record returns ALREADY_COMPLETED, 0 duplicate actions', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-h';
        const testInternalId = 'surv_test_h';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: 'some.pdf',
            attachment: { id: 'some.pdf' }
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.DELETED,
            internalStatus: SURVEY_INTERNAL_STATUS.COMPLETED
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: {}
        });

        const res = await service.recoverStoredSubmission({
            submissionId: testSubId,
            dryRun: true
        });

        assert.strictEqual(res.safeToExecute, false);
        assert.ok(res.blockingReasons.includes('ALREADY_COMPLETED'));
    });

    // --- Test I: Permissions & Endpoint Guards ---
    await testCase('I. Permissions: Non-admin 403, inactive admin 403, missing permission 403, admin 200', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-i';
        const testInternalId = 'surv_test_i';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: null
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: {}
        });

        let currentAuth = null;
        const fakeRequireAuth = (req, res, next) => {
            if (!currentAuth) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
            req.auth = currentAuth;
            next();
        };

        const router = createSurveyImportRouter({
            requireAuth: fakeRequireAuth,
            surveyImportService: service,
            surveyRepository: repo
        });

        const app = express();
        app.use(express.json());
        app.use('/api/surveys', router);

        const server = http.createServer(app);
        await new Promise(r => server.listen(0, r));
        const port = server.address().port;

        try {
            // 1. Unauthenticated -> 401
            currentAuth = null;
            let resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: true })
            });
            assert.strictEqual(resp.status, 401);

            // 2. Regular user with ONLINE_SURVEY_ACCESS -> 403 (Non-admin blocked)
            currentAuth = { id: 'u1', role: 'user', status: 'active', permissions: { [ONLINE_SURVEY_ACCESS]: true } };
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: true })
            });
            assert.strictEqual(resp.status, 403);

            // 3. Regular user without permissions -> 403
            currentAuth = { id: 'u2', role: 'user', status: 'active', permissions: {} };
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: true })
            });
            assert.strictEqual(resp.status, 403);

            // 4. Inactive admin -> 403
            currentAuth = { id: 'admin1', role: 'admin', status: 'inactive', permissions: { [ONLINE_SURVEY_ACCESS]: true } };
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: true })
            });
            assert.strictEqual(resp.status, 403);

            // 5. Active Admin -> 200
            currentAuth = { id: 'admin1', role: 'admin', status: 'active', permissions: { [ONLINE_SURVEY_ACCESS]: true } };
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: true })
            });
            assert.strictEqual(resp.status, 200);
            const json = await resp.json();
            assert.strictEqual(json.dryRun, true);
            assert.strictEqual(json.submissionId, testSubId);
            assert.strictEqual(json.attachmentState, 'MISSING');

            // 6. Array body -> 400
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ submissionId: testSubId, dryRun: true }])
            });
            assert.strictEqual(resp.status, 400);

            // 7. Non-dryRun without confirm -> 400
            resp = await fetch(`http://localhost:${port}/api/surveys/admin/recover-stored-submission`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: testSubId, dryRun: false })
            });
            assert.strictEqual(resp.status, 400);
        } finally {
            await new Promise(r => server.close(r));
        }
    });

    // --- Test J: Dry-run zero side-effects ---
    await testCase('J. Dry-run Isolation: Exactly 0 Track A calls, 0 PDF generation calls, 0 data modifications', async () => {
        const mockStore = createMockStore();
        const testSubId = 'synth-sub-test-j';
        const testInternalId = 'surv_test_j';

        mockStore.rawStore.SurveySubmissions = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId,
            processingStatus: 'PENDING_STAFF_REVIEW',
            attachmentId: null
        }];

        mockStore.rawStore.ExternalSubmissionImports = [{
            submissionId: testSubId,
            externalStatus: SURVEY_EXTERNAL_STATUS.LEASED,
            internalStatus: SURVEY_INTERNAL_STATUS.ERROR
        }];

        mockStore.rawStore.SurveyConsentEvidence = [{
            submissionId: testSubId,
            internalSurveyId: testInternalId
        }];

        let trackACalls = 0;
        let pdfGenCalls = 0;

        const mockExternalClient = {
            leasePendingSubmissions: async () => { trackACalls++; return {}; },
            acknowledgeSubmission: async () => { trackACalls++; return {}; },
            deleteImportedSubmission: async () => { trackACalls++; return {}; }
        };

        const mockReferralService = {
            attachmentsDir: TEST_ATTACHMENTS_DIR,
            generateScreeningReportOnly: async () => { pdfGenCalls++; return {}; }
        };

        const repo = new SurveyImportRepository({
            getData: mockStore.getData,
            persistData: mockStore.persistData,
            attachmentsDir: TEST_ATTACHMENTS_DIR
        });

        const service = new SurveyImportService({
            repository: repo,
            decryptionService: {},
            validator: {},
            externalApiClient: mockExternalClient,
            referralService: mockReferralService
        });

        const initialSubsJson = JSON.stringify(mockStore.rawStore.SurveySubmissions);
        const initialLedgerJson = JSON.stringify(mockStore.rawStore.ExternalSubmissionImports);

        const res = await service.recoverStoredSubmission({
            submissionId: testSubId,
            dryRun: true
        });

        assert.strictEqual(res.dryRun, true);
        assert.strictEqual(trackACalls, 0, 'Zero Track A calls in dry-run');
        assert.strictEqual(pdfGenCalls, 0, 'Zero PDF calls in dry-run');
        assert.strictEqual(JSON.stringify(mockStore.rawStore.SurveySubmissions), initialSubsJson, 'SurveySubmissions must not be modified in dry-run');
        assert.strictEqual(JSON.stringify(mockStore.rawStore.ExternalSubmissionImports), initialLedgerJson, 'Ledger must not be modified in dry-run');
    });

    // Cleanup scratch test directory
    try {
        if (fs.existsSync(TEST_ATTACHMENTS_DIR)) {
            fs.rmSync(TEST_ATTACHMENTS_DIR, { recursive: true, force: true });
        }
    } catch (ignore) {}

    console.log('\n====================================================');
    console.log(`📊 Recovery Test Results: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

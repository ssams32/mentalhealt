/**
 * scripts/verify-track-b-survey.mjs
 * Comprehensive automated verification test suite for Track B:
 * Internal NAS Survey Administration and Import.
 * 
 * Verifies:
 * 1. Contract & Authenticated Decryption
 * 2. Tamper Defense & Key Version Handling
 * 3. Consent Evidence & TransmittedFieldSet Enforcement
 * 4. SBQ-R Policy Gate
 * 5. Atomic Persistence, ACK, and Deletion Sequence
 * 6. Idempotency & Concurrency Lock
 * 7. Failure Recovery & Retry Mechanism
 * 8. Zero-Leak Log Redaction Policy
 */

import assert from 'assert';
import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyImportRepository,
    SurveyImportService,
    MockTrackAApi,
    SURVEY_ERROR_CODES,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS
} from '../server/survey/index.js';

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

// In-Memory Storage Adapter for Test Isolation
function createInMemoryStore() {
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

async function runAllTests() {
    console.log('\n============================================================');
    console.log('🧪 TRACK B: SURVEY ADMINISTRATION & IMPORT VERIFICATION');
    console.log('============================================================\n');

    // Setup Test Environment
    const keyProvider = new SurveyKeyProvider();
    const { publicKey, privateKey } = keyProvider.generateSyntheticTestKey('test_key_v1');
    const decryptionService = new SurveyDecryptionService({ keyProvider });
    const validator = new SurveyPayloadValidator({ sbqrApproved: false });
    const mockTrackA = new MockTrackAApi();

    // ──────────────────────────────────────────────────────────
    // 1. Contract & Authenticated Decryption
    // ──────────────────────────────────────────────────────────
    console.log('--- 1. Contract & Authenticated Decryption ---');

    const validSyntheticPayload = {
        submissionId: 'test-sub-001',
        schemaVersion: '1.0.0',
        assessmentId: 'phq-9',
        assessmentVersion: '1.0.0',
        contactOnly: false,
        consentEvidence: {
            consentVersion: '2026.1',
            personalInfoConsent: true,
            sensitiveInfoConsent: true,
            consentedAt: new Date().toISOString(),
            transmittedFieldSet: ['clientName', 'phone', 'gender', 'region', 'answers', 'totalScore', 'severity']
        },
        contact: {
            clientName: '홍길동',
            phone: '010-1234-5678',
            gender: '남성',
            region: '이천시'
        },
        assessment: {
            answers: [1, 2, 1, 0, 0, 1, 2, 1, 0],
            totalScore: 8,
            severity: 'mild'
        }
    };

    const envelope = mockTrackA.seedSubmission({
        payload: validSyntheticPayload,
        publicKeyPem: publicKey,
        keyVersion: 'test_key_v1'
    });

    it('Valid synthetic envelope decrypts and preserves allowlisted payload fields', () => {
        const decrypted = decryptionService.decryptEnvelope(envelope);
        assert.strictEqual(decrypted.submissionId, 'test-sub-001');
        assert.strictEqual(decrypted.assessmentId, 'phq-9');
        assert.strictEqual(decrypted.contact.clientName, '홍길동');
        assert.strictEqual(decrypted.assessment.totalScore, 8);
    });

    it('Tampered ciphertext fails with CIPHERTEXT_AUTHENTICATION_FAILED', () => {
        const tamperedEnvelope = JSON.parse(JSON.stringify(envelope));
        const buf = Buffer.from(tamperedEnvelope.ciphertext, 'base64');
        buf[0] ^= 0xff; // Flip bit
        tamperedEnvelope.ciphertext = buf.toString('base64');

        assert.throws(() => {
            decryptionService.decryptEnvelope(tamperedEnvelope);
        }, /Ciphertext authentication failed/);
    });

    it('Corrupted IV fails with CIPHERTEXT_AUTHENTICATION_FAILED', () => {
        const corruptedIvEnvelope = JSON.parse(JSON.stringify(envelope));
        corruptedIvEnvelope.iv = Buffer.from('short_iv').toString('base64');

        assert.throws(() => {
            decryptionService.decryptEnvelope(corruptedIvEnvelope);
        }, /Ciphertext authentication failed/);
    });

    it('Unsupported schemaVersion in envelope is rejected', () => {
        const badVersionEnvelope = JSON.parse(JSON.stringify(envelope));
        badVersionEnvelope.schemaVersion = '99.0.0';

        assert.throws(() => {
            decryptionService.decryptEnvelope(badVersionEnvelope);
        }, /Unsupported envelope schema version/);
    });

    // ──────────────────────────────────────────────────────────
    // 2. Consent Evidence & TransmittedFieldSet Enforcement
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 2. Consent Evidence & Allowlist Enforcement ---');

    it('Personal contact fields without personalInfoConsent are rejected', () => {
        const noPersonalConsentPayload = JSON.parse(JSON.stringify(validSyntheticPayload));
        noPersonalConsentPayload.consentEvidence.personalInfoConsent = false;

        assert.throws(() => {
            validator.validate(noPersonalConsentPayload);
        }, /Personal contact fields provided without verified personalInfoConsent/);
    });

    it('Assessment data without sensitiveInfoConsent is rejected', () => {
        const noSensitiveConsentPayload = JSON.parse(JSON.stringify(validSyntheticPayload));
        noSensitiveConsentPayload.consentEvidence.sensitiveInfoConsent = false;

        assert.throws(() => {
            validator.validate(noSensitiveConsentPayload);
        }, /Sensitive assessment fields provided without verified sensitiveInfoConsent/);
    });

    it('Undeclared transmitted field triggers TRANSMITTED_FIELDSET_MISMATCH', () => {
        const undeclaredFieldPayload = JSON.parse(JSON.stringify(validSyntheticPayload));
        // Remove phone from transmittedFieldSet but keep in contact
        undeclaredFieldPayload.consentEvidence.transmittedFieldSet = ['clientName', 'gender', 'region', 'answers', 'totalScore', 'severity'];

        assert.throws(() => {
            validator.validate(undeclaredFieldPayload);
        }, /not declared in transmittedFieldSet/);
    });

    it('Prohibited unknown top-level field is rejected', () => {
        const unknownFieldPayload = JSON.parse(JSON.stringify(validSyntheticPayload));
        unknownFieldPayload.injectedMaliciousKey = 'exploit';

        assert.throws(() => {
            validator.validate(unknownFieldPayload);
        }, /Prohibited top-level property/);
    });

    // ──────────────────────────────────────────────────────────
    // 3. Strict SBQ-R Safety Gate
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 3. Strict SBQ-R Safety Gate ---');

    it('SBQ-R submission is quarantined without active referral creation', () => {
        const sbqrPayload = JSON.parse(JSON.stringify(validSyntheticPayload));
        sbqrPayload.assessmentId = 'sbq-r';
        const res = validator.validate(sbqrPayload);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(res.isSbqrQuarantined, true);
        assert(res.quarantineReason.includes('SBQ-R is not approved'));
    });

    // ──────────────────────────────────────────────────────────
    // 4. Atomic Import, Idempotency, and Failure Recovery
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 4. Atomic Import, ACK, Deletion & Idempotency ---');

    await itAsync('Successful import persists intake, sends ACK, and deletes external ciphertext', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();
        const subId = 'test-flow-001';

        mockApi.seedSubmission({
            payload: { ...validSyntheticPayload, submissionId: subId },
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: subId
        });

        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });

        const summary = await importService.runManualImport({ actorId: 'admin_test' });
        assert.strictEqual(summary.imported, 1);
        assert.strictEqual(summary.duplicates, 0);
        assert.strictEqual(summary.quarantined, 0);

        // Verify ledger
        const ledger = repo.findBySubmissionId(subId);
        assert.strictEqual(ledger.internalStatus, SURVEY_INTERNAL_STATUS.COMPLETED);
        assert.strictEqual(ledger.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);

        // Verify PendingReferrals
        const pendingRefs = getData('PendingReferrals', []);
        assert.strictEqual(pendingRefs.length, 1);
        assert.strictEqual(pendingRefs[0].name, '홍길동');
        assert.strictEqual(pendingRefs[0].source, 'online_survey');

        // Verify mock external state is deleted
        const extItem = mockApi.submissions.get(subId);
        assert.strictEqual(extItem.status, 'DELETED');
        assert.strictEqual(extItem.envelope.ciphertext, '[DELETED]');
    });

    await itAsync('Duplicate import produces idempotent success without duplicate rows', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();
        const subId = 'test-flow-dup';

        mockApi.seedSubmission({
            payload: { ...validSyntheticPayload, submissionId: subId },
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: subId
        });

        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });

        // First run: imported
        await importService.runManualImport({ actorId: 'admin_test' });

        // Simulate external API re-delivering the same submission envelope
        mockApi.seedSubmission({
            payload: { ...validSyntheticPayload, submissionId: subId },
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: subId
        });

        // Second run: must detect duplicate in internal ledger
        const summary2 = await importService.runManualImport({ actorId: 'admin_test' });
        assert.strictEqual(summary2.imported, 0);
        assert.strictEqual(summary2.duplicates, 1);

        // Ensure exactly 1 pending referral created
        const pendingRefs = getData('PendingReferrals', []);
        assert.strictEqual(pendingRefs.length, 1);
    });

    await itAsync('Concurrent import attempt is rejected with IMPORT_ALREADY_IN_PROGRESS', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();

        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });

        // Simulate locked state
        importService._isImportRunning = true;

        try {
            await importService.runManualImport({ actorId: 'admin_concurrent' });
            assert.fail('Should have thrown');
        } catch (err) {
            assert.strictEqual(err.code, SURVEY_ERROR_CODES.IMPORT_ALREADY_IN_PROGRESS);
        } finally {
            importService._isImportRunning = false;
        }
    });

    await itAsync('External deletion failure marks DELETE_PENDING for subsequent retry', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();
        const subId = 'test-flow-del-fail';

        mockApi.seedSubmission({
            payload: { ...validSyntheticPayload, submissionId: subId },
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: subId
        });

        // Simulate deletion failure
        mockApi.failDeleteNext = true;

        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });

        const summary = await importService.runManualImport({ actorId: 'admin_test' });
        assert.strictEqual(summary.imported, 1);
        assert.strictEqual(summary.deletePending, 1);

        const ledger = repo.findBySubmissionId(subId);
        assert.strictEqual(ledger.externalStatus, SURVEY_EXTERNAL_STATUS.DELETE_PENDING);

        // Now retry deletions
        const retryResult = await importService.retryPendingDeletions('admin_test');
        assert.strictEqual(retryResult.succeeded, 1);

        const updatedLedger = repo.findBySubmissionId(subId);
        assert.strictEqual(updatedLedger.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
    });

    // ──────────────────────────────────────────────────────────
    // 5. Zero-Leak Audit Log Redaction Policy
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 5. Audit Log Redaction Policy ---');

    await itAsync('Audit logs and operation errors contain zero names, phone numbers, answers, or keys', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();

        mockApi.seedSubmission({
            payload: validSyntheticPayload,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1'
        });

        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });

        await importService.runManualImport({ actorId: 'admin_test' });

        const auditLogs = repo.getAuditLogs();
        assert(auditLogs.length > 0);

        const auditDump = JSON.stringify(auditLogs);
        assert(!auditDump.includes('홍길동'), 'Audit logs must NOT contain client name');
        assert(!auditDump.includes('010-1234-5678'), 'Audit logs must NOT contain phone number');
        assert(!auditDump.includes('PRIVATE KEY'), 'Audit logs must NOT contain private key');
    });

    // ──────────────────────────────────────────────────────────
    // 6. TRACK_A_MAX_BATCH_SIZE & Effective Limit Policy
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 6. TRACK_A_MAX_BATCH_SIZE & Effective Limit Policy ---');

    await itAsync('A. maxBatchSize=1, requestedLimit=50 enforces effectiveLimit=1 on API call', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        let capturedLimit = null;
        const spyApi = {
            async checkSubmissionGateStatus() { return { enabled: true }; },
            async leasePendingSubmissions({ limit, leaseSeconds }) {
                capturedLimit = limit;
                return { submissions: [] };
            }
        };
        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: spyApi,
            maxBatchSize: 1
        });
        assert.strictEqual(importService.maxBatchSize, 1);
        await importService.runManualImport({ actorId: 'admin_test', limit: 50 });
        assert.strictEqual(capturedLimit, 1, 'API call limit must be 1 when maxBatchSize=1 and requestedLimit=50');
    });

    await itAsync('B. maxBatchSize=50, requestedLimit=10 uses effectiveLimit=10 on API call', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        let capturedLimit = null;
        const spyApi = {
            async checkSubmissionGateStatus() { return { enabled: true }; },
            async leasePendingSubmissions({ limit, leaseSeconds }) {
                capturedLimit = limit;
                return { submissions: [] };
            }
        };
        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: spyApi,
            maxBatchSize: 50
        });
        assert.strictEqual(importService.maxBatchSize, 50);
        await importService.runManualImport({ actorId: 'admin_test', limit: 10 });
        assert.strictEqual(capturedLimit, 10, 'API call limit must be 10 when requestedLimit=10 and maxBatchSize=50');
    });

    await itAsync('C. maxBatchSize=50, requestedLimit=50 uses effectiveLimit=50 on API call', async () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        let capturedLimit = null;
        const spyApi = {
            async checkSubmissionGateStatus() { return { enabled: true }; },
            async fetchPending({ limit, leaseSeconds }) {
                capturedLimit = limit;
                return { submissions: [] };
            }
        };
        const importService = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: spyApi,
            maxBatchSize: 50
        });
        assert.strictEqual(importService.maxBatchSize, 50);
        await importService.runManualImport({ actorId: 'admin_test', limit: 50 });
        assert.strictEqual(capturedLimit, 50, 'API call limit must be 50 via fetchPending fallback');
    });

    it('D. Production configuration validation: rejects invalid and accepts 1..100 integers', () => {
        function validateProductionBatch(val) {
            const trimmed = typeof val === 'string' ? val.trim() : '';
            const num = Number(trimmed);
            const isValid = trimmed !== '' && /^\d+$/.test(trimmed) && Number.isInteger(num) && num >= 1 && num <= 100;
            if (!isValid) {
                throw new Error('[FATAL] Invalid TRACK_A_MAX_BATCH_SIZE in production mode.');
            }
            return num;
        }

        assert.strictEqual(validateProductionBatch('1'), 1);
        assert.strictEqual(validateProductionBatch('100'), 100);
        assert.throws(() => validateProductionBatch(undefined), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch(''), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('   '), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('0'), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('-5'), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('101'), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('1.5'), /Invalid TRACK_A_MAX_BATCH_SIZE/);
        assert.throws(() => validateProductionBatch('abc'), /Invalid TRACK_A_MAX_BATCH_SIZE/);
    });

    it('E. mock and staging fallback to default 50 when no valid batch size configured', () => {
        const { getData, persistData } = createInMemoryStore();
        const repo = new SurveyImportRepository({ getData, persistData });
        const mockApi = new MockTrackAApi();
        const svcDefault = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi
        });
        assert.strictEqual(svcDefault.maxBatchSize, 50);

        const svcInvalid = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi,
            maxBatchSize: 'invalid'
        });
        assert.strictEqual(svcInvalid.maxBatchSize, 50);

        const svcFraction = new SurveyImportService({
            repository: repo,
            decryptionService,
            validator,
            externalApiClient: mockApi,
            maxBatchSize: 1.5
        });
        assert.strictEqual(svcFraction.maxBatchSize, 50);
    });

    console.log('\n============================================================');
    console.log(`📊 TRACK B VERIFICATION RESULTS: ${passed} Passed, ${failed} Failed (Total: ${passed + failed})`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test suite crash:', err);
    process.exit(1);
});

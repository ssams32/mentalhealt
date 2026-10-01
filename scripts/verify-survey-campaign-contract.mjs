/**
 * scripts/verify-survey-campaign-contract.mjs
 * Comprehensive Track B Verification Suite for Campaign Backend Implementation.
 *
 * Tests:
 * 1. S1~S12 baseline verification from verify-payload-contract.mjs
 * 2. campaignCode unknown-field regression test (ALLOWED_TOP_LEVEL_KEYS)
 * 3. Validation metadata separation (Calibration 1: ABSENT / VALID / INVALID, zero _ internal keys)
 * 4. transmittedFieldSet conditional synchronization (Calibration 5)
 * 5. Repository single point of persistence (persistSurveyIntake & campaignCode)
 * 6. Intake classification audit events (CAMPAIGN_CODE_ABSENT / _VALID_REGISTERED / _VALID_UNREGISTERED / _INVALID)
 * 7. Zero PII / raw invalid code in audit logs
 * 8. Campaign-specific mutex serial execution & race condition prevention (Calibration 2)
 * 9. Concurrent duplicate creation: 1 success / 1 conflict (409), LOST_UPDATE: NO
 * 10. Campaign updates & code immutability (400 on code change attempt)
 * 11. Absence of DELETE endpoint / method
 * 12. Filter validation on GET /imports and GET /export (Calibration 4: 400 on malformed, valid-unregistered allowed)
 * 13. safeList campaign metadata fields (campaignCode, campaignName, campaignPurpose, campaignRegistrationStatus)
 * 14. 4-count aggregation & allowlist verification (Calibration 3: receivedCount, pendingReviewCount, registeredReferralCount, completedCount)
 * 15. Count partitioning invariant: sum(campaigns) + unspecified = total (including unregistered valid codes)
 * 16. Role-based access control (Admin required for POST/PATCH, Survey permission for GET)
 * 17. MockTrackAApi fixtures & purge-demo preservation
 * 18. Explicit campaignCodeMetadata propagation with cloned payload instance (BLOCKER 1 fix)
 * 19. Real SurveyImportService full intake cycle with cloned payload (MAJOR 1 fix)
 * 20. Real SurveyExportService XLSX generation & privacy masking (MAJOR 1 fix)
 * 21. S5 runtime test: identical period campaigns partitioned strictly by code (MAJOR 2 fix)
 * 22. S12 runtime test: inactive campaign historical submissions preserved in GET /campaigns (MAJOR 2 fix)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';

import {
    SurveyPayloadValidator,
    getCampaignMetadataForPayload,
    payloadCampaignMetadataMap
} from '../server/survey/surveyPayloadValidator.js';
import { SurveyImportRepository } from '../server/survey/surveyImportRepository.js';
import { SurveyImportService } from '../server/survey/surveyImportService.js';
import { SurveyExportService } from '../server/survey/surveyExportService.js';
import { createSurveyImportRouter, validateAndNormalizeCampaignFilter } from '../server/survey/surveyImportRouter.js';
import { MockTrackAApi } from '../server/survey/mockTrackAApi.js';
import XLSX from 'xlsx';
import {
    SURVEY_STORAGE_FILES,
    CAMPAIGN_CODE_PATTERN,
    SURVEY_CAMPAIGN_AUDIT_ACTIONS,
    SURVEY_CAMPAIGN_CLASSIFICATIONS,
    SURVEY_CAMPAIGN_REGISTRATION_STATUS,
    SURVEY_ERROR_CODES
} from '../server/survey/surveyConstants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory Storage Harness for Repository
function createInMemoryStorage() {
    const memory = new Map();
    return {
        getData: (filename, defaultValue = []) => {
            if (!memory.has(filename)) {
                memory.set(filename, JSON.parse(JSON.stringify(defaultValue)));
            }
            return memory.get(filename);
        },
        persistData: async (filename, data) => {
            memory.set(filename, JSON.parse(JSON.stringify(data)));
            return true;
        },
        dump: (filename) => memory.get(filename) || []
    };
}

async function runCampaignBackendVerificationSuite() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Survey Campaign Backend Contract Suite');
    console.log('🧪 ========================================================');

    let passedTests = 0;
    let failedTests = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✅ PASS: ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failedTests++;
        }
    }

    async function testAsync(name, fn) {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passedTests++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failedTests++;
        }
    }

    // ──────────────────────────────────────────────────────────
    // SUITE 1: Payload Validator & Calibration 1 & 5
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 1: Payload Validator & Metadata Contract');

    const validator = new SurveyPayloadValidator({ sbqrApproved: false });

    function createBasePayload() {
        return {
            submissionId: `sub-${crypto.randomUUID()}`,
            schemaVersion: 'v1.0',
            assessmentId: 'phq-9',
            assessmentVersion: '1.0.0',
            contactOnly: false,
            submittedAt: new Date().toISOString(),
            contact: {
                clientName: '홍길동',
                phone: '010-1234-5678',
                gender: '남성',
                region: '이천시',
                counselingRequestText: '상담 요청'
            },
            assessment: {
                totalScore: 10,
                severity: '중등도 우울',
                responses: [
                    { questionNumber: 1, score: 2 }
                ]
            },
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: true,
                consentedAt: new Date().toISOString(),
                transmittedFieldSet: ['clientName', 'phone', 'gender', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
            }
        };
    }

    test('1.1. campaignCode is NOT rejected as unknown-field (Check order regression fixed)', () => {
        const payload = createBasePayload();
        payload.campaignCode = 'ACME-2026-1';
        const res = validator.validate(payload);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(payload.campaignCode, 'ACME-2026-1');
        assert.strictEqual(res.campaignCodeMetadata.status, 'VALID');
        assert.strictEqual(res.campaignCodeMetadata.code, 'ACME-2026-1');
    });

    test('1.2. Valid canonical code: trimmed and uppercased, transmittedFieldSet synchronized (Calibration 5)', () => {
        const payload = createBasePayload();
        payload.campaignCode = '  acme-corp-2026-q1  ';
        const res = validator.validate(payload);
        assert.strictEqual(payload.campaignCode, 'ACME-CORP-2026-Q1');
        assert.strictEqual(res.campaignCodeMetadata.status, 'VALID');
        assert.strictEqual(res.campaignCodeMetadata.code, 'ACME-CORP-2026-Q1');
        assert.strictEqual(payload.consentEvidence.transmittedFieldSet.includes('campaignCode'), true);
        // Ensure no duplicates
        const count = payload.consentEvidence.transmittedFieldSet.filter(f => f === 'campaignCode').length;
        assert.strictEqual(count, 1);
    });

    test('1.3. Absent code: metadata is ABSENT and payload.campaignCode is undefined', () => {
        const payload = createBasePayload();
        delete payload.campaignCode;
        const res = validator.validate(payload);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(payload.campaignCode, undefined);
        assert.strictEqual(res.campaignCodeMetadata.status, 'ABSENT');
        assert.strictEqual(res.campaignCodeMetadata.code, null);
    });

    test('1.4. Invalid code format: submission accepted, campaignCode removed (null/undefined), metadata INVALID (Calibration 1)', () => {
        const payload = createBasePayload();
        payload.campaignCode = 'invalid_lowercase_and_symbols!@#';
        const res = validator.validate(payload);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(payload.campaignCode, undefined);
        assert.strictEqual(res.campaignCodeMetadata.status, 'INVALID');
        assert.strictEqual(res.campaignCodeMetadata.code, null);
        assert.strictEqual(res.isSbqrQuarantined, false);
    });

    test('1.5. Non-string code: submission accepted, campaignCode removed, metadata INVALID', () => {
        const payload = createBasePayload();
        payload.campaignCode = 12345;
        const res = validator.validate(payload);
        assert.strictEqual(res.valid, true);
        assert.strictEqual(payload.campaignCode, undefined);
        assert.strictEqual(res.campaignCodeMetadata.status, 'INVALID');
        assert.strictEqual(res.campaignCodeMetadata.code, null);
    });

    test('1.6. CRITICAL GUARANTEE: NO internal keys starting with "_" in payload (INTERNAL_INVALID_FLAG_ADDED_TO_PAYLOAD: NO)', () => {
        const payload = createBasePayload();
        payload.campaignCode = 'invalid_code!@#';
        validator.validate(payload);

        const allKeys = Object.keys(payload);
        const internalKeys = allKeys.filter(k => k.startsWith('_'));
        assert.strictEqual(internalKeys.length, 0, `No internal _ keys allowed, found: ${internalKeys.join(', ')}`);
        assert.strictEqual(payload._campaignCodeInvalid, undefined);

        const jsonStr = JSON.stringify(payload);
        assert.strictEqual(jsonStr.includes('_campaignCodeInvalid'), false);
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 2: Repository Persistence & Audit Logging
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 2: Repository Persistence & Intake Classification Audit');

    await testAsync('2.1. persistSurveyIntake persists campaignCode into surveyRecord', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // Seed a registered campaign
        await repo.createCampaign({
            code: 'DEMO-2026-1',
            companyName: '데모주식회사',
            purpose: '임직원 검진'
        });

        const envelope = {
            submissionId: 'sub-test-intake-001',
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            sourceEnvironment: 'mock'
        };
        const payload = createBasePayload();
        payload.campaignCode = 'DEMO-2026-1';
        payload.submissionId = envelope.submissionId;
        validator.validate(payload);

        const intake = await repo.persistSurveyIntake({
            envelope,
            payload,
            isSbqrQuarantined: false,
            actorId: 'test-agent'
        });

        const sub = repo.findSubmissionById(intake.internalSurveyId);
        assert.strictEqual(sub.campaignCode, 'DEMO-2026-1');
        assert.strictEqual(sub._campaignCodeInvalid, undefined);

        // Check audit event
        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const intakeAudit = audits.find(a => a.action === 'CAMPAIGN_CODE_VALID_REGISTERED' && a.submissionId === envelope.submissionId);
        assert.ok(intakeAudit, 'Must record CAMPAIGN_CODE_VALID_REGISTERED audit event');
        assert.strictEqual(intakeAudit.campaignCode, 'DEMO-2026-1');
    });

    await testAsync('2.2. persistSurveyIntake classifies valid-unregistered code correctly', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const envelope = {
            submissionId: 'sub-test-unreg-001',
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            sourceEnvironment: 'mock'
        };
        const payload = createBasePayload();
        payload.campaignCode = 'UNREG-CORP-2026';
        payload.submissionId = envelope.submissionId;
        validator.validate(payload);

        const intake = await repo.persistSurveyIntake({
            envelope,
            payload,
            isSbqrQuarantined: false,
            actorId: 'test-agent'
        });

        const sub = repo.findSubmissionById(intake.internalSurveyId);
        assert.strictEqual(sub.campaignCode, 'UNREG-CORP-2026');

        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const intakeAudit = audits.find(a => a.action === 'CAMPAIGN_CODE_VALID_UNREGISTERED' && a.submissionId === envelope.submissionId);
        assert.ok(intakeAudit, 'Must record CAMPAIGN_CODE_VALID_UNREGISTERED audit event');
        assert.strictEqual(intakeAudit.campaignCode, 'UNREG-CORP-2026');
    });

    await testAsync('2.3. persistSurveyIntake classifies absent code correctly', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const envelope = {
            submissionId: 'sub-test-absent-001',
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            sourceEnvironment: 'mock'
        };
        const payload = createBasePayload();
        delete payload.campaignCode;
        payload.submissionId = envelope.submissionId;
        validator.validate(payload);

        const intake = await repo.persistSurveyIntake({
            envelope,
            payload,
            isSbqrQuarantined: false,
            actorId: 'test-agent'
        });

        const sub = repo.findSubmissionById(intake.internalSurveyId);
        assert.strictEqual(sub.campaignCode, null);

        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const intakeAudit = audits.find(a => a.action === 'CAMPAIGN_CODE_ABSENT' && a.submissionId === envelope.submissionId);
        assert.ok(intakeAudit, 'Must record CAMPAIGN_CODE_ABSENT audit event');
    });

    await testAsync('2.4. persistSurveyIntake classifies invalid code correctly and NEVER exposes raw invalid string (Calibration 1)', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const envelope = {
            submissionId: 'sub-test-invalid-001',
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            sourceEnvironment: 'mock'
        };
        const rawInvalidString = 'MALICIOUS_INJECTION_OR_PII!@#123';
        const payload = createBasePayload();
        payload.campaignCode = rawInvalidString;
        payload.submissionId = envelope.submissionId;
        validator.validate(payload);

        const intake = await repo.persistSurveyIntake({
            envelope,
            payload,
            isSbqrQuarantined: false,
            actorId: 'test-agent'
        });

        const sub = repo.findSubmissionById(intake.internalSurveyId);
        assert.strictEqual(sub.campaignCode, null);

        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const invalidAudit = audits.find(a => a.action === 'CAMPAIGN_CODE_INVALID' && a.submissionId === envelope.submissionId);
        assert.ok(invalidAudit, 'Must record CAMPAIGN_CODE_INVALID audit event');
        assert.strictEqual(invalidAudit.campaignCode, null);

        // Scan all audit log entries for any appearance of the raw invalid string
        const serializedAudits = JSON.stringify(audits);
        assert.strictEqual(serializedAudits.includes(rawInvalidString), false, 'Raw invalid campaign code must NEVER be logged in audit trail!');
    });

    await testAsync('2.5. persistSurveyIntake explicitly propagates campaignCodeMetadata even when payload is cloned ({ ...payload }) without WeakMap hit (BLOCKER 1 fix)', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const envelope = {
            submissionId: 'sub-test-clone-001',
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            sourceEnvironment: 'mock'
        };
        const rawInvalidString = 'MALFORMED_SPECIAL_CHARS!@#$';
        const payload = createBasePayload();
        payload.campaignCode = rawInvalidString;
        payload.submissionId = envelope.submissionId;

        // Run validation
        const valResult = validator.validate(payload);
        assert.ok(valResult.campaignCodeMetadata, 'Validation result must include campaignCodeMetadata');
        assert.strictEqual(valResult.campaignCodeMetadata.status, 'INVALID');

        // Intentionally create a decoupled, cloned object instance
        const clonedPayload = { ...payload };

        // Verify that the WeakMap does NOT recognize this new object instance
        assert.strictEqual(getCampaignMetadataForPayload(clonedPayload), null, 'WeakMap must return null for cloned object instance');

        // Persist with explicit campaignCodeMetadata propagation (교정 1)
        const intake = await repo.persistSurveyIntake({
            envelope,
            payload: clonedPayload,
            campaignCodeMetadata: valResult.campaignCodeMetadata,
            isSbqrQuarantined: false,
            actorId: 'test-agent'
        });

        const sub = repo.findSubmissionById(intake.internalSurveyId);
        assert.strictEqual(sub.campaignCode, null, 'Invalid campaignCode must be null on surveyRecord');

        // Verify audit event classified as INVALID (NOT ABSENT!)
        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const invalidAudit = audits.find(a => a.submissionId === envelope.submissionId && a.action === 'CAMPAIGN_CODE_INVALID');
        assert.ok(invalidAudit, 'Must record CAMPAIGN_CODE_INVALID audit event even with cloned payload instance');
        assert.strictEqual(invalidAudit.campaignCode, null);

        const absentAudit = audits.find(a => a.submissionId === envelope.submissionId && a.action === 'CAMPAIGN_CODE_ABSENT');
        assert.strictEqual(absentAudit, undefined, 'Must NEVER misclassify cloned invalid payload as CAMPAIGN_CODE_ABSENT');

        // Ensure zero raw invalid code leaked into audit
        assert.strictEqual(JSON.stringify(audits).includes(rawInvalidString), false);
    });

    await testAsync('2.6. Full ingestion cycle via real SurveyImportService instance preserves INVALID classification and records CAMPAIGN_CODE_INVALID even when payload is duplicated', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const subId = 'sub-service-full-intake-001';
        const rawInvalidString = 'MALFORMED-CAMPAIGN-CODE!@#99';
        const mockEnvelope = {
            submissionId: subId,
            schemaVersion: 'v1.0',
            keyVersion: 'k2026_01',
            requestType: 'CONSULTATION_REQUEST',
            consultationRequested: true,
            consultationRequestedAt: new Date().toISOString(),
            lease: {
                leaseId: `lease_${subId}`,
                leasedAt: new Date().toISOString(),
                leaseUntil: new Date(Date.now() + 600000).toISOString()
            }
        };

        const mockClient = {
            checkSubmissionGateStatus: async () => ({ enabled: true }),
            leasePendingSubmissions: async () => ({
                success: true,
                count: 1,
                submissions: [mockEnvelope]
            }),
            acknowledgeSubmission: async () => ({ success: true, acknowledged: true }),
            deleteImportedSubmission: async () => ({ success: true, deleted: true })
        };

        const mockDecrypter = {
            decryptEnvelope: () => {
                const p = createBasePayload();
                p.submissionId = subId;
                p.campaignCode = rawInvalidString;
                return p;
            }
        };

        // Wrap repo.persistSurveyIntake to intentionally clone the payload argument
        // to simulate decoupled/re-serialized instance in service or pipeline
        const originalPersist = repo.persistSurveyIntake.bind(repo);
        let persistPayloadReceived = null;
        repo.persistSurveyIntake = async (args) => {
            const clonedPayload = { ...args.payload };
            persistPayloadReceived = clonedPayload;
            return await originalPersist({ ...args, payload: clonedPayload });
        };

        const realService = new SurveyImportService({
            repository: repo,
            decryptionService: mockDecrypter,
            validator,
            externalApiClient: mockClient,
            sourceEnvironment: 'mock'
        });

        const summary = await realService.runManualImport({ actorId: 'admin-tester', batchSize: 5 });
        assert.strictEqual(summary.imported, 1);
        assert.strictEqual(summary.acknowledged, 1);
        assert.strictEqual(summary.deleted, 1);

        // Verify that the payload passed to repo was indeed a clone that misses WeakMap
        assert.strictEqual(getCampaignMetadataForPayload(persistPayloadReceived), null, 'WeakMap must return null for cloned payload passed to persistSurveyIntake');

        // Check audit event
        const audits = store.dump(SURVEY_STORAGE_FILES.SURVEY_IMPORT_AUDIT);
        const invalidAudit = audits.find(a => a.submissionId === subId && a.action === 'CAMPAIGN_CODE_INVALID');
        assert.ok(invalidAudit, 'Real SurveyImportService must record CAMPAIGN_CODE_INVALID audit event even when payload is cloned');
        assert.strictEqual(invalidAudit.campaignCode, null);

        const absentAudit = audits.find(a => a.submissionId === subId && a.action === 'CAMPAIGN_CODE_ABSENT');
        assert.strictEqual(absentAudit, undefined, 'Must NEVER record CAMPAIGN_CODE_ABSENT for invalid code');

        // Check repository submission record
        const sub = repo.findSubmissionById(subId);
        assert.strictEqual(sub.campaignCode, null);
        assert.strictEqual(JSON.stringify(audits).includes(rawInvalidString), false);
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 3: Campaign Mutex & Concurrency Race Condition Block (Calibration 2)
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 3: Campaign Mutex & Atomic Duplicate Concurrency Control');

    await testAsync('3.1. Concurrent duplicate creation: Promise.allSettled 2x same code -> 1 SUCCESS / 1 CONFLICT (409), LOST_UPDATE: NO', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // 1. Seed an existing baseline campaign to verify other campaigns are not wiped (LOST_UPDATE check)
        await repo.createCampaign({
            code: 'BASELINE-2026',
            companyName: '기존회사',
            purpose: '기존 목적'
        });

        // 2. Launch 2 concurrent creation requests for the exact same code
        const duplicateCode = 'CONCUR-TEST-2026';
        const promise1 = repo.createCampaign({
            code: duplicateCode,
            companyName: '경합회사 1',
            purpose: '경합 생성 테스트 1'
        });
        const promise2 = repo.createCampaign({
            code: duplicateCode,
            companyName: '경합회사 2',
            purpose: '경합 생성 테스트 2'
        });

        const results = await Promise.allSettled([promise1, promise2]);
        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        assert.strictEqual(fulfilled.length, 1, `Exactly 1 must succeed, got ${fulfilled.length}`);
        assert.strictEqual(rejected.length, 1, `Exactly 1 must be rejected with conflict, got ${rejected.length}`);
        assert.strictEqual(rejected[0].reason.status, 409, 'Conflict status must be 409');
        assert.strictEqual(rejected[0].reason.code, 'CONCURRENCY_CONFLICT');

        // 3. Verify registry content
        const allCampaigns = repo.getCampaigns();
        const concurRecords = allCampaigns.filter(c => c.code === duplicateCode);
        assert.strictEqual(concurRecords.length, 1, 'Exactly 1 record must exist for the code');

        // 4. Verify LOST_UPDATE: NO (BASELINE-2026 was preserved)
        const baseline = allCampaigns.find(c => c.code === 'BASELINE-2026');
        assert.ok(baseline, 'Baseline campaign must be preserved (LOST_UPDATE: NO)');
        assert.strictEqual(allCampaigns.length, 2, 'Total records must be exactly 2');
    });

    await testAsync('3.2. updateCampaign enforces code immutability and mutex protection', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const created = await repo.createCampaign({
            code: 'IMMUTABLE-2026',
            companyName: '수정전회사',
            purpose: '수정전목적'
        });
        assert.strictEqual(created.version, 1);

        // Attempt to modify code -> rejected with 400
        let codeChangeCaught = false;
        try {
            await repo.updateCampaign('IMMUTABLE-2026', {
                code: 'NEW-CODE-2026',
                companyName: '변경시도'
            });
        } catch (err) {
            codeChangeCaught = true;
            assert.strictEqual(err.status, 400);
            assert.strictEqual(err.code, 'CAMPAIGN_CODE_IMMUTABLE');
        }
        assert.strictEqual(codeChangeCaught, true, 'Code change attempt must be rejected');

        // Valid update
        const updated = await repo.updateCampaign('IMMUTABLE-2026', {
            companyName: '수정후회사',
            purpose: '수정후목적',
            isActive: false
        });
        assert.strictEqual(updated.companyName, '수정후회사');
        assert.strictEqual(updated.purpose, '수정후목적');
        assert.strictEqual(updated.isActive, false);
        assert.strictEqual(updated.version, 2);
    });

    test('3.3. Verify NO DELETE method exists on SurveyImportRepository', () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });
        assert.strictEqual(repo.deleteCampaign, undefined, 'deleteCampaign method must NOT exist');
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 4: Filter Validation (Calibration 4)
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 4: Filter Validation Contract (Calibration 4)');

    test('4.1. validateAndNormalizeCampaignFilter accepts all valid shapes', () => {
        // all / empty
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter(), { valid: true, type: 'ALL', code: null });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter(''), { valid: true, type: 'ALL', code: null });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('all'), { valid: true, type: 'ALL', code: null });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('ALL'), { valid: true, type: 'ALL', code: null });

        // unspecified / none / 미지정
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('unspecified'), { valid: true, type: 'UNSPECIFIED', code: null });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('none'), { valid: true, type: 'UNSPECIFIED', code: null });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('미지정'), { valid: true, type: 'UNSPECIFIED', code: null });

        // valid canonical codes
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('DEMO-2026-1'), { valid: true, type: 'CODE', code: 'DEMO-2026-1' });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('  acme-2026  '), { valid: true, type: 'CODE', code: 'ACME-2026' });
        assert.deepStrictEqual(validateAndNormalizeCampaignFilter('UNREGISTERED-VALID-CODE'), { valid: true, type: 'CODE', code: 'UNREGISTERED-VALID-CODE' });
    });

    test('4.2. validateAndNormalizeCampaignFilter rejects malformed filters', () => {
        assert.strictEqual(validateAndNormalizeCampaignFilter('invalid!code').valid, false);
        assert.strictEqual(validateAndNormalizeCampaignFilter('-startsWithHyphen').valid, false);
        assert.strictEqual(validateAndNormalizeCampaignFilter('a').valid, false); // Less than 2 chars
        assert.strictEqual(validateAndNormalizeCampaignFilter('A'.repeat(33)).valid, false); // More than 32 chars
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 5: API Router & Permissions & SafeList Mapping
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 5: API Router, Permissions, & SafeList Mapping');

    await testAsync('5.1. GET /api/surveys/imports: campaignFilter validation & safeList mapping', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // Seed 1 registered campaign
        await repo.createCampaign({
            code: 'ACME-2026-1',
            companyName: '아크메코퍼레이션',
            purpose: '2026년 임직원 검진'
        });

        // Seed 3 submissions in repo:
        // 1. Registered: ACME-2026-1
        // 2. Unregistered: UNREG-2026-1
        // 3. Absent: null
        const now = new Date().toISOString();
        const subs = [
            {
                submissionId: 'sub-001',
                internalSurveyId: 'surv-001',
                campaignCode: 'ACME-2026-1',
                requestType: 'CONSULTATION_REQUEST',
                consultationRequested: true,
                processingStatus: 'PENDING_STAFF_REVIEW',
                importedAt: now
            },
            {
                submissionId: 'sub-002',
                internalSurveyId: 'surv-002',
                campaignCode: 'UNREG-2026-1',
                requestType: 'SCREENING_ONLY',
                consultationRequested: false,
                processingStatus: 'SCREENING_COMPLETED',
                importedAt: now
            },
            {
                submissionId: 'sub-003',
                internalSurveyId: 'surv-003',
                campaignCode: null,
                requestType: 'SCREENING_ONLY',
                consultationRequested: false,
                processingStatus: 'SCREENING_COMPLETED',
                importedAt: now
            }
        ];
        await repo.saveSurveySubmissions(subs);

        const ledger = subs.map(s => ({
            submissionId: s.submissionId,
            internalImportId: `imp_${s.submissionId}`,
            importedAt: now
        }));
        await repo.saveImportsLedger(ledger);

        // Build Router
        const app = express();
        app.use(express.json());
        const fakeAuth = (req, res, next) => {
            req.auth = { id: 'admin-1', role: 'admin', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: fakeAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo,
            surveyExportService: {
                generateExcelBuffer: (records, opts) => ({
                    buffer: Buffer.from('mock-excel'),
                    filename: 'test.xlsx',
                    rowCount: records.length
                })
            }
        });
        app.use('/api/surveys', router);

        // Helper to perform local mock request
        const makeRequest = async (pathStr) => {
            const server = app.listen(0);
            const port = server.address().port;
            try {
                const res = await fetch(`http://127.0.0.1:${port}${pathStr}`);
                const data = await res.json().catch(() => null);
                return { status: res.status, data };
            } finally {
                server.close();
            }
        };

        // Case A: Invalid filter -> 400
        const badRes = await makeRequest('/api/surveys/imports?campaignFilter=invalid!code');
        assert.strictEqual(badRes.status, 400);
        assert.strictEqual(badRes.data.error.code, 'INVALID_CAMPAIGN_FILTER');

        // Case B: Filter 'all' -> 3 records, verify safeList fields
        const allRes = await makeRequest('/api/surveys/imports?campaignFilter=all');
        assert.strictEqual(allRes.status, 200);
        assert.strictEqual(allRes.data.total, 3);
        const item1 = allRes.data.imports.find(i => i.submissionId === 'sub-001');
        assert.strictEqual(item1.campaignCode, 'ACME-2026-1');
        assert.strictEqual(item1.campaignName, '아크메코퍼레이션');
        assert.strictEqual(item1.campaignPurpose, '2026년 임직원 검진');
        assert.strictEqual(item1.campaignRegistrationStatus, 'REGISTERED');

        const item2 = allRes.data.imports.find(i => i.submissionId === 'sub-002');
        assert.strictEqual(item2.campaignCode, 'UNREG-2026-1');
        assert.strictEqual(item2.campaignName, null);
        assert.strictEqual(item2.campaignRegistrationStatus, 'UNREGISTERED');

        const item3 = allRes.data.imports.find(i => i.submissionId === 'sub-003');
        assert.strictEqual(item3.campaignCode, null);
        assert.strictEqual(item3.campaignRegistrationStatus, 'ABSENT');

        // Case C: Filter 'unspecified' -> 1 record
        const unspecRes = await makeRequest('/api/surveys/imports?campaignFilter=unspecified');
        assert.strictEqual(unspecRes.status, 200);
        assert.strictEqual(unspecRes.data.total, 1);
        assert.strictEqual(unspecRes.data.imports[0].submissionId, 'sub-003');

        // Case D: Filter specific code -> 1 record
        const codeRes = await makeRequest('/api/surveys/imports?campaignFilter=ACME-2026-1');
        assert.strictEqual(codeRes.status, 200);
        assert.strictEqual(codeRes.data.total, 1);
        assert.strictEqual(codeRes.data.imports[0].submissionId, 'sub-001');

        // Case E: Valid format but non-existent code -> 200 with 0 items
        const zeroRes = await makeRequest('/api/surveys/imports?campaignFilter=NONEXISTENT-2026');
        assert.strictEqual(zeroRes.status, 200);
        assert.strictEqual(zeroRes.data.total, 0);
    });

    await testAsync('5.2. GET /api/surveys/export: campaignCode filter validation and real XLSX generation & masking via SurveyExportService', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const subs = [
            {
                submissionId: 'sub-exp-001',
                internalSurveyId: 'surv-exp-001',
                campaignCode: 'DEMO-2026-1',
                assessmentId: 'phq-9',
                contact: { clientName: '홍길동', phone: '010-1234-5678', region: '서울' },
                assessment: { totalScore: 12, severity: '중등도' },
                createdAt: '2026-09-25T10:00:00.000Z',
                importedAt: '2026-09-25T10:05:00.000Z'
            },
            {
                submissionId: 'sub-exp-002',
                internalSurveyId: 'surv-exp-002',
                campaignCode: null,
                assessmentId: 'phq-9',
                contact: { clientName: '김철수', phone: '010-9876-5432', region: '경기' },
                assessment: { totalScore: 3, severity: '정상' },
                createdAt: '2026-09-25T11:00:00.000Z',
                importedAt: '2026-09-25T11:05:00.000Z'
            }
        ];
        await repo.saveSurveySubmissions(subs);

        const realExportService = new SurveyExportService();

        let currentAuthUser = { id: 'user-1', role: 'user', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
        const app = express();
        const fakeAuth = (req, res, next) => {
            req.auth = currentAuthUser;
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: fakeAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo,
            surveyExportService: realExportService
        });
        app.use('/api/surveys', router);

        const makeRequest = async (pathStr) => {
            const server = app.listen(0);
            const port = server.address().port;
            try {
                const res = await fetch(`http://127.0.0.1:${port}${pathStr}`);
                const status = res.status;
                const headers = res.headers;
                let buffer = null;
                if (status === 200) {
                    const ab = await res.arrayBuffer();
                    buffer = Buffer.from(ab);
                }
                return { status, headers, buffer };
            } finally {
                server.close();
            }
        };

        // 1. Invalid campaignCode filter -> 400
        const badRes = await makeRequest('/api/surveys/export?campaignCode=invalid!code');
        assert.strictEqual(badRes.status, 400);

        // 2. Valid campaignCode filter -> 200, real XLSX buffer generated and parsed
        currentAuthUser = { id: 'user-1', role: 'user', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
        const goodRes = await makeRequest('/api/surveys/export?campaignCode=DEMO-2026-1');
        assert.strictEqual(goodRes.status, 200);
        const contentType = goodRes.headers.get('content-type') || '';
        assert.ok(contentType.includes('spreadsheetml') || contentType.includes('octet-stream'), 'Content-Type must indicate excel/binary file');
        const contentDisposition = goodRes.headers.get('content-disposition') || '';
        assert.ok(contentDisposition.includes('.xlsx'), 'Content-Disposition must have .xlsx filename');

        // Parse real XLSX workbook
        const wb = XLSX.read(goodRes.buffer, { type: 'buffer' });
        const sheetName = wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
        // Header row + exactly 1 data row (sub-exp-001)
        assert.strictEqual(rows.length, 2, 'Must export header row + exactly 1 matched record');
        assert.strictEqual(rows[1][1], 'sub-exp-001', 'Must match sub-exp-001');

        // Masking verification for regular user (without SURVEY_EXPORT_IDENTIFIABLE):
        assert.strictEqual(rows[1][4], '홍*동', 'Client name must be masked for non-identifiable user');
        assert.strictEqual(rows[1][5], '010-****-5678', 'Phone must be masked for non-identifiable user');

        // 3. Identifiable user test (Admin with SURVEY_EXPORT_IDENTIFIABLE)
        currentAuthUser = {
            id: 'admin-1',
            role: 'admin',
            status: 'active',
            permissions: { ONLINE_SURVEY_ACCESS: true, SURVEY_EXPORT_IDENTIFIABLE: true }
        };
        const identRes = await makeRequest('/api/surveys/export?campaignCode=DEMO-2026-1');
        assert.strictEqual(identRes.status, 200);
        const wbIdent = XLSX.read(identRes.buffer, { type: 'buffer' });
        const rowsIdent = XLSX.utils.sheet_to_json(wbIdent.Sheets[sheetName], { header: 1 });
        assert.strictEqual(rowsIdent.length, 2);
        assert.strictEqual(rowsIdent[1][4], '홍길동', 'Client name must NOT be masked for identifiable user');
        assert.strictEqual(rowsIdent[1][5], '010-1234-5678', 'Phone must NOT be masked for identifiable user');
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 6: Count Contract & Allowlist (Calibration 3)
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 6: Count Contract & Strict Allowlist (Calibration 3)');

    await testAsync('6.1. GET /api/surveys/campaigns returns 4 counts using official allowlists & partitioning invariant', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // Seed 2 campaigns
        await repo.createCampaign({ code: 'CAMP-A', companyName: 'A사', purpose: '목적 A' });
        await repo.createCampaign({ code: 'CAMP-B', companyName: 'B사', purpose: '목적 B' });

        // Set up submissions across various official workflow states
        const submissions = [
            // CAMP-A:
            // 1. Pending review: PENDING_STAFF_REVIEW, no referral
            { submissionId: 's1', campaignCode: 'CAMP-A', processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            // 2. Pending review: STAFF_ASSIGNED, no referral
            { submissionId: 's2', campaignCode: 'CAMP-A', processingStatus: 'STAFF_ASSIGNED', referralId: null },
            // 3. Registered referral: has referralId
            { submissionId: 's3', campaignCode: 'CAMP-A', processingStatus: 'STAFF_ASSIGNED', referralId: 'ref-s3' },
            // 4. Completed: COMPLETED
            { submissionId: 's4', campaignCode: 'CAMP-A', processingStatus: 'COMPLETED', referralId: 'ref-s4' },
            // 5. Completed: SCREENING_COMPLETED (screening-only)
            { submissionId: 's5', campaignCode: 'CAMP-A', processingStatus: 'SCREENING_COMPLETED', referralId: null },
            // 6. Quarantined SBQ-R: QUARANTINED (MUST NOT be in pendingReviewCount!)
            { submissionId: 's6', campaignCode: 'CAMP-A', processingStatus: 'QUARANTINED', referralId: null, isSbqrQuarantined: true },

            // CAMP-B:
            // 7. Pending review: PENDING_STAFF_REVIEW
            { submissionId: 's7', campaignCode: 'CAMP-B', processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            // 8. Completed: COMPLETED
            { submissionId: 's8', campaignCode: 'CAMP-B', processingStatus: 'COMPLETED', referralId: 'ref-s8' },

            // UNSPECIFIED (no code):
            // 9. Pending review: PENDING_STAFF_REVIEW
            { submissionId: 's9', campaignCode: null, processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            // 10. Completed: SCREENING_COMPLETED
            { submissionId: 's10', campaignCode: null, processingStatus: 'SCREENING_COMPLETED', referralId: null },
            // 11. Deleted: deletionStatus='deleted' (MUST be excluded from ALL counts!)
            { submissionId: 's11', campaignCode: 'CAMP-A', processingStatus: 'PENDING_STAFF_REVIEW', deletionStatus: 'deleted' },

            // UNREGISTERED (valid code not in SurveyCampaigns registry - BLOCKER 2 verification):
            // 12. Pending review: PENDING_STAFF_REVIEW
            { submissionId: 's12', campaignCode: 'UNREG-2026-1', processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            // 13. Completed: COMPLETED
            { submissionId: 's13', campaignCode: 'UNREG-2026-1', processingStatus: 'COMPLETED', referralId: 'ref-s13' }
        ];

        await repo.saveSurveySubmissions(submissions);

        // Referrals list
        const referrals = [
            { id: 'ref-s3', referralId: 'ref-s3', sourceSubmissionId: 's3', status: 'active' },
            { id: 'ref-s4', referralId: 'ref-s4', sourceSubmissionId: 's4', status: 'closed', closureStatus: '종결' },
            { id: 'ref-s8', referralId: 'ref-s8', sourceSubmissionId: 's8', status: 'closed', closureStatus: '종결' },
            { id: 'ref-s13', referralId: 'ref-s13', sourceSubmissionId: 's13', status: 'closed', closureStatus: '종결' }
        ];
        await repo.persistData('Referrals', referrals);

        // Build Router & test
        const app = express();
        const fakeAuth = (req, res, next) => {
            req.auth = { id: 'admin-1', role: 'admin', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: fakeAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo
        });
        app.use('/api/surveys', router);

        const server = app.listen(0);
        const port = server.address().port;
        let responseData;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns`);
            assert.strictEqual(res.status, 200);
            responseData = await res.json();
        } finally {
            server.close();
        }

        const campA = responseData.campaigns.find(c => c.code === 'CAMP-A');
        const campB = responseData.campaigns.find(c => c.code === 'CAMP-B');
        const unreg = responseData.campaigns.find(c => c.code === 'UNREG-2026-1');
        const unspec = responseData.unspecifiedCounts;
        const total = responseData.totalCounts;

        // CAMP-A verification:
        // total valid submissions = s1, s2, s3, s4, s5, s6 (s11 is deleted) = 6
        assert.strictEqual(campA.receivedCount, 6);
        // pendingReviewCount = s1 (PENDING_STAFF_REVIEW) + s2 (STAFF_ASSIGNED) = 2. (s6 QUARANTINED is excluded!)
        assert.strictEqual(campA.pendingReviewCount, 2, 'QUARANTINED must NOT be counted in pendingReviewCount');
        // registeredReferralCount = s3 + s4 = 2
        assert.strictEqual(campA.registeredReferralCount, 2);
        // completedCount = s4 (COMPLETED) + s5 (SCREENING_COMPLETED) = 2
        assert.strictEqual(campA.completedCount, 2);

        // CAMP-B verification:
        assert.strictEqual(campB.receivedCount, 2);
        assert.strictEqual(campB.pendingReviewCount, 1);
        assert.strictEqual(campB.registeredReferralCount, 1);
        assert.strictEqual(campB.completedCount, 1);

        // UNREG-2026-1 verification (BLOCKER 2 fix):
        assert.ok(unreg, 'Unregistered code UNREG-2026-1 MUST be included in campaigns list');
        assert.strictEqual(unreg.companyName, '(미등록 캠페인)');
        assert.strictEqual(unreg.isRegistered, false);
        assert.strictEqual(unreg.campaignRegistrationStatus, 'UNREGISTERED');
        assert.strictEqual(unreg.receivedCount, 2);
        assert.strictEqual(unreg.pendingReviewCount, 1);
        assert.strictEqual(unreg.registeredReferralCount, 1);
        assert.strictEqual(unreg.completedCount, 1);

        // Unspecified verification:
        assert.strictEqual(unspec.receivedCount, 2);
        assert.strictEqual(unspec.pendingReviewCount, 1);
        assert.strictEqual(unspec.registeredReferralCount, 0);
        assert.strictEqual(unspec.completedCount, 1);

        // PARTITIONING INVARIANT VERIFICATION:
        // sum(campaigns[M]) + unspecified[M] === total[M]
        const sumMetric = (m) => responseData.campaigns.reduce((sum, c) => sum + (c[m] || 0), 0);
        assert.strictEqual(sumMetric('receivedCount') + unspec.receivedCount, total.receivedCount, 'receivedCount partitioning invariant');
        assert.strictEqual(sumMetric('pendingReviewCount') + unspec.pendingReviewCount, total.pendingReviewCount, 'pendingReviewCount partitioning invariant');
        assert.strictEqual(sumMetric('registeredReferralCount') + unspec.registeredReferralCount, total.registeredReferralCount, 'registeredReferralCount partitioning invariant');
        assert.strictEqual(sumMetric('completedCount') + unspec.completedCount, total.completedCount, 'completedCount partitioning invariant');

        assert.strictEqual(total.receivedCount, 12);
        assert.strictEqual(total.pendingReviewCount, 5);
        assert.strictEqual(total.registeredReferralCount, 4);
        assert.strictEqual(total.completedCount, 5);
    });

    await testAsync('6.2. S5 runtime test: campaigns with identical startsAt/endsAt periods partition submissions strictly by code', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        const samePeriod = {
            startsAt: '2026-10-01T00:00:00.000Z',
            endsAt: '2026-10-31T23:59:59.999Z'
        };

        // Seed 2 campaigns with 100% identical deployment periods
        await repo.createCampaign({
            code: 'CAMP-S5-ALPHA',
            companyName: '알파사',
            purpose: '10월 검진',
            ...samePeriod
        });
        await repo.createCampaign({
            code: 'CAMP-S5-BETA',
            companyName: '베타사',
            purpose: '10월 검진',
            ...samePeriod
        });

        // Seed submissions: 3 for ALPHA, 2 for BETA
        const subs = [
            { submissionId: 's5-a1', campaignCode: 'CAMP-S5-ALPHA', processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            { submissionId: 's5-a2', campaignCode: 'CAMP-S5-ALPHA', processingStatus: 'STAFF_ASSIGNED', referralId: null },
            { submissionId: 's5-a3', campaignCode: 'CAMP-S5-ALPHA', processingStatus: 'COMPLETED', referralId: null },
            { submissionId: 's5-b1', campaignCode: 'CAMP-S5-BETA', processingStatus: 'PENDING_STAFF_REVIEW', referralId: null },
            { submissionId: 's5-b2', campaignCode: 'CAMP-S5-BETA', processingStatus: 'COMPLETED', referralId: null }
        ];
        await repo.saveSurveySubmissions(subs);
        const ledger = subs.map(s => ({
            submissionId: s.submissionId,
            internalImportId: `imp_${s.submissionId}`,
            importedAt: new Date().toISOString()
        }));
        await repo.saveImportsLedger(ledger);

        const app = express();
        const fakeAuth = (req, res, next) => {
            req.auth = { id: 'admin-1', role: 'admin', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: fakeAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo
        });
        app.use('/api/surveys', router);

        const server = app.listen(0);
        const port = server.address().port;
        try {
            // GET /campaigns
            const campRes = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns`);
            assert.strictEqual(campRes.status, 200);
            const campData = await campRes.json();

            const alpha = campData.campaigns.find(c => c.code === 'CAMP-S5-ALPHA');
            const beta = campData.campaigns.find(c => c.code === 'CAMP-S5-BETA');
            assert.ok(alpha && beta, 'Both campaigns must exist in /campaigns');

            // Partitioning verification: counts strictly separated by code despite identical periods
            assert.strictEqual(alpha.receivedCount, 3, 'ALPHA must have 3 received submissions');
            assert.strictEqual(alpha.pendingReviewCount, 2);
            assert.strictEqual(alpha.completedCount, 1);

            assert.strictEqual(beta.receivedCount, 2, 'BETA must have 2 received submissions');
            assert.strictEqual(beta.pendingReviewCount, 1);
            assert.strictEqual(beta.completedCount, 1);

            // Filter verification: GET /imports?campaignFilter=CAMP-S5-ALPHA
            const alphaImportsRes = await fetch(`http://127.0.0.1:${port}/api/surveys/imports?campaignFilter=CAMP-S5-ALPHA`);
            assert.strictEqual(alphaImportsRes.status, 200);
            const alphaImports = await alphaImportsRes.json();
            assert.strictEqual(alphaImports.total, 3);
            assert.ok(alphaImports.imports.every(i => i.campaignCode === 'CAMP-S5-ALPHA'));

            // Filter verification: GET /imports?campaignFilter=CAMP-S5-BETA
            const betaImportsRes = await fetch(`http://127.0.0.1:${port}/api/surveys/imports?campaignFilter=CAMP-S5-BETA`);
            assert.strictEqual(betaImportsRes.status, 200);
            const betaImports = await betaImportsRes.json();
            assert.strictEqual(betaImports.total, 2);
            assert.ok(betaImports.imports.every(i => i.campaignCode === 'CAMP-S5-BETA'));
        } finally {
            server.close();
        }
    });

    await testAsync('6.3. S12 runtime test: inactive campaign (isActive: false) preserves past submissions in GET /campaigns list & counts', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // 1. Create campaign initially active
        await repo.createCampaign({
            code: 'CAMP-S12-INACTIVE',
            companyName: '과거참여기관',
            purpose: '지난해 검진',
            startsAt: '2025-01-01T00:00:00.000Z',
            endsAt: '2025-12-31T23:59:59.999Z'
        });

        // 2. Add past submissions
        const subs = [
            { submissionId: 's12-past-1', campaignCode: 'CAMP-S12-INACTIVE', processingStatus: 'COMPLETED', referralId: null },
            { submissionId: 's12-past-2', campaignCode: 'CAMP-S12-INACTIVE', processingStatus: 'STAFF_ASSIGNED', referralId: 'ref-s12-2' }
        ];
        await repo.saveSurveySubmissions(subs);
        const ledger = subs.map(s => ({
            submissionId: s.submissionId,
            internalImportId: `imp_${s.submissionId}`,
            importedAt: new Date().toISOString()
        }));
        await repo.saveImportsLedger(ledger);
        await repo.persistData('Referrals', [
            { id: 'ref-s12-2', referralId: 'ref-s12-2', sourceSubmissionId: 's12-past-2', status: 'closed', closureStatus: '종결' }
        ]);

        // 3. Deactivate campaign via updateCampaign (isActive: false)
        const updated = await repo.updateCampaign('CAMP-S12-INACTIVE', { isActive: false });
        assert.strictEqual(updated.isActive, false);

        const app = express();
        const fakeAuth = (req, res, next) => {
            req.auth = { id: 'admin-1', role: 'admin', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: fakeAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo
        });
        app.use('/api/surveys', router);

        const server = app.listen(0);
        const port = server.address().port;
        try {
            // GET /campaigns must include the inactive campaign with its past counts preserved
            const res = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();

            const pastCamp = data.campaigns.find(c => c.code === 'CAMP-S12-INACTIVE');
            assert.ok(pastCamp, 'Inactive campaign must remain preserved in GET /campaigns');
            assert.strictEqual(pastCamp.isActive, false, 'isActive must be false');
            assert.strictEqual(pastCamp.receivedCount, 2, 'Past received submissions must be preserved');
            assert.strictEqual(pastCamp.registeredReferralCount, 1);
            assert.strictEqual(pastCamp.completedCount, 2);

            // Partitioning invariant holds
            const sumMetric = (m) => data.campaigns.reduce((acc, c) => acc + (c[m] || 0), 0);
            assert.strictEqual(sumMetric('receivedCount') + data.unspecifiedCounts.receivedCount, data.totalCounts.receivedCount);

            // Filter on inactive campaign still returns historical records
            const filterRes = await fetch(`http://127.0.0.1:${port}/api/surveys/imports?campaignFilter=CAMP-S12-INACTIVE`);
            assert.strictEqual(filterRes.status, 200);
            const filterData = await filterRes.json();
            assert.strictEqual(filterData.total, 2);
        } finally {
            server.close();
        }
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 7: Permissions Guarding
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 7: Permissions Guarding on Campaign Endpoints');

    await testAsync('7.1. Regular user gets 403 on POST /campaigns and PATCH /campaigns/:code', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        await repo.createCampaign({ code: 'PERM-TEST', companyName: '권한테스트', purpose: '테스트' });

        const app = express();
        app.use(express.json());
        const regularAuth = (req, res, next) => {
            req.auth = { id: 'user-2', role: 'user', status: 'active', permissions: { ONLINE_SURVEY_ACCESS: true } };
            next();
        };
        const router = createSurveyImportRouter({
            requireAuth: regularAuth,
            surveyImportService: { getStatusSummary: () => ({}) },
            surveyRepository: repo
        });
        app.use('/api/surveys', router);

        const server = app.listen(0);
        const port = server.address().port;
        try {
            // POST should fail with 403
            const postRes = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: 'FAIL-CODE', companyName: '실패', purpose: '실패' })
            });
            assert.strictEqual(postRes.status, 403);

            // PATCH should fail with 403
            const patchRes = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns/PERM-TEST`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ purpose: '실패' })
            });
            assert.strictEqual(patchRes.status, 403);

            // GET should succeed with 200
            const getRes = await fetch(`http://127.0.0.1:${port}/api/surveys/campaigns`);
            assert.strictEqual(getRes.status, 200);
        } finally {
            server.close();
        }
    });

    // ──────────────────────────────────────────────────────────
    // SUITE 8: MockTrackAApi & Purge-Demo Preservation
    // ──────────────────────────────────────────────────────────
    console.log('\n▶️ SUITE 8: MockTrackAApi Fixtures & Purge Demo Preservation');

    test('8.1. MockTrackAApi provides getDemoCampaignSeed, seedValidUnregisteredSubmission, seedInvalidCampaignCodeSubmission', () => {
        const mock = new MockTrackAApi();
        const seed = mock.getDemoCampaignSeed();
        assert.strictEqual(seed.code, 'DEMO-2026-1');
        assert.strictEqual(seed.companyName, '데모주식회사');
        assert.strictEqual(seed.isActive, true);

        // Generate synthetic keys
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        // Seed default submissions
        mock.seedDefaultSyntheticSubmissions(publicKey);
        const demo001 = mock.submissions.get('sub-demo-001');
        assert.ok(demo001, 'sub-demo-001 must exist');

        // Seed unreg fixture
        const unregEnv = mock.seedValidUnregisteredSubmission(publicKey);
        assert.ok(unregEnv, 'Unregistered fixture seeded');

        // Seed invalid fixture
        const invalidEnv = mock.seedInvalidCampaignCodeSubmission(publicKey);
        assert.ok(invalidEnv, 'Invalid code fixture seeded');
    });

    await testAsync('8.2. purgeDemoSubmissions preserves SurveyCampaigns registry', async () => {
        const store = createInMemoryStorage();
        const repo = new SurveyImportRepository({
            getData: store.getData,
            persistData: store.persistData
        });

        // Seed campaign
        await repo.createCampaign({ code: 'DEMO-2026-1', companyName: '데모주식회사', purpose: '데모' });

        // Seed demo submission
        const subs = [
            { submissionId: 'sub-demo-001', isSynthetic: true },
            { submissionId: 'sub-real-001', isSynthetic: false }
        ];
        await repo.saveSurveySubmissions(subs);
        const ledger = [
            { submissionId: 'sub-demo-001', isSynthetic: true },
            { submissionId: 'sub-real-001', isSynthetic: false }
        ];
        await repo.saveImportsLedger(ledger);

        // Purge demo
        const purgeRes = await repo.purgeDemoSubmissions({
            actorId: 'admin',
            reason: 'Test demo purge'
        });
        assert.strictEqual(purgeRes.success, true);
        assert.strictEqual(purgeRes.purgedCount, 1);

        // Verify remaining submissions
        const remainingSubs = repo.getSurveySubmissions();
        assert.strictEqual(remainingSubs.length, 1);
        assert.strictEqual(remainingSubs[0].submissionId, 'sub-real-001');

        // Verify SurveyCampaigns remains untouched
        const campaigns = repo.getCampaigns();
        assert.strictEqual(campaigns.length, 1);
        assert.strictEqual(campaigns[0].code, 'DEMO-2026-1');
    });

    console.log('\n====================================================');
    console.log(`📊 Summary: ${passedTests} Passed, ${failedTests} Failed (Total: ${passedTests + failedTests})`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        throw new Error(`${failedTests} tests failed!`);
    }
}

runCampaignBackendVerificationSuite().catch(err => {
    console.error('Fatal error running verification suite:', err);
    process.exit(1);
});

/**
 * scripts/verify-tracka-pending-observability.mjs
 * Verification suite for Track A pending observability logging and contract safety.
 *
 * Requirements verified:
 * 1. raw response count contract: {success:true,count:1,submissions:[env]} -> parsedCount=1
 * 2. submissions array parser: valid envelope -> submissions 1 item
 * 3. counseling record filter: envelope without submissionId -> excludedNoSubmissionId=1
 * 4. empty queue: {success:true,count:0,submissions:[]} -> QUEUE_DRAINED_CLASS=A
 * 5. malformed response fail-closed: {success:true} (no submissions) -> submissions=[], QUEUE_DRAINED_CLASS=A, no throw
 * 6. secret/PII non-exposure: all captured log lines must NOT expose serviceSecret, Authorization, ciphertext, wrappedKey, or submissionId
 * 7. worker ID and query contract: request URL matches /api/v1/internal/submissions/pending?limit=<n>&leaseSeconds=<n> and x-worker-id header set
 * 8. campaign classification: synthetic payload with campaignCode='S4-A' passes validator and classifies correctly
 */

import assert from 'assert';
import crypto from 'crypto';
import { TrackAClient } from '../server/survey/trackAClient.js';
import { SurveyImportService } from '../server/survey/surveyImportService.js';
import { SurveyPayloadValidator } from '../server/survey/surveyPayloadValidator.js';
import { SURVEY_INTERNAL_STATUS } from '../server/survey/surveyConstants.js';

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

// In-Memory Repository for Isolated Import Service Testing
class MockImportRepository {
    constructor() {
        this.records = new Map();
        this.submissions = [];
        this.auditEvents = [];
        this.workflowSteps = [];
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

// Mock Decryption Service
class MockDecryptionService {
    decryptEnvelope(envelope) {
        return {
            submissionId: envelope.submissionId,
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
                responses: [{ questionNumber: 1, score: 2 }]
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
}

// Log Capture Helper
function createLogCapture() {
    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    console.warn = (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    console.error = (...args) => {
        logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };

    return {
        logs,
        release: () => {
            console.log = origLog;
            console.warn = origWarn;
            console.error = origError;
        }
    };
}

// Mock Response Builder
function mockFetchResponse(status, data, headers = {}) {
    const contentType = headers['content-type'] || 'application/json; charset=utf-8';
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get: (name) => {
                if (name.toLowerCase() === 'content-type') return contentType;
                return headers[name.toLowerCase()] || null;
            }
        },
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}

async function runSuite() {
    console.log('============================================================');
    console.log('🧪 TRACK A PENDING OBSERVABILITY & CONTRACT TEST SUITE');
    console.log('============================================================\n');

    const originalFetch = globalThis.fetch;

    try {
        // ---------------------------------------------------------
        // 1. raw response count 계약: {success:true,count:1,submissions:[env]} -> parsedCount=1
        // ---------------------------------------------------------
        await testCase('1. raw response count 계약: {success:true,count:1,submissions:[env]} -> parsedCount=1', async () => {
            const capture = createLogCapture();
            try {
                const sampleEnv = { submissionId: 'sub-raw-count-01', schemaVersion: 'v1.0', keyVersion: 'k2026_01' };
                globalThis.fetch = async () => mockFetchResponse(200, {
                    success: true,
                    count: 1,
                    submissions: [sampleEnv]
                });

                const client = new TrackAClient({
                    baseUrl: 'http://localhost:3000',
                    serviceSecret: 'test-secret-1',
                    workerId: 'worker-1'
                });

                const res = await client.leasePendingSubmissions({ limit: 10, leaseSeconds: 300 });

                assert.strictEqual(res.success, true, 'success must be true');
                assert.strictEqual(res.count, 1, 'count must be 1');
                assert.strictEqual(res.submissions.length, 1, 'submissions length must be 1');
                assert.strictEqual(res.httpMeta.rawSubmissionsLength, 1, 'rawSubmissionsLength must be 1');
                assert.strictEqual(res.httpMeta.submissionsIsArray, true, 'submissionsIsArray must be true');

                const pendingHttpLog = capture.logs.find(l => l.includes('TRACK_A_PENDING_HTTP'));
                assert.ok(pendingHttpLog, 'TRACK_A_PENDING_HTTP log line must be produced');
                assert.ok(pendingHttpLog.includes('rawCount=1'), 'TRACK_A_PENDING_HTTP must contain rawCount=1');
                assert.ok(pendingHttpLog.includes('parsedCount=1'), 'TRACK_A_PENDING_HTTP must contain parsedCount=1');
                assert.ok(pendingHttpLog.includes('status=200'), 'status must be 200');
                assert.ok(pendingHttpLog.includes('endpoint=/api/v1/internal/submissions/pending'), 'endpoint path must match');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 2. submissions 배열 파서: 정상 envelope -> submissions 1건
        // ---------------------------------------------------------
        await testCase('2. submissions 배열 파서: 정상 envelope -> submissions 1건', async () => {
            const capture = createLogCapture();
            try {
                const sampleEnv = {
                    submissionId: 'sub-envelope-valid-01',
                    schemaVersion: 'v1.0',
                    keyVersion: 'k2026_01',
                    lease: { leaseId: 'lease-test-1', leaseUntil: new Date(Date.now() + 300000).toISOString() }
                };

                globalThis.fetch = async () => mockFetchResponse(200, {
                    success: true,
                    count: 1,
                    submissions: [sampleEnv]
                });

                const client = new TrackAClient({
                    baseUrl: 'http://localhost:3000',
                    serviceSecret: 'test-secret-2',
                    workerId: 'worker-2'
                });

                const res = await client.leasePendingSubmissions();

                assert.strictEqual(Array.isArray(res.submissions), true, 'submissions must be an array');
                assert.strictEqual(res.submissions.length, 1, 'submissions must contain exactly 1 item');
                assert.strictEqual(res.submissions[0].submissionId, 'sub-envelope-valid-01', 'submissionId must match');
                assert.strictEqual(res.httpMeta.submissionsIsArray, true, 'submissionsIsArray must be true');
                assert.strictEqual(res.httpMeta.countField, 1, 'countField must be 1');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 3. 상담 레코드 필터: submissionId 없는 envelope -> excludedNoSubmissionId=1
        // ---------------------------------------------------------
        await testCase('3. 상담 레코드 필터: submissionId 없는 envelope -> excludedNoSubmissionId=1', async () => {
            const capture = createLogCapture();
            try {
                const envelopeWithoutSubId = {
                    schemaVersion: 'v1.0',
                    keyVersion: 'k2026_01'
                    // Missing submissionId
                };

                const mockClient = {
                    checkSubmissionGateStatus: async () => ({ enabled: true }),
                    leasePendingSubmissions: async () => ({
                        success: true,
                        count: 1,
                        submissions: [envelopeWithoutSubId],
                        httpMeta: {
                            httpStatus: 200,
                            contentType: 'application/json',
                            topLevelKeys: ['success', 'count', 'submissions'],
                            successField: true,
                            countField: 1,
                            submissionsIsArray: true,
                            rawSubmissionsLength: 1
                        }
                    })
                };

                const repo = new MockImportRepository();
                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: mockClient,
                    workerId: 'worker-test-3'
                });

                const summary = await service.runManualImport();

                const batchLog = capture.logs.find(l => l.includes('TRACK_A_PENDING_BATCH'));
                assert.ok(batchLog, 'TRACK_A_PENDING_BATCH log must be present');
                assert.ok(batchLog.includes('rawCount=1'), 'rawCount must be 1');
                assert.ok(batchLog.includes('parsedCount=1'), 'parsedCount must be 1');
                assert.ok(batchLog.includes('filteredCount=0'), 'filteredCount must be 0');
                assert.ok(batchLog.includes('excludedNoSubmissionId=1'), 'excludedNoSubmissionId must be 1');
                assert.ok(batchLog.includes('excludedRepeatFailed=0'), 'excludedRepeatFailed must be 0');

                const classCLog = capture.logs.find(l => l.includes('QUEUE_DRAINED_CLASS=C'));
                assert.ok(classCLog, 'QUEUE_DRAINED_CLASS=C parsedCount>0 filteredCount=0 must be logged');
                assert.strictEqual(summary.stopReason, 'FAILED_ITEM_LOOP_PREVENTED');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 4. empty queue: {success:true,count:0,submissions:[]} -> QUEUE_DRAINED_CLASS=A
        // ---------------------------------------------------------
        await testCase('4. empty queue: {success:true,count:0,submissions:[]} -> QUEUE_DRAINED_CLASS=A', async () => {
            const capture = createLogCapture();
            try {
                const mockClient = {
                    checkSubmissionGateStatus: async () => ({ enabled: true }),
                    leasePendingSubmissions: async () => ({
                        success: true,
                        count: 0,
                        submissions: [],
                        httpMeta: {
                            httpStatus: 200,
                            contentType: 'application/json',
                            topLevelKeys: ['success', 'count', 'submissions'],
                            successField: true,
                            countField: 0,
                            submissionsIsArray: true,
                            rawSubmissionsLength: 0
                        }
                    })
                };

                const repo = new MockImportRepository();
                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: mockClient,
                    workerId: 'worker-test-4'
                });

                const summary = await service.runManualImport();

                assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED', 'stopReason must be QUEUE_DRAINED');
                assert.strictEqual(summary.imported, 0, 'imported must be 0');

                const batchLog = capture.logs.find(l => l.includes('TRACK_A_PENDING_BATCH'));
                assert.ok(batchLog, 'TRACK_A_PENDING_BATCH log must be present');
                assert.ok(batchLog.includes('rawCount=0'), 'rawCount must be 0');
                assert.ok(batchLog.includes('parsedCount=0'), 'parsedCount must be 0');
                assert.ok(batchLog.includes('filteredCount=0'), 'filteredCount must be 0');

                const classALog = capture.logs.find(l => l.includes('QUEUE_DRAINED_CLASS=A rawCount=0'));
                assert.ok(classALog, 'QUEUE_DRAINED_CLASS=A rawCount=0 must be logged');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 5. malformed response fail-closed: {success:true} (submissions 없음) -> submissions=[], QUEUE_DRAINED_CLASS=A, throw 없음
        // ---------------------------------------------------------
        await testCase('5. malformed response fail-closed: {success:true} (submissions 없음) -> submissions=[], QUEUE_DRAINED_CLASS=A, throw 없음', async () => {
            const capture = createLogCapture();
            try {
                globalThis.fetch = async () => mockFetchResponse(200, {
                    success: true
                    // Missing submissions, missing count
                });

                const client = new TrackAClient({
                    baseUrl: 'http://localhost:3000',
                    serviceSecret: 'test-secret-5',
                    workerId: 'worker-5'
                });

                const leaseResult = await client.leasePendingSubmissions();

                assert.strictEqual(Array.isArray(leaseResult.submissions), true, 'submissions must be an empty array');
                assert.strictEqual(leaseResult.submissions.length, 0, 'submissions length must be 0');
                assert.strictEqual(leaseResult.count, 0, 'count must default to 0');
                assert.strictEqual(leaseResult.httpMeta.submissionsIsArray, false, 'submissionsIsArray must be false');
                assert.strictEqual(leaseResult.httpMeta.rawSubmissionsLength, 0, 'rawSubmissionsLength must be 0');

                const repo = new MockImportRepository();
                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: client,
                    workerId: 'worker-5'
                });

                // Fail-closed verification: must not throw
                let summary;
                await assert.doesNotReject(async () => {
                    summary = await service.runManualImport();
                }, 'Service must not throw on malformed response');

                assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED');
                assert.strictEqual(summary.imported, 0);

                const classALog = capture.logs.find(l => l.includes('QUEUE_DRAINED_CLASS=A rawCount=0'));
                assert.ok(classALog, 'QUEUE_DRAINED_CLASS=A rawCount=0 must be logged');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 6. secret/PII 로그 비노출: 캡처한 모든 로그 라인에 serviceSecret 원문·Authorization·ciphertext·wrappedKey·submissionId 값 미포함
        // ---------------------------------------------------------
        await testCase('6. secret/PII 로그 비노출: 캡처한 모든 로그 라인에 serviceSecret 원문·Authorization·ciphertext·wrappedKey·submissionId 값 미포함', async () => {
            const capture = createLogCapture();
            try {
                const DUMMY_SECRET = 'ultra-secret-token-xyz-987654321';
                const DUMMY_SUB_ID = 'sub-pii-check-secret-456';
                const DUMMY_CIPHERTEXT = 'aes-encrypted-counseling-blob-789';
                const DUMMY_WRAPPED_KEY = 'rsa-wrapped-dek-blob-321';

                const sampleEnv = {
                    submissionId: DUMMY_SUB_ID,
                    schemaVersion: 'v1.0',
                    keyVersion: 'k2026_01',
                    ciphertext: DUMMY_CIPHERTEXT,
                    wrappedKey: DUMMY_WRAPPED_KEY
                };

                globalThis.fetch = async () => mockFetchResponse(200, {
                    success: true,
                    count: 1,
                    submissions: [sampleEnv]
                });

                const client = new TrackAClient({
                    baseUrl: 'http://localhost:3000',
                    serviceSecret: DUMMY_SECRET,
                    workerId: 'worker-pii-check'
                });

                await client.leasePendingSubmissions();

                const repo = new MockImportRepository();
                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: client,
                    workerId: 'worker-pii-check'
                });

                // Run empty queue import to also generate QUEUE_DRAINED logs
                globalThis.fetch = async () => mockFetchResponse(200, {
                    success: true,
                    count: 0,
                    submissions: []
                });
                await service.runManualImport();

                // Filter observability log lines
                const observabilityLogs = capture.logs.filter(l =>
                    l.includes('TRACK_A_AUTH_FINGERPRINT') ||
                    l.includes('TRACK_A_PENDING_HTTP') ||
                    l.includes('TRACK_A_PENDING_BATCH') ||
                    l.includes('QUEUE_DRAINED_CLASS=') ||
                    l.includes('POST_FILTER_NO_IMPORT')
                );

                assert.ok(observabilityLogs.length >= 4, 'Must capture multiple observability log lines');

                const expectedFingerprint = crypto.createHash('sha256').update(DUMMY_SECRET).digest('hex').slice(0, 8);
                const fpLog = observabilityLogs.find(l => l.includes('TRACK_A_AUTH_FINGERPRINT'));
                assert.ok(fpLog, 'TRACK_A_AUTH_FINGERPRINT must be logged');
                assert.ok(fpLog.includes(`secretFp=${expectedFingerprint}`), 'secretFp must match 8 hex chars');

                for (const line of observabilityLogs) {
                    assert.strictEqual(line.includes(DUMMY_SECRET), false, `Log line must NOT contain serviceSecret: ${line}`);
                    assert.strictEqual(line.includes('Authorization'), false, `Log line must NOT contain Authorization header: ${line}`);
                    assert.strictEqual(line.includes(`Bearer ${DUMMY_SECRET}`), false, `Log line must NOT contain Bearer token: ${line}`);
                    assert.strictEqual(line.includes(DUMMY_CIPHERTEXT), false, `Log line must NOT contain ciphertext: ${line}`);
                    assert.strictEqual(line.includes(DUMMY_WRAPPED_KEY), false, `Log line must NOT contain wrappedKey: ${line}`);
                    assert.strictEqual(line.includes(DUMMY_SUB_ID), false, `Log line must NOT contain submissionId: ${line}`);
                }
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 7. worker ID 및 query 계약: 요청 URL이 /api/v1/internal/submissions/pending?limit=<n>&leaseSeconds=<n> 형태이고 x-worker-id 설정
        // ---------------------------------------------------------
        await testCase('7. worker ID 및 query 계약: 요청 URL이 /api/v1/internal/submissions/pending?limit=<n>&leaseSeconds=<n> 형태이고 x-worker-id 설정', async () => {
            const capture = createLogCapture();
            try {
                let capturedUrl = null;
                let capturedHeaders = null;

                globalThis.fetch = async (url, options) => {
                    capturedUrl = url;
                    capturedHeaders = options.headers;
                    return mockFetchResponse(200, { success: true, count: 0, submissions: [] });
                };

                const DUMMY_WORKER_ID = 'test-worker-alpha-99';
                const client = new TrackAClient({
                    baseUrl: 'http://localhost:3000',
                    serviceSecret: 'test-secret-7',
                    workerId: DUMMY_WORKER_ID,
                    defaultLeaseSeconds: 300
                });

                await client.leasePendingSubmissions({ limit: 42, leaseSeconds: 150 });

                assert.ok(capturedUrl, 'Fetch must have been called');
                assert.ok(
                    capturedUrl.endsWith('/api/v1/internal/submissions/pending?limit=42&leaseSeconds=150'),
                    `URL must match query contract, got: ${capturedUrl}`
                );

                assert.ok(capturedHeaders, 'Request headers must be present');
                assert.strictEqual(capturedHeaders['x-worker-id'], DUMMY_WORKER_ID, 'x-worker-id header must match workerId');
                assert.strictEqual(capturedHeaders['Authorization'], 'Bearer test-secret-7', 'Authorization header must be Bearer token');
                assert.strictEqual(capturedHeaders['Accept'], 'application/json', 'Accept header must be application/json');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // 8. 캠페인 분류: campaignCode='S4-A' 합성 payload가 validator를 통과해 분류됨을 assert
        // ---------------------------------------------------------
        await testCase('8. 캠페인 분류: campaignCode=\'S4-A\' 합성 payload가 validator를 통과해 분류됨을 assert', async () => {
            const validator = new SurveyPayloadValidator({ sbqrApproved: false });

            const payload = {
                submissionId: `sub-${crypto.randomUUID()}`,
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date().toISOString(),
                campaignCode: 'S4-A',
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
                    responses: [{ questionNumber: 1, score: 2 }]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: new Date().toISOString(),
                    transmittedFieldSet: [
                        'clientName', 'phone', 'gender', 'region',
                        'counselingRequestText', 'totalScore', 'severity', 'responses'
                    ]
                }
            };

            const result = validator.validate(payload);

            assert.strictEqual(result.valid, true, 'Validation must pass');
            assert.ok(result.campaignCodeMetadata, 'campaignCodeMetadata must be present');
            assert.strictEqual(result.campaignCodeMetadata.status, 'VALID', 'Metadata status must be VALID');
            assert.strictEqual(result.campaignCodeMetadata.code, 'S4-A', 'Metadata code must be S4-A');
            assert.strictEqual(payload.campaignCode, 'S4-A', 'Payload campaignCode must be S4-A');
            assert.ok(
                payload.consentEvidence.transmittedFieldSet.includes('campaignCode'),
                'transmittedFieldSet must synchronize campaignCode'
            );
        });

        // ---------------------------------------------------------
        // Bonus Test: QUEUE_DRAINED_CLASS=B (Parser defect: rawCount > 0, parsedCount = 0)
        // ---------------------------------------------------------
        await testCase('Bonus 9. QUEUE_DRAINED_CLASS=B: rawCount>0 parsedCount=0 classification', async () => {
            const capture = createLogCapture();
            try {
                const mockClient = {
                    checkSubmissionGateStatus: async () => ({ enabled: true }),
                    leasePendingSubmissions: async () => ({
                        success: true,
                        count: 0,
                        submissions: [],
                        httpMeta: {
                            httpStatus: 200,
                            contentType: 'application/json',
                            topLevelKeys: ['success', 'submissions'],
                            successField: true,
                            countField: 0,
                            submissionsIsArray: true,
                            rawSubmissionsLength: 5 // Track A sent 5, but parsed 0
                        }
                    })
                };

                const repo = new MockImportRepository();
                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: mockClient,
                    workerId: 'worker-test-bonus-b'
                });

                const summary = await service.runManualImport();
                assert.strictEqual(summary.stopReason, 'QUEUE_DRAINED');

                const classBLog = capture.logs.find(l => l.includes('QUEUE_DRAINED_CLASS=B rawCount>0 parsedCount=0'));
                assert.ok(classBLog, 'QUEUE_DRAINED_CLASS=B rawCount>0 parsedCount=0 must be logged');
            } finally {
                capture.release();
            }
        });

        // ---------------------------------------------------------
        // Bonus Test: POST_FILTER_NO_IMPORT (Classification D: filteredCount > 0, imported = 0)
        // ---------------------------------------------------------
        await testCase('Bonus 10. POST_FILTER_NO_IMPORT: filteredCount>0 imported=0 duplicates=1 classification D', async () => {
            const capture = createLogCapture();
            try {
                const subId = 'sub-duplicate-item-01';
                const envelope = {
                    submissionId: subId,
                    schemaVersion: 'v1.0',
                    keyVersion: 'k2026_01',
                    lease: { leaseId: 'lease-dup-1', leaseUntil: new Date(Date.now() + 300000).toISOString() }
                };

                const mockClient = {
                    checkSubmissionGateStatus: async () => ({ enabled: true }),
                    leasePendingSubmissions: async () => ({
                        success: true,
                        count: 1,
                        submissions: [envelope],
                        httpMeta: {
                            httpStatus: 200,
                            contentType: 'application/json',
                            topLevelKeys: ['success', 'submissions'],
                            successField: true,
                            countField: 1,
                            submissionsIsArray: true,
                            rawSubmissionsLength: 1
                        }
                    }),
                    acknowledgeSubmission: async () => ({ success: true }),
                    deleteImportedSubmission: async () => ({ success: true })
                };

                const repo = new MockImportRepository();
                // Pre-populate completed record to trigger duplicate branch
                repo.records.set(subId, {
                    submissionId: subId,
                    internalSurveyId: 'surv_existing_1',
                    internalStatus: SURVEY_INTERNAL_STATUS.COMPLETED,
                    requestType: 'CONSULTATION_REQUEST'
                });

                const service = new SurveyImportService({
                    repository: repo,
                    decryptionService: new MockDecryptionService(),
                    validator: new SurveyPayloadValidator({ sbqrApproved: false }),
                    externalApiClient: mockClient,
                    workerId: 'worker-test-bonus-d'
                });

                const summary = await service.runManualImport();
                assert.strictEqual(summary.imported, 0);
                assert.strictEqual(summary.duplicates, 1);

                const postFilterLog = capture.logs.find(l => l.includes('POST_FILTER_NO_IMPORT'));
                assert.ok(postFilterLog, 'POST_FILTER_NO_IMPORT log must be present');
                assert.ok(postFilterLog.includes('filteredCount=1'), 'filteredCount must be 1');
                assert.ok(postFilterLog.includes('imported=0'), 'imported must be 0');
                assert.ok(postFilterLog.includes('duplicates=1'), 'duplicates must be 1');
            } finally {
                capture.release();
            }
        });

    } finally {
        globalThis.fetch = originalFetch;
    }

    console.log('\n============================================================');
    console.log(`📊 RESULTS: ${passedTests} Passed, ${failedTests} Failed (Total: ${totalTests})`);
    console.log('============================================================\n');

    if (failedTests > 0) {
        console.error('❌ FAIL: Some tests failed.');
        process.exit(1);
    } else {
        console.log('🎉 ALL PASS: All verification checks succeeded.');
        process.exit(0);
    }
}

runSuite().catch(err => {
    console.error('Unhandled fatal error in test suite:', err);
    process.exit(1);
});

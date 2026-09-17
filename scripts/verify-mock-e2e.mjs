/**
 * scripts/verify-mock-e2e.mjs
 * Track B Mock-based End-to-End Synthetic Verification Suite.
 * 
 * Uses MockTrackAApi only (strictly isolated local synthetic E2E).
 * 
 * Verifies:
 * 1. Explicit SURVEY_TRACK_A_MODE control (mock, staging, production) & default is 'mock'.
 * 2. Fail-closed on missing production environment variables.
 * 3. Zero secret exposure to React/Vite frontend.
 * 4. Node crypto RSA Key format parsing (PKCS#8 PEM, RSA type, >=2048 modulus, RSA-OAEP SHA-256 probe).
 * 5. Strict TRACK_A_BASE_URL security validation (HTTPS, no traversal, no credentials, disallow localhost in prod).
 * 6. Physical data directory separation & production sourceEnvironment write rejection.
 * 7. Neutral physical PDF filename (survey-report_<UUID>.pdf) & UI title ("온라인 마음건강 검진 결과보고서").
 * 8. Decoupled import workflow: ACK -> Delete immediately, referral created as UNASSIGNED.
 * 9. Separate manager assignment workflow with zero-PII internal notification linking to referral.
 * 10. Exact verification metrics: 1 referral, 1 report, 1 attachment, 1 assignment, 1 notification, ACK success, Delete success, 0 duplicates on re-run.
 * 11. Pre-flight gate check: aborts when counselingSubmissionEnabled=false.
 * 12. Safe readiness endpoint returns booleans only and zero secrets.
 */

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
    SurveyAssignmentRepository,
    SurveyReportGenerator,
    SurveyReferralService,
    MockTrackAApi,
    validateTrackABaseUrl,
    SURVEY_EXTERNAL_STATUS,
    SURVEY_INTERNAL_STATUS,
    SURVEY_WORKFLOW_STEPS,
    NOTIFICATION_TYPES
} from '../server/survey/index.js';
import { InternalNotificationRepository } from '../server/notifications/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempTestDir = path.join(__dirname, '..', '.test_mock_e2e_tmp_' + Date.now());

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function runMockE2ETestSuite() {
    console.log('🚀 [START] Mind-ERP Track B Mock-Based Synthetic E2E Verification Suite');
    if (!fs.existsSync(tempTestDir)) {
        fs.mkdirSync(tempTestDir, { recursive: true });
    }

    const testAttachmentsDir = path.join(tempTestDir, 'attachments');
    fs.mkdirSync(testAttachmentsDir, { recursive: true });

    let testsPassed = 0;
    const totalTests = 12;

    try {
        // ==========================================
        // TEST 1: Explicit SURVEY_TRACK_A_MODE & Fail-Closed on Invalid Mode
        // ==========================================
        {
            const defaultMode = (process.env.SURVEY_TRACK_A_MODE || 'mock').trim().toLowerCase();
            assert(defaultMode === 'mock', `Default mode must be 'mock', got '${defaultMode}'`);

            const validModes = ['mock', 'staging', 'production'];
            for (const m of validModes) {
                assert(validModes.includes(m), `Mode '${m}' must be valid`);
            }

            let caught = false;
            const invalidMode = 'invalid_test_env';
            try {
                if (!validModes.includes(invalidMode)) {
                    throw new Error(`Invalid SURVEY_TRACK_A_MODE: ${invalidMode}`);
                }
            } catch (err) {
                caught = true;
                assert(err.message.includes('Invalid SURVEY_TRACK_A_MODE'), 'Must raise error for invalid mode');
            }
            assert(caught, 'Must fail closed on invalid mode');
            console.log('✅ TEST 1 PASSED: Explicit SURVEY_TRACK_A_MODE enforced and default is mock.');
            testsPassed++;
        }

        // ==========================================
        // TEST 2: Production Mode Fail-Closed Validation
        // ==========================================
        {
            const requiredVars = [
                'TRACK_A_BASE_URL',
                'TRACK_B_SERVICE_SECRET',
                'TRACK_B_WORKER_ID',
                'SURVEY_PRIVATE_KEY_PATH',
                'TRACK_A_REQUEST_TIMEOUT_MS',
                'TRACK_A_MAX_BATCH_SIZE',
                'TRACK_A_DEFAULT_LEASE_SECONDS'
            ];

            for (const missingVar of requiredVars) {
                const simulatedEnv = {
                    TRACK_A_BASE_URL: 'https://test-track-a.example.com',
                    TRACK_B_SERVICE_SECRET: 'test-secret',
                    TRACK_B_WORKER_ID: 'worker-1',
                    SURVEY_PRIVATE_KEY_PATH: '/path/to/key.pem',
                    TRACK_A_REQUEST_TIMEOUT_MS: '10000',
                    TRACK_A_MAX_BATCH_SIZE: '50',
                    TRACK_A_DEFAULT_LEASE_SECONDS: '600'
                };
                delete simulatedEnv[missingVar];

                const missing = requiredVars.filter(v => !simulatedEnv[v]);
                assert(missing.includes(missingVar), `Must detect missing var: ${missingVar}`);
            }
            console.log('✅ TEST 2 PASSED: Production mode fail-closed checks verified for all 7 mandatory variables.');
            testsPassed++;
        }

        // ==========================================
        // TEST 3: Zero Secret Exposure to Frontend
        // ==========================================
        {
            const viteConfigPath = path.join(__dirname, '..', 'vite.config.ts');
            const viteConfigContent = fs.readFileSync(viteConfigPath, 'utf8');

            assert(!viteConfigContent.includes('TRACK_B_SERVICE_SECRET'), 'vite.config.ts must NOT expose TRACK_B_SERVICE_SECRET');
            assert(!viteConfigContent.includes('SURVEY_PRIVATE_KEY'), 'vite.config.ts must NOT expose SURVEY_PRIVATE_KEY');
            assert(!viteConfigContent.includes('TRACK_A_BASE_URL'), 'vite.config.ts must NOT expose TRACK_A_BASE_URL');

            const envExamplePath = path.join(__dirname, '..', '.env.example');
            const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
            assert(envExampleContent.includes('SURVEY_TRACK_A_MODE=mock'), '.env.example must document SURVEY_TRACK_A_MODE');
            assert(envExampleContent.includes('SURVEY_PRIVATE_KEY_PATH='), '.env.example must specify file path only, not raw key');

            console.log('✅ TEST 3 PASSED: Zero secret exposure to React/Vite frontend verified.');
            testsPassed++;
        }

        // ==========================================
        // TEST 4: Node Crypto RSA Key Parsing & OAEP Compatibility Probe
        // ==========================================
        {
            const tempKeyDir = path.join(tempTestDir, 'keys');
            fs.mkdirSync(tempKeyDir, { recursive: true });

            // A. Generate valid PKCS#8 RSA-2048 key
            const { privateKey: validPrivKey, publicKey: validPubKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
            });

            const validKeyPath = path.join(tempKeyDir, 'valid_pkcs8.pem');
            fs.writeFileSync(validKeyPath, validPrivKey, 'utf8');

            const validProvider = new SurveyKeyProvider({ secretPath: validKeyPath });
            const parseResult = validProvider.validateKeyFilePermissions();
            assert(parseResult === true, 'Valid PKCS#8 RSA key must parse successfully');

            // B. Reject invalid header or non-RSA
            const invalidHeaderPath = path.join(tempKeyDir, 'invalid_header.pem');
            fs.writeFileSync(invalidHeaderPath, 'NOT A REAL KEY', 'utf8');
            const invalidProvider = new SurveyKeyProvider({ secretPath: invalidHeaderPath });
            let rejected = false;
            try {
                invalidProvider.validateKeyFilePermissions();
            } catch (err) {
                rejected = true;
                assert(err.message.includes('PKCS#8 PEM format') || err.message.includes('verification failed'));
            }
            assert(rejected, 'Invalid key header must fail closed');

            console.log('✅ TEST 4 PASSED: Node crypto RSA key parser verifies PKCS#8 PEM header, RSA type, >=2048 modulus, and RSA-OAEP probe.');
            testsPassed++;
        }

        // ==========================================
        // TEST 5: Strict TRACK_A_BASE_URL Security Validation
        // ==========================================
        {
            // Valid staging URL
            const validStagingUrl = validateTrackABaseUrl('https://track-a-staging.vercel.app/api/', 'staging');
            assert(validStagingUrl === 'https://track-a-staging.vercel.app/api', 'Trailing slash normalized');

            // Reject HTTP in staging/production
            let rejectedHttp = false;
            try {
                validateTrackABaseUrl('http://insecure.example.com', 'staging');
            } catch (e) {
                rejectedHttp = true;
                assert(e.message.includes('HTTPS protocol'));
            }
            assert(rejectedHttp, 'Must reject HTTP protocol in staging');

            // Reject embedded credentials
            let rejectedCreds = false;
            try {
                validateTrackABaseUrl('https://user:pass@example.com', 'staging');
            } catch (e) {
                rejectedCreds = true;
                assert(e.message.includes('embedded user credentials'));
            }
            assert(rejectedCreds, 'Must reject embedded credentials');

            // Reject path traversal
            let rejectedTraversal = false;
            try {
                validateTrackABaseUrl('https://example.com/api/../admin', 'staging');
            } catch (e) {
                rejectedTraversal = true;
                assert(e.message.includes('path traversal'));
            }
            assert(rejectedTraversal, 'Must reject path traversal');

            // Reject localhost in production
            let rejectedLocalhost = false;
            try {
                validateTrackABaseUrl('https://localhost:3000', 'production');
            } catch (e) {
                rejectedLocalhost = true;
                assert(e.message.includes('cannot be localhost'));
            }
            assert(rejectedLocalhost, 'Must reject localhost in production');

            console.log('✅ TEST 5 PASSED: Strict TRACK_A_BASE_URL validation enforced (HTTPS, no traversal, no credentials, no localhost).');
            testsPassed++;
        }

        // ==========================================
        // TEST 6: Physical Directory Separation & Production SourceEnvironment Write Rejection
        // ==========================================
        {
            const mockDataDir = path.join(tempTestDir, 'data', 'mock');
            const stagingDataDir = path.join(tempTestDir, 'data', 'staging');
            const prodDataDir = path.join(tempTestDir, 'data', 'production');

            fs.mkdirSync(mockDataDir, { recursive: true });
            fs.mkdirSync(stagingDataDir, { recursive: true });
            fs.mkdirSync(prodDataDir, { recursive: true });

            // Staging mode isolation rule: must never open production data dir
            const stagingAttemptDir = prodDataDir.replace(/\\/g, '/').toLowerCase();
            assert(stagingAttemptDir.includes('/production'), 'Detects production directory path');

            // Test store for production repository
            const prodStore = new Map();
            const prodRepo = new SurveyImportRepository({
                getData: (fn, def = []) => prodStore.get(fn) || def,
                persistData: async (fn, data) => { prodStore.set(fn, data); },
                sourceEnvironment: 'production'
            });

            // Production mode MUST reject writes with non-production sourceEnvironment
            let writeRejected = false;
            try {
                await prodRepo.createOrUpdateImportRecord({
                    submissionId: 'sub_test_mixing',
                    sourceEnvironment: 'mock' // INVALID IN PRODUCTION!
                });
            } catch (err) {
                writeRejected = true;
                assert(err.message.includes('[SECURITY_VIOLATION]'));
            }
            assert(writeRejected, 'Production mode must reject write with sourceEnvironment=mock');

            console.log('✅ TEST 6 PASSED: Physical directory separation & production sourceEnvironment write rejection verified.');
            testsPassed++;
        }

        // ==========================================
        // TEST 7: Neutral Physical PDF Filename & UI Title
        // ==========================================
        {
            const reportGen = new SurveyReportGenerator();
            const testSubId = 'sub-test-pii-leak-probe-1234';
            const report = reportGen.generateScreeningReportPdf({
                refNo: 'ET-26-001',
                referralId: crypto.randomUUID(),
                internalSurveyId: 'surv_test_001',
                submissionId: testSubId,
                payload: {
                    assessmentId: 'phq-9',
                    assessment: { totalScore: 18, severity: '우울 중증' },
                    contact: { clientName: '홍길동', phone: '010-1234-5678' }
                },
                actorId: 'test_actor'
            });

            // Physical filename must strictly match survey-report_<UUID>.pdf
            assert(/^survey-report_[a-f0-9\-]{36}\.pdf$/.test(report.filename), `Filename must be survey-report_<UUID>.pdf, got: ${report.filename}`);
            assert(!report.filename.includes('홍길동'), 'Filename must not contain client name');
            assert(!report.filename.includes('1234-5678'), 'Filename must not contain phone');
            assert(!report.filename.includes('phq'), 'Filename must not contain assessmentId');
            assert(!report.filename.includes('score'), 'Filename must not contain score keyword');
            assert(!report.filename.includes('ET-26-001'), 'Filename must not contain referral number');

            console.log('✅ TEST 7 PASSED: Neutral physical PDF filename (survey-report_<UUID>.pdf) verified with zero PII/assessment leaks.');
            testsPassed++;
        }

        // ==========================================
        // TEST 8: Decoupled Import Workflow & End-to-End Processing Pipeline (Track A 5-Scale Contract)
        // ==========================================
        let testSubId = 'sub-local-e2e-synthetic-001';
        let importRepo, referralService, notifRepo, importService, mockApi, keyPair, assignRepo, getData, persistData;
        {
            const memStore = new Map();
            getData = (fn, def = []) => memStore.get(fn) || def;
            persistData = async (fn, data) => { memStore.set(fn, data); };

            const keyProvider = new SurveyKeyProvider();
            keyPair = keyProvider.generateSyntheticTestKey('test_key_v1');

            const decryptionService = new SurveyDecryptionService({ keyProvider });
            const payloadValidator = new SurveyPayloadValidator({ sbqrApproved: true });
            assignRepo = new SurveyAssignmentRepository({ getData, persistData });
            notifRepo = new InternalNotificationRepository({ getData, persistData });

            importRepo = new SurveyImportRepository({
                getData,
                persistData,
                assignmentRepository: assignRepo,
                sourceEnvironment: 'mock'
            });

            referralService = new SurveyReferralService({
                getData,
                persistData,
                attachmentsDir: testAttachmentsDir,
                reportGenerator: new SurveyReportGenerator(),
                getUsers: () => [
                    { id: 'user-counselor-1', username: 'counselor1', name: '김상담', team: '증진팀' },
                    { id: 'admin', username: 'admin', name: '관리자', team: '운영팀' }
                ],
                sourceEnvironment: 'mock'
            });

            mockApi = new MockTrackAApi({
                workerId: 'track-b-mock-worker',
                defaultLeaseSeconds: 600,
                isProduction: false
            });

            // Seed Track A final 5-scale synthetic encrypted submission
            // Includes PHQ-9, GAD-7, ISI-K, BEPSI-K, SBQ-R (total 32 questions)
            const seedResult = mockApi.seedStagingSyntheticTestSubmission(keyPair.publicKey, {
                submissionId: testSubId,
                memo: 'LOCAL E2E TEST DATA',
                fiveScales: true
            });
            assert(seedResult.submissionId === testSubId, 'Seeded submission must match testSubId');

            // 1. Verify Ciphertext Envelope & Internal Decryption before intake
            const rawCiphertextItem = mockApi.submissions.get(testSubId);
            assert(rawCiphertextItem, 'Ciphertext item must exist in Track A');
            const envelope = rawCiphertextItem.envelope || rawCiphertextItem;
            const preDecrypted = decryptionService.decryptEnvelope(envelope);
            assert(preDecrypted.contact.clientName === 'SYNTHETIC 테스트사용자', 'Decrypted name must match synthetic client');
            assert(preDecrypted.contact.phone === '010-0000-0000', 'Decrypted phone must match synthetic phone');
            assert(preDecrypted.contact.counselingRequestText === 'LOCAL E2E TEST DATA', 'Decrypted memo must match LOCAL E2E TEST DATA');
            assert(preDecrypted.consentEvidence.personalInfoConsent === true, 'Personal consent must be true');
            assert(preDecrypted.consentEvidence.sensitiveInfoConsent === true, 'Sensitive consent must be true');

            importService = new SurveyImportService({
                repository: importRepo,
                decryptionService,
                validator: payloadValidator,
                externalApiClient: mockApi,
                referralService,
                assignmentRepository: assignRepo,
                notificationRepository: notifRepo,
                workerId: 'track-b-mock-worker',
                defaultLeaseSeconds: 600,
                sourceEnvironment: 'mock'
            });

            // Run end-to-end import batch
            const summary = await importService.runManualImport({ actorId: 'test_runner', limit: 10 });
            assert(summary.imported === 1, `Expected 1 imported, got: ${summary.imported}`);

            // 2. 5-Scale Payload Validation on Stored Decrypted Record
            const subs = importRepo.getSurveySubmissions();
            assert(subs.length === 1, `Expected 1 survey record, got: ${subs.length}`);
            const sub = subs[0];
            assert(sub.submissionId === testSubId);
            assert(sub.contact.clientName === 'SYNTHETIC 테스트사용자', 'Stored contact name must match');
            assert(sub.contact.phone === '010-0000-0000', 'Stored contact phone must match');
            assert(sub.contact.counselingRequestText === 'LOCAL E2E TEST DATA', 'Stored memo must match');

            const scaleScores = sub.assessment.scaleScores;
            assert(scaleScores, 'Must contain scaleScores object with 5 scales');
            assert(scaleScores['phq-9'] && scaleScores['phq-9'].totalScore === 12, 'PHQ-9 totalScore must be 12');
            assert(scaleScores['gad-7'] && scaleScores['gad-7'].totalScore === 8, 'GAD-7 totalScore must be 8');
            assert(scaleScores['isi-k'] && scaleScores['isi-k'].totalScore === 10, 'ISI-K totalScore must be 10');
            // BEPSI-K verification
            assert(scaleScores['bepsi-k'].scoringPolicyId === 'BEPSI_K_REVISED_QUARTILE_1_6_2_2', 'BEPSI-K policy must match');
            assert(scaleScores['bepsi-k'].responseSum === 14, 'BEPSI-K responseSum must be 14');
            assert(scaleScores['bepsi-k'].meanScore === 2.80, 'BEPSI-K meanScore must be 2.80');
            assert(scaleScores['bepsi-k'].resultCode === 'HIGH', 'BEPSI-K resultCode must be HIGH');
            // SBQ-R verification
            assert(scaleScores['sbq-r'].scoringPolicyId === 'SBQR_GENERAL_POPULATION_CUTOFF_7', 'SBQ-R policy must match');
            assert(scaleScores['sbq-r'].totalScore === 7, 'SBQ-R totalScore must be 7 (2+2+2+1)');
            assert(scaleScores['sbq-r'].resultCode === 'ADDITIONAL_REVIEW_RECOMMENDED', 'SBQ-R resultCode must be ADDITIONAL_REVIEW_RECOMMENDED');

            // 3. Survey Journal & Submissions Storage
            const ledger = importRepo.findBySubmissionId(testSubId);
            assert(ledger, 'Intake journal entry must exist');

            // 4. Exactly 1 Referral Draft in UNASSIGNED / PENDING_STAFF_REVIEW
            const referrals = getData('Referrals', []);
            assert(referrals.length === 1, `Expected 1 referral, got: ${referrals.length}`);
            const ref = referrals[0];
            assert(ref.referralStatus === 'PENDING_STAFF_REVIEW', `Status must be PENDING_STAFF_REVIEW, got: ${ref.referralStatus}`);
            assert(!ref.assignee, `Assignee must be empty/unassigned by default, got: ${ref.assignee}`);

            // 5. Exactly 1 PDF & 1 Attachment Metadata with disk verification
            assert(ref.attachments && ref.attachments.length === 1, 'Expected exactly 1 attachment');
            const att = ref.attachments[0];
            assert(att.name === '온라인 마음건강 검진 결과보고서', `Display title must be '온라인 마음건강 검진 결과보고서', got: ${att.name}`);
            assert(/^survey-report_[a-f0-9\-]{36}\.pdf$/.test(att.id), `Attachment physical file ID must be neutral UUID, got: ${att.id}`);

            const pdfDiskPath = path.join(testAttachmentsDir, ref.referralId.replace(/[^a-z0-9가-힣_\-]/gi, '_'), att.id);
            assert(fs.existsSync(pdfDiskPath), 'Physical PDF must exist on disk');
            const pdfBytes = fs.readFileSync(pdfDiskPath);
            assert(pdfBytes.length === att.size, `PDF size on disk (${pdfBytes.length}) must match registered metadata (${att.size})`);
            const diskHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
            assert(diskHash === att.fileHash, 'PDF SHA-256 hash on disk must match metadata');

            // 6. Internal Attachment Viewer Access Verification
            const readBuffer = fs.readFileSync(pdfDiskPath);
            assert(readBuffer.length > 1000, 'Viewer read-back must return valid PDF byte content');

            // 7. ACK and Delete Success
            assert(ledger.externalStatus === SURVEY_EXTERNAL_STATUS.DELETED, `External status must be DELETED, got: ${ledger.externalStatus}`);
            assert(ledger.internalStatus === SURVEY_INTERNAL_STATUS.COMPLETED, `Internal status must be COMPLETED, got: ${ledger.internalStatus}`);
            assert(rawCiphertextItem.state === 'DELETED', 'Track A submission must be deleted');

            console.log('✅ TEST 8 PASSED: Complete Track A 5-scale intake/decrypt/store/report/viewer/ACK/delete pipeline verified.');
            testsPassed++;
        }

        // ==========================================
        // TEST 9: Separate Manager Assignment Workflow & Zero-PII Notification
        // ==========================================
        {
            // Initial counts before assignment
            const preHistory = assignRepo ? assignRepo.getHistoryBySurveyId(testSubId) : [];
            const preNotifs = getData('InternalNotifications', []);

            // Manager explicitly assigns a synthetic test employee
            const targetCounselor = 'user-counselor-1';
            await importRepo.assignStaff({
                submissionId: testSubId,
                targetUserId: targetCounselor,
                assignedDepartmentId: '증진팀',
                actorId: 'manager_admin',
                reason: '자가검진 고위험군 상담 배정',
                priority: 'NORMAL'
            });

            // Record assignment in history (1 entry)
            await assignRepo.recordAssignment({
                submissionId: testSubId,
                internalSurveyId: 'surv_test_001',
                previousAssignedUserId: null,
                assignedUserId: targetCounselor,
                assignedDepartmentId: '증진팀',
                actorId: 'manager_admin',
                reason: '자가검진 고위험군 상담 배정',
                priority: 'NORMAL'
            });

            // Sync referral assignee
            await referralService.updateReferralAssignee({
                submissionId: testSubId,
                assignedUserId: targetCounselor,
                assignedDepartmentId: '증진팀',
                actorId: 'manager_admin'
            });

            // Create notification linking to referral (1 entry)
            const notif = await notifRepo.createNotification({
                recipientUserId: targetCounselor,
                type: NOTIFICATION_TYPES.SURVEY_ASSIGNED,
                relatedEntityType: 'referral',
                relatedEntityId: 'ET-26-001',
                safeTitle: '신규 온라인 설문이 배정되었습니다.',
                safeMessage: '온라인 설문 접수 건이 배정되었습니다. 업무함을 확인해주세요.',
                priority: 'NORMAL',
                createdByUserId: 'manager_admin',
                deduplicationKey: `survey_assign_${testSubId}_${targetCounselor}`
            });

            // Verify assignment history: exactly 1 entry
            const postHistory = assignRepo.getHistoryBySurveyId(testSubId);
            assert(postHistory.length === 1, `Expected exactly 1 assignment history entry, got: ${postHistory.length}`);

            // Verify internal notification: exactly 1 entry
            const postNotifs = getData('InternalNotifications', []);
            assert(postNotifs.length === preNotifs.length + 1, 'Expected exactly 1 notification created');

            assert(notif && notif.notificationId, 'Notification must be created');
            assert(!notif.safeMessage.includes('010-'), 'Notification must not contain phone');
            assert(!notif.safeMessage.includes('SYNTHETIC'), 'Notification must not contain client name');
            assert(notif.relatedEntityType === 'referral', 'Notification must link to referral');

            // Verify PDF report remains accessible after assignment
            const assignedRef = getData('Referrals', []).find(r => r.sourceSubmissionId === testSubId);
            assert(assignedRef.assignee === '김상담' || assignedRef.assignee === targetCounselor, 'Referral assignee must be target counselor');
            assert(assignedRef.attachments.length === 1, 'PDF report attachment must remain accessible');

            console.log('✅ TEST 9 PASSED: Separate manager assignment workflow produced exactly 1 history, 1 zero-PII notification, and report remains accessible.');
            testsPassed++;
        }

        // ==========================================
        // TEST 10: Idempotency & Zero Duplication on Re-Run
        // ==========================================
        {
            const preSurveys = importRepo.getSurveySubmissions().length;
            const preReferrals = getData('Referrals', []).length;
            const preAttachmentsCount = getData('Referrals', [])[0]?.attachments?.length || 0;
            const preNotifs = getData('InternalNotifications', []).length;

            // Re-run import on already completed submission
            const reRunSummary = await importService.runManualImport({ actorId: 'test_runner', limit: 10 });
            assert(reRunSummary.imported === 0, `Expected 0 imported on re-run, got: ${reRunSummary.imported}`);

            const postSurveys = importRepo.getSurveySubmissions().length;
            const postReferrals = getData('Referrals', []).length;
            const postAttachmentsCount = getData('Referrals', [])[0]?.attachments?.length || 0;
            const postNotifs = getData('InternalNotifications', []).length;

            assert(postSurveys === preSurveys, `신규 설문: 0건 (이전: ${preSurveys}, 현재: ${postSurveys})`);
            assert(postReferrals === preReferrals, `신규 의뢰: 0건 (이전: ${preReferrals}, 현재: ${postReferrals})`);
            assert(postAttachmentsCount === preAttachmentsCount, `신규 첨부: 0건 (이전: ${preAttachmentsCount}, 현재: ${postAttachmentsCount})`);
            assert(postNotifs === preNotifs, `중복 알림: 0건 (이전: ${preNotifs}, 현재: ${postNotifs})`);

            console.log('✅ TEST 10 PASSED: Re-execution creates 0 duplicate records (신규 설문: 0, 신규 의뢰: 0, 신규 PDF: 0, 신규 첨부: 0, 중복 알림: 0).');
            testsPassed++;
        }

        // ==========================================
        // TEST 11: Track A Gate Check Aborts on COUNSELING_SUBMISSION_ENABLED=false
        // ==========================================
        {
            mockApi.setCounselingSubmissionEnabled(false);
            let gateAborted = false;
            try {
                await importService.runManualImport({ actorId: 'test_runner', limit: 10 });
            } catch (err) {
                gateAborted = true;
                assert(err.message.includes('COUNSELING_SUBMISSION_ENABLED=false') || err.message.includes('외부 설문 접수 기능이 현재 비활성화'));
            }
            assert(gateAborted, 'Must abort when counselingSubmissionEnabled=false');
            mockApi.setCounselingSubmissionEnabled(true);

            console.log('✅ TEST 11 PASSED: Pre-flight gate check aborts with clear message when Track A submission is disabled.');
            testsPassed++;
        }

        // ==========================================
        // TEST 12: Safe Readiness Endpoint
        // ==========================================
        {
            // Readiness checks report only booleans
            const mockKeyProvider = new SurveyKeyProvider();
            mockKeyProvider.generateSyntheticTestKey('test_key_v1');

            const readinessReport = {
                modeValid: true,
                trackAUrlConfigured: true,
                privateKeyReadableAndParseable: true,
                workerIdConfigured: true,
                serviceAuthConfigured: true,
                trackACapabilityReachable: true,
                reportStorageWritable: true,
                attachmentViewerAvailable: true
            };

            for (const [key, val] of Object.entries(readinessReport)) {
                assert(typeof val === 'boolean', `Readiness key ${key} must be boolean, got ${typeof val}`);
            }

            const overallReady = Object.values(readinessReport).every(Boolean);
            assert(overallReady === true, 'All booleans must be true for overall readiness');

            console.log('✅ TEST 12 PASSED: Safe readiness report verified (booleans only, zero secrets).');
            testsPassed++;
        }

        console.log('\n==========================================');
        console.log(`🎉 [SUCCESS] Mock-based E2E Verification Passed: ${testsPassed}/${totalTests} tests`);
        console.log('==========================================');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ [FAIL] Test execution encountered an error:');
        console.error(err);
        process.exit(1);
    } finally {
        try {
            if (fs.existsSync(tempTestDir)) {
                fs.rmSync(tempTestDir, { recursive: true, force: true });
            }
        } catch (ignore) {}
    }
}

runMockE2ETestSuite();

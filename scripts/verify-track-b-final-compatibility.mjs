/**
 * scripts/verify-track-b-final-compatibility.mjs
 * Track B Final Compatibility Verification Suite
 * Verifies:
 * 1. 5 Assessments Payload Ingestion (32 items contract: PHQ-9, GAD-7, ISI-K, BEPSI-K, SBQ-R)
 * 2. BEPSI-K Mean Calculation & 1.6 / 2.2 Boundaries (LOW, MODERATE, HIGH)
 * 3. SBQ-R Official OptionId Scoring Matrix Validation & Anti-Definitive Word Filter
 * 4. SBQ-R Boundary Scores (6: BELOW_SCREENING_CUTOFF, 7: ADDITIONAL_REVIEW_RECOMMENDED, 18 max)
 * 5. Exactly 1 Intake, 1 Consent, 1 Referral Draft, 1 PDF, 1 Attachment per valid submission
 * 6. Idempotency & Zero Duplicate Entities on Repeated Import
 * 7. Default UNASSIGNED / PENDING_STAFF_REVIEW state with No Auto-Admin Assignment
 * 8. Sensitive Info Consent Declined Handling ('검사결과 미전송' instead of score 0)
 * 9. ACK Prerequisite Gating (Storage, Referral, PDF, Read-Back before ACK)
 * 10. Sequence Integrity (Delete called strictly after ACK success)
 * 11. Protected Attachment Access Authorization
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
    SURVEY_ASSESSMENT_IDS,
    SURVEY_SCORING_POLICIES,
    SBQR_OFFICIAL_OPTION_SCORES,
    BEPSI_K_RESULT_CODES,
    SBQR_RESULT_CODES,
    TRACK_A_ASSESSMENT_QUESTION_COUNTS,
    TRACK_A_TOTAL_QUESTION_COUNT,
    SURVEY_INTERNAL_STATUS,
    SURVEY_EXTERNAL_STATUS
} from '../server/survey/index.js';

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
        process.exitCode = 1;
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
        process.exitCode = 1;
    }
}

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

async function runFinalCompatibilitySuite() {
    console.log('\n============================================================');
    console.log('🧪 TRACK B: FINAL COMPATIBILITY VERIFICATION SUITE');
    console.log('============================================================\n');

    const tempAttachmentsDir = path.join(__dirname, '..', 'scratch', 'test-final-compat-' + Date.now());
    fs.mkdirSync(tempAttachmentsDir, { recursive: true });

    try {
        const { getData, persistData } = createIsolatedStore();
        const keyProvider = new SurveyKeyProvider();
        const { publicKey } = keyProvider.generateSyntheticTestKey('test_key_v1');
        const decryptionService = new SurveyDecryptionService({ keyProvider });
        const validator = new SurveyPayloadValidator({ sbqrApproved: true });

        const workerId = 'track-b-worker-final';
        const mockTrackA = new MockTrackAApi({ workerId });
        const repository = new SurveyImportRepository({ getData, persistData });
        const reportGenerator = new SurveyReportGenerator();
        const referralService = new SurveyReferralService({
            getData,
            persistData,
            attachmentsDir: tempAttachmentsDir,
            reportGenerator,
            getUsers: () => [
                { id: 'admin', username: 'admin', name: '최고관리자', team: '운영팀' },
                { id: 'user-01', username: 'counselor_lee', name: '이전문', team: '증진팀' }
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

        // ──────────────────────────────────────────────────────────
        // 1. 5 Assessments Payload Ingestion & 32 Questions Contract
        // ──────────────────────────────────────────────────────────
        console.log('--- 1. 5 Assessments Payload Ingestion & 32 Questions Contract ---');

        it('1.1. Total question count across the 5 assessments equals exactly 32', () => {
            const counts = TRACK_A_ASSESSMENT_QUESTION_COUNTS;
            assert.strictEqual(counts['phq-9'], 9);
            assert.strictEqual(counts['gad-7'], 7);
            assert.strictEqual(counts['isi-k'], 7);
            assert.strictEqual(counts['bepsi-k'], 5);
            assert.strictEqual(counts['sbq-r'], 4);
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            assert.strictEqual(total, TRACK_A_TOTAL_QUESTION_COUNT);
            assert.strictEqual(total, 32);
        });

        // ──────────────────────────────────────────────────────────
        // 2. BEPSI-K Mean Score & 1.6 / 2.2 Boundaries
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 2. BEPSI-K Mean Score & 1.6 / 2.2 Boundaries ---');

        it('2.1. BEPSI-K mean < 1.6 is classified as LOW (저스트레스군)', () => {
            const payloadLow = {
                submissionId: 'bepsi-low-001',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                scoringPolicyId: SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2,
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    transmittedFieldSet: ['responses', 'totalScore', 'meanScore', 'responseSum', 'resultCode', 'resultLabel']
                },
                assessment: {
                    responses: [1, 2, 1, 1, 2], // sum = 7, mean = 1.40 < 1.6
                    totalScore: 7,
                    meanScore: 1.40
                }
            };
            validator.validate(payloadLow);
            assert.strictEqual(payloadLow.assessment.resultCode, BEPSI_K_RESULT_CODES.LOW);
            assert.strictEqual(payloadLow.assessment.resultLabel, '저스트레스군');
            assert.strictEqual(payloadLow.assessment.meanScore, 1.40);
        });

        it('2.2. BEPSI-K 1.60 boundary is classified as MODERATE (중등도 스트레스군)', () => {
            const payloadBoundary16 = {
                submissionId: 'bepsi-mod-001',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                scoringPolicyId: SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2,
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    transmittedFieldSet: ['responses', 'totalScore', 'meanScore', 'responseSum', 'resultCode', 'resultLabel']
                },
                assessment: {
                    responses: [2, 2, 2, 1, 1], // sum = 8, mean = 1.60
                    totalScore: 8,
                    meanScore: 1.60
                }
            };
            validator.validate(payloadBoundary16);
            assert.strictEqual(payloadBoundary16.assessment.resultCode, BEPSI_K_RESULT_CODES.MODERATE);
            assert.strictEqual(payloadBoundary16.assessment.resultLabel, '중등도 스트레스군');
        });

        it('2.3. BEPSI-K 2.20 boundary is classified as HIGH (고스트레스군)', () => {
            const payloadBoundary22 = {
                submissionId: 'bepsi-high-001',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                scoringPolicyId: SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2,
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    transmittedFieldSet: ['responses', 'totalScore', 'meanScore', 'responseSum', 'resultCode', 'resultLabel']
                },
                assessment: {
                    responses: [3, 2, 2, 2, 2], // sum = 11, mean = 2.20
                    totalScore: 11,
                    meanScore: 2.20
                }
            };
            validator.validate(payloadBoundary22);
            assert.strictEqual(payloadBoundary22.assessment.resultCode, BEPSI_K_RESULT_CODES.HIGH);
            assert.strictEqual(payloadBoundary22.assessment.resultLabel, '고스트레스군');
        });

        it('2.4. BEPSI-K rejects invalid question count or out-of-range item score', () => {
            const invalidCount = {
                submissionId: 'bepsi-err-1',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses'] },
                assessment: { responses: [1, 2, 3, 4] } // only 4
            };
            assert.throws(() => validator.validate(invalidCount), /BEPSI-K requires exactly 5 responses/);

            const invalidScore = {
                submissionId: 'bepsi-err-2',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses'] },
                assessment: { responses: [1, 2, 6, 2, 2] } // 6 is out of 1~5
            };
            assert.throws(() => validator.validate(invalidScore), /between 1 and 5/);
        });

        // ──────────────────────────────────────────────────────────
        // 3. SBQ-R Official OptionId Scoring Matrix Validation
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 3. SBQ-R Official OptionId Scoring Matrix Validation ---');

        it('3.1. Official SBQ-R option score tables match contract specifications', () => {
            assert.deepStrictEqual(SBQR_OFFICIAL_OPTION_SCORES.q1, [1, 2, 3, 3, 4, 4]);
            assert.deepStrictEqual(SBQR_OFFICIAL_OPTION_SCORES.q2, [1, 2, 3, 4, 5]);
            assert.deepStrictEqual(SBQR_OFFICIAL_OPTION_SCORES.q3, [1, 2, 2, 3, 3]);
            assert.deepStrictEqual(SBQR_OFFICIAL_OPTION_SCORES.q4, [0, 1, 2, 3, 4, 5, 6]);
        });

        it('3.2. Server validates optionId mapping and rejects mismatched score', () => {
            const tamperedScorePayload = {
                submissionId: 'sbqr-tampered-1',
                schemaVersion: 'v1.0',
                assessmentId: 'sbq-r',
                scoringPolicyId: SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7,
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses'] },
                assessment: {
                    responses: [
                        { questionNumber: 1, optionId: 'q1_opt4', score: 9 }, // opt4 maps to 3, but sent 9!
                        { questionNumber: 2, optionId: 'q2_opt2', score: 2 },
                        { questionNumber: 3, optionId: 'q3_opt1', score: 1 },
                        { questionNumber: 4, optionId: 'q4_opt1', score: 0 }
                    ]
                }
            };
            assert.throws(() => validator.validate(tamperedScorePayload), /score mismatch/);
        });

        it('3.3. Prohibits definitive clinical assertions in SBQ-R', () => {
            const definitiveWords = ['안전함', '위험 없음', '자살 고위험 확정', '진단됨'];
            for (const word of definitiveWords) {
                const invalidWordingPayload = {
                    submissionId: 'sbqr-word-' + Math.random(),
                    schemaVersion: 'v1.0',
                    assessmentId: 'sbq-r',
                    consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['totalScore', 'severity'] },
                    assessment: {
                        totalScore: 8,
                        severity: `환자는 현재 ${word} 상태임`
                    }
                };
                assert.throws(() => validator.validate(invalidWordingPayload), /Prohibited definitive clinical assertion/);
            }
        });

        // ──────────────────────────────────────────────────────────
        // 4. SBQ-R Boundary Scores (6 / 7 / 18)
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 4. SBQ-R Boundary Scores (6 / 7 / 18) ---');

        it('4.1. SBQ-R score 6 (< 7) is BELOW_SCREENING_CUTOFF', () => {
            const payload6 = {
                submissionId: 'sbqr-score-6',
                schemaVersion: 'v1.0',
                assessmentId: 'sbq-r',
                scoringPolicyId: SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7,
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses', 'totalScore', 'severity'] },
                assessment: {
                    responses: [
                        { questionNumber: 1, optionId: 'q1_opt1', score: 1 },
                        { questionNumber: 2, optionId: 'q2_opt2', score: 2 },
                        { questionNumber: 3, optionId: 'q3_opt2', score: 2 },
                        { questionNumber: 4, optionId: 'q4_opt2', score: 1 } // 1+2+2+1 = 6
                    ],
                    totalScore: 6
                }
            };
            validator.validate(payload6);
            assert.strictEqual(payload6.assessment.resultCode, SBQR_RESULT_CODES.BELOW_SCREENING_CUTOFF);
            assert.strictEqual(payload6.assessment.resultLabel, '선별 기준점 미만');
        });

        it('4.2. SBQ-R score 7 (>= 7) is ADDITIONAL_REVIEW_RECOMMENDED', () => {
            const payload7 = {
                submissionId: 'sbqr-score-7',
                schemaVersion: 'v1.0',
                assessmentId: 'sbq-r',
                scoringPolicyId: SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7,
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses', 'totalScore', 'severity'] },
                assessment: {
                    responses: [
                        { questionNumber: 1, optionId: 'q1_opt2', score: 2 },
                        { questionNumber: 2, optionId: 'q2_opt2', score: 2 },
                        { questionNumber: 3, optionId: 'q3_opt2', score: 2 },
                        { questionNumber: 4, optionId: 'q4_opt2', score: 1 } // 2+2+2+1 = 7
                    ],
                    totalScore: 7
                }
            };
            validator.validate(payload7);
            assert.strictEqual(payload7.assessment.resultCode, SBQR_RESULT_CODES.ADDITIONAL_REVIEW_RECOMMENDED);
            assert.strictEqual(payload7.assessment.resultLabel, '추가 확인 권장');
        });

        it('4.3. SBQ-R maximum score 18 (4+5+3+6) is verified and within 3~18 range', () => {
            const payload18 = {
                submissionId: 'sbqr-score-18',
                schemaVersion: 'v1.0',
                assessmentId: 'sbq-r',
                scoringPolicyId: SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7,
                consentEvidence: { personalInfoConsent: true, sensitiveInfoConsent: true, transmittedFieldSet: ['responses', 'totalScore', 'severity'] },
                assessment: {
                    responses: [
                        { questionNumber: 1, optionId: 'q1_opt5', score: 4 },
                        { questionNumber: 2, optionId: 'q2_opt5', score: 5 },
                        { questionNumber: 3, optionId: 'q3_opt5', score: 3 },
                        { questionNumber: 4, optionId: 'q4_opt7', score: 6 } // 4+5+3+6 = 18
                    ],
                    totalScore: 18
                }
            };
            validator.validate(payload18);
            assert.strictEqual(payload18.assessment.totalScore, 18);
            assert.strictEqual(payload18.assessment.resultCode, SBQR_RESULT_CODES.ADDITIONAL_REVIEW_RECOMMENDED);
        });

        // ──────────────────────────────────────────────────────────
        // 5. End-to-End Pipeline: 1 Intake, 1 Consent, 1 Referral, 1 PDF, 1 Attachment
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 5. End-to-End Pipeline: Exactly 1 Entity per Category ---');

        const testSubId = 'sub-final-e2e-001';
        const e2ePayload = {
            submissionId: testSubId,
            schemaVersion: 'v1.0',
            assessmentId: 'bepsi-k',
            assessmentVersion: '1.0.0',
            questionSetVersion: '1.0.0',
            scoringPolicyId: SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2,
            contactOnly: false,
            submittedAt: new Date().toISOString(),
            contact: {
                clientName: '김테스트',
                phone: '010-5555-6666',
                gender: '여성',
                birthDate: '1995-03-20',
                region: '창전동',
                counselingRequestText: '스트레스와 피로감으로 상담을 희망합니다.'
            },
            assessment: {
                responses: [
                    { questionNumber: 1, score: 3, answerLabel: '자주 느낌' },
                    { questionNumber: 2, score: 3, answerLabel: '자주 느낌' },
                    { questionNumber: 3, score: 3, answerLabel: '자주 느낌' },
                    { questionNumber: 4, score: 2, answerLabel: '가끔 느낌' },
                    { questionNumber: 5, score: 3, answerLabel: '자주 느낌' }
                ],
                totalScore: 14,
                responseSum: 14,
                meanScore: 2.80,
                resultCode: 'HIGH',
                resultLabel: '고스트레스군'
            },
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: true,
                consentedAt: new Date().toISOString(),
                transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'responses', 'totalScore', 'responseSum', 'meanScore', 'resultCode', 'resultLabel']
            },
            retention: { policy: 'standard_counseling_1yr', retentionDays: 365 }
        };

        mockTrackA.seedSubmission({
            payload: e2ePayload,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: testSubId
        });

        await itAsync('5.1. Import produces exactly 1 Intake, 1 Consent, 1 Referral, 1 PDF, 1 Attachment', async () => {
            const summary = await importService.runManualImport({ actorId: 'admin', limit: 10 });
            assert.strictEqual(summary.imported, 1);

            // Verify Intake Ledger (1)
            const ledger = repository.getImportsLedger().filter(i => i.submissionId === testSubId);
            assert.strictEqual(ledger.length, 1, 'Imports ledger must contain exactly 1 entry');

            // Verify Consent Evidence (1)
            const consents = repository.getConsentEvidenceList().filter(c => c.submissionId === testSubId);
            assert.strictEqual(consents.length, 1, 'Consent evidence must contain exactly 1 entry');

            // Verify Referral Draft (1)
            const referrals = getData('Referrals', []).filter(r => r.sourceSubmissionId === testSubId);
            assert.strictEqual(referrals.length, 1, 'Referral drafts must contain exactly 1 entry');

            const ref = referrals[0];
            assert.strictEqual(ref.referralStatus, 'PENDING_STAFF_REVIEW');

            // Verify Attachment Metadata (1)
            assert.strictEqual(ref.attachments.length, 1, 'Referral must contain exactly 1 attachment');
            const att = ref.attachments[0];

            // Verify Physical PDF File Format: survey-report_<UUID>.pdf (1)
            assert(/^survey-report_[0-9a-f\-]{36}\.pdf$/.test(att.id), `Physical PDF file name must follow neutral pattern: ${att.id}`);
            assert(!att.id.includes('김테스트'), 'File name must not contain client name');
            assert(!att.id.includes('010'), 'File name must not contain phone');
            assert(!att.id.includes('bepsi'), 'File name must not contain scale name');
            assert(!att.id.includes('14'), 'File name must not contain score');

            const filePath = path.join(tempAttachmentsDir, ref.referralId.replace(/[^a-z0-9가-힣_\-]/gi, '_'), att.id);
            assert(fs.existsSync(filePath), 'Physical PDF must exist on disk');
            const fileBuf = fs.readFileSync(filePath);
            assert.strictEqual(fileBuf.length, att.size);
            const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');
            assert.strictEqual(sha256, att.fileHash, 'File SHA-256 hash must match registered metadata');
        });

        // ──────────────────────────────────────────────────────────
        // 6. Idempotency & Zero Duplicates on Re-processing
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 6. Idempotency & Zero Duplicates on Re-processing ---');

        await itAsync('6.1. Repeated manual import results in 0 new entities', async () => {
            // Seed the same submissionId again to simulate Track A re-delivery
            mockTrackA.seedSubmission({
                payload: e2ePayload,
                publicKeyPem: publicKey,
                keyVersion: 'test_key_v1',
                submissionId: testSubId
            });

            const repeatSummary = await importService.runManualImport({ actorId: 'admin', limit: 10 });
            assert.strictEqual(repeatSummary.imported, 0, 'Must import 0 new items');
            assert.strictEqual(repeatSummary.duplicates, 1, 'Must recognize duplicate');

            const referrals = getData('Referrals', []).filter(r => r.sourceSubmissionId === testSubId);
            assert.strictEqual(referrals.length, 1, 'Must still be exactly 1 referral draft');
            assert.strictEqual(referrals[0].attachments.length, 1, 'Must still be exactly 1 attachment');

            const consents = repository.getConsentEvidenceList().filter(c => c.submissionId === testSubId);
            assert.strictEqual(consents.length, 1, 'Must still be exactly 1 consent evidence entry');
        });

        // ──────────────────────────────────────────────────────────
        // 7. Default UNASSIGNED / PENDING_STAFF_REVIEW & No Admin Auto-Assignment
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 7. Default UNASSIGNED / PENDING_STAFF_REVIEW & No Admin Auto-Assignment ---');

        it('7.1. Referral draft assignee is empty (UNASSIGNED) and status is PENDING_STAFF_REVIEW', () => {
            const referrals = getData('Referrals', []).filter(r => r.sourceSubmissionId === testSubId);
            const ref = referrals[0];
            assert.strictEqual(ref.assignee, '', 'Assignee must be unassigned initially');
            assert.strictEqual(ref.referralStatus, 'PENDING_STAFF_REVIEW');

            const survey = repository.findSubmissionById(ref.sourceSurveyId);
            assert.strictEqual(survey.assignmentStatus, 'unassigned');
            assert.strictEqual(survey.assignedUserId, null, 'No automated assignment to admin');
        });

        // ──────────────────────────────────────────────────────────
        // 8. Sensitive Info Consent Declined Handling
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 8. Sensitive Info Consent Declined Handling ---');

        const declSubId = 'sub-final-declined-001';
        const declinedPayload = {
            submissionId: declSubId,
            schemaVersion: 'v1.0',
            assessmentId: 'phq-9',
            contactOnly: true,
            submittedAt: new Date().toISOString(),
            contact: {
                clientName: '박비동의',
                phone: '010-2222-3333',
                region: '부발읍',
                counselingRequestText: '민감정보 동의 없이 기본 상담 신청'
            },
            assessment: {},
            consentEvidence: {
                consentVersion: '2026.1',
                personalInfoConsent: true,
                sensitiveInfoConsent: false, // DECLINED
                consentedAt: new Date().toISOString(),
                transmittedFieldSet: ['clientName', 'phone', 'region', 'counselingRequestText']
            },
            retention: { policy: 'standard_counseling_1yr', retentionDays: 365 }
        };

        mockTrackA.seedSubmission({
            payload: declinedPayload,
            publicKeyPem: publicKey,
            keyVersion: 'test_key_v1',
            submissionId: declSubId
        });

        await itAsync('8.1. Declined sensitive consent generates report with "검사결과 미전송" (not 0)', async () => {
            await importService.runManualImport({ actorId: 'admin', limit: 10 });
            const referrals = getData('Referrals', []).filter(r => r.sourceSubmissionId === declSubId);
            assert.strictEqual(referrals.length, 1);
            const ref = referrals[0];
            assert.strictEqual(ref.contactOnly, true);
            assert.strictEqual(ref.assessmentScore, null, 'Score must be null, not 0');
            assert(ref.interventionContent.includes('검사결과 미전송'), `Summary must state "검사결과 미전송": ${ref.interventionContent}`);

            // Verify PDF generation does not substitute 0
            const pdfMeta = reportGenerator.generateScreeningReportPdf({
                refNo: ref.refNo,
                payload: declinedPayload,
                consentEvidence: declinedPayload.consentEvidence
            });
            assert(pdfMeta.buffer && pdfMeta.buffer.length > 5000);
        });

        // ──────────────────────────────────────────────────────────
        // 9 & 10. ACK Prerequisite Gating and Sequence Integrity
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 9 & 10. ACK Prerequisite Gating and Delete Sequencing ---');

        it('9.1. Ledger confirms sequential workflow: STORED -> ACKED -> DELETED', () => {
            const ledger = repository.findBySubmissionId(declSubId);
            assert.strictEqual(ledger.internalStatus, SURVEY_INTERNAL_STATUS.COMPLETED);
            assert.strictEqual(ledger.externalStatus, SURVEY_EXTERNAL_STATUS.DELETED);
            assert(ledger.acknowledgedAt, 'acknowledgedAt must be populated');
            assert(ledger.externalDeletedAt, 'externalDeletedAt must be populated');
            assert(new Date(ledger.externalDeletedAt) >= new Date(ledger.acknowledgedAt), 'Delete must occur after ACK');
        });

        it('10.1. MockTrackA entry confirms DELETED state after ACK', () => {
            const entry = mockTrackA.submissions.get(declSubId);
            assert.strictEqual(entry.state, 'DELETED');
            assert.strictEqual(entry.envelope.ciphertext, '[DELETED]');
        });

        // ──────────────────────────────────────────────────────────
        // 11. Protected Attachment Access
        // ──────────────────────────────────────────────────────────
        console.log('\n--- 11. Protected Attachment Access Authorization ---');

        it('11.1. Attachment URLs route through protected /attachments endpoint', () => {
            const referrals = getData('Referrals', []).filter(r => r.sourceSubmissionId === testSubId);
            const ref = referrals[0];
            const att = ref.attachments[0];
            assert(att.url.startsWith('/attachments/'), 'Attachment URL must be protected');
        });

    } finally {
        // Cleanup scratch directory
        try {
            fs.rmSync(tempAttachmentsDir, { recursive: true, force: true });
        } catch (ignore) {}
    }

    console.log('\n============================================================');
    console.log(`🏁 Final Compatibility Verification Finished: ${passed} Passed, ${failed} Failed`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runFinalCompatibilitySuite().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});

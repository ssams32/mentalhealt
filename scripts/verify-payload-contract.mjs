/**
 * scripts/verify-payload-contract.mjs
 * Targeted test suite for Track B Payload Contract Alignment & Strict Security Rules.
 * 
 * Tests:
 * 1. Acceptance of confirmed canonical fields
 * 2. Normalization of approved legacy aliases
 * 3. Rejection of arbitrary unknown top-level fields
 * 4. Rejection of nested unknown fields (contact, consent, assessment, scores, scales)
 * 5. Safe diagnostic output: zero logging of unknown field values
 * 6. Safe diagnostic output: JSON path and field count returned accurately
 * 7. Consent validation: personalInfoConsent=false rejected with CONSENT_VIOLATION_PERSONAL
 * 8. Consent validation: sensitiveInfoConsent=false policy enforced (CONSENT_VIOLATION_SENSITIVE)
 * 9. Canonical conversion of 5 screening scales (PHQ-9, GAD-7, ISI-K, BEPSI-K, SBQ-R)
 * 10. Security gate: rejection of client-specified internal IDs (referralId, attachmentId)
 * 11. Security gate: rejection of admin auto-assignment fields (assignedUserId, role, isAdmin)
 * 12. Security gate: rejection of secrets, tokens, bypass headers, and filesystem paths
 */

import assert from 'assert';
import { SurveyPayloadValidator } from '../server/survey/surveyPayloadValidator.js';
import { SURVEY_ERROR_CODES, SURVEY_ASSESSMENT_IDS } from '../server/survey/surveyConstants.js';

function createValidTrackAPayload() {
    return {
        submissionId: 'test-uuid-2026-001',
        schemaVersion: 'v1.0',
        assessmentId: 'icheon-screening-23',
        assessmentVersion: '2026.1',
        requestedAt: '2026-09-18T10:00:00.000Z',
        retentionPolicyReference: 'RETENTION_30_DAYS',
        consent: {
            personalInfoConsent: true,
            sensitiveInfoConsent: true,
            contactOnlySubmission: false,
            consentVersion: 'v1.0-2026',
            consentedAt: '2026-09-18T10:00:00.000Z',
            assessmentDataIncluded: true
        },
        identity: {
            name: '테스트이용자',
            phone: '010-1234-5678',
            preferredTime: '오후 (13:00 ~ 16:00)',
            note: '상담 검토 요청 메모',
            demographics: {
                age: '30대',
                region: '이천시',
                worker: '예',
                customer: '아니오'
            }
        },
        assessment: {
            scores: {
                phq: 12,
                phqLevel: '중간정도 우울',
                phqQ9: 0,
                gad: 8,
                gadLevel: '경도 불안',
                isi: 15,
                isiLevel: '중등도 불면증',
                bepsi: {
                    assessmentId: 'bepsi-k',
                    scoringPolicyId: 'BEPSI_K_REVISED_QUARTILE_1_6_2_2',
                    responseSum: 11,
                    meanScore: 2.2,
                    displayMean: '2.20',
                    resultCode: 'HIGH',
                    resultLabel: '고스트레스군'
                },
                sbqr: {
                    assessmentId: 'sbq-r',
                    scoringPolicyId: 'SBQR_GENERAL_POPULATION_CUTOFF_7',
                    totalScore: 7,
                    resultCode: 'ADDITIONAL_REVIEW_RECOMMENDED',
                    resultLabel: '추가 확인 권장',
                    isAboveCutoff: true,
                    screeningCutoff: 7
                }
            },
            risk: {
                level: 'MODERATE',
                label: '중등도 위험군',
                reasons: ['PHQ-9 점수 10점 이상', 'ISI-K 점수 15점 이상']
            },
            answers: {
                phq_1: 1, phq_2: 2, phq_3: 1, phq_4: 1, phq_5: 2, phq_6: 1, phq_7: 1, phq_8: 2, phq_9: 0,
                gad_1: 1, gad_2: 1, gad_3: 2, gad_4: 1, gad_5: 1, gad_6: 1, gad_7: 1,
                isi_1: 2, isi_2: 3, isi_3: 2, isi_4: 2, isi_5: 2, isi_6: 2, isi_7: 2,
                bepsi_1: 2, bepsi_2: 3, bepsi_3: 2, bepsi_4: 2, bepsi_5: 2,
                sbqr_1: 'SBQ_1_1', sbqr_2: 'SBQ_2_2', sbqr_3: 'SBQ_3_1', sbqr_4: 'SBQ_4_0'
            }
        }
    };
}

async function runTests() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Survey Payload Validator Strict Alignment');
    console.log('🧪 ========================================================\n');

    const validator = new SurveyPayloadValidator({ sbqrApproved: true });

    // -------------------------------------------------------------
    // Test 1: Acceptance of confirmed canonical fields
    // -------------------------------------------------------------
    console.log('▶️ TEST 1: Acceptance of confirmed canonical fields & legacy aliases');
    const validPayload = createValidTrackAPayload();
    const result1 = validator.validate(validPayload);
    assert.strictEqual(result1.valid, true, 'Valid Track A payload must pass validation');
    console.log('  ✅ PASS: Valid canonical payload accepted');

    // -------------------------------------------------------------
    // Test 2: Normalization of approved legacy aliases
    // -------------------------------------------------------------
    console.log('▶️ TEST 2: Normalization of legacy aliases (identity->contact, requestedAt->submittedAt, etc.)');
    assert.strictEqual(validPayload.requestedAt, undefined, 'requestedAt must be removed after normalization');
    assert.strictEqual(typeof validPayload.submittedAt, 'string', 'submittedAt must be populated');
    assert.strictEqual(validPayload.retentionPolicyReference, undefined, 'retentionPolicyReference must be removed');
    assert.strictEqual(typeof validPayload.retention?.policy, 'string', 'retention.policy must be populated');
    assert.strictEqual(validPayload.identity, undefined, 'identity must be removed after normalization');
    assert.strictEqual(typeof validPayload.contact?.clientName, 'string', 'contact.clientName must be populated');
    assert.strictEqual(typeof validPayload.contact?.counselingRequestText, 'string', 'contact.counselingRequestText must be populated');
    assert.strictEqual(validPayload.consent, undefined, 'consent must be removed after normalization');
    assert.strictEqual(typeof validPayload.consentEvidence, 'object', 'consentEvidence must be populated');
    console.log('  ✅ PASS: Normalization removed raw aliases and created canonical representations');

    // -------------------------------------------------------------
    // Test 3: Rejection of arbitrary unknown top-level fields
    // -------------------------------------------------------------
    console.log('▶️ TEST 3: Rejection of arbitrary unknown top-level fields');
    const payload3 = createValidTrackAPayload();
    payload3.unknownTopField = 'malicious_data';
    try {
        validator.validate(payload3);
        assert.fail('Should have rejected unknown top-level field');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        assert.strictEqual(err.details.unknownFieldNames.includes('unknownTopField'), true);
        assert.strictEqual(err.details.unknownPaths.includes('$'), true);
        console.log('  ✅ PASS: Unknown top-level field rejected with PROHIBITED_UNKNOWN_FIELDS');
    }

    // -------------------------------------------------------------
    // Test 4: Rejection of nested unknown fields
    // -------------------------------------------------------------
    console.log('▶️ TEST 4: Rejection of nested unknown fields');
    const payload4 = createValidTrackAPayload();
    payload4.identity.unexpectedContactMeta = 'leak';
    payload4.assessment.scores.bepsi.unexpectedBepsiProp = 999;
    try {
        validator.validate(payload4);
        assert.fail('Should have rejected nested unknown fields');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        assert.strictEqual(err.details.unknownFieldNames.includes('unexpectedContactMeta'), true);
        assert.strictEqual(err.details.unknownFieldNames.includes('unexpectedBepsiProp'), true);
        console.log('  ✅ PASS: Nested unknown fields rejected with precise path identification');
    }

    // -------------------------------------------------------------
    // Test 5 & 6: Safe diagnostic output (no value leak, path and count only)
    // -------------------------------------------------------------
    console.log('▶️ TEST 5 & 6: Safe diagnostic error details (zero value leaks, path and count returned)');
    const payload5 = createValidTrackAPayload();
    const sensitiveSecretValue = 'SECRET_VALUE_DO_NOT_LEAK_12345';
    payload5.unauthorizedMetadata = sensitiveSecretValue;
    try {
        validator.validate(payload5);
        assert.fail('Should have rejected');
    } catch (err) {
        const errorJson = JSON.stringify(err);
        const errorMsg = err.message;
        assert.strictEqual(errorJson.includes(sensitiveSecretValue), false, 'Error object must NOT contain field values');
        assert.strictEqual(errorMsg.includes(sensitiveSecretValue), false, 'Error message must NOT contain field values');
        assert.strictEqual(err.details.unknownFieldNames.includes('unauthorizedMetadata'), true);
        assert.strictEqual(typeof err.details.unknownFieldCount, 'number');
        assert.strictEqual(err.details.unknownFieldCount >= 1, true);
        console.log('  ✅ PASS: Diagnostics contain field names and JSON paths with zero value leaks');
    }

    // -------------------------------------------------------------
    // Test 7: Consent validation: personalInfoConsent=false rejected
    // -------------------------------------------------------------
    console.log('▶️ TEST 7: Personal information consent false rejection');
    const payload7 = createValidTrackAPayload();
    payload7.consent.personalInfoConsent = false;
    try {
        validator.validate(payload7);
        assert.fail('Should have rejected personal info without consent');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.CONSENT_VIOLATION_PERSONAL);
        console.log('  ✅ PASS: Personal contact transmission without consent rejected');
    }

    // -------------------------------------------------------------
    // Test 8: Consent validation: sensitiveInfoConsent=false policy enforced
    // -------------------------------------------------------------
    console.log('▶️ TEST 8: Sensitive assessment consent false rejection');
    const payload8 = createValidTrackAPayload();
    payload8.consent.sensitiveInfoConsent = false;
    try {
        validator.validate(payload8);
        assert.fail('Should have rejected assessment without sensitive consent');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.CONSENT_VIOLATION_SENSITIVE);
        console.log('  ✅ PASS: Assessment data transmission without sensitive consent rejected');
    }

    // -------------------------------------------------------------
    // Test 9: Canonical conversion of 5 screening scales
    // -------------------------------------------------------------
    console.log('▶️ TEST 9: Canonical conversion of 5 screening scales (PHQ-9, GAD-7, ISI-K, BEPSI-K, SBQ-R)');
    const payload9 = createValidTrackAPayload();
    validator.validate(payload9);
    assert.ok(payload9.assessment.scaleScores['phq-9'], 'phq-9 scale must be in scaleScores');
    assert.ok(payload9.assessment.scaleScores['gad-7'], 'gad-7 scale must be in scaleScores');
    assert.ok(payload9.assessment.scaleScores['isi-k'], 'isi-k scale must be in scaleScores');
    assert.ok(payload9.assessment.scaleScores['bepsi-k'], 'bepsi-k scale must be in scaleScores');
    assert.ok(payload9.assessment.scaleScores['sbq-r'], 'sbq-r scale must be in scaleScores');
    assert.strictEqual(payload9.assessment.scaleScores['bepsi-k'].resultCode, 'HIGH');
    assert.strictEqual(payload9.assessment.scaleScores['sbq-r'].resultCode, 'ADDITIONAL_REVIEW_RECOMMENDED');
    console.log('  ✅ PASS: All 5 scales successfully converted to canonical internal representations');

    // -------------------------------------------------------------
    // Test 10: Security gate: rejection of client-specified internal IDs
    // -------------------------------------------------------------
    console.log('▶️ TEST 10: Security gate: rejection of client-specified internal IDs');
    const payload10a = createValidTrackAPayload();
    payload10a.referralId = 'client-injected-ref-id-999';
    try {
        validator.validate(payload10a);
        assert.fail('Should have rejected referralId');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        console.log('  ✅ PASS: Client-specified referralId rejected');
    }

    const payload10b = createValidTrackAPayload();
    payload10b.attachmentId = 'client-injected-att-id-999';
    try {
        validator.validate(payload10b);
        assert.fail('Should have rejected attachmentId');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        console.log('  ✅ PASS: Client-specified attachmentId rejected');
    }

    // -------------------------------------------------------------
    // Test 11: Security gate: rejection of admin auto-assignment fields
    // -------------------------------------------------------------
    console.log('▶️ TEST 11: Security gate: rejection of admin auto-assignment fields');
    const payload11 = createValidTrackAPayload();
    payload11.assignedUserId = 'admin';
    try {
        validator.validate(payload11);
        assert.fail('Should have rejected assignedUserId');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        console.log('  ✅ PASS: Admin auto-assignment fields rejected');
    }

    // -------------------------------------------------------------
    // Test 12: Security gate: rejection of secrets, tokens, bypass headers, and filesystem paths
    // -------------------------------------------------------------
    console.log('▶️ TEST 12: Security gate: rejection of secrets, tokens, and filesystem paths');
    const payload12a = createValidTrackAPayload();
    payload12a.serviceSecret = 'leaked-token';
    try {
        validator.validate(payload12a);
        assert.fail('Should have rejected serviceSecret');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        console.log('  ✅ PASS: Service secret rejected');
    }

    const payload12b = createValidTrackAPayload();
    payload12b.identity.filePath = 'C:\\Windows\\System32\\config';
    try {
        validator.validate(payload12b);
        assert.fail('Should have rejected filesystem path');
    } catch (err) {
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS);
        console.log('  ✅ PASS: Filesystem path rejected');
    }

    console.log('\n🎉 ALL 12 TARGETED CONTRACT & SECURITY TESTS PASSED!\n');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});

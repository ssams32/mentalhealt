/**
 * server/survey/surveyPayloadValidator.js
 * Validates decrypted survey submissions against schema, consent evidence,
 * allowlisted field sets, and strict SBQ-R safety gate.
 */

import {
    SURVEY_ERROR_CODES,
    SUPPORTED_PAYLOAD_SCHEMA_VERSIONS,
    SURVEY_ASSESSMENT_IDS,
    SURVEY_SCORING_POLICIES,
    SBQR_OFFICIAL_OPTION_SCORES,
    BEPSI_K_RESULT_CODES,
    SBQR_RESULT_CODES,
    TRACK_A_ASSESSMENT_QUESTION_COUNTS
} from './surveyConstants.js';
import { SurveyOperationError } from './surveyErrors.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set([
    'submissionId',
    'schemaVersion',
    'assessmentId',
    'assessmentVersion',
    'questionSetVersion',
    'scoringPolicyId',
    'contactOnly',
    'submittedAt',
    'completedAt',
    'consentEvidence',
    'contact',
    'assessment',
    'retention'
]);

const ALLOWED_CONTACT_KEYS = new Set([
    'clientName',
    'phone',
    'gender',
    'birthDate',
    'region',
    'address',
    'counselingRequestText'
]);

const ALLOWED_ASSESSMENT_KEYS = new Set([
    'answers',
    'responses',
    'totalScore',
    'responseSum',
    'meanScore',
    'severity',
    'resultCode',
    'resultLabel',
    'scoringPolicyId',
    'scaleScores',
    'riskFlag',
    'completedAt',
    'questionSetVersion',
    'assessmentVersion'
]);

// Prohibited definitive clinical words
const PROHIBITED_DEFINITIVE_WORDS = ['안전함', '위험 없음', '자살 고위험 확정', '진단됨'];

export class SurveyPayloadValidator {
    /**
     * @param {Object} [options]
     * @param {boolean} [options.sbqrApproved]
     */
    constructor(options = {}) {
        this.sbqrApproved = options.sbqrApproved !== undefined
            ? options.sbqrApproved
            : (process.env.SBQR_GATE_APPROVED === 'true');
    }

    /**
     * Validate decrypted payload and check consent and fieldset conformance.
     * 
     * @param {Object} payload
     * @returns {{ valid: boolean, isSbqrQuarantined: boolean, quarantineReason?: string }}
     */
    validate(payload) {
        if (!payload || typeof payload !== 'object') {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                'Decrypted payload must be a valid JSON object'
            );
        }

        // 1. Check prohibited unknown top-level keys
        for (const key of Object.keys(payload)) {
            if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS,
                    `Prohibited top-level property in payload: ${key}`
                );
            }
        }

        // 2. Validate core envelope identifiers
        if (!payload.submissionId || typeof payload.submissionId !== 'string') {
            throw new SurveyOperationError(SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA, 'Missing submissionId');
        }
        if (!SUPPORTED_PAYLOAD_SCHEMA_VERSIONS.includes(payload.schemaVersion)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
                `Unsupported payload schema version: ${payload.schemaVersion}`
            );
        }
        if (!payload.assessmentId || typeof payload.assessmentId !== 'string') {
            throw new SurveyOperationError(SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA, 'Missing assessmentId');
        }

        const assessmentId = payload.assessmentId.toLowerCase();

        // 3. Validate Consent Evidence
        const consent = payload.consentEvidence;
        if (!consent || typeof consent !== 'object') {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                'Missing consentEvidence block'
            );
        }

        if (!Array.isArray(consent.transmittedFieldSet)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.TRANSMITTED_FIELDSET_MISMATCH,
                'transmittedFieldSet must be an array of field names'
            );
        }
        const declaredFields = new Set(consent.transmittedFieldSet);

        // 4. Personal Information Consent Verification
        const contact = payload.contact || {};
        const contactKeys = Object.keys(contact).filter(k => contact[k] !== undefined && contact[k] !== null && contact[k] !== '');

        if (contactKeys.length > 0) {
            if (consent.personalInfoConsent !== true) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.CONSENT_VIOLATION_PERSONAL,
                    'Personal contact fields provided without verified personalInfoConsent'
                );
            }

            for (const cKey of contactKeys) {
                if (!ALLOWED_CONTACT_KEYS.has(cKey)) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS,
                        `Prohibited field in contact object: ${cKey}`
                    );
                }
                if (!declaredFields.has(cKey)) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.TRANSMITTED_FIELDSET_MISMATCH,
                        `Contact field '${cKey}' transmitted but not declared in transmittedFieldSet`
                    );
                }
            }
        }

        // 5. Sensitive Assessment Data Consent Verification
        const assessment = payload.assessment;
        const hasAssessmentData = assessment && typeof assessment === 'object' && Object.keys(assessment).length > 0;

        if (hasAssessmentData) {
            if (consent.sensitiveInfoConsent !== true) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.CONSENT_VIOLATION_SENSITIVE,
                    'Sensitive assessment fields provided without verified sensitiveInfoConsent'
                );
            }

            for (const aKey of Object.keys(assessment)) {
                if (!ALLOWED_ASSESSMENT_KEYS.has(aKey)) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS,
                        `Prohibited field in assessment object: ${aKey}`
                    );
                }
                if (!declaredFields.has(aKey)) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.TRANSMITTED_FIELDSET_MISMATCH,
                        `Assessment field '${aKey}' transmitted but not declared in transmittedFieldSet`
                    );
                }
            }

            // 6. Strict SBQ-R Gate Inspection (Fast-quarantine for unapproved legacy gate)
            if (assessmentId === SURVEY_ASSESSMENT_IDS.SBQ_R) {
                const hasCanonicalPolicy = payload.scoringPolicyId === SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7 ||
                                          payload.assessment?.scoringPolicyId === SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7;

                if (this.sbqrApproved === false && !hasCanonicalPolicy) {
                    return {
                        valid: true,
                        isSbqrQuarantined: true,
                        quarantineReason: 'SBQ-R is not approved for automated referral creation; quarantined by policy gate'
                    };
                }
            }

            // 7. Scale-Specific Validation for the 5 Contract Assessments
            this._validateScaleSpecificPayload(assessmentId, payload);
        }

        return {
            valid: true,
            isSbqrQuarantined: false,
            quarantineReason: null
        };
    }

    /**
     * Scale-specific validation and scoring policy verification.
     * @private
     */
    _validateScaleSpecificPayload(assessmentId, payload) {
        const assessment = payload.assessment || {};
        const responses = assessment.responses || assessment.answers;

        if (assessmentId === SURVEY_ASSESSMENT_IDS.BEPSI_K) {
            this._validateBepsiK(payload, assessment, responses);
        } else if (assessmentId === SURVEY_ASSESSMENT_IDS.SBQ_R) {
            this._validateSbqR(payload, assessment, responses);
        } else if (assessmentId === SURVEY_ASSESSMENT_IDS.PHQ_9) {
            this._validatePhq9(assessment, responses);
        } else if (assessmentId === SURVEY_ASSESSMENT_IDS.GAD_7) {
            this._validateGad7(assessment, responses);
        } else if (assessmentId === SURVEY_ASSESSMENT_IDS.ISI_K) {
            this._validateIsiK(assessment, responses);
        }
    }

    /**
     * BEPSI-K Validation:
     * - Exactly 5 responses, 1~5 points each
     * - responseSum: 5~25
     * - meanScore = responseSum / 5
     * - Categorization based on unrounded mean:
     *   mean < 1.6: LOW
     *   1.6 <= mean < 2.2: MODERATE
     *   mean >= 2.2: HIGH
     */
    _validateBepsiK(payload, assessment, responses) {
        const scoringPolicy = payload.scoringPolicyId || assessment.scoringPolicyId;
        if (scoringPolicy && scoringPolicy !== SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                `Invalid BEPSI-K scoringPolicyId: ${scoringPolicy}`
            );
        }

        if (Array.isArray(responses)) {
            if (responses.length !== 5) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `BEPSI-K requires exactly 5 responses, received ${responses.length}`
                );
            }

            let sum = 0;
            for (let i = 0; i < 5; i++) {
                const item = responses[i];
                const score = typeof item === 'number' ? item : (item && typeof item.score === 'number' ? item.score : null);
                if (score === null || score < 1 || score > 5 || !Number.isInteger(score)) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                        `BEPSI-K response ${i + 1} score must be an integer between 1 and 5 (got ${score})`
                    );
                }
                sum += score;
            }

            if (sum < 5 || sum > 25) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `BEPSI-K responseSum must be between 5 and 25 (got ${sum})`
                );
            }

            const mean = sum / 5;

            // Verify with transmitted responseSum if provided
            const transmittedSum = assessment.responseSum ?? assessment.totalScore;
            if (transmittedSum !== undefined && transmittedSum !== null && transmittedSum !== sum) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `BEPSI-K responseSum mismatch: calculated ${sum}, transmitted ${transmittedSum}`
                );
            }

            // Verify with transmitted meanScore if provided
            if (assessment.meanScore !== undefined && assessment.meanScore !== null) {
                if (Math.abs(assessment.meanScore - mean) > 0.01) {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                        `BEPSI-K meanScore mismatch: calculated ${mean}, transmitted ${assessment.meanScore}`
                    );
                }
            }

            // Categorization based on unrounded mean
            let calculatedResultCode;
            let calculatedResultLabel;
            if (mean < 1.6) {
                calculatedResultCode = BEPSI_K_RESULT_CODES.LOW;
                calculatedResultLabel = '저스트레스군';
            } else if (mean < 2.2) {
                calculatedResultCode = BEPSI_K_RESULT_CODES.MODERATE;
                calculatedResultLabel = '중등도 스트레스군';
            } else {
                calculatedResultCode = BEPSI_K_RESULT_CODES.HIGH;
                calculatedResultLabel = '고스트레스군';
            }

            // Sync to assessment object for downstream reporting & storage
            assessment.responseSum = sum;
            assessment.totalScore = sum;
            assessment.meanScore = Number(mean.toFixed(2));
            assessment.rawMeanScore = mean;
            assessment.resultCode = assessment.resultCode || calculatedResultCode;
            assessment.resultLabel = assessment.resultLabel || calculatedResultLabel;
            assessment.severity = assessment.resultLabel;
            assessment.scoringPolicyId = SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2;
        } else if (assessment.meanScore !== undefined || assessment.totalScore !== undefined) {
            // Summary-only BEPSI-K
            const score = assessment.responseSum ?? assessment.totalScore;
            const mean = assessment.meanScore ?? (score ? score / 5 : null);
            if (score !== undefined && (score < 5 || score > 25)) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `BEPSI-K score must be between 5 and 25 (got ${score})`
                );
            }
            if (mean !== null) {
                if (mean < 1.6) {
                    assessment.resultCode = BEPSI_K_RESULT_CODES.LOW;
                    assessment.resultLabel = '저스트레스군';
                } else if (mean < 2.2) {
                    assessment.resultCode = BEPSI_K_RESULT_CODES.MODERATE;
                    assessment.resultLabel = '중등도 스트레스군';
                } else {
                    assessment.resultCode = BEPSI_K_RESULT_CODES.HIGH;
                    assessment.resultLabel = '고스트레스군';
                }
                assessment.severity = assessment.resultLabel;
            }
        }
    }

    /**
     * SBQ-R Validation:
     * - Exactly 4 items
     * - Official optionId based score matrices:
     *   Q1: [1, 2, 3, 3, 4, 4]
     *   Q2: [1, 2, 3, 4, 5]
     *   Q3: [1, 2, 2, 3, 3]
     *   Q4: [0, 1, 2, 3, 4, 5, 6]
     * - Total score range: 3~18
     * - totalScore < 7: BELOW_SCREENING_CUTOFF
     * - totalScore >= 7: ADDITIONAL_REVIEW_RECOMMENDED
     * - Server-side revalidation of optionId and scores; array index is NOT used as score.
     * - Prohibit definitive wording (안전함, 위험 없음, 자살 고위험 확정, 진단됨)
     */
    _validateSbqR(payload, assessment, responses) {
        // Enforce scoring policy if provided
        const scoringPolicy = payload.scoringPolicyId || assessment.scoringPolicyId;
        if (scoringPolicy && scoringPolicy !== SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                `Invalid SBQ-R scoringPolicyId: ${scoringPolicy}`
            );
        }

        // Check prohibited definitive wording in labels/notes
        this._assertNoDefinitiveWords(assessment);

        if (Array.isArray(responses)) {
            if (responses.length !== 4) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `SBQ-R requires exactly 4 items, received ${responses.length}`
                );
            }

            const qTables = [
                SBQR_OFFICIAL_OPTION_SCORES.q1,
                SBQR_OFFICIAL_OPTION_SCORES.q2,
                SBQR_OFFICIAL_OPTION_SCORES.q3,
                SBQR_OFFICIAL_OPTION_SCORES.q4
            ];

            let calculatedTotal = 0;

            for (let i = 0; i < 4; i++) {
                const item = responses[i];
                const table = qTables[i];

                let optionIndex = null;
                let transmittedScore = null;

                if (typeof item === 'object' && item !== null) {
                    transmittedScore = typeof item.score === 'number' ? item.score : null;

                    // OptionId resolution
                    if (item.optionId !== undefined && item.optionId !== null) {
                        const optStr = String(item.optionId).trim();
                        // Extract trailing number if format is e.g. q1_3 or opt_2 or pure number
                        const match = optStr.match(/(\d+)$/);
                        if (match) {
                            const parsedNum = parseInt(match[1], 10);
                            // Determine if 1-indexed (1..N) or 0-indexed (0..N-1)
                            if (parsedNum >= 1 && parsedNum <= table.length) {
                                optionIndex = parsedNum - 1;
                            } else if (parsedNum === 0 && parsedNum < table.length) {
                                optionIndex = parsedNum;
                            }
                        }
                    } else if (typeof item.selectedOptionIndex === 'number') {
                        optionIndex = item.selectedOptionIndex;
                    }
                } else if (typeof item === 'number') {
                    transmittedScore = item;
                }

                // If optionIndex was resolved, verify official score from table
                if (optionIndex !== null && optionIndex >= 0 && optionIndex < table.length) {
                    const officialScore = table[optionIndex];
                    if (transmittedScore !== null && transmittedScore !== officialScore) {
                        throw new SurveyOperationError(
                            SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                            `SBQ-R Q${i + 1} score mismatch: optionId maps to official score ${officialScore}, but received ${transmittedScore}`
                        );
                    }
                    calculatedTotal += officialScore;
                } else if (transmittedScore !== null) {
                    // OptionId missing but score provided: verify score belongs to allowed scores for this question
                    if (!table.includes(transmittedScore)) {
                        throw new SurveyOperationError(
                            SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                            `SBQ-R Q${i + 1} score ${transmittedScore} is not in allowed official scores: [${table.join(', ')}]`
                        );
                    }
                    calculatedTotal += transmittedScore;
                } else {
                    throw new SurveyOperationError(
                        SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                        `SBQ-R Q${i + 1} missing valid optionId or score`
                    );
                }
            }

            if (calculatedTotal < 3 || calculatedTotal > 18) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `SBQ-R totalScore must be between 3 and 18 (calculated ${calculatedTotal})`
                );
            }

            if (assessment.totalScore !== undefined && assessment.totalScore !== null && assessment.totalScore !== calculatedTotal) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `SBQ-R totalScore mismatch: calculated ${calculatedTotal}, transmitted ${assessment.totalScore}`
                );
            }

            assessment.totalScore = calculatedTotal;
            assessment.scoringPolicyId = SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7;

            if (calculatedTotal < 7) {
                assessment.resultCode = SBQR_RESULT_CODES.BELOW_SCREENING_CUTOFF;
                assessment.resultLabel = '선별 기준점 미만';
                assessment.severity = '선별 기준점 미만 (추가 확인 권장 대상 아님)';
            } else {
                assessment.resultCode = SBQR_RESULT_CODES.ADDITIONAL_REVIEW_RECOMMENDED;
                assessment.resultLabel = '추가 확인 권장';
                assessment.severity = '추가 확인 권장 (전문가 상담 권장)';
            }
        } else if (assessment.totalScore !== undefined && assessment.totalScore !== null) {
            // Summary totalScore provided
            const total = assessment.totalScore;
            if (total < 3 || total > 18) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `SBQ-R totalScore must be between 3 and 18 (got ${total})`
                );
            }

            assessment.scoringPolicyId = SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7;
            if (total < 7) {
                assessment.resultCode = SBQR_RESULT_CODES.BELOW_SCREENING_CUTOFF;
                assessment.resultLabel = '선별 기준점 미만';
                assessment.severity = '선별 기준점 미만 (추가 확인 권장 대상 아님)';
            } else {
                assessment.resultCode = SBQR_RESULT_CODES.ADDITIONAL_REVIEW_RECOMMENDED;
                assessment.resultLabel = '추가 확인 권장';
                assessment.severity = '추가 확인 권장 (전문가 상담 권장)';
            }
        }
    }

    _validatePhq9(assessment, responses) {
        if (Array.isArray(responses) && responses.length === 9) {
            let sum = 0;
            for (let i = 0; i < 9; i++) {
                const item = responses[i];
                const score = typeof item === 'number' ? item : (item && typeof item.score === 'number' ? item.score : 0);
                sum += score;
            }
            if (assessment.totalScore === undefined) {
                assessment.totalScore = sum;
            }
        }
    }

    _validateGad7(assessment, responses) {
        if (Array.isArray(responses) && responses.length === 7) {
            let sum = 0;
            for (let i = 0; i < 7; i++) {
                const item = responses[i];
                const score = typeof item === 'number' ? item : (item && typeof item.score === 'number' ? item.score : 0);
                sum += score;
            }
            if (assessment.totalScore === undefined) {
                assessment.totalScore = sum;
            }
        }
    }

    _validateIsiK(assessment, responses) {
        if (Array.isArray(responses) && responses.length === 7) {
            let sum = 0;
            for (let i = 0; i < 7; i++) {
                const item = responses[i];
                const score = typeof item === 'number' ? item : (item && typeof item.score === 'number' ? item.score : 0);
                sum += score;
            }
            if (assessment.totalScore === undefined) {
                assessment.totalScore = sum;
            }
        }
    }

    /**
     * Prohibit definitive medical/safety assertions.
     * @private
     */
    _assertNoDefinitiveWords(assessment) {
        const textToCheck = [
            assessment.severity,
            assessment.resultLabel,
            assessment.riskFlag
        ].filter(Boolean).join(' ');

        for (const word of PROHIBITED_DEFINITIVE_WORDS) {
            if (textToCheck.includes(word)) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `Prohibited definitive clinical assertion in SBQ-R result: '${word}' is not permitted`
                );
            }
        }
    }
}


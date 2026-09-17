/**
 * server/survey/surveyPayloadValidator.js
 * Validates decrypted survey submissions against schema, consent evidence,
 * allowlisted field sets, and strict SBQ-R safety gate.
 */

import {
    SURVEY_ERROR_CODES,
    SUPPORTED_PAYLOAD_SCHEMA_VERSIONS,
    SURVEY_ASSESSMENT_IDS
} from './surveyConstants.js';
import { SurveyOperationError } from './surveyErrors.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set([
    'submissionId',
    'schemaVersion',
    'assessmentId',
    'assessmentVersion',
    'contactOnly',
    'submittedAt',
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
    'meanScore',
    'severity',
    'scaleScores',
    'riskFlag'
]);

export class SurveyPayloadValidator {
    /**
     * @param {Object} [options]
     * @param {boolean} [options.sbqrApproved=false]
     */
    constructor(options = {}) {
        this.sbqrApproved = options.sbqrApproved || process.env.SBQR_GATE_APPROVED === 'true';
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
        }

        // 6. Strict SBQ-R Gate Inspection
        let isSbqrQuarantined = false;
        let quarantineReason = null;

        if (payload.assessmentId === SURVEY_ASSESSMENT_IDS.SBQ_R) {
            if (!this.sbqrApproved) {
                isSbqrQuarantined = true;
                quarantineReason = 'SBQ-R is not approved for automated referral creation; quarantined by policy gate';
            }
        }

        return {
            valid: true,
            isSbqrQuarantined,
            quarantineReason
        };
    }
}

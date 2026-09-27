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
    'requestedAt',
    'completedAt',
    'consentEvidence',
    'consent',
    'contact',
    'identity',
    'assessment',
    'retention',
    'retentionPolicyReference',
    'scaleScores',
    'requestType',
    'consultationRequested',
    'consultationRequestedAt',
    'screeningCompletedAt'
]);

const ALLOWED_CONTACT_KEYS = new Set([
    'clientName',
    'name',
    'phone',
    'gender',
    'birthDate',
    'region',
    'address',
    'counselingRequestText',
    'note',
    'preferredTime',
    'demographics'
]);

const ALLOWED_DEMOGRAPHICS_KEYS = new Set([
    'age',
    'region',
    'worker',
    'customer'
]);

const ALLOWED_CONSENT_KEYS = new Set([
    'personalInfoConsent',
    'sensitiveInfoConsent',
    'contactOnlySubmission',
    'consentVersion',
    'consentedAt',
    'assessmentDataIncluded',
    'transmittedFieldSet'
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
    'scales',
    'scores',
    'risk',
    'phq9',
    'gad7',
    'isik',
    'bepsik',
    'sbqr',
    'riskFlag',
    'completedAt',
    'questionSetVersion',
    'assessmentVersion'
]);

const ALLOWED_SCORES_KEYS = new Set([
    'phq',
    'phqLevel',
    'phqQ9',
    'gad',
    'gadLevel',
    'isi',
    'isiLevel',
    'bepsi',
    'sbqr',
    'bepsik',
    'isik',
    'phq9',
    'gad7'
]);

const ALLOWED_BEPSI_KEYS = new Set([
    'assessmentId',
    'scoringPolicyId',
    'responseSum',
    'meanScore',
    'displayMean',
    'resultCode',
    'resultLabel',
    'sum',
    'mean',
    'responses',
    'answers'
]);

const ALLOWED_SBQR_KEYS = new Set([
    'assessmentId',
    'scoringPolicyId',
    'totalScore',
    'resultCode',
    'resultLabel',
    'isAboveCutoff',
    'screeningCutoff',
    'responses',
    'answers'
]);

const ALLOWED_RISK_KEYS = new Set([
    'level',
    'label',
    'reasons'
]);

const ALLOWED_RETENTION_KEYS = new Set([
    'policy',
    'retentionPolicyReference'
]);

// Prohibited security property names (lowercased without punctuation)
const FORBIDDEN_SECURITY_KEY_NAMES = new Set([
    'privatekey',
    'private_key',
    'rsaprivatekey',
    'secretkey',
    'servicesecret',
    'apikey',
    'token',
    'upstashtoken',
    'secret',
    'vercelbypasssecret',
    'x-vercel-protection-bypass',
    'authorization',
    'bearer',
    'rawciphertext',
    'isadmin',
    'role',
    'assigneduserid',
    'assignedadmin',
    'autoassign',
    'referralid',
    'attachmentid',
    'internalsurveyid',
    'internalimportid'
]);

// Prohibited definitive clinical words
const PROHIBITED_DEFINITIVE_WORDS = ['안전함', '위험 없음', '자살 고위험 확정', '진단됨'];

class UnknownFieldCollector {
    constructor() {
        this.byPath = {};
        this.totalCount = 0;
    }

    add(pathStr, fieldName) {
        if (!this.byPath[pathStr]) {
            this.byPath[pathStr] = [];
        }
        if (!this.byPath[pathStr].includes(fieldName)) {
            this.byPath[pathStr].push(fieldName);
            this.totalCount++;
        }
    }

    hasErrors() {
        return this.totalCount > 0;
    }

    toErrorDetails() {
        const unknownFieldNames = [];
        const unknownPaths = Object.keys(this.byPath);
        for (const p of unknownPaths) {
            for (const fn of this.byPath[p]) {
                if (!unknownFieldNames.includes(fn)) {
                    unknownFieldNames.push(fn);
                }
            }
        }
        return {
            unknownFieldNames,
            unknownPaths,
            unknownFieldCount: this.totalCount,
            unknownFieldsByPath: this.byPath
        };
    }
}

export function normalizeCanonicalAge(ageRaw) {
    if (ageRaw === undefined || ageRaw === null) return null;

    // 1. Integer actual age in safe range 0..120
    if (typeof ageRaw === 'number') {
        if (Number.isInteger(ageRaw) && ageRaw >= 0 && ageRaw <= 120) {
            return ageRaw;
        }
        return null;
    }

    // 2. Legacy official age-band string
    if (typeof ageRaw === 'string') {
        const trimmed = ageRaw.trim();
        if (!trimmed) return null;

        const legacyBands = new Set([
            '10대 미만', '10대', '20대', '30대', '40대', '50대', '60대',
            '70대 이상', '70대이상', '70대', '80대 이상', '80대이상'
        ]);

        if (legacyBands.has(trimmed)) {
            if (trimmed === '70대이상') return '70대 이상';
            if (trimmed === '80대이상') return '80대 이상';
            return trimmed;
        }

        return null;
    }

    return null;
}

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
     * Recursively assert no security secrets, admin overrides, or filesystem paths.
     * @private
     */
    _checkSecurityViolations(obj, currentPath = '$', collector) {
        if (!obj || typeof obj !== 'object') {
            if (typeof obj === 'string') {
                if (obj.includes('BEGIN PRIVATE KEY') || obj.includes('BEGIN RSA PRIVATE KEY')) {
                    collector.add(currentPath, '[PLAINTEXT_PRIVATE_KEY]');
                } else if (/^(?:[a-zA-Z]:[\\\/]|\/(?:etc|var|usr|home|tmp|root|bin|sbin)[\\\/])/.test(obj)) {
                    collector.add(currentPath, '[FILESYSTEM_PATH]');
                }
            }
            return;
        }

        for (const [key, value] of Object.entries(obj)) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
            const fieldPath = currentPath === '$' ? `$.${key}` : `${currentPath}.${key}`;

            if (FORBIDDEN_SECURITY_KEY_NAMES.has(normalizedKey)) {
                collector.add(currentPath, key);
            }

            if (value && typeof value === 'object') {
                this._checkSecurityViolations(value, fieldPath, collector);
            } else if (typeof value === 'string') {
                if (value.includes('BEGIN PRIVATE KEY') || value.includes('BEGIN RSA PRIVATE KEY')) {
                    collector.add(fieldPath, '[PLAINTEXT_PRIVATE_KEY]');
                } else if (/^(?:[a-zA-Z]:[\\\/]|\/(?:etc|var|usr|home|tmp|root|bin|sbin)[\\\/])/.test(value)) {
                    collector.add(fieldPath, '[FILESYSTEM_PATH]');
                }
            }
        }
    }

    /**
     * Inspect all hierarchical levels for unauthorized unknown fields.
     * @private
     */
    _collectUnknownFields(payload) {
        const collector = new UnknownFieldCollector();

        // 1. Security scan
        this._checkSecurityViolations(payload, '$', collector);

        // 2. Top-level keys check
        for (const key of Object.keys(payload)) {
            if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
                collector.add('$', key);
            }
        }

        // 3. Contact / Identity keys check
        for (const [obj, basePath] of [
            [payload.contact, '$.contact'],
            [payload.identity, '$.identity']
        ]) {
            if (obj && typeof obj === 'object') {
                for (const cKey of Object.keys(obj)) {
                    if (!ALLOWED_CONTACT_KEYS.has(cKey)) {
                        collector.add(basePath, cKey);
                    }
                }

                if (obj.demographics && typeof obj.demographics === 'object') {
                    const demoPath = `${basePath}.demographics`;
                    for (const dKey of Object.keys(obj.demographics)) {
                        if (!ALLOWED_DEMOGRAPHICS_KEYS.has(dKey)) {
                            collector.add(demoPath, dKey);
                        }
                    }
                }
            }
        }

        // 4. Consent / ConsentEvidence keys check
        const consentObj = payload.consentEvidence || payload.consent;
        if (consentObj && typeof consentObj === 'object') {
            const consentPath = payload.consent ? '$.consent' : '$.consentEvidence';
            for (const cKey of Object.keys(consentObj)) {
                if (!ALLOWED_CONSENT_KEYS.has(cKey)) {
                    collector.add(consentPath, cKey);
                }
            }
        }

        // 5. Retention keys check
        if (payload.retention && typeof payload.retention === 'object') {
            for (const rKey of Object.keys(payload.retention)) {
                if (!ALLOWED_RETENTION_KEYS.has(rKey)) {
                    collector.add('$.retention', rKey);
                }
            }
        }

        // 6. Assessment keys check
        const assessment = payload.assessment;
        if (assessment && typeof assessment === 'object') {
            for (const aKey of Object.keys(assessment)) {
                if (!ALLOWED_ASSESSMENT_KEYS.has(aKey)) {
                    collector.add('$.assessment', aKey);
                }
            }

            // Scores sub-object
            if (assessment.scores && typeof assessment.scores === 'object') {
                for (const sKey of Object.keys(assessment.scores)) {
                    if (!ALLOWED_SCORES_KEYS.has(sKey)) {
                        collector.add('$.assessment.scores', sKey);
                    }
                }

                if (assessment.scores.bepsi && typeof assessment.scores.bepsi === 'object') {
                    for (const bKey of Object.keys(assessment.scores.bepsi)) {
                        if (!ALLOWED_BEPSI_KEYS.has(bKey)) {
                            collector.add('$.assessment.scores.bepsi', bKey);
                        }
                    }
                }

                if (assessment.scores.sbqr && typeof assessment.scores.sbqr === 'object') {
                    for (const sbKey of Object.keys(assessment.scores.sbqr)) {
                        if (!ALLOWED_SBQR_KEYS.has(sbKey)) {
                            collector.add('$.assessment.scores.sbqr', sbKey);
                        }
                    }
                }
            }

            // Risk sub-object
            if (assessment.risk && typeof assessment.risk === 'object') {
                for (const rKey of Object.keys(assessment.risk)) {
                    if (!ALLOWED_RISK_KEYS.has(rKey)) {
                        collector.add('$.assessment.risk', rKey);
                    }
                }
            }
        }

        return collector;
    }

    /**
     * Normalize Track A legacy aliases into Track B canonical schema.
     * Original aliases are strictly removed from internal storage objects.
     * @private
     */
    _normalizePayload(payload) {
        // 0. requestType & consultationRequested canonicalization
        if (!payload.requestType) {
            payload.requestType = payload.consultationRequested ? 'CONSULTATION_REQUEST' : 'SCREENING_ONLY';
        }
        if (payload.consultationRequested === undefined) {
            payload.consultationRequested = payload.requestType === 'CONSULTATION_REQUEST';
        }

        // Canonical removal of worker & customer from demographics and contact
        if (payload.contact?.demographics) {
            delete payload.contact.demographics.worker;
            delete payload.contact.demographics.customer;
        }
        if (payload.identity?.demographics) {
            delete payload.identity.demographics.worker;
            delete payload.identity.demographics.customer;
        }
        if (payload.contact) {
            delete payload.contact.worker;
            delete payload.contact.customer;
        }

        // 1. requestedAt -> submittedAt
        if (payload.requestedAt !== undefined) {
            if (!payload.submittedAt) {
                payload.submittedAt = payload.requestedAt;
            }
            delete payload.requestedAt;
        }

        // 2. retentionPolicyReference -> retention
        if (payload.retentionPolicyReference !== undefined) {
            if (!payload.retention) {
                payload.retention = { policy: payload.retentionPolicyReference };
            }
            delete payload.retentionPolicyReference;
        }

        // 3. identity -> contact (contact priority, identity fallback)
        if (payload.identity && typeof payload.identity === 'object') {
            const id = payload.identity;
            if (!payload.contact || typeof payload.contact !== 'object') {
                payload.contact = {};
            }

            // clientName / name
            if (!payload.contact.clientName && !payload.contact.name) {
                if (id.clientName || id.name) {
                    payload.contact.clientName = id.clientName || id.name;
                }
            }
            // phone
            if (!payload.contact.phone && id.phone) {
                payload.contact.phone = id.phone;
            }
            // preferredTime
            if (!payload.contact.preferredTime && id.preferredTime) {
                payload.contact.preferredTime = id.preferredTime;
            }
            // counselingRequestText / note
            if (!payload.contact.counselingRequestText && !payload.contact.note) {
                if (id.counselingRequestText || id.note) {
                    payload.contact.counselingRequestText = id.counselingRequestText || id.note;
                }
            }
            // gender (contact.gender has priority; identity.gender is legacy fallback)
            const hasContactGender = payload.contact.gender !== undefined && payload.contact.gender !== null && String(payload.contact.gender).trim() !== '';
            if (!hasContactGender && id.gender !== undefined && id.gender !== null && String(id.gender).trim() !== '') {
                payload.contact.gender = id.gender;
            }
            // demographics (contact.demographics.age has priority; identity.demographics.age is legacy fallback)
            if (!payload.contact.demographics && id.demographics) {
                payload.contact.demographics = { ...id.demographics };
            } else if (payload.contact.demographics && typeof payload.contact.demographics === 'object' && id.demographics && typeof id.demographics === 'object') {
                const hasContactAge = payload.contact.demographics.age !== undefined && payload.contact.demographics.age !== null && String(payload.contact.demographics.age).trim() !== '';
                if (!hasContactAge && id.demographics.age !== undefined && id.demographics.age !== null && String(id.demographics.age).trim() !== '') {
                    payload.contact.demographics.age = id.demographics.age;
                }
                if (!payload.contact.demographics.region && id.demographics.region) {
                    payload.contact.demographics.region = id.demographics.region;
                }
            }
            // region
            if (!payload.contact.region) {
                payload.contact.region = payload.contact.demographics?.region || id.region || '';
            }

            delete payload.identity;
        }

        if (payload.contact && typeof payload.contact === 'object') {
            if (payload.contact.name !== undefined) {
                if (!payload.contact.clientName) {
                    payload.contact.clientName = payload.contact.name;
                }
                delete payload.contact.name;
            }
            if (payload.contact.note !== undefined) {
                if (!payload.contact.counselingRequestText) {
                    payload.contact.counselingRequestText = payload.contact.note;
                }
                delete payload.contact.note;
            }
            if (payload.contact.demographics && typeof payload.contact.demographics === 'object') {
                if (payload.contact.demographics.age !== undefined && payload.contact.demographics.age !== null) {
                    const normalizedAge = normalizeCanonicalAge(payload.contact.demographics.age);
                    if (normalizedAge !== null) {
                        payload.contact.demographics.age = normalizedAge;
                    } else {
                        payload.contact.demographics.age = null;
                    }
                }
            }
        }

        // 4. consent -> consentEvidence
        if (payload.consent && typeof payload.consent === 'object') {
            if (!payload.consentEvidence) {
                payload.consentEvidence = {
                    personalInfoConsent: Boolean(payload.consent.personalInfoConsent),
                    sensitiveInfoConsent: Boolean(payload.consent.sensitiveInfoConsent),
                    contactOnlySubmission: Boolean(payload.consent.contactOnlySubmission),
                    consentVersion: payload.consent.consentVersion || 'v1.0-2026',
                    consentedAt: payload.consent.consentedAt || new Date().toISOString(),
                    assessmentDataIncluded: Boolean(payload.consent.assessmentDataIncluded)
                };
            }
            delete payload.consent;
        }

        // 5. assessment scale conversion (scores -> canonical scaleScores)
        if (payload.assessment && typeof payload.assessment === 'object') {
            const assessment = payload.assessment;
            if (assessment.scores && typeof assessment.scores === 'object') {
                const s = assessment.scores;
                const canonicalScales = assessment.scaleScores || {};

                // PHQ-9
                if (s.phq !== undefined || s.phqLevel !== undefined) {
                    canonicalScales['phq-9'] = canonicalScales['phq-9'] || {
                        assessmentId: 'phq-9',
                        totalScore: s.phq,
                        severity: s.phqLevel,
                        q9Score: s.phqQ9
                    };
                    canonicalScales.phq9 = canonicalScales['phq-9'];
                }

                // GAD-7
                if (s.gad !== undefined || s.gadLevel !== undefined) {
                    canonicalScales['gad-7'] = canonicalScales['gad-7'] || {
                        assessmentId: 'gad-7',
                        totalScore: s.gad,
                        severity: s.gadLevel
                    };
                    canonicalScales.gad7 = canonicalScales['gad-7'];
                }

                // ISI-K
                if (s.isi !== undefined || s.isiLevel !== undefined) {
                    canonicalScales['isi-k'] = canonicalScales['isi-k'] || {
                        assessmentId: 'isi-k',
                        totalScore: s.isi,
                        severity: s.isiLevel
                    };
                    canonicalScales.isik = canonicalScales['isi-k'];
                }

                // BEPSI-K
                const bepsiSrc = s.bepsi || s.bepsik || s['bepsi-k'];
                if (bepsiSrc && typeof bepsiSrc === 'object') {
                    canonicalScales['bepsi-k'] = canonicalScales['bepsi-k'] || {
                        assessmentId: 'bepsi-k',
                        scoringPolicyId: bepsiSrc.scoringPolicyId || SURVEY_SCORING_POLICIES.BEPSI_K_REVISED_QUARTILE_1_6_2_2,
                        responseSum: bepsiSrc.responseSum,
                        meanScore: bepsiSrc.meanScore,
                        displayMean: bepsiSrc.displayMean,
                        resultCode: bepsiSrc.resultCode,
                        resultLabel: bepsiSrc.resultLabel
                    };
                    canonicalScales.bepsik = canonicalScales['bepsi-k'];
                }

                // SBQ-R
                const sbqSrc = s.sbqr || s['sbq-r'];
                if (sbqSrc && typeof sbqSrc === 'object') {
                    canonicalScales['sbq-r'] = canonicalScales['sbq-r'] || {
                        assessmentId: 'sbq-r',
                        scoringPolicyId: sbqSrc.scoringPolicyId || SURVEY_SCORING_POLICIES.SBQR_GENERAL_POPULATION_CUTOFF_7,
                        totalScore: sbqSrc.totalScore,
                        resultCode: sbqSrc.resultCode,
                        resultLabel: sbqSrc.resultLabel,
                        isAboveCutoff: sbqSrc.isAboveCutoff,
                        screeningCutoff: sbqSrc.screeningCutoff || 7
                    };
                    canonicalScales.sbqr = canonicalScales['sbq-r'];
                }

                assessment.scaleScores = canonicalScales;
                payload.scaleScores = canonicalScales;
            }
        }

        // 6. Synthesize or update transmittedFieldSet if missing
        if (payload.consentEvidence) {
            if (!Array.isArray(payload.consentEvidence.transmittedFieldSet)) {
                const declared = [];
                if (payload.contact) {
                    for (const k of Object.keys(payload.contact)) {
                        if (payload.contact[k] !== undefined && payload.contact[k] !== null && payload.contact[k] !== '') {
                            declared.push(k);
                        }
                    }
                }
                if (payload.assessment) {
                    for (const k of Object.keys(payload.assessment)) {
                        declared.push(k);
                    }
                }
                payload.consentEvidence.transmittedFieldSet = declared;
            } else {
                if (payload.assessment?.scaleScores && !payload.consentEvidence.transmittedFieldSet.includes('scaleScores')) {
                    payload.consentEvidence.transmittedFieldSet.push('scaleScores');
                }
                if (payload.contact?.demographics && !payload.consentEvidence.transmittedFieldSet.includes('demographics')) {
                    payload.consentEvidence.transmittedFieldSet.push('demographics');
                }
                if (payload.contact?.gender && !payload.consentEvidence.transmittedFieldSet.includes('gender')) {
                    payload.consentEvidence.transmittedFieldSet.push('gender');
                }
            }
        }
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

        // 1. Strict unknown fields & security violations collection
        const collector = this._collectUnknownFields(payload);
        if (collector.hasErrors()) {
            const details = collector.toErrorDetails();
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PROHIBITED_UNKNOWN_FIELDS,
                `Prohibited unknown fields detected: count=${details.unknownFieldCount}, paths=[${details.unknownPaths.join(', ')}]`,
                details
            );
        }

        // 1b. Validate requestType & consultationRequested contract
        if (payload.requestType !== undefined) {
            if (payload.requestType !== 'SCREENING_ONLY' && payload.requestType !== 'CONSULTATION_REQUEST') {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.UNKNOWN_REQUEST_TYPE || SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    `Unknown requestType: "${payload.requestType}". Must be 'SCREENING_ONLY' or 'CONSULTATION_REQUEST'`
                );
            }
        }

        if (payload.consultationRequested !== undefined) {
            if (typeof payload.consultationRequested !== 'boolean') {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    'consultationRequested must be a boolean'
                );
            }
        }

        if (payload.requestType === 'SCREENING_ONLY') {
            if (payload.consultationRequested === true) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    'SCREENING_ONLY cannot have consultationRequested=true'
                );
            }
            if (payload.consultationRequestedAt !== undefined && payload.consultationRequestedAt !== null && payload.consultationRequestedAt !== '') {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    'SCREENING_ONLY cannot have consultationRequestedAt'
                );
            }
        } else if (payload.requestType === 'CONSULTATION_REQUEST') {
            if (payload.consultationRequested === false) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    'CONSULTATION_REQUEST must have consultationRequested=true'
                );
            }
            if (!payload.consultationRequestedAt || isNaN(Date.parse(payload.consultationRequestedAt))) {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_PAYLOAD_SCHEMA,
                    'CONSULTATION_REQUEST requires a valid consultationRequestedAt timestamp'
                );
            }
        }

        // 2. Normalize approved legacy aliases to canonical shape
        this._normalizePayload(payload);

        // 3. Validate core envelope identifiers
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

        // 4. Validate Consent Evidence
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

        // 5. Personal Information Consent Verification
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

        // 6. Sensitive Assessment Data Consent Verification
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

            // 7. Strict SBQ-R Gate Inspection (Fast-quarantine for unapproved legacy gate)
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

            // 8. Scale-Specific Validation for the 5 Contract Assessments
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

        // Validate nested 5-scale scores if present in scaleScores object
        const nestedScales = assessment.scaleScores || assessment.scales;
        if (nestedScales && typeof nestedScales === 'object') {
            const bepsiObj = nestedScales.bepsik || nestedScales['bepsi-k'];
            if (bepsiObj && typeof bepsiObj === 'object') {
                this._validateBepsiK(bepsiObj, bepsiObj, bepsiObj.responses || bepsiObj.answers);
            }
            const sbqrObj = nestedScales.sbqr || nestedScales['sbq-r'];
            if (sbqrObj && typeof sbqrObj === 'object') {
                this._validateSbqR(sbqrObj, sbqrObj, sbqrObj.responses || sbqrObj.answers);
            }
            const phqObj = nestedScales.phq9 || nestedScales['phq-9'];
            if (phqObj && typeof phqObj === 'object') {
                this._validatePhq9(phqObj, phqObj.responses || phqObj.answers);
            }
            const gadObj = nestedScales.gad7 || nestedScales['gad-7'];
            if (gadObj && typeof gadObj === 'object') {
                this._validateGad7(gadObj, gadObj.responses || gadObj.answers);
            }
            const isiObj = nestedScales.isik || nestedScales['isi-k'];
            if (isiObj && typeof isiObj === 'object') {
                this._validateIsiK(isiObj, isiObj.responses || isiObj.answers);
            }
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


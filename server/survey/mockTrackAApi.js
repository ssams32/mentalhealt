/**
 * server/survey/mockTrackAApi.js
 * In-memory Mock External Collection API (Track A) strictly implementing
 * Track A canonical contract and state transitions for local integration testing.
 */

import crypto from 'crypto';
import { TRACK_A_ERROR_CODES } from './surveyConstants.js';

export class MockTrackAApi {
    constructor(options = {}) {
        this.submissions = new Map(); // submissionId -> { envelope, state, lease, ackAt, deletedAt }
        this.failAckNext = false;
        this.failDeleteNext = false;
        this.networkAvailable = true;
        this.simulateLeaseExpired = false;
        this.expectedWorkerId = options.workerId || 'track-b-worker-1';
        this.isProduction = options.isProduction || false;
    }

    setCounselingSubmissionEnabled(enabled) {
        this.counselingSubmissionEnabled = Boolean(enabled);
    }

    /**
     * Check if counseling submission is enabled on Track A gate.
     */
    async checkSubmissionGateStatus() {
        if (!this.networkAvailable) {
            const err = new Error('Track A service unreachable');
            err.statusCode = 503;
            err.code = 'NETWORK_ERROR';
            throw err;
        }
        if (this.counselingSubmissionEnabled === false) {
            return {
                enabled: false,
                message: 'COUNSELING_SUBMISSION_DISABLED: 설문 접수 수집이 비활성화되어 있습니다.'
            };
        }
        return { enabled: true };
    }

    /**
     * Helper to encrypt a synthetic payload and store it as a pending envelope.
     */
    seedSubmission({
        payload,
        publicKeyPem,
        keyVersion = 'test_key_v1',
        schemaVersion = 'v1.0',
        algorithm = 'AES-256-GCM+RSA-OAEP-SHA256',
        submissionId = null,
        format = 'trackA'
    }) {
        if (this.isProduction || process.env.SURVEY_TRACK_A_MODE === 'production') {
            throw new Error('Synthetic fixture generation is strictly forbidden in production mode.');
        }
        const subId = submissionId || payload.submissionId || crypto.randomUUID();
        payload.submissionId = subId;

        // 1. Generate random 256-bit AES DEK and 12-byte IV
        const dek = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);

        // 2. Encrypt payload with AES-256-GCM
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
        const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
        const ciphertextBuf = Buffer.concat([cipher.update(payloadBuf), cipher.final()]);
        const tagBuf = cipher.getAuthTag();

        // 3. Wrap DEK with RSA-OAEP-256 using Track B Public Key
        const wrappedKeyBuf = crypto.publicEncrypt(
            {
                key: publicKeyPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            dek
        );

        let envelope;
        if (format === 'trackA') {
            // Track A canonical format: wrappedKey + combined ciphertext/16-byte tag
            const combinedCipherBuf = Buffer.concat([ciphertextBuf, tagBuf]);
            envelope = {
                submissionId: subId,
                schemaVersion,
                keyVersion,
                algorithm,
                wrappedKey: wrappedKeyBuf.toString('base64'),
                iv: iv.toString('base64'),
                ciphertext: combinedCipherBuf.toString('base64'),
                receivedAt: new Date().toISOString()
            };
        } else {
            // Legacy separate tag format
            envelope = {
                submissionId: subId,
                schemaVersion: '1.0.0',
                keyVersion,
                algorithm: 'RSA-OAEP-256+AES-256-GCM',
                encryptedKey: wrappedKeyBuf.toString('base64'),
                iv: iv.toString('base64'),
                tag: tagBuf.toString('base64'),
                ciphertext: ciphertextBuf.toString('base64'),
                receivedAt: new Date().toISOString()
            };
        }

        this.submissions.set(subId, {
            envelope,
            state: 'PENDING',
            status: 'PENDING',
            lease: null,
            workerId: null,
            ackAt: null,
            deletedAt: null
        });

        return envelope;
    }

    /**
     * Seeds the 5 canonical synthetic test submissions for development and UI testing:
     * 1. sub-demo-001 (PHQ-9 Depression)
     * 2. sub-demo-002 (GAD-7 Anxiety)
     * 3. sub-demo-003 (BEPSI-K Stress)
     * 4. sub-demo-004 (Contact-Only, sensitive info consent false)
     * 5. sub-demo-005 (SBQ-R Suicide risk, quarantined by policy gate)
     */
    seedDefaultSyntheticSubmissions(publicKeyPem) {
        const nowIso = new Date().toISOString();

        // 1. PHQ-9
        this.seedSubmission({
            submissionId: 'sub-demo-001',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-001',
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                campaignCode: 'DEMO-2026-1',
                contactOnly: false,
                submittedAt: nowIso,
                contact: {
                    clientName: '홍길동',
                    phone: '010-1234-5678',
                    gender: '남성',
                    birthDate: '1990-05-15',
                    region: '부발읍',
                    counselingRequestText: '최근 3개월간 수면장애와 무기력감이 심해져 일상생활에 지장이 있습니다. 전문가 상담을 희망합니다.'
                },
                assessment: {
                    totalScore: 14,
                    severity: '중간 정도의 우울',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미나 즐거움 저하', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 2, questionLabel: '우울감이나 슬픔', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 3, questionLabel: '수면 문제', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 4, questionLabel: '피로감이나 에너지 부족', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 5, questionLabel: '식욕 변화', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 6, questionLabel: '자책감 또는 실패감', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '집중 곤란', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 8, questionLabel: '초조함 또는 둔화', score: 1, answerLabel: '며칠 동안' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses', 'campaignCode']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 2. GAD-7
        this.seedSubmission({
            submissionId: 'sub-demo-002',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-002',
                schemaVersion: 'v1.0',
                assessmentId: 'gad-7',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
                contact: {
                    clientName: '김영희',
                    phone: '010-9876-5432',
                    gender: '여성',
                    birthDate: '1997-11-20',
                    region: '창전동',
                    counselingRequestText: '직장 내 대인관계와 업무 스트레스로 인해 가슴 답답함과 과도한 걱정이 지속됩니다.'
                },
                assessment: {
                    totalScore: 11,
                    severity: '중간 정도의 불안',
                    responses: [
                        { questionNumber: 1, questionLabel: '불안, 초조하거나 긴장됨', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 2, questionLabel: '걱정을 멈추거나 조절할 수 없음', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 3, questionLabel: '여러 가지 문제에 대해 너무 많이 걱정함', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 4, questionLabel: '안절부절못함', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 5, questionLabel: '쉽게 피곤해지거나 짜증남', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 6, questionLabel: '쉽게 성을 내거나 신경질적이 됨', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '끔찍한 일이 생길 것 같아 두려움', score: 1, answerLabel: '며칠 동안' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 3. BEPSI-K
        this.seedSubmission({
            submissionId: 'sub-demo-003',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-003',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 5).toISOString(),
                contact: {
                    clientName: '박민수',
                    phone: '010-3344-5566',
                    gender: '남성',
                    birthDate: '1981-08-12',
                    region: '증포동',
                    counselingRequestText: '가족 부양과 경제적 부담으로 극심한 스트레스를 겪고 있으며 신체적 피로가 누적되었습니다.'
                },
                assessment: {
                    totalScore: 14,
                    meanScore: 2.80,
                    severity: '고스트레스군',
                    scaleScores: { rawScore: 14, meanScore: 2.80, policyVersion: 'v1.0' },
                    responses: [
                        { questionNumber: 1, questionLabel: '기능이나 능력에 대한 요구 부담', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 2, questionLabel: '자신의 뜻대로 되지 않음', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 3, questionLabel: '마음의 평정 유지 곤란', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 4, questionLabel: '자신감 상실', score: 2, answerLabel: '가끔 느낌' },
                        { questionNumber: 5, questionLabel: '일상적 삶의 의미 상실', score: 3, answerLabel: '자주 느낌' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'meanScore', 'severity', 'scaleScores', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 4. Contact-Only
        this.seedSubmission({
            submissionId: 'sub-demo-004',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-004',
                schemaVersion: 'v1.0',
                assessmentId: 'contact-only',
                assessmentVersion: '1.0.0',
                contactOnly: true,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
                contact: {
                    clientName: '이정은',
                    phone: '010-7788-9900',
                    gender: '여성',
                    birthDate: '1974-03-25',
                    region: '장호원읍',
                    counselingRequestText: '온라인 검사는 부담스러워 기본 정보만 남깁니다. 센터 방문 상담 절차에 대해 안내 전화 부탁드립니다.'
                },
                assessment: {},
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: false,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 5. SBQ-R
        this.seedSubmission({
            submissionId: 'sub-demo-005',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-005',
                schemaVersion: 'v1.0',
                assessmentId: 'sbq-r',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
                contact: {
                    clientName: '강위기',
                    phone: '010-5566-7788',
                    gender: '남성',
                    birthDate: '1993-12-05',
                    region: '신둔면',
                    counselingRequestText: '위기 상황 관련 도움 요청'
                },
                assessment: {
                    totalScore: 12,
                    severity: '고위험군'
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 6. ISI-K (수면 척도)
        this.seedSubmission({
            submissionId: 'sub-demo-006',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-006',
                schemaVersion: 'v1.0',
                assessmentId: 'isi-k',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 6).toISOString(),
                contact: {
                    clientName: '최수면',
                    phone: '010-4455-6677',
                    gender: '여성',
                    birthDate: '1988-02-14',
                    region: '백사면',
                    counselingRequestText: '밤에 잠들기 어렵고 자주 깨어 낮 동안 피로가 극심합니다.'
                },
                assessment: {
                    totalScore: 16,
                    severity: '중등도 불면',
                    responses: [
                        { questionNumber: 1, questionLabel: '잠들기 어려움', score: 3, answerLabel: '심함' },
                        { questionNumber: 2, questionLabel: '잠을 유지하기 어려움', score: 3, answerLabel: '심함' },
                        { questionNumber: 3, questionLabel: '너무 일찍 깸', score: 2, answerLabel: '보통' },
                        { questionNumber: 4, questionLabel: '수면 양상에 대한 만족도', score: 3, answerLabel: '매우 불만족' },
                        { questionNumber: 5, questionLabel: '일상생활 방해 정도', score: 3, answerLabel: '심함' },
                        { questionNumber: 6, questionLabel: '타인이 느끼는 문제 정도', score: 1, answerLabel: '약간' },
                        { questionNumber: 7, questionLabel: '수면 문제에 대한 걱정/고통', score: 1, answerLabel: '약간' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 7. PHQ-9 긴급/우선 검토 건 (Severe Depression)
        this.seedSubmission({
            submissionId: 'sub-demo-007',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-007',
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 1).toISOString(),
                contact: {
                    clientName: '정우선',
                    phone: '010-8899-0011',
                    gender: '남성',
                    birthDate: '1985-09-30',
                    region: '호법면',
                    counselingRequestText: '최근 번아웃과 심각한 우울 증세로 인해 출근이 어려운 상태입니다. 빠른 초기면접 희망합니다.'
                },
                assessment: {
                    totalScore: 21,
                    severity: '심한 우울 (우선검토 권장)',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미나 즐거움 저하', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 2, questionLabel: '우울감이나 슬픔', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 3, questionLabel: '수면 문제', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 4, questionLabel: '피로감이나 에너지 부족', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 5, questionLabel: '식욕 저하 또는 과식', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 6, questionLabel: '자책감 또는 실패감', score: 3, answerLabel: '거의 매일' },
                        { questionNumber: 7, questionLabel: '집중 곤란', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 8, questionLabel: '초조함 또는 둔화', score: 2, answerLabel: '자주 있음' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 8. 오늘 신규 접수 건 (10분 전 접수)
        this.seedSubmission({
            submissionId: 'sub-demo-008',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-008',
                schemaVersion: 'v1.0',
                assessmentId: 'gad-7',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 600 * 1000).toISOString(),
                contact: {
                    clientName: '오신규',
                    phone: '010-1122-3344',
                    gender: '여성',
                    birthDate: '2001-04-18',
                    region: '안흥동',
                    counselingRequestText: '취업 준비 중 불안감이 심해 신청합니다.'
                },
                assessment: {
                    totalScore: 7,
                    severity: '경미한 불안',
                    responses: [
                        { questionNumber: 1, questionLabel: '불안, 초조하거나 긴장됨', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 2, questionLabel: '걱정을 멈출 수 없음', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 3, questionLabel: '과도한 걱정', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 4, questionLabel: '안절부절못함', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 5, questionLabel: '쉽게 피곤/짜증', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 6, questionLabel: '신경질적', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '두려움', score: 0, answerLabel: '전혀 없음' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 9. BEPSI-K 정상 스트레스군 (점수 1.4점)
        this.seedSubmission({
            submissionId: 'sub-demo-009',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-009',
                schemaVersion: 'v1.0',
                assessmentId: 'bepsi-k',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 18).toISOString(),
                contact: {
                    clientName: '조정상',
                    phone: '010-6677-8899',
                    gender: '남성',
                    birthDate: '1979-10-10',
                    region: '마장면',
                    counselingRequestText: '예방 차원에서 정신건강 상태를 점검하고자 합니다.'
                },
                assessment: {
                    totalScore: 7,
                    meanScore: 1.40,
                    severity: '저스트레스군',
                    scaleScores: { rawScore: 7, meanScore: 1.40, policyVersion: 'v1.0' },
                    responses: [
                        { questionNumber: 1, questionLabel: '요구 부담', score: 2, answerLabel: '가끔' },
                        { questionNumber: 2, questionLabel: '뜻대로 안 됨', score: 1, answerLabel: '거의 없음' },
                        { questionNumber: 3, questionLabel: '마음 평정', score: 2, answerLabel: '가끔' },
                        { questionNumber: 4, questionLabel: '자신감 상실', score: 1, answerLabel: '거의 없음' },
                        { questionNumber: 5, questionLabel: '삶의 의미', score: 1, answerLabel: '거의 없음' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'meanScore', 'severity', 'scaleScores', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });

        // 10. 일반 상담 신청 (미배정 접수대기)
        this.seedSubmission({
            submissionId: 'sub-demo-010',
            publicKeyPem,
            payload: {
                submissionId: 'sub-demo-010',
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: new Date(Date.now() - 3600 * 1000 * 3).toISOString(),
                contact: {
                    clientName: '한미배',
                    phone: '010-9900-1122',
                    gender: '여성',
                    birthDate: '1995-07-22',
                    region: '중리동',
                    counselingRequestText: '최근 대인관계 단절과 무력감으로 심리 상담을 원합니다.'
                },
                assessment: {
                    totalScore: 9,
                    severity: '경도 우울',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미 저하', score: 1, answerLabel: '며칠' },
                        { questionNumber: 2, questionLabel: '우울감', score: 2, answerLabel: '자주' },
                        { questionNumber: 3, questionLabel: '수면 문제', score: 2, answerLabel: '자주' },
                        { questionNumber: 4, questionLabel: '피로감', score: 2, answerLabel: '자주' },
                        { questionNumber: 5, questionLabel: '식욕 변화', score: 1, answerLabel: '며칠' },
                        { questionNumber: 6, questionLabel: '자책감', score: 1, answerLabel: '며칠' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });
    }

    /**
     * Dedicated staging end-to-end synthetic submission seeder.
     * Complies strictly with synthetic data specifications:
     * - Name: SYNTHETIC 테스트사용자
     * - Phone: 010-0000-0000
     * - Memo: STAGING E2E TEST DATA
     */
    seedStagingSyntheticTestSubmission(publicKeyPem, options = {}) {
        if (this.isProduction || process.env.SURVEY_TRACK_A_MODE === 'production') {
            throw new Error('Synthetic fixture generation is strictly forbidden in production mode.');
        }

        const submissionId = options.submissionId || 'sub-staging-e2e-001';
        const nowIso = new Date().toISOString();
        const memo = options.memo || options.counselingRequestText || 'STAGING E2E TEST DATA';
        const isFiveScales = options.fiveScales || memo === 'LOCAL E2E TEST DATA' || options.assessmentId === 'bepsi-k';

        if (isFiveScales) {
            const scaleScores = {
                'phq-9': {
                    assessmentId: 'phq-9',
                    assessmentVersion: '1.0.0',
                    totalScore: 12,
                    severity: '중등도 우울',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미나 즐거움 저하', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 2, questionLabel: '기분 저하, 우울감', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 3, questionLabel: '잠들기 어렵거나 수면 과다', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 4, questionLabel: '피로감이나 기력 저하', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 5, questionLabel: '식욕 저하 또는 과식', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 6, questionLabel: '자책감 또는 죄책감', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '집중하기 어려움', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 8, questionLabel: '행동이 느려지거나 안절부절못함', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 9, questionLabel: '차라리 죽는 게 낫겠다는 생각', score: 0, answerLabel: '전혀 없음' }
                    ]
                },
                'gad-7': {
                    assessmentId: 'gad-7',
                    assessmentVersion: '1.0.0',
                    totalScore: 8,
                    severity: '경미한 불안',
                    responses: [
                        { questionNumber: 1, questionLabel: '불안, 긴장됨', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 2, questionLabel: '걱정 조절 곤란', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 3, questionLabel: '과도한 걱정', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 4, questionLabel: '안절부절못함', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 5, questionLabel: '쉽게 피로/짜증', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 6, questionLabel: '신경질적이 됨', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '두려움 느낌', score: 1, answerLabel: '며칠 동안' }
                    ]
                },
                'isi-k': {
                    assessmentId: 'isi-k',
                    assessmentVersion: '1.0.0',
                    totalScore: 10,
                    severity: '경미한 불면',
                    responses: [
                        { questionNumber: 1, questionLabel: '입면 곤란', score: 2, answerLabel: '약간' },
                        { questionNumber: 2, questionLabel: '수면 유지 곤란', score: 2, answerLabel: '약간' },
                        { questionNumber: 3, questionLabel: '조기 각성', score: 1, answerLabel: '약간' },
                        { questionNumber: 4, questionLabel: '수면 양상 불만족', score: 2, answerLabel: '약간' },
                        { questionNumber: 5, questionLabel: '낮 활동 방해', score: 1, answerLabel: '약간' },
                        { questionNumber: 6, questionLabel: '타인 인지 문제', score: 1, answerLabel: '약간' },
                        { questionNumber: 7, questionLabel: '수면 고통', score: 1, answerLabel: '약간' }
                    ]
                },
                'bepsi-k': {
                    assessmentId: 'bepsi-k',
                    assessmentVersion: '1.0.0',
                    questionSetVersion: '1.0.0',
                    scoringPolicyId: 'BEPSI_K_REVISED_QUARTILE_1_6_2_2',
                    responseSum: 14,
                    meanScore: 2.80,
                    totalScore: 14,
                    resultCode: 'HIGH',
                    resultLabel: '고스트레스군',
                    responses: [
                        { questionNumber: 1, questionLabel: '기능이나 능력에 대한 요구 부담', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 2, questionLabel: '자신의 뜻대로 되지 않음', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 3, questionLabel: '마음의 평정 유지 곤란', score: 3, answerLabel: '자주 느낌' },
                        { questionNumber: 4, questionLabel: '자신감 상실', score: 2, answerLabel: '가끔 느낌' },
                        { questionNumber: 5, questionLabel: '일상적 삶의 의미 상실', score: 3, answerLabel: '자주 느낌' }
                    ]
                },
                'sbq-r': {
                    assessmentId: 'sbq-r',
                    assessmentVersion: '1.0.0',
                    scoringPolicyId: 'SBQR_GENERAL_POPULATION_CUTOFF_7',
                    totalScore: 7,
                    resultCode: 'ADDITIONAL_REVIEW_RECOMMENDED',
                    resultLabel: '추가 확인 권장',
                    responses: [
                        { questionNumber: 1, optionId: 'q1_opt2', score: 2, answerLabel: '생각해 본 적 있음' },
                        { questionNumber: 2, optionId: 'q2_opt2', score: 2, answerLabel: '과거 1회' },
                        { questionNumber: 3, optionId: 'q3_opt2', score: 2, answerLabel: '과거 1회 말함' },
                        { questionNumber: 4, optionId: 'q4_opt2', score: 1, answerLabel: '가능성 낮음' }
                    ]
                }
            };

            return this.seedSubmission({
                submissionId,
                publicKeyPem,
                payload: {
                    submissionId,
                    schemaVersion: 'v1.0',
                    assessmentId: 'bepsi-k',
                    assessmentVersion: '1.0.0',
                    questionSetVersion: '1.0.0',
                    scoringPolicyId: 'BEPSI_K_REVISED_QUARTILE_1_6_2_2',
                    contactOnly: false,
                    submittedAt: nowIso,
                    contact: {
                        clientName: 'SYNTHETIC 테스트사용자',
                        phone: '010-0000-0000',
                        gender: '기타',
                        birthDate: '1990-01-01',
                        region: '중리동',
                        counselingRequestText: memo
                    },
                    assessment: {
                        totalScore: 14,
                        responseSum: 14,
                        meanScore: 2.80,
                        resultCode: 'HIGH',
                        resultLabel: '고스트레스군',
                        scoringPolicyId: 'BEPSI_K_REVISED_QUARTILE_1_6_2_2',
                        responses: [
                            { questionNumber: 1, questionLabel: '기능이나 능력에 대한 요구 부담', score: 3, answerLabel: '자주 느낌' },
                            { questionNumber: 2, questionLabel: '자신의 뜻대로 되지 않음', score: 3, answerLabel: '자주 느낌' },
                            { questionNumber: 3, questionLabel: '마음의 평정 유지 곤란', score: 3, answerLabel: '자주 느낌' },
                            { questionNumber: 4, questionLabel: '자신감 상실', score: 2, answerLabel: '가끔 느낌' },
                            { questionNumber: 5, questionLabel: '일상적 삶의 의미 상실', score: 3, answerLabel: '자주 느낌' }
                        ],
                        scaleScores
                    },
                    consentEvidence: {
                        consentVersion: '2026.1',
                        personalInfoConsent: true,
                        sensitiveInfoConsent: true,
                        consentedAt: nowIso,
                        transmittedFieldSet: [
                            'clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText',
                            'responses', 'totalScore', 'responseSum', 'meanScore', 'resultCode', 'resultLabel',
                            'scoringPolicyId', 'scaleScores'
                        ]
                    },
                    retention: { policy: 'standard_counseling_1yr' }
                }
            });
        }

        return this.seedSubmission({
            submissionId,
            publicKeyPem,
            payload: {
                submissionId,
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                contactOnly: false,
                submittedAt: nowIso,
                contact: {
                    clientName: 'SYNTHETIC 테스트사용자',
                    phone: '010-0000-0000',
                    gender: '기타',
                    birthDate: '1990-01-01',
                    region: '중리동',
                    counselingRequestText: memo
                },
                assessment: {
                    totalScore: 12,
                    severity: '중등도 우울',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미나 즐거움 저하', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 2, questionLabel: '기분 저하, 우울감', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 3, questionLabel: '잠들기 어렵거나 수면 과다', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 4, questionLabel: '피로감이나 기력 저하', score: 2, answerLabel: '자주 있음' },
                        { questionNumber: 5, questionLabel: '식욕 저하 또는 과식', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 6, questionLabel: '자책감 또는 죄책감', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 7, questionLabel: '집중하기 어려움', score: 1, answerLabel: '며칠 동안' },
                        { questionNumber: 8, questionLabel: '행동이 느려지거나 안절부절못함', score: 1, answerLabel: '며칠 동안' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });
    }

    /**
     * Canonical lease pending endpoint:
     * GET /api/v1/internal/submissions/pending?limit=<1-100>&leaseSeconds=<seconds>
     */
    async leasePendingSubmissions({ limit = 20, leaseSeconds = 300 } = {}) {
        return this.fetchPending({ limit, leaseSeconds });
    }

    async fetchPending({ limit = 20, leaseSeconds = 300 } = {}) {
        if (!this.networkAvailable) {
            throw new Error('Network connection to Track A external service failed');
        }

        const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
        const boundedLease = Math.max(30, Math.min(3600, Number(leaseSeconds) || 300));
        const now = Date.now();
        const pending = [];

        for (const [id, item] of this.submissions.entries()) {
            if (item.state === 'DELETED') continue;

            const isUnleased = item.state === 'PENDING';
            const isExpiredLease = item.state === 'LEASED' && item.lease && new Date(item.lease.leaseUntil).getTime() <= now;
            const isRetryableFailed = item.state === 'FAILED_RETRYABLE';

            if (isUnleased || isExpiredLease || isRetryableFailed) {
                const leaseId = `lease_${crypto.randomUUID()}`;
                const leasedAt = new Date(now).toISOString();
                const leaseUntil = new Date(now + boundedLease * 1000).toISOString();

                item.state = 'LEASED';
                item.status = 'LEASED';
                item.lease = { leaseId, leasedAt, leaseUntil };
                item.workerId = this.expectedWorkerId;

                const responseEnvelope = {
                    ...JSON.parse(JSON.stringify(item.envelope)),
                    state: 'LEASED',
                    lease: { ...item.lease }
                };
                pending.push(responseEnvelope);

                if (pending.length >= boundedLimit) break;
            }
        }

        return {
            success: true,
            count: pending.length,
            submissions: pending
        };
    }

    /**
     * Canonical ACK endpoint:
     * POST /api/v1/internal/submissions/:id/ack
     */
    async acknowledgeSubmission(submissionId, leaseOpts = {}) {
        return this.acknowledge(submissionId, leaseOpts);
    }

    async acknowledge(submissionId, leaseOpts = {}) {
        if (!this.networkAvailable) throw new Error('External API unavailable');
        if (this.failAckNext) {
            this.failAckNext = false;
            throw new Error('Simulated Track A ACK failure');
        }

        const item = this.submissions.get(submissionId);
        if (!item) {
            const err = new Error('Submission not found');
            err.code = 'SUBMISSION_NOT_FOUND';
            err.statusCode = 404;
            throw err;
        }

        if (item.state === 'QUARANTINED') {
            const err = new Error('Cannot acknowledge quarantined submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_ACK_QUARANTINED;
            err.statusCode = 409;
            throw err;
        }

        if (item.state !== 'LEASED') {
            const err = new Error('Cannot acknowledge unleased submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_ACK_UNLEASED;
            err.statusCode = 409;
            throw err;
        }

        // Canonical contract lease validation
        if (leaseOpts && typeof leaseOpts === 'object' && leaseOpts.leaseId !== undefined) {
            if (!leaseOpts.leaseId) {
                const err = new Error('Missing leaseId');
                err.code = TRACK_A_ERROR_CODES.MISSING_LEASE_ID;
                err.statusCode = 400;
                throw err;
            }
            if (item.lease?.leaseId !== leaseOpts.leaseId) {
                const err = new Error('Lease ID mismatch');
                err.code = TRACK_A_ERROR_CODES.LEASE_MISMATCH;
                err.statusCode = 409;
                throw err;
            }
            if (this.simulateLeaseExpired || (item.lease && new Date(item.lease.leaseUntil).getTime() <= Date.now())) {
                if (item.lease) item.lease.leaseUntil = new Date(Date.now() - 1000).toISOString();
                const err = new Error('Lease expired');
                err.code = TRACK_A_ERROR_CODES.LEASE_EXPIRED;
                err.statusCode = 409;
                throw err;
            }
            if (leaseOpts.workerId && item.workerId && item.workerId !== leaseOpts.workerId) {
                const err = new Error('Worker ID mismatch');
                err.code = TRACK_A_ERROR_CODES.WORKER_MISMATCH;
                err.statusCode = 409;
                throw err;
            }
        }

        item.state = 'IMPORTED';
        item.status = 'IMPORTED';
        item.ackAt = new Date().toISOString();
        return {
            success: true,
            submissionId,
            state: 'IMPORTED',
            requestId: leaseOpts?.requestId || null
        };
    }

    /**
     * Canonical failed endpoint:
     * POST /api/v1/internal/submissions/:id/failed
     */
    async reportSubmissionFailed(submissionId, failureOpts = {}) {
        return this.reportFailure(submissionId, failureOpts);
    }

    async reportFailure(submissionId, failureOpts = {}) {
        const item = this.submissions.get(submissionId);
        if (!item) {
            const err = new Error('Submission not found');
            err.code = 'SUBMISSION_NOT_FOUND';
            err.statusCode = 404;
            throw err;
        }

        if (item.state !== 'LEASED') {
            const err = new Error('Cannot fail unleased submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_FAIL_UNLEASED;
            err.statusCode = 409;
            throw err;
        }

        // Handle both simple errorCode string (legacy) and canonical failureOpts object
        let category = 'RETRYABLE';
        let reason = 'PROCESSING_ERROR';

        if (typeof failureOpts === 'string') {
            reason = failureOpts;
        } else if (failureOpts && typeof failureOpts === 'object') {
            category = failureOpts.category || 'RETRYABLE';
            reason = failureOpts.reason || 'PROCESSING_ERROR';

            if (failureOpts.leaseId && item.lease?.leaseId !== failureOpts.leaseId) {
                const err = new Error('Lease ID mismatch');
                err.code = TRACK_A_ERROR_CODES.LEASE_MISMATCH;
                err.statusCode = 409;
                throw err;
            }
            if (this.simulateLeaseExpired || (item.lease && new Date(item.lease.leaseUntil).getTime() <= Date.now())) {
                const err = new Error('Lease expired');
                err.code = TRACK_A_ERROR_CODES.LEASE_EXPIRED;
                err.statusCode = 409;
                throw err;
            }
        }

        item.state = category === 'QUARANTINED' ? 'QUARANTINED' : 'FAILED_RETRYABLE';
        item.status = item.state;
        item.lastErrorCode = reason;
        return { success: true, submissionId, state: item.state };
    }

    /**
     * Canonical delete endpoint:
     * POST /api/v1/internal/submissions/:id/delete
     */
    async deleteImportedSubmission(submissionId, deleteOpts = {}) {
        return this.deleteCiphertext(submissionId, deleteOpts);
    }

    async deleteCiphertext(submissionId, deleteOpts = {}) {
        if (!this.networkAvailable) throw new Error('External API unavailable');
        if (this.failDeleteNext) {
            this.failDeleteNext = false;
            throw new Error('Simulated Track A deletion failure');
        }

        const item = this.submissions.get(submissionId);
        if (!item) {
            const err = new Error('Submission not found');
            err.code = 'SUBMISSION_NOT_FOUND';
            err.statusCode = 404;
            throw err;
        }

        // Enforce state transition rules
        if (item.state === 'PENDING') {
            const err = new Error('Cannot delete pending submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_DELETE_PENDING;
            err.statusCode = 409;
            throw err;
        }
        if (item.state === 'LEASED') {
            const err = new Error('Cannot delete active leased submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_DELETE_ACTIVE_LEASED;
            err.statusCode = 409;
            throw err;
        }
        if (item.state === 'FAILED_RETRYABLE') {
            const err = new Error('Cannot delete failed retryable submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_DELETE_FAILED_RETRYABLE;
            err.statusCode = 409;
            throw err;
        }
        if (item.state === 'QUARANTINED') {
            const err = new Error('Cannot delete quarantined submission');
            err.code = TRACK_A_ERROR_CODES.CANNOT_DELETE_QUARANTINED;
            err.statusCode = 409;
            throw err;
        }

        // Permitted only when state === 'IMPORTED' (or ACKNOWLEDGED)
        item.state = 'DELETED';
        item.status = 'DELETED';
        item.deletedAt = new Date().toISOString();
        if (item.envelope) {
            item.envelope.ciphertext = '[DELETED]';
            item.envelope.wrappedKey = '[DELETED]';
            if (item.envelope.encryptedKey) item.envelope.encryptedKey = '[DELETED]';
        }

        return {
            success: true,
            submissionId,
            state: 'DELETED',
            requestId: deleteOpts?.requestId || null
        };
    }

    /**
     * Get synthetic campaign seed fixture (DEMO-2026-1)
     */
    getDemoCampaignSeed() {
        return {
            code: 'DEMO-2026-1',
            companyName: '데모주식회사',
            purpose: '2026년 상반기 임직원 마음건강 검진',
            startsAt: '2026-01-01T00:00:00.000Z',
            endsAt: '2026-12-31T23:59:59.999Z',
            isActive: true,
            version: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
        };
    }

    /**
     * Seed a synthetic submission with a valid canonical format, but unregistered campaign code.
     */
    seedValidUnregisteredSubmission(publicKeyPem, options = {}) {
        const subId = options.submissionId || 'sub-demo-unreg-001';
        const nowIso = new Date().toISOString();
        return this.seedSubmission({
            submissionId: subId,
            publicKeyPem,
            payload: {
                submissionId: subId,
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                campaignCode: options.campaignCode || 'UNREG-2026-1',
                contactOnly: false,
                submittedAt: nowIso,
                contact: {
                    clientName: '미등록테스트',
                    phone: '010-9988-7766',
                    gender: '남성',
                    birthDate: '1992-04-10',
                    region: '이천시',
                    counselingRequestText: '미등록 캠페인 코드 접수 테스트'
                },
                assessment: {
                    totalScore: 8,
                    severity: '경도 우울',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미 저하', score: 1, answerLabel: '며칠' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses', 'campaignCode']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });
    }

    /**
     * Seed a synthetic submission with an invalid campaign code (e.g. invalid format or characters).
     */
    seedInvalidCampaignCodeSubmission(publicKeyPem, options = {}) {
        const subId = options.submissionId || 'sub-demo-invalid-code-001';
        const nowIso = new Date().toISOString();
        return this.seedSubmission({
            submissionId: subId,
            publicKeyPem,
            payload: {
                submissionId: subId,
                schemaVersion: 'v1.0',
                assessmentId: 'phq-9',
                assessmentVersion: '1.0.0',
                campaignCode: options.campaignCode || 'INVALID_CODE!@#',
                contactOnly: false,
                submittedAt: nowIso,
                contact: {
                    clientName: '무효코드테스트',
                    phone: '010-1122-3344',
                    gender: '여성',
                    birthDate: '1994-06-20',
                    region: '이천시',
                    counselingRequestText: '무효 캠페인 코드 접수 테스트'
                },
                assessment: {
                    totalScore: 6,
                    severity: '정상',
                    responses: [
                        { questionNumber: 1, questionLabel: '흥미 저하', score: 1, answerLabel: '며칠' }
                    ]
                },
                consentEvidence: {
                    consentVersion: '2026.1',
                    personalInfoConsent: true,
                    sensitiveInfoConsent: true,
                    consentedAt: nowIso,
                    transmittedFieldSet: ['clientName', 'phone', 'gender', 'birthDate', 'region', 'counselingRequestText', 'totalScore', 'severity', 'responses']
                },
                retention: { policy: 'standard_counseling_1yr' }
            }
        });
    }
}

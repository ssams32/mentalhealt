/**
 * scripts/verify-encryption-contract.mjs
 * Targeted verification suite for Track B encryption contract alignment:
 * 1. canonical algorithm 허용 (AES-GCM-256/RSA-OAEP-SHA256)
 * 2. 미승인 algorithm 거부
 * 3. v1-2026 키쌍 일치 (cryptographic challenge)
 * 4. 잘못된 개인키 거부
 * 5. authentication tag 변조 거부
 * 6. wrappedKey 변조 거부
 * 7. 비밀정보 로그 미출력
 */

import assert from 'assert';
import fs from 'fs';
import crypto from 'crypto';
import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SURVEY_ERROR_CODES
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

async function runTests() {
    console.log('\n============================================================');
    console.log('🧪 P0 ENCRYPTION CONTRACT VERIFICATION');
    console.log('============================================================\n');

    const privateKeyPath = process.env.SURVEY_PRIVATE_KEY_PATH || 'C:/Users/김준삼/secure-test-keys/survey_private_key.pem';
    const publicKeyPath = 'C:/Users/김준삼/secure-test-keys/survey_public_key.pem';

    const privPem = fs.readFileSync(privateKeyPath, 'utf8');
    const pubPem = fs.readFileSync(publicKeyPath, 'utf8');

    const keyProvider = new SurveyKeyProvider({ secretPath: privateKeyPath });
    const decryptionService = new SurveyDecryptionService({ keyProvider });

    // Helper: generate canonical Track A envelope
    function createCanonicalEnvelope(payload, {
        algorithm = 'AES-GCM-256/RSA-OAEP-SHA256',
        keyVersion = 'v1-2026',
        pubKey = pubPem,
        tamperTag = false,
        tamperWrappedKey = false
    } = {}) {
        const dek = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);

        const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
        const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
        const ciphertextBuf = Buffer.concat([cipher.update(payloadBuf), cipher.final()]);
        let tagBuf = cipher.getAuthTag();

        if (tamperTag) {
            tagBuf[0] ^= 0xff;
        }

        const combinedCipher = Buffer.concat([ciphertextBuf, tagBuf]);

        let wrappedKeyBuf = crypto.publicEncrypt({
            key: pubKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, dek);

        if (tamperWrappedKey) {
            wrappedKeyBuf[0] ^= 0xff;
        }

        return {
            submissionId: payload.submissionId || crypto.randomUUID(),
            schemaVersion: 'v1.0',
            keyVersion,
            algorithm,
            iv: iv.toString('base64'),
            wrappedKey: wrappedKeyBuf.toString('base64'),
            ciphertext: combinedCipher.toString('base64')
        };
    }

    const validPayload = {
        submissionId: 'test-contract-sub-001',
        schemaVersion: '1.0.0',
        assessmentId: 'phq-9',
        contactOnly: false,
        consentEvidence: {
            consentVersion: '2026.1',
            personalInfoConsent: true,
            sensitiveInfoConsent: true,
            consentedAt: new Date().toISOString(),
            transmittedFieldSet: ['clientName', 'phone', 'answers', 'totalScore']
        },
        contact: {
            clientName: '홍길동',
            phone: '010-1234-5678'
        },
        assessment: {
            answers: [1, 2, 1, 0, 0, 1, 2, 1, 0],
            totalScore: 8,
            severity: 'mild'
        }
    };

    // 1. canonical algorithm 허용
    it('1. canonical algorithm 허용: AES-GCM-256/RSA-OAEP-SHA256 is accepted and successfully decrypted', () => {
        const envelope = createCanonicalEnvelope(validPayload);
        const decrypted = decryptionService.decryptEnvelope(envelope);
        assert.strictEqual(decrypted.submissionId, validPayload.submissionId);
        assert.strictEqual(decrypted.contact.clientName, '홍길동');
        assert.strictEqual(decrypted.assessment.totalScore, 8);
    });

    // 2. 미승인 algorithm 거부
    it('2. 미승인 algorithm 거부: Unapproved algorithms are rejected with UNSUPPORTED_ALGORITHM', () => {
        const unapprovedAlgorithms = [
            'AES-CBC-256',
            'DES-EDE3-CBC',
            'AES-GCM-128/RSA-OAEP',
            'NONE',
            'CHACHA20-POLY1305'
        ];

        for (const badAlgo of unapprovedAlgorithms) {
            const badEnvelope = createCanonicalEnvelope(validPayload, { algorithm: badAlgo });
            assert.throws(() => {
                decryptionService.decryptEnvelope(badEnvelope);
            }, (err) => {
                assert.strictEqual(err.code, SURVEY_ERROR_CODES.UNSUPPORTED_ALGORITHM);
                return true;
            });
        }
    });

    // 3. v1-2026 키쌍 일치
    it('3. v1-2026 키쌍 일치: Public and private keys match via zero-leak challenge probe', () => {
        const probe = crypto.randomBytes(32);
        const encryptedProbe = crypto.publicEncrypt({
            key: pubPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, probe);

        const decryptedProbe = crypto.privateDecrypt({
            key: privPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, encryptedProbe);

        assert.strictEqual(probe.equals(decryptedProbe), true);
    });

    // 4. 잘못된 개인키 거부
    it('4. 잘못된 개인키 거부: Decrypting with wrong private key fails with CIPHERTEXT_AUTHENTICATION_FAILED', () => {
        const otherKeypair = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        const envelopeForOtherKey = createCanonicalEnvelope(validPayload, { pubKey: otherKeypair.publicKey });
        assert.throws(() => {
            decryptionService.decryptEnvelope(envelopeForOtherKey);
        }, (err) => {
            assert.strictEqual(err.code, SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED);
            return true;
        });
    });

    // 5. authentication tag 변조 거부
    it('5. authentication tag 변조 거부: Tampering with 16-byte GCM tag fails with CIPHERTEXT_AUTHENTICATION_FAILED', () => {
        const tamperedTagEnvelope = createCanonicalEnvelope(validPayload, { tamperTag: true });
        assert.throws(() => {
            decryptionService.decryptEnvelope(tamperedTagEnvelope);
        }, (err) => {
            assert.strictEqual(err.code, SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED);
            return true;
        });
    });

    // 6. wrappedKey 변조 거부
    it('6. wrappedKey 변조 거부: Tampering with wrappedKey fails with CIPHERTEXT_AUTHENTICATION_FAILED', () => {
        const tamperedKeyEnvelope = createCanonicalEnvelope(validPayload, { tamperWrappedKey: true });
        assert.throws(() => {
            decryptionService.decryptEnvelope(tamperedKeyEnvelope);
        }, (err) => {
            assert.strictEqual(err.code, SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED);
            return true;
        });
    });

    // 7. 비밀정보 로그 미출력
    it('7. 비밀정보 로그 미출력: Errors and exceptions never expose secret keys, wrappedKeys, or raw ciphertexts', () => {
        const badEnvelope = createCanonicalEnvelope(validPayload, { tamperTag: true });
        try {
            decryptionService.decryptEnvelope(badEnvelope);
            assert.fail('Should have thrown');
        } catch (err) {
            const str = String(err.message) + ' ' + String(err.stack);
            assert(!str.includes(privPem), 'Must not log private key');
            assert(!str.includes(badEnvelope.wrappedKey), 'Must not log wrappedKey');
            assert(!str.includes(badEnvelope.ciphertext), 'Must not log ciphertext');
        }
    });

    console.log(`\n============================================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`============================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

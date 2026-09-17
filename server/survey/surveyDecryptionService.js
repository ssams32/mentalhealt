/**
 * server/survey/surveyDecryptionService.js
 * Authenticated in-memory decryption service for encrypted submission envelopes.
 * Uses RSA-OAEP-256 for DEK unwrap and AES-256-GCM for payload decryption.
 */

import crypto from 'crypto';
import {
    SURVEY_ERROR_CODES,
    SUPPORTED_ENVELOPE_SCHEMA_VERSIONS,
    SUPPORTED_ALGORITHMS
} from './surveyConstants.js';
import { SurveyOperationError } from './surveyErrors.js';

export class SurveyDecryptionService {
    /**
     * @param {Object} options
     * @param {import('./surveyKeyProvider.js').SurveyKeyProvider} options.keyProvider
     */
    constructor(options = {}) {
        if (!options.keyProvider) {
            throw new Error('SurveyDecryptionService requires keyProvider dependency');
        }
        this.keyProvider = options.keyProvider;
    }

    /**
     * Validate envelope outer schema without sensitive data leakage.
     */
    validateEnvelope(envelope) {
        if (!envelope || typeof envelope !== 'object') {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_ENVELOPE_SCHEMA,
                'Malformed envelope: payload must be an object'
            );
        }

        // 1. Mandatory base envelope fields
        const requiredBaseFields = ['submissionId', 'schemaVersion', 'keyVersion', 'algorithm', 'iv', 'ciphertext'];
        for (const field of requiredBaseFields) {
            if (!envelope[field] || typeof envelope[field] !== 'string') {
                throw new SurveyOperationError(
                    SURVEY_ERROR_CODES.INVALID_ENVELOPE_SCHEMA,
                    `Missing or invalid required envelope field: ${field}`
                );
            }
        }

        // 2. Key field reconciliation: accept either 'wrappedKey' (Track A WebCrypto standard) or 'encryptedKey' (Track B)
        const keyField = envelope.wrappedKey || envelope.encryptedKey;
        if (!keyField || typeof keyField !== 'string') {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.INVALID_ENVELOPE_SCHEMA,
                'Missing wrappedKey or encryptedKey in envelope'
            );
        }

        // 3. Version and Algorithm conformance
        if (!SUPPORTED_ENVELOPE_SCHEMA_VERSIONS.includes(envelope.schemaVersion)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
                `Unsupported envelope schema version: ${envelope.schemaVersion}`
            );
        }

        if (!SUPPORTED_ALGORITHMS.includes(envelope.algorithm)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.UNSUPPORTED_ALGORITHM,
                `Unsupported envelope algorithm: ${envelope.algorithm}`
            );
        }
    }

    /**
     * Decrypt envelope ciphertext in-memory.
     * Throws SurveyOperationError on authentication failure or tampering.
     * 
     * @param {Object} envelope
     * @returns {Object} Decrypted payload object
     */
    decryptEnvelope(envelope) {
        this.validateEnvelope(envelope);

        const privateKeyPem = this.keyProvider.getPrivateKey(envelope.keyVersion);

        // 1. Unwrap AES Data Encryption Key (DEK) with RSA-OAEP-256
        // Reconcile: wrappedKey (Track A) or encryptedKey (Track B)
        const rawEncryptedKey = envelope.wrappedKey || envelope.encryptedKey;
        let dek;
        try {
            const encryptedKeyBuf = Buffer.from(rawEncryptedKey, 'base64');
            dek = crypto.privateDecrypt(
                {
                    key: privateKeyPem,
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256'
                },
                encryptedKeyBuf
            );
        } catch (err) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED,
                'Failed to unwrap DEK: private key mismatch or corrupted key envelope'
            );
        }

        if (dek.length !== 32) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED,
                'Invalid unwrapped DEK length: 256-bit key required'
            );
        }

        // 2. Extract IV, Ciphertext, and Auth Tag
        try {
            const ivBuf = Buffer.from(envelope.iv, 'base64');
            if (ivBuf.length !== 12) {
                throw new Error('IV must be 12 bytes for GCM');
            }

            let ciphertextBuf;
            let tagBuf;

            // Reconcile Tag:
            // Case A: Separate tag (Track B original schema)
            if (envelope.tag && typeof envelope.tag === 'string') {
                tagBuf = Buffer.from(envelope.tag, 'base64');
                ciphertextBuf = Buffer.from(envelope.ciphertext, 'base64');
            } else {
                // Case B: Combined tag at the end of ciphertext (Track A WebCrypto subtle.encrypt standard output)
                const fullCipherBuf = Buffer.from(envelope.ciphertext, 'base64');
                if (fullCipherBuf.length < 16) {
                    throw new Error('Ciphertext length too short for AES-GCM tag');
                }
                ciphertextBuf = fullCipherBuf.subarray(0, fullCipherBuf.length - 16);
                tagBuf = fullCipherBuf.subarray(fullCipherBuf.length - 16);
            }

            if (tagBuf.length !== 16) {
                throw new Error('Auth tag must be 16 bytes for GCM');
            }

            const decipher = crypto.createDecipheriv('aes-256-gcm', dek, ivBuf);
            decipher.setAuthTag(tagBuf);

            // Bind optional AAD if present in envelope
            if (envelope.aad) {
                decipher.setAAD(Buffer.from(envelope.aad, 'utf8'));
            }

            const decryptedBuf = Buffer.concat([
                decipher.update(ciphertextBuf),
                decipher.final()
            ]);

            const decryptedJson = decryptedBuf.toString('utf8');
            const payload = JSON.parse(decryptedJson);

            return payload;
        } catch (err) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.CIPHERTEXT_AUTHENTICATION_FAILED,
                'Ciphertext authentication failed: data tampered, invalid IV, or invalid auth tag'
            );
        }
    }
}


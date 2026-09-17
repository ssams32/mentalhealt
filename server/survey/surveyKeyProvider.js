/**
 * server/survey/surveyKeyProvider.js
 * Backend-only RSA Private Key Provider with strict secret protection.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SURVEY_ERROR_CODES, SUPPORTED_KEY_VERSIONS } from './surveyConstants.js';
import { SurveyOperationError } from './surveyErrors.js';

export class SurveyKeyProvider {
    constructor(options = {}) {
        this.secretPath = options.secretPath || process.env.SURVEY_PRIVATE_KEY_PATH || '/run/secrets/survey_private_key';
        this.mockKeys = options.mockKeys || new Map(); // keyVersion -> { privateKey, publicKey }
    }

    /**
     * Validate key file accessibility and format at startup.
     * In staging/production, fails immediately if file is missing, not a file,
     * unreadable, or not valid PEM RSA private key.
     */
    validateKeyFilePermissions() {
        if (!this.secretPath) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PRIVATE_KEY_UNAVAILABLE,
                'SURVEY_PRIVATE_KEY_PATH is not configured'
            );
        }
        if (!fs.existsSync(this.secretPath)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PRIVATE_KEY_UNAVAILABLE,
                `Survey private key file not found: ${this.secretPath}`
            );
        }
        try {
            fs.accessSync(this.secretPath, fs.constants.R_OK);
            const stat = fs.statSync(this.secretPath);
            if (!stat.isFile()) {
                throw new Error(`Path is not a regular file: ${this.secretPath}`);
            }
            const content = fs.readFileSync(this.secretPath, 'utf8').trim();
            if (!content.includes('PRIVATE KEY')) {
                throw new Error('File does not contain valid PEM RSA private key header');
            }
            return true;
        } catch (err) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PRIVATE_KEY_UNAVAILABLE,
                `Survey private key file cannot be read or is invalid (${this.secretPath}): ${err.message}`
            );
        }
    }

    /**
     * Register an in-memory key pair for synthetic testing or staging.
     */
    registerSyntheticKey(keyVersion, privateKeyPem, publicKeyPem) {
        this.mockKeys.set(keyVersion, {
            privateKey: privateKeyPem,
            publicKey: publicKeyPem
        });
    }

    /**
     * Generate and register an ephemeral synthetic RSA-2048 keypair.
     */
    generateSyntheticTestKey(keyVersion = 'test_key_v1') {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        this.registerSyntheticKey(keyVersion, privateKey, publicKey);
        return { keyVersion, publicKey, privateKey };
    }

    /**
     * Retrieve the RSA private key for the given keyVersion.
     * Throws SurveyOperationError if key is missing or keyVersion unsupported.
     */
    getPrivateKey(keyVersion) {
        if (!keyVersion || !SUPPORTED_KEY_VERSIONS.includes(keyVersion)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.UNSUPPORTED_KEY_VERSION,
                `Unsupported or missing keyVersion: ${keyVersion}`
            );
        }

        // 1. Check in-memory synthetic key (used in tests / isolated dev)
        if (this.mockKeys.has(keyVersion)) {
            return this.mockKeys.get(keyVersion).privateKey;
        }

        // 2. Read from runtime secret file
        if (!fs.existsSync(this.secretPath)) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PRIVATE_KEY_UNAVAILABLE,
                'Survey private key secret file is not available on host runtime'
            );
        }

        try {
            const keyContent = fs.readFileSync(this.secretPath, 'utf8').trim();
            if (!keyContent.includes('PRIVATE KEY')) {
                throw new Error('Invalid PEM format');
            }
            return keyContent;
        } catch (err) {
            throw new SurveyOperationError(
                SURVEY_ERROR_CODES.PRIVATE_KEY_UNAVAILABLE,
                'Failed to load survey private key from secret path'
            );
        }
    }

    /**
     * Retrieve the corresponding public key if registered in mock/synthetic context.
     */
    getPublicKey(keyVersion) {
        if (this.mockKeys.has(keyVersion)) {
            return this.mockKeys.get(keyVersion).publicKey;
        }
        return null;
    }
}

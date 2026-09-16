/**
 * server/joycall-intake/joyCallIntakeCoordinator.js
 * Ingestion coordinator bridging completed NAS JoyCall files into Private Audio Storage.
 * Strictly enforces read-only source preservation and zero automatic AI/classification/linking.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JoyCallIntakeValidator } from './joyCallIntakeValidator.js';
import { JoyCallIntakeRepository } from './joyCallIntakeRepository.js';
import { JOYCALL_INTAKE_CHECK_CODES, JOYCALL_INTAKE_PROCESSING_STATUS } from './joyCallIntakeConstants.js';
import { JoyCallIntakeError, JOYCALL_INTAKE_ERROR_CODES } from './joyCallIntakeErrors.js';

export class JoyCallIntakeCoordinator {
    /**
     * @param {Object} options
     * @param {string} options.nasIncomingDir
     * @param {Object} [options.privateAudioStorage]
     * @param {JoyCallIntakeRepository} options.repository
     */
    constructor(options = {}) {
        this.nasIncomingDir = options.nasIncomingDir || null;
        this.privateAudioStorage = options.privateAudioStorage || null;
        this.repository = options.repository || null;
        this.validator = new JoyCallIntakeValidator(options);
    }

    /**
     * Non-destructively compute SHA-256 of file.
     */
    async _computeSha256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(err));
        });
    }

    /**
     * Ingest a specific file from NAS.
     * @param {string} filename - relative or base name within nasIncomingDir
     */
    async processFile(filename) {
        // 1. Filename validation (ignore .uploading, check extension)
        const nameValidation = this.validator.validateFilename(filename);
        if (!nameValidation.valid) {
            return {
                status: 'IGNORED',
                filename,
                code: nameValidation.code,
                reason: nameValidation.reason
            };
        }

        const sourcePath = path.isAbsolute(filename) ? filename : path.join(this.nasIncomingDir, filename);
        if (!fs.existsSync(sourcePath)) {
            throw new JoyCallIntakeError(
                JOYCALL_INTAKE_ERROR_CODES.FILE_NOT_FOUND,
                '수신 대상 파일을 찾을 수 없습니다.'
            );
        }

        // 2. Validate file (size, signature, format)
        const fileValidation = this.validator.validateFile(sourcePath);
        if (!fileValidation.valid) {
            return {
                status: 'REJECTED',
                filename: path.basename(sourcePath),
                code: fileValidation.code,
                reason: fileValidation.reason
            };
        }

        // 3. Compute SHA-256
        const sha256 = await this._computeSha256(sourcePath);

        // 4. Duplicate Check in Repository
        if (this.repository) {
            const existing = this.repository.findByContentHash(sha256);
            if (existing) {
                return {
                    status: 'DUPLICATE',
                    filename: path.basename(sourcePath),
                    code: JOYCALL_INTAKE_CHECK_CODES.DUPLICATE_HASH,
                    sha256,
                    existingCallId: existing.id
                };
            }
        }

        // 5. Copy to Private Audio Storage (source file is PRESERVED)
        let storageKey = null;
        if (this.privateAudioStorage) {
            const targetFilename = `joycall_${Date.now()}_${path.basename(sourcePath)}`;
            const storeRes = await this.privateAudioStorage.storeAudioFile(sourcePath, {
                targetFilename,
                sha256,
                mimeType: fileValidation.canonicalMime
            });
            storageKey = storeRes.storageKey;
        } else {
            // Standalone synthetic fallback: storage key simulated
            storageKey = `audio/synthetic/${sha256.substring(0, 16)}.wav`;
        }

        // 6. Create VoiceCall record in unclassified, unlinked, pending state
        let voiceCall = null;
        if (this.repository) {
            voiceCall = await this.repository.createIntakeCall({
                originalFileName: path.basename(sourcePath),
                contentHash: sha256,
                fileSize: fileValidation.size,
                mimeType: fileValidation.canonicalMime,
                storageKey
            });
        }

        return {
            status: 'ACCEPTED',
            code: JOYCALL_INTAKE_CHECK_CODES.INTAKE_SUCCESS,
            filename: path.basename(sourcePath),
            voiceCallId: voiceCall ? voiceCall.id : null,
            contentHash: sha256,
            fileSize: fileValidation.size,
            processingStatus: JOYCALL_INTAKE_PROCESSING_STATUS.PENDING,
            classificationStatus: voiceCall ? voiceCall.classificationStatus : 'pending'
        };
    }

    /**
     * Scan NAS incoming directory and process all available completed recordings.
     */
    async scanAndProcessAll() {
        if (!this.nasIncomingDir || !fs.existsSync(this.nasIncomingDir)) {
            return { processed: 0, results: [] };
        }

        const entries = fs.readdirSync(this.nasIncomingDir);
        const results = [];

        for (const entry of entries) {
            try {
                const res = await this.processFile(entry);
                results.push(res);
            } catch (err) {
                results.push({
                    status: 'ERROR',
                    filename: entry,
                    error: err.message
                });
            }
        }

        return {
            processed: entries.length,
            results
        };
    }
}

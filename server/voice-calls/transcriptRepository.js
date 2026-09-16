/**
 * server/voice-calls/transcriptRepository.js
 * Call-by-call Isolated Transcript Storage for Mind-ERP OS.
 * Stores transcripts as individual files under: DATA_DIR/transcripts/YYYY-MM/{callId}.json
 * Strictly enforces Path Traversal Defense, Atomic Temp-Write-Rename, VoiceCall Existence, and Overwrite Prohibitions.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DIARIZATION_MODE, ERROR_CODES } from './voiceCallConstants.js';
import { deepClone, isSafeStorageKey } from './voiceCallValidator.js';

const CALL_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const YEAR_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export class TranscriptRepository {
    /**
     * @param {string} dataDir - Absolute or relative path to DATA_DIR
     * @param {Object} [deps={}] - { voiceCallRepo }
     */
    constructor(dataDir, deps = {}) {
        if (!dataDir) throw new Error('dataDir is required for TranscriptRepository');
        this.dataDir = path.resolve(dataDir);
        this.transcriptsRoot = path.resolve(this.dataDir, 'transcripts');
        this.voiceCallRepo = deps.voiceCallRepo || null;

        if (!fs.existsSync(this.transcriptsRoot)) {
            fs.mkdirSync(this.transcriptsRoot, { recursive: true });
        }
    }

    /**
     * Set VoiceCallRepository dependency.
     */
    setVoiceCallRepository(repo) {
        this.voiceCallRepo = repo;
    }

    /**
     * Validate and resolve safe filepath inside transcriptsRoot.
     * Prevents any directory traversal attack (e.g. '../', '..\\').
     */
    _resolveSafePath(callId, yearMonth = null) {
        if (!callId || typeof callId !== 'string' || !CALL_ID_REGEX.test(callId)) {
            const err = new Error('유효하지 않은 통화 ID입니다.');
            err.code = ERROR_CODES.PATH_TRAVERSAL_DETECTED;
            err.status = 400;
            throw err;
        }

        const ym = yearMonth && YEAR_MONTH_REGEX.test(yearMonth)
            ? yearMonth
            : new Date().toISOString().slice(0, 7); // UTC 'YYYY-MM'

        const monthDir = path.resolve(this.transcriptsRoot, ym);
        const targetPath = path.resolve(monthDir, `${callId}.json`);

        // Strict containment check: resolved path must start with transcriptsRoot
        const relative = path.relative(this.transcriptsRoot, targetPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            const err = new Error('경로 조작 공격이 감지되었습니다.');
            err.code = ERROR_CODES.PATH_TRAVERSAL_DETECTED;
            err.status = 403;
            throw err;
        }

        return { monthDir, targetPath, yearMonth: ym };
    }

    /**
     * Search for a call's transcript across all yearMonth directories if yearMonth is not provided.
     */
    _findTranscriptPath(callId, yearMonth = null) {
        if (yearMonth) {
            const resolved = this._resolveSafePath(callId, yearMonth);
            if (fs.existsSync(resolved.targetPath)) return resolved;
            return null;
        }

        // Fast path: check current month first
        const currentYm = new Date().toISOString().slice(0, 7);
        const fastResolved = this._resolveSafePath(callId, currentYm);
        if (fs.existsSync(fastResolved.targetPath)) return fastResolved;

        // Search other YYYY-MM subdirectories
        if (!fs.existsSync(this.transcriptsRoot)) return null;
        const entries = fs.readdirSync(this.transcriptsRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && YEAR_MONTH_REGEX.test(entry.name) && entry.name !== currentYm) {
                const resolved = this._resolveSafePath(callId, entry.name);
                if (fs.existsSync(resolved.targetPath)) {
                    return resolved;
                }
            }
        }
        return null;
    }

    /**
     * Validate transcript payload.
     */
    validateTranscript(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('전사 데이터는 유효한 객체여야 합니다.');
        }
        if (!data.callId || typeof data.callId !== 'string') {
            throw new Error('callId가 누락되었습니다.');
        }
        if (typeof data.text !== 'string') {
            throw new Error('전사 본문(text)이 문자열이어야 합니다.');
        }
        if (!Array.isArray(data.segments)) {
            throw new Error('세그먼트(segments) 배열이 필요합니다.');
        }
        return true;
    }

    /**
     * Atomically save transcript to isolated month directory.
     * Enforces VoiceCall existence verification and prohibits destructive overwrite.
     */
    async saveTranscript(callId, transcriptData, options = {}) {
        this.validateTranscript(transcriptData);

        // Verify VoiceCall existence unconditionally when repository is configured
        const repo = options.voiceCallRepo || this.voiceCallRepo;
        if (repo) {
            const call = repo.findById(callId, { includeDeleted: true });
            if (!call) {
                const err = new Error(`존재하지 않는 통화 [${callId}]에 대한 전사를 저장할 수 없습니다.`);
                err.code = ERROR_CODES.NOT_FOUND;
                err.status = 404;
                throw err;
            }
        }

        const now = new Date();
        const yearMonth = options.yearMonth ||
            (transcriptData.createdAt ? transcriptData.createdAt.slice(0, 7) : now.toISOString().slice(0, 7));

        const { monthDir, targetPath } = this._resolveSafePath(callId, yearMonth);

        if (!fs.existsSync(monthDir)) {
            await fs.promises.mkdir(monthDir, { recursive: true });
        }

        // Destructive overwrite strictly prohibited (no bypass allowed on public API)
        if (fs.existsSync(targetPath)) {
            const err = new Error('기존 전사 파일이 이미 존재합니다. 전사 파일의 파괴적 덮어쓰기는 금지되어 있습니다.');
            err.code = ERROR_CODES.OVERWRITE_PROHIBITED;
            err.status = 409;
            throw err;
        }

        const nowIso = now.toISOString();
        const fullRecord = {
            id: transcriptData.id || crypto.randomUUID(),
            callId: String(callId),
            detectedLanguage: transcriptData.detectedLanguage || 'ko',
            languageConfidence: transcriptData.languageConfidence !== undefined ? Number(transcriptData.languageConfidence) : undefined,
            text: String(transcriptData.text),
            segments: (transcriptData.segments || []).map((s, idx) => ({
                id: s.id || `seg_${idx + 1}`,
                sequence: s.sequence !== undefined ? s.sequence : idx + 1,
                startSeconds: Number(s.startSeconds || 0),
                endSeconds: Number(s.endSeconds || 0),
                text: String(s.text || ''),
                speakerLabel: s.speakerLabel || undefined,
                confidence: s.confidence !== undefined ? Number(s.confidence) : undefined
            })),
            sttEngine: String(transcriptData.sttEngine || 'synthesized'),
            sttModel: String(transcriptData.sttModel || 'whisper-synth'),
            sttModelVersion: transcriptData.sttModelVersion || undefined,
            sttModelDigest: transcriptData.sttModelDigest || undefined,
            diarizationMode: transcriptData.diarizationMode || DIARIZATION_MODE.NONE,
            createdAt: transcriptData.createdAt || nowIso,
            updatedAt: nowIso,
            version: transcriptData.version || 1
        };

        const relativeStorageKey = `transcripts/${yearMonth}/${callId}.json`;
        const serialized = JSON.stringify(fullRecord, null, 2);
        const tempPath = `${targetPath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

        try {
            await fs.promises.writeFile(tempPath, serialized, 'utf8');

            // Verify written file is non-empty and valid JSON
            const verifyContent = await fs.promises.readFile(tempPath, 'utf8');
            if (!verifyContent || verifyContent.length === 0) {
                throw new Error('임시 파일 쓰기 실패: 비어있는 파일');
            }
            JSON.parse(verifyContent); // integrity verify

            await fs.promises.rename(tempPath, targetPath);

            return {
                ...deepClone(fullRecord),
                storageKey: relativeStorageKey
            };
        } catch (err) {
            if (fs.existsSync(tempPath)) {
                try { await fs.promises.unlink(tempPath); } catch (ignore) {}
            }
            const storageErr = new Error('전사 파일 저장 중 오류가 발생했습니다.');
            storageErr.code = ERROR_CODES.TRANSCRIPT_STORAGE_ERROR;
            storageErr.status = 500;
            throw storageErr;
        }
    }

    /**
     * Get transcript by callId with single-file corruption isolation.
     */
    async getTranscript(callId, yearMonth = null) {
        const found = this._findTranscriptPath(callId, yearMonth);
        if (!found) return null;

        try {
            const raw = await fs.promises.readFile(found.targetPath, 'utf8');
            if (raw.trim() === '') {
                throw new Error('Transcript file is empty');
            }
            const parsed = JSON.parse(raw);
            return deepClone(parsed);
        } catch (err) {
            console.error(`⚠️ [TRANSCRIPT_CORRUPTION] Single transcript [${callId}] corrupted, isolating file:`, err.message);
            const error = new Error('전사 파일이 손상되었습니다.');
            error.code = ERROR_CODES.TRANSCRIPT_STORAGE_ERROR;
            error.status = 500;
            error.isCorrupted = true;
            throw error;
        }
    }

    /**
     * Check if a transcript exists for a call.
     */
    transcriptExists(callId, yearMonth = null) {
        return this._findTranscriptPath(callId, yearMonth) !== null;
    }

    /**
     * Quarantine a corrupted transcript file without destroying it.
     */
    async quarantineCorruptedTranscript(callId, yearMonth = null) {
        const found = this._findTranscriptPath(callId, yearMonth);
        if (!found) return false;

        const quarantinedPath = `${found.targetPath}.quarantine_${Date.now()}`;
        try {
            await fs.promises.rename(found.targetPath, quarantinedPath);
            return true;
        } catch (e) {
            return false;
        }
    }
}

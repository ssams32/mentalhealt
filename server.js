/*
 * Copyright (c) 2026 이천시정신건강복지센터. All Rights Reserved.
 * 의뢰관리 전용 의뢰관리시스템 백엔드 서버
 */
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// --- Track A1 & A2: Authentication & Authorization Modules ---
import { SessionRepository } from './server/auth/sessionRepository.js';
import { AuthService } from './server/auth/authService.js';
import { createAuthMiddleware } from './server/auth/authMiddleware.js';
import { createAuthRouter } from './server/auth/authRouter.js';
import { createCorsOptions } from './server/config/corsPolicy.js';
import { getEffectiveVoiceCapabilities, hasOnlineSurveyAccess } from './server/permissions/voiceCapabilities.js';
import { createReferralMutationEngine, restoreCacheInPlace } from './server/referralMutationEngine.js';
import { requireVoiceCapability, requireRole } from './server/permissions/permissionMiddleware.js';

// --- Track A7 & Voice Management: Authenticated Audio Streaming & Call Management ---
import { VoiceCallRepository, createVoiceCallRouter } from './server/voice-calls/index.js';
import {
    PrivateAudioAccessService,
    AuditEventSink,
    createAudioStreamingRouter
} from './server/audio-streaming/index.js';

// --- Track A10.5: Restricted Voice Access Gate ---
import {
    parseVoiceAccessConfig,
    validateVoiceAccessConfig,
    VoiceAccessRepository,
    VoiceAccessAuthorizer
} from './server/voice-access/index.js';

// --- Track B: Internal Survey Administration & Import ---
import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyImportRepository,
    SurveyImportService,
    SurveyAssignmentRepository,
    SurveyExportService,
    SurveyReportGenerator,
    SurveyReferralService,
    TrackAClient,
    createSurveyImportRouter,
    MockTrackAApi,
    validateTrackABaseUrl,
    SurveyAutoImportScheduler
} from './server/survey/index.js';

// --- In-App Internal Notifications ---
import {
    InternalNotificationRepository,
    createNotificationRouter
} from './server/notifications/index.js';
import { getNextKstPurgeTime, canAccessReferralAttachment } from './server/survey/kstUtils.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-load .env if available in Node 20+
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(envPath);
    }
} catch (ignore) {}

const app = express();
// [포트 설정] 프론트엔드 8888, 백엔드 8889 체계 확정
const PORT = process.env.PORT || 8889;
const SERVER_VERSION = '3.1.2';
const START_TIME = new Date().toISOString();
const OPTIMIZATION_VERSION = 'v5.5.2-strict';
const ISP_POLICY_VERSION = 'isp-policy-v8-actual-intervention-total';
const ANALYSIS_CACHE_VERSION = 'v3.1.3';

// [Health Check] For Docker/NAS health checks
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'ok',
        service: 'icheon-center-backend',
        port: PORT,
        startedAt: START_TIME,
        optimizationVersion: OPTIMIZATION_VERSION,
        uptime: process.uptime(),
        version: SERVER_VERSION,
        timestamp: new Date().toISOString()
    });
});

// Middleware
// [성능 개선] Gzip/Deflate 네트워크 압축 (4MB JSON -> 300KB로 10배 이상 압축 전송)
// [무결성 하드닝] A7: Range 스트리밍 및 바이너리 오디오는 압축(Content-Encoding 변조) 제외
app.use(compression({
    filter: (req, res) => {
        if (req.path && req.path.includes('/audio')) {
            return false;
        }
        const cacheControl = res.getHeader('Cache-Control');
        if (typeof cacheControl === 'string' && /no-transform/i.test(cacheControl)) {
            return false;
        }
        return compression.filter(req, res);
    }
}));
// [보안 하드닝] Track A1: 명시적 Origin Allowlist 기반 CORS 정책 (임의 origin 반사 제거)
app.use(cors(createCorsOptions()));
// [개선] bodyParser deprecated -> express 내장 미들웨어 사용
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve built frontend (Priority: root dist > upload/imhc/dist)
const FRONTEND_DIST = process.env.FRONTEND_DIST ||
    (fs.existsSync(path.join(__dirname, 'dist')) ? path.join(__dirname, 'dist') : path.join(__dirname, 'upload', 'imhc', 'dist'));

app.use(express.static(FRONTEND_DIST, {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// Global Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

// Error handling middleware for catch-all
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('❌ [JSON PARSE ERROR]:', err.message);
        return res.status(400).json({
            error: {
                code: 'INVALID_JSON',
                message: '잘못된 JSON 형식입니다.'
            }
        });
    }
    console.error('❌ [SERVER ERROR]:', err.stack);
    res.status(500).json({ success: false, error: "Internal Server Error", message: err.message });
});

// ==========================================
// 1. Explicit Mode Resolution (Default: 'mock')
// ==========================================
const rawSurveyTrackAMode = (process.env.SURVEY_TRACK_A_MODE || 'mock').trim().toLowerCase();
const VALID_SURVEY_TRACK_A_MODES = ['mock', 'staging', 'production'];
if (!VALID_SURVEY_TRACK_A_MODES.includes(rawSurveyTrackAMode)) {
    console.error(`❌ [FATAL_CONFIG_ERROR] Invalid SURVEY_TRACK_A_MODE: "${process.env.SURVEY_TRACK_A_MODE}". Must be one of: 'mock', 'staging', 'production'.`);
    throw new Error(`[FATAL] Invalid SURVEY_TRACK_A_MODE: "${process.env.SURVEY_TRACK_A_MODE}". Must be 'mock', 'staging', or 'production'.`);
}
const surveyTrackAMode = rawSurveyTrackAMode;

// Physical separation of data directories by execution mode
const BASE_DATA_ROOT = path.join(__dirname, 'app', 'data');
const BASE_ATTACHMENTS_ROOT = path.resolve(__dirname, 'docker', 'Data', 'attachments');

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(BASE_DATA_ROOT, surveyTrackAMode);

const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR
    ? path.resolve(process.env.ATTACHMENTS_DIR)
    : path.join(BASE_ATTACHMENTS_ROOT, surveyTrackAMode);

// Isolation safety enforcement: Staging mode must NEVER open or point to production data/attachments!
if (surveyTrackAMode === 'staging') {
    const normDataDir = DATA_DIR.replace(/\\/g, '/').toLowerCase();
    const normAttDir = ATTACHMENTS_DIR.replace(/\\/g, '/').toLowerCase();
    if (normDataDir.includes('/production') || normAttDir.includes('/production')) {
        throw new Error('[FATAL_ISOLATION_ERROR] Staging mode must never open production JSON data files or attachment directories.');
    }
}

console.log('==========================================');
console.log('🚀 [SERVER STARTUP]');
console.log('🔒 SURVEY_TRACK_A_MODE:', surveyTrackAMode);
console.log('📂 DATA_DIR:', DATA_DIR);
console.log('📂 ATTACHMENTS_DIR:', ATTACHMENTS_DIR);
console.log('🔗 ABSOLUTE_PATH:', path.resolve(DATA_DIR));
console.log('==========================================');

if (!fs.existsSync(DATA_DIR)) {
    console.log('⚠️ [SYSTEM] DATA_DIR not found, creating:', DATA_DIR);
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

// Bootstrap initial users and data for mock mode if newly initialized
const usersJsonPath = path.join(DATA_DIR, 'Users.json');
const rootUsersJsonPath = path.join(BASE_DATA_ROOT, 'Users.json');
if (!fs.existsSync(usersJsonPath) && fs.existsSync(rootUsersJsonPath) && surveyTrackAMode === 'mock') {
    try {
        fs.copyFileSync(rootUsersJsonPath, usersJsonPath);
        console.log(`📋 [SYSTEM] Bootstrapped baseline Users.json for ${surveyTrackAMode} environment.`);
    } catch (ignore) {}
}

// ==========================================
// 💾 IN-MEMORY CACHE & ASYNC PERSISTENCE
// ==========================================

const memoryCache = {}; // In-memory single source of truth
const saveQueue = {}; // Queue for async file writes

// Helper: Get data synchronously from memory cache
const getData = (filename, defaultValue = []) => {
    if (memoryCache[filename]) {
        return memoryCache[filename];
    }

    const filePath = path.join(DATA_DIR, `${filename}.json`);
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.trim() === '') {
                 console.warn(`⚠️ [SERVER] ${filename}.json is empty on disk.`);
                 memoryCache[filename] = defaultValue;
                 return memoryCache[filename];
            }
            const data = JSON.parse(content);
            memoryCache[filename] = data;

            if (Array.isArray(data) && data.length > 0) {
                const lastItem = data[data.length - 1];
                const firstItem = data[0];
                console.log(`✅ [LOAD] ${filename}.json: ${data.length} items loaded.`);
                if (lastItem.requestDate && lastItem.requestDate.includes('2026-05')) {
                    console.log('✅ [CONFIRMED] Latest May data is present in the loaded file.');
                }
            }

            return memoryCache[filename];
        } catch (e) {
            console.error(`❌ [CRITICAL ERROR] Failed to parse ${filename}.json:`, e);
            throw new Error(`Data Corruption Detected in ${filename}.json. Manual intervention required.`);
        }
    }

    memoryCache[filename] = defaultValue;
    return memoryCache[filename];
};

// In-Memory Idempotency Store for mutations
const idempotencyStore = new Map();
const cleanIdempotencyStore = () => {
    if (idempotencyStore.size > 2000) {
        const keys = Array.from(idempotencyStore.keys()).slice(0, 500);
        keys.forEach(k => idempotencyStore.delete(k));
    }
};

const hashPayload = (obj) => {
    return crypto.createHash('sha256').update(JSON.stringify(obj || {})).digest('hex');
};

const TEAM_CODES = {
    '정신건강증진팀': 'HB',
    '예방관리팀': 'YP',
    '중독관리팀': 'JD',
    '지역복지팀': 'ET',
    '기획홍보팀': 'GH',
    '아동청소년팀': 'AD',
    '위기관리팀': 'WG',
    '남부분소': 'NB',
    '증진팀': 'JJ',
    '회복팀': 'HB',
    '자살예방센터': 'JY',
    '아동청소년': 'AC'
};

// Helper: Create a backup of a file before overwriting
const createBackup = async (filename) => {
    const backupDir = path.join(DATA_DIR, 'backups', new Date().toISOString().split('T')[0]);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const sourcePath = path.join(DATA_DIR, `${filename}.json`);
    const backupPath = path.join(backupDir, `${filename}_${Date.now()}.json.bak`);

    if (fs.existsSync(sourcePath)) {
        try {
            await fs.promises.copyFile(sourcePath, backupPath);
            const parentDir = path.join(DATA_DIR, 'backups');
            const folders = fs.readdirSync(parentDir).sort();
            if (folders.length > 7) {
                for (let i = 0; i < folders.length - 7; i++) {
                    const oldDir = path.join(parentDir, folders[i]);
                    fs.rmSync(oldDir, { recursive: true, force: true });
                }
            }
        } catch (e) {
            console.error(`Backup failed for ${filename}:`, e);
        }
    }
};

// Queue state for serializing file writes safely
const fileLocks = {};

// Helper: Persist data safely to disk (Atomic write: temp file -> JSON verify -> rename)
// Returns a Promise that resolves ONLY when data is successfully flushed to disk.
const persistData = async (filename, data) => {
    if (filename.startsWith('Budget') || filename === 'Referrals' || filename === 'SuicideAttempters' || filename === 'Users') {
        try {
            await createBackup(filename);
        } catch (e) {
            console.error(`Pre-save backup failed: ${e}`);
        }
    }

    if (!fileLocks[filename]) {
        fileLocks[filename] = Promise.resolve();
    }

    const currentLock = fileLocks[filename];
    const writeOperation = async () => {
        const filePath = path.join(DATA_DIR, `${filename}.json`);
        const dataToSave = JSON.stringify(data, null, 2);
        let retries = 3;
        let lastErr = null;

        for (let i = 0; i < retries; i++) {
            const tempPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            try {
                await fs.promises.writeFile(tempPath, dataToSave, 'utf8');
                // Verify temp file is not empty and valid JSON
                const written = await fs.promises.readFile(tempPath, 'utf8');
                if (!written || written.length === 0) throw new Error("Empty file write detected");
                JSON.parse(written); // verify JSON integrity
                await fs.promises.rename(tempPath, filePath);
                memoryCache[filename] = data;
                return true;
            } catch (e) {
                lastErr = e;
                console.error(`Attempt ${i + 1} failed saving to ${filePath}:`, e.message);
                if (fs.existsSync(tempPath)) {
                    try { await fs.promises.unlink(tempPath); } catch (ignore) { }
                }
                if (i < retries - 1) {
                    await new Promise(r => setTimeout(r, Math.pow(2, i) * 100));
                }
            }
        }
        throw lastErr || new Error(`Failed to persist ${filename} after ${retries} attempts`);
    };

    const nextLock = currentLock.then(writeOperation, writeOperation);
    fileLocks[filename] = nextLock;
    return nextLock;
};

// Legacy compatibility wrapper: triggers async save
const saveData = (filename, data) => {
    persistData(filename, data).catch(e => {
        console.error(`Async save failed for ${filename}:`, e);
    });
    return true;
};

// ==========================================
// 🛡️ REFERRALS INTEGRITY GUARD & CONCURRENCY CONTROL (F1, F5, F6)
// Scope: Strictly single Node.js process. Does not coordinate across multiple instances.
// ==========================================

const MAX_NOTE_CONTENT_LENGTH = 100000; // 100,000 characters
const MAX_NOTES_COUNT = 1000;           // 1,000 notes per record

const validateNotes = (notes) => {
    if (notes === undefined || notes === null) return { valid: true };
    if (!Array.isArray(notes)) {
        return { valid: false, error: 'notes는 배열이어야 합니다.' };
    }
    if (notes.length > MAX_NOTES_COUNT) {
        return { valid: false, error: `notes 개수가 최대 허용치(${MAX_NOTES_COUNT}개)를 초과했습니다.` };
    }
    for (let i = 0; i < notes.length; i++) {
        const item = notes[i];
        if (item && typeof item === 'object') {
            if (typeof item.content === 'string' && item.content.length > MAX_NOTE_CONTENT_LENGTH) {
                return { valid: false, error: `note 내용 길이가 최대 허용치(${MAX_NOTE_CONTENT_LENGTH}자)를 초과했습니다.` };
            }
        }
    }
    return { valid: true };
};

const referralAuditLogger = async (entry = {}) => {
    try {
        const auditEntry = {
            id: `audit_referral_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            category: 'referrals',
            actorType: 'user',
            actorUserId: String(entry.actorUserId || 'system'),
            targetId: String(entry.targetId || '-'), // Stable ID or count:N ONLY, Zero PII
            action: String(entry.action || 'REFERRAL_EVENT'),
            timestamp: new Date().toISOString(),
            result: entry.result || 'SUCCESS',
            reasonCode: entry.reasonCode || null
        };
        const currentLogs = getData('AuditEntries', []);
        currentLogs.push(auditEntry);
        if (currentLogs.length > 5000) currentLogs.shift();
        await persistData('AuditEntries', currentLogs);
    } catch (ignore) {}
};

// Allowlist for PUT /api/referrals (F3): Only approved mutable fields are merged
const REFERRAL_ALLOWLIST = new Set([
    // Demographics & Request details
    'name', 'phone', 'gender', 'age', 'birthDate', 'address', 'team', 'subTeam',
    'assignee', 'assignedStaffId', 'assignedUserId', 'requestDate', 'referralPath',
    'requestAgency', 'requestorName', 'requesterName', 'agency', 'agencyPhone',
    'requesterPhone', 'requesterFax', 'requesterEmail',
    // Clinical & Action Status
    'diagnosisProtectionRequest', 'writtenRequest', 'phoneRequest', 'diagnosisName',
    'interventionContent', 'actionResult', 'closureStatus', 'registrationStatus',
    'policeIntervention', 'criLevel', 'region', 'reply', 'replyStatus',
    'isUnregistered', 'isWebsiteReferral', 'referralStatus',
    // Guardian & Consent
    'medicalInsurance', 'disabilityStatus', 'guardianPresence', 'guardianName',
    'guardianRelation', 'guardianPhone', 'guardianNotes', 'consentToReferral',
    'consentNotes', 'problem', 'reason',
    // Attachments & Notes
    'attachments', 'officialDoc', 'notes', 'latestNote', 'latestNoteDate',
    // Website Integration Metadata
    'isSeen', 'websiteReferralSeenAt', 'externalReceivedAt',
    'firstScrapedAt', 'lastSyncedAt'
]);

// Immutable identifier contract for PUT /api/referrals/:id (MAJOR-3).
// These four identifiers can never be changed via PUT. Any payload value that is
// semantically different from the stored value is rejected with an explicit 400
// (uniform contract for all four). Same-value input is accepted as a no-op.
const IMMUTABLE_IDENTIFIERS = [
    { key: 'referralId', code: 'REFERRAL_ID_CHANGE_NOT_ALLOWED' },
    { key: 'refNo', code: 'REFNO_CHANGE_NOT_ALLOWED' },
    { key: 'sourceSubmissionId', code: 'SOURCE_SUBMISSION_ID_CHANGE_NOT_ALLOWED' },
    { key: 'externalReferralId', code: 'EXTERNAL_REFERRAL_ID_CHANGE_NOT_ALLOWED' }
];

// Semantic identifier equality: null/undefined/'' all mean "absent".
// Object/array payloads are never valid identifier values.
const isSameIdentifierValue = (incoming, current) => {
    if (incoming === current) return true;
    if ((incoming !== null && typeof incoming === 'object') ||
        (current !== null && typeof current === 'object')) return false;
    const norm = (v) => (v === undefined || v === null) ? '' : String(v);
    return norm(incoming) === norm(current);
};

/**
 * Referrals mutation entry point (production).
 * The engine implementation lives in ./server/referralMutationEngine.js (extracted
 * verbatim so test harnesses can drive it directly without the HTTP server).
 * Behavior is identical: same mutex, snapshot, verification, rollback, persist.
 */
const { mutateReferrals } = createReferralMutationEngine({ getData, persistData, referralAuditLogger });

// ==========================================
// 🔐 TRACK A1/A2: AUTHENTICATION & SESSIONS
// ==========================================
const sessionRepository = new SessionRepository(getData, persistData);
const authService = new AuthService(sessionRepository, () => getData('Users', []));
const { requireAuth, optionalAuth, requireAdmin } = createAuthMiddleware(authService);
const authRouter = createAuthRouter(authService, requireAuth, {
    // [P0-D2] 최초 관리자 bootstrap — Users.json이 비어있을 때만 login 경유로 생성.
    // 초기 비밀번호는 ADMIN_INIT_PASSWORD 환경변수만 사용 ('1234' 하드코딩 fallback 금지).
    // 미설정 시 fail-closed: 503 반환, 서버는 정상 기동.
    ensureInitialAdmin: async () => {
        const users = getData('Users', []);
        if (users.length > 0) return { created: false };
        const initPassword = process.env.ADMIN_INIT_PASSWORD;
        if (!initPassword) {
            console.error('[Bootstrap] ADMIN_INIT_PASSWORD 미설정 — 초기 관리자 생성 불가 (fail-closed)');
            return { blocked: true };
        }
        const adminUser = {
            id: "admin",
            username: "admin",
            name: "시스템관리자",
            password: initPassword,
            role: "admin",
            status: "active",
            team: "증진팀",
            createdDate: new Date().toISOString().split('T')[0],
            lastLogin: ""
        };
        try {
            await persistData('Users', [adminUser]);
        } catch (e) {
            console.error('[Bootstrap] 초기 관리자 저장 실패:', e && e.message);
            // fail-closed: persistData는 디스크 쓰기 전에 memoryCache를 갱신하므로,
            // 저장 실패 시 phantom 관리자를 캐시에서도 제거한다. 제거하지 않으면
            // 재시도 로그인이 미저장 관리자를 기준으로 진행하게 된다.
            // 참조 동등성(=== adminUser)으로 우리가 만든 phantom일 때만 제거한다.
            if (getData('Users', [])[0] === adminUser) {
                memoryCache['Users'] = [];
            }
            return { blocked: true, reason: 'PERSIST_FAILED' };
        }
        console.log('[Bootstrap] 초기 관리자 계정 생성됨 (Users 비어있음)');
        return { created: true };
    }
});

app.use('/api/auth', authRouter);

// ==========================================
// 📁 ATTACHMENTS (Protected Internal File Access)
// ==========================================
// [Fix] Legacy URL Rewrite Middleware
app.use('/attachments', (req, res, next) => {
    const url = decodeURIComponent(req.url);
    if (url.includes('이천센터의뢰관리 파일저장소')) {
        req.url = req.url.replace(/이천센터의뢰관리 파일저장소\/의뢰관리 첨부파일/, 'legacy')
            .replace(/이천센터의뢰관리 파일저장소/, 'legacy');
    }
    next();
});

// Protect /attachments with session authentication and cache prevention
app.use('/attachments', requireAuth, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

// Capability inspection endpoint (Minimal UI helper only; server enforces checks per request)
app.get('/api/auth/capabilities', requireAuth, (req, res) => {
    const caps = getEffectiveVoiceCapabilities(req.auth);
    res.json({ capabilities: caps });
});

// Periodic session cleanup (every 6 hours)
setInterval(() => {
    sessionRepository.cleanupExpiredSessions().catch(err => {
        console.error('Session cleanup error:', err);
    });
}, 6 * 60 * 60 * 1000);

// ==========================================
// 🎧 TRACK A7: AUTHENTICATED AUDIO STREAMING
// ==========================================
const isProduction = process.env.NODE_ENV === 'production';
let privateAudioDir = process.env.PRIVATE_AUDIO_DIR;

if (!privateAudioDir) {
    if (isProduction) {
        console.error('⚠️ [OPERATIONAL WARNING] PRIVATE_AUDIO_DIR is not configured in production. Audio streaming subsystem is DISABLED.');
        privateAudioDir = null;
    } else {
        privateAudioDir = path.resolve(DATA_DIR, '..', 'private-audio');
        if (!fs.existsSync(privateAudioDir)) {
            fs.mkdirSync(privateAudioDir, { recursive: true });
        }
    }
}

const voiceCallRepository = new VoiceCallRepository(getData, persistData);
const privateAudioAccessService = new PrivateAudioAccessService({
    privateAudioRoot: privateAudioDir
});
const audioStreamingAuditSink = new AuditEventSink();

// ==========================================
// 🔒 TRACK A10.5: RESTRICTED VOICE ACCESS GATE
// ==========================================
const voiceAccessConfig = parseVoiceAccessConfig(process.env);
const voiceAccessValidation = validateVoiceAccessConfig(voiceAccessConfig);

let voiceAccessAuthorizer = null;
if (voiceAccessConfig.enabled && voiceAccessValidation.valid) {
    const voiceAccessRepo = new VoiceAccessRepository({
        dataDir: voiceAccessConfig.dataDir
    });
    voiceAccessAuthorizer = new VoiceAccessAuthorizer({
        repository: voiceAccessRepo,
        mode: voiceAccessConfig.mode
    });
}

const voiceAuditLogger = (entry = {}) => {
    try {
        const auditEntry = {
            id: `audit_voice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            category: 'voice_ai',
            actorType: 'user',
            actorUserId: String(entry.actorUserId || 'system'),
            targetId: String(entry.targetId || entry.targetUserId || '-'),
            action: String(entry.action || 'VOICE_AI_EVENT'),
            timestamp: new Date().toISOString(),
            result: entry.result || 'SUCCESS',
            reasonCode: entry.reasonCode || null
        };
        console.log(`[VOICE_AUDIT] ${auditEntry.action} actor=${auditEntry.actorUserId} target=${auditEntry.targetId} result=${auditEntry.result}`);
        const currentLogs = getData('AuditEntries', []);
        currentLogs.push(auditEntry);
        if (currentLogs.length > 5000) currentLogs.shift();
        saveData('AuditEntries', currentLogs);
    } catch (ignore) {}
};

const surveyAuditLogger = (entry = {}) => {
    try {
        const auditEntry = {
            id: `audit_survey_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            category: 'online_survey',
            actorType: 'user',
            actorUserId: String(entry.actorUserId || 'system'),
            targetId: String(entry.targetId || entry.targetUserId || '-'),
            action: String(entry.action || 'ONLINE_SURVEY_EVENT'),
            timestamp: new Date().toISOString(),
            result: entry.result || 'SUCCESS',
            reasonCode: entry.reasonCode || null
        };
        console.log(`[SURVEY_AUDIT] ${auditEntry.action} actor=${auditEntry.actorUserId} target=${auditEntry.targetId} result=${auditEntry.result}`);
        const currentLogs = getData('AuditEntries', []);
        currentLogs.push(auditEntry);
        if (currentLogs.length > 5000) currentLogs.shift();
        saveData('AuditEntries', currentLogs);
    } catch (ignore) {}
};

const audioStreamingRouter = createAudioStreamingRouter({
    requireAuth,
    voiceCallRepository,
    privateAudioAccessService,
    auditEventSink: audioStreamingAuditSink,
    voiceAccessAuthorizer
});

const voiceCallRouter = createVoiceCallRouter({
    requireAuth,
    voiceCallRepository,
    privateAudioDir,
    joyCallIncomingDir: process.env.JOYCALL_INCOMING_DIR || (privateAudioDir ? path.resolve(privateAudioDir, '..', 'incoming-voice') : null),
    getData,
    persistData,
    auditLogger: voiceAuditLogger
});

app.use('/api/voice-calls', audioStreamingRouter);
app.use('/api/voice-calls', voiceCallRouter);

// ==========================================
// 📋 TRACK B: INTERNAL SURVEY IMPORT & MANAGEMENT
// ==========================================
console.log(`🔒 [SURVEY_CONFIG] Active execution mode: SURVEY_TRACK_A_MODE=${surveyTrackAMode}`);

// 2. Production Mode Fail-Closed Validation
if (surveyTrackAMode === 'production') {
    const requiredProductionEnvVars = [
        'TRACK_A_BASE_URL',
        'TRACK_B_SERVICE_SECRET',
        'TRACK_B_WORKER_ID',
        'SURVEY_PRIVATE_KEY_PATH',
        'TRACK_A_REQUEST_TIMEOUT_MS',
        'TRACK_A_MAX_BATCH_SIZE',
        'TRACK_A_DEFAULT_LEASE_SECONDS'
    ];

    const missingVars = requiredProductionEnvVars.filter(varName => !process.env[varName] || !process.env[varName].trim());
    if (missingVars.length > 0) {
        console.error(`❌ [FATAL_CONFIG_ERROR] Production mode requires all mandatory variables. Missing or empty: ${missingVars.join(', ')}`);
        throw new Error(`[FATAL] Missing required production environment variables: ${missingVars.join(', ')}. Server fail-closed.`);
    }

    const rawBatchSizeStr = process.env.TRACK_A_MAX_BATCH_SIZE;
    const trimmedBatchStr = typeof rawBatchSizeStr === 'string' ? rawBatchSizeStr.trim() : '';
    const numBatchSize = Number(trimmedBatchStr);
    const isStrictInteger = trimmedBatchStr !== '' && /^\d+$/.test(trimmedBatchStr) && Number.isInteger(numBatchSize);
    if (!isStrictInteger || numBatchSize < 1 || numBatchSize > 100) {
        console.error(`❌ [FATAL_CONFIG_ERROR] Production mode requires TRACK_A_MAX_BATCH_SIZE to be an integer between 1 and 100.`);
        throw new Error(`[FATAL] Invalid TRACK_A_MAX_BATCH_SIZE in production mode. Must be integer between 1 and 100. Server fail-closed.`);
    }
}

// 3. Staging Mode Validation
if (surveyTrackAMode === 'staging') {
    const requiredStagingEnvVars = [
        'TRACK_A_BASE_URL',
        'TRACK_B_SERVICE_SECRET',
        'TRACK_B_WORKER_ID',
        'SURVEY_PRIVATE_KEY_PATH',
        'TRACK_A_DEFAULT_LEASE_SECONDS'
    ];
    const missingStagingVars = requiredStagingEnvVars.filter(varName => !process.env[varName] || !process.env[varName].trim());
    if (missingStagingVars.length > 0) {
        console.error(`❌ [FATAL_CONFIG_ERROR] Staging mode requires all mandatory variables. Missing or empty: ${missingStagingVars.join(', ')}`);
        throw new Error(`[FATAL] Missing required staging environment variables: ${missingStagingVars.join(', ')}. Server fail-closed.`);
    }

    const leaseSec = Number(process.env.TRACK_A_DEFAULT_LEASE_SECONDS);
    if (isNaN(leaseSec) || leaseSec !== 600) {
        console.error(`❌ [FATAL_CONFIG_ERROR] Staging mode requires TRACK_A_DEFAULT_LEASE_SECONDS=600 (got ${process.env.TRACK_A_DEFAULT_LEASE_SECONDS})`);
        throw new Error(`[FATAL] Staging mode requires TRACK_A_DEFAULT_LEASE_SECONDS=600. Server fail-closed.`);
    }
}

// 4. Key Provider Initialization and Permissions Validation
const surveyPrivateKeyPath = process.env.SURVEY_PRIVATE_KEY_PATH || (surveyTrackAMode === 'mock' ? path.join(__dirname, '.mock_survey_private_key') : null);

const surveyKeyProvider = new SurveyKeyProvider({
    secretPath: surveyPrivateKeyPath
});

if (surveyTrackAMode === 'production' || surveyTrackAMode === 'staging') {
    // Fail closed if key file missing, unreadable, or invalid PEM format. Never fallback to Mock!
    try {
        surveyKeyProvider.validateKeyFilePermissions();
        console.log(`🔑 [SURVEY_CONFIG] Survey private key verified at: ${surveyPrivateKeyPath}`);
    } catch (keyErr) {
        console.error(`❌ [FATAL_KEY_ERROR] ${keyErr.message}`);
        throw new Error(`[FATAL] Survey private key is unavailable or unreadable in ${surveyTrackAMode} mode: ${keyErr.message}. Server fail-closed and will NOT fallback to mock.`);
    }
} else {
    // Mock mode: If secret file does not exist, initialize synthetic test key
    if (!fs.existsSync(surveyKeyProvider.secretPath)) {
        surveyKeyProvider.generateSyntheticTestKey('test_key_v1');
        console.log(`🌱 [SURVEY_CONFIG] Mock mode: initialized in-memory synthetic RSA key (test_key_v1).`);
    }
}

const surveyDecryptionService = new SurveyDecryptionService({
    keyProvider: surveyKeyProvider
});

const surveyPayloadValidator = new SurveyPayloadValidator({
    sbqrApproved: process.env.SBQR_GATE_APPROVED === 'true'
});

const surveyAssignmentRepository = new SurveyAssignmentRepository({
    getData,
    persistData
});

const internalNotificationRepository = new InternalNotificationRepository({
    getData,
    persistData
});

const surveyRepository = new SurveyImportRepository({
    getData,
    persistData,
    assignmentRepository: surveyAssignmentRepository,
    sourceEnvironment: surveyTrackAMode,
    attachmentsDir: ATTACHMENTS_DIR,
    auditLogger: surveyAuditLogger
});

// Common parameters
const trackABaseUrl = process.env.TRACK_A_BASE_URL || process.env.TRACK_A_COLLECTION_API_URL;
const trackBServiceSecret = process.env.TRACK_B_SERVICE_SECRET || process.env.TRACK_B_INTERNAL_PULL_TOKEN;
const trackBWorkerId = process.env.TRACK_B_WORKER_ID || (surveyTrackAMode === 'mock' ? 'track-b-mock-worker' : 'track-b-worker-1');
const trackARequestTimeoutMs = Number(process.env.TRACK_A_REQUEST_TIMEOUT_MS) || 10000;
const trackADefaultLeaseSeconds = Number(process.env.TRACK_A_DEFAULT_LEASE_SECONDS) || 600;
let trackAMaxBatchSize = 50;
if (surveyTrackAMode === 'production') {
    trackAMaxBatchSize = Number(process.env.TRACK_A_MAX_BATCH_SIZE.trim());
} else {
    const rawBatchStr = typeof process.env.TRACK_A_MAX_BATCH_SIZE === 'string' ? process.env.TRACK_A_MAX_BATCH_SIZE.trim() : '';
    const parsedBatch = Number(rawBatchStr);
    if (rawBatchStr !== '' && /^\d+$/.test(rawBatchStr) && Number.isInteger(parsedBatch) && parsedBatch >= 1 && parsedBatch <= 100) {
        trackAMaxBatchSize = parsedBatch;
    } else {
        trackAMaxBatchSize = 50;
    }
}

// Validate Track A URL for staging and production
if (surveyTrackAMode === 'staging' || surveyTrackAMode === 'production') {
    try {
        validateTrackABaseUrl(trackABaseUrl, surveyTrackAMode);
        console.log(`🌐 [SURVEY_CONFIG] TRACK_A_BASE_URL validated (${surveyTrackAMode}): ${trackABaseUrl}`);
    } catch (urlErr) {
        console.error(`❌ [FATAL_URL_ERROR] ${urlErr.message}`);
        throw new Error(`[FATAL] Invalid TRACK_A_BASE_URL: ${urlErr.message}. Server fail-closed.`);
    }
}

// 5. Explicit Client Selection strictly controlled by SURVEY_TRACK_A_MODE
let externalSurveyApiClient;
if (surveyTrackAMode === 'mock') {
    externalSurveyApiClient = new MockTrackAApi({
        workerId: trackBWorkerId,
        isProduction: false
    });
    console.log(`🧪 [SURVEY_CONFIG] MockTrackAApi client active (mode=mock).`);
} else {
    // staging or production
    externalSurveyApiClient = new TrackAClient({
        baseUrl: trackABaseUrl,
        serviceSecret: trackBServiceSecret,
        workerId: trackBWorkerId,
        timeoutMs: trackARequestTimeoutMs,
        defaultLeaseSeconds: trackADefaultLeaseSeconds
    });
    console.log(`🌐 [SURVEY_CONFIG] TrackAClient active (mode=${surveyTrackAMode}, url=${trackABaseUrl}, workerId=${trackBWorkerId}, lease=${trackADefaultLeaseSeconds}s).`);
}

const surveyReportGenerator = new SurveyReportGenerator();
const surveyReferralService = new SurveyReferralService({
    getData,
    persistData,
    attachmentsDir: ATTACHMENTS_DIR,
    reportGenerator: surveyReportGenerator,
    getUsers: () => getData('Users', []),
    sourceEnvironment: surveyTrackAMode,
    mutateReferrals
});

const surveyImportService = new SurveyImportService({
    repository: surveyRepository,
    decryptionService: surveyDecryptionService,
    validator: surveyPayloadValidator,
    externalApiClient: externalSurveyApiClient,
    referralService: surveyReferralService,
    assignmentRepository: surveyAssignmentRepository,
    notificationRepository: internalNotificationRepository,
    workerId: trackBWorkerId,
    defaultLeaseSeconds: trackADefaultLeaseSeconds,
    maxBatchSize: trackAMaxBatchSize,
    sourceEnvironment: surveyTrackAMode
});

const surveyExportService = new SurveyExportService();

const surveyAutoImportScheduler = new SurveyAutoImportScheduler({
    surveyImportService,
    repository: surveyRepository,
    externalApiClient: externalSurveyApiClient,
    keyProvider: surveyKeyProvider,
    auditLogger: surveyAuditLogger
});

const surveyImportRouter = createSurveyImportRouter({
    requireAuth,
    surveyImportService,
    surveyRepository,
    surveyAssignmentRepository,
    notificationRepository: internalNotificationRepository,
    surveyExportService,
    referralService: surveyReferralService,
    autoImportScheduler: surveyAutoImportScheduler,
    getUsers: () => getData('Users', []),
    keyProvider: surveyKeyProvider,
    externalApiClient: externalSurveyApiClient,
    attachmentsDir: ATTACHMENTS_DIR,
    trackABaseUrl,
    trackBServiceSecret,
    trackBWorkerId,
    surveyTrackAMode,
    auditLogger: surveyAuditLogger
});

const notificationRouter = createNotificationRouter({
    requireAuth,
    notificationRepository: internalNotificationRepository
});

app.use('/api/surveys', surveyImportRouter);
app.use('/api/notifications', notificationRouter);

// Start autonomous background survey synchronization (60s initial delay, 5m cycle)
surveyAutoImportScheduler.start();

// Startup workflow recovery for pending deletions or lease reacquisition
surveyImportService.recoverPendingWorkflows('startup_recovery').catch(err => {
    console.error('⚠️ [SURVEY_STARTUP_RECOVERY_ERROR]:', err.message);
});

// In development/local mock mode, if SurveySubmissions is empty, auto-import seeded synthetic records
// STRICT ENFORCEMENT: Never seed synthetic records in staging or production mode!
if (surveyTrackAMode === 'mock' && process.env.NODE_ENV !== 'production') {
    const existingSubs = surveyRepository.getSurveySubmissions();
    if (existingSubs.length === 0 && typeof externalSurveyApiClient.seedDefaultSyntheticSubmissions === 'function') {
        const pubKey = surveyKeyProvider.getPublicKey ? surveyKeyProvider.getPublicKey('test_key_v1') : '';
        if (pubKey) {
            externalSurveyApiClient.seedDefaultSyntheticSubmissions(pubKey);
            surveyImportService.runManualImport({ actorId: 'system_dev_seed', limit: 10 }).then(async (summary) => {
                console.log(`🌱 [SURVEY_SEED] Auto-imported ${summary.imported} synthetic submissions with draft referrals & PDF reports.`);
                try {
                    await surveyRepository.assignStaff({
                        submissionId: 'sub-demo-002',
                        targetUserId: 'admin',
                        assignedDepartmentId: '증진팀',
                        actorId: 'system',
                        assignmentPriority: 'NORMAL',
                        reason: '신규 접수 배정'
                    });
                    await surveyReferralService.updateReferralAssignee('sub-demo-002', 'admin', '증진팀', 'system', '신규 접수 배정');
                } catch (ignore) {}
            }).catch(e => console.warn('🌱 [SURVEY_SEED] Notice:', e.message));
        }
    }
}


// --- UTILITIES ---
const normalizeMemberRegistrationNo = (raw) => {
    if (raw == null) return '';
    let str = String(raw).trim();
    if (str.includes('.') || str.includes('e')) {
        const num = Number(str);
        if (!isNaN(num)) str = String(BigInt(Math.floor(num)));
    }
    return str.replace(/[^a-zA-Z0-9]/g, '');
};

function normalizeRegistrationNo(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/\.0$/, '');
}

function normalizeKeyText(value) {
  return String(value ?? '').trim().replace(/\s+/g, '');
}

function buildMemberEvaluationKey(member) {
  const memberId = member?.memberId ?? member?.id;
  if (memberId !== undefined && memberId !== null && String(memberId).trim()) {
    return `id:${String(memberId).trim()}`;
  }

  const reg = normalizeRegistrationNo(
    member?.memberRegistrationNo ??
    member?.registrationNo ??
    member?.memberNo ??
    member?.회원등록번호
  );

  const name = normalizeKeyText(
    member?.memberName ??
    member?.name ??
    member?.clientName ??
    member?.targetName ??
    member?.회원명 ??
    member?.이름
  );

  return `mp:${reg || 'no-reg'}:${name || 'no-name'}`;
}

const normalizePersonName = (value) => {
    if (value == null) return null;
    const text = String(value).trim().replace(/\s+/g, '');
    return text || null;
};

// Trash Auto-Cleanup
const cleanupTrash = () => {
    try {
        const trash = getData('Trash', []);
        if (!trash || trash.length === 0) return;
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const filtered = trash.filter(item => {
            if (!item.deletedAt) return true;
            return new Date(item.deletedAt).getTime() > thirtyDaysAgo;
        });
        if (filtered.length < trash.length) {
            const purgedCount = trash.length - filtered.length;
            saveData('Trash', filtered);
            referralAuditLogger({
                actorUserId: 'system',
                targetId: `count:${purgedCount}`,
                action: 'TRASH_PURGE',
                result: 'SUCCESS',
                reasonCode: 'RETENTION_EXPIRED'
            });
        }
    } catch (e) {
        console.error('Trash cleanup error:', e);
    }
};

cleanupTrash();
setInterval(cleanupTrash, 24 * 60 * 60 * 1000);

const CASE_ANALYSIS_FILE = 'CaseAnalysisSavedResults';

const normalizeSavedAnalysisList = (raw) => {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw?.data)) list = raw.data;
    else if (Array.isArray(raw?.list)) list = raw.list;
    else if (Array.isArray(raw?.value)) list = raw.value;

    return list
        .filter(item => item && (item.id || item._id))
        .map((item, idx) => ({
            id: String(item.id || item._id || `id_${idx}`),
            name: String(item.name || item.title || `저장된 분석 ${idx + 1}`),
            createdAt: String(item.createdAt || item.created_at || new Date().toISOString()),
            data: item.data || {}
        }));
};

// ==========================================
// API ENDPOINTS
// ==========================================

// ==========================================
// 🏢 ORG SETTINGS (다센터 지원: 기관별 설정 외부화)
// - Settings.json이 없으면 아래 기본값으로 시드 (constants.ts의 현재 하드코딩 값과 100% 동일)
// - 기존 데이터 행은 절대 수정하지 않음 (additive only)
// - 설정이 비어있거나 조회 실패 시 클라이언트는 constants.ts 값으로 폴백
// ==========================================
const DEFAULT_ORG_SETTINGS = {
    orgName: '이천시정신건강복지센터',
    orgShortName: '이천센터',
    region: '이천',
    setupCompleted: true, // 시드 시점에 데이터 존재 여부로 재결정됨
    teams: [
        { name: '증진팀', code: 'JJ' },
        { name: '회복팀', code: 'HB' },
        { name: '자살예방센터', code: 'JY' },
        { name: '아동청소년', code: 'AC' },
        { name: '남부분소', code: 'NB' },
    ],
    subTeams: ['회복', '아청', '자살', '청년'],
    subTeamParent: '남부분소', // 세부팀을 사용하는 팀 (해당 팀 선택 시 세부 분류 드롭다운 표시)
    regions: ["장호원읍", "부발읍", "신둔면", "백사면", "호법면", "마장면", "대월면", "모가면", "설성면", "율면", "창전동", "증포동", "중리동", "관고동", "기타"],
    referralPaths: ['가족', '경찰서', '소방', '의료기관', '기타', '본인', '읍면동 행정복지센터', '의뢰기관', '이천시청', '정신보건기관', '보건소', '지역사회복지관', '지인', '게이트키퍼'],
};

// 신규 설치 vs 기존 운영 판단: 데이터 파일이 하나라도 있으면 기존 운영으로 간주
const hasExistingOrgData = () => {
    try {
        for (const f of ['Referrals', 'Users', 'SuicideAttempters', 'BudgetPlans']) {
            const p = path.join(DATA_DIR, `${f}.json`);
            if (fs.existsSync(p)) {
                const c = fs.readFileSync(p, 'utf8').trim();
                if (c && c !== '[]' && c !== '{}') return true;
            }
        }
    } catch (e) { /* 폴백: 기존 운영으로 간주하지 않음 */ }
    return false;
};

const getOrgSettings = () => {
    const existing = getData('Settings', null);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    // 깊은 복사로 기본값 공유 참조 방지. 값은 constants.ts와 100% 동일해야 함.
    const copy = JSON.parse(JSON.stringify(DEFAULT_ORG_SETTINGS));
    copy.setupCompleted = hasExistingOrgData();
    saveData('Settings', copy);
    console.log(`🏢 [SETTINGS] 기본 기관 설정 시드 완료 (setupCompleted=${copy.setupCompleted})`);
    return copy;
};

// refNo용 팀 코드 조회: 설정 → 레거시 TEAM_CODES 맵 → 'ET'
// (시드된 설정의 팀/코드가 기존 TEAM_CODES와 동일하므로 기존 동작과 100% 동일)
const getTeamCodeForRefNo = (teamName) => {
    try {
        const s = getOrgSettings();
        const t = (s.teams || []).find(t => t && t.name === teamName);
        if (t && t.code) return t.code;
    } catch (e) { /* 폴백 */ }
    return (typeof TEAM_CODES !== 'undefined' && TEAM_CODES[teamName]) || 'ET';
};

// 설정 조회: 미인증 시 setupCompleted 플래그만 반환 (초기 마법사 표시 판단용)
app.get('/api/settings', optionalAuth, (req, res) => {
    try {
        const s = getOrgSettings();
        if (!req.auth || !req.auth.id) {
            return res.json({ setupCompleted: !!s.setupCompleted });
        }
        res.json(s);
    } catch (e) {
        console.error('GET /api/settings error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 설정 수정: 관리자 전용. teams가 비게 되는 변경은 거부 (드롭다운 붕괴 방지)
app.put('/api/settings', requireAdmin, (req, res) => {
    try {
        const body = req.body || {};
        const current = getOrgSettings();
        if (body.teams !== undefined) {
            if (!Array.isArray(body.teams) || body.teams.length === 0) {
                return res.status(400).json({ success: false, error: '팀은 최소 1개 이상이어야 합니다.' });
            }
            for (const t of body.teams) {
                if (!t || typeof t.name !== 'string' || !t.name.trim() || typeof t.code !== 'string' || !t.code.trim()) {
                    return res.status(400).json({ success: false, error: '팀 이름과 코드는 필수입니다.' });
                }
            }
        }
        const merged = { ...current, ...body, setupCompleted: true };
        saveData('Settings', merged);
        res.json({ success: true, settings: merged });
    } catch (e) {
        console.error('PUT /api/settings error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 초기 설정 마법사 완료: 인증 불필요, setupCompleted=false일 때만 1회 실행 가능
app.post('/api/setup', (req, res) => {
    try {
        const current = getOrgSettings();
        if (current.setupCompleted) {
            return res.status(403).json({ success: false, error: '이미 초기 설정이 완료되었습니다.' });
        }
        const { orgName, orgShortName, region, teams, subTeams, subTeamParent, regions, referralPaths, admin } = req.body || {};
        if (!orgName || !String(orgName).trim()) {
            return res.status(400).json({ success: false, error: '기관명은 필수입니다.' });
        }
        if (!Array.isArray(teams) || teams.length === 0 || teams.some(t => !t || !t.name || !t.code)) {
            return res.status(400).json({ success: false, error: '팀 목록( 이름+코드 )은 최소 1개 이상 필수입니다.' });
        }
        if (!admin || !admin.username || !admin.password || String(admin.password).length < 4) {
            return res.status(400).json({ success: false, error: '관리자 계정(ID/4자 이상 비밀번호)은 필수입니다.' });
        }
        const settings = {
            orgName: String(orgName).trim(),
            orgShortName: String(orgShortName || orgName).trim(),
            region: String(region || '').trim(),
            setupCompleted: true,
            teams: teams.map(t => ({ name: String(t.name).trim(), code: String(t.code).trim().toUpperCase() })),
            subTeams: Array.isArray(subTeams) ? subTeams.map(String) : [],
            subTeamParent: typeof subTeamParent === 'string' ? subTeamParent.trim() : '',
            regions: Array.isArray(regions) ? regions.map(String) : [],
            referralPaths: Array.isArray(referralPaths) ? referralPaths.map(String) : [],
        };
        saveData('Settings', settings);
        // 관리자 계정 생성 (멱등: 동일 ID가 있으면 생성 스킵)
        const users = getData('Users', []);
        if (!users.find(u => u.id === admin.username || u.username === admin.username)) {
            users.push({
                id: admin.username,
                username: admin.username,
                password: String(admin.password),
                name: String(admin.name || '시스템관리자'),
                role: 'admin',
                team: settings.teams[0].name,
                status: 'active',
                createdDate: new Date().toISOString().split('T')[0],
            });
            saveData('Users', users);
        }
        console.log(`🏢 [SETUP] 초기 설정 완료: ${settings.orgName}`);
        res.json({ success: true });
    } catch (e) {
        console.error('POST /api/setup error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// [P0-D2] 최초 관리자 bootstrap은 POST /api/auth/login 내부로 이관됨.
// 이 라우트는 순수 조회만 수행한다.
app.get('/api/users', requireAuth, (req, res) => {
    const users = getData('Users', []);
    // [Track A1 Security] Strip password before returning user list to clients
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
});

const ALLOWED_USER_ROLES = ['admin', 'staff', 'user', 'manager'];

app.post('/api/users', requireAdmin, (req, res) => {
    const newUser = req.body || {};
    const users = getData('Users', []);
    if (!newUser.id || !newUser.password) {
        return res.status(400).json({ success: false, error: "id and password are required" });
    }
    if (newUser.role && !ALLOWED_USER_ROLES.includes(newUser.role)) {
        return res.status(400).json({ success: false, error: "Invalid role" });
    }
    if (users.find(u => u.id === newUser.id)) {
        return res.status(400).json({ success: false, error: "Duplicate ID" });
    }
    users.push({
        ...newUser,
        role: newUser.role || 'user',
        status: newUser.status || 'active',
        createdDate: newUser.createdDate || new Date().toISOString().split('T')[0]
    });
    saveData('Users', users);
    res.json({ success: true });
});

app.put('/api/users', requireAdmin, async (req, res) => {
    try {
        const updatedUser = req.body;
        const users = getData('Users', []);
        const index = users.findIndex(u => u.id === updatedUser.id);
        if (index !== -1) {
            users[index] = updatedUser;
            await persistData('Users', users);
            return res.json({ success: true, user: updatedUser });
        }
        res.status(404).json({ success: false, error: "User not found" });
    } catch (err) {
        console.error('PUT /api/users error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin-controlled Voice Recording AI access grant/revoke
app.patch('/api/users/:id/voice-access', requireAuth, async (req, res) => {
    try {
        if (!req.auth || req.auth.role !== 'admin') {
            voiceAuditLogger({
                actorUserId: req.auth?.id || 'unknown',
                targetUserId: req.params.id,
                action: 'VOICE_AI_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'ADMIN_REQUIRED'
            });
            return res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: '관리자만 사용자 권한을 변경할 수 있습니다.'
                }
            });
        }

        if (!req.body || typeof req.body.granted !== 'boolean') {
            voiceAuditLogger({
                actorUserId: req.auth?.id || 'unknown',
                targetUserId: req.params.id,
                action: 'VOICE_AI_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'INVALID_GRANTED_VALUE'
            });
            return res.status(400).json({
                error: {
                    code: 'INVALID_GRANTED_VALUE',
                    message: 'granted 값은 true 또는 false여야 합니다.'
                }
            });
        }

        const granted = req.body.granted;
        const targetId = req.params.id;
        const users = getData('Users', []);
        const targetIndex = users.findIndex(u => u && String(u.id) === String(targetId));

        if (targetIndex === -1) {
            return res.status(404).json({
                error: {
                    code: 'USER_NOT_FOUND',
                    message: '대상 사용자를 찾을 수 없습니다.'
                }
            });
        }

        const targetUser = users[targetIndex];

        if (targetUser.status !== 'active') {
            return res.status(400).json({
                error: {
                    code: 'USER_NOT_ACTIVE',
                    message: '비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.'
                }
            });
        }

        // Safe immutable permissions clone (preserves all other keys including voiceCalls)
        let updatedPermissions;
        if (Array.isArray(targetUser.permissions)) {
            if (granted) {
                updatedPermissions = targetUser.permissions.includes('VOICE_RECORDING_AI_ACCESS')
                    ? [...targetUser.permissions]
                    : [...targetUser.permissions, 'VOICE_RECORDING_AI_ACCESS'];
            } else {
                updatedPermissions = targetUser.permissions.filter(p => p !== 'VOICE_RECORDING_AI_ACCESS');
            }
        } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
            updatedPermissions = {
                ...targetUser.permissions,
                VOICE_RECORDING_AI_ACCESS: granted
            };
        } else {
            updatedPermissions = {
                VOICE_RECORDING_AI_ACCESS: granted
            };
        }

        // Atomic update: construct cloned user and cloned array without mutating existing records in place
        const updatedUser = {
            ...targetUser,
            permissions: updatedPermissions
        };

        const updatedUsers = [
            ...users.slice(0, targetIndex),
            updatedUser,
            ...users.slice(targetIndex + 1)
        ];

        await persistData('Users', updatedUsers);

        const auditAction = granted ? 'VOICE_AI_PERMISSION_GRANTED' : 'VOICE_AI_PERMISSION_REVOKED';
        voiceAuditLogger({
            actorUserId: req.auth.id,
            targetUserId: updatedUser.id,
            action: auditAction,
            result: 'SUCCESS',
            reasonCode: granted ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED'
        });

        const { password, ...safeUser } = updatedUser;
        return res.json({
            success: true,
            message: granted
                ? '음성 녹음 분석(AI) 사용 권한을 부여했습니다.'
                : '음성 녹음 분석(AI) 사용 권한을 회수했습니다.',
            user: safeUser
        });
    } catch (err) {
        console.error('PATCH /api/users/:id/voice-access error:', err);
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: '권한 변경 처리 중 오류가 발생했습니다.'
            }
        });
    }
});

// Admin-controlled Online Survey access grant/revoke
app.patch('/api/users/:id/online-survey-access', requireAuth, async (req, res) => {
    try {
        if (!req.auth || req.auth.role !== 'admin') {
            surveyAuditLogger({
                actorUserId: req.auth?.id || 'unknown',
                targetUserId: req.params.id,
                action: 'ONLINE_SURVEY_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'ADMIN_REQUIRED'
            });
            return res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: '관리자만 사용자 권한을 변경할 수 있습니다.'
                }
            });
        }

        if (!req.body || typeof req.body.granted !== 'boolean') {
            surveyAuditLogger({
                actorUserId: req.auth?.id || 'unknown',
                targetUserId: req.params.id,
                action: 'ONLINE_SURVEY_ACCESS_DENIED',
                result: 'DENIED',
                reasonCode: 'INVALID_GRANTED_VALUE'
            });
            return res.status(400).json({
                error: {
                    code: 'INVALID_GRANTED_VALUE',
                    message: 'granted 값은 true 또는 false여야 합니다.'
                }
            });
        }

        const granted = req.body.granted;
        const targetId = req.params.id;
        const users = getData('Users', []);
        const targetIndex = users.findIndex(u => u && String(u.id) === String(targetId));

        if (targetIndex === -1) {
            return res.status(404).json({
                error: {
                    code: 'USER_NOT_FOUND',
                    message: '대상 사용자를 찾을 수 없습니다.'
                }
            });
        }

        const targetUser = users[targetIndex];

        if (targetUser.status !== 'active') {
            return res.status(400).json({
                error: {
                    code: 'USER_NOT_ACTIVE',
                    message: '비활성 또는 정지된 사용자에게는 권한을 부여할 수 없습니다.'
                }
            });
        }

        // Safe immutable permissions clone (preserves all other keys including VOICE_RECORDING_AI_ACCESS, voiceCalls, etc.)
        let updatedPermissions;
        if (Array.isArray(targetUser.permissions)) {
            if (granted) {
                updatedPermissions = targetUser.permissions.includes('ONLINE_SURVEY_ACCESS')
                    ? [...targetUser.permissions]
                    : [...targetUser.permissions, 'ONLINE_SURVEY_ACCESS'];
            } else {
                updatedPermissions = targetUser.permissions.filter(p => p !== 'ONLINE_SURVEY_ACCESS');
            }
        } else if (typeof targetUser.permissions === 'object' && targetUser.permissions !== null) {
            updatedPermissions = {
                ...targetUser.permissions,
                ONLINE_SURVEY_ACCESS: granted
            };
        } else {
            updatedPermissions = {
                ONLINE_SURVEY_ACCESS: granted
            };
        }

        // Atomic update: construct cloned user and cloned array without mutating existing records in place
        const updatedUser = {
            ...targetUser,
            permissions: updatedPermissions
        };

        const updatedUsers = [
            ...users.slice(0, targetIndex),
            updatedUser,
            ...users.slice(targetIndex + 1)
        ];

        await persistData('Users', updatedUsers);

        const auditAction = granted ? 'ONLINE_SURVEY_PERMISSION_GRANTED' : 'ONLINE_SURVEY_PERMISSION_REVOKED';
        surveyAuditLogger({
            actorUserId: req.auth.id,
            targetUserId: updatedUser.id,
            action: auditAction,
            result: 'SUCCESS',
            reasonCode: granted ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED'
        });

        const { password, ...safeUser } = updatedUser;
        return res.json({
            success: true,
            message: granted
                ? '온라인 설문 사용 권한을 부여했습니다.'
                : '온라인 설문 사용 권한을 회수했습니다.',
            user: safeUser
        });
    } catch (err) {
        console.error('PATCH /api/users/:id/online-survey-access error:', err);
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: '권한 변경 처리 중 오류가 발생했습니다.'
            }
        });
    }
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
    if (!req.auth || req.auth.role !== 'admin') {
        return res.status(403).json({ success: false, error: "관리자만 사용자 권한을 변경할 수 있습니다." });
    }
    const userId = req.params.id;
    const users = getData('Users', []);
    if (userId === 'admin') {
        return res.status(403).json({ success: false, error: "Cannot delete the default admin account." });
    }
    const filteredUsers = users.filter(u => u.id !== userId);
    saveData('Users', filteredUsers);
    res.json({ success: true });
});

// REFERRALS
app.get('/api/referrals', requireAuth, (req, res) => {
    try {
        let referrals = getData('Referrals', []);
        const { team, closureStatus, registrationStatus, view, source, includeOnlineSurveys } = req.query;

        // [Track B P0-1: Online Survey Separation]
        // ONLINE_SURVEY records are excluded from general referral list by default.
        const isOnlineSurveyRecord = (r) => {
            if (!r) return false;
            const src = String(r.source || r.sourceType || '').toUpperCase();
            return src === 'ONLINE_SURVEY' || Boolean(r.sourceSubmissionId) || Boolean(r.sourceSurveyId);
        };

        const requestedSource = String(source || '').toUpperCase();
        if (requestedSource === 'ONLINE_SURVEY') {
            referrals = referrals.filter(isOnlineSurveyRecord);
        } else if (includeOnlineSurveys !== 'true') {
            referrals = referrals.filter(r => !isOnlineSurveyRecord(r));
        }

        const reqUserId = req.headers['x-user-id'] || req.query.userId;
        const reqUserRole = req.headers['x-user-role'] || req.query.userRole;
        let reqUserTeam = req.headers['x-user-team'] || req.query.userTeam;
        if (reqUserTeam) {
            try { reqUserTeam = decodeURIComponent(reqUserTeam); } catch {}
        }

        const users = getData('Users', []);
        const user = users.find(u => u.id === reqUserId || u.username === reqUserId);
        const role = user?.role || reqUserRole || 'user';
        const userTeam = user?.team || reqUserTeam;
        const canSelectAllTeams = role === 'admin' || (role === 'manager' && user?.permissions?.referrals?.read !== false);

        let effectiveTeam = team;

        if (effectiveTeam && effectiveTeam !== 'all') {
            referrals = referrals.filter(r => {
                if (effectiveTeam === '남부분소') {
                    return r.team === '남부분소';
                }
                return r.team === effectiveTeam || (r.team === '남부분소' && r.subTeam === effectiveTeam);
            });
        }

        if (closureStatus && closureStatus !== 'all') {
            if (closureStatus === 'ongoing') {
                referrals = referrals.filter(r => r.closureStatus === '미종결');
            } else if (closureStatus === 'closed') {
                referrals = referrals.filter(r => r.closureStatus !== '미종결');
            }
        }

        if (registrationStatus && registrationStatus !== 'all') {
            referrals = referrals.filter(r => (r.registrationStatus || (r.isUnregistered ? '미등록' : '확인중')) === registrationStatus);
        }

        // [Track B: Default Sort: Unclosed/Ongoing first, Completed/Closed to bottom]
        referrals.sort((a, b) => {
            // 1. 종결 및 등록관리 완료 여부 최우선 판정 (완료된 건은 무조건 뒤로)
            const aCompleted = Boolean(
                (a.closureStatus && a.closureStatus !== '미종결') ||
                (a.actionResult && (a.actionResult.includes('등록관리') || a.actionResult.includes('종결')))
            );
            const bCompleted = Boolean(
                (b.closureStatus && b.closureStatus !== '미종결') ||
                (b.actionResult && (b.actionResult.includes('등록관리') || b.actionResult.includes('종결')))
            );
            if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

            // 2. 미완료(진행중) 중에서만 미등록 우선
            if (!aCompleted) {
                const isUnregA = Boolean(a.registrationStatus === '미등록' || a.isUnregistered === true);
                const isUnregB = Boolean(b.registrationStatus === '미등록' || b.isUnregistered === true);
                if (isUnregA !== isUnregB) return isUnregA ? -1 : 1;
            }

            // 3. 접수일자 내림차순
            const dateA = a.requestDate ? new Date(a.requestDate).getTime() : 0;
            const dateB = b.requestDate ? new Date(b.requestDate).getTime() : 0;
            if (dateA !== dateB) return dateB - dateA;

            // 4. 의뢰번호 내림차순
            return (b.refNo || '').localeCompare(a.refNo || '');
        });

        // Lightweight summary view for dashboard listing to optimize payload size
        if (view === 'summary') {
            const summaryData = referrals.map(r => {
                const { notes, attachments, ...rest } = r;
                const safeNotes = Array.isArray(notes) ? notes : [];
                const safeAttachments = Array.isArray(attachments) ? attachments : [];
                return {
                    ...rest,
                    noteCount: safeNotes.length,
                    latestNote: r.latestNote || (safeNotes[0] ? safeNotes[0].content : ''),
                    latestNoteDate: r.latestNoteDate || (safeNotes[0] ? (safeNotes[0].createdAt || safeNotes[0].date) : ''),
                    attachmentCount: safeAttachments.length,
                    attachments: safeAttachments.map(a => ({
                        id: a.id,
                        name: a.name,
                        size: a.size,
                        type: a.type,
                        uploadedAt: a.uploadedAt
                    }))
                };
            });
            return res.json(summaryData);
        }

        res.json(referrals);
    } catch (err) {
        console.error('❌ GET /api/referrals error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Direct URL/ID access preserves full record access regardless of list exclusion
app.get('/api/referrals/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const referrals = getData('Referrals', []);
        const target = referrals.find(r => r && (r.referralId === id || r.refNo === id || r.clientId === id || r.sourceSubmissionId === id));
        if (!target) {
            return res.status(404).json({ success: false, error: 'Referral not found' });
        }
        res.json(target);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 📅 AUTOMATIC 30-DAY RETENTION SCHEDULER (Asia/Seoul 03:30 Daily)
// ==========================================
let retentionPurgeRunning = false;
let retentionPurgeTimer = null;

export function scheduleNextRetentionPurge(surveyRepo, auditLogFn) {
    if (!surveyRepo || typeof surveyRepo.purgeExpiredSubmissions !== 'function') return null;

    const now = new Date();
    let nextRunDate;
    try {
        nextRunDate = getNextKstPurgeTime(now);
    } catch (e) {
        console.error('[RetentionScheduler] Failed to calculate next KST purge time:', e);
        return null;
    }
    const delayMs = Math.max(nextRunDate.getTime() - now.getTime(), 1000);

    retentionPurgeTimer = setTimeout(async () => {
        if (retentionPurgeRunning) {
            console.warn('[RetentionScheduler] Previous purge still running, skipping cycle.');
            scheduleNextRetentionPurge(surveyRepo, auditLogFn);
            return;
        }

        retentionPurgeRunning = true;
        const startMs = Date.now();
        try {
            const summary = await surveyRepo.purgeExpiredSubmissions({
                actorId: 'scheduler_retention_30d',
                retentionDays: 30
            });
            const durationMs = Date.now() - startMs;
            if (typeof auditLogFn === 'function') {
                auditLogFn({
                    actorUserId: 'scheduler_retention_30d',
                    action: 'AUTOMATIC_SURVEY_RETENTION_EXECUTED',
                    result: 'SUCCESS',
                    processedCount: summary.totalProcessed || 0,
                    purgedCount: summary.purgedCount || 0,
                    retainedAttachmentCount: summary.retainedSharedPdfCount || 0,
                    orphanDeletedCount: summary.deletedOrphanPdfCount || 0,
                    failedCount: summary.failedCount || 0,
                    durationMs
                });
            }
        } catch (err) {
            console.error('[RetentionScheduler] Error during automatic 30-day purge:', err);
            if (typeof auditLogFn === 'function') {
                auditLogFn({
                    actorUserId: 'scheduler_retention_30d',
                    action: 'AUTOMATIC_SURVEY_RETENTION_FAILED',
                    result: 'FAILED',
                    reasonCode: err.code || err.message || 'PURGE_UNHANDLED_EXCEPTION',
                    durationMs: Date.now() - startMs
                });
            }
        } finally {
            retentionPurgeRunning = false;
            // Schedule next daily cycle
            scheduleNextRetentionPurge(surveyRepo, auditLogFn);
        }
    }, delayMs);

    if (retentionPurgeTimer && typeof retentionPurgeTimer.unref === 'function') {
        retentionPurgeTimer.unref();
    }

    return { nextRunDate, delayMs };
}

// Schedule automatic 30-day retention purge (Daily at 03:30 Asia/Seoul)
// Initialized after surveyRepository, surveyAuditLogger, and scheduler declarations are fully evaluated
scheduleNextRetentionPurge(surveyRepository, surveyAuditLogger);

// Attachment streaming endpoint (supports inline PDF preview, strictly guarded and audited)
// [P0-D6] 첨부파일 경로 검증 헬퍼 — GET /attachments와 DELETE /api/deleteFile이 공유.
// traversal 문자 검사 → basename+sanitize → path.resolve prefix 검증 → symlink(realpath) 검증.
// 반환: { ok:true, safeFolder, safeFile, resolvedPath } 또는 { ok:false, reason }
function validateAttachmentPath(folder, file) {
    if (!folder || !file ||
        folder.includes('..') || file.includes('..') ||
        folder.includes('/') || folder.includes('\\') ||
        file.includes('/') || file.includes('\\')) {
        return { ok: false, reason: 'PATH_TRAVERSAL' };
    }
    const safeFolder = path.basename(folder).replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
    const safeFile = path.basename(file);
    if (!safeFolder || !safeFile) {
        return { ok: false, reason: 'EMPTY' };
    }
    const base = path.resolve(ATTACHMENTS_DIR);
    const resolvedPath = path.resolve(base, safeFolder, safeFile);
    if (!resolvedPath.startsWith(base + path.sep)) {
        return { ok: false, reason: 'PREFIX' };
    }
    // symlink 방어: 실제 경로를 해소해 다시 prefix 검증 (파일이 없을 때는 skip — 존재 검사는 호출자 몫)
    try {
        const real = fs.realpathSync(resolvedPath);
        let realBase;
        try { realBase = fs.realpathSync(base); } catch { realBase = base; }
        if (real !== realBase && !real.startsWith(realBase + path.sep)) {
            return { ok: false, reason: 'SYMLINK_ESCAPE' };
        }
    } catch (e) { /* ENOENT 등 — 호출자가 존재 여부를 판단 */ }
    return { ok: true, safeFolder, safeFile, resolvedPath };
}

app.get('/attachments/:folder/:file', requireAuth, async (req, res) => {
    try {
        if (!req.auth || req.auth.status !== 'active') {
            return res.status(403).json({ error: { code: 'ACCOUNT_INACTIVE', message: '비활성화된 계정은 첨부파일을 조회할 수 없습니다.' } });
        }

        const { folder, file } = req.params;
        // 1. Path traversal security checks (공유 헬퍼 — DELETE /api/deleteFile과 동일 정책)
        const pathCheck = validateAttachmentPath(folder, file);
        if (!pathCheck.ok) {
            if (typeof surveyAuditLogger === 'function') {
                surveyAuditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    action: 'ATTACHMENT_ACCESS_DENIED',
                    result: 'DENIED',
                    reasonCode: pathCheck.reason === 'PATH_TRAVERSAL' ? 'PATH_TRAVERSAL_ATTEMPT' : 'PATH_TRAVERSAL_DETECTED'
                });
            }
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '잘못된 경로입니다.' } });
        }
        const { safeFolder, safeFile, resolvedPath } = pathCheck;

        // 2. Object-Level Authorization: Check before reading disk
        const currentUserId = String(req.auth?.id || req.auth?.userId || '');
        const userRole = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
        const isAdmin = userRole === 'admin';

        const referrals = getData('Referrals', []);
        const connectedReferral = referrals.find(r =>
            r && (
                r.referralId === safeFolder ||
                r.refNo === safeFolder ||
                r.sourceSubmissionId === safeFolder ||
                r.sourceSurveyId === safeFolder ||
                (r.attachments && r.attachments.some(a => a && (a.id === safeFile || a.url?.includes(encodeURIComponent(safeFile)) || a.url?.includes(encodeURIComponent(safeFolder)))))
            )
        );

        const submissions = surveyRepository.getSurveySubmissions();
        const connectedSurvey = submissions.find(s =>
            s && (
                s.submissionId === safeFolder ||
                s.internalSurveyId === safeFolder ||
                s.attachmentId === safeFile ||
                (s.attachment && s.attachment.id === safeFile) ||
                (s.attachment && s.attachment.url?.includes(encodeURIComponent(safeFile)))
            )
        );

        let isAuthorized = false;
        let denialReason = 'OBJECT_AUTHORIZATION_FAILED';

        if (isAdmin) {
            isAuthorized = true;
        } else {
            // Check connected referral authorization first
            if (connectedReferral) {
                const refCheck = canAccessReferralAttachment({ authUser: req.auth, referral: connectedReferral });
                if (refCheck.allowed) {
                    isAuthorized = true;
                } else {
                    denialReason = refCheck.reasonCode;
                }
            }

            // If not authorized by referral, check connected survey authorization
            if (!isAuthorized && connectedSurvey) {
                const hasSurveyPerm = hasOnlineSurveyAccess(req.auth);
                const isAssigned = String(connectedSurvey.assignedUserId) === currentUserId;
                if (hasSurveyPerm && isAssigned) {
                    isAuthorized = true;
                } else if (!hasSurveyPerm) {
                    denialReason = 'SURVEY_ATTACHMENT_PERMISSION_DENIED';
                } else {
                    denialReason = 'SURVEY_ATTACHMENT_NOT_ASSIGNED';
                }
            }
        }

        if (!isAuthorized) {
            if (typeof surveyAuditLogger === 'function') {
                surveyAuditLogger({
                    actorUserId: currentUserId || 'unknown',
                    action: 'ATTACHMENT_ACCESS_DENIED',
                    attachmentId: safeFile,
                    folder: safeFolder,
                    result: 'DENIED',
                    reasonCode: denialReason
                });
            }
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '해당 첨부파일에 접근할 권한이 없습니다.' } });
        }

        // 3. Check existence only after authorization
        if (!fs.existsSync(resolvedPath)) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: '첨부파일을 찾을 수 없습니다.' } });
        }

        const isDownload = req.query.download === 'true' || req.query.download === '1';
        const action = isDownload ? 'ATTACHMENT_DOWNLOADED' : 'ATTACHMENT_VIEWED';
        if (typeof surveyAuditLogger === 'function') {
            surveyAuditLogger({
                actorUserId: currentUserId || 'unknown',
                action,
                attachmentId: safeFile,
                folder: safeFolder,
                linkedReferralId: connectedReferral?.referralId || null,
                linkedSurveyId: connectedSurvey?.submissionId || null,
                result: 'SUCCESS'
            });
        }

        const ext = path.extname(safeFile).toLowerCase();
        const mimeType = ext === '.pdf' ? 'application/pdf'
            : (ext === '.png' ? 'image/png'
            : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'));

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `${isDownload ? 'attachment' : 'inline'}; filename="${encodeURIComponent(safeFile)}"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        fs.createReadStream(resolvedPath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: { code: 'ATTACHMENT_ERROR', message: err.message } });
    }
});

app.post('/api/referrals', requireAuth, async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ success: false, error: "요청 본문이 올바르지 않습니다." });
        }
        if (!req.body.name || !req.body.team) {
            return res.status(400).json({ success: false, error: "이름과 소속팀은 필수 입력 항목입니다." });
        }

        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    console.log(`[API] Returning cached response for idempotency key: ${idempotencyKey}`);
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({
                        success: false,
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload"
                    });
                }
            }
        }

        const referrals = getData('Referrals', []);

        // Reject duplicate client-provided referralId (Point D)
        if (req.body.referralId) {
            const duplicateReferralId = referrals.find(r => r && r.referralId === req.body.referralId);
            if (duplicateReferralId) {
                return res.status(409).json({
                    success: false,
                    code: 'DUPLICATE_REFERRAL_ID',
                    error: '이미 존재하는 의뢰 ID(referralId)입니다.',
                    data: { referralId: duplicateReferralId.referralId, refNo: duplicateReferralId.refNo }
                });
            }
        }

        // Online Survey Link Validation & Guards
        let linkedSubmission = null;
        if (req.body.sourceSubmissionId || req.body.sourceSurveyId) {
            const subId = req.body.sourceSubmissionId;
            const srvId = req.body.sourceSurveyId;

            // 1. Idempotency: Duplicate referral check across all records
            const duplicateReferral = referrals.find(r =>
                r && ((subId && (r.sourceSubmissionId === subId || r.externalIdx === subId)) || (srvId && r.sourceSurveyId === srvId))
            );
            if (duplicateReferral) {
                return res.status(409).json({
                    success: false,
                    code: 'REFERRAL_ALREADY_EXISTS',
                    error: '이미 등록된 온라인 설문 의뢰 건입니다.',
                    data: duplicateReferral
                });
            }

            // 2. Authentication check
            if (!req.auth) {
                return res.status(401).json({
                    success: false,
                    code: 'UNAUTHENTICATED',
                    error: '온라인 설문 기반 의뢰 등록에는 로그인이 필요합니다.'
                });
            }

            if (req.auth.status !== 'active') {
                return res.status(403).json({
                    success: false,
                    code: 'ACCOUNT_INACTIVE',
                    error: '비활성화된 계정은 의뢰를 등록할 수 없습니다.'
                });
            }

            // 2b. Online Survey Permission check
            const userRole = (req.auth.role || req.auth.userRole || 'user').toLowerCase();
            const isAdmin = userRole === 'admin';
            if (!isAdmin && !hasOnlineSurveyAccess(req.auth)) {
                return res.status(403).json({
                    success: false,
                    code: 'FORBIDDEN',
                    error: '온라인 설문 접근 권한이 없습니다.'
                });
            }

            // 3. Survey Repository Existence Check
            linkedSubmission = surveyRepository.findSubmissionById(subId || srvId);
            if (!linkedSubmission) {
                return res.status(400).json({
                    success: false,
                    code: 'SURVEY_NOT_FOUND',
                    error: '유효하지 않은 설문 접수 ID입니다.'
                });
            }

            // 4. Duplicate referral on submission record
            if (linkedSubmission.referralId) {
                return res.status(409).json({
                    success: false,
                    code: 'REFERRAL_ALREADY_EXISTS',
                    error: '이미 의뢰대장이 생성된 설문입니다.'
                });
            }

            // 5. Assignment requirement
            if (!linkedSubmission.assignedUserId || linkedSubmission.assignmentStatus === 'unassigned') {
                return res.status(400).json({
                    success: false,
                    code: 'ASSIGNMENT_REQUIRED',
                    error: '담당자 배정 전에는 의뢰대장을 생성할 수 없습니다.'
                });
            }

            // 6. Assignee authorization: Admin or assigned staff only
            const currentUserId = String(req.auth.id || req.auth.userId || '');
            const isAssigned = String(linkedSubmission.assignedUserId) === currentUserId;

            if (!isAdmin && !isAssigned) {
                if (typeof surveyAuditLogger === 'function') {
                    surveyAuditLogger({
                        actorUserId: currentUserId || 'unknown',
                        targetUserId: linkedSubmission.submissionId,
                        internalSurveyId: linkedSubmission.internalSurveyId,
                        action: 'ONLINE_SURVEY_REFERRAL_CREATE_DENIED',
                        result: 'DENIED',
                        reasonCode: 'NOT_ASSIGNED_STAFF'
                    });
                }
                return res.status(403).json({
                    success: false,
                    code: 'FORBIDDEN',
                    error: '배정된 담당자만 해당 설문의 의뢰대장 등록을 진행할 수 있습니다.'
                });
            }
        }

        if (req.body.notes) {
            const vNotes = validateNotes(req.body.notes);
            if (!vNotes.valid) {
                return res.status(400).json({ success: false, code: 'INVALID_NOTES_LENGTH', error: vNotes.error });
            }
        }

        // BLOCKER-1 fix: the authoritative duplicate checks, refNo allocation (max + 1),
        // record construction and push all run inside the Referrals RMW critical section
        // against the live in-lock ledger state. No value computed before the mutex is
        // reused inside it. The checks above remain only as an early-exit fast path.
        let newReferral;
        try {
            newReferral = await mutateReferrals({
                opType: 'CREATE',
                actorUserId: req.auth?.id || req.auth?.userId || 'system'
            }, async (refs) => {
                // Authoritative duplicate referralId check (latest in-lock state)
                if (req.body.referralId) {
                    const dup = refs.find(r => r && r.referralId === req.body.referralId);
                    if (dup) {
                        const dupErr = new Error('이미 존재하는 의뢰 ID(referralId)입니다.');
                        dupErr.code = 'DUPLICATE_REFERRAL_ID';
                        dupErr.existingReferralId = dup.referralId;
                        dupErr.existingRefNo = dup.refNo;
                        throw dupErr;
                    }
                }

                // Authoritative duplicate check for survey-linked registrations
                if (req.body.sourceSubmissionId || req.body.sourceSurveyId) {
                    const subId = req.body.sourceSubmissionId;
                    const srvId = req.body.sourceSurveyId;
                    const dupSurvey = refs.find(r =>
                        r && ((subId && (r.sourceSubmissionId === subId || r.externalIdx === subId)) || (srvId && r.sourceSurveyId === srvId))
                    );
                    if (dupSurvey) {
                        const dupErr = new Error('이미 등록된 온라인 설문 의뢰 건입니다.');
                        dupErr.code = 'REFERRAL_ALREADY_EXISTS';
                        dupErr.existingRecord = dupSurvey;
                        throw dupErr;
                    }
                }

                // Server-Side Atomic Numbering (inside the critical section)
                // 팀 코드: 기관 설정 → 레거시 TEAM_CODES 맵 → 'ET' (기존 동작과 동일)
                const teamCode = getTeamCodeForRefNo(req.body.team);
                const now = new Date();
                const yearYY = now.getFullYear().toString().slice(-2);
                const prefix = `${teamCode}-${yearYY}-`;

                const existingSeqs = refs
                    .filter(r => r && r.refNo && String(r.refNo).startsWith(prefix))
                    .map(r => {
                        const parts = String(r.refNo).split('-');
                        return parts.length >= 3 ? parseInt(parts[2], 10) : NaN;
                    })
                    .filter(n => !isNaN(n));

                const maxSeq = existingSeqs.length > 0 ? Math.max(...existingSeqs) : 0;
                const assignedRefNo = `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;

                // Ensure immutable referralId
                const referralId = req.body.referralId || crypto.randomUUID();
                const clientId = req.body.clientId || `C${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                const isoNow = now.toISOString();

                // Server-side forced attachment linking: Do not trust client attachments solely
                let referralAttachments = Array.isArray(req.body.attachments) ? [...req.body.attachments] : [];
                if (linkedSubmission && linkedSubmission.attachment) {
                    const surveyAtt = linkedSubmission.attachment;
                    const alreadyExists = referralAttachments.some(a =>
                        a && ((surveyAtt.id && a.id === surveyAtt.id) ||
                              (surveyAtt.url && a.url === surveyAtt.url) ||
                              (surveyAtt.fileHash && a.fileHash === surveyAtt.fileHash))
                    );
                    if (!alreadyExists) {
                        referralAttachments.push({
                            ...surveyAtt,
                            linkedReferralId: referralId,
                            linkedSurveyId: linkedSubmission.internalSurveyId || linkedSubmission.submissionId
                        });
                    }
                }

                const created = {
                    ...req.body,
                    referralId,
                    refNo: assignedRefNo,
                    clientId,
                    version: 1,
                    registrationStatus: req.body.registrationStatus || (req.body.isUnregistered ? '미등록' : '확인중'),
                    createdAt: linkedSubmission ? isoNow : (req.body.createdAt || isoNow),
                    updatedAt: isoNow,
                    attachments: referralAttachments,
                    assignedStaffId: req.body.assignedStaffId || (linkedSubmission ? String(linkedSubmission.assignedUserId) : (req.body.assignedUserId || req.body.assigneeId || null)),
                    linkedSurveyId: linkedSubmission ? (linkedSubmission.internalSurveyId || linkedSubmission.submissionId) : req.body.linkedSurveyId,
                    sourceSubmissionId: linkedSubmission ? linkedSubmission.submissionId : req.body.sourceSubmissionId
                };

                refs.push(created);
                return created;
            });
        } catch (err) {
            if (err && err.code === 'DUPLICATE_REFERRAL_ID') {
                return res.status(409).json({
                    success: false,
                    code: 'DUPLICATE_REFERRAL_ID',
                    error: '이미 존재하는 의뢰 ID(referralId)입니다.',
                    data: { referralId: err.existingReferralId, refNo: err.existingRefNo }
                });
            }
            if (err && err.code === 'REFERRAL_ALREADY_EXISTS') {
                return res.status(409).json({
                    success: false,
                    code: 'REFERRAL_ALREADY_EXISTS',
                    error: '이미 등록된 온라인 설문 의뢰 건입니다.',
                    data: err.existingRecord
                });
            }
            throw err;
        }

        const referralId = newReferral.referralId;
        const assignedRefNo = newReferral.refNo;
        const isoNow = newReferral.updatedAt;

        // Update Survey Record Link & Emit Audit Event
        if (linkedSubmission) {
            try {
                const subId = req.body.sourceSubmissionId || req.body.sourceSurveyId;
                const subs = surveyRepository.getSurveySubmissions();
                const sIdx = subs.findIndex(s => s && (s.submissionId === subId || s.internalSurveyId === subId));
                if (sIdx !== -1) {
                    subs[sIdx].referralId = referralId;
                    subs[sIdx].refNo = assignedRefNo;
                    subs[sIdx].processingStatus = 'COMPLETED';
                    subs[sIdx].consultationStatus = '접수완료';
                    subs[sIdx].registeredAt = isoNow;
                    subs[sIdx].completedAt = isoNow;
                    subs[sIdx].registeredByUserId = req.auth?.id || req.auth?.userId || 'unknown';
                    await surveyRepository.saveSurveySubmissions(subs);
                }

                if (typeof surveyAuditLogger === 'function') {
                    if (linkedSubmission.attachment) {
                        surveyAuditLogger({
                            actorUserId: req.auth?.id || req.auth?.userId || 'unknown',
                            targetUserId: linkedSubmission.submissionId,
                            internalSurveyId: linkedSubmission.internalSurveyId,
                            referralId,
                            refNo: assignedRefNo,
                            attachmentId: linkedSubmission.attachment?.id || null,
                            action: 'REFERRAL_SURVEY_PDF_LINKED',
                            result: 'SUCCESS'
                        });
                    }
                    surveyAuditLogger({
                        actorUserId: req.auth?.id || req.auth?.userId || 'unknown',
                        targetUserId: linkedSubmission.submissionId,
                        internalSurveyId: linkedSubmission.internalSurveyId,
                        referralId,
                        refNo: assignedRefNo,
                        action: 'ONLINE_SURVEY_REFERRAL_CREATED',
                        result: 'SUCCESS'
                    });
                }
            } catch (syncErr) {
                console.error('Failed to synchronize survey submission link on referral creation:', syncErr);
            }
        }

        const responsePayload = { success: true, data: newReferral };
        if (idempotencyKey) {
            cleanIdempotencyStore();
            idempotencyStore.set(idempotencyKey, {
                statusCode: 201,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.status(201).json(responsePayload);
    } catch (err) {
        console.error('❌ POST /api/referrals error:', err);
        res.status(500).json({ success: false, error: `저장 실패: ${err.message}` });
    }
});

const handleReferralUpdate = async (req, res) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    console.log(`[API] Returning cached response for update idempotency key: ${idempotencyKey}`);
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({
                        success: false,
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload"
                    });
                }
            }
        }

        const referral = req.body;
        if (!referral || typeof referral !== 'object') {
            return res.status(400).json({ success: false, error: "요청 본문이 올바르지 않습니다." });
        }

        // B3: 성명 빈 문자열/공백 가드
        if (referral.name !== undefined && (typeof referral.name !== 'string' || !referral.name.trim())) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_NAME',
                error: "성명을 입력해야 합니다."
            });
        }

        const targetId = req.params.id || referral.referralId || referral.refNo || referral.clientId;
        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing identifier (referralId or refNo)" });
        }

        if (req.params.id && referral.referralId && req.params.id !== referral.referralId) {
            return res.status(400).json({
                success: false,
                code: 'REFERRAL_ID_CHANGE_NOT_ALLOWED',
                error: "URL의 식별자와 본문의 referralId가 일치하지 않습니다."
            });
        }

        const referrals = getData('Referrals', []);

        // F3 Identification: If referralId is present (body or param matching referralId), match ONLY by referralId.
        const isReferralIdTarget = referral.referralId || (req.params.id && referrals.some(r => r && r.referralId === req.params.id));
        let index = -1;

        if (isReferralIdTarget) {
            const targetRefId = req.params.id || referral.referralId;
            index = referrals.findIndex(r => r && r.referralId === targetRefId);
            if (index === -1) {
                return res.status(404).json({ success: false, error: "Referral not found by referralId" });
            }
        } else {
            // Fallback: refNo -> clientId
            const fallbackRefNo = referral.refNo || req.params.id;
            if (fallbackRefNo) {
                const matches = referrals
                    .map((r, i) => ({ r, i }))
                    .filter(item => item.r && item.r.refNo === fallbackRefNo);
                if (matches.length > 1) {
                    return res.status(409).json({
                        success: false,
                        code: 'AMBIGUOUS_RECORD',
                        error: `동일 의뢰번호(${fallbackRefNo})를 가진 레코드가 ${matches.length}건 존재합니다. referralId를 지정해야 합니다.`
                    });
                } else if (matches.length === 1) {
                    index = matches[0].i;
                }
            }

            if (index === -1) {
                const fallbackClientId = referral.clientId || req.params.id;
                if (fallbackClientId) {
                    const matches = referrals
                        .map((r, i) => ({ r, i }))
                        .filter(item => item.r && item.r.clientId === fallbackClientId);
                    if (matches.length > 1) {
                        return res.status(409).json({
                            success: false,
                            code: 'AMBIGUOUS_RECORD',
                            error: `동일 clientId(${fallbackClientId})를 가진 레코드가 ${matches.length}건 존재합니다. referralId를 지정해야 합니다.`
                        });
                    } else if (matches.length === 1) {
                        index = matches[0].i;
                    }
                }
            }

            if (index === -1) {
                return res.status(404).json({ success: false, error: "Referral not found" });
            }
        }

        const currentRecord = referrals[index];

        // F3 Immutability Guard: identifiers must not change (uniform explicit 400 contract)
        for (const { key, code } of IMMUTABLE_IDENTIFIERS) {
            if (Object.prototype.hasOwnProperty.call(referral, key) &&
                !isSameIdentifierValue(referral[key], currentRecord[key])) {
                return res.status(400).json({
                    success: false,
                    code,
                    error: `${key}는 변경할 수 없습니다.`
                });
            }
        }

        // F6: Notes length validation before save
        if (referral.notes) {
            const vNotes = validateNotes(referral.notes);
            if (!vNotes.valid) {
                return res.status(400).json({
                    success: false,
                    code: 'INVALID_NOTES_LENGTH',
                    error: vNotes.error
                });
            }
        }

        // Optimistic Concurrency Control check
        if (referral.version !== undefined && currentRecord.version !== undefined) {
            const reqVer = Number(referral.version);
            const curVer = Number(currentRecord.version);
            if (reqVer !== curVer) {
                const isConsecutiveSave = (curVer - reqVer === 1);
                if (isConsecutiveSave) {
                    console.warn(`[OCC] Consecutive save detected for ${currentRecord.refNo || targetId} (reqVer: ${reqVer}, curVer: ${curVer}). Auto-resolving with merge.`);
                } else {
                    return res.status(409).json({
                        success: false,
                        code: 'VERSION_CONFLICT',
                        error: "다른 사용자에 의해 데이터가 변경되었습니다. 최신 정보를 불러온 후 다시 시도해주세요.",
                        currentVersion: currentRecord.version,
                        latestUpdatedAt: currentRecord.updatedAt
                    });
                }
            }
        }

        const nextVersion = (currentRecord.version || 1) + 1;

        // F3: Merge ONLY allowed fields from allowlist
        const updatedReferral = { ...currentRecord };
        for (const [key, val] of Object.entries(referral)) {
            if (REFERRAL_ALLOWLIST.has(key)) {
                updatedReferral[key] = val;
            }
        }

        // Immutable identity and system fields
        updatedReferral.referralId = currentRecord.referralId;
        updatedReferral.refNo = currentRecord.refNo;
        updatedReferral.clientId = currentRecord.clientId;
        updatedReferral.createdAt = currentRecord.createdAt;
        updatedReferral.sourceSubmissionId = currentRecord.sourceSubmissionId;
        updatedReferral.sourceSurveyId = currentRecord.sourceSurveyId;
        updatedReferral.externalIdx = currentRecord.externalIdx;
        updatedReferral.externalReferralId = currentRecord.externalReferralId;
        updatedReferral.version = nextVersion;
        updatedReferral.updatedAt = new Date().toISOString();

        await mutateReferrals({
            opType: 'UPDATE',
            targetId: currentRecord.referralId,
            actorUserId: req.auth?.id || req.auth?.userId || 'system'
        }, async (refs) => {
            refs[index] = updatedReferral;
        });

        const responsePayload = { success: true, data: updatedReferral };
        if (idempotencyKey) {
            cleanIdempotencyStore();
            idempotencyStore.set(idempotencyKey, {
                statusCode: 200,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.json(responsePayload);
    } catch (err) {
        console.error('❌ PUT /api/referrals error:', err);
        if (err.code === 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
            return res.status(500).json({ success: false, code: err.code, error: err.message });
        }
        res.status(500).json({ success: false, error: `수정 실패: ${err.message}` });
    }
};

app.put('/api/referrals', requireAuth, handleReferralUpdate);
app.put('/api/referrals/:id', requireAuth, handleReferralUpdate);

const handleReferralDelete = async (req, res) => {
    try {
        const targetId = req.params.id || req.params.refNo || req.body?.referralId || req.body?.refNo;
        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing referral identifier" });
        }

        const referrals = getData('Referrals', []);

        // F7 Strict Identification: exact referralId first
        let index = referrals.findIndex(r => r && r.referralId === targetId);

        // Fallback only if no referralId matches
        if (index === -1) {
            const matches = referrals
                .map((r, i) => ({ r, i }))
                .filter(item => item.r && (item.r.refNo === targetId || item.r.clientId === targetId));

            if (matches.length > 1) {
                return res.status(409).json({
                    success: false,
                    code: 'AMBIGUOUS_RECORD',
                    error: `동일 식별자에 해당하는 레코드가 ${matches.length}건 존재합니다. 고유한 referralId로 삭제를 요청하세요.`
                });
            } else if (matches.length === 1) {
                index = matches[0].i;
            }
        }

        if (index === -1) {
            return res.json({ success: true, alreadyDeleted: true });
        }

        const deletedItem = referrals[index];
        const actorUserId = req.auth?.id || req.auth?.userId || 'unknown';

        // F2 Two-phase atomicity:
        // Phase 1: Persist to Trash first
        const trash = getData('Trash', []);
        const trashSnapshot = JSON.parse(JSON.stringify(trash));
        const trashItem = { ...deletedItem, _trashSource: 'Referrals', deletedAt: new Date().toISOString() };
        trash.push(trashItem);

        try {
            await persistData('Trash', trash);
        } catch (trashErr) {
            restoreCacheInPlace(trash, trashSnapshot);
            console.error('❌ Failed to persist to Trash in DELETE /api/referrals:', trashErr);
            return res.status(500).json({ success: false, error: `휴지통 보관 실패: ${trashErr.message}` });
        }

        // Phase 2: Once Trash persist succeeds, remove from Referrals via mutateReferrals
        try {
            await mutateReferrals({
                opType: 'DELETE',
                expectedRemovalIds: [deletedItem.referralId],
                actorUserId
            }, async (refs) => {
                const idx = refs.findIndex(r => r && r.referralId === deletedItem.referralId);
                if (idx !== -1) {
                    refs.splice(idx, 1);
                }
            });
        } catch (refErr) {
            // Referrals persist failed: Rollback Trash (remove added item and re-persist), restore cache, 500
            restoreCacheInPlace(trash, trashSnapshot);
            try {
                await persistData('Trash', trash);
            } catch (trashRollbackErr) {
                console.error('CRITICAL: Trash rollback failed after Referrals persist failure:', trashRollbackErr);
            }
            console.error('❌ Failed to persist Referrals deletion:', refErr);
            if (refErr.code === 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
                return res.status(500).json({ success: false, code: refErr.code, error: refErr.message });
            }
            return res.status(500).json({ success: false, error: `대장 삭제 실패: ${refErr.message}` });
        }

        // Audit log (PII prohibited, stable referralId only)
        await referralAuditLogger({
            actorUserId,
            targetId: deletedItem.referralId,
            action: 'REFERRAL_DELETE',
            result: 'SUCCESS'
        });

        res.json({
            success: true,
            deletedRefNo: deletedItem.refNo,
            referralId: deletedItem.referralId
        });
    } catch (err) {
        console.error('❌ DELETE /api/referrals error:', err);
        res.status(500).json({ success: false, error: `삭제 실패: ${err.message}` });
    }
};

app.delete('/api/referrals/:refNo', requireAuth, requireAdmin, handleReferralDelete);
app.delete('/api/referrals', requireAuth, requireAdmin, handleReferralDelete);

// SUICIDE ATTEMPTERS
app.get('/api/suicideattempters', requireAuth, (req, res) => {
    res.json(getData('SuicideAttempters', []));
});

app.post('/api/suicideattempters', requireAuth, (req, res) => {
    const sa = req.body;
    const records = getData('SuicideAttempters', []);
    records.push(sa);
    saveData('SuicideAttempters', records);
    res.json({ success: true });
});

// ISP ACHIEVEMENT CACHE
const ispAchievementCache = new Map();

function clearIspAchievementCache() {
    console.log('[CACHE] Clearing ISP Achievement Cache');
    ispAchievementCache.clear();
}


function parseCountValue(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (value === '-') return 0;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

const CATEGORY_LABEL_MAP = {
    individual: '개별상담',
    resource: '자원조정',
    '개별상담': '개별상담',
    '자원조정': '자원조정'
};

const COUNSELING_TYPE_LABEL_MAP = {
    inOffice: '내소',
    visit: '방문',
    phone: '전화',
    online: '온라인',
    내소: '내소',
    방문: '방문',
    전화: '전화',
    온라인: '온라인'
};

function normalizeKey(value) {
    return String(value ?? '').trim();
}

function getSessionCategory(session) {
    const raw = normalizeKey(
        session?.category ??
        session?.majorCategory ??
        session?.mainCategory ??
        session?.대분류 ??
        session?.구분
    );
    return CATEGORY_LABEL_MAP[raw] || raw;
}

function getSessionType(session) {
    const raw = normalizeKey(
        session?.type ??
        session?.subCategory ??
        session?.subType ??
        session?.소분류 ??
        session?.label
    );
    return COUNSELING_TYPE_LABEL_MAP[raw] || raw;
}

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, '').replace(/[()]/g, '');
}

function getMajorCategory(row) {
    return normalizeText(
        row?.majorCategory ??
        row?.mainCategory ??
        row?.category ??
        row?.group ??
        row?.대분류 ??
        row?.구분
    );
}

function getSubCategory(row) {
    return normalizeText(
        row?.subCategory ??
        row?.subType ??
        row?.type ??
        row?.label ??
        row?.name ??
        row?.소분류 ??
        row?.상세구분
    );
}

function getMonthlyValueFromRow(row, month) {
    const candidates = [
        row?.monthly?.[month],
        row?.monthly?.[month - 1],
        row?.months?.[month - 1],
        row?.monthlyData?.[month - 1],
        row?.[`month${month}`],
        row?.[`m${month}`],
        row?.[`${month}월`],
        row?.[String(month)]
    ];
    for (const value of candidates) {
        if (value !== undefined && value !== null && value !== '') return parseCountValue(value);
    }
    return 0;
}

function getAnalysisVersion(analysisData) {
    if (!analysisData) return 'empty';
    return analysisData.savedAt || `${analysisData.memberPerformance?.length || 0}-${analysisData.ispPlans?.length || 0}`;
}

function evaluateIspAchievement(actualCount, targetCount, month, year) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const isFuture = (year > currentYear) || (year === currentYear && month > currentMonth);
    const isCurrent = (year === currentYear && month === currentMonth);

    if (isFuture) {
        return { status: 'future', label: '평가전', isFuture: true, isCurrent: false };
    }

    if (isCurrent) {
        // 현재월: 목표 달성시 달성(진행중), 미달시 진행중
        return {
            status: actualCount >= targetCount && targetCount > 0 ? 'success' : 'inprogress',
            label: actualCount >= targetCount && targetCount > 0 ? '달성(진행중)' : '진행중',
            isFuture: false,
            isCurrent: true
        };
    }

    // 과거월
    if (targetCount === 0) {
        return { status: 'not_evaluated', label: '미평가', isFuture: false, isCurrent: false };
    }

    if (actualCount >= targetCount) {
        return { status: 'success', label: '달성', isFuture: false, isCurrent: false };
    } else {
        return { status: 'fail', label: '미달', isFuture: false, isCurrent: false };
    }
}

function isIndividualCounselingRow(row) {
    const category = getSessionCategory(row);
    const type = getSessionType(row);
    if (category.includes('ISP') || type.includes('ISP')) return false;
    if (category.includes('기록') || type.includes('기록')) return false;

    const isMajor = category === '개별상담';
    const isSub = ['내소', '방문', '전화', '온라인'].includes(type);
    return isMajor && isSub;
}

function isResourceCoordinationRow(row) {
    const category = getSessionCategory(row);
    if (category.includes('ISP')) return false;
    return category === '자원조정';
}

function calculateInterventionActualForMemberMonth(member, month) {
    // 1. Try detailedSessions (granular data)
    const sessions = member.detailedSessions || [];
    let count = 0;
    let foundInSessions = false;

    sessions.forEach(s => {
        if (Number(s.month) !== month) return;
        if (isIndividualCounselingRow(s) || isResourceCoordinationRow(s)) {
            count += (s.value !== undefined && s.value !== null && s.value !== '') ? parseCountValue(s.value) : 1;
            foundInSessions = true;
        }
    });

    if (foundInSessions) return count;

    // 2. Fallback to performanceRows (aggregated data) if sessions are empty
    const performanceRows = member.performanceRows || member.children || member.rows || member.details || [];
    let fallbackCount = 0;
    performanceRows.forEach(row => {
        if (isIndividualCounselingRow(row) || isResourceCoordinationRow(row)) {
            fallbackCount += getMonthlyValueFromRow(row, month);
        }
    });

    return fallbackCount;
}

// ISP ACHIEVEMENT YEARLY ANALYTICS
app.get('/api/analysis/isp-achievement-yearly', requireAuth, (req, res) => {
    const startTotal = performance.now();
    const { year, detailLevel = 'summary' } = req.query;

    if (!year) return res.status(400).json({ success: false, error: "Year is required (YYYY)" });

    const targetYear = parseInt(year);
    const analysisBlob = getData('GlobalCaseAnalysis', null);

    if (!analysisBlob || (!analysisBlob.memberPerformance && !analysisBlob.data)) {
        return res.json({ success: true, data: {} });
    }

    const analysisData = analysisBlob.memberPerformance ? analysisBlob : analysisBlob.data;
    const version = getAnalysisVersion(analysisData);
    const cacheKey = `isp-yearly:${year}:${version}:${detailLevel}:${ISP_POLICY_VERSION}`;

    // --- CACHE HIT ---
    if (ispAchievementCache.has(cacheKey)) {
        const cached = ispAchievementCache.get(cacheKey);
        return res.json({
            ...cached,
            diagnostics: {
                ...cached.diagnostics,
                cache: { hit: true }
            }
        });
    }

    const { memberPerformance, ispPlans } = analysisData;
    const tPrepStart = performance.now();

    // 1. Pre-indexing
    const ispByRegNo = {};
    const ispByName = {};
    (ispPlans || []).forEach(plan => {
        const regKey = normalizeMemberRegistrationNo(plan.registrationNo);
        const nameKey = normalizePersonName(plan.memberName);
        if (regKey) {
            if (!ispByRegNo[regKey]) ispByRegNo[regKey] = [];
            ispByRegNo[regKey].push(plan);
        }
        if (nameKey) {
            if (!ispByName[nameKey]) ispByName[nameKey] = [];
            ispByName[nameKey].push(plan);
        }
    });

    const membersByName = {};
    const regNoCounts = {};

    memberPerformance.forEach(m => {
        const nameKey = normalizePersonName(m.memberName);
        if (nameKey) {
            if (!membersByName[nameKey]) membersByName[nameKey] = [];
            membersByName[nameKey].push(m);
        }

        const reg = normalizeRegistrationNo(m.registrationNo);
        if (reg) {
            regNoCounts[reg] = (regNoCounts[reg] || 0) + 1;
        }
    });

    const duplicateRegistrationNoCounts = {};
    Object.entries(regNoCounts).forEach(([reg, count]) => {
        if (count > 1) duplicateRegistrationNoCounts[reg] = count;
    });

    const result = {};
    const membersList = [];

    memberPerformance.forEach((member, index) => {
        const evaluationKey = buildMemberEvaluationKey(member);
        const normRegNo = normalizeMemberRegistrationNo(member.registrationNo);
        const normMemberName = normalizePersonName(member.memberName);

        let matchedIspPlans = [];
        let matchStatus = 'NOT_MATCHED';
        let matchMethod = 'NONE';
        let matchReason = '';

        if (normRegNo && ispByRegNo[normRegNo] && !duplicateRegistrationNoCounts[normRegNo]) {
            matchedIspPlans = ispByRegNo[normRegNo];
            matchStatus = 'MATCHED';
            matchMethod = 'NORMALIZED_MEMBER_REGISTRATION_NO';
            matchReason = 'MATCHED_BY_NORMALIZED_MEMBER_REGISTRATION_NO';
        } else if (normMemberName && ispByName[normMemberName]) {
            const sameNameRows = ispByName[normMemberName];
            const masterCount = (membersByName[normMemberName] || []).length;

            if (masterCount > 1) {
                matchStatus = 'AMBIGUOUS';
                matchReason = 'MULTIPLE_MASTER_MEMBERS_WITH_SAME_NAME';
            } else {
                matchedIspPlans = sameNameRows;
                matchStatus = 'MATCHED';
                matchMethod = 'EXACT_NAME_UNIQUE_HISTORY';
                matchReason = 'MATCHED_BY_EXACT_NAME_UNIQUE_HISTORY_FALLBACK';
            }
        } else if (normRegNo && ispByRegNo[normRegNo] && duplicateRegistrationNoCounts[normRegNo]) {
            matchStatus = 'DUPLICATE_REG_BLOCKED';
            matchReason = 'DUPLICATE_REGISTRATION_NO';
        }

        const monthlyItems = [];
        const effectiveSegments = [];

        if (matchStatus === 'MATCHED' && matchedIspPlans.length > 0) {
            const sortedPlans = [...matchedIspPlans].sort((a, b) => (a.establishedDate || '').localeCompare(b.establishedDate || ''));
            const preYearPlans = sortedPlans.filter(p => p.establishedDate && p.establishedDate < `${targetYear}-01-01`);
            if (preYearPlans.length > 0) {
                effectiveSegments.push({ startDate: `${targetYear}-01-01`, plan: preYearPlans[preYearPlans.length - 1] });
            }
            sortedPlans.filter(p => p.establishedDate && p.establishedDate.startsWith(String(targetYear))).forEach(plan => {
                effectiveSegments.push({ startDate: plan.establishedDate, plan: plan });
            });
        }

        for (let m = 1; m <= 12; m++) {
            const monthStr = `${year}-${String(m).padStart(2, '0')}`;
            const daysInMonth = new Date(targetYear, m, 0).getDate();
            const monthStart = `${monthStr}-01`;
            const monthEnd = `${monthStr}-${daysInMonth}`;

            const applicableSegments = effectiveSegments.filter(seg => {
                const idx = effectiveSegments.indexOf(seg);
                const nextSeg = effectiveSegments[idx + 1];
                const segEnd = nextSeg ? nextSeg.startDate : '9999-12-31';
                return seg.startDate <= monthEnd && segEnd > monthStart;
            });

            let totalTarget = 0;
            let managementTypeSummary = "";
            const mergedSegmentsList = [];

            const mergeMap = new Map();
            applicableSegments.forEach(seg => {
                const idx = effectiveSegments.indexOf(seg);
                const nextSeg = effectiveSegments[idx + 1];
                const actualStart = seg.startDate < monthStart ? monthStart : seg.startDate;
                const actualEnd = (nextSeg && nextSeg.startDate <= monthEnd) ?
                    new Date(new Date(nextSeg.startDate).getTime() - 86400000).toISOString().split('T')[0] : monthEnd;

                const overlapDays = (new Date(actualEnd) - new Date(actualStart)) / 86400000 + 1;
                if (overlapDays > 0) {
                    const type = seg.plan.managementCategory || '유지관리';
                    if (!mergeMap.has(type)) mergeMap.set(type, { days: 0 });
                    const entry = mergeMap.get(type);
                    entry.days += overlapDays;
                }
            });

            mergeMap.forEach((data, type) => {
                const { days } = data;
                let segTarget = 0;
                const catShort = type.substring(0, 2);
                if (type.includes('집중')) segTarget = Math.ceil(days / 7);
                else if (type.includes('유지') || type.includes('단기')) segTarget = days >= 1 ? 1 : 0;

                totalTarget += segTarget;
                managementTypeSummary += (managementTypeSummary ? ' / ' : '') + `${catShort} ${Math.round(days)}일`;

                if (detailLevel !== 'summary') {
                    mergedSegmentsList.push({
                        managementType: type,
                        days: Math.round(days),
                        target: segTarget
                    });
                }
            });

            const actualCount = calculateInterventionActualForMemberMonth(member, m);
            const evaluation = evaluateIspAchievement(actualCount, totalTarget, m, targetYear);

            const monthItem = {
                month: m,
                managementTypeSummary: managementTypeSummary || "-",
                targetCount: totalTarget,
                actualCount: actualCount,
                evaluationLabel: evaluation.label,
                evaluationResult: evaluation.status.toUpperCase(),
                isFutureMonth: evaluation.isFuture,
                isCurrentMonth: evaluation.isCurrent
            };

            if (detailLevel === 'summary') {
                monthlyItems.push(monthItem);
            } else {
                // For detailed, we might want to calculate breakdown here
                const breakdown = { inOffice: 0, visit: 0, phone: 0, online: 0 };
                (member.detailedSessions || []).forEach(s => {
                    if (Number(s.month) === m && (isIndividualCounselingRow(s) || isResourceCoordinationRow(s))) {
                        const type = String(s.type || '').trim();
                        if (type === '내소' || type.includes('office')) breakdown.inOffice++;
                        else if (type === '방문' || type.includes('visit')) breakdown.visit++;
                        else if (type === '전화' || type.includes('phone')) breakdown.phone++;
                        else if (type === '온라인' || type.includes('online')) breakdown.online++;
                    }
                });

                monthlyItems.push({
                    ...monthItem,
                    actualCountBreakdown: breakdown,
                    mergedSegments: mergedSegmentsList
                });
            }
        }

        const memberResult = {
            memberEvaluationKey: evaluationKey,
            sourceIndex: index,
            memberName: member.memberName,
            registrationNo: member.registrationNo,
            normalizedMemberName: normMemberName,
            normalizedMemberRegistrationNo: normRegNo,
            ispMatched: matchStatus === 'MATCHED',
            ispMatchStatus: matchStatus,
            ispMatchMethod: matchMethod,
            ispMatchReason: matchReason,
            monthly: monthlyItems
        };

        result[evaluationKey] = memberResult;
        membersList.push(memberResult);
    });

    const tEnd = performance.now();
    const response = {
        success: true,
        year: targetYear,
        detailLevel,
        data: result,
        members: membersList,
        diagnostics: {
            computeMs: (tEnd - tPrepStart).toFixed(2),
            totalMs: (tEnd - startTotal).toFixed(2),
            policy: ISP_POLICY_VERSION,
            duplicateRegistrationNoCounts,
            cache: { hit: false }
        }
    };

    ispAchievementCache.set(cacheKey, response);
    res.json(response);
});

// CASE ANALYSIS STATE
app.get('/api/analysis/current', requireAuth, (req, res) => {
    try {
        let data = getData('GlobalCaseAnalysis', null);
        if (!data) return res.json({ success: true, data: null });

        const reqUserId = req.headers['x-user-id'] || req.query.userId;
        const reqUserRole = req.headers['x-user-role'] || req.query.userRole;
        let reqUserTeam = req.headers['x-user-team'] || req.query.userTeam;
        if (reqUserTeam) {
            try { reqUserTeam = decodeURIComponent(reqUserTeam); } catch {}
        }

        const users = getData('Users', []);
        const user = users.find(u => u.id === reqUserId || u.username === reqUserId);
        const role = user?.role || reqUserRole || 'user';
        const userTeam = user?.team || reqUserTeam;

        if (role === 'user' && userTeam) {
            const teamMap = {
                '자살예방센터': ['자살팀', '자살예방센터'],
                '증진팀': ['증진팀'],
                '회복팀': ['회복팀'],
                '남부분소': ['남부분소'],
                '아동청소년': ['아동청소년', '아청팀']
            };
            const allowedDepts = teamMap[userTeam] || [userTeam];
            const counselorPerf = Array.isArray(data.counselorPerformance) ? data.counselorPerformance : [];
            const filteredCounselors = counselorPerf.filter(c => allowedDepts.includes(c.department));
            const allowedCounselorNames = new Set(filteredCounselors.map(c => c.counselorName));

            const filteredMemberPerf = Array.isArray(data.memberPerformance)
                ? data.memberPerformance.filter(m => allowedCounselorNames.has(m.counselorName) || allowedCounselorNames.has(m.mainCounselor) || allowedCounselorNames.has(m.registrant))
                : [];

            const filteredISP = Array.isArray(data.ispExpiringMembers)
                ? data.ispExpiringMembers.filter(m => allowedCounselorNames.has(m.counselorName) || allowedCounselorNames.has(m.mainCounselor) || allowedCounselorNames.has(m.registrant))
                : [];

            data = {
                ...data,
                counselorPerformance: filteredCounselors,
                memberPerformance: filteredMemberPerf,
                ispExpiringMembers: filteredISP
            };
        }

        res.json({ success: true, data });
    } catch (err) {
        console.error('❌ GET /api/analysis/current error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/analysis/current', requireAuth, (req, res) => {
    saveData('GlobalCaseAnalysis', req.body.data);
    clearIspAchievementCache();
    res.json({ success: true });
});

// Helper to identify genuine website referrals and strictly exclude online surveys and voice calls
function isWebsiteReferralItem(item) {
    if (!item) return false;
    // Strictly exclude online survey items
    if (item.source === 'online_survey') return false;
    if (item.surveySubmissionId || item.submissionId || item.sourceSurveyId || item.sourceSubmissionId) return false;
    if (item.referralPath === '온라인설문' || item.requestAgency === '온라인 자가검진') return false;

    // Strictly exclude voice calls
    if (item.source === 'voice_call' || item.source === 'voiceCalls' || item.voiceCallId || item.referralPath === '음성통화') return false;

    // Strictly exclude quarantined items
    if (item.isSbqrQuarantined || item.quarantinedAt) return false;

    // Explicit website source check (fail-closed against unknown/missing sources; externalIdx alone does NOT classify as website)
    const isExplicitWebSource = item.source === 'website' || item.source === 'homepage' || item.source === 'web' || item.sourceType === 'website' || item.sourceType === 'homepage';
    const isExplicitWebPath = item.referralPath === '홈페이지' || item.referralPath === '홈페이지 의뢰' || item.referralPath === '홈페이지 상담신청' || item.requestAgency === '홈페이지';
    const isExplicitWebFlag = item.isWebsiteReferral === true;

    return isExplicitWebSource || isExplicitWebPath || isExplicitWebFlag;
}

// PENDING REFERRALS (Scraper Sync - Website Referrals Only)
app.get('/api/pending-referrals', requireAuth, (req, res) => {
    const referrals = getData('Referrals', []);
    let allPending = getData('PendingReferrals', []);
    const normalizePhone = (num) => num ? String(num).replace(/[^0-9]/g, '') : '';

    // Filter out scanner probes / spam
    allPending = allPending.filter(p => !/sparrow|dast|<script|alert\(/i.test(`${p.name} ${p.phone} ${p.problem} ${p.reason}`));

    const beforeCount = allPending.length;
    allPending = allPending.filter(p => {
        // Only prune registered website referrals from PendingReferrals; preserve non-website items (e.g. survey/voice) untouched
        if (!isWebsiteReferralItem(p)) return true;

        const isRegistered = referrals.some(r => {
            const nameMatch = r.name && p.name && r.name.trim() === p.name.trim();
            if (!nameMatch) return false;

            const rPhone = normalizePhone(r.phone);
            const pPhone = normalizePhone(p.phone);
            if (rPhone && pPhone && rPhone === pPhone) return true;

            if (r.birthDate && p.birthDate && r.birthDate.trim() === p.birthDate.trim()) return true;

            return false;
        });
        return !isRegistered;
    });

    if (allPending.length !== beforeCount) {
        saveData('PendingReferrals', allPending);
    }

    // Return ONLY website referrals to caller (0 surveys, 0 voice calls)
    const websiteList = allPending.filter(p => isWebsiteReferralItem(p));
    res.json(websiteList);
});

// 스크레이퍼 상태 진단 API
app.get('/api/pending-referrals/status', requireAuth, (req, res) => {
    const list = getData('PendingReferrals', []);
    const filePath = path.join(DATA_DIR, 'PendingReferrals.json');
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    const latest = list.reduce((a, b) =>
        (a.createdAt || '') > (b.createdAt || '') ? a : b, {});
    const ageMs = stat ? Date.now() - new Date(stat.mtime).getTime() : Infinity;
    const ageDays = ageMs / 86400000;
    const scraperLagging = ageDays > 1;
    if (scraperLagging) {
        console.warn(`⚠️ [SCRAPER] PendingReferrals.json이 ${ageDays.toFixed(1)}일째 미갱신.`);
    }
    res.json({
        total: list.length,
        pending: list.filter(r => r.status === 'pending').length,
        lastFileModified: stat ? stat.mtime : null,
        latestCreatedAt: latest.createdAt || null,
        ageHours: Math.round(ageMs / 3600000),
        scraperLagging
    });
});

app.post('/api/pending-referrals', requireAuth, (req, res) => {
    const list = getData('PendingReferrals', []);
    list.push(req.body);
    saveData('PendingReferrals', list);
    res.json({ success: true });
});

// [P0] POST /_diag 제거됨 — 무인증 디스크 쓰기 디버그 잔재 (REMOVE)

app.get('/api/health/storage', requireAdmin, (req, res) => {
    try {
        const files = ['Referrals', 'BudgetPlans', 'BudgetTransactions', 'SuicideAttempters', 'Users', 'Trash'];
        const stats = files.map(filename => {
            const filePath = path.join(DATA_DIR, `${filename}.json`);
            let fileInfo = { filename, exists: false, size: 0, lastModified: null, recordCount: 0 };

            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                fileInfo.exists = true;
                fileInfo.size = stat.size;
                fileInfo.lastModified = stat.mtime;

                // Get record count from memory cache if available, else 0
                const data = memoryCache[filename];
                if (Array.isArray(data)) {
                    fileInfo.recordCount = data.length;
                } else if (data && typeof data === 'object') {
                    fileInfo.recordCount = Object.keys(data).length;
                }
            }
            return fileInfo;
        });

        res.json({
            success: true,
            dataDir: DATA_DIR,
            attachmentsDir: ATTACHMENTS_DIR,
            stats
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/users/import', requireAdmin, (req, res) => {
    try {
        const parsedData = req.body;
        if (!Array.isArray(parsedData)) {
            return res.status(400).json({ success: false, error: "Invalid data format. Expected an array of users." });
        }

        const users = getData('Users', []);
        let updatedCount = 0;
        let createdCount = 0;

        parsedData.forEach((newUser) => {
            if (!newUser.id) return;
            // [P0] role 화이트리스트 검증 — import 경로로 관리자 권한 상승 방지
            let role = newUser.role;
            if (role && !ALLOWED_USER_ROLES.includes(role)) return; // 유효하지 않은 role은 해당 레코드 skip
            const index = users.findIndex(u => u.id === newUser.id);
            if (index !== -1) {
                users[index] = { ...users[index], ...newUser, ...(role ? { role } : {}) };
                updatedCount++;
            } else {
                users.push({
                    ...newUser,
                    createdDate: newUser.createdDate || new Date().toISOString().split('T')[0],
                    status: newUser.status || 'active',
                    role: role || 'user',
                    team: newUser.team || '증진팀'
                });
                createdCount++;
            }
        });

        saveData('Users', users);
        console.log(`📥 [Import] Users imported: ${createdCount} created, ${updatedCount} updated.`);
        res.json({
            success: true,
            message: `엑셀 데이터 가져오기 완료: 신규 ${createdCount}명 추가, 기존 ${updatedCount}명 업데이트되었습니다.`
        });
    } catch (e) {
        console.error('❌ User import error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

// [P0-D5] body.adminId를 신뢰하지 않음. requireAdmin이 세션의 req.auth만 검증한다.
// FE가 adminId를 계속 보내도 무시된다 (회귀 없음).
app.post('/api/users/reset-password', requireAdmin, (req, res) => {
    const { targetId, newPassword } = req.body || {};
    const users = getData('Users', []);

    const userIndex = users.findIndex(u => u.id === targetId);
    if (userIndex === -1) {
        return res.status(404).json({ success: false, error: "Target user not found" });
    }

    users[userIndex].password = newPassword;
    saveData('Users', users);
    res.json({ success: true, message: "Password reset successful" });
});

// [P0-D4] 세션 바인딩: 본인 또는 관리자만 변경 가능. 비밀번호 평문 로그 제거됨.
app.post('/api/users/change-password', requireAuth, (req, res) => {
    const { userId, oldPassword, newPassword } = req.body || {};

    const requester = req.auth || {};
    const isSelf = String(userId) === String(requester.id);
    const isAdmin = requester.role === 'admin';
    if (!isSelf && !isAdmin) {
        return res.status(403).json({ success: false, error: "본인 또는 관리자만 비밀번호를 변경할 수 있습니다." });
    }

    // Force reload data to ensure freshness
    const users = getData('Users', []);
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
        return res.status(404).json({ success: false, error: "User not found" });
    }

    const currentUser = users[userIndex];

    if (String(currentUser.password) !== String(oldPassword)) {
        return res.status(400).json({ success: false, error: "Current password does not match" });
    }

    users[userIndex].password = newPassword;
    const saveSuccess = saveData('Users', users);

    if (saveSuccess) {
        res.json({ success: true, message: "Password changed successful" });
    } else {
        res.status(500).json({ success: false, error: "Failed to save new password to database" });
    }
});

app.post('/api/referrals/bulk-delete', requireAuth, requireAdmin, async (req, res) => {
    try {
        const userRole = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
        if (userRole !== 'admin') {
            return res.status(403).json({
                success: false,
                code: 'FORBIDDEN',
                error: "관리자만 일괄 삭제를 수행할 수 있습니다."
            });
        }

        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.json({ success: true, message: "No IDs provided", deletedCount: 0 });
        }

        const referrals = getData('Referrals', []);

        // F4 Match priority: referralId first, then refNo, then clientId
        const itemsToDelete = referrals.filter(r =>
            r && (ids.includes(r.referralId) || ids.includes(r.refNo) || ids.includes(r.clientId))
        );

        if (itemsToDelete.length === 0) {
            return res.json({ success: true, deletedCount: 0, movedToTrash: true });
        }

        const expectedRemovalIds = itemsToDelete.map(r => r.referralId);
        const actorUserId = req.auth?.id || req.auth?.userId || 'unknown';

        // Phase 1: Add to Trash and persist Trash first
        const trash = getData('Trash', []);
        const trashSnapshot = JSON.parse(JSON.stringify(trash));
        const nowIso = new Date().toISOString();

        itemsToDelete.forEach(item => {
            trash.push({
                ...item,
                _trashSource: 'Referrals',
                deletedAt: nowIso
            });
        });

        try {
            await persistData('Trash', trash);
        } catch (trashErr) {
            restoreCacheInPlace(trash, trashSnapshot);
            console.error('❌ Failed to persist to Trash in bulk-delete:', trashErr);
            return res.status(500).json({ success: false, error: `휴지통 보관 실패: ${trashErr.message}` });
        }

        // Phase 2: Remove from Referrals via mutateReferrals
        try {
            await mutateReferrals({
                opType: 'BULK_DELETE',
                expectedRemovalIds,
                actorUserId
            }, async (refs) => {
                const removalSet = new Set(expectedRemovalIds);
                const filtered = refs.filter(r => !r || !removalSet.has(r.referralId));
                restoreCacheInPlace(refs, filtered);
            });
        } catch (refErr) {
            // Rollback Trash if Referrals persist fails
            restoreCacheInPlace(trash, trashSnapshot);
            try {
                await persistData('Trash', trash);
            } catch (trashRollbackErr) {
                console.error('CRITICAL: Trash rollback failed in bulk-delete:', trashRollbackErr);
            }
            console.error('❌ Failed to persist Referrals in bulk-delete:', refErr);
            if (refErr.code === 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
                return res.status(500).json({ success: false, code: refErr.code, error: refErr.message });
            }
            return res.status(500).json({ success: false, error: `일괄 삭제 실패: ${refErr.message}` });
        }

        // F4 Audit log (PII prohibited, count only)
        await referralAuditLogger({
            actorUserId,
            targetId: `count:${itemsToDelete.length}`,
            action: 'REFERRAL_BULK_DELETE',
            result: 'SUCCESS'
        });

        res.json({
            success: true,
            deletedCount: itemsToDelete.length,
            movedToTrash: true
        });
    } catch (err) {
        console.error('❌ bulk-delete error:', err);
        res.status(500).json({ success: false, error: `일괄 삭제 실패: ${err.message}` });
    }
});

app.put('/api/suicideattempters', requireAuth, (req, res) => {
    const updatedSA = req.body;
    const records = getData('SuicideAttempters', []);
    const index = records.findIndex(r => r.uid === updatedSA.uid);
    if (index !== -1) {
        records[index] = updatedSA;
        saveData('SuicideAttempters', records);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false, error: "Record not found" });
});

app.delete('/api/suicideattempters/:uid', requireAuth, (req, res) => {
    const { uid } = req.params;
    console.log(`[DELETE] Request for SuicideAttempter: ${uid}`);

    let records = getData('SuicideAttempters', []);
    const index = records.findIndex(r => r.uid === uid);

    if (index !== -1) {
        // Soft Delete: Move to Trash (복구 가능)
        const deletedItem = records[index];
        const trash = getData('Trash', []);
        trash.push({
            ...deletedItem,
            _trashSource: 'SuicideAttempters',
            deletedAt: new Date().toISOString()
        });
        records.splice(index, 1);
        saveData('SuicideAttempters', records);
        saveData('Trash', trash);

        console.log(`[DELETE] Successfully removed: ${uid}`);
        res.json({ success: true, movedToTrash: true });
    } else {
        // 이미 없는 경우도 성공으로 처리 (멱등성 확보 - 고스트 400 에러 방지)
        console.warn(`[DELETE] Item already missing or deleted: ${uid}. Returning success.`);
        res.json({ success: true, message: "Item already deleted" });
    }
});

app.post('/api/suicideattempters/bulk-delete', requireAuth, (req, res) => {
    const { uids } = req.body;
    console.log(`[BULK-DELETE] Request for UIDs: ${JSON.stringify(uids)}`);

    if (!Array.isArray(uids) || uids.length === 0) {
        // [NAS FIX] Even if empty, return success to avoid 400 error in UI
        return res.json({ success: true, message: "No UIDs provided", deletedCount: 0 });
    }

    let records = getData('SuicideAttempters', []);
    const trash = getData('Trash', []);
    const initialCount = records.length;

    const itemsToDelete = records.filter(r => uids.includes(r.uid));

    if (itemsToDelete.length > 0) {
        // Add to trash
        itemsToDelete.forEach(item => {
            trash.push({
                ...item,
                _trashSource: 'SuicideAttempters',
                deletedAt: new Date().toISOString()
            });
        });

        // Remove from main list
        records = records.filter(r => !uids.includes(r.uid));

        saveData('SuicideAttempters', records);
        saveData('Trash', trash);
        console.log(`[BULK-DELETE] Removed ${itemsToDelete.length} items.`);
    } else {
        console.warn(`[BULK-DELETE] None of the requested items found. Returning success.`);
    }

    res.json({
        success: true,
        deletedCount: initialCount - records.length,
        movedToTrash: true
    });
});

app.get('/api/unregistered', requireAuth, (req, res) => {
    res.json(getData('UnregisteredCandidates', []));
});

app.post('/api/unregistered', requireAuth, (req, res) => {
    const candidate = req.body;
    if (!candidate || (!candidate.clientId && !candidate.refNo)) {
        return res.status(400).json({ success: false, error: "Invalid candidate data" });
    }
    const candidates = getData('UnregisteredCandidates', []);

    const exists = candidate.clientId
        ? candidates.some(c => c.clientId === candidate.clientId)
        : candidates.some(c => candidate.refNo && c.refNo === candidate.refNo);
    if (!exists) {
        candidates.push(candidate);
        const saved = saveData('UnregisteredCandidates', candidates);
        if (!saved) {
            return res.status(500).json({ success: false, error: "Database write failed" });
        }
    }
    res.json({ success: true, message: "Unregistered candidate processed successfully" });
});

app.put('/api/unregistered', requireAuth, (req, res) => {
    const candidate = req.body;
    const candidates = getData('UnregisteredCandidates', []);
    const index = candidate.clientId
        ? candidates.findIndex(c => c.clientId === candidate.clientId)
        : candidates.findIndex(c => candidate.refNo && c.refNo === candidate.refNo);
    if (index !== -1) {
        candidates[index] = candidate;
        saveData('UnregisteredCandidates', candidates);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false, error: "Candidate not found" });
});

app.delete('/api/unregistered/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    let candidates = getData('UnregisteredCandidates', []);
    candidates = candidates.filter(c => c.refNo !== id && c.clientId !== id);
    saveData('UnregisteredCandidates', candidates);
    res.json({ success: true });
});

app.get('/api/trash', requireAuth, requireAdmin, (req, res) => {
    res.json(getData('Trash', []));
});

app.post('/api/trash/restore', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ success: false, error: "Missing id" });
        }
        let trash = getData('Trash', []);
        const item = trash.find(t => t && (t.referralId === id || t.refNo === id || t.clientId === id || t.uid === id));
        if (!item) {
            return res.status(404).json({ success: false, error: "Item not found in trash" });
        }

        const collection = item._trashSource || 'Referrals';
        const actorUserId = req.auth?.id || req.auth?.userId || 'unknown';

        if (collection === 'Referrals') {
            const restoredItem = { ...item };
            delete restoredItem._trashSource;
            delete restoredItem.deletedAt;

            // Phase 1: Restore to Referrals first via mutateReferrals
            try {
                await mutateReferrals({
                    opType: 'RESTORE',
                    expectedAdditionIds: [restoredItem.referralId],
                    actorUserId
                }, async (refs) => {
                    refs.push(restoredItem);
                });
            } catch (refErr) {
                console.error('❌ Failed to persist Referrals during restore:', refErr);
                if (refErr.code === 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
                    return res.status(500).json({ success: false, code: refErr.code, error: refErr.message });
                }
                return res.status(500).json({ success: false, error: `의뢰대장 복원 실패: ${refErr.message}` });
            }

            // Phase 2: Once Referrals succeed, remove from Trash
            const trashSnapshot = JSON.parse(JSON.stringify(trash));
            const trashIndex = trash.indexOf(item);
            if (trashIndex !== -1) {
                trash.splice(trashIndex, 1);
            }

            try {
                await persistData('Trash', trash);
            } catch (trashErr) {
                // If Trash persist fails: Rollback Referrals addition
                restoreCacheInPlace(trash, trashSnapshot);
                try {
                    await mutateReferrals({
                        opType: 'DELETE',
                        expectedRemovalIds: [restoredItem.referralId],
                        actorUserId: 'system'
                    }, async (refs) => {
                        const idx = refs.findIndex(r => r && r.referralId === restoredItem.referralId);
                        if (idx !== -1) refs.splice(idx, 1);
                    });
                } catch (rollbackErr) {
                    console.error('CRITICAL: Failed to rollback Referrals after Trash persist failure in restore:', rollbackErr);
                }
                console.error('❌ Failed to persist Trash during restore:', trashErr);
                return res.status(500).json({ success: false, error: `휴지통 정리 실패: ${trashErr.message}` });
            }

            // Audit log (PII prohibited)
            await referralAuditLogger({
                actorUserId,
                targetId: restoredItem.referralId,
                action: 'REFERRAL_RESTORE',
                result: 'SUCCESS'
            });

            return res.json({ success: true, restored: restoredItem });
        } else {
            // Other collection fallback
            const data = getData(collection, []);
            const dataSnapshot = JSON.parse(JSON.stringify(data));
            const trashSnapshot = JSON.parse(JSON.stringify(trash));

            const restoredItem = { ...item };
            delete restoredItem._trashSource;
            delete restoredItem.deletedAt;
            data.push(restoredItem);

            try {
                await persistData(collection, data);
            } catch (dataErr) {
                restoreCacheInPlace(data, dataSnapshot);
                return res.status(500).json({ success: false, error: dataErr.message });
            }

            const trashIndex = trash.indexOf(item);
            if (trashIndex !== -1) trash.splice(trashIndex, 1);

            try {
                await persistData('Trash', trash);
            } catch (trashErr) {
                restoreCacheInPlace(data, dataSnapshot);
                restoreCacheInPlace(trash, trashSnapshot);
                await persistData(collection, data).catch(ignore => {});
                return res.status(500).json({ success: false, error: trashErr.message });
            }

            return res.json({ success: true, restored: restoredItem });
        }
    } catch (err) {
        console.error('❌ /api/trash/restore error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/trash/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        let trash = getData('Trash', []);
        trash = trash.filter(t => t.referralId !== id && t.refNo !== id && t.clientId !== id && t.uid !== id);
        await persistData('Trash', trash);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ DELETE /api/trash/:id error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/pcassets', requireAuth, (req, res) => {
    res.json(getData('PC_Assets', []));
});

app.post('/api/pcassets', requireAuth, (req, res) => {
    const assets = req.body;
    saveData('PC_Assets', assets);
    res.json({ success: true });
});

app.get('/api/officialdocs', requireAuth, (req, res) => {
    res.json(getData('Documents', []));
});

app.post('/api/officialdocs/sync', (req, res) => {
    res.json({ success: false, error: "Gmail Sync not available on NAS server without OAuth2 setup." });
});

app.get('/api/budget/plans', requireAuth, (req, res) => {
    res.json(getData('BudgetPlans', {}));
});

app.post('/api/budget/plans', requireAuth, (req, res) => {
    saveData('BudgetPlans', req.body);
    res.json({ success: true });
});

app.get('/api/budget/transactions', requireAuth, (req, res) => {
    res.json(getData('BudgetTransactions', []));
});

app.post('/api/budget/transactions', requireAuth, (req, res) => {
    saveData('BudgetTransactions', req.body);
    res.json({ success: true });
});

app.get('/api/budget/metadata', requireAuth, (req, res) => {
    res.json(getData('BudgetMetadata', {}));
});

app.post('/api/budget/metadata', requireAuth, (req, res) => {
    saveData('BudgetMetadata', req.body);
    res.json({ success: true });
});

app.get('/api/budget/hierarchy', requireAuth, (req, res) => {
    res.json(getData('BudgetHierarchy', []));
});

app.post('/api/budget/hierarchy', requireAuth, (req, res) => {
    try {
        console.log('📥 [POST] /api/budget/hierarchy - Request body type:', typeof req.body);
        if (!req.body) {
            console.error('❌ [POST] /api/budget/hierarchy - Request body is empty!');
            return res.status(400).json({ success: false, error: "Request body is empty" });
        }

        const success = saveData('BudgetHierarchy', req.body);
        // [NAS FIX] Don't return 400 even if success is false, as saveData is now always returning true or handled
        res.json({ success: true });
    } catch (error) {
        console.error('🔥 [POST] /api/budget/hierarchy - CRASH:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/pending-referrals/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    let list = getData('PendingReferrals', []);
    list = list.filter(item => item.id !== id);
    saveData('PendingReferrals', list);

    // Explicitly add to ScrapedExternalIds to prevent re-scraping
    const scrapedIdsArray = getData('ScrapedExternalIds', []);
    const scrapedIds = new Set(scrapedIdsArray);
    scrapedIds.add(id);
    saveData('ScrapedExternalIds', Array.from(scrapedIds));

    res.json({ success: true });
});

app.get('/api/logs', requireAuth, (req, res) => {
    res.json(getData('Logs', []));
});

app.post('/api/logs', requireAuth, (req, res) => {
    const log = req.body;
    if (!log || !log.logId) {
        return res.status(400).json({ success: false, error: 'Invalid log data' });
    }
    const logs = getData('Logs', []);
    logs.push(log);
    saveData('Logs', logs);
    res.json({ success: true });
});

app.get('/api/analysis-results', requireAuth, (req, res) => {
    const list = normalizeSavedAnalysisList(getData(CASE_ANALYSIS_FILE, []));
    res.json(list);
});

app.post('/api/analysis-results', requireAuth, (req, res) => {
    const { name, data } = req.body || {};
    if (!name || !data) {
        return res.status(400).json({ success: false, error: 'name and data are required' });
    }

    // [CRITICAL BUG FIX] Do NOT normalize during load, it destroys detailed data of existing items
    const rawList = getData(CASE_ANALYSIS_FILE, []);
    const list = Array.isArray(rawList) ? rawList : [];

    const item = {
        id: `analysis_${Date.now()}`,
        name: String(name),
        createdAt: new Date().toISOString(),
        data
    };

    const next = [item, ...list];

    // Normalize only for the final output ensuring structure, but keeping our new item intact
    const normalizedNext = normalizeSavedAnalysisList(next);

    const startTime = Date.now();
    const saved = saveData(CASE_ANALYSIS_FILE, normalizedNext);
    const duration = Date.now() - startTime;

    if (!saved) {
        console.error(`[API] Failed to save analysis result: ${name}`);
        return res.status(500).json({ success: false, error: 'Failed to save analysis result' });
    }

    console.log(`[API] Successfully saved analysis result: ${name} (${JSON.stringify(data).length} bytes, ${duration}ms)`);
    res.json({ success: true, item });
});

app.get('/api/analysis-results/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const list = normalizeSavedAnalysisList(getData(CASE_ANALYSIS_FILE, []));
    const found = list.find(item => item?.id === id);
    if (!found) {
        return res.status(404).json({ success: false, error: 'Saved analysis not found' });
    }
    res.json({ success: true, name: found.name, data: found.data });
});

app.delete('/api/analysis-results/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const source = normalizeSavedAnalysisList(getData(CASE_ANALYSIS_FILE, []));
    const next = source.filter(item => item?.id !== id);

    if (next.length === source.length) {
        return res.status(404).json({ success: false, error: 'Saved analysis not found' });
    }

    const saved = saveData(CASE_ANALYSIS_FILE, next);
    if (!saved) {
        return res.status(500).json({ success: false, error: 'Failed to delete saved analysis' });
    }

    res.json({ success: true });
});

app.put('/api/logs', requireAuth, (req, res) => {
    const updatedLog = req.body;
    if (!updatedLog || !updatedLog.logId) {
        return res.status(400).json({ success: false, error: 'Invalid log data' });
    }
    const logs = getData('Logs', []);
    const index = logs.findIndex(l => l.logId === updatedLog.logId);
    if (index !== -1) {
        logs[index] = { ...logs[index], ...updatedLog };
        saveData('Logs', logs);
        return res.json({ success: true });
    }
    // 없으면 추가 (신규)
    logs.push(updatedLog);
    saveData('Logs', logs);
    res.json({ success: true });
});

app.post('/api/activity', requireAuth, async (req, res) => {
    try {
        const { user, action, details } = req.body;
        const activityLogs = getData('ActivityLogs', []);
        activityLogs.push({
            id: `act_${Date.now()}`,
            user: user || 'Unknown',
            action: action || '',
            details: details || '',
            timestamp: new Date().toLocaleString('ko-KR')
        });
        // 최대 5000개 유지
        if (activityLogs.length > 5000) activityLogs.splice(0, activityLogs.length - 5000);
        await persistData('ActivityLogs', activityLogs);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ POST /api/activity error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── 📎 FILE UPLOAD ────────────────────────────────────────────────────────
// POST /api/upload
// Body: { base64: string, filename: string, mimeType: string,
//         referralId?: string, referralName?: string, folderType?: string }
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, async (req, res) => {
    const { base64, filename, mimeType, referralId, referralName, folderType } = req.body;
    const requestId = `UPLOAD_${Date.now()}`;

    // 1. 필수 필드 검증
    if (!base64 || !filename) {
        console.warn(`⚠️ [${requestId}] ATTACH_400: base64 또는 filename 누락`);
        return res.status(400).json({
            success: false, status: 'error',
            code: 'ATTACH_400', message: 'base64와 filename은 필수입니다.'
        });
    }

    // [P0-D7] 객체 검증: referralId가 지정된 경우 실존 레코드와 매칭되어야 한다.
    // 신규 작성 중인 레코드의 임시 폴더 키('new-sa', 'C-<timestamp>')는 FE 정상 흐름이므로 허용.
    // (folderType allowlist는 ReferralEditor가 clientId/'C-<ts>'를 folderType으로 보내므로 적용하지 않음)
    if (referralId) {
        const rid = String(referralId);
        const referrals = getData('Referrals', []);
        const attempters = getData('SuicideAttempters', []);
        const existsInReferrals = referrals.some(r => r && (String(r.referralId) === rid || String(r.refNo) === rid || String(r.clientId) === rid));
        const existsInAttempters = attempters.some(a => a && (String(a.uid) === rid || String(a.id) === rid));
        const isTempKey = /^(new-sa|C-\d+)$/.test(rid);
        if (!existsInReferrals && !existsInAttempters && !isTempKey) {
            console.warn(`⚠️ [${requestId}] ATTACH_400: 존재하지 않는 referralId ${rid}`);
            return res.status(400).json({
                success: false, status: 'error',
                code: 'ATTACH_400', message: '유효하지 않은 의뢰/대상자 ID입니다.'
            });
        }
    }

    // 2. 파일 크기 검증 (50MB)
    const estimatedBytes = Math.ceil(base64.length * 0.75);
    if (estimatedBytes > 50 * 1024 * 1024) {
        console.warn(`⚠️ [${requestId}] ATTACH_413: ${(estimatedBytes / 1024 / 1024).toFixed(1)}MB 초과`);
        return res.status(413).json({
            success: false, status: 'error',
            code: 'ATTACH_413',
            message: `파일 크기가 50MB를 초과합니다. (${(estimatedBytes / 1024 / 1024).toFixed(1)}MB)`
        });
    }

    // 3. 확장자 검증
    const allowedExt = ['.pdf', '.jpg', '.jpeg', '.png', '.hwp', '.hwpx', '.docx', '.xlsx'];
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExt.includes(ext)) {
        console.warn(`⚠️ [${requestId}] ATTACH_415: 허용되지 않은 확장자 ${ext}`);
        return res.status(415).json({
            success: false, status: 'error',
            code: 'ATTACH_415',
            message: `허용되지 않은 파일 형식입니다. (${ext}) 허용: ${allowedExt.join(', ')}`
        });
    }

    // 4. 폴더 결정 (Path Traversal 방지)
    const rawFolder = referralId || folderType || 'unsorted';
    const safeFolder = rawFolder.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
    const folderPath = path.join(ATTACHMENTS_DIR, safeFolder);
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }

    // 5. 타임스탬프 prefix로 중복 충돌 방지
    const safeFilename = filename.replace(/[^a-z0-9가-힣._\-]/gi, '_');
    const fileId = `${Date.now()}_${safeFilename}`;
    const filePath = path.join(folderPath, fileId);
    const fileUrl = `/attachments/${safeFolder}/${encodeURIComponent(fileId)}`;

    try {
        const buffer = Buffer.from(base64, 'base64');
        await fs.promises.writeFile(filePath, buffer);
        console.log(`✅ [${requestId}] ATTACH_200: folder=${safeFolder} file=${fileId} size=${(buffer.length / 1024).toFixed(1)}KB`);

        // GAS 호환(status:'success') + REST 호환(success:true) 모두 충족
        return res.json({
            success: true,
            status: 'success',
            code: 'ATTACH_200',
            fileId: fileId,
            filename: filename,
            fileUrl: fileUrl,
            size: buffer.length,
            folder: safeFolder,
            requestId: requestId
        });
    } catch (e) {
        console.error(`❌ [${requestId}] ATTACH_500: 파일 저장 실패 path=${filePath}`, e.message);
        return res.status(500).json({
            success: false, status: 'error',
            code: 'ATTACH_500',
            message: '서버 파일 저장에 실패했습니다.',
            requestId: requestId
        });
    }
});
// ───────────────────────────────────────────────────────────────────────────

// [P0-B2/D6] OBJECT_SCOPED: requireAuth + 공유 경로 검증 + GET /attachments와 동일한 객체 소유권
app.delete('/api/deleteFile/:folder/:fileId', requireAuth, async (req, res) => {
    try {
        if (!req.auth || req.auth.status !== 'active') {
            return res.status(403).json({ error: { code: 'ACCOUNT_INACTIVE', message: '비활성화된 계정은 첨부파일을 삭제할 수 없습니다.' } });
        }

        const { folder, fileId } = req.params;
        const pathCheck = validateAttachmentPath(folder, fileId);
        if (!pathCheck.ok) {
            if (typeof surveyAuditLogger === 'function') {
                surveyAuditLogger({
                    actorUserId: req.auth?.id || 'unknown',
                    action: 'ATTACHMENT_DELETE_DENIED',
                    result: 'DENIED',
                    reasonCode: pathCheck.reason
                });
            }
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '잘못된 경로입니다.' } });
        }
        const { safeFolder, safeFile, resolvedPath } = pathCheck;

        // 객체 소유권: GET /attachments와 동일한 판정 (admin 우회 → 의뢰 담당자 → 설문 담당자 → 거부)
        const currentUserId = String(req.auth?.id || req.auth?.userId || '');
        const userRole = (req.auth?.role || req.auth?.userRole || 'user').toLowerCase();
        const isAdmin = userRole === 'admin';

        let isAuthorized = false;
        if (isAdmin) {
            isAuthorized = true;
        } else {
            const referrals = getData('Referrals', []);
            const connectedReferral = referrals.find(r =>
                r && (
                    r.referralId === safeFolder ||
                    r.refNo === safeFolder ||
                    r.sourceSubmissionId === safeFolder ||
                    r.sourceSurveyId === safeFolder
                )
            );
            if (connectedReferral) {
                const refCheck = canAccessReferralAttachment({ authUser: req.auth, referral: connectedReferral });
                if (refCheck.allowed) isAuthorized = true;
            } else {
                const submissions = surveyRepository.getSurveySubmissions();
                const connectedSurvey = submissions.find(s =>
                    s && (
                        s.submissionId === safeFolder ||
                        s.internalSurveyId === safeFolder ||
                        s.attachmentId === safeFile ||
                        (s.attachment && s.attachment.id === safeFile)
                    )
                );
                if (connectedSurvey) {
                    const hasSurveyPerm = hasOnlineSurveyAccess(req.auth);
                    isAuthorized = hasSurveyPerm && String(connectedSurvey.assignedUserId) === currentUserId;
                }
            }
        }

        if (!isAuthorized) {
            if (typeof surveyAuditLogger === 'function') {
                surveyAuditLogger({
                    actorUserId: currentUserId || 'unknown',
                    action: 'ATTACHMENT_DELETE_DENIED',
                    attachmentId: safeFile,
                    folder: safeFolder,
                    result: 'DENIED',
                    reasonCode: 'OBJECT_AUTHORIZATION_FAILED'
                });
            }
            return res.status(403).json({ error: { code: 'FORBIDDEN', message: '해당 첨부파일을 삭제할 권한이 없습니다.' } });
        }

        if (fs.existsSync(resolvedPath)) {
            await fs.promises.unlink(resolvedPath);
            console.log(`🗑️ File deleted from NAS: ${resolvedPath}`);
            res.json({ success: true });
        } else {
            console.warn(`⚠️ File not found for deletion: ${resolvedPath}`);
            res.json({ success: true }); // Still return success to stay in sync
        }
    } catch (e) {
        console.error("❌ NAS Delete Error:", e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.get('/api/analysis/isp-achievement', requireAuth, (req, res) => {
    const { month } = req.query; // YYYY-MM
    if (!month) return res.status(400).json({ success: false, error: "Month is required (YYYY-MM)" });

    const clients = getData('clients', []);
    const counselingRecords = getData('counseling_records', []);

    // Get year and month info for duration calculation
    const [year, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mm, 0).getDate();

    const result = clients.map(client => {
        const segments = [
            {
                category: client.managementCategory,
                duration: daysInMonth
            }
        ];

        let totalTarget = 0;
        let actualFaceToFace = 0;

        segments.forEach(seg => {
            let divisor = 30.0;
            if (seg.category === '집중관리') divisor = 7.0;
            else if (seg.category === '일시관리') divisor = 90.0;
            else if (seg.category === '유지관리') divisor = 30.0;

            const segmentTarget = Math.ceil(seg.duration / divisor);
            totalTarget += segmentTarget;
        });

        const sessions = counselingRecords.filter(r =>
            r.clientId === client.id &&
            r.date.startsWith(month) &&
            (r.type === 'visit' || r.type === 'inOffice')
        );
        actualFaceToFace = sessions.length;

        const achievementRate = totalTarget > 0 ? Math.min(100, Math.round((actualFaceToFace / totalTarget) * 100)) : 100;

        // Multi-tier Evaluation Logic
        let status = 'fail';
        let statusText = '개입 부족 (미달)';

        if (actualFaceToFace >= totalTarget) {
            if (actualFaceToFace > (totalTarget + OVER_THRESHOLD)) {
                status = 'warning';
                statusText = '과잉 개입 (ISP 점검 요망)';
            } else {
                status = 'success';
                statusText = '적정 개입 (달성)';
            }
        }

        return {
            memberId: client.id,
            memberName: client.name,
            registrationNo: client.registrationNo || '',
            managementCategory: client.managementCategory,
            targetSessions: totalTarget,
            actualSessions: actualFaceToFace,
            achievementRate: achievementRate,
            status: status,
            statusText: statusText
        };
    });

    res.json({ success: true, data: result });
});

app.post('/api/saveNotes', requireAuth, async (req, res) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey) {
            const cached = idempotencyStore.get(idempotencyKey);
            if (cached) {
                if (cached.reqBodyHash === hashPayload(req.body)) {
                    console.log(`[API] Returning cached response for saveNotes idempotency key: ${idempotencyKey}`);
                    return res.status(cached.statusCode).json(cached.response);
                } else {
                    return res.status(409).json({
                        success: false,
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        error: "Idempotency key reused with different request payload"
                    });
                }
            }
        }

        const { refNo, notes, referralId, version } = req.body;

        // F6: Validate notes length and count BEFORE mutation
        const vNotes = validateNotes(notes);
        if (!vNotes.valid) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_NOTES_LENGTH',
                error: vNotes.error
            });
        }

        const referrals = getData('Referrals', []);

        let index = -1;
        if (referralId) {
            index = referrals.findIndex(r => r && r.referralId === referralId);
        }
        if (index === -1 && refNo) {
            index = referrals.findIndex(r => r && (r.refNo === refNo || r.clientId === refNo));
        }

        if (index === -1) {
            return res.status(404).json({ success: false, error: "Referral not found" });
        }

        const target = referrals[index];

        // Optimistic Concurrency Control check
        if (version !== undefined && target.version !== undefined) {
            const reqVer = Number(version);
            const curVer = Number(target.version);
            if (reqVer !== curVer) {
                const isConsecutiveSave = (curVer - reqVer === 1);
                if (isConsecutiveSave) {
                    console.warn(`[OCC] Consecutive notes save detected for ${target.refNo || req.params.id} (reqVer: ${reqVer}, curVer: ${curVer}). Auto-resolving with merge.`);
                } else {
                    return res.status(409).json({
                        success: false,
                        code: 'VERSION_CONFLICT',
                        error: "다른 사용자에 의해 데이터가 변경되었습니다. 최신 정보를 불러온 후 다시 시도해주세요.",
                        currentVersion: target.version,
                        latestUpdatedAt: target.updatedAt
                    });
                }
            }
        }

        const newNotes = Array.isArray(notes) ? notes : [];
        const currentNotes = Array.isArray(target.notes) ? target.notes : [];

        // Safety check: prevent accidental truncation if current has notes but new is empty without explicit clear flag
        if (currentNotes.length > 0 && newNotes.length === 0 && !req.body.allowEmptyNotes) {
            return res.status(400).json({
                success: false,
                code: 'EMPTY_NOTES_REJECTED',
                error: "기존 상담메모가 존재하는데 빈 목록이 전송되었습니다. 삭제 시 명시적 플래그가 필요합니다."
            });
        }

        // Assign note ID if missing
        newNotes.forEach((n, idx) => {
            if (!n.id) n.id = `note_${Date.now()}_${idx}`;
        });

        // Prepare updated target
        const updatedTarget = {
            ...target,
            notes: newNotes,
            latestNote: newNotes.length > 0 ? (newNotes[0].content || '') : '',
            latestNoteDate: newNotes.length > 0 ? (newNotes[0].createdAt || newNotes[0].date || new Date().toLocaleString('ko-KR')) : '',
            version: (target.version || 1) + 1,
            updatedAt: new Date().toISOString()
        };

        await mutateReferrals({
            opType: 'NOTES',
            targetId: target.referralId,
            actorUserId: req.auth?.id || req.auth?.userId || 'system'
        }, async (refs) => {
            refs[index] = updatedTarget;
        });

        const responsePayload = { success: true, data: updatedTarget };
        if (idempotencyKey) {
            cleanIdempotencyStore();
            idempotencyStore.set(idempotencyKey, {
                statusCode: 200,
                reqBodyHash: hashPayload(req.body),
                response: responsePayload
            });
        }

        res.json(responsePayload);
    } catch (err) {
        console.error('❌ POST /api/saveNotes error:', err);
        if (err.code === 'REFERRAL_DATA_INTEGRITY_VIOLATION') {
            return res.status(500).json({ success: false, code: err.code, error: err.message });
        }
        res.status(500).json({ success: false, error: `저장 실패: ${err.message}` });
    }
});


app.get('/api/budget/transactions', (req, res) => {
    try {
        const transactions = getData('BudgetTransactions', []);
        res.json(transactions);
    } catch (e) {
        console.error('❌ Budget transactions GET error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.post('/api/budget/transactions', (req, res) => {
    try {
        const transactions = Array.isArray(req.body) ? req.body : [];
        saveData('BudgetTransactions', transactions);
        console.log(`💰 Budget transactions saved: ${transactions.length} items`);
        res.json({ success: true, count: transactions.length });
    } catch (e) {
        console.error('❌ Budget transactions POST error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.get('/api/budget/plans', (req, res) => {
    try {
        const plans = getData('BudgetPlans', {});
        res.json(plans);
    } catch (e) {
        console.error('❌ Budget plans GET error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.post('/api/budget/plans', (req, res) => {
    try {
        const plans = req.body && typeof req.body === 'object' ? req.body : {};
        saveData('BudgetPlans', plans);
        console.log(`📋 Budget plans saved: ${Object.keys(plans).length} items`);
        res.json({ success: true, count: Object.keys(plans).length });
    } catch (e) {
        console.error('❌ Budget plans POST error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.get('/api/budget/metadata', (req, res) => {
    try {
        const metadata = getData('BudgetMetadata', {});
        res.json(metadata);
    } catch (e) {
        console.error('❌ Budget metadata GET error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.post('/api/budget/metadata', (req, res) => {
    try {
        const metadata = req.body && typeof req.body === 'object' ? req.body : {};
        saveData('BudgetMetadata', metadata);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ Budget metadata POST error:', e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.get('/api/budget/hierarchy', (req, res) => {
    res.json(getData('BudgetHierarchy', {}));
});

app.post('/api/budget/hierarchy', (req, res) => {
    saveData('BudgetHierarchy', req.body);
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    res.json(getData('Logs', []));
});

app.post('/api/logs', (req, res) => {
    const logs = getData('Logs', []);
    if (req.body && Object.keys(req.body).length > 0) {
        logs.unshift(req.body); // Newest first
        if (logs.length > 2000) logs.pop(); // Keep last 2000
        saveData('Logs', logs);
    }
    res.json({ success: true });
});

app.get('/api/unregistered', (req, res) => {
    res.json(getData('Unregistered', []));
});

// ==========================================
// 🚀 EXTERNAL REFERRAL SCRAPER (imhc.co.kr)
// ==========================================

// [P0-D3] 외부 로그인 자격증명은 환경변수에서만 읽는다.
// 코드·기본값·로그에 평문 자격증명을 남기지 않는다.
function getExternalCredentials() {
    const login_id = process.env.EXTERNAL_LOGIN_ID;
    const login_pw = process.env.EXTERNAL_LOGIN_PW;
    if (!login_id || !login_pw) return null;
    return { login_id, login_pw };
}

const EXTERNAL_CONFIG = {
    loginUrl: 'https://www.imhc.co.kr/sa/login/login_pro.php',
    listUrl: 'https://www.imhc.co.kr/sa/community/reqask_list.php',
    viewUrl: 'https://www.imhc.co.kr/sa/community/reqask_view.php',
    pollInterval: 30 * 60 * 1000 // 30 mins
};

const DEFAULT_SYNC_METADATA = {
    lastSuccessfulSyncAt: null,
    lastAttemptedSyncAt: null,
    lastSyncStatus: 'idle',
    lastSyncError: null,
    failedDetailCount: 0,
    seenExternalIds: {}
};

function getWebsiteSyncMetadata() {
    const data = getData('WebsiteSyncMetadata', { ...DEFAULT_SYNC_METADATA });
    if (!data.seenExternalIds) data.seenExternalIds = {};
    return data;
}

async function saveWebsiteSyncMetadata(meta) {
    await persistData('WebsiteSyncMetadata', meta);
}

// Website referral collection period: 2026-09-01 00:00:00 KST and later (no end date).
// [Track B hotfix] 기존 isSeptember2026InSeoul()은 2026-10-01 00:00 KST부터 신규 홈페이지
// 의뢰를 cleanup에서 자동 삭제하는 시한폭탄이었음. 2026-09 이전(6/7/8월 테스트 데이터)은 계속 제외.
function isAllowedWebsiteReferralPeriod(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const trimmed = dateStr.trim();
    // Fast path: exactly YYYY-MM or YYYY-MM-DD (no time part) -> lexicographic compare.
    // Anything with a time component falls through to the timezone-aware Date path below,
    // so KST date boundaries (e.g. 2026-08-31T15:00:00Z == 2026-09-01 00:00 KST) stay correct.
    const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(trimmed);
    if (m) {
        const ym = m[1] + '-' + m[2];
        return ym >= '2026-09';
    }
    try {
        const d = new Date(trimmed);
        if (isNaN(d.getTime())) return false;
        const seoulFormatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = seoulFormatter.format(d); // YYYY-MM-DD
        return parts >= '2026-09-01';
    } catch {
        return false;
    }
}

let isWebsiteSyncing = false;

// [Headless 2026-10-14] 타임아웃 시 강제 종료용 transport 참조
let activeScraperTransport = null;

// [Headless scraper 2026-10-14] 홈페이지 보안 강화로 fetch 기반 전송 계층이
// 세션 검증을 통과하지 못함. 전송 계층을 추상화하여 헤드리스 브라우저로 교체.
// 파싱 로직(정규식)은 그대로 유지. SCRAPER_TRANSPORT=fetch 로 즉시 롤백 가능.
const SCRAPER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 연속 빈 결과 카운터: 3회 연속 시 차단 징후 WARN (데이터는 절대 삭제하지 않음)
let consecutiveEmptyScraperRuns = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- FetchTransport: 기존 fetch 로직 (비상 폴백용) ---
class FetchTransport {
    constructor() {
        this.name = 'fetch';
        this.sessionCookie = '';
    }

    async init(credentials) {
        const loginFormData = new URLSearchParams();
        Object.entries(credentials).forEach(([k, v]) => loginFormData.append(k, v));

        const loginRes = await fetch(EXTERNAL_CONFIG.loginUrl, {
            method: 'POST',
            body: loginFormData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': SCRAPER_USER_AGENT
            },
            redirect: 'manual'
        });

        const cookieHeader = loginRes.headers.get('set-cookie');
        if (!cookieHeader) {
            throw new Error('No session cookie received from login');
        }

        // [Hotfix 2026-10-14] 다중 쿠키 전송 (단일 쿠키 환경에서는 기존과 동일)
        const setCookies = loginRes.headers.getSetCookie?.()
            ?? [loginRes.headers.get('set-cookie')].filter(Boolean);
        this.sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    async getListHtml(pageNum) {
        const pageUrl = pageNum === 1
            ? EXTERNAL_CONFIG.listUrl
            : `${EXTERNAL_CONFIG.listUrl}?page=${pageNum}`;
        try {
            const listRes = await fetch(pageUrl, {
                headers: {
                    'Cookie': this.sessionCookie,
                    'User-Agent': SCRAPER_USER_AGENT
                }
            });
            if (!listRes.ok) return null;
            return await listRes.text();
        } catch (e) {
            console.warn(`⚠️ [FetchTransport] List page ${pageNum} failed:`, e.message);
            return null;
        }
    }

    async getViewHtml(idx) {
        try {
            const viewRes = await fetch(`${EXTERNAL_CONFIG.viewUrl}?idx=${idx}`, {
                headers: {
                    'Cookie': this.sessionCookie,
                    'User-Agent': SCRAPER_USER_AGENT
                }
            });
            if (!viewRes.ok) return null;
            return await viewRes.text();
        } catch (e) {
            console.warn(`⚠️ [FetchTransport] View page idx=${idx} failed:`, e.message);
            return null;
        }
    }

    async close() {
        // fetch는 정리할 리소스 없음
    }
}

// --- BrowserTransport: Puppeteer 헤드리스 브라우저 (기본값) ---
class BrowserTransport {
    constructor() {
        this.name = 'browser';
        this.browser = null;
        this.page = null;
    }

    async init(credentials) {
        // [Stealth 2026-10-15] 홈페이지 봇 차단 우회: puppeteer-extra + stealth 플러그인.
        // 스텔스 로드 실패 시 puppeteer-core로 자동 폴백 (기존 동작 유지, 크래시 없음).
        let puppeteer;
        let browserLib = 'puppeteer-core';
        try {
            const puppeteerExtra = (await import('puppeteer-extra')).default;
            const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
            puppeteerExtra.use(StealthPlugin());
            puppeteer = puppeteerExtra;
            browserLib = 'puppeteer-extra+stealth';
        } catch (e) {
            console.warn('⚠️ [BrowserTransport] stealth unavailable, falling back to puppeteer-core:', e.message);
            try {
                puppeteer = (await import('puppeteer-core')).default;
            } catch (e2) {
                throw new Error('no browser automation lib available: ' + e2.message);
            }
        }
        console.log(`ℹ️ [BrowserTransport] Using ${browserLib}`);

        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
        try {
            this.browser = await puppeteer.launch({
                executablePath,
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                ],
                timeout: 30000,
            });
        } catch (e) {
            throw new Error('Chromium launch failed (' + executablePath + '): ' + e.message);
        }

        this.page = await this.browser.newPage();
        await this.page.setUserAgent(SCRAPER_USER_AGENT);
        await this.page.setViewport({ width: 1366, height: 768 });

        // 로그인: 기존 POST 엔드포인트를 브라우저 컨텍스트에서 실행.
        // 브라우저의 쿠키 저장소·TLS 지문을 그대로 활용하므로 별도 폼 파싱 불필요.
        // [P0-D3] 자격증명은 page.evaluate 인자로만 전달, 로그에 절대 출력하지 않음.
        const loginOk = await this.page.evaluate(async (loginUrl, creds) => {
            try {
                const fd = new URLSearchParams();
                for (const [k, v] of Object.entries(creds)) fd.append(k, v);
                await fetch(loginUrl, {
                    method: 'POST',
                    body: fd,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    credentials: 'include',
                });
                return true;
            } catch (e) {
                return false;
            }
        }, EXTERNAL_CONFIG.loginUrl, credentials);

        if (!loginOk) {
            throw new Error('Browser login POST failed');
        }

        // 세션 검증: 목록 페이지 로드 후 로그인 폼(password input)이 남아있는지 확인
        await this.page.goto(EXTERNAL_CONFIG.listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
        const html = await this.page.content();
        if (/<input[^>]*type=["']password["']/i.test(html)) {
            throw new Error('Login verification failed: password field still present on list page');
        }
        console.log('✅ [BrowserTransport] Login verified, session active');
    }

    async getListHtml(pageNum) {
        const pageUrl = pageNum === 1
            ? EXTERNAL_CONFIG.listUrl
            : `${EXTERNAL_CONFIG.listUrl}?page=${pageNum}`;
        try {
            await this.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(1000); // PHP 렌더링 완료 여유
            const html = await this.page.content();
            if (process.env.SCRAPER_DEBUG === 'true') {
                console.log(`🔍 [BrowserTransport] List page ${pageNum} HTML head:`, html.substring(0, 500));
            }
            return html;
        } catch (e) {
            console.warn(`⚠️ [BrowserTransport] List page ${pageNum} failed:`, e.message);
            return null;
        }
    }

    async getViewHtml(idx) {
        try {
            await this.page.goto(`${EXTERNAL_CONFIG.viewUrl}?idx=${idx}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(1000 + Math.random() * 1000); // 1~2초 간격 (예의 + 레이트리밋 회피)
            return await this.page.content();
        } catch (e) {
            console.warn(`⚠️ [BrowserTransport] View page idx=${idx} failed:`, e.message);
            return null;
        }
    }

    async close() {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch (e) {
                console.warn('⚠️ [BrowserTransport] browser.close() failed:', e.message);
            }
            this.browser = null;
            this.page = null;
        }
    }
}

// 전송 계층 선택: SCRAPER_TRANSPORT=browser(기본) | fetch(비상 폴백)
function createScraperTransport() {
    const name = (process.env.SCRAPER_TRANSPORT || 'browser').toLowerCase();
    if (name === 'fetch') {
        console.log('ℹ️ [Scraper] Using FetchTransport (SCRAPER_TRANSPORT=fetch)');
        return new FetchTransport();
    }
    return new BrowserTransport();
}

async function fetchExternalReferralsInner(options = {}) {
    if (isWebsiteSyncing) {
        console.log('⏳ [Scraper] Sync already in progress, skipping duplicate invocation.');
        return { success: false, inProgress: true };
    }
    isWebsiteSyncing = true;
    console.log('🔄 [Scraper] Starting external referral check (HTTPS)...');
    const meta = getWebsiteSyncMetadata();
    meta.lastAttemptedSyncAt = new Date().toISOString();

    // [P0-D3] 외부 자격증명 미설정 시 fail-closed — 스크레이퍼만 중단, 서버 기동은 유지.
    // 비밀 기본값을 사용하지 않으며, 값을 로그·오류 메시지에 포함하지 않는다.
    const credentials = getExternalCredentials();
    if (!credentials) {
        console.error('❌ [Scraper] 외부 자격증명 미설정 (EXTERNAL_LOGIN_ID / EXTERNAL_LOGIN_PW) — sync 건너뜀');
        meta.lastSyncStatus = 'config_error';
        meta.lastSyncError = '외부 자격증명이 설정되지 않았습니다 (EXTERNAL_LOGIN_ID / EXTERNAL_LOGIN_PW)';
        saveWebsiteSyncMetadata(meta);
        isWebsiteSyncing = false;
        return { success: false, error: meta.lastSyncError };
    }

    // [Headless 2026-10-14] 전송 계층 초기화 (로그인). 브라우저 기본, 실패 시 fetch 폴백.
    // NOTE: transport.close()는 아래 finally에서 보장됨.
    let transport = createScraperTransport();
    try {
        await transport.init(credentials);
    } catch (initErr) {
        console.error(`❌ [Scraper] ${transport.name} transport init failed:`, initErr.message);
        try { await transport.close(); } catch {}
        const fallbackEnabled = (process.env.SCRAPER_FALLBACK_FETCH ?? 'true').toLowerCase() !== 'false';
        if (transport.name !== 'fetch' && fallbackEnabled) {
            console.warn('⚠️ [Scraper] Falling back to FetchTransport');
            transport = new FetchTransport();
            try {
                await transport.init(credentials);
            } catch (fallbackErr) {
                console.error('❌ [Scraper] Fallback login also failed:', fallbackErr.message);
                meta.lastSyncStatus = 'failed';
                meta.lastSyncError = 'Login failed: ' + fallbackErr.message;
                saveWebsiteSyncMetadata(meta);
                isWebsiteSyncing = false;
                return { success: false, error: meta.lastSyncError };
            }
        } else {
            meta.lastSyncStatus = 'failed';
            meta.lastSyncError = 'Login failed: ' + initErr.message;
            saveWebsiteSyncMetadata(meta);
            isWebsiteSyncing = false;
            return { success: false, error: meta.lastSyncError };
        }
    }
    activeScraperTransport = transport;

    try {
        const referrals = getData('Referrals', []);
        let existingPending = getData('PendingReferrals', []);
        const scrapedIdsArray = getData('ScrapedExternalIds', []);
        const scrapedIds = new Set(scrapedIdsArray);

        // Auto-cleanup:
        // 1. Keep 2026-09 and later; remove older months (June/July/August test data)
        // 2. Remove already registered clients from existingPending
        const normalizePhone = (num) => num ? String(num).replace(/[^0-9]/g, '') : '';
        const beforeCleanupCount = existingPending.length;
        existingPending = existingPending.filter(p => {
            const extId = p.externalIdx || (p.id && String(p.id).startsWith('ext_') ? p.id : null);
            const isWeb = !!extId || !!p.isWebsiteReferral;
            const receivedAt = p.externalReceivedAt || p.registrationDate || p.createdAt || '';

            // [Constraint] Website referrals from 2026-09-01 KST onward are kept in PendingReferrals
            if (isWeb && !isAllowedWebsiteReferralPeriod(receivedAt)) {
                console.log(`🧹 [Scraper Cleanup] Purging pre-September-2026 website referral: ${p.name} (${receivedAt})`);
                // [Track B hotfix] 최종관리자 확정 기준: 날짜 조건으로 제외된 의뢰의 externalIdx를
                // ScrapedExternalIds에 추가하지 않는다 (9월 이전 테스트 데이터 포함).
                // -> 이 분기의 scrapedIds.add 호출을 제거함. 재수집 영구 차단 방지.
                return false;
            }

            const isRegistered = referrals.some(r => {
                const nameMatch = r.name && p.name && r.name.trim() === p.name.trim();
                if (!nameMatch) return false;

                const rPhone = normalizePhone(r.phone);
                const pPhone = normalizePhone(p.phone);
                if (rPhone && pPhone && rPhone === pPhone) return true;

                if (r.birthDate && p.birthDate && r.birthDate.trim() === p.birthDate.trim()) return true;

                return false;
            });

            if (isRegistered) {
                console.log(`🧹 [Scraper Cleanup] Removing pending referral for already-registered person: ${p.name}`);
                if (p.externalIdx) scrapedIds.add(p.externalIdx);
                if (p.id) scrapedIds.add(p.id);
                return false;
            }
            return true;
        });

        if (existingPending.length !== beforeCleanupCount) {
            await persistData('PendingReferrals', existingPending);
            await persistData('ScrapedExternalIds', Array.from(scrapedIds));
        }

        existingPending.forEach(p => {
            if (p.externalIdx) scrapedIds.add(p.externalIdx);
            if (p.id) scrapedIds.add(p.id);
        });

        // 2. Multi-page traversal (up to 5 pages) to recover accumulated referrals
        const discoveredIndices = [];
        const maxPages = 5;
        for (let page = 1; page <= maxPages; page++) {
            const listHtml = await transport.getListHtml(page);
            if (!listHtml) break;

            const idxMatches = [...listHtml.matchAll(/reqask_view\.php\?idx=([0-9]+)/g)];
            const pageIndices = [...new Set(idxMatches.map(m => m[1]))];
            if (pageIndices.length === 0) break;

            for (const idx of pageIndices) {
                if (!discoveredIndices.includes(idx)) {
                    discoveredIndices.push(idx);
                }
            }

            // If any item on this page is already known/scraped, stop crawling older pages
            const hasKnown = pageIndices.some(idx => scrapedIds.has(`ext_${idx}`));
            if (hasKnown && !options.forceAllPages) {
                break;
            }
        }

        if (discoveredIndices.length === 0) {
            console.log('ℹ️ [Scraper] No referrals found on list pages');
            consecutiveEmptyScraperRuns += 1;
            if (consecutiveEmptyScraperRuns >= 3) {
                console.warn(`⚠️ [Scraper] ${consecutiveEmptyScraperRuns} consecutive empty runs — possible blocking. Data untouched.`);
            }
            meta.lastSuccessfulSyncAt = new Date().toISOString();
            meta.lastSyncStatus = 'success';
            meta.lastSyncError = null;
            saveWebsiteSyncMetadata(meta);
            return { success: true, added: 0 };
        }
        // 목록에서 항목을 찾으면 연속 빈 결과 카운터 리셋
        consecutiveEmptyScraperRuns = 0;

        // 3. Fetch details for each unscraped index
        const newItems = [];
        let failedCount = 0;

        for (const idx of discoveredIndices) {
            const currentExtId = `ext_${idx}`;
            if (scrapedIds.has(currentExtId)) continue;

            try {
                console.log(`📥 [Scraper] Fetching details for idx: ${idx}`);
                const viewHtml = await transport.getViewHtml(idx);
                if (!viewHtml) {
                    failedCount++;
                    continue;
                }

                const extractField = (label) => {
                    const regex = new RegExp(`<label>${label}<\\/label>\\s*<div><strong>(.*?)<\\/strong><\\/div>`, 's');
                    const match = viewHtml.match(regex);
                    return match ? match[1].replace(/<br\s*\/?>/gi, '\n').trim() : '';
                };

                let regDate = extractField('등록일시');
                if (!regDate) {
                    const m = viewHtml.match(/<div><strong>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/strong><\/div>/);
                    regDate = m ? m[1] : '';
                }

                if (!regDate) {
                    console.warn(`⚠️ [Scraper] Missing registration date for idx ${idx}, counting as failed detail fetch.`);
                    failedCount++;
                    continue;
                }

                const birthDate = extractField('생년월일');
                const genderRaw = extractField('성별');
                const gender = genderRaw.includes('남') ? '남성' : (genderRaw.includes('여') ? '여성' : '기타');

                let age = 0;
                if (birthDate && birthDate.match(/^\d{4}/)) {
                    const birthYear = parseInt(birthDate.substring(0, 4));
                    age = new Date().getFullYear() - birthYear;
                }

                const agency = extractField('의뢰인기관명');
                let referralPath = '기타';
                if (agency.includes('행정복지센터') || agency.includes('동사무소') || agency.includes('면사무소')) referralPath = '읍면동 행정복지센터';
                else if (agency.includes('경찰')) referralPath = '경찰서';
                else if (agency.includes('소방') || agency.includes('119')) referralPath = '소방';
                else if (agency.includes('보건소')) referralPath = '보건소';
                else if (agency.includes('병원') || agency.includes('의료원') || agency.includes('의원')) referralPath = '의료기관';
                else if (agency.includes('이천시청') || agency.includes('시청')) referralPath = '이천시청';
                else if (agency) referralPath = '의뢰기관';

                const nowIso = new Date().toISOString();
                const item = {
                    id: currentExtId,
                    externalIdx: currentExtId,
                    externalReferralId: String(idx),
                    name: extractField('이름'),
                    phone: extractField('연락처'),
                    gender: gender,
                    age: age,
                    birthDate: birthDate,
                    address: extractField('주소'),
                    medicalInsurance: extractField('의료보장'),
                    disabilityStatus: extractField('장애등록여부'),
                    problem: extractField('주문제'),
                    guardianPresence: extractField('보호자유무'),
                    guardianName: extractField('보호자성명'),
                    guardianRelation: extractField('보호자관계'),
                    guardianPhone: extractField('보호자연락처'),
                    guardianNotes: extractField('보호자기타내용'),
                    consentToReferral: extractField('센터의뢰동의여부'),
                    consentNotes: extractField('센터의뢰동의여부기타내용'),
                    reason: extractField('의뢰이유'),
                    agency: agency,
                    agencyPhone: extractField('의뢰인연락처'),
                    requesterName: extractField('의뢰인이름'),
                    requesterFax: extractField('의뢰인팩스'),
                    requesterEmail: extractField('의뢰인이메일'),
                    registrationDate: regDate.split(' ')[0],
                    externalReceivedAt: regDate,
                    createdAt: regDate,
                    firstScrapedAt: nowIso,
                    lastSyncedAt: nowIso,
                    referralPath: referralPath,
                    isWebsiteReferral: true,
                    websiteReferralSeenAt: null,
                    status: 'pending'
                };

                // [Security] Quarantine check for automated scanner probes / test spam
                const isSpamProbe = /sparrow|dast|<script|onload=|javascript:|alert\(/i.test(
                    `${item.name} ${item.phone} ${item.problem} ${item.reason} ${item.requesterName}`
                );
                if (isSpamProbe) {
                    console.warn(`🛡️ [SCRAPER QUARANTINE] Quarantined security probe/spam: ${item.name} (${currentExtId})`);
                    const quarantined = getData('QuarantinedReferrals', []);
                    quarantined.push({ ...item, quarantinedAt: nowIso, reason: 'Automated scanner probe detected' });
                    saveData('QuarantinedReferrals', quarantined);
                    scrapedIds.add(currentExtId);
                    continue;
                }

                // [Constraint] Only collect referrals from 2026-09-01 KST onward
                if (!isAllowedWebsiteReferralPeriod(regDate)) {
                    console.log(`⏩ [Scraper] Skipping ${item.name} (${currentExtId}) - registration date prior to September 2026 (${regDate})`);
                    // [Track B hotfix] 최종관리자 확정 기준: 날짜 조건 skip 시 scrapedIds에 추가하지
                    // 않는다 (재수집 영구 차단 방지). 스팸 격리·등록済み·중복 방지의 scrapedIds.add는 유지.
                    continue;
                }

                if (item.name) {
                    const isAlreadyRegistered = referrals.some(r => {
                        const nameMatch = r.name && r.name.trim() === item.name.trim();
                        if (!nameMatch) return false;

                        const rPhone = normalizePhone(r.phone);
                        const itemPhone = normalizePhone(item.phone);
                        if (rPhone && itemPhone && rPhone === itemPhone) return true;

                        if (r.birthDate && item.birthDate && r.birthDate.trim() === item.birthDate.trim()) return true;

                        return false;
                    });

                    if (isAlreadyRegistered) {
                        console.log(`ℹ️ [Scraper] Skipping ${item.name} because they are already registered in the system.`);
                        scrapedIds.add(currentExtId);
                        continue;
                    }

                    newItems.push(item);
                    scrapedIds.add(currentExtId);
                    console.log(`✅ [Scraper] Successfully scraped: ${item.name} (${currentExtId})`);
                }
            } catch (detailErr) {
                console.warn(`❌ [Scraper] Error fetching detail for idx ${idx}:`, detailErr.message);
                failedCount++;
            }
        }

        if (newItems.length > 0) {
            const updatedPending = [...newItems, ...existingPending];
            await persistData('PendingReferrals', updatedPending);
            console.log(`🚀 [Scraper] Added ${newItems.length} new external referrals`);
        } else {
            console.log('😴 [Scraper] No new referrals to add');
        }

        meta.lastSuccessfulSyncAt = new Date().toISOString();
        meta.lastSyncStatus = 'success';
        meta.lastSyncError = null;
        meta.failedDetailCount = failedCount;
        await saveWebsiteSyncMetadata(meta);
        await persistData('ScrapedExternalIds', Array.from(scrapedIds));

        return { success: true, added: newItems.length };
    } catch (err) {
        console.error('❌ [Scraper] Error during external fetch:', err);
        meta.lastSyncStatus = 'failed';
        meta.lastSyncError = err.message;
        await saveWebsiteSyncMetadata(meta);
        return { success: false, error: err.message };
    } finally {
        if (transport) {
            try { await transport.close(); } catch (closeErr) {
                console.warn('⚠️ [Scraper] transport.close() failed:', closeErr.message);
            }
        }
        activeScraperTransport = null;
        isWebsiteSyncing = false;
    }
}

// [Headless 2026-10-14] 타임아웃 래퍼: 브라우저 hang 방지 (기본 8분).
// 내부 함수의 finally가 transport 정리·플래그 해제를 보장하므로,
// 타임아웃 시에는 여기서 강제 종료 + 메타데이터 기록만 수행.
async function fetchExternalReferrals(options = {}) {
    const timeoutMs = parseInt(process.env.SCRAPER_TIMEOUT_MS || '480000', 10);
    try {
        return await Promise.race([
            fetchExternalReferralsInner(options),
            new Promise((_, reject) => setTimeout(async () => {
                if (activeScraperTransport) {
                    try { await activeScraperTransport.close(); } catch {}
                    activeScraperTransport = null;
                }
                reject(new Error(`Scraper timed out after ${timeoutMs}ms`));
            }, timeoutMs)),
        ]);
    } catch (err) {
        if (err.message && err.message.includes('timed out')) {
            console.error('❌ [Scraper]', err.message);
            const meta = getWebsiteSyncMetadata();
            meta.lastAttemptedSyncAt = new Date().toISOString();
            meta.lastSyncStatus = 'failed';
            meta.lastSyncError = err.message;
            await saveWebsiteSyncMetadata(meta);
            return { success: false, error: err.message };
        }
        throw err;
    }
}

function getWebsiteReferralsSummary() {
    const meta = getWebsiteSyncMetadata();
    const referrals = getData('Referrals', []);
    const pendingReferrals = getData('PendingReferrals', []);

    const periodStart = '2026-09-01T00:00:00+09:00';
    const septMap = new Map();

    // 1. Pending referrals
    pendingReferrals.forEach(p => {
        if (!isWebsiteReferralItem(p)) return;
        const extId = p.externalIdx || (p.id && String(p.id).startsWith('ext_') ? p.id : null);
        if (!extId && !p.isWebsiteReferral) return;

        const key = extId || p.id;
        const receivedAt = p.externalReceivedAt || p.registrationDate || p.createdAt || '';
        if (!isAllowedWebsiteReferralPeriod(receivedAt)) return;

        const isSeen = !!(meta.seenExternalIds && meta.seenExternalIds[key]) || !!p.websiteReferralSeenAt;

        septMap.set(key, {
            id: p.id || key,
            externalIdx: extId || key,
            externalReferralId: p.externalReferralId || (extId ? extId.replace(/^ext_/, '') : undefined),
            name: p.name,
            phone: p.phone,
            gender: p.gender,
            age: p.age,
            birthDate: p.birthDate,
            address: p.address,
            agency: p.agency,
            agencyPhone: p.agencyPhone,
            requesterName: p.requesterName,
            requesterPhone: p.requesterPhone || p.agencyPhone,
            problem: p.problem,
            reason: p.reason,
            externalReceivedAt: p.externalReceivedAt || receivedAt,
            firstScrapedAt: p.firstScrapedAt || p.createdAt,
            lastSyncedAt: p.lastSyncedAt || meta.lastSuccessfulSyncAt,
            referralPath: p.referralPath || '홈페이지',
            isWebsiteReferral: true,
            status: p.status === 'completed' ? 'completed' : (p.status === 'processing' ? 'processing' : 'pending'),
            isSeen: isSeen,
            websiteReferralSeenAt: p.websiteReferralSeenAt || (meta.seenExternalIds ? meta.seenExternalIds[key] : null),
            source: 'pending'
        });
    });

    // 2. Registered referrals (registered items override pending if matching)
    referrals.forEach(r => {
        if (!isWebsiteReferralItem(r)) return;
        const extId = r.externalIdx || (r.id && String(r.id).startsWith('ext_') ? r.id : null);
        if (!extId && !r.isWebsiteReferral) return;

        const key = extId || r.refNo || r.referralId;
        const receivedAt = r.externalReceivedAt || r.registrationDate || r.requestDate || r.createdAt || '';
        if (!isAllowedWebsiteReferralPeriod(receivedAt)) return;

        const status = r.closureStatus === '종결' ? 'completed' : 'processing';
        const isSeen = true; // Registered items have been reviewed

        septMap.set(key, {
            id: r.referralId || r.id || key,
            externalIdx: extId || key,
            externalReferralId: extId ? extId.replace(/^ext_/, '') : undefined,
            name: r.name,
            phone: r.phone,
            gender: r.gender,
            age: r.age,
            birthDate: r.birthDate,
            address: r.address,
            agency: r.requestAgency || r.agency,
            agencyPhone: r.requesterPhone || r.agencyPhone,
            requesterName: r.requesterName || r.requestorName,
            requesterPhone: r.requesterPhone,
            problem: r.problem,
            reason: r.reason,
            externalReceivedAt: r.externalReceivedAt || receivedAt,
            firstScrapedAt: r.firstScrapedAt || r.createdAt,
            lastSyncedAt: r.lastSyncedAt || meta.lastSuccessfulSyncAt,
            referralPath: r.referralPath || '홈페이지',
            isWebsiteReferral: true,
            status: status,
            isSeen: isSeen,
            websiteReferralSeenAt: r.websiteReferralSeenAt || meta.lastSuccessfulSyncAt,
            refNo: r.refNo,
            source: 'registered'
        });
    });

    const items = Array.from(septMap.values());
    items.sort((a, b) => (b.externalReceivedAt || '').localeCompare(a.externalReceivedAt || ''));

    const total = items.length;
    const unseen = items.filter(i => !i.isSeen).length;
    const pending = items.filter(i => i.status === 'pending').length;
    const processing = items.filter(i => i.status === 'processing').length;
    const completed = items.filter(i => i.status === 'completed').length;

    return {
        success: true,
        periodStart,
        total,
        unseen,
        pending,
        processing,
        completed,
        failedDetailCount: meta.failedDetailCount || 0,
        lastSuccessfulSyncAt: meta.lastSuccessfulSyncAt,
        lastSyncStatus: meta.lastSyncStatus || 'idle',
        lastSyncError: meta.lastSyncError || null,
        syncInProgress: isWebsiteSyncing,
        items
    };
}

// ----------------------------------------------------
// 🌐 Website Referral Summary & Sync Endpoints
// ----------------------------------------------------
app.get('/api/website-referrals/summary', requireAuth, (req, res) => {
    res.json(getWebsiteReferralsSummary());
});

app.post('/api/website-referrals/sync', requireAuth, async (req, res) => {
    try {
        await fetchExternalReferrals({ force: true });
        res.json(getWebsiteReferralsSummary());
    } catch (err) {
        console.error('Error during website-referrals/sync:', err);
        res.status(500).json({
            success: false,
            error: err.message,
            summary: getWebsiteReferralsSummary()
        });
    }
});

// Backwards-compatible alias for pending-referrals/sync
app.post('/api/pending-referrals/sync', requireAuth, async (req, res) => {
    try {
        await fetchExternalReferrals({ force: true });
        res.json(getWebsiteReferralsSummary());
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/website-referrals/mark-seen', requireAuth, async (req, res) => {
    try {
        const { ids } = req.body || {};
        const meta = getWebsiteSyncMetadata();
        const now = new Date().toISOString();
        const pendingReferrals = getData('PendingReferrals', []);

        if (Array.isArray(ids) && ids.length > 0) {
            ids.forEach(id => {
                meta.seenExternalIds[id] = now;
            });
            pendingReferrals.forEach(p => {
                if (isWebsiteReferralItem(p) && (ids.includes(p.id) || ids.includes(p.externalIdx))) {
                    p.websiteReferralSeenAt = now;
                }
            });
        } else {
            const summary = getWebsiteReferralsSummary();
            summary.items.forEach(item => {
                if (item.externalIdx) meta.seenExternalIds[item.externalIdx] = now;
                if (item.id) meta.seenExternalIds[item.id] = now;
            });
            pendingReferrals.forEach(p => {
                if (isWebsiteReferralItem(p) && isAllowedWebsiteReferralPeriod(p.externalReceivedAt || p.registrationDate || p.createdAt || '')) {
                    p.websiteReferralSeenAt = now;
                }
            });
        }

        await saveWebsiteSyncMetadata(meta);
        await persistData('PendingReferrals', pendingReferrals);

        res.json(getWebsiteReferralsSummary());
    } catch (err) {
        console.error('Error in mark-seen:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// [Auto-Migration] Ensure NAS Referrals.json has required stable identifiers on startup
// F3: Never silently renumber duplicate refNos. Instead, log console warning and audit log (count only).
const sanitizeReferralsOnStartup = async () => {
    try {
        const referrals = getData('Referrals', []);
        if (!Array.isArray(referrals) || referrals.length === 0) return;

        const seenRefNos = new Set();
        let fixCount = 0;
        let dupRefCount = 0;
        let missingRefCount = 0;

        referrals.forEach(r => {
            if (!r) return;
            if (!r.referralId) {
                r.referralId = crypto.randomUUID();
                fixCount++;
            }
            if (!r.clientId) {
                r.clientId = `C${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                fixCount++;
            }
            if (!r.version) {
                r.version = 1;
                fixCount++;
            }

            const currentRefNo = r.refNo;
            if (!currentRefNo) {
                missingRefCount++;
                console.warn(`⚠️ [STARTUP] Record ${r.referralId} has missing refNo. Retaining record without silent renumber.`);
            } else if (seenRefNos.has(currentRefNo)) {
                dupRefCount++;
                console.warn(`⚠️ [STARTUP] Duplicate refNo detected: ${currentRefNo}. Retaining record without silent renumber.`);
            } else {
                seenRefNos.add(currentRefNo);
            }
        });

        if (dupRefCount > 0 || missingRefCount > 0) {
            console.warn(`⚠️ [STARTUP] Found ${dupRefCount} duplicate refNos and ${missingRefCount} missing refNos. Retained without silent mutation.`);
            referralAuditLogger({
                actorUserId: 'system',
                targetId: `count:${dupRefCount + missingRefCount}`,
                action: 'STARTUP_REFNO_ANOMALY_DETECTED',
                result: 'WARNING',
                reasonCode: 'DUPLICATE_OR_MISSING_REFNO'
            });
        }

        if (fixCount > 0) {
            console.log(`🧹 [STARTUP] Auto-generated ${fixCount} missing identifiers (referralId/clientId/version). Persisting...`);
            await persistData('Referrals', referrals);
            console.log(`✅ [STARTUP] Identifier migration complete.`);
        }
    } catch (e) {
        console.warn('⚠️ [STARTUP] Notice in sanitizeReferralsOnStartup:', e.message);
    }
};

// Initial check and set interval
setTimeout(fetchExternalReferrals, 5000); // 5초 후 최초 1회 실행
setInterval(fetchExternalReferrals, EXTERNAL_CONFIG.pollInterval); // 30분 주기

// START SERVER
app.listen(PORT, async () => {
    console.log(`🚀 이천센터 의뢰관리시스템 v${SERVER_VERSION} 서버 실행 중 (포트: ${PORT})`);
    await sanitizeReferralsOnStartup();
});

// API Catch-all 404 handler (prevents SPA HTML fallback for missing API endpoints)
app.all('/api/*', (req, res) => {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: '요청한 API 엔드포인트를 찾을 수 없습니다.'
        }
    });
});

// Catch-all for Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

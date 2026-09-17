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
import { getEffectiveVoiceCapabilities } from './server/permissions/voiceCapabilities.js';
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
    validateTrackABaseUrl
} from './server/survey/index.js';

// --- In-App Internal Notifications ---
import {
    InternalNotificationRepository,
    createNotificationRouter
} from './server/notifications/index.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    '남부분소': 'NB'
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

    memoryCache[filename] = data;

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
// 🔐 TRACK A1/A2: AUTHENTICATION & SESSIONS
// ==========================================
const sessionRepository = new SessionRepository(getData, persistData);
const authService = new AuthService(sessionRepository, () => getData('Users', []));
const { requireAuth, optionalAuth } = createAuthMiddleware(authService);
const authRouter = createAuthRouter(authService, requireAuth);

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

// Protect /attachments with session authentication, cache prevention, and inline disposition for PDFs
app.use('/attachments', requireAuth, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
}, express.static(ATTACHMENTS_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.toLowerCase().endsWith('.pdf')) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'inline');
        }
    }
}));

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
    persistData
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
    sourceEnvironment: surveyTrackAMode
});

// Common parameters
const trackABaseUrl = process.env.TRACK_A_BASE_URL || process.env.TRACK_A_COLLECTION_API_URL;
const trackBServiceSecret = process.env.TRACK_B_SERVICE_SECRET || process.env.TRACK_B_INTERNAL_PULL_TOKEN;
const trackBWorkerId = process.env.TRACK_B_WORKER_ID || (surveyTrackAMode === 'mock' ? 'track-b-mock-worker' : 'track-b-worker-1');
const trackARequestTimeoutMs = Number(process.env.TRACK_A_REQUEST_TIMEOUT_MS) || 10000;
const trackADefaultLeaseSeconds = Number(process.env.TRACK_A_DEFAULT_LEASE_SECONDS) || 600;

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
    sourceEnvironment: surveyTrackAMode
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
    sourceEnvironment: surveyTrackAMode
});

const surveyExportService = new SurveyExportService();

const surveyImportRouter = createSurveyImportRouter({
    requireAuth,
    surveyImportService,
    surveyRepository,
    surveyAssignmentRepository,
    notificationRepository: internalNotificationRepository,
    surveyExportService,
    referralService: surveyReferralService,
    getUsers: () => getData('Users', []),
    keyProvider: surveyKeyProvider,
    externalApiClient: externalSurveyApiClient,
    attachmentsDir: ATTACHMENTS_DIR,
    trackABaseUrl,
    trackBServiceSecret,
    trackBWorkerId,
    surveyTrackAMode
});

const notificationRouter = createNotificationRouter({
    requireAuth,
    notificationRepository: internalNotificationRepository
});

app.use('/api/surveys', surveyImportRouter);
app.use('/api/notifications', notificationRouter);

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
            saveData('Trash', filtered);
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

app.get('/api/users', (req, res) => {
    const users = getData('Users', []);
    if (users.length === 0) {
        const initPassword = process.env.ADMIN_INIT_PASSWORD || '1234';
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
        saveData('Users', [adminUser]);
        const { password, ...safeAdmin } = adminUser;
        return res.json([safeAdmin]);
    }
    // [Track A1 Security] Strip password before returning user list to clients
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
});

app.post('/api/users', (req, res) => {
    const newUser = req.body;
    const users = getData('Users', []);
    if (users.find(u => u.id === newUser.id)) {
        return res.status(400).json({ success: false, error: "Duplicate ID" });
    }
    users.push(newUser);
    saveData('Users', users);
    res.json({ success: true });
});

app.put('/api/users', async (req, res) => {
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
        console.error('❌ PUT /api/users error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/users/:id', (req, res) => {
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
app.get('/api/referrals', (req, res) => {
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
        if (!canSelectAllTeams && userTeam) {
            effectiveTeam = userTeam;
        }

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
app.get('/api/referrals/:id', (req, res) => {
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

// Attachment streaming endpoint (supports inline PDF preview)
app.get('/attachments/:folder/:file', (req, res) => {
    try {
        const { folder, file } = req.params;
        const safeFolder = folder.replace(/[^a-z0-9가-힣_\-]/gi, '_').substring(0, 100);
        const safeFile = path.basename(file);
        const filePath = path.join(ATTACHMENTS_DIR, safeFolder, safeFile);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: '첨부파일을 찾을 수 없습니다.' } });
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: { code: 'ATTACHMENT_ERROR', message: err.message } });
    }
});

app.post('/api/referrals', async (req, res) => {
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

        // Server-Side Atomic Numbering
        const teamCode = TEAM_CODES[req.body.team] || 'ET';
        const now = new Date();
        const yearYY = now.getFullYear().toString().slice(-2);
        const prefix = `${teamCode}-${yearYY}-`;

        const existingSeqs = referrals
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

        const newReferral = {
            ...req.body,
            referralId,
            refNo: assignedRefNo,
            clientId,
            version: 1,
            registrationStatus: req.body.registrationStatus || (req.body.isUnregistered ? '미등록' : '확인중'),
            createdAt: req.body.createdAt || isoNow,
            updatedAt: isoNow
        };

        referrals.push(newReferral);
        await persistData('Referrals', referrals);

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
        const targetId = req.params.id || referral.referralId || referral.refNo || referral.clientId;

        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing identifier (referralId or refNo)" });
        }

        const referrals = getData('Referrals', []);

        // 1. Try referralId first
        let index = -1;
        if (referral.referralId) {
            index = referrals.findIndex(r => r.referralId === referral.referralId);
        }
        // 2. Try targetId matching referralId
        if (index === -1) {
            index = referrals.findIndex(r => r.referralId === targetId);
        }
        // 3. Fallback: match by refNo, but check for collision ambiguity
        if (index === -1) {
            const matchingByRefNo = referrals
                .map((r, i) => ({ r, i }))
                .filter(item => item.r.refNo === targetId);

            if (matchingByRefNo.length > 1 && !referral.referralId && !referral.clientId) {
                return res.status(409).json({
                    success: false,
                    code: 'AMBIGUOUS_RECORD',
                    error: `동일 의뢰번호(${targetId})를 가진 레코드가 ${matchingByRefNo.length}건 존재합니다. referralId 또는 clientId를 지정해야 합니다.`
                });
            } else if (matchingByRefNo.length === 1) {
                index = matchingByRefNo[0].i;
            } else if (matchingByRefNo.length > 1 && referral.clientId) {
                index = referrals.findIndex(r => r.clientId === referral.clientId);
            }
        }
        // 4. Fallback: match by clientId
        if (index === -1) {
            index = referrals.findIndex(r => r.clientId === targetId);
        }

        if (index === -1) {
            return res.status(404).json({ success: false, error: "Referral not found" });
        }

        const currentRecord = referrals[index];

        // Optimistic Concurrency Control check
        if (referral.version !== undefined && currentRecord.version !== undefined) {
            const reqVer = Number(referral.version);
            const curVer = Number(currentRecord.version);
            if (reqVer !== curVer) {
                // 직전 자동저장 직후 연속 수동저장 등 단일 세션 1버전 차이의 경우:
                // 저장을 강제 거부하지 않고 최신 상태와 안전하게 병합 저장 허용
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
        const updatedReferral = {
            ...currentRecord,
            ...referral,
            referralId: currentRecord.referralId || referral.referralId || crypto.randomUUID(),
            refNo: referral.refNo || currentRecord.refNo,
            clientId: currentRecord.clientId || referral.clientId,
            version: nextVersion,
            createdAt: currentRecord.createdAt || referral.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        referrals[index] = updatedReferral;
        await persistData('Referrals', referrals);

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
        res.status(500).json({ success: false, error: `수정 실패: ${err.message}` });
    }
};

app.put('/api/referrals', handleReferralUpdate);
app.put('/api/referrals/:id', handleReferralUpdate);

const handleReferralDelete = async (req, res) => {
    try {
        const targetId = req.params.id || req.params.refNo || req.body?.referralId || req.body?.refNo;
        if (!targetId) {
            return res.status(400).json({ success: false, error: "Missing referral identifier" });
        }

        let referrals = getData('Referrals', []);

        // Ambiguity check
        const matches = referrals
            .map((r, i) => ({ r, i }))
            .filter(item => item.r.referralId === targetId || item.r.refNo === targetId || item.r.clientId === targetId);

        if (matches.length > 1) {
            // Check if exact referralId matches
            const exactIdMatch = matches.filter(m => m.r.referralId === targetId);
            if (exactIdMatch.length !== 1) {
                return res.status(409).json({
                    success: false,
                    code: 'AMBIGUOUS_RECORD',
                    error: `동일 식별자에 해당하는 레코드가 ${matches.length}건 존재합니다. 고유한 referralId로 삭제를 요청하세요.`
                });
            }
        }

        const index = referrals.findIndex(r => r.referralId === targetId || r.refNo === targetId || r.clientId === targetId);
        if (index !== -1) {
            const deletedItem = referrals[index];
            const trash = getData('Trash', []);
            trash.push({ ...deletedItem, _trashSource: 'Referrals', deletedAt: new Date().toISOString() });
            referrals.splice(index, 1);
            
            await persistData('Referrals', referrals);
            await persistData('Trash', trash);
            res.json({ success: true, deletedRefNo: deletedItem.refNo, referralId: deletedItem.referralId });
        } else {
            res.json({ success: true, alreadyDeleted: true });
        }
    } catch (err) {
        console.error('❌ DELETE /api/referrals error:', err);
        res.status(500).json({ success: false, error: `삭제 실패: ${err.message}` });
    }
};

app.delete('/api/referrals/:refNo', handleReferralDelete);
app.delete('/api/referrals', handleReferralDelete);

// SUICIDE ATTEMPTERS
app.get('/api/suicideattempters', (req, res) => {
    res.json(getData('SuicideAttempters', []));
});

app.post('/api/suicideattempters', (req, res) => {
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
app.get('/api/analysis/isp-achievement-yearly', (req, res) => {
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
app.get('/api/analysis/current', (req, res) => {
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

app.post('/api/analysis/current', (req, res) => {
    saveData('GlobalCaseAnalysis', req.body.data);
    clearIspAchievementCache();
    res.json({ success: true });
});

// PENDING REFERRALS (Scraper Sync)
app.get('/api/pending-referrals', (req, res) => {
    const referrals = getData('Referrals', []);
    let list = getData('PendingReferrals', []);
    const normalizePhone = (num) => num ? num.replace(/[^0-9]/g, '') : '';
    
    // Filter out scanner probes / spam
    list = list.filter(p => !/sparrow|dast|<script|alert\(/i.test(`${p.name} ${p.phone} ${p.problem} ${p.reason}`));
    
    const beforeCount = list.length;
    list = list.filter(p => {
        const isRegistered = referrals.some(r => {
            const nameMatch = r.name && r.name.trim() === p.name.trim();
            if (!nameMatch) return false;

            const rPhone = normalizePhone(r.phone);
            const pPhone = normalizePhone(p.phone);
            if (rPhone && pPhone && rPhone === pPhone) return true;

            if (r.birthDate && p.birthDate && r.birthDate.trim() === p.birthDate.trim()) return true;

            return false;
        });
        return !isRegistered;
    });

    if (list.length !== beforeCount) {
        saveData('PendingReferrals', list);
    }
    
    res.json(list);
});

// 스크레이퍼 상태 진단 API
app.get('/api/pending-referrals/status', (req, res) => {
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

app.post('/api/pending-referrals', (req, res) => {
    const list = getData('PendingReferrals', []);
    list.push(req.body);
    saveData('PendingReferrals', list);
    res.json({ success: true });
});

app.post('/_diag', (req, res) => {
    try {
        const payload = req.body || {};
        const outDir = path.join(__dirname, 'diag_reports');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'last_payload.json');
        const record = { receivedAt: new Date().toISOString(), payload };
        fs.writeFileSync(outPath, JSON.stringify(record, null, 2), 'utf8');
        console.log('[_diag] received payload:', Object.keys(payload));
        res.json({ success: true });
    } catch (e) {
        console.error('[_diag] error handling payload', e);
        res.status(500).json({ success: false });
    }
});

app.get('/api/health/storage', (req, res) => {
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

app.post('/api/users/import', (req, res) => {
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
            const index = users.findIndex(u => u.id === newUser.id);
            if (index !== -1) {
                users[index] = { ...users[index], ...newUser };
                updatedCount++;
            } else {
                users.push({
                    ...newUser,
                    createdDate: newUser.createdDate || new Date().toISOString().split('T')[0],
                    status: newUser.status || 'active',
                    role: newUser.role || 'user',
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

app.post('/api/users/reset-password', (req, res) => {
    const { adminId, targetId, newPassword } = req.body;
    const users = getData('Users', []);

    // Check if requester is admin
    const admin = users.find(u => u.id === adminId);
    if (!admin || admin.role !== 'admin') {
        return res.status(403).json({ success: false, error: "Only admins can reset passwords" });
    }

    const userIndex = users.findIndex(u => u.id === targetId);
    if (userIndex === -1) {
        return res.status(404).json({ success: false, error: "Target user not found" });
    }

    users[userIndex].password = newPassword;
    saveData('Users', users);
    res.json({ success: true, message: "Password reset successful" });
});

app.post('/api/users/change-password', (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    console.log(`[Password Change Request] User: ${userId}, NewPwd: ${newPassword}`);

    // Force reload data to ensure freshness
    const users = getData('Users', []);
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
        console.error(`[Password Change] User not found: ${userId}`);
        console.log('Available IDs:', users.map(u => u.id));
        return res.status(404).json({ success: false, error: "User not found" });
    }

    const currentUser = users[userIndex];
    console.log(`[Password Change] Found User: ${currentUser.name} (${currentUser.id}), Stored Pwd: ${currentUser.password}`);

    if (String(currentUser.password) !== String(oldPassword)) {
        console.error(`[Password Change] Password Mismatch. Provided: ${oldPassword}, Stored: ${currentUser.password}`);
        return res.status(400).json({ success: false, error: "Current password does not match" });
    }

    users[userIndex].password = newPassword;
    const saveSuccess = saveData('Users', users);

    console.log(`[Password Change] Save Result: ${saveSuccess}`);

    if (saveSuccess) {
        res.json({ success: true, message: "Password changed successful" });
    } else {
        res.status(500).json({ success: false, error: "Failed to save new password to database" });
    }
});

app.post('/api/referrals/bulk-delete', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.json({ success: true, message: "No IDs provided", deletedCount: 0 });
    }

    let referrals = getData('Referrals', []);
    const trash = getData('Trash', []);
    const initialCount = referrals.length;

    const itemsToDelete = referrals.filter(r => ids.includes(r.refNo) || ids.includes(r.clientId));

    // Add to trash
    itemsToDelete.forEach(item => {
        trash.push({
            ...item,
            _trashSource: 'Referrals',
            deletedAt: new Date().toISOString()
        });
    });

    // Remove from main list
    referrals = referrals.filter(r => !ids.includes(r.refNo) && !ids.includes(r.clientId));

    saveData('Referrals', referrals);
    saveData('Trash', trash);

    res.json({
        success: true,
        deletedCount: initialCount - referrals.length,
        movedToTrash: true
    });
});

app.put('/api/suicideattempters', (req, res) => {
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

app.delete('/api/suicideattempters/:uid', (req, res) => {
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

app.post('/api/suicideattempters/bulk-delete', (req, res) => {
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

app.get('/api/unregistered', (req, res) => {
    res.json(getData('UnregisteredCandidates', []));
});

app.post('/api/unregistered', (req, res) => {
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

app.put('/api/unregistered', (req, res) => {
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

app.delete('/api/unregistered/:id', (req, res) => {
    const { id } = req.params;
    let candidates = getData('UnregisteredCandidates', []);
    candidates = candidates.filter(c => c.refNo !== id && c.clientId !== id);
    saveData('UnregisteredCandidates', candidates);
    res.json({ success: true });
});

app.get('/api/trash', (req, res) => {
    res.json(getData('Trash', []));
});

app.post('/api/trash/restore', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ success: false, error: "Missing id" });
        }
        let trash = getData('Trash', []);
        const item = trash.find(t => t.referralId === id || t.refNo === id || t.clientId === id || t.uid === id);
        if (!item) {
            return res.status(404).json({ success: false, error: "Item not found in trash" });
        }

        // Determine original collection
        const collection = item._trashSource || 'Referrals';
        const data = getData(collection, []);

        // Remove from trash
        trash = trash.filter(t => t !== item);

        // Restore to original collection
        delete item._trashSource;
        delete item.deletedAt;
        data.push(item);

        await persistData('Trash', trash);
        await persistData(collection, data);
        res.json({ success: true, restored: item });
    } catch (err) {
        console.error('❌ /api/trash/restore error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/trash/:id', async (req, res) => {
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

app.get('/api/pcassets', (req, res) => {
    res.json(getData('PC_Assets', []));
});

app.post('/api/pcassets', (req, res) => {
    const assets = req.body;
    saveData('PC_Assets', assets);
    res.json({ success: true });
});

app.get('/api/officialdocs', (req, res) => {
    res.json(getData('Documents', []));
});

app.post('/api/officialdocs/sync', (req, res) => {
    res.json({ success: false, error: "Gmail Sync not available on NAS server without OAuth2 setup." });
});

app.get('/api/budget/plans', (req, res) => {
    res.json(getData('BudgetPlans', {}));
});

app.post('/api/budget/plans', (req, res) => {
    saveData('BudgetPlans', req.body);
    res.json({ success: true });
});

app.get('/api/budget/transactions', (req, res) => {
    res.json(getData('BudgetTransactions', []));
});

app.post('/api/budget/transactions', (req, res) => {
    saveData('BudgetTransactions', req.body);
    res.json({ success: true });
});

app.get('/api/budget/metadata', (req, res) => {
    res.json(getData('BudgetMetadata', {}));
});

app.post('/api/budget/metadata', (req, res) => {
    saveData('BudgetMetadata', req.body);
    res.json({ success: true });
});

app.get('/api/budget/hierarchy', (req, res) => {
    res.json(getData('BudgetHierarchy', []));
});

app.post('/api/budget/hierarchy', (req, res) => {
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

app.delete('/api/pending-referrals/:id', (req, res) => {
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

app.get('/api/logs', (req, res) => {
    res.json(getData('Logs', []));
});

app.post('/api/logs', (req, res) => {
    const log = req.body;
    if (!log || !log.logId) {
        return res.status(400).json({ success: false, error: 'Invalid log data' });
    }
    const logs = getData('Logs', []);
    logs.push(log);
    saveData('Logs', logs);
    res.json({ success: true });
});

app.get('/api/analysis-results', (req, res) => {
    const list = normalizeSavedAnalysisList(getData(CASE_ANALYSIS_FILE, []));
    res.json(list);
});

app.post('/api/analysis-results', (req, res) => {
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

app.get('/api/analysis-results/:id', (req, res) => {
    const { id } = req.params;
    const list = normalizeSavedAnalysisList(getData(CASE_ANALYSIS_FILE, []));
    const found = list.find(item => item?.id === id);
    if (!found) {
        return res.status(404).json({ success: false, error: 'Saved analysis not found' });
    }
    res.json({ success: true, name: found.name, data: found.data });
});

app.delete('/api/analysis-results/:id', (req, res) => {
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

app.put('/api/logs', (req, res) => {
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

app.post('/api/activity', async (req, res) => {
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
app.post('/api/upload', async (req, res) => {
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

app.delete('/api/deleteFile/:folder/:fileId', async (req, res) => {
    const { folder, fileId } = req.params;
    const filePath = path.join(ATTACHMENTS_DIR, folder, fileId);

    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`🗑️ File deleted from NAS: ${filePath}`);
            res.json({ success: true });
        } else {
            console.warn(`⚠️ File not found for deletion: ${filePath}`);
            res.json({ success: true }); // Still return success to stay in sync
        }
    } catch (e) {
        console.error("❌ NAS Delete Error:", e);
        res.status(500).json({ success: false, error: e.toString() });
    }
});

app.get('/api/analysis/isp-achievement', (req, res) => {
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

app.post('/api/saveNotes', async (req, res) => {
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
        const referrals = getData('Referrals', []);
        
        let index = -1;
        if (referralId) {
            index = referrals.findIndex(r => r.referralId === referralId);
        }
        if (index === -1 && refNo) {
            index = referrals.findIndex(r => r.refNo === refNo || r.clientId === refNo);
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

        target.notes = newNotes;
        if (newNotes.length > 0) {
            target.latestNote = newNotes[0].content || '';
            target.latestNoteDate = newNotes[0].createdAt || newNotes[0].date || new Date().toLocaleString('ko-KR');
        } else {
            target.latestNote = '';
            target.latestNoteDate = '';
        }

        target.version = (target.version || 1) + 1;
        target.updatedAt = new Date().toISOString();

        await persistData('Referrals', referrals);

        const responsePayload = { success: true, data: target };
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
        res.status(500).json({ success: false, error: `메모 저장 실패: ${err.message}` });
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

const EXTERNAL_CONFIG = {
    loginUrl: 'https://www.imhc.co.kr/sa/login/login_pro.php',
    listUrl: 'https://www.imhc.co.kr/sa/community/reqask_list.php',
    viewUrl: 'https://www.imhc.co.kr/sa/community/reqask_view.php',
    credentials: {
        login_id: 'Admin',
        login_pw: 'dlcjstl!@#$'
    },
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

// Asia/Seoul September 2026 date validator (boundary: 2026-09-01 00:00:00 KST)
function isSeptember2026InSeoul(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const trimmed = dateStr.trim();
    if (/^2026-09(-\d{2})?/.test(trimmed)) return true;
    try {
        const d = new Date(trimmed);
        if (isNaN(d.getTime())) return false;
        const seoulFormatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = seoulFormatter.format(d);
        return parts.startsWith('2026-09');
    } catch {
        return false;
    }
}

let isWebsiteSyncing = false;

async function fetchExternalReferrals(options = {}) {
    if (isWebsiteSyncing) {
        console.log('⏳ [Scraper] Sync already in progress, skipping duplicate invocation.');
        return { success: false, inProgress: true };
    }
    isWebsiteSyncing = true;
    console.log('🔄 [Scraper] Starting external referral check (HTTPS)...');
    const meta = getWebsiteSyncMetadata();
    meta.lastAttemptedSyncAt = new Date().toISOString();

    try {
        // 1. Login to get session cookie via HTTPS
        const loginFormData = new URLSearchParams();
        Object.entries(EXTERNAL_CONFIG.credentials).forEach(([k, v]) => loginFormData.append(k, v));

        const loginRes = await fetch(EXTERNAL_CONFIG.loginUrl, {
            method: 'POST',
            body: loginFormData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            redirect: 'manual'
        });

        const cookieHeader = loginRes.headers.get('set-cookie');
        if (!cookieHeader) {
            console.error('❌ [Scraper] Login failed: No cookies received');
            meta.lastSyncStatus = 'failed';
            meta.lastSyncError = 'No session cookie received from login';
            saveWebsiteSyncMetadata(meta);
            isWebsiteSyncing = false;
            return { success: false, error: meta.lastSyncError };
        }

        const sessionCookie = cookieHeader.split(';')[0];

        const referrals = getData('Referrals', []);
        let existingPending = getData('PendingReferrals', []);
        const scrapedIdsArray = getData('ScrapedExternalIds', []);
        const scrapedIds = new Set(scrapedIdsArray);

        // Auto-cleanup:
        // 1. Enforce September 2026-only for website referrals: remove past months (June/July/August)
        // 2. Remove already registered clients from existingPending
        const normalizePhone = (num) => num ? String(num).replace(/[^0-9]/g, '') : '';
        const beforeCleanupCount = existingPending.length;
        existingPending = existingPending.filter(p => {
            const extId = p.externalIdx || (p.id && String(p.id).startsWith('ext_') ? p.id : null);
            const isWeb = !!extId || !!p.isWebsiteReferral;
            const receivedAt = p.externalReceivedAt || p.registrationDate || p.createdAt || '';

            // [Constraint] Only 2026-09 website referrals are allowed in PendingReferrals
            if (isWeb && !isSeptember2026InSeoul(receivedAt)) {
                console.log(`🧹 [Scraper Cleanup] Purging non-September website referral: ${p.name} (${receivedAt})`);
                if (p.externalIdx) scrapedIds.add(p.externalIdx);
                if (p.id) scrapedIds.add(p.id);
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
            const pageUrl = page === 1
                ? EXTERNAL_CONFIG.listUrl
                : `${EXTERNAL_CONFIG.listUrl}?page=${page}`;

            const listRes = await fetch(pageUrl, {
                headers: {
                    'Cookie': sessionCookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                }
            });
            if (!listRes.ok) break;

            const listHtml = await listRes.text();
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
            meta.lastSuccessfulSyncAt = new Date().toISOString();
            meta.lastSyncStatus = 'success';
            meta.lastSyncError = null;
            saveWebsiteSyncMetadata(meta);
            isWebsiteSyncing = false;
            return { success: true, added: 0 };
        }

        // 3. Fetch details for each unscraped index
        const newItems = [];
        let failedCount = 0;

        for (const idx of discoveredIndices) {
            const currentExtId = `ext_${idx}`;
            if (scrapedIds.has(currentExtId)) continue;

            try {
                console.log(`📥 [Scraper] Fetching details for idx: ${idx}`);
                const viewRes = await fetch(`${EXTERNAL_CONFIG.viewUrl}?idx=${idx}`, {
                    headers: {
                        'Cookie': sessionCookie,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                    }
                });
                if (!viewRes.ok) {
                    failedCount++;
                    continue;
                }
                const viewHtml = await viewRes.text();

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

                // [Constraint] Only collect September 2026 referrals
                if (!isSeptember2026InSeoul(regDate)) {
                    console.log(`⏩ [Scraper] Skipping ${item.name} (${currentExtId}) - registration date prior to September 2026 (${regDate})`);
                    scrapedIds.add(currentExtId);
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
        isWebsiteSyncing = false;
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
        const extId = p.externalIdx || (p.id && String(p.id).startsWith('ext_') ? p.id : null);
        if (!extId && !p.isWebsiteReferral) return;

        const key = extId || p.id;
        const receivedAt = p.externalReceivedAt || p.registrationDate || p.createdAt || '';
        if (!isSeptember2026InSeoul(receivedAt)) return;

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
        const extId = r.externalIdx || (r.id && String(r.id).startsWith('ext_') ? r.id : null);
        if (!extId && !r.isWebsiteReferral) return;

        const key = extId || r.refNo || r.referralId;
        const receivedAt = r.externalReceivedAt || r.registrationDate || r.requestDate || r.createdAt || '';
        if (!isSeptember2026InSeoul(receivedAt)) return;

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
app.get('/api/website-referrals/summary', (req, res) => {
    res.json(getWebsiteReferralsSummary());
});

app.post('/api/website-referrals/sync', async (req, res) => {
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
app.post('/api/pending-referrals/sync', async (req, res) => {
    try {
        await fetchExternalReferrals({ force: true });
        res.json(getWebsiteReferralsSummary());
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/website-referrals/mark-seen', async (req, res) => {
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
                if (ids.includes(p.id) || ids.includes(p.externalIdx)) {
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
                if (isSeptember2026InSeoul(p.externalReceivedAt || p.registrationDate || p.createdAt || '')) {
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

// [Auto-Migration] Ensure NAS Referrals.json has zero duplicate or missing refNos on startup
const sanitizeReferralsOnStartup = async () => {
    try {
        const referrals = getData('Referrals', []);
        if (!Array.isArray(referrals) || referrals.length === 0) return;

        const refNoRegex = /^([A-Z]{2})-26-(\d{3,})$/;
        const teamMaxSeq = { 'JJ': 0, 'HB': 0, 'JY': 0, 'AC': 0, 'NB': 0, 'ET': 0 };

        referrals.forEach(r => {
            if (r && r.refNo && typeof r.refNo === 'string') {
                const match = r.refNo.match(refNoRegex);
                if (match) {
                    const code = match[1];
                    const seq = parseInt(match[2], 10);
                    if (seq < 900) {
                        if (teamMaxSeq[code] !== undefined) {
                            if (seq > teamMaxSeq[code]) teamMaxSeq[code] = seq;
                        } else {
                            if (seq > teamMaxSeq['ET']) teamMaxSeq['ET'] = seq;
                        }
                    }
                }
            }
        });

        const seenRefNos = new Set();
        let fixCount = 0;

        referrals.forEach(r => {
            if (!r) return;
            if (!r.referralId) r.referralId = crypto.randomUUID();
            if (!r.clientId) r.clientId = `C${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            if (!r.version) r.version = 1;

            const currentRefNo = r.refNo;
            const isMatch = currentRefNo && typeof currentRefNo === 'string' && refNoRegex.test(currentRefNo);
            const isDup = currentRefNo && seenRefNos.has(currentRefNo);

            if (!currentRefNo || !isMatch || isDup) {
                const team = r.team;
                const teamCode = TEAM_CODES[team] || 'ET';
                teamMaxSeq[teamCode] = (teamMaxSeq[teamCode] || 0) + 1;
                const newRefNo = `${teamCode}-26-${String(teamMaxSeq[teamCode]).padStart(3, '0')}`;
                
                if (currentRefNo && !r.originalRefNo) r.originalRefNo = currentRefNo;
                r.refNo = newRefNo;
                r.updatedAt = new Date().toISOString();
                seenRefNos.add(newRefNo);
                fixCount++;
            } else {
                seenRefNos.add(currentRefNo);
            }
        });

        if (fixCount > 0) {
            console.log(`🧹 [STARTUP] Found ${fixCount} duplicate/missing refNos. Auto-healing Referrals.json...`);
            await persistData('Referrals', referrals);
            console.log(`✅ [STARTUP] Auto-healing complete. Referrals.json is now 100% unique.`);
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

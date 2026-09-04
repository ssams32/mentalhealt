/*
 * Copyright (c) 2026 이천시정신건강복지센터. All Rights Reserved.
 * 의뢰관리 전용 의뢰관리시스템 백엔드 서버
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
// [보안 개선] 의뢰관리 전용: 모든 출처 허용 (CORS는 실질적 보안이 아니므로 의뢰망에서는 허용)
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
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
        return res.status(400).json({ success: false, error: "Invalid JSON payload", details: err.message });
    }
    console.error('❌ [SERVER ERROR]:', err.stack);
    res.status(500).json({ success: false, error: "Internal Server Error", message: err.message });
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'app', 'data');
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.resolve(__dirname, 'docker', 'Data', 'attachments');

console.log('==========================================');
console.log('🚀 [SERVER STARTUP]');
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

// [Fix] Legacy URL Rewrite Middleware
app.use('/attachments', (req, res, next) => {
    const url = decodeURIComponent(req.url);
    if (url.includes('이천센터의뢰관리 파일저장소')) {
        req.url = req.url.replace(/이천센터의뢰관리 파일저장소\/의뢰관리 첨부파일/, 'legacy')
            .replace(/이천센터의뢰관리 파일저장소/, 'legacy');
    }
    next();
});
app.use('/attachments', express.static(ATTACHMENTS_DIR));

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

// Helper: Trigger asynchronous save to disk with retry
const triggerSave = async (filename) => {
    if (saveQueue[filename] && saveQueue[filename].isWriting) {
        saveQueue[filename].pending = true;
        return;
    }

    if (!saveQueue[filename]) {
        saveQueue[filename] = { isWriting: false, pending: false };
    }

    saveQueue[filename].isWriting = true;
    saveQueue[filename].pending = false;

    const filePath = path.join(DATA_DIR, `${filename}.json`);
    const dataToSave = JSON.stringify(memoryCache[filename], null, 2);

    const tryWrite = async () => {
        let retries = 3;
        for (let i = 0; i < retries; i++) {
            const tempPath = `${filePath}.tmp.${Date.now()}`;
            try {
                await fs.promises.writeFile(tempPath, dataToSave, 'utf8');
                await fs.promises.rename(tempPath, filePath);
                return;
            } catch (e) {
                console.error(`Attempt ${i + 1} failed saving to ${filePath}:`, e.message);
                if (fs.existsSync(tempPath)) {
                    try { await fs.promises.unlink(tempPath); } catch (ignore) { }
                }
                if (i === retries - 1) return;
                await new Promise(r => setTimeout(r, Math.pow(2, i) * 100));
            }
        }
    };

    await tryWrite();
    saveQueue[filename].isWriting = false;
    if (saveQueue[filename].pending) {
        triggerSave(filename);
    }
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

const saveData = (filename, data) => {
    if (filename.startsWith('Budget') || filename === 'Referrals' || filename === 'SuicideAttempters' || filename === 'Users') {
        createBackup(filename).catch(e => console.error(`Pre-save backup failed: ${e}`));
    }

    memoryCache[filename] = data;
    triggerSave(filename).catch(e => console.error(`Async save failed for ${filename}:`, e));
    return true;
};

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
        return res.json([{ ...safeAdmin, password: adminUser.password }]);
    }
    res.json(users);
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

app.put('/api/users', (req, res) => {
    const updatedUser = req.body;
    const users = getData('Users', []);
    const index = users.findIndex(u => u.id === updatedUser.id);
    if (index !== -1) {
        users[index] = updatedUser;
        saveData('Users', users);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false, error: "User not found" });
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
    res.json(getData('Referrals', []));
});

app.post('/api/referrals', (req, res) => {
    const referrals = getData('Referrals', []);
    referrals.push(req.body);
    saveData('Referrals', referrals);
    res.json({ success: true });
});

app.put('/api/referrals', (req, res) => {
    const referral = req.body;
    const referrals = getData('Referrals', []);
    const index = referrals.findIndex(r => r.refNo === referral.refNo);
    if (index !== -1) {
        referrals[index] = referral;
        saveData('Referrals', referrals);
        res.json({ success: true, data: referral });
    } else {
        res.status(404).json({ success: false, error: "Referral not found" });
    }
});

app.delete('/api/referrals/:refNo', (req, res) => {
    const { refNo } = req.params;
    let referrals = getData('Referrals', []);
    const index = referrals.findIndex(r => r.refNo === refNo || r.clientId === refNo);
    if (index !== -1) {
        const deletedItem = referrals[index];
        const trash = getData('Trash', []);
        trash.push({ ...deletedItem, _trashSource: 'Referrals', deletedAt: new Date().toISOString() });
        referrals.splice(index, 1);
        saveData('Referrals', referrals);
        saveData('Trash', trash);
        res.json({ success: true });
    } else {
        res.json({ success: true, alreadyDeleted: true });
    }
});

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
    res.json({ success: true, data: getData('GlobalCaseAnalysis', null) });
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

app.post('/api/trash/restore', (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ success: false, error: "Missing id" });
    }
    let trash = getData('Trash', []);
    const item = trash.find(t => t.refNo === id || t.clientId === id || t.uid === id);
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

    saveData('Trash', trash);
    saveData(collection, data);
    res.json({ success: true, restored: item });
});

app.delete('/api/trash/:id', (req, res) => {
    const { id } = req.params;
    let trash = getData('Trash', []);
    trash = trash.filter(t => t.refNo !== id && t.clientId !== id && t.uid !== id);
    saveData('Trash', trash);
    res.json({ success: true });
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

app.post('/api/activity', (req, res) => {
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
    saveData('ActivityLogs', activityLogs);
    res.json({ success: true });
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

app.post('/api/saveNotes', (req, res) => {
    const { refNo, notes } = req.body;
    const referrals = getData('Referrals', []);
    const index = referrals.findIndex(r => r.refNo === refNo);
    if (index !== -1) {
        referrals[index].notes = notes;
        saveData('Referrals', referrals);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: "Referral not found" });
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
    loginUrl: 'http://www.imhc.co.kr/sa/login/login_pro.php',
    listUrl: 'http://www.imhc.co.kr/sa/community/reqask_list.php',
    viewUrl: 'http://www.imhc.co.kr/sa/community/reqask_view.php',
    credentials: {
        login_id: 'Admin',
        login_pw: 'dlcjstl!@#$'
    },
    pollInterval: 30 * 60 * 1000 // 30 mins
};

async function fetchExternalReferrals() {
    console.log('🔄 [Scraper] Starting external referral check...');
    try {
        // 1. Login to get session cookie
        const loginFormData = new URLSearchParams();
        Object.entries(EXTERNAL_CONFIG.credentials).forEach(([k, v]) => loginFormData.append(k, v));

        const loginRes = await fetch(EXTERNAL_CONFIG.loginUrl, {
            method: 'POST',
            body: loginFormData,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            redirect: 'manual'
        });

        const cookieHeader = loginRes.headers.get('set-cookie');
        if (!cookieHeader) {
            console.error('❌ [Scraper] Login failed: No cookies received');
            return;
        }

        const sessionCookie = cookieHeader.split(';')[0];

        // 2. Fetch the list page
        const listRes = await fetch(EXTERNAL_CONFIG.listUrl, {
            headers: { 'Cookie': sessionCookie }
        });
        const listHtml = await listRes.text();

        // 3. Parse IDs (idx) from the list
        const idxMatches = [...listHtml.matchAll(/reqask_view\.php\?idx=([0-9]+)/g)];
        const indices = [...new Set(idxMatches.map(m => m[1]))].slice(0, 30);

        if (indices.length === 0) {
            console.log('ℹ️ [Scraper] No referrals found in list');
            return;
        }

        const referrals = getData('Referrals', []);
        let existingPending = getData('PendingReferrals', []);

        // Load persistent tracking of scraped IDs
        const scrapedIdsArray = getData('ScrapedExternalIds', []);
        const scrapedIds = new Set(scrapedIdsArray);

        const normalizePhone = (num) => num ? num.replace(/[^0-9]/g, '') : '';

        // Auto-cleanup: remove already registered clients from existingPending
        const beforeCleanupCount = existingPending.length;
        existingPending = existingPending.filter(p => {
            const isRegistered = referrals.some(r => {
                const nameMatch = r.name && r.name.trim() === p.name.trim();
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
            saveData('PendingReferrals', existingPending);
            saveData('ScrapedExternalIds', Array.from(scrapedIds));
        }

        existingPending.forEach(p => {
            if (p.externalIdx) scrapedIds.add(p.externalIdx);
            if (p.id) scrapedIds.add(p.id);
        });

        const newItems = [];

        // 4. Fetch details
        for (const idx of indices) {
            const currentExtId = `ext_${idx}`;
            if (scrapedIds.has(currentExtId)) continue;

            console.log(`📥 [Scraper] Fetching details for idx: ${idx}`);
            const viewRes = await fetch(`${EXTERNAL_CONFIG.viewUrl}?idx=${idx}`, {
                headers: { 'Cookie': sessionCookie }
            });
            const viewHtml = await viewRes.text();

            const extractField = (label) => {
                const regex = new RegExp(`<label>${label}<\/label>\\s*<div><strong>(.*?)<\/strong><\/div>`, 's');
                const match = viewHtml.match(regex);
                return match ? match[1].replace(/<br\s*\/?>/gi, '\n').trim() : '';
            };

            const registrationDateLine = viewHtml.match(/<div><strong>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/strong><\/div>/);
            const registrationDate = registrationDateLine ? registrationDateLine[1] : new Date().toISOString();

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
            else if (agency) referralPath = '의뢰기관';

            const item = {
                id: `ext_${idx}`,
                externalIdx: `ext_${idx}`,
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
                registrationDate: registrationDate.split(' ')[0],
                createdAt: registrationDate,
                referralPath: referralPath,
                isWebsiteReferral: true,
                status: 'pending'
            };

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
                    saveData('ScrapedExternalIds', Array.from(scrapedIds));
                    continue;
                }

                newItems.push(item);
                console.log(`✅ [Scraper] Successfully scraped: ${item.name}`);
            }
        }

        if (newItems.length > 0) {
            const updatedPending = [...newItems, ...existingPending];
            saveData('PendingReferrals', updatedPending);

            newItems.forEach(item => {
                if (item.externalIdx) scrapedIds.add(item.externalIdx);
            });
            saveData('ScrapedExternalIds', Array.from(scrapedIds));

            console.log(`🚀 [Scraper] Added ${newItems.length} new external referrals`);
        } else {
            console.log('😴 [Scraper] No new referrals to add');
        }
    } catch (err) {
        console.error('❌ [Scraper] Error during external fetch:', err);
    }
}

// Initial check and set interval
setTimeout(fetchExternalReferrals, 5000); // 5초 후 최초 1회 실행
setInterval(fetchExternalReferrals, EXTERNAL_CONFIG.pollInterval); // 30분 주기

// START SERVER
app.listen(PORT, () => {
    console.log(`🚀 이천센터 의뢰관리시스템 v${SERVER_VERSION} 서버 실행 중 (포트: ${PORT})`);
});

// Catch-all for Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

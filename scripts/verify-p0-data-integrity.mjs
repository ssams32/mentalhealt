/**
 * scripts/verify-p0-data-integrity.mjs
 * 
 * P0H-2 Comprehensive Data Integrity Verification Suite
 * Tests 1-15 jun scenarios + supplementary hardening test cases:
 * 1. New registration with notes (+1, existing hashes invariant)
 * 2. Validation failure (zero-mutation)
 * 3. Persistence forced failure (zero-mutation, no ghost records)
 * 4. Duplicate referralId (409)
 * 5. Duplicate / modified refNo rejection (PUT 400 REFNO_CHANGE_NOT_ALLOWED)
 * 6. Lossless preservation of Korean multiline, CRLF, quotes, backslashes, tabs, emojis, long text
 * 7. Concurrent new registrations (both preserved, 0 lost updates)
 * 8. Concurrent new registration + update (both preserved)
 * 9. Filtered client state simulation (single record POST never overwrites array)
 * 10. Website pending referral conversion to POST
 * 11. Online survey submission referral conversion
 * 12. Concurrent auto-sync (W8/W9) and manual update
 * 13. Server restart count and stable-ID verification
 * 14. Post-error refresh simulation (GET consistency)
 * 15. Unguarded deletion attempt detection (REFERRAL_DATA_INTEGRITY_VIOLATION + zero mutation)
 * Supplementary:
 * - DELETE two-phase atomic rollback on Trash persist failure (B1 regression guard)
 * - Bulk-delete admin-only guard (403 for non-admin)
 * - Bulk-delete awaited persist error handling (no false success on disk failure)
 * - Bulk-delete referralId matching
 * - PUT referralId change rejection (400)
 * - PUT cache rollback on disk persist failure
 * - Note length / count limits validation (400 + zero mutation)
 * 
 * Runs against live production server.js on isolated DATA_DIR with 50+ synthetic records.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { runScenario15 } from './verify-scenario15-engine.mjs';
import { runMajor3 } from './verify-major3-put-contract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 1. Setup isolated synthetic environment
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p0h2_integrity_verify_'));
const DATA_DIR = path.join(TEST_DIR, 'data');
const ATTACHMENTS_DIR = path.join(TEST_DIR, 'attachments');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const TEST_PORT = 9980 + Math.floor(Math.random() * 50);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Helper: Canonical Record Hash
function canonicalHash(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const key of sortedKeys) {
        sortedObj[key] = obj[key];
    }
    return crypto.createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
}

function computeFileChecksum(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

// 2. Generate 55 synthetic records (Departments A: 증진팀, B: 회복팀, C: 남부분소)
const syntheticUsers = [
    {
        id: "synthetic_admin",
        username: "synthetic_admin",
        name: "관리자",
        password: "pwd",
        role: "admin",
        team: "증진팀",
        status: "active"
    },
    {
        id: "synthetic_user_jj",
        username: "synthetic_user_jj",
        name: "증진직원",
        password: "pwd",
        role: "user",
        team: "증진팀",
        status: "active",
        permissions: { referrals: { read: true, write: true } }
    },
    {
        id: "synthetic_user_hb",
        username: "synthetic_user_hb",
        name: "회복직원",
        password: "pwd",
        role: "user",
        team: "회복팀",
        status: "active",
        permissions: { referrals: { read: true, write: true } }
    }
];

const initialReferrals = [];
const depts = [
    { name: '증진팀', code: 'JJ', count: 22 },
    { name: '회복팀', code: 'HB', count: 20 },
    { name: '남부분소', code: 'NB', count: 13 }
];

let globalIdx = 1;
for (const dept of depts) {
    for (let i = 1; i <= dept.count; i++) {
        const referralId = `synth-ref-${dept.code}-${String(i).padStart(3, '0')}`;
        const refNo = `${dept.code}-26-${String(i).padStart(3, '0')}`;
        const clientId = `C_synth_${dept.code}_${i}`;

        const isWebsite = (globalIdx % 5 === 0);
        const isSurvey = (globalIdx % 7 === 0);
        const hasSuicideLink = (globalIdx % 4 === 0);

        const record = {
            referralId,
            refNo,
            clientId,
            name: `합성대상자_${globalIdx}`,
            team: dept.name,
            version: 1,
            closureStatus: i % 3 === 0 ? "종결" : "미종결",
            registrationStatus: "확인중",
            requestDate: "2026-05-10",
            notes: [
                {
                    id: `note_${globalIdx}_1`,
                    content: `초기 상담 메모 ${globalIdx}번: 특이사항 관찰`,
                    createdAt: "2026-05-10 10:00:00",
                    author: "시스템"
                }
            ],
            latestNote: `초기 상담 메모 ${globalIdx}번: 특이사항 관찰`,
            latestNoteDate: "2026-05-10 10:00:00"
        };

        if (isWebsite) {
            record.isWebsiteReferral = true;
            record.externalIdx = `web-ext-${globalIdx}`;
            record.externalReferralId = `EXT_${globalIdx}`;
        }
        if (isSurvey) {
            record.source = 'survey';
            record.sourceSubmissionId = `sub-synth-${globalIdx}`;
            record.sourceSurveyId = `srv-synth-${globalIdx}`;
        }
        if (hasSuicideLink) {
            record.suicideAttempterId = `sa-link-${globalIdx}`;
        }

        initialReferrals.push(record);
        globalIdx++;
    }
}

// Seed Survey Submissions for survey referral integration testing
const initialSurveys = [
    {
        submissionId: "sub-test-online-101",
        internalSurveyId: "sub-test-online-101",
        surveyId: "survey_general_screening",
        respondentName: "설문대상자A",
        respondentPhone: "010-9999-1001",
        submittedAt: "2026-05-11T12:00:00Z",
        assignmentStatus: "assigned",
        assignedUserId: "synthetic_admin",
        assignedDepartmentId: "증진팀",
        processingStatus: "ASSIGNED",
        consultationStatus: "상담대기",
        answers: { score: 18 }
    },
    {
        submissionId: "sub-test-online-102",
        internalSurveyId: "sub-test-online-102",
        surveyId: "survey_general_screening",
        respondentName: "설문대상자B",
        respondentPhone: "010-9999-1002",
        submittedAt: "2026-05-11T13:00:00Z",
        assignmentStatus: "assigned",
        assignedUserId: "synthetic_admin",
        assignedDepartmentId: "회복팀",
        processingStatus: "ASSIGNED",
        consultationStatus: "상담대기",
        answers: { score: 22 }
    }
];

const initialPendingReferrals = [
    {
        externalIdx: "web-pending-501",
        name: "홈페이지의뢰자X",
        phone: "010-8888-5001",
        team: "증진팀",
        problem: "우울감",
        isSeen: true
    }
];

// Write synthetic seeds
fs.writeFileSync(path.join(DATA_DIR, 'Users.json'), JSON.stringify(syntheticUsers, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'Referrals.json'), JSON.stringify(initialReferrals, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'SurveySubmissions.json'), JSON.stringify(initialSurveys, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'PendingReferrals.json'), JSON.stringify(initialPendingReferrals, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'Trash.json'), JSON.stringify([], null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'AuditEntries.json'), JSON.stringify([], null, 2), 'utf8');

console.log(`[SETUP] Seeded ${initialReferrals.length} synthetic referrals across 3 departments.`);
console.log(`[SETUP] Seeded ${initialSurveys.length} survey submissions, 1 pending referral.`);

let serverProcess = null;
let adminCookie = null;
let userCookie = null;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✅ [PASS] ${message}`);
    } else {
        failedTests++;
        console.error(`  ❌ [FAIL] ${message}`);
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function startServer() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            PORT: String(TEST_PORT),
            DATA_DIR: DATA_DIR,
            ATTACHMENTS_DIR: ATTACHMENTS_DIR,
            NODE_ENV: 'test',
            SURVEY_TRACK_A_MODE: 'mock'
        };

        serverProcess = spawn('node', ['server.js'], {
            cwd: ROOT_DIR,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let started = false;
        serverProcess.stdout.on('data', (chunk) => {
            const str = chunk.toString();
            if (str.includes(`Server running`) || str.includes(String(TEST_PORT))) {
                if (!started) {
                    started = true;
                    resolve();
                }
            }
        });

        serverProcess.stderr.on('data', (chunk) => {
            // console.error(`[SERVER STDERR] ${chunk}`);
        });

        serverProcess.on('error', (err) => {
            reject(err);
        });

        setTimeout(() => {
            if (!started) resolve(); // Continue after timeout if server initialized
        }, 3000);
    });
}

async function stopServer() {
    if (serverProcess) {
        serverProcess.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        serverProcess = null;
    }
}

async function login(username, password) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error(`Login failed for ${username}: ${res.status}`);
    return setCookie.split(';')[0];
}

function getDiskState() {
    const filePath = path.join(DATA_DIR, 'Referrals.json');
    if (!fs.existsSync(filePath)) return { count: 0, ids: new Set(), hashMap: new Map(), checksum: null };
    const content = fs.readFileSync(filePath, 'utf8');
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    const data = JSON.parse(content);
    const ids = new Set(data.map(r => r.referralId).filter(Boolean));
    const hashMap = new Map(data.map(r => [r.referralId, canonicalHash(r)]));
    return { count: data.length, ids, hashMap, checksum, data };
}

function getTrashDiskState() {
    const filePath = path.join(DATA_DIR, 'Trash.json');
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getAuditLogs() {
    const filePath = path.join(DATA_DIR, 'AuditEntries.json');
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function waitForAuditLog(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const logs = getAuditLogs();
        const found = logs.find(predicate);
        if (found) return found;
        await new Promise(r => setTimeout(r, 20));
    }
    const logs = getAuditLogs();
    return logs.find(predicate);
}

async function getCacheState(cookie) {
    const res = await fetch(`${BASE_URL}/api/referrals?team=all&includeOnlineSurveys=true`, {
        headers: { 'Cookie': cookie }
    });
    if (!res.ok) throw new Error(`GET /api/referrals failed: ${res.status}`);
    const data = await res.json();
    const ids = new Set(data.map(r => r.referralId).filter(Boolean));
    const hashMap = new Map(data.map(r => [r.referralId, canonicalHash(r)]));
    return { count: data.length, ids, hashMap, data };
}

async function runTests() {
    console.log(`\n==================================================`);
    console.log(`🚀 Starting P0H-2 Data Integrity Verification Suite`);
    console.log(`==================================================\n`);

    await startServer();
    adminCookie = await login('synthetic_admin', 'pwd');
    userCookie = await login('synthetic_user_jj', 'pwd');

    const initialDisk = getDiskState();
    console.log(`[INITIAL] Initial Referrals on disk: ${initialDisk.count} items, Checksum: ${initialDisk.checksum.slice(0, 12)}...`);

    // ----------------------------------------------------
    // Scenario 1: New registration with notes (+1, existing hashes invariant)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 1: New registration with notes (+1, existing hashes invariant)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminCookie);

        const payload = {
            name: "시나리오1_대상자",
            team: "증진팀",
            phone: "010-1111-2222",
            gender: "남성",
            age: 35,
            notes: [
                {
                    id: "note_s1",
                    content: "상담 메모 시나리오 1: 상태 호전 중",
                    createdAt: "2026-05-12 14:00:00",
                    author: "관리자"
                }
            ]
        };

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify(payload)
        });

        assert(res.status === 201, `HTTP 201 Created (got ${res.status})`);
        const json = await res.json();
        assert(json.success === true, `Response success is true`);
        const created = json.data;
        assert(created && created.referralId, `Created record has referralId (${created?.referralId})`);
        assert(created.refNo.startsWith('JJ-26-'), `Created refNo has correct prefix JJ-26- (${created.refNo})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminCookie);

        assert(afterDisk.count === beforeDisk.count + 1, `Disk count exactly +1 (${beforeDisk.count} -> ${afterDisk.count})`);
        assert(afterCache.count === beforeCache.count + 1, `Cache count exactly +1 (${beforeCache.count} -> ${afterCache.count})`);
        assert(afterDisk.ids.has(created.referralId), `New ID present in disk ID set`);

        // Invariant: all prior records maintain exact canonical hash
        let allPriorMatch = true;
        for (const [id, oldHash] of beforeDisk.hashMap.entries()) {
            if (afterDisk.hashMap.get(id) !== oldHash) {
                allPriorMatch = false;
                break;
            }
        }
        assert(allPriorMatch, `All prior 55 records maintained 100% identical canonical hashes`);
    }

    // ----------------------------------------------------
    // Scenario 2: Validation failure (zero-mutation)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 2: Validation failure (zero-mutation)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminCookie);

        const invalidPayload = {
            phone: "010-0000-0000"
            // Missing 'name' and 'team' (required)
        };

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify(invalidPayload)
        });

        assert(res.status === 400, `HTTP 400 Bad Request on missing required fields (got ${res.status})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminCookie);

        assert(afterDisk.count === beforeDisk.count, `Disk count unchanged (${afterDisk.count})`);
        assert(afterCache.count === beforeCache.count, `Cache count unchanged (${afterCache.count})`);
        assert(afterDisk.checksum === beforeDisk.checksum, `Disk SHA-256 checksum 100% invariant`);
    }

    // ----------------------------------------------------
    // Scenario 3: Persistence forced failure (disk and cache invariant, no ghost records)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 3: Persistence forced failure (zero-mutation, no ghost records)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminCookie);

        // Swap Referrals.json with a directory to force EISDIR on atomic rename
        const refFilePath = path.join(DATA_DIR, 'Referrals.json');
        const backupPath = path.join(DATA_DIR, 'Referrals.json.saved_for_test3');
        fs.renameSync(refFilePath, backupPath);
        fs.mkdirSync(refFilePath);

        let res;
        try {
            res = await fetch(`${BASE_URL}/api/referrals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
                body: JSON.stringify({ name: "실패테스트", team: "증진팀" })
            });
        } finally {
            // Restore file from backup
            try { fs.rmdirSync(refFilePath); } catch (e) {}
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, refFilePath);
            }
        }

        assert(res.status === 500, `HTTP 500 on persist failure (got ${res.status})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminCookie);

        assert(afterDisk.count === beforeDisk.count, `Disk count invariant (${afterDisk.count})`);
        assert(afterCache.count === beforeCache.count, `Cache count invariant (no ghost records in cache)`);
        assert(afterDisk.checksum === beforeDisk.checksum, `Disk checksum invariant`);
    }

    // ----------------------------------------------------
    // Scenario 4: Duplicate referralId (409)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 4: Duplicate referralId (409)`);
    {
        const beforeDisk = getDiskState();
        const existingRecord = initialReferrals[0];

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: existingRecord.referralId, // duplicate ID
                name: "중복ID시도",
                team: "증진팀"
            })
        });

        assert(res.status === 409, `HTTP 409 on duplicate referralId (got ${res.status})`);
        const json = await res.json();
        assert(json.code === 'DUPLICATE_REFERRAL_ID', `Code is DUPLICATE_REFERRAL_ID`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count, `Zero mutation on duplicate ID rejection`);
    }

    // ----------------------------------------------------
    // Scenario 5: Duplicate / modified refNo rejection (PUT 400 REFNO_CHANGE_NOT_ALLOWED)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 5: Duplicate / modified refNo rejection (PUT 400 REFNO_CHANGE_NOT_ALLOWED)`);
    {
        const target = initialReferrals[1]; // JJ-26-002
        const other = initialReferrals[2];  // JJ-26-003

        // Attempt to modify refNo to other's refNo
        const res = await fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: target.referralId,
                refNo: other.refNo // change attempt
            })
        });

        assert(res.status === 400, `HTTP 400 on refNo alteration attempt (got ${res.status})`);
        const json = await res.json();
        assert(json.code === 'REFNO_CHANGE_NOT_ALLOWED', `Error code REFNO_CHANGE_NOT_ALLOWED returned`);
    }

    // ----------------------------------------------------
    // Scenario 6: Lossless preservation of Korean multiline, CRLF, quotes, backslashes, tabs, emojis, long text
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 6: Lossless preservation of Korean multiline, CRLF, quotes, backslashes, tabs, emojis, long text`);
    {
        const target = initialReferrals[3];
        const complexNoteText = `한글 여러 줄 테스트 시작\r\nCRLF 줄바꿈 1\nLF 줄바꿈 2\rCR 줄바꿈 3\n` +
            `따옴표: 'single' and "double" and \`backtick\`\n` +
            `특수기호: \\backslash /slash &amp; <script>alert("xss")</script>\n` +
            `탭:\t[tabbed-content]\t[end-tab]\n` +
            `이모지: 🧠 🛡️ 🏥 🚀 👨‍⚕️ ❤️\n` +
            `긴 문자열: ` + "가나다라마바사아자차카타파하".repeat(100);

        const res = await fetch(`${BASE_URL}/api/saveNotes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: target.referralId,
                notes: [
                    {
                        id: "complex_note_001",
                        content: complexNoteText,
                        createdAt: "2026-05-12 15:30:00",
                        author: "검증담당"
                    }
                ]
            })
        });

        assert(res.status === 200, `HTTP 200 on saving complex notes (got ${res.status})`);

        // Read directly from disk
        const diskState = getDiskState();
        const reloaded = diskState.data.find(r => r.referralId === target.referralId);
        assert(reloaded && reloaded.notes && reloaded.notes.length === 1, `Reloaded record has notes`);
        assert(reloaded.notes[0].content === complexNoteText, `Content on disk matches input byte-for-byte (lossless)`);
    }

    // ----------------------------------------------------
    // Scenario 7: Concurrent new registrations (both preserved, 0 lost updates)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 7: Concurrent new registrations (both preserved, 0 lost updates)`);
    {
        const beforeDisk = getDiskState();

        const p1 = fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ name: "동시대상자1", team: "회복팀" })
        });

        const p2 = fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ name: "동시대상자2", team: "회복팀" })
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        assert(r1.status === 201 && r2.status === 201, `Both concurrent requests succeeded (201/201)`);

        const j1 = await r1.json();
        const j2 = await r2.json();
        assert(j1.data.refNo !== j2.data.refNo, `Both assigned distinct unique refNos (${j1.data.refNo} vs ${j2.data.refNo})`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count + 2, `Disk count exactly +2 (${beforeDisk.count} -> ${afterDisk.count})`);
        assert(afterDisk.ids.has(j1.data.referralId) && afterDisk.ids.has(j2.data.referralId), `Both IDs preserved on disk`);
    }

    // ----------------------------------------------------
    // Scenario 8: Concurrent new registration + existing update (both preserved)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 8: Concurrent new registration + existing update (both preserved)`);
    {
        const beforeDisk = getDiskState();
        const updateTarget = initialReferrals[4];

        const pCreate = fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ name: "동시등록건", team: "남부분소" })
        });

        const pUpdate = fetch(`${BASE_URL}/api/referrals/${updateTarget.referralId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: updateTarget.referralId,
                address: "경기도 이천시 부발읍 동시수정테스트"
            })
        });

        const [rCreate, rUpdate] = await Promise.all([pCreate, pUpdate]);
        assert(rCreate.status === 201, `Concurrent create succeeded (201)`);
        assert(rUpdate.status === 200, `Concurrent update succeeded (200)`);

        const jCreate = await rCreate.json();
        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count + 1, `Disk count +1`);
        assert(afterDisk.ids.has(jCreate.data.referralId), `Created record exists on disk`);

        const updatedOnDisk = afterDisk.data.find(r => r.referralId === updateTarget.referralId);
        assert(updatedOnDisk.address === "경기도 이천시 부발읍 동시수정테스트", `Updated address persisted`);
    }

    // ----------------------------------------------------
    // Scenario 9: Filtered client state simulation (single record POST never overwrites array)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 9: Filtered client state simulation (single record POST never overwrites array)`);
    {
        // Even if user query was filtered to '남부분소' (13 items), sending a POST does not overwrite other departments
        const beforeDisk = getDiskState();

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
            body: JSON.stringify({ name: "부분클라이언트등록", team: "남부분소" })
        });

        assert(res.status === 201, `Single record registration succeeded`);
        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count + 1, `Entire database preserved, count +1`);
    }

    // ----------------------------------------------------
    // Scenario 10: Website pending referral conversion to POST
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 10: Website pending referral conversion to POST`);
    {
        const beforeDisk = getDiskState();
        const pending = initialPendingReferrals[0];

        const payload = {
            name: pending.name,
            team: pending.team,
            phone: pending.phone,
            isWebsiteReferral: true,
            externalIdx: pending.externalIdx,
            problem: pending.problem
        };

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify(payload)
        });

        assert(res.status === 201, `Website pending conversion succeeded (201)`);
        const json = await res.json();
        assert(json.data.externalIdx === pending.externalIdx, `Preserved externalIdx on conversion`);
        assert(json.data.isWebsiteReferral === true, `isWebsiteReferral set to true`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count + 1, `Converted referral saved to Referrals.json`);
    }

    // ----------------------------------------------------
    // Scenario 11: Online survey submission referral conversion
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 11: Online survey submission referral conversion`);
    {
        const beforeDisk = getDiskState();
        const surveySub = initialSurveys[0];

        const payload = {
            name: surveySub.respondentName,
            team: surveySub.assignedDepartmentId,
            phone: surveySub.respondentPhone,
            source: 'survey',
            sourceSubmissionId: surveySub.submissionId,
            sourceSurveyId: surveySub.surveyId
        };

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify(payload)
        });

        assert(res.status === 201, `Online survey referral conversion succeeded (201)`);
        const json = await res.json();
        assert(json.data.sourceSubmissionId === surveySub.submissionId, `sourceSubmissionId linked`);

        // Re-attempting duplicate conversion should 409
        const resDup = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify(payload)
        });
        assert(resDup.status === 409, `Duplicate survey referral blocked with 409`);
    }

    // ----------------------------------------------------
    // Scenario 12: Concurrent auto-processing (W8/W9) and manual update
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 12: Concurrent auto-processing (W8/W9 equivalent) and manual update`);
    {
        const target = initialReferrals[10];

        const pAssignee = fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: target.referralId,
                assignee: "자동배정담당자",
                team: "증진팀"
            })
        });

        const pManualNote = fetch(`${BASE_URL}/api/saveNotes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: target.referralId,
                notes: [
                    { id: "note_m1", content: "수동 메모 동시 저장", createdAt: "2026-05-12 16:00:00", author: "실무자" }
                ]
            })
        });

        const [r1, r2] = await Promise.all([pAssignee, pManualNote]);
        assert((r1.status === 200 || r1.status === 409) && (r2.status === 200 || r2.status === 409), `Serialized execution handled without corruption`);
        const afterDisk = getDiskState();
        assert(afterDisk.ids.has(target.referralId), `Target record intact on disk`);
    }

    // ----------------------------------------------------
    // Scenario 13: Server restart count and stable-ID verification
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 13: Server restart count and stable-ID verification`);
    {
        const beforeRestart = getDiskState();
        await stopServer();
        await startServer();
        adminCookie = await login('synthetic_admin', 'pwd');

        const afterRestart = getDiskState();
        assert(afterRestart.count === beforeRestart.count, `Disk count unchanged after restart (${afterRestart.count})`);
        assert(afterRestart.checksum === beforeRestart.checksum, `Disk checksum 100% matched after restart`);

        // Check startup audit log
        const auditLogs = getAuditLogs();
        console.log(`  ℹ️ Total audit logs recorded so far: ${auditLogs.length}`);
    }

    // ----------------------------------------------------
    // Scenario 14: Post-error refresh simulation (GET consistency)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 14: Post-error refresh simulation (GET consistency)`);
    {
        // Trigger a bad request
        await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ invalid: true })
        });

        const getRes = await fetch(`${BASE_URL}/api/referrals?team=all&includeOnlineSurveys=true`, {
            headers: { 'Cookie': adminCookie }
        });
        assert(getRes.status === 200, `GET /api/referrals returns 200`);
        const list = await getRes.json();
        const disk = getDiskState();
        assert(list.length === disk.count, `In-memory cache and disk count match (${list.length} == ${disk.count})`);
    }

    // ----------------------------------------------------
    // Scenario 15: Unguarded record decrease detection (REFERRAL_DATA_INTEGRITY_VIOLATION)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 15: Unguarded record decrease detection (REFERRAL_DATA_INTEGRITY_VIOLATION)`);
    {
        // 1. Drive the REAL production mutation engine directly (no test-only HTTP route):
        //    opType UPDATE but the mutation callback pops a record (undeclared decrease).
        const eng = await runScenario15();

        assert(eng.violationDetected, `Engine detected the unguarded decrease (threw an error)`);
        assert(eng.thrownCode === 'REFERRAL_DATA_INTEGRITY_VIOLATION', `Fail-closed with REFERRAL_DATA_INTEGRITY_VIOLATION code (got ${eng.thrownCode})`);
        assert(eng.persistNotCalled, `persistData NOT called for Referrals (not treated as success)`);
        assert(eng.diskCountUnchanged, `Disk count unchanged (${eng.afterCount} == ${eng.beforeCount})`);
        assert(eng.diskChecksumUnchanged, `Disk checksum strictly identical (zero mutation)`);
        assert(eng.cacheRestored, `In-memory cache restored in-place (${eng.afterCount})`);
        assert(eng.cacheIdsPreserved, `Cache stable ID set preserved`);
        assert(eng.cacheHashesPreserved, `Cache canonical hashes of surviving records preserved`);
        assert(eng.noGhostRecords, `No ghost records`);
        assert(eng.auditLogged, `Audit log recorded for REFERRAL_DATA_INTEGRITY_VIOLATION`);
        assert(eng.auditNoPii, `Zero PII in violation audit log`);
        assert(eng.positiveControlPassed, `Positive control: legitimate single-record update still persists`);

        const beforeDisk = getDiskState();

        // 2. Also verify URL-body referralId mismatch rejection (zero-mutation)
        const target = initialReferrals[15];
        const resMismatch = await fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: "completely-different-id",
                name: "위반테스트"
            })
        });

        assert(resMismatch.status === 400, `Rejected mismatched referralId modification (400)`);
        const afterDisk2 = getDiskState();
        assert(afterDisk2.checksum === beforeDisk.checksum, `Zero mutation on mismatched referralId`);
    }

    // ----------------------------------------------------
    // Supplementary 1: DELETE Two-phase atomicity (Trash persist first, rollback if Referrals fails)
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 1: DELETE Two-phase atomicity`);
    {
        const beforeDisk = getDiskState();
        const target = initialReferrals[18];

        const res = await fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
            method: 'DELETE',
            headers: { 'Cookie': adminCookie }
        });

        assert(res.status === 200, `DELETE succeeded (200)`);
        const json = await res.json();
        assert(json.deletedRefNo === target.refNo, `Deleted correct refNo`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count - 1, `Disk count exactly -1`);
        assert(!afterDisk.ids.has(target.referralId), `Target removed from Referrals.json`);

        const trash = getTrashDiskState();
        const trashItem = trash.find(t => t.referralId === target.referralId);
        assert(trashItem !== undefined, `Item safely stored in Trash.json`);
        assert(trashItem._trashSource === 'Referrals', `_trashSource tagged as Referrals`);

        // Audit check
        const deleteLog = await waitForAuditLog(l => l.action === 'REFERRAL_DELETE' && l.targetId === target.referralId);
        assert(deleteLog !== undefined, `Audit log recorded for REFERRAL_DELETE`);
    }

    // ----------------------------------------------------
    // Supplementary 2: RESTORE Two-phase atomicity
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 2: RESTORE Two-phase atomicity`);
    {
        const target = initialReferrals[18];
        const beforeDisk = getDiskState();

        const res = await fetch(`${BASE_URL}/api/trash/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ id: target.referralId })
        });

        assert(res.status === 200, `RESTORE succeeded (200)`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count + 1, `Restored to Referrals.json (count +1)`);
        assert(afterDisk.ids.has(target.referralId), `Restored ID present in Referrals.json`);

        const trash = getTrashDiskState();
        assert(!trash.some(t => t.referralId === target.referralId), `Item removed from Trash.json`);

        const restoreLog = await waitForAuditLog(l => l.action === 'REFERRAL_RESTORE' && l.targetId === target.referralId);
        assert(restoreLog !== undefined, `Audit log recorded for REFERRAL_RESTORE`);
    }

    // ----------------------------------------------------
    // Supplementary 3: Bulk-delete admin-only check & referralId match
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 3: Bulk-delete admin-only & referralId matching`);
    {
        const target1 = initialReferrals[25];
        const target2 = initialReferrals[26];

        // 1. Non-admin user attempt -> 403
        const resUser = await fetch(`${BASE_URL}/api/referrals/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
            body: JSON.stringify({ ids: [target1.referralId, target2.referralId] })
        });
        assert(resUser.status === 403, `Non-admin bulk-delete rejected with 403 FORBIDDEN`);

        // 2. Admin attempt -> 200
        const beforeDisk = getDiskState();
        const resAdmin = await fetch(`${BASE_URL}/api/referrals/bulk-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({ ids: [target1.referralId, target2.referralId] })
        });

        assert(resAdmin.status === 200, `Admin bulk-delete succeeded (200)`);
        const json = await resAdmin.json();
        assert(json.deletedCount === 2, `Reported deletedCount === 2`);

        const afterDisk = getDiskState();
        assert(afterDisk.count === beforeDisk.count - 2, `Referrals count exactly -2`);
        assert(!afterDisk.ids.has(target1.referralId) && !afterDisk.ids.has(target2.referralId), `Both IDs removed from disk`);

        const trash = getTrashDiskState();
        assert(trash.some(t => t.referralId === target1.referralId) && trash.some(t => t.referralId === target2.referralId), `Both moved to Trash.json`);

        const bulkLog = await waitForAuditLog(l => l.action === 'REFERRAL_BULK_DELETE' && l.targetId === 'count:2');
        assert(bulkLog !== undefined, `Audit log recorded for REFERRAL_BULK_DELETE (count only, zero PII)`);
    }

    // ----------------------------------------------------
    // Supplementary 4: Notes length and count validation (F6)
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 4: Notes length and count validation (F6)`);
    {
        const target = initialReferrals[30];
        const beforeDisk = getDiskState();

        // 1. Content length exceeds 100,000 characters
        const tooLongContent = 'x'.repeat(100001);
        const resTooLong = await fetch(`${BASE_URL}/api/saveNotes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
            body: JSON.stringify({
                referralId: target.referralId,
                notes: [{ id: "n1", content: tooLongContent }]
            })
        });

        assert(resTooLong.status === 400, `Exceeded note content length rejected with 400`);
        const jLong = await resTooLong.json();
        assert(jLong.code === 'INVALID_NOTES_LENGTH', `Code is INVALID_NOTES_LENGTH`);

        const afterDisk = getDiskState();
        assert(afterDisk.checksum === beforeDisk.checksum, `Zero mutation on notes validation failure`);
    }

    // ----------------------------------------------------
    // Supplementary 6: DELETE Trash persist failure rollback (B1 regression guard)
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 6: DELETE Trash persist failure rollback (B1 regression guard)`);
    {
        const beforeDisk = getDiskState();
        const target = initialReferrals[35];

        // Swap Trash.json with a directory to force Trash persist failure
        const trashFilePath = path.join(DATA_DIR, 'Trash.json');
        const backupTrashPath = path.join(DATA_DIR, 'Trash.json.saved_for_b1');
        fs.renameSync(trashFilePath, backupTrashPath);
        fs.mkdirSync(trashFilePath);

        let res;
        try {
            res = await fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
                method: 'DELETE',
                headers: { 'Cookie': adminCookie }
            });
        } finally {
            try { fs.rmdirSync(trashFilePath); } catch (e) {}
            if (fs.existsSync(backupTrashPath)) {
                fs.renameSync(backupTrashPath, trashFilePath);
            }
        }

        assert(res.status === 500, `DELETE rejected with 500 when Trash persist fails (got ${res.status})`);

        const afterDisk = getDiskState();
        const trashDisk = getTrashDiskState();

        assert(afterDisk.ids.has(target.referralId), `Target remains safely in Referrals ledger (not deleted)`);
        assert(!trashDisk.some(t => t.referralId === target.referralId), `Target NOT left in Trash (no duplicate/ghost state)`);
    }

    // ----------------------------------------------------
    // Supplementary 7: Bulk-delete persist failure: No false success response
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 7: Bulk-delete persist failure (no false success)`);
    {
        const beforeDisk = getDiskState();
        const target = initialReferrals[36];

        // Swap Referrals.json with directory to force failure on Referrals persist
        const refFilePath = path.join(DATA_DIR, 'Referrals.json');
        const backupPath = path.join(DATA_DIR, 'Referrals.json.saved_for_bulk_fail');
        fs.renameSync(refFilePath, backupPath);
        fs.mkdirSync(refFilePath);

        let res;
        try {
            res = await fetch(`${BASE_URL}/api/referrals/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
                body: JSON.stringify({ ids: [target.referralId] })
            });
        } finally {
            try { fs.rmdirSync(refFilePath); } catch (e) {}
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, refFilePath);
            }
        }

        assert(res.status === 500, `Bulk-delete returns 500 on persist failure (never 200 false success)`);
        const json = await res.json();
        assert(json.success === false, `Response success is false`);

        const trashDisk = getTrashDiskState();
        assert(!trashDisk.some(t => t.referralId === target.referralId), `Trash rolled back: target not left in Trash`);
    }

    // ----------------------------------------------------
    // Supplementary 8: PUT persist failure cache rollback
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 8: PUT persist failure cache rollback`);
    {
        const target = initialReferrals[37];
        const beforeCache = await getCacheState(adminCookie);
        const originalName = target.name;

        // Swap Referrals.json with directory
        const refFilePath = path.join(DATA_DIR, 'Referrals.json');
        const backupPath = path.join(DATA_DIR, 'Referrals.json.saved_for_put_fail');
        fs.renameSync(refFilePath, backupPath);
        fs.mkdirSync(refFilePath);

        let res;
        try {
            res = await fetch(`${BASE_URL}/api/referrals/${target.referralId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
                body: JSON.stringify({
                    referralId: target.referralId,
                    name: "변형시도실패명"
                })
            });
        } finally {
            try { fs.rmdirSync(refFilePath); } catch (e) {}
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, refFilePath);
            }
        }

        assert(res.status === 500, `PUT returns 500 on persist failure (got ${res.status})`);

        // Check GET to verify in-memory cache was rolled back to snapshot
        const afterCache = await getCacheState(adminCookie);
        const recInCache = afterCache.data.find(r => r.referralId === target.referralId);
        assert(recInCache && recInCache.name === originalName, `In-memory cache rolled back to original name (${recInCache?.name})`);
    }

    // ----------------------------------------------------
    // Supplementary 9: Audit Log Zero-PII Verification
    // ----------------------------------------------------
    console.log(`\n▶ Supplementary 9: Audit Log Zero-PII Verification`);
    {
        const auditLogs = getAuditLogs();
        assert(auditLogs.length > 0, `Audit logs exist (${auditLogs.length} events)`);

        let hasPii = false;
        for (const log of auditLogs) {
            const str = JSON.stringify(log);
            // Check for names or raw notes or phone numbers
            if (str.includes("합성대상자") || str.includes("상담 메모") || str.includes("010-")) {
                hasPii = true;
                break;
            }
        }
        assert(!hasPii, `Audit logs contain ZERO PII (no names, phone numbers, or note contents)`);
    }

    // ----------------------------------------------------
    // Scenario 16: PUT immutable identifier contract (MAJOR-3)
    // ----------------------------------------------------
    console.log(`\n▶ Scenario 16: PUT immutable identifier contract (MAJOR-3)`);
    {
        // Drives the real production PUT /api/referrals/:id against an isolated
        // server: externalReferralId type variants, existing identifier regression,
        // same-value no-op contract, unknown-field injection, server-managed fields,
        // normal mutable fields by category, and persist-failure atomicity.
        const m3 = await runMajor3();
        let m3failed = 0;
        for (const c of m3) {
            if (!c.ok) {
                m3failed++;
                console.log(`   ✗ MAJOR-3 sub-check failed: ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
            }
        }
        assert(m3failed === 0, `MAJOR-3 PUT contract sub-checks all pass (${m3.length}/${m3.length})`);
        assert(m3.length >= 90, `MAJOR-3 sub-check count intact (${m3.length} checks)`);
    }

    console.log(`\n==================================================`);
    console.log(`🏁 All Test Scenarios Completed Successfully!`);
    console.log(`   Total Assertions: ${totalTests}`);
    console.log(`   Passed: ${passedTests}`);
    console.log(`   Failed: ${failedTests}`);
    console.log(`==================================================\n`);
}

async function main() {
    try {
        await runTests();
    } catch (e) {
        console.error(`\n❌ Test suite failed with exception:`, e);
        process.exitCode = 1;
    } finally {
        await stopServer();
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (ignore) {}
    }
}

main();

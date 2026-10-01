/**
 * scripts/verify-p0-ledger-scope-and-registration.mjs
 * 
 * P0-2 Comprehensive Verification Suite
 * - Tests 1-9: Registration scenarios & Invariants
 * - Inquiry verification: Non-admin all-department query, Suicide ledger all-dept, Case analysis isolation guard
 * - TEAM_CODES prefix verification (JJ, HB, JY, AC, NB)
 * - Synthetic temporary environment, ZERO operations data mutation, ZERO PII
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 1. Setup isolated synthetic temporary directory
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p0_synthetic_verify_'));
const DATA_DIR = path.join(TEST_DIR, 'data');
const ATTACHMENTS_DIR = path.join(TEST_DIR, 'attachments');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const TEST_PORT = 9987 + Math.floor(Math.random() * 100);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Initial Synthetic Seed Data
const initialUsers = [
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
    },
    {
        id: "synthetic_user_nb",
        username: "synthetic_user_nb",
        name: "남부직원",
        password: "pwd",
        role: "user",
        team: "남부분소",
        status: "active",
        permissions: { referrals: { read: true, write: true } }
    }
];

const initialReferrals = [
    {
        referralId: "init-ref-001",
        refNo: "JJ-26-001",
        name: "대상자1",
        team: "증진팀",
        clientId: "C_init_001",
        version: 1,
        closureStatus: "미종결",
        notes: [{ date: "2026-01-01", text: "초기 기록 1" }]
    },
    {
        referralId: "init-ref-002",
        refNo: "JJ-26-002",
        name: "대상자2",
        team: "증진팀",
        clientId: "C_init_002",
        version: 1,
        closureStatus: "미종결",
        notes: [{ date: "2026-01-02", text: "초기 기록 2" }]
    },
    {
        referralId: "init-ref-003",
        refNo: "HB-26-001",
        name: "대상자3",
        team: "회복팀",
        clientId: "C_init_003",
        version: 1,
        closureStatus: "미종결",
        notes: [{ date: "2026-01-03", text: "초기 기록 3" }]
    },
    {
        referralId: "init-ref-004",
        refNo: "HB-26-002",
        name: "대상자4",
        team: "회복팀",
        clientId: "C_init_004",
        version: 1,
        closureStatus: "종결",
        notes: [{ date: "2026-01-04", text: "초기 기록 4" }]
    },
    {
        referralId: "init-ref-005",
        refNo: "NB-26-001",
        name: "대상자5",
        team: "남부분소",
        clientId: "C_init_005",
        version: 1,
        closureStatus: "미종결",
        notes: [{ date: "2026-01-05", text: "초기 기록 5" }]
    }
];

const initialSuicideAttempters = [
    {
        uid: "2026-001",
        name: "자살대상자1",
        requestAgency: "이천경찰서",
        region: "창전동",
        pic: "경찰관A",
        infoTarget: "자살시도자",
        processingStatus: "서비스동의"
    },
    {
        uid: "2026-002",
        name: "자살대상자2",
        requestAgency: "이천소방서",
        region: "부발읍",
        pic: "소방관B",
        infoTarget: "자살시도자",
        processingStatus: "처리중"
    },
    {
        uid: "2026-003",
        name: "자살대상자3",
        requestAgency: "이천의료원",
        region: "장호원읍",
        pic: "의료진C",
        infoTarget: "자살유족",
        processingStatus: "서비스동의"
    }
];

const initialCaseAnalysis = {
    counselorPerformance: [
        { counselorName: "증진상담사A", department: "증진팀", clientCount: 15, sessionCount: 45 },
        { counselorName: "회복상담사B", department: "회복팀", clientCount: 12, sessionCount: 38 },
        { counselorName: "남부상담사C", department: "남부분소", clientCount: 8, sessionCount: 20 },
        { counselorName: "자살상담사D", department: "자살예방센터", clientCount: 10, sessionCount: 25 },
        { counselorName: "아청상담사E", department: "아동청소년", clientCount: 7, sessionCount: 18 }
    ],
    memberPerformance: [
        { memberId: "m1", counselorName: "증진상담사A", department: "증진팀" },
        { memberId: "m2", counselorName: "회복상담사B", department: "회복팀" },
        { memberId: "m3", counselorName: "남부상담사C", department: "남부분소" }
    ],
    ispExpiringMembers: [
        { memberId: "m1", counselorName: "증진상담사A" },
        { memberId: "m2", counselorName: "회복상담사B" }
    ]
};

// Write initial synthetic files
fs.writeFileSync(path.join(DATA_DIR, 'Users.json'), JSON.stringify(initialUsers, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'Referrals.json'), JSON.stringify(initialReferrals, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'SuicideAttempters.json'), JSON.stringify(initialSuicideAttempters, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'GlobalCaseAnalysis.json'), JSON.stringify(initialCaseAnalysis, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'ActivityLogs.json'), JSON.stringify([], null, 2), 'utf8');
fs.writeFileSync(path.join(DATA_DIR, 'Trash.json'), JSON.stringify([], null, 2), 'utf8');

// Spawn server
console.log(`[SPAWN] Starting synthetic server on port ${TEST_PORT}...`);
const serverProcess = spawn('node', ['server.js'], {
    cwd: ROOT_DIR,
    env: {
        ...process.env,
        PORT: TEST_PORT.toString(),
        DATA_DIR: DATA_DIR,
        ATTACHMENTS_DIR: ATTACHMENTS_DIR,
        SURVEY_TRACK_A_MODE: 'mock',
        ADMIN_INIT_PASSWORD: 'pwd'
    },
    stdio: 'pipe'
});

serverProcess.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('ExperimentalWarning')) {
        // Suppress benign logs
    }
});

async function waitForServer(retries = 40) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${BASE_URL}/api/health`);
            if (res.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('Server failed to start in time');
}

// Checksum & State helpers
function getDiskState() {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'Referrals.json'), 'utf8');
    const items = JSON.parse(raw);
    const checksum = crypto.createHash('sha256').update(raw).digest('hex');
    const ids = items.map(r => r.referralId);
    return { count: items.length, ids, checksum, items };
}

async function getCacheState(adminToken) {
    const res = await fetch(`${BASE_URL}/api/referrals`, {
        headers: {
            'Authorization': `Bearer ${adminToken}`,
            'Cookie': `mind_session=${adminToken}`,
            'x-user-id': 'synthetic_admin',
            'x-user-role': 'admin'
        }
    });
    if (!res.ok) {
        throw new Error(`getCacheState failed: ${res.status} ${await res.text()}`);
    }
    const items = await res.json();
    const checksum = crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
    const ids = items.map(r => r.referralId);
    return { count: items.length, ids, checksum, items };
}

async function loginUser(username, password) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Host': `127.0.0.1:${TEST_PORT}`,
            'Origin': `http://127.0.0.1:${TEST_PORT}`
        },
        body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
        throw new Error(`Login failed for ${username}: ${res.status} ${await res.text()}`);
    }
    const cookieHeader = res.headers.get('set-cookie') || '';
    const match = cookieHeader.match(/mind_session=([^;]+)/);
    if (!match) {
        throw new Error(`Session cookie not found in login response for ${username}`);
    }
    return decodeURIComponent(match[1]);
}

async function runSuite() {
    await waitForServer();
    console.log(`✅ [READY] Synthetic test server running on ${BASE_URL}\n`);

    const adminToken = await loginUser('synthetic_admin', 'pwd');
    const userJjToken = await loginUser('synthetic_user_jj', 'pwd');
    const userHbToken = await loginUser('synthetic_user_hb', 'pwd');
    const userNbToken = await loginUser('synthetic_user_nb', 'pwd');

    console.log(`🔐 Logged in: admin, user_jj (증진팀), user_hb (회복팀), user_nb (남부분소)`);

    let passedTests = 0;
    let failedTests = 0;

    function assert(cond, msg) {
        if (!cond) {
            console.error(`  ❌ FAIL: ${msg}`);
            failedTests++;
            throw new Error(`Assertion failed: ${msg}`);
        } else {
            console.log(`  ✔ PASS: ${msg}`);
            passedTests++;
        }
    }

    console.log(`\n======================================================`);
    console.log(`PART 1: 9 REGISTRATION SCENARIOS & INVARIANT VERIFICATION`);
    console.log(`======================================================`);

    // --- TEST 1: 기록내용 없는 등록 ---
    console.log(`\n[Test 1] 기록내용 없는 등록 (empty notes)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: "테스트대상자1",
                team: "증진팀",
                notes: []
            })
        });

        assert(res.status === 201, `HTTP status is 201 (got ${res.status})`);
        const body = await res.json();
        assert(body.success === true, `Response success is true`);
        assert(body.data.refNo.startsWith('JJ-26-'), `refNo prefixed with JJ-26- (got ${body.data.refNo})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);
        assert(afterDisk.count === beforeDisk.count + 1, `Disk count: ${beforeDisk.count} -> ${afterDisk.count} (+1)`);
        assert(afterCache.count === beforeCache.count + 1, `Cache count: ${beforeCache.count} -> ${afterCache.count} (+1)`);
        assert(beforeDisk.ids.every(id => afterDisk.ids.includes(id)), `All existing IDs preserved`);
    }

    // --- TEST 2: 한글 여러 줄 기록내용 등록 ---
    console.log(`\n[Test 2] 한글 여러 줄 기록내용 등록`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        const multiLineText = "1차 초기상담 진행함.\n대상자 우울감 호소하며 내원 연계 요청함.\n추후 2차 상담 예정.";
        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userHbToken}`,
                'Cookie': `mind_session=${userHbToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: "테스트대상자2",
                team: "회복팀",
                notes: [{ date: "2026-10-01", text: multiLineText }],
                interventionContent: multiLineText
            })
        });

        assert(res.status === 201, `HTTP status is 201 (got ${res.status})`);
        const body = await res.json();
        assert(body.data.refNo.startsWith('HB-26-'), `refNo prefixed with HB-26- (got ${body.data.refNo})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);
        assert(afterDisk.count === beforeDisk.count + 1, `Disk count: ${beforeDisk.count} -> ${afterDisk.count} (+1)`);
        assert(afterCache.count === beforeCache.count + 1, `Cache count: ${beforeCache.count} -> ${afterCache.count} (+1)`);

        const savedItem = afterDisk.items.find(r => r.referralId === body.data.referralId);
        assert(savedItem.interventionContent === multiLineText, `Multi-line Korean preserved losslessly in disk`);
        assert(savedItem.notes[0].text === multiLineText, `Multi-line Korean in notes preserved losslessly`);
    }

    // --- TEST 3: 특수문자+줄바꿈 기록내용 등록 ---
    console.log(`\n[Test 3] 특수문자+줄바꿈 기록내용 등록`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        const specialText = `특수문자 테스트: !@#$%^&*()_+-=[]{}|;':",./<>?~\\n\r\t
따옴표와 슬래시: "큰따옴표" '작은따옴표' \\백슬래시 /슬래시
이모지: 🏥💊🩺🚨💙
줄바꿈 1\n줄바꿈 2\r\n줄바꿈 3`;

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: "테스트대상자3",
                team: "자살예방센터",
                notes: [{ date: "2026-10-01", text: specialText }]
            })
        });

        assert(res.status === 201, `HTTP status is 201 (got ${res.status})`);
        const body = await res.json();
        assert(body.data.refNo.startsWith('JY-26-'), `refNo prefixed with JY-26- for 자살예방센터 (got ${body.data.refNo})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);
        assert(afterDisk.count === beforeDisk.count + 1, `Disk count: ${beforeDisk.count} -> ${afterDisk.count} (+1)`);
        const savedItem = afterDisk.items.find(r => r.referralId === body.data.referralId);
        assert(savedItem.notes[0].text === specialText, `Special chars + newlines 100% identical on disk`);
    }

    // --- TEST 4: 최대 길이 기록내용 (10만자) ---
    console.log(`\n[Test 4] 최대 길이 기록내용 등록 (100,000자 대용량)`);
    {
        const beforeDisk = getDiskState();
        const maxLenText = "가나다라마바사아자차".repeat(10000); // 100,000 characters

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: "테스트대상자4",
                team: "아동청소년",
                notes: [{ date: "2026-10-01", text: maxLenText }]
            })
        });

        assert(res.status === 201, `HTTP status is 201 (got ${res.status})`);
        const body = await res.json();
        assert(body.data.refNo.startsWith('AC-26-'), `refNo prefixed with AC-26- for 아동청소년 (got ${body.data.refNo})`);

        const afterDisk = getDiskState();
        const savedItem = afterDisk.items.find(r => r.referralId === body.data.referralId);
        assert(savedItem.notes[0].text.length === 100000, `Notes length exactly 100,000 chars (no truncation)`);
    }

    // --- TEST 5: 잘못된 필드로 validation 실패 ---
    console.log(`\n[Test 5] Validation 실패 (필수필드 누락 -> 400 & 불변식 검증)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: "010-1234-5678" // missing name and team
            })
        });

        assert(res.status === 400, `HTTP status is 400 (got ${res.status})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);
        assert(afterDisk.count === beforeDisk.count, `[Invariant 5] Disk count unchanged (${beforeDisk.count} -> ${afterDisk.count})`);
        assert(afterCache.count === beforeCache.count, `[Invariant 5] Cache count unchanged (${beforeCache.count} -> ${afterCache.count})`);
        assert(afterDisk.checksum === beforeDisk.checksum, `[Invariant 5] Disk checksum unchanged`);
        assert(afterCache.checksum === beforeCache.checksum, `[Invariant 5] Cache checksum unchanged`);
    }

    // --- TEST 6: persistData 실패 강제 ---
    console.log(`\n[Test 6] persistData 실패 강제 (디스크 실패 시 캐시 선반영 결함 수정 검증)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        // Temporarily swap Referrals.json file with a directory to force EISDIR on atomic rename
        const referralsFilePath = path.join(DATA_DIR, 'Referrals.json');
        const backupPath = path.join(DATA_DIR, 'Referrals.json.saved_for_test6');
        fs.renameSync(referralsFilePath, backupPath);
        fs.mkdirSync(referralsFilePath);

        let persistFailed = false;
        try {
            const res = await fetch(`${BASE_URL}/api/referrals`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userJjToken}`,
                    'Cookie': `mind_session=${userJjToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: "디스크실패유발대상자",
                    team: "증진팀"
                })
            });

            if (res.status === 500) {
                persistFailed = true;
            }
        } finally {
            // Restore original Referrals.json file
            try { fs.rmSync(referralsFilePath, { recursive: true, force: true }); } catch {}
            try { fs.renameSync(backupPath, referralsFilePath); } catch {}
        }

        assert(persistFailed === true, `POST /api/referrals returned 500 on persistData failure`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);

        assert(afterDisk.count === beforeDisk.count, `[Invariant 6] Disk count unchanged: ${beforeDisk.count} -> ${afterDisk.count}`);
        assert(afterCache.count === beforeCache.count, `[Invariant 6] Cache count unchanged: ${beforeCache.count} -> ${afterCache.count} (NO GHOST RECORD)`);
        assert(afterDisk.checksum === beforeDisk.checksum, `[Invariant 6] Disk checksum 0 delta`);
        assert(afterCache.checksum === beforeCache.checksum, `[Invariant 6] Cache checksum 0 delta`);
    }

    // --- TEST 7: 동시 신규등록 2건 ---
    console.log(`\n[Test 7] 동시 신규등록 2건 (동시 요청 순차 채번 및 락 직렬화)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);

        const [res1, res2] = await Promise.all([
            fetch(`${BASE_URL}/api/referrals`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userJjToken}`,
                    'Cookie': `mind_session=${userJjToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: "동시대상자1", team: "남부분소" })
            }),
            fetch(`${BASE_URL}/api/referrals`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userJjToken}`,
                    'Cookie': `mind_session=${userJjToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: "동시대상자2", team: "남부분소" })
            })
        ]);

        assert(res1.status === 201 && res2.status === 201, `Both concurrent requests returned 201`);
        const b1 = await res1.json();
        const b2 = await res2.json();

        assert(b1.data.refNo !== b2.data.refNo, `Both assigned different refNos (${b1.data.refNo} vs ${b2.data.refNo})`);
        assert(b1.data.refNo.startsWith('NB-26-') && b2.data.refNo.startsWith('NB-26-'), `Both have NB-26- prefix for 남부분소`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);
        assert(afterDisk.count === beforeDisk.count + 2, `Disk count exactly +2 (${beforeDisk.count} -> ${afterDisk.count})`);
        assert(afterCache.count === beforeCache.count + 2, `Cache count exactly +2 (${beforeCache.count} -> ${afterCache.count})`);
    }

    // --- TEST 8: ID 충돌 (409 거부 + 기존 보존) ---
    console.log(`\n[Test 8] ID 충돌 (클라이언트가 기존 referralId 주입 시 409 거부 & 불변식 검증)`);
    {
        const beforeDisk = getDiskState();
        const beforeCache = await getCacheState(adminToken);
        const existingRecord = beforeDisk.items.find(r => r.referralId === 'init-ref-001');

        const res = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                referralId: 'init-ref-001', // EXISTING ID!
                name: "악의적덮어쓰기시도",
                team: "증진팀"
            })
        });

        assert(res.status === 409, `HTTP status is 409 Conflict (got ${res.status})`);
        const body = await res.json();
        assert(body.code === 'DUPLICATE_REFERRAL_ID', `Error code is DUPLICATE_REFERRAL_ID (got ${body.code})`);

        const afterDisk = getDiskState();
        const afterCache = await getCacheState(adminToken);

        assert(afterDisk.count === beforeDisk.count, `[Invariant 8] Disk count unchanged: ${beforeDisk.count} -> ${afterDisk.count}`);
        assert(afterCache.count === beforeCache.count, `[Invariant 8] Cache count unchanged: ${beforeCache.count} -> ${afterCache.count}`);
        assert(afterDisk.checksum === beforeDisk.checksum, `[Invariant 8] Disk checksum 0 delta`);
        assert(afterCache.checksum === beforeCache.checksum, `[Invariant 8] Cache checksum 0 delta`);

        const preservedRecord = afterDisk.items.find(r => r.referralId === 'init-ref-001');
        assert(preservedRecord.name === existingRecord.name, `Existing record untouched: name is still "${preservedRecord.name}"`);
    }

    // --- TEST 9: 부서 필터 화면 상태 등록 후 전 부서 조회 ---
    console.log(`\n[Test 9] 부서 필터 화면 상태 등록 후 전 부서 조회 (루트 커즈 해소 검증)`);
    {
        // Register a record for '회복팀' using userJj (who belongs to '증진팀')
        const regRes = await fetch(`${BASE_URL}/api/referrals`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: "타부서의뢰등록건",
                team: "회복팀"
            })
        });
        assert(regRes.status === 201, `Registration for other department succeeded with 201`);
        const regBody = await regRes.json();
        const createdId = regBody.data.referralId;

        // Query with team=all as non-admin userJj (소속팀: 증진팀)
        const allRes = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'x-user-id': 'synthetic_user_jj',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('증진팀')
            }
        });
        assert(allRes.status === 200, `GET /api/referrals?team=all returned 200`);
        const allItems = await allRes.json();

        const foundCreated = allItems.find(r => r.referralId === createdId);
        assert(Boolean(foundCreated), `Registered other-team record is VISIBLE in all-teams query (Root Cause Resolved!)`);

        // Also query with NO team parameter
        const defaultRes = await fetch(`${BASE_URL}/api/referrals`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'x-user-id': 'synthetic_user_jj',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('증진팀')
            }
        });
        const defaultItems = await defaultRes.json();
        const foundInDefault = defaultItems.find(r => r.referralId === createdId);
        assert(Boolean(foundInDefault), `Registered other-team record is VISIBLE in default (no param) query for non-admin`);
    }

    console.log(`\n======================================================`);
    console.log(`PART 2: INQUIRY SCOPE & ISOLATION GUARDS VERIFICATION`);
    console.log(`======================================================`);

    // 2.1 Non-admin all-department query
    console.log(`\n[Inquiry 1] 의뢰 권한 있는 non-admin의 전 부서 조회 검증`);
    {
        const res = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'x-user-id': 'synthetic_user_jj',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('증진팀')
            }
        });
        const items = await res.json();
        const teamsPresent = new Set(items.map(r => r.team));
        assert(teamsPresent.has('증진팀'), `Contains 증진팀 records`);
        assert(teamsPresent.has('회복팀'), `Contains 회복팀 records`);
        assert(teamsPresent.has('남부분소'), `Contains 남부분소 records`);
        assert(teamsPresent.has('자살예방센터'), `Contains 자살예방센터 records`);
        assert(teamsPresent.has('아동청소년'), `Contains 아동청소년 records`);
        console.log(`  ✔ PASS: Non-admin user sees all 5 departments when requesting team=all`);

        // Explicit team filter test
        const hbRes = await fetch(`${BASE_URL}/api/referrals?team=${encodeURIComponent('회복팀')}`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'x-user-id': 'synthetic_user_jj',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('증진팀')
            }
        });
        const hbItems = await hbRes.json();
        assert(hbItems.every(r => r.team === '회복팀' || (r.team === '남부분소' && r.subTeam === '회복팀')), `Explicit team filter strictly respected`);
    }

    // 2.2 Suicide Attempters Ledger all-department query
    console.log(`\n[Inquiry 2] 자살시도자 대장 전 부서 조회 검증`);
    {
        const res = await fetch(`${BASE_URL}/api/suicideattempters`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`
            }
        });
        assert(res.status === 200, `GET /api/suicideattempters returned 200`);
        const items = await res.json();
        assert(items.length === 3, `Returned all 3 suicide attempter records (got ${items.length})`);
        const agencies = new Set(items.map(r => r.requestAgency));
        assert(agencies.has('이천경찰서') && agencies.has('이천소방서') && agencies.has('이천의료원'), `All agencies present without department restriction`);
        console.log(`  ✔ PASS: Suicide attempters ledger returns all records unconditionally`);
    }

    // 2.3 Case Analysis System Department Isolation Guard (REGRESSION GUARD)
    console.log(`\n[Inquiry 3] 사례분석 시스템 본인 부서 격리 유지 검증 (REGRESSION GUARD)`);
    {
        // 1) synthetic_user_jj (증진팀): should ONLY receive 증진팀 counselor data
        const jjRes = await fetch(`${BASE_URL}/api/analysis/current`, {
            headers: {
                'Authorization': `Bearer ${userJjToken}`,
                'Cookie': `mind_session=${userJjToken}`,
                'x-user-id': 'synthetic_user_jj',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('증진팀')
            }
        });
        assert(jjRes.status === 200, `GET /api/analysis/current for user_jj returned 200`);
        const jjData = (await jjRes.json()).data;
        const jjCounselorDepts = jjData.counselorPerformance.map(c => c.department);
        assert(jjCounselorDepts.length === 1 && jjCounselorDepts[0] === '증진팀', `user_jj ONLY sees 증진팀 in counselorPerformance (got ${JSON.stringify(jjCounselorDepts)})`);
        assert(jjData.memberPerformance.every(m => m.department === '증진팀'), `user_jj ONLY sees 증진팀 members`);

        // 2) synthetic_user_hb (회복팀): should ONLY receive 회복팀 counselor data
        const hbRes = await fetch(`${BASE_URL}/api/analysis/current`, {
            headers: {
                'Authorization': `Bearer ${userHbToken}`,
                'Cookie': `mind_session=${userHbToken}`,
                'x-user-id': 'synthetic_user_hb',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('회복팀')
            }
        });
        const hbData = (await hbRes.json()).data;
        const hbCounselorDepts = hbData.counselorPerformance.map(c => c.department);
        assert(hbCounselorDepts.length === 1 && hbCounselorDepts[0] === '회복팀', `user_hb ONLY sees 회복팀 in counselorPerformance (got ${JSON.stringify(hbCounselorDepts)})`);

        // 3) synthetic_admin: should see ALL counselors
        const adminRes = await fetch(`${BASE_URL}/api/analysis/current`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`,
                'Cookie': `mind_session=${adminToken}`,
                'x-user-id': 'synthetic_admin',
                'x-user-role': 'admin'
            }
        });
        const adminData = (await adminRes.json()).data;
        assert(adminData.counselorPerformance.length === 5, `Admin sees all 5 counselors across all departments`);
        console.log(`  ✔ PASS: Case analysis department isolation remains 100% intact and strict!`);
    }

    console.log(`\n======================================================`);
    console.log(`PART 3: TEAM_CODES PREFIX VALIDATION`);
    console.log(`======================================================`);
    {
        const teamsToTest = [
            { team: '증진팀', expectedPrefix: 'JJ-26-' },
            { team: '회복팀', expectedPrefix: 'HB-26-' },
            { team: '자살예방센터', expectedPrefix: 'JY-26-' },
            { team: '아동청소년', expectedPrefix: 'AC-26-' },
            { team: '남부분소', expectedPrefix: 'NB-26-' }
        ];

        for (const { team, expectedPrefix } of teamsToTest) {
            const res = await fetch(`${BASE_URL}/api/referrals`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${adminToken}`,
                    'Cookie': `mind_session=${adminToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: `채번검증_${team}`, team })
            });
            assert(res.status === 201, `Registration for ${team} returned 201`);
            const body = await res.json();
            assert(body.data.refNo.startsWith(expectedPrefix), `${team} assigned ${expectedPrefix} (got ${body.data.refNo})`);
            assert(!body.data.refNo.startsWith('ET-'), `${team} does NOT fall back to ET- prefix`);
        }
        console.log(`  ✔ PASS: All 5 frontend standard teams assigned correct prefixes matching constants.ts`);
    }

    console.log(`\n======================================================`);
    console.log(`RESULTS SUMMARY: ${passedTests} passed, ${failedTests} failed`);
    console.log(`======================================================\n`);

    if (failedTests > 0) {
        process.exitCode = 1;
    }
}

runSuite()
    .catch(err => {
        console.error('Fatal error during suite execution:', err);
        process.exitCode = 1;
    })
    .finally(() => {
        console.log('[CLEANUP] Terminating synthetic server and removing temporary test directory...');
        try {
            serverProcess.kill('SIGTERM');
        } catch {}
        try {
            if (fs.existsSync(TEST_DIR)) {
                fs.rmSync(TEST_DIR, { recursive: true, force: true });
            }
        } catch {}
    });

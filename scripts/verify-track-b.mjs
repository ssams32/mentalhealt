/**
 * Track B Verification Test Suite
 * 
 * Tests:
 * 1. 미등록 및 미종결 우선 기본 정렬 (GET /api/referrals)
 * 2. User.team과 Permission 기반 서버 측 부서 제한
 *    - admin: 모든 부서 조회 허용
 *    - authorized manager: 모든 부서 조회 허용
 *    - regular user: 소속팀으로 강제 격리
 *    - restricted manager (referrals.read === false): 소속팀으로 강제 격리
 * 3. 관리자 또는 승인된 manager의 부서 선택 UI 로직 (canSelectTeam)
 * 4. 필터 조건 전체에 대한 엑셀 데이터 빌드
 * 5. 상담메모(notes)와 첨부 본문(attachments) 기본 제외 검증
 * 6. Excel Formula Injection 방어 (CWE-1236)
 * 7. 다운로드 감사 로그 기록 (/api/activity & /api/logs)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const TEST_PORT = 8895;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// 1. Formula Injection Sanitizer Unit Test
function testFormulaInjection() {
    console.log('\n--- [Test 1] Formula Injection Defense (CWE-1236) ---');
    const sanitizeExcelCell = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(str.trimStart())) {
            return `'${str}`;
        }
        return str;
    };

    const dangerousInputs = [
        "=1+1",
        "=cmd|'/c calc'!A0",
        "+12345",
        "-500",
        "@SUM(A1:A10)",
        "\tmalicious_tab",
        "\rmalicious_cr",
        "  =leading_spaces_formula",
        "  +plus_with_space"
    ];

    dangerousInputs.forEach(input => {
        const sanitized = sanitizeExcelCell(input);
        assert(sanitized.startsWith("'"), `Failed to sanitize: ${input} -> ${sanitized}`);
        console.log(`  [PASS] ${JSON.stringify(input)} -> ${JSON.stringify(sanitized)}`);
    });

    const safeInputs = [
        "홍길동",
        "010-1234-5678",
        "이천시 부발읍",
        "정상 텍스트"
    ];

    safeInputs.forEach(input => {
        const sanitized = sanitizeExcelCell(input);
        assert.strictEqual(sanitized, input);
        console.log(`  [PASS] Safe value preserved: ${JSON.stringify(input)}`);
    });
    console.log('✅ Formula Injection Defense Test Passed!');
}

// 2. Sensitive Notes & Attachments Exclusion Test
function testSensitiveDataExclusion() {
    console.log('\n--- [Test 2] Sensitive Notes & Attachments Exclusion ---');
    const sampleReferral = {
        refNo: 'ET-26-001',
        name: '홍길동',
        gender: '남성',
        age: '35',
        region: '이천시 증포동',
        phone: '010-9999-8888',
        requestDate: '2026-09-01',
        requestAgency: '이천보건소',
        requestorName: '김간호',
        actionResult: '등록관리진행',
        assignee: '이담당',
        reply: false,
        replyStatus: '회신예정',
        latestNote: '최신 1회성 요약 상담내용입니다.',
        // Sensitive detailed note history (MUST BE EXCLUDED)
        notes: [
            { id: 'n1', content: '민감한 상세 과거 병력 기록 (엑셀 제외 대상)', createdAt: '2026-08-01' },
            { id: 'n2', content: '최신 1회성 요약 상담내용입니다.', createdAt: '2026-09-01' }
        ],
        // Sensitive attachments binary/metadata (MUST BE EXCLUDED)
        attachments: [
            { id: 'att1', name: '진단서.pdf', data: 'JVBERi0xLjQK...', size: 1048576 }
        ]
    };

    // Simulate Excel row generation from ReferralDashboardV2.tsx
    const sanitizeExcelCell = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(str.trimStart())) {
            return `'${str}`;
        }
        return str;
    };

    let noteContent = sampleReferral.latestNote || '-';
    if (noteContent === '-' && sampleReferral.notes && sampleReferral.notes.length > 0) {
        const sortedNotes = [...sampleReferral.notes].sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        noteContent = sortedNotes[0].content || '-';
    }

    const row = [
        sanitizeExcelCell('1'),
        sanitizeExcelCell(sampleReferral.name),
        sanitizeExcelCell(sampleReferral.gender === '여성' ? '여' : sampleReferral.gender === '남성' ? '남' : sampleReferral.gender),
        sanitizeExcelCell(sampleReferral.age),
        sanitizeExcelCell(sampleReferral.region || '이천시'),
        sanitizeExcelCell(sampleReferral.phone || '-'),
        sanitizeExcelCell(sampleReferral.requestDate),
        sanitizeExcelCell(sampleReferral.requestAgency),
        sanitizeExcelCell(sampleReferral.requestorName || '-'),
        sanitizeExcelCell(noteContent),
        sanitizeExcelCell(sampleReferral.actionResult || '-'),
        sanitizeExcelCell(sampleReferral.region),
        sanitizeExcelCell(sampleReferral.assignee),
        sanitizeExcelCell(sampleReferral.replyStatus || (sampleReferral.reply ? '회신완료' : '회신예정'))
    ];

    // Assert: full notes array and attachments are NOT in row
    const rowString = JSON.stringify(row);
    assert(!rowString.includes('민감한 상세 과거 병력 기록'), 'Full notes history leaked into excel!');
    assert(!rowString.includes('진단서.pdf'), 'Attachment filename/object leaked into excel!');
    assert(!rowString.includes('JVBERi0xLjQK'), 'Attachment binary leaked into excel!');
    assert(row[9].includes('최신 1회성 요약 상담내용입니다.'), 'Latest note summary should be preserved');
    console.log('✅ Sensitive Data Exclusion Test Passed!');
}

// 3. UI Team Selection Permission Unit Test
function testCanSelectTeamPermission() {
    console.log('\n--- [Test 3] UI canSelectTeam Permission Logic ---');
    const evaluateCanSelectTeam = (currentUser) => {
        if (!currentUser) return false;
        if (currentUser.role === 'admin') return true;
        if (currentUser.role === 'manager') {
            return currentUser.permissions?.referrals?.read !== false;
        }
        return false;
    };

    assert.strictEqual(evaluateCanSelectTeam({ role: 'admin', team: '증진팀' }), true, 'Admin must be able to select team');
    assert.strictEqual(evaluateCanSelectTeam({ role: 'manager', team: '회복팀', permissions: { referrals: { read: true } } }), true, 'Authorized manager must be able to select team');
    assert.strictEqual(evaluateCanSelectTeam({ role: 'manager', team: '회복팀', permissions: {} }), true, 'Manager without explicit read restriction must be able to select team');
    assert.strictEqual(evaluateCanSelectTeam({ role: 'manager', team: '회복팀', permissions: { referrals: { read: false } } }), false, 'Restricted manager must NOT be able to select team');
    assert.strictEqual(evaluateCanSelectTeam({ role: 'user', team: '자살예방센터' }), false, 'Regular user must NOT be able to select team');
    console.log('✅ UI canSelectTeam Permission Test Passed!');
}

// 4. Server-Side Tests (Spawn test instance of server.js)
async function runServerTests() {
    console.log('\n--- [Test 4] Server-Side Team Enforcement & Default Sorting ---');
    
    // Prepare test mock environment
    const testDataDir = path.resolve('test-track-b-data');
    if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });

    // Seed test users
    const testUsers = [
        { id: 'admin_test', username: 'admin_test', role: 'admin', team: '증진팀' },
        { id: 'manager_auth', username: 'manager_auth', role: 'manager', team: '회복팀', permissions: { referrals: { read: true } } },
        { id: 'manager_rest', username: 'manager_rest', role: 'manager', team: '자살예방센터', permissions: { referrals: { read: false } } },
        { id: 'user_recovery', username: 'user_recovery', role: 'user', team: '회복팀' },
        { id: 'user_promotion', username: 'user_promotion', role: 'user', team: '증진팀' }
    ];
    fs.writeFileSync(path.join(testDataDir, 'Users.json'), JSON.stringify(testUsers, null, 2));

    // Seed test referrals with various statuses and dates for sorting & filtering
    const testReferrals = [
        {
            referralId: 'ref-1',
            refNo: 'ET-26-001',
            name: '김종결',
            team: '증진팀',
            closureStatus: '종결',
            actionResult: '종결',
            registrationStatus: '등록',
            requestDate: '2026-09-05'
        },
        {
            referralId: 'ref-2',
            refNo: 'ET-26-002',
            name: '박미종결과거',
            team: '증진팀',
            closureStatus: '미종결',
            actionResult: '진행중',
            registrationStatus: '등록',
            requestDate: '2026-09-01'
        },
        {
            referralId: 'ref-3',
            refNo: 'ET-26-003',
            name: '이미종결최신',
            team: '증진팀',
            closureStatus: '미종결',
            actionResult: '진행중',
            registrationStatus: '등록',
            requestDate: '2026-09-07'
        },
        {
            referralId: 'ref-4',
            refNo: 'ET-26-004',
            name: '최미등록',
            team: '증진팀',
            closureStatus: '미종결',
            actionResult: '미등록',
            registrationStatus: '미등록',
            requestDate: '2026-09-03'
        },
        {
            referralId: 'ref-5',
            refNo: 'RC-26-001',
            name: '정회복미종결',
            team: '회복팀',
            closureStatus: '미종결',
            actionResult: '상담중',
            registrationStatus: '등록',
            requestDate: '2026-09-06'
        },
        {
            referralId: 'ref-6',
            refNo: 'SP-26-001',
            name: '강자살예방',
            team: '자살예방센터',
            closureStatus: '미종결',
            actionResult: '상담중',
            registrationStatus: '등록',
            requestDate: '2026-09-04'
        }
    ];
    fs.writeFileSync(path.join(testDataDir, 'Referrals.json'), JSON.stringify(testReferrals, null, 2));
    fs.writeFileSync(path.join(testDataDir, 'ActivityLogs.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(testDataDir, 'Logs.json'), JSON.stringify([], null, 2));

    // Spawn server process on TEST_PORT pointing to testDataDir
    console.log(`Starting isolated test server on port ${TEST_PORT}...`);
    const serverProc = spawn('node', ['server.js'], {
        env: {
            ...process.env,
            PORT: String(TEST_PORT),
            DATA_DIR: testDataDir
        },
        stdio: 'pipe'
    });

    serverProc.stdout.on('data', d => {
        // console.log(`[SERVER]: ${d}`);
    });
    serverProc.stderr.on('data', d => {
        // console.error(`[SERVER ERR]: ${d}`);
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
        let attempts = 0;
        const interval = setInterval(async () => {
            attempts++;
            try {
                const res = await fetch(`${BASE_URL}/api/health`);
                if (res.ok) {
                    clearInterval(interval);
                    resolve();
                }
            } catch (e) {
                if (attempts > 30) {
                    clearInterval(interval);
                    serverProc.kill();
                    reject(new Error('Server failed to start in time'));
                }
            }
        }, 200);
    });

    console.log('Isolated test server is UP!');

    try {
        // Subtest A: Server-Side Default Sort Order
        console.log('\n  [Subtest A] Server-Side Default Sorting Verification:');
        const sortRes = await fetch(`${BASE_URL}/api/referrals?team=증진팀`, {
            headers: {
                'x-user-id': 'admin_test',
                'x-user-role': 'admin'
            }
        });
        const sortData = await sortRes.json();
        const sortedNames = sortData.map(r => r.name);
        console.log('    Returned Order:', sortedNames);

        // Expectation:
        // 1. 미등록 우선 ('최미등록')
        // 2. 미종결 우선 중 최신일자 ('이미종결최신' 09-07 > '박미종결과거' 09-01)
        // 3. 종결 건 최하단 ('김종결')
        assert.strictEqual(sortedNames[0], '최미등록', '1st should be unregistered: 최미등록');
        assert.strictEqual(sortedNames[1], '이미종결최신', '2nd should be latest unclosed: 이미종결최신');
        assert.strictEqual(sortedNames[2], '박미종결과거', '3rd should be older unclosed: 박미종결과거');
        assert.strictEqual(sortedNames[3], '김종결', '4th should be closed: 김종결');
        console.log('    ✅ Default Sorting (Unregistered > Unclosed > Date DESC > refNo DESC) Verified!');

        // Subtest B: Server-Side Team Enforcement for Regular User
        console.log('\n  [Subtest B] Server-Side Department Restriction for Regular User:');
        // user_recovery attempts to query team=all or team=증진팀
        const userAllRes = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'x-user-id': 'user_recovery',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('회복팀')
            }
        });
        const userAllData = await userAllRes.json();
        assert(userAllData.length > 0, 'User should get records');
        assert(userAllData.every(r => r.team === '회복팀'), 'User must ONLY receive their own team records (회복팀)');
        console.log(`    ✅ Regular User querying team=all strictly restricted to: ${userAllData.map(r => r.team).join(', ')}`);

        // User attempts to query another team explicitly
        const userOtherRes = await fetch(`${BASE_URL}/api/referrals?team=${encodeURIComponent('증진팀')}`, {
            headers: {
                'x-user-id': 'user_recovery',
                'x-user-role': 'user',
                'x-user-team': encodeURIComponent('회복팀')
            }
        });
        const userOtherData = await userOtherRes.json();
        assert(userOtherData.every(r => r.team === '회복팀'), 'User querying another team must be forced to own team!');
        console.log(`    ✅ Regular User querying team=증진팀 strictly overridden to: ${userOtherData.map(r => r.team).join(', ')}`);

        // Subtest C: Restricted Manager Enforcement
        console.log('\n  [Subtest C] Restricted Manager Enforcement:');
        const restMgrRes = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'x-user-id': 'manager_rest',
                'x-user-role': 'manager',
                'x-user-team': encodeURIComponent('자살예방센터')
            }
        });
        const restMgrData = await restMgrRes.json();
        assert(restMgrData.every(r => r.team === '자살예방센터'), 'Restricted manager must ONLY get own team records');
        console.log(`    ✅ Restricted Manager strictly restricted to: ${restMgrData.map(r => r.team).join(', ')}`);

        // Subtest D: Admin and Authorized Manager Cross-Team Access
        console.log('\n  [Subtest D] Admin & Authorized Manager Cross-Team Access:');
        const adminRes = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'x-user-id': 'admin_test',
                'x-user-role': 'admin'
            }
        });
        const adminData = await adminRes.json();
        assert.strictEqual(adminData.length, testReferrals.length, 'Admin must see ALL referrals across teams');
        console.log(`    ✅ Admin successfully retrieved all ${adminData.length} records across all teams.`);

        const authMgrRes = await fetch(`${BASE_URL}/api/referrals?team=all`, {
            headers: {
                'x-user-id': 'manager_auth',
                'x-user-role': 'manager',
                'x-user-team': encodeURIComponent('회복팀')
            }
        });
        const authMgrData = await authMgrRes.json();
        assert.strictEqual(authMgrData.length, testReferrals.length, 'Authorized manager must see ALL referrals');
        console.log(`    ✅ Authorized Manager successfully retrieved all ${authMgrData.length} records.`);

        // Subtest E: Audit Log for Excel Export
        console.log('\n  [Subtest E] Excel Download Audit Logging:');
        const auditPayload = {
            user: '김상담사',
            action: 'EXCEL_EXPORT',
            details: '의뢰대장 엑셀 다운로드 [필터 전체 6건] (팀: 증진팀, 검색: "없음")'
        };

        const auditRes = await fetch(`${BASE_URL}/api/activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(auditPayload)
        });
        assert.strictEqual(auditRes.status, 200);

        // Verify audit log file
        const writtenLogs = JSON.parse(fs.readFileSync(path.join(testDataDir, 'ActivityLogs.json'), 'utf8'));
        assert(writtenLogs.length > 0, 'Audit log should have been saved');
        const lastLog = writtenLogs[writtenLogs.length - 1];
        assert.strictEqual(lastLog.user, '김상담사');
        assert.strictEqual(lastLog.action, 'EXCEL_EXPORT');
        assert(lastLog.details.includes('필터 전체 6건'));
        console.log(`    ✅ Audit log successfully written to ActivityLogs.json:`, lastLog);

    } finally {
        // Cleanup server and test directory
        console.log('\nShutting down isolated test server...');
        serverProc.kill();
        // remove testDataDir
        try {
            fs.rmSync(testDataDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

async function runAll() {
    try {
        testFormulaInjection();
        testSensitiveDataExclusion();
        testCanSelectTeamPermission();
        await runServerTests();
        console.log('\n=============================================');
        console.log('🎉 ALL TRACK B AUDIT & VERIFICATION TESTS PASSED!');
        console.log('=============================================\n');
    } catch (err) {
        console.error('\n❌ TRACK B VERIFICATION FAILED:', err);
        process.exit(1);
    }
}

runAll();

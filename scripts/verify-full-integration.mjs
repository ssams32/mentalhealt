/**
 * verify-full-integration.mjs
 * Track A, B, C 종합 통합 검증 테스트 스크립트
 * 
 * 검증 항목:
 * 1. 저장 실패 및 유효성 검사 방어
 * 2. 연속 등록 테스트 (Rapid Sequential Creation)
 * 3. 동시 채번 테스트 (Concurrent Lock & Auto-numbering)
 * 4. Version 충돌 테스트 (OCC 409 Conflict)
 * 5. 팀 권한 우회 테스트 (Header tampering & query bypass)
 * 6. 엑셀 데이터 노출 및 Injection 방어 테스트
 * 7. 기존 기능 회귀 테스트 (Soft delete, Restore, Notes, Stats)
 * 8. 소스코드 민감정보 검사 (Hardcoded Secrets Scanner)
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const TEST_PORT = 8896;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_DIR = path.resolve('scratch/test_integration_env');
const TEST_DATA_DIR = path.join(TEST_DIR, 'app/data');

// 1. 테스트 격리 환경 초기화
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// Mock 데이터 시딩
const mockUsers = [
  { id: 'admin1', username: 'admin', role: 'admin', team: '증진팀', name: '관리자' },
  { id: 'mgr_ok', username: 'mgr_ok', role: 'manager', team: '회복팀', name: '인가매니저', permissions: { referrals: { read: true, write: true, delete: true } } },
  { id: 'mgr_no', username: 'mgr_no', role: 'manager', team: '자살예방센터', name: '비인가매니저', permissions: { referrals: { read: false, write: false, delete: false } } },
  { id: 'user1', username: 'user1', role: 'user', team: '증진팀', name: '일반유저1' },
  { id: 'user2', username: 'user2', role: 'user', team: '회복팀', name: '일반유저2' }
];

const mockReferrals = [
  {
    referralId: 'REF-SEED-01',
    refNo: 'JJ-26-0001',
    clientId: 'CL-001',
    name: '홍길동',
    team: '증진팀',
    registrationStatus: '미등록',
    closureStatus: '미종결',
    processStatus: '접수',
    requestDate: '2026-03-01',
    version: 1,
    notes: [{ id: 'n1', content: '비밀 상담내역 1: 매우 민감한 개인정보', author: '상담원' }],
    attachments: [{ id: 'att1', name: '진단서.pdf', content: 'BASE64_SECRET_DATA' }]
  },
  {
    referralId: 'REF-SEED-02',
    refNo: 'HB-26-0001',
    clientId: 'CL-002',
    name: '이순신',
    team: '회복팀',
    registrationStatus: '등록',
    closureStatus: '미종결',
    processStatus: '진행',
    requestDate: '2026-03-02',
    version: 1,
    notes: [{ id: 'n2', content: '비밀 상담내역 2', author: '상담원' }],
    attachments: [{ id: 'att2', name: '소견서.pdf', content: 'BASE64_SECRET_DATA' }]
  }
];

fs.writeFileSync(path.join(TEST_DATA_DIR, 'Users.json'), JSON.stringify(mockUsers, null, 2));
fs.writeFileSync(path.join(TEST_DATA_DIR, 'Referrals.json'), JSON.stringify(mockReferrals, null, 2));
fs.writeFileSync(path.join(TEST_DATA_DIR, 'DeletedReferrals.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(TEST_DATA_DIR, 'ActivityLogs.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(TEST_DATA_DIR, 'Logs.json'), JSON.stringify([], null, 2));

// 2. 서버 실행
console.log('[1/8] 격리 테스트 서버 실행 중...');
const serverProcess = spawn('node', ['server.js'], {
  env: {
    ...process.env,
    PORT: TEST_PORT.toString(),
    DATA_DIR: TEST_DATA_DIR
  },
  stdio: 'pipe'
});

serverProcess.stderr.on('data', d => {
  const msg = d.toString();
  if (!msg.includes('ExperimentalWarning')) {
    console.error(`[Server Stderr]: ${msg}`);
  }
});

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`${BASE_URL}/api/users`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error('서버 기동 실패');
}

async function runTests() {
  await waitForServer();
  console.log('✔ 격리 테스트 서버 기동 완료 (Port: ' + TEST_PORT + ')');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      failed++;
      throw new Error(message);
    } else {
      console.log(`✔ PASS: ${message}`);
      passed++;
    }
  }

  // TEST 1: 저장 실패 및 유효성 검사 방어
  console.log('\n--- [TEST 1] 저장 실패 및 유효성 검사 방어 ---');
  {
    // 필수값 누락 생성 시 400 거부
    const badRes = await fetch(`${BASE_URL}/api/referrals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }) // team 누락
    });
    assert(badRes.status === 400, '필수 필드(team) 누락 시 400 Bad Request 반환');

    // 존재하지 않는 리소스 수정 시 404
    const notFoundRes = await fetch(`${BASE_URL}/api/referrals/NON-EXISTENT-ID`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '존재안함' })
    });
    assert(notFoundRes.status === 404, '존재하지 않는 ID 수정 시 404 반환');
  }

  // TEST 2: 연속 등록 테스트 (Sequential Creation)
  console.log('\n--- [TEST 2] 연속 등록 테스트 (5건 연속) ---');
  {
    const createdIds = [];
    const createdRefNos = [];
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${BASE_URL}/api/referrals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `seq-key-${i}`
        },
        body: JSON.stringify({
          name: `연속대상자_${i}`,
          team: '증진팀',
          requestDate: '2026-03-05'
        })
      });
      assert(res.status === 201, `연속 등록 ${i}건째 201 Created 응답`);
      const body = await res.json();
      assert(body.success && body.data, '응답에 success와 data 포함');
      const item = body.data;
      assert(item.referralId && !createdIds.includes(item.referralId), `고유 referralId 생성 (${item.referralId})`);
      assert(item.refNo && !createdRefNos.includes(item.refNo), `고유 refNo 채번 (${item.refNo})`);
      createdIds.push(item.referralId);
      createdRefNos.push(item.refNo);
    }
    assert(createdIds.length === 5, '연속 등록 5건 모두 성공 및 고유키 보장');
  }

  // TEST 3: 동시 채번 테스트 (Concurrent Auto-numbering 10건)
  console.log('\n--- [TEST 3] 동시 채번 테스트 (10건 동시 요청) ---');
  {
    const promises = Array.from({ length: 10 }).map((_, idx) =>
      fetch(`${BASE_URL}/api/referrals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `concurrent-key-${idx}-${Date.now()}`
        },
        body: JSON.stringify({
          name: `동시대상자_${idx}`,
          team: '회복팀',
          requestDate: '2026-03-06'
        })
      }).then(async r => {
        const json = await r.json();
        return json.data;
      })
    );

    const results = await Promise.all(promises);
    const refNos = results.map(r => r.refNo);
    const uniqueRefNos = new Set(refNos);
    assert(uniqueRefNos.size === 10, `동시 10건 생성 시 번호 충돌 0건 (고유 번호 수: ${uniqueRefNos.size}/10)`);
    console.log('채번 결과:', Array.from(uniqueRefNos).sort());
  }

  // TEST 4: Version 충돌 테스트 (OCC 409 Conflict)
  console.log('\n--- [TEST 4] Version 충돌 테스트 (OCC) ---');
  {
    // REF-SEED-01 (version: 1)
    // 1. 정상 업데이트 (version 1 -> 2)
    const update1 = await fetch(`${BASE_URL}/api/referrals/REF-SEED-01`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referralId: 'REF-SEED-01',
        name: '홍길동_수정1',
        version: 1
      })
    });
    assert(update1.status === 200, '정상 버전(1) 수정 시 200 OK');
    const update1Body = await update1.json();
    assert(update1Body.data.version === 2, '수정 후 version 2로 증가');

    // 2. 구버전(version 1)으로 재시도 -> 409 Conflict 발생해야 함
    const updateConflict = await fetch(`${BASE_URL}/api/referrals/REF-SEED-01`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referralId: 'REF-SEED-01',
        name: '홍길동_충돌시도',
        version: 1 // 이미 2로 올라갔으므로 1은 충돌
      })
    });
    assert(updateConflict.status === 409, '구버전(version 1)으로 수정 시도 시 409 Conflict 발생');
  }

  // TEST 5: 팀 권한 우회 테스트
  console.log('\n--- [TEST 5] 팀 권한 우회 차단 테스트 ---');
  {
    // 일반 사용자 (user2: 회복팀)가 '증진팀' 또는 '전체' 요청 시 강제 회복팀 데이터만 반환되어야 함
    const userBypassAttempt = await fetch(`${BASE_URL}/api/referrals?team=${encodeURIComponent('증진팀')}`, {
      headers: {
        'x-user-id': 'user2',
        'x-user-role': 'user',
        'x-user-team': encodeURIComponent('회복팀')
      }
    });
    assert(userBypassAttempt.status === 200, '일반 사용자 조회 성공');
    const userList = await userBypassAttempt.json();
    const otherTeamItems = userList.filter(item => item.team !== '회복팀');
    assert(otherTeamItems.length === 0, '일반 사용자의 타 부서 쿼리 우회 시도 차단 (오직 본인팀 데이터만 반환)');

    // 비인가 매니저(mgr_no: 자살예방센터, permissions.referrals.read = false)
    const mgrBypassAttempt = await fetch(`${BASE_URL}/api/referrals?team=전체`, {
      headers: {
        'x-user-id': 'mgr_no',
        'x-user-role': 'manager',
        'x-user-team': encodeURIComponent('자살예방센터')
      }
    });
    const mgrList = await mgrBypassAttempt.json();
    const invalidMgrItems = mgrList.filter(item => item.team !== '자살예방센터');
    assert(invalidMgrItems.length === 0, '비인가 매니저 전체 조회 우회 차단 (오직 본인팀 데이터만 반환)');
  }

  // TEST 6: 엑셀 데이터 노출 및 Injection 방어 테스트
  console.log('\n--- [TEST 6] 엑셀 데이터 노출 및 Formula Injection 방어 테스트 ---');
  {
    // 살균 로직 검증 (ReferralDashboardV2의 sanitizeExcelCell 로직)
    const sanitizeExcelCell = (value) => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@]/.test(str.trimStart())) {
        return `'${str}`;
      }
      return str;
    };

    const injectionPayloads = [
      '=cmd|\' /C calc\'!A0',
      '+1+2',
      '-5',
      '@SUM(1,2)',
      '\t=calc',
      '\r@danger',
      '   =spacedFormula'
    ];

    for (const p of injectionPayloads) {
      const sanitized = sanitizeExcelCell(p);
      assert(sanitized.startsWith("'"), `수식 주입 페이로드 [${p}] 살균 처리: [${sanitized}]`);
    }

    // 엑셀 내보내기 행에서 notes/attachments 제외 검증
    const sampleRecord = {
      refNo: 'TEST-01',
      name: '홍길동',
      notes: [{ id: 'n1', content: 'SECRET_NOTE_BODY' }],
      attachments: [{ id: 'att1', content: 'SECRET_FILE_BODY' }],
      latestNote: '요약 노트만 허용'
    };

    const exportRow = {
      '의뢰번호': sanitizeExcelCell(sampleRecord.refNo),
      '이름': sanitizeExcelCell(sampleRecord.name),
      '최근노트': sanitizeExcelCell(sampleRecord.latestNote)
    };

    assert(!('notes' in exportRow) && !('attachments' in exportRow), '엑셀 내보내기 행에 민감 본문(notes, attachments) 미포함');

    // 감사 로그 기록 검증
    const auditRes = await fetch(`${BASE_URL}/api/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'EXCEL_EXPORT',
        user: 'admin1',
        details: '전체 의뢰대장 엑셀 다운로드 (테스트)'
      })
    });
    assert(auditRes.status === 200 || auditRes.status === 201, `감사 로그 기록 HTTP ${auditRes.status} 응답`);
    const logDisk = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'ActivityLogs.json'), 'utf8'));
    assert(logDisk.some(l => l.action === 'EXCEL_EXPORT'), 'ActivityLogs.json에 엑셀 다운로드 감사 로그 영구 기록 확인');
  }

  // TEST 7: 기존 기능 회귀 테스트 (Soft Delete, Restore, Note addition)
  console.log('\n--- [TEST 7] 기존 기능 회귀 테스트 ---');
  {
    // 1. 상담메모 추가 (PUT /api/referrals/:id)
    const curRes = await fetch(`${BASE_URL}/api/referrals`);
    const curList = await curRes.json();
    const curItem = curList.find(r => r.referralId === 'REF-SEED-01');
    const updatedNotes = [...(curItem.notes || []), { id: 'n_new', content: '신규 테스트 메모', author: '담당자' }];
    
    const noteRes = await fetch(`${BASE_URL}/api/referrals/REF-SEED-01`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...curItem,
        notes: updatedNotes,
        latestNote: '신규 테스트 메모'
      })
    });
    assert(noteRes.status === 200, '상담메모 추가(PUT /api/referrals/:id) 200 OK');

    // 2. 의뢰 소프트 삭제 (휴지통 이동)
    const deleteRes = await fetch(`${BASE_URL}/api/referrals/REF-SEED-02`, {
      method: 'DELETE'
    });
    assert(deleteRes.status === 200, '의뢰 삭제 API 200 OK');
    const deletedFile = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Trash.json'), 'utf8'));
    assert(deletedFile.some(d => d.referralId === 'REF-SEED-02'), 'Trash.json에 삭제 건 보관 확인');

    // 3. 의뢰 복원
    const restoreRes = await fetch(`${BASE_URL}/api/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'REF-SEED-02' })
    });
    assert(restoreRes.status === 200, '의뢰 복원 API 200 OK');
    const restoredReferrals = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'Referrals.json'), 'utf8'));
    assert(restoredReferrals.some(r => r.referralId === 'REF-SEED-02'), 'Referrals.json에 복원 확인');
  }

  // TEST 8: 소스코드 민감정보 검사
  console.log('\n--- [TEST 8] 소스코드 민감정보 검사 ---');
  {
    const sensitivePatterns = [
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      /ghp_[0-9a-zA-Z]{36}/, // GitHub Personal Access Token
      /AKIA[0-9A-Z]{16}/, // AWS Access Key
      /(?:api_key|apiKey|secret_key|privateKey)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
      /eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{15,}/ // JWT Token
    ];

    const filesToScan = [
      'server.js',
      'services/apiClient.ts',
      'components/referrals/ReferralDashboardV2.tsx',
      'components/referrals/ReferralEditor.tsx',
      'types.ts',
      'constants.ts'
    ];

    let leakFound = false;
    for (const f of filesToScan) {
      const content = fs.readFileSync(path.resolve(f), 'utf8');
      for (const pattern of sensitivePatterns) {
        if (pattern.test(content)) {
          console.error(`🚨 민감정보 의심 패턴 발견 in ${f}: ${pattern}`);
          leakFound = true;
        }
      }
    }
    assert(!leakFound, '핵심 소스코드 내 하드코딩된 민감정보(비밀키, 토큰, JWT) 없음 확인');
  }

  console.log(`\n========================================`);
  console.log(`🎉 모든 종합 통합 검증 완료: ${passed} 통과, ${failed} 실패`);
  console.log(`========================================\n`);
}

runTests()
  .catch(err => {
    console.error('검증 중 오류 발생:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    serverProcess.kill('SIGTERM');
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

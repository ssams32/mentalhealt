/**
 * scripts/create_demo_data.mjs — PT 시연용 목업 데이터 생성기
 *
 * 사용법: node scripts/create_demo_data.mjs [mock|staging]   (기본: mock)
 * 대상:   app/data/<mode>/  (server.js의 DATA_DIR 규칙과 동일)
 *
 * 생성 파일:
 *   Users.json                  — 관리자 1 + 팀장 5 + 팀원 15 (5개 팀)
 *   Referrals.json              — 의뢰 50건 (최근 3개월, 5개 팀 분산, 상태 다양)
 *   Clients.json                — 내담자 40명 (의뢰 clientId와 연결)
 *   BudgetPlans.json            — 팀별 2026년 예산안 5건 (Record<부서_과목, 계획>)
 *   GlobalCaseAnalysis.json     — 사례관리 분석 원천 데이터 (상담실적·회원실적·ISP)
 *   CaseAnalysisSavedResults.json — 저장된 분석 결과 1건 (위 분석 스냅샷)
 *
 * ※ 모든 인물·연락처는 전형적 플레이스홀더(김철수/이영희…, 010-0000-XXXX)이며
 *   실존 인물을 연상시키지 않는다.
 * ※ 실행 전 대상 디렉토리의 기존 JSON은 app/data_<mode>_backup_<날짜시간> 으로 백업한다.
 * ※ production 모드는 절대 허용하지 않는다.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const mode = (process.argv[2] || 'mock').toLowerCase();
if (!['mock', 'staging'].includes(mode)) {
  console.error(`❌ 잘못된 모드: "${mode}" — 허용: mock | staging (production 금지)`);
  process.exit(1);
}

const dataDir = path.join(rootDir, 'app', 'data', mode);
console.log(`📂 Target DATA_DIR: ${dataDir} (mode=${mode})`);

// ---------------------------------------------------------------------------
// 0. 백업: 대상 디렉토리의 기존 JSON을 app/data_<mode>_backup_<날짜시간> 으로 복사
// ---------------------------------------------------------------------------
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
})();

if (fs.existsSync(dataDir)) {
  const existing = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
  if (existing.length > 0) {
    const backupDir = path.join(rootDir, 'app', `data_${mode}_backup_${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of existing) {
      fs.copyFileSync(path.join(dataDir, f), path.join(backupDir, f));
    }
    console.log(`📦 백업 완료: ${backupDir} (${existing.length}개 파일)`);
  }
}
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// 유틸: 결정적 의사난수(재현 가능) + 날짜
// ---------------------------------------------------------------------------
let seed = 20261020;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pad3 = (n) => String(n).padStart(3, '0');

// 최근 3개월 범위 (오늘 기준 90일 전 ~ 오늘)
const today = new Date();
const dayMs = 24 * 60 * 60 * 1000;
const fmtDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const recentDate = () => new Date(today.getTime() - int(0, 90) * dayMs);
const fmtISO = (d) => d.toISOString();

// ---------------------------------------------------------------------------
// 1. 기본 상수 (constants.ts / orgConfig 폴백과 일치)
// ---------------------------------------------------------------------------
const TEAMS = [
  { name: '증진팀', code: 'JJ' },
  { name: '회복팀', code: 'HB' },
  { name: '자살예방센터', code: 'JY' },
  { name: '아동청소년', code: 'AC' },
  { name: '남부분소', code: 'NB' },
];
const NAMBU_SUB_TEAMS = ['회복', '아청', '자살', '청년'];
const REGIONS = ['장호원읍', '부발읍', '신둔면', '백사면', '호법면', '마장면', '대월면', '모가면', '설성면', '율면', '창전동', '증포동', '중리동', '관고동', '기타'];
const REFERRAL_PATHS = ['가족', '경찰서', '소방', '의료기관', '기타', '본인', '읍면동 행정복지센터', '의뢰기관', '이천시청', '정신보건기관', '보건소', '지역사회복지관', '지인', '게이트키퍼'];
const AGENCIES = {
  '이천시청': '이천시청 복지정책과',
  '보건소': '이천시보건소',
  '경찰서': '이천경찰서',
  '소방': '이천소방서',
  '의료기관': '이천의료원',
  '읍면동 행정복지센터': '장호원읍 행정복지센터',
  '의뢰기관': '이천시정신건강복지센터',
  '정신보건기관': '여주정신건강복지센터',
  '지역사회복지관': '이천종합사회복지관',
  '자살예방센터': '이천시자살예방센터',
  '학교': '이천중앙초등학교',
  '가족': '가족 직접 의뢰',
  '본인': '본인 직접 신청',
  '지인': '지인 소개',
  '게이트키퍼': '생명사랑 게이트키퍼',
  '기타': '기타 기관',
};
const DIAGNOSES = ['우울증', '조현병', '조울증', '물질중독', '불안장애', '아동기정신질환 및 정신건강문제', '행위중독', '치매', '구분하기 어려움', '기타질환'];
const DEMO_PASSWORD = 'demo1234';

// 직원 명단 (팀장 1 + 팀원 3 = 팀당 4명, 총 20명)
const STAFF_BY_TEAM = {
  '증진팀': [
    { name: '김진태', role: 'manager', username: 'mgr_jj' },
    { name: '이수빈', role: 'user', username: 'user_jj1' },
    { name: '박하준', role: 'user', username: 'user_jj2' },
    { name: '최연주', role: 'user', username: 'user_jj3' },
  ],
  '회복팀': [
    { name: '정수민', role: 'manager', username: 'mgr_hb' },
    { name: '김도현', role: 'user', username: 'user_hb1' },
    { name: '이서윤', role: 'user', username: 'user_hb2' },
    { name: '박지민', role: 'user', username: 'user_hb3' },
  ],
  '자살예방센터': [
    { name: '한지훈', role: 'manager', username: 'mgr_jy' },
    { name: '강민지', role: 'user', username: 'user_jy1' },
    { name: '조현아', role: 'user', username: 'user_jy2' },
    { name: '윤태우', role: 'user', username: 'user_jy3' },
  ],
  '아동청소년': [
    { name: '서예린', role: 'manager', username: 'mgr_ac' },
    { name: '신동민', role: 'user', username: 'user_ac1' },
    { name: '황지우', role: 'user', username: 'user_ac2' },
    { name: '오세훈', role: 'user', username: 'user_ac3' },
  ],
  '남부분소': [
    { name: '배재성', role: 'manager', username: 'mgr_nb' },
    { name: '류하영', role: 'user', username: 'user_nb1' },
    { name: '임정훈', role: 'user', username: 'user_nb2' },
    { name: '송미래', role: 'user', username: 'user_nb3' },
  ],
};
const allStaff = TEAMS.flatMap((t) =>
  STAFF_BY_TEAM[t.name].map((s) => ({ ...s, team: t.name }))
);

// 내담자 명단 (전형적 플레이스홀더 40명)
const CLIENT_NAMES = [
  '김철수', '이영희', '박민수', '최지영', '정현우', '강수진', '조동현', '윤미경',
  '장준호', '임서연', '한승민', '오태경', '서준혁', '신혜림', '권도윤', '황지아',
  '안재민', '송유나', '류태호', '홍은비', '전민기', '고아름', '문준석', '양하은',
  '배상현', '백지호', '허수아', '유동규', '남겨레', '김하늘', '이도현', '박서준',
  '최민아', '정태양', '강나래', '조현석', '윤다솜', '장민호', '임채원', '김봄이',
];

const INTERVENTION_TEMPLATES = [
  '초기 상담 진행, 주 1회 정기 상담 연계 예정',
  '위기 개입 후 병원 진료 동행 및 약물 복용 교육 실시',
  '가정 방문 상담 진행, 가족 지지체계 점검 완료',
  '전화 상담으로 경과 확인, 다음 주 내소 상담 예약',
  '지역사회 자원(긴급생계비·주거지원) 연계 신청 지원',
  '사례회의 논의 결과 치료 연계 및 모니터링 유지',
  '학교 상담실과 협조하여 등교 지원 계획 수립',
  '보호자 면담 실시, 서비스 이용 동의 확인',
];
const NOTE_TEMPLATES = [
  '초기 의뢰 접수 및 기초 상담 진행 (시연용 샘플)',
  '담당자 배정 후 1차 대면 상담 완료 (시연용 샘플)',
  '경과 확인 전화 상담, 상태 안정적 (시연용 샘플)',
  '연계 기관 회신 수신, 후속 조치 협의 중 (시연용 샘플)',
  '사례 종결 논의 완료, 사후 모니터링 안내 (시연용 샘플)',
];

// ---------------------------------------------------------------------------
// 2. Users.json — 관리자 1 + 팀장 5 + 팀원 15
// ---------------------------------------------------------------------------
const nowISO = fmtISO(today);
const users = [
  {
    id: 'admin',
    username: 'admin',
    password: DEMO_PASSWORD,
    name: '시연관리자',
    role: 'admin',
    createdDate: '2026-01-05',
    lastLogin: nowISO,
    status: 'active',
    team: '증진팀',
  },
  ...allStaff.map((s, idx) => ({
    id: `user_${s.username}`,
    username: s.username,
    password: DEMO_PASSWORD,
    name: s.name,
    role: s.role,
    createdDate: '2026-02-01',
    lastLogin: fmtISO(new Date(today.getTime() - int(0, 30) * dayMs)),
    status: 'active',
    team: s.team,
  })),
];

// ---------------------------------------------------------------------------
// 3. Clients.json — 내담자 40명 (의뢰 clientId와 연결)
// ---------------------------------------------------------------------------
const clients = CLIENT_NAMES.map((name, idx) => {
  const age = int(15, 82);
  const birthYear = today.getFullYear() - age;
  const birthMonth = int(1, 12);
  const birthDay = int(1, 28);
  const p = (n) => String(n).padStart(2, '0');
  return {
    clientId: `C-DEMO-${pad3(idx + 1)}`,
    name,
    phone: `010-0000-${String(1000 + idx).slice(-4)}`,
    gender: pick(['남성', '여성']),
    age,
    birthDate: `${birthYear}-${p(birthMonth)}-${p(birthDay)}`,
    region: pick(REGIONS),
    address: `${pick(REGIONS)} ${int(1, 200)}번지`,
    team: TEAMS[idx % TEAMS.length].name,
    assignee: allStaff[(idx * 7) % allStaff.length].name,
    registrationStatus: '등록',
    createdAt: fmtISO(new Date(today.getTime() - int(10, 400) * dayMs)),
  };
});

// ---------------------------------------------------------------------------
// 4. Referrals.json — 의뢰 50건 (5개 팀 × 10건, 팀 코드별 refNo 순번)
// ---------------------------------------------------------------------------
const yearYY = String(today.getFullYear()).slice(-2);
const teamSeq = {};
const referrals = [];
let clientCursor = 0;

for (let teamIdx = 0; teamIdx < TEAMS.length; teamIdx++) {
  const team = TEAMS[teamIdx];
  for (let k = 0; k < 10; k++) {
    // 내담자 40명을 50건에 배분 (일부 내담자는 의뢰 2건)
    const clientIdx = clientCursor < CLIENT_NAMES.length ? clientCursor++ : int(0, CLIENT_NAMES.length - 1);
    const client = clients[clientIdx];

    const seq = (teamSeq[team.code] = (teamSeq[team.code] || 0) + 1);
    const refNo = `${team.code}-${yearYY}-${pad3(seq)}`;

    const requestDate = recentDate();
    const age = client.age;
    const gender = client.gender;

    // 상태 다양: 신규 / 배정됨 / 진행중 / 완료
    const stateRoll = (teamIdx * 10 + k) % 10; // 팀 내 고른 분포
    let statusPack;
    if (stateRoll < 2) {
      statusPack = { label: '신규', registrationStatus: '확인중', closureStatus: '미종결', actionResult: '처리중', reply: true, replyStatus: '회신필요' };
    } else if (stateRoll < 5) {
      statusPack = { label: '배정됨', registrationStatus: '등록', closureStatus: '미종결', actionResult: '처리중', reply: false, replyStatus: '회신완료' };
    } else if (stateRoll < 8) {
      statusPack = { label: '진행중', registrationStatus: '등록', closureStatus: '미종결', actionResult: pick(['지속상담', '서비스연계']), reply: false, replyStatus: '회신완료' };
    } else {
      statusPack = { label: '완료', registrationStatus: '등록', closureStatus: '종결', actionResult: pick(['종결', '치료연계']), reply: false, replyStatus: '회신완료' };
    }

    const pathName = pick(REFERRAL_PATHS);
    const requestAgency = AGENCIES[pathName] || pick(Object.values(AGENCIES));
    const assignee = pick(STAFF_BY_TEAM[team.name]).name;
    const subTeam = team.name === '남부분소' ? pick(NAMBU_SUB_TEAMS) : undefined;

    const noteCount = statusPack.label === '신규' ? 0 : statusPack.label === '배정됨' ? 1 : int(1, 3);
    const notes = [];
    for (let n = 0; n < noteCount; n++) {
      const noteDate = new Date(requestDate.getTime() + (n + 1) * 7 * dayMs);
      notes.push({
        id: `note-${refNo}-${n + 1}`,
        content: pick(NOTE_TEMPLATES),
        createdAt: fmtISO(noteDate),
        author: assignee,
      });
    }
    const latestNote = notes.length > 0 ? notes[notes.length - 1] : null;

    const referral = {
      referralId: `ref-demo-${refNo.toLowerCase()}`,
      refNo,
      clientId: client.clientId,
      version: 1,
      createdAt: fmtISO(requestDate),
      updatedAt: latestNote ? latestNote.createdAt : fmtISO(requestDate),
      name: client.name,
      phone: client.phone,
      gender,
      age,
      requestDate: fmtDate(requestDate),
      referralPath: pathName,
      requestAgency,
      diagnosisProtectionRequest: rand() > 0.7,
      writtenRequest: rand() > 0.5,
      phoneRequest: rand() > 0.5,
      diagnosisName: pick(DIAGNOSES),
      interventionContent: pick(INTERVENTION_TEMPLATES),
      actionResult: statusPack.actionResult,
      closureStatus: statusPack.closureStatus,
      registrationStatus: statusPack.registrationStatus,
      policeIntervention: pathName === '경찰서',
      criLevel: pick(['a', 'b', 'c', 'd', 'e']),
      region: client.region,
      assignee,
      requestorName: `${pick(['김', '이', '박', '최', '정'])}${pick(['민수', '영희', '철수', '지영', '현우'])}`,
      reply: statusPack.reply,
      replyStatus: statusPack.replyStatus,
      team: team.name,
      ...(subTeam ? { subTeam } : {}),
      attachments: [],
      notes,
      ...(latestNote ? { latestNote: latestNote.content, latestNoteDate: latestNote.createdAt } : {}),
      address: client.address,
      // 시연용 상태 라벨 (서버가 무시하는 여분 필드, 통계 확인용)
      _demoState: statusPack.label,
    };
    referrals.push(referral);
  }
}
// 의뢰일자 오름차순 정렬 (대시보드가 보기 좋도록)
referrals.sort((a, b) => a.requestDate.localeCompare(b.requestDate));

// ---------------------------------------------------------------------------
// 5. BudgetPlans.json — 팀별 2026년 예산안 5건 (Record<부서_과목, 계획>)
// ---------------------------------------------------------------------------
const BUDGET_SPECS = [
  { team: '증진팀', budgetItem: '인건비', projectName: '정신건강증진사업', amount: 150000000 },
  { team: '회복팀', budgetItem: '사업운영비', projectName: '정신질환자 회복지원사업', amount: 80000000 },
  { team: '자살예방센터', budgetItem: '인건비', projectName: '자살예방 및 생명존중사업', amount: 120000000 },
  { team: '아동청소년', budgetItem: '사업운영비', projectName: '아동청소년 정신건강사업', amount: 95000000 },
  { team: '남부분소', budgetItem: '인건비', projectName: '남부권역 찾아가는 정신건강서비스', amount: 110000000 },
];
const budgetPlans = {};
BUDGET_SPECS.forEach((spec, i) => {
  const writer = STAFF_BY_TEAM[spec.team][0].name; // 팀장
  const entries = [];
  const nEntries = int(2, 4);
  let used = 0;
  for (let e = 0; e < nEntries; e++) {
    const amt = int(1000000, 8000000);
    used += amt;
    const entryDate = new Date(2026, int(0, 9), int(1, 28));
    entries.push({
      id: `be-demo-${i + 1}-${e + 1}`,
      date: fmtDate(entryDate),
      writer,
      amount: amt,
      description: `${spec.projectName} 집행 (${pick(['강사비', '홍보물 제작', '행사 운영비', '교통비', '소모품 구입'])}) (시연용)`,
    });
  }
  const key = `${spec.team}_${spec.budgetItem}`;
  budgetPlans[key] = {
    department: spec.team,
    budgetItem: spec.budgetItem,
    categoryGroup: '기본운영',
    source: '국비보조금',
    category1: '운영비',
    projectName: spec.projectName,
    category2: spec.budgetItem,
    budgetAmount: spec.amount,
    manualEntries: entries,
    order: i + 1,
  };
});

// ---------------------------------------------------------------------------
// 6. GlobalCaseAnalysis.json — 사례관리 분석 원천 데이터
//    (상담실적 20명 · 회원실적 40명 · ISP 만기회원 6명 · ISP 계획 20건)
// ---------------------------------------------------------------------------
const SESSION_TYPES = ['inOffice', 'visit', 'online', 'emergency', 'phone'];
const SESSION_CATEGORIES = ['individual', 'resource', 'general'];

const counselorPerformance = allStaff.map((s, si) => {
  const sessionCount = int(14, 42);
  const allSessions = [];
  const types = { inOffice: 0, visit: 0, online: 0, emergency: 0, phone: 0 };
  let totalGeneral = 0;
  for (let i = 0; i < sessionCount; i++) {
    const type = pick(SESSION_TYPES);
    const category = pick(SESSION_CATEGORIES);
    const d = recentDate();
    allSessions.push({ date: fmtDate(d), type, category });
    types[type] += 1;
    if (category === 'general') totalGeneral += 1;
  }
  allSessions.sort((a, b) => a.date.localeCompare(b.date));
  const faceToFaceSessions = allSessions
    .filter((x) => x.type === 'inOffice' || x.type === 'visit')
    .map((x) => ({ date: x.date }));
  return {
    counselorName: s.name,
    department: s.team,
    types,
    faceToFaceSessions,
    allSessions,
    totalSessions: allSessions.length,
    totalEmergency: types.emergency,
    totalGeneral,
  };
});

// ISP 회원 (앞 20명) — 관리구분은 ISPAnalysisTab 기준값:
//   집중관리 = 월 4회 이상 달성, 일시관리 = 월 1회 이상 달성 (서버 yearly 엔드포인트와 동일 규칙)
const ISP_MEMBER_COUNT = 20;
const ispCategoryFor = (i) => (i % 5 < 3 ? '집중관리' : '일시관리'); // 60% 집중 / 40% 일시
const ISP_WEAK = new Set([2, 7, 13, 17]); // 20%: 과거월 대부분 미달(FAIL)로 보이게

const memberPerformance = clients.map((client, ci) => {
  const mainCounselor = allStaff[(ci * 3) % allStaff.length].name;
  const detailedSessions = [];
  // 실적 집계(서버·프론트 공통)에서 인정되는 조합만 사용
  const newSession = (month, category) => ({
    month,
    category,
    type: pick(['inOffice', 'visit', 'phone', 'online']),
  });

  if (ci < ISP_MEMBER_COUNT) {
    // ISP 회원: 1~10월 월별 실적. 과거월(1~9월)은 달성 위주 + 20% 미달, 10월(현재월)은 진행중
    // 달성 판정은 totalIntervention = 개별상담(individual) + 자원조정(resource) 합산 기준
    const intensive = ispCategoryFor(ci) === '집중관리';
    const weak = ISP_WEAK.has(ci);
    for (let m = 1; m <= 10; m++) {
      let total;
      let split = null; // { ind, res } 명시 분할 (합산 달성 시연월)
      if (m === 10) {
        total = intensive ? int(1, 4) : int(0, 1); // 현재월: 부분 실적 (IN_PROGRESS)
      } else if (weak) {
        total = intensive ? int(0, 3) : 0; // 집중 목표(4~5)·일시 목표(1) 미만 → FAIL
      } else {
        total = intensive ? int(5, 7) : int(1, 3); // 서버 목표(집중 4~5 / 일시 1) 이상 → SUCCESS
        // 합산 달성 시연월 (3·6·9월): 개별상담만·자원조정만으로는 목표 미달, 합산해야 달성
        if (m % 3 === 0) {
          if (intensive) {
            const ind = int(2, 3); // < 목표 5
            let res = int(2, 3); // < 목표 5
            if (ind + res < 5) res += 5 - (ind + res); // 합산은 목표(5) 이상
            split = { ind, res };
            total = ind + res;
          } else if (total >= 2) {
            split = { ind: 1, res: total - 1 }; // 일시: 양쪽 카테고리 모두 실적
          }
        }
      }
      if (split) {
        for (let s = 0; s < split.ind; s++) detailedSessions.push(newSession(m, 'individual'));
        for (let s = 0; s < split.res; s++) detailedSessions.push(newSession(m, 'resource'));
      } else {
        // 일반 월: 두 카테고리를 무작위로 섞음 (전체가 한쪽에만 몰리지 않게)
        for (let s = 0; s < total; s++) {
          detailedSessions.push(newSession(m, rand() < 0.6 ? 'individual' : 'resource'));
        }
      }
    }
  } else {
    // ISP 없는 회원: 회원실적 화면용 가벼운 실적 (개별상담/자원조정 혼합)
    const sessCount = int(3, 10);
    for (let i = 0; i < sessCount; i++) {
      detailedSessions.push(newSession(int(1, 10), pick(['individual', 'resource'])));
    }
  }

  const registrationNo = `REG-26${pad3(ci + 1)}`;
  return {
    memberName: client.name,
    registrationNo,
    department: client.team,
    mainCounselor,
    totalSessions: detailedSessions.length,
    detailedSessions,
  };
});

// ISP 만기 회원 6명 (daysPassed가 큰 순서대로 — 알림 카드가 채워지도록)
const ispExpiringMembers = memberPerformance.slice(0, 6).map((m, i) => ({
  id: `isp-exp-demo-${i + 1}`,
  name: m.memberName,
  registrant: m.mainCounselor,
  date: fmtDate(new Date(today.getTime() - (380 + i * 60) * dayMs)),
  daysPassed: 380 + i * 60,
  rowNum: i + 1,
}));

// ISP 계획 20건 — managementCategory는 ISPAnalysisTab 기준값 (집중관리 60% / 일시관리 40%)
// ※ 서버 isp-achievement-yearly는 이 값에서 월 목표를 계산함 (집중: ceil(일수/7)≈4~5, 일시: 1)
//   '중증정신질환'/'일반정신건강' 같은 값을 넣으면 목표 0 → 미평가(미평가) 되므로 사용 금지
const ispPlans = memberPerformance.slice(0, ISP_MEMBER_COUNT).map((m, i) => {
  const birthYear = today.getFullYear() - clients[i].age;
  const p = (n) => String(n).padStart(2, '0');
  const establishedDate = new Date(today.getTime() - (300 + i * 20) * dayMs); // 전원 2025년 수립 → 2026년 전월 커버
  const managementCategory = ispCategoryFor(i);
  const demoYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  // monthly: normalizeIspMonthlyData가 기대하는 12개월 형태 — 서버와 동일 규칙으로 계산한 목표/실적/평가
  const actualByMonth = Array(12).fill(0);
  (m.detailedSessions || []).forEach((s) => {
    const mo = Number(s.month);
    if (mo >= 1 && mo <= 12) actualByMonth[mo - 1] += 1;
  });
  const EVAL_LABEL = { SUCCESS: '달성', FAIL: '미달', IN_PROGRESS: '진행중', FUTURE_NOT_DUE: '평가전' };
  const monthly = [];
  for (let mo = 1; mo <= 12; mo++) {
    const days = new Date(demoYear, mo, 0).getDate();
    const targetCount = managementCategory === '집중관리' ? Math.ceil(days / 7) : 1;
    const actualCount = actualByMonth[mo - 1];
    let evaluationResult;
    if (mo > currentMonth) evaluationResult = 'FUTURE_NOT_DUE';
    else if (mo === currentMonth) evaluationResult = 'IN_PROGRESS';
    else evaluationResult = actualCount >= targetCount ? 'SUCCESS' : 'FAIL';
    monthly.push({
      month: mo,
      managementTypeSummary: managementCategory,
      targetCount,
      actualCount,
      evaluationResult,
      evaluationLabel: EVAL_LABEL[evaluationResult],
    });
  }

  return {
    registrationNo: m.registrationNo,
    normalizedRegistrationNo: m.registrationNo,
    memberName: m.memberName,
    normalizedName: m.memberName,
    managementCategory,
    establishedDate: fmtDate(establishedDate),
    monthly,
    gender: clients[i].gender,
    birthDate: `${birthYear}-${p(int(1, 12))}-${p(int(1, 28))}`,
    excelRowNumber: i + 2,
    parseStatus: 'success',
    parseIssues: [],
  };
});

const globalCaseAnalysis = {
  counselorPerformance,
  memberPerformance,
  ispExpiringMembers,
  ispPlans,
  ispAchievement: [],
};

// 저장된 분석 결과 1건 (위 분석 스냅샷)
const savedAnalyses = [
  {
    id: `analysis_demo_${stamp}`,
    name: '시연용 사례관리 분석 (2026년 3분기)',
    createdAt: nowISO,
    data: globalCaseAnalysis,
  },
];

// ---------------------------------------------------------------------------
// 7. SuicideAttempters.json — 자살시도자 대장 20건
// ---------------------------------------------------------------------------
const SA_AGENCIES = ['이천경찰서', '이천시보건소', '이천의료원 응급실', '이천소방서', '이천시자살예방센터', '경기도자살예방센터'];
const SA_NOTE_TEMPLATES = [
  '의뢰 접수, 위기 상황 기초 평가 실시 (시연용 샘플)',
  '전화 상담으로 안전 확인, 다음 내소 상담 예약 (시연용 샘플)',
  '응급실 동행 및 진료 연계 완료 (시연용 샘플)',
  '가정 방문 상담 진행, 보호자 면담 실시 (시연용 샘플)',
  '자살위기지원서비스 안내 및 서비스 동의 확인 (시연용 샘플)',
  '경과 확인 전화 상담, 현재 상태 안정적 (시연용 샘플)',
];
// 처리상태/개입상태/등록상태 조합 (20건에 고른 분포)
const SA_PACKS = [
  { processingStatus: '서비스동의', disposalReason: '', registrationStatus: '등록', interventionStatus: '자살위기지원서비스(등록_미등록)' },
  { processingStatus: '서비스동의', disposalReason: '', registrationStatus: '기등록', interventionStatus: '연계(등록)' },
  { processingStatus: '처리중', disposalReason: '', registrationStatus: '확인중', interventionStatus: '일반상담(미등록)' },
  { processingStatus: '처리중', disposalReason: '', registrationStatus: '미등록', interventionStatus: '' },
  { processingStatus: '거부', disposalReason: '서비스거부', registrationStatus: '미등록', interventionStatus: '' },
  { processingStatus: '개인정보파기', disposalReason: '개인정보파기요청', registrationStatus: '종결', interventionStatus: '' },
  { processingStatus: '서비스동의', disposalReason: '', registrationStatus: '종결', interventionStatus: '퇴록(등록)' },
];
const suicideAttempters = [];
for (let i = 0; i < 20; i++) {
  const name = CLIENT_NAMES[(i * 3 + 7) % CLIENT_NAMES.length];
  const receipt = recentDate();
  const receiptDate = fmtDate(receipt);
  const age = int(19, 68);
  const birthYear = today.getFullYear() - age;
  const bp = (n) => String(n).padStart(2, '0');
  const staff = pick(STAFF_BY_TEAM['자살예방센터']);
  const pack = SA_PACKS[i % SA_PACKS.length];
  const region = pick(REGIONS);

  const notes = [];
  const noteCount = int(1, 2);
  for (let n = 0; n < noteCount; n++) {
    const noteDate = new Date(receipt.getTime() + (n + 1) * 3 * dayMs);
    notes.push({
      id: `note-sa-${pad3(i + 1)}-${n + 1}`,
      content: pick(SA_NOTE_TEMPLATES),
      createdAt: fmtISO(noteDate),
      author: staff.name,
    });
  }

  suicideAttempters.push({
    uid: `sa-demo-${pad3(i + 1)}`,
    sn: `SA-${yearYY}-${pad3(i + 1)}`,
    requestAgency: pick(SA_AGENCIES),
    pic: staff.name,
    name,
    receiptDate,
    gender: pick(['남성', '여성']),
    birthDate: `${birthYear}-${bp(int(1, 12))}-${bp(int(1, 28))}`,
    age,
    notes,
    infoTarget: pick(['본인', '본인', '본인', '가족']),
    processingStatus: pack.processingStatus,
    disposalReason: pack.disposalReason,
    interventionStatus: pack.interventionStatus,
    registrationStatus: pack.registrationStatus,
    region,
    assignee: staff.name,
    attachments: [],
    phoneNumber: `010-0000-${String(3000 + i).slice(-4)}`,
    address: `${region} ${int(1, 200)}번지`,
    privacyAcquisitionDate: fmtDate(new Date(receipt.getTime() + int(0, 2) * dayMs)),
  });
}
// 접수일 오름차순 정렬
suicideAttempters.sort((a, b) => a.receiptDate.localeCompare(b.receiptDate));

// ---------------------------------------------------------------------------
// 8. 파일 쓰기
// ---------------------------------------------------------------------------
const outputs = {
  'Users.json': users,
  'Referrals.json': referrals,
  'Clients.json': clients,
  'BudgetPlans.json': budgetPlans,
  'GlobalCaseAnalysis.json': globalCaseAnalysis,
  'CaseAnalysisSavedResults.json': savedAnalyses,
  'SuicideAttempters.json': suicideAttempters,
};

let totalBytes = 0;
for (const [filename, content] of Object.entries(outputs)) {
  const filePath = path.join(dataDir, filename);
  const json = JSON.stringify(content, null, 2);
  fs.writeFileSync(filePath, json, 'utf8');
  totalBytes += Buffer.byteLength(json, 'utf8');
  const count = Array.isArray(content) ? content.length : Object.keys(content).length;
  console.log(`✅ ${filename}: ${count}건`);
}

console.log('──────────────────────────────────────────');
console.log(`🎉 시연 데이터 생성 완료: ${dataDir}`);
console.log(`   - 사용자: ${users.length}명 (관리자 1, 팀장 5, 팀원 15)`);
console.log(`   - 의뢰: ${referrals.length}건 / 내담자: ${clients.length}명`);
console.log(`   - 예산안: ${Object.keys(budgetPlans).length}건`);
console.log(`   - 상담실적: ${counselorPerformance.length}명 / 회원실적: ${memberPerformance.length}명`);
console.log(`   - ISP 계획: ${ispPlans.length}건 / 만기회원: ${ispExpiringMembers.length}명`);
console.log(`   - 자살시도자: ${suicideAttempters.length}건`);
console.log(`   - 전체 ${(totalBytes / 1024).toFixed(1)} KB`);
console.log(`   - 로그인: admin / ${DEMO_PASSWORD} (전 계정 동일)`);
console.log('──────────────────────────────────────────');

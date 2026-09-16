import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'app', 'data');
const realBackupDir = path.join(rootDir, 'app', 'data_real_backup');

console.log('📂 Target DATA_DIR:', dataDir);

// 1. Ensure backup of all JSON files in app/data to app/data_real_backup if not already backed up
if (!fs.existsSync(realBackupDir)) {
  fs.mkdirSync(realBackupDir, { recursive: true });
}

const currentFiles = fs.readdirSync(dataDir);
for (const file of currentFiles) {
  if (file.endsWith('.json')) {
    const srcPath = path.join(dataDir, file);
    const destPath = path.join(realBackupDir, file);
    if (!fs.existsSync(destPath)) {
      console.log(`📦 Backing up ${file} to data_real_backup...`);
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 2. Define Pure Dummy Data for Referrals
const dummyReferrals = [
  {
    referralId: "ref-dummy-001",
    refNo: "ET-26-001",
    name: "홍길동 (더미)",
    phone: "010-0000-0001",
    age: 35,
    gender: "남",
    team: "동부",
    subTeam: "동부1팀",
    region: "창전동",
    referralPath: "경찰",
    requestAgency: "이천경찰서",
    requestorName: "김순경",
    requestDate: "2026-09-01",
    diagnosisName: "우울증",
    criLevel: "중위험군",
    actionResult: "등록",
    assignee: "담당자A",
    closureStatus: "진행중",
    notes: [
      { id: "note-d1", date: "2026-09-01", content: "초기 의뢰 접수 및 기초 상담 진행 (더미 샘플)" }
    ],
    attachments: [],
    version: 1
  },
  {
    referralId: "ref-dummy-002",
    refNo: "ET-26-002",
    name: "김영희 (더미)",
    phone: "010-0000-0002",
    age: 28,
    gender: "여",
    team: "남부",
    subTeam: "남부1팀",
    region: "부발읍",
    referralPath: "소방",
    requestAgency: "이천소방서",
    requestorName: "이소방",
    requestDate: "2026-09-03",
    diagnosisName: "양극성 정동장애",
    criLevel: "고위험군",
    actionResult: "미등록",
    assignee: "담당자B",
    closureStatus: "종결",
    notes: [
      { id: "note-d2", date: "2026-09-03", content: "위기 개입 수행 및 병원 연계 진행 (더미 샘플)" }
    ],
    attachments: [],
    version: 1
  }
];

// 3. Define Pure Dummy Data for SuicideAttempters (자살시도자 의뢰 대장)
const dummySuicideAttempters = [
  {
    uid: "sui-dummy-001",
    name: "이철수 (더미)",
    gender: "남",
    age: 42,
    birthDate: "1984-05-15",
    region: "증포동",
    receiptDate: "2026-09-02",
    registrationStatus: "등록",
    processingStatus: "개입중",
    interventionStatus: "동행방문",
    diagnosisName: "적응장애",
    infoTarget: "대상자 본인",
    privacyAcquisitionDate: "2026-09-02",
    assignee: "담당자C",
    pic: "담당자C",
    disposalReason: "",
    notes: [
      { id: "sui-note-1", date: "2026-09-02", content: "응급실 연계 후 사후관리 진행 (더미 샘플)" }
    ],
    attachments: []
  },
  {
    uid: "sui-dummy-002",
    name: "박지민 (더미)",
    gender: "여",
    age: 24,
    birthDate: "2002-11-20",
    region: "마장면",
    receiptDate: "2026-09-05",
    registrationStatus: "미등록",
    processingStatus: "종결",
    interventionStatus: "전화상담",
    diagnosisName: "우울에피소드",
    infoTarget: "보호자",
    privacyAcquisitionDate: "2026-09-05",
    assignee: "담당자A",
    pic: "담당자A",
    disposalReason: "거부",
    notes: [
      { id: "sui-note-2", date: "2026-09-05", content: "서비스 거부로 인한 서비스 안내 후 종결 (더미 샘플)" }
    ],
    attachments: []
  }
];

// 4. Clean/Mask Sensitive Data JSON Files in app/data
const filesToReplace = {
  'Referrals.json': dummyReferrals,
  'SuicideAttempters.json': dummySuicideAttempters,
  'PendingReferrals.json': [],
  'UnregisteredCandidates.json': [],
  'QuarantinedReferrals.json': [],
  'GlobalCaseAnalysis.json': [],
  'CaseAnalysisSavedResults.json': [],
  'Logs.json': []
};

for (const [filename, content] of Object.entries(filesToReplace)) {
  const filePath = path.join(dataDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  console.log(`✅ Replaced ${filename} with dummy/empty data (${JSON.stringify(content).length} bytes)`);
}

console.log('🎉 All target JSON data successfully converted to dummy data!');

import fs from 'fs';
import path from 'path';

const dataDir = path.join(process.cwd(), 'app', 'data');
const backupDir = path.join(process.cwd(), 'app', 'data_real_backup');

if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

const piiFiles = [
    'Referrals.json',
    'UnregisteredCandidates.json',
    'GlobalCaseAnalysis.json',
    'CaseAnalysisSavedResults.json',
    'SuicideAttempters.json',
    'PendingReferrals.json',
    'QuarantinedReferrals.json',
    'Logs.json'
];

// Backup files and remove them from active data dir
for (const file of piiFiles) {
    const srcPath = path.join(dataDir, file);
    const destPath = path.join(backupDir, file);
    
    if (fs.existsSync(srcPath)) {
        // Only backup if we haven't already backed up, to avoid overwriting real data with dummy data
        if (!fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            console.log(`Backed up ${file} to data_real_backup`);
        } else {
            console.log(`${file} already backed up.`);
        }
    }
}

// Write dummy data
const dummyReferrals = [
    {
        "refNo": "ET-26-001",
        "clientId": "DUMMY_CLIENT_001",
        "name": "홍길동",
        "gender": "남성",
        "age": "45",
        "phone": "010-1234-5678",
        "region": "이천시",
        "address": "창전동 123-4",
        "requestDate": "2026-09-10",
        "requestAgency": "이천시청",
        "requestorName": "김공무",
        "referralPath": "공공기관 연계",
        "reason": "경제적 어려움 및 우울감 호소",
        "criLevel": "b",
        "team": "회복팀",
        "subTeam": "회복팀",
        "assignee": "김준삼",
        "counselor": "김준삼",
        "closureStatus": "미종결",
        "registrationStatus": "등록",
        "version": 1
    },
    {
        "refNo": "ET-26-002",
        "clientId": "DUMMY_CLIENT_002",
        "name": "김영희",
        "gender": "여성",
        "age": "32",
        "phone": "010-9876-5432",
        "region": "이천시",
        "address": "부발읍 456-7",
        "requestDate": "2026-09-09",
        "requestAgency": "보건소",
        "requestorName": "이보건",
        "referralPath": "의료기관 연계",
        "reason": "산후 우울증 의심",
        "criLevel": "c",
        "team": "증진팀",
        "subTeam": "증진팀",
        "assignee": "송사랑",
        "counselor": "송사랑",
        "closureStatus": "미종결",
        "registrationStatus": "등록",
        "version": 1
    }
];

fs.writeFileSync(path.join(dataDir, 'Referrals.json'), JSON.stringify(dummyReferrals, null, 2));
fs.writeFileSync(path.join(dataDir, 'UnregisteredCandidates.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(dataDir, 'GlobalCaseAnalysis.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(dataDir, 'PendingReferrals.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(dataDir, 'QuarantinedReferrals.json'), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(dataDir, 'Logs.json'), JSON.stringify([], null, 2));

console.log("Dummy data injected. Real data is safely isolated in app/data_real_backup.");

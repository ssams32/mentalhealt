import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root directory
const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'app', 'data');
const referralsPath = path.join(dataDir, 'Referrals.json');
const outputDir = path.join(projectRoot, 'audit-output');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

function maskName(name) {
    if (!name) return '미상';
    const str = String(name).trim();
    if (str.length === 0) return '미상';
    if (str.length === 1) return str + '○';
    if (str.length === 2) return str[0] + '○';
    return str[0] + '○'.repeat(str.length - 2) + str[str.length - 1];
}

function maskPhone(phone) {
    if (!phone) return '없음';
    const clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length < 7) return '***-****';
    return clean.slice(0, 3) + '-****-' + clean.slice(-4);
}

function runAudit() {
    console.log('🔍 [AUDIT] Starting read-only referrals audit...');
    if (!fs.existsSync(referralsPath)) {
        console.error('❌ Referrals.json not found at:', referralsPath);
        process.exit(1);
    }

    const stats = fs.statSync(referralsPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const rawContent = fs.readFileSync(referralsPath, 'utf8');

    let referrals = [];
    try {
        referrals = JSON.parse(rawContent);
    } catch (e) {
        console.error('❌ Failed to parse Referrals.json:', e.message);
        process.exit(1);
    }

    const totalRecords = referrals.length;
    console.log(`📊 Total records: ${totalRecords}, File size: ${fileSizeMB} MB`);

    // 1. refNo duplicates
    const refNoMap = new Map();
    // 2. clientId duplicates & missing
    const clientIdMap = new Map();
    let missingClientIdCount = 0;
    // 3. referralId duplicates & missing
    const referralIdMap = new Map();
    let missingReferralIdCount = 0;

    // 4. Duplicate candidates based on [name + age + phone]
    const candidateMap = new Map();

    // 5. Notes integrity & Base64 checks
    let totalNotes = 0;
    let missingNoteIdCount = 0;
    let oversizedRecords = [];
    let base64Count = 0;

    // 6. Registration status & Closure status
    let registrationStatusStats = {};
    let closureStatusStats = {};

    referrals.forEach((r, idx) => {
        const rowNum = idx + 1;
        const refNo = r.refNo || '(없음)';
        const clientId = r.clientId || '';
        const referralId = r.referralId || '';

        // refNo
        if (!refNoMap.has(refNo)) refNoMap.set(refNo, []);
        refNoMap.get(refNo).push({ index: rowNum, name: maskName(r.name), requestDate: r.requestDate });

        // clientId
        if (!clientId) {
            missingClientIdCount++;
        } else {
            if (!clientIdMap.has(clientId)) clientIdMap.set(clientId, []);
            clientIdMap.get(clientId).push({ index: rowNum, refNo, name: maskName(r.name) });
        }

        // referralId
        if (!referralId) {
            missingReferralIdCount++;
        } else {
            if (!referralIdMap.has(referralId)) referralIdMap.set(referralId, []);
            referralIdMap.get(referralId).push({ index: rowNum, refNo });
        }

        // Candidate Key: name + age + phone
        const cleanPhone = r.phone ? String(r.phone).replace(/[^0-9]/g, '') : '';
        const normName = r.name ? String(r.name).trim().replace(/\s+/g, '') : '';
        const age = r.age !== undefined && r.age !== null ? String(r.age) : '';
        if (normName) {
            const candKey = `${normName}_${age}_${cleanPhone}`;
            if (!candidateMap.has(candKey)) candidateMap.set(candKey, []);
            candidateMap.get(candKey).push({
                index: rowNum,
                refNo,
                clientId,
                name: maskName(r.name),
                requestDate: r.requestDate,
                team: r.team
            });
        }

        // Notes
        if (Array.isArray(r.notes)) {
            totalNotes += r.notes.length;
            r.notes.forEach(n => {
                if (!n.id) missingNoteIdCount++;
            });
        }

        // Record size
        const recordStr = JSON.stringify(r);
        const recordBytes = Buffer.byteLength(recordStr, 'utf8');
        if (recordBytes > 50 * 1024) { // > 50KB
            oversizedRecords.push({
                index: rowNum,
                refNo,
                sizeKB: (recordBytes / 1024).toFixed(1),
                notesCount: Array.isArray(r.notes) ? r.notes.length : 0,
                attachmentsCount: Array.isArray(r.attachments) ? r.attachments.length : 0
            });
        }

        // Base64 check in record
        if (recordStr.includes('data:image') || recordStr.includes('base64,')) {
            base64Count++;
        }

        // Status stats
        const regStat = r.registrationStatus || (r.isUnregistered ? '미등록' : '미지정');
        registrationStatusStats[regStat] = (registrationStatusStats[regStat] || 0) + 1;

        const cloStat = r.closureStatus || '미지정';
        closureStatusStats[cloStat] = (closureStatusStats[cloStat] || 0) + 1;
    });

    // Filter duplicate refNos
    const duplicateRefNos = [];
    for (const [refNo, occurrences] of refNoMap.entries()) {
        if (occurrences.length > 1 && refNo !== '(없음)') {
            duplicateRefNos.push({ refNo, count: occurrences.length, occurrences });
        }
    }

    // Filter duplicate clientIds
    const duplicateClientIds = [];
    for (const [clientId, occurrences] of clientIdMap.entries()) {
        if (occurrences.length > 1) {
            duplicateClientIds.push({ clientId, count: occurrences.length, occurrences });
        }
    }

    // Filter candidate clashes
    const duplicateCandidates = [];
    for (const [key, occurrences] of candidateMap.entries()) {
        if (occurrences.length > 1) {
            // Check if requestDates are different
            const dates = new Set(occurrences.map(o => o.requestDate));
            duplicateCandidates.push({
                candidateKeyMasked: occurrences[0].name + ` (건수: ${occurrences.length})`,
                count: occurrences.length,
                differentRequestDates: dates.size > 1,
                occurrences
            });
        }
    }

    // 1. referral-summary.json
    const summary = {
        totalRecords,
        fileSizeMB,
        duplicateRefNoCount: duplicateRefNos.length,
        duplicateRefNoTotalRecords: duplicateRefNos.reduce((sum, d) => sum + d.count, 0),
        duplicateClientIdCount: duplicateClientIds.length,
        missingClientIdCount,
        missingReferralIdCount,
        duplicateCandidateKeyGroups: duplicateCandidates.length,
        totalNotes,
        missingNoteIdCount,
        oversizedRecordsCount: oversizedRecords.length,
        recordsWithBase64Count: base64Count,
        registrationStatusDistribution: registrationStatusStats,
        closureStatusDistribution: closureStatusStats,
        auditTimestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(outputDir, 'referral-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

    // 2. duplicate-refnos.masked.csv
    let refNoCsv = 'refNo,count,rowIndices,maskedNames,requestDates\n';
    duplicateRefNos.forEach(d => {
        const rows = d.occurrences.map(o => o.index).join('|');
        const names = d.occurrences.map(o => o.name).join('|');
        const dates = d.occurrences.map(o => o.requestDate || '').join('|');
        refNoCsv += `"${d.refNo}",${d.count},"${rows}","${names}","${dates}"\n`;
    });
    fs.writeFileSync(path.join(outputDir, 'duplicate-refnos.masked.csv'), refNoCsv, 'utf8');

    // 3. duplicate-clientids.masked.csv
    let clientIdCsv = 'clientId,count,rowIndices,refNos,maskedNames\n';
    duplicateClientIds.forEach(d => {
        const rows = d.occurrences.map(o => o.index).join('|');
        const refs = d.occurrences.map(o => o.refNo).join('|');
        const names = d.occurrences.map(o => o.name).join('|');
        clientIdCsv += `"${d.clientId}",${d.count},"${rows}","${refs}","${names}"\n`;
    });
    fs.writeFileSync(path.join(outputDir, 'duplicate-clientids.masked.csv'), clientIdCsv, 'utf8');

    // 4. duplicate-candidates.masked.csv
    let candCsv = 'maskedLabel,count,differentDates,occurrences\n';
    duplicateCandidates.forEach(c => {
        const occStr = c.occurrences.map(o => `[Row${o.index} ${o.refNo} ${o.requestDate || ''}]`).join('; ');
        candCsv += `"${c.candidateKeyMasked}",${c.count},${c.differentRequestDates},"${occStr}"\n`;
    });
    fs.writeFileSync(path.join(outputDir, 'duplicate-candidates.masked.csv'), candCsv, 'utf8');

    // 5. note-integrity.json
    const noteIntegrity = {
        totalNotes,
        missingNoteIdCount,
        recordsSampleWithNotes: referrals.slice(0, 5).map(r => ({
            refNo: r.refNo,
            noteCount: Array.isArray(r.notes) ? r.notes.length : 0
        }))
    };
    fs.writeFileSync(path.join(outputDir, 'note-integrity.json'), JSON.stringify(noteIntegrity, null, 2), 'utf8');

    // 6. oversized-records.masked.csv
    let overCsv = 'index,refNo,sizeKB,notesCount,attachmentsCount\n';
    oversizedRecords.forEach(o => {
        overCsv += `${o.index},"${o.refNo}",${o.sizeKB},${o.notesCount},${o.attachmentsCount}\n`;
    });
    fs.writeFileSync(path.join(outputDir, 'oversized-records.masked.csv'), overCsv, 'utf8');

    // 7. report.md
    const reportMd = `# 의뢰대장 읽기 전용 데이터 무결성 감사 보고서
- **감사 일시**: ${new Date().toLocaleString('ko-KR')}
- **대상 파일**: \`app/data/Referrals.json\` (${fileSizeMB} MB)
- **전체 레코드 수**: ${totalRecords.toLocaleString()}건

## 1. 핵심 무결성 지표 요약
| 검사 항목 | 결과 수치 | 평가 등급 | 비고 |
| :--- | :--- | :--- | :--- |
| **의뢰번호(refNo) 중복** | ${duplicateRefNos.length}개 번호 (${duplicateRefNos.reduce((sum, d) => sum + d.count, 0)}건 연루) | **CONFIRMED** | 프론트엔드 동시 채번 충돌 |
| **clientId 누락** | ${missingClientIdCount}건 | **CONFIRMED** | 과거 레코드 일부 누락 |
| **clientId 중복** | ${duplicateClientIds.length}건 | **CONFIRMED** | Date.now() 동시 생성 충돌 |
| **referralId 누락** | ${missingReferralIdCount}건 (전체) | **CONFIRMED** | 신규 필드 도입 전 상태 |
| **[이름+나이+연락처] 중복 후보** | ${duplicateCandidates.length}개 그룹 | **REVIEW_REQUIRED** | 재의뢰 또는 동명이인/동일인 |
| **의뢰일자 다른 중복 후보** | ${duplicateCandidates.filter(c => c.differentRequestDates).length}개 그룹 | **REVIEW_REQUIRED** | 별도 사건(자동 병합 금지 대상) |
| **상담메모 총계** | ${totalNotes.toLocaleString()}건 | **CONFIRMED** | 누락 ID ${missingNoteIdCount}건 |
| **대용량 레코드 (>50KB)** | ${oversizedRecords.length}건 | **REVIEW_REQUIRED** | 메모 다수 또는 첨부파일 메타 |
| **Base64 포함 레코드** | ${base64Count}건 | **CONFIRMED** | 페이로드 비대화 원인 |

## 2. 세부 발견사항 및 원인
1. **refNo 중복**:
   - 총 ${duplicateRefNos.length}개 번호에서 중복 발생 확인.
   - 원인: 프론트엔드 \`App.tsx\`에서 로컬 메모리 기준 \`maxId + 1\`로 클라이언트 사이드에서 산출하여 동시 등록 시 동일 번호 할당.
2. **동일인 재의뢰와 30일 규칙 위험성**:
   - 후보 중 의뢰일자가 상이한 건이 ${duplicateCandidates.filter(c => c.differentRequestDates).length}건 존재.
   - 이들을 자동 병합할 경우 별개의 상담 이력이나 조치 결과가 훼손될 수 있으므로 **경고 안내 후 사용자 수동 검토** 방식으로 전환 필수.
`;
    fs.writeFileSync(path.join(outputDir, 'report.md'), reportMd, 'utf8');

    console.log('✅ [AUDIT COMPLETE] Audit files generated in audit-output/');
}

runAudit();

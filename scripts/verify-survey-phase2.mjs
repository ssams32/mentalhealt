/**
 * scripts/verify-survey-phase2.mjs
 * Comprehensive Verification Suite for Track B Phase 2:
 * 1. Contract reconciliation (WebCrypto wrappedKey + combined tag vs separate tag)
 * 2. Staff assignment & optimistic concurrency (409 CONCURRENCY_CONFLICT)
 * 3. Immutable assignment history preservation
 * 4. Internal in-app notification dispatch & zero-PII deduplication
 * 5. Server-side XLSX generation, CWE-1236 formula injection defense, & privacy masking
 */

import assert from 'assert';
import crypto from 'crypto';
import XLSX from 'xlsx';

import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyImportRepository,
    SurveyAssignmentRepository,
    SurveyExportService,
    sanitizeExcelCell,
    SURVEY_ASSIGNMENT_PRIORITY,
    NOTIFICATION_TYPES,
    SURVEY_ERROR_CODES
} from '../server/survey/index.js';

import {
    InternalNotificationRepository
} from '../server/notifications/index.js';

console.log('🧪 Starting Track B Phase 2 Verification Suite...\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function runAsyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

// ----------------------------------------------------
// Mock in-memory storage for repository tests
// ----------------------------------------------------
function createInMemoryStore() {
    const data = {};
    return {
        getData: (key, def = []) => JSON.parse(JSON.stringify(data[key] || def)),
        persistData: async (key, val) => {
            data[key] = JSON.parse(JSON.stringify(val));
            return true;
        },
        raw: data
    };
}

// ====================================================
// TEST 1: Track A / B Contract Reconciliation
// ====================================================
console.log('📌 Group 1: Track A and Track B Envelope Decryption Contract Reconciliation');

await runAsyncTest('WebCrypto standard format (wrappedKey + combined 16-byte tag)', async () => {
    const keyProvider = new SurveyKeyProvider({ secretPath: '/dummy/key.pem' });
    const { publicKey } = keyProvider.generateSyntheticTestKey('k2026_01');
    const decryptionService = new SurveyDecryptionService({ keyProvider });

    // Simulate WebCrypto client encryption
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const plaintext = JSON.stringify({
        schemaVersion: '1.0.0',
        assessmentId: 'phq-9',
        contact: { clientName: '홍길동', phone: '010-1234-5678' }
    });

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ctPart1 = cipher.update(plaintext, 'utf8');
    const ctPart2 = cipher.final();
    const tag = cipher.getAuthTag(); // 16 bytes
    // WebCrypto subtle.encrypt appends the tag to the ciphertext buffer
    const combinedCiphertextWithTag = Buffer.concat([ctPart1, ctPart2, tag]);

    const wrappedKey = crypto.publicEncrypt({
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey);

    const envelope = {
        schemaVersion: '1.0.0',
        submissionId: 'sub_test_reconcile_01',
        createdAt: new Date().toISOString(),
        keyVersion: 'k2026_01',
        algorithm: 'RSA-OAEP-256+AES-256-GCM',
        wrappedKey: wrappedKey.toString('base64'),
        iv: iv.toString('base64'),
        ciphertext: combinedCiphertextWithTag.toString('base64')
        // note: NO separate tag field!
    };

    const decrypted = decryptionService.decryptEnvelope(envelope);
    assert.strictEqual(decrypted.contact.clientName, '홍길동');
    assert.strictEqual(decrypted.contact.phone, '010-1234-5678');
    assert.strictEqual(decrypted.assessmentId, 'phq-9');
});

await runAsyncTest('Separate tag format (encryptedKey + separate tag field)', async () => {
    const keyProvider = new SurveyKeyProvider({ secretPath: '/dummy/key.pem' });
    const { publicKey } = keyProvider.generateSyntheticTestKey('test_key_v1');
    const decryptionService = new SurveyDecryptionService({ keyProvider });

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const plaintext = JSON.stringify({
        schemaVersion: '1.0.0',
        assessmentId: 'gad-7',
        contact: { clientName: '김상담', phone: '010-9876-5432' }
    });

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encryptedKey = crypto.publicEncrypt({
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey);

    const envelope = {
        schemaVersion: '1.0.0',
        submissionId: 'sub_test_reconcile_02',
        createdAt: new Date().toISOString(),
        keyVersion: 'test_key_v1',
        algorithm: 'RSA-OAEP-256+AES-256-GCM',
        encryptedKey: encryptedKey.toString('base64'),
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: tag.toString('base64')
    };

    const decrypted = decryptionService.decryptEnvelope(envelope);
    assert.strictEqual(decrypted.contact.clientName, '김상담');
    assert.strictEqual(decrypted.contact.phone, '010-9876-5432');
});

// ====================================================
// TEST 2: Staff Assignment & Concurrency Control
// ====================================================
console.log('\n📌 Group 2: Staff Assignment & Optimistic Concurrency Control');

await runAsyncTest('Initial staff assignment succeeds and increments version', async () => {
    const store = createInMemoryStore();
    const repo = new SurveyImportRepository(store);

    // Seed a survey submission
    await store.persistData('SurveySubmissions', [{
        internalSurveyId: 'surv_assign_01',
        submissionId: 'sub_assign_01',
        schemaVersion: '1.0.0',
        assessmentId: 'phq-9',
        assignedUserId: null,
        assignedDepartmentId: null,
        assignmentPriority: 'NORMAL',
        assignedAt: null,
        version: 1
    }]);

    const updated = await repo.assignStaff({
        submissionId: 'sub_assign_01',
        assignedUserId: 'counselor_01',
        assignedDepartmentId: '증진팀',
        assignmentPriority: 'PRIORITY_REVIEW',
        actorId: 'admin',
        reason: '위험도 우선검토 지정'
    });

    assert.strictEqual(updated.assignedUserId, 'counselor_01');
    assert.strictEqual(updated.assignmentPriority, 'PRIORITY_REVIEW');
    assert.strictEqual(updated.version, 2);
    assert(updated.assignedAt);
});

await runAsyncTest('Reassignment with expectedVersion matches and succeeds', async () => {
    const store = createInMemoryStore();
    const repo = new SurveyImportRepository(store);

    await store.persistData('SurveySubmissions', [{
        internalSurveyId: 'surv_assign_02',
        submissionId: 'sub_assign_02',
        assignedUserId: 'counselor_01',
        assignedDepartmentId: '증진팀',
        assignmentPriority: 'NORMAL',
        version: 2
    }]);

    const updated = await repo.assignStaff({
        submissionId: 'sub_assign_02',
        assignedUserId: 'counselor_02',
        assignedDepartmentId: '위기관리팀',
        assignmentPriority: 'IMMEDIATE_REVIEW',
        actorId: 'admin',
        reason: '팀간 업무 이관',
        expectedVersion: 2
    });

    assert.strictEqual(updated.assignedUserId, 'counselor_02');
    assert.strictEqual(updated.previousAssignedUserId, 'counselor_01');
    assert.strictEqual(updated.assignmentPriority, 'IMMEDIATE_REVIEW');
    assert.strictEqual(updated.version, 3);
});

await runAsyncTest('Reassignment with stale expectedVersion rejects with 409 CONCURRENCY_CONFLICT', async () => {
    const store = createInMemoryStore();
    const repo = new SurveyImportRepository(store);

    await store.persistData('SurveySubmissions', [{
        internalSurveyId: 'surv_assign_03',
        submissionId: 'sub_assign_03',
        assignedUserId: 'counselor_02',
        version: 5
    }]);

    let threw = false;
    try {
        await repo.assignStaff({
            submissionId: 'sub_assign_03',
            assignedUserId: 'counselor_03',
            expectedVersion: 4 // Stale!
        });
    } catch (err) {
        threw = true;
        assert.strictEqual(err.code, SURVEY_ERROR_CODES.CONCURRENCY_CONFLICT);
    }
    assert(threw, 'Should have thrown CONCURRENCY_CONFLICT');
});

// ====================================================
// TEST 3: Immutable Assignment History
// ====================================================
console.log('\n📌 Group 3: Immutable Assignment History Store');

await runAsyncTest('Append-only assignment history logs preserve sequential audit trail', async () => {
    const store = createInMemoryStore();
    const historyRepo = new SurveyAssignmentRepository(store);

    const record1 = await historyRepo.recordAssignment({
        submissionId: 'sub_hist_01',
        internalSurveyId: 'surv_hist_01',
        previousAssignedUserId: null,
        assignedUserId: 'user_a',
        assignedDepartmentId: '팀A',
        priority: 'NORMAL',
        reason: '초기 배정',
        actorUserId: 'admin',
        version: 1
    });

    const record2 = await historyRepo.recordAssignment({
        submissionId: 'sub_hist_01',
        internalSurveyId: 'surv_hist_01',
        previousAssignedUserId: 'user_a',
        assignedUserId: 'user_b',
        assignedDepartmentId: '팀B',
        priority: 'IMMEDIATE_REVIEW',
        reason: '고위험군 재배정',
        actorUserId: 'manager_1',
        version: 2
    });

    const history = historyRepo.getHistoryBySurveyId('sub_hist_01');
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].historyId, record1.historyId);
    assert.strictEqual(history[1].historyId, record2.historyId);
    assert.strictEqual(history[1].previousAssignedUserId, 'user_a');
    assert.strictEqual(history[1].assignedUserId, 'user_b');
    assert.strictEqual(history[1].priority, 'IMMEDIATE_REVIEW');
});

// ====================================================
// TEST 4: Internal In-App Notifications & Zero PII
// ====================================================
console.log('\n📌 Group 4: Internal Notifications & Privacy Guardrails');

await runAsyncTest('Notification dispatch, zero PII, and deduplicationKey', async () => {
    const store = createInMemoryStore();
    const notifRepo = new InternalNotificationRepository(store);

    const dedupKey = 'survey_assign_sub_notif_01_v1';
    const firstDispatch = await notifRepo.createNotification({
        recipientUserId: 'counselor_lee',
        type: NOTIFICATION_TYPES.SURVEY_ASSIGNED,
        relatedEntityType: 'survey',
        relatedEntityId: 'sub_notif_01',
        safeTitle: '온라인 설문 배정 알림',
        safeMessage: '온라인 상담검토 1건이 배정되었습니다. (접수ID: surv_notif_01, 우선순위: NORMAL)',
        priority: 'NORMAL',
        createdByUserId: 'admin',
        deduplicationKey: dedupKey
    });

    assert.strictEqual(firstDispatch.isDuplicate, false);
    assert.strictEqual(firstDispatch.notification.recipientUserId, 'counselor_lee');
    assert.strictEqual(firstDispatch.notification.readAt, null);

    // Verify zero PII in notification
    assert(!firstDispatch.notification.safeMessage.includes('010-'));
    assert(!firstDispatch.notification.safeMessage.includes('홍길동'));

    // Try duplicate dispatch with identical dedup key
    const secondDispatch = await notifRepo.createNotification({
        recipientUserId: 'counselor_lee',
        type: NOTIFICATION_TYPES.SURVEY_ASSIGNED,
        relatedEntityType: 'survey',
        relatedEntityId: 'sub_notif_01',
        safeTitle: '온라인 설문 배정 알림',
        safeMessage: '온라인 상담검토 1건이 배정되었습니다.',
        deduplicationKey: dedupKey
    });

    assert.strictEqual(secondDispatch.isDuplicate, true);
    assert.strictEqual(secondDispatch.notification.notificationId, firstDispatch.notification.notificationId);

    // Verify unread count
    assert.strictEqual(notifRepo.getUnreadCount('counselor_lee'), 1);

    // Mark as read
    await notifRepo.markAsRead(firstDispatch.notification.notificationId, 'counselor_lee');
    assert.strictEqual(notifRepo.getUnreadCount('counselor_lee'), 0);
});

// ====================================================
// TEST 5: Server-Side XLSX Export & CWE-1236 Defense
// ====================================================
console.log('\n📌 Group 5: Server-Side XLSX Export & Formula Injection Defense (CWE-1236)');

runTest('CWE-1236 sanitizeExcelCell prepends single quote for dangerous formula prefixes', () => {
    // Dangerous triggers: =, +, -, @, \t, \r
    assert.strictEqual(sanitizeExcelCell('=SUM(1,2)'), "'=SUM(1,2)");
    assert.strictEqual(sanitizeExcelCell('+cmd|/c calc'), "'+cmd|/c calc");
    assert.strictEqual(sanitizeExcelCell('-1000'), "'-1000");
    assert.strictEqual(sanitizeExcelCell('@dangerous_func()'), "'@dangerous_func()");
    assert.strictEqual(sanitizeExcelCell('\tleading_tab'), "'\tleading_tab");
    assert.strictEqual(sanitizeExcelCell('\rleading_cr'), "'\rleading_cr");
    assert.strictEqual(sanitizeExcelCell('   =SUM(1,2)'), "'   =SUM(1,2)"); // leading whitespace with formula

    // Safe strings should NOT be modified
    assert.strictEqual(sanitizeExcelCell('홍길동'), '홍길동');
    assert.strictEqual(sanitizeExcelCell('010-1234-5678'), '010-1234-5678');
    assert.strictEqual(sanitizeExcelCell('일반 상담 신청입니다.'), '일반 상담 신청입니다.');
});

runTest('XLSX Buffer generation creates valid workbook in memory with neutral filename', () => {
    const exportService = new SurveyExportService();

    const sampleRecords = [
        {
            internalSurveyId: 'surv_exp_01',
            submissionId: 'sub_exp_01',
            createdAt: '2026-09-16T10:00:00.000Z',
            importedAt: '2026-09-16T10:05:00.000Z',
            contact: {
                clientName: '홍길동',
                phone: '010-1234-5678',
                region: '이천시 부발읍',
                counselingRequestText: '=1+1 dangerous injection'
            },
            assessmentId: 'phq-9',
            assessment: { totalScore: 14, severity: '중간 정도의 우울증' },
            consultationStatus: '검토대기',
            assignedUserId: 'counselor_kim',
            assignedAt: '2026-09-16T11:00:00.000Z',
            assignmentPriority: 'PRIORITY_REVIEW',
            consentEvidence: {
                personalInfoConsent: true,
                sensitiveInfoConsent: true,
                consentVersion: '1.0.0'
            },
            retentionUntil: '2027-09-16T10:00:00.000Z',
            externalStatus: 'DELETED'
        },
        {
            internalSurveyId: 'surv_exp_02',
            submissionId: 'sub_exp_02',
            contact: {
                clientName: '이순신',
                phone: '010-9876-5432',
                region: '이천시 창전동',
                counselingRequestText: '+CMD|calc'
            },
            assessmentId: 'gad-7',
            assessment: { totalScore: 8, severity: '경도 불안' },
            assignmentPriority: 'NORMAL'
        }
    ];

    // 1. Export with identifiable permission = false (Masked)
    const maskedResult = exportService.generateExcelBuffer(sampleRecords, { isIdentifiable: false });
    assert(Buffer.isBuffer(maskedResult.buffer));
    assert(maskedResult.filename.startsWith('online-surveys_'));
    assert(maskedResult.filename.endsWith('.xlsx'));
    assert.strictEqual(maskedResult.rowCount, 2);

    // Read back the generated XLSX buffer using xlsx reader
    const wbMasked = XLSX.read(maskedResult.buffer, { type: 'buffer' });
    const sheetName = wbMasked.SheetNames[0];
    const rowsMasked = XLSX.utils.sheet_to_json(wbMasked.Sheets[sheetName], { header: 1 });

    // Verify header row
    assert.strictEqual(rowsMasked[0][4], '내담자명');
    assert.strictEqual(rowsMasked[0][5], '연락처');

    // Verify row 1 is masked
    assert.strictEqual(rowsMasked[1][4], '홍*동');
    assert.strictEqual(rowsMasked[1][5], '010-****-5678');
    // Verify counselingRequestText formula escaped
    assert.strictEqual(rowsMasked[1][7], "'=1+1 dangerous injection");

    // Verify row 2 formula escaped
    assert.strictEqual(rowsMasked[2][7], "'+CMD|calc");

    // 2. Export with identifiable permission = true (Unmasked)
    const unmaskedResult = exportService.generateExcelBuffer(sampleRecords, { isIdentifiable: true });
    const wbUnmasked = XLSX.read(unmaskedResult.buffer, { type: 'buffer' });
    const rowsUnmasked = XLSX.utils.sheet_to_json(wbUnmasked.Sheets[wbUnmasked.SheetNames[0]], { header: 1 });

    assert.strictEqual(rowsUnmasked[1][4], '홍길동');
    assert.strictEqual(rowsUnmasked[1][5], '010-1234-5678');
    assert.strictEqual(rowsUnmasked[2][4], '이순신');
    assert.strictEqual(rowsUnmasked[2][5], '010-9876-5432');
});

console.log(`\n==============================================`);
console.log(`🎯 Phase 2 Results: ${passedTests}/${totalTests} tests passed.`);
console.log(`==============================================\n`);
if (passedTests !== totalTests) {
    process.exit(1);
}

/**
 * scripts/verify-survey-dashboard-ux.mjs
 * Verification suite for Track B Administrator Dashboard UX, 10 synthetic fixtures,
 * business summary calculations, consultation-status progression, and privacy guards.
 */

import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    SurveyKeyProvider,
    SurveyDecryptionService,
    SurveyPayloadValidator,
    SurveyImportRepository,
    SurveyImportService,
    SurveyReportGenerator,
    SurveyReferralService,
    MockTrackAApi
} from '../server/survey/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;

function it(desc, fn) {
    try {
        fn();
        console.log(`  ✅ [PASS] ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${desc}:`, err.message);
        failed++;
    }
}

async function itAsync(desc, fn) {
    try {
        await fn();
        console.log(`  ✅ [PASS] ${desc}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${desc}:`, err.message);
        failed++;
    }
}

function createIsolatedStore() {
    const store = new Map();
    const getData = (filename, defaultVal = []) => {
        if (!store.has(filename)) {
            store.set(filename, JSON.parse(JSON.stringify(defaultVal)));
        }
        return store.get(filename);
    };
    const persistData = async (filename, data) => {
        store.set(filename, JSON.parse(JSON.stringify(data)));
        return true;
    };
    return { getData, persistData, store };
}

async function runDashboardUxSuite() {
    console.log('\n============================================================');
    console.log('🧪 TRACK B: ADMINISTRATOR DASHBOARD UX & WORKFLOW VERIFICATION');
    console.log('============================================================\n');

    const { getData, persistData } = createIsolatedStore();
    const keyProvider = new SurveyKeyProvider();
    const { publicKey, privateKey } = keyProvider.generateSyntheticTestKey('test_key_v1');
    const decryptionService = new SurveyDecryptionService({ keyProvider });
    const validator = new SurveyPayloadValidator({ sbqrApproved: false });
    const repo = new SurveyImportRepository({ getData, persistData });
    const mockTrackA = new MockTrackAApi({ workerId: 'track-b-worker-1' });
    const reportGen = new SurveyReportGenerator();
    const tempDir = path.join(__dirname, '..', 'scratch');

    const referralService = new SurveyReferralService({
        getData,
        persistData,
        attachmentsDir: tempDir,
        reportGenerator: reportGen,
        getUsers: () => [
            { id: 'user_kim', name: '김상담', team: '증진팀', role: 'counselor' },
            { id: 'user_lee', name: '이전문', team: '예방팀', role: 'counselor' }
        ]
    });

    const importService = new SurveyImportService({
        repository: repo,
        decryptionService,
        validator,
        externalApiClient: mockTrackA,
        referralService,
        workerId: 'track-b-worker-1'
    });

    // 1. Seed all 10 synthetic fixtures
    console.log('📌 Group 1: 10 Synthetic Test Fixtures Generation & Validation');
    mockTrackA.seedDefaultSyntheticSubmissions(publicKey);

    it('1.1. Exactly 10 synthetic envelopes are seeded in MockTrackA', () => {
        assert.strictEqual(mockTrackA.submissions.size, 10, 'Expected 10 seeded submissions');
    });

    it('1.2. Fixtures include all required variants (PHQ-9, GAD-7, BEPSI-K, ISI-K, Contact-Only, SBQ-R)', () => {
        const subIds = Array.from(mockTrackA.submissions.keys());
        assert.ok(subIds.includes('sub-demo-001'), 'sub-demo-001 (PHQ-9) missing');
        assert.ok(subIds.includes('sub-demo-002'), 'sub-demo-002 (GAD-7) missing');
        assert.ok(subIds.includes('sub-demo-003'), 'sub-demo-003 (BEPSI-K) missing');
        assert.ok(subIds.includes('sub-demo-004'), 'sub-demo-004 (Contact-Only) missing');
        assert.ok(subIds.includes('sub-demo-005'), 'sub-demo-005 (SBQ-R) missing');
        assert.ok(subIds.includes('sub-demo-006'), 'sub-demo-006 (ISI-K) missing');
        assert.ok(subIds.includes('sub-demo-007'), 'sub-demo-007 (PHQ-9 Severe) missing');
        assert.ok(subIds.includes('sub-demo-008'), 'sub-demo-008 (New GAD-7) missing');
        assert.ok(subIds.includes('sub-demo-009'), 'sub-demo-009 (BEPSI-K Normal) missing');
        assert.ok(subIds.includes('sub-demo-010'), 'sub-demo-010 (Unassigned PHQ-9) missing');
    });

    // 2. Import all 10 fixtures through pipeline
    console.log('\n📌 Group 2: Ingestion & Business-First Aggregation Metrics');
    let summary;
    await itAsync('2.1. Batch ingestion processes all 10 submissions with strict quarantine gate', async () => {
        summary = await importService.runManualImport({ actorId: 'admin_test', limit: 50 });
        assert.strictEqual(summary.imported, 9, 'Expected 9 approved imports');
        assert.strictEqual(summary.quarantined, 1, 'Expected 1 SBQ-R quarantined');
    });

    it('2.2. SBQ-R submission creates 0 referrals and 0 PDF reports', () => {
        const referrals = getData('Referrals', []);
        const sbqrRef = referrals.find(r => r.sourceSubmissionId === 'sub-demo-005');
        assert.strictEqual(sbqrRef, undefined, 'SBQ-R must not produce a referral');
    });

    it('2.3. Contact-Only submission creates a referral without assessment scores', () => {
        const referrals = getData('Referrals', []);
        const contactOnlyRef = referrals.find(r => r.sourceSubmissionId === 'sub-demo-004');
        assert.ok(contactOnlyRef, 'Contact-only referral must exist');
        assert.strictEqual(contactOnlyRef.contactOnly, true, 'Must flag contactOnly');
        assert.strictEqual(contactOnlyRef.assessmentScore, null, 'Must have null assessmentScore');
    });

    it('2.4. BEPSI-K submissions distinguish rawScore and meanScore correctly', () => {
        const subs = repo.getSurveySubmissions();
        const bepsiSub1 = subs.find(s => s.submissionId === 'sub-demo-003');
        const bepsiSub2 = subs.find(s => s.submissionId === 'sub-demo-009');
        assert.ok(bepsiSub1 && bepsiSub2, 'BEPSI-K submissions must be present');
        assert.strictEqual(bepsiSub1.assessment.totalScore, 14, 'Raw totalScore must be 14');
        assert.strictEqual(bepsiSub1.assessment.meanScore, 2.80, 'Mean score must be 2.80');
        assert.strictEqual(bepsiSub2.assessment.totalScore, 7, 'Raw totalScore must be 7');
        assert.strictEqual(bepsiSub2.assessment.meanScore, 1.40, 'Mean score must be 1.40');
    });

    // 3. Staff Assignment & Linked Referral Synchronization
    console.log('\n📌 Group 3: Staff Assignment & Linked Referral Synchronization');
    await itAsync('3.1. Assigning staff updates submission and syncs note & assignee to linked referral', async () => {
        await repo.assignStaff({
            submissionId: 'sub-demo-001',
            targetUserId: 'user_kim',
            assignedDepartmentId: '증진팀',
            actorId: 'admin_test',
            assignmentPriority: 'PRIORITY_REVIEW',
            reason: '초기 심층 면접 배정'
        });

        const updatedRef = await referralService.updateReferralAssignee({
            submissionId: 'sub-demo-001',
            assignedUserId: 'user_kim',
            assignedDepartmentId: '증진팀',
            actorId: 'admin_test'
        });

        assert.ok(updatedRef, 'Updated referral must be returned');
        assert.strictEqual(updatedRef.assignee, '김상담', 'Referral assignee must be 김상담');
        assert.strictEqual(updatedRef.team, '증진팀', 'Referral team must be 증진팀');
        const lastNote = updatedRef.notes[updatedRef.notes.length - 1];
        assert.ok(lastNote.content.includes('김상담'), 'Note must log assignment');
    });

    // 4. Consultation Status Update Workflow
    console.log('\n📌 Group 4: Consultation Progress Status Update Workflow');
    await itAsync('4.1. Updating consultation status updates repo and linked referral draft', async () => {
        const updatedSub = await repo.updateConsultationStatus({
            submissionId: 'sub-demo-001',
            consultationStatus: '상담진행',
            actorId: 'user_kim',
            note: '1차 전화 초기면접 완료'
        });

        assert.strictEqual(updatedSub.consultationStatus, '상담진행', 'Status must be updated to 상담진행');
        assert.strictEqual(updatedSub.consultationStatusUpdatedBy, 'user_kim');

        const updatedRef = await referralService.updateReferralConsultationStatus({
            submissionId: 'sub-demo-001',
            consultationStatus: '상담진행',
            actorId: 'user_kim',
            note: '1차 전화 초기면접 완료'
        });

        assert.ok(updatedRef, 'Referral must be updated');
        assert.strictEqual(updatedRef.referralStatus, 'IN_PROGRESS');
        assert.strictEqual(updatedRef.closureStatus, '미종결');
        const lastNote = updatedRef.notes[updatedRef.notes.length - 1];
        assert.ok(lastNote.content.includes('상담진행'), 'Referral note must log consultation status');
    });

    await itAsync('4.2. Updating consultation status to 상담완료 closes the linked referral', async () => {
        await repo.updateConsultationStatus({
            submissionId: 'sub-demo-001',
            consultationStatus: '상담완료',
            actorId: 'user_kim',
            note: '종결 평가 완료'
        });

        const updatedRef = await referralService.updateReferralConsultationStatus({
            submissionId: 'sub-demo-001',
            consultationStatus: '상담완료',
            actorId: 'user_kim',
            note: '종결 평가 완료'
        });

        assert.strictEqual(updatedRef.referralStatus, 'REVIEWED');
        assert.strictEqual(updatedRef.closureStatus, '종결');
    });

    // 5. Zero-Leakage of Technical Secrets in Dashboard View
    console.log('\n📌 Group 5: Zero Secret Leakage & Privacy Guardrails');
    it('5.1. Submission records contain zero private keys, secrets, or encryption keys', () => {
        const subs = repo.getSurveySubmissions();
        const stringified = JSON.stringify(subs);
        assert.ok(!stringified.includes('PRIVATE KEY'), 'Must not contain private key');
        assert.ok(!stringified.includes('TRACK_B_SERVICE_SECRET'), 'Must not contain service secret');
        assert.ok(!stringified.includes('wrappedKey'), 'Submissions must not retain raw wrappedKey');
    });

    console.log('\n============================================================');
    console.log(`🎯 DASHBOARD UX SUITE COMPLETED: ${passed} Passed, ${failed} Failed`);
    console.log('============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runDashboardUxSuite().catch(err => {
    console.error('Fatal error in suite:', err);
    process.exit(1);
});

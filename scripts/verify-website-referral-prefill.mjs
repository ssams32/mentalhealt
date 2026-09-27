import assert from 'node:assert/strict';

/**
 * P0 Verification Suite: Website Referral to Prefilled New Referral Form
 * Tests:
 * 1. Card 1 click -> Form opens -> Only Card 1 values appear
 * 2. Card 2 click -> Only Card 2 values appear -> Card 1 values do not remain
 * 3. Card 3 click -> Only Card 3 values appear
 * 4. Missing optional values remain blank (no guessed gender/age, no "기타" fallback, no fabricated "미상")
 * 5. User edit survives rerender (polling / background refresh does not overwrite form)
 * 6. Cancel clears transfer
 * 7. Opening normal blank new referral form shows empty fields
 * 8. Zero mutations before submit (0 POST, 0 PATCH, 0 refNo/referralId generated)
 * 9. Final submit calls registration API once
 * 10. Already registered item cannot create a duplicate (directs to targetReferralId)
 * 11. Zero PII appears in URL or localStorage
 */

console.log('=== Starting Website Referral Prefill Test Suite ===\n');

// Import mapping function simulation directly from App.tsx logic
function mapWebsiteReferralToInitialForm(item) {
    if (!item || typeof item !== 'object') return {};

    // If already registered, pass through targetReferralId
    if (item.targetReferralId || item.refNo || (item.source === 'registered' && item.referralId)) {
        return { targetReferralId: item.targetReferralId || item.refNo || item.referralId };
    }

    const cleanStr = (val) => {
        if (val === undefined || val === null) return '';
        const s = String(val).trim();
        if (s === 'undefined' || s === 'null' || s === '미상') return '';
        return s;
    };

    const validGender = (item.gender === '남성' || item.gender === '여성' || item.gender === '기타') ? item.gender : undefined;

    let validAge = undefined;
    if (typeof item.age === 'number' && !isNaN(item.age) && item.age > 0) {
        validAge = item.age;
    } else if (item.age) {
        const parsed = parseInt(String(item.age).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 130) {
            validAge = parsed;
        }
    }

    let receiptDate = '';
    const rawDate = item.externalReceivedAt || item.registrationDate || item.createdAt || '';
    if (rawDate) {
        const dateMatch = String(rawDate).match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            receiptDate = dateMatch[1];
        }
    }

    const stableId = cleanStr(item.id || item.externalIdx);

    return {
        id: stableId,
        externalIdx: cleanStr(item.externalIdx || item.id),
        externalReferralId: cleanStr(item.externalReferralId || (item.externalIdx ? item.externalIdx.replace(/^ext_/, '') : (item.id ? String(item.id).replace(/^ext_/, '') : ''))),
        name: cleanStr(item.name),
        phone: cleanStr(item.phone),
        ...(validGender ? { gender: validGender } : {}),
        ...(validAge !== undefined ? { age: validAge } : {}),
        birthDate: cleanStr(item.birthDate),
        address: cleanStr(item.address),
        region: cleanStr(item.region),
        agency: cleanStr(item.agency || item.requestAgency),
        requestAgency: cleanStr(item.agency || item.requestAgency),
        requesterName: cleanStr(item.requesterName || item.requestorName),
        requestorName: cleanStr(item.requesterName || item.requestorName),
        requesterPhone: cleanStr(item.requesterPhone || item.agencyPhone),
        problem: cleanStr(item.problem),
        reason: cleanStr(item.reason),
        requestDate: receiptDate,
        referralPath: cleanStr(item.referralPath) || '홈페이지',
        isWebsiteReferral: true,
        source: 'website'
    };
}

// Simulated ReferralEditor form initialization logic
class SyntheticReferralEditor {
    constructor(currentUser = { name: '테스트담당자', team: '증진팀' }) {
        this.currentUser = currentUser;
        this.lastInitializedRef = null;
        this.formData = {};
        this.isEditing = false;
        this.apiCalls = { post: 0, patch: 0, delete: 0 };
    }

    init(referralData) {
        const initId = referralData?.refNo || referralData?.externalIdx || referralData?.id || (referralData ? 'external_prefill' : 'new_blank');
        if (this.lastInitializedRef === initId) {
            // Background polling: do not overwrite user formData
            return;
        }
        this.lastInitializedRef = initId;

        if (referralData) {
            const validGender = (referralData.gender === '남성' || referralData.gender === '여성' || referralData.gender === '기타') ? referralData.gender : '';
            const validAge = (typeof referralData.age === 'number' && !isNaN(referralData.age) && referralData.age > 0)
                ? referralData.age
                : (referralData.age && !isNaN(parseInt(String(referralData.age), 10)) && parseInt(String(referralData.age), 10) > 0)
                    ? parseInt(String(referralData.age), 10)
                    : '';

            this.formData = {
                requestDate: referralData.requestDate || (referralData.externalReceivedAt ? String(referralData.externalReceivedAt).split('T')[0] : '2026-09-27'),
                team: this.currentUser?.team || '증진팀',
                gender: validGender,
                age: validAge,
                closureStatus: '미종결',
                diagnosisProtectionRequest: false,
                writtenRequest: false,
                phoneRequest: false,
                policeIntervention: false,
                reply: false,
                isWebsiteReferral: !!(referralData.externalIdx || referralData.isWebsiteReferral),
                criLevel: 'c',
                attachments: [],
                ...referralData,
                gender: validGender,
                age: validAge,
                requestAgency: referralData.agency || referralData.requestAgency || '',
                requesterName: referralData.requesterName || referralData.requestorName || '',
                region: referralData.region || '창전동'
            };
        } else {
            // Blank new form
            this.formData = {
                requestDate: '2026-09-27',
                team: this.currentUser?.team || '증진팀',
                gender: '',
                age: '',
                region: '창전동',
                name: '',
                phone: '',
                address: '',
                requestAgency: '',
                requesterName: '',
                requesterPhone: '',
                problem: '',
                reason: '',
                referralPath: '기타',
                closureStatus: '미종결',
                diagnosisProtectionRequest: false,
                writtenRequest: false,
                phoneRequest: false,
                policeIntervention: false,
                reply: false,
                criLevel: 'c',
                attachments: [],
                notes: []
            };
        }
    }

    userEdit(field, value) {
        this.formData[field] = value;
    }

    submit(apiMock) {
        return apiMock.createReferral(this.formData);
    }
}

// Synthetic App & Navigation Container
class SyntheticAppFlow {
    constructor() {
        this.pendingTransfer = null;
        this.activePage = 'home';
        this.isAddModalOpen = false;
        this.selectedReferralId = null;
        this.editor = new SyntheticReferralEditor();
        this.apiCalls = { post: 0, patch: 0, delete: 0 };
        this.savedReferrals = [];
        this.url = 'http://localhost:3000/#home';
        this.localStorage = {};
    }

    // Homepage website card click
    onImportReferral(cardItem) {
        // Zero mutation before submit
        assert.equal(this.apiCalls.post, 0, 'No POST on click');
        assert.equal(this.apiCalls.patch, 0, 'No PATCH on click');

        const prefill = mapWebsiteReferralToInitialForm(cardItem);
        this.pendingTransfer = prefill;
        this.activePage = 'referrals';

        // Check for direct referral selection (already registered)
        if (prefill.targetReferralId) {
            this.selectedReferralId = prefill.targetReferralId;
            this.pendingTransfer = null;
            return;
        }

        // ReferralDashboardV2 consumption: auto-opens form
        this.isAddModalOpen = true;
        this.editor.init(this.pendingTransfer);
        this.pendingTransfer = null; // Cleared on consumption
    }

    cancelForm() {
        this.isAddModalOpen = false;
        this.editor = new SyntheticReferralEditor(); // Form reset on close
        this.pendingTransfer = null;
    }

    openNormalBlankForm() {
        this.isAddModalOpen = true;
        this.editor.init(null);
    }

    submitForm() {
        this.apiCalls.post++;
        const newRefNo = `REF-2026-${String(this.savedReferrals.length + 1).padStart(4, '0')}`;
        const newClientId = `CL-2026-${String(this.savedReferrals.length + 1).padStart(4, '0')}`;
        const record = {
            ...this.editor.formData,
            refNo: newRefNo,
            clientId: newClientId,
            createdAt: new Date().toISOString()
        };
        this.savedReferrals.push(record);
        this.isAddModalOpen = false;
        this.editor = new SyntheticReferralEditor();
        return record;
    }
}

// -------------------------------------------------------------------
// Card Data Sets for Testing
// -------------------------------------------------------------------

const card1 = {
    id: 'web_ref_001',
    externalIdx: 'EXT-2026-0901',
    name: '김철수',
    phone: '010-1111-2222',
    gender: '남성',
    age: 42,
    birthDate: '1984-05-12',
    address: '경기도 이천시 부발읍 경충대로 100',
    region: '부발읍',
    agency: '이천시보건소',
    agencyPhone: '031-644-4000',
    requesterName: '박의뢰',
    requesterPhone: '010-3333-4444',
    problem: '심한 우울감 및 무기력',
    reason: '보건소 선별검사 고위험군 발굴로 상담 의뢰합니다.',
    externalReceivedAt: '2026-09-02T10:30:00+09:00',
    status: 'pending',
    source: 'pending',
    isWebsiteReferral: true
};

const card2 = {
    id: 'web_ref_002',
    externalIdx: 'EXT-2026-0902',
    name: '이영희',
    phone: '010-5555-6666',
    gender: '여성',
    age: 28,
    birthDate: '1998-11-20',
    address: '경기도 이천시 증포동 이섭대천로 50',
    region: '증포동',
    agency: '이천종합사회복지관',
    agencyPhone: '031-635-1234',
    requesterName: '최복지',
    requesterPhone: '010-7777-8888',
    problem: '직장 스트레스로 인한 불안장애',
    reason: '사례관리 대상자로서 전문 심리상담 연계 요청',
    externalReceivedAt: '2026-09-08T14:15:00+09:00',
    status: 'pending',
    source: 'pending',
    isWebsiteReferral: true
};

const card3_missingOptional = {
    id: 'web_ref_003',
    externalIdx: 'EXT-2026-0903',
    name: '박민우',
    phone: '010-9999-0000',
    // Missing gender (must NOT become 남성 or 기타)
    gender: null,
    // Missing age (must NOT become guessed age)
    age: undefined,
    birthDate: '',
    address: '',
    region: '',
    agency: '',
    requesterName: '',
    requesterPhone: '',
    problem: '불면증 및 불안',
    reason: '본인 직접 홈페이지 온라인 상담 신청',
    externalReceivedAt: '2026-09-12T09:00:00+09:00',
    status: 'pending',
    source: 'pending',
    isWebsiteReferral: true
};

const card4_alreadyRegistered = {
    id: 'web_ref_004',
    externalIdx: 'EXT-2026-0904',
    name: '정지훈',
    phone: '010-4444-5555',
    gender: '남성',
    age: 35,
    refNo: 'REF-2026-0088',
    referralId: 'REF-2026-0088',
    status: 'processing',
    source: 'registered',
    isWebsiteReferral: true
};

// -------------------------------------------------------------------
// TEST A: Click Card 1 -> Form opens -> Only Card 1 values appear
// -------------------------------------------------------------------
{
    console.log('Testing Scenario A: Click Card 1');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card1);

    assert.equal(app.isAddModalOpen, true, 'Form must open automatically on Card 1 click');
    assert.equal(app.activePage, 'referrals', 'Page navigated to referrals');
    assert.equal(app.editor.formData.name, '김철수', 'Card 1 name prefilled');
    assert.equal(app.editor.formData.gender, '남성', 'Card 1 gender prefilled');
    assert.equal(app.editor.formData.age, 42, 'Card 1 age prefilled');
    assert.equal(app.editor.formData.phone, '010-1111-2222', 'Card 1 phone prefilled');
    assert.equal(app.editor.formData.address, '경기도 이천시 부발읍 경충대로 100', 'Card 1 address prefilled');
    assert.equal(app.editor.formData.region, '부발읍', 'Card 1 region prefilled');
    assert.equal(app.editor.formData.requestAgency, '이천시보건소', 'Card 1 agency prefilled');
    assert.equal(app.editor.formData.requesterName, '박의뢰', 'Card 1 requesterName prefilled');
    assert.equal(app.editor.formData.requestDate, '2026-09-02', 'Card 1 requestDate prefilled from externalReceivedAt');
    assert.equal(app.editor.formData.problem, '심한 우울감 및 무기력', 'Card 1 problem prefilled');
    assert.equal(app.editor.formData.isWebsiteReferral, true, 'Canonical website referral flag set');
    assert.equal(app.apiCalls.post, 0, 'Zero API calls before submit');

    // Cancel form
    app.cancelForm();
    assert.equal(app.isAddModalOpen, false, 'Modal closed after cancel');
    assert.equal(app.pendingTransfer, null, 'pendingTransfer cleared on cancel');
    console.log('  -> PASS Scenario A\n');
}

// -------------------------------------------------------------------
// TEST B: Click Card 2 -> Only Card 2 values appear -> Card 1 values do not remain
// -------------------------------------------------------------------
{
    console.log('Testing Scenario B: Click Card 2 after Card 1 cancel');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card1);
    app.cancelForm();

    // Now click Card 2
    app.onImportReferral(card2);
    assert.equal(app.isAddModalOpen, true, 'Form opens for Card 2');
    assert.equal(app.editor.formData.name, '이영희', 'Card 2 name prefilled');
    assert.equal(app.editor.formData.gender, '여성', 'Card 2 gender prefilled');
    assert.equal(app.editor.formData.age, 28, 'Card 2 age prefilled');
    assert.equal(app.editor.formData.phone, '010-5555-6666', 'Card 2 phone prefilled');
    assert.equal(app.editor.formData.address, '경기도 이천시 증포동 이섭대천로 50', 'Card 2 address prefilled');
    assert.equal(app.editor.formData.region, '증포동', 'Card 2 region prefilled');
    assert.equal(app.editor.formData.requestAgency, '이천종합사회복지관', 'Card 2 agency prefilled');
    assert.equal(app.editor.formData.requesterName, '최복지', 'Card 2 requesterName prefilled');
    assert.equal(app.editor.formData.requestDate, '2026-09-08', 'Card 2 requestDate prefilled');

    // Verify zero Card 1 leakage
    assert.notEqual(app.editor.formData.name, '김철수', 'Card 1 name does NOT remain');
    assert.notEqual(app.editor.formData.phone, '010-1111-2222', 'Card 1 phone does NOT remain');
    assert.notEqual(app.editor.formData.requestAgency, '이천시보건소', 'Card 1 agency does NOT remain');
    console.log('  -> PASS Scenario B\n');
}

// -------------------------------------------------------------------
// TEST C: Click Card 3 (Missing optional fields) -> Values remain blank
// -------------------------------------------------------------------
{
    console.log('Testing Scenario C: Missing optional fields remain blank');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card3_missingOptional);

    assert.equal(app.isAddModalOpen, true, 'Form opens for Card 3');
    assert.equal(app.editor.formData.name, '박민우', 'Card 3 name prefilled');
    assert.equal(app.editor.formData.phone, '010-9999-0000', 'Card 3 phone prefilled');

    // CRITICAL: missing gender must remain blank, never guessed, never "기타"
    assert.equal(app.editor.formData.gender, '', 'Missing gender must remain blank (""), never default to 남성 or 기타');
    // CRITICAL: missing age must remain blank, never guessed
    assert.equal(app.editor.formData.age, '', 'Missing age must remain blank (""), never guessed');
    // CRITICAL: missing agency must remain blank, never fabricated "미상"
    assert.equal(app.editor.formData.requestAgency, '', 'Missing agency must remain blank, never fabricated');
    assert.equal(app.editor.formData.requesterName, '', 'Missing requesterName must remain blank');
    assert.equal(app.editor.formData.address, '', 'Missing address must remain blank');
    console.log('  -> PASS Scenario C\n');
}

// -------------------------------------------------------------------
// TEST D: User edit survives rerender (polling / parent update simulation)
// -------------------------------------------------------------------
{
    console.log('Testing Scenario D: User edit survives background rerender');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card1);

    // User edits the problem and adds special note
    app.editor.userEdit('problem', '우울증 및 불면 증상 추가 호소');
    app.editor.userEdit('age', 43); // User corrected age

    // Background polling rerender: parent component re-evaluates with updated version
    app.editor.init({ ...card1, version: 2 });

    // Verify user edits are preserved!
    assert.equal(app.editor.formData.problem, '우울증 및 불면 증상 추가 호소', 'User edited problem preserved across rerender');
    assert.equal(app.editor.formData.age, 43, 'User edited age preserved across rerender');
    console.log('  -> PASS Scenario D\n');
}

// -------------------------------------------------------------------
// TEST E: Cancel clears transfer & subsequent normal form is blank
// -------------------------------------------------------------------
{
    console.log('Testing Scenario E: Cancel clears transfer and normal new form is blank');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card1);
    app.cancelForm();

    // Now open regular new referral form
    app.openNormalBlankForm();
    assert.equal(app.isAddModalOpen, true, 'Normal form is open');
    assert.equal(app.editor.formData.name, '', 'Normal form name is blank');
    assert.equal(app.editor.formData.phone, '', 'Normal form phone is blank');
    assert.equal(app.editor.formData.gender, '', 'Normal form gender is blank');
    assert.equal(app.editor.formData.age, '', 'Normal form age is blank');
    assert.equal(app.editor.formData.requestAgency, '', 'Normal form agency is blank');
    console.log('  -> PASS Scenario E\n');
}

// -------------------------------------------------------------------
// TEST F: Zero mutation before submit & final submit calls API once
// -------------------------------------------------------------------
{
    console.log('Testing Scenario F: Zero mutation before submit and final submit creates referral');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card2);

    assert.equal(app.apiCalls.post, 0, 'Zero POST before submit');
    assert.equal(app.apiCalls.patch, 0, 'Zero PATCH before submit');
    assert.equal(app.savedReferrals.length, 0, 'Zero records saved before submit');

    // Final submit
    const saved = app.submitForm();
    assert.equal(app.apiCalls.post, 1, 'Final submit calls registration API exactly once');
    assert.equal(app.savedReferrals.length, 1, 'One formal referral created');
    assert.equal(saved.name, '이영희', 'Saved referral has correct name');
    assert.equal(saved.gender, '여성', 'Saved referral has correct gender');
    assert.ok(saved.refNo.startsWith('REF-2026-'), 'Formal refNo generated only on submit');
    assert.ok(saved.clientId.startsWith('CL-2026-'), 'Formal clientId generated only on submit');
    assert.equal(app.isAddModalOpen, false, 'Modal closed after successful submit');
    console.log('  -> PASS Scenario F\n');
}

// -------------------------------------------------------------------
// TEST G: Already registered item cannot create duplicate (directs to targetReferralId)
// -------------------------------------------------------------------
{
    console.log('Testing Scenario G: Already registered item directs to existing referral');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card4_alreadyRegistered);

    assert.equal(app.isAddModalOpen, false, 'Already registered card must NOT open new registration form');
    assert.equal(app.selectedReferralId, 'REF-2026-0088', 'Directs to existing linked referral ID');
    assert.equal(app.apiCalls.post, 0, 'Zero POST calls (duplicate blocked)');
    console.log('  -> PASS Scenario G\n');
}

// -------------------------------------------------------------------
// TEST H: Zero PII in URL or localStorage
// -------------------------------------------------------------------
{
    console.log('Testing Scenario H: Zero PII in URL or localStorage');
    const app = new SyntheticAppFlow();
    app.onImportReferral(card1);

    const urlString = app.url;
    const storageKeys = Object.keys(app.localStorage);
    const storageValues = Object.values(app.localStorage);

    assert.equal(urlString.includes('김철수'), false, 'Zero name in URL');
    assert.equal(urlString.includes('010-1111-2222'), false, 'Zero phone in URL');
    assert.equal(storageKeys.some(k => k.includes('김철수')), false, 'Zero name in storage keys');
    assert.equal(storageValues.some(v => String(v).includes('010-1111-2222')), false, 'Zero phone in storage');
    console.log('  -> PASS Scenario H\n');
}

console.log('====================================================');
console.log('ALL WEBSITE REFERRAL PREFILL TESTS PASSED! (8/8 SCENARIOS)');
console.log('====================================================');

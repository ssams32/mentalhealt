import assert from 'node:assert/strict';

/**
 * Synthetic Test: Dashboard Data Separation & Source Classification Audit
 * Verifies channel isolation: website referrals, online surveys, voice calls, and unknown sources.
 * Strictly asserts that externalIdx / ext_* ALONE does NOT classify an item as website referral.
 */

// Canonical source definitions
export const WEBSITE_REFERRAL_CANONICAL_SOURCE_FIELD = 'source';
export const WEBSITE_REFERRAL_ALLOWED_VALUES = ['website', 'homepage', 'web'];
export const SURVEY_SOURCE_VALUES_EXCLUDED = ['online_survey', 'survey', 'screening', 'voice_call', 'voice'];

export function isWebsiteReferralItem(item) {
  if (!item || typeof item !== 'object') return false;

  // Fail-closed against survey indicators
  if (
    item.source === 'online_survey' ||
    item.source === 'survey' ||
    item.source === 'screening' ||
    item.sourceType === 'online_survey' ||
    Boolean(item.surveySubmissionId) ||
    Boolean(item.submissionId) ||
    Boolean(item.sourceSurveyId) ||
    Boolean(item.sourceSubmissionId) ||
    item.referralPath === '온라인설문' ||
    item.requestAgency === '온라인 자가검진' ||
    item.channel === 'online_survey'
  ) {
    return false;
  }

  // Fail-closed against voice call indicators
  if (
    item.source === 'voice_call' ||
    item.source === 'voice' ||
    item.source === 'voiceCalls' ||
    item.sourceType === 'voice_call' ||
    Boolean(item.voiceCallId) ||
    item.referralPath === '음성접수' ||
    item.referralPath === '음성통화' ||
    item.channel === 'voice'
  ) {
    return false;
  }

  // Exclude quarantine
  if (item.isSbqrQuarantined || item.quarantinedAt) return false;

  // Explicit website channel requirement (fail-closed, externalIdx alone is NOT sufficient)
  const isExplicitWebSource =
    item.source === 'website' ||
    item.source === 'homepage' ||
    item.source === 'web' ||
    item.sourceType === 'website' ||
    item.sourceType === 'homepage';

  const isExplicitWebPath =
    item.referralPath === '홈페이지' ||
    item.referralPath === '홈페이지 의뢰' ||
    item.referralPath === '홈페이지 상담신청' ||
    item.requestAgency === '홈페이지';

  const isExplicitWebFlag = item.isWebsiteReferral === true;

  return isExplicitWebSource || isExplicitWebPath || isExplicitWebFlag;
}

// Section 4: Synthetic Channel Isolation Test (Full Matrix)
function testSyntheticChannelIsolationMatrix() {
  const syntheticItems = [
    // 1. 홈페이지 의뢰 2건
    { id: 'ext_101', externalIdx: 101, source: 'website', name: '홍길동', phone: '010-1111-2222', referralPath: '홈페이지' },
    { id: 'ext_102', externalIdx: 102, source: 'homepage', name: '김철수', phone: '010-3333-4444', isWebsiteReferral: true },

    // 2. 온라인 설문 3건
    { id: 'srv_201', submissionId: 'sub-201', source: 'online_survey', name: '이영희', phone: '010-5555-6666', referralPath: '온라인설문' },
    { id: 'srv_202', surveySubmissionId: 'sub-202', source: 'online_survey', name: '박민수', phone: '010-7777-8888', requestAgency: '온라인 자가검진' },
    { id: 'srv_203', sourceSurveyId: 'sub-203', source: 'online_survey', name: '최지우', phone: '010-9999-0000' },

    // 3. 음성 접수 1건
    { id: 'voice_301', voiceCallId: 'vc-301', source: 'voice_call', name: '정우성', phone: '010-1234-5678', referralPath: '음성접수' },

    // 4. source unknown 1건
    { id: 'unk_401', name: '미상원', phone: '010-0000-1111' },

    // 5. externalIdx만 있는 source unknown 1건
    { id: 'ext_501', externalIdx: 501, name: '미상투', phone: '010-0000-2222' },

    // 6. 온라인 설문에서 정식 등록된 Referral 1건
    {
      id: 'ref_601',
      refNo: '2026-09-001',
      name: '설문등록자',
      phone: '010-9999-8888',
      source: 'online_survey',
      sourceSurveyId: 'sub-201',
      surveySubmissionId: 'sub-201',
      externalIdx: 'sub-201',
      isWebsiteReferral: true,
      referralPath: '온라인설문',
      status: '접수완료',
    },
  ];

  // A. 메인 홈페이지 의뢰 목록: 홈페이지 의뢰 2건만
  const mainWebsiteList = syntheticItems.filter(isWebsiteReferralItem);
  assert.equal(mainWebsiteList.length, 2, '메인 홈페이지 의뢰 목록에는 정확히 홈페이지 의뢰 2건만 포함되어야 함');
  assert.deepEqual(mainWebsiteList.map(i => i.id).sort(), ['ext_101', 'ext_102'].sort());

  // B. 온라인 설문 목록: 설문 3건 (SurveyManagementPage 영역)
  const onlineSurveyList = syntheticItems.filter(i =>
    i.source === 'online_survey' && !i.refNo
  );
  assert.equal(onlineSurveyList.length, 3, '온라인 설문 화면에는 미등록 설문 3건만 표시되어야 함');

  // C. 음성 접수 화면: 음성 1건
  const voiceList = syntheticItems.filter(i =>
    i.source === 'voice_call' || Boolean(i.voiceCallId) || i.referralPath === '음성접수'
  );
  assert.equal(voiceList.length, 1, '음성 접수 화면에는 음성 1건만 표시되어야 함');
  assert.equal(mainWebsiteList.some(i => i.source === 'voice_call'), false, '음성 접수는 메인 홈페이지 의뢰 목록에 없어야 함');

  // D. source unknown 1건: 메인 홈페이지 의뢰에서 제외
  const unknownInMain = mainWebsiteList.some(i => i.id === 'unk_401');
  assert.equal(unknownInMain, false, 'source unknown 건은 메인 홈페이지 의뢰에서 제외되어야 함');

  // E. externalIdx만 있는 unknown 1건: 메인 홈페이지 의뢰에서 제외 (핵심 감사)
  const extOnlyInMain = mainWebsiteList.some(i => i.id === 'ext_501');
  assert.equal(extOnlyInMain, false, 'externalIdx만 있고 source가 없는 건은 메인 홈페이지 의뢰에서 제외되어야 함 (EXTERNAL_ID_ALONE_CLASSIFIES_AS_WEBSITE: NO)');

  // F. 정식 등록 설문 Referral: 메인 홈페이지 의뢰에서 제외, 의뢰대장에서는 조회 가능
  const registeredSurveyInMain = mainWebsiteList.some(i => i.id === 'ref_601');
  assert.equal(registeredSurveyInMain, false, '정식 등록 설문 Referral은 메인 홈페이지 의뢰에서 제외되어야 함');

  const referralLedger = syntheticItems.filter(i => i.refNo);
  assert.equal(referralLedger.length, 1, '정식 의뢰대장에는 정식 등록 설문 Referral이 정상 표시되어야 함');
  assert.equal(referralLedger[0].refNo, '2026-09-001');

  console.log('[PASS] Synthetic Channel Isolation Matrix Test');
}

// Section 1: Strict Classification & Fail-Closed Audit
function testStrictClassificationAudit() {
  // Test: externalIdx alone does NOT classify as website
  const itemWithExtIdOnly = { id: 'ext_999', externalIdx: 999 };
  assert.equal(isWebsiteReferralItem(itemWithExtIdOnly), false, 'EXTERNAL_ID_ALONE_CLASSIFIES_AS_WEBSITE must be NO');

  // Test: unknown source fails closed
  const itemWithUnknownSource = { id: 'ext_888', externalIdx: 888, source: 'unknown_source' };
  assert.equal(isWebsiteReferralItem(itemWithUnknownSource), false, 'UNKNOWN_SOURCE_FAILS_CLOSED must be YES');

  // Test: null, undefined, primitives fail closed
  assert.equal(isWebsiteReferralItem(null), false);
  assert.equal(isWebsiteReferralItem(undefined), false);
  assert.equal(isWebsiteReferralItem(''), false);
  assert.equal(isWebsiteReferralItem({}), false);

  console.log('[PASS] Strict Classification & Fail-Closed Audit Test');
}

function runAll() {
  console.log('Running verify-dashboard-data-separation...');
  testSyntheticChannelIsolationMatrix();
  testStrictClassificationAudit();
  console.log('ALL DASHBOARD DATA SEPARATION TESTS PASSED!');
}

runAll();

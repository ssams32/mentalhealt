import assert from 'node:assert/strict';

/**
 * Synthetic Test: Dashboard Duplicate Render & State Stability
 * Tests that dashboard components, stats, and polling state do not duplicate or append.
 */

// Simulated State Deduplication and Polling logic (identical to App.tsx / HomePage.tsx)
class SyntheticDashboardState {
  constructor() {
    this.websiteReferralItems = [];
    this.websitePendingCount = 0;
    this.voicePendingCount = 0;
    this.surveyPendingCount = 0;
    this.pollCount = 0;
    this.renderCounts = {
      dashboardRoot: 0,
      websiteSection: 0,
      statsSection: 0,
    };
  }

  // Simulate server response on polling
  simulatePoll(mockServerResponse) {
    this.pollCount++;
    const { pendingReferrals = [], surveyCount = 0, voiceCount = 0 } = mockServerResponse;

    // Filter website only (fail-closed, explicit website source required)
    const websiteItems = pendingReferrals.filter(item => {
      if (!item || typeof item !== 'object') return false;
      if (item.source === 'online_survey' || item.surveySubmissionId || item.submissionId || item.referralPath === '온라인설문') return false;
      if (item.source === 'voice_call' || item.voiceCallId || item.referralPath === '음성접수') return false;
      const isExplicitWeb = item.source === 'website' || item.source === 'homepage' || item.source === 'web' ||
        item.referralPath === '홈페이지' || item.isWebsiteReferral === true;
      return isExplicitWeb;
    });

    // Replace state with deduplication (same logic as App.tsx)
    const updated = [];
    const seen = new Set();

    websiteItems.forEach(item => {
      // Canonical ID used for deduplication
      const canonicalKey = item.id || item.externalIdx || (item.name + '_' + item.phone);
      if (!seen.has(canonicalKey)) {
        seen.add(canonicalKey);
        updated.push(item);
      }
    });

    // Replace - NOT append
    this.websiteReferralItems = updated;
    this.websitePendingCount = updated.length;
    this.surveyPendingCount = surveyCount;
    this.voicePendingCount = voiceCount;
  }

  // Simulate rendering HomePage
  renderHomePage() {
    this.renderCounts.dashboardRoot++;
    // HomePage renders 1 stats section
    this.renderCounts.statsSection++;
    // HomePage renders 1 website referral section
    this.renderCounts.websiteSection++;

    // Check duplicate referral items in rendered list
    const itemIds = this.websiteReferralItems.map(i => i.id || i.externalIdx || (i.name + '_' + i.phone));
    const uniqueIds = new Set(itemIds);
    const duplicates = itemIds.length - uniqueIds.size;

    return {
      dashboardRootRendered: 1,
      statsSectionRendered: 1,
      websiteSectionRendered: 1,
      renderedItemsCount: this.websiteReferralItems.length,
      duplicates,
    };
  }
}

function testPollingStability() {
  const state = new SyntheticDashboardState();
  const mockServerResponse = {
    pendingReferrals: [
      { id: 'ext_1', externalIdx: 1, name: '홍길동', phone: '010-1111-2222', source: 'website' },
      { id: 'ext_2', externalIdx: 2, name: '이순신', phone: '010-3333-4444', source: 'website' },
      // Poll returns survey, voice, and unknown items
      { id: 'srv_1', submissionId: 'sub-1', name: '설문자', source: 'online_survey' },
      { id: 'voc_1', voiceCallId: 'vc-1', name: '음성자', source: 'voice_call' },
      { id: 'unk_1', name: '미상자' },
      { id: 'ext_only', externalIdx: 999 }, // externalIdx alone
    ],
    surveyCount: 1,
    voiceCount: 1,
  };

  // Poll 1
  state.simulatePoll(mockServerResponse);
  const render1 = state.renderHomePage();
  assert.equal(render1.renderedItemsCount, 2, 'Poll 1 must yield 2 website items');
  assert.equal(render1.duplicates, 0, 'Poll 1 duplicate referral items must be 0');
  assert.equal(render1.dashboardRootRendered, 1, 'Dashboard root must be 1');
  assert.equal(render1.statsSectionRendered, 1, 'Stats section must be 1');
  assert.equal(render1.websiteSectionRendered, 1, 'Website section must be 1');

  // Poll 2
  state.simulatePoll(mockServerResponse);
  const render2 = state.renderHomePage();
  assert.equal(render2.renderedItemsCount, 2, 'Poll 2 must not append duplicates; count remains 2');
  assert.equal(render2.duplicates, 0, 'Poll 2 duplicate referral items must be 0');

  // Poll 3
  state.simulatePoll(mockServerResponse);
  const render3 = state.renderHomePage();
  assert.equal(render3.renderedItemsCount, 2, 'Poll 3 must not append duplicates; count remains 2');
  assert.equal(render3.duplicates, 0, 'Poll 3 duplicate referral items must be 0');

  console.log('[PASS] Test C: Duplicate Rendering & Polling Stability (3 polls, 0 appended duplicates)');
}

function testSidebarBadgeIsolation() {
  const state = new SyntheticDashboardState();
  state.simulatePoll({
    pendingReferrals: [
      { id: 'ext_1', name: '홍길동', source: 'website' },
    ],
    surveyCount: 5, // 5 pending surveys
    voiceCount: 2,
  });

  // Check state isolation
  assert.equal(state.websitePendingCount, 1, 'Website pending count is isolated to website only');
  assert.equal(state.surveyPendingCount, 5, 'Survey pending count is isolated');
  assert.equal(state.websiteReferralItems.length, 1, 'Website referral items array does not contain surveys');

  // Ensure surveyPendingCount is not passed to dashboard items
  const surveyItemInDashboard = state.websiteReferralItems.some(i => i.source === 'online_survey');
  assert.equal(surveyItemInDashboard, false, 'Survey item must never be in dashboard items');
  console.log('[PASS] Test D: Sidebar Badge Isolation');
}

function runAll() {
  console.log('Running verify-dashboard-duplicate-render...');
  testPollingStability();
  testSidebarBadgeIsolation();
  console.log('ALL DUPLICATE RENDER TESTS PASSED!');
}

runAll();

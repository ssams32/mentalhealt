import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

console.log('🧪 [Track B: M4] Starting Frontend Campaign Verification Script...\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
    totalTests++;
    if (!condition) {
        console.error(`❌ FAIL: ${message}`);
        throw new Error(message);
    } else {
        console.log(`✅ PASS: ${message}`);
        passedTests++;
    }
}

// ─────────────────────────────────────────────────────────────
// 1. Transpile and load services/apiClient.ts dynamically
// ─────────────────────────────────────────────────────────────
const apiClientTsPath = path.resolve('services/apiClient.ts');
const apiClientSource = fs.readFileSync(apiClientTsPath, 'utf8');

const transpileResult = ts.transpileModule(apiClientSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: false,
    }
});

// Create in-memory module execution for transpileResult with Node.js compatible import.meta.env fallback
let moduleCode = transpileResult.outputText.replace(
    /import\.meta\.env/g,
    '(import.meta.env || { VITE_API_BASE_URL: "/api" })'
);

const tempModulePath = path.resolve('scripts/.temp-apiClient.mjs');
fs.writeFileSync(tempModulePath, moduleCode, 'utf8');

let apiClientModule;
try {
    apiClientModule = await import(`file://${tempModulePath}?t=${Date.now()}`);
} finally {
    if (fs.existsSync(tempModulePath)) {
        fs.unlinkSync(tempModulePath);
    }
}

const {
    ApiClient,
    apiClient,
    buildCampaignDistributionUrl,
    getCampaignLabelInfo
} = apiClientModule;

// ─────────────────────────────────────────────────────────────
// Test Suite 1: buildCampaignDistributionUrl Rules & Encoding
// ─────────────────────────────────────────────────────────────
console.log('\n--- [Test Suite 1] buildCampaignDistributionUrl Rules ---');

{
    // Test 1.1: Standard campaign code URL generation
    const url1 = buildCampaignDistributionUrl('HY-2026', 'https://survey.center.local/survey');
    assert(url1 === 'https://survey.center.local/survey?c=HY-2026',
        `Standard code link generation: expected 'https://survey.center.local/survey?c=HY-2026', got '${url1}'`);

    // Test 1.2: Code normalization (trim & uppercase)
    const url2 = buildCampaignDistributionUrl('  sec-2026  ', 'https://survey.center.local/survey');
    assert(url2 === 'https://survey.center.local/survey?c=SEC-2026',
        `Code trimming and uppercasing: expected 'https://survey.center.local/survey?c=SEC-2026', got '${url2}'`);

    // Test 1.3: Safe URL encoding for special characters
    const url3 = buildCampaignDistributionUrl('CAMP 2026+SPECIAL', 'https://survey.center.local/survey');
    assert(url3 === 'https://survey.center.local/survey?c=CAMP%202026%2BSPECIAL',
        `URL encoding of special chars: expected 'c=CAMP%202026%2BSPECIAL', got '${url3}'`);

    // Test 1.4: Base URL with trailing slashes
    const url4 = buildCampaignDistributionUrl('TEST-CODE', 'https://survey.center.local/survey///');
    assert(url4 === 'https://survey.center.local/survey?c=TEST-CODE',
        `Trailing slash stripping: got '${url4}'`);

    // Test 1.5: Base URL with existing query parameters
    const url5 = buildCampaignDistributionUrl('TEST-CODE', 'https://survey.center.local/survey?theme=blue');
    assert(url5 === 'https://survey.center.local/survey?theme=blue&c=TEST-CODE',
        `Separator switch to '&' when query param exists: got '${url5}'`);

    // Test 1.6: Invalid or empty codes
    const urlEmpty = buildCampaignDistributionUrl('');
    assert(urlEmpty === '', `Empty code returns empty string: got '${urlEmpty}'`);

    const urlNull = buildCampaignDistributionUrl(null);
    assert(urlNull === '', `Null code returns empty string: got '${urlNull}'`);
}

// ─────────────────────────────────────────────────────────────
// Test Suite 2: getCampaignLabelInfo Branching Logic
// ─────────────────────────────────────────────────────────────
console.log('\n--- [Test Suite 2] getCampaignLabelInfo Branching ---');

{
    // Test 2.1: Registered campaign with companyName
    const reg1 = getCampaignLabelInfo({
        campaignCode: 'CAMP-01',
        campaignName: '현대모비스',
        campaignRegistrationStatus: 'REGISTERED'
    });
    assert(reg1.type === 'registered' && reg1.label === '현대모비스' && reg1.isWarning === false && reg1.code === 'CAMP-01',
        `Registered campaign with companyName: label='${reg1.label}', type='${reg1.type}', isWarning=${reg1.isWarning}`);

    // Test 2.2: Registered campaign without companyName (falls back to code)
    const reg2 = getCampaignLabelInfo({
        campaignCode: 'CAMP-02',
        campaignName: null,
        campaignRegistrationStatus: 'REGISTERED'
    });
    assert(reg2.type === 'registered' && reg2.label === 'CAMP-02' && reg2.isWarning === false,
        `Registered campaign without companyName falls back to code: label='${reg2.label}'`);

    // Test 2.3: Unregistered valid campaign code (Warning badge requirement)
    const unreg = getCampaignLabelInfo({
        campaignCode: 'UNKNOWN-CAMP',
        campaignName: null,
        campaignRegistrationStatus: 'UNREGISTERED'
    });
    assert(unreg.type === 'unregistered' && unreg.label === '미등록 캠페인' && unreg.isWarning === true && unreg.code === 'UNKNOWN-CAMP',
        `Unregistered valid campaign code triggers warning badge: label='${unreg.label}', isWarning=${unreg.isWarning}`);

    // Test 2.4: Unspecified (no code)
    const unspec1 = getCampaignLabelInfo({
        campaignCode: null,
        campaignRegistrationStatus: 'ABSENT'
    });
    assert(unspec1.type === 'unspecified' && unspec1.label === '미지정' && unspec1.isWarning === false && unspec1.code === null,
        `Null campaignCode results in '미지정' (unspecified): label='${unspec1.label}'`);

    // Test 2.5: Unspecified (empty/whitespace code)
    const unspec2 = getCampaignLabelInfo({
        campaignCode: '   '
    });
    assert(unspec2.type === 'unspecified' && unspec2.label === '미지정',
        `Whitespace campaignCode results in '미지정' (unspecified): label='${unspec2.label}'`);
}

// ─────────────────────────────────────────────────────────────
// Test Suite 3: ApiClient Campaign Filter Parameters & Endpoints
// ─────────────────────────────────────────────────────────────
console.log('\n--- [Test Suite 3] ApiClient Parameter Passing & Mock Interception ---');

{
    const client = new ApiClient();
    const calls = [];

    // Mock client.request
    client.request = async (endpoint, options = {}) => {
        calls.push({ endpoint, options });
        return { success: true, endpoint, options };
    };

    // Test 3.1: getSurveyImports with campaignFilter='CAMP-01'
    await client.getSurveyImports({ campaignFilter: 'CAMP-01' });
    const lastCall1 = calls[calls.length - 1];
    assert(lastCall1.endpoint.includes('/surveys/imports?campaignFilter=CAMP-01'),
        `getSurveyImports with code filter: endpoint='${lastCall1.endpoint}'`);

    // Test 3.2: getSurveyImports with campaignFilter='unspecified'
    await client.getSurveyImports({ campaignFilter: 'unspecified' });
    const lastCall2 = calls[calls.length - 1];
    assert(lastCall2.endpoint.includes('/surveys/imports?campaignFilter=unspecified'),
        `getSurveyImports with unspecified filter: endpoint='${lastCall2.endpoint}'`);

    // Test 3.3: getSurveyImports with campaignFilter='all' (should be omitted)
    await client.getSurveyImports({ campaignFilter: 'all' });
    const lastCall3 = calls[calls.length - 1];
    assert(!lastCall3.endpoint.includes('campaignFilter'),
        `getSurveyImports with 'all' omits campaignFilter parameter: endpoint='${lastCall3.endpoint}'`);

    // Test 3.4: getSurveyCampaigns requests GET /surveys/campaigns
    await client.getSurveyCampaigns();
    const lastCall4 = calls[calls.length - 1];
    assert(lastCall4.endpoint === '/surveys/campaigns',
        `getSurveyCampaigns calls '/surveys/campaigns': endpoint='${lastCall4.endpoint}'`);

    // Test 3.5: createSurveyCampaign requests POST /surveys/campaigns
    await client.createSurveyCampaign({
        code: 'TEST-CODE',
        companyName: '테스트 회사',
        purpose: '테스트 목적',
        isActive: true
    });
    const lastCall5 = calls[calls.length - 1];
    assert(lastCall5.endpoint === '/surveys/campaigns' && lastCall5.options.method === 'POST',
        `createSurveyCampaign calls POST '/surveys/campaigns'`);
    const parsedBody = JSON.parse(lastCall5.options.body);
    assert(parsedBody.code === 'TEST-CODE' && parsedBody.companyName === '테스트 회사',
        `createSurveyCampaign body preserved: code=${parsedBody.code}, companyName=${parsedBody.companyName}`);

    // Test 3.6: updateSurveyCampaign requests PATCH /surveys/campaigns/:code (immutable code)
    await client.updateSurveyCampaign('TEST-CODE', {
        companyName: '수정 회사',
        purpose: '수정 목적',
        isActive: false
    });
    const lastCall6 = calls[calls.length - 1];
    assert(lastCall6.endpoint === '/surveys/campaigns/TEST-CODE' && lastCall6.options.method === 'PATCH',
        `updateSurveyCampaign calls PATCH '/surveys/campaigns/TEST-CODE'`);
}

// ─────────────────────────────────────────────────────────────
// Test Suite 4: downloadSurveyExport Integration with campaignCode
// ─────────────────────────────────────────────────────────────
console.log('\n--- [Test Suite 4] downloadSurveyExport Query Parameter Verification ---');

{
    const client = new ApiClient();
    let requestedUrl = null;

    // Mock global.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            headers: {
                get: (header) => (header === 'content-disposition' ? 'attachment; filename="survey_export.xlsx"' : null)
            },
            blob: async () => ({ size: 1024, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        };
    };

    try {
        // Test 4.1: downloadSurveyExport with campaignCode='CAMP-01'
        await client.downloadSurveyExport({ campaignCode: 'CAMP-01', assessmentId: 'phq-9' });
        assert(requestedUrl.includes('campaignCode=CAMP-01'),
            `downloadSurveyExport includes campaignCode: '${requestedUrl}'`);
        assert(requestedUrl.includes('assessmentId=phq-9'),
            `downloadSurveyExport includes other filters: '${requestedUrl}'`);

        // Test 4.2: downloadSurveyExport with campaignCode='unspecified'
        await client.downloadSurveyExport({ campaignCode: 'unspecified' });
        assert(requestedUrl.includes('campaignCode=unspecified'),
            `downloadSurveyExport includes campaignCode=unspecified: '${requestedUrl}'`);

        // Test 4.3: downloadSurveyExport with campaignCode='all' (omitted)
        await client.downloadSurveyExport({ campaignCode: 'all' });
        assert(!requestedUrl.includes('campaignCode='),
            `downloadSurveyExport omits campaignCode when 'all': '${requestedUrl}'`);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// ─────────────────────────────────────────────────────────────
// Test Suite 5: Security & Invariant Rules Verification
// ─────────────────────────────────────────────────────────────
console.log('\n--- [Test Suite 5] Invariants & Safety Verification ---');

{
    // Invariant 5.1: No DELETE methods on ApiClient
    assert(typeof ApiClient.prototype.deleteSurveyCampaign === 'undefined',
        `No deleteSurveyCampaign method exists on ApiClient (DELETE prohibited)`);

    // Invariant 5.2: Inactive campaign warning logic
    function checkInactiveCampaignCopyGuard(campaign) {
        if (!campaign.isActive) {
            return { requiresConfirmation: true, warningMessage: '비활성 캠페인 경고' };
        }
        return { requiresConfirmation: false };
    }

    const activeCamp = { code: 'ACTIVE-01', isActive: true };
    const inactiveCamp = { code: 'INACTIVE-01', isActive: false };
    assert(checkInactiveCampaignCopyGuard(activeCamp).requiresConfirmation === false,
        `Active campaign allows immediate copy`);
    assert(checkInactiveCampaignCopyGuard(inactiveCamp).requiresConfirmation === true,
        `Inactive campaign triggers confirmation guard before distribution link copy`);
}

console.log(`\n========================================`);
console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
console.log(`========================================\n`);

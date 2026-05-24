
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8889/api';
const TEST_YEAR = '2026';

async function runRegressionTests() {
    console.log('🧪 [REGRESSION TEST] Starting Final Stabilization Check...');

    try {
        // 1. Health Check
        const healthRes = await fetch(`${BASE_URL}/health`);
        const health = await healthRes.json();
        console.log(`✅ Health Check: ${health.status}, Version: ${health.optimizationVersion}`);

        // 2. detailLevel Filtering & Payload Test
        console.log('\n--- Test 1: detailLevel & Payload ---');
        
        // Summary
        const sRes = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const sData = await sRes.json();
        const firstMember = Object.values(sData.data)[0];
        const firstMonth = firstMember.monthly[0];
        
        const hasBreakdown = 'actualCountBreakdown' in firstMonth;
        const hasMerged = 'mergedSegments' in firstMonth;
        console.log(`🔍 Summary Check: Breakdown? ${hasBreakdown} (Expect false), Merged? ${hasMerged} (Expect false)`);
        
        // Full
        const fRes = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=full`);
        const fData = await fRes.json();
        const fullMonth = Object.values(fData.data)[0].monthly[0];
        const fullHasBreakdown = 'actualCountBreakdown' in fullMonth;
        const fullHasMerged = 'mergedSegments' in fullMonth;
        console.log(`🔍 Full Check: Breakdown? ${fullHasBreakdown} (Expect true), Merged? ${fullHasMerged} (Expect true)`);

        if (hasBreakdown || hasMerged || !fullHasBreakdown || !fullHasMerged) {
            throw new Error('Field filtering validation failed');
        }

        // 3. Cache Logic
        console.log('\n--- Test 2: Cache Hit/Miss ---');
        const c1Res = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const c1Data = await c1Res.json();
        console.log(`🎯 Cache Request 1: hit=${c1Data.diagnostics.cache.hit}`);
        
        const c2Res = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const c2Data = await c2Res.json();
        console.log(`🎯 Cache Request 2: hit=${c2Data.diagnostics.cache.hit}`);
        
        if (!c2Data.diagnostics.cache.hit) {
            throw new Error('Cache hit expected but missed');
        }

        // 4. Accuracy Verification (Logic Regression)
        console.log('\n--- Test 3: Business Logic Accuracy ---');
        
        // Find a specific member if possible, otherwise use the first one
        const member = Object.values(fData.data).find(m => m.memberName === '김준삼') || Object.values(fData.data)[0];
        console.log(`👤 Testing Logic for: ${member.memberName}`);

        // Test C & D: Target Count Logic (Merged segments)
        // Check for a month where we expect target 1 for 유지관리
        const feb = member.monthly[1]; // Feb
        console.log(`📅 Feb (${feb.managementTypeSummary}): Target=${feb.targetCount}, Actual=${feb.actualCount}`);
        
        if (feb.managementTypeSummary.includes('유지') && feb.targetCount > 1 && !feb.managementTypeSummary.includes('집중')) {
            console.warn('⚠️ Warning: 유지관리 target > 1 found. Check if multiple segments exist.');
        }

        // Test F & G: Evaluation Labels
        const may = member.monthly[4]; // May (Current or near current)
        const dec = member.monthly[11]; // Dec (Future)
        console.log(`📅 May Evaluation: ${may.evaluationLabel} (${may.evaluationResult})`);
        console.log(`📅 Dec Evaluation: ${dec.evaluationLabel} (${dec.evaluationResult})`);

        if (!dec.isFutureMonth || dec.evaluationLabel !== '평가전') {
            console.error('❌ Future month should be 평가전');
        }

        // 5. Cache Invalidation Test
        console.log('\n--- Test 4: Cache Invalidation (POST /api/analysis/current) ---');
        // Get current data first to avoid corruption
        const currentDataRes = await fetch(`${BASE_URL}/analysis/current`);
        const currentData = await currentDataRes.json();
        
        // Save same data back to trigger clearCache
        await fetch(`${BASE_URL}/analysis/current`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentData)
        });
        console.log('♻️ Cache cleared via POST /api/analysis/current');

        const postClearRes = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const postClearData = await postClearRes.json();
        console.log(`🎯 Post-clear Cache: hit=${postClearData.diagnostics.cache.hit} (Expect false)`);

        if (postClearData.diagnostics.cache.hit) {
            throw new Error('Cache should be invalid after POST');
        }

        console.log('\n✅ ALL REGRESSION TESTS PASSED!');

    } catch (error) {
        console.error('\n💥 REGRESSION TEST FAILED:', error.message);
        process.exit(1);
    }
}

runRegressionTests();

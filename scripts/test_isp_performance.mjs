
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8889/api';
const TEST_YEAR = '2026';

async function runTests() {
    console.log('🚀 [ISP PERF TEST] Starting Verification...');

    try {
        // 0. Health Check
        const healthRes = await fetch(`${BASE_URL}/health`);
        const health = await healthRes.json();
        console.log(`✅ Health Check: ${health.status}, Version: ${health.optimizationVersion}, StartedAt: ${health.startedAt}`);

        if (health.optimizationVersion !== 'isp-achievement-cache-v1') {
            console.warn('⚠️ Warning: Server optimization version mismatch or server not restarted.');
        }

        // 1. Summary First Request (Cold)
        console.log(`\n--- Test 1: Summary (Cold Start) ---`);
        const s1Start = Date.now();
        const s1Res = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const s1Data = await s1Res.json();
        const s1End = Date.now();
        
        console.log(`⏱️ Total Time: ${s1End - s1Start}ms`);
        console.log(`📊 Backend Compute: ${s1Data.diagnostics.cache.computeMs}ms`);
        console.log(`📦 Approx Size: ${s1Data.diagnostics.payload.approxBytes} bytes`);
        
        // Assertions for summary
        const firstMemberKey = Object.keys(s1Data.data)[0];
        const firstMonth = s1Data.data[firstMemberKey].monthly[0];
        const hasBreakdown = 'actualCountBreakdown' in firstMonth;
        const hasMerged = 'mergedSegments' in firstMonth;
        
        console.log(`🔍 Field Check (Summary): Breakdown? ${hasBreakdown}, Merged? ${hasMerged}`);
        if (hasBreakdown || hasMerged) {
            console.error('❌ FAILED: Summary response contains detailed fields!');
            process.exit(1);
        }

        // 2. Summary Second Request (Cache Hit)
        console.log(`\n--- Test 2: Summary (Cache Hit) ---`);
        const s2Start = Date.now();
        const s2Res = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=summary`);
        const s2Data = await s2Res.json();
        const s2End = Date.now();
        
        console.log(`⏱️ Total Time: ${s2End - s2Start}ms`);
        console.log(`🎯 Cache Hit: ${s2Data.diagnostics.cache.hit}`);
        
        if (!s2Data.diagnostics.cache.hit) {
            console.error('❌ FAILED: Cache hit expected but got miss!');
            process.exit(1);
        }

        // 3. Full Request
        console.log(`\n--- Test 3: Full (Cold/Different Key) ---`);
        const f1Start = Date.now();
        const f1Res = await fetch(`${BASE_URL}/analysis/isp-achievement-yearly?year=${TEST_YEAR}&detailLevel=full`);
        const f1Data = await f1Res.json();
        const f1End = Date.now();
        
        console.log(`⏱️ Total Time: ${f1End - f1Start}ms`);
        console.log(`📦 Approx Size: ${f1Data.diagnostics.payload.approxBytes} bytes`);
        
        const fullMonth = f1Data.data[firstMemberKey].monthly[0];
        const fullHasBreakdown = 'actualCountBreakdown' in fullMonth;
        const fullHasMerged = 'mergedSegments' in fullMonth;
        
        console.log(`🔍 Field Check (Full): Breakdown? ${fullHasBreakdown}, Merged? ${fullHasMerged}`);
        if (!fullHasBreakdown || !fullHasMerged) {
            console.error('❌ FAILED: Full response missing detailed fields!');
            process.exit(1);
        }

        // 4. Comparison
        const reduction = ((1 - s1Data.diagnostics.payload.approxBytes / f1Data.diagnostics.payload.approxBytes) * 100).toFixed(1);
        console.log(`\n📉 Payload Reduction (Summary vs Full): ${reduction}%`);

        console.log(`\n✅ All Performance & Structure Tests Passed!`);

    } catch (error) {
        console.error('💥 Test Execution Error:', error.message);
        process.exit(1);
    }
}

runTests();

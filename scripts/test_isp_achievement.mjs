// Built-in fetch used (Node 18+)

const BASE_URL = 'http://localhost:8889/api';
const TEST_MONTH = '2024-05';

async function runTests() {
    console.log('🚀 Starting TDD Verification for ISP Achievement...');

    try {
        const response = await fetch(`${BASE_URL}/analysis/isp-achievement?month=${TEST_MONTH}`);
        const result = await response.json();

        if (!result.success) {
            throw new Error(`API call failed: ${result.error}`);
        }

        const data = result.data;
        console.log(`📊 Received ${data.length} records for ${TEST_MONTH}`);

        // Test Cases (Based on May 2024 - 31 days)
        // C001 (집중관리): CEIL(31 / 7) = 5 sessions target
        // C002 (집중관리): CEIL(31 / 7) = 5 sessions target
        // C003 (일시관리): CEIL(31 / 90) = 1 session target

        const tests = [
            {
                name: 'Hong Gil-dong (집중관리, 4 FaceToFace) -> FAIL (Target 5)',
                check: () => {
                    const m = data.find(m => m.memberName === '홍길동');
                    return m?.targetSessions === 5 && m?.status === 'fail';
                }
            },
            {
                name: 'Kim Cheol-su (집중관리, 3 FaceToFace) -> FAIL (Target 5)',
                check: () => data.find(m => m.memberName === '김철수')?.statusText === '개입 부족 (미달)'
            },
            {
                name: 'Lee Young-hee (일시관리, 4 FaceToFace) -> WARNING (Target 1, Over 2)',
                check: () => data.find(m => m.memberName === '이영희')?.statusText === '과잉 개입 (ISP 점검 요망)'
            }
        ];

        let passed = 0;
        tests.forEach(test => {
            if (test.check()) {
                console.log(`✅ PASSED: ${test.name}`);
                passed++;
            } else {
                console.error(`❌ FAILED: ${test.name}`);
            }
        });

        console.log(`\n🏆 Result: ${passed}/${tests.length} tests passed.`);
        
        if (passed === tests.length) {
            console.log('✨ All logic verified successfully!');
        } else {
            process.exit(1);
        }

    } catch (error) {
        console.error('💥 Test Execution Error:', error.message);
        console.log('💡 Note: Make sure the backend server is running on port 8889.');
        process.exit(1);
    }
}

runTests();

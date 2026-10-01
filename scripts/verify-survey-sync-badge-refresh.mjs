/**
 * scripts/verify-survey-sync-badge-refresh.mjs
 * Focused verification for the P0 frontend hotfix:
 * "ReferenceError: refreshSidebarBadge is not defined" after manual survey sync.
 *
 * Two layers, following this repository's verification conventions:
 *  A. Static/structural checks against the REAL sources
 *     (components/survey/SurveyManagementPage.tsx, App.tsx) proving that
 *     - the identifier is declared as an optional prop and destructured,
 *     - App wires the canonical /api/surveys/status badge fetch into it,
 *     - post-success refresh runs AFTER the import try/catch, isolated per step,
 *     - the empty-queue message and the error-heading state exist.
 *  B. A behavioral simulation of the corrected handleImportClick control flow
 *     (same branch order as the source verified in layer A) driven by mocked
 *     API responses only. No real network, no Track A, no production data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pagePath = path.join(ROOT, 'components/survey/SurveyManagementPage.tsx');
const appPath = path.join(ROOT, 'App.tsx');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function testCase(name, fn) {
    totalTests++;
    process.stdout.write(`  ⏳ ${name}... `);
    try {
        await fn();
        passedTests++;
        console.log('✅ PASS');
    } catch (err) {
        failedTests++;
        console.log(`❌ FAIL\n    -> ${err.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const pageSrc = fs.readFileSync(pagePath, 'utf-8');
const appSrc = fs.readFileSync(appPath, 'utf-8');

// Extract the real handleImportClick body for structural checks.
const handlerStart = pageSrc.indexOf('const handleImportClick');
assert(handlerStart >= 0, 'handleImportClick not found');
const handlerEnd = pageSrc.indexOf('// --- Action: External Delete Retry ---', handlerStart);
assert(handlerEnd > handlerStart, 'handleImportClick end marker not found');
const handler = pageSrc.slice(handlerStart, handlerEnd);

// ---------------------------------------------------------------------------
// Layer A: static / structural checks on the real sources
// ---------------------------------------------------------------------------
console.log('--- Layer A: source structure ---');

await testCase('A1: refreshSidebarBadge declared as optional prop', () => {
    assert(
        /refreshSidebarBadge\?:\s*\(\)\s*=>\s*void\s*\|\s*Promise<void>/.test(pageSrc),
        'optional prop declaration missing in SurveyManagementPageProps'
    );
});

await testCase('A2: refreshSidebarBadge destructured from props', () => {
    const sigStart = pageSrc.indexOf('export const SurveyManagementPage');
    const sig = pageSrc.slice(sigStart, pageSrc.indexOf(') => {', sigStart));
    assert(sig.includes('refreshSidebarBadge'), 'prop not destructured in component signature');
});

await testCase('A3: no unguarded truthiness call on the identifier remains', () => {
    assert(
        !pageSrc.includes('if (refreshSidebarBadge) refreshSidebarBadge();'),
        'old broken call pattern still present'
    );
    assert(
        handler.includes("typeof refreshSidebarBadge === 'function'"),
        'typeof guard missing in handler'
    );
});

await testCase('A4: App owns the canonical badge fetch and wires it as the prop', () => {
    assert(appSrc.includes('const fetchSurveyStats = useCallback'), 'fetchSurveyStats is not a stable callback in App');
    assert(appSrc.includes("fetch('/api/surveys/status'"), 'canonical /api/surveys/status fetch missing in App');
    assert(appSrc.includes('refreshSidebarBadge={fetchSurveyStats}'), 'App does not pass the canonical fetch to SurveyManagementPage');
    assert(appSrc.includes('setSurveyPendingCount(data.badgeCount)'), 'badge count state update missing');
});

await testCase('A5: App 30s badge polling preserved through the same function', () => {
    assert(appSrc.includes('setInterval(fetchSurveyStats, 30000)'), '30s polling no longer uses fetchSurveyStats');
});

await testCase('A6: handler calls the import API exactly once', () => {
    const occurrences = pageSrc.split('apiClient.importOnlineSurveys(').length - 1;
    assert(occurrences === 1, `expected exactly 1 importOnlineSurveys call site, found ${occurrences}`);
});

await testCase('A7: refresh steps run after the import try/catch, guarded by success flag', () => {
    const idxImport = handler.indexOf('apiClient.importOnlineSurveys(');
    const idxCompleted = handler.indexOf('importCompleted = true');
    const idxGuard = handler.indexOf('if (!importCompleted) return;');
    const idxLoad = handler.indexOf('await loadData(selectedSubmissionId)', idxGuard);
    const idxBadge = handler.indexOf('await refreshSidebarBadge()', idxGuard);
    assert(idxImport >= 0 && idxCompleted > idxImport, 'success flag not set after import');
    assert(idxGuard > idxCompleted, 'post-success guard missing after try/catch');
    assert(idxLoad > idxGuard, 'loadData refresh not in the isolated post-success block');
    assert(idxBadge > idxLoad, 'badge refresh must run after list refresh');
    const insideTry = handler.slice(idxImport, idxGuard);
    assert(!insideTry.includes('await loadData('), 'loadData still inside the import try block');
    assert(!insideTry.includes('refreshSidebarBadge()'), 'badge refresh still inside the import try block');
});

await testCase('A8: badge refresh isolated in its own try/catch with non-blocking warning', () => {
    const badgeBlock = handler.slice(handler.indexOf("typeof refreshSidebarBadge === 'function'"));
    assert(badgeBlock.includes('try {') && badgeBlock.includes('catch (badgeErr)'), 'badge refresh not isolated in try/catch');
    assert(badgeBlock.includes('console.warn'), 'badge failure must degrade to a non-blocking warning');
});

await testCase('A9: empty-queue completion message present', () => {
    assert(handler.includes('현재 대기 중인 신규 설문이 없습니다.'), 'empty-queue message missing');
    assert(handler.includes('tot === 0'), 'empty-queue branch condition missing');
});

await testCase('A10: failure state cannot render a false completion heading', () => {
    assert(handler.includes('isError: true'), 'catch does not mark the error state');
    assert(pageSrc.includes("syncProgress.isError ? '설문 동기화 오류' : '설문 동기화 완료'"), 'modal title is not error-aware');
});

await testCase('A11: loading released in finally; no global hack introduced', () => {
    assert(handler.includes('finally {') && handler.includes('setImporting(false);'), 'setImporting(false) not in finally');
    assert(!pageSrc.includes('window.refreshSidebarBadge'), 'window global hack must not exist');
    assert(!handler.includes('location.reload'), 'full page reload must not be used');
});

// ---------------------------------------------------------------------------
// Layer B: behavioral simulation of the corrected handler contract.
// Mirrors the branch order verified in Layer A. Mocks only.
// ---------------------------------------------------------------------------
console.log('--- Layer B: behavioral simulation (mock API only) ---');

function makeHarness({ importImpl, badgeImpl, withBadge = true }) {
    const calls = { import: 0, loadData: 0, badge: 0, toasts: [] };
    const warnings = [];
    let syncProgress = { isOpen: false, isSyncing: false, isError: false, imported: 0, failed: 0, reused: 0, total: 0, message: '', stopReason: undefined };
    let importing = false;
    let setStateAfterCompletion = 0;
    let completed = false;

    const setSyncProgress = (updater) => {
        if (completed) setStateAfterCompletion++;
        syncProgress = typeof updater === 'function' ? updater(syncProgress) : updater;
    };
    const showToast = (msg, type) => calls.toasts.push({ msg, type });
    const loadData = async () => { calls.loadData++; };
    const refreshSidebarBadge = withBadge
        ? async () => { calls.badge++; if (badgeImpl) await badgeImpl(); }
        : undefined;

    // Control flow identical to the corrected handleImportClick in source.
    async function handleImportClick() {
        if (importing || syncProgress.isSyncing) return;
        let importCompleted = false;
        try {
            importing = true;
            setSyncProgress({ isOpen: true, isSyncing: true, isError: false, imported: 0, failed: 0, reused: 0, total: 0, message: '온라인 설문을 안전하게 동기화하고 있습니다...' });
            calls.import++;
            const res = await importImpl();
            if (res.success && res.summary) {
                const s = res.summary;
                const imp = s.imported ?? 0;
                const fld = s.failed ?? s.quarantined ?? 0;
                const rsd = s.reused ?? s.duplicates ?? 0;
                const tot = s.discovered ?? s.totalFetched ?? (imp + fld + rsd);
                setSyncProgress({
                    isOpen: true, isSyncing: false, isError: false,
                    imported: imp, failed: fld, reused: rsd, total: tot,
                    stopReason: s.stopReason || '동기화 완료',
                    message: tot === 0
                        ? '현재 대기 중인 신규 설문이 없습니다.'
                        : `동기화 완료: 신규 수신 ${imp}건, 재사용/중복 ${rsd}건, 오류/격리 ${fld}건 (총 ${tot}건 처리)`
                });
                showToast(`설문 동기화 완료: 신규 ${imp}건, 재사용 ${rsd}건, 오류/격리 ${fld}건`, 'success');
                importCompleted = true;
            } else {
                throw new Error(res?.message || '설문 동기화 요청이 서버에서 완료되지 않았습니다.');
            }
        } catch (err) {
            const isRunning = err.code === 'IMPORT_ALREADY_IN_PROGRESS' || err.code === 'IMPORT_ALREADY_RUNNING';
            const msg = isRunning
                ? '현재 다른 설문 동기화 작업이 진행 중입니다. 잠시 후 다시 확인해 주세요.'
                : (err.message || '설문 동기화 중 오류가 발생했습니다.');
            setSyncProgress(prev => ({ ...prev, isSyncing: false, isError: true, message: `오류 발생: ${msg}` }));
            showToast(msg, 'error');
        } finally {
            importing = false;
        }
        completed = true;
        if (!importCompleted) return;
        try {
            await loadData();
        } catch (refreshErr) {
            warnings.push(String(refreshErr));
        }
        if (typeof refreshSidebarBadge === 'function') {
            try {
                await refreshSidebarBadge();
            } catch (badgeErr) {
                warnings.push(String(badgeErr));
            }
        }
    }

    return {
        handleImportClick, calls, warnings,
        getState: () => syncProgress,
        isImporting: () => importing,
        getSetStateAfterCompletion: () => setStateAfterCompletion
    };
}

const okSummary = (over) => ({
    success: true,
    summary: { imported: 0, failed: 0, reused: 0, discovered: 0, totalFetched: 0, stopReason: 'QUEUE_DRAINED', ...over }
});

await testCase('Test 1: empty queue (QUEUE_DRAINED, 0/0/0)', async () => {
    const h = makeHarness({ importImpl: async () => okSummary({}) });
    await h.handleImportClick();
    const st = h.getState();
    assert(h.calls.import === 1, `import API must be called once, got ${h.calls.import}`);
    assert(st.isError === false, 'empty drain must not be an error state');
    assert(st.message === '현재 대기 중인 신규 설문이 없습니다.', `wrong empty-queue message: ${st.message}`);
    assert(!st.message.includes('오류 발생'), 'ReferenceError/error text must not appear');
    assert(st.stopReason === 'QUEUE_DRAINED', 'stopReason must be preserved');
    assert(h.calls.loadData === 1, 'list refresh must be called once');
    assert(h.calls.badge === 1, 'badge refresh must be called once via canonical callback');
    assert(h.isImporting() === false, 'loading state must be released');
});

await testCase('Test 2: one imported item', async () => {
    const h = makeHarness({ importImpl: async () => okSummary({ imported: 1, discovered: 1, totalFetched: 1 }) });
    await h.handleImportClick();
    const st = h.getState();
    assert(st.imported === 1, 'imported count must be 1');
    assert(st.message.includes('신규 수신 1건'), 'summary must show the imported count');
    assert(h.calls.loadData === 1, 'list refresh exactly once');
    assert(h.calls.badge === 1, 'badge refresh exactly once');
    assert(h.calls.toasts.filter(t => t.type === 'success').length === 1, 'exactly one success toast (no duplicate popup)');
    assert(h.calls.import === 1, 'no duplicate import');
});

await testCase('Test 3: badge callback absent', async () => {
    const h = makeHarness({ importImpl: async () => okSummary({ imported: 2, discovered: 2, totalFetched: 2 }), withBadge: false });
    await h.handleImportClick(); // must not throw (no ReferenceError possible: declared prop is undefined)
    const st = h.getState();
    assert(st.isError === false, 'completion must remain visible without a badge callback');
    assert(st.imported === 2, 'import result must be preserved');
    assert(!st.message.includes('오류 발생'), 'no false server failure may be displayed');
    assert(h.calls.import === 1, 'no duplicate import');
    assert(h.calls.badge === 0, 'absent callback must not be invoked');
});

await testCase('Test 4: badge refresh throws', async () => {
    const h = makeHarness({
        importImpl: async () => okSummary({ imported: 1, discovered: 1, totalFetched: 1 }),
        badgeImpl: async () => { throw new Error('badge fetch failed'); }
    });
    await h.handleImportClick();
    const st = h.getState();
    assert(st.isError === false, 'successful import must remain successful when badge refresh fails');
    assert(st.imported === 1 && st.message.includes('신규 수신 1건'), 'import summary must not be overwritten');
    assert(h.warnings.length === 1, 'badge failure must degrade to a non-blocking warning only');
    assert(h.calls.import === 1, 'import must NOT be retried after badge failure');
    assert(h.isImporting() === false, 'loading state must be released');
});

await testCase('Test 5: import API fails', async () => {
    const apiErr = Object.assign(new Error('서버 내부 오류가 발생했습니다.'), { code: 'IMPORT_FAILED' });
    const h = makeHarness({ importImpl: async () => { throw apiErr; } });
    await h.handleImportClick();
    const st = h.getState();
    assert(st.isError === true, 'API failure must set the error state (no false completion heading)');
    assert(st.message.includes('서버 내부 오류가 발생했습니다.'), 'the actual API error must be displayed');
    assert(h.calls.badge === 0, 'badge refresh must not run as if import succeeded');
    assert(h.calls.loadData === 0, 'list refresh must not run after a failed import');
    assert(h.isImporting() === false, 'loading state must be released');
});

await testCase('Test 6: partial failure response preserves exact server counts', async () => {
    const h = makeHarness({
        importImpl: async () => okSummary({ imported: 2, reused: 1, failed: 3, discovered: 6, totalFetched: 6, stopReason: 'FAILED_ITEM_LOOP_PREVENTED' })
    });
    await h.handleImportClick();
    const st = h.getState();
    assert(st.imported === 2 && st.reused === 1 && st.failed === 3, `counts must be preserved exactly, got ${st.imported}/${st.reused}/${st.failed}`);
    assert(st.stopReason === 'FAILED_ITEM_LOOP_PREVENTED', 'server stopReason must be preserved');
    assert(st.isError === false, 'a completed response with failures is not a frontend error');
    assert(!st.message.includes('refreshSidebarBadge'), 'frontend callback error must not replace the server result');
    assert(h.calls.badge === 1, 'badge refresh still runs once after a completed response');
});

await testCase('Test 7: unmount during refresh — no post-completion state updates, no duplicate request', async () => {
    const h = makeHarness({ importImpl: async () => okSummary({ imported: 1, discovered: 1, totalFetched: 1 }) });
    await h.handleImportClick();
    assert(h.getSetStateAfterCompletion() === 0, 'refresh phase must not call setState (safe after unmount)');
    assert(h.calls.import === 1, 'no duplicate import request');
    assert(h.calls.loadData === 1 && h.calls.badge === 1, 'each refresh runs exactly once');
});

console.log(`\nTotal: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failedTests > 0) {
    console.error('❌ SURVEY SYNC BADGE REFRESH VERIFICATION FAILED');
    process.exit(1);
}
console.log('✅ ALL SURVEY SYNC BADGE REFRESH CHECKS PASSED');

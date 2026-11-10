/**
 * Referral list date-sort tests for compareReferralsByRequestDate
 * Run with: node --test tests/referralSort.test.js
 *
 * The list must sort strictly by requestDate descending (newest first).
 * Completion status and unregistered status must NOT affect the order —
 * that was the bug: an old unregistered referral appeared above newer ones.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The comparator lives in a .ts component module, so transpile it (same
// approach as tests/survey.test.js, which imports the typescript API)
// and load the result from a temp file.
const srcPath = path.join(__dirname, '../components/referrals/referralSort.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'referral-sort-'));
const tmpFile = path.join(tmpDir, 'referralSort.mjs');
fs.writeFileSync(tmpFile, outputText);
const { compareReferralsByRequestDate } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

const byRefNo = (list) => list.map((r) => r.refNo);

describe('compareReferralsByRequestDate', () => {
    it('sorts strictly by requestDate descending, ignoring completion/unregistered status', () => {
        const list = [
            // Old unregistered: the old grouped sort put this first.
            { refNo: 'R-001', requestDate: '2026-03-06', registrationStatus: '미등록' },
            // Newest registered.
            { refNo: 'R-002', requestDate: '2026-09-23', registrationStatus: '등록' },
            // Recent but completed: the old grouped sort put this last.
            { refNo: 'R-003', requestDate: '2026-09-20', closureStatus: '종결' },
            // Same date pair: refNo descending.
            { refNo: 'R-004', requestDate: '2026-07-23', registrationStatus: '등록' },
            { refNo: 'R-005', requestDate: '2026-07-23', registrationStatus: '등록' },
            // No date: last.
            { refNo: 'R-006', requestDate: '', registrationStatus: '미등록' },
        ];
        const sorted = [...list].sort(compareReferralsByRequestDate);
        assert.deepEqual(byRefNo(sorted), ['R-002', 'R-003', 'R-005', 'R-004', 'R-001', 'R-006']);
    });

    it('puts missing or invalid dates last', () => {
        const list = [
            { refNo: 'R-011', requestDate: '잘못된날짜' },
            { refNo: 'R-012', requestDate: '2026-01-15' },
            { refNo: 'R-013', requestDate: '' },
        ];
        const sorted = [...list].sort(compareReferralsByRequestDate);
        assert.equal(sorted[0].refNo, 'R-012');
        assert.deepEqual(byRefNo(sorted).slice(1).sort(), ['R-011', 'R-013']);
    });

    it('orders a shuffled list newest-first', () => {
        const dates = ['2026-09-23', '2026-07-23', '2026-03-10', '2026-03-06', '2026-01-05'];
        const list = dates.map((d, i) => ({ refNo: `R-1${i}`, requestDate: d }));
        const shuffled = [list[3], list[0], list[4], list[1], list[2]];
        const sorted = [...shuffled].sort(compareReferralsByRequestDate);
        assert.deepEqual(
            sorted.map((r) => r.requestDate),
            [...dates].sort().reverse()
        );
    });
});

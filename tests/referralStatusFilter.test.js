/**
 * Referral status-filter predicate tests for matchesStatusFilter
 * Run with: node --test tests/referralStatusFilter.test.js
 *
 * The "개입중만 보기" toggle drives statusFilter ('all' | 'ongoing' | 'closed').
 * 'ongoing' must keep only 미종결 rows; 'all' keeps everything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The predicate lives in a .ts component module, so transpile it (same
// approach as tests/referralSort.test.js) and load the result from a temp file.
const srcPath = path.join(__dirname, '../components/referrals/referralStatusFilter.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'referral-status-filter-'));
const tmpFile = path.join(tmpDir, 'referralStatusFilter.mjs');
fs.writeFileSync(tmpFile, outputText);
const { matchesStatusFilter } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

describe('matchesStatusFilter', () => {
    it('ongoing keeps only 미종결 rows', () => {
        const list = [
            { refNo: 'R-001', closureStatus: '미종결' },
            { refNo: 'R-002', closureStatus: '종결' },
            { refNo: 'R-003', closureStatus: '미종결' },
            { refNo: 'R-004' },
        ];
        const kept = list.filter((r) => matchesStatusFilter(r, 'ongoing'));
        assert.deepEqual(kept.map((r) => r.refNo), ['R-001', 'R-003']);
    });

    it('all keeps every row', () => {
        const list = [
            { refNo: 'R-001', closureStatus: '미종결' },
            { refNo: 'R-002', closureStatus: '종결' },
            { refNo: 'R-003' },
        ];
        const kept = list.filter((r) => matchesStatusFilter(r, 'all'));
        assert.deepEqual(kept.map((r) => r.refNo), ['R-001', 'R-002', 'R-003']);
    });

    it('closed keeps only non-미종결 rows', () => {
        const list = [
            { refNo: 'R-001', closureStatus: '미종결' },
            { refNo: 'R-002', closureStatus: '종결' },
            { refNo: 'R-003' },
        ];
        const kept = list.filter((r) => matchesStatusFilter(r, 'closed'));
        assert.deepEqual(kept.map((r) => r.refNo), ['R-002', 'R-003']);
    });
});

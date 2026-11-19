/**
 * 대상자 복합키[이름·연령·연락처] + 의뢰날짜 판정 테스트 (CLAUDE.md §1, §2)
 * Run with: node --test tests/clientIdentity.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../utils/clientIdentity.ts'), 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-identity-'));
const tmpFile = path.join(tmpDir, 'clientIdentity.mjs');
fs.writeFileSync(tmpFile, outputText);
const { getClientCompositeKey, classifyIncomingReferral, normalizeDate } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

const existing = [
    { refNo: 'R-1', name: '김민수', age: 34, phone: '010-1111-2222', requestDate: '2026-03-02' },
    { refNo: 'R-2', name: '이영희', age: '27', phone: '01033334444', requestDate: '2026-05-10' },
];

describe('getClientCompositeKey', () => {
    it('normalizes spaces, age text and phone formatting', () => {
        assert.equal(
            getClientCompositeKey({ name: ' 김 민수 ', age: '34세', phone: '010 1111 2222' }),
            getClientCompositeKey({ name: '김민수', age: 34, phone: '010-1111-2222' }),
        );
    });
    it('returns null when any key part is missing', () => {
        assert.equal(getClientCompositeKey({ name: '김민수', age: 34, phone: '' }), null);
        assert.equal(getClientCompositeKey({ name: '김민수', age: 0, phone: '01011112222' }), null);
        assert.equal(getClientCompositeKey({ name: '', age: 34, phone: '01011112222' }), null);
    });
});

describe('normalizeDate', () => {
    it('accepts dotted, slashed and ISO forms', () => {
        assert.equal(normalizeDate('2026.3.2'), '2026-03-02');
        assert.equal(normalizeDate('2026/03/02'), '2026-03-02');
        assert.equal(normalizeDate('2026-03-02T09:00:00Z'), '2026-03-02');
        assert.equal(normalizeDate('없음'), '');
    });
});

describe('classifyIncomingReferral', () => {
    it('same composite key and same date → duplicate (no alert)', () => {
        const r = classifyIncomingReferral({ name: '김민수', age: '34', phone: '01011112222', requestDate: '2026.03.02' }, existing);
        assert.equal(r.kind, 'duplicate');
        assert.equal(r.match.refNo, 'R-1');
    });
    it('same composite key but different date → re-referral (alert)', () => {
        const r = classifyIncomingReferral({ name: '김민수', age: 34, phone: '010-1111-2222', requestDate: '2026-11-19' }, existing);
        assert.equal(r.kind, 're-referral');
        assert.equal(r.match.refNo, 'R-1');
    });
    it('same name and age but different phone → new person (never merged)', () => {
        const r = classifyIncomingReferral({ name: '김민수', age: 34, phone: '01099998888', requestDate: '2026-03-02' }, existing);
        assert.equal(r.kind, 'new');
    });
    it('missing phone cannot be identified → new', () => {
        const r = classifyIncomingReferral({ name: '김민수', age: 34, requestDate: '2026-03-02' }, existing);
        assert.equal(r.kind, 'new');
    });
});

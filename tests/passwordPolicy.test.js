/**
 * 비밀번호 변경 권장 기준 테스트 (서버/프론트 규칙 일치 포함)
 * Run with: node --test tests/passwordPolicy.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as server from '../server/auth/passwordPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../utils/passwordPolicy.ts'), 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-policy-'));
const tmpFile = path.join(tmpDir, 'passwordPolicy.mjs');
fs.writeFileSync(tmpFile, outputText);
const client = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

const samples = ['1234', '12345678', 'abcd', 'abcdefgh', 'abc12', 'abcd1234', 'Abcd!2345', '', '가나다라마바사아1'];

describe('passwordPolicy', () => {
    it('recommends change for numeric-only or short passwords', () => {
        assert.equal(server.isPasswordChangeRecommended('1234'), true);
        assert.ok(server.getPasswordWeaknesses('1234').includes('숫자로만 구성'));
        assert.equal(server.isPasswordChangeRecommended('12345678'), true);
        assert.equal(server.isPasswordChangeRecommended('abcdefgh'), true);
        assert.equal(server.isPasswordChangeRecommended('abc12'), true);
        assert.equal(server.isPasswordChangeRecommended(undefined), true);
    });
    it('accepts letters + digits with 8+ chars', () => {
        assert.equal(server.isPasswordChangeRecommended('abcd1234'), false);
        assert.equal(server.isPasswordChangeRecommended('Abcd!2345'), false);
    });
    it('server and frontend rules agree', () => {
        for (const pw of samples) {
            assert.deepEqual(client.getPasswordWeaknesses(pw), server.getPasswordWeaknesses(pw), pw);
        }
    });
});

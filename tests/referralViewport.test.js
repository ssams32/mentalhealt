/**
 * Referral viewport helper tests for isDesktopViewport
 * Run with: node --test tests/referralViewport.test.js
 *
 * The auto-select effect in ReferralDashboardV2 must only run on desktop
 * (lg breakpoint, 1024px). On mobile it must not re-select the first
 * referral, otherwise the "목록으로" button can never show the list.
 * matchMedia missing means desktop behaviour (auto-select).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The helper lives in a .ts component module, so transpile it (same
// approach as tests/referralStatusFilter.test.js) and load the result.
const srcPath = path.join(__dirname, '../components/referrals/referralViewport.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'referral-viewport-'));
const tmpFile = path.join(tmpDir, 'referralViewport.mjs');
fs.writeFileSync(tmpFile, outputText);
const { isDesktopViewport, DESKTOP_BREAKPOINT_PX } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

describe('isDesktopViewport', () => {
    it('breakpoint matches the lg layout breakpoint (1024px)', () => {
        assert.equal(DESKTOP_BREAKPOINT_PX, 1024);
    });

    it('returns true when the media query matches (desktop)', () => {
        const matchMedia = (query) => ({ matches: query === '(min-width: 1024px)' });
        assert.equal(isDesktopViewport(matchMedia), true);
    });

    it('returns false when the media query does not match (mobile)', () => {
        const matchMedia = () => ({ matches: false });
        assert.equal(isDesktopViewport(matchMedia), false);
    });

    it('asks matchMedia with the lg breakpoint query', () => {
        let seenQuery;
        const matchMedia = (query) => {
            seenQuery = query;
            return { matches: true };
        };
        isDesktopViewport(matchMedia);
        assert.equal(seenQuery, '(min-width: 1024px)');
    });

    it('falls back to desktop (true) when matchMedia is missing', () => {
        assert.equal(isDesktopViewport(undefined), true);
        assert.equal(isDesktopViewport(null), true);
    });
});

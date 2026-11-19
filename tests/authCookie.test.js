/**
 * 잘못 인코딩된 세션 쿠키가 서버를 종료시키지 않는지 확인
 * Run with: node --test tests/authCookie.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionCookie, createAuthMiddleware } from '../server/auth/authMiddleware.js';

describe('parseSessionCookie', () => {
    it('returns null for a malformed percent-encoding instead of throwing', () => {
        assert.equal(parseSessionCookie('mind_session=%'), null);
        assert.equal(parseSessionCookie('other=1; mind_session=%E0%A4%A'), null);
    });
    it('still decodes a valid cookie', () => {
        assert.equal(parseSessionCookie('a=b; mind_session=abc%20def'), 'abc def');
    });
});

describe('requireAuth with malformed cookie', () => {
    it('responds 401 rather than throwing', async () => {
        const { requireAuth } = createAuthMiddleware({ authenticateSession: async () => null });
        let status = null;
        const res = { status(code) { status = code; return this; }, json() { return this; } };
        await requireAuth({ headers: { cookie: 'mind_session=%' } }, res, () => {});
        assert.equal(status, 401);
    });
});

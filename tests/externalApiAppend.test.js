/**
 * 홈페이지 연동 수신이 기존 대기 의뢰/설문 제출 기록을 지우지 않는지 확인 (회귀 테스트)
 * Run with: node --test tests/externalApiAppend.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineService } from '../server/external-api/engineService.js';

describe('engineService._appendAndPersist', () => {
    it('keeps existing rows and replaces only rows with the same external id', async () => {
        const store = {
            PendingReferrals: [
                { externalIdx: 'OLD-1', name: '기존1' },
                { externalIdx: 'DUP', name: '이전값' },
                { id: 'scraper-item', name: '스크레이퍼' },
            ],
        };
        const service = createEngineService({
            getData: (name, fallback) => store[name] ?? fallback,
            persistData: async (name, data) => { store[name] = data; },
            syncHistory: { retryQueue: { addOrUpdate() {} } },
            config: {},
        });
        await service._appendAndPersist('PendingReferrals', [
            { externalIdx: 'DUP', name: '새값' },
            { externalIdx: 'NEW-1', name: '신규' },
        ], 'externalIdx');

        const names = store.PendingReferrals.map(r => r.name);
        assert.deepEqual(names, ['기존1', '스크레이퍼', '새값', '신규']);
    });

    it('creates the list when nothing is stored yet', async () => {
        const store = {};
        const service = createEngineService({
            getData: (name, fallback) => store[name] ?? fallback,
            persistData: async (name, data) => { store[name] = data; },
            syncHistory: { retryQueue: { addOrUpdate() {} } },
            config: {},
        });
        await service._appendAndPersist('SurveySubmissions', [{ submissionId: 'S1' }], 'submissionId');
        assert.deepEqual(store.SurveySubmissions, [{ submissionId: 'S1' }]);
    });
});

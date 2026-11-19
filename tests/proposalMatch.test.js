/**
 * Unit tests for budget proposal crosscheck matching logic
 * Run with: node --test tests/proposalMatch.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srcPath = path.join(__dirname, '../components/budget/proposalMatch.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-match-'));
const tmpFile = path.join(tmpDir, 'proposalMatch.mjs');
fs.writeFileSync(tmpFile, outputText);
const { matchManualEntryToProposal, normalizeBudgetItem, isSameBudgetItem, buildManualEntryFromProposal, findManualEntryForProposal } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

describe('proposalMatch - 수기 지출 품의 내역 크로스체크', () => {

    it('1. 정확 일치 (같은 과목) -> matched ("일치" + 품의번호 + 적요)', () => {
        const entry = {
            id: 'e1',
            date: '2026-11-19',
            amount: 50000,
            description: '주유비 지출'
        };
        const transactions = [
            {
                id: 't1',
                approvalNo: 'AP-2026-001',
                date: '2026-11-19',
                amount: 50000,
                budgetItem: '차량운행비',
                description: '업무용 차량 주유'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'matched');
        assert.equal(result.badgeText, '일치');
        assert.equal(result.detailText, 'AP-2026-001 업무용 차량 주유');
        assert.equal(result.matchedCount, 1);
        assert.equal(result.matchedProposal.approvalNo, 'AP-2026-001');
    });

    it('2. 정확 일치 (다른 과목만 있음) -> other-item ("다른 과목" + 품의번호 + 과목명)', () => {
        const entry = {
            id: 'e2',
            date: '2026-11-19',
            amount: 50000,
            description: '출장비'
        };
        const transactions = [
            {
                id: 't2',
                approvalNo: 'AP-2026-002',
                date: '2026-11-19',
                amount: 50000,
                budgetItem: '여비',
                description: '관내 출장 여비'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'other-item');
        assert.equal(result.badgeText, '다른 과목');
        assert.equal(result.detailText, 'AP-2026-002 (여비)');
        assert.equal(result.matchedCount, 1);
    });

    it('3. 여러 개 일치 -> 첫 번째 표시 + "외 N건"', () => {
        const entry = {
            id: 'e3',
            date: '2026-11-19',
            amount: 30000,
            description: '사무용품'
        };
        const transactions = [
            {
                id: 't3a',
                approvalNo: 'AP-001',
                date: '2026-11-19',
                amount: 30000,
                budgetItem: '수용비및수수료',
                description: '복사용지 구매'
            },
            {
                id: 't3b',
                approvalNo: 'AP-002',
                date: '2026-11-19',
                amount: 30000,
                budgetItem: '수용비및수수료',
                description: '토너 구매'
            },
            {
                id: 't3c',
                approvalNo: 'AP-003',
                date: '2026-11-19',
                amount: 30000,
                budgetItem: '수용비및수수료',
                description: '필기구 구매'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '수용비및수수료');
        assert.equal(result.status, 'matched');
        assert.equal(result.badgeText, '일치');
        assert.equal(result.detailText, 'AP-001 복사용지 구매 외 2건');
        assert.equal(result.matchedCount, 3);
    });

    it('3-2. 다른 과목 여러 개 일치 -> "외 N건"', () => {
        const entry = {
            id: 'e3_2',
            date: '2026-11-19',
            amount: 30000,
            description: '소모품'
        };
        const transactions = [
            {
                id: 't3_other1',
                approvalNo: 'AP-101',
                date: '2026-11-19',
                amount: 30000,
                budgetItem: '복리후생비',
                description: '간식비'
            },
            {
                id: 't3_other2',
                approvalNo: 'AP-102',
                date: '2026-11-19',
                amount: 30000,
                budgetItem: '복리후생비',
                description: '음료구입'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '수용비및수수료');
        assert.equal(result.status, 'other-item');
        assert.equal(result.badgeText, '다른 과목');
        assert.equal(result.detailText, 'AP-101 (복리후생비) 외 1건');
        assert.equal(result.matchedCount, 2);
    });

    it('4. 날짜만 일치 -> date-only ("날짜만 맞음" + 해당 품의 금액)', () => {
        const entry = {
            id: 'e4',
            date: '2026-11-19',
            amount: 50000,
            description: '소모품'
        };
        const transactions = [
            {
                id: 't4',
                approvalNo: 'AP-004',
                date: '2026-11-19',
                amount: 75000,
                budgetItem: '차량운행비',
                description: '엔진오일 교체'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'date-only');
        assert.equal(result.badgeText, '날짜만 맞음');
        assert.equal(result.detailText, '75,000원');
        assert.equal(result.matchedCount, 1);
    });

    it('4-2. 날짜만 일치 여러 건 -> "외 N건"', () => {
        const entry = {
            id: 'e4_2',
            date: '2026-11-19',
            amount: 50000,
            description: '소모품'
        };
        const transactions = [
            { id: 't4a', date: '2026-11-19', amount: 60000, budgetItem: '차량운행비' },
            { id: 't4b', date: '2026-11-19', amount: 80000, budgetItem: '차량운행비' }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'date-only');
        assert.equal(result.badgeText, '날짜만 맞음');
        assert.equal(result.detailText, '60,000원 외 1건');
        assert.equal(result.matchedCount, 2);
    });

    it('5. 금액만 일치 -> amount-only ("금액만 맞음" + 해당 품의 날짜)', () => {
        const entry = {
            id: 'e5',
            date: '2026-11-19',
            amount: 50000,
            description: '주유'
        };
        const transactions = [
            {
                id: 't5',
                approvalNo: 'AP-005',
                date: '2026-11-12',
                amount: 50000,
                budgetItem: '차량운행비',
                description: '주유비'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'amount-only');
        assert.equal(result.badgeText, '금액만 맞음');
        assert.equal(result.detailText, '2026-11-12');
        assert.equal(result.matchedCount, 1);
    });

    it('5-2. 금액만 일치 여러 건 -> "외 N건"', () => {
        const entry = {
            id: 'e5_2',
            date: '2026-11-19',
            amount: 50000,
            description: '주유'
        };
        const transactions = [
            { id: 't5a', date: '2026-11-10', amount: 50000, budgetItem: '차량운행비' },
            { id: 't5b', date: '2026-11-15', amount: 50000, budgetItem: '차량운행비' }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'amount-only');
        assert.equal(result.badgeText, '금액만 맞음');
        assert.equal(result.detailText, '2026-11-10 외 1건');
        assert.equal(result.matchedCount, 2);
    });

    it('6. 품의 없음 -> no-match ("품의 없음")', () => {
        const entry = {
            id: 'e6',
            date: '2026-11-19',
            amount: 123456,
            description: '기타 경비'
        };
        const transactions = [
            {
                id: 't6',
                date: '2026-10-01',
                amount: 99999,
                budgetItem: '차량운행비'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'no-match');
        assert.equal(result.badgeText, '품의 없음');
        assert.equal(result.detailText, '');
        assert.equal(result.matchedCount, 0);
    });

    it('7. 빈 행 건너뛰기 -> isPlaceholder=true, amount=0, description="" 이면 skipped ("-")', () => {
        const entry = {
            id: 'empty_1',
            date: '2026-11-19',
            writer: '관리자',
            amount: 0,
            description: '',
            isPlaceholder: true
        };
        const transactions = [
            {
                id: 't7',
                date: '2026-11-19',
                amount: 50000,
                budgetItem: '차량운행비'
            }
        ];

        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'skipped');
        assert.equal(result.badgeText, '-');
        assert.equal(result.detailText, '');
        assert.equal(result.matchedCount, 0);
    });

    it('8. 금액 0인 행 -> 빈 행 조건 아니면 대조 수행 (날짜 일치 품의 있으면 date-only, 없으면 no-match)', () => {
        // 8-a. isPlaceholder=false인 실입력 행 (금액 0, 적요 있음, 날짜에 다른 금액 품의 존재)
        const entryWithDateMatch = {
            id: 'e8_a',
            date: '2026-11-19',
            amount: 0,
            description: '견적 확인용',
            isPlaceholder: false
        };
        const transactions = [
            {
                id: 't8',
                approvalNo: 'AP-800',
                date: '2026-11-19',
                amount: 40000,
                budgetItem: '차량운행비',
                description: '견적 품의'
            }
        ];
        const resA = matchManualEntryToProposal(entryWithDateMatch, transactions, '차량운행비');
        assert.equal(resA.status, 'date-only');
        assert.equal(resA.badgeText, '날짜만 맞음');
        assert.equal(resA.detailText, '40,000원');

        // 8-b. 일치하는 품의가 전혀 없는 금액 0 행
        const entryNoMatch = {
            id: 'e8_b',
            date: '2026-05-01',
            amount: 0,
            description: '품의 미등록',
            isPlaceholder: false
        };
        const resB = matchManualEntryToProposal(entryNoMatch, transactions, '차량운행비');
        assert.equal(resB.status, 'no-match');
        assert.equal(resB.badgeText, '품의 없음');
    });

    it('9. 예산과목 정규화 (normalizeBudgetItem & "외 N건" 처리)', () => {
        assert.equal(normalizeBudgetItem('차량운행비 외 1건'), '차량운행비');
        assert.equal(normalizeBudgetItem('  수용비및수수료  '), '수용비및수수료');
        assert.equal(normalizeBudgetItem(''), '');

        assert.equal(isSameBudgetItem('차량운행비 외 2건', '차량운행비'), true);
        assert.equal(isSameBudgetItem('차량운행비', '여비'), false);
    });

    it('10. 부분 일치는 같은 과목 안에서만 탐색 (다른 과목의 날짜/금액은 부분 일치로 오인하지 않음)', () => {
        const entry = {
            id: 'e10',
            date: '2026-11-19',
            amount: 50000,
            description: '차량 주유'
        };
        // 같은 날짜/금액이지만 과목이 '여비'인 품의만 있음 (금액 다름)
        const transactions = [
            {
                id: 't10',
                date: '2026-11-19',
                amount: 90000,
                budgetItem: '여비',
                description: '출장'
            }
        ];

        // 모달 과목은 '차량운행비' -> 다른 과목이므로 부분 일치되지 않고 no-match
        const result = matchManualEntryToProposal(entry, transactions, '차량운행비');
        assert.equal(result.status, 'no-match');
        assert.equal(result.badgeText, '품의 없음');
    });

    it('11. budgetItem prop이 주어지지 않은 경우 (단일 추가 모달 등)', () => {
        const entry = {
            id: 'e11',
            date: '2026-11-19',
            amount: 50000,
            description: '공통 지출'
        };
        const transactions = [
            {
                id: 't11',
                approvalNo: 'AP-11',
                date: '2026-11-19',
                amount: 50000,
                budgetItem: '일반수용비',
                description: '문구류'
            }
        ];

        // budgetItem 미지정 시 정확 일치는 matched
        const result = matchManualEntryToProposal(entry, transactions);
        assert.equal(result.status, 'matched');
        assert.equal(result.badgeText, '일치');
        assert.equal(result.detailText, 'AP-11 문구류');
    });
});

describe('proposalMatch - 품의 1클릭 수기 자동 입력', () => {

    it('1. buildManualEntryFromProposal: 품의번호가 있으면 [번호] 적요 형태', () => {
        const t = {
            id: 't1',
            approvalNo: '2026-0001',
            date: '2026-11-19',
            writer: '관리자',
            amount: 50000,
            description: '차량 유류비'
        };
        const entry = buildManualEntryFromProposal(t);
        assert.equal(entry.description, '[2026-0001] 차량 유류비');
        assert.equal(entry.date, '2026-11-19');
        assert.equal(entry.writer, '관리자');
        assert.equal(entry.amount, 50000);
        assert.equal(typeof entry.id, 'string');
        assert.ok(entry.id.length > 0);
        assert.equal(entry.isPlaceholder, undefined);
    });

    it('2. buildManualEntryFromProposal: 품의번호가 없으면 적요 그대로', () => {
        const t = {
            id: 't2',
            approvalNo: '',
            date: '2026-11-18',
            writer: '관리자',
            amount: 20000,
            description: '출장 여비'
        };
        const entry = buildManualEntryFromProposal(t);
        assert.equal(entry.description, '출장 여비');
    });

    it('3. buildManualEntryFromProposal: 적요가 비어 있으면 품의번호만', () => {
        const t = {
            id: 't3',
            approvalNo: ' 2026-0003 ',
            date: '2026-11-17',
            writer: '관리자',
            amount: 30000,
            description: '   '
        };
        const entry = buildManualEntryFromProposal(t);
        assert.equal(entry.description, '[2026-0003]');
    });

    it('4. buildManualEntryFromProposal: 금액은 숫자로 변환', () => {
        const t = {
            id: 't4',
            approvalNo: '2026-0004',
            date: '2026-11-16',
            writer: '관리자',
            amount: '75000',
            description: '소모품 구매'
        };
        const entry = buildManualEntryFromProposal(t);
        assert.equal(entry.amount, 75000);
        assert.equal(typeof entry.amount, 'number');
    });

    it('5. findManualEntryForProposal: 날짜+금액이 일치하면 그 행을 찾음', () => {
        const t = { id: 't5', date: '2026-11-19', amount: 50000 };
        const entries = [
            { id: 'e1', date: '2026-11-18', amount: 50000, description: '다른 날' },
            { id: 'e2', date: '2026-11-19', amount: 50000, description: '[2026-0001] 차량 유류비' },
            { id: 'e3', date: '2026-11-19', amount: 30000, description: '다른 금액' }
        ];
        const found = findManualEntryForProposal(t, entries);
        assert.equal(found.id, 'e2');
    });

    it('6. findManualEntryForProposal: 날짜만 맞으면 못 찾음', () => {
        const t = { id: 't6', date: '2026-11-19', amount: 99000 };
        const entries = [
            { id: 'e1', date: '2026-11-19', amount: 50000, description: '날짜만 같음' }
        ];
        assert.equal(findManualEntryForProposal(t, entries), null);
    });

    it('7. findManualEntryForProposal: 금액만 맞으면 못 찾음', () => {
        const t = { id: 't7', date: '2026-11-15', amount: 50000 };
        const entries = [
            { id: 'e1', date: '2026-11-19', amount: 50000, description: '금액만 같음' }
        ];
        assert.equal(findManualEntryForProposal(t, entries), null);
    });

    it('8. findManualEntryForProposal: 빈 행과 placeholder는 무시', () => {
        const t = { id: 't8', date: '2026-11-19', amount: 0 };
        const entries = [
            { id: 'e1', date: '2026-11-19', amount: 0, description: '', isPlaceholder: true },
            { id: 'e2', date: '2026-11-19', amount: 0, description: '' },
            { id: 'e3', date: '2026-11-19', amount: 0, description: '0원 지출' }
        ];
        // e1(placeholder)과 e2(빈 행)는 무시되고, 적요가 있는 e3이 찾아짐
        const found = findManualEntryForProposal(t, entries);
        assert.equal(found.id, 'e3');
    });

    it('9. findManualEntryForProposal: 빈 목록이면 null', () => {
        const t = { id: 't9', date: '2026-11-19', amount: 50000 };
        assert.equal(findManualEntryForProposal(t, []), null);
        assert.equal(findManualEntryForProposal(t), null);
    });

    it('10. findManualEntryForProposal: 금액 문자열도 숫자로 비교', () => {
        const t = { id: 't10', date: '2026-11-19', amount: '50000' };
        const entries = [
            { id: 'e1', date: '2026-11-19', amount: 50000, description: '숫자 금액 행' }
        ];
        const found = findManualEntryForProposal(t, entries);
        assert.equal(found.id, 'e1');
    });
});

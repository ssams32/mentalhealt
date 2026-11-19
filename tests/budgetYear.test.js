/**
 * Unit tests for budget year logic (2026/2027 separation)
 * Run with: node --test tests/budgetYear.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srcPath = path.join(__dirname, '../components/budget/budgetYear.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-year-'));
const tmpFile = path.join(tmpDir, 'budgetYear.mjs');
fs.writeFileSync(tmpFile, outputText);
const {
    LEGACY_PLAN_YEAR,
    toBudgetKey,
    toBudgetKeyNoYear,
    parsePlanYear,
    parseBudgetKey,
    stripYearFromKey,
    getTransactionYear,
    getPlanYear,
    availableYears,
    dataYears,
    resolveInitialYear,
    countPlansForYear,
    findLatestYearWithPlans,
    copyPlansToYear,
    migrateBudgetPlansMap,
    normalizeHiddenItemKeys,
} = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpDir, { recursive: true, force: true });

const plan2026a = {
    department: '증진', budgetItem: '차량운영비', categoryGroup: '운영비',
    source: '', category1: '', projectName: '안심버스', category2: '차량운영비',
    budgetAmount: 500000, manualEntries: [{ id: 'm1', date: '2026-11-01', writer: '관리자', amount: 50000, description: '유류비' }],
    order: 0, year: 2026
};
const plan2026b = {
    department: '증진', budgetItem: '여비', categoryGroup: '운영비',
    source: '', category1: '', projectName: '', category2: '여비',
    budgetAmount: 300000, manualEntries: [], order: 1, year: 2026
};
const plans2026 = {
    '2026_증진_차량운영비': plan2026a,
    '2026_증진_여비': plan2026b
};
const tx2026 = { id: 't1', date: '2026-11-19', year: 2026, amount: 50000, department: '증진', budgetItem: '차량운영비' };
const tx2027 = { id: 't2', date: '2027-01-15', year: 2027, amount: 10000, department: '증진', budgetItem: '차량운영비' };

describe('budgetYear - 연도 포함 키', () => {
    it('1. toBudgetKey에 연도가 들어가고 부서·과목이 정규화된다', () => {
        assert.equal(toBudgetKey(2026, '증진팀', '차량운영비 외 1건'), '2026_증진_차량운영비');
        assert.equal(toBudgetKey(2027, '증진', '차량운영비'), '2027_증진_차량운영비');
        assert.equal(toBudgetKey(2026, '아동청소년팀', '여비'), '2026_아동청소년_여비');
    });

    it('2. 연도·부서·과목 중 하나라도 없으면 빈 키를 반환한다', () => {
        assert.equal(toBudgetKey(2026, '', '차량운영비'), '');
        assert.equal(toBudgetKey(2026, '증진', ''), '');
        assert.equal(toBudgetKey(NaN, '증진', '차량운영비'), '');
        assert.equal(toBudgetKey(0, '증진', '차량운영비'), '');
    });

    it('3. toBudgetKeyNoYear는 연도 없는 옛 키를 만든다', () => {
        assert.equal(toBudgetKeyNoYear('증진팀', '차량운영비'), '증진_차량운영비');
    });

    it('4. parsePlanYear: 연도 있는 키는 그 연도, 옛 키는 2026', () => {
        assert.equal(parsePlanYear('2026_증진_차량운영비'), 2026);
        assert.equal(parsePlanYear('2027_증진_차량운영비'), 2027);
        assert.equal(parsePlanYear('증진_차량운영비'), 2026);
        assert.equal(parsePlanYear(''), 2026);
        assert.equal(LEGACY_PLAN_YEAR, 2026);
    });

    it('5. parseBudgetKey: 키를 연도/부서/과목으로 나눈다', () => {
        assert.deepEqual(parseBudgetKey('2027_증진_차량운영비'), { year: 2027, department: '증진', budgetItem: '차량운영비' });
        assert.deepEqual(parseBudgetKey('증진_차량운영비'), { year: 2026, department: '증진', budgetItem: '차량운영비' });
    });

    it('6. stripYearFromKey: 연도 접두사를 떼고 옛 키는 그대로 둔다', () => {
        assert.equal(stripYearFromKey('2027_증진_차량운영비'), '증진_차량운영비');
        assert.equal(stripYearFromKey('증진_차량운영비'), '증진_차량운영비');
    });
});

describe('budgetYear - 연도 구하기', () => {
    it('7. getTransactionYear: year 필드가 있으면 쓰고 없으면 날짜에서 뽑는다', () => {
        assert.equal(getTransactionYear(tx2026), 2026);
        assert.equal(getTransactionYear(tx2027), 2027);
        assert.equal(getTransactionYear({ id: 't3', date: '2026-05-01' }), 2026);
        assert.equal(getTransactionYear({ id: 't4', date: '' }), new Date().getFullYear());
        assert.equal(getTransactionYear(null), new Date().getFullYear());
    });

    it('8. getPlanYear: plan.year가 있으면 쓰고 없으면 키에서 뽑는다', () => {
        assert.equal(getPlanYear(plan2026a, '2026_증진_차량운영비'), 2026);
        assert.equal(getPlanYear({ department: '증진', budgetItem: '여비' }, '증진_여비'), 2026);
        assert.equal(getPlanYear({ department: '증진', budgetItem: '여비', year: 2027 }, '2026_증진_여비'), 2027);
        assert.equal(getPlanYear(null), 2026);
    });
});

describe('budgetYear - 연도 목록·초기 연도', () => {
    it('9. availableYears는 데이터 연도 + 올해를 내림차순으로 내놓는다', () => {
        const years = availableYears([tx2026, tx2027], plans2026);
        assert.ok(years.includes(2026));
        assert.ok(years.includes(2027));
        assert.ok(years.includes(new Date().getFullYear()));
        assert.deepEqual(years, [...years].sort((a, b) => b - a));
    });

    it('10. 빈 데이터면 올해만 나온다', () => {
        assert.deepEqual(availableYears([], {}), [new Date().getFullYear()]);
        assert.deepEqual(dataYears([], {}), []);
    });

    it('11. resolveInitialYear: 저장된 연도가 최우선', () => {
        assert.equal(resolveInitialYear([tx2026], plans2026, 2027), 2027);
    });

    it('12. resolveInitialYear: 저장된 연도가 없으면 올해 데이터가 있을 때 올해', () => {
        assert.equal(resolveInitialYear([tx2026], plans2026, null), 2026);
    });

    it('13. resolveInitialYear: 올해 데이터가 없으면 데이터가 있는 가장 최근 해', () => {
        // 올해는 2026년이고 데이터는 2026년만 있음 -> 2026. (2027년 데이터만 있는 가짜 상황은
        // 올해가 2027년일 때와 같아 따로 재현이 어려우므로, 2025년 데이터만 있는 경우로 확인)
        const tx2025 = { id: 't0', date: '2025-03-01', year: 2025, amount: 1000 };
        const plans2025 = { '2025_증진_여비': { ...plan2026b, year: 2025 } };
        assert.equal(resolveInitialYear([tx2025], plans2025, null), 2025);
    });

    it('14. resolveInitialYear: 데이터가 아예 없으면 올해', () => {
        assert.equal(resolveInitialYear([], {}, null), new Date().getFullYear());
    });
});

describe('budgetYear - 구조 복사', () => {
    it('15. 복사 시 금액 0·수기 빈 배열·새 연도, 과목/부서는 그대로', () => {
        const copied = copyPlansToYear(plans2026, 2026, 2027);
        assert.deepEqual(Object.keys(copied).sort(), ['2027_증진_여비', '2027_증진_차량운영비']);
        assert.equal(copied['2027_증진_차량운영비'].budgetAmount, 0);
        assert.deepEqual(copied['2027_증진_차량운영비'].manualEntries, []);
        assert.equal(copied['2027_증진_차량운영비'].year, 2027);
        assert.equal(copied['2027_증진_차량운영비'].department, '증진');
        assert.equal(copied['2027_증진_차량운영비'].budgetItem, '차량운영비');
        assert.equal(copied['2027_증진_차량운영비'].projectName, '안심버스');
        assert.equal(copied['2027_증진_차량운영비'].categoryGroup, '운영비');
    });

    it('16. 복사는 원본을 바꾸지 않는다', () => {
        const before = JSON.stringify(plans2026);
        copyPlansToYear(plans2026, 2026, 2027);
        assert.equal(JSON.stringify(plans2026), before);
        assert.equal(plans2026['2026_증진_차량운영비'].budgetAmount, 500000);
        assert.equal(plans2026['2026_증진_차량운영비'].manualEntries.length, 1);
    });

    it('17. 새 연도에 이미 같은 과목이 있으면 건너뛴다', () => {
        const withExisting = {
            ...plans2026,
            '2027_증진_여비': { ...plan2026b, year: 2027, budgetAmount: 999 }
        };
        const copied = copyPlansToYear(withExisting, 2026, 2027);
        assert.deepEqual(Object.keys(copied), ['2027_증진_차량운영비']);
    });

    it('18. 원본 연도에 계획이 없으면 빈 맵을 반환한다', () => {
        assert.deepEqual(copyPlansToYear(plans2026, 2027, 2028), {});
    });

    it('19. countPlansForYear / findLatestYearWithPlans', () => {
        assert.equal(countPlansForYear(plans2026, 2026), 2);
        assert.equal(countPlansForYear(plans2026, 2027), 0);
        assert.equal(findLatestYearWithPlans(plans2026, 2027), 2026);
        assert.equal(findLatestYearWithPlans(plans2026, 2026), null);
        assert.equal(findLatestYearWithPlans({}, 2027), null);
    });
});

describe('budgetYear - 옛 키 이전', () => {
    it('20. 옛 키는 2026년 키로 바뀌고 year가 채워진다 (changed=true)', () => {
        const legacy = {
            '증진_차량운영비': { ...plan2026a, year: undefined },
            '증진_여비': { ...plan2026b, year: undefined }
        };
        const { map, changed } = migrateBudgetPlansMap(legacy);
        assert.equal(changed, true);
        assert.deepEqual(Object.keys(map).sort(), ['2026_증진_여비', '2026_증진_차량운영비']);
        assert.equal(map['2026_증진_차량운영비'].year, 2026);
        assert.equal(map['2026_증진_차량운영비'].budgetAmount, 500000);
        assert.equal(map['2026_증진_차량운영비'].manualEntries.length, 1);
    });

    it('21. 이미 연도 키면 바뀌지 않는다 (changed=false)', () => {
        const { map, changed } = migrateBudgetPlansMap(plans2026);
        assert.equal(changed, false);
        assert.deepEqual(Object.keys(map).sort(), ['2026_증진_여비', '2026_증진_차량운영비']);
    });

    it('22. year 필드가 없는 새 키 계획도 year가 채워진다', () => {
        const { map, changed } = migrateBudgetPlansMap({
            '2027_증진_여비': { ...plan2026b, year: undefined }
        });
        assert.equal(changed, true);
        assert.equal(map['2027_증진_여비'].year, 2027);
    });

    it('23. 부서·과목이 없는 계획은 버린다', () => {
        const { map } = migrateBudgetPlansMap({
            '증진_차량운영비': plan2026a,
            '이상한키': { department: '', budgetItem: '' }
        });
        assert.deepEqual(Object.keys(map), ['2026_증진_차량운영비']);
    });
});

describe('budgetYear - 숨김 항목 키', () => {
    it('24. normalizeHiddenItemKeys는 연도 없는 부서_과목 키를 유지한다', () => {
        assert.deepEqual(
            normalizeHiddenItemKeys(['증진_차량운영비', '증진팀_여비 외 1건', '2026_증진_차량운영비']),
            ['증진_차량운영비', '증진_여비']
        );
        assert.deepEqual(normalizeHiddenItemKeys([]), []);
    });
});

/**
 * 예산 연도(2026/2027 분리) 순수 로직.
 *
 * - 화면 표시 전용 순수 함수 모음 (저장/네트워크 부수효과 없음).
 * - 런타임 import가 없어 node --test에서 TS를 그대로 변환해 읽을 수 있다.
 *   (normalizeBudgetItem/normalizeDepartmentName을 이 파일 안에 둔 이유도 같다.
 *   BudgetPage.tsx와 proposalMatch.ts에 같은 정규화 로직이 이미 있지만,
 *   이 모듈을 의존성 없이 테스트 가능하게 두기 위해 일부러 따로 둔다.)
 */

import type { BudgetTransaction } from '../../types';

/** 연도가 없는 옛 계획 키를 읽을 때 기본으로 취급하는 연도 (2026년 데이터). */
export const LEGACY_PLAN_YEAR = 2026;

/** 계획 키에 들어갈 수 있는 연도인지 검사한다 (1900~2100). */
export function isValidYear(year: unknown): year is number {
    const y = Number(year);
    return Number.isInteger(y) && y >= 1900 && y <= 2100;
}

export interface BudgetPlanLike {
    department: string;
    budgetItem: string;
    categoryGroup?: string;
    source?: string;
    category1?: string;
    projectName?: string;
    category2?: string;
    budgetAmount?: number;
    manualEntries?: Array<{
        id?: string;
        date: string;
        writer?: string;
        amount: number | string;
        description?: string;
        isPlaceholder?: boolean;
    }>;
    order?: number;
    year?: number;
}

/**
 * 예산과목 정규화 (앞뒤 공백 제거, '외 N건' 접미사 제거).
 * proposalMatch.ts / BudgetPage.tsx의 기존 규칙과 동일하다.
 */
export function normalizeBudgetItem(name?: string): string {
    if (!name) return '';
    return name.trim().replace(/[\s\u00A0]*외[\s\u00A0]*\d+[\s\u00A0]*건.*$/, '').trim();
}

function normalizeBudgetItemBeforeSuffixOnlyRule(name: string): string {
    let normalized = name.trim();
    if (normalized.includes(' 외 ')) {
        normalized = normalized.split(' 외 ')[0].trim();
    } else {
        normalized = normalized.replace(/[\s\u00A0]*외[\s\u00A0]*\d+[\s\u00A0]*건\s*$/, '').trim();
    }
    return normalized;
}

/**
 * 부서명 정규화 (팀 이름에 들어간 키워드로 표준 부서명을 뽑는다).
 * BudgetPage.tsx의 기존 규칙과 동일하다.
 */
export function normalizeDepartmentName(name?: string): string {
    const text = (name || '').trim();
    if (!text) return '';
    if (text.includes('증진')) return '증진';
    if (text.includes('회복')) return '회복';
    if (text.includes('자살')) return '자살';
    if (text.includes('남부')) return '남부';
    if (text.includes('아동')) return '아동청소년';
    return text.replace(/팀$/, '').trim();
}

/**
 * 연도 포함 계획 키: `2026_증진_차량운영비`.
 * 부서나 과목이 비어 있거나 연도가 이상하면 ''을 반환한다 (기존 규칙 유지).
 */
export function toBudgetKey(year: number | string, department: string, item: string): string {
    const y = Number(year);
    if (!isValidYear(y)) return '';
    const dept = normalizeDepartmentName(department);
    const normalizedItem = normalizeBudgetItem(item);
    return dept && normalizedItem ? `${y}_${dept}_${normalizedItem}` : '';
}

/**
 * Key under which the plan for (year, department, item) is stored.
 * Plans saved before item names stopped being cut at ' 외 ' keep their old key, so that key wins when it holds a plan.
 */
export function resolvePlanKey(
    plans: Record<string, unknown>,
    year: number,
    department: string,
    item: string
): string {
    const key = toBudgetKey(year, department, item);
    const keyBeforeSuffixOnlyRule = toBudgetKey(year, department, normalizeBudgetItemBeforeSuffixOnlyRule(item.trim()));
    return !plans[key] && plans[keyBeforeSuffixOnlyRule] ? keyBeforeSuffixOnlyRule : key;
}

/** 연도 없는 옛 키: `증진_차량운영비` (숨김 항목 등 연도와 무관한 키에 쓴다). */
export function toBudgetKeyNoYear(department: string, item: string): string {
    const dept = normalizeDepartmentName(department);
    const normalizedItem = normalizeBudgetItem(item);
    return dept && normalizedItem ? `${dept}_${normalizedItem}` : '';
}

/**
 * 계획 키에서 연도를 뽑는다.
 * `2026_증진_차량운영비` -> 2026, 연도 없는 옛 키(`증진_차량운영비`) -> 2026.
 */
export function parsePlanYear(key: string): number {
    if (typeof key !== 'string') return LEGACY_PLAN_YEAR;
    const m = key.match(/^(\d{4})_/);
    if (m) {
        const y = Number(m[1]);
        if (isValidYear(y)) return y;
    }
    return LEGACY_PLAN_YEAR;
}

/**
 * 계획 키를 연도/부서/과목으로 나눈다.
 * 과목 이름 안에 '_'가 있으면 뒤쪽은 전부 과목으로 합친다.
 */
export function parseBudgetKey(key: string): { year: number; department: string; budgetItem: string } {
    if (typeof key !== 'string' || !key) {
        return { year: LEGACY_PLAN_YEAR, department: '', budgetItem: '' };
    }
    const parts = key.split('_');
    if (parts.length >= 3 && /^\d{4}$/.test(parts[0]) && isValidYear(Number(parts[0]))) {
        return {
            year: Number(parts[0]),
            department: parts[1] || '',
            budgetItem: parts.slice(2).join('_')
        };
    }
    return {
        year: LEGACY_PLAN_YEAR,
        department: parts[0] || '',
        budgetItem: parts.slice(1).join('_')
    };
}

/** 계획 키에서 연도 접두사(`2026_`)를 뗀다. 옛 키는 그대로 둔다. */
export function stripYearFromKey(key: string): string {
    if (typeof key !== 'string') return '';
    return key.replace(/^\d{4}_/, '');
}

/**
 * 품의 1건의 연도를 구한다.
 * year 필드가 있으면 그 값을 쓰고, 없으면 날짜(YYYY-MM-DD) 앞 4자리를 쓴다.
 * 둘 다 없으면 올해를 반환한다.
 */
export function getTransactionYear(t: BudgetTransaction | null | undefined): number {
    const currentYear = new Date().getFullYear();
    if (!t) return currentYear;
    if (isValidYear((t as { year?: unknown }).year)) return Number((t as { year?: unknown }).year);
    const dateStr = typeof t.date === 'string' ? t.date.trim() : '';
    const y = Number(dateStr.slice(0, 4));
    return isValidYear(y) ? y : currentYear;
}

/**
 * 계획 1건의 연도를 구한다.
 * plan.year가 있으면 그 값을 쓰고, 없으면 키에서 뽑는다 (옛 키는 2026).
 */
export function getPlanYear(plan: BudgetPlanLike | null | undefined, key?: string): number {
    if (plan && isValidYear(plan.year)) return Number(plan.year);
    if (key) return parsePlanYear(key);
    return LEGACY_PLAN_YEAR;
}

/** 데이터(품의+계획)에 실제로 들어 있는 연도 목록 (내림차순, 올해 제외). */
export function dataYears(
    transactions: BudgetTransaction[] | null | undefined,
    plans: Record<string, BudgetPlanLike> | null | undefined
): number[] {
    const years = new Set<number>();
    (Array.isArray(transactions) ? transactions : []).forEach(t => {
        years.add(getTransactionYear(t));
    });
    Object.entries(plans || {}).forEach(([key, plan]) => {
        years.add(getPlanYear(plan, key));
    });
    return Array.from(years).sort((a, b) => b - a);
}

/**
 * 연도 선택 버튼에 보여줄 연도 목록 (내림차순).
 * 데이터에 있는 연도 + 올해를 합친다. 빈 데이터면 올해만 나온다.
 */
export function availableYears(
    transactions: BudgetTransaction[] | null | undefined,
    plans: Record<string, BudgetPlanLike> | null | undefined
): number[] {
    const years = new Set<number>(dataYears(transactions, plans));
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
}

/**
 * 처음 보여줄 연도를 정한다.
 * 1. 저장된 연도가 있으면 그 연도 (사용자 선택이 최우선).
 * 2. 올해 데이터가 있으면 올해.
 * 3. 올해 데이터가 없으면 데이터가 있는 가장 최근 해 (1월 1일에 갑자기 빈 화면이 뜨지 않게).
 * 4. 데이터가 아예 없으면 올해.
 */
export function resolveInitialYear(
    transactions: BudgetTransaction[] | null | undefined,
    plans: Record<string, BudgetPlanLike> | null | undefined,
    storedYear?: number | null
): number {
    const currentYear = new Date().getFullYear();
    if (isValidYear(storedYear)) return Number(storedYear);
    const years = dataYears(transactions, plans);
    if (years.length === 0) return currentYear;
    if (years.includes(currentYear)) return currentYear;
    return years[0];
}

/** 해당 연도의 계획이 몇 개인지 센다. */
export function countPlansForYear(
    plans: Record<string, BudgetPlanLike> | null | undefined,
    year: number
): number {
    return Object.entries(plans || {}).filter(([key, plan]) => getPlanYear(plan, key) === year).length;
}

/**
 * 복사 원본 연도를 찾는다: 선택 연도보다 1년 전 중 계획이 있는 가장 최근 해.
 * 없으면 null (복사 버튼을 보여주지 않는다).
 */
export function findLatestYearWithPlans(
    plans: Record<string, BudgetPlanLike> | null | undefined,
    beforeYear: number
): number | null {
    const years = dataYears([], plans).filter(y => y < beforeYear);
    return years.length > 0 ? years[0] : null;
}

/**
 * 원본 연도 계획들의 구조만 새 연도로 복사한다 (금액 0, 수기 내역 빈 배열, 이월 없음).
 * - 복사 대상: 원본 연도의 계획 전부.
 * - 복사 내용: department/budgetItem/categoryGroup/source/category1/projectName/category2/order는 그대로.
 * - budgetAmount는 0, manualEntries는 빈 배열, year는 새 연도로 둔다.
 * - 원본은 바꾸지 않는다. 새 연도에 이미 같은 과목 계획이 있으면 그 과목은 건너뛴다.
 * - 반환값은 복사된 계획들만 담은 맵 (호출하는 쪽에서 기존 맵에 합친다).
 */
export function copyPlansToYear<T extends BudgetPlanLike>(
    plans: Record<string, T> | null | undefined,
    fromYear: number,
    toYear: number
): Record<string, T> {
    const copied: Record<string, T> = {};
    const source = plans || {};
    Object.entries(source).forEach(([key, plan]) => {
        if (!plan || getPlanYear(plan, key) !== fromYear) return;
        const newKey = toBudgetKey(toYear, plan.department, plan.budgetItem);
        if (!newKey || source[newKey] || copied[newKey]) return;
        copied[newKey] = {
            ...plan,
            year: toYear,
            budgetAmount: 0,
            manualEntries: []
        };
    });
    return copied;
}

/**
 * 계획 맵을 연도 포함 키로 이전한다.
 * - 연도 없는 옛 키(`증진_차량운영비`)는 2026년 키(`2026_증진_차량운영비`)로 바꾼다.
 * - 각 계획에 year를 채우고, 부서/과목은 키에서 다시 뽑아 정규화한다.
 * - categoryGroup/category2/budgetAmount/manualEntries 기본값도 채운다.
 * - changed가 true면 키가 하나라도 바뀌었거나 year가 새로 채워졌다는 뜻이다.
 */
export function migrateBudgetPlansMap<T extends BudgetPlanLike>(
    plans: Record<string, T> | null | undefined
): { map: Record<string, T>; changed: boolean } {
    const map: Record<string, T> = {};
    let changed = false;
    Object.entries(plans || {}).forEach(([key, plan]) => {
        if (!plan || !plan.department || !plan.budgetItem) return;
        const year = getPlanYear(plan, key);
        const newKey = toBudgetKey(year, plan.department, plan.budgetItem);
        if (!newKey) return;
        if (newKey !== key) changed = true;
        if (!isValidYear(plan.year)) changed = true;
        const parsed = parseBudgetKey(newKey);
        const normalizedPlan = {
            ...plan,
            year,
            department: parsed.department,
            budgetItem: parsed.budgetItem,
            categoryGroup: plan.categoryGroup || '미지정',
            category2: plan.category2 || parsed.budgetItem,
            budgetAmount: Number(plan.budgetAmount) || 0,
            manualEntries: Array.isArray(plan.manualEntries) ? plan.manualEntries : []
        };
        const collidingPlan = map[newKey];
        if (collidingPlan) changed = true;
        map[newKey] = collidingPlan
            ? {
                ...normalizedPlan,
                ...collidingPlan,
                budgetAmount: collidingPlan.budgetAmount || normalizedPlan.budgetAmount,
                manualEntries: [...(collidingPlan.manualEntries || []), ...normalizedPlan.manualEntries]
            }
            : normalizedPlan;
    });
    return { map, changed };
}

/**
 * 숨김 항목 키 목록을 정규화한다 (연도와 무관한 `부서_과목` 형태 유지).
 * BudgetPage.tsx의 기존 규칙과 동일하다.
 */
export function normalizeHiddenItemKeys(hidden: string[]): string[] {
    if (!Array.isArray(hidden)) return [];
    const normalized = hidden
        .map((key) => {
            if (typeof key !== 'string') return '';
            // 연도 접두사가 붙어 들어와도 떼어낸 뒤 부서_과목으로 정규화한다.
            const baseKey = stripYearFromKey(key);
            const idx = baseKey.indexOf('_');
            if (idx < 1) return '';
            return toBudgetKeyNoYear(baseKey.slice(0, idx), baseKey.slice(idx + 1));
        })
        .filter(Boolean);
    return Array.from(new Set(normalized));
}

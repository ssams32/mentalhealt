export interface BudgetTreeNode {
    id: string;
    name: string;
    amount: number;
    type: 'root' | 'hang' | 'mok' | 'semok' | 'detail';
    children?: BudgetTreeNode[];
}

export type DropPosition = 'before' | 'inside' | 'after';

export interface MoveResult<T extends BudgetTreeNode> {
    ok: boolean;
    tree: T[];
    message: string;
}

interface Located {
    node: BudgetTreeNode;
    siblings: BudgetTreeNode[];
    parent: BudgetTreeNode | null;
    level: number;
}

const GROUP_LEVEL = 1;
const PARENT_ITEM_LEVEL = 2;
const CHILD_ITEM_LEVEL = 3;
const LOOSE_GROUP_PREFIX = 'loose-';

function locate(tree: BudgetTreeNode[], id: string): Located | null {
    const search = (siblings: BudgetTreeNode[], parent: BudgetTreeNode | null, level: number): Located | null => {
        for (const node of siblings) {
            const isGroup = level === GROUP_LEVEL && node.type === 'hang';
            const nodeLevel = level === GROUP_LEVEL && !isGroup ? PARENT_ITEM_LEVEL : level;
            if (node.id === id) return { node, siblings, parent, level: nodeLevel };
            const found = search(node.children || [], node, nodeLevel + 1);
            if (found) return found;
        }
        return null;
    };
    return search(tree, null, 0);
}

function isDescendant(ancestor: BudgetTreeNode, id: string): boolean {
    return (ancestor.children || []).some(child => child.id === id || isDescendant(child, id));
}

/**
 * Drag-and-drop move for the 3-level budget tree (department > group > parent item > child item).
 * Never mutates `tree`; on rejection returns it unchanged with ok=false.
 * - Dropping on a group header (a `hang` node or `loose-<departmentId>`) always moves inside the group as a parent item.
 * - Dropping inside a parent item makes the source its child item; a source that has children is rejected.
 * - Dropping before/after an item makes the source its sibling at that item's level.
 * - A node cannot be moved into itself or its own descendants.
 */
export function moveNode<T extends BudgetTreeNode>(
    tree: T[],
    sourceId: string,
    targetId: string,
    position: DropPosition
): MoveResult<T> {
    const reject = (message: string): MoveResult<T> => ({ ok: false, tree, message });

    const next = JSON.parse(JSON.stringify(tree)) as BudgetTreeNode[];
    const containerId = targetId.startsWith(LOOSE_GROUP_PREFIX) ? targetId.slice(LOOSE_GROUP_PREFIX.length) : targetId;
    const source = locate(next, sourceId);
    const target = locate(next, containerId);

    if (!source || !target) return reject('옮길 항목이나 놓을 위치를 찾지 못했습니다.');
    if (source.level < PARENT_ITEM_LEVEL) return reject('부서와 그룹은 끌어서 옮길 수 없습니다.');
    if (sourceId === containerId || isDescendant(source.node, containerId)) {
        return reject('자신이나 자신의 하위 항목으로 이동할 수 없습니다.');
    }
    if (target.level > CHILD_ITEM_LEVEL) return reject('이 위치에는 놓을 수 없습니다.');

    const dropsIntoGroup = target.level <= GROUP_LEVEL;
    const dropsIntoParentItem = target.level === PARENT_ITEM_LEVEL && position === 'inside';
    const insertsInside = dropsIntoGroup || dropsIntoParentItem;
    const newLevel = dropsIntoGroup ? PARENT_ITEM_LEVEL : dropsIntoParentItem ? CHILD_ITEM_LEVEL : target.level;
    const moved = source.node;

    if (newLevel === CHILD_ITEM_LEVEL && (moved.children || []).length > 0) {
        return reject(`'${moved.name}'에 새끼 항목이 있어 다른 어미 항목 아래로 넣을 수 없습니다. 새끼 항목을 먼저 옮겨 주세요.`);
    }

    source.siblings.splice(source.siblings.indexOf(moved), 1);

    if (newLevel === PARENT_ITEM_LEVEL) moved.type = 'mok';
    else if (moved.type === 'mok') moved.type = 'semok';

    if (insertsInside) {
        target.node.children = [...(target.node.children || []), moved];
    } else {
        const targetIndex = target.siblings.indexOf(target.node);
        target.siblings.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, moved);
    }

    const newParentName = insertsInside
        ? (targetId.startsWith(LOOSE_GROUP_PREFIX) ? '미지정' : target.node.name)
        : (target.parent ? target.parent.name : '');
    const message = newLevel === source.level && !insertsInside
        ? `'${moved.name}' 항목의 순서를 바꿨습니다.`
        : newLevel === PARENT_ITEM_LEVEL
            ? `'${moved.name}' 항목이 '${newParentName}'의 어미 항목으로 이동되었습니다.`
            : `'${moved.name}' 항목이 어미 항목 '${newParentName}'의 새끼 항목으로 이동되었습니다.`;

    return { ok: true, tree: next as T[], message };
}

/**
 * Budget amount of a node: the sum of its children when that sum is non-zero, otherwise its own amount.
 * A parent's own amount is never added on top of its children.
 */
export function rollupAmount(ownAmount: number, childAmounts: number[]): number {
    const childSum = childAmounts.reduce((sum, amount) => sum + amount, 0);
    return childSum !== 0 ? childSum : ownAmount;
}

export function balanceAndRatio(amount: number, execution: number): { balance: number; ratio: number } {
    return { balance: amount - execution, ratio: amount > 0 ? (execution / amount) * 100 : 0 };
}

/**
 * A node's own budget amount for the selected year (before any rollup of its children).
 * The hierarchy amount is the pre-year-split store, i.e. the legacy year's amount, so it is used when the
 * selected year has no plan, or when the legacy year's plan amount is still the default 0.
 */
export function resolveOwnAmount(
    plan: { budgetAmount?: number } | undefined,
    hierarchyAmount: number,
    isLegacyYear: boolean
): number {
    if (!plan) return hierarchyAmount;
    if (plan.budgetAmount) return plan.budgetAmount;
    return isLegacyYear ? hierarchyAmount : 0;
}

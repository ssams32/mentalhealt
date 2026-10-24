/**
 * server/assets/assetStateMachine.js — Stage 1 + Stage 2
 * utils/assetStateMachines.ts의 운영 상태 전이표를 Node(Express)에서 쓰기 위해
 * JS로 미러링한 것이다. 원본 전이 규칙과 동일하며, 규칙 변경 시 양쪽을 함께 고친다.
 * Stage 2 추가: 배치도 AABB 검증(utils/assetIsometric.ts 미러),
 * 재물조사 제출 검증·승인 판정(utils/assetStateMachines.ts + 원본 inventory.ts 미러).
 */

export const OPERATIONAL_STATUSES = [
    'IN_USE', 'IN_STORAGE', 'RENTED', 'REPAIRING', 'EXTERNAL_OUT',
    'DISPOSAL_PLANNED', 'DISPOSED', 'LOST', 'UNVERIFIED',
];

const ALLOWED_OPERATIONAL_TRANSITIONS = {
    IN_USE: ['IN_STORAGE', 'RENTED', 'REPAIRING', 'EXTERNAL_OUT', 'DISPOSAL_PLANNED', 'LOST', 'UNVERIFIED'],
    IN_STORAGE: ['IN_USE', 'RENTED', 'REPAIRING', 'DISPOSAL_PLANNED', 'LOST'],
    RENTED: ['IN_STORAGE', 'IN_USE', 'REPAIRING', 'LOST'],
    REPAIRING: ['IN_USE', 'IN_STORAGE', 'EXTERNAL_OUT', 'DISPOSAL_PLANNED'],
    EXTERNAL_OUT: ['IN_USE', 'IN_STORAGE', 'REPAIRING', 'DISPOSAL_PLANNED', 'LOST'],
    DISPOSAL_PLANNED: ['DISPOSED', 'IN_STORAGE'],
    DISPOSED: [], // Terminal state
    LOST: ['IN_USE', 'IN_STORAGE', 'DISPOSED'],
    UNVERIFIED: ['IN_USE', 'IN_STORAGE', 'REPAIRING', 'LOST', 'DISPOSAL_PLANNED'],
};

export function canTransitionOperationalStatus(from, to) {
    if (from === to) return true;
    const allowed = ALLOWED_OPERATIONAL_TRANSITIONS[from];
    return Array.isArray(allowed) ? allowed.includes(to) : false;
}

/** 공간 계층: kind -> 허용 부모 kind (null = 최상위). */
export const SPACE_PARENT_KIND = {
    site: null,
    building: 'site',
    floor: 'building',
    room: 'floor',
    zone: 'room',
    furniture: 'room', // 가구는 사무실 소속이며, 구역(zoneId)은 별도 선택 필드
};

export const SPACE_KINDS = Object.keys(SPACE_PARENT_KIND);

/** ---- Stage 2: 배치도 AABB 검증 (utils/assetIsometric.ts의 validateFloorPlanLayout 미러) ---- */

export function getEffectiveDimensions(obj) {
    const isRotated = obj.rotationDeg === 90 || obj.rotationDeg === 270;
    return {
        effWidth: isRotated ? obj.depthCells : obj.widthCells,
        effDepth: isRotated ? obj.widthCells : obj.depthCells,
    };
}

export function validateFloorPlanLayout(roomGridWidth, roomGridDepth, objects) {
    const outOfBoundsIds = [];
    const collisionPairs = [];
    for (const obj of objects) {
        const { effWidth, effDepth } = getEffectiveDimensions(obj);
        if (obj.coordX < 0 || obj.coordY < 0 || obj.coordX + effWidth > roomGridWidth || obj.coordY + effDepth > roomGridDepth) {
            outOfBoundsIds.push(obj.id);
        }
    }
    for (let i = 0; i < objects.length; i++) {
        for (let j = i + 1; j < objects.length; j++) {
            const a = objects[i];
            const b = objects[j];
            if (a.zLayer !== b.zLayer) continue;
            const dimA = getEffectiveDimensions(a);
            const dimB = getEffectiveDimensions(b);
            const overlapX = a.coordX < b.coordX + dimB.effWidth && a.coordX + dimA.effWidth > b.coordX;
            const overlapY = a.coordY < b.coordY + dimB.effDepth && a.coordY + dimA.effDepth > b.coordY;
            if (overlapX && overlapY) collisionPairs.push([a.id, b.id]);
        }
    }
    return { valid: outOfBoundsIds.length === 0 && collisionPairs.length === 0, outOfBoundsIds, collisionPairs };
}

/** 동일 가구(furnitureId)를 두 번 이상 배치하면 게시 차단 (원본 floor-plan.ts 미러). */
export function findDuplicateFurnitureIds(objects) {
    const seen = new Map();
    for (const o of objects) {
        if (o.objectType !== 'FURNITURE' || !o.furnitureId) continue;
        seen.set(o.furnitureId, (seen.get(o.furnitureId) || 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

export const FLOOR_PLAN_OBJECT_TYPES = ['FURNITURE', 'STANDALONE_ASSET', 'ZONE_BOUNDARY', 'STRUCTURE_WALL', 'STRUCTURE_DOOR'];
export const FLOOR_PLAN_ROTATIONS = [0, 90, 180, 270];

/** ---- Stage 2: 재물조사 (utils/assetStateMachines.ts + 원본 inventory.ts 미러) ---- */

export const INVENTORY_RESULT_STATUSES = [
    'NORMAL', 'LOCATION_MISMATCH', 'INFO_MISMATCH', 'REPAIR_NEEDED', 'DAMAGED',
    'LOST_SUSPECTED', 'QR_DAMAGED', 'QR_MISATTACHED', 'DUPLICATE_SUSPECTED',
    'UNCHECKED', 'UNVERIFIABLE',
];

export const INVENTORY_PROCESS_STATUSES = [
    'UNCHECKED', 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED',
    'RECHECK_REQUESTED', 'ACTION_COMPLETED', 'EXCLUDED',
];

export const FOLLOW_UP_ACTIONS = [
    'NONE', 'UPDATE_OFFICIAL_LOCATION', 'RESTORE_ORIGINAL_LOCATION',
    'REQUEST_REPAIR', 'MARK_LOST_SUSPECT', 'REISSUE_QR',
];

export function validateInventorySubmissionRules(input) {
    const errors = [];
    if (!input.isLocationMatched && input.resultStatus === 'NORMAL') {
        errors.push('위치 불일치(isLocationMatched=false)인 경우 조사 결과를 정상 확인(NORMAL)으로 선택할 수 없습니다.');
    }
    if (!input.isLocationMatched && !input.actualRoomId) {
        errors.push('위치 불일치 보고 시 실제 확인한 사무실(actualRoomId)을 반드시 선택해야 합니다.');
    }
    if (input.resultStatus === 'LOST_SUSPECTED' && input.isQrScanned) {
        errors.push('분실 의심(LOST_SUSPECTED) 자산은 현물 QR 스캔(isQrScanned=true)과 동시에 성립할 수 없습니다.');
    }
    if ((input.resultStatus === 'QR_MISATTACHED' || input.resultStatus === 'INFO_MISMATCH')
        && (!input.memo || String(input.memo).trim().length < 2)) {
        errors.push('QR 오부착 의심 또는 정보 불일치 선택 시 상세 메모를 필수로 입력해야 합니다.');
    }
    return { valid: errors.length === 0, errors };
}

export function normalizeReviewDecision(raw) {
    if (raw === 'APPROVE') return 'APPROVE';
    if (raw === 'REJECT' || raw === 'REJECTED') return 'REJECT';
    if (raw === 'RECHECK_REQUESTED') return 'RECHECK_REQUESTED';
    return null;
}

export function canApplyOfficialLocationUpdate(decision, followUpAction) {
    return decision === 'APPROVE' && followUpAction === 'UPDATE_OFFICIAL_LOCATION';
}

export function computeInventoryProgress(targets) {
    if (!targets.length) return 0;
    const processed = targets.filter((t) => t.status !== 'UNCHECKED' && t.status !== 'DRAFT').length;
    return Math.round((processed / targets.length) * 1000) / 10;
}

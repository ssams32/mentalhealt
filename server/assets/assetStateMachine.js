/**
 * server/assets/assetStateMachine.js — Stage 1
 * utils/assetStateMachines.ts의 운영 상태 전이표를 Node(Express)에서 쓰기 위해
 * JS로 미러링한 것이다. 원본 전이 규칙과 동일하며, 규칙 변경 시 양쪽을 함께 고친다.
 * 조사 결과/처리 상태 검증은 Stage 2(재물조사)에서 이 파일에 추가한다.
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

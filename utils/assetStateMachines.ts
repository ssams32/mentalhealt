/**
 * assetStateMachines.ts — Stage 1 이식본 (로직 무변경)
 * 원본: ~/workspace/office-asset-fullstack/src/lib/state-machines.ts
 * 운영 상태 9종 + 조사 결과 상태 11종 + 조사 처리 상태 9종.
 * 서버(Express)는 Node에서 TS를 직접 import할 수 없으므로,
 * server/assets/assetStateMachine.js에 동일한 전이표를 JS로 미러링해 두었다.
 * 전이 규칙을 바꿀 때는 양쪽을 함께 고쳐야 한다.
 */

export type OperationalStatus =
  | 'IN_USE'
  | 'IN_STORAGE'
  | 'RENTED'
  | 'REPAIRING'
  | 'EXTERNAL_OUT'
  | 'DISPOSAL_PLANNED'
  | 'DISPOSED'
  | 'LOST'
  | 'UNVERIFIED';

export type InventoryResultStatus =
  | 'NORMAL'
  | 'LOCATION_MISMATCH'
  | 'INFO_MISMATCH'
  | 'REPAIR_NEEDED'
  | 'DAMAGED'
  | 'LOST_SUSPECTED'
  | 'QR_DAMAGED'
  | 'QR_MISATTACHED'
  | 'DUPLICATE_SUSPECTED'
  | 'UNCHECKED'
  | 'UNVERIFIABLE';

export type InventoryProcessStatus =
  | 'UNCHECKED'
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'RECHECK_REQUESTED'
  | 'ACTION_COMPLETED'
  | 'EXCLUDED';

export const OPERATIONAL_STATUSES: OperationalStatus[] = [
  'IN_USE', 'IN_STORAGE', 'RENTED', 'REPAIRING', 'EXTERNAL_OUT',
  'DISPOSAL_PLANNED', 'DISPOSED', 'LOST', 'UNVERIFIED',
];

const ALLOWED_OPERATIONAL_TRANSITIONS: Record<OperationalStatus, OperationalStatus[]> = {
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

export function canTransitionOperationalStatus(
  from: OperationalStatus,
  to: OperationalStatus
): boolean {
  if (from === to) return true;
  return ALLOWED_OPERATIONAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validateInventorySubmissionRules(input: {
  isLocationMatched: boolean;
  resultStatus: InventoryResultStatus;
  isQrScanned: boolean;
  actualRoomId?: string | null;
  memo?: string | null;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!input.isLocationMatched && input.resultStatus === 'NORMAL') {
    errors.push('위치 불일치(isLocationMatched=false)인 경우 조사 결과를 정상 확인(NORMAL)으로 선택할 수 없습니다.');
  }

  if (!input.isLocationMatched && !input.actualRoomId) {
    errors.push('위치 불일치 보고 시 실제 확인한 사무실(actualRoomId)을 반드시 선택해야 합니다.');
  }

  if (input.resultStatus === 'LOST_SUSPECTED' && input.isQrScanned) {
    errors.push('분실 의심(LOST_SUSPECTED) 자산은 현물 QR 스캔(isQrScanned=true)과 동시에 성립할 수 없습니다.');
  }

  if (
    (input.resultStatus === 'QR_MISATTACHED' || input.resultStatus === 'INFO_MISMATCH') &&
    (!input.memo || input.memo.trim().length < 2)
  ) {
    errors.push('QR 오부착 의심 또는 정보 불일치 선택 시 상세 메모를 필수로 입력해야 합니다.');
  }

  return { valid: errors.length === 0, errors };
}

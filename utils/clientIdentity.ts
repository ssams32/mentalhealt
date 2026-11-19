/**
 * 대상자 식별·중복 판정 (CLAUDE.md §1, §2)
 *
 * - 대상자 식별: [이름, 연령, 연락처] 복합키
 * - 중복 판정: 복합키 + 의뢰날짜가 모두 같으면 "이미 등록된 같은 의뢰"
 * - 알림: 같은 대상자(복합키 일치)인데 의뢰날짜가 다르면 재의뢰로 보고 알림
 *
 * 순수 함수만 둔다(서버 호출·저장 없음).
 */

export interface ClientLike {
    name?: string | null;
    age?: string | number | null;
    phone?: string | null;
    requestDate?: string | null;
    registrationDate?: string | null;
}

/** 이름: 앞뒤·중간 공백 제거 */
export function normalizeName(name: unknown): string {
    return String(name ?? '').replace(/\s+/g, '');
}

/** 연령: 양의 정수만 인정, 그 외는 null */
export function normalizeAge(age: unknown): number | null {
    const n = Number(String(age ?? '').replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** 연락처: 숫자만 */
export function normalizePhone(phone: unknown): string {
    return String(phone ?? '').replace(/[^0-9]/g, '');
}

/** 날짜: 'YYYY-MM-DD' 로 정규화 (YYYY.MM.DD, YYYY/MM/DD, ISO 시각 포함 허용). 실패 시 '' */
export function normalizeDate(value: unknown): string {
    const m = String(value ?? '').trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 복합키. 세 값 중 하나라도 없으면 null (식별 불가 → 같은 사람으로 단정하지 않음) */
export function getClientCompositeKey(client: ClientLike): string | null {
    const name = normalizeName(client.name);
    const age = normalizeAge(client.age);
    const phone = normalizePhone(client.phone);
    if (!name || age === null || !phone) return null;
    return `${name}|${age}|${phone}`;
}

export type ReferralMatchKind = 'new' | 'duplicate' | 're-referral';

export interface ReferralMatchResult<T> {
    kind: ReferralMatchKind;
    /** 복합키가 같은 기존 기록 (duplicate면 날짜까지 같은 기록) */
    match?: T;
}

/**
 * 들어온 의뢰를 기존 기록과 비교한다.
 * - 'duplicate'  : 복합키와 의뢰날짜가 모두 같은 기록이 있음 (알림 불필요)
 * - 're-referral': 복합키는 같은데 의뢰날짜가 다름 (알림 대상)
 * - 'new'        : 같은 대상자를 찾지 못함 (신규 접수로 표시)
 */
export function classifyIncomingReferral<T extends ClientLike>(
    incoming: ClientLike,
    existing: T[],
): ReferralMatchResult<T> {
    const key = getClientCompositeKey(incoming);
    if (!key) return { kind: 'new' };

    const sameClient = existing.filter(r => r && getClientCompositeKey(r) === key);
    if (sameClient.length === 0) return { kind: 'new' };

    const incomingDate = normalizeDate(incoming.requestDate || incoming.registrationDate);
    const sameDate = incomingDate
        ? sameClient.find(r => normalizeDate(r.requestDate || r.registrationDate) === incomingDate)
        : undefined;
    if (sameDate) return { kind: 'duplicate', match: sameDate };

    return { kind: 're-referral', match: sameClient[0] };
}

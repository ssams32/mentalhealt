export interface ClientLike {
    name?: string | null;
    age?: string | number | null;
    phone?: string | null;
    requestDate?: string | null;
    registrationDate?: string | null;
}

export function normalizeName(name: unknown): string {
    return String(name ?? '').replace(/\s+/g, '');
}

export function normalizeAge(age: unknown): number | null {
    const n = Number(String(age ?? '').replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePhone(phone: unknown): string {
    return String(phone ?? '').replace(/[^0-9]/g, '');
}

export function normalizeDate(value: unknown): string {
    const m = String(value ?? '').trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

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
    match?: T;
}

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

export type ReferralStatusFilter = 'all' | 'ongoing' | 'closed';

export interface StatusFilterableReferral {
    closureStatus?: string | null;
}

export function matchesStatusFilter(
    referral: StatusFilterableReferral,
    statusFilter: ReferralStatusFilter
): boolean {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'ongoing') return referral.closureStatus === '미종결';
    return referral.closureStatus !== '미종결';
}

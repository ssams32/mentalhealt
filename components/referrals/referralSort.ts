import type { Referral } from '../../types';

/**
 * 의뢰대장 대상자 리스트 정렬 비교자.
 *
 * 의뢰접수일(requestDate) 내림차순(최신 먼저)이 유일한 기준이다.
 * 종결 여부나 미등록 여부는 정렬에 쓰지 않는다 — 오래된 미등록 의뢰가
 * 최신 등록 의뢰보다 위에 올라오던 문제를 고치기 위해서다.
 * 날짜가 없거나 잘못된 값이면 맨 뒤로 보낸다(0으로 취급).
 * 날짜가 같으면 의뢰번호 내림차순.
 */
export function compareReferralsByRequestDate(a: Referral, b: Referral): number {
    const toTime = (d: string | undefined): number => {
        if (!d) return 0;
        const t = new Date(d).getTime();
        return Number.isNaN(t) ? 0 : t;
    };
    const dateA = toTime(a.requestDate);
    const dateB = toTime(b.requestDate);
    if (dateA !== dateB) return dateB - dateA;

    const refA = a.refNo || '';
    const refB = b.refNo || '';
    return refB.localeCompare(refA);
}

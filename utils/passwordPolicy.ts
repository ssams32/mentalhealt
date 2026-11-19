export const PASSWORD_RECOMMENDED_MIN_LENGTH = 8;

export const PASSWORD_RECOMMENDATION_TEXT =
    `영문과 숫자를 섞어 ${PASSWORD_RECOMMENDED_MIN_LENGTH}자 이상(특수문자 포함 권장)으로 정해 주세요.`;

export function getPasswordWeaknesses(password: string): string[] {
    const pw = password ?? '';
    const reasons: string[] = [];
    if (pw.length < PASSWORD_RECOMMENDED_MIN_LENGTH) {
        reasons.push(`${PASSWORD_RECOMMENDED_MIN_LENGTH}자 미만`);
    }
    if (/^\d+$/.test(pw)) {
        reasons.push('숫자로만 구성');
    } else {
        if (!/[A-Za-z]/.test(pw)) reasons.push('영문자 없음');
        if (!/\d/.test(pw)) reasons.push('숫자 없음');
    }
    return reasons;
}

export function isPasswordChangeRecommended(password: string): boolean {
    return getPasswordWeaknesses(password).length > 0;
}

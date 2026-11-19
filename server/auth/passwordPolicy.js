export const PASSWORD_RECOMMENDED_MIN_LENGTH = 8;

export function getPasswordWeaknesses(password) {
    const pw = typeof password === 'string' ? password : String(password ?? '');
    const reasons = [];
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

export function isPasswordChangeRecommended(password) {
    return getPasswordWeaknesses(password).length > 0;
}

/**
 * server/auth/passwordPolicy.js
 *
 * 비밀번호 "권장" 정책. 기존 비밀번호를 거부하거나 강제로 바꾸게 하지 않고,
 * 단순한 비밀번호(숫자만, 8자 미만 등)인 경우 변경을 권장하는 용도로만 쓴다.
 * 프론트엔드 utils/passwordPolicy.ts 와 같은 규칙을 유지해야 한다.
 */

export const PASSWORD_RECOMMENDED_MIN_LENGTH = 8;

/**
 * @param {unknown} password
 * @returns {string[]} 권장 기준에 못 미치는 이유 목록 (빈 배열이면 충분히 복잡함)
 */
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

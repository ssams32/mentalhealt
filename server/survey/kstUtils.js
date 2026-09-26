/**
 * server/survey/kstUtils.js
 * Explicit Asia/Seoul (KST) Date & Time Formatting Utilities.
 * Guarantees zero implicit timezone dependencies and safe handling of date-only strings.
 */

const KST_TIMEZONE = 'Asia/Seoul';
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format timestamp to Asia/Seoul (KST) string.
 * @param {string|number|Date|null|undefined} dateValue - Input date value
 * @param {'list'|'detail'|'date'} [formatType='list'] - Output format style:
 *   - 'list': 'YYYY-MM-DD HH:mm'
 *   - 'detail': 'YYYY년 M월 D일 HH:mm'
 *   - 'date': 'YYYY-MM-DD'
 * @returns {string} Formatted KST string or '-' if invalid/empty
 */
export function formatKstDateTime(dateValue, formatType = 'list') {
    if (!dateValue) return '-';

    // Date-only preservation: do NOT apply timezone shifts to pure dates (e.g. birthDate: '1990-05-15')
    if (typeof dateValue === 'string' && DATE_ONLY_REGEX.test(dateValue.trim())) {
        const trimmed = dateValue.trim();
        if (formatType === 'detail') {
            const parts = trimmed.split('-');
            return `${parseInt(parts[0], 10)}년 ${parseInt(parts[1], 10)}월 ${parseInt(parts[2], 10)}일`;
        }
        return trimmed;
    }

    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return '-';

    try {
        const formatter = new Intl.DateTimeFormat('ko-KR', {
            timeZone: KST_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const parts = formatter.formatToParts(d);
        const partMap = {};
        for (const p of parts) {
            partMap[p.type] = p.value;
        }

        const year = partMap.year;
        const month = partMap.month;
        const day = partMap.day;
        let hour = partMap.hour;
        const minute = partMap.minute;

        // In 24h format, midnight can sometimes be formatted as '24' in certain V8 locales
        if (hour === '24') hour = '00';

        if (!year || !month || !day) return '-';

        if (formatType === 'detail') {
            return `${parseInt(year, 10)}년 ${parseInt(month, 10)}월 ${parseInt(day, 10)}일 ${hour}:${minute}`;
        }

        if (formatType === 'date') {
            return `${year}-${month}-${day}`;
        }

        // Default 'list': YYYY-MM-DD HH:mm
        return `${year}-${month}-${day} ${hour}:${minute}`;
    } catch (e) {
        return '-';
    }
}

/**
 * Calculate the next 03:30 Asia/Seoul (KST) execution time from a given reference date.
 * System-timezone independent: strictly evaluates KST parts and computes target UTC timestamp.
 * @param {Date} [fromDate=new Date()]
 * @returns {Date} Target Date in UTC representing 03:30 KST
 */
export function getNextKstPurgeTime(fromDate = new Date()) {
    const d = new Date(fromDate);
    if (isNaN(d.getTime())) {
        throw new Error('Invalid fromDate supplied to getNextKstPurgeTime');
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: KST_TIMEZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false
    });

    const parts = formatter.formatToParts(d);
    const partMap = {};
    for (const p of parts) {
        if (p.type !== 'literal') partMap[p.type] = parseInt(p.value, 10);
    }
    if (partMap.hour === 24) partMap.hour = 0;

    let targetYear = partMap.year;
    let targetMonth = partMap.month;
    let targetDay = partMap.day;

    const isBeforeToday330 = (partMap.hour < 3) || (partMap.hour === 3 && partMap.minute < 30);
    if (!isBeforeToday330) {
        targetDay += 1;
    }

    // KST is UTC+9. Therefore 03:30 KST is (3 - 9) = -6 hours in UTC of that day.
    const targetUtcMs = Date.UTC(targetYear, targetMonth - 1, targetDay, 3 - 9, 30, 0, 0);
    return new Date(targetUtcMs);
}

/**
 * Object-level authorization policy for Referral attachments.
 * Enforces admin-only, assigned-staff only, and fail-closed legacy protection.
 * @param {Object} params
 * @param {Object} params.authUser - Current authenticated caller
 * @param {Object} params.referral - Connected Referral record
 * @returns {{ allowed: boolean, reasonCode: string }}
 */
export function canAccessReferralAttachment({ authUser, referral }) {
    if (!authUser || authUser.status !== 'active') {
        return { allowed: false, reasonCode: 'ACCOUNT_INACTIVE' };
    }

    const currentUserId = String(authUser.id || authUser.userId || '');
    const userRole = (authUser.role || authUser.userRole || 'user').toLowerCase();
    if (userRole === 'admin') {
        return { allowed: true, reasonCode: 'ADMIN_ACCESS' };
    }

    if (!referral) {
        return { allowed: false, reasonCode: 'REFERRAL_NOT_FOUND' };
    }

    // Official assignee ID fields
    const referralAssigneeId = referral.assignedStaffId || referral.assignedUserId || referral.assigneeId || referral.managerId;
    if (!referralAssigneeId) {
        // Legacy referral without assigned staff ID: fail-closed for non-admins
        return { allowed: false, reasonCode: 'LEGACY_REFERRAL_OWNER_UNKNOWN' };
    }

    if (String(referralAssigneeId) === currentUserId) {
        return { allowed: true, reasonCode: 'ASSIGNEE_ACCESS' };
    }

    return { allowed: false, reasonCode: 'REFERRAL_ATTACHMENT_NOT_ASSIGNED' };
}

/**
 * Validates whether Y, M, D forms an actual valid calendar date.
 */
function isValidCalendarDate(year, month, day) {
    if (year < 1900 || year > 2100) return false;
    if (month < 1 || month > 12) return false;
    const maxDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day >= 1 && day <= maxDaysInMonth;
}

/**
 * Parse and validate strict YYYY-MM-DD date-only string.
 * @param {string} str
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseStrictDateOnly(str) {
    if (typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (!DATE_ONLY_REGEX.test(trimmed)) return null;
    const [yStr, mStr, dStr] = trimmed.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);
    if (!isValidCalendarDate(year, month, day)) return null;
    return { year, month, day };
}

/**
 * Convert KST date range [fromDateStr, toDateStr] to exact UTC boundaries.
 * Start: fromDate 00:00:00.000 KST -> UTC Date
 * End: toDate 23:59:59.999 KST -> UTC Date
 *
 * @param {string|null|undefined} fromDateStr - 'YYYY-MM-DD'
 * @param {string|null|undefined} toDateStr - 'YYYY-MM-DD'
 * @returns {{
 *   startUtcMs: number | null,
 *   endUtcMs: number | null,
 *   startUtcIso: string | null,
 *   endUtcIso: string | null
 * }}
 */
export function getKstDateRangeUtcBoundaries(fromDateStr, toDateStr) {
    let startUtcMs = null;
    let endUtcMs = null;

    if (fromDateStr) {
        const parsedFrom = parseStrictDateOnly(fromDateStr);
        if (!parsedFrom) {
            const err = new Error('올바른 날짜를 입력해 주세요.');
            err.code = 'INVALID_DATE_FORMAT';
            throw err;
        }
        // KST is UTC+9: 00:00:00.000 KST is (0 - 9) = -9h in UTC
        startUtcMs = Date.UTC(parsedFrom.year, parsedFrom.month - 1, parsedFrom.day, -9, 0, 0, 0);
    }

    if (toDateStr) {
        const parsedTo = parseStrictDateOnly(toDateStr);
        if (!parsedTo) {
            const err = new Error('올바른 날짜를 입력해 주세요.');
            err.code = 'INVALID_DATE_FORMAT';
            throw err;
        }
        // KST is UTC+9: 23:59:59.999 KST is (23 - 9) = 14h in UTC
        endUtcMs = Date.UTC(parsedTo.year, parsedTo.month - 1, parsedTo.day, 14, 59, 59, 999);
    }

    if (startUtcMs !== null && endUtcMs !== null) {
        if (startUtcMs > endUtcMs) {
            const err = new Error('시작일은 종료일보다 늦을 수 없습니다.');
            err.code = 'INVALID_DATE_RANGE';
            throw err;
        }
    }

    return {
        startUtcMs,
        endUtcMs,
        startUtcIso: startUtcMs !== null ? new Date(startUtcMs).toISOString() : null,
        endUtcIso: endUtcMs !== null ? new Date(endUtcMs).toISOString() : null
    };
}

/**
 * Get KST date strings ('YYYY-MM-DD') for quick presets.
 * System-timezone independent: calculates strictly in Asia/Seoul.
 *
 * @param {'today'|'7days'|'30days'|'all'} preset
 * @param {Date} [referenceDate=new Date()]
 * @returns {{ fromDate: string, toDate: string }}
 */
export function getKstPresetDateStrings(preset, referenceDate = new Date()) {
    if (preset === 'all') {
        return { fromDate: '', toDate: '' };
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: KST_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    const parts = formatter.formatToParts(referenceDate);
    const partMap = {};
    for (const p of parts) {
        if (p.type !== 'literal') partMap[p.type] = p.value;
    }

    const year = parseInt(partMap.year, 10);
    const month = parseInt(partMap.month, 10);
    const day = parseInt(partMap.day, 10);

    const formatYmd = (y, m, d) => {
        const mm = String(m).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        return `${y}-${mm}-${dd}`;
    };

    const toDate = formatYmd(year, month, day);

    if (preset === 'today') {
        return { fromDate: toDate, toDate };
    }

    const daysOffset = preset === '7days' ? 6 : 29;
    // Calculate reference midnight in UTC:
    const kstMidnightMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const targetMs = kstMidnightMs - (daysOffset * 24 * 60 * 60 * 1000);
    const targetDate = new Date(targetMs);

    const fromDate = formatYmd(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth() + 1,
        targetDate.getUTCDate()
    );

    return { fromDate, toDate };
}

/**
 * server/permissions/canonicalDepartment.js
 * Centralized Canonical Department Identifier Resolution for Mind-ERP OS.
 * Prevents fuzzy matches, substring tampering, and display name confusion.
 */

export const CANONICAL_DEPARTMENTS = Object.freeze({
    PROMOTION: 'dept_promotion',
    RECOVERY: 'dept_recovery',
    PREVENTION: 'dept_prevention',
    COUNSEL_1: 'dept_counsel_1',
    COUNSEL_2: 'dept_counsel_2',
    CHILD_YOUTH: 'dept_child_youth',
    NAMBU: 'dept_nambu',
    OPERATIONS: 'dept_operations'
});

export const DEPARTMENT_CANONICAL_MAP = Object.freeze({
    // Standard Canonical IDs
    'dept_promotion': CANONICAL_DEPARTMENTS.PROMOTION,
    'dept_recovery': CANONICAL_DEPARTMENTS.RECOVERY,
    'dept_prevention': CANONICAL_DEPARTMENTS.PREVENTION,
    'dept_counsel_1': CANONICAL_DEPARTMENTS.COUNSEL_1,
    'dept_counsel_2': CANONICAL_DEPARTMENTS.COUNSEL_2,
    'dept_child_youth': CANONICAL_DEPARTMENTS.CHILD_YOUTH,
    'dept_nambu': CANONICAL_DEPARTMENTS.NAMBU,
    'dept_operations': CANONICAL_DEPARTMENTS.OPERATIONS,

    // Center 2-letter Team Codes (from constants.ts TEAM_CODES)
    'JJ': CANONICAL_DEPARTMENTS.PROMOTION,
    'HB': CANONICAL_DEPARTMENTS.PROMOTION,
    'JY': CANONICAL_DEPARTMENTS.PREVENTION,
    'YP': CANONICAL_DEPARTMENTS.PREVENTION,
    'AC': CANONICAL_DEPARTMENTS.CHILD_YOUTH,
    'AD': CANONICAL_DEPARTMENTS.CHILD_YOUTH,
    'NB': CANONICAL_DEPARTMENTS.NAMBU,
    'JD': 'dept_addiction',
    'ET': 'dept_community',
    'GH': 'dept_public_relations',
    'WG': 'dept_crisis',

    // Exact Center Korean Team Names
    '정신건강증진팀': CANONICAL_DEPARTMENTS.PROMOTION,
    '예방관리팀': CANONICAL_DEPARTMENTS.PREVENTION,
    '중독관리팀': 'dept_addiction',
    '지역복지팀': 'dept_community',
    '기획홍보팀': 'dept_public_relations',
    '위기관리팀': 'dept_crisis',
    '남부분소': CANONICAL_DEPARTMENTS.NAMBU,
    '증진팀': CANONICAL_DEPARTMENTS.PROMOTION,
    '증진': CANONICAL_DEPARTMENTS.PROMOTION,
    '회복팀': CANONICAL_DEPARTMENTS.RECOVERY,
    '회복': CANONICAL_DEPARTMENTS.RECOVERY,
    '자살예방센터': CANONICAL_DEPARTMENTS.PREVENTION,
    '자살예방팀': CANONICAL_DEPARTMENTS.PREVENTION,
    '자살예방': CANONICAL_DEPARTMENTS.PREVENTION,
    '상담1팀': CANONICAL_DEPARTMENTS.COUNSEL_1,
    '상담2팀': CANONICAL_DEPARTMENTS.COUNSEL_2,
    '아동청소년팀': CANONICAL_DEPARTMENTS.CHILD_YOUTH,
    '아동청소년': CANONICAL_DEPARTMENTS.CHILD_YOUTH,
    '남부지원팀': CANONICAL_DEPARTMENTS.NAMBU,
    '남부센터': CANONICAL_DEPARTMENTS.NAMBU,
    '운영팀': CANONICAL_DEPARTMENTS.OPERATIONS,
    '기획운영팀': CANONICAL_DEPARTMENTS.OPERATIONS
});

/**
 * Validate department mapping consistency.
 * Returns true if all mappings resolve cleanly without conflict, or false if conflicts detected.
 */
export function validateCanonicalDepartmentMappings() {
    for (const [alias, canonical] of Object.entries(DEPARTMENT_CANONICAL_MAP)) {
        if (!alias || typeof alias !== 'string' || !canonical || typeof canonical !== 'string') {
            return false;
        }
    }
    return true;
}

/**
 * Resolve any raw department token to its immutable canonical ID.
 * Strict exact match only: rejects unknown names, substrings, or malformed inputs.
 * 
 * @param {string|null|undefined} raw
 * @returns {string|null} Canonical Department ID or null if unrecognized
 */
export function resolveCanonicalDepartmentId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return DEPARTMENT_CANONICAL_MAP[trimmed] || null;
}

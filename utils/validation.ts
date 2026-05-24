import { Referral } from '../types';

/**
 * Stage 4: PreToolUse Hook (Validation Logic)
 * 데이터 저장 전 필수 필드(이름, 연령, 연락처, 날짜)가 포함되었는지 검사합니다.
 */
export const validateReferralFields = (data: any): { isValid: boolean; missingFields: string[] } => {
    const requiredFields = [
        { key: 'name', label: '이름' },
        { key: 'age', label: '연령' },
        { key: 'phone', label: '연락처' },
        { key: 'requestDate', label: '의뢰날짜' }
    ];

    const missingFields: string[] = [];

    requiredFields.forEach(field => {
        const value = data[field.key];
        if (value === undefined || value === null || String(value).trim() === '') {
            missingFields.push(field.label);
        }
    });

    // Special check for requestDate/registrationDate alias
    if (missingFields.includes('의뢰날짜') && (data.registrationDate || data.createdAt)) {
        const idx = missingFields.indexOf('의뢰날짜');
        missingFields.splice(idx, 1);
    }

    return {
        isValid: missingFields.length === 0,
        missingFields
    };
};

/**
 * Enhanced validation for Budget transactions
 */
export const validateBudgetTransaction = (data: any): boolean => {
    return !!(data.amount && data.description && data.date);
};

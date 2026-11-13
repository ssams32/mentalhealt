/**
 * server/external-api/payloadValidator.js
 * Homepage Integration Engine — Payload Validation & Normalization
 * ESM module.
 * 03 문서 §2-6 표 그대로 구현.
 */

import { HomepageIntegrationError } from "./engineErrors.js";

/**
 * 스팸/프로브 패턴 (스크레이퍼와 동일)
 */
const SPAM_PATTERNS = [
  /sparrow/i,
  /dast/i,
  /<script/i,
  /onload\s*=/i,
  /javascript:/i,
  /alert\(/i,
];

/**
 * externalId 허용 문자: 영문·숫자로 시작, 이후 영문·숫자·점·밑줄·하이픈만 허용.
 * 03 문서 §2-6 "externalId 없음·형식 오류"의 형식 규칙. 공백·특수문자가 들어간 ID는
 * 06 T6 "허용 문자 밖 ID"로 격리한다.
 */
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 스팸 프로브 여부 검사
 * @param {object} item - 검사할 항목
 * @returns {boolean}
 */
function isSpamProbe(item) {
  if (!item || typeof item !== "object") return false;

  const text = JSON.stringify(item);
  return SPAM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 문자열 trim 정규화
 * @param {string} str
 * @returns {string}
 */
function trimString(str) {
  return typeof str === "string" ? str.trim() : str;
}

/**
 * 날짜 ISO 8601 정규화
 * @param {string} dateStr
 * @returns {string|null} 정규화된 ISO 문자열 또는 null (파싱 실패 시)
 */
function normalizeDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  try {
    const date = new Date(trimmed);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

/**
 * 의뢰 항목 검증
 * @param {object} raw - 원본 항목
 * @param {object} normalized - 정규화된 항목
 * @returns {{status: 'valid'|'quarantined'|'rejected', normalized: object, reason?: string}}
 */
function validateReferralItem(raw, normalized) {
  // 필수 필드 검사
  if (!normalized.externalId || typeof normalized.externalId !== "string") {
    return {
      status: "quarantined",
      normalized,
      reason: "externalId 누락 또는 형식 오류",
    };
  }

  // externalId 허용 문자 검사
  if (!EXTERNAL_ID_PATTERN.test(normalized.externalId)) {
    return {
      status: "quarantined",
      normalized,
      reason: "externalId 형식 오류 (허용 문자 외 포함)",
    };
  }

  // receivedAt 파싱 검사
  if (!normalized.receivedAt || typeof normalized.receivedAt !== "string") {
    return {
      status: "quarantined",
      normalized,
      reason: "receivedAt 누락 또는 파싱 실패",
    };
  }

  // 이름 + 전화 둘 다 없음
  const hasName =
    normalized.name &&
    typeof normalized.name === "string" &&
    normalized.name.trim();
  const hasPhone =
    normalized.phone &&
    typeof normalized.phone === "string" &&
    normalized.phone.trim();
  if (!hasName && !hasPhone) {
    return {
      status: "quarantined",
      normalized,
      reason: "이름과 연락처가 모두 없음",
    };
  }

  // 타입 불일치 검사 (문자열이어야 하는 필드들)
  const stringFields = [
    "name",
    "phone",
    "gender",
    "age",
    "birthDate",
    "address",
    "problem",
    "reason",
    "referralPath",
  ];
  for (const field of stringFields) {
    if (
      normalized[field] !== undefined &&
      normalized[field] !== null &&
      typeof normalized[field] !== "string"
    ) {
      return {
        status: "quarantined",
        normalized,
        reason: `필드 타입 불일치: ${field}은 문자열이어야 함`,
      };
    }
  }

  // 길이 초과 검사
  const lengthLimits = {
    name: 50,
    phone: 30,
    problem: 2000,
    reason: 2000,
    referralPath: 500,
    guardianName: 50,
    guardianPhone: 30,
    guardianNotes: 500,
    requesterName: 100,
    requesterFax: 50,
    requesterEmail: 100,
    agency: 100,
    agencyPhone: 30,
    medicalInsurance: 50,
    disabilityStatus: 50,
    consentNotes: 500,
  };

  for (const [field, limit] of Object.entries(lengthLimits)) {
    const value = normalized[field];
    if (value && typeof value === "string" && value.length > limit) {
      return {
        status: "quarantined",
        normalized,
        reason: `길이 초과: ${field} (최대 ${limit}자)`,
      };
    }
  }

  // gender 값 정규화 (알 수 없는 값은 null로)
  const validGenders = [
    "male",
    "female",
    "other",
    "M",
    "F",
    "남",
    "여",
    "남자",
    "여자",
  ];
  if (normalized.gender && !validGenders.includes(normalized.gender)) {
    normalized.gender = null;
    // 경고는 이력에 별도 기록 (여기선 정규화만)
  }

  // referralPath 값 정규화 (알 수 없는 값은 null로)
  // 명세가 오면 유효 값 목록으로 교체
  const validReferralPaths = [
    "health-center",
    "medical-institution",
    "icheon-city-hall",
    "referral-agency",
    "other",
  ];
  if (
    normalized.referralPath &&
    !validReferralPaths.includes(normalized.referralPath)
  ) {
    normalized.referralPath = null;
  }

  // 스팸 패턴 검사
  if (isSpamProbe(raw)) {
    return {
      status: "quarantined",
      normalized,
      reason: "스팸/프로브 패턴 탐지",
    };
  }

  return { status: "valid", normalized };
}

/**
 * 척도검사 항목 검증
 * @param {object} raw - 원본 항목
 * @param {object} normalized - 정규화된 항목
 * @returns {{status: 'valid'|'quarantined'|'rejected', normalized: object, reason?: string}}
 */
function validateAssessmentItem(raw, normalized) {
  // 필수 필드 검사
  if (!normalized.externalId || typeof normalized.externalId !== "string") {
    return {
      status: "quarantined",
      normalized,
      reason: "externalId 누락 또는 형식 오류",
    };
  }

  // externalId 허용 문자 검사
  if (!EXTERNAL_ID_PATTERN.test(normalized.externalId)) {
    return {
      status: "quarantined",
      normalized,
      reason: "externalId 형식 오류 (허용 문자 외 포함)",
    };
  }

  if (!normalized.scale || typeof normalized.scale !== "string") {
    return {
      status: "quarantined",
      normalized,
      reason: "scale(척도 코드) 누락",
    };
  }

  if (!normalized.submittedAt || typeof normalized.submittedAt !== "string") {
    return {
      status: "quarantined",
      normalized,
      reason: "submittedAt 누락 또는 파싱 실패",
    };
  }

  // totalScore 숫자 검사
  if (normalized.totalScore !== undefined && normalized.totalScore !== null) {
    const score = Number(normalized.totalScore);
    if (isNaN(score)) {
      return {
        status: "quarantined",
        normalized,
        reason: "totalScore가 숫자가 아님",
      };
    }
    normalized.totalScore = score;
  }

  // score도 같은 값으로 (기존 코드 혼용 대응)
  if (normalized.score !== undefined && normalized.score !== null) {
    const score = Number(normalized.score);
    if (isNaN(score)) {
      return {
        status: "quarantined",
        normalized,
        reason: "score가 숫자가 아님",
      };
    }
    normalized.score = score;
  } else if (normalized.totalScore !== undefined) {
    normalized.score = normalized.totalScore;
  }

  // scaleScores 객체 검사
  if (normalized.scaleScores !== undefined && normalized.scaleScores !== null) {
    if (
      typeof normalized.scaleScores !== "object" ||
      Array.isArray(normalized.scaleScores)
    ) {
      return {
        status: "quarantined",
        normalized,
        reason: "scaleScores가 객체가 아님",
      };
    }
  }

  // severity 없음은 null로 통과 (총점으로 추측하지 않음)
  if (normalized.severity === undefined || normalized.severity === "") {
    normalized.severity = null;
  } else if (
    normalized.severity !== null &&
    typeof normalized.severity !== "string"
  ) {
    normalized.severity = String(normalized.severity);
  }

  // answers/responses는 원본 그대로 저장 (검증하지 않음)
  // 단, 스팸 패턴은 검사
  if (isSpamProbe(raw)) {
    return {
      status: "quarantined",
      normalized,
      reason: "스팸/프로브 패턴 탐지",
    };
  }

  return { status: "valid", normalized };
}

/**
 * 배치 페이로드 검증 메인 클래스
 */
export class HomepagePayloadValidator {
  /**
   * 배치 페이로드 검증
   * @param {object} payload - 원본 페이로드
   * @param {'referral'|'assessment'} kind - 항목 종류
   * @returns {{valid: array, quarantined: array, rejected: array}}
   */
  validateBatch(payload, kind) {
    const result = {
      valid: [],
      quarantined: [],
      rejected: [],
    };

    // 1단계: 구조 검증
    if (!payload || typeof payload !== "object") {
      throw new HomepageIntegrationError({
        message: "페이로드가 객체가 아닙니다",
        code: "INVALID_PAYLOAD_SCHEMA",
      });
    }

    // items 배열 확인
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

    if (!Array.isArray(items) || items.length === 0) {
      return result; // 빈 배열은 유효 (신규 데이터 없음)
    }

    // 2단계: 항목별 검증
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") {
        result.rejected.push({ item: rawItem, reason: "항목이 객체가 아님" });
        continue;
      }

      // 정규화된 복사본 생성
      const normalized = this._normalizeItem(rawItem, kind);

      // 종류별 검증
      let validation;
      if (kind === "referral") {
        validation = validateReferralItem(rawItem, normalized);
      } else if (kind === "assessment") {
        validation = validateAssessmentItem(rawItem, normalized);
      } else {
        result.rejected.push({
          item: rawItem,
          reason: `알 수 없는 종류: ${kind}`,
        });
        continue;
      }

      // 결과 분류
      switch (validation.status) {
        case "valid":
          result.valid.push(validation.normalized);
          break;
        case "quarantined":
          result.quarantined.push({
            item: validation.normalized,
            reason: validation.reason,
            original: rawItem,
          });
          break;
        case "rejected":
          result.rejected.push({
            item: validation.normalized,
            reason: validation.reason,
            original: rawItem,
          });
          break;
      }
    }

    return result;
  }

  /**
   * 항목 정규화 (공통)
   * @param {object} item
   * @param {'referral'|'assessment'} kind
   * @returns {object}
   */
  _normalizeItem(item, kind) {
    const normalized = {};

    for (const [key, value] of Object.entries(item)) {
      if (typeof value === "string") {
        // 문자열 trim (전화번호 형식 변환 금지)
        normalized[key] = value.trim();
      } else {
        normalized[key] = value;
      }
    }

    // 날짜 필드 ISO 8601 정규화
    const dateFields =
      kind === "referral"
        ? ["receivedAt", "registrationDate", "birthDate", "externalReceivedAt"]
        : ["submittedAt", "importedAt"];

    for (const field of dateFields) {
      if (normalized[field]) {
        const iso = normalizeDate(normalized[field]);
        if (iso) normalized[field] = iso;
      }
    }

    // externalId는 살균하지 않음 (원본 유지, _sanitizeId는 클라이언트에서 사용)

    return normalized;
  }

  /**
   * 의뢰 단일 항목 검증 (외부 호출용)
   * @param {object} item
   * @returns {{status: string, normalized: object, reason?: string}}
   */
  validateReferralItem(item) {
    const normalized = this._normalizeItem(item, "referral");
    return validateReferralItem(item, normalized);
  }

  /**
   * 척도검사 단일 항목 검증 (외부 호출용)
   * @param {object} item
   * @returns {{status: string, normalized: object, reason?: string}}
   */
  validateAssessmentItem(item) {
    const normalized = this._normalizeItem(item, "assessment");
    return validateAssessmentItem(item, normalized);
  }

  /**
   * 스팸 프로브 검사
   * @param {object} item
   * @returns {boolean}
   */
  isSpamProbe(item) {
    return isSpamProbe(item);
  }
}

/**
 * 편의 함수: 단일 항목 검증
 * @param {object} item
 * @param {'referral'|'assessment'} kind
 * @returns {{status: string, normalized: object, reason?: string}}
 */
export function validateItem(item, kind) {
  const validator = new HomepagePayloadValidator();
  if (kind === "referral") {
    return validator.validateReferralItem(item);
  } else {
    return validator.validateAssessmentItem(item);
  }
}

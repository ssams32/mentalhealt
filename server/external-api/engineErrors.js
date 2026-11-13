/**
 * server/external-api/engineErrors.js
 * Homepage Integration Engine — Typed Errors & Log Masking
 * ESM module.
 */

import crypto from "crypto";

/**
 * 마스킹 규칙 상수
 */
const BEARER_TOKEN_PATTERN = /bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const PHONE_PATTERN = /01[016789]-?\d{3,4}-?\d{4}/g;
const RESIDENT_REG_PATTERN = /\d{6}-?\d{7}/g;
const FILE_PATH_PATTERN = /(?:[a-zA-Z]:|\/)[^\s:;"'<>]+/g;

/**
 * 로그용 단일 값 마스킹
 * @param {unknown} value - 마스킹할 값
 * @returns {unknown} 마스킹된 값
 */
export function maskForLog(value) {
  if (typeof value !== "string") return value;
  return (
    value
      .replace(FILE_PATH_PATTERN, "[REDACTED_PATH]")
      .replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]")
      .replace(/X-Api-Key\s*:\s*[A-Za-z0-9._~+\/-]+/gi, "X-Api-Key: [REDACTED]")
      .replace(
        /Authorization\s*:\s*[A-Za-z0-9._~+\/-]+/gi,
        "Authorization: [REDACTED]",
      )
      // Generic API key pattern - must come BEFORE phone/resident to avoid matching replacement tokens
      // 단, 엔진 에러 코드(ENGINE_ERROR_CODES 키)는 비밀이 아니라 식별자이므로 그대로 둔다
      // (그렇지 않으면 "HOMEPAGE_AUTH_FAILED: ..." 같은 에러 메시지의 코드까지 지워져 원인을 알 수 없게 된다)
      .replace(/[A-Za-z][A-Za-z0-9._~+\/-]{11,}/g, (token) =>
        Object.prototype.hasOwnProperty.call(ENGINE_ERROR_CODES, token)
          ? token
          : "[REDACTED_API_KEY]",
      )
      .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
      .replace(RESIDENT_REG_PATTERN, "[REDACTED_RESIDENT_REG]")
  );
}

/**
 * 로그용 페이로드 객체 마스킹
 * @param {object} obj - 마스킹할 객체
 * @returns {object} 마스킹된 객체 (원본 변경 안 함)
 */
export function maskPayloadForLog(obj) {
  if (!obj || typeof obj !== "object") return maskForLog(obj);

  const REDACT_KEYS = new Set([
    "apiKey",
    "api_key",
    "ApiKey",
    "API_KEY",
    "phone",
    "clientName",
    "answers",
    "responses",
    "residentRegistrationNumber",
    "resident_registration_number",
    "Authorization",
    "authorization",
    "password",
    "secret",
  ]);

  if (Array.isArray(obj)) {
    return obj.map((item) => maskPayloadForLog(item));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      result[key] = maskForLog(value);
    } else if (value && typeof value === "object") {
      result[key] = maskPayloadForLog(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 에러 코드 표
 * 코드명, HTTP 상태, 재시도 가능 여부, 의미
 */
export const ENGINE_ERROR_CODES = {
  CONFIG_MISSING: {
    http: 500,
    retryable: false,
    message: "필수 설정(baseUrl·키·orgId) 없음",
  },
  CONFIG_INVALID_URL: {
    http: 500,
    retryable: false,
    message: "baseUrl 검증 실패",
  },
  CONFIG_KEY_IN_SETTINGS: {
    http: 500,
    retryable: false,
    message: "설정 JSON에 키가 들어 있음 (무시하고 경고)",
  },
  ENGINE_DISABLED: {
    http: 409,
    retryable: false,
    message: "폴링 OFF인데 수동 동기화 시도",
  },
  SCRAPER_CONFLICT: {
    http: 409,
    retryable: false,
    message: "스크레이퍼가 켜져 있어 엔진 실행 거부",
  },
  AUTH_FAILED: {
    http: 502,
    retryable: false,
    message: "홈페이지 401/403. 재시도해도 같은 결과",
  },
  HOMEPAGE_AUTH_FAILED: {
    http: 401,
    retryable: false,
    message: "홈페이지 인증 실패 (잘못된 API 키)",
  },
  NOT_FOUND: { http: 502, retryable: false, message: "홈페이지 404" },
  RATE_LIMITED: {
    http: 502,
    retryable: true,
    message: "홈페이지 429. Retry-After가 있으면 그 값을 따름",
  },
  REQUEST_TIMEOUT: {
    http: 504,
    retryable: true,
    message: "AbortController 타임아웃",
  },
  NETWORK_ERROR: {
    http: 503,
    retryable: true,
    message: "연결 실패·DNS·TLS 오류",
  },
  NON_JSON_RESPONSE: {
    http: 502,
    retryable: false,
    message: "JSON이 아닌 응답 (HTML·로그인 페이지 등)",
  },
  INVALID_PAYLOAD_SCHEMA: {
    http: 502,
    retryable: false,
    message: "최상위 구조가 아님",
  },
  VALIDATION_FAILED: {
    http: 422,
    retryable: false,
    message: "항목 검증 실패 → 격리 (사이클 실패 아님)",
  },
  DUPLICATE_SKIPPED: {
    http: 409,
    retryable: false,
    message: "멱등성 스킵 결과 (카운트만 함)",
  },
  PERSIST_FAILED: {
    http: 500,
    retryable: true,
    message: "persistData 실패 (3회 재시도 후에도 실패)",
  },
  ACK_FAILED: {
    http: 502,
    retryable: true,
    message: "ack 전송 실패 → 재시도 큐로 이동 (저장은 이미 완료됨)",
  },
  SYNC_ALREADY_RUNNING: {
    http: 409,
    retryable: false,
    message: "이미 사이클 실행 중",
  },
  SYNC_TOO_FREQUENT: {
    http: 429,
    retryable: true,
    message: "수동 동기화 간격 10초 미만",
  },
  RETRY_EXHAUSTED: {
    http: 422,
    retryable: false,
    message: "재시도 3회 소진 → 수동 재처리 대기",
  },
  KEY_ENCRYPTION_UNAVAILABLE: {
    http: 503,
    retryable: false,
    message: "암호화 마스터 키가 설정되지 않음",
  },
  INVALID_KEY_FORMAT: {
    http: 400,
    retryable: false,
    message: "API 키 형식이 올바르지 않음 (16~512자, 공백 불가)",
  },
};

/**
 * 홈페이지 연동 전용 Typed 에러 클래스
 * 생성 시점에 메시지가 마스킹 함수를 통과함
 */
export class HomepageIntegrationError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.message - 에러 메시지 (마스킹됨)
   * @param {string} opts.code - 에러 코드 (ENGINE_ERROR_CODES 키)
   * @param {number} [opts.statusCode] - HTTP 상태 코드 (코드표에서 자동 결정)
   * @param {string} [opts.externalId] - 외부 고유 ID
   * @param {boolean} [opts.retryable] - 재시도 가능 여부 (코드표에서 자동 결정)
   * @param {object} [opts.details] - 추가 상세 정보 (마스킹됨)
   */
  constructor({
    message,
    code,
    statusCode,
    externalId,
    retryable,
    details = {},
  } = {}) {
    const safeMessage = maskForLog(message || `Homepage API error: ${code}`);
    super(safeMessage);

    this.name = "HomepageIntegrationError";
    this.code = code || "UNKNOWN_ERROR";

    // 코드표에서 기본값 가져오기
    const codeInfo = ENGINE_ERROR_CODES[this.code] || {};
    this.statusCode = statusCode ?? codeInfo.http ?? 500;
    this.retryable = retryable ?? codeInfo.retryable ?? false;
    this.externalId = externalId ?? null;

    // details 마스킹
    this.details = this._redactObject(details);
  }

  _redactObject(obj) {
    if (!obj || typeof obj !== "object") return maskForLog(obj);
    if (Array.isArray(obj)) return obj.map((item) => this._redactObject(item));

    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        [
          "apiKey",
          "Authorization",
          "authorization",
          "password",
          "secret",
          "key",
        ].includes(k)
      ) {
        result[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        result[k] = maskForLog(v);
      } else if (v && typeof v === "object") {
        result[k] = this._redactObject(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  /**
   * 에러를 직렬화 가능한 객체로 변환
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      externalId: this.externalId,
      details: this.details,
    };
  }
}

/**
 * HTTP 응답으로부터 에러 생성 (homepageClient 내부용)
 * @param {Response} resp - fetch 응답
 * @param {object} data - 파싱된 JSON 본문
 * @param {string} externalId - 외부 ID
 * @returns {HomepageIntegrationError}
 */
export function createErrorFromResponse(resp, data, externalId = null) {
  // 홈페이지 에러 본문의 error.code/error.message 우선 사용
  const hpCode = data?.error?.code || data?.code;
  const hpMsg = data?.error?.message || data?.message || `HTTP ${resp.status}`;

  // HTTP 상태 코드별 기본 매핑
  let code, retryable;
  switch (resp.status) {
    case 401:
    case 403:
      code = "AUTH_FAILED";
      retryable = false;
      break;
    case 404:
      code = "NOT_FOUND";
      retryable = false;
      break;
    case 429:
      code = "RATE_LIMITED";
      retryable = true;
      break;
    case 500:
    case 502:
    case 503:
    case 504:
      code = "NETWORK_ERROR";
      retryable = true;
      break;
    default:
      code = hpCode || "UNKNOWN_ERROR";
      retryable = false;
  }

  // 홈페이지가 준 에러 코드가 우리 코드표에 있으면 그걸 사용
  if (hpCode && ENGINE_ERROR_CODES[hpCode]) {
    code = hpCode;
    retryable = ENGINE_ERROR_CODES[hpCode].retryable;
  }

  return new HomepageIntegrationError({
    message: `${code}: ${hpMsg}`,
    code,
    statusCode: resp.status,
    externalId,
    retryable,
    details: { httpStatus: resp.status, homepageCode: hpCode },
  });
}

/**
 * 네트워크/타임아웃 에러로부터 에러 생성
 * @param {Error} err - 원본 에러
 * @param {string} externalId - 외부 ID
 * @returns {HomepageIntegrationError}
 */
export function createErrorFromFetchError(err, externalId = null) {
  const isAbort =
    err.name === "AbortError" ||
    err.message?.includes("aborted") ||
    err.message?.includes("timeout");
  return new HomepageIntegrationError({
    message: isAbort
      ? "홈페이지 API 요청 타임아웃"
      : "홈페이지 API 네트워크 연결 실패",
    code: isAbort ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    statusCode: isAbort ? 504 : 503,
    externalId,
    retryable: true,
    details: { originalMessage: err.message, originalName: err.name },
  });
}

/**
 * 인증 지문 생성 (SHA-256 앞 8자)
 * @param {string} apiKey - API 키
 * @returns {string} 지문
 */
export function computeAuthFingerprint(apiKey) {
  if (!apiKey) return "none";
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

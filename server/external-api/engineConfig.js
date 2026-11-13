/**
 * server/external-api/engineConfig.js
 * Homepage Integration Engine — Configuration Load & Validation
 * ESM module.
 * 03 문서 §2-1 표 그대로 구현.
 */

import fs from "fs";
import path from "path";
import { validateHomepageBaseUrl } from "./urlValidator.js";
import {
  HomepageIntegrationError,
  ENGINE_ERROR_CODES,
} from "./engineErrors.js";

/**
 * 설정 파일 경로
 * @param {string} dataDir - 데이터 디렉터리
 * @returns {string} 설정 파일 경로
 */
function getSettingsPath(dataDir) {
  return path.join(dataDir, "EngineSettings.json");
}

/**
 * 환경변수에서 설정 로드 (시드용)
 * @returns {object} 환경변수 설정 객체
 */
export function loadEnvConfig() {
  return {
    baseUrl: process.env.HOMEPAGE_API_BASE_URL?.trim(),
    orgId: process.env.HOMEPAGE_ORG_ID?.trim(),
    apiKeyHeader: process.env.HOMEPAGE_API_KEY_HEADER?.trim() || "X-Api-Key",
    authScheme: process.env.HOMEPAGE_API_AUTH_SCHEME?.trim() || "api-key",
    orgIdPlacement: process.env.HOMEPAGE_ORG_ID_PLACEMENT?.trim() || "header",
    mode: (process.env.HOMEPAGE_API_MODE?.trim() || "mock").toLowerCase(),
    pollEnabled: process.env.HOMEPAGE_POLL_ENABLED === "true",
    pollIntervalSeconds: parseInt(
      process.env.HOMEPAGE_POLL_INTERVAL_SECONDS || "60",
      10,
    ),
    pollInitialDelaySeconds: parseInt(
      process.env.HOMEPAGE_POLL_INITIAL_DELAY_SECONDS || "60",
      10,
    ),
    requestTimeoutMs: parseInt(
      process.env.HOMEPAGE_REQUEST_TIMEOUT_MS || "10000",
      10,
    ),
    maxBatchSize: parseInt(process.env.HOMEPAGE_MAX_BATCH_SIZE || "50", 10),
    keyFilePath: process.env.HOMEPAGE_API_KEY_FILE?.trim(),
  };
}

/**
 * JSON 설정 파일에서 설정 로드
 * @param {string} dataDir - 데이터 디렉터리
 * @returns {object|null} 설정 객체 또는 null
 */
function loadJsonConfig(dataDir) {
  const settingsPath = getSettingsPath(dataDir);
  if (!fs.existsSync(settingsPath)) return null;

  try {
    const content = fs.readFileSync(settingsPath, "utf8");
    if (!content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 설정 값 검증 및 정규화
 * @param {object} config - 병합된 설정
 * @param {string} mode - 모드
 * @returns {object} 검증된 설정
 */
export function validateConfig(config, mode) {
  const errors = [];

  // 필수 필드 검사
  if (!config.baseUrl) {
    errors.push("baseUrl");
  }
  if (!config.orgId) {
    errors.push("orgId");
  }

  // baseUrl 검증
  if (config.baseUrl) {
    try {
      config.baseUrl = validateHomepageBaseUrl(config.baseUrl, mode);
    } catch (e) {
      throw new HomepageIntegrationError({
        message: e.message,
        code: "CONFIG_INVALID_URL",
        details: { baseUrl: config.baseUrl },
      });
    }
  }

  // 모드 검증
  const validModes = ["mock", "staging", "production"];
  if (!validModes.includes(mode)) {
    throw new HomepageIntegrationError({
      message: `잘못된 모드: ${mode}. mock, staging, production 중 하나여야 합니다.`,
      code: "CONFIG_MISSING",
    });
  }

  // production/staging에서 필수 필드 체크
  if (mode !== "mock") {
    if (!config.baseUrl) errors.push("baseUrl (production/staging 필수)");
    if (!config.orgId) errors.push("orgId (production/staging 필수)");
  }

  // 수치 범위 검증 및 기본값 적용
  config.pollIntervalSeconds = Math.max(
    30,
    Math.min(3600, config.pollIntervalSeconds || 60),
  );
  config.pollInitialDelaySeconds = Math.max(
    0,
    Math.min(600, config.pollInitialDelaySeconds || 60),
  );
  config.requestTimeoutMs = Math.max(
    1000,
    Math.min(120000, config.requestTimeoutMs || 10000),
  );
  config.maxBatchSize = Math.max(1, Math.min(100, config.maxBatchSize || 50));

  // 기본값 적용
  config.apiKeyHeader = config.apiKeyHeader || "X-Api-Key";
  config.authScheme = ["api-key", "bearer"].includes(config.authScheme)
    ? config.authScheme
    : "api-key";
  config.orgIdPlacement = ["header", "query", "body"].includes(
    config.orgIdPlacement,
  )
    ? config.orgIdPlacement
    : "header";
  config.mode = mode;
  config.pollEnabled = config.pollEnabled === true; // boolean 강제

  if (errors.length > 0) {
    throw new HomepageIntegrationError({
      message: `필수 설정 누락: ${errors.join(", ")}`,
      code: "CONFIG_MISSING",
      details: { missing: errors },
    });
  }

  return config;
}

/**
 * 엔진 설정 로드 (환경변수 > JSON 설정 > 기본값 우선순위)
 * @param {object} opts
 * @param {Function} opts.getData - 데이터 읽기 함수
 * @param {Function} opts.persistData - 데이터 저장 함수
 * @param {string} [opts.dataDir] - 데이터 디렉터리 (선택적, 기본값: process.env.DATA_DIR 또는 cwd/app/data)
 * @returns {object} EngineConfig 객체
 */
export function loadEngineConfig({ getData, persistData, dataDir } = {}) {
  dataDir =
    dataDir || process.env.DATA_DIR || path.join(process.cwd(), "app", "data");

  // 1. 환경변수 설정 (시드용)
  const envConfig = loadEnvConfig();

  // 2. JSON 설정 (런타임 진실 원본)
  const jsonConfig = loadJsonConfig(dataDir) || {};

  // 3. 병합: env 명시값 > JSON 설정값 > 기본값
  // 단, apiKey는 JSON에 둘 수 없음 (나중에 별도 처리)
  const merged = {
    ...jsonConfig,
    ...Object.fromEntries(
      Object.entries(envConfig).filter(([_, v]) => v !== undefined && v !== ""),
    ),
  };

  // 모드 결정 (env가 우선)
  const mode = envConfig.mode || jsonConfig.mode || "mock";

  // 검증
  const validated = validateConfig(merged, mode);

  // JSON에 키가 들어 있으면 경고 (저장하지 않음)
  if (
    jsonConfig.apiKey ||
    jsonConfig.api_key ||
    jsonConfig.ApiKey ||
    jsonConfig.API_KEY
  ) {
    console.warn(
      "[ENGINE_CONFIG] EngineSettings.json에 apiKey 필드가 있습니다. 보안상 무시되며 저장되지 않습니다.",
    );
    // 경고용 에러 객체 생성 (던지지 않음)
    const keyWarning = new HomepageIntegrationError({
      message: "설정 JSON에 키가 들어 있음 (무시하고 경고)",
      code: "CONFIG_KEY_IN_SETTINGS",
    });
    validated._keyWarning = keyWarning;
  }

  return validated;
}

/**
 * 설정 요약 반환 (키 값 제외, 존재 여부와 지문만 포함)
 * @param {object} config - EngineConfig
 * @param {string} [keyFingerprint] - 키 지문
 * @returns {object} 설정 요약
 */
export function getEngineConfigSummary(config, keyFingerprint = null) {
  return {
    enabled: config.enabled !== false,
    baseUrl: config.baseUrl,
    orgId: config.orgId,
    mode: config.mode,
    pollEnabled: config.pollEnabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    keyPresent: !!keyFingerprint,
    keyFingerprint,
    apiKeyHeader: config.apiKeyHeader,
    authScheme: config.authScheme,
    orgIdPlacement: config.orgIdPlacement,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBatchSize: config.maxBatchSize,
    disabledReason: config.disabledReason || null,
  };
}

/**
 * 설정 저장 (키 제외, 비키 설정만)
 * @param {object} patch - 변경할 설정 필드
 * @param {string} actorUserId - 변경자 ID
 * @param {object} opts
 * @param {Function} opts.getData
 * @param {Function} opts.persistData
 * @returns {Promise<object>} 저장된 설정 (키 제외)
 */
export async function saveEngineSettings(
  patch,
  actorUserId,
  { getData, persistData } = {},
) {
  const dataDir =
    process.env.DATA_DIR || path.join(process.cwd(), "app", "data");
  const settingsPath = getSettingsPath(dataDir);

  // 현재 설정 로드
  const current = loadJsonConfig(dataDir) || {};

  // 허용된 필드만 업데이트 (키 필드 차단)
  const ALLOWED_FIELDS = new Set([
    "baseUrl",
    "orgId",
    "apiKeyHeader",
    "authScheme",
    "orgIdPlacement",
    "mode",
    "pollEnabled",
    "pollIntervalSeconds",
    "pollInitialDelaySeconds",
    "requestTimeoutMs",
    "maxBatchSize",
  ]);

  const BLOCKED_FIELDS = new Set([
    "apiKey",
    "api_key",
    "ApiKey",
    "API_KEY",
    "keyFilePath",
    "keyFingerprint",
  ]);

  // 차단된 필드가 있으면 에러
  for (const key of Object.keys(patch)) {
    if (BLOCKED_FIELDS.has(key)) {
      throw new HomepageIntegrationError({
        message: `키 관련 필드는 설정 저장 API로 변경할 수 없습니다: ${key}`,
        code: "CONFIG_KEY_IN_SETTINGS",
      });
    }
  }

  // 허용된 필드만 병합
  const updates = {};
  for (const [key, value] of Object.entries(patch)) {
    if (ALLOWED_FIELDS.has(key)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new HomepageIntegrationError({
      message: "변경 가능한 필드가 없습니다",
      code: "INVALID_PAYLOAD_SCHEMA",
    });
  }

  // baseUrl이 변경되면 검증
  if (updates.baseUrl) {
    const mode = updates.mode || current.mode || "mock";
    try {
      updates.baseUrl = validateHomepageBaseUrl(updates.baseUrl, mode);
    } catch (e) {
      throw new HomepageIntegrationError({
        message: e.message,
        code: "CONFIG_INVALID_URL",
      });
    }
  }

  // 모드 검증
  if (
    updates.mode &&
    !["mock", "staging", "production"].includes(updates.mode)
  ) {
    throw new HomepageIntegrationError({
      message: "잘못된 모드 값입니다",
      code: "INVALID_PAYLOAD_SCHEMA",
    });
  }

  // 수치 범위 검증
  if (updates.pollIntervalSeconds !== undefined) {
    updates.pollIntervalSeconds = Math.max(
      30,
      Math.min(3600, updates.pollIntervalSeconds),
    );
  }
  if (updates.pollInitialDelaySeconds !== undefined) {
    updates.pollInitialDelaySeconds = Math.max(
      0,
      Math.min(600, updates.pollInitialDelaySeconds),
    );
  }
  if (updates.requestTimeoutMs !== undefined) {
    updates.requestTimeoutMs = Math.max(
      1000,
      Math.min(120000, updates.requestTimeoutMs),
    );
  }
  if (updates.maxBatchSize !== undefined) {
    updates.maxBatchSize = Math.max(1, Math.min(100, updates.maxBatchSize));
  }

  const updated = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
    updatedBy: actorUserId,
  };

  // 저장 전 검증
  const validated = validateConfig(updated, updated.mode);

  // 저장
  await persistData("EngineSettings", validated);

  // 키 제외 요약 반환
  const {
    apiKey,
    api_key,
    ApiKey,
    API_KEY,
    keyFilePath,
    keyFingerprint,
    ...safeConfig
  } = validated;
  return safeConfig;
}

/**
 * API 키 해석 (기동 시 1회만 읽음)
 * @returns {Promise<{key: string, source: 'env'|'file'} | null>}
 */
export async function resolveApiKey() {
  // 1순위: Docker Secrets 파일
  const keyFilePath =
    process.env.HOMEPAGE_API_KEY_FILE?.trim() ||
    "/run/secrets/homepage_api_key";

  if (fs.existsSync(keyFilePath)) {
    try {
      const key = fs.readFileSync(keyFilePath, "utf8").trim();
      if (
        key &&
        key.length >= 16 &&
        !/[\s\n\r"']/.test(key) &&
        !/^https?:\/\//i.test(key) &&
        !/^Bearer\s+/i.test(key)
      ) {
        return { key, source: "file" };
      }
    } catch {
      // 파일 읽기 실패 시 env로 폴백
    }
  }

  // 2순위: 환경변수 직접 입력
  const envKey = process.env.HOMEPAGE_API_KEY?.trim();
  if (
    envKey &&
    envKey.length >= 16 &&
    !/[\s\n\r"']/.test(envKey) &&
    !/^https?:\/\//i.test(envKey) &&
    !/^Bearer\s+/i.test(envKey)
  ) {
    return { key: envKey, source: "env" };
  }

  // 둘 다 없으면 null 반환 (throw 안 함 — 호출자가 fail-closed 판정)
  return null;
}

/**
 * 모의 모드용 합성 키
 */
export const MOCK_API_KEY = "mock-homepage-key";

/**
 * 키 검증 (형식만)
 * @param {string} key
 * @returns {boolean}
 */
export function validateApiKeyFormat(key) {
  return (
    typeof key === "string" &&
    key.length >= 16 &&
    !/[\s\n\r"']/.test(key) &&
    !/^https?:\/\//i.test(key) &&
    !/^Bearer\s+/i.test(key)
  );
}

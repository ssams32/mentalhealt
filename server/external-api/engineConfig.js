/**
 * server/external-api/engineConfig.js
 * Homepage Integration Engine — Configuration Load & Validation
 * ESM module.
 * 03 문서 §2-1 표 그대로 구현.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
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
 * @param {object} [extra] - 추가 메타데이터 (keyRegisteredAt, masterKeyConfigured)
 * @returns {object} 설정 요약
 */
export function getEngineConfigSummary(
  config,
  keyFingerprint = null,
  extra = {},
) {
  const keyDecryptFailed = Boolean(extra.keyDecryptFailed);
  const effectiveFingerprint = keyDecryptFailed ? null : keyFingerprint;
  return {
    enabled: config.enabled !== false,
    baseUrl: config.baseUrl,
    orgId: config.orgId,
    mode: config.mode,
    pollEnabled: config.pollEnabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    keyPresent: !keyDecryptFailed && !!effectiveFingerprint,
    keyFingerprint: effectiveFingerprint,
    keyRegisteredAt: keyDecryptFailed ? null : (extra.keyRegisteredAt || null),
    masterKeyConfigured:
      extra.masterKeyConfigured !== undefined
        ? extra.masterKeyConfigured
        : isMasterKeyConfigured(),
    keyDecryptFailed,
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
    "keyRegisteredAt",
    "masterKeyConfigured",
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
 * 마스터 암호화 키 Buffer 반환 (32바이트)
 * HOMEPAGE_KEY_ENCRYPTION_KEY (hex 또는 base64)
 * @param {string} [overrideKey] - 테스트용 오버라이드
 * @returns {Buffer|null}
 */
export function getMasterKey(overrideKey) {
  const raw = (
    overrideKey !== undefined
      ? overrideKey
      : process.env.HOMEPAGE_KEY_ENCRYPTION_KEY
  )?.trim();
  if (!raw) return null;

  // 1. 64자리 hex 문자열 (32바이트)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // 2. base64 디코딩 시 32바이트
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  } catch {
    // ignore
  }

  // 3. UTF-8 바이트 길이가 정확히 32바이트
  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) return utf8;

  return null;
}

/**
 * 암호화 마스터 키 설정 여부 확인
 * @param {string} [overrideKey]
 * @returns {boolean}
 */
export function isMasterKeyConfigured(overrideKey) {
  return getMasterKey(overrideKey) !== null;
}

/**
 * 암호화 파일 경로
 * @param {string} [dataDir]
 * @returns {string}
 */
export function getEncryptedKeyPath(dataDir) {
  const dir =
    dataDir || process.env.DATA_DIR || path.join(process.cwd(), "app", "data");
  return path.join(dir, "ExternalApiKey.enc.json");
}

/**
 * 문자열 AES-256-GCM 암호화 (테스트 및 내부용)
 * @param {string} text - 암호화할 문자열
 * @param {Buffer} masterKeyBuffer - 32바이트 키
 * @returns {{ version: number, iv: string, tag: string, data: string }}
 */
export function encryptApiKeyString(text, masterKeyBuffer) {
  if (!masterKeyBuffer || masterKeyBuffer.length !== 32) {
    throw new Error("Master key must be a 32-byte Buffer");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKeyBuffer, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: data.toString("hex"),
  };
}

/**
 * AES-256-GCM 복호화 (테스트 및 내부용)
 * @param {{ iv: string, tag: string, data: string }} payload
 * @param {Buffer} masterKeyBuffer
 * @returns {string}
 */
export function decryptApiKeyString(payload, masterKeyBuffer) {
  if (!masterKeyBuffer || masterKeyBuffer.length !== 32) {
    throw new Error("Master key must be a 32-byte Buffer");
  }
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKeyBuffer, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 암호화 파일에 API 키 저장
 * @param {string} key
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Buffer|string} [opts.masterKey]
 * @returns {Promise<{ success: boolean, updatedAt: string }>}
 */
export async function saveEncryptedApiKey(key, { dataDir, masterKey } = {}) {
  if (!validateApiKeyFormat(key)) {
    throw new HomepageIntegrationError({
      message: "API 키 형식이 올바르지 않습니다 (8~512자, 공백 불가)",
      code: "INVALID_KEY_FORMAT",
      statusCode: 400,
    });
  }

  const keyBuffer =
    Buffer.isBuffer(masterKey) && masterKey.length === 32
      ? masterKey
      : getMasterKey(typeof masterKey === "string" ? masterKey : undefined);

  if (!keyBuffer) {
    throw new HomepageIntegrationError({
      message:
        "암호화 마스터 키가 설정되지 않음 (HOMEPAGE_KEY_ENCRYPTION_KEY 필요)",
      code: "KEY_ENCRYPTION_UNAVAILABLE",
      statusCode: 503,
    });
  }

  const encrypted = encryptApiKeyString(key, keyBuffer);
  const now = new Date().toISOString();
  const filePath = getEncryptedKeyPath(dataDir);

  let createdAt = now;
  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (existing.createdAt) createdAt = existing.createdAt;
    } catch {
      // ignore
    }
  }

  const payload = {
    ...encrypted,
    createdAt,
    updatedAt: now,
  };

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
  return { success: true, updatedAt: now };
}

/**
 * 암호화 파일에서 API 키 복호화 및 로드
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {Buffer|string} [opts.masterKey]
 * @returns {{ key: string, updatedAt: string|null }|null}
 */
export function loadEncryptedApiKey({ dataDir, masterKey } = {}) {
  const filePath = getEncryptedKeyPath(dataDir);
  if (!fs.existsSync(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o111) !== 0) {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // ignore
  }

  const keyBuffer =
    Buffer.isBuffer(masterKey) && masterKey.length === 32
      ? masterKey
      : getMasterKey(typeof masterKey === "string" ? masterKey : undefined);

  if (!keyBuffer) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    const payload = JSON.parse(raw);
    if (!payload.iv || !payload.tag || !payload.data) return null;

    const decrypted = decryptApiKeyString(payload, keyBuffer);
    if (validateApiKeyFormat(decrypted)) {
      return {
        key: decrypted,
        updatedAt: payload.updatedAt || payload.createdAt || null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 암호화 파일 삭제
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @returns {Promise<{ success: boolean }>}
 */
export async function deleteEncryptedApiKey({ dataDir } = {}) {
  const filePath = getEncryptedKeyPath(dataDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
  return { success: true };
}

/**
 * 암호화 파일 메타데이터 조회 (키 제외)
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @returns {{ exists: boolean, createdAt: string|null, updatedAt: string|null }}
 */
export function getEncryptedKeyMetadata({ dataDir } = {}) {
  const filePath = getEncryptedKeyPath(dataDir);
  if (!fs.existsSync(filePath)) {
    return { exists: false, createdAt: null, updatedAt: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    return {
      exists: true,
      createdAt: payload.createdAt || null,
      updatedAt: payload.updatedAt || payload.createdAt || null,
    };
  } catch {
    return { exists: true, createdAt: null, updatedAt: null };
  }
}

/**
 * API 키 해석 (우선순위: env HOMEPAGE_API_KEY > 암호화 파일 > null)
 * @param {string|object} [options] - dataDir 문자열 또는 { dataDir }
 * @returns {Promise<{key: string, source: 'env'|'file'|'encrypted_file', updatedAt?: string|null} | null>}
 */
export async function resolveApiKey(options = {}) {
  const dataDir =
    typeof options === "string"
      ? options
      : options?.dataDir ||
        process.env.DATA_DIR ||
        path.join(process.cwd(), "app", "data");

  // 1순위: Docker Secrets 파일
  const keyFilePath =
    process.env.HOMEPAGE_API_KEY_FILE?.trim() ||
    "/run/secrets/homepage_api_key";

  if (fs.existsSync(keyFilePath)) {
    try {
      const key = fs.readFileSync(keyFilePath, "utf8").trim();
      if (validateApiKeyFormat(key)) {
        return { key, source: "file" };
      }
    } catch {
      // 파일 읽기 실패 시 env로 폴백
    }
  }

  // 2순위: 환경변수 직접 입력
  const envKey = process.env.HOMEPAGE_API_KEY?.trim();
  if (envKey && validateApiKeyFormat(envKey)) {
    return { key: envKey, source: "env" };
  }

  // 3순위: 암호화 파일 (ExternalApiKey.enc.json)
  const encKey = loadEncryptedApiKey({ dataDir });
  if (encKey?.key) {
    return {
      key: encKey.key,
      source: "encrypted_file",
      updatedAt: encKey.updatedAt,
    };
  }

  // 없으면 null 반환 (throw 안 함 — 호출자가 fail-closed 판정)
  return null;
}

/**
 * 모의 모드용 합성 키
 */
export const MOCK_API_KEY = "mock-homepage-key";

/**
 * 키 검증 (형식만 — 8~512자, 공백/따옴표/URL/Bearer 금지)
 * @param {string} key
 * @returns {boolean}
 */
export function validateApiKeyFormat(key) {
  return (
    typeof key === "string" &&
    key.length >= 8 &&
    key.length <= 512 &&
    !/[\s\n\r"']/.test(key) &&
    !/^https?:\/\//i.test(key) &&
    !/^Bearer\s+/i.test(key)
  );
}

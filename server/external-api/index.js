/**
 * server/external-api/index.js
 * Homepage Integration Engine — Assembly & Export
 * ESM module.
 * 03 문서 §2-12 표 그대로 구현.
 */

import {
  loadEngineConfig,
  resolveApiKey,
  MOCK_API_KEY,
  getEngineConfigSummary,
  saveEngineSettings,
  saveEncryptedApiKey,
  deleteEncryptedApiKey,
  getEncryptedKeyMetadata,
  isMasterKeyConfigured,
  validateApiKeyFormat,
} from "./engineConfig.js";
import {
  HomepageClient,
  MockHomepageClient,
  ENDPOINT_PATHS,
} from "./homepageClient.js";
import { HomepagePayloadValidator } from "./payloadValidator.js";
import {
  IdempotencyStore,
  createIdempotencyStore,
} from "./idempotencyStore.js";
import { createSyncHistoryStores } from "./syncHistory.js";
import {
  mapReferralToPending,
  mapAssessmentToSubmission,
  resolveReferralLink,
  classifyMissingFields,
  SOURCE_CHANNEL,
} from "./intakeAdapter.js";
import { HomepageEngineService, createEngineService } from "./engineService.js";
import { HomepagePollScheduler, createPollScheduler } from "./pollScheduler.js";
import { createExternalApiRouter } from "./engineRouter.js";
import {
  HomepageIntegrationError,
  ENGINE_ERROR_CODES,
  maskForLog,
  maskPayloadForLog,
  computeAuthFingerprint,
} from "./engineErrors.js";
import {
  validateHomepageBaseUrl,
  isValidHomepageBaseUrl,
} from "./urlValidator.js";

/**
 * 외부 API 엔진 조립
 * @param {object} deps
 * @param {Function} deps.getData
 * @param {Function} deps.persistData
 * @param {Function} deps.requireAuth
 * @param {Function} deps.requireAdmin
 * @param {Function} deps.auditLogger
 * @returns {object} { config, client, engineService, pollScheduler, engineRouter }
 */
export async function createExternalApiEngine(deps) {
  const {
    getData,
    persistData,
    requireAuth,
    requireAdmin,
    auditLogger,
    dataDir,
  } = deps;

  // 1. 설정 로드 (실패해도 throw하지 않고 disabled 엔진 반환)
  let config;
  let disabledReason = null;
  try {
    config = loadEngineConfig({ getData, persistData, dataDir });
  } catch (err) {
    disabledReason = err.message;
    config = { enabled: false, disabledReason, mode: "mock" };
  }

  // 2. API 키 해석 및 클라이언트 생성
  let client = null;
  let keyFingerprint = null;

  if (config.enabled !== false) {
    const keyInfo = await resolveApiKey({ dataDir });

    if (config.mode === "mock") {
      // Mock 모드에서는 환경변수 키로 진짜 HomepageClient 사용 (HTTP Mock 서버 호출)
      // 테스트에서 잘못된 키를 주면 401이 발생하도록 함
      const mockApiKey =
        process.env.HOMEPAGE_API_KEY || (keyInfo ? keyInfo.key : MOCK_API_KEY);
      const baseClient = new HomepageClient({
        baseUrl: config.baseUrl || "http://localhost:9999",
        apiKey: mockApiKey,
        apiKeyHeader: config.apiKeyHeader,
        authScheme: config.authScheme,
        orgId: config.orgId || "mock-org",
        orgIdPlacement: config.orgIdPlacement,
        timeoutMs: config.requestTimeoutMs,
        maxBatchSize: config.maxBatchSize,
      });
      // Mock 서버용 acknowledgeItem 래퍼: externalId에 "REF" 포함 시 referral, "ASM" 포함 시 assessment로 판단
      const originalAcknowledgeItem = baseClient.acknowledgeItem.bind(baseClient);
      baseClient.acknowledgeItem = async function (externalId, { requestId }) {
        const kind = externalId.includes("REF") ? "referral" : "assessment";
        const safeId = baseClient._sanitizeId(externalId);
        const ackPath =
          kind === "referral"
            ? ENDPOINT_PATHS.ACK_REFERRAL(safeId)
            : ENDPOINT_PATHS.ACK_ASSESSMENT(safeId);
        return baseClient._request(ackPath, {
          method: "POST",
          body: { requestId },
          externalId,
        });
      };
      client = baseClient;
      keyFingerprint = keyInfo
        ? computeAuthFingerprint(keyInfo.key)
        : process.env.HOMEPAGE_API_KEY
          ? computeAuthFingerprint(process.env.HOMEPAGE_API_KEY)
          : null;
    } else if (keyInfo) {
      // Production/Staging: 실제 키 사용
      client = new HomepageClient({
        baseUrl: config.baseUrl,
        apiKey: keyInfo.key,
        apiKeyHeader: config.apiKeyHeader,
        authScheme: config.authScheme,
        orgId: config.orgId,
        orgIdPlacement: config.orgIdPlacement,
        timeoutMs: config.requestTimeoutMs,
        maxBatchSize: config.maxBatchSize,
      });
      keyFingerprint = computeAuthFingerprint(keyInfo.key);
    } else {
      // 키가 없으면 클라이언트 없이 disabled 상태로
      config.enabled = false;
      disabledReason =
        "API 키가 설정되지 않음 (Docker Secrets 파일 또는 환경변수 필요)";
      client = null;
    }
  }

  // 설정 요약에 키 지문 포함
  const configSummary = getEngineConfigSummary(config, keyFingerprint);

  // 3. 하위 모듈 인스턴스 생성
  const payloadValidator = new HomepagePayloadValidator();
  const idempotencyStore = createIdempotencyStore({
    dataDir: dataDir || process.env.DATA_DIR,
    auditLogger,
  });
  const syncHistory = createSyncHistoryStores({
    dataDir: dataDir || process.env.DATA_DIR,
  });

  // 엔진 서비스용 설정 객체 (enabled 플래그 추가)
  const engineConfig = { ...config, enabled: config.enabled !== false };

  const engineService = createEngineService({
    client,
    payloadValidator,
    idempotencyStore,
    intakeAdapter: {
      mapReferralToPending,
      mapAssessmentToSubmission,
      resolveReferralLink,
      classifyMissingFields,
    },
    syncHistory,
    config: engineConfig,
    persistData,
    getData,
    auditLogger,
    pollScheduler: null, // 나중에 주입
  });

  const pollScheduler = createPollScheduler({
    engineService,
    config: engineConfig,
    auditLogger,
  });

  // 순환 참조 해결: engineService에 pollScheduler 주입
  engineService.pollScheduler = pollScheduler;
  pollScheduler.setSyncHistory(syncHistory);

  // 4. API 키 재로드 함수
  const reloadApiKey = async () => {
    const keyInfo = await resolveApiKey({ dataDir });

    let currentConfig = config;
    try {
      currentConfig = loadEngineConfig({ getData, persistData, dataDir });
    } catch {
      // ignore
    }

    if (currentConfig.mode === "mock") {
      const activeKey =
        process.env.HOMEPAGE_API_KEY || (keyInfo ? keyInfo.key : MOCK_API_KEY);
      if (client) {
        client.apiKey = activeKey;
      } else {
        const baseClient = new HomepageClient({
          baseUrl: currentConfig.baseUrl || "http://localhost:9999",
          apiKey: activeKey,
          apiKeyHeader: currentConfig.apiKeyHeader,
          authScheme: currentConfig.authScheme,
          orgId: currentConfig.orgId || "mock-org",
          orgIdPlacement: currentConfig.orgIdPlacement,
          timeoutMs: currentConfig.requestTimeoutMs,
          maxBatchSize: currentConfig.maxBatchSize,
        });
        const originalAcknowledgeItem = baseClient.acknowledgeItem.bind(baseClient);
        baseClient.acknowledgeItem = async function (externalId, { requestId }) {
          const kind = externalId.includes("REF") ? "referral" : "assessment";
          const safeId = baseClient._sanitizeId(externalId);
          const ackPath =
            kind === "referral"
              ? ENDPOINT_PATHS.ACK_REFERRAL(safeId)
              : ENDPOINT_PATHS.ACK_ASSESSMENT(safeId);
          return baseClient._request(ackPath, {
            method: "POST",
            body: { requestId },
            externalId,
          });
        };
        client = baseClient;
        engineService.updateClient(client);
      }
      keyFingerprint = keyInfo
        ? computeAuthFingerprint(keyInfo.key)
        : process.env.HOMEPAGE_API_KEY
          ? computeAuthFingerprint(process.env.HOMEPAGE_API_KEY)
          : null;
    } else {
      if (keyInfo) {
        client = new HomepageClient({
          baseUrl: currentConfig.baseUrl,
          apiKey: keyInfo.key,
          apiKeyHeader: currentConfig.apiKeyHeader,
          authScheme: currentConfig.authScheme,
          orgId: currentConfig.orgId,
          orgIdPlacement: currentConfig.orgIdPlacement,
          timeoutMs: currentConfig.requestTimeoutMs,
          maxBatchSize: currentConfig.maxBatchSize,
        });
        keyFingerprint = computeAuthFingerprint(keyInfo.key);
        currentConfig.enabled = true;
        currentConfig.disabledReason = null;
        engineService.updateClient(client);
        engineService.config.enabled = true;
        if (pollScheduler && currentConfig.pollEnabled) {
          pollScheduler.stop();
          pollScheduler.start();
        }
      } else {
        client = null;
        keyFingerprint = null;
        currentConfig.enabled = false;
        currentConfig.disabledReason = "API 키가 설정되지 않음";
        engineService.updateClient(null);
        engineService.config.enabled = false;
        if (pollScheduler) {
          pollScheduler.stop();
        }
      }
    }

    return { client, keyFingerprint };
  };

  const engineRouter = createExternalApiRouter({
    requireAuth,
    requireAdmin,
    engineService,
    pollScheduler,
    engineConfig: {
      loadEngineConfig,
      saveEngineSettings,
      getEngineConfigSummary,
      resolveApiKey,
      saveEncryptedApiKey,
      deleteEncryptedApiKey,
      getEncryptedKeyMetadata,
      isMasterKeyConfigured,
      validateApiKeyFormat,
      MOCK_API_KEY,
    },
    homepageClient: client,
    getHomepageClient: () => client,
    reloadApiKey,
    dataDir: dataDir || process.env.DATA_DIR,
    auditLogger,
    getData,
    persistData,
  });

  return {
    config: configSummary,
    client,
    engineService,
    pollScheduler,
    engineRouter,
    reloadApiKey,
    getData,
    persistData,
  };
}

/**
 * 외부 API 엔진 시작 (스케줄러 기동 + 기동 시 1회 상태 기록)
 * @param {object} engine - createExternalApiEngine 반환 객체
 */
export function startExternalApiEngine(engine) {
  if (engine.pollScheduler) {
    engine.pollScheduler.start();
  }
}

/**
 * 편의 export: 엔진 에러 클래스 및 유틸리티
 */
export {
  HomepageIntegrationError,
  ENGINE_ERROR_CODES,
  maskForLog,
  maskPayloadForLog,
  computeAuthFingerprint,
};

/**
 * 편의 export: 설정 관련
 */
export {
  loadEngineConfig,
  saveEngineSettings,
  getEngineConfigSummary,
  resolveApiKey,
  saveEncryptedApiKey,
  deleteEncryptedApiKey,
  getEncryptedKeyMetadata,
  isMasterKeyConfigured,
  validateApiKeyFormat,
  MOCK_API_KEY,
  validateHomepageBaseUrl,
  isValidHomepageBaseUrl,
};

/**
 * 편의 export: 클라이언트
 */
export { HomepageClient, MockHomepageClient, ENDPOINT_PATHS };

/**
 * 편의 export: 검증기
 */
export { HomepagePayloadValidator };

/**
 * 편의 export: 멱등성
 */
export { IdempotencyStore, createIdempotencyStore };

/**
 * 편의 export: 이력
 */
export { createSyncHistoryStores };

/**
 * 편의 export: 어댑터
 */
export {
  mapReferralToPending,
  mapAssessmentToSubmission,
  resolveReferralLink,
  classifyMissingFields,
  SOURCE_CHANNEL,
};

/**
 * 편의 export: 서비스
 */
export { HomepageEngineService, createEngineService };

/**
 * 편의 export: 스케줄러
 */
export { HomepagePollScheduler, createPollScheduler };

/**
 * 편의 export: 라우터
 */
export { createExternalApiRouter };

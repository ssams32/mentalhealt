/**
 * server/external-api/engineRouter.js
 * Homepage Integration Engine — Admin Router Factory
 * ESM module.
 * createSurveyImportRouter 패턴 그대로, 의존성 주입 방식.
 */

import express from "express";
import {
  HomepageIntegrationError,
  ENGINE_ERROR_CODES,
} from "./engineErrors.js";

// 인메모리 속도 제한 카운터 (관리자 ID → 마지막 호출 시각 Map)
const testConnectionRateLimit = new Map(); // 분당 5회
const syncRateLimit = new Map(); // 관리자당 분당 2회 + 전역 10초
const keyManagementRateLimit = new Map(); // 관리자당 분당 5회

/**
 * 속도 제한 체크
 * @param {Map} store
 * @param {string} key
 * @param {number} maxCalls
 * @param {number} windowMs
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
function checkRateLimit(store, key, maxCalls, windowMs) {
  const now = Date.now();
  const calls = store.get(key) || [];
  const recentCalls = calls.filter((t) => now - t < windowMs);

  if (recentCalls.length >= maxCalls) {
    const oldest = recentCalls[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  recentCalls.push(now);
  store.set(key, recentCalls);
  return { allowed: true };
}

/**
 * 전역 동기화 속도 제한 (10초 간격)
 */
function checkGlobalSyncLimit() {
  const now = Date.now();
  const lastSync = global._lastExternalApiSyncAt || 0;
  if (now - lastSync < 10000) {
    const retryAfter = Math.ceil((lastSync + 10000 - now) / 1000);
    return { allowed: false, retryAfter };
  }
  global._lastExternalApiSyncAt = now;
  return { allowed: true };
}

/**
 * Origin 검증 (CSRF 방어)
 * @param {Request} req
 * @returns {boolean}
 */
function verifyOrigin(req) {
  const origin = req.get("origin");
  const referer = req.get("referer");
  const host = req.get("host");

  // Origin 없는 요청은 production에서 차단
  if (process.env.NODE_ENV === "production" && !origin && !referer) {
    return false;
  }

  // Origin이 있으면 host와 일치하는지 확인
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      return originHost === host;
    } catch {
      return false;
    }
  }

  // Referer로 폴백
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      return refererHost === host;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * 외부 API 라우터 팩토리
 * @param {object} deps
 * @param {Function} deps.requireAuth - 인증 미들웨어
 * @param {Function} deps.requireAdmin - 관리자 미들웨어
 * @param {HomepageEngineService} deps.engineService
 * @param {HomepagePollScheduler} deps.pollScheduler
 * @param {object} deps.engineConfig - { loadEngineConfig, saveEngineSettings, getEngineConfigSummary, resolveApiKey }
 * @param {HomepageClient} deps.homepageClient
 * @param {Function} deps.auditLogger
 * @returns {express.Router}
 */
export function createExternalApiRouter(deps) {
  const {
    requireAuth,
    requireAdmin,
    engineService,
    pollScheduler,
    engineConfig,
    homepageClient,
    auditLogger,
  } = deps;

  const router = express.Router();

  // 라우터 레벨에서 관리자 권한 강제 (assetRouter 패턴)
  router.use(requireAuth);
  router.use(requireAdmin);

  // 상태 변경 엔드포인트에 Origin 검증 적용
  const verifyStateChangingOrigin = (req, res, next) => {
    if (!verifyOrigin(req)) {
      return res.status(403).json({
        error: {
          code: "ORIGIN_MISMATCH",
          message: "요청 출처가 일치하지 않습니다",
        },
      });
    }
    next();
  };

  // ==========================================
  // 1. GET /status — 엔진·스케줄러 상태 + 마지막 수신 요약
  // ==========================================
  router.get("/status", async (req, res) => {
    try {
      const status = engineService.getStatus();
      res.json(status);
    } catch (err) {
      console.error("[EXTERNAL_API] GET /status error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 2. GET /config — 현재 설정 (키 값 제외, 키 존재 여부 + 지문만)
  // ==========================================
  router.get("/config", async (req, res) => {
    try {
      // 미설정 상태면 loadEngineConfig가 CONFIG_MISSING을 던진다.
      // 그 경우 disabled 요약으로 200을 반환한다
      // (createExternalApiEngine의 기동 시 처리와 동일 — 설정 화면이
      //  미설정 상태에서도 떠야 관리자가 처음 설정을 저장할 수 있다).
      let config;
      try {
        config = engineConfig.loadEngineConfig({
          getData: deps.getData,
          persistData: deps.persistData,
        });
      } catch (loadErr) {
        if (
          loadErr instanceof HomepageIntegrationError &&
          loadErr.code === "CONFIG_MISSING"
        ) {
          config = {
            enabled: false,
            disabledReason: loadErr.message,
            mode: "mock",
          };
        } else {
          throw loadErr;
        }
      }

      // API 키 지문 및 등록 메타데이터 계산
      let keyFingerprint = null;
      let keyRegisteredAt = null;

      const keyInfo = await engineConfig.resolveApiKey({
        dataDir: deps.dataDir,
      });
      if (keyInfo) {
        const { computeAuthFingerprint } = await import("./engineErrors.js");
        keyFingerprint = computeAuthFingerprint(keyInfo.key);
      } else {
        const currentClient =
          (typeof deps.getHomepageClient === "function"
            ? deps.getHomepageClient()
            : engineService?.client) || homepageClient;
        if (
          currentClient?.apiKey &&
          currentClient.apiKey !== engineConfig.MOCK_API_KEY
        ) {
          const { computeAuthFingerprint } = await import("./engineErrors.js");
          keyFingerprint = computeAuthFingerprint(currentClient.apiKey);
        }
      }

      if (typeof engineConfig.getEncryptedKeyMetadata === "function") {
        const keyMeta = engineConfig.getEncryptedKeyMetadata({
          dataDir: deps.dataDir,
        });
        if (keyMeta?.updatedAt) {
          keyRegisteredAt = keyMeta.updatedAt;
        }
      }

      const masterKeyConfigured =
        typeof engineConfig.isMasterKeyConfigured === "function"
          ? engineConfig.isMasterKeyConfigured()
          : false;

      const summary = engineConfig.getEngineConfigSummary(
        config,
        keyFingerprint,
        { keyRegisteredAt, masterKeyConfigured },
      );
      res.json(summary);
    } catch (err) {
      console.error("[EXTERNAL_API] GET /config error:", err);
      if (err instanceof HomepageIntegrationError) {
        return res
          .status(err.statusCode)
          .json({ error: { code: err.code, message: err.message } });
      }
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 3. PUT /config — 비키 설정 변경 (키 변경 불가)
  // ==========================================
  router.put("/config", verifyStateChangingOrigin, async (req, res) => {
    try {
      const patch = req.body || {};
      const actorUserId = req.auth?.userId || "unknown";

      const saved = await engineConfig.saveEngineSettings(patch, actorUserId, {
        getData: deps.getData,
        persistData: deps.persistData,
      });

      // 감사 로그
      if (typeof auditLogger === "function") {
        await auditLogger({
          action: "EXTERNAL_API_CONFIG_CHANGED",
          actorUserId,
          targetId: Object.keys(patch).join(","),
          result: "SUCCESS",
        });
      }

      // 스케줄러 설정 동기화
      if (pollScheduler) {
        pollScheduler.updateConfig(saved);
      }

      res.json({ success: true, config: saved });
    } catch (err) {
      console.error("[EXTERNAL_API] PUT /config error:", err);
      if (err instanceof HomepageIntegrationError) {
        return res
          .status(err.statusCode)
          .json({ error: { code: err.code, message: err.message } });
      }
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 4. POST /test-connection — 연결 테스트 (관리자당 분당 5회)
  // ==========================================
  router.post(
    "/test-connection",
    verifyStateChangingOrigin,
    async (req, res) => {
      try {
        const adminId = req.auth?.userId || "unknown";
        const rateLimit = checkRateLimit(
          testConnectionRateLimit,
          `test:${adminId}`,
          5,
          60000,
        );
        if (!rateLimit.allowed) {
          return res
            .set("Retry-After", rateLimit.retryAfter)
            .status(429)
            .json({
              error: {
                code: "RATE_LIMITED",
                message: "연결 테스트는 분당 5회까지 가능합니다",
              },
            });
        }

        const activeClient =
          (typeof deps.getHomepageClient === "function"
            ? deps.getHomepageClient()
            : engineService?.client) || homepageClient;

        if (!activeClient) {
          return res.status(409).json({
            error: {
              code: "ENGINE_DISABLED",
              message: "API 키가 설정되지 않아 연결 테스트할 수 없습니다",
            },
          });
        }

        const startTime = Date.now();
        const [pingResult, capResult] = await Promise.all([
          activeClient.ping().catch(() => false),
          activeClient
            .checkCapabilities()
            .catch(() => ({ valid: false, data: {} })),
        ]);

        const latencyMs = Date.now() - startTime;
        const success = pingResult && capResult.valid;

        const result = {
          success,
          httpStatus: success ? 200 : 502,
          latencyMs,
          authPassed: pingResult,
          error: success ? null : capResult.data?.error || "연결 실패",
          testedAt: new Date().toISOString(),
        };

        res.json(result);
      } catch (err) {
        console.error("[EXTERNAL_API] POST /test-connection error:", err);
        res
          .status(500)
          .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
      }
    },
  );

  // ==========================================
  // 4-1. POST /key — API 키 등록·변경 (관리자당 분당 5회)
  // ==========================================
  router.post("/key", verifyStateChangingOrigin, async (req, res) => {
    try {
      const adminId = req.auth?.userId || "unknown";
      const rateLimit = checkRateLimit(
        keyManagementRateLimit,
        `key:${adminId}`,
        5,
        60000,
      );
      if (!rateLimit.allowed) {
        return res
          .set("Retry-After", rateLimit.retryAfter)
          .status(429)
          .json({
            error: {
              code: "RATE_LIMITED",
              message: "API 키 관리는 분당 5회까지 가능합니다",
            },
          });
      }

      if (
        typeof engineConfig.isMasterKeyConfigured === "function" &&
        !engineConfig.isMasterKeyConfigured()
      ) {
        return res.status(503).json({
          error: {
            code: "KEY_ENCRYPTION_UNAVAILABLE",
            message:
              "암호화 마스터 키가 설정되지 않음 (HOMEPAGE_KEY_ENCRYPTION_KEY 필요)",
          },
        });
      }

      const { key } = req.body || {};
      if (
        !key ||
        (typeof engineConfig.validateApiKeyFormat === "function" &&
          !engineConfig.validateApiKeyFormat(key))
      ) {
        return res.status(400).json({
          error: {
            code: "INVALID_KEY_FORMAT",
            message: "API 키 형식이 올바르지 않습니다 (16~512자, 공백 불가)",
          },
        });
      }

      // 암호화 파일에 저장
      await engineConfig.saveEncryptedApiKey(key, { dataDir: deps.dataDir });

      const { computeAuthFingerprint } = await import("./engineErrors.js");
      const keyFingerprint = computeAuthFingerprint(key);

      // 감사 이벤트 기록 (키 평문 절대 금지, 지문만 기록)
      if (typeof auditLogger === "function") {
        await auditLogger({
          action: "EXTERNAL_API_KEY_REGISTERED",
          actorUserId: adminId,
          targetId: keyFingerprint.slice(0, 8),
          result: "SUCCESS",
        });
      }

      // 엔진 클라이언트 재로드
      if (typeof deps.reloadApiKey === "function") {
        await deps.reloadApiKey();
      }

      res.json({
        success: true,
        keyPresent: true,
        keyFingerprint,
      });
    } catch (err) {
      console.error("[EXTERNAL_API] POST /key error:", err);
      if (err instanceof HomepageIntegrationError) {
        return res
          .status(err.statusCode)
          .json({ error: { code: err.code, message: err.message } });
      }
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 4-2. DELETE /key — API 키 폐기 (관리자당 분당 5회)
  // ==========================================
  router.delete("/key", verifyStateChangingOrigin, async (req, res) => {
    try {
      const adminId = req.auth?.userId || "unknown";
      const rateLimit = checkRateLimit(
        keyManagementRateLimit,
        `key:${adminId}`,
        5,
        60000,
      );
      if (!rateLimit.allowed) {
        return res
          .set("Retry-After", rateLimit.retryAfter)
          .status(429)
          .json({
            error: {
              code: "RATE_LIMITED",
              message: "API 키 관리는 분당 5회까지 가능합니다",
            },
          });
      }

      if (typeof engineConfig.deleteEncryptedApiKey === "function") {
        await engineConfig.deleteEncryptedApiKey({ dataDir: deps.dataDir });
      }

      // 감사 이벤트 기록
      if (typeof auditLogger === "function") {
        await auditLogger({
          action: "EXTERNAL_API_KEY_DELETED",
          actorUserId: adminId,
          targetId: "ExternalApiKey",
          result: "SUCCESS",
        });
      }

      // 엔진 클라이언트 재로드
      if (typeof deps.reloadApiKey === "function") {
        await deps.reloadApiKey();
      }

      res.json({
        success: true,
        keyPresent: false,
      });
    } catch (err) {
      console.error("[EXTERNAL_API] DELETE /key error:", err);
      if (err instanceof HomepageIntegrationError) {
        return res
          .status(err.statusCode)
          .json({ error: { code: err.code, message: err.message } });
      }
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 5. POST /sync — 수동 동기화 1회 실행 (202 + jobId 반환)
  // ==========================================
  router.post("/sync", verifyStateChangingOrigin, async (req, res) => {
    try {
      const adminId = req.auth?.userId || "unknown";

      // 전역 10초 간격 체크
      const globalLimit = checkGlobalSyncLimit();
      if (!globalLimit.allowed) {
        return res
          .set("Retry-After", globalLimit.retryAfter)
          .status(429)
          .json({
            error: {
              code: "SYNC_TOO_FREQUENT",
              message: "전역 동기화 간격 10초 미만",
            },
          });
      }

      // 관리자당 분당 2회 체크
      const adminLimit = checkRateLimit(
        syncRateLimit,
        `sync:${adminId}`,
        2,
        60000,
      );
      if (!adminLimit.allowed) {
        return res
          .set("Retry-After", adminLimit.retryAfter)
          .status(429)
          .json({
            error: {
              code: "RATE_LIMITED",
              message: "수동 동기화는 분당 2회까지 가능합니다",
            },
          });
      }

      // 스케줄러의 10초 쓰로틀 체크
      if (pollScheduler && !pollScheduler.checkManualSyncThrottle()) {
        return res
          .set("Retry-After", 10)
          .status(429)
          .json({
            error: {
              code: "SYNC_TOO_FREQUENT",
              message: "수동 동기화 간격 10초 미만",
            },
          });
      }

      const { v4: uuidv4 } = await import("crypto");
      const jobId = `job_${Date.now()}_${uuidv4().slice(0, 8)}`;

      // 비동기로 실행 (catch에서 에러 처리)
      engineService
        .runSyncCycle({ actorId: adminId, trigger: "manual" })
        .then((summary) => {
          // 잡 상태 저장 (메모리 또는 파일)
          if (!global._externalApiJobs) global._externalApiJobs = new Map();
          global._externalApiJobs.set(jobId, {
            jobId,
            status: "completed",
            summary,
            completedAt: new Date().toISOString(),
          });
        })
        .catch((err) => {
          if (!global._externalApiJobs) global._externalApiJobs = new Map();
          global._externalApiJobs.set(jobId, {
            jobId,
            status: "failed",
            error: err.message,
            completedAt: new Date().toISOString(),
          });
        });

      res.status(202).json({ success: true, jobId });
    } catch (err) {
      console.error("[EXTERNAL_API] POST /sync error:", err);
      if (err instanceof HomepageIntegrationError) {
        return res
          .status(err.statusCode)
          .json({ error: { code: err.code, message: err.message } });
      }
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 6. GET /sync/:jobId — 수동 동기화 잡 상태 폴링
  // ==========================================
  router.get("/sync/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const jobs = global._externalApiJobs || new Map();
      const job = jobs.get(jobId);

      if (!job) {
        return res
          .status(404)
          .json({
            error: { code: "NOT_FOUND", message: "잡을 찾을 수 없습니다" },
          });
      }

      res.json(job);
    } catch (err) {
      console.error("[EXTERNAL_API] GET /sync/:jobId error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 7. GET /history — 동기화 이력 목록
  // ==========================================
  router.get("/history", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);

      const history = engineService.syncHistory.history.getHistory(
        limit,
        offset,
      );
      res.json({
        items: history,
        total: engineService.syncHistory.history.totalCount,
      });
    } catch (err) {
      console.error("[EXTERNAL_API] GET /history error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 8. GET /history/:cycleId — 사이클 1건 상세
  // ==========================================
  router.get("/history/:cycleId", async (req, res) => {
    try {
      const { cycleId } = req.params;
      const cycle = engineService.syncHistory.history.getCycle(cycleId);

      if (!cycle) {
        return res
          .status(404)
          .json({
            error: { code: "NOT_FOUND", message: "사이클을 찾을 수 없습니다" },
          });
      }

      res.json(cycle);
    } catch (err) {
      console.error("[EXTERNAL_API] GET /history/:cycleId error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 9. GET /retry-queue — 실패 재처리 큐 목록
  // ==========================================
  router.get("/retry-queue", async (req, res) => {
    try {
      const queue = engineService.syncHistory.retryQueue.getAll();
      res.json({ items: queue, total: queue.length });
    } catch (err) {
      console.error("[EXTERNAL_API] GET /retry-queue error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  // ==========================================
  // 10. POST /retry/:externalId — 실패 항목 1건 재처리
  // ==========================================
  router.post(
    "/retry/:externalId",
    verifyStateChangingOrigin,
    async (req, res) => {
      try {
        const { externalId } = req.params;
        const adminId = req.auth?.userId || "unknown";

        await engineService.retryFailedItem(externalId, { actorId: adminId });

        res.json({ success: true });
      } catch (err) {
        console.error("[EXTERNAL_API] POST /retry/:externalId error:", err);
        if (err instanceof HomepageIntegrationError) {
          return res
            .status(err.statusCode)
            .json({ error: { code: err.code, message: err.message } });
        }
        res
          .status(500)
          .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
      }
    },
  );

  // ==========================================
  // 11. POST /retry-queue/retry-all — 재시도 큐 전체 재처리
  // ==========================================
  router.post(
    "/retry-queue/retry-all",
    verifyStateChangingOrigin,
    async (req, res) => {
      try {
        const adminId = req.auth?.userId || "unknown";
        const result = await engineService.retryAllFailed({ actorId: adminId });
        res.json({ success: true, ...result });
      } catch (err) {
        console.error("[EXTERNAL_API] POST /retry-queue/retry-all error:", err);
        if (err instanceof HomepageIntegrationError) {
          return res
            .status(err.statusCode)
            .json({ error: { code: err.code, message: err.message } });
        }
        res
          .status(500)
          .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
      }
    },
  );

  // ==========================================
  // 12. GET /seen/:externalId — 외부 ID 수신 여부 조회
  // ==========================================
  router.get("/seen/:externalId", async (req, res) => {
    try {
      const { externalId } = req.params;
      const record = engineService.idempotencyStore.getSeenRecord(externalId);

      if (!record) {
        return res.json({ seen: false });
      }

      res.json({
        seen: true,
        kind: record.kind,
        status: record.status,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        ackedAt: record.ackedAt,
      });
    } catch (err) {
      console.error("[EXTERNAL_API] GET /seen/:externalId error:", err);
      res
        .status(500)
        .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
    }
  });

  return router;
}

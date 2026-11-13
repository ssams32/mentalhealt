/**
 * server/external-api/mockHomepageApi.js
 * Mock Homepage API Server — Node.js built-in http only
 * ESM module.
 * Follows mockTrackAApi.js pattern: in-memory synthetic mock class + scenario control flags.
 * Only runs when HOMEPAGE_API_MODE=mock.
 */

import { createServer } from "http";
import { URL } from "url";
import crypto from "crypto";

/**
 * Mock 에러 코드 (homepageClient의 에러 코드와 일치)
 */
export const MOCK_HOMEPAGE_ERROR_CODES = {
  HOMEPAGE_AUTH_FAILED: "HOMEPAGE_AUTH_FAILED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_PAYLOAD_SCHEMA: "INVALID_PAYLOAD_SCHEMA",
};

/**
 * 유효한 API 키
 */
export const VALID_MOCK_API_KEY = "mock-homepage-key";

/**
 * 시나리오 제어 플래그 기본값
 */
const DEFAULT_SCENARIO = {
  // seed data
  referrals: [],
  assessments: [],
  // scenario flags
  networkAvailable: true,
  failAckNext: false,
  // ack/failed 호출 기록 (테스트 검증용)
  ackLog: [],
  failedLog: [],
};

/**
 * 합성 의뢰 데이터 생성
 */
function createSyntheticReferral(overrides = {}) {
  const now = new Date();
  const baseId = overrides.externalId || `REF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  
  return {
    externalId: baseId,
    receivedAt: overrides.receivedAt || now.toISOString(),
    name: overrides.name || "SYNTHETIC 테스트사용자",
    phone: overrides.phone || "010-0000-0000",
    gender: overrides.gender || "기타",
    age: overrides.age || 30,
    birthDate: overrides.birthDate || "1990-01-01",
    address: overrides.address || "테스트시 테스트구 테스트동 123",
    problem: overrides.problem || "테스트 의뢰 사유입니다.",
    guardianPresence: overrides.guardianPresence ?? false,
    guardianName: overrides.guardianName || "",
    guardianRelation: overrides.guardianRelation || "",
    guardianPhone: overrides.guardianPhone || "",
    guardianNotes: overrides.guardianNotes || "",
    consentToReferral: overrides.consentToReferral ?? true,
    consentNotes: overrides.consentNotes || "",
    reason: overrides.reason || "테스트 의뢰입니다.",
    agency: overrides.agency || "테스트 기관",
    agencyPhone: overrides.agencyPhone || "02-0000-0000",
    requesterName: overrides.requesterName || "테스트 의뢰자",
    requesterFax: overrides.requesterFax || "",
    requesterEmail: overrides.requesterEmail || "test@example.com",
    referralPath: overrides.referralPath || "기관의뢰",
    ...overrides,
  };
}

/**
 * 합성 척도검사 데이터 생성
 */
function createSyntheticAssessment(overrides = {}) {
  const now = new Date();
  const baseId = overrides.externalId || `ASM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  
  return {
    externalId: baseId,
    scale: overrides.scale || "phq-9",
    submittedAt: overrides.submittedAt || now.toISOString(),
    totalScore: overrides.totalScore !== undefined ? overrides.totalScore : 10,
    severity: overrides.severity || "경도",
    scaleScores: overrides.scaleScores || { [overrides.scale || "phq-9"]: { totalScore: overrides.totalScore || 10, severity: overrides.severity || "경도" } },
    sourceSubmissionId: overrides.sourceSubmissionId || baseId,
    ...overrides,
  };
}

/**
 * MockHomepageApi 클래스 — HTTP 서버 래퍼
 */
export class MockHomepageApi {
  constructor(options = {}) {
    // 모드 가드: production/staging에서는 절대 동작하지 않음
    const mode = process.env.HOMEPAGE_API_MODE || "mock";
    if (mode !== "mock") {
      throw new Error(
        `MockHomepageApi는 HOMEPAGE_API_MODE=mock일 때만 동작합니다. 현재 모드: ${mode}`
      );
    }

    this.port = options.port || 3457;
    this.server = null;
    this.scenario = { ...DEFAULT_SCENARIO, ...options.scenario };

    // 기본 시드 데이터 설정 (옵션으로 덮어쓰기 가능)
    if (options.seedReferrals) {
      this.scenario.referrals = options.seedReferrals;
    } else {
      // 기본: 2건의 정상 의뢰
      this.scenario.referrals = [
        createSyntheticReferral({ externalId: "REF-001", name: "SYNTHETIC 테스트사용자1", phone: "010-0000-0001" }),
        createSyntheticReferral({ externalId: "REF-002", name: "SYNTHETIC 테스트사용자2", phone: "010-0000-0002" }),
      ];
    }

    if (options.seedAssessments) {
      this.scenario.assessments = options.seedAssessments;
    } else {
      // 기본: 1건의 정상 척도검사
      this.scenario.assessments = [
        createSyntheticAssessment({ externalId: "ASM-001", scale: "phq-9", totalScore: 10 }),
      ];
    }

    // 시나리오 플래그 적용
    if (options.networkAvailable !== undefined) {
      this.scenario.networkAvailable = options.networkAvailable;
    }
    if (options.failAckNext !== undefined) {
      this.scenario.failAckNext = options.failAckNext;
    }
  }

  /**
   * 서버 시작
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res));
      
      this.server.listen(this.port, () => {
        console.log(`[MOCK_HOMEPAGE_API] Mock server started on port ${this.port}`);
        resolve(this);
      });

      this.server.on("error", (err) => {
        console.error(`[MOCK_HOMEPAGE_API] Server error:`, err);
        reject(err);
      });
    });
  }

  /**
   * 서버 정지
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log(`[MOCK_HOMEPAGE_API] Mock server stopped`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 시나리오 데이터 교체 (테스트용)
   */
  setScenario(scenario) {
    this.scenario = { ...this.scenario, ...scenario };
  }

  /**
   * 의뢰 시드 데이터 교체
   */
  setReferrals(referrals) {
    this.scenario.referrals = referrals;
  }

  /**
   * 척도검사 시드 데이터 교체
   */
  setAssessments(assessments) {
    this.scenario.assessments = assessments;
  }

  /**
   * 네트워크 사용 가능 여부 설정
   */
  setNetworkAvailable(available) {
    this.scenario.networkAvailable = available;
  }

  /**
   * 다음 ack 실패 설정
   */
  setFailAckNext(fail) {
    this.scenario.failAckNext = fail;
  }

  /**
   * ack 호출 기록 조회
   */
  getAckLog() {
    return [...this.scenario.ackLog];
  }

  /**
   * failed 호출 기록 조회
   */
  getFailedLog() {
    return [...this.scenario.failedLog];
  }

  /**
   * 로그 초기화
   */
  clearLogs() {
    this.scenario.ackLog = [];
    this.scenario.failedLog = [];
  }

  /**
   * HTTP 요청 처리
   */
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const path = url.pathname;
    const method = req.method;

    // CORS 헤더
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, X-Org-Id");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 인증 확인
    const apiKey = req.headers["x-api-key"] || req.headers["x-api-key"];
    const isValidKey = apiKey === VALID_MOCK_API_KEY;

    // 네트워크 사용 불가 시뮬레이션
    if (!this.scenario.networkAvailable) {
      this._sendError(res, 503, "NETWORK_ERROR", "Mock server network unavailable");
      return;
    }

    try {
      // 라우팅
      if (method === "GET" && path === "/api/v1/referrals") {
        await this._handleReferralsList(req, res, url, isValidKey);
      } else if (method === "GET" && path === "/api/v1/assessments") {
        await this._handleAssessmentsList(req, res, url, isValidKey);
      } else if (method === "GET" && path.match(/^\/api\/v1\/referrals\/[^/]+$/)) {
        await this._handleReferralById(req, res, path, isValidKey);
      } else if (method === "GET" && path.match(/^\/api\/v1\/assessments\/[^/]+$/)) {
        await this._handleAssessmentById(req, res, path, isValidKey);
      } else if (method === "GET" && (path === "/api/v1/capabilities" || path === "/api/v1/health")) {
        await this._handleCapabilities(req, res, isValidKey);
      } else if (method === "POST" && path.match(/^\/api\/v1\/referrals\/[^/]+\/ack$/)) {
        await this._handleAck(req, res, path, "referral", isValidKey);
      } else if (method === "POST" && path.match(/^\/api\/v1\/assessments\/[^/]+\/ack$/)) {
        await this._handleAck(req, res, path, "assessment", isValidKey);
      } else if (method === "POST" && path.match(/^\/api\/v1\/referrals\/[^/]+\/failed$/)) {
        await this._handleFailed(req, res, path, "referral", isValidKey);
      } else if (method === "POST" && path.match(/^\/api\/v1\/assessments\/[^/]+\/failed$/)) {
        await this._handleFailed(req, res, path, "assessment", isValidKey);
      } else {
        this._sendError(res, 404, "NOT_FOUND", "Endpoint not found");
      }
    } catch (err) {
      console.error("[MOCK_HOMEPAGE_API] Request handler error:", err);
      this._sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
    }
  }

  /**
   * 인증 확인 및 에러 응답
   */
  _checkAuth(res, isValidKey) {
    if (!isValidKey) {
      this._sendError(res, 401, "HOMEPAGE_AUTH_FAILED", "Invalid API key");
      return false;
    }
    return true;
  }

  /**
   * 에러 응답 전송
   */
  _sendError(res, statusCode, code, message) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  /**
   * 성공 응답 전송
   */
  _sendJson(res, data, statusCode = 200) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  /**
   * 요청 본문 읽기
   */
  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * GET /api/v1/referrals — 신규 의뢰 목록
   */
  async _handleReferralsList(req, res, url, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit")) || 50));

    // since 파라미터는 받지만 일부러 필터링하지 않는다.
    // 이유: 실제 홈페이지 API의 since 지원 여부는 미확정(U9)이고, 하네스 T5는 같은 고유 ID가
    // 다시 반환될 때 엔진의 멱등성(중복 스킵)이 동작하는지 검증한다. since로 걸러버리면
    // 두 번째 폴링에서 아무것도 안 와서 멱등성을 검증할 수 없다. 엔진은 since를 계속 보내고,
    // 중복 제거는 엔진의 seen-set이 맡는다.
    let items = [...this.scenario.referrals];

    // limit 적용
    items = items.slice(0, limit);

    this._sendJson(res, {
      items,
      count: items.length,
      nextSince: items.length > 0 ? items[items.length - 1].receivedAt : null,
    });
  }

  /**
   * GET /api/v1/assessments — 신규 척도검사 결과 목록
   */
  async _handleAssessmentsList(req, res, url, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit")) || 50));

    // since 파라미터는 받지만 일부러 필터링하지 않는다 (의뢰 목록과 같은 이유: U9 미확정, T5 멱등성 검증).
    let items = [...this.scenario.assessments];

    items = items.slice(0, limit);

    this._sendJson(res, {
      items,
      count: items.length,
      nextSince: items.length > 0 ? items[items.length - 1].submittedAt : null,
    });
  }

  /**
   * GET /api/v1/referrals/:id — 의뢰 단건 조회
   */
  async _handleReferralById(req, res, path, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const id = path.split("/").pop();
    const item = this.scenario.referrals.find((r) => r.externalId === id);

    if (!item) {
      this._sendError(res, 404, "NOT_FOUND", "Referral not found");
      return;
    }

    this._sendJson(res, item);
  }

  /**
   * GET /api/v1/assessments/:id — 척도검사 단건 조회
   */
  async _handleAssessmentById(req, res, path, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const id = path.split("/").pop();
    const item = this.scenario.assessments.find((a) => a.externalId === id);

    if (!item) {
      this._sendError(res, 404, "NOT_FOUND", "Assessment not found");
      return;
    }

    this._sendJson(res, item);
  }

  /**
   * GET /api/v1/capabilities — 연결 테스트 (health fallback 포함)
   */
  async _handleCapabilities(req, res, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    this._sendJson(res, {
      success: true,
      capabilities: ["referrals", "assessments"],
      version: "1.0.0-mock",
    });
  }

  /**
   * POST /api/v1/{referrals|assessments}/{id}/ack — 수신 완료 처리
   */
  async _handleAck(req, res, path, kind, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const id = path.split("/")[4]; // /api/v1/referrals/{id}/ack
    const body = await this._readBody(req);
    const requestId = body.requestId;

    if (!requestId) {
      this._sendError(res, 400, "INVALID_PAYLOAD_SCHEMA", "requestId is mandatory for ACK request");
      return;
    }

    // 시나리오: 다음 ack 1회 실패
    if (this.scenario.failAckNext) {
      this.scenario.failAckNext = false;
      this._sendError(res, 500, "ACK_FAILED", "Simulated ACK failure");
      return;
    }

    // 대상 존재 확인
    const items = kind === "referral" ? this.scenario.referrals : this.scenario.assessments;
    const item = items.find((i) => i.externalId === id);

    if (!item) {
      this._sendError(res, 404, "NOT_FOUND", `${kind} not found`);
      return;
    }

    // 로그 기록
    this.scenario.ackLog.push({
      kind,
      externalId: id,
      requestId,
      timestamp: new Date().toISOString(),
    });

    this._sendJson(res, {
      success: true,
      acknowledged: true,
      externalId: id,
      requestId,
    });
  }

  /**
   * POST /api/v1/{referrals|assessments}/{id}/failed — 실패 보고
   */
  async _handleFailed(req, res, path, kind, isValidKey) {
    if (!this._checkAuth(res, isValidKey)) return;

    const id = path.split("/")[4];
    const body = await this._readBody(req);
    const category = body.category || "PROCESSING_ERROR";
    const reason = body.reason || "PROCESSING_ERROR";

    // 대상 존재 확인
    const items = kind === "referral" ? this.scenario.referrals : this.scenario.assessments;
    const item = items.find((i) => i.externalId === id);

    if (!item) {
      this._sendError(res, 404, "NOT_FOUND", `${kind} not found`);
      return;
    }

    // 로그 기록
    this.scenario.failedLog.push({
      kind,
      externalId: id,
      category,
      reason,
      timestamp: new Date().toISOString(),
    });

    this._sendJson(res, {
      success: true,
      reported: true,
      externalId: id,
    });
  }
}

/**
 * 편의 함수: Mock 서버 생성 및 시작
 */
export async function createMockHomepageApi(options = {}) {
  const api = new MockHomepageApi(options);
  await api.start();
  return api;
}

export default MockHomepageApi;

/**
 * server/external-api/homepageClient.js
 * Homepage Integration Engine — HTTP Client for Homepage API
 * ESM module.
 * trackAClient.js의 _request를 뼈대로 삼되, Track A 전용 로직 제거.
 */

import crypto from "crypto";
import {
  HomepageIntegrationError,
  createErrorFromResponse,
  createErrorFromFetchError,
  computeAuthFingerprint,
} from "./engineErrors.js";

/**
 * 엔드포인트 경로 상수 (명세가 오면 여기만 변경)
 * [미확정] — 현재 가정치
 */
export const ENDPOINT_PATHS = {
  REFERRALS_LIST: "/api/v1/referrals",
  ASSESSMENTS_LIST: "/api/v1/assessments",
  REFERRAL_BY_ID: (id) => `/api/v1/referrals/${id}`,
  ASSESSMENT_BY_ID: (id) => `/api/v1/assessments/${id}`,
  CAPABILITIES: "/api/v1/capabilities",
  HEALTH_FALLBACK: "/api/v1/health",
  ACK_REFERRAL: (id) => `/api/v1/referrals/${id}/ack`,
  ACK_ASSESSMENT: (id) => `/api/v1/assessments/${id}/ack`,
  FAILED_REFERRAL: (id) => `/api/v1/referrals/${id}/failed`,
  FAILED_ASSESSMENT: (id) => `/api/v1/assessments/${id}/failed`,
};

/**
 * HomepageClient 클래스
 * 기관별 API 키 인증 사용
 */
export class HomepageClient {
  /**
   * @param {object} config
   * @param {string} config.baseUrl - 홈페이지 API 기본 주소 (예: https://api.example.org)
   * @param {string} config.apiKey - 기관별 API 키
   * @param {string} [config.apiKeyHeader='X-Api-Key'] - API 키 헤더명
   * @param {string} [config.authScheme='api-key'] - 인증 방식 ('api-key' | 'bearer')
   * @param {string} config.orgId - 기관 식별값
   * @param {string} [config.orgIdPlacement='header'] - 기관 식별값 전달 위치 ('header' | 'query' | 'body')
   * @param {number} [config.timeoutMs=10000] - 요청 타임아웃(ms)
   * @param {number} [config.maxBatchSize=50] - 최대 배치 크기
   */
  constructor(config = {}) {
    // 필수값 검사
    if (!config.baseUrl) {
      throw new Error("HomepageClient requires baseUrl");
    }
    if (!config.apiKey) {
      throw new Error("HomepageClient requires apiKey");
    }
    if (!config.orgId) {
      throw new Error("HomepageClient requires orgId");
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.apiKeyHeader = config.apiKeyHeader || "X-Api-Key";
    this.authScheme = config.authScheme || "api-key";
    this.orgId = config.orgId;
    this.orgIdPlacement = config.orgIdPlacement || "header";
    this.timeoutMs = Number(config.timeoutMs) || 10000;
    this.maxBatchSize = Math.max(
      1,
      Math.min(100, Number(config.maxBatchSize) || 50),
    );
    this._authFingerprintLogged = false;

    // 운영 환경에서 HTTPS 강제
    if (
      process.env.NODE_ENV === "production" &&
      !this.baseUrl.startsWith("https://")
    ) {
      throw new Error(
        "HomepageClient requires HTTPS in production environment",
      );
    }

    // 인증 지문 로그 (프로세스당 1회)
    this._logAuthFingerprint();
  }

  _logAuthFingerprint() {
    if (!this._authFingerprintLogged && this.apiKey) {
      const fp = computeAuthFingerprint(this.apiKey);
      console.log(
        `HOMEPAGE_AUTH_FINGERPRINT orgId=${this.orgId} keyFp=${fp} scheme=${this.authScheme} header=${this.apiKeyHeader}`,
      );
      this._authFingerprintLogged = true;
    }
  }

  /**
   * ID 살균 (trackAClient 패턴)
   * @param {string} id
   * @returns {string}
   */
  _sanitizeId(id) {
    if (!id || typeof id !== "string" || !/^[a-zA-Z0-9_\-]+$/.test(id)) {
      throw new HomepageIntegrationError({
        message: "외부 ID 형식이 올바르지 않습니다",
        code: "INVALID_PAYLOAD_SCHEMA",
        statusCode: 400,
      });
    }
    return encodeURIComponent(id);
  }

  /**
   * 인증 헤더 구성
   * @param {object} headers - 헤더 객체 (변경됨)
   */
  _buildAuthHeaders(headers) {
    // API 키 인증
    if (this.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers[this.apiKeyHeader] = this.apiKey;
    }

    // 기관 식별값 전달
    if (this.orgIdPlacement === "header") {
      headers["X-Org-Id"] = this.orgId;
    }
    // query와 body는 요청 시점에 처리
  }

  /**
   * 내부 요청 메서드 (trackAClient._request 뼈대)
   * @param {string} endpointPath - 엔드포인트 경로
   * @param {object} opts
   * @param {string} [opts.method='GET']
   * @param {object} [opts.body=null]
   * @param {string} [opts.externalId=null]
   * @param {object} [opts.query={}] - 쿼리 파라미터
   * @returns {Promise<object>} 파싱된 JSON
   */
  async _request(
    endpointPath,
    { method = "GET", body = null, externalId = null, query = {} } = {},
  ) {
    // URL 구성
    let url = `${this.baseUrl}${endpointPath}`;
    const searchParams = new URLSearchParams();

    // 쿼리 파라미터 추가
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        searchParams.append(k, String(v));
      }
    }

    // 기관 ID가 query 위치인 경우
    if (this.orgIdPlacement === "query") {
      searchParams.append("orgId", this.orgId);
    }

    if (searchParams.toString()) {
      url += `?${searchParams.toString()}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = {
      Accept: "application/json",
    };

    // 인증 헤더 구성
    this._buildAuthHeaders(headers);

    // Content-Type for body
    if (body) {
      headers["Content-Type"] = "application/json";
      // 기관 ID가 body 위치인 경우
      if (this.orgIdPlacement === "body") {
        body = { ...body, orgId: this.orgId };
      }
    }

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Content-Type 검사
      const contentType = resp.headers.get("content-type") || "";
      let data;

      if (contentType.includes("application/json")) {
        data = await resp.json().catch(() => null);
      } else {
        const text = await resp.text().catch(() => "");
        // HTML, 로그인 페이지 등 JSON이 아닌 응답
        throw new HomepageIntegrationError({
          message: `홈페이지 API가 JSON이 아닌 응답을 반환했습니다 (HTTP ${resp.status})`,
          code: "NON_JSON_RESPONSE",
          statusCode: resp.status,
          externalId,
          details: { contentType, preview: text.slice(0, 200) },
        });
      }

      // HTTP 에러 처리
      if (!resp.ok) {
        throw createErrorFromResponse(resp, data, externalId);
      }

      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HomepageIntegrationError) {
        throw err;
      }
      throw createErrorFromFetchError(err, externalId);
    }
  }

  /**
   * 연결 테스트: ping + capabilities
   * @returns {Promise<{valid: boolean, data: object}>}
   */
  async checkCapabilities() {
    try {
      // capabilities 엔드포인트 시도
      const data = await this._request(ENDPOINT_PATHS.CAPABILITIES, {
        method: "GET",
      });
      return {
        valid: true,
        data,
      };
    } catch (err) {
      // capabilities가 404이면 health fallback 시도
      if (err.statusCode === 404 || err.code === "NOT_FOUND") {
        try {
          const data = await this._request(ENDPOINT_PATHS.HEALTH_FALLBACK, {
            method: "GET",
          });
          return {
            valid: true,
            data,
          };
        } catch {
          // health도 실패하면 false
          return { valid: false, data: { error: err.message } };
        }
      }
      return { valid: false, data: { error: err.message, code: err.code } };
    }
  }

  /**
   * 간단한 연결 확인 (ping)
   * @returns {Promise<boolean>}
   */
  async ping() {
    const cap = await this.checkCapabilities();
    return cap.valid;
  }

  /**
   * 신규 의뢰 목록 조회
   * @param {object} opts
   * @param {number} opts.limit - 조회 건수 (1~100)
   * @param {string} [opts.since] - 이 시각 이후 항목 (ISO 8601)
   * @returns {Promise<{items: array, count: number, nextSince?: string}>}
   */
  async fetchNewReferrals({ limit, since } = {}) {
    const boundedLimit = Math.max(
      1,
      Math.min(this.maxBatchSize, Number(limit) || this.maxBatchSize),
    );
    const query = { limit: boundedLimit };
    if (since) query.since = since;

    const data = await this._request(ENDPOINT_PATHS.REFERRALS_LIST, {
      method: "GET",
      query,
      externalId: "batch:referrals",
    });

    // 응답 구조 가정: { items: [], count: number, nextSince?: string }
    // 명세가 오면 여기서 파싱 로직만 변경
    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

    return {
      items,
      count: data?.count ?? items.length,
      nextSince: data?.nextSince ?? null,
    };
  }

  /**
   * 신규 척도검사 결과 목록 조회
   * @param {object} opts
   * @param {number} opts.limit
   * @param {string} [opts.since]
   * @returns {Promise<{items: array, count: number, nextSince?: string}>}
   */
  async fetchNewAssessments({ limit, since } = {}) {
    const boundedLimit = Math.max(
      1,
      Math.min(this.maxBatchSize, Number(limit) || this.maxBatchSize),
    );
    const query = { limit: boundedLimit };
    if (since) query.since = since;

    const data = await this._request(ENDPOINT_PATHS.ASSESSMENTS_LIST, {
      method: "GET",
      query,
      externalId: "batch:assessments",
    });

    const items = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

    return {
      items,
      count: data?.count ?? items.length,
      nextSince: data?.nextSince ?? null,
    };
  }

  /**
   * 단건 조회 (재시도 큐 단건 재처리용)
   * @param {'referral'|'assessment'} kind
   * @param {string} externalId
   * @returns {Promise<object>}
   */
  async fetchItemById(kind, externalId) {
    const safeId = this._sanitizeId(externalId);
    const path =
      kind === "referral"
        ? ENDPOINT_PATHS.REFERRAL_BY_ID(safeId)
        : ENDPOINT_PATHS.ASSESSMENT_BY_ID(safeId);

    return this._request(path, {
      method: "GET",
      externalId,
    });
  }

  /**
   * 수신 완료 처리 (ack)
   * 저장 완료 후에만 호출해야 함
   * @param {string} externalId
   * @param {object} opts
   * @param {string} opts.requestId - 요청 ID (필수)
   * @returns {Promise<object>}
   */
  async acknowledgeItem(externalId, { requestId }) {
    if (!requestId) {
      throw new HomepageIntegrationError({
        message: "requestId is mandatory for ACK request",
        code: "INVALID_PAYLOAD_SCHEMA",
        statusCode: 400,
        externalId,
      });
    }

    const safeId = this._sanitizeId(externalId);
    const kind = externalId.startsWith("REF_") ? "referral" : "assessment";
    const path =
      kind === "referral"
        ? ENDPOINT_PATHS.ACK_REFERRAL(safeId)
        : ENDPOINT_PATHS.ACK_ASSESSMENT(safeId);

    const body = { requestId };

    return this._request(path, {
      method: "POST",
      body,
      externalId,
    });
  }

  /**
   * 실패 보고
   * 실패해도 사이클을 멈추지 않음
   * @param {string} externalId
   * @param {object} opts
   * @param {string} opts.category - 실패 구분
   * @param {string} opts.reason - 사유
   * @returns {Promise<object>}
   */
  async reportItemFailed(externalId, { category, reason }) {
    const safeId = this._sanitizeId(externalId);
    const kind = externalId.startsWith("REF_") ? "referral" : "assessment";
    const path =
      kind === "referral"
        ? ENDPOINT_PATHS.FAILED_REFERRAL(safeId)
        : ENDPOINT_PATHS.FAILED_ASSESSMENT(safeId);

    const body = {
      category: category || "PROCESSING_ERROR",
      reason: String(reason || "PROCESSING_ERROR")
        .replace(/[^a-zA-Z0-9_\-]/g, "")
        .substring(0, 64),
    };

    try {
      return await this._request(path, {
        method: "POST",
        body,
        externalId,
      });
    } catch (err) {
      // ack 실패는 사이클을 멈추지 않음 — 로그만 남기고 에러 던지지 않음
      console.warn(
        `[HOMEPAGE_CLIENT] reportItemFailed failed for ${externalId}:`,
        err.message,
      );
      return { success: false, error: err.message };
    }
  }
}

/**
 * 모의 환경용 클라이언트 (네트워크 통신 없음)
 * 개발·테스트용
 */
export class MockHomepageClient extends HomepageClient {
  constructor(config = {}) {
    // 모의 모드에서는 baseUrl과 apiKey가 필수가 아님
    super({
      baseUrl: config.baseUrl || "http://localhost:9999",
      apiKey: config.apiKey || "mock-homepage-key",
      orgId: config.orgId || "mock-org",
      ...config,
    });
    this.mockData = config.mockData || {
      referrals: [],
      assessments: [],
    };
  }

  async _request(endpointPath, { method = "GET", query = {} } = {}) {
    // 모의 응답
    if (
      endpointPath === ENDPOINT_PATHS.CAPABILITIES ||
      endpointPath === ENDPOINT_PATHS.HEALTH_FALLBACK
    ) {
      return { success: true, capabilities: ["referrals", "assessments"] };
    }

    if (endpointPath === ENDPOINT_PATHS.REFERRALS_LIST) {
      const limit = Number(query.limit) || this.maxBatchSize;
      const items = this.mockData.referrals.slice(0, limit);
      return { items, count: items.length };
    }

    if (endpointPath === ENDPOINT_PATHS.ASSESSMENTS_LIST) {
      const limit = Number(query.limit) || this.maxBatchSize;
      const items = this.mockData.assessments.slice(0, limit);
      return { items, count: items.length };
    }

    if (endpointPath.startsWith("/api/v1/referrals/") && method === "GET") {
      const id = endpointPath.split("/").pop();
      const item = this.mockData.referrals.find(
        (r) => r.externalId === id || r.id === id,
      );
      if (!item)
        throw new HomepageIntegrationError({
          message: "Not found",
          code: "NOT_FOUND",
          statusCode: 404,
        });
      return item;
    }

    if (endpointPath.startsWith("/api/v1/assessments/") && method === "GET") {
      const id = endpointPath.split("/").pop();
      const item = this.mockData.assessments.find(
        (r) => r.submissionId === id || r.id === id,
      );
      if (!item)
        throw new HomepageIntegrationError({
          message: "Not found",
          code: "NOT_FOUND",
          statusCode: 404,
        });
      return item;
    }

    if (endpointPath.includes("/ack")) {
      return { success: true, acknowledged: true };
    }

    if (endpointPath.includes("/failed")) {
      return { success: true, reported: true };
    }

    return { success: true };
  }
}

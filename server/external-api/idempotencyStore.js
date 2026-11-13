/**
 * server/external-api/idempotencyStore.js
 * Homepage Integration Engine — Idempotency Seen-Set (ExternalApiSeenIds.json)
 * ESM module.
 * 03 문서 §2-7 표 그대로 구현.
 */

import fs from "fs";
import path from "path";
import { HomepageIntegrationError } from "./engineErrors.js";

/**
 * 설정 파일 경로
 * @param {string} dataDir - 데이터 디렉터리
 * @returns {string} 설정 파일 경로
 */
function getSeenIdsPath(dataDir) {
  return path.join(dataDir, "ExternalApiSeenIds.json");
}

/**
 * Seen IDs 저장소 로드
 * @param {string} dataDir - 데이터 디렉터리
 * @returns {object} seen IDs 객체
 */
function loadSeenIds(dataDir) {
  const filePath = getSeenIdsPath(dataDir);
  if (!fs.existsSync(filePath)) return {};

  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Seen IDs 저장소 저장
 * @param {object} seenIds - 저장할 객체
 * @param {string} dataDir - 데이터 디렉터리
 */
function saveSeenIds(seenIds, dataDir) {
  const filePath = getSeenIdsPath(dataDir);
  fs.writeFileSync(filePath, JSON.stringify(seenIds, null, 2), "utf8");
}

/**
 * 정리 이력 저장 (감사용)
 * @param {object} entry - 정리 이력 엔트리
 * @param {Function} auditLogger - 감사 로거
 */
async function logCleanup(entry, auditLogger) {
  if (typeof auditLogger === "function") {
    try {
      await auditLogger({
        action: "IDEMPOTENCY_CLEANUP",
        actorUserId: entry.actorUserId || "system",
        targetId: `removed:${entry.removedCount}`,
        result: "SUCCESS",
        reasonCode: null,
      });
    } catch (ignore) {}
  }
}

/**
 * 멱등성 스토어 클래스
 */
export class IdempotencyStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - 데이터 디렉터리
   * @param {Function} [opts.auditLogger] - 감사 로거
   */
  constructor({ dataDir, auditLogger } = {}) {
    this.dataDir =
      dataDir ||
      process.env.DATA_DIR ||
      path.join(process.cwd(), "app", "data");
    this.auditLogger = auditLogger;
    this._seenIds = loadSeenIds(this.dataDir);
    this._dirty = false;
  }

  /**
   * 외부 ID가 이미 처리되었는지 확인
   * @param {string} externalId
   * @returns {boolean}
   */
  hasSeen(externalId) {
    return externalId in this._seenIds;
  }

  /**
   * 외부 ID 기록 (단건)
   * @param {string} externalId
   * @param {object} record - 기록할 레코드 { kind, status, firstSeenAt?, lastSeenAt?, ackedAt? }
   */
  markSeen(externalId, record) {
    const now = new Date().toISOString();
    const existing = this._seenIds[externalId];

    this._seenIds[externalId] = {
      kind: record.kind,
      status: record.status,
      firstSeenAt: existing?.firstSeenAt || record.firstSeenAt || now,
      lastSeenAt: now,
      ackedAt:
        record.status === "acked"
          ? existing?.ackedAt || record.ackedAt || now
          : existing?.ackedAt || null,
    };
    this._dirty = true;
  }

  /**
   * 외부 ID 일괄 기록 (한 사이클의 seen 기록을 한 번에)
   * @param {Array<{externalId: string, record: object}>} entries
   */
  markSeenBatch(entries) {
    const now = new Date().toISOString();
    for (const { externalId, record } of entries) {
      const existing = this._seenIds[externalId];
      this._seenIds[externalId] = {
        kind: record.kind,
        status: record.status,
        firstSeenAt: existing?.firstSeenAt || record.firstSeenAt || now,
        lastSeenAt: now,
        ackedAt:
          record.status === "acked"
            ? existing?.ackedAt || record.ackedAt || now
            : existing?.ackedAt || null,
      };
    }
    this._dirty = true;
  }

  /**
   * 기록된 seen 레코드 조회
   * @param {string} externalId
   * @returns {object|null}
   */
  getSeenRecord(externalId) {
    return this._seenIds[externalId] || null;
  }

  /**
   * seen 기록 삭제 (관리자 수동 재처리용, 엔진 내부에서는 호출 안 함)
   * @param {string} externalId
   * @returns {boolean} 삭제 성공 여부
   */
  removeSeen(externalId) {
    if (externalId in this._seenIds) {
      delete this._seenIds[externalId];
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * 디스크에 저장 (더티 플래그가 있을 때만)
   */
  async flush() {
    if (this._dirty) {
      saveSeenIds(this._seenIds, this.dataDir);
      this._dirty = false;
    }
  }

  /**
   * 10,000건 초과 시 오래된 acked 항목부터 정리 (180일 지난 것)
   * @param {string} actorUserId - 정리 수행자
   * @returns {number} 삭제된 건수
   */
  async cleanupIfNeeded(actorUserId = "system") {
    const MAX_ENTRIES = 10000;
    const MAX_AGE_DAYS = 180;
    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    const entries = Object.entries(this._seenIds);
    if (entries.length <= MAX_ENTRIES) return 0;

    // acked이면서 180일 지난 것부터 삭제 후보로 정렬
    const candidates = entries
      .filter(
        ([_, record]) =>
          record.status === "acked" &&
          record.ackedAt &&
          now - new Date(record.ackedAt).getTime() > maxAgeMs,
      )
      .sort(
        (a, b) =>
          new Date(a[1].ackedAt).getTime() - new Date(b[1].ackedAt).getTime(),
      );

    const toRemove = candidates.slice(0, entries.length - MAX_ENTRIES);
    let removedCount = 0;

    for (const [externalId] of toRemove) {
      delete this._seenIds[externalId];
      removedCount++;
    }

    if (removedCount > 0) {
      this._dirty = true;
      await this.flush();
      await logCleanup({ actorUserId, removedCount }, this.auditLogger);
    }

    return removedCount;
  }

  /**
   * 전체 seen 개수 반환
   * @returns {number}
   */
  get size() {
    return Object.keys(this._seenIds).length;
  }
}

/**
 * 팩토리 함수
 * @param {object} opts
 * @returns {IdempotencyStore}
 */
export function createIdempotencyStore(opts = {}) {
  return new IdempotencyStore(opts);
}

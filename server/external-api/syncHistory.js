/**
 * server/external-api/syncHistory.js
 * Homepage Integration Engine — Sync History, State & Retry Queue
 * ESM module.
 * 03 문서 §2-10 표 그대로 구현.
 */

import fs from "fs";
import path from "path";

/**
 * 파일 경로들
 * @param {string} dataDir - 데이터 디렉터리
 * @returns {object} 파일 경로 객체
 */
function getPaths(dataDir) {
  return {
    state: path.join(dataDir, "ExternalApiSyncState.json"),
    history: path.join(dataDir, "ExternalApiSyncHistory.json"),
    retryQueue: path.join(dataDir, "ExternalApiRetryQueue.json"),
  };
}

/**
 * JSON 파일 안전 로드
 * @param {string} filePath
 * @param {any} defaultValue
 * @returns {any}
 */
function loadJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return defaultValue;
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

/**
 * JSON 파일 안전 저장
 * @param {string} filePath
 * @param {any} data
 */
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 동기화 상태 관리 클래스
 */
export class SyncStateStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - 데이터 디렉터리
   */
  constructor({ dataDir } = {}) {
    this.dataDir =
      dataDir ||
      process.env.DATA_DIR ||
      path.join(process.cwd(), "app", "data");
    const paths = getPaths(this.dataDir);
    this.statePath = paths.state;
    this.state = loadJson(this.statePath, {
      enabled: false,
      lastSuccessfulSyncAt: null,
      lastAttemptedSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      lastReceivedCount: 0,
      lastStoredCount: 0,
      lastDuplicateCount: 0,
      lastFailedCount: 0,
      consecutiveFailures: 0,
      nextScheduledAt: null,
      scraperConflict: false,
    });
  }

  /**
   * 상태 전체 조회
   * @returns {object}
   */
  getState() {
    return { ...this.state };
  }

  /**
   * 사이클 시작 시 호출
   * @param {boolean} scraperConflict - 스크레이퍼 충돌 여부
   */
  markAttemptStart(scraperConflict = false) {
    this.state.lastAttemptedSyncAt = new Date().toISOString();
    this.state.lastSyncStatus = "running";
    this.state.lastSyncError = null;
    this.state.scraperConflict = scraperConflict;
    this._save();
  }

  /**
   * 사이클 성공 완료 시 호출
   * @param {object} summary - 사이클 요약
   */
  markSuccess(summary) {
    this.state.lastSuccessfulSyncAt = new Date().toISOString();
    this.state.lastSyncStatus = "success";
    this.state.lastSyncError = null;
    this.state.lastReceivedCount = summary.received || 0;
    this.state.lastStoredCount = summary.stored || 0;
    this.state.lastDuplicateCount = summary.duplicates || 0;
    this.state.lastFailedCount = summary.failed || 0;
    this.state.consecutiveFailures = 0;
    this._save();
  }

  /**
   * 사이클 실패 시 호출
   * @param {string} error - 에러 메시지
   * @param {object} [summary] - 부분 결과
   */
  markFailure(error, summary = {}) {
    this.state.lastSyncStatus = "failed";
    this.state.lastSyncError = error;
    this.state.lastReceivedCount = summary.received || 0;
    this.state.lastStoredCount = summary.stored || 0;
    this.state.lastDuplicateCount = summary.duplicates || 0;
    this.state.lastFailedCount = (summary.failed || 0) + 1;
    this.state.consecutiveFailures += 1;
    this._save();
  }

  /**
   * 다음 예약 시각 설정
   * @param {string} isoString
   */
  setNextScheduledAt(isoString) {
    this.state.nextScheduledAt = isoString;
    this._save();
  }

  /**
   * 스크레이퍼 충돌 상태 설정
   * @param {boolean} conflict
   */
  setScraperConflict(conflict) {
    this.state.scraperConflict = conflict;
    this._save();
  }

  /**
   * 활성화 상태 설정
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.state.enabled = enabled;
    this._save();
  }

  _save() {
    saveJson(this.statePath, this.state);
  }
}

/**
 * 동기화 이력 관리 클래스 (최대 500건)
 */
export class SyncHistoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - 데이터 디렉터리
   */
  constructor({ dataDir } = {}) {
    this.dataDir =
      dataDir ||
      process.env.DATA_DIR ||
      path.join(process.cwd(), "app", "data");
    const paths = getPaths(this.dataDir);
    this.historyPath = paths.history;
    this.history = loadJson(this.historyPath, []);
    this.MAX_HISTORY = 500;
  }

  /**
   * 이력 목록 조회 (최신순, 페이지네이션)
   * @param {number} limit - 최대 건수 (기본 50, 최대 100)
   * @param {number} offset - 건너뛸 건수
   * @returns {Array}
   */
  getHistory(limit = 50, offset = 0) {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const sorted = [...this.history].sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return sorted.slice(offset, offset + boundedLimit);
  }

  /**
   * 사이클 ID로 단건 조회
   * @param {string} cycleId
   * @returns {object|null}
   */
  getCycle(cycleId) {
    return this.history.find((c) => c.cycleId === cycleId) || null;
  }

  /**
   * 사이클 레코드 추가 (성공/실패 모두)
   * @param {object} cycleRecord - 사이클 요약 객체
   */
  addCycle(cycleRecord) {
    this.history.unshift(cycleRecord);
    // 최대 500건 유지
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(0, this.MAX_HISTORY);
    }
    saveJson(this.historyPath, this.history);
  }

  /**
   * 전체 개수
   * @returns {number}
   */
  get totalCount() {
    return this.history.length;
  }
}

/**
 * 재시도 큐 관리 클래스 (최대 1,000건, exhausted는 자동 삭제 안 함)
 */
export class RetryQueueStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir - 데이터 디렉터리
   */
  constructor({ dataDir } = {}) {
    this.dataDir =
      dataDir ||
      process.env.DATA_DIR ||
      path.join(process.cwd(), "app", "data");
    const paths = getPaths(this.dataDir);
    this.queuePath = paths.retryQueue;
    this.queue = loadJson(this.queuePath, []);
    this.MAX_QUEUE = 1000;
    this.MAX_ATTEMPTS = 3;
  }

  /**
   * 실패 항목 추가 또는 업데이트
   * @param {object} item - { externalId, kind, attemptCount, nextAttemptAt, lastErrorCode, firstFailedAt, lastAttemptedAt, status }
   */
  addOrUpdate(item) {
    const existingIndex = this.queue.findIndex(
      (q) => q.externalId === item.externalId && q.kind === item.kind,
    );

    const now = new Date().toISOString();
    const entry = {
      externalId: item.externalId,
      kind: item.kind,
      attemptCount:
        item.attemptCount ??
        (existingIndex >= 0 ? this.queue[existingIndex].attemptCount + 1 : 1),
      nextAttemptAt: item.nextAttemptAt ?? now,
      lastErrorCode: item.lastErrorCode ?? null,
      firstFailedAt:
        existingIndex >= 0
          ? this.queue[existingIndex].firstFailedAt
          : (item.firstFailedAt ?? now),
      lastAttemptedAt: now,
      status:
        item.status ??
        (item.attemptCount >= this.MAX_ATTEMPTS ? "exhausted" : "pending"),
    };

    if (existingIndex >= 0) {
      this.queue[existingIndex] = entry;
    } else {
      this.queue.unshift(entry);
    }

    // 최대 1,000건 유지 (exhausted는 보호)
    if (this.queue.length > this.MAX_QUEUE) {
      const nonExhausted = this.queue.filter((q) => q.status !== "exhausted");
      const exhausted = this.queue.filter((q) => q.status === "exhausted");
      const toKeep = nonExhausted.slice(0, this.MAX_QUEUE - exhausted.length);
      this.queue = [...toKeep, ...exhausted];
    }

    saveJson(this.queuePath, this.queue);
  }

  /**
   * 재시도 대상 항목 조회 (시각이 된 pending 항목들)
   * @returns {Array}
   */
  getDueItems() {
    const now = Date.now();
    return this.queue.filter(
      (q) =>
        q.status === "pending" && new Date(q.nextAttemptAt).getTime() <= now,
    );
  }

  /**
   * 전체 큐 조회
   * @returns {Array}
   */
  getAll() {
    return [...this.queue];
  }

  /**
   * 특정 항목 조회
   * @param {string} externalId
   * @param {string} kind
   * @returns {object|null}
   */
  getItem(externalId, kind) {
    return (
      this.queue.find((q) => q.externalId === externalId && q.kind === kind) ||
      null
    );
  }

  /**
   * 항목 상태 업데이트
   * @param {string} externalId
   * @param {string} kind
   * @param {object} updates
   */
  updateItem(externalId, kind, updates) {
    const index = this.queue.findIndex(
      (q) => q.externalId === externalId && q.kind === kind,
    );
    if (index >= 0) {
      this.queue[index] = { ...this.queue[index], ...updates };
      saveJson(this.queuePath, this.queue);
      return true;
    }
    return false;
  }

  /**
   * 항목 삭제 (exhausted가 아닌 경우만)
   * @param {string} externalId
   * @param {string} kind
   * @returns {boolean}
   */
  removeItem(externalId, kind) {
    const index = this.queue.findIndex(
      (q) => q.externalId === externalId && q.kind === kind,
    );
    if (index >= 0 && this.queue[index].status !== "exhausted") {
      this.queue.splice(index, 1);
      saveJson(this.queuePath, this.queue);
      return true;
    }
    return false;
  }

  /**
   * 큐 전체 개수
   * @returns {number}
   */
  get size() {
    return this.queue.length;
  }
}

/**
 * 통합 팩토리
 * @param {object} opts
 * @returns {object} { state, history, retryQueue }
 */
export function createSyncHistoryStores(opts = {}) {
  return {
    state: new SyncStateStore(opts),
    history: new SyncHistoryStore(opts),
    retryQueue: new RetryQueueStore(opts),
  };
}

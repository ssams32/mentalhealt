/**
 * server/external-api/pollScheduler.js
 * Homepage Integration Engine — Auto Polling Scheduler
 * ESM module.
 * surveyAutoImportScheduler 패턴 그대로.
 */

import { HomepageIntegrationError } from "./engineErrors.js";

export class HomepagePollScheduler {
  /**
   * @param {object} deps
   * @param {HomepageEngineService} deps.engineService
   * @param {object} deps.config
   * @param {Function} deps.auditLogger
   */
  constructor({ engineService, config, auditLogger } = {}) {
    this.engineService = engineService;
    this.config = config;
    this.auditLogger = auditLogger;
    this._timer = null;
    this._running = false;
    this._enabled = config?.pollEnabled === true;
    this._intervalSeconds = config?.pollIntervalSeconds || 60;
    this._initialDelaySeconds = config?.pollInitialDelaySeconds || 60;
    this._lastManualSyncAt = 0;
  }

  /**
   * 스케줄러 시작
   */
  start() {
    // 필수 설정 확인
    if (!this._enabled) {
      console.warn(
        "[POLL_SCHEDULER] 자동 수신이 비활성화되어 있습니다 (pollEnabled=false). 스케줄러를 시작하지 않습니다.",
      );
      return;
    }

    if (!this.config || this.config.enabled === false) {
      console.warn(
        "[POLL_SCHEDULER] 엔진 설정이 유효하지 않습니다. 스케줄러를 시작하지 않습니다.",
      );
      return;
    }

    if (!this.engineService || !this.engineService.client) {
      console.warn(
        "[POLL_SCHEDULER] 클라이언트가 없습니다 (키 없음). 스케줄러를 시작하지 않습니다.",
      );
      return;
    }

    // 이미 실행 중이면 무시
    if (this._timer) {
      console.warn("[POLL_SCHEDULER] 이미 실행 중입니다.");
      return;
    }

    console.log(
      `[POLL_SCHEDULER] 자동 수신 스케줄러 시작: 초기 지연 ${this._initialDelaySeconds}초, 주기 ${this._intervalSeconds}초`,
    );
    this._scheduleNext(this._initialDelaySeconds * 1000);

    // 기동 시 1회 상태 기록
    this._recordStartupStatus();
  }

  /**
   * 스케줄러 정지
   */
  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      console.log("[POLL_SCHEDULER] 자동 수신 스케줄러 정지");
    }
  }

  /**
   * 다음 실행 예약
   * @param {number} delayMs - 지연 시간(ms)
   */
  _scheduleNext(delayMs) {
    this._timer = setTimeout(async () => {
      this._timer = null;
      await this._runCycle();
      // 실패해도 다음 예약 유지
      if (!this._running) {
        this._scheduleNext(this._intervalSeconds * 1000);
      }
    }, delayMs);

    // 프로세스 종료 시 타이머가 방해하지 않게 unref
    this._timer.unref?.();
  }

  /**
   * 사이클 실행
   */
  async _runCycle() {
    if (this._running) {
      console.warn(
        "[POLL_SCHEDULER] 이전 사이클이 아직 실행 중입니다. 건너뜁니다.",
      );
      return;
    }

    this._running = true;

    try {
      const summary = await this.engineService.runSyncCycle({
        actorId: "scheduler",
        trigger: "scheduled",
      });
      console.log(
        `[POLL_SCHEDULER] 사이클 완료: ${summary.cycleId}, received=${summary.received}, stored=${summary.stored}, duplicates=${summary.duplicates}`,
      );
    } catch (err) {
      console.error("[POLL_SCHEDULER] 사이클 실패:", err.message);
    } finally {
      this._running = false;
    }
  }

  /**
   * 기동 시 상태 기록
   */
  async _recordStartupStatus() {
    if (typeof this.auditLogger === "function") {
      try {
        await this.auditLogger({
          action: "POLL_SCHEDULER_STARTED",
          actorUserId: "system",
          targetId: `interval:${this._intervalSeconds}s`,
          result: "SUCCESS",
        });
      } catch (ignore) {}
    }
    this.syncHistory?.state?.setNextScheduledAt?.(
      new Date(Date.now() + this._initialDelaySeconds * 1000).toISOString(),
    );
  }

  /**
   * 수동 동기화 호출 시 10초 이내 재호출 차단 확인
   * @returns {boolean} 호출 허용 여부
   */
  checkManualSyncThrottle() {
    const now = Date.now();
    if (now - this._lastManualSyncAt < 10000) {
      return false;
    }
    this._lastManualSyncAt = now;
    return true;
  }

  /**
   * 수동 동기화 실행 (스케줄러의 다음 예약 시각을 바꾸지 않음)
   */
  async runManualSync({ actorId }) {
    if (!this.checkManualSyncThrottle()) {
      throw new HomepageIntegrationError({
        message: "수동 동기화 간격 10초 미만",
        code: "SYNC_TOO_FREQUENT",
      });
    }

    return this.engineService.runSyncCycle({
      actorId,
      trigger: "manual",
    });
  }

  /**
   * 스케줄러 상태 조회
   */
  getStatus() {
    const state = this.syncHistory?.state?.getState?.() || {};
    return {
      enabled: this._enabled,
      running: this._running,
      intervalSeconds: this._intervalSeconds,
      initialDelaySeconds: this._initialDelaySeconds,
      nextScheduledAt: state.nextScheduledAt || null,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt || null,
      lastAttemptedSyncAt: state.lastAttemptedSyncAt || null,
      lastSyncStatus: state.lastSyncStatus || null,
      consecutiveFailures: state.consecutiveFailures || 0,
      scraperConflict: state.scraperConflict || false,
    };
  }

  /**
   * 설정 업데이트 시 호출 (주기 변경 등)
   * @param {object} newConfig
   */
  updateConfig(newConfig) {
    if (newConfig.pollEnabled !== undefined) {
      this._enabled = newConfig.pollEnabled === true;
    }
    if (newConfig.pollIntervalSeconds !== undefined) {
      this._intervalSeconds = Math.max(
        30,
        Math.min(3600, newConfig.pollIntervalSeconds),
      );
    }
    if (newConfig.pollInitialDelaySeconds !== undefined) {
      this._initialDelaySeconds = Math.max(
        0,
        Math.min(600, newConfig.pollInitialDelaySeconds),
      );
    }

    // 재시작이 필요한 경우
    if (this._enabled && !this._timer && this.engineService?.client) {
      this.start();
    } else if (!this._enabled && this._timer) {
      this.stop();
    }
  }

  /**
   * SyncHistory 주입 (순환 참조 방지를 위해 별도 설정)
   * @param {object} syncHistory
   */
  setSyncHistory(syncHistory) {
    this.syncHistory = syncHistory;
  }
}

/**
 * 팩토리 함수
 */
export function createPollScheduler(deps) {
  return new HomepagePollScheduler(deps);
}

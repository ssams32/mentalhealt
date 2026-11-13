/**
 * server/external-api/engineService.js
 * Homepage Integration Engine — Sync Cycle Orchestrator
 * ESM module.
 * 03 문서 §2-9 표 그대로 구현.
 */

import crypto from "crypto";
import {
  HomepageIntegrationError,
  ENGINE_ERROR_CODES,
} from "./engineErrors.js";

const SOURCE_CHANNEL = "homepage-api";

/**
 * 사이클 ID 생성
 */
function generateCycleId() {
  return `cycle_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 잡 ID 생성 (수동 동기화용)
 */
function generateJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export class HomepageEngineService {
  /**
   * @param {object} deps
   * @param {HomepageClient} deps.client - 홈페이지 클라이언트
   * @param {HomepagePayloadValidator} deps.payloadValidator - 페이로드 검증기
   * @param {IdempotencyStore} deps.idempotencyStore - 멱등성 스토어
   * @param {IntakeAdapter} deps.intakeAdapter - 어댑터 (mapReferralToPending 등)
   * @param {SyncHistoryStores} deps.syncHistory - { state, history, retryQueue }
   * @param {EngineConfig} deps.config - 엔진 설정
   * @param {Function} deps.persistData - 데이터 저장 함수
   * @param {Function} deps.getData - 데이터 조회 함수
   * @param {Function} deps.auditLogger - 감사 로거
   * @param {PollScheduler} deps.pollScheduler - 스케줄러 (상태 조회용)
   */
  constructor(deps) {
    this.client = deps.client;
    this.payloadValidator = deps.payloadValidator;
    this.idempotencyStore = deps.idempotencyStore;
    this.intakeAdapter = deps.intakeAdapter;
    this.syncHistory = deps.syncHistory;
    this.config = deps.config;
    this.persistData = deps.persistData;
    this.getData = deps.getData;
    this.auditLogger = deps.auditLogger;
    this.pollScheduler = deps.pollScheduler;

    this._running = false;
    this._lastManualSyncAt = 0;
  }

  /**
   * 클라이언트 인스턴스 갱신 (키 변경/재로드 시)
   * @param {HomepageClient|null} newClient
   */
  updateClient(newClient) {
    this.client = newClient;
  }

  /**
   * 엔진 상태 조회
   * @returns {object}
   */
  getStatus() {
    const schedulerStatus = this.pollScheduler
      ? this.pollScheduler.getStatus()
      : { enabled: false, running: false };
    const state = this.syncHistory.state.getState();

    return {
      engine: {
        enabled: this.config.enabled !== false,
        mode: this.config.mode,
        configValid: this.config.enabled !== false,
      },
      scheduler: {
        ...schedulerStatus,
        enabled: state.enabled,
        nextScheduledAt: state.nextScheduledAt,
      },
      lastSync: {
        lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
        lastAttemptedSyncAt: state.lastAttemptedSyncAt,
        lastSyncStatus: state.lastSyncStatus,
        lastSyncError: state.lastSyncError,
        lastReceivedCount: state.lastReceivedCount,
        lastStoredCount: state.lastStoredCount,
        lastDuplicateCount: state.lastDuplicateCount,
        lastFailedCount: state.lastFailedCount,
        consecutiveFailures: state.consecutiveFailures,
        scraperConflict: state.scraperConflict,
      },
    };
  }

  /**
   * 수신 사이클 실행 (가져오기→검증→멱등성→저장→ack→이력 순서 강제)
   * @param {object} opts
   * @param {string} opts.actorId - 실행자 ID
   * @param {string} opts.trigger - 'scheduled' | 'manual' | 'retry'
   * @returns {Promise<object>} 사이클 요약
   */
  async runSyncCycle({ actorId, trigger }) {
    // 실행 중 가드
    if (this._running) {
      throw new HomepageIntegrationError({
        message: "이미 사이클 실행 중",
        code: "SYNC_ALREADY_RUNNING",
      });
    }

    // 엔진 자체가 비활성화된 상태에서 실행 시도
    if (this.config.enabled === false) {
      throw new HomepageIntegrationError({
        message: "엔진이 비활성화되어 있음",
        code: "ENGINE_DISABLED",
      });
    }

    // 예약된 동기화인데 폴링 비활성화 상태
    if (trigger === "scheduled" && !this.config.pollEnabled) {
      throw new HomepageIntegrationError({
        message: "폴링 OFF인데 예약 동기화 시도",
        code: "POLL_DISABLED",
      });
    }

    // 스크레이퍼 충돌 검사
    const scraperEnabled = process.env.EXTERNAL_SCRAPER_ENABLED === "true";
    if (scraperEnabled) {
      this.syncHistory.state.setScraperConflict(true);
      throw new HomepageIntegrationError({
        message: "스크레이퍼가 켜져 있어 엔진 실행 거부",
        code: "SCRAPER_CONFLICT",
      });
    }
    this.syncHistory.state.setScraperConflict(false);

    this._running = true;
    const cycleId = generateCycleId();
    const startedAt = new Date().toISOString();

    // 사이클 요약 초기화
    const summary = {
      cycleId,
      trigger,
      actorId,
      startedAt,
      finishedAt: null,
      received: 0,
      stored: 0,
      duplicates: 0,
      quarantined: 0,
      failed: 0,
      acked: 0,
      ackSkipped: 0,
      stopReason: null,
      errors: {},
    };

    this.syncHistory.state.markAttemptStart(scraperEnabled);

    try {
      // 1. 가져오기 (Fetch)
      let fetchResult;
      try {
        fetchResult = await this._fetchNewItems();
      } catch (fetchErr) {
        // 가져오기 실패도 재시도 큐에 기록 (06 T8: 연결 실패는 실패 큐에 errorCode로 기록, 지수 백오프)
        this._queueFetchFailure(fetchErr);
        throw fetchErr;
      }
      summary.received =
        fetchResult.referrals.length + fetchResult.assessments.length;

      if (summary.received === 0) {
        summary.stopReason = "no_new_data";
        this._finalizeCycle(summary, "success");
        return summary;
      }

      // 2. 검증 (Validate)
      const validationResult = this._validateItems(fetchResult);

      // 격리 항목의 seen-set 처리 (06 T5: 두 번째 폴링에서 격리 건까지 전부 스킵).
      // 이미 본 적 있는 격리 항목은 다시 격리하지 않고 중복으로 스킵한다.
      // 처음 보는 격리 항목은 seen-set에 'quarantined'로 기록한다 (03 문서 §2-6).
      let alreadySeenQuarantined = 0;
      const freshQuarantined = [];
      for (const q of validationResult.quarantined) {
        const qId = q.item?.externalId;
        if (qId && this.idempotencyStore.hasSeen(qId)) {
          alreadySeenQuarantined++;
        } else {
          freshQuarantined.push(q);
          if (qId) {
            this.idempotencyStore.markSeen(qId, {
              kind: q.kind,
              status: "quarantined",
            });
          }
        }
      }
      validationResult.quarantined = freshQuarantined;
      summary.quarantined = freshQuarantined.length;

      // 3. 멱등성 체크 (Idempotency)
      const idempotencyResult = await this._checkIdempotency(
        validationResult.valid,
      );
      summary.duplicates =
        idempotencyResult.duplicates.length + alreadySeenQuarantined;
      const toProcess = idempotencyResult.toProcess;

      // 4. 저장 (Persist)
      const persistResult = await this._persistItems(
        toProcess,
        actorId,
        cycleId,
      );
      summary.stored = persistResult.stored;
      summary.failed = persistResult.failed;

      // 5. ACK 전송 (Acknowledge) - 저장 성공한 항목만
      const ackResult = await this._sendAcknowledgements(
        persistResult.successItems,
      );
      summary.acked = ackResult.acked;
      summary.ackSkipped = ackResult.skipped;

      // 멱등성 스토어 플러시
      await this.idempotencyStore.flush();

      summary.stopReason = "success";
      this._finalizeCycle(summary, "success");

      // 6. 이력 기록 (History) - stopReason이 설정된 후 호출
      await this._recordHistory(
        summary,
        validationResult,
        persistResult,
        ackResult,
      );

      return summary;
    } catch (err) {
      if (err instanceof HomepageIntegrationError) {
        summary.stopReason = err.code;
        summary.errors[err.code] = (summary.errors[err.code] || 0) + 1;
      } else {
        summary.stopReason = "UNEXPECTED_ERROR";
        summary.errors["UNEXPECTED_ERROR"] = 1;
      }
      this._finalizeCycle(summary, "failed", err.message);
      throw err;
    } finally {
      this._running = false;
    }
  }

  /**
   * 가져오기 실패를 재시도 큐에 기록 (항목을 알 수 없는 사이클 단위 실패)
   * @param {Error} err - 가져오기 실패 에러
   */
  _queueFetchFailure(err) {
    const code =
      err instanceof HomepageIntegrationError ? err.code : "NETWORK_ERROR";
    const existing = this.syncHistory.retryQueue.getItem("sync:fetch", "fetch");
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    // 지수 백오프 1000ms→2000ms→4000ms, 최대 60000ms (06 T8)
    const backoffMs = Math.min(60000, 1000 * 2 ** (attemptCount - 1));
    this.syncHistory.retryQueue.addOrUpdate({
      externalId: "sync:fetch",
      kind: "fetch",
      attemptCount,
      nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
      lastErrorCode: code,
      firstFailedAt:
        existing?.firstFailedAt ?? new Date().toISOString(),
      lastAttemptedAt: new Date().toISOString(),
    });
  }

  /**
   * 신규 항목 가져오기
   */
  async _fetchNewItems() {
    const since = this.syncHistory.state.getState().lastSuccessfulSyncAt;
    const limit = this.config.maxBatchSize || 50;

    const [referralsRes, assessmentsRes] = await Promise.all([
      this.client.fetchNewReferrals({ limit, since }),
      this.client.fetchNewAssessments({ limit, since }),
    ]);

    return {
      referrals: referralsRes.items || [],
      assessments: assessmentsRes.items || [],
    };
  }

  /**
   * 항목 검증
   */
  _validateItems(fetchResult) {
    const referralValidation = this.payloadValidator.validateBatch(
      { items: fetchResult.referrals },
      "referral",
    );
    const assessmentValidation = this.payloadValidator.validateBatch(
      { items: fetchResult.assessments },
      "assessment",
    );

    return {
      valid: [...referralValidation.valid, ...assessmentValidation.valid],
      quarantined: [
        ...referralValidation.quarantined.map((q) => ({
          ...q,
          kind: "referral",
        })),
        ...assessmentValidation.quarantined.map((q) => ({
          ...q,
          kind: "assessment",
        })),
      ],
      rejected: [
        ...referralValidation.rejected.map((r) => ({ ...r, kind: "referral" })),
        ...assessmentValidation.rejected.map((r) => ({
          ...r,
          kind: "assessment",
        })),
      ],
    };
  }

  /**
   * 멱등성 체크 (seen-set → PendingReferrals → Referrals)
   */
  async _checkIdempotency(validItems) {
    const duplicates = [];
    const toProcess = [];

    for (const item of validItems) {
      const externalId = item.externalId;

      // 1차: seen-set
      if (this.idempotencyStore.hasSeen(externalId)) {
        const record = this.idempotencyStore.getSeenRecord(externalId);
        // stored인데 ackedAt이 없으면 ack만 다시 시도
        if (record?.status === "stored" && !record.ackedAt) {
          toProcess.push({ ...item, _needsAckOnly: true });
        } else {
          duplicates.push(externalId);
        }
        continue;
      }

      // 2차: PendingReferrals 조회
      const pendingReferrals = this.getData("PendingReferrals", []);
      if (
        pendingReferrals.some(
          (p) =>
            p.externalIdx === externalId || p.externalReferralId === externalId,
        )
      ) {
        duplicates.push(externalId);
        continue;
      }

      // 3차: Referrals 조회 (sourceSubmissionId / externalIdx)
      const referrals = this.getData("Referrals", []);
      if (
        referrals.some(
          (r) =>
            r.sourceSubmissionId === externalId ||
            r.externalReferralId === externalId ||
            r.externalIdx === externalId,
        )
      ) {
        duplicates.push(externalId);
        continue;
      }

      toProcess.push(item);
    }

    return { duplicates, toProcess };
  }

  /**
   * 항목 저장 (어댑터 매핑 → persistData)
   */
  async _persistItems(items, actorId, cycleId) {
    const referralsToStore = [];
    const assessmentsToStore = [];
    const failed = [];
    const successItems = [];

    for (const item of items) {
      try {
        if (item.kind === "referral" || (!item.kind && item.receivedAt)) {
          const pending = this.intakeAdapter.mapReferralToPending(item, item, {
            receivedAt: new Date().toISOString(),
            cycleId,
          });
          referralsToStore.push(pending);
        } else if (
          item.kind === "assessment" ||
          (!item.kind && item.submittedAt)
        ) {
          const submission = this.intakeAdapter.mapAssessmentToSubmission(
            item,
            item,
            { receivedAt: new Date().toISOString() },
          );

          // 의뢰 연결 시도
          const linkResult = this.intakeAdapter.resolveReferralLink(
            submission,
            { getData: this.getData },
          );
          if (linkResult.action === "link") {
            submission.referralId = linkResult.referralId;
            submission.refNo = linkResult.referralId; // refNo도 동일하게
          } else if (linkResult.action === "candidate") {
            submission.linkCandidate = {
              referralId: linkResult.referralId,
              confidence: "candidate",
            };
          }

          assessmentsToStore.push(submission);
        }
      } catch (err) {
        failed.push({ item, error: err.message });
      }
    }

    // 저장 실행 (await persistData로 성공 확인)
    let stored = 0;

    if (referralsToStore.length > 0) {
      try {
        await this.persistData("PendingReferrals", referralsToStore);
      } catch (persistErr) {
        // 저장 자체가 실패하면 저장하려던 항목을 재시도 큐에 등록 (08 C4)
        this._queuePersistFailed(referralsToStore, "referral", "externalIdx");
        throw persistErr;
      }
      stored += referralsToStore.length;
      successItems.push(
        ...referralsToStore.map((r) => ({
          externalId: r.externalIdx,
          kind: "referral",
        })),
      );
    }

    if (assessmentsToStore.length > 0) {
      try {
        await this.persistData("SurveySubmissions", assessmentsToStore);
      } catch (persistErr) {
        this._queuePersistFailed(
          assessmentsToStore,
          "assessment",
          "submissionId",
        );
        throw persistErr;
      }
      stored += assessmentsToStore.length;
      successItems.push(
        ...assessmentsToStore.map((a) => ({
          externalId: a.submissionId,
          kind: "assessment",
        })),
      );
    }

    // 격리된 항목도 저장 (QuarantinedReferrals 등) - 여기서는 생략, 검증 단계에서 처리됨

    // 실패한 항목을 재시도 큐에 등록
    for (const { item, error } of failed) {
      this.syncHistory.retryQueue.addOrUpdate({
        externalId: item.externalId,
        kind: item.kind || (item.receivedAt ? "referral" : "assessment"),
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() + 60000).toISOString(), // 1분 후
        lastErrorCode: "PERSIST_FAILED",
        firstFailedAt: new Date().toISOString(),
        lastAttemptedAt: new Date().toISOString(),
        status: "pending",
      });
    }

    return { stored, failed: failed.length, successItems };
  }

  /**
   * ACK 전송 (저장 성공한 항목만)
   */
  async _sendAcknowledgements(successItems) {
    let acked = 0;
    let skipped = 0;

    for (const { externalId, kind } of successItems) {
      try {
        // seen-set에서 acked 상태 확인
        const record = this.idempotencyStore.getSeenRecord(externalId);
        if (record?.status === "acked") {
          skipped++;
          continue;
        }

        // requestId 생성 (외부 ID + 타임스탬프)
        const requestId = `${externalId}_${Date.now()}`;
        await this.client.acknowledgeItem(externalId, { requestId });

        // seen-set 업데이트
        this.idempotencyStore.markSeen(externalId, {
          kind,
          status: "acked",
          ackedAt: new Date().toISOString(),
        });
        acked++;
      } catch (err) {
        // ACK 실패 시 재시도 큐로 이동 (저장은 이미 완료됨)
        this.syncHistory.retryQueue.addOrUpdate({
          externalId,
          kind,
          attemptCount: 1,
          nextAttemptAt: new Date(Date.now() + 60000).toISOString(),
          lastErrorCode: "ACK_FAILED",
          firstFailedAt: new Date().toISOString(),
          lastAttemptedAt: new Date().toISOString(),
          status: "pending",
        });
      }
    }

    return { acked, skipped };
  }

  /**
   * 이력 기록
   */
  async _recordHistory(summary, validationResult, persistResult, ackResult) {
    const cycleRecord = {
      ...summary,
      status: summary.stopReason === "success" ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      quarantinedDetails: validationResult.quarantined.map((q) => ({
        externalId: q.item.externalId,
        kind: q.kind,
        reason: q.reason,
      })),
      failedExternalIds: [
        ...persistResult.successItems
          .filter((s) => false)
          .map((s) => s.externalId), // persist 실패는 이미 큐에 있음
      ],
    };

    this.syncHistory.history.addCycle(cycleRecord);
    this.syncHistory.state.markSuccess(summary);
  }

  /**
   * 사이클 마무리
   */
  _finalizeCycle(summary, status, error = null) {
    summary.finishedAt = new Date().toISOString();
    if (status === "failed") {
      this.syncHistory.state.markFailure(error, summary);
    }
  }

  /**
   * 의뢰 배치 처리 (외부 호출용)
   */
  async processReferralBatch(items, { actorId }) {
    const validation = this.payloadValidator.validateBatch(
      { items },
      "referral",
    );
    const idempotency = await this._checkIdempotency(validation.valid);
    const persist = await this._persistItems(
      idempotency.toProcess,
      actorId,
      generateCycleId(),
    );
    const ack = await this._sendAcknowledgements(persist.successItems);
    return { validation, idempotency, persist, ack };
  }

  /**
   * 척도검사 배치 처리 (외부 호출용)
   */
  async processAssessmentBatch(items, { actorId }) {
    const validation = this.payloadValidator.validateBatch(
      { items },
      "assessment",
    );
    const idempotency = await this._checkIdempotency(validation.valid);
    const persist = await this._persistItems(
      idempotency.toProcess,
      actorId,
      generateCycleId(),
    );
    const ack = await this._sendAcknowledgements(persist.successItems);
    return { validation, idempotency, persist, ack };
  }

  /**
   * 저장 실패 항목을 재시도 큐에 등록
   * @param {Array<object>} items - 저장하려던 항목들
   * @param {string} kind - 'referral' | 'assessment'
   * @param {string} idField - 외부 ID 필드명
   */
  _queuePersistFailed(items, kind, idField) {
    for (const item of items) {
      this.syncHistory.retryQueue.addOrUpdate({
        externalId: item[idField],
        kind,
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() + 60000).toISOString(), // 1분 후
        lastErrorCode: "PERSIST_FAILED",
        firstFailedAt: new Date().toISOString(),
        lastAttemptedAt: new Date().toISOString(),
        status: "pending",
      });
    }
  }

  /**
   * 실패 항목 1건 재처리
   */
  async retryFailedItem(externalId, { actorId }) {
    const queueItem =
      this.syncHistory.retryQueue.getItem(externalId, "referral") ||
      this.syncHistory.retryQueue.getItem(externalId, "assessment");
    if (!queueItem) {
      // 가져오기 실패로 큐에 들어간 사이클 단위 항목이 있으면, 단건 재조회가 아니라
      // 전체를 다시 가져온다 (06 T10: 실패했던 항목이 다음 주기에 다시 가져와져 저장됨).
      // 가져오기 실패 때는 항목 ID를 알 수 없어 큐에 항목별 기록이 남지 않기 때문이다.
      const fetchEntry = this.syncHistory.retryQueue.getItem(
        "sync:fetch",
        "fetch",
      );
      if (fetchEntry) {
        await this.runSyncCycle({ actorId, trigger: "manual" });
        this.syncHistory.retryQueue.removeItem("sync:fetch", "fetch");
        return { success: true, retriedViaSync: true };
      }
      throw new HomepageIntegrationError({
        message: "재시도 큐에 없는 항목입니다",
        code: "NOT_FOUND",
        externalId,
      });
    }

    if (queueItem.status === "exhausted") {
      throw new HomepageIntegrationError({
        message: "재시도 3회 소진 → 수동 재처리 대기",
        code: "RETRY_EXHAUSTED",
        externalId,
      });
    }

    // 단건 재조회
    const item = await this.client.fetchItemById(queueItem.kind, externalId);

    // 재처리
    if (queueItem.kind === "referral") {
      await this.processReferralBatch([item], { actorId });
    } else {
      await this.processAssessmentBatch([item], { actorId });
    }

    // 큐에서 제거
    this.syncHistory.retryQueue.removeItem(externalId, queueItem.kind);

    return { success: true };
  }

  /**
   * 재시도 큐 전체 재처리
   */
  async retryAllFailed({ actorId }) {
    const dueItems = this.syncHistory.retryQueue.getDueItems();
    let retried = 0;
    let failed = 0;

    for (const queueItem of dueItems) {
      try {
        await this.retryFailedItem(queueItem.externalId, { actorId });
        retried++;
      } catch {
        failed++;
      }
    }

    return { retried, failed };
  }
}

/**
 * 팩토리 함수
 */
export function createEngineService(deps) {
  return new HomepageEngineService(deps);
}

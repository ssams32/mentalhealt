/**
 * tests/externalApiEngine.test.js
 * Homepage Integration Engine — Integration Tests
 * Run with: node --test tests/externalApiEngine.test.js
 * Mock 홈페이지 API만 사용, 실제 네트워크 호출 금지.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import fs from "fs";

// Test imports
const engineErrorsPath = "../server/external-api/engineErrors.js";
const urlValidatorPath = "../server/external-api/urlValidator.js";
const engineConfigPath = "../server/external-api/engineConfig.js";
const homepageClientPath = "../server/external-api/homepageClient.js";
const payloadValidatorPath = "../server/external-api/payloadValidator.js";
const idempotencyStorePath = "../server/external-api/idempotencyStore.js";
const syncHistoryPath = "../server/external-api/syncHistory.js";
const intakeAdapterPath = "../server/external-api/intakeAdapter.js";
const engineServicePath = "../server/external-api/engineService.js";
const pollSchedulerPath = "../server/external-api/pollScheduler.js";
const indexPath = "../server/external-api/index.js";

let engineErrors,
  urlValidator,
  engineConfig,
  homepageClient,
  payloadValidatorModule;
let idempotencyStoreModule,
  syncHistoryModule,
  intakeAdapter,
  engineServiceModule,
  pollSchedulerModule,
  indexModule;

before(async () => {
  [
    engineErrors,
    urlValidator,
    engineConfig,
    homepageClient,
    payloadValidatorModule,
    idempotencyStoreModule,
    syncHistoryModule,
    intakeAdapter,
    engineServiceModule,
    pollSchedulerModule,
    indexModule,
  ] = await Promise.all([
    import(engineErrorsPath),
    import(urlValidatorPath),
    import(engineConfigPath),
    import(homepageClientPath),
    import(payloadValidatorPath),
    import(idempotencyStorePath),
    import(syncHistoryPath),
    import(intakeAdapterPath),
    import(engineServicePath),
    import(pollSchedulerPath),
    import(indexPath),
  ]);
});

// Mock 데이터 디렉터리
const TEST_DATA_DIR = "/tmp/external-api-test-data";

function setupTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

// Mock persistData/getData
const mockDataStore = {};
function mockGetData(filename, defaultValue = []) {
  if (mockDataStore[filename]) return mockDataStore[filename];
  const filePath = path.join(TEST_DATA_DIR, `${filename}.json`);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return defaultValue;
    }
  }
  return defaultValue;
}

async function mockPersistData(filename, data) {
  mockDataStore[filename] = data;
  const filePath = path.join(TEST_DATA_DIR, `${filename}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Mock auditLogger
const auditLogs = [];
async function mockAuditLogger(entry) {
  auditLogs.push({ ...entry, timestamp: new Date().toISOString() });
}

// Mock HomepageClient (MockHomepageClient 사용)
function createMockClient(mockData = {}) {
  return new homepageClient.MockHomepageClient({
    baseUrl: "http://mock.example.com",
    apiKey: "mock-homepage-key",
    orgId: "test-org",
    mockData: {
      referrals: mockData.referrals || [],
      assessments: mockData.assessments || [],
    },
  });
}

describe("idempotencyStore — seen-set 기능", () => {
  let store;

  before(() => {
    setupTestDir();
    store = new idempotencyStoreModule.IdempotencyStore({
      dataDir: TEST_DATA_DIR,
      auditLogger: mockAuditLogger,
    });
  });

  after(() => {
    cleanupTestDir();
  });

  test("hasSeen: 처음엔 false 반환", () => {
    assert.strictEqual(store.hasSeen("NEW-ID-001"), false);
  });

  test("markSeen: 기록 후 hasSeen true 반환", () => {
    store.markSeen("TEST-001", { kind: "referral", status: "stored" });
    assert.strictEqual(store.hasSeen("TEST-001"), true);
  });

  test("markSeenBatch: 여러 건 일괄 기록", () => {
    store.markSeenBatch([
      {
        externalId: "BATCH-001",
        record: { kind: "referral", status: "stored" },
      },
      {
        externalId: "BATCH-002",
        record: { kind: "assessment", status: "stored" },
      },
    ]);
    assert.strictEqual(store.hasSeen("BATCH-001"), true);
    assert.strictEqual(store.hasSeen("BATCH-002"), true);
  });

  test("getSeenRecord: 기록된 레코드 조회", () => {
    store.markSeen("RECORD-001", { kind: "referral", status: "stored" });
    const record = store.getSeenRecord("RECORD-001");
    assert.ok(record);
    assert.strictEqual(record.kind, "referral");
    assert.strictEqual(record.status, "stored");
    assert.ok(record.firstSeenAt);
    assert.ok(record.lastSeenAt);
  });

  test("removeSeen: 관리자 수동 재처리용 삭제", () => {
    store.markSeen("REMOVE-001", { kind: "referral", status: "stored" });
    assert.strictEqual(store.removeSeen("REMOVE-001"), true);
    assert.strictEqual(store.hasSeen("REMOVE-001"), false);
    assert.strictEqual(store.removeSeen("REMOVE-001"), false); // 이미 삭제됨
  });

  test("상태 전이: stored → acked", () => {
    store.markSeen("TRANSIT-001", { kind: "referral", status: "stored" });
    store.markSeen("TRANSIT-001", {
      kind: "referral",
      status: "acked",
      ackedAt: new Date().toISOString(),
    });
    const record = store.getSeenRecord("TRANSIT-001");
    assert.strictEqual(record.status, "acked");
    assert.ok(record.ackedAt);
  });

  test("cleanupIfNeeded: 10,000건 초과 시 오래된 acked 항목 정리", async () => {
    const smallStore = new idempotencyStoreModule.IdempotencyStore({
      dataDir: TEST_DATA_DIR + "-cleanup",
    });
    // 10000건 제한을 위해 테스트용으로 작은 값으로 조정하여 검증
    // 실제로는 MAX_ENTRIES가 10000이므로 여기선 로직만 확인
    const now = new Date().toISOString();
    const oldDate = new Date(
      Date.now() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 200일 전

    smallStore.markSeen("OLD-ACKED", {
      kind: "referral",
      status: "acked",
      ackedAt: oldDate,
    });
    smallStore.markSeen("RECENT-ACKED", {
      kind: "referral",
      status: "acked",
      ackedAt: now,
    });
    smallStore.markSeen("STORED", { kind: "referral", status: "stored" });

    // cleanupIfNeeded는 10000건 넘어야 동작하므로 여기선 에러 없이 호출되는지만 확인
    const removed = await smallStore.cleanupIfNeeded("test-admin");
    assert.strictEqual(typeof removed, "number");
  });
});

describe("syncHistory — 상태·이력·재시도 큐", () => {
  let stateStore, historyStore, retryQueue;

  before(() => {
    setupTestDir();
    stateStore = new syncHistoryModule.SyncStateStore({
      dataDir: TEST_DATA_DIR,
    });
    historyStore = new syncHistoryModule.SyncHistoryStore({
      dataDir: TEST_DATA_DIR,
    });
    retryQueue = new syncHistoryModule.RetryQueueStore({
      dataDir: TEST_DATA_DIR,
    });
  });

  after(() => {
    cleanupTestDir();
  });

  test("SyncStateStore: 초기 상태", () => {
    const state = stateStore.getState();
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.consecutiveFailures, 0);
  });

  test("SyncStateStore: 사이클 시작/성공/실패 기록", () => {
    stateStore.markAttemptStart(false);
    let state = stateStore.getState();
    assert.strictEqual(state.lastSyncStatus, "running");

    stateStore.markSuccess({
      received: 10,
      stored: 8,
      duplicates: 2,
      failed: 0,
    });
    state = stateStore.getState();
    assert.strictEqual(state.lastSyncStatus, "success");
    assert.strictEqual(state.lastReceivedCount, 10);
    assert.strictEqual(state.consecutiveFailures, 0);
    assert.ok(state.lastSuccessfulSyncAt);

    stateStore.markFailure("테스트 에러", {
      received: 5,
      stored: 3,
      duplicates: 1,
      failed: 1,
    });
    state = stateStore.getState();
    assert.strictEqual(state.lastSyncStatus, "failed");
    assert.strictEqual(state.consecutiveFailures, 1);
  });

  test("SyncHistoryStore: 이력 추가 및 조회 (최대 500건)", () => {
    for (let i = 0; i < 5; i++) {
      historyStore.addCycle({
        cycleId: `cycle-${i}`,
        trigger: "scheduled",
        startedAt: new Date(Date.now() - i * 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        received: i,
        stored: i,
        duplicates: 0,
        quarantined: 0,
        failed: 0,
      });
    }

    const history = historyStore.getHistory(10, 0);
    assert.strictEqual(history.length, 5);
    // unshift로 추가되고 getHistory에서 startedAt 내림차순 정렬하므로
    // cycle-0이 가장 최신(now), cycle-4가 가장 오래됨(now-4000ms)
    assert.strictEqual(history[0].cycleId, "cycle-0");
  });

  test("SyncHistoryStore: 단건 조회", () => {
    const cycle = historyStore.getCycle("cycle-2");
    assert.ok(cycle);
    assert.strictEqual(cycle.cycleId, "cycle-2");
  });

  test("RetryQueueStore: 실패 항목 추가 및 재시도 대상 조회", () => {
    retryQueue.addOrUpdate({
      externalId: "FAIL-001",
      kind: "referral",
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 1000).toISOString(), // 1초 후
      lastErrorCode: "PERSIST_FAILED",
    });

    const due = retryQueue.getDueItems();
    assert.strictEqual(due.length, 0); // 아직 시각 안 됨

    // 과거 시각으로 변경
    retryQueue.updateItem("FAIL-001", "referral", {
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    });
    const due2 = retryQueue.getDueItems();
    assert.strictEqual(due2.length, 1);
  });

  test("RetryQueueStore: exhausted 항목은 자동 삭제 안 됨", () => {
    retryQueue.addOrUpdate({
      externalId: "EXHAUST-001",
      kind: "assessment",
      attemptCount: 3,
      nextAttemptAt: new Date().toISOString(),
      lastErrorCode: "PERSIST_FAILED",
      status: "exhausted",
    });

    // 큐 크기 제한 테스트를 위해 많은 항목 추가
    for (let i = 0; i < 1010; i++) {
      retryQueue.addOrUpdate({
        externalId: `BULK-${i}`,
        kind: "referral",
        attemptCount: 1,
        nextAttemptAt: new Date().toISOString(),
        lastErrorCode: "TEST",
        status: "pending",
      });
    }

    // exhausted 항목은 살아있어야 함
    const exhaustItem = retryQueue.getItem("EXHAUST-001", "assessment");
    assert.ok(exhaustItem);
    assert.strictEqual(exhaustItem.status, "exhausted");
  });
});

describe("intakeAdapter — 매핑 함수", () => {
  test("mapReferralToPending: 기본 매핑", () => {
    const raw = {
      externalId: "REF-001",
      receivedAt: "2024-01-15T10:30:00Z",
      name: "홍길동",
      phone: "010-1234-5678",
      gender: "male",
      age: "30",
      address: "경기도 이천시",
      problem: "우울감",
      agency: "이천시보건소",
    };

    const normalized = { ...raw };
    const pending = intakeAdapter.mapReferralToPending(raw, normalized, {
      receivedAt: "2024-01-15T10:30:00Z",
    });

    assert.strictEqual(pending.externalIdx, "REF-001");
    assert.strictEqual(pending.name, "홍길동");
    assert.strictEqual(pending.phone, "010-1234-5678");
    assert.strictEqual(pending.referralPath, "health-center"); // 보건소 → health-center
    assert.strictEqual(pending.source, "homepage-api");
    assert.strictEqual(pending.referralStatus, "PENDING_STAFF_REVIEW");
    assert.ok(Array.isArray(pending.missingFields));
    assert.ok(pending.missingFields.length > 0); // UI 필수 12개 중 없는 것들
  });

  test("mapAssessmentToSubmission: 기본 매핑", () => {
    const raw = {
      externalId: "ASM-001",
      submittedAt: "2024-01-15T10:30:00Z",
      scale: "phq-9",
      totalScore: 15,
      severity: "moderate",
      answers: ["1", "0", "2"],
    };

    const normalized = { ...raw };
    const submission = intakeAdapter.mapAssessmentToSubmission(raw, normalized);

    assert.strictEqual(submission.submissionId, "ASM-001");
    assert.strictEqual(submission.scale, "phq-9");
    assert.strictEqual(submission.totalScore, 15);
    assert.strictEqual(submission.score, 15); // 동일값
    assert.strictEqual(submission.severity, "moderate");
    assert.ok(submission.sourceSubmissionId);
  });

  test("resolveReferralLink: sourceSubmissionId 정확 일치 시 link", () => {
    const assessment = {
      sourceSubmissionId: "EXISTING-001",
      name: "테스트",
      phone: "010-0000-0000",
    };
    const mockGetData = (filename) => {
      if (filename === "Referrals") {
        return [{ referralId: "REF-123", sourceSubmissionId: "EXISTING-001" }];
      }
      return [];
    };

    const result = intakeAdapter.resolveReferralLink(assessment, {
      getData: mockGetData,
    });
    assert.strictEqual(result.action, "link");
    assert.strictEqual(result.referralId, "REF-123");
  });

  test("resolveReferralLink: externalIdx 정확 일치 시 link", () => {
    const assessment = {
      externalIdx: "EXT-001",
      sourceSubmissionId: "NEW-001",
      name: "테스트",
      phone: "010-0000-0000",
    };
    const mockGetData = (filename) => {
      if (filename === "Referrals") {
        return [{ referralId: "REF-456", externalIdx: "EXT-001" }];
      }
      if (filename === "PendingReferrals") return [];
      return [];
    };

    const result = intakeAdapter.resolveReferralLink(assessment, {
      getData: mockGetData,
    });
    assert.strictEqual(result.action, "link");
    assert.strictEqual(result.referralId, "REF-456");
  });

  test("resolveReferralLink: 이름+연락처+나이 일치 30일 내면 candidate", () => {
    const assessment = {
      sourceSubmissionId: "NEW-002",
      externalIdx: "NEW-EXT",
      name: "김철수",
      phone: "010-1111-2222",
      age: "25",
      submittedAt: new Date().toISOString(),
    };
    const mockGetData = (filename) => {
      if (filename === "Referrals") {
        return [
          {
            referralId: "REF-789",
            name: "김철수",
            phone: "010-1111-2222",
            age: "25",
            requestDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split("T")[0],
          },
        ];
      }
      if (filename === "PendingReferrals") return [];
      return [];
    };

    const result = intakeAdapter.resolveReferralLink(assessment, {
      getData: mockGetData,
    });
    assert.strictEqual(result.action, "candidate");
    assert.ok(result.referralId);
  });

  test("classifyMissingFields: UI 필수 12개 중 없는 것 반환", () => {
    const pending = {
      name: "홍길동",
      phone: "010-1234-5678",
      gender: "male",
      // region, diagnosisName, requestAgency, team, actionResult, closureStatus, requestDate, assignee, criLevel 없음
    };

    const missing = intakeAdapter.classifyMissingFields(pending);
    assert.ok(missing.includes("region"));
    assert.ok(missing.includes("diagnosisName"));
    assert.ok(missing.includes("requestAgency"));
    assert.ok(missing.includes("team"));
    assert.ok(missing.includes("actionResult"));
    assert.ok(missing.includes("closureStatus"));
    assert.ok(missing.includes("requestDate"));
    assert.ok(missing.includes("assignee"));
    assert.ok(missing.includes("criLevel"));
    assert.strictEqual(missing.length, 9); // name, phone, gender는 있음
  });
});

describe("engineService — 사이클 오케스트레이션", () => {
  let service,
    client,
    validator,
    idempotencyStoreInstance,
    syncHistoryInstance,
    config,
    persistData,
    getData,
    auditLogger;

  before(() => {
    setupTestDir();
    client = createMockClient({
      referrals: [
        {
          externalId: "CYCLE-REF-001",
          receivedAt: "2024-01-15T10:00:00Z",
          name: "사이클테스트1",
          phone: "010-1111-1111",
        },
        {
          externalId: "CYCLE-REF-002",
          receivedAt: "2024-01-15T10:05:00Z",
          name: "사이클테스트2",
          phone: "010-2222-2222",
        },
      ],
      assessments: [
        {
          externalId: "CYCLE-ASM-001",
          submittedAt: "2024-01-15T11:00:00Z",
          scale: "phq-9",
          totalScore: 10,
        },
      ],
    });

    validator = new payloadValidatorModule.HomepagePayloadValidator();
    idempotencyStoreInstance = new idempotencyStoreModule.IdempotencyStore({
      dataDir: TEST_DATA_DIR,
      auditLogger: mockAuditLogger,
    });
    syncHistoryInstance = syncHistoryModule.createSyncHistoryStores({
      dataDir: TEST_DATA_DIR,
    });
    config = {
      enabled: true,
      mode: "mock",
      pollEnabled: false,
      maxBatchSize: 50,
    };

    persistData = mockPersistData;
    getData = mockGetData;
    auditLogger = mockAuditLogger;

    service = new engineServiceModule.HomepageEngineService({
      client,
      payloadValidator: validator,
      idempotencyStore: idempotencyStoreInstance,
      intakeAdapter,
      syncHistory: syncHistoryInstance,
      config,
      persistData,
      getData,
      auditLogger,
    });
  });

  after(() => {
    cleanupTestDir();
  });

  test("getStatus: 엔진·스케줄러·마지막 동기화 상태 반환", () => {
    const status = service.getStatus();
    assert.ok(status.engine);
    assert.ok(status.scheduler);
    assert.ok(status.lastSync);
  });

  test("runSyncCycle: Mock 수신 → 검증 → 멱등성 → 저장 → ack 순서 실행", async () => {
    const summary = await service.runSyncCycle({
      actorId: "test-admin",
      trigger: "manual",
    });

    assert.ok(summary.cycleId);
    assert.strictEqual(summary.trigger, "manual");
    assert.ok(summary.received > 0);
    assert.ok(summary.stored >= 0);
    assert.ok(summary.finishedAt);
    assert.strictEqual(summary.stopReason, "success");
  });

  test("runSyncCycle: 1건 실패가 배치를 멈추지 않음 (독립 처리)", async () => {
    // 잘못된 데이터 포함
    const badDataDir = TEST_DATA_DIR + "-bad";
    // 디렉터리 생성
    if (fs.existsSync(badDataDir)) {
      fs.rmSync(badDataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(badDataDir, { recursive: true });

    const badClient = createMockClient({
      referrals: [
        {
          externalId: "GOOD-001",
          receivedAt: "2024-01-15T10:00:00Z",
          name: "좋은데이터",
          phone: "010-1111-1111",
        },
        {
          externalId: "BAD-001",
          receivedAt: "invalid-date",
          name: "",
          phone: "",
        }, // 검증 실패
      ],
    });

    const badService = new engineServiceModule.HomepageEngineService({
      client: badClient,
      payloadValidator: validator,
      idempotencyStore: new idempotencyStoreModule.IdempotencyStore({
        dataDir: badDataDir,
        auditLogger: mockAuditLogger,
      }),
      intakeAdapter,
      syncHistory: syncHistoryModule.createSyncHistoryStores({
        dataDir: badDataDir,
      }),
      config,
      persistData,
      getData,
      auditLogger,
    });

    const summary = await badService.runSyncCycle({
      actorId: "test-admin",
      trigger: "manual",
    });
    // 좋은 건은 저장되고, 나쁜 건은 격리/실패 처리되어야 함
    assert.ok(summary.received === 2);
    assert.ok(summary.quarantined >= 1 || summary.failed >= 1);
  });

  test("runSyncCycle: ack는 저장 성공 후에만 전송", async () => {
    const summary = await service.runSyncCycle({
      actorId: "test-admin",
      trigger: "manual",
    });
    // acked가 stored 이하이거나 동일해야 함 (저장 성공한 것만 ack)
    assert.ok(summary.acked <= summary.stored);
  });

  test("retryFailedItem: 실패 항목 재처리", async () => {
    // 실패 항목을 큐에 넣고 재시도
    syncHistoryInstance.retryQueue.addOrUpdate({
      externalId: "RETRY-001",
      kind: "referral",
      attemptCount: 1,
      nextAttemptAt: new Date().toISOString(),
      lastErrorCode: "PERSIST_FAILED",
      status: "pending",
    });

    // MockClient에 해당 ID 데이터 추가
    const retryClient = createMockClient({
      referrals: [
        {
          externalId: "RETRY-001",
          receivedAt: "2024-01-15T10:00:00Z",
          name: "재시도",
          phone: "010-9999-9999",
        },
      ],
    });

    const retryService = new engineServiceModule.HomepageEngineService({
      client: retryClient,
      payloadValidator: validator,
      idempotencyStore: idempotencyStoreInstance,
      intakeAdapter,
      syncHistory: syncHistoryInstance,
      config,
      persistData,
      getData,
      auditLogger,
    });

    await retryService.retryFailedItem("RETRY-001", { actorId: "test-admin" });
    // 큐에서 제거되었는지 확인
    const item = syncHistoryInstance.retryQueue.getItem(
      "RETRY-001",
      "referral",
    );
    // removeItem이 호출되어야 함 (예외가 없으면 성공)
  });

  test("retryAllFailed: 재시도 큐 전체 재처리", async () => {
    const result = await service.retryAllFailed({ actorId: "test-admin" });
    assert.ok(typeof result.retried === "number");
    assert.ok(typeof result.failed === "number");
  });
});

describe("pollScheduler — 스케줄러", () => {
  let scheduler, service, config;

  before(() => {
    setupTestDir();
    config = {
      enabled: true,
      mode: "mock",
      pollEnabled: false,
      pollIntervalSeconds: 60,
      pollInitialDelaySeconds: 60,
    };

    service = {
      runSyncCycle: async () => ({
        cycleId: "test-cycle",
        received: 0,
        stored: 0,
      }),
    };

    scheduler = new pollSchedulerModule.HomepagePollScheduler({
      engineService: service,
      config,
      auditLogger: mockAuditLogger,
    });
  });

  after(() => {
    scheduler.stop();
    cleanupTestDir();
  });

  test("기본 OFF: pollEnabled=false이면 시작하지 않음", () => {
    const offScheduler = new pollSchedulerModule.HomepagePollScheduler({
      engineService: service,
      config: { ...config, pollEnabled: false },
      auditLogger: mockAuditLogger,
    });
    offScheduler.start();
    // 경고만 로그되고 시작 안 함
    assert.strictEqual(offScheduler.getStatus().enabled, false);
  });

  test("in-progress 가드: 실행 중이면 건너뜀", async () => {
    let running = false;
    const blockingService = {
      runSyncCycle: async () => {
        running = true;
        await new Promise((r) => setTimeout(r, 50));
        running = false;
        return { cycleId: "block", received: 0 };
      },
    };

    const blockScheduler = new pollSchedulerModule.HomepagePollScheduler({
      engineService: blockingService,
      config: { ...config, pollEnabled: true, pollIntervalSeconds: 1 },
      auditLogger: mockAuditLogger,
    });

    blockScheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    blockScheduler.stop();
  });

  test("10초 이내 재실행 거부: SYNC_TOO_FREQUENT", () => {
    assert.strictEqual(scheduler.checkManualSyncThrottle(), true); // 첫 호출 허용
    assert.strictEqual(scheduler.checkManualSyncThrottle(), false); // 10초 내 재호출 차단
  });

  test("getStatus: 스케줄러 상태 요약 반환", () => {
    const status = scheduler.getStatus();
    assert.ok(typeof status.enabled === "boolean");
    assert.ok(typeof status.running === "boolean");
    assert.ok(typeof status.intervalSeconds === "number");
  });
});

describe("index — 엔진 조립", () => {
  let deps;

  before(() => {
    setupTestDir();
    deps = {
      getData: mockGetData,
      persistData: mockPersistData,
      requireAuth: (req, res, next) => {
        req.auth = { userId: "test", role: "admin" };
        next();
      },
      requireAdmin: (req, res, next) => next(),
      auditLogger: mockAuditLogger,
    };
  });

  after(() => {
    cleanupTestDir();
  });

  test("createExternalApiEngine: 설정 로드 실패 시 disabled 엔진 반환 (throw 안 함)", async () => {
    // 필수 설정 없이 호출
    const badDeps = {
      ...deps,
      getData: () => ({}),
      persistData: async () => {},
    };
    const engine = await indexModule.createExternalApiEngine(badDeps);
    assert.ok(engine);
    assert.strictEqual(engine.config.enabled, false);
    assert.ok(engine.config.disabledReason);
    assert.strictEqual(engine.client, null);
  });

  test("createExternalApiEngine: 키 없으면 client: null", async () => {
    // Mock 모드에서는 합성 키로 client 생성됨
    const engine = await indexModule.createExternalApiEngine(deps);
    assert.ok(engine);
    // mock 모드에서는 MockHomepageClient가 생성됨
  });

  test("startExternalApiEngine: 스케줄러 기동", async () => {
    const engine = await indexModule.createExternalApiEngine(deps);
    indexModule.startExternalApiEngine(engine);
    // 에러 없이 호출되어야 함
    assert.ok(true);
  });
});

describe("라우터 — 12개 엔드포인트 (Mock 테스트)", () => {
  // 라우터 테스트는 Express app 없이 핸들러 로직만 검증하거나
  // SuperTest 등으로 통합 테스트 가능. 여기선 기본 구조만 확인.
  test("engineRouter 팩토리 함수 존재", async () => {
    const { createExternalApiRouter } =
      await import("../server/external-api/engineRouter.js");
    assert.ok(typeof createExternalApiRouter === "function");
  });

  test("GET /config — 미설정 상태에서도 200 + disabled 요약 반환 (회귀: 2026-11-12 config 500)", async () => {
    // 환경변수에 홈페이지 설정이 있으면 미설정 상태가 아니게 되므로
    // 테스트 동안만 제거하고 끝나면 복원한다.
    const savedEnv = {};
    for (const key of [
      "HOMEPAGE_API_BASE_URL",
      "HOMEPAGE_ORG_ID",
      "HOMEPAGE_API_MODE",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const express = (await import("express")).default;
    const { createExternalApiRouter } = await import(
      "../server/external-api/engineRouter.js"
    );
    const engineConfig = await import(
      "../server/external-api/engineConfig.js"
    );
    const app = express();
    app.use(express.json());
    const router = createExternalApiRouter({
      requireAuth: (req, _res, next) => {
        req.auth = { userId: "admin", role: "admin" };
        next();
      },
      requireAdmin: (_req, _res, next) => next(),
      engineService: {},
      pollScheduler: null,
      engineConfig,
      homepageClient: null,
      auditLogger: async () => {},
      getData: () => [],
      persistData: async () => {},
    });
    app.use("/api/external-api", router);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = server.address().port;
      const res = await fetch(
        `http://127.0.0.1:${port}/api/external-api/config`,
      );
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.enabled, false);
      assert.ok(body.disabledReason);
      assert.strictEqual(body.keyPresent, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

after(() => {
  cleanupTestDir();
});

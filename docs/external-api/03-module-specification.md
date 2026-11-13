# 03. 신규 모듈별 상세 기능 및 인터페이스

- 설계 기준: `origin/main 34c28d8` (브랜치 `external-api-engine`)
- 근거: 2단계 설계 문서 3건 (1번 백엔드 / 2번 관리자 페이지 / 3번 보안·설정·운영)
- 상태: **설계 단계. 코드 변경 없음.**
- 표기: **[사실]**은 코드에서 직접 확인한 것, **[설계]**는 이번 단계에서 정한 것,
  **[미확정]**은 홈페이지 API 명세가 없어 정할 수 없는 것,
  **[조정]**은 3개 트랙 설계가 달라 팀장이 맞춘 부분이다.

---

## 1. 모듈 목록 (`server/external-api/`, 12개 파일)

1단계 초안 9개에서 3개가 늘었다. 에러·마스킹을 한곳에 모으지 않으면 각 모듈이 따로
마스킹 규칙을 갖게 되고, 사이클 지휘를 스케줄러가 직접 하면 스케줄러가 비대해지며,
조립을 `index.js`에 모아야 `server.js` 변경이 4곳으로 유지되기 때문이다.

| 파일 | 역할 (1~2줄) |
|---|---|
| `index.js` | 조립. `createExternalApiEngine(deps)` → `{ config, client, engineService, pollScheduler, engineRouter }` 반환 |
| `engineConfig.js` | 설정 로드·검증 (env + `EngineSettings.json`, 키는 참조만 — 값 반환 금지) |
| `engineErrors.js` | `HomepageIntegrationError` typed 에러 + 로그 마스킹 (`surveyErrors.js` 패턴) |
| `urlValidator.js` | baseUrl 검증 (surveyUrlValidator 규칙을 홈페이지용으로 일반화) |
| `homepageClient.js` | 홈페이지 API HTTP 클라이언트 (TrackAClient 패턴, 인증은 기관별 API 키) |
| `pollScheduler.js` | 자동 수신 스케줄러 (surveyAutoImportScheduler 패턴, 주기 단위는 초) |
| `payloadValidator.js` | 수신 페이로드 검증·정규화 (통과/격리/거부 구분) |
| `idempotencyStore.js` | 고유 접수 ID seen-set (`ExternalApiSeenIds.json`) |
| `intakeAdapter.js` | 홈페이지 형식 → 내부 형식 매핑 (의뢰·척도검사·연결 규칙) |
| `engineService.js` | 수신 사이클 오케스트레이터 (`runSyncCycle` — 가져오기→검증→멱등성→저장→ack→이력 순서를 코드로 강제) |
| `syncHistory.js` | 동기화 상태·이력·재시도 큐 저장소 (JSON 3종) |
| `engineRouter.js` | 관리자 전용 라우터 팩토리 `createExternalApiRouter(deps)` |

**의존성 방향 (순환 참조 금지):**
`engineRouter` → `engineService` → `homepageClient`·`payloadValidator`·`intakeAdapter`·
`idempotencyStore`·`syncHistory`·`engineConfig`. `pollScheduler`는 `engineService.runSyncCycle` 하나만 안다.
`homepageClient`는 어떤 저장소도 모른다. `engineService`는 저장소에 직접 접근하지 않고
`syncHistory`·`idempotencyStore`·어댑터 경유로만 접근한다
(단, `PendingReferrals`·`SurveySubmissions` 저장은 어댑터가 `persistData`를 직접 await한다).

---

## 2. 각 모듈의 인터페이스 (요약)

### 2-1. `engineConfig.js`

| 함수 | 입력 | 출력 | 비고 |
|---|---|---|---|
| `loadEngineConfig(overrides?)` | `{ getData, persistData }` | `EngineConfig` 객체 | 필수값 없으면 `CONFIG_MISSING`, baseUrl 검증 실패 시 `CONFIG_INVALID_URL` |
| `getEngineConfigSummary(config)` | `EngineConfig` | 키 값을 제외한 요약 (baseUrl, orgId, mode, pollEnabled, intervalSeconds, keyPresent, keyFingerprint) | — |
| `saveEngineSettings(patch, actorUserId)` | 부분 설정 + 행위자 ID | 저장된 설정 (키 제외) | 범위 밖 값이면 `CONFIG_VALIDATION_FAILED`. 감사 이벤트는 호출자(engineRouter)가 기록 |
| `resolveApiKey()` | 없음 (env만 읽음) | `{ key, source: 'env' \| 'file' }` 또는 `null` | 키가 없으면 `null` 반환 (throw 안 함 — 호출자가 fail-closed 판정) |

**`EngineConfig` 필드** (우선순위: env 명시값 > JSON 설정값 > 기본값. 단, `apiKey`는 JSON에 둘 수 없음.
JSON에 키가 들어 있으면 `CONFIG_KEY_IN_SETTINGS` 경고를 남기고 무시한다):

| 필드 | 기본값 | 비고 |
|---|---|---|
| `baseUrl` | 없음 (필수) | `urlValidator.js`로 검증. 프론트 빌드 주입 금지 |
| `apiKeyHeader` | `X-Api-Key` | **[미확정]** 업체 인증 방식에 따라 변경 |
| `authScheme` | `api-key` | `api-key` \| `bearer`. **[미확정]** |
| `orgId` | 없음 (필수) | 기관 식별값 |
| `orgIdPlacement` | `header` | `header` \| `query` \| `body`. **[미확정]** |
| `mode` | `mock` | `mock` \| `staging` \| `production` |
| `pollEnabled` | `false` | 기본 OFF |
| `pollIntervalSeconds` | `60` | 범위 30~3600 (범위 밖이면 60으로 고정) |
| `pollInitialDelaySeconds` | `60` | 범위 0~600 |
| `requestTimeoutMs` | `10000` | 범위 1000~60000 |
| `maxBatchSize` | `50` | 범위 1~100 |
| `keyFilePath` | 없음 | Docker Secrets 경로 (예: `/run/secrets/homepage_api_key`) |

**환경변수 10개** (상세·저장 위치 성격은 `04-security-design.md` §2 참조):
`HOMEPAGE_API_BASE_URL`·`HOMEPAGE_API_KEY`·`HOMEPAGE_API_KEY_FILE`·`HOMEPAGE_ORG_ID`·
`HOMEPAGE_API_MODE`·`HOMEPAGE_POLL_ENABLED`·`HOMEPAGE_POLL_INTERVAL_SECONDS`·
`HOMEPAGE_REQUEST_TIMEOUT_MS`·`HOMEPAGE_MAX_BATCH_SIZE`·`HOMEPAGE_API_KEY_HEADER`.
스케줄러 초기 지연은 별도 변수 없이 60초 고정.

**JSON 설정 파일 `EngineSettings.json`**: 비(非)키 설정만 저장한다
(`baseUrl`, `orgId`, `mode`, `pollEnabled`, `pollIntervalSeconds`, `pollInitialDelaySeconds`,
`requestTimeoutMs`, `maxBatchSize`). 저장 시 `persistData`를 쓰고, 저장 전후로 감사 이벤트를 남긴다.
구조는 `WebsiteSyncMetadata`와 같은 단일 객체 형태다.

### 2-2. `engineErrors.js` — 에러 코드표

| 코드 | HTTP | 재시도 | 의미 |
|---|---|---|---|
| `CONFIG_MISSING` | 500 | 아니오 | 필수 설정(baseUrl·키·orgId) 없음 |
| `CONFIG_INVALID_URL` | 500 | 아니오 | baseUrl 검증 실패 |
| `CONFIG_KEY_IN_SETTINGS` | 500 | 아니오 | 설정 JSON에 키가 들어 있음 (무시하고 경고) |
| `ENGINE_DISABLED` | 409 | 아니오 | 폴링 OFF인데 수동 동기화 시도 |
| `SCRAPER_CONFLICT` | 409 | 아니오 | 스크레이퍼가 켜져 있어 엔진 실행 거부 |
| `AUTH_FAILED` | 502 | 아니오 | 홈페이지 401/403. 재시도해도 같은 결과 |
| `NOT_FOUND` | 502 | 아니오 | 홈페이지 404 |
| `RATE_LIMITED` | 502 | 예 | 홈페이지 429. `Retry-After`가 있으면 그 값을 따름 |
| `REQUEST_TIMEOUT` | 504 | 예 | `AbortController` 타임아웃 |
| `NETWORK_ERROR` | 503 | 예 | 연결 실패·DNS·TLS 오류 |
| `NON_JSON_RESPONSE` | 502 | 아니오 | JSON이 아닌 응답 (HTML·로그인 페이지 등) |
| `INVALID_PAYLOAD_SCHEMA` | 502 | 아니오 | 최상위 구조가 아님 |
| `VALIDATION_FAILED` | 422 | 아니오 | 항목 검증 실패 → 격리 (사이클 실패 아님) |
| `DUPLICATE_SKIPPED` | — | — | 에러 아님. 멱등성 스킵 결과 (카운트만 함) |
| `PERSIST_FAILED` | 500 | 예 | `persistData` 실패 (3회 재시도 후에도 실패) |
| `ACK_FAILED` | 502 | 예 | ack 전송 실패 → 재시도 큐로 이동 (저장은 이미 완료됨) |
| `SYNC_ALREADY_RUNNING` | 409 | 아니오 | 이미 사이클 실행 중 |
| `SYNC_TOO_FREQUENT` | 429 | 예 | 수동 동기화 간격 10초 미만 |
| `RETRY_EXHAUSTED` | 422 | 아니오 | 재시도 3회 소진 → 수동 재처리 대기 |

마스킹 함수: `maskForLog(value)` — API 키·Bearer 토큰·전화번호·주민번호 패턴·파일 경로를 마스킹.
`maskPayloadForLog(obj)` — 키 목록(`apiKey`, `phone`, `clientName`, `answers`, `responses`,
`residentRegistrationNumber`)은 `[REDACTED]`로 교체.

### 2-3. `urlValidator.js`

`validateHomepageBaseUrl(rawUrl, mode = 'mock')` — surveyUrlValidator 규칙 그대로:
빈 문자열·비문자열 거부, `..`·`\` 거부, `new URL()` 파싱 실패 거부, 내장 자격증명 거부,
staging·production에서 `https:`가 아니면 거부, production에서 localhost·127.0.0.1·`::1`·
`.localhost`·`.local` 거부, staging에서 localhost 계열 거부. mock 모드에서는 `http://localhost` 허용.

### 2-4. `homepageClient.js` — `HomepageClient` 클래스

| 메서드 | 입력 | 출력 | 비고 |
|---|---|---|---|
| `constructor(config)` | baseUrl, apiKey, apiKeyHeader?, authScheme?, orgId, orgIdPlacement?, timeoutMs?, maxBatchSize? | 인스턴스 | 필수값 누락 시 throw. 운영에서 `https:`가 아니면 throw |
| `checkCapabilities()` / `ping()` | 없음 | `{ valid, data }` / `boolean` | 연결 테스트용 |
| `fetchNewReferrals({ limit, since? })` | limit 1~100, since? | `{ items, count, nextSince? }` | — |
| `fetchNewAssessments({ limit, since? })` | 위와 동일 | 위와 동일 | — |
| `fetchItemById(kind, externalId)` | `'referral' \| 'assessment'`, 외부 ID | 항목 1건 | 재시도 큐 단건 재처리용 |
| `acknowledgeItem(externalId, { requestId })` | 외부 ID, 요청 ID(필수) | 홈페이지 응답 | 저장 완료 후에만 호출 |
| `reportItemFailed(externalId, { category, reason })` | 외부 ID, 실패 구분·사유 | 홈페이지 응답 | 실패해도 사이클을 멈추지 않음 |
| `_request(endpointPath, {...})` | 내부 전용 | 파싱된 JSON | `HomepageIntegrationError`로 변환 |
| `_sanitizeId(id)` | 외부 ID 문자열 | `encodeURIComponent(id)` | 형식이 아니면 `INVALID_PAYLOAD_SCHEMA` |

**`_request` 동작** (`trackAClient.js` 뼈대): `AbortController` + 타임아웃(기본 10초),
인증 헤더 + 기관 식별값 + `Accept: application/json`, 응답 `Content-Type`이 JSON이 아니면
`NON_JSON_RESPONSE`, `!resp.ok`면 홈페이지 에러 본문의 `error.code`/`error.message`를 typed 에러로 옮김,
`fetch` 자체 실패는 `REQUEST_TIMEOUT`/`NETWORK_ERROR`로 변환.
**로그에는 키를 절대 남기지 않는다.** 인증 지문은 `sha256(apiKey)` 앞 8자만 프로세스당 1회 출력.

**엔드포인트 경로 [미확정]** — 인터페이스 계약용 가정치. 명세가 오면 이 표만 바꾼다:

| 메서드 | 경로 (가정치) | 용도 |
|---|---|---|
| `fetchNewReferrals` | `GET /api/v1/referrals?limit=&since=` | 신규 의뢰 목록 |
| `fetchNewAssessments` | `GET /api/v1/assessments?limit=&since=` | 신규 척도검사 결과 목록 |
| `fetchItemById` | `GET /api/v1/{referrals\|assessments}/{id}` | 단건 재조회 |
| `checkCapabilities` | `GET /api/v1/capabilities` (없으면 `GET /api/v1/health`로 폴백) | 연결 테스트 |
| `acknowledgeItem` | `POST /api/v1/{referrals\|assessments}/{id}/ack` | 수신 완료 처리 |
| `reportItemFailed` | `POST /api/v1/{referrals\|assessments}/{id}/failed` | 실패 보고 |

### 2-5. `pollScheduler.js` — `HomepagePollScheduler` 클래스

`surveyAutoImportScheduler` 패턴 그대로. 기본 OFF, 기동 지연 60초, in-progress 가드,
`setTimeout` 체인 + `unref()`, 실패해도 다음 예약 유지, `getStatus()` 상태 요약.
기동 위치: `server.js`의 survey 스케줄러 기동부(`surveyAutoImportScheduler.start()` 호출 직후).
필수 설정이 없으면 스케줄러는 기동하지 않고 경고 1줄만 남긴다 (서버 기동 자체는 계속).
수동 동기화는 스케줄러의 다음 예약 시각을 바꾸지 않는다. 수동 실행 직후 10초 이내 재실행은
`SYNC_TOO_FREQUENT`(429)로 거부한다.

### 2-6. `payloadValidator.js` — `HomepagePayloadValidator` 클래스

`validateBatch(payload, kind)` → `{ valid, quarantined, rejected }`.
의뢰 검증: `externalId` 없음·형식 오류·`receivedAt` 파싱 실패·이름+전화 둘 다 없음·타입 불일치·
길이 초과(`name` 50자, `phone` 30자, `problem`/`reason` 2000자, 기타 500자)·스팸 패턴은 격리.
`gender`·`referralPath`가 알 수 없는 값이면 `null`로 정규화하고 통과 (이력에 경고 1건).
척도검사 검증: `externalId`·`scale`·`submittedAt` 없음, `totalScore` 비숫자, `scaleScores` 비객체는 격리.
`severity` 없음은 `null`로 통과 (**총점으로 추측하지 않음**).
정규화: 문자열 trim, 전화번호 형식 변환 금지, 날짜는 ISO 8601로 통일 (KST 기준 여부는 **[미확정]**).

### 2-7. `idempotencyStore.js` — seen-set (`ExternalApiSeenIds.json`)

`hasSeen(externalId)` · `markSeen(externalId, record)` · `markSeenBatch(entries)` ·
`getSeenRecord(externalId)` · `removeSeen(externalId)` (관리자 수동 재처리용, 엔진 내부에서는 호출 안 함).
레코드: `{ kind, status: 'stored' | 'quarantined' | 'acked' | 'failed', firstSeenAt, lastSeenAt, ackedAt }`.
한 사이클의 seen 기록은 `markSeenBatch`로 한 번에 묶어 쓴다.
10,000건 초과 시 `acked`이면서 180일 지난 항목부터 정리 (정리 시 감사 이벤트 1건).
**스크레이퍼의 `seenExternalIds`를 이어받지 않는다** (수명주기 분리·키 체계 차이 가능성·ack 상태 추적).

### 2-8. `intakeAdapter.js`

`mapReferralToPending(raw, normalized, ctx)` → `PendingReferrals` 항목.
`mapAssessmentToSubmission(raw, normalized, ctx)` → `SurveySubmissions` 레코드.
`resolveReferralLink(assessment, { getData })` → `{ action: 'link' | 'candidate' | 'none', referralId?, reason }`.
`classifyMissingFields(pendingItem)` → UI 필수 12개 중 없는 항목 목록.
매핑표는 `05-data-mapping.md` 참조. 명세가 오면 바꿀 곳은
`homepageClient` 경로 상수 + `intakeAdapter` 매핑표 + `engineConfig` 인증 설정뿐이다.

### 2-9. `engineService.js` — `HomepageEngineService` 클래스

`runSyncCycle({ actorId, trigger })` → 사이클 요약
(`cycleId`, `trigger`, `startedAt`/`finishedAt`, `received`, `stored`, `duplicates`,
`quarantined`, `failed`, `acked`, `ackSkipped`, `stopReason`, `errors` 코드별 집계).
`processReferralBatch` / `processAssessmentBatch` — 항목별 처리, 1건 실패가 배치를 멈추지 않음.
`retryFailedItem(externalId, { actorId })` / `retryAllFailed({ actorId })`.
`getStatus()` — 스케줄러 상태 + `syncHistory` 상태 합산.

### 2-10. `syncHistory.js` — 파일 3종

| 파일 | 내용 | 크기 관리 |
|---|---|---|
| `ExternalApiSyncState.json` | 단일 객체: `{ enabled, lastSuccessfulSyncAt, lastAttemptedSyncAt, lastSyncStatus, lastSyncError, lastReceivedCount, lastStoredCount, lastDuplicateCount, lastFailedCount, consecutiveFailures, nextScheduledAt, scraperConflict }` | 단일 객체라 관리 불필요 |
| `ExternalApiSyncHistory.json` | 사이클별 레코드 배열 (사이클 요약 + 에러 코드별 집계 + 실패한 외부 ID 목록 — 이름·전화 없음) | 최대 500건. 초과 시 가장 오래된 것부터 삭제 |
| `ExternalApiRetryQueue.json` | 실패 항목 배열 `{ externalId, kind, attemptCount, nextAttemptAt, lastErrorCode, firstFailedAt, lastAttemptedAt, status }` | 최대 1,000건. `status: 'exhausted'` 항목은 자동 삭제하지 않음 (수동 재처리 대기) |

`lastSuccessfulSyncAt` 갱신 조건: fetch 성공 + 받은 항목의 저장(또는 멱등성 스킵 처리) 완료.
받은 건수 0건이어도 fetch 성공이면 갱신한다 (신규 데이터 없음도 정상 수신이다).

### 2-11. `engineRouter.js` — 팩토리 `createExternalApiRouter(deps)`

`createSurveyImportRouter(deps)` 패턴과 동일하게 의존성 주입.
주입: `requireAuth`, `requireAdmin` (`server/auth/authMiddleware.js`에서 주입 — 직접 import 안 함),
`engineService`, `pollScheduler`, `engineConfig` (load/save 함수),
`homepageClient` (또는 `testConnection` 함수), `auditLogger`.

### 2-12. `index.js`

`createExternalApiEngine(deps)` → `{ config, client, engineService, pollScheduler, engineRouter }`.
설정 로드 실패 시 throw하지 않고 `{ enabled: false, disabledReason }`를 담은 엔진을 반환한다
(엔진 설정 문제로 서버 기동이 멈추면 안 되기 때문. 단, 설정이 유효하지 않으면 스케줄러는 절대 기동하지 않음).
키가 없으면 클라이언트를 만들지 않고 `client: null`로 둔다.
`startExternalApiEngine(engine)` — 스케줄러 기동 + 기동 시 1회 상태 기록.

---

## 3. 라우터·마운트 설계 (통합 엔드포인트 목록)

### 3-1. 마운트 (`server.js` 변경 4곳)

```js
// 1. import (survey 모듈 import 근처)
import { createExternalApiEngine, startExternalApiEngine } from './server/external-api/index.js';

// 2. 엔진 생성 (survey 모듈 조립부 근처, server.js 약 840~900행대)
const externalApiEngine = createExternalApiEngine({
    getData,
    persistData,
    requireAuth,
    requireAdmin,
    auditLogger: referralAuditLogger  // [추측] surveyAuditLogger와 같은 형태의 로거. 정확한 주입 대상은 3단계에서 server.js를 보고 확정
});

// 3. 라우터 마운트 (survey 라우터 마운트 직후 — 반드시 app.all('/api/*') 404 핸들러(5295행)보다 앞에 둘 것)
app.use('/api/external-api', externalApiEngine.engineRouter);

// 4. 스케줄러 기동 (surveyAutoImportScheduler.start() 호출 직후)
startExternalApiEngine(externalApiEngine);
```

### 3-2. 엔드포인트 목록 (전부 `requireAdmin`)

**[조정]** 3개 트랙의 목록을 하나로 맞췄다. 설정 경로는 `/config`로 통일한다
(1·2번 트랙 일치. 3번 트랙의 `/settings` 표기는 같은 API의 다른 이름이다).
수동 동기화는 비동기 잡 방식이다 (설문 `POST /api/surveys/import` 선례 — `POST /sync`가 `jobId`를 돌려주고
`GET /sync/:jobId`로 폴링한다. 1번 트랙의 동기식 사이클 반환은 잡 결과로 바뀐다).

| # | 메서드 | 경로 | 설명 |
|---|---|---|---|
| 1 | GET | `/api/external-api/status` | 엔진·스케줄러 상태 + 마지막 수신 요약 |
| 2 | GET | `/api/external-api/config` | 현재 설정 (키 값 제외, 키 존재 여부 + 지문만 포함) |
| 3 | PUT | `/api/external-api/config` | 비(非)키 설정 변경 (baseUrl·orgId·주기·배치·타임아웃). 키 변경은 이 API로 불가. 변경 시 감사 이벤트 기록 |
| 4 | POST | `/api/external-api/test-connection` | 연결 테스트 (`ping()` + `checkCapabilities()`). 자체 속도 제한 있음 |
| 5 | POST | `/api/external-api/sync` | 수동 동기화 1회 실행 (202 + `jobId` 반환). 실행 중이면 409 `SYNC_ALREADY_RUNNING`, 10초 이내 재호출이면 429 `SYNC_TOO_FREQUENT` |
| 6 | GET | `/api/external-api/sync/:jobId` | 수동 동기화 잡 상태 폴링 (3초 간격, 최대 10분 — 설문 잡 폴링 선례) |
| 7 | GET | `/api/external-api/history` | 동기화 이력 목록 (쿼리 `limit` 기본 50·최대 100, `offset`) |
| 8 | GET | `/api/external-api/history/:cycleId` | 사이클 1건 상세 |
| 9 | GET | `/api/external-api/retry-queue` | 실패 재처리 큐 목록 |
| 10 | POST | `/api/external-api/retry/:externalId` | 실패 항목 1건 재처리 |
| 11 | POST | `/api/external-api/retry-queue/retry-all` | 재시도 큐 전체 재처리 |
| 12 | GET | `/api/external-api/seen/:externalId` | 외부 ID 수신 여부 조회 (디버깅·지원용) |

**인증·역할**: 12개 전부 `requireAdmin`이다. `GET /status`도 관리자만 본다.
`req.auth`만 신뢰하고 `x-user-role` 헤더는 보지 않는다 (R2 패턴 금지).
**응답 관례**: GET은 객체·배열을 그대로 반환하고, 상태 변경(POST/PUT)은 `{ success: true, ... }`를 반환하고,
에러는 `{ error: { code, message } }` + HTTP 상태코드를 반환한다.
`requireAdmin`의 403은 기존과 동일하게 `{ success: false, error: "관리자 권한이 필요합니다." }`를 반환한다.
**속도 제한 [조정]**: 전역 속도 제한이 없는 상태(R4)라 엔진 라우터 안에 자체 가드를 둔다.
`POST /test-connection`은 관리자당 분당 5회, `POST /sync`는 전역 10초 간격 + 관리자당 분당 2회.
초과 시 429 + `Retry-After` 헤더. 가드는 인메모리 Map(관리자 ID → 마지막 호출 시각)으로 구현하고,
프로세스 재시작 시 초기화된다 (영구 차단 안 함).
(1번 트랙은 테스트 10회/분을 제안했고 3번 트랙은 5회/분을 제안했다. 엄격한 쪽(5회/분)으로 맞췄다.)

**이름 충돌 없음 확인 [사실]**: 신규 네임스페이스 `/api/external-api/*`는 기존
`/api/website-referrals/*`(스크레이퍼용)와 겹치지 않는다.
기존 `POST /api/pending-referrals/sync`·`POST /api/website-referrals/sync`는 스크레이퍼용 별칭이라
엔진의 수동 동기화와 분리한다. `GET /api/surveys/sync-status`와도 겹치지 않는다.

### 3-3. 키 관련 엔드포인트 — **결정 대기**

| # | 메서드 | 경로 | 설명 |
|---|---|---|---|
| — | POST | `/api/external-api/key` | 인증키 등록·변경 (2번 트랙 설계) |
| — | DELETE | `/api/external-api/key` | 인증키 폐기 (2번 트랙 설계, 선택) |

1·3번 트랙은 키를 env/Docker Secrets로만 관리하고 페이지에 키 입력 칸을 두지 않는 설계를 제안했다
(상세는 `04-security-design.md` §2). 2번 트랙은 의뢰서 6절 "API 인증키 등록 및 변경"에 따라
페이지에 비밀번호형 입력 칸을 설계했다. **권장안은 1·3번 트랙(화면 입력 없음, 지문 표시 + 연결 테스트만)**이다.
이유: 웹 페이지에서 컨테이너 환경변수를 바꿀 수 없고(재시작 필요), 키를 웹 경로·설정 JSON 경유로 저장하면
R1과 같은 평문 저장 함정이 생기며, 키가 HTTP 요청 본문·브라우저 기록에 남는다.
키 교체는 NAS 운영 절차(새 키 발급 → Secrets 파일 원자적 교체 → 컨테이너 재시작 → 지문 변경 확인 + 연결 테스트)로 한다.
jun이 "화면에서 입력하게 해줘"를 고르면 위 2개 엔드포인트를 추가한다.

---

## 4. 관리자 화면 설계 (신규 페이지 — 2026-11-12 19:59 jun 확정)

`02-architecture-design.md` §5 참조. 신규 페이지로 확정됐다.

### 4-1. 페이지 구조

| 항목 | 값 |
|---|---|
| 새 `Page` 값 | `'externalApi'` (camelCase 관례 — `surveyManagement`·`voiceCalls`와 같은 모양). 현재 `Page` 유니언은 `types.ts:289`에 16개 값으로 정의돼 있음 **[사실]** |
| 새 컴포넌트 | `components/externalApi/ExternalApiAdminPage.tsx` (새 디렉터리) |
| 메뉴 제목 | 홈페이지 API 연동 |
| 사이드바 아이콘 | lucide `Webhook` (없으면 `PlugZap`으로 대체). `PAGES_CONFIG` 아이콘은 `fa-solid fa-plug` |
| 메뉴 색 | `text-sky-600` / `bg-sky-50` / `activeBg: bg-sky-100` / `activeText: text-sky-700` (기존 메뉴와 겹치지 않는 sky 계열) |
| 사이드바 위치 | `'data'` 바로 뒤. 관리자(`role === 'admin'`, `status === 'active'`)에게만 노출 |
| 모바일 하단 내비 | 넣지 않음 (데스크톱 전용) |

### 4-2. 화면 섹션 7개 (의뢰서 6절 항목 10개 전부 커버)

| 섹션 | 내용 | 데이터 출처 |
|---|---|---|
| S1 연동 상태 | 상태 점 + 상태 말(정상/실패/미설정/동기화 중) + 마지막 성공 시각 + 이번 주기 건수 + 다음 예정 시각. 페이지 맨 위 가로 상태 스트립 (동기화 중일 때만 점 깜빡임 — 모션은 이 하나뿐) | `GET /status` (진입 시 1회 + 30초마다 새로고침, 동기화 중에는 3초마다) |
| S2 연결 설정 | API 주소 + 기관 식별값 입력 + 저장 | `GET/PUT /config` |
| S3 인증키 | 등록됨/미등록 + 등록 시각만 표시. 비밀번호형 입력 + 등록·변경 버튼 (키 값·일부·길이 전부 표시 금지). 제출 후 state에서 즉시 삭제 | `POST /api/external-api/key` (위 §3-3 결정 대기 — 키 입력 없음으로 정해지면 이 섹션은 지문 표시 + 연결 테스트 안내로 바뀐다) |
| S4 연결 테스트 | 테스트 버튼 + 결과 패널 (성공/실패·HTTP 상태·응답 시간·인증 결과·오류 코드·테스트 시각). 실제 데이터를 가져오지 않음 | `POST /test-connection` |
| S5 자동 수신 | ON/OFF 토글 + 주기(초, 기본 60, 범위 60~3600 — 60 미만은 입력 단계에서 차단). 기본 OFF | `PUT /config` |
| S6 수동 동기화 | [지금 동기화] 버튼 → `jobId` 반환 → `GET /sync/:jobId` 3초 폴링 (최대 10분) → 결과 요약 표시 | `POST /sync`, `GET /sync/:jobId` |
| S7 수신 이력·오류 | 표 (시각 | 종류 | 결과 | 받은 건수 | 중복 스킵 | 오류 | [재처리]). 고유 접수 ID·오류 코드만 표시. 이름·전화·검사 원문 절대 표시 안 함. 최근 50건 + 더 보기 | `GET /history`, `POST /retry/:externalId` |

선택 사항: 기존 스크레이퍼 상태를 S1 아래 한 줄로 읽기 전용 표시 ("기존 홈페이지 수집(스크레이퍼): 꺼짐").
이 페이지에서 스크레이퍼를 켜거나 끌 수 없다.

### 4-3. 권한 (이중 방어)

- 사이드바 노출 판정(admin만) + `renderPage` 진입 시 재검사해 403 화면
  ("접근 권한 제한" + 홈으로 이동, `surveyManagement` case 구조 그대로).
  1단계 분석에서 확인했듯 `data`·`accounts` 페이지에는 `renderPage` 단 가드가 없어
  사이드바 노출 판정에만 의존한다. 새 페이지는 그 전철을 밟지 않는다.
- 새 권한 플래그는 만들지 않는다 (관리자 전용이라 `role` 검사만으로 충분).
  나중에 일반 직원에게 읽기 전용 접근을 주기로 정해지면 그때 `EXTERNAL_API_ACCESS` 플래그를
  `isPermissionFlagGranted` 헬퍼로 추가한다.
- 서버가 최종 판정자다. 프론트의 메뉴 숨김·진입 가드는 편의용이고, 진짜 검사는 서버 `requireAdmin`이 한다.
- 오프라인: 서버 무응답 시 마지막으로 받은 값을 "마지막 확인 시각"과 함께 보여주고,
  모든 동작 버튼(저장·테스트·동기화·키 변경)을 비활성화한다. 설정 저장은 오프라인에서 할 수 없다.

### 4-4. 건드리는 파일 목록 (구현 시)

| 파일 | 변경 내용 |
|---|---|
| `types.ts` | `Page` 유니언에 `'externalApi'` 추가 + 아래 §5의 타입 5개 추가 |
| `constants.ts` | `PAGES_CONFIG`에 `externalApi` 항목 추가 |
| `components/layout/Sidebar.tsx` | 메뉴 배열에 `'externalApi'` 추가 (`'data'` 뒤) + 노출 판정(admin만) + `PAGE_ICONS`에 `Webhook` 추가 |
| `App.tsx` | `renderPage`에 `case 'externalApi':` + 403 가드 추가 |
| `services/apiClient.ts` | §5의 메서드 9개 추가 |
| `components/externalApi/ExternalApiAdminPage.tsx` | **신규 파일** — 페이지 전체 (7개 섹션) |
| 건드리지 않는 것 | 모바일 하단 내비, `aiNotepad`(미사용 값), `data` 페이지, `authService.ts`(미사용 코드) |

디자인 토큰은 코드에서 확인된 것만 쓴다 (`--executive-indigo #4338ca` 등).
**[사실]** `--brand-primary`·`--brand-light`는 소스 전수 grep 결과 정의가 없어,
새 페이지는 이 변수에 의존하지 않게 설계했다. 정의되지 않은 토큰 자체를 고치는 일은 이 단계 범위가 아니다.

### 4-5. 상태·엣지 케이스

첫 진입 로딩 중에는 섹션 자리 스피너 + 버튼 전부 비활성화. 설정 불러오기 실패 시 상단 오류 배너 +
입력 칸 비활성화 (빈 상태로 표시하지 않음). 미설정 시 S1 "미설정" + 안내 문구,
테스트·동기화·자동 수신 저장 버튼 비활성화 (사유 표시). 저장·테스트·동기화 중에는 해당 버튼 비활성화 +
진행 표시. 세션 만료(401)는 기존 동작대로 처리. 키 입력 후 새로고침하면 입력 중이던 키는 사라진다 (의도된 동작).

---

## 5. `apiClient` 메서드 (9개) 및 타입 (5개)

직접 `fetch`를 쓰지 않고 `apiClient`에 메서드를 추가하는 방식이다
(`DataManagementPage`가 `/api/backup/*`을 직접 `fetch`로 부르는 것과 다르다).
`authService.ts`는 미사용 코드라 쓰지 않는다.

| 메서드 | 호출 API | 비고 |
|---|---|---|
| `getExternalApiConfig()` | `GET /api/external-api/config` | 설정 조회 |
| `saveExternalApiConfig(patch)` | `PUT /api/external-api/config` | 설정 저장 (바뀐 필드만 보낸다) |
| `registerExternalApiKey(key)` | `POST /api/external-api/key` | 키 등록·변경 (§3-3 결정 대기) |
| `deleteExternalApiKey()` | `DELETE /api/external-api/key` | 키 폐기 (선택, §3-3 결정 대기) |
| `testExternalApiConnection()` | `POST /api/external-api/test-connection` | 연결 테스트 |
| `getExternalApiStatus()` | `GET /api/external-api/status` | 수신 상태 조회 |
| `getExternalApiHistory(limit?)` | `GET /api/external-api/history?limit=` | 이력 조회 (기본 50) |
| `triggerExternalApiSync()` | `POST /api/external-api/sync` | 수동 동기화 시작, `jobId` 반환 |
| `getExternalApiSyncJob(jobId)` | `GET /api/external-api/sync/:jobId` | 잡 상태 폴링 |
| `retryExternalApiHistoryItem(id)` | `POST /api/external-api/history/:id/retry` | 실패 항목 재처리 (선택) |

타입 5개 (`types.ts`에 추가): `ExternalApiConfig` (baseUrl·orgId·pollEnabled·pollIntervalSeconds·
keyConfigured·keyUpdatedAt — 키 값 없음), `ExternalApiStatus` (lastSuccessfulSyncAt·lastAttemptedSyncAt·
lastSyncStatus·lastSyncError·syncInProgress·receivedReferrals·receivedAssessments·skippedDuplicates·
failedCount·nextScheduledAt), `ExternalApiHistoryItem` (id·syncedAt·kind·result·receivedCount·
skippedDuplicates·errorCode·errorMessage(마스킹됨)·retryStatus·retriedAt),
`ExternalApiTestResult` (success·httpStatus·latencyMs·authPassed·error·testedAt),
`ExternalApiSyncJob` (jobId·status·summary·error).

---

## 6. 미확정 항목 목록 (명세가 오면 정할 것 — 총 18개)

| # | 항목 | 정해지면 바뀌는 곳 | 현재 가정치 |
|---|---|---|---|
| U1 | 홈페이지 API 기본 주소 | `HOMEPAGE_API_BASE_URL` 설정값 | 없음 (필수) |
| U2 | 인증 방식 (API 키 헤더 vs Bearer vs OAuth vs Basic) | `HOMEPAGE_API_KEY_HEADER`, `HOMEPAGE_API_AUTH_SCHEME` | `X-Api-Key` + `api-key` |
| U3 | 기관 식별값 형식·전달 위치 (헤더·쿼리·본문) | `HOMEPAGE_ORG_ID_PLACEMENT`, `HOMEPAGE_ORG_ID` | 헤더 `X-Org-Id` |
| U4 | 엔드포인트 경로 (의뢰 목록·단건·척도검사 목록·ack·실패 보고·capabilities) | `homepageClient`의 경로 상수 (§2-4 표) | `/api/v1/...` 가정 |
| U5 | 요청·응답 JSON 스키마 (필드명·필수 여부·페이지네이션) | `payloadValidator`, `intakeAdapter` 매핑표 | `items` 배열 + `count` 가정 |
| U6 | 의뢰 필드 정의 (필수 필드·날짜 형식·인코딩) | `payloadValidator.validateReferralItem`, 매핑표 | §2-6 규칙 |
| U7 | 척도검사 종류 코드 목록·문항·점수 형식 | `payloadValidator.validateAssessmentItem`, 매핑표 | `scale` 코드 + 총점 + `scaleScores` 가정 |
| U8 | 대상자 식별 키 (이름+연락처 vs 고유 ID) | `resolveReferralLink` 연결 규칙 | 정확 일치만 연결, 후보는 수동 검토 |
| U9 | 페이지네이션·필터·정렬 방식 (`since` 파라미터 지원 여부 포함) | `fetchNewReferrals`/`fetchNewAssessments` 인자 | `limit` + `since` 가정 |
| U10 | 에러 형식·재시도 가능 여부 구분 | `engineErrors.js` 코드 매핑 | HTTP 상태 기반 분류 |
| U11 | 속도 제한 (분당 요청 수·429 정책·권장 폴링 주기) | `pollIntervalSeconds` 하한·재시도 정책 | 하한 30초, 기본 60초 |
| U12 | 수신 완료 처리(ack) API 유무·방식·미ack 시 재전송 여부 | `acknowledgeItem`, ack 단계 | ack API가 있다고 가정, 없으면 스킵 |
| U13 | 단건 재조회 API 유무 (재시도 큐 단건 재처리용) | `fetchItemById`, 재처리 흐름 | 있다고 가정, 없으면 큐 저장 페이로드로 재처리 |
| U14 | 날짜·시간대 형식 (KST 기준 여부) | `payloadValidator` 날짜 정규화 | ISO 8601 가정, KST 변환 규칙 미정 |
| U15 | `source` 채널 값 (새 값 `'homepage-api'` vs 기존 `'website'` 재사용) | `intakeAdapter` 매핑표 | `'homepage-api'` 제안, 팀장 최종 결정 |
| U16 | 스크레이퍼 seen-set 키 체계와 API 고유 ID의 동일 여부 | `idempotencyStore` 승계 여부 | 별도 파일로 분리 (승계 안 함) |
| U17 | 홈페이지가 직접 주는 `referralPath` 값 목록 | 매핑표의 경로 분류 | 스크레이퍼 자동 분류 규칙 재사용 |
| U18 | 키 발급·재발급 절차·테스트용 키 제공 여부 | 3번 트랙 (설정·운영) 범위 | — |

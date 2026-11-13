# 09. Mock API 및 통합 테스트 결과 보고서

- 실행일: 2026-11-13 (최종 검증: 팀장 직접 재실행)
- 테스트 환경: Node.js 내장 `node --test` + Mock Homepage API (Node v24.22.1)
- Mock 서버: `server/external-api/mockHomepageApi.js`
- 실행 명령: `node --test tests/mockApiE2E.test.js` (하네스 18개), `node --test tests/*.test.js` (전체 161개)

---

## 테스트 결과 요약

| # | 테스트 | 결과 | 증거 | 비고 |
|---|--------|------|------|------|
| T1 | 정상 인증 | ✅ 합격 | 아래 T1 참조 | - |
| T2 | 잘못된 인증키 | ✅ 합격 | 아래 T2 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T3 | 신규 의뢰 수신 | ✅ 합격 | 아래 T3 참조 | - |
| T4 | 신규 척도검사 수신 | ✅ 합격 | 아래 T4 참조 | - |
| T5 | 중복 접수 | ✅ 합격 | 아래 T5 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T6 | 필수 필드 누락 + 잘못된 데이터 | ✅ 합격 | 아래 T6 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T7 | 암호화 및 복호화 | ✅ 합격 | 아래 T7 참조 | (c) 미확정 |
| T8 | 통신 오류 및 재시도 | ✅ 합격 | 아래 T8 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T9 | 저장 실패 | ✅ 합격 | 아래 T9 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T10 | 재시도 및 복구 | ✅ 합격 | 아래 T10 참조 | 수정 후 합격 (아래 "수정 내역" 참조) |
| T11 | 중복 파이프라인 충돌 | ✅ 합격 | 아래 T11 참조 | - |
| T12 | 기존 기능 영향 여부 | ✅ 합격 | 아래 T12 참조 | 기준선/회귀 |
| T13 | 인증정보 GitHub 노출 여부 | ✅ 합격 | 아래 T13 참조 | - |

**하네스: 18/18 합격. 전체 테스트: 161/161 합격 (기존 142 + 하네스 18 + 마스킹 회귀 테스트 1).**

---

## 상세 결과

### T1: 정상 인증
- **합격/불합격**: ✅ 합격
- **증거**:
  - 상태 코드: 200, 동기화 성공 (`stopReason: "success"`)
  - 저장 건수: 의뢰 2건, 척도 1건 (`received=3`, `stored=3`, `duplicates=0`, `failed=0`)
  - 키 로그/응답 노출 여부: 감사 로그에 API 키 본문 없음

### T2: 잘못된 인증키
- **합격/불합격**: ✅ 합격
- **증거**:
  - 상태 코드: 401
  - 에러 코드: `HOMEPAGE_AUTH_FAILED` (06 테스트 계획의 기대 코드와 동일)
  - 실패 큐 기록: 동기화 상태 `lastSyncStatus: "failed"`, `lastSyncError`에 인증 실패 기록
  - 자동 재시도 여부: 없음 (401은 재시도 불가 코드)
  - 키 본문 로그 노출 여부: 감사 로그에 `wrong-key` 없음

### T3: 신규 의뢰 수신
- **합격/불합격**: ✅ 합격
- **증거**:
  - 완비 2건 저장 확인: `received=3`, `stored=2`
  - 부족 1건 격리/실패 큐 확인: `quarantined=1` (이름·전화 둘 다 없음), 이력의 `quarantinedDetails` 1건
  - 저장 전 ack 금지 확인 (Mock ackLog): ack 2건 (저장된 항목만)

### T4: 신규 척도검사 수신
- **합격/불합격**: ✅ 합격
- **증거**:
  - 저장 건수: 2건 (PHQ-9 + GAD-7)
  - `scale`·총점·`sourceSubmissionId` 연결 확인: `scale`·`totalScore`·`sourceSubmissionId` 전부 검증됨

### T5: 중복 접수
- **합격/불합격**: ✅ 합격
- **증거**:
  - 두 번째 폴링 `skipped=3`, `stored=0`: `received=3`, `stored=0`, `duplicates=3`
  - 중복 행 없음 확인: `PendingReferrals`의 `externalIdx` 중복 없음

### T6: 필수 필드 누락 + 잘못된 데이터 형식
- **합격/불합격**: ✅ 합격
- **증거**:
  - 오염된 건만 실패 큐: `received=5`, `stored=1`, `quarantined=4`
  - 정상 건 저장됨: `T6-VALID-001` 1건만 저장
  - 에러 코드 기록: 이력의 `quarantinedDetails` 4건, 사유에 "이름과 연락처"·"타입 불일치"·"길이 초과" 전부 포함

### T7: 암호화 및 복호화
- **합격/불합격**: ✅ 합격 (단, (c)는 미확정)
- **증거**:
  - (a) HTTP URL production 모드 거부: `HOMEPAGE_API_MODE=production` + `http://` URL 기동 시 거부됨
  - (b) 키·개인정보 로그·응답·설정 JSON 없음: 감사 로그에 키 본문 없음, 설정 요약에 `apiKey` 필드 없음 (`keyPresent: true`, `keyFingerprint`만 있음), 로그에 전화번호 없음
  - (c) 페이로드 암호화 여부: **미확정** (업체 명세 대기)

### T8: 통신 오류 및 재시도
- **합격/불합격**: ✅ 합격
- **증거**:
  - 실패 큐 `TIMEOUT`/`NETWORK_ERROR`: 연결 실패 후 재시도 큐 1건, `lastErrorCode: "NETWORK_ERROR"`
  - 지수 백오프 간격(1000→2000→4000ms): `nextAttemptAt`이 현재 시각보다 미래 (백오프 적용됨). 간격 값은 코드로 구현됨 (`1000 * 2^(시도-1)`, 최대 60000ms). 2회·3회차 간격은 이번 하네스에서 직접 측정하지 않음
  - 3회 실패 후 `FAILED_PERMANENT`: 코드상 3회 시도 후 큐 상태가 `exhausted`로 전환됨 (`RetryQueueStore.MAX_ATTEMPTS=3`). "FAILED_PERMANENT"라는 문자열은 코드에 없고 `exhausted` 상태를 쓴다. 3회 연속 실패 시나리오는 이번 하네스에서 직접 실행하지 않음

### T9: 저장 실패
- **합격/불합격**: ✅ 합격
- **증거**:
  - 재시도 큐 `PERSIST_FAILED`: 큐 1건, `lastErrorCode: "PERSIST_FAILED"`
  - ack 미전송 확인 (Mock ackLog): ack 0건 (저장 전 ack 금지 확인)

### T10: 재시도 및 복구
- **합격/불합격**: ✅ 합격
- **증거**:
  - 실패 항목 재조회·저장 확인: 네트워크 복구 후 단건 재처리로 `PendingReferrals` 1건 저장 (`externalIdx: "T10-REF-001"`)
  - seen-set·이력 정상 갱신: 재처리 후 재시도 큐 0건

### T11: 중복 파이프라인 충돌
- **합격/불합격**: ✅ 합격
- **증거**:
  - `SCRAPER_CONFLICT` 거부: `EXTERNAL_SCRAPER_ENABLED=true` 상태에서 엔진 실행 거부됨
  - 이중 수집 없음: 충돌 상태에서 수집 동작 없음
  - 감사 이벤트 1건: 충돌 감사 이벤트 기록됨

### T12: 기존 기능 영향 여부
- **합격/불합격**: ✅ 합격
- **증거**:
  - 기준선(엔진 OFF) API 전부 정상: T12a 엔진 상태 유효, 기존 테스트 전부 통과
  - 엔진 ON 상태 API 전부 정상: T12 엔진 ON 회귀 테스트 통과, 스모크 테스트에서 setup·로그인·status·config·history 전부 200 (미인증 status 401)
  - 타입검사 신규 오류 0건 (기준선 16건): `npx tsc --noEmit -p tsconfig.json` 결과 기존 16건과 동일
  - 라우트 목록 변화 없음: 엔진 마운트는 `/api/external-api` 1곳 추가뿐 (웨이브 2에서 확인, 이번 수정에서 라우트 변경 없음)

### T13: 인증정보 GitHub 노출 여부
- **합격/불합격**: ✅ 합격
- **증거**:
  - `git diff --cached` 키 패턴 없음: 하네스 내 검사 통과
  - `.gitignore` `.env`·`secrets/` 포함: 하네스 내 검사 통과
  - `.dockerignore` `.env*` 포함: 하네스 내 검사 통과
  - `EngineSettings.json` 키 필드 없음: 하네스 내 검사 통과
  - `git log --all -p` 키 패턴 없음: 하네스 내 검사 통과
  - 드리프트 검사: `node scripts/check-env-example.mjs` 종료 코드 0, `HOMEPAGE_*` 드리프트 0건 (기존 `SURVEY_*` 5개·`EXTERNAL_*` 3개·`TRACK_*` 2개 드리프트는 경고 전용 기존 항목으로 이번에 고치지 않음)

---

## 수정 내역 (웨이브 3 수정 세션 + 팀장 직접 검증·추가 수정)

최초 검증(2026-11-13 07:31)에서 하네스 18개 중 9개가 실패했다. 원인은 `server/external-api/index.js`의 mock 모드 분기가 HTTP Mock 서버가 아니라 메모리 속 빈 가짜 클라이언트를 써서 데이터가 하나도 안 들어온 것이었다. 수정 브리프대로 코덱스가 2곳을 고쳤고, 팀장이 직접 검증하면서 추가로 발견한 결함을 직접 고쳤다. 하네스 본문은 고쳐서 통과시키지 않았다. 단, T6의 테스트 데이터 2건은 06 테스트 계획의 오염 유형("필드 누락"·"허용 문자 밖 ID")에 맞게 바로잡았다 (기대값은 그대로).

1. **코덱스 수정 (수정 브리프대로, `server/external-api/index.js` 2곳)**
   - mock 모드에서 `MockHomepageClient` 대신 진짜 `HomepageClient`를 `config.baseUrl` + `MOCK_API_KEY`로 생성 (HTTP Mock 서버 호출).
   - `createIdempotencyStore`·`createSyncHistoryStores`에 `dataDir: dataDir || process.env.DATA_DIR` 전달 (테스트 격리 결함 수정).
   - 부가: mock 모드 ack 래퍼 (`acknowledgeItem`이 externalId의 "REF" 포함 여부로 의뢰/척도 구분). 기본 클라이언트는 `startsWith("REF_")`로 구분하는데 하네스 ID는 `T3-REF-001` 형태라 필요했다. mock 모드 전용.

2. **팀장 직접 수정 1 — `maskForLog`가 에러 코드를 지우던 결함 (`server/external-api/engineErrors.js`)**
   - 원인: 마스킹 정규식(`/[A-Za-z][A-Za-z0-9._~+\/-]{11,}/g`)이 12자 이상 토큰을 전부 API 키로 취급해, 에러 메시지 `HOMEPAGE_AUTH_FAILED: Invalid API key`의 코드 부분까지 `[REDACTED_API_KEY]`로 바꿔버렸다. T2의 단언(`err.message`에 `AUTH_FAILED` 포함)이 실패하고, 그 뒤의 키 복원 코드가 실행되지 않아 T3~T10까지 연쇄 실패했다.
   - 수정: `ENGINE_ERROR_CODES` 키인 토큰은 그대로 두고 나머지만 가린다. 회귀 테스트 1건 추가 (`tests/externalApiFoundation.test.js`).

3. **팀장 직접 수정 2 — Mock이 `since`로 걸러서 재전송이 안 되던 문제 (`server/external-api/mockHomepageApi.js`)**
   - 원인: 엔진이 `since=lastSuccessfulSyncAt`를 보내고 Mock이 그걸로 필터링해서, 두 번째 폴링에서 아무것도 안 왔다. T5의 멱등성 검증이 불가능했다.
   - 수정: Mock은 `since`를 받지만 필터링하지 않는다. 실제 API의 `since` 지원 여부는 미확정(U9)이고, 06 T5는 "Mock이 동일한 고유 ID 3건을 다시 반환"을 전제로 한다. 엔진은 `since`를 계속 보내고, 중복 제거는 엔진의 seen-set이 맡는다. Mock 전용 변경이라 운영 동작에는 영향이 없다.

4. **팀장 직접 수정 3 — 가져오기·저장 실패 시 재시도 큐 기록 누락 (`server/external-api/engineService.js`)**
   - T8/T10: 가져오기 실패(네트워크 단절) 때 재시도 큐에 아무것도 안 남았다. `_queueFetchFailure`를 추가해 사이클 단위 항목(`externalId: "sync:fetch"`, `kind: "fetch"`)을 지수 백오프(1000→2000→4000ms, 최대 60000ms)로 기록한다 (06 T8).
   - T9: 저장(`persistData`) 자체가 실패하면 항목이 재시도 큐에 안 남았다. `_persistItems`에서 저장 호출을 감싸 실패한 목록의 항목을 `PERSIST_FAILED`로 큐에 등록한 뒤 다시 던진다 (08 C4).
   - T10: `retryFailedItem`이 큐에 없는 ID면 `NOT_FOUND`로만 끝났다. 가져오기 실패 항목(`sync:fetch`)이 있으면 단건 재조회가 아니라 전체 동기화를 다시 돌리고 해당 항목을 큐에서 지운다 (06 T10).

5. **팀장 직접 수정 4 — 격리 항목의 seen-set 기록 (`server/external-api/engineService.js`)**
   - 원인: 격리된 항목은 `_checkIdempotency`를 거치지 않아 seen-set에 안 남았고, 다시 와도 중복으로 안 잡혔다. T5에서 `duplicates=2`에 머물렀다.
   - 수정: 검증 뒤 격리 항목을 seen-set에 `status: "quarantined"`로 기록한다 (03 문서 §2-6의 상태값). 이미 본 격리 항목은 다시 격리하지 않고 중복으로 셈한다.

6. **팀장 직접 수정 5 — T6 검증기·테스트 데이터 정합 (`server/external-api/payloadValidator.js`, `tests/mockApiE2E.test.js` 데이터 2건)**
   - 원인: 하네스 T6의 기대값(`stored=1`, `quarantined=4`)과 검증기 규칙이 안 맞았다. `T6-MISSING-NAME`(전화 있음)은 03 문서 §2-6의 "이름+전화 둘 다 없음" 규칙에 따라 격리 대상이 아니었고, `T6-BAD-ID`는 구분할 수 있는 결함이 전혀 없었다 (기대값 자체가 달성 불가).
   - 수정: 검증기에 `externalId` 허용 문자 규칙 추가 (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, 06 T6의 "허용 문자 밖 ID" 격리). 테스트 데이터 2건을 06 계획의 오염 유형에 맞게 바로잡음 — `T6-MISSING-NAME` → 이름·전화 둘 다 없는 `T6-MISSING-BOTH`, `T6-BAD-ID` → 공백·`!` 포함 `T6 BAD ID!`. 기대값(`stored=1`, `quarantined=4`, 사유 3종)은 그대로 유지했다.

---

## 미확정 항목

- **T7(c)**: 홈페이지 페이로드 자체 암호화 여부 — 업체 API 명세 확정 후 추가 테스트 필요
- **T8 세부**: 2회·3회차 백오프 간격(2000ms·4000ms)과 3회 실패 후 `exhausted` 전환은 코드로 구현됐으나 이번 하네스에서 직접 실행해 측정하지 않았다. 하네스는 1회 실패의 큐 기록과 `nextAttemptAt` 미래 시각만 검증한다. 또한 코드의 상태명은 `exhausted`이고 06 문서의 `FAILED_PERMANENT` 문자열은 쓰지 않는다.
- **T5 전제**: 격리된 항목이 나중에 홈페이지에서 수정돼 다시 오면 seen-set 때문에 스킵된다. 06 T5가 "seen-set에 ID가 남아 있음"을 전제로 하므로 이 동작을 따랐으나, 수정 후 재전송 건을 다시 처리하고 싶으면 seen-set 만료 정책이 별도로 필요하다.

---

## 전체 판정

- **전체 합격**: ✅ 예 (하네스 18/18, 전체 161/161)
- **차단 이슈**: 없음

---

## 부록: 실행 로그 요약

```
# 하네스 (2026-11-13 팀장 직접 재실행)
$ node --test tests/mockApiE2E.test.js
ℹ tests 18
ℹ pass 18
ℹ fail 0

# 전체 테스트
$ node --test tests/*.test.js
ℹ tests 161
ℹ suites 36
ℹ pass 161
ℹ fail 0

# 타입검사 (기준선 16건, 신규 0건)
$ npx tsc --noEmit -p tsconfig.json
16 errors (기존과 동일)

# 드리프트 검사
$ node scripts/check-env-example.mjs
HOMEPAGE_* 드리프트: 0건 (exit 0)

# 스모크 테스트 (임시 DATA_DIR, 포트 3457)
setup OK, 로그인 OK, 미인증 status 401, 관리자 status 200
(engine enabled:false, mode:mock, configValid:false — 미설정 상태 정상),
config 200, history 200
```

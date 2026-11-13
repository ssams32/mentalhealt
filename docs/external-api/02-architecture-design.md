# 02. 전체 시스템 아키텍처 및 데이터 흐름

- 설계 기준: `origin/main 34c28d8` (브랜치 `external-api-engine`)
- 근거: 1단계 분석 보고서 3건 + 통합 보고서, 2단계 설계 문서 3건
  (`mentalhealt-api-engine-design-1-backend.md` / `-2-admin-page.md` / `-3-security-ops.md`)
- 상태: **설계 단계. 코드 변경 없음.** 이 문서들은 `docs/external-api/`에만 추가됐고,
  기존 프로그램 코드·데이터·라우트·스크레이퍼·인증 구조·Docker 운영 환경을 건드리지 않았다.
- 표기: **[사실]**은 코드에서 직접 확인한 것, **[설계]**는 이번 단계에서 정한 것,
  **[미확정]**은 홈페이지 API 명세가 없어 정할 수 없는 것.

---

## 1. 목적과 원칙

홈페이지(외부기관 의뢰접수·온라인 척도검사)에서 생기는 데이터를
NAS 의뢰관리시스템으로 자동 수신하는 전용 엔진을 만든다.
홈페이지 업체에는 API 개발을 별도로 요청할 예정이며, 주소·인증·형식·명세는 전부 미확정이다.
그래서 명세와 무관하게 동작하는 범용 엔진을 먼저 설계한다.

**가장 중요한 원칙: 운영 중인 시스템을 최대한 유지하고, 기존 기능을 재사용·확장한다.**
새로운 데이터 수신 경로를 무조건 추가하지 않는다.
기존 스크레이퍼를 그대로 복제한 별도 수집 파이프라인을 만들지 않는다.

---

## 2. 전체 아키텍처

```
홈페이지 서버
  │  HTTPS + 기관별 API 키
  ▼
NAS 내부 Node.js API 수신 엔진 (server/external-api/, 인프로세스)
  │  주기 폴링 (기본 OFF, 기본 60초) · 수동 동기화
  ▼
데이터 검증 및 중복 확인
  │  통과 / 격리 / 거부 구분, 항목 1건 실패가 전체를 멈추지 않음
  ▼
기존 저장 구조에 반영 (await persistData로 저장 성공 확인 후 다음 단계)
  │  의뢰 → PendingReferrals (직원 검토 큐) / 척도검사 → SurveySubmissions
  ▼
직원 검토 및 정식 등록 (기존 UI·기존 API — 엔진 범위 밖)
```

- **Pull 방식만 쓴다.** NAS가 외부 홈페이지 API에 HTTPS로 접속해 가져온다.
  NAS 포트포워딩 없음, NAS 외부 공개 없음, 외부에서 NAS로 직접 접속하는 구조 없음.
- **별도 중계 서버는 구축하지 않는다.** 홈페이지 업체의 서버 구조상 필요하면
  대안과 비용 요소를 별도로 보고한다 (현재로서는 필요성이 확인되지 않음).
- **단일 프로세스 전제.** 엔진은 `server.js`와 같은 프로세스 안에서 동작한다.
  스케줄러는 인프로세스 `setTimeout` 체인이다 (별도 워커·큐 서버 없음).

### 신규 모듈 구성 (`server/external-api/`, 12개 파일)

| 파일 | 역할 |
|---|---|
| `index.js` | 조립 (barrel). `createExternalApiEngine(deps)` |
| `engineConfig.js` | 설정 로드·검증 (env + `EngineSettings.json`, 키는 참조만) |
| `engineErrors.js` | typed 에러 + 로그용 마스킹 |
| `urlValidator.js` | baseUrl 검증 (surveyUrlValidator 규칙 일반화) |
| `homepageClient.js` | 홈페이지 API HTTP 클라이언트 (TrackAClient 패턴) |
| `pollScheduler.js` | 자동 수신 스케줄러 (surveyAutoImportScheduler 패턴) |
| `payloadValidator.js` | 수신 페이로드 검증·정규화 |
| `idempotencyStore.js` | 고유 접수 ID seen-set (`ExternalApiSeenIds.json`) |
| `intakeAdapter.js` | 홈페이지 형식 → 내부 형식 매핑 (의뢰·척도검사·연결 규칙) |
| `engineService.js` | 수신 사이클 오케스트레이터 (`runSyncCycle`) |
| `syncHistory.js` | 동기화 상태·이력·재시도 큐 저장소 (JSON 3종) |
| `engineRouter.js` | 관리자 전용 라우터 팩토리 (`createExternalApiRouter`) |

**`server.js` 변경은 4곳뿐이다** (import 1줄 + 엔진 생성 + 라우터 마운트 + 스케줄러 기동).
기존 라우트·함수는 건드리지 않는다. 마운트는 반드시 404 핸들러(`app.all('/api/*')`, 5295행)보다 앞에 둔다.
상세 인터페이스는 `03-module-specification.md` 참조.

---

## 3. 데이터 흐름

### 3-1. 의뢰 수신 흐름 (12단계)

1. 스케줄러 기동 (기본 OFF, 기동 60초 후 첫 사이클, 이후 60초 간격, in-progress면 스킵)
2. 스크레이퍼 충돌 검사 (`EXTERNAL_SCRAPER_ENABLED=true`이면 실행 거부, fail-closed)
3. 홈페이지 API 조회 (`fetchNewReferrals`, 타임아웃 10초, 401/403은 재시도 안 함, 429·5xx·타임아웃은 지수 백오프 최대 3회)
4. 페이로드 검증 (통과 / 격리 / 거부 — 항목 1건 실패가 전체를 멈추지 않음)
5. 멱등성 3단계 검사 (seen-set → `PendingReferrals` → `Referrals`)
6. 어댑터 매핑 (`PendingReferrals` 항목으로 변환, `source='homepage-api'`,
   `referralStatus='PENDING_STAFF_REVIEW'`, `missingFields` 계산)
7. 저장 (`await persistData('PendingReferrals')` — **저장 성공을 await로 확인한 뒤에만 다음 단계**)
8. seen-set 기록 (한 사이클 묶어 1회 쓰기)
9. 수신 완료 처리 (ack) — **저장이 완료된 항목에 대해서만** ack 전송. ack API가 없으면 스킵하고 기록.
10. 이력·상태 기록 (사이클 요약 + 에러 코드별 집계)
11. 직원 확인 (기존 `ReferralInbox` → `mapWebsiteReferralToInitialForm` → `ReferralEditor` — 엔진 범위 밖)
12. 정식 등록 (기존 `POST /api/referrals`, `Idempotency-Key` + 중복 409 검사 경유 — 엔진 범위 밖)

**자동 등록은 v1에서 하지 않는다.** UI 필수 12개가 전부 있어도 자동 등록하지 않고,
전부 직원 검토 큐로 간다. 자동 등록은 별도 jun 결정 사항이다.

### 3-2. 척도검사 수신 흐름

1~5단계는 의뢰와 동일 (조회는 `fetchNewAssessments`, 검증은 `validateAssessmentItem`).
6. 어댑터 매핑 (`SurveySubmissions` 레코드로 변환. `severity`는 홈페이지 판정 그대로,
   없으면 `null` — **총점으로 심각도를 추측하지 않는다**).
7. 대상자 연결 판정 (정확 일치만 연결, 후보는 자동 연결 안 함, 불일치는 미연결 저장 — `05-data-mapping.md`).
8. 저장 (`await persistData('SurveySubmissions')` — 저장 확인 후 ack).
9. ack → 10. 이력 기록.
11. 직원 확인 (기존 `SurveyManagementPage` 마스킹 목록·복호화 상세·의뢰 초안 흐름 — 엔진 범위 밖).

### 3-3. 실패·재처리 흐름

- 통신 실패: 사이클 내 지수 백오프 최대 3회 → 그래도 실패하면 사이클 FAILED 기록 + 다음 주기 재시도.
  연속 5회 실패하면 감사 이벤트 1건 (스케줄러는 멈추지 않음 — 장애 복구 후 자동 재개).
- 항목 저장 실패: 재시도 큐에 추가 → 다음 사이클 시작 시 `nextAttemptAt`이 지난 항목부터 재처리
  (단건 재조회 API가 있으면 다시 가져오고, 없으면 큐 저장 페이로드로 재처리 — **[미확정]**).
  재시도 3회 소진 시 `FAILED_PERMANENT`, 수동 재처리만 가능 (자동 삭제 안 함).
- ack 실패: 저장은 이미 완료됨. 재시도 큐에 ack만 다시 보낼 항목으로 추가.

---

## 4. 기존 기능 재사용 범위

| 기존 구조 | 재사용 방식 | 버리는 것 / 바꾸는 것 |
|---|---|---|
| `PendingReferrals` | 외부 의뢰 임시 접수·직원 검토 흐름 그대로 재사용. 엔진은 이 테이블에만 쓴다 | 바로 `Referrals`에 넣지 않음 |
| `SurveySubmissions` | 온라인 척도검사 데이터 저장 그대로 재사용. 새 저장 체계 추가 안 함 | 없음 |
| `WebsiteSyncMetadata` | 상태 파일 패턴(단일 객체)만 참고 | 엔진 상태는 전용 파일 `ExternalApiSyncState.json`으로 분리 (아래 §6 결정 2번) |
| `ScrapedExternalIds` | 멱등성 패턴(seen-set)만 참고 | seen-set을 이어받지 않고 전용 파일 `ExternalApiSeenIds.json`으로 분리 (아래 §6 결정 1번) |
| `referralMutationEngine` | 정식 등록 경로에서 그대로 사용 (엔진이 직접 호출하지 않음 — 직원이 UI로 등록할 때 탄다) | 엔진이 직접 쓰지 않음 |
| `trackAClient.js` | HTTP 클라이언트 뼈대 (타임아웃·ID 살균·typed 에러·지문 로그) | 공용 Bearer 시크릿 + RSA 구조는 기관별 API 키로 교체 |
| `surveyUrlValidator.js` | URL 검증 규칙 7개 그대로 | 에러 메시지 변수명만 홈페이지용으로 변경 |
| `surveyAutoImportScheduler.js` | 기본 OFF·기동 지연 60초·in-progress 가드·`unref()`·`getStatus()` | 주기 단위를 분→초로 변경 |
| 기존 인증·관리자 권한 미들웨어 | `requireAuth`·`requireAdmin`을 라우터 팩토리에 주입 (직접 import 안 함 — survey 라우터 선례) | `x-user-role` 헤더 신뢰 패턴은 절대 재사용하지 않음 |
| 기존 데이터 저장·원자적 파일 교체 | `getData`/`persistData` 경유. 저장 성공은 `await`로 확인 | `saveData`(fire-and-forget)는 엔진에서 사용하지 않음 |
| 기존 감사 해시 체인 (`AuditRepository`) | 보안 사건(설정 변경·수동 동기화·키 지문 변경 등)만 기록 | 주기적 폴링 성공·운영 이력은 전용 파일로 분리 (아래 §6 결정 3번) |
| 기존 감사 페이로드 정책 | PII 금지 키 목록을 엔진 로그·감사 기록에도 그대로 적용 | 엔진 전용 금지 키(키 본문·`apiKey`·`Authorization`) 추가 |
| `retryBackoffPolicy.js` | `computeRetryDelay` 그대로 재사용 (1000ms~60000ms, 지터 0.2) | `classifyError`는 엔진 에러 코드표로 다시 매핑 |

---

## 5. 관리자 화면 위치 — **확정: 신규 페이지 (옵션 A)**

2026-11-12 19:59 jun 선택으로 신규 페이지로 확정됐다.
(19:46 jun 결정 "새롭게 만들어 관리자 페이지 만들고"와 19:50 의뢰서 §3-8 "데이터 관리 안 섹션"이
갈렸으나, jun이 신규 페이지를 골랐다. 옵션 B는 폐기한다.)

| 옵션 | 근거 | 영향 |
|---|---|---|
| **A. 신규 페이지** (별도 사이드바 메뉴 "홈페이지 API 연동") — **확정** | 2026-11-12 19:46 jun 결정 + 19:59 최종 선택 | 새 `Page` 값 `'externalApi'`, 컴포넌트 `components/externalApi/ExternalApiAdminPage.tsx`, 사이드바 메뉴 1개 추가, `renderPage` 403 가드. 화면 7개 섹션 설계 완료 (`03-module-specification.md` §4 참조) |
| B. '데이터 관리' 페이지 안 섹션 (새 사이드바 메뉴 없음) — 폐기 | 2026-11-12 19:50 의뢰서 §3-8 | — |

**백엔드는 위치와 무관하게 동일하게 동작한다.**
라우터는 `/api/external-api/*`로 독립돼 있고, 화면이 새 페이지가 되든 섹션이 되든 같은 API를 쓴다.
jun이 신규 페이지(옵션 A)로 확정했으므로 이 문서는 옵션 A로 적혀 있다.

---

## 6. 기존 충돌 7건 (C1~C7) 처리

| 충돌 | 내용 | 처리 (설계) |
|---|---|---|
| C1 스크레이퍼와 중복 수집 | 스크레이퍼가 이미 같은 홈페이지를 긁고 있음 | 스크레이퍼는 OFF 유지가 전제. 엔진은 `EXTERNAL_SCRAPER_ENABLED=true`이면 실행 거부(충돌 가드, fail-closed). seen-set은 별도 파일로 분리해 이력을 섞지 않음. 스크레이퍼 종료 시점은 API 엔진 검증 후 별도 결정 |
| C2 라우트 충돌 | `/api/website-referrals/*`가 이미 있음 | 신규 네임스페이스 `/api/external-api/*`로 분리. 기존 summary/sync/mark-seen은 건드리지 않음 |
| C3 Track A/B 설문 API와 역할 분리 | Track A/B가 이미 외부 API pull 패턴을 갖고 있음 | 전송·검증·스케줄러 패턴만 재사용. 인증은 기관별 API 키로 분리. 설문 자동 동기화와 신규 API 수신은 **별도 채널·별도 seen-set**으로 동작하고, 저장 테이블(`SurveySubmissions`)만 공유. 한쪽이 고장 나도 다른 쪽은 동작 |
| C4 저장 성공 확인 | `saveData`는 fire-and-forget | 엔진은 `await persistData(...)`만 사용. 저장 실패 시 재시도 큐로 이동. ack는 저장 성공 후에만 전송 |
| C5 홈페이지 서버 요청 제한 | 1분 폴링은 기존(설문 5분·스크레이퍼 30분)보다 공격적 | 주기 하한 30초·기본 60초. 업체 rate limit 확인 후 확정 (명세 요청 07 문서 12번). 429 응답 시 `Retry-After` 준수 + 지수 백오프 |
| C6 API 키 저장 위치 | 키를 설정 JSON에 넣으면 R1과 같은 함정 | 키는 env/Docker Secrets로만. 설정 JSON에는 주소·기관ID·주기·ON/OFF만. 상세는 `04-security-design.md` |
| C7 감사로그 재사용 여부 | 해시 체인 감사 로그가 이미 있음 | 둘 다 쓴다. 보안 사건은 해시 체인, 운영 이력·상태·재시도 큐는 전용 파일 3종 |

---

## 7. 미확정 항목 (명세가 오면 정할 것 — 요약)

총 18개 (전체 목록은 `03-module-specification.md` §6). 바뀌는 곳은 딱 3곳뿐이다.

| 바뀌는 곳 | 명세가 오면 정해지는 것 |
|---|---|
| `homepageClient`의 엔드포인트 경로 상수 | 실제 API 경로·쿼리·페이지네이션 방식 |
| `intakeAdapter`의 매핑표 | 홈페이지 필드명 → 내부 필드명 대응, 필수 필드·열거형 값 |
| `engineConfig`의 인증 설정 | 인증 방식·헤더명·기관 식별값 전달 위치 |
| 그 외 (스케줄러·멱등성·이력·라우터) | 바꾸지 않는다. 명세와 무관하게 동작한다 |

홈페이지 업체에 요청할 명세는 `07-homepage-vendor-api-spec.md` 참조.

# 08. 백엔드, 관리자 화면, 테스트, 실제 연동의 단계별 개발 계획

- 설계 기준: `origin/main 34c28d8` (브랜치 `external-api-engine`)
- 근거: 2단계 설계 문서 3건 + 의뢰서 단계 구분 (1 분석 → 2 설계 → 3 백엔드 → 4 관리자 화면 → 5 Mock 테스트)
- 상태: **설계 단계. 코드 변경 없음. 3단계 백엔드 구현은 jun 승인 후 시작한다.**

---

## 1. 전체 아키텍처 요약

- 홈페이지 서버 → HTTPS 인증 API → NAS 내부 Node.js API 수신 엔진 (Pull 방식, 기본 OFF·기본 60초)
  → 데이터 검증 및 중복 확인 → 기존 저장 구조에 반영 (`PendingReferrals`·`SurveySubmissions`)
  → 직원 검토 및 정식 등록 (기존 UI·기존 API).
- 신규 모듈: `server/external-api/` 12개 파일. `server.js` 변경은 4곳뿐이다.
- NAS 포트포워딩 없음, NAS 외부 공개 없음, 별도 중계 서버 없음, 단일 프로세스 전제.
- 자동 등록은 v1에서 하지 않는다 (전부 직원 검토 큐).
- 저장 성공 이후에만 홈페이지에 수신 완료 처리한다 (`await persistData` 확인이 전제 조건).

---

## 2. 기존 기능 재사용 범위

| 재사용 | 범위 |
|---|---|
| `PendingReferrals` | 외부 의뢰 임시 접수·직원 검토 흐름 그대로 |
| `SurveySubmissions` | 온라인 척도검사 데이터 저장 그대로 (새 저장 체계 추가 안 함) |
| `trackAClient.js`·`surveyUrlValidator.js`·`surveyAutoImportScheduler.js` | 전송·검증·스케줄러 패턴 (인증은 기관별 API 키로 교체) |
| `retryBackoffPolicy.js`·`auditRepository.js`·`auditPayloadPolicy.js` | 재시도·감사 해시 체인·PII 금지 키 목록 |
| `requireAuth`·`requireAdmin` | 라우터 팩토리에 주입 |
| `getData`/`persistData` | 저장. `saveData`(fire-and-forget)는 엔진에서 사용 금지 |
| `ReferralInbox`·`mapWebsiteReferralToInitialForm`·`ReferralEditor`·`POST /api/referrals` | 직원 확인·정식 등록 흐름 (엔진 범위 밖) |
| `SurveyManagementPage` | 척도검사 확인·의뢰 초안 흐름 (엔진 범위 밖) |
| `DataManagementPage`·`SurveyManagementPage` '시스템' 탭 | 관리자 화면 구성 모델 |

상세는 `02-architecture-design.md` §4 참조.

---

## 3. 신규 개발 모듈 목록

| 모듈 | 파일 | 난이도 |
|---|---|---|
| 조립 | `server/external-api/index.js` | 하 |
| 설정 | `engineConfig.js` | 중 |
| 에러·마스킹 | `engineErrors.js` | 하 |
| URL 검증 | `urlValidator.js` | 하 (surveyUrlValidator 재사용) |
| HTTP 클라이언트 | `homepageClient.js` | 중 |
| 스케줄러 | `pollScheduler.js` | 하 (surveyAutoImportScheduler 재사용) |
| 페이로드 검증 | `payloadValidator.js` | 중 |
| 멱등성 | `idempotencyStore.js` | 중 |
| 어댑터 | `intakeAdapter.js` | 중 (명세 의존도가 가장 높음) |
| 사이클 지휘 | `engineService.js` | 중 |
| 이력·큐 | `syncHistory.js` | 중 |
| 라우터 | `engineRouter.js` | 중 |
| 관리자 페이지 | `components/externalApi/ExternalApiAdminPage.tsx` (+ `types.ts`·`constants.ts`·`Sidebar.tsx`·`App.tsx`·`apiClient.ts` 변경) | 중 |
| Mock API | `server/external-api/mockHomepageApi.js` | 하 |
| 드리프트 검사 | `scripts/check-env-example.mjs` | 하 |

상세 인터페이스는 `03-module-specification.md` 참조.

---

## 4. 데이터 흐름 (요약)

폴링(기본 OFF·60초) → 스크레이퍼 충돌 검사 → 홈페이지 조회 → 검증(통과/격리/거부)
→ 멱등성 3단계(seen-set → `PendingReferrals` → `Referrals`)
→ 어댑터 매핑 → `await persistData` 저장 확인 → seen-set 기록 → ack(저장 완료 후만)
→ 이력 기록 → 직원 확인 → 기존 `POST /api/referrals`로 정식 등록.
상세는 `02-architecture-design.md` §3, 매핑표는 `05-data-mapping.md` 참조.

---

## 5. 보안 설계 (요약)

- 기관별 API 키는 env/Docker Secrets로만 관리. 설정 JSON·프론트·소스·GitHub·로그에 키 없음.
  키 지문(SHA-256 앞 8자)만 상태·감사 기록에 표시.
- 엔진 라우터 12개 엔드포인트 전부 `requireAdmin`. `req.auth`만 신뢰 (`x-user-role` 헤더 금지).
  상태 변경 엔드포인트에는 `verifyStateChangingOrigin` 적용.
- 로그 마스킹: 허용 목록 방식. 고유 접수 ID·기관 ID·상태 코드·건수·지문 앞 8자만 허용.
  이름·전화·주민번호·검사 응답 원문·키 본문·응답 원문 금지.
- HTTPS 강제, URL 검증, 응답 크기 상한(폴링 5MB·건당 100KB), 자체 속도 제한(연결 테스트 분당 5회·수동 동기화 분당 2회).
- R1·R2·R3은 신규 API 개발과 별도의 보안 개선 작업으로 분리 (이번 단계에서 수정 안 함).
  R2 실서버 재현 검증 방법, 중복 API 11개 삭제 여부 분석은 `04-security-design.md` §4 참조.
- 데이터 전송 암호화와 API 인증은 별개로 다룬다. 기존 JSON 저장 데이터 암호화는 별도 과제.

---

## 6. 기존 기능과의 충돌 방지 방안

| 충돌 | 방지 방안 |
|---|---|
| C1 스크레이퍼와 중복 수집 | 스크레이퍼 OFF 유지 전제 + 엔진 충돌 가드(`EXTERNAL_SCRAPER_ENABLED=true`이면 실행 거부) + seen-set 별도 파일 분리 |
| C2 라우트 충돌 | 신규 네임스페이스 `/api/external-api/*`로 분리. 기존 `/api/website-referrals/*` 건드리지 않음 |
| C3 Track A/B와 역할 분리 | 전송·검증·스케줄러 패턴만 재사용. 인증은 기관별 키로 분리. 채널별 seen-set 분리, 저장 테이블만 공유 |
| C4 저장 성공 확인 | `await persistData`만 사용. 저장 실패 시 재시도 큐. ack는 저장 성공 후에만 전송 |
| C5 요청 제한 | 주기 하한 30초·기본 60초. 429 시 `Retry-After` 준수 + 지수 백오프. 업체 rate limit 확인 후 확정 |
| C6 키 저장 위치 | 키는 env/Docker Secrets로만. 설정 JSON에는 비(非)키 설정만 |
| C7 감사로그 재사용 여부 | 둘 다 쓴다. 보안 사건은 해시 체인, 운영 이력·상태·재시도 큐는 전용 파일 3종 |

---

## 7. 개발 결정 사항 8건 (권장안·이유·예상 영향·대안)

### 결정 1. 기존 `ScrapedExternalIds`를 재사용할지 신규 이력 파일을 분리할지

- **권장안: 신규 파일 `ExternalApiSeenIds.json`으로 분리한다.**
- 이유: (1) 스크레이퍼 seen-set은 스크레이퍼 수명주기에 묶여 있고, 스크레이퍼 제거 시 함께 사라질 수 있다.
  (2) 스크레이퍼 ID(`ext_...`)와 홈페이지 API의 안정적 제출 ID는 다른 키 체계일 수 있다 (미확정).
  (3) 엔진의 seen-set은 ack 상태까지 추적해야 하는데, 스크레이퍼 구조에는 ack 상태가 없다.
- 예상 영향: 파일 1개 추가. 전환기에 스크레이퍼 seen-set을 가져오는 기능은 3단계 범위에 두지 않는다.
- 대안: `WebsiteSyncMetadata.seenExternalIds`를 이어받는다 — 이력이 섞여 API 재전송분이 잘못 스킵될 수 있다.

### 결정 2. 기존 `WebsiteSyncMetadata`를 확장할지 신규 동기화 메타데이터를 만들지

- **권장안: 신규 파일 3종으로 만든다** (`ExternalApiSyncState.json`·`ExternalApiSyncHistory.json`·`ExternalApiRetryQueue.json`).
- 이유: 상태(덮어쓰기)·이력(append·조회)·재시도 큐(갱신·삭제)의 쓰기 패턴이 달라 한 파일로는 안 된다.
  기존 `WebsiteSyncMetadata`는 스크레이퍼 채널의 상태라 섞으면 채널 구분이 흐려진다.
- 예상 영향: 파일 3개 추가. `getData`/`persistData` 경유로 기존 저장 방식을 따른다.
- 대안: `WebsiteSyncMetadata`를 확장한다 — 스크레이퍼와 엔진의 상태가 섞이고, 파일이 비대해진다.

### 결정 3. 기존 감사로그를 재사용할지 엔진 전용 이력 파일을 만들지

- **권장안: 둘 다 쓴다 (용도를 나눈다).**
- 이유: 보안 사건(설정 변경·수동 동기화·키 지문 변경 등)은 변조 증거가 필요하고 건수가 적어 해시 체인이 맞는다.
  운영 이력(주기별 수신 기록·재시도 큐)은 건수가 많고 조회·정리가 필요해 해시 체인(append-only)에 맞지 않는다.
- 예상 영향: 감사 이벤트 7종 정의 + 전용 파일 3종. 감사 기록 실패가 폴링을 막지 않게 분리한다.
- 대안: 한쪽만 쓴다 — 해시 체인만 쓰면 운영 조회가 안 되고, 전용 파일만 쓰면 보안 사건의 변조 증거가 없다.

### 결정 4. 의뢰와 척도검사 데이터를 어떤 식별자로 연결할지

- **권장안: 정확 일치만 자동 연결한다** (`sourceSubmissionId`/`sourceSurveyId` 또는 `externalIdx` 정확 일치).
  이름+연락처+나이 일치 + 접수일 30일 이내는 후보(`candidate`)로만 표시하고 자동 연결하지 않는다.
  그 외는 미연결로 저장한다.
- 이유: 임의 연결은 다른 사람의 검사 결과를 잘못 붙이는 사고로 이어진다. 후보는 직원이 확인한다.
- 예상 영향: 미연결·후보 건은 직원 수동 연결이 필요하다. 연결 UI는 기존 설문→의뢰 초안 흐름을 재사용한다.
- 대안: 후보까지 자동 연결한다 — 오연결 위험이 있다. / 이름+연락처만으로 연결한다 — 동명이인 오연결 위험이 있다.

### 결정 5. 기존 설문 자동 동기화와 신규 API 수신을 어떻게 통합할지

- **권장안: 채널은 분리하고, 저장 테이블만 공유한다.**
- 이유: 설문 자동 동기화(Track A/B)와 신규 API 수신은 별도 채널·별도 seen-set으로 동작하고,
  저장 테이블(`SurveySubmissions`)만 공유한다. 한쪽이 고장 나도 다른 쪽은 동작한다.
  최종 중복 방지는 저장 전 검사(`sourceSubmissionId`·`externalIdx` 조회)가 맡는다.
- 예상 영향: 화면은 새로 만들지 않는다. 저장된 레코드는 기존 `SurveyManagementPage` 흐름을 그대로 탄다.
- 대안: 파이프라인을 하나로 합친다 — 한쪽 장애가 다른 쪽까지 멈추고, 채널 구분이 사라진다.

### 결정 6. 기존 스크레이퍼의 향후 종료 시점

- **권장안: API 엔진 검증 후 별도 결정한다. 지금은 OFF 유지를 전제로 하고, 이번 단계에서 수정·삭제하지 않는다.**
- 이유: 스크레이퍼는 2026-10-21 jun 지시로 OFF 상태다 (홈페이지 봇 차단으로 수집 불가 + 타 센터 배포 시 타 기관 의뢰가 섞일 위험).
  API 엔진이 실제 홈페이지 데이터 수신을 검증하기 전에는 스크레이퍼를 건드릴 이유가 없다.
- 예상 영향: 없음 (이번 단계). 전환 시에는 엔진 충돌 가드를 해제하고 스크레이퍼를 제거하는 별도 작업이 필요하다.
- 대안: 지금 바로 삭제한다 — API 엔진이 아직 검증되지 않은 상태에서 기존 수집 경로를 없애는 것은 위험하다.

### 결정 7. 신규 API 엔진의 설정값을 어디에 저장할지

- **권장안: 비(非)키 설정은 `EngineSettings.json`, 모드·키는 env 전용이다.**
- 이유: 주소·기관ID·주기·ON/OFF는 관리자가 화면에서 바꿀 수 있어야 해서 JSON에 둔다.
  모드는 기동 전 결정 사항(데이터 디렉터리 분리와 직결)이라 env 전용이다.
  키는 비밀이라 env/Secrets 전용이다. env는 최초 시드 역할만 하고, JSON이 생긴 뒤로는 JSON이 진실 원본이다
  (화면에서 바꾼 값이 컨테이너 재시작 때 env로 되돌아가는 사고 방지).
- 예상 영향: `EngineSettings.json` 신규 파일 1개. 설정 저장 시 키 관련 필드가 있으면 거부한다 (allowlist 검증).
- 대안: 전부 env로 둔다 — 화면에서 바꿀 수 없어 운영이 불편하다. / 전부 JSON으로 둔다 — 키가 평문으로 들어가는 R1 함정이 생긴다.

### 결정 8. 기관별 API 키를 Docker Secrets와 환경변수 중 어떤 방식으로 운영할지

- **권장안: Docker Secrets 파일을 1순위, 환경변수 직접 입력을 2순위(폴백)로 한다.**
- 이유: Secrets 파일은 compose 파일에 키 본문이 남지 않고, 파일 권한(0600)으로 접근을 통제할 수 있다.
  env 직접 입력은 Docker Secrets를 쓸 수 없는 설치(일반 PC Docker 등)에서만 쓴다.
  파일 경로가 있으면 env 직접 입력보다 우선한다.
- 예상 영향: NAS에 Secrets 파일 경로(`/volume2/docker/imhc/secrets/homepage_api_key`)를 만들고
  compose에 `secrets:` 블록을 추가한다. 키 교체 시 컨테이너 재시작이 필요하다.
- 대안: env 직접 입력만 쓴다 — compose 파일·`.env`에 키 본문이 남아 유출 경로가 늘어난다.

---

## 8. 단계별 개발 계획

### 3단계: 백엔드 엔진 구현 (jun 승인 후)

- 순서: `engineErrors`·`urlValidator` → `engineConfig` → `homepageClient` → `payloadValidator` →
  `idempotencyStore`·`syncHistory` → `intakeAdapter` → `engineService` → `pollScheduler` →
  `engineRouter` → `index.js` 조립 → `server.js` 마운트 4곳.
- 난이도: 중. 가장 명세 의존도가 높은 부분은 `intakeAdapter` 매핑표와 `homepageClient` 경로 상수다.
  명세가 오면 이 두 곳만 바꾸면 된다.
- 검수 기준: 타입검사 신규 오류 0건 (기존 16건 기준선), Mock 테스트 T1~T13 중 백엔드 관련 항목 통과,
  기존 라우트 목록 변경 없음, 코드 변경 범위가 설계 문서와 일치함.
- **주의: 설계가 끝났다고 임의로 3단계를 시작하지 않는다. jun 승인이 필요하다.**

### 4단계: 관리자 화면 구현

- 순서: `types.ts` 타입 5개 → `constants.ts` `PAGES_CONFIG` → `Sidebar.tsx` 메뉴 →
  `App.tsx` `renderPage` + 403 가드 → `apiClient.ts` 메서드 9개 → `ExternalApiAdminPage.tsx` 7개 섹션.
- 난이도: 중. 화면 위치는 02 문서 §5의 결정(신규 페이지 vs 데이터 관리 안 섹션)에 따라 달라진다.
- 검수 기준: 의뢰서 6절 항목 10개가 화면에 빠짐없이 들어감, 권한 이중 방어(메뉴 숨김 + 진입 가드) 동작,
  키 값·일부·길이 전부 표시 안 됨, 오프라인 상태에서 동작 버튼 비활성화.

### 5단계: Mock API 테스트

- 순서: T12 기준선 → T1~T6 → T7·T8·T9·T10·T11·T13 → T12 회귀 확인 → 결과 보고서 작성.
- 상세는 `06-test-plan.md` 참조. 테스트 데이터는 전부 합성 데이터. 실제 운영 개인정보 사용 금지.
- 난이도: 하~중. Mock 서버(`mockHomepageApi.js`)는 3단계에서 함께 만든다.

### 실제 연동 (업체 명세 확정 후)

- 순서: 업체 명세 수령 → `homepageClient` 경로 상수 + `intakeAdapter` 매핑표 + `engineConfig` 인증 설정 교체 →
  staging 모드 + 스테이징 키로 연결 테스트 → 수동 동기화 1회 (합성 데이터) →
  폴링 ON (주기 60초) → 1주간 운영 관찰 → 스크레이퍼 전환 여부 결정 (별도 jun 결정).
- 난이도: 중. 명세 의존도가 가장 높은 단계다.
- 전제: 업체 명세 요청서(`07-homepage-vendor-api-spec.md`)에 대한 답변이 와야 한다.
  답변이 오기 전에는 실제 연동을 시작할 수 없다.

---

## 9. 해결해야 할 미확정 사항

- 홈페이지 API 전부 (주소·인증 방식·엔드포인트·JSON 스키마·필수 필드·고유 ID 형식·페이지네이션·
  에러 형식·속도 제한·ack API 유무·날짜 형식 — 총 18개, `03-module-specification.md` §6).
- 관리자 화면 위치 — **확정: 신규 페이지** (2026-11-12 19:59 jun 선택).
- 인증키 화면 입력 여부 (03 문서 §3-3 — 권장안은 화면 입력 없음).
- `source` 채널 값 (`'homepage-api'` vs 기존 `'website'` 재사용 — 팀장 최종 결정).
- 배포 타이밍 (Watchtower 자정 vs 문서 "약 5분" — 롤아웃 전 확인 절차는 04 문서 §8-4 참조).
- `BudgetHierarchy.json`의 "청년 치료비 지원" 세목 존재 여부 (엔진과 무관하나 1단계 미확정 사항으로 이관 — NAS 라이브 데이터 확인 필요).

---

## 10. 팀장 승인 및 결정이 필요한 항목

**실제 코드 개발에 착수하기 전에 반드시 승인받아야 하는 사항:**

1. **2단계 설계 승인** — 이 문서 7건(`02`~`08`) 전체에 대한 승인.
2. **관리자 화면 위치** — **확정: 신규 페이지 (옵션 A)** (2026-11-12 19:59 jun 선택).
3. **인증키 화면 입력 여부** — 화면 입력 없음(권장안) vs 화면에서 등록·변경.
4. **3단계 백엔드 구현 착수 승인** — 설계 승인과 별개로, 구현 시작 전에 다시 확인한다.
5. **업체 명세 요청 여부** — `07-homepage-vendor-api-spec.md`를 홈페이지 업체에 전달할지.
6. **R2 실서버 재현 검증** — 스테이징에서 실제로 관리자 행세가 되는지 확인 후 조치 방향 결정.
7. **중복 API 11개 삭제 여부** — 이번 단계에서는 삭제하지 않는다. 삭제는 별도 작업으로 jun 승인 후.
8. **스크레이퍼 전환 계획** — API 엔진 검증 후 별도 결정. 이번 단계에서는 OFF 유지.

**설계 단계에서 정하지 않고 남겨두는 사항:**
자동 등록 범위 (v1에서는 자동 등록 안 함 — 별도 jun 결정 사항).
at-rest 암호화 도입 (별도 보안 개선 과제). 전역 helmet 도입 (별도 결정).
전역 로그인 속도 제한 도입 (별도 결정). 기존 드리프트 28개 정리 (별도 과제).

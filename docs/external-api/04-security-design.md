# 04. API 인증, 기관별 키 관리, 개인정보 보호 설계

- 설계 기준: `origin/main 34c28d8` (브랜치 `external-api-engine`)
- 근거: 2단계 설계 문서 3번 (보안·설정·운영) + 1단계 분석 보고서 (리스크 R1~R16, 충돌 C1~C7)
- 상태: **설계 단계. 코드 변경 없음.** 이 단계에서 기존 보안 취약점을 수정하지 않는다.
  R1·R2·R3은 신규 API 개발과 별도의 보안 개선 작업으로 분리한다 (아래 §4 참조).
- 표기: **[사실]**은 코드에서 직접 확인한 것, **[설계 결정]**은 이 문서가 정하는 것,
  **[미확정]**은 홈페이지 API 명세가 없어 정할 수 없는 것.

---

## 1. 위협 모델 (신뢰 경계 4개)

| 신뢰 경계 | 넘어오는 것 | 자산 | 주요 위협 |
|---|---|---|---|
| 홈페이지 API (외부, 신뢰하지 않음) | 의뢰·척도검사 JSON | 개인정보, 시스템 무결성 | 위조·변조 응답, 과대 페이로드, 주소 조작(SSRF 유사 악용) |
| 관리자 브라우저 (인증됨, 그러나 입력은 검증) | 설정 변경, 연결 테스트, 수동 동기화 | API 키, 관리자 권한 | 권한 상승(R2 패턴), CSRF, 키 노출 |
| NAS 파일시스템 (env·Secrets·JSON) | 키 파일, 설정 JSON, 데이터 JSON | API 키, 개인정보, 백업 | 파일 유출 시 평문 노출(R1·R7), 권한 설정 오류 |
| 로그·감사 기록 (Docker 로그, AuditEntries) | 상태·에러 기록 | 개인정보, 키 | 로그에 실명·키 노출(R6) |

---

## 2. 기관별 API 키 관리

### 2-1. 구조 — 키가 어디에 있고 어디에 없는지

```
[홈페이지 업체] --(발급, 기관별 키)--> [NAS 운영자]
                                          |
                    +---------------------+---------------------+
                    | (택 1)              | (택 2, 권장)        |
                    | 환경변수            | Docker Secrets 파일 |
                    | HOMEPAGE_API_KEY    | HOMEPAGE_API_KEY_   |
                    | (compose env)       | FILE=/run/secrets/  |
                    |                     | homepage_api_key    |
                    +----------+----------+----------+----------+
                               |                     |
                               v                     v
                    [engineConfig: 기동 시 1회 로드·검증]
                               |
                    [메모리에만 보관: homepageClient가 요청 시 사용]
                               |
              +--------------------------------------------------+
              | 절대 가지 않는 곳 (설계상 금지)                    |
              | EngineSettings.json / Settings.json / 프론트엔드  |
              | localStorage / 소스코드 / GitHub / .env.example  |
              | Docker 이미지 / 로그 / 감사 기록 / 에러 응답       |
              +--------------------------------------------------+
```

**키 입력 경로 2가지 (우선순위 포함):**
- 1순위 — Docker Secrets 파일 (`HOMEPAGE_API_KEY_FILE`, 기본값 `/run/secrets/homepage_api_key`).
  파일에 키 원문을 두고 경로만 env로 지정. survey 선례(`SURVEY_PRIVATE_KEY_PATH`)와 동일.
- 2순위 — 환경변수 직접 입력 (`HOMEPAGE_API_KEY`). Docker Secrets를 쓸 수 없는 설치(일반 PC Docker 등)용 폴백.
- 두 경로 모두 없으면 production/staging 모드에서는 기동 시 fail-closed로 처리한다
  (엔진 비활성화 + 상태 API `misconfigured` 반환 + 기동 로그에 키 누락 명시 — 키 값 자체는 로그에 남기지 않음).
  mock 모드에서는 합성 키(`mock-homepage-key`, 코드 내 상수, 실제 통신 없음)를 허용한다.
- **키는 기동 시 1회만 읽는다.** 실행 중 env·파일 변경은 반영되지 않는다.
  키 변경·재발급 시 컨테이너 재시작이 필요하다 (survey 키 제공자도 같은 방식).

**키 검증 규칙 (기동 시, `engineConfig`에서 수행):**
존재(파일 또는 env 중 하나에 값) → 앞뒤 공백 제거 후 비어 있지 않음 → 최소 16자
(**[미확정]** 업체 키 형식이 미확정이므로 16자는 하한 가드) → 공백·개행·따옴표 없음 →
`http://`·`https://`·`Bearer ` 같은 접두사 없음 (키 본문만 저장하는 규칙).
형식 검증까지만 기동 시 수행한다. 실제 유효성(키가 진짜로 통하는지)은 기동 시 확인하지 않고,
관리자 페이지의 "연결 테스트" 또는 첫 폴링에서 확인한다
(기동 시 프로브를 하면 홈페이지 장애가 서버 기동을 막을 수 있기 때문).

**키 지문 (fingerprint):** 키 본문은 어디에도 표시하지 않는다. 대신 SHA-256 해시 앞 8자를 지문으로 만들어
상태·감사 기록에 쓴다 (예: `9f2c41ab…`). 지문만으로는 키를 복원할 수 없다.
상태 API가 반환하는 키 정보는 이것뿐이다:
`{ configured: true, source: "file" | "env", fingerprint: "9f2c41ab…", loadedAt: "<ISO 시각>" }`.

**키 변경·재발급 절차 (운영 절차 — 코드가 아니라 순서):**
1. 업체에서 새 키 발급 (구 키는 아직 폐기하지 않는다)
2. NAS 운영자가 새 키를 Secrets 파일에 원자적으로 교체한다 (임시 파일에 쓰고 rename, 권한 0600, 소유자 root)
   또는 compose env의 `HOMEPAGE_API_KEY`를 바꾼다
3. 컨테이너 재시작 (`docker compose up -d`)
4. 관리자 페이지에서 지문 변경 확인 + 연결 테스트 실행
5. 연결 테스트 성공 후 업체 측에 구 키 폐기 요청
6. 구 키 폐기 확인을 감사 기록에 남긴다 (지문만 기록)

주의: 2번과 5번 사이에 구 키·새 키가 둘 다 유효한 기간이 있어야 한다.
업체가 "새 키 발급 시 구 키 즉시 폐기" 방식이면, 교체 작업 전에 업체에 순서를 확인한다 (**[미확정]**).
키 교체 중 폴링은 실패할 수 있다. 교체 작업은 폴링이 꺼진 상태에서 하고, 연결 테스트 성공 후 다시 켠다.

**기관별 분리 구조:** 기관별 키는 기관별 NAS의 env/Secrets에만 존재한다.
공용 소스코드·GitHub·Docker 이미지에는 어떤 기관의 키도 들어가지 않는다.
기관 식별값(`HOMEPAGE_ORG_ID`)은 비밀이 아니라 설정값이다. `EngineSettings.json`에 두고,
요청 시 식별용으로만 쓴다 (인증은 키가 맡는다).
전국 배포용 `docker-compose.deploy.yml`에는 키 자리에 주석 처리된 템플릿만 둔다 (실제 키 없음).
각 기관이 설치 시 자신의 키를 Secrets 파일로 만든다.

### 2-2. 설정 저장 구조 (환경변수 vs 설정 JSON)

| 항목 | 저장 위치 | 이유 | 변경 주체 |
|---|---|---|---|
| API 키 본문 | env(`HOMEPAGE_API_KEY`) 또는 Secrets 파일(`HOMEPAGE_API_KEY_FILE`) | 비밀. 설정 JSON에 넣으면 R1 함정 | NAS 운영자 (컨테이너 재시작 필요) |
| 모드 | env 전용(`HOMEPAGE_API_MODE`) | 기동 전 결정 사항. 데이터 디렉터리 분리와 직결 | NAS 운영자 (컨테이너 재시작 필요) |
| API 기본 주소 | `EngineSettings.json` (env는 최초 시드용) | 비밀이 아님. 관리자가 화면에서 바꿀 수 있어야 함 | 관리자 (화면, 재시작 불필요) |
| 기관 식별값 | `EngineSettings.json` (env는 최초 시드용) | 비밀이 아님. 기관별 설정값 | 관리자 (화면, 재시작 불필요) |
| 자동 수신 ON/OFF | `EngineSettings.json` (env는 최초 시드용) | 운영 설정. 화면에서 켜고 끌 수 있어야 함 | 관리자 (화면, 즉시 반영) |
| 수신 주기(초) | `EngineSettings.json` (env는 최초 시드용) | 운영 설정. 화면에서 바꿀 수 있어야 함 | 관리자 (화면, 다음 주기부터 반영) |
| 요청 타임아웃(ms) | `EngineSettings.json` (env는 최초 시드용) | 운영 설정 | 관리자 (화면) |
| 배치 크기(건) | `EngineSettings.json` (env는 최초 시드용) | 운영 설정 | 관리자 (화면) |
| API 키 헤더명 | `EngineSettings.json` (env는 최초 시드용) | 업체 명세에 따라 바뀌는 값. **[미확정]** 기본값 `X-Api-Key`는 가설 | 관리자 (화면, 명세 확정 후) |
| 키 지문·로딩 시각 | 상태 응답에만 존재 (저장하지 않음) | 키에서 파생된 표시용 값. 설정이 아님 | — (기동 시 계산) |

**[설계 결정]** env는 "최초 시드" 역할만 한다. `EngineSettings.json`이 없으면(최초 기동)
env에 있는 비-비밀 값을 읽어 JSON을 만들고, 그 뒤로는 JSON이 진실 원본이다.
env를 나중에 바꿔도 JSON이 있으면 env는 무시된다 (관리자가 화면에서 바꾼 값이 컨테이너 재시작 때
env로 되돌아가는 사고를 막는다). 단, 모드와 키는 예외로 항상 env가 진실 원본이다.

**`EngineSettings.json` 스키마 (설계안)** — 저장 위치: `DATA_DIR/EngineSettings.json`
(모드별 분리됨 — `DATA_DIR`이 이미 `app/data/<모드>`로 나뉘기 때문).
저장 방식은 기존 `Settings.json`과 같다 (`getData`/`persistData` 경유, `getOrgSettings()` 패턴).
필드: `baseUrl`, `orgId`, `apiKeyHeader`(`X-Api-Key`), `pollEnabled`(기본 false),
`pollIntervalSeconds`(기본 60, 허용 30~3600), `requestTimeoutMs`(기본 10000, 허용 1000~120000),
`maxBatchSize`(기본 50, 허용 1~100), `updatedAt`, `updatedBy`(마지막 변경 관리자).
이 파일에 키 본문·키 지문 전체·비밀번호가 들어가면 안 된다. 설정 저장 시 키 관련 필드가 있으면 거부한다
(allowlist 검증 — 키 필드명은 저장 전에 차단 목록으로 검사).
설정 변경은 관리자만 가능하다 (`requireAdmin`). 변경 시마다 감사 기록에 남긴다
(변경 항목명·이전값·새 값 — 단, 값에 키가 포함될 수 없으므로 안전).

**모드별 분리:**

| 모드 | `HOMEPAGE_API_MODE` | baseUrl | 키 | 데이터 |
|---|---|---|---|---|
| mock | `mock` (기본값) | 불필요 (MockHomepageApi 사용, 네트워크 없음) | 합성 키 (코드 내 상수, 실제 통신 없음) | `DATA_DIR`의 mock 경로 |
| staging | `staging` | 스테이징 주소 (운영 주소와 다른 호스트여야 함) | 스테이징 전용 키 (운영 키와 다르게 발급) | `DATA_DIR`의 staging 경로. 합성 데이터만 사용 |
| production | `production` | 운영 주소 | 운영 전용 키 | `DATA_DIR`의 production 경로. mock·합성 데이터 주입 금지 |

모드가 잘못된 값이면 기동 시 실패한다 (survey `SURVEY_TRACK_A_MODE`의 fail-closed 패턴).
staging/production에서 `baseUrl`이 없으면 기동 시 fail-closed (엔진 비활성화 + `misconfigured` 상태).

---

## 3. 엔진에서의 보안 원칙 적용 (R1~R7 대응)

| 리스크 | 심각도 | 엔진에서의 대응 | 범위 |
|---|---|---|---|
| R1 비밀번호 평문 저장 | 상 | **API 키를 설정 JSON·프론트·소스·로그에 일절 저장하지 않는다.** 키는 env/Secrets 참조만 (§2). 관리자 화면은 키 입력 칸을 두지 않고 지문만 표시한다 (03 문서 §3-3 결정 대기 참조). 키 검증은 형식 검사 + 지문 계산만 하고, 키 본문을 어디에도 기록하지 않는다 | 엔진 범위 내. 기존 `Users.json` 평문 저장 수정은 엔진 범위 밖 (jun 결정 사항, 별도 보고) |
| R2 `x-user-role` 헤더 신뢰 | 상 | **engineRouter는 `req.auth`만 신뢰한다.** `x-user-id`·`x-user-role`·`x-user-team` 헤더와 `userId`·`userRole` 쿼리 파라미터를 읽지 않는다. 관리자 판정은 `requireAdmin` 미들웨어(`req.auth.role === 'admin'`)로만 한다. 새 관리자 페이지는 서버 가드 + 프론트 `renderPage` 가드의 이중 방어를 둔다 | 엔진 범위 내. 기존 `/api/referrals`(1520-1522행)·`/api/analysis/current`(2952-2954행) 핸들러 수정은 엔진 범위 밖. 실서버 재현 검증은 별도 과제 (아래 §4 참조) |
| R3 인증 없는 중복 API | 중 | **새 라우터는 `requireAdmin`을 라우터 레벨에서 한 번에 적용한다** (`router.use(requireAdmin)` — assetRouter의 `router.use(requireAuth)` 패턴). 개별 핸들러마다 인증을 붙이는 방식은 누락 사고를 부르므로 쓰지 않는다. 엔진 라우트는 `/api/external-api/*` 네임스페이스 하나로 묶어, 기존 `/api/website-referrals/*`와 충돌하지 않게 한다. 엔진은 budget/logs/unregistered 라우트를 건드리지 않는다 | 엔진 범위 내. 기존 11개 중복 블록 삭제는 엔진 범위 밖 (jun 승인 후 별도 작업) |
| R4 로그인 속도 제한 없음 | 중 | **엔진 라우터에 자체 속도 제한을 둔다.** 연결 테스트: 관리자 계정당 분당 5회. 수동 동기화: 관리자 계정당 분당 2회 + 전역 10초 간격. 초과 시 429 + `Retry-After` 헤더. `express-rate-limit`이 설치돼 있지 않으므로(확인됨) 의존성을 새로 추가하지 않고, 라우터 내 인메모리 카운터 미들웨어로 구현한다. 단일 프로세스 전제라 인메모리 카운터가 유효하다. 카운터는 재시작 시 초기화된다 (허용) | 엔진 범위 내. 전역 로그인 속도 제한 도입은 엔진 범위 밖 |
| R5 보안 헤더·helmet 없음 | 중 | **엔진 라우터 응답에 최소 헤더를 붙인다.** `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (설정·상태 응답). 전역 helmet 도입은 하지 않는다 (기존 동작 변경 위험). 새 관리자 페이지가 외부 리소스를 불러오지 않도록 한다 | 엔진 범위 내(라우터 헤더). 전역 helmet 도입은 엔진 범위 밖 (jun 결정) |
| R6 스크레이퍼 로그에 실명 노출 | 중 | **엔진 로그 마스킹 규칙을 정한다(아래 §5).** 허용: 고유 접수 ID, 기관 ID, 상태 코드, 건수, 시각, 지문 앞 8자. 금지: 이름·전화·주민번호·검사 응답 원문·API 키·키 본문·에러 응답 원문 전체. `auditPayloadPolicy.js`의 PII 금지 키 목록을 엔진 로그·감사 기록에도 그대로 적용한다. Docker json-file 로그는 30MB 순환이라 실명이 남으면 30MB 동안 보관된다 — 마스킹이 유일한 방어다 | 엔진 범위 내 |
| R7 의뢰·개인정보 평문 저장 | 중 | **부분 대응.** 엔진이 가져오는 개인정보는 기존 평문 JSON 저장소에 들어가므로, 엔진이 at-rest 암호화를 새로 도입하지 않는다 (기존 저장 방식을 임의로 바꾸지 않는다 — 의뢰서 원칙). 대신 엔진이 만드는 새 파일은 PII를 포함하지 않는 구조로 설계한다: seen-set은 고유 접수 ID만, 실패 큐는 ID + 에러 코드만, 이력 파일은 건수·상태만. 전송 중 암호화는 HTTPS 강제로 보장한다 (아래 §6) | 부분 대응. at-rest 암호화 도입은 엔진 범위 밖 (jun 결정) |

---

## 4. 보안 취약점 R1·R2·R3 — 별도 보안 개선 작업으로 분리

이 3건은 신규 API 개발과 별개로 처리한다. 이번 설계 단계에서는 수정하지 않는다.

### R1 — 비밀번호 평문 저장 (상)

- 내용: `server/auth/authService.js:67-70` `storedPwd !== inputPwd` 평문 비교, bcrypt 없음.
  `/api/setup`도 평문 저장·최소 4자. `Users.json`·백업 스냅샷에 평문으로 들어감 **[사실, 팀장 직접 확인]**.
- 엔진과의 관계: 엔진의 API 키를 설정 JSON 평문으로 저장하면 안 된다 (R1과 같은 함정).
  환경변수/Docker Secrets로만 분리하고, 키 저장과 데이터 암호화는 별개 기능으로 설계할 것.
- 별도 작업: `Users.json` 평문 비밀번호를 bcrypt 해시로 바꾸는 것은 기존 인증 체계 변경이라
  jun 결정 사항으로 별도 보고한다. 이번 단계에서는 건드리지 않는다.

### R2 — `x-user-role` 헤더 신뢰 (상)

- 내용: `server.js:1520-1522` (`/api/referrals`), `2952-2954` (분석) — 핸들러가 세션 사용자(`req.auth`)가 아니라
  클라이언트 헤더로 역할·팀을 정함. 존재하지 않는 `x-user-id` + `x-user-role: admin`이면
  전 팀 의뢰 조회가 가능해 보이는 구조 **[사실, 코드 독해 결과이며 실서버 미검증]**.
- **실서버 재현 검증 방법 (스테이징):**
  1. 스테이징 서버에 일반 사용자 계정으로 로그인해 세션 쿠키를 확보한다.
  2. `x-user-id: <존재하지 않는 ID>` + `x-user-role: admin` 헤더를 붙여 `GET /api/referrals`를 호출한다.
  3. 다른 팀의 의뢰 목록이 반환되는지 확인한다. 반환되면 권한 우회 확정.
  4. 확인되면 조치안: 핸들러가 `req.auth`의 역할·팀만 보게 수정하고, 헤더 읽는 코드를 제거한다.
     수정 범위는 해당 핸들러 2곳이며, 기존 기능 변경이라 jun 승인 후 별도 작업으로 한다.
  5. 반환되지 않으면 코드 독해 오판으로 기록하고, 해당 핸들러는 건드리지 않는다.
- 엔진과의 관계: 새 엔진은 `req.auth`만 신뢰한다 (R2 패턴 금지). 기존 핸들러 수정은 엔진 범위 밖이다.

### R3 — 인증 없는 중복 API 11개 (중)

- 내용: `server.js:4282-4375` — 예산 8개·로그 2개·미등록 1개가 인증 없이 중복 정의돼 있음.
  인증 버전이 먼저 등록돼 현재 도달 불가(dead code)로 보이나, 순서에만 의존하는 fragile한 상태
  **[사실, 팀장 직접 확인 — 4282행 인증 없는 예산 API 존재 확인]**.
- **삭제 여부와 영향 범위 분석:**
  - 삭제 찬성: 순서에만 의존하는 보안 구멍을 없앤다. dead code 정리.
  - 삭제 반대·유보: 삭제 자체가 기존 기능 변경이다. 현재 도달 불가로 보여 실효 위험은 낮다.
    삭제 후 기존 기능이 정상 동작하는지 회귀 확인이 필요하다.
  - **이번 단계에서는 삭제하지 않는다.** jun 승인 후 별도 작업으로 한다. 엔진은 이 11개 블록을 건드리지 않는다.
- 엔진과의 관계: 새 라우터는 `router.use(requireAdmin)`을 라우터 레벨에서 한 번에 적용해
  같은 실수를 반복하지 않는다.

### R4~R16 — 나머지 리스크 (1단계 보고서 기준)

| 리스크 | 심각도 | 내용 | 엔진과의 관계 |
|---|---|---|---|
| R4 | 중 | 로그인 속도 제한 없음 (`express-rate-limit` 없음). R1과 결합되면 무차별 대입 부담이 낮아짐 | 엔진 라우터 자체 가드로 대응 (§3). 전역 로그인 속도 제한 도입은 범위 밖 |
| R5 | 중 | 보안 헤더·helmet 없음 (첨부파일 경로에만 `nosniff`/`no-store`) | 엔진 라우터 응답에만 최소 헤더 부착 (§3). 전역 helmet 도입은 범위 밖 |
| R6 | 중 | 스크레이퍼 로그에 실명 노출 (Docker 로그에 이름이 남음) | 엔진 로그 마스킹 규칙으로 대응 (§5). 스크레이퍼 로그 자체 수정은 범위 밖 |
| R7 | 중 | 의뢰·개인정보 평문 저장 (at-rest 암호화 없음). 백업 스냅샷도 평문 | 부분 대응 (§3). at-rest 암호화 도입은 별도 결정 사항 |
| R8 | 하 | `/api/setup` — 초기 설정 전에는 누구나 관리자 계정 생성 가능 (가드 있음, 운영 주의) | 엔진과 무관. 범위 밖 |
| R9 | 하 | `POST /api/officialdocs/sync` 무인증 스텁 (현재는 실패만 반환) | 엔진과 무관. 범위 밖 |
| R10 | 하 | 업로드 확장자 검사만 존재 (매직바이트 검증 없음) | 엔진과 무관. 범위 밖 |
| R11 | 하 | CORS — Origin 없는 요청 허용 + `credentials: true`. CSRF 방어는 authRouter에만 적용 | 엔진 라우터의 상태 변경 엔드포인트에는 `verifyStateChangingOrigin`을 라우터 레벨에서 적용 (아래 §7). 전역 CORS 변경은 범위 밖 |
| R12 | 하 | CI 테스트·감사·시크릿 스캔 없음 + 배포 타이밍 문서 불일치 (Watchtower 자정 vs "약 5분") | 배포 전 체크리스트·드리프트 검사로 대응 (`08-implementation-roadmap.md` 참조). 문서 정합성 작업은 별도 보고 |
| R13 | 하 | `.env.example` 죽은 변수 28개 + `DEPLOY_GH_NAS.md` 구식 (Private 레지스트리 전제) | 엔진 변수 10개에 대해서만 드리프트 없음을 보장하는 절차 설계 (아래 §8). 기존 28개 정리는 별도 과제 |
| R14 | 정보 | GHCR public + `latest` 단일 태그 (롤백은 다이제스트로만) | 롤백은 이미지 다이제스트로 한다. 엔진은 스키마 마이그레이션이 없고 새 JSON 파일만 지연 생성하므로 이전 이미지로 되돌려도 데이터가 깨지지 않는다 |
| R15 | 정보 | 단일 Node 프로세스·인메모리 캐시 | 엔진은 인프로세스 `setInterval`로 둔다. 별도 프로세스·큐 서버 없음 |
| R16 | 정보 | `npm install` 사용 (lockfile 미고정), `npm audit` 없음 | 엔진은 새 의존성을 추가하지 않는다 (인메모리 카운터·기존 유틸 재사용) |

---

## 5. 로그 마스킹 규칙 (상세)

엔진의 모든 로그·감사 기록·에러 응답에 적용한다.

**허용하는 식별자:** 고유 접수 ID (`externalIdx` 등) — 식별의 유일한 수단. 기관 식별값 (`orgId`).
상태 코드·에러 코드 (예: `HOMEPAGE_AUTH_FAILED`, `TIMEOUT`). 건수·시각·소요 시간. 키 지문 앞 8자.

**절대 남기지 않는 것:** 이름·전화·주민번호·주소·보호자 정보. 검사 문항별 응답 원문·총점과 연결된 개인 식별 정보
(건수는 허용, 원문은 금지). API 키 본문·키 지문 전체. 홈페이지 API 응답 원문 전체
(에러 응답도 원문 그대로 남기지 않고, 상태 코드 + 메시지 요약만 남긴다).
요청 URL에 쿼리 파라미터로 개인정보가 들어간 경우, URL 전체를 로그에 남기지 않는다 (호스트 + 경로까지만).

**구현 방식:** 로그를 찍기 전에 허용 목록(allowlist)으로 필드를 걸러내는 헬퍼를 둔다
(금지 목록이 아니라 허용 목록 — 새 필드가 추가돼도 기본적으로 안 남는다).
`auditPayloadPolicy.js`의 PII 금지 키 목록을 재사용한다 (이름·전화 등).
엔진 전용 금지 키(키 본문, `apiKey`, `Authorization` 헤더 값)를 추가한다.
에러 응답은 `{ error: { code, message } }` 관례를 따르고, message에는 내부 상세(스택·URL·키)를 넣지 않는다.

---

## 6. URL 검증·HTTPS 강제

- `surveyUrlValidator.js`를 재사용한다 (그대로 import하거나, 엔진용 `urlValidator.js`로 감싼다).
- 검증 규칙: staging/production은 HTTPS만 허용. 내장 자격증명(`user:pass@`) 금지.
  경로 traversal(`..`, `\`) 금지. production에서는 localhost·127.0.0.1·`::1`·`.local`·`.localhost` 금지.
  staging에서는 localhost 금지 (실제 스테이징 배포 URL만 허용).
- mock 모드에서는 URL 검증을 건너뛴다 (네트워크를 쓰지 않으므로).
- `baseUrl`이 바뀌면(설정 변경) 다음 폴링부터 새 URL을 쓰기 전에 검증을 다시 수행한다.
  검증 실패 시 이전 설정을 유지하고 변경을 거부한다 (fail-closed — 잘못된 주소로 폴링하지 않는다).
- **데이터 전송 암호화와 API 인증은 별개로 다룬다.** 전송 중 암호화는 HTTPS 강제로 보장한다.
  페이로드 자체의 암호화 여부는 **[미확정]** — 업체 명세에 따라 별도 테스트를 추가한다 (`06-test-plan.md` T7 참조).
  기존 JSON 저장 데이터의 암호화 방식까지 이번 설계에서 임의로 변경하지 않는다.
  저장 데이터 암호화는 별도 보안 개선 과제로 분리하고 영향도를 보고한다 (R7 참조).

---

## 7. CSRF·Origin 방어 (엔진 라우터)

- **[사실]** 기존 CSRF 방어(`verifyStateChangingOrigin`, `server/auth/csrfProtection.js`)는
  `authRouter`에만 적용돼 있고, 나머지 API 라우트에는 전역 적용이 안 돼 있다.
  세션 쿠키는 `HttpOnly; SameSite=Lax`라 일반적인 CSRF는 Lax로 1차 방어된다.
- **[설계 결정]** 엔진 라우터의 상태 변경 엔드포인트(설정 변경·수동 동기화·실패 재처리·연결 테스트)에는
  `verifyStateChangingOrigin`을 라우터 레벨에서 적용한다.
  Origin 없는 변경 요청은 production에서 차단한다 (`ALLOW_ORIGINLESS_MUTATIONS` 기본값 false와 같은 원칙).
- 엔진 라우터는 JSON만 받고, `Content-Type: application/json`이 아닌 변경 요청은 거부한다.
- 입력 검증 경계: 홈페이지 API 응답은 외부 입력이다. 스키마 검증(허용된 필드·길이·형식·enum)을 통과한 값만 사용하고,
  나머지는 버리거나 실패로 기록한다. 응답 크기 상한: 한 번의 폴링 응답은 최대 5MB,
  한 건의 페이로드는 최대 100KB를 넘으면 거부한다 (**[판단]** 업체 페이로드 크기가 미확정이므로 상한은 가드용이며,
  명세가 오면 조정한다). 고유 접수 ID는 허용 문자(영문·숫자·`-`·`_`, 최대 128자)로 살균한다
  (trackAClient의 `_sanitizeId` 패턴). 살균에 실패하면 해당 건을 실패 큐에 넣고 계속 진행한다
  (한 건의 오염이 전체 폴링을 막지 않는다).

---

## 8. 배포·환경변수 설계

### 8-1. 신규 환경변수 10개 확정안

| # | 변수 | 용도 | 기본값 | 필수 여부 | 저장 위치 성격 |
|---|---|---|---|---|---|
| 1 | `HOMEPAGE_API_BASE_URL` | 홈페이지 API 기본 주소 | 없음 | production/staging에서 필수 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 2 | `HOMEPAGE_API_KEY` | 기관별 API 키 본문 (직접 입력 경로) | 없음 | production/staging에서 필수 (파일 경로가 없을 때) | env 전용. 설정 JSON·프론트·GitHub 절대 금지 |
| 3 | `HOMEPAGE_API_KEY_FILE` | API 키 Secrets 파일 경로 | `/run/secrets/homepage_api_key` | production/staging에서 필수 (직접 입력이 없을 때) | env 전용. 파일 본문은 디스크 Secrets |
| 4 | `HOMEPAGE_ORG_ID` | 기관 식별값 | 없음 | production/staging에서 필수 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 5 | `HOMEPAGE_API_MODE` | 모드 (mock/staging/production) | `mock` | 아니오 (기본값 mock) | env 전용. 기동 전 결정 |
| 6 | `HOMEPAGE_POLL_ENABLED` | 자동 수신 ON/OFF | `false` | 아니오 (기본 OFF) | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 7 | `HOMEPAGE_POLL_INTERVAL_SECONDS` | 수신 주기(초) | `60` | 아니오 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 8 | `HOMEPAGE_REQUEST_TIMEOUT_MS` | 요청 타임아웃(ms) | `10000` | 아니오 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 9 | `HOMEPAGE_MAX_BATCH_SIZE` | 한 번에 가져올 최대 건수 | `50` | 아니오 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json` |
| 10 | `HOMEPAGE_API_KEY_HEADER` | API 키 헤더명 | `X-Api-Key` | 아니오 | env는 최초 시드. 런타임 진실 원본은 `EngineSettings.json`. **[미확정]** 업체 인증 방식에 따라 변경 |

스케줄러 초기 지연은 별도 환경변수로 두지 않고 60초로 고정한다
(survey 선례 `SURVEY_AUTO_IMPORT_INITIAL_DELAY_SECONDS` 기본값 60초와 동일). 환경변수는 10개로 유지한다.
키 입력 경로가 둘 다 설정된 경우 파일 경로(`HOMEPAGE_API_KEY_FILE`)가 우선한다.
둘 다 없으면 production/staging에서 기동 시 fail-closed (§2-1 참조).

### 8-2. `.env.example` 추가 절차 (죽은 변수 28개 전례를 반복하지 않게)

**[사실]** 현재 `.env.example`에는 `SURVEY_AUTO_IMPORT_*` 5개와 `EXTERNAL_*` 8개가 아예 없다 (grep 결과 0건).
코드에서 읽히는 변수가 예시 파일에 없는 드리프트가 이미 존재한다. 새 엔진 변수를 추가할 때는 이 전례를 반복하지 않는다.

1. **블록 추가**: `.env.example` 맨 아래에 구분된 블록을 추가한다. 블록 제목은 `Track C: External Homepage API Engine`으로 한다.
   각 변수마다 한 줄 주석(용도·기본값·필수 여부)을 단다. 값은 전부 비워두거나 플레이스홀더만 둔다 (실제 키·주소를 넣지 않는다).
2. **코드 대조**: 추가한 뒤 코드에서 `process.env.HOMEPAGE_*`를 grep으로 전수 확인하고, 예시 파일의 변수 목록과 1:1로 대조한다.
   예시에만 있고 코드에서 읽히지 않는 변수가 있으면 지운다 (죽은 변수 방지).
   코드에서 읽히는데 예시에 없는 변수가 있으면 추가한다.
3. **드리프트 검사 스크립트**: `scripts/check-env-example.mjs`를 새로 만든다 (3단계 구현물, 본 문서는 설계만 한다).
   동작: `.env.example`의 키 목록을 파싱 → `server/`·`server.js`에서 `process.env.<KEY>` 참조를 grep →
   (a) 예시에만 있는 키(죽은 변수), (b) 코드에만 있는 키(문서 누락)를 보고하고, 하나라도 있으면 종료 코드 1로 실패한다.
   검사 범위는 `HOMEPAGE_*`·`SURVEY_*`·`EXTERNAL_*`·`TRACK_*`·`BACKUP_*`로 한정한다
   (전수 검사는 기존 드리프트 28개 때문에 처음부터 실패하므로, 엔진 관련 범위부터 시작한다).
4. **배포 전 실행**: 배포 체크리스트에 드리프트 검사 통과를 넣는다. 검사가 실패하면 배포하지 않는다.

기존 드리프트 28개(`JOB_*` 12개 등)는 엔진 범위가 아니라 별도 정리 과제다.
본 문서는 엔진 변수 10개에 대해서만 드리프트 없음을 보장하는 절차를 설계한다.

### 8-3. Docker Secrets·compose 설계

**이천 NAS (`docker-compose.yml`):**
```yaml
secrets:
  homepage_api_key:
    file: /volume2/docker/imhc/secrets/homepage_api_key
services:
  app:
    secrets:
      - homepage_api_key
    environment:
      - HOMEPAGE_API_KEY_FILE=/run/secrets/homepage_api_key
      - HOMEPAGE_API_MODE=production
```
- Secrets 파일은 repo 밖 NAS 호스트 경로(`/volume2/docker/imhc/secrets/`)에 둔다. Git에 들어가지 않는다. 파일 권한 0600, 소유자 root.
- **[미확정]** 전국 배포 대상 NAS·PC마다 Secrets 파일 경로가 다를 수 있으므로,
  `HOMEPAGE_API_KEY_FILE`은 설치 시 경로를 지정하게 한다. 기본값은 `/run/secrets/homepage_api_key`다.

**전국 배포용 (`docker-compose.deploy.yml`):** 키 자리에 주석 처리된 템플릿만 둔다 (실제 키 없음).
각 기관이 설치 시 자신의 키를 Secrets 파일로 만든 뒤 주석을 해제한다.
`ADMIN_INIT_PASSWORD` 플레이스홀더 전례와 같은 방식이다.

**이미지·빌드:** `.dockerignore`에 이미 `.env*`가 포함돼 있어 이미지 안에 env가 들어가지 않는다.
Secrets 파일은 볼륨 마운트가 아니라 Docker Secrets 메커니즘으로 주입되므로 이미지에도 들어가지 않는다.
`VITE_*` 빌드 인자에는 엔진 값을 넣지 않는다 (설문 프론트 URL이 빌드 시점에 박히는 전례를 답습하지 않는다).

### 8-4. 배포 타이밍 확인 절차 (Watchtower 자정 vs 문서 "약 5분" 불일치)

**[사실]** `docker-compose.yml`의 Watchtower 스케줄은 매일 자정(`0 0 0 * * *`)이고,
`DEPLOYMENT_SAFETY_RULES.md`에는 "main push 후 약 5분 내 자동 배포"라고 적혀 있다.
어느 쪽이 맞는지 1단계에서는 확인하지 못했다.

**확인 절차 (롤아웃 전):**
1. NAS에서 `docker compose config`로 실효 Watchtower 스케줄을 읽는다 (compose 파일에 적힌 값과 실제 동작 값이 같은지 확인).
2. `docker logs watchtower`에서 마지막 이미지 풀(pull) 시각을 확인한다.
3. main push 시각과 컨테이너 이미지 변경 시각을 대조해 실제 소요 시간을 기록한다.
4. 확인 결과가 자정이면 `DEPLOYMENT_SAFETY_RULES.md`의 "약 5분" 문구를 고친다
   (문서 수정은 별도 보고 — 코드 변경이 아니라 문서 정합성 작업이다).
5. 확인이 끝나기 전까지 롤아웃 계획은 "다음 자정 반영"을 전제로 세운다 ("5분 내 반영"을 전제로 세우지 않는다).

**롤아웃 안전성:** 엔진 기본값이 OFF(`HOMEPAGE_POLL_ENABLED=false`, 모드 `mock`)이므로,
코드를 배포해도 동작이 바뀌지 않는다. 활성화는 별도 관리자 작업이다 (연결 테스트 성공 후 ON).
롤백: GHCR `latest` 단일 태그라 버전 태그 롤백이 안 되므로, 롤백은 이미지 다이제스트로 한다
(배포 시 다이제스트를 기록해 둔다). 엔진은 스키마 마이그레이션이 없고 새 JSON 파일만 지연 생성하므로,
이전 이미지로 되돌려도 데이터가 깨지지 않는다.

### 8-5. 배포 전 확인 체크리스트

| # | 확인 항목 | 확인 방법 | 합격 기준 |
|---|---|---|---|
| 1 | 환경 대상 확인 | 배포 대상 compose 파일(`docker-compose.yml` 이천 / `docker-compose.deploy.yml` 전국)이 맞는지, `DATA_DIR`·`PORT`가 대상 NAS와 맞는지 확인 | 대상 NAS와 compose 설정이 일치함 |
| 2 | 시크릿 검증 | 키 파일 존재·읽기 가능·권한 0600 확인. 앞뒤 공백 제거 후 비어 있지 않은지 확인. 키 지문을 기록 (키 본문은 기록하지 않음) | 키 파일이 있고, 지문이 기록됨 |
| 3 | 환경 게이트 확인 | `HOMEPAGE_API_MODE`가 대상에 맞는지 확인 (NAS 운영은 production, 테스트는 staging/mock). `HOMEPAGE_POLL_ENABLED=false`로 시작하는지 확인 | 모드가 대상과 일치하고, 폴링이 OFF로 시작함 |
| 4 | 드리프트 검사 | `scripts/check-env-example.mjs` 실행 (§8-2) | 통과 (죽은 변수·누락 변수 0건) |
| 5 | 시크릿 스캔 | 스테이징된 diff에서 키 패턴 grep (06 문서 T10과 동일 절차). `.gitignore`·`.dockerignore` 확인 | 키 본문이 diff·이미지·설정 JSON에 없음 |
| 6 | 타입검사 | `npx tsc --noEmit -p tsconfig.json` 실행 | 신규 오류 0건 (기존 오류 16건은 기준선) |
| 7 | 스모크 테스트 (mock) | mock 모드로 기동 → `GET /api/external-api/status` 호출 → 연결 테스트 실행 | 상태가 `mock`·`configured`로 나오고, 연결 테스트가 성공함 |
| 8 | 스모크 테스트 (staging) | staging 모드 + 스테이징 키로 기동 → 연결 테스트 실행 → 수동 동기화 1회 | 연결 테스트 성공, 합성 데이터 1건 이상 수신·저장됨 |
| 9 | 배포 타이밍 기록 | push 시각·Watchtower 풀 시각·컨테이너 이미지 변경 시각을 기록 (§8-4) | 실제 소요 시간이 기록됨 |
| 10 | 롤백 준비 | 배포 전 이미지 다이제스트 기록 | 다이제스트가 기록됨 |

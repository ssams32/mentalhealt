# 05. 의뢰 및 척도검사 데이터 매핑 설계

- 설계 기준: `origin/main 34c28d8` (브랜치 `external-api-engine`)
- 근거: 2단계 설계 문서 1번 (백엔드 엔진) + 1단계 분석 보고서 (트랙 2 상세)
- 상태: **설계 단계. 코드 변경 없음.**
- 표기: **[사실]**은 코드에서 직접 확인한 것, **[설계]**는 이번 단계에서 정한 것,
  **[미확정]**은 홈페이지 API 명세가 없어 정할 수 없는 것.

---

## 1. 원칙

- **기존 저장 구조를 재사용한다.** 의뢰는 `PendingReferrals`, 척도검사는 `SurveySubmissions`에 저장한다.
  새로운 검사 데이터 저장 체계를 불필요하게 추가하지 않는다.
- **외부 의뢰는 곧바로 정식 `Referrals`에 등록하지 않는다.**
  기존 필수 입력값 12개가 모두 충족되지 않을 수 있으므로 직원 검토 대기 상태로 저장하고,
  직원이 확인한 뒤 기존 의뢰 등록 절차를 통해 정식 등록한다.
- **검사 결과와 의뢰정보는 대상자를 확실하게 식별할 수 있는 경우에만 연결한다.**
  임의 연결 금지. 정확 일치만 자동 연결하고, 후보는 직원 검토로 넘긴다.
- **저장 성공 이후에만 홈페이지에 수신 완료 처리한다.**
  `await persistData(...)` 성공 확인이 ack의 전제 조건이다. `saveData` 사용 금지.

---

## 2. 의뢰접수 데이터 매핑

### 2-1. 매핑표 (`PendingReferrals` 항목)

홈페이지 필드명은 **[미확정]** — 아래 왼쪽 열은 내부 목표 필드, 오른쪽 "값"은 변환 규칙이다.
명세가 오면 홈페이지 필드명 → 내부 필드명 대응표만 추가하면 된다.

| 내부 필드 | 값 | 비고 |
|---|---|---|
| `id` / `externalIdx` | 홈페이지 고유 접수 ID | seen-set 키와 동일 |
| `externalReferralId` | 홈페이지 고유 접수 ID에서 접두사 제거 (규칙 미확정 — 명세가 오면 정한다) | 스크레이퍼는 `ext_` 제거 규칙을 썼다. API도 같은 규칙인지 미확정 |
| `name` / `phone` / `gender` / `age` / `birthDate` / `address` | 홈페이지 값 그대로 | 검증·정규화를 통과한 값만 |
| `medicalInsurance` / `disabilityStatus` / `problem` / `guardianPresence` / `guardianName` / `guardianRelation` / `guardianPhone` / `guardianNotes` / `consentToReferral` / `consentNotes` / `reason` | 홈페이지 값 그대로 | 외부기관 의뢰 전용 필드 (이미 `Referral` 타입에 있음) |
| `agency` / `agencyPhone` / `requesterName` / `requesterFax` / `requesterEmail` | 홈페이지 값 그대로 | 의뢰기관·의뢰자 정보 |
| `referralPath` | 홈페이지 값 또는 기관명 기반 자동 분류 | 스크레이퍼의 자동 분류 규칙(보건소/의료기관/이천시청/의뢰기관)을 재사용한다. 단, 홈페이지가 직접 경로를 주면 그 값을 우선한다. 홈페이지가 직접 주는 값 목록은 **[미확정]** |
| `registrationDate` | `receivedAt`의 날짜 부분 (YYYY-MM-DD) | |
| `externalReceivedAt` | 홈페이지 접수 시각 (원본 그대로) | |
| `createdAt` / `firstReceivedAt` / `lastSyncedAt` | 엔진 수신 시각 (ISO) | 스크레이퍼는 `firstScrapedAt`을 썼다. 엔진은 `firstReceivedAt`을 쓴다 (스크레이퍼와 구분). `lastSyncedAt`은 기존 필드명을 그대로 쓴다 |
| `isWebsiteReferral` | `true` | 기존 채널 필터가 이 플래그를 보기 때문이다 |
| `source` | `'homepage-api'` | **[설계]** 새 채널 값. 기존 `'website'`와 구분한다. 최종 확정은 팀장 결정 |
| `referralStatus` | `'PENDING_STAFF_REVIEW'` | 직원 검토 큐. 자동 등록 없음 |
| `status` | `'pending'` | `PendingReferrals` 항목 상태 (스크레이퍼와 동일) |
| `websiteReferralSeenAt` | `null` | 직원이 확인하면 기존 엔드포인트가 채운다 |
| `missingFields` | UI 필수 12개 중 없는 항목 목록 | 엔진이 붙이는 주석 필드. 직원 확인 화면이 이 목록을 보여준다. 이 필드는 `Referral` 타입에 없는 엔진 전용 주석 필드이며, 정식 등록 시 `POST /api/referrals` 검증이 이 필드를 무시하는지 3단계에서 확인할 것 (무시하지 않으면 등록 전에 제거하는 단계를 어댑터에 추가한다) |

### 2-2. UI 필수 12개와 직원 검토 큐

자동 등록의 병목은 UI 필수 12개다: name, phone, gender, region, diagnosisName, requestAgency,
team, actionResult, closureStatus, requestDate, assignee, criLevel.
홈페이지 의뢰에는 없는 값이 많아 현재는 직원 확인 후 등록 방식이다.
엔진은 `classifyMissingFields()`로 없는 항목을 `missingFields` 배열로 붙이고,
직원 확인 화면(`ReferralInbox` → `mapWebsiteReferralToInitialForm` → `ReferralEditor`)이
이 목록을 보여주며 직원이 채워서 저장한다. 엔진은 이 흐름에 새 화면을 추가하지 않는다.

### 2-3. 의뢰·척도검사 식별자 구분

| 데이터 | 식별자 (고유 접수 ID) | 저장 위치 |
|---|---|---|
| 의뢰 | 홈페이지 의뢰 고유 접수 ID (`externalIdx`) | `PendingReferrals` → 정식 등록 시 `Referrals` |
| 척도검사 | 홈페이지 검사 고유 제출 ID (`submissionId` / `assessmentId`) | `SurveySubmissions` |

의뢰와 척도검사의 식별자는 서로 다른 키 체계다. 한쪽의 ID로 다른 쪽을 조회하지 않는다.
연결은 아래 §4의 규칙으로만 한다.

---

## 3. 척도검사 데이터 매핑

### 3-1. 매핑표 (`SurveySubmissions` 레코드)

| 내부 필드 | 값 | 비고 |
|---|---|---|
| `submissionId` | 홈페이지 고유 제출 ID | seen-set 키와 동일 |
| `assessmentId` | 홈페이지 검사 ID (없으면 `submissionId`와 동일) | |
| `scale` | 척도 코드 (예: `phq-9`) | **[미확정]** — 코드 목록은 명세가 오면 정한다. 알 수 없는 코드는 그대로 저장하고 `scaleSeverities`에는 넣지 않는다 |
| `totalScore` / `score` | 홈페이지 총점 | 둘 다 같은 값을 넣는다 (기존 코드가 두 필드를 혼용하므로) |
| `severity` | 홈페이지 판정 (없으면 `null`) | **총점으로 심각도를 추측하지 않는다** (1단계 P0 Fix 규칙). `null` 그대로 저장 |
| `scaleScores` | 척도별 `{ totalScore, severity }` 맵 | 홈페이지가 척도별 결과를 주면 그대로, 단일 척도만 주면 `{ [scale]: { totalScore, severity } }`로 만든다 |
| `answers` / `responses` | 문항별 응답 원본 (받은 그대로) | 저장 위치는 `SurveySubmissions` 레코드 내부. 로그·이력에는 절대 남기지 않는다. 문항별 응답 프론트 표시 위치는 미확인 사항으로 남긴다 (1단계 분석 §7 — 저장 구조에는 있으나 렌더링 위치 미확인) |
| `submittedAt` / `importedAt` | 홈페이지 실시 시각 / 엔진 수신 시각 | |
| `campaignCode` | 홈페이지가 주면 그대로, 없으면 `null` | **[미확정]** |
| `sourceSubmissionId` (연결용) | `submissionId`와 동일 | `Referrals` 연결 고리 |
| `referralId` / `refNo` | 연결이 확정될 때만 채움 | 아래 §4 연결 규칙 참조. 미연결이면 `null` |

### 3-2. 기존 설문 자동 동기화와 신규 API 수신의 통합 방안

| 항목 | 기존 설문 자동 동기화 (Track A/B) | 신규 홈페이지 API 수신 | 통합 방안 |
|---|---|---|---|
| 수집 채널 | 설문 서버 pull | 홈페이지 API pull | **별도 채널로 동작.** 한쪽이 고장 나도 다른 쪽은 동작한다 |
| seen-set | Track A/B 자체 이력 | 전용 `ExternalApiSeenIds.json` | **분리.** 이력을 섞으면 재전송분이 잘못 스킵될 수 있다 |
| 저장 테이블 | `SurveySubmissions` | `SurveySubmissions` | **공유.** 저장 형식은 동일하고, `sourceSubmissionId`로 출처를 구분한다 |
| 중복 방지 | Track A/B 멱등성 | 엔진 멱등성 3단계 (seen-set → `PendingReferrals`·`SurveySubmissions` 조회) | 저장 전 중복 검사가 최종 방어선이라, 채널이 달라도 같은 항목이 두 번 저장되지 않는다 |
| 화면 | `SurveyManagementPage` | 같은 화면 (마스킹 목록·복호화 상세·의뢰 초안 흐름) | **화면을 새로 만들지 않는다.** 저장된 레코드는 기존 흐름을 그대로 탄다 |

기존 설문 자동 동기화와 신규 API 수신이 동시에 작동해도 중복 수신되지 않는 이유는
저장 테이블이 같고 저장 전 중복 검사를 거치기 때문이다. 채널별 seen-set은 각 채널의 재전송만 막고,
최종 중복 방지는 저장 전 검사(`sourceSubmissionId`·`externalIdx` 조회)가 맡는다.

---

## 4. 대상자 연결 규칙 (`resolveReferralLink` — 임의 연결 금지)

| 조건 | 판정 | 처리 |
|---|---|---|
| `sourceSubmissionId`/`sourceSurveyId`가 기존 `Referrals` 레코드의 동일 값과 정확히 일치 | `link` | 해당 의뢰에 연결한다. `referralId`·`refNo`를 채우고, `referralStatus`는 건드리지 않는다 |
| `externalIdx`가 기존 `Referrals`·`PendingReferrals`와 정확히 일치 | `link` | 위와 동일 |
| 이름 + 연락처 + 나이(또는 생년월일)가 일치하고 접수일 30일 이내 | `candidate` | **자동 연결하지 않는다.** `linkCandidate: { referralId, confidence: 'candidate' }`를 레코드에 붙이고 직원 검토 큐로 보낸다 (기존 `syncRequest` 대조 규칙과 같은 기준이나, 자동 병합은 하지 않는다) |
| 위 어느 것에도 해당하지 않음 | `none` | 미연결 상태로 저장한다. 나중에 직원이 수동으로 연결할 수 있다 (연결 UI는 기존 설문→의뢰 초안 흐름을 재사용) |

---

## 5. 중복 수신 및 데이터 무결성

### 5-1. 멱등성 3단계 방어선

| 단계 | 검사 대상 | 키 | 스킵 시 처리 |
|---|---|---|---|
| 1차 | `ExternalApiSeenIds.json` | 홈페이지 고유 접수 ID | `duplicates` +1, 저장·ack 건너뜀. 단, 상태가 `stored`인데 `ackedAt`이 없으면 ack만 다시 시도한다 |
| 2차 | `PendingReferrals` | `externalIdx` | `duplicates` +1, 저장 건너뜀 |
| 3차 | `Referrals` | `sourceSubmissionId` / `externalIdx` | `duplicates` +1, 저장 건너뜀 (이미 정식 등록된 건) |

**1차 방어선이 실패해도 2·3차가 막는다.** seen-set 쓰기가 실패한 사이클이 있어도,
다음 사이클에서 2·3차 검사가 중복 저장을 막는다. seen-set은 성능·ack 추적용이고,
최종 중복 방지는 2·3차 검사가 맡는다.

**`Idempotency-Key` 재사용 여부:** 엔진은 `POST /api/referrals`를 직접 호출하지 않으므로,
엔진 내부에서 `Idempotency-Key`를 쓰지 않는다. 의뢰 정식 등록은 기존 UI가 하고,
그 경로는 이미 `Idempotency-Key` + 중복 409 검사를 갖고 있다.
엔진의 멱등성은 seen-set + 2·3차 검사가 맡는다.

### 5-2. 수신 도중 서버가 종료된 경우 복구

- 사이클은 상태 파일(`ExternalApiSyncState.json`)에 `lastAttemptedSyncAt`을 남기고 시작한다.
  서버가 사이클 도중 종료되면 다음 기동 시 마지막 시도가 미완료 상태로 남는다.
- seen-set은 저장 완료된 항목만 기록하므로, 종료 전에 저장이 안 된 항목은 다음 사이클에서 다시 가져온다.
  이미 저장된 항목은 2·3차 검사로 스킵된다. ack를 보내기 전에 저장했는지 확인하므로,
  저장 안 된 항목에 ack를 보내는 일은 없다.
- 스케줄러는 기동 60초 후 첫 사이클을 실행하므로, 재기동 후 자동으로 복구된다.

### 5-3. 저장 성공 보장 (`persistData` 확인 방식)

**[사실]** `saveData`는 fire-and-forget라 저장 성공을 보장하지 않는다
(`server.js` 322행 `persistData`·373행 `saveData`, 팀장 직접 확인).
**[설계]** 신규 엔진에서 저장 성공을 보장하는 데 `saveData`를 사용하지 않는다.
어댑터는 `await persistData('PendingReferrals', items)` / `await persistData('SurveySubmissions', records)`로
저장하고, 반환값을 확인한다. `persistData`의 실제 반환값과 오류 처리 구조는 3단계 구현 전
코드에서 다시 확인하고, 실패 시 `PERSIST_FAILED`로 분류해 재시도 큐로 이동시킨다
(사이클 내 재시도 최대 3회 → 그래도 실패하면 큐로 이동, 최대 3회 소진 시 `FAILED_PERMANENT`).

### 5-4. 검증 단계 (0~3단계)

| 단계 | 위치 | 내용 |
|---|---|---|
| 0단계: 전송 검증 | `homepageClient._request` | HTTP 상태·JSON 여부·타임아웃. 실패하면 사이클 실패로 기록 |
| 1단계: 구조 검증 | `payloadValidator.validateBatch` | 최상위 구조 (객체·배열 여부, `items` 존재 여부 — **[미확정]** 명세가 오면 확정) |
| 2단계: 항목 검증 | `payloadValidator.validateReferralItem` / `validateAssessmentItem` | 통과/격리/거부 구분 (03 문서 §2-6 규칙표 참조) |
| 3단계: 스팸·프로브 차단 | `payloadValidator.isSpamProbe` | 스크레이퍼와 동일한 패턴 (`sparrow\|dast\|<script\|onload=\|javascript:\|alert\(`). 탐지 시 `QuarantinedReferrals`로 격리 |

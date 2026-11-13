/**
 * server/external-api/intakeAdapter.js
 * Homepage Integration Engine — Data Mapping Adapter
 * ESM module.
 * 03 문서 §2-8, 05 문서 매핑표 그대로 구현.
 */

import { HomepageIntegrationError } from "./engineErrors.js";

/**
 * 소스 채널 상수 (한 곳에 정의해서 나중에 한 번에 바꿀 수 있게)
 */
export const SOURCE_CHANNEL = "homepage-api";

/**
 * UI 필수 12개 필드 (기존 코드에서 확인)
 */
const UI_REQUIRED_FIELDS = [
  "name",
  "phone",
  "gender",
  "region",
  "diagnosisName",
  "requestAgency",
  "team",
  "actionResult",
  "closureStatus",
  "requestDate",
  "assignee",
  "criLevel",
];

/**
 * 의뢰 접수 데이터를 PendingReferrals 형식으로 매핑
 * @param {object} raw - 홈페이지 원본 데이터
 * @param {object} normalized - 검증·정규화 통과된 데이터
 * @param {object} ctx - 컨텍스트 { receivedAt, cycleId }
 * @returns {object} PendingReferrals 항목
 */
export function mapReferralToPending(raw, normalized, ctx = {}) {
  const now = ctx.receivedAt || new Date().toISOString();
  const receivedDate = now.split("T")[0]; // YYYY-MM-DD

  // externalReferralId: 고유 접수 ID에서 접두사 제거 규칙 (명세 미확정으로 일단 원본 유지)
  const externalReferralId =
    normalized.externalId || raw.externalId || raw.externalIdx;

  const pending = {
    // 식별자
    id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    externalIdx: normalized.externalId || raw.externalId || raw.externalIdx,
    externalReferralId,

    // 대상자 기본 정보
    name: normalized.name ?? raw.name ?? null,
    phone: normalized.phone ?? raw.phone ?? null,
    gender: normalized.gender ?? raw.gender ?? null,
    age: normalized.age ?? raw.age ?? null,
    birthDate: normalized.birthDate ?? raw.birthDate ?? null,
    address: normalized.address ?? raw.address ?? null,

    // 보험·장애·문제·보호자
    medicalInsurance:
      normalized.medicalInsurance ?? raw.medicalInsurance ?? null,
    disabilityStatus:
      normalized.disabilityStatus ?? raw.disabilityStatus ?? null,
    problem: normalized.problem ?? raw.problem ?? null,
    guardianPresence:
      normalized.guardianPresence ?? raw.guardianPresence ?? null,
    guardianName: normalized.guardianName ?? raw.guardianName ?? null,
    guardianRelation:
      normalized.guardianRelation ?? raw.guardianRelation ?? null,
    guardianPhone: normalized.guardianPhone ?? raw.guardianPhone ?? null,
    guardianNotes: normalized.guardianNotes ?? raw.guardianNotes ?? null,

    // 동의
    consentToReferral:
      normalized.consentToReferral ?? raw.consentToReferral ?? null,
    consentNotes: normalized.consentNotes ?? raw.consentNotes ?? null,

    // 의뢰 사유
    reason: normalized.reason ?? raw.reason ?? null,

    // 의뢰기관·의뢰자
    agency: normalized.agency ?? raw.agency ?? null,
    agencyPhone: normalized.agencyPhone ?? raw.agencyPhone ?? null,
    requesterName: normalized.requesterName ?? raw.requesterName ?? null,
    requesterFax: normalized.requesterFax ?? raw.requesterFax ?? null,
    requesterEmail: normalized.requesterEmail ?? raw.requesterEmail ?? null,

    // 의뢰 경로 (홈페이지 직접 값 우선, 없으면 기관명 기반 자동 분류)
    referralPath:
      normalized.referralPath ?? raw.referralPath ?? classifyReferralPath(raw),

    // 날짜
    registrationDate: receivedDate,
    externalReceivedAt:
      normalized.externalReceivedAt ??
      raw.receivedAt ??
      raw.externalReceivedAt ??
      now,
    createdAt: now,
    firstReceivedAt: now,
    lastSyncedAt: now,

    // 채널 플래그
    isWebsiteReferral: true,
    source: SOURCE_CHANNEL,

    // 상태
    referralStatus: "PENDING_STAFF_REVIEW",
    status: "pending",

    // 직원 확인 시 채워지는 필드
    websiteReferralSeenAt: null,

    // UI 필수 12개 중 없는 항목 (엔진 전용 주석 필드)
    // pending 객체 생성 전에 필요한 값들 미리 계산
    missingFields: (() => {
      const computedReferralPath =
        normalized.referralPath ??
        raw.referralPath ??
        classifyReferralPath(raw);
      const computedAgency =
        normalized.agency ?? raw.agency ?? raw.requestAgency ?? null;
      const computedAddress = normalized.address ?? raw.address ?? null;
      return classifyMissingFields({
        ...normalized,
        ...raw,
        referralPath: computedReferralPath,
        requestAgency: computedAgency,
        region: computedAddress?.split(" ")[0] ?? null,
        diagnosisName: null, // 홈페이지에 없는 필드
        team: null,
        actionResult: null,
        closureStatus: null,
        requestDate: receivedDate,
        assignee: null,
        criLevel: null,
      });
    })(),
  };

  return pending;
}

/**
 * 척도검사 데이터를 SurveySubmissions 형식으로 매핑
 * @param {object} raw - 홈페이지 원본 데이터
 * @param {object} normalized - 검증·정규화 통과된 데이터
 * @param {object} ctx - 컨텍스트
 * @returns {object} SurveySubmissions 레코드
 */
export function mapAssessmentToSubmission(raw, normalized, ctx = {}) {
  const now = ctx.receivedAt || new Date().toISOString();
  const submissionId =
    normalized.externalId ||
    raw.externalId ||
    raw.submissionId ||
    raw.assessmentId;
  const scale = normalized.scale || raw.scale;
  const totalScore =
    normalized.totalScore ?? normalized.score ?? raw.totalScore ?? raw.score;

  const submission = {
    submissionId,
    assessmentId: normalized.assessmentId ?? raw.assessmentId ?? submissionId,
    scale,
    totalScore: Number(totalScore),
    score: Number(totalScore), // 기존 코드 혼용 대응
    severity: normalized.severity ?? raw.severity ?? null, // 총점으로 추측하지 않음
    scaleScores:
      normalized.scaleScores ??
      raw.scaleScores ??
      (scale && totalScore !== undefined
        ? {
            [scale]: {
              totalScore: Number(totalScore),
              severity: normalized.severity ?? raw.severity ?? null,
            },
          }
        : {}),
    answers: normalized.answers ?? raw.answers ?? raw.responses ?? null,
    responses: normalized.responses ?? raw.responses ?? raw.answers ?? null,
    submittedAt: normalized.submittedAt ?? raw.submittedAt ?? now,
    importedAt: now,
    campaignCode: normalized.campaignCode ?? raw.campaignCode ?? null,
    sourceSubmissionId: submissionId, // 연결용
    referralId: null, // 연결 확정 시 채움
    refNo: null,
  };

  return submission;
}

/**
 * 의뢰 연결 규칙 (임의 연결 금지)
 * @param {object} assessment - 척도검사 레코드 (이미 매핑된 상태)
 * @param {object} opts - { getData }
 * @returns {{ action: 'link'|'candidate'|'none', referralId?: string, reason: string }}
 */
export function resolveReferralLink(assessment, { getData }) {
  const sourceSubmissionId = assessment.sourceSubmissionId;
  const externalIdx = assessment.externalIdx; // 의뢰와 같은 ID 체계라면

  if (!sourceSubmissionId) {
    return { action: "none", reason: "sourceSubmissionId 없음" };
  }

  // 1. sourceSubmissionId가 기존 Referrals의 동일 값과 정확히 일치
  const referrals = getData("Referrals", []);
  const exactMatch = referrals.find(
    (r) =>
      r.sourceSubmissionId === sourceSubmissionId ||
      r.externalReferralId === sourceSubmissionId,
  );
  if (exactMatch) {
    return {
      action: "link",
      referralId: exactMatch.referralId || exactMatch.id,
      reason: "sourceSubmissionId 정확 일치",
    };
  }

  // 2. externalIdx가 기존 Referrals·PendingReferrals와 정확히 일치
  if (externalIdx) {
    const referralMatch = referrals.find(
      (r) =>
        r.externalReferralId === externalIdx || r.externalIdx === externalIdx,
    );
    if (referralMatch) {
      return {
        action: "link",
        referralId: referralMatch.referralId || referralMatch.id,
        reason: "externalIdx 정확 일치 (Referrals)",
      };
    }

    const pendingReferrals = getData("PendingReferrals", []);
    const pendingMatch = pendingReferrals.find(
      (p) =>
        p.externalReferralId === externalIdx || p.externalIdx === externalIdx,
    );
    if (pendingMatch) {
      return {
        action: "link",
        referralId: pendingMatch.id,
        reason: "externalIdx 정확 일치 (PendingReferrals)",
      };
    }
  }

  // 3. 이름 + 연락처 + 나이(또는 생년월일)가 일치하고 접수일 30일 이내
  const name = assessment.name;
  const phone = assessment.phone;
  const age = assessment.age;
  const birthDate = assessment.birthDate;
  const submittedAt = assessment.submittedAt
    ? new Date(assessment.submittedAt)
    : null;

  if (name && phone && (age || birthDate) && submittedAt) {
    const thirtyDaysAgo = new Date(
      submittedAt.getTime() - 30 * 24 * 60 * 60 * 1000,
    );

    // Referrals에서 후보 찾기
    const candidate = referrals.find((r) => {
      if (r.name !== name || r.phone !== phone) return false;
      if (age && r.age && String(r.age) !== String(age)) return false;
      if (birthDate && r.birthDate && r.birthDate !== birthDate) return false;
      const referralDate = r.requestDate ? new Date(r.requestDate) : null;
      if (referralDate && referralDate < thirtyDaysAgo) return false;
      return true;
    });

    if (candidate) {
      return {
        action: "candidate",
        referralId: candidate.referralId || candidate.id,
        reason: "이름+연락처+나이 일치, 접수일 30일 이내 (후보)",
      };
    }

    // PendingReferrals에서도 후보 찾기
    const pendingReferrals = getData("PendingReferrals", []);
    const pendingCandidate = pendingReferrals.find((p) => {
      if (p.name !== name || p.phone !== phone) return false;
      if (age && p.age && String(p.age) !== String(age)) return false;
      if (birthDate && p.birthDate && p.birthDate !== birthDate) return false;
      const referralDate = p.registrationDate
        ? new Date(p.registrationDate)
        : null;
      if (referralDate && referralDate < thirtyDaysAgo) return false;
      return true;
    });

    if (pendingCandidate) {
      return {
        action: "candidate",
        referralId: pendingCandidate.id,
        reason: "이름+연락처+나이 일치, 접수일 30일 이내 (후보, Pending)",
      };
    }
  }

  return { action: "none", reason: "연결 조건 미충족" };
}

/**
 * UI 필수 12개 중 없는 항목 목록 반환
 * @param {object} pendingItem - 매핑된 pending 항목
 * @returns {string[]} 없는 필드 이름 배열
 */
export function classifyMissingFields(pendingItem) {
  const missing = [];

  for (const field of UI_REQUIRED_FIELDS) {
    const value = pendingItem[field];
    if (!value || (typeof value === "string" && !value.trim())) {
      missing.push(field);
    }
  }

  return missing;
}

/**
 * 의뢰 경로 자동 분류 (스크레이퍼 규칙 재사용)
 * @param {object} raw
 * @returns {string|null}
 */
function classifyReferralPath(raw) {
  const agency = (
    raw.agency ||
    raw.requestAgency ||
    raw.requesterName ||
    ""
  ).toLowerCase();

  if (agency.includes("보건소")) return "health-center";
  if (
    agency.includes("병원") ||
    agency.includes("의원") ||
    agency.includes("의료")
  )
    return "medical-institution";
  if (agency.includes("이천시청") || agency.includes("시청"))
    return "icheon-city-hall";
  if (
    agency.includes("복지") ||
    agency.includes("센터") ||
    agency.includes("기관")
  )
    return "referral-agency";

  return "other";
}

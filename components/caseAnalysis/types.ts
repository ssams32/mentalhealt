import { MemberPerformance } from '../../types';

export type IspEvaluationResult =
  | 'NOT_EVALUATED'
  | 'FUTURE_NOT_DUE'
  | 'IN_PROGRESS'
  | 'FAIL'
  | 'SUCCESS'
  | 'WARNING';

export type IspMatchStatus =
  | 'MATCHED'
  | 'NOT_MATCHED'
  | 'INVALID_MEMBER_KEY'
  | 'AMBIGUOUS_NAME_CANDIDATES'
  | 'PARTIAL_CANDIDATE_ONLY'
  | 'NOT_FOUND'
  | 'DUPLICATE_REG_BLOCKED'
  | 'AMBIGUOUS';

export type IspMatchMethod =
  | 'NORMALIZED_MEMBER_REGISTRATION_NO'
  | 'EXACT_NAME_UNIQUE_HISTORY'
  | 'NAME_WITH_ATTRIBUTES_UNIQUE'
  | 'NONE';

export type IspDetailLevel = 'summary' | 'full' | 'debug';

export interface IspActualCountBreakdown {
  inOffice?: number;
  visit?: number;
  phone?: number;
  online?: number;
  total?: number;
  [key: string]: unknown;
}

export interface IspMonthlySegment {
  ispPlanId?: number | string;
  establishedDate?: string;
  managementType: string;
  rangeStart?: string;
  rangeEnd?: string;
  overlapDays: number;
  cycleDays?: number;
  targetCount: number;
}

export interface IspMonthlyEvaluation {
  month: number;
  managementTypeSummary: string;
  targetCount: number;
  actualCount: number;
  evaluationResult: IspEvaluationResult;
  evaluationLabel?: string;
  warningThresholdCount?: number | null;

  isPastMonth?: boolean;
  isCurrentMonth?: boolean;
  isFutureMonth?: boolean;

  segments?: IspMonthlySegment[];
  mergedSegments?: IspMonthlySegment[];
  sourceSegments?: unknown[];
  actualCountBreakdown?: IspActualCountBreakdown;
  targetPolicyReason?: string;
  audit?: unknown | null;
}

export interface IspMemberEvaluation {
  memberId?: number | string;
  memberName?: string;
  normalizedMemberName?: string | null;
  memberRegistrationNo?: string | null;
  normalizedMemberRegistrationNo?: string | null;

  ispMatched: boolean;
  ispMatchStatus: IspMatchStatus;
  ispMatchMethod: IspMatchMethod;
  ispMatchReason?: string;

  ispPlanCount?: number;
  matchedIspPlanIds?: Array<number | string>;
  ispMatchCandidates?: unknown[];

  monthly: Record<number, IspMonthlyEvaluation> | IspMonthlyEvaluation[];
}

export interface IspAchievementDiagnostics {
  year?: number;
  detailLevel?: IspDetailLevel;
  analysisStorageShape?: string;
  memberPerformanceCount?: number;
  ispPlansCount?: number;
  totalMembers?: number;
  matchByRegistrationNo?: number;
  matchByExactNameUniqueHistory?: number;
  ambiguousBySameNameMembers?: number;
  ambiguousByDifferentRegistrationNosInSameName?: number;
  notMatchedByRegistrationNoOrName?: number;
  futureMonthsSkippedEvaluation?: number;
  currentMonthsInProgress?: number;
  pastMonthsEvaluated?: number;
  cache?: {
    hit?: boolean;
    key?: string;
    generatedAt?: string;
    servedAt?: string;
    computeMs?: string | number;
    totalMs?: string | number;
  };
  payload?: {
    approxBytes?: number;
  };
  [key: string]: unknown;
}

export interface IspAchievementYearlyResponse {
  success: boolean;
  year?: number;
  detailLevel?: IspDetailLevel;
  data: Record<string, IspMemberEvaluation>;
  members?: IspMemberEvaluation[];
  diagnostics?: IspAchievementDiagnostics;
}

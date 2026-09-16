export type Role = 'admin' | 'manager' | 'user';
export type UserStatus = 'active' | 'suspended';
export type Team = '증진팀' | '회복팀' | '자살예방센터' | '아동청소년' | '남부분소';

// Menu access permissions: 'read' | 'write' | 'delete' | 'none'
export interface Permission {
    referrals: { read: boolean; write: boolean; delete: boolean };
    suicideAttempters: { read: boolean; write: boolean; delete: boolean };
    caseAnalysis: { read: boolean; write: boolean; delete: boolean };
    data: { read: boolean; write: boolean; delete: boolean };
    reports: { read: boolean; write: boolean; delete: boolean };
    budget: { read: boolean; write: boolean; delete: boolean };
    accounts: { read: boolean; write: boolean; delete: boolean };
}

export interface User {
    id: string;
    username: string; // Added for compatibility
    password?: string;
    name: string;
    role: Role;
    createdDate: string;
    lastLogin: string;
    status: UserStatus;
    team: Team;
    permissions?: Permission; // Optional for backward compatibility, defaults to role-based
}

// 담당자 목록을 위한 타입 정의
export interface Staff {
    name: string;
    team: Team;
}

export interface Log {
    logId: string;
    userId: string;
    loginTime: string;
    logoutTime: string | null;
    action?: string;
    details?: string;
    id?: string;
    timestamp?: string;
}

export interface ActivityLog {
    id: string;
    action: string;
    user: string;
    details: string;
    timestamp: string;
    logId?: string;
    userId?: string;
    loginTime?: string;
    logoutTime?: string | null;
}

export type AnyLog = Log | ActivityLog;

export interface ReferralNote {
    id: string;
    content: string;
    createdAt: string;
    author: string;
}

export interface AssetSetting {
    category: string;
    icon?: string;
    // External Referral Specific Fields
    agency?: string;
    requesterPhone?: string;
    requesterFax?: string;
    requesterEmail?: string;
    medicalInsurance?: string;
    disabilityStatus?: string;
    guardianPresence?: string;
    guardianName?: string;
    guardianRelation?: string;
    guardianPhone?: string;
    guardianNotes?: string;
    consentToReferral?: string;
    consentNotes?: string;
    problem?: string;
    color: string;
}

export interface Attachment {
    id: string;
    name: string;
    url?: string;
    type: string;
    // Base64 인코딩된 파일 데이터 (로컬 처리를 위함)
    content?: string;
    isDemo?: boolean;
    // 첨부파일별 노트를 저장하기 위한 속성
    notes?: ReferralNote[];
    size: number;
    uploadedAt: string;
}

export interface Referral {
    referralId?: string; // [v5.5 Immutable Primary Key]
    refNo: string;
    clientId: string;
    version?: number; // [v5.5 Optimistic Concurrency Control]
    createdAt?: Date | string;
    updatedAt?: Date | string;
    name: string;
    phone?: string; // 연락처 필드 추가
    gender: '남성' | '여성' | '기타';
    age: number;
    requestDate: string;
    referralPath: string;
    requestAgency: string;
    diagnosisProtectionRequest: boolean;
    writtenRequest: boolean;
    phoneRequest: boolean;
    diagnosisName: string;
    interventionContent: string;
    actionResult: string;
    closureStatus: '종결' | '미종결';
    registrationStatus?: '등록' | '미등록' | '확인중' | '해당없음'; // [v5.5 Explicit Registration Status]
    policeIntervention: boolean;
    criLevel: 'a' | 'b' | 'c' | 'd' | 'e';
    region: string;
    assignee: string;
    requestorName?: string; // 의뢰자 성명 추가
    requesterName?: string; // [호환성 필드] 의뢰자 성명
    reply: boolean;
    replyStatus?: string; // 회신 상태 (회신필요/회신완료)
    team: Team;
    subTeam?: string;
    attachments: Attachment[];
    officialDoc?: Attachment; // Added to store the official referral document
    notes: ReferralNote[];
    latestNote?: string;
    latestNoteDate?: string;
    isUnregistered?: boolean; // 미등록 대상자 여부 (모니터링 관리용)
    isWebsiteReferral?: boolean; // 홈페이지 의뢰 여부
    externalIdx?: string; // [NEW] ID for external referrals for deletion tracking
    address?: string; // 주소 필드 추가

    // External Referral Specific Fields
    agency?: string;
    requesterPhone?: string;
    requesterFax?: string;
    requesterEmail?: string;
    medicalInsurance?: string;
    disabilityStatus?: string;
    guardianPresence?: string;
    guardianName?: string;
    guardianRelation?: string;
    guardianPhone?: string;
    guardianNotes?: string;
    consentToReferral?: string;
    consentNotes?: string;
    problem?: string;
    reason?: string;

    // Website Referral Additional Metadata
    externalReferralId?: string;
    externalReceivedAt?: string;
    websiteReferralSeenAt?: string;
    firstScrapedAt?: string;
    lastSyncedAt?: string;
}

export interface WebsiteReferralItem {
    id: string;
    externalIdx: string;
    externalReferralId?: string;
    name: string;
    phone?: string;
    gender?: string;
    age?: number | string;
    birthDate?: string;
    address?: string;
    agency?: string;
    agencyPhone?: string;
    requesterName?: string;
    requesterPhone?: string;
    problem?: string;
    reason?: string;
    externalReceivedAt: string;
    firstScrapedAt?: string;
    lastSyncedAt?: string;
    referralPath?: string;
    isWebsiteReferral: boolean;
    status: 'pending' | 'processing' | 'completed';
    isSeen: boolean;
    websiteReferralSeenAt?: string | null;
    refNo?: string;
    source?: 'pending' | 'registered';
    [key: string]: any;
}

export interface WebsiteReferralSummary {
    success: boolean;
    periodStart: string;
    total: number;
    unseen: number;
    pending: number;
    processing: number;
    completed: number;
    failedDetailCount: number;
    lastSuccessfulSyncAt: string | null;
    lastSyncStatus?: 'success' | 'failed' | 'idle';
    lastSyncError?: string | null;
    syncInProgress?: boolean;
    items: WebsiteReferralItem[];
}

// 노트 데이터 구조를 정의하는 인터페이스
export interface Note {
    id: string;
    title: string;
    content: string;
    createdAt: string;
    updatedAt: string;
    author: string;
    attendees: string[];
    icon?: string;
    summary?: string;
    type?: 'shared' | 'private';
    isFavorite?: boolean;
}



export interface SuicideAttempterReferral {
    uid: string;
    sn?: string;
    requestAgency: string;
    pic: string;
    name: string;
    receiptDate: string;
    gender: '남성' | '여성' | '기타' | string;
    birthDate: string;
    age: number;
    // `details`를 `notes` 배열로 대체
    notes: ReferralNote[];
    infoTarget: string;
    processingStatus: '서비스동의' | '거부' | '처리중' | '개인정보파기';
    disposalReason: '개인정보파기요청' | '기타' | '부재' | '서비스거부' | '연락처오류' | '';
    interventionStatus: '일반상담(미등록)' | '자살위기지원서비스(등록_미등록)' | '퇴록(등록)' | '연계(등록)' | '';
    registrationStatus: '등록' | '미등록' | '확인중' | '기등록' | '기등록자' | '종결';
    region: string;
    assignee: string;
    // 첨부파일 배열 추가
    attachments: Attachment[];
    // diagnosisName?: string; // Removed per user request
    phoneNumber?: string;
    address?: string;
    privacyAcquisitionDate?: string;
}

export interface ToDo {
    id: string;
    content: string;
    isCompleted: boolean;
    dueDate?: string; // YYYY-MM-DD
    assignee?: string;
    linkedEventId?: string; // Google Calendar Event ID
}

export interface CalendarEvent {
    id: string;
    title: string;
    start: string;
    end?: string;
    allDay?: boolean;
    resourceId?: string;
    backgroundColor?: string;
    extendedProps?: {
        description?: string;
        status?: string;
    };
}

export type Page = 'home' | 'referrals' | 'suicideAttempters' | 'caseAnalysis' | 'data' | 'reports' | 'accounts' | 'calendar' | 'budget'
    | 'aiNotepad' | 'assets' | 'antiGravity' | 'voiceCalls';

export interface VoiceCallItem {
    id: string;
    originalFileName: string;
    callerPhoneNumber?: string;
    clientName?: string;
    fileSize: number;
    durationSeconds?: number;
    mimeType?: string;
    storageKey?: string;
    intakeSource?: string;
    contentHash?: string;
    validationStatus?: string;
    processingStatus?: string;
    callCategory?: 'clinical' | 'administrative' | 'mixed' | 'unknown';
    callRecordType?: 'administrative_call' | 'individual_counseling' | 'intake_counseling' | null;
    classificationStatus?: 'pending' | 'classified';
    classificationMethod?: 'staff_selected' | 'staff_corrected' | null;
    classifiedByUserId?: string;
    classifiedByUserName?: string;
    classifiedAt?: string;
    assignedDepartmentId?: string;
    assignedUserId?: string;
    assignedUserName?: string;
    assignmentStatus?: 'unassigned' | 'recommended' | 'assigned' | 'reassigned';
    assignmentChangedAt?: string;
    referralId?: string;
    refNo?: string;
    clientId?: string;
    subjectLinkStatus?: 'unlinked' | 'linked';
    notes?: string;
    receivedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface PageConfig {
    title: string;
    icon?: string;
    color: string;
    bg?: string;
    activeBg: string;
    activeText: string;
}

// Types for Case Analysis System
export interface CounselorPerformance {
    counselorName: string;
    department: string;
    types: {
        inOffice: number;
        visit: number;
        online: number;
        emergency: number;
        phone: number;
    };
    faceToFaceSessions: { date: string }[];
    // New field for granular analysis
    allSessions: { date: string; type: 'inOffice' | 'visit' | 'online' | 'emergency' | 'phone'; category?: 'individual' | 'resource' | 'general' }[];
    totalSessions: number;
    totalEmergency: number;
    totalGeneral: number;
}

export interface MemberPerformance {
    memberName: string;
    registrationNo?: string;
    department: string;
    mainCounselor: string;
    totalSessions: number;
    // Granular session data for detailed analysis
    detailedSessions: {
        month: number;
        category: 'individual' | 'resource';
        type: 'inOffice' | 'visit' | 'online' | 'phone';
    }[];
}

export interface ISPExpiringMember {
    id: string;
    name: string;
    registrant: string;
    date: string;
    daysPassed: number;
    rowNum: number;
}

export interface IspPlan {
    registrationNo: string;
    normalizedRegistrationNo: string;
    memberName: string;
    normalizedName: string;
    managementCategory: string;
    establishedDate: string;
    gender?: string;
    birthDate?: string;
    excelRowNumber?: number;
    parseStatus?: 'success' | 'warning' | 'error';
    parseIssues?: string[];
}

export interface AnalysisResult {
    counselorPerformance: CounselorPerformance[];
    memberPerformance: MemberPerformance[];
    ispExpiringMembers: ISPExpiringMember[];
    ispPlans: IspPlan[];
    ispAchievement?: any[]; // Defined as any[] for legacy support, use specialized types for new features
}

export interface BudgetTransaction {
    id: string;
    // 원본 데이터
    approvalNo: string; // 품의번호
    type: string; // 품의유형
    description: string; // 적요(거래처)
    amount: number; // 품의금액
    balance: number; // 품의잔액
    resolutionLink: string; // 결의연계
    projectCode: string; // 사업코드
    projectName: string; // 사업명
    fundingSource: string; // 자금원천
    budgetItem: string; // 예산과목
    approvalStatus: string; // 승인(결재)
    writer: string; // 작성자

    // 파생 데이터
    date: string; // 작성일 (YYYY-MM-DD)
    year: number;
    month: number;
    quarter: number;
    vendor: string; // 거래처
    department: string; // 부서명
}

export interface BudgetFilter {
    department?: string[];
    projectName?: string[];
    budgetItem?: string[];
    fundingSource?: string[];
    type?: string[];
    approvalStatus?: string[];
    writer?: string[];
    resolutionLink?: string[];
    vendorKeyword?: string;
    minAmount?: number;
    maxAmount?: number;
    startDate?: string;
    endDate?: string;
}

export interface BudgetPreset {
    id: string;
    name: string;
    description: string;
    filter: BudgetFilter;
    creator: string;
    createdAt: string;
    scope: 'all' | 'department' | 'private';
}

// ============================================================
// 🎙️ TRACK A3/A4: VOICE CALL DOMAIN MODEL & METADATA CONTRACTS
// ============================================================

export type ProcessingStatus =
    | 'received'
    | 'validating'
    | 'rejected'
    | 'queued'
    | 'capacity_waiting'
    | 'transcribing'
    | 'summarizing'
    | 'routing'
    | 'review_required'
    | 'ready'
    | 'retrying'
    | 'failed'
    | 'completed';

export type CallCategory =
    | 'clinical'
    | 'administrative'
    | 'mixed'
    | 'unknown';

export type AssignmentStatus =
    | 'unassigned'
    | 'recommended'
    | 'assigned'
    | 'reassigned';

export type ReviewStatus =
    | 'not_started'
    | 'ai_draft'
    | 'in_review'
    | 'revision_required'
    | 'confirmed';

export type IntakeValidationStatus =
    | 'pending'
    | 'valid'
    | 'duplicate'
    | 'unsupported'
    | 'corrupted'
    | 'oversized'
    | 'duration_exceeded'
    | 'content_mismatch'
    | 'quarantined';

export type AudioIntakeSource =
    | 'browser_upload'
    | 'browser_recording'
    | 'nas_ingest'
    | 'internal_api';

export type DiarizationMode =
    | 'model'
    | 'channel'
    | 'none';

export interface VoiceCallRecord {
    id: string;
    intakeSource: AudioIntakeSource;
    intakeReference?: string;
    originalFileName: string;
    storageKey?: string;
    contentHash: string;
    mimeType: string;
    fileSize: number;
    durationSeconds?: number;
    validationStatus: IntakeValidationStatus;
    rejectionCode?: string;
    processingStatus: ProcessingStatus;
    callCategory: CallCategory;
    classificationConfidence?: number;
    requiresHumanReview: boolean;
    subjectType?: 'referral' | 'suicide_attempter' | 'unregistered_client';
    subjectId?: string;
    referralId?: string;
    recommendedDepartmentId?: string;
    recommendedAssigneeId?: string;
    assignedDepartmentId?: string;
    assignedUserId?: string;
    assignmentStatus: AssignmentStatus;
    reviewStatus: ReviewStatus;
    activeProcessingRevisionId?: string;
    transcriptStorageKey?: string;
    receivedAt: string;
    processedAt?: string;
    confirmedAt?: string;
    confirmedBy?: string;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
    version: number;
    isDeleted: boolean;
    deletedAt?: string;
}

export interface TranscriptSegment {
    id?: string;
    sequence: number;
    startSeconds: number;
    endSeconds: number;
    text: string;
    speakerLabel?: string;
    confidence?: number;
}

export interface VoiceCallTranscript {
    id: string;
    callId: string;
    detectedLanguage: string;
    languageConfidence?: number;
    text: string;
    segments: TranscriptSegment[];
    sttEngine: string;
    sttModel: string;
    sttModelVersion?: string;
    sttModelDigest?: string;
    diarizationMode: DiarizationMode;
    createdAt: string;
    updatedAt: string;
    version: number;
}

export interface ProcessingRevision {
    id: string;
    callId: string;
    revisionNumber: number;
    status: 'draft' | 'active' | 'superseded' | 'failed';
    sttEngine: string;
    sttModel: string;
    sttModelDigest?: string;
    llmProvider: string;
    llmModel: string;
    llmModelDigest?: string;
    promptId: string;
    promptVersion: string;
    schemaVersion: string;
    callCategory: CallCategory;
    classificationConfidence: number;
    requiresHumanReview: boolean;
    aiSummary: string;
    aiKeyPoints: string[];
    aiRequestedActions: string[];
    safetyFlags: string[];
    recommendedDepartmentId?: string;
    recommendedAssigneeId?: string;
    detectedLanguage: string;
    diarizationMode: DiarizationMode;
    validationResult?: 'pass' | 'warning' | 'fail';
    validationErrors?: Array<{ field: string; message: string }>;
    retryCount: number;
    startedAt: string;
    completedAt?: string;
    createdAt: string;
}

export interface CallSummaryReview {
    id: string;
    callId: string;
    processingRevisionId: string;
    aiSummarySnapshot: string;
    reviewedSummary: string;
    aiKeyPointsSnapshot: string[];
    reviewedKeyPoints: string[];
    aiRequestedActionsSnapshot: string[];
    reviewedRequestedActions: string[];
    reviewStatus: ReviewStatus;
    reviewedBy: string;
    reviewedAt: string;
    createdAt: string;
    updatedAt: string;
    version: number;
}

export interface AssignmentHistoryEntry {
    id: string;
    callId: string;
    previousUserId?: string;
    nextUserId?: string;
    previousDepartmentId?: string;
    nextDepartmentId?: string;
    reason?: string;
    assignedBy: string;
    assignedAt: string;
    resultingVersion: number;
}

export interface ReconciliationIssue {
    checkCode: string;
    severity: 'error' | 'warning' | 'info';
    resourceType: 'voice_call' | 'transcript' | 'processing_revision' | 'summary_review' | 'assignment_history';
    resourceId: string;
    repairable: boolean;
    safeMessage: string;
}

export interface ReconciliationReport {
    timestamp: string;
    totalRecords: number;
    issuesCount: number;
    issues: ReconciliationIssue[];
}

export interface AudioIntakeConfig {
    temporaryRoot: string;
    quarantineRoot?: string;
    minFileBytes?: number;
    maxFileBytes?: number;
    maxDurationSeconds?: number;
}

export interface AudioIntakeResult {
    intakeId: string;
    voiceCallId: string | null;
    temporaryStorageKey: string | null;
    originalFileName: string;
    normalizedFileName: string;
    declaredMimeType?: string;
    detectedMimeType: string | null;
    detectedFormat: string | null;
    fileSize: number;
    contentHash: string;
    durationSeconds: number | null;
    durationValidationStatus: 'pending' | 'exact' | 'estimated' | 'unavailable' | 'exceeded';
    processingStatus?: ProcessingStatus;
    validationStatus: IntakeValidationStatus;
    rejectionCode?: string;
    duplicateOfCallId?: string;
    receivedAt: string;
    validatedAt: string;
}

export type StoragePromotionStatus =
    | 'not_started'
    | 'pending'
    | 'copying'
    | 'verifying'
    | 'linked'
    | 'incomplete'
    | 'failed'
    | 'quarantined';

export type MediaValidationStage =
    | 'signature_only'
    | 'structural'
    | 'pending_decode'
    | 'decoded'
    | 'rejected';

export interface PublicAudioIntakeResult {
    intakeId: string;
    status: 'accepted' | 'rejected' | 'duplicate';
    validationStatus: IntakeValidationStatus;
    mediaValidationStage: MediaValidationStage;
    messageCode: string;
    fileSize?: number;
    declaredMimeType?: string | null;
    detectedFormat?: string | null;
    warnings: string[];
    receivedAt: string;
    validatedAt: string;
}

export interface PrivateAudioStorageConfig {
    privateAudioRoot: string;
    quarantineAudioRoot?: string;
    temporaryAudioRoot: string;
    minimumFreeSpaceBytes?: number;
    maxSingleFileBytes?: number;
}

export interface AudioPromotionResult {
    status: 'promoted' | 'already_promoted';
    callId: string;
    storageKey: string;
    version: number;
    fileSize?: number;
    contentHash?: string;
    usedCopyFallback?: boolean;
    idempotent?: boolean;
    promotedAt?: string;
}

export type StreamingDispositionType = 'inline' | 'attachment';

export interface ParsedByteRange {
    type: 'full' | 'range';
    start: number;
    end: number;
    length: number;
}

export interface AudioStreamingAuditEvent {
    id: string;
    eventType: string;
    resourceType: 'voice_call';
    resourceId: string;
    actorUserId: string;
    outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
    reasonCode?: string;
    occurredAt: string;
}

// --- Track A8: Persistent Job Queue Types ---
export type VoiceCallJobStatus =
    | 'queued'
    | 'leased'
    | 'processing'
    | 'retry_wait'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'blocked';

export type VoiceCallJobType =
    | 'audio_decode_validation'
    | 'stt_transcription'
    | 'llm_classification'
    | 'routing'
    | 'reconciliation'
    | 'synthetic_noop'
    | 'synthetic_test';

export type VoiceCallJobPriority = 'urgent' | 'high' | 'normal';

export interface VoiceCallJob {
    id: string;
    callId: string;
    jobType: VoiceCallJobType;
    status: VoiceCallJobStatus;
    idempotencyKey: string;
    pipelineRevision: number;
    priority: VoiceCallJobPriority;
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: string | null;
    leaseOwner: string | null;
    leaseTokenHash: string | null;
    leaseAcquiredAt: string | null;
    leaseExpiresAt: string | null;
    heartbeatAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    failedAt: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    resultReference: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
    version: number;
}

// --- Track A9: Persistent Notifications and Outbox Types ---
export type NotificationStatus = 'unread' | 'read' | 'archived' | 'expired';
export type NotificationSeverity = 'info' | 'warning' | 'action_required';

export type NotificationType =
    | 'voice_call_received'
    | 'voice_call_ready_for_review'
    | 'voice_call_assigned'
    | 'voice_call_reassigned'
    | 'voice_call_processing_failed'
    | 'voice_call_review_requested'
    | 'system_configuration_required';

export interface NotificationRecord {
    id: string;
    recipientUserId: string;
    type: NotificationType;
    resourceType: string;
    resourceId: string;
    messageCode: string;
    severity: NotificationSeverity;
    status: NotificationStatus;
    deduplicationKey: string;
    sourceOutboxEventId: string | null;
    safeMetadata: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
    deliveredAt: string;
    readAt: string | null;
    archivedAt: string | null;
    expiresAt: string | null;
    version: number;
}

export type OutboxStatus =
    | 'pending'
    | 'leased'
    | 'dispatching'
    | 'retry_wait'
    | 'delivered'
    | 'failed'
    | 'cancelled'
    | 'blocked';

export interface NotificationOutboxEvent {
    id: string;
    eventType: NotificationType;
    aggregateType: string;
    aggregateId: string;
    recipientUserId: string;
    sourceVersion: number;
    deduplicationKey: string;
    payload: Record<string, unknown>;
    status: OutboxStatus;
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: string | null;
    leaseOwner: string | null;
    leaseTokenHash: string | null;
    leaseAcquiredAt: string | null;
    leaseExpiresAt: string | null;
    heartbeatAt: string | null;
    deliveredNotificationId: string | null;
    lastErrorCode: string | null;
    createdAt: string;
    updatedAt: string;
    deliveredAt: string | null;
    failedAt: string | null;
    cancelledAt: string | null;
    version: number;
}

// ============================================================
// TRACK A10: ASSIGNMENT AND ROUTING DOMAIN TYPES
// ============================================================

export type AssignmentOperationStatus =
    | 'pending'
    | 'call_updated'
    | 'history_recorded'
    | 'outbox_recorded'
    | 'completed'
    | 'incomplete'
    | 'failed'
    | 'conflict';

export interface AssignmentCommand {
    callId: string;
    operationId: string;
    expectedVersion: number;
    requestedDepartmentId: string;
    requestedUserId: string;
    reasonCode: string;
    noteCode?: string;
}

export interface AssignmentOperationRecord {
    id: string;
    operationId: string;
    callId: string;
    actorUserId: string;
    requestedDepartmentId: string;
    requestedUserId: string;
    expectedVersion: number;
    reasonCode?: string;
    requestFingerprint?: string;
    status: AssignmentOperationStatus;
    resultingCallVersion: number | null;
    historyRecordId: string | null;
    outboxEventId: string | null;
    lastErrorCode: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    version: number;
}

export interface AssignableUserSummary {
    id: string;
    role: string;
    canonicalDepartmentId: string | null;
    isActive: boolean;
    isDeleted: boolean;
    isSuspended: boolean;
    isAssignable: boolean;
}

// ============================================================
// TRACK A11: PERSISTENT AUDIT LOG DOMAIN TYPES
// ============================================================

export type AuditCategory =
    | 'authentication'
    | 'authorization'
    | 'audio_access'
    | 'assignment'
    | 'notification'
    | 'outbox'
    | 'job'
    | 'storage'
    | 'system';

export type AuditActorType = 'user' | 'worker' | 'system' | 'anonymous';

export type AuditOutcome =
    | 'success'
    | 'denied'
    | 'failed'
    | 'incomplete'
    | 'conflict'
    | 'blocked'
    | 'aborted';

export interface AuditEntry {
    id: string;
    sequence: number;
    schemaVersion: number;
    eventType: string;
    category: AuditCategory;
    actorType: AuditActorType;
    actorId: string | null;
    resourceType: string;
    resourceId: string;
    operationId: string | null;
    outcome: AuditOutcome;
    reasonCode: string | null;
    beforeVersion: number | null;
    afterVersion: number | null;
    occurredAt: string;
    recordedAt: string;
    previousEntryHash: string;
    entryHash: string;
    safeMetadata: Record<string, unknown> | null;
}

export interface AuditHead {
    schemaVersion: number;
    lastSequence: number;
    lastEntryHash: string;
    updatedAt: string;
}

// ============================================================
// TRACK A12: OPERATIONAL READINESS, JOYCALL SYNC & NAS INTAKE
// ============================================================

export type OperationalStatus =
    | 'ready'
    | 'disabled'
    | 'unconfigured'
    | 'degraded'
    | 'corrupted'
    | 'unavailable'
    | 'blocked';

export type JoyCallSyncStatus =
    | 'PENDING'
    | 'UPLOADING'
    | 'COMPLETED'
    | 'FAILED'
    | 'SKIPPED_DUPLICATE';

export interface JoyCallTransferManifestRecord {
    filename: string;
    sha256: string;
    sizeBytes: number;
    destinationFilename: string;
    status: JoyCallSyncStatus;
    completedAt?: string;
    failedAt?: string;
    error?: string;
}

export type JoyCallIntakeProcessingStatus =
    | 'pending'
    | 'validating'
    | 'stored'
    | 'rejected'
    | 'duplicate';

export type JoyCallClassificationStatus =
    | 'pending'
    | 'classified';

export type JoyCallCanonicalRecordType =
    | 'administrative_call'
    | 'individual_counseling'
    | 'intake_counseling';

export type JoyCallCanonicalClassificationMethod =
    | 'staff_selected'
    | 'staff_corrected';

export type JoyCallLinkStatus =
    | 'unlinked'
    | 'linked';

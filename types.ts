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
    refNo: string;
    clientId: string;
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
    policeIntervention: boolean;
    criLevel: 'a' | 'b' | 'c' | 'd' | 'e';
    region: string;
    assignee: string;
    requestorName?: string; // 의뢰자 성명 추가
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
    requesterName?: string;
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
    | 'aiNotepad' | 'assets' | 'antiGravity';

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

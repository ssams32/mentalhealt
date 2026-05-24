
import { User, Referral, SuicideAttempterReferral, PageConfig, Team, Staff } from './types';

export const initialUsers: User[] = [
    { id: 'admin', username: 'admin', password: '1234', name: '시스템관리자', role: 'admin', createdDate: '2025-01-01', lastLogin: '2025-11-15 14:30:00', status: 'active', team: '증진팀' },
    { id: 'manager1', username: 'manager1', password: 'manager123', name: '김관리자', role: 'manager', createdDate: '2025-01-15', lastLogin: '2025-11-14 16:20:00', status: 'active', team: '회복팀' },
    { id: 'user1', username: 'user1', password: 'user123', name: '박상담사', role: 'user', createdDate: '2025-02-01', lastLogin: '2025-11-13 09:15:00', status: 'active', team: '증진팀' },
    { id: 'user_jin', username: 'user_jin', password: 'user123', name: '김화자-증진팀', role: 'user', createdDate: '2025-03-01', lastLogin: '2025-11-16 10:00:00', status: 'active', team: '증진팀' }
];

// 담당자 선택 드롭다운에 사용될 직원 목록
export const STAFF_LIST: Staff[] = [
    { name: '김화자', team: '증진팀' },
    { name: '박상담사', team: '증진팀' },
    { name: '김관리자', team: '회복팀' },
    { name: '최상담사', team: '아동청소년' },
    { name: '김상담사', team: '자살예방센터' },
    { name: '정상담사', team: '증진팀' },
    { name: '송상담사', team: '남부분소' },
];


export const ICHEON_REGIONS = ["장호원읍", "부발읍", "신둔면", "백사면", "호법면", "마장면", "대월면", "모가면", "설성면", "율면", "창전동", "증포동", "중리동", "관고동", "기타"];
export const DIAGNOSIS_OPTIONS = ['우울증', '조현병', '조울증', '물질중독', '불안장애', '아동기정신질환 및 정신건강문제', '행위중독', '치매', '구분하기 어려움', '기타질환'];
export const CRI_LEVELS: Record<'a' | 'b' | 'c' | 'd' | 'e', string> = { a: 'A등급(위기)', b: 'B등급(고위험)', c: 'C등급(중위험)', d: 'D등급(저위험)', e: 'E등급(관찰)' };
export const GENDER_OPTIONS: ('남성' | '여성' | '기타')[] = ['남성', '여성', '기타'];
export const DISPOSAL_REASON_OPTIONS = ['기타', '부재', '서비스거부', '연락처오류'];
export const PROCESSING_STATUS_OPTIONS = ['서비스동의', '거부', '처리중', '개인정보파기'];
export const REGISTRATION_STATUS_OPTIONS = ['등록', '미등록', '확인중', '기등록', '기등록자', '종결'];
export const INTERVENTION_STATUS_OPTIONS = ['일반상담(미등록)', '자살위기지원서비스(등록_미등록)', '퇴록(등록)', '연계(등록)'];
export const ACTION_RESULT_OPTIONS = ['기타조치', '등록관리(기등록 포함)', '서비스연계', '정보제공', '종결', '지속상담', '처리중', '치료연계'];
export const INFO_TARGET_OPTIONS = ['자살시도자', '자살시도자 가족', '자살유족'];

export const REFERRAL_PATH_OPTIONS = [
    '가족', '경찰서', '소방', '의료기관', '기타', '본인', '읍면동 행정복지센터', '의뢰기관',
    '이천시청', '정신보건기관', '보건소', '지역사회복지관', '지인', '게이트키퍼'
];

export const AGE_BRACKETS = ['10대', '20대', '30대', '40대', '50대', '60대', '70대', '80대 이상', '미상'];
export const MONTH_LABELS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

export const INTERVENTION_GUIDE_TEXT = `자살시도력 : (+) 1st 2022년 1월 Wrist cutting, 2nd 2022년 2월 농약음독 , 3rd 2022 7월 투신하려다 경찰신고
정신과 약물복용 및  치료여부: 2022년 1월 수원아주다남병원 응급입원 후 퇴원, 2022년 원주기독병원 위세척 후 귀가. 입원에 거부적이며 2월까지정신과 약물 복용했으나 2022년 6월 임의 중단
음주여부 : 매일 소주 2병씩 /  식사 및 수면 : 2~3시간 잤다가 깨어남.  
진단명 : 양극성 정동장애
약물 : (아침) 아리피졸정 2mg, 명인벤즈트로핀메실레이트정 1mg, 데파킨크로노정 300mg, 리보트릴정, 스리반정 0.5mg
(저녁) 데타킨크로노정 300mg, 팔리스펜서방정3mg, 리보트릴정, 스리반정 0.5mg 
외래병원 : 하은정신의학과의원
보호요인 : 거북이  /  지지체계 : 초등학교 동창생
주호소 및 개입내용 : 1인 가구이며 고등학교 졸업 후 이천으로 왔으나 뚜렷한 직장없이 집에서 은둔. 최근 2개월간 무분별한 지출과 폭음 증가. 정신과적 문제가 있으나 약물을 임의 중단하여 하은정신의학과의원에 연계하였으며 주 1회 외래동행하여 상담 및 약물 처방 중, 경제적 문제로 이천시청에서 경기도형 긴급생계비 지원, 신체치료(어깨 탈골)을 위해 이천의료원 공공사업과 자원 연계
현상황 : 등록을 위해 초기 상담 중`;

export const initialReferrals: Referral[] = [];

export const initialSuicideAttempterReferrals: SuicideAttempterReferral[] = [];

export const PAGES_CONFIG: Record<string, PageConfig> = {
    home: { title: '홈', icon: 'fa-solid fa-house', color: 'text-indigo-600', bg: 'bg-indigo-50', activeBg: 'bg-indigo-100', activeText: 'text-indigo-700' },
    referrals: { title: '의뢰 관리', icon: 'fa-solid fa-users', color: 'text-blue-600', bg: 'bg-blue-50', activeBg: 'bg-blue-100', activeText: 'text-blue-700' },
    suicideAttempters: { title: '자살시도자', icon: 'fa-solid fa-heart-pulse', color: 'text-rose-500', bg: 'bg-rose-50', activeBg: 'bg-rose-100', activeText: 'text-rose-700' },
    caseAnalysis: { title: '사례 분석 시스템', icon: 'fa-solid fa-magnifying-glass-chart', color: 'text-purple-600', bg: 'bg-purple-50', activeBg: 'bg-purple-100', activeText: 'text-purple-700' },
    data: { title: '데이터 관리', icon: 'fa-solid fa-database', color: 'text-emerald-600', bg: 'bg-emerald-50', activeBg: 'bg-emerald-100', activeText: 'text-emerald-700' },
    reports: { title: '통계/보고서', icon: 'fa-solid fa-chart-pie', color: 'text-amber-500', bg: 'bg-amber-50', activeBg: 'bg-amber-100', activeText: 'text-amber-700' },

    budget: {
        title: '예산 관리',
        color: 'text-cyan-600',
        activeBg: 'bg-cyan-50',
        activeText: 'text-cyan-700'
    },
    calendar: {
        title: '일정 관리',
        color: 'text-indigo-600',
        activeBg: 'bg-indigo-50',
        activeText: 'text-indigo-700'
    },
    accounts: {
        title: '계정 관리',
        color: 'text-slate-600',
        activeBg: 'bg-slate-100',
        activeText: 'text-slate-900'
    },
    assets: {
        title: '자산 관리',
        icon: 'fa-solid fa-map',
        color: 'text-orange-600',
        bg: 'bg-orange-50',
        activeBg: 'bg-orange-100',
        activeText: 'text-orange-700'
    },
    antiGravity: {
        title: '안티그래비티',
        icon: 'fa-solid fa-rocket',
        color: 'text-indigo-600',
        bg: 'bg-indigo-50',
        activeBg: 'bg-indigo-600',
        activeText: 'text-white'
    }
    /*
        officialDocuments: {
            title: '공문수발',
            icon: 'fa-solid fa-file-invoice',
            color: 'text-indigo-600',
            bg: 'bg-indigo-50',
            activeBg: 'bg-indigo-100',
            activeText: 'text-indigo-700'
        }
    */
};

export const TEAMS_CONFIG: Record<Team, { title: string, icon: string }> = {
    '증진팀': { title: '증진팀', icon: 'fa-bullseye' },
    '회복팀': { title: '회복팀', icon: 'fa-seedling' },
    '자살예방센터': { title: '자살예방센터', icon: 'fa-truck-medical' },
    '아동청소년': { title: '아동청소년', icon: 'fa-child' },
    '남부분소': { title: '남부분소', icon: 'fa-building' }
};

export const ALL_TEAMS: Team[] = Object.keys(TEAMS_CONFIG) as Team[];
export const MAIN_TEAMS: Team[] = ['증진팀', '회복팀', '자살예방센터', '아동청소년', '남부분소'];

export const TEAM_CODES: Record<Team, string> = {
    '증진팀': 'JJ',
    '회복팀': 'HB',
    '자살예방센터': 'JY',
    '아동청소년': 'AC',
    '남부분소': 'NB'
};

export const NAMBU_SUB_TEAMS = ['회복', '아청', '자살', '청년'];

export const REFERRAL_EXCEL_HEADERS: Record<keyof Omit<Referral, 'createdAt' | 'updatedAt' | 'clientId' | 'latestNoteDate' | 'isWebsiteReferral' | 'externalIdx' | 'address' | 'problem' | 'medicalInsurance' | 'disabilityStatus' | 'guardianPresence' | 'guardianName' | 'guardianRelation' | 'guardianPhone' | 'guardianNotes' | 'consentToReferral' | 'consentNotes' | 'agency' | 'requesterEmail' | 'requesterFax' | 'requesterName' | 'requesterPhone' | 'reason'>, string> = {
    refNo: '의뢰번호', name: '이름', phone: '연락처', gender: '성별', age: '나이',
    requestDate: '의뢰일', team: '담당팀', subTeam: '세부팀', assignee: '담당자',
    region: '지역', referralPath: '의뢰경로', requestAgency: '의뢰기관',
    diagnosisName: '진단명', criLevel: '위험도(CRI)', actionResult: '조치결과',
    closureStatus: '종결상태', interventionContent: '개입내용',
    diagnosisProtectionRequest: '진단/보호의뢰', writtenRequest: '공문접수',
    phoneRequest: '전화접수', policeIntervention: '경찰동행', reply: '회신여부',
    replyStatus: '회신상태', attachments: '첨부파일 수', notes: '노트', latestNote: '최근 노트',
    requestorName: '의뢰자 성명', isUnregistered: '미등록 여부', officialDoc: '의뢰공문'
};

// 'notes'와 'attachments'를 포함하도록 수정하고 '고유번호'를 '의뢰번호'로 변경
export const SA_EXCEL_HEADERS: Record<keyof Omit<SuicideAttempterReferral, 'details'>, string> = {
    uid: '의뢰번호', sn: '일련번호', name: '이름', receiptDate: '접수일자', gender: '성별',
    age: '나이', birthDate: '생년월일', region: '지역',
    requestAgency: '의뢰기관', pic: '기관 담당자', infoTarget: '정보제공대상',
    processingStatus: '처리구분', disposalReason: '미동의/미연계 사유',
    interventionStatus: '개입현황', registrationStatus: '등록여부',
    assignee: '담당자', notes: '최근 노트', attachments: '첨부파일 수',
    phoneNumber: '전화번호', address: '주소', privacyAcquisitionDate: '개인정보동의일'
};
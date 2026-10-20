import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

/**
 * 사례분석시스템 샘플 양식 다운로드
 *
 * analyzeAllFiles(excelAnalysisService.ts)가 요구하는 6종 파일의 양식 샘플을 생성한다.
 * - 파일명은 파서의 파일명 정규식(1.개별상담 / 2.자원조정 / 3.일반상담 / 4.등퇴록대장 / 5.ISP수립 / 6.팀구별)에 맞춘다.
 * - 1·2번 파일은 열 위치(A=회원번호, C=상담자, G=성명, J=응급개입, K=상담유형, L=상담일) 기준으로 파싱된다.
 * - 3번 파일은 D=상담일, N=상담자, AH=상담유형 열을 사용한다.
 * - 5번 파일은 헤더명(회원등록번호·성명·관리구분·수립일 등) 기준으로 파싱된다.
 * - 회원 예시는 관리구분 3종(집중관리·유지관리·일시관리)을 골고루 포함하고,
 *   월 목표 기준(집중 월 4회 / 유지 월 1회 / 일시 월 1회, 개별상담+자원조정 합산)에 맞춰 세션을 배치했다.
 * - 모든 데이터는 가짜 예시 데이터다.
 */

const downloadWorkbook = (fileName: string, sheetName: string, rows: any[][], colWidths?: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (colWidths) {
        ws['!cols'] = colWidths.map(w => ({ wch: w }));
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([out], { type: 'application/octet-stream' }), fileName);
};

// 상담자(6.팀구별)와 회원 예시 — 6개 파일이 서로 맞물리는 하나의 작은 예시 데이터셋
const COUNSELORS: [string, string][] = [
    ['김민수', '증진팀'],
    ['이영희', '증진팀'],
    ['박준호', '회복팀'],
    ['최서연', '아동청소년'],
    ['정다은', '자살예방센터'],
];

// 회원 예시: [회원번호, 성명, 성별, 생년월일, 연령, 진단명, 관리구분, 담당자]
// 관리구분 월 목표 (ISP 기준): 집중관리 월 4회 / 유지관리 월 1회 / 일시관리 월 1회 (개별상담+자원조정 합산)
const MEMBERS = {
    김철수: { regNo: '2026001', gender: '남', birth: '1985-03-12', age: 41, diag: '우울장애', category: '집중관리', counselor: '김민수' },
    이영자: { regNo: '2026002', gender: '여', birth: '1990-07-25', age: 36, diag: '불안장애', category: '일시관리', counselor: '이영희' },
    박민준: { regNo: '2026003', gender: '남', birth: '1978-11-02', age: 48, diag: '조현병', category: '집중관리', counselor: '박준호' },
    최지현: { regNo: '2026004', gender: '여', birth: '2001-05-18', age: 25, diag: '적응장애', category: '유지관리', counselor: '최서연' },
    정수민: { regNo: '2026005', gender: '남', birth: '1995-09-30', age: 31, diag: '우울장애', category: '유지관리', counselor: '정다은' },
    한미래: { regNo: '2026006', gender: '여', birth: '1988-12-05', age: 38, diag: '불안장애', category: '일시관리', counselor: '정다은' },
} as const;
type MemberName = keyof typeof MEMBERS;

// 1·2번 공통 양식: A 회원번호 / B 연락처 / C 상담자 / D 상담구분 / E 진단명 / F 상담장소 / G 성명 / H 연령 / I 성별 / J 응급개입 / K 상담유형 / L 상담일
const SESSION_HEADER = ['회원번호', '연락처', '상담자', '상담구분', '진단명', '상담장소', '성명', '연령', '성별', '응급개입', '상담유형', '상담일'];
const sessionRow = (name: MemberName, counselor: string, emergency: string, type: string, date: string) => {
    const m = MEMBERS[name];
    return [m.regNo, '010-0000-0000', counselor, '정기상담', m.diag, '센터', name, m.age, m.gender, emergency, type, date];
};

const buildTeamFile = (): [string, string, any[][]] => [
    '6.팀구별.xlsx', '팀구별',
    [['상담사', '부서'], ...COUNSELORS],
];

const buildIndividualFile = (): [string, string, any[][]] => [
    '1.개별상담.xlsx', '개별상담',
    [
        SESSION_HEADER,
        // 김철수 (집중관리, 월 4회 이상 목표): 8월 4회 / 9월 3회 / 10월 2회 — 자원조정과 합산해 8·9월 달성
        sessionRow('김철수', '김민수', 'N', '내소', '2026-08-05'),
        sessionRow('김철수', '김민수', 'N', '방문', '2026-08-12'),
        sessionRow('김철수', '김민수', 'N', '내소', '2026-08-19'),
        sessionRow('김철수', '김민수', 'N', '방문', '2026-08-28'),
        sessionRow('김철수', '김민수', 'N', '내소', '2026-09-02'),
        sessionRow('김철수', '김민수', 'N', '방문', '2026-09-09'),
        sessionRow('김철수', '김민수', 'N', '유선', '2026-09-16'),
        sessionRow('김철수', '김민수', 'N', '내소', '2026-10-07'),
        sessionRow('김철수', '김민수', 'N', '방문', '2026-10-14'),
        // 이영자 (일시관리, 월 1회 목표): 매월 1회
        sessionRow('이영자', '이영희', 'N', '내소', '2026-08-11'),
        sessionRow('이영자', '이영희', 'N', '온라인', '2026-09-08'),
        sessionRow('이영자', '이영희', 'Y', '내소', '2026-10-05'),
        // 박민준 (집중관리, 월 4회 이상 목표): 8월 3회 / 9월 2회 / 10월 2회 — 자원조정 합산해도 8·9월 미달(미달 예시)
        sessionRow('박민준', '박준호', 'N', '방문', '2026-08-07'),
        sessionRow('박민준', '박준호', 'N', '내소', '2026-08-14'),
        sessionRow('박민준', '박준호', 'N', '방문', '2026-08-21'),
        sessionRow('박민준', '박준호', 'N', '내소', '2026-09-04'),
        sessionRow('박민준', '박준호', 'N', '내소', '2026-09-11'),
        sessionRow('박민준', '박준호', 'N', '내소', '2026-10-02'),
        sessionRow('박민준', '박준호', 'N', '방문', '2026-10-09'),
        // 최지현 (유지관리, 월 1회 목표): 매월 1회
        sessionRow('최지현', '최서연', 'N', '내소', '2026-08-18'),
        sessionRow('최지현', '최서연', 'N', '내소', '2026-09-15'),
        sessionRow('최지현', '최서연', 'N', '유선', '2026-10-10'),
        // 정수민 (유지관리, 월 1회 목표): 9·10월 각 1회 (8월은 자원조정만으로 달성)
        sessionRow('정수민', '정다은', 'N', '내소', '2026-09-07'),
        sessionRow('정수민', '정다은', 'N', '온라인', '2026-10-04'),
        // 한미래 (일시관리, 월 1회 목표): 8·10월 각 1회 (9월은 자원조정만으로 달성)
        sessionRow('한미래', '정다은', 'N', '내소', '2026-08-25'),
        sessionRow('한미래', '정다은', 'N', '내소', '2026-10-11'),
    ],
];

const buildResourceFile = (): [string, string, any[][]] => [
    '2.자원조정.xlsx', '자원조정',
    [
        SESSION_HEADER,
        // 김철수 (집중관리): 8월 1회 / 9월 2회 / 10월 1회 — 개별상담과 합산 시 8월 5회·9월 5회 달성
        sessionRow('김철수', '김민수', 'N', '방문', '2026-08-26'),
        sessionRow('김철수', '김민수', 'N', '유선', '2026-09-23'),
        sessionRow('김철수', '정다은', 'Y', '유선', '2026-09-25'),
        sessionRow('김철수', '김민수', 'N', '내소', '2026-10-16'),
        // 이영자 (일시관리): 9월 1회 — 합산 2회
        sessionRow('이영자', '이영희', 'N', '내소', '2026-09-21'),
        // 박민준 (집중관리): 8월 1회 / 9월 1회 / 10월 1회 — 합산 시 8월 4회·9월 3회로 미달
        sessionRow('박민준', '박준호', 'N', '방문', '2026-08-28'),
        sessionRow('박민준', '박준호', 'N', '유선', '2026-09-18'),
        sessionRow('박민준', '박준호', 'N', '방문', '2026-10-06'),
        // 최지현 (유지관리): 10월 1회 — 합산 2회
        sessionRow('최지현', '최서연', 'N', '내소', '2026-10-13'),
        // 정수민 (유지관리): 8월 1회 — 개별상담 없이 자원조정만으로 8월 목표 달성
        sessionRow('정수민', '정다은', 'N', '유선', '2026-08-24'),
        // 한미래 (일시관리): 9월 1회 — 개별상담 없이 자원조정만으로 9월 목표 달성
        sessionRow('한미래', '정다은', 'N', '방문', '2026-09-28'),
    ],
];

const buildGeneralFile = (): [string, string, any[][]] => {
    // 34열(A~AH). 파서 사용 열: D 상담일 / N 상담자 / AH 상담유형
    const header = [
        '접수번호', '접수일', '접수경로', '상담일', '성명', '성별', '연령', '연락처', '주소', '상담구분',
        '위기단계', '상담주제', '조치사항', '상담자', '상담시간', '상담장소', '의뢰기관', '연계기관', '후속조치', '비고',
        '항목21', '항목22', '항목23', '항목24', '항목25', '항목26', '항목27', '항목28', '항목29', '항목30',
        '항목31', '항목32', '항목33', '상담유형',
    ];
    const row = (no: string, date: string, name: string, counselor: string, type: string) => {
        const r = new Array(34).fill('');
        r[0] = no; r[3] = date; r[4] = name; r[13] = counselor; r[33] = type;
        return r;
    };
    return [
        '3.일반상담.xlsx', '일반상담',
        [
            header,
            row('G-001', '2026-09-03', '홍길동', '김민수', '내소'),
            row('G-002', '2026-09-10', '김영희', '이영희', '유선'),
            row('G-003', '2026-09-18', '익명', '정다은', '응급'),
            row('G-004', '2026-10-02', '이철민', '박준호', '방문'),
            row('G-005', '2026-10-09', '박수진', '최서연', '온라인'),
        ],
    ];
};

const buildRegistrationFile = (): [string, string, any[][]] => [
    '4.등퇴록대장.xlsx', '등퇴록대장',
    [
        ['등록번호', '성명', '성별', '생년월일', '등록일', '퇴록일', '상태', '담당자', '관리구분'],
        ...(['김철수', '이영자', '박민준', '최지현', '정수민', '한미래'] as MemberName[]).map(name => {
            const m = MEMBERS[name];
            const regDates: Record<MemberName, string> = {
                김철수: '2026-01-15', 이영자: '2026-02-03', 박민준: '2026-03-10',
                최지현: '2026-04-06', 정수민: '2026-05-12', 한미래: '2026-06-08',
            };
            return [m.regNo, name, m.gender, m.birth, regDates[name], '', '이용중', m.counselor, m.category];
        }),
        ['2025018', '오준석', '남', '1992-04-14', '2025-05-12', '2026-06-30', '퇴록', '김민수', '일시관리'],
    ],
];

const buildIspFile = (): [string, string, any[][]] => [
    '5.ISP수립.xlsx', 'ISP수립',
    [
        ['회원등록번호', '관리구분', '성별', '성명', '생년월일', '수립예정일', '수립일', '등록자'],
        ...(['김철수', '이영자', '박민준', '최지현', '정수민', '한미래'] as MemberName[]).map(name => {
            const m = MEMBERS[name];
            const dates: Record<MemberName, [string, string]> = {
                // [수립예정일, 수립일] — 김철수·박민준은 수립예정일이 임박한 만기 예시
                김철수: ['2026-11-05', '2026-01-15'], 이영자: ['2027-01-20', '2026-02-03'],
                박민준: ['2026-11-15', '2026-03-10'], 최지현: ['2027-02-01', '2026-04-06'],
                정수민: ['2027-03-10', '2026-05-12'], 한미래: ['2027-01-25', '2026-06-08'],
            };
            return [m.regNo, m.category, m.gender, name, m.birth, dates[name][0], dates[name][1], m.counselor];
        }),
    ],
];

/** 샘플 양식 6종을 순차 다운로드한다 (브라우저 다중 다운로드 허용이 필요할 수 있음). */
export const downloadSampleExcelFiles = () => {
    const builders = [
        buildTeamFile,
        buildIndividualFile,
        buildResourceFile,
        buildGeneralFile,
        buildRegistrationFile,
        buildIspFile,
    ];
    builders.forEach((build, i) => {
        setTimeout(() => {
            const [fileName, sheetName, rows] = build();
            downloadWorkbook(fileName, sheetName, rows);
        }, i * 400);
    });
};

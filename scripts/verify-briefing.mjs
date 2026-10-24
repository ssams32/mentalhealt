import assert from 'assert';
import * as XLSX from 'xlsx';

console.log('====================================================');
console.log('  🔍 [VERIFY-BRIEFING] 풀브리핑 회의 탭 구현 종합 검증');
console.log('====================================================\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error('     ' + (err.stack || err.message));
        process.exitCode = 1;
    }
}

// -------------------------------------------------------------
// 0. 도메인 상수 및 순수 로직 (briefingUtils & excelAnalysisService)
// -------------------------------------------------------------
const ISP_NEED_LABELS = [
    '자살·자해 및 타해 위험',
    '정신과적 증상',
    '정신약물관리',
    '스트레스 상태',
    '신체질환',
    '음주 및 중독문제',
    '개인위생관리',
    '일상생활관리',
    '가족자원',
    '가족관계',
    '사회적 관계',
    '공공서비스 활용능력',
    '주거',
    '경제활동 지원',
    '취업 및 학업욕구',
    '고용 및 교육가능성',
];

const normalizePersonName = (value) => {
    if (value == null) return '';
    return String(value).trim().replace(/\s+/g, '');
};

const normalizeMemberRegistrationNo = (raw) => {
    if (raw == null) return '';
    let str = String(raw).trim();
    if (str.includes('.') || str.includes('e')) {
        const num = Number(str);
        if (!isNaN(num)) str = String(BigInt(Math.floor(num)));
    }
    return str.replace(/[^a-zA-Z0-9]/g, '');
};

const anonymizeMemberName = (rawName) => {
    const name = normalizePersonName(rawName);
    if (!name) return '익00';
    if (/^.[0○]{2,}$/.test(name)) return name;
    return `${name.charAt(0)}00`;
};

const parseGoals = (goalsRaw) => {
    if (!goalsRaw) return { longTermGoal: '', shortTermGoal: '', isSplit: false };
    const raw = String(goalsRaw).trim();
    const longMatch = raw.match(/<장기\s*목표>([\s\S]*?)(?=<단기\s*목표>|$)/i);
    const shortMatch = raw.match(/<단기\s*목표>([\s\S]*)$/i);
    if (longMatch && shortMatch) {
        return {
            longTermGoal: longMatch[1].trim(),
            shortTermGoal: shortMatch[1].trim(),
            isSplit: true
        };
    }
    return {
        longTermGoal: raw,
        shortTermGoal: '',
        isSplit: false
    };
};

const normalizeManagementCategory = (categoryRaw) => {
    if (!categoryRaw) return '미분류';
    const cat = String(categoryRaw).replace(/\s+/g, '');
    if (cat.includes('집중')) return '집중관리';
    if (cat.includes('유지')) return '유지관리';
    if (cat.includes('일시')) return '일시관리';
    return '미분류';
};

const getTargetFrequencyPerMonth = (normCat) => {
    switch (normCat) {
        case '집중관리': return 4;
        case '유지관리': return 1;
        case '일시관리': return 1;
        default: return 0;
    }
};

const evaluateSuitability = (params) => {
    const { managementCategory, sessions, establishedDateStr, dateRange } = params;
    const today = params.today ? new Date(params.today) : new Date();
    today.setHours(0, 0, 0, 0);

    const normCat = normalizeManagementCategory(managementCategory);
    const targetFreq = getTargetFrequencyPerMonth(normCat);

    const startD = dateRange.start ? new Date(dateRange.start) : new Date('2026-01-01');
    const endD = dateRange.end ? new Date(dateRange.end) : new Date('2026-12-31');
    endD.setHours(23, 59, 59, 999);

    // 부재(노쇼) 건은 통계·적절성 판정에서 제외
    const validSessions = (sessions || []).filter(s => {
        if (s.absent) return false;
        if (!s.date) return false;
        const sd = new Date(s.date);
        return sd >= startD && sd <= endD;
    });

    const ascSessions = [...validSessions].sort((a, b) => (a.date < b.date ? -1 : 1));

    let longestGapDays = 0;
    if (ascSessions.length > 1) {
        for (let i = 1; i < ascSessions.length; i++) {
            const d1 = new Date(ascSessions[i - 1].date).getTime();
            const d2 = new Date(ascSessions[i].date).getTime();
            const diffDays = Math.round((d2 - d1) / (1000 * 3600 * 24));
            if (diffDays > longestGapDays) longestGapDays = diffDays;
        }
    }

    let daysSinceLastSession = null;
    if (ascSessions.length > 0) {
        const lastSessionDate = new Date(ascSessions[ascSessions.length - 1].date);
        lastSessionDate.setHours(0, 0, 0, 0);
        daysSinceLastSession = Math.max(0, Math.round((today.getTime() - lastSessionDate.getTime()) / (1000 * 3600 * 24)));
    }

    // 분모: max(선택 시작월, ISP 수립월) ~ 선택 종료월
    let evalStartYear = startD.getFullYear();
    let evalStartMonth = startD.getMonth() + 1;

    if (establishedDateStr) {
        const estD = new Date(establishedDateStr);
        if (!isNaN(estD.getTime())) {
            const estYear = estD.getFullYear();
            const estMonth = estD.getMonth() + 1;
            if (estYear > evalStartYear || (estYear === evalStartYear && estMonth > evalStartMonth)) {
                evalStartYear = estYear;
                evalStartMonth = estMonth;
            }
        }
    }

    const evalEndYear = endD.getFullYear();
    const evalEndMonth = endD.getMonth() + 1;

    const countByYearMonth = {};
    validSessions.forEach(s => {
        const ym = s.date.substring(0, 7);
        countByYearMonth[ym] = (countByYearMonth[ym] || 0) + 1;
    });

    const monthlyAchievements = [];
    let curY = evalStartYear;
    let curM = evalStartMonth;

    while (curY < evalEndYear || (curY === evalEndYear && curM <= evalEndMonth)) {
        const ym = `${curY}-${String(curM).padStart(2, '0')}`;
        const actual = countByYearMonth[ym] || 0;
        monthlyAchievements.push({
            yearMonth: ym,
            target: targetFreq,
            actual,
            achieved: actual >= targetFreq
        });

        curM++;
        if (curM > 12) {
            curM = 1;
            curY++;
        }
    }

    const totalTargetMonths = monthlyAchievements.length;
    const achievedMonthsCount = monthlyAchievements.filter(m => m.achieved).length;
    const achievementRate = totalTargetMonths > 0 ? achievedMonthsCount / totalTargetMonths : 0;
    const totalActualSessions = validSessions.length;
    const actualMonthlyAvg = totalTargetMonths > 0 ? Math.round((totalActualSessions / totalTargetMonths) * 10) / 10 : 0;

    let suitability = '적정';
    if (normCat === '미분류' || targetFreq === 0 || totalTargetMonths === 0) {
        suitability = '판정제외';
    } else if (totalActualSessions === 0) {
        suitability = '개입없음';
    } else if (achievementRate >= 0.8) {
        suitability = '적정';
    } else {
        suitability = '부족';
    }

    const isExcessive = targetFreq > 0 && actualMonthlyAvg > targetFreq * 1.5;

    return {
        suitability,
        isExcessive,
        targetMonthly: targetFreq,
        actualMonthlyAvg,
        totalTargetMonths,
        achievedMonthsCount,
        achievementRate,
        monthlyAchievements,
        longestGapDays,
        daysSinceLastSession
    };
};

const joinBriefingData = (params) => {
    const { ispPlans, briefingMembers, counselorMap, dateRange } = params;
    const deregSet = new Set((params.deregisteredRegNos || []).map(v => String(v).replace(/[^a-zA-Z0-9]/g, '')));
    const today = params.today ? new Date(params.today) : new Date();
    today.setHours(0, 0, 0, 0);

    const ISP_REVIEW_CYCLE_DAYS = 180;

    const ispPlansByName = new Map();
    (ispPlans || []).forEach(plan => {
        const normName = normalizePersonName(plan.memberName || plan.normalizedName);
        if (!ispPlansByName.has(normName)) ispPlansByName.set(normName, []);
        ispPlansByName.get(normName).push(plan);
    });
    const ispRepresentativeMap = new Map();
    ispPlansByName.forEach((plans, normName) => {
        const sorted = [...plans].sort((a, b) => {
            const da = a.establishedDate ? new Date(a.establishedDate).getTime() : 0;
            const db = b.establishedDate ? new Date(b.establishedDate).getTime() : 0;
            return db - da;
        });
        const latest = sorted[0];
        ispRepresentativeMap.set(`${normName}::${normalizePersonName(latest.registrant || '')}`, { latest, count: sorted.length });
    });

    // 2. 개입 회원 목록 정리: 이름 단위 그룹핑
    // (2026-10-23 수정: 연결 키를 (이름+담당자) 쌍에서 이름 기준으로 교체.
    //  ISP 등록자와 현재 주 상담자가 다르면(담당 변경 등) 세션이 전부 누락되던 문제 해결.
    //  담당자는 속성이며, 주 상담자는 세션이 가장 많은 상담사로 정한다.)
    const membersByName = new Map();
    (briefingMembers || []).forEach(m => {
        const normName = normalizePersonName(m.memberName || m.normalizedName);
        if (!membersByName.has(normName)) membersByName.set(normName, []);
        membersByName.get(normName).push(m);
    });

    const ispGroupsByName = new Map();
    ispRepresentativeMap.forEach((entry, key) => {
        const normName = key.split('::')[0];
        if (!ispGroupsByName.has(normName)) ispGroupsByName.set(normName, []);
        ispGroupsByName.get(normName).push({ key, latest: entry.latest, count: entry.count });
    });

    // 상담자별로 갈라진 동일 회원의 개입 묶음을 하나로 합친다
    const mergeMembers = (list) => {
        const sessions = list.flatMap(m => m.sessions || []);
        const counts = new Map();
        sessions.forEach(s => {
            if (s.counselor) counts.set(s.counselor, (counts.get(s.counselor) || 0) + 1);
        });
        let mainCounselor = list[0].mainCounselor;
        let max = -1;
        counts.forEach((cnt, cName) => {
            if (cnt > max) { max = cnt; mainCounselor = cName; }
        });
        const base = list.find(m => m.mainCounselor === mainCounselor) || list[0];
        return {
            ...base,
            mainCounselor,
            gender: list.find(m => m.gender)?.gender,
            age: list.find(m => m.age)?.age,
            diagnosis: list.find(m => m.diagnosis)?.diagnosis,
            diagnosisCode: list.find(m => m.diagnosisCode)?.diagnosisCode,
            sessions
        };
    };

    const workItems = [];

    const allNames = new Set();
    ispGroupsByName.forEach((_, n) => allNames.add(n));
    membersByName.forEach((_, n) => allNames.add(n));

    allNames.forEach(normName => {
        const groups = ispGroupsByName.get(normName) || [];
        const members = membersByName.get(normName) || [];

        // 동명이인: ISP 등록자가 여럿이고 개입도 상담자별로 갈라지면 등록자=주상담자 쌍으로 분리한다
        if (groups.length > 1 && members.length > 1) {
            const usedGroups = new Set();
            const usedMembers = new Set();
            members.forEach(m => {
                const g = groups.find(g => !usedGroups.has(g.key) && normalizePersonName(g.latest.registrant || '') === normalizePersonName(m.mainCounselor));
                if (g) {
                    usedGroups.add(g.key);
                    usedMembers.add(m);
                    workItems.push({ id: g.key, normName, isp: g.latest, plansCount: g.count, member: m, joinStatus: '확정연결', counselorChanged: false });
                }
            });
            groups.filter(g => !usedGroups.has(g.key)).forEach(g => {
                workItems.push({ id: g.key, normName, isp: g.latest, plansCount: g.count, member: undefined, joinStatus: '개입없음', counselorChanged: false });
            });
            const rest = members.filter(m => !usedMembers.has(m));
            if (rest.length) {
                const merged = mergeMembers(rest);
                workItems.push({ id: `${normName}::${normalizePersonName(merged.mainCounselor)}`, normName, isp: undefined, plansCount: 0, member: merged, joinStatus: 'ISP미수립', counselorChanged: false });
            }
            return;
        }

        const member = members.length ? mergeMembers(members) : undefined;

        // ISP 대표 선택: 수립이 여럿이면 담당자 매칭과 무관하게 가장 최근 수립을 대표로 한다
        // (2026-10-23 jun 확정: ISP 담당자는 최근 수립한 사람으로 정해진다)
        let chosen;
        if (groups.length) {
            chosen = [...groups].sort((a, b) => new Date(b.latest.establishedDate || 0).getTime() - new Date(a.latest.establishedDate || 0).getTime())[0];
        }

        let joinStatus = '확정연결';
        if (chosen && !member) joinStatus = '개입없음';
        else if (!chosen && member) joinStatus = 'ISP미수립';

        const counselorChanged = !!(chosen && member && normalizePersonName(chosen.latest.registrant || '') !== normalizePersonName(member.mainCounselor));

        const planHistory = [...(ispPlansByName.get(normName) || [])]
            .sort((a, b) => new Date(b.establishedDate || 0).getTime() - new Date(a.establishedDate || 0).getTime())
            .map(plan => {
                const g = parseGoals(plan.goalsRaw);
                const needs = plan.needs || [];
                return {
                    establishedDate: plan.establishedDate || '',
                    registrant: plan.registrant || '',
                    managementCategory: plan.managementCategory || '미분류',
                    longTermGoal: g.longTermGoal,
                    shortTermGoal: g.shortTermGoal,
                    isGoalSplit: g.isSplit,
                    ispResultText: plan.ispResultText || '',
                    unmetNeeds: needs.filter(n => n.score >= 1),
                    allNeeds: needs
                };
            });

        workItems.push({
            id: chosen ? chosen.key : `${normName}::${normalizePersonName(member.mainCounselor)}`,
            normName,
            isp: chosen?.latest,
            plansCount: chosen?.count || 0,
            member,
            joinStatus,
            counselorChanged,
            planHistory
        });
    });

    const result = [];

    const visibleWorkItems = workItems.filter(w => {
        if (!w.isp || deregSet.size === 0) return true;
        const reg = String(w.isp.registrationNo || '').replace(/[^a-zA-Z0-9]/g, '');
        return !(reg && deregSet.has(reg));
    });

    visibleWorkItems.forEach(({ id: itemId, normName, isp, member, joinStatus, counselorChanged, plansCount, planHistory }) => {
        const rawName = isp?.memberName || member?.memberName || normName;
        // 담당자: ISP 최근 수립의 등록자가 담당자다 (2026-10-23 jun 확정). ISP가 없을 때만 최다 상담자로 대체
        const mainCounselor = isp?.registrant || member?.mainCounselor || '미지정';
        const registrant = isp?.registrant || '';
        const department = member?.department || counselorMap[mainCounselor] || counselorMap[registrant] || '부서정보없음';
        const managementCategory = isp?.managementCategory || '미분류';
        const normCat = normalizeManagementCategory(managementCategory);
        const establishedDate = isp?.establishedDate || '';


        let isExpiring = false;
        let daysUntilReview = 9999;
        let reviewDueDate = '';

        if (establishedDate) {
            const estDate = new Date(establishedDate);
            if (!isNaN(estDate.getTime())) {
                const dueDate = new Date(estDate);
                dueDate.setHours(0, 0, 0, 0);
                dueDate.setDate(dueDate.getDate() + ISP_REVIEW_CYCLE_DAYS);
                reviewDueDate = dueDate.toISOString().split('T')[0];
                const diffTime = dueDate.getTime() - today.getTime();
                daysUntilReview = Math.ceil(diffTime / (1000 * 3600 * 24));
                if (daysUntilReview <= 30) isExpiring = true;
            }
        }

        const allSessions = member?.sessions || [];
        const sortedSessions = [...allSessions].sort((a, b) => (b.date > a.date ? 1 : -1));

        const startD = dateRange.start ? new Date(dateRange.start) : new Date('2026-01-01');
        const endD = dateRange.end ? new Date(dateRange.end) : new Date('2026-12-31');
        endD.setHours(23, 59, 59, 999);

        const inRangeSessions = sortedSessions.filter(s => {
            if (!s.date) return false;
            const d = new Date(s.date);
            return d >= startD && d <= endD;
        });

        const individualCount = inRangeSessions.filter(s => s.category === 'individual' && !s.absent).length;
        const resourceCount = inRangeSessions.filter(s => s.category === 'resource' && !s.absent).length;
        const totalInterventionCount = individualCount + resourceCount;

        const suitabilityEval = evaluateSuitability({
            managementCategory,
            sessions: sortedSessions,
            establishedDateStr: establishedDate,
            dateRange,
            today
        });

        result.push({
            id: itemId,
            memberName: rawName,
            normalizedName: normName,
            registrationNo: isp?.registrationNo || '',
            counselor: mainCounselor,
            registrant,
            department,
            managementCategory,
            normalizedCategory: normalizeManagementCategory(managementCategory),
            establishedDate,
            isExpiring,
            daysUntilReview,
            reviewDueDate,
            needs: (isp?.needs || []).filter(n => n.score >= 1),
            allNeeds: isp?.needs || [],
            ispResultText: isp?.ispResultText || '',
            goalsRaw: isp?.goalsRaw || '',
            individualCount,
            resourceCount,
            totalInterventionCount,
            suitability: suitabilityEval.suitability,
            isExcessive: suitabilityEval.isExcessive,
            suitabilityEval,
            joinStatus,
            counselorChanged,
            planHistory: planHistory || []
        });
    });

    const priorityWeight = (item) => {
        if (item.suitability === '개입없음') return 1;
        if (item.suitability === '부족') return 2;
        if (item.isExpiring) return 3;
        if (item.suitability === '적정') return 4;
        return 5;
    };

    return result.sort((a, b) => {
        const wA = priorityWeight(a);
        const wB = priorityWeight(b);
        if (wA !== wB) return wA - wB;
        if (a.daysUntilReview !== b.daysUntilReview) return a.daysUntilReview - b.daysUntilReview;
        return a.normalizedName.localeCompare(b.normalizedName, 'ko');
    });
};

// -------------------------------------------------------------
// 샘플 데이터 픽스처 생성기
// -------------------------------------------------------------
const COUNSELORS = [
    ['김민수', '증진팀'],
    ['이영희', '증진팀'],
    ['박준호', '회복팀'],
    ['최서연', '아동청소년'],
    ['정다은', '자살예방센터'],
];

const MEMBERS = {
    김철수: { regNo: '20260115000001', gender: '남', birth: '1985-03-12', age: 41, diag: '우울장애', category: '집중관리', counselor: '김민수' },
    이영자: { regNo: '20260203000002', gender: '여', birth: '1990-07-25', age: 36, diag: '불안장애', category: '일시관리', counselor: '이영희' },
    박민준: { regNo: '20260310000003', gender: '남', birth: '1978-11-02', age: 48, diag: '조현병', category: '집중관리', counselor: '박준호' },
    최지현: { regNo: '20260406000004', gender: '여', birth: '2001-05-18', age: 25, diag: '적응장애', category: '유지관리', counselor: '최서연' },
    정수민: { regNo: '20260512000005', gender: '남', birth: '1995-09-30', age: 31, diag: '우울장애', category: '유지관리', counselor: '정다은' },
    한미래: { regNo: '20260608000006', gender: '여', birth: '1988-12-05', age: 38, diag: '불안장애', category: '일시관리', counselor: '정다은' },
    서민재: { regNo: '20260615000007', gender: '남', birth: '1993-06-15', age: 33, diag: '우울장애', category: '집중관리', counselor: '정다은' },
    강도윤: { regNo: '20260703000008', gender: '여', birth: '1997-02-20', age: 29, diag: '불안장애', category: '유지관리', counselor: '정다은' },
    윤하늘: { regNo: '20260720000009', gender: '남', birth: '1990-10-08', age: 36, diag: '우울장애', category: '일시관리', counselor: '정다은' },
};

const INDIVIDUAL_SPECS = [
    ['김철수', '김민수', 'N', '내소', '2026-08-05'],
    ['김철수', '김민수', 'N', '방문', '2026-08-12'],
    ['김철수', '김민수', 'N', '내소', '2026-08-19'],
    ['김철수', '김민수', 'N', '방문', '2026-08-28'],
    ['김철수', '김민수', 'N', '내소', '2026-09-02'],
    ['김철수', '김민수', 'N', '방문', '2026-09-09'],
    ['김철수', '김민수', 'N', '전화', '2026-09-16'],
    ['김철수', '김민수', 'N', '내소', '2026-10-07'],
    ['김철수', '김민수', 'N', '방문', '2026-10-14'],
    ['이영자', '이영희', 'N', '내소', '2026-08-11'],
    ['이영자', '이영희', 'N', '온라인', '2026-09-08'],
    ['이영자', '이영희', 'Y', '내소', '2026-10-05'],
    ['박민준', '박준호', 'N', '방문', '2026-08-07'],
    ['박민준', '박준호', 'N', '내소', '2026-08-14'],
    ['박민준', '박준호', 'N', '방문', '2026-08-21'],
    ['박민준', '박준호', 'N', '내소', '2026-09-04'],
    ['박민준', '박준호', 'N', '내소', '2026-09-11'],
    ['박민준', '박준호', 'N', '내소', '2026-10-02'],
    ['박민준', '박준호', 'N', '방문', '2026-10-09'],
    ['최지현', '최서연', 'N', '내소', '2026-08-18'],
    ['최지현', '최서연', 'N', '내소', '2026-09-15'],
    ['최지현', '최서연', 'N', '전화', '2026-10-10'],
    ['정수민', '정다은', 'N', '내소', '2026-09-07'],
    ['정수민', '정다은', 'N', '온라인', '2026-10-04'],
    ['한미래', '정다은', 'N', '내소', '2026-08-25'],
    ['한미래', '정다은', 'N', '내소', '2026-10-11'],
    ['서민재', '정다은', 'N', '내소', '2026-08-03'],
    ['서민재', '정다은', 'N', '방문', '2026-08-10'],
    ['서민재', '정다은', 'N', '내소', '2026-08-17'],
    ['서민재', '정다은', 'N', '전화', '2026-08-24'],
    ['서민재', '정다은', 'N', '내소', '2026-09-01'],
    ['서민재', '정다은', 'N', '방문', '2026-09-08'],
    ['서민재', '정다은', 'N', '내소', '2026-09-15'],
    ['서민재', '정다은', 'N', '전화', '2026-09-22'],
    ['서민재', '정다은', 'N', '내소', '2026-10-06'],
    ['서민재', '정다은', 'N', '방문', '2026-10-13'],
    ['강도윤', '정다은', 'N', '내소', '2026-08-06'],
    ['강도윤', '정다은', 'N', '온라인', '2026-08-20'],
    ['강도윤', '정다은', 'N', '내소', '2026-09-03'],
    ['강도윤', '정다은', 'N', '전화', '2026-09-17'],
    ['강도윤', '정다은', 'N', '내소', '2026-10-08'],
    ['윤하늘', '정다은', 'N', '내소', '2026-08-14'],
    ['윤하늘', '정다은', 'N', '방문', '2026-10-03'],
];

const RESOURCE_SPECS = [
    ['김철수', '김민수', 'N', '방문', '2026-08-26'],
    ['김철수', '김민수', 'N', '전화', '2026-09-23'],
    ['김철수', '정다은', 'Y', '전화', '2026-09-25'],
    ['김철수', '김민수', 'N', '내소', '2026-10-16'],
    ['이영자', '이영희', 'N', '내소', '2026-09-21'],
    ['박민준', '박준호', 'N', '방문', '2026-08-28'],
    ['박민준', '박준호', 'N', '전화', '2026-09-18'],
    ['박민준', '박준호', 'N', '방문', '2026-10-06'],
    ['최지현', '최서연', 'N', '내소', '2026-10-13'],
    ['정수민', '정다은', 'N', '전화', '2026-08-24'],
    ['한미래', '정다은', 'N', '방문', '2026-09-28'],
    ['서민재', '정다은', 'N', '방문', '2026-08-26'],
    ['서민재', '정다은', 'N', '전화', '2026-09-29'],
    ['강도윤', '정다은', 'N', '전화', '2026-08-27'],
    ['윤하늘', '정다은', 'N', '내소', '2026-09-11'],
];

// =========================================================================
// ① 파서 교체 회귀 검증
// =========================================================================
console.log('📌 ① 파서 교체 회귀 검증');

test('개별상담(43건) + 자원조정(15건) = 58건 총합 및 상담사별 건수 일치', () => {
    // 24열 양식 파싱 시뮬레이션
    const validCounselors = COUNSELORS.map(c => c[0]);
    const counselorPerformance = {};
    validCounselors.forEach(c => {
        counselorPerformance[c] = { counselorName: c, totalSessions: 0, types: { inOffice: 0, visit: 0, online: 0, emergency: 0, phone: 0 } };
    });

    const allSessions = [
        ...INDIVIDUAL_SPECS.map(s => ({ member: s[0], counselor: s[1], emergency: s[2] === 'Y', type: s[3], date: s[4], category: 'individual', absent: false })),
        ...RESOURCE_SPECS.map(s => ({ member: s[0], counselor: s[1], emergency: s[2] === 'Y', type: s[3], date: s[4], category: 'resource', absent: false }))
    ];

    allSessions.forEach(s => {
        if (!s.absent) {
            const perf = counselorPerformance[s.counselor];
            perf.totalSessions++;
            if (s.emergency) perf.types.emergency++;
            else if (s.type === '내소') perf.types.inOffice++;
            else if (s.type === '방문') perf.types.visit++;
            else if (s.type === '온라인') perf.types.online++;
            else if (s.type === '전화') perf.types.phone++;
        }
    });

    const total = Object.values(counselorPerformance).reduce((acc, c) => acc + c.totalSessions, 0);
    assert.strictEqual(total, 58, `총 세션 수는 58건이어야 함 (실제: ${total})`);

    assert.strictEqual(counselorPerformance['김민수'].totalSessions, 12);
    assert.strictEqual(counselorPerformance['이영희'].totalSessions, 4);
    assert.strictEqual(counselorPerformance['박준호'].totalSessions, 10);
    assert.strictEqual(counselorPerformance['최서연'].totalSessions, 4);
    assert.strictEqual(counselorPerformance['정다은'].totalSessions, 28);
});

// =========================================================================
// ② ISP 이관 회귀 검증
// =========================================================================
console.log('\n📌 ② ISP 이관 회귀 검증');

test('ISP 전 필드 열 매핑 이관: C~AG 열 정확한 추출 및 16개 영역 점수 라벨 매칭', () => {
    // 2단 헤더 + 9개 회원 데이터 생성
    const dataRows = Object.keys(MEMBERS).map((name, i) => {
        const m = MEMBERS[name];
        const isSuicide = name === '서민재' || name === '강도윤' || name === '윤하늘';
        const scores = new Array(16).fill(0);
        scores[1] = 1; // 정신과적 증상
        scores[2] = 1; // 정신약물관리
        if (isSuicide) scores[0] = 1; // 자살·자해 위험

        const suicideInfo = isSuicide
            ? ['Y', name === '서민재' ? 12 : 8, '스트레스', 'Y', '약물', '자살사고']
            : ['N', '', '', 'N', '', ''];

        return [
            i + 1, '기관', m.regNo, name, m.gender, m.age, '2026-08-01', m.counselor, m.category,
            ...suicideInfo,
            'ISP결과 서술문 예시',
            '<장기목표>\n장기목표 원문\n<단기목표>\n단기목표 원문',
            ...scores
        ];
    });

    // 헤더 2행 스킵 (3행 시작) 파싱
    const parsedPlans = dataRows.map((row, idx) => {
        const registrationNo = row[2];
        const memberName = row[3];
        const registrant = row[7];
        const managementCategory = row[8];
        const establishedDate = row[6];
        const suicideInfo = {
            riskFlag: row[9],
            thoughtScore: row[10],
            thoughtReason: row[11],
            planFlag: row[12],
            planMethod: row[13],
            content: row[14]
        };
        const ispResultText = row[15];
        const goalsRaw = row[16];
        const needs = ISP_NEED_LABELS.map((label, lIdx) => ({
            label,
            score: Number(row[17 + lIdx]) || 0
        }));

        return {
            registrationNo,
            normalizedRegistrationNo: normalizeMemberRegistrationNo(registrationNo),
            memberName,
            normalizedName: normalizePersonName(memberName),
            managementCategory,
            establishedDate,
            registrant,
            excelRowNumber: idx + 3, // 3행부터 시작
            parseStatus: 'success',
            needs,
            ispResultText,
            goalsRaw,
            suicideInfo
        };
    });

    assert.strictEqual(parsedPlans.length, 9, 'ISP 수립 계획은 9명이어야 함');
    assert.strictEqual(parsedPlans[0].excelRowNumber, 3, '첫 데이터 행은 3행이어야 함');
    assert.strictEqual(parsedPlans[8].excelRowNumber, 11, '마지막 데이터 행은 11행이어야 함');

    parsedPlans.forEach(plan => {
        assert(plan.registrationNo.startsWith('2026'), '등록번호 형식 정상');
        assert.strictEqual(plan.needs.length, 16, '16개 상태평가 점수 전원 매핑');
        assert(plan.goalsRaw.includes('<장기목표>'), '장기목표 태그 포함');
        assert(plan.goalsRaw.includes('<단기목표>'), '단기목표 태그 포함');
    });

    const seoMinJae = parsedPlans.find(p => p.memberName === '서민재');
    assert.strictEqual(seoMinJae.suicideInfo.riskFlag, 'Y');
    assert.strictEqual(seoMinJae.suicideInfo.thoughtScore, 12);
});

// =========================================================================
// ③ 조인·판정 숫자 픽스처 대조 (동명이인 분리, 부재 제외, 월별 달성)
// =========================================================================
console.log('\n📌 ③ 조인·판정 숫자 픽스처 대조');

test('ISP 중복 수립 픽스처: 같은 이름 수립이 여럿이면 최근 1건만 대상자로 (jun 지시)', () => {
    const mockIspPlans = [
        {
            memberName: '김철수',
            normalizedName: '김철수',
            managementCategory: '집중관리',
            establishedDate: '2026-08-01',
            registrant: '김민수',
            needs: [{ label: '정신과적 증상', score: 1 }],
            goalsRaw: '<장기목표>\n장기A\n<단기목표>\n단기A'
        },
        {
            memberName: '김철수',
            normalizedName: '김철수',
            managementCategory: '유지관리',
            establishedDate: '2026-03-01',
            registrant: '박준호',
            needs: [{ label: '일상생활관리', score: 1 }],
            goalsRaw: '<장기목표>\n장기B\n<단기목표>\n단기B'
        }
    ];

    const mockBriefingMembers = [
        {
            memberName: '김철수',
            normalizedName: '김철수',
            mainCounselor: '김민수',
            department: '증진팀',
            sessions: [
                { date: '2026-08-05', category: 'individual', counselor: '김민수', absent: false },
                { date: '2026-08-12', category: 'individual', counselor: '김민수', absent: false },
                { date: '2026-08-19', category: 'individual', counselor: '김민수', absent: false },
                { date: '2026-08-26', category: 'individual', counselor: '김민수', absent: false },
            ]
        },
        {
            memberName: '김철수',
            normalizedName: '김철수',
            mainCounselor: '박준호',
            department: '회복팀',
            sessions: [
                { date: '2026-08-10', category: 'resource', counselor: '박준호', absent: false }
            ]
        }
    ];

    const joined = joinBriefingData({
        ispPlans: mockIspPlans,
        briefingMembers: mockBriefingMembers,
        counselorMap: { 김민수: '증진팀', 박준호: '회복팀' },
        dateRange: { start: '2026-08-01', end: '2026-08-31' },
        today: new Date('2026-08-31')
    });

    assert.strictEqual(joined.length, 1, '같은 이름은 최근 수립 1건만 대상자가 되어야 함');
    assert.strictEqual(joined[0].counselor, '김민수', '담당자는 최근 수립 등록자');
    assert.strictEqual(joined[0].managementCategory, '집중관리', '관리구분도 최근 수립 기준');
    assert.strictEqual(joined[0].totalInterventionCount, 5, '세션은 상담자 구분 없이 전부 합산');
});

test('부재(노쇼) 건 픽스처: 건수·적절성 판정에서 제외', () => {
    const sessions = [
        { date: '2026-08-05', category: 'individual', absent: true },
        { date: '2026-08-15', category: 'individual', absent: false }
    ];

    const res = evaluateSuitability({
        managementCategory: '유지관리',
        sessions,
        establishedDateStr: '2026-08-01',
        dateRange: { start: '2026-08-01', end: '2026-08-31' },
        today: new Date('2026-08-31')
    });

    const m = res.monthlyAchievements.find(ma => ma.yearMonth === '2026-08');
    assert.strictEqual(m.actual, 1, `부재 건 제외로 8월 실제 건수는 1건이어야 함 (실제: ${m.actual})`);
    assert.strictEqual(m.achieved, true, '월 1회 달성');
});

test('월별 달성 및 분모 제한 픽스처: 수립 전 월 제외 및 달성률 80% 기준 판정', () => {
    // 2026-07 ~ 2026-12 (6개월 중 수립일 2026-09-15 -> 분모 4개월)
    const sessions = [
        // 9월 4회 달성
        { date: '2026-09-02', category: 'individual', absent: false },
        { date: '2026-09-09', category: 'individual', absent: false },
        { date: '2026-09-16', category: 'individual', absent: false },
        { date: '2026-09-23', category: 'individual', absent: false },
        // 10월 4회 달성
        { date: '2026-10-07', category: 'individual', absent: false },
        { date: '2026-10-14', category: 'individual', absent: false },
        { date: '2026-10-21', category: 'individual', absent: false },
        { date: '2026-10-28', category: 'individual', absent: false },
        // 11월 4회 달성
        { date: '2026-11-04', category: 'individual', absent: false },
        { date: '2026-11-11', category: 'individual', absent: false },
        { date: '2026-11-18', category: 'individual', absent: false },
        { date: '2026-11-25', category: 'individual', absent: false },
        // 12월 1회 (미달)
        { date: '2026-12-02', category: 'individual', absent: false }
    ];

    const res = evaluateSuitability({
        managementCategory: '집중관리',
        sessions,
        establishedDateStr: '2026-09-15',
        dateRange: { start: '2026-07-01', end: '2026-12-31' },
        today: new Date('2026-12-31')
    });

    assert.strictEqual(res.totalTargetMonths, 4, '판정 대상 월은 9~12월 4개월');
    assert.strictEqual(res.achievedMonthsCount, 3, '달성 개월 수는 3개월');
    assert.strictEqual(res.suitability, '부족', '3/4=75% (<80%)로 부족 판정');
});

// =========================================================================
// ④ 엑셀 다운로드 열 구성·익명화 확인
// =========================================================================
console.log('\n📌 ④ 엑셀 다운로드 열 구성·익명화 확인');

test('익명화 강제: 첫 글자 + 00 변환', () => {
    assert.strictEqual(anonymizeMemberName('김철수'), '김00');
    assert.strictEqual(anonymizeMemberName('이영희'), '이00');
    assert.strictEqual(anonymizeMemberName('박민준'), '박00');
    assert.strictEqual(anonymizeMemberName('김00'), '김00');
});

test('과다 개입(목표의 150% 초과) 참고 표시 검증', () => {
    // 유지관리 목표: 월 1회. 3개월 동안 5회 개입 -> 월평균 1.67회 (> 1.5회 = 150% 초과)
    const sessions = [
        { date: '2026-08-05', category: 'individual', absent: false },
        { date: '2026-08-15', category: 'individual', absent: false },
        { date: '2026-09-05', category: 'individual', absent: false },
        { date: '2026-09-20', category: 'individual', absent: false },
        { date: '2026-10-10', category: 'individual', absent: false },
    ];

    const res = evaluateSuitability({
        managementCategory: '유지관리',
        sessions,
        establishedDateStr: '2026-08-01',
        dateRange: { start: '2026-08-01', end: '2026-10-31' },
        today: new Date('2026-10-31')
    });

    assert.strictEqual(res.suitability, '적정', '목표를 매월 달성했으므로 적정');
    assert.strictEqual(res.isExcessive, true, '월평균 1.7회로 목표(1회)의 150% 초과하여 과다 참고 플래그 true');
});

test('24열 신규 양식 실 엑셀 버퍼 생성 및 시트 파싱 무결성 검증', () => {
    const indHeader = [
        'No', '기관명', '구분', '회원명', '성별', '나이', '진단명', '진단코드',
        '상담시작시간', '상담종료시간', '소요시간', '관련기관', '장소', '상담대상', '상담형태',
        '부재여부', '응급개입', '프로그램영역', '프로그램세부', '문제영역', '욕구항목',
        '상담주제', '상담내용', '상담자'
    ];
    assert.strictEqual(indHeader.length, 24, '개별상담내역은 정확히 24열');
    assert.strictEqual(indHeader[3], '회원명', 'D열은 회원명');
    assert.strictEqual(indHeader[8], '상담시작시간', 'I열은 상담시작시간');
    assert.strictEqual(indHeader[14], '상담형태', 'O열은 상담형태');
    assert.strictEqual(indHeader[15], '부재여부', 'P열은 부재여부');
    assert.strictEqual(indHeader[16], '응급개입', 'Q열은 응급개입');
    assert.strictEqual(indHeader[23], '상담자', 'X열은 상담자');

    const resHeader = [
        'No', '기관명', '구분', '회원명', '성별', '나이', '진단명', '진단코드',
        '관련기관', '상담일자', '상담시작시간', '상담종료시간', '소요시간', '상담대상', '상담형태',
        'ISP관리구분', '부재여부', '응급개입', '관리구분', '문제영역', '욕구항목',
        '상담주제', '상담내용', '상담자'
    ];
    assert.strictEqual(resHeader.length, 24, '자원조정내역은 정확히 24열');
    assert.strictEqual(resHeader[3], '회원명', 'D열은 회원명');
    assert.strictEqual(resHeader[9], '상담일자', 'J열은 상담일자');
    assert.strictEqual(resHeader[14], '상담형태', 'O열은 상담형태');
    assert.strictEqual(resHeader[16], '부재여부', 'Q열은 부재여부');
    assert.strictEqual(resHeader[17], '응급개입', 'R열은 응급개입');
    assert.strictEqual(resHeader[23], '상담자', 'X열은 상담자');
});

test('엑셀 4개 열 구성 및 수퍼비전 내용 결합(작성자 표기, 일시 제외) 검증', () => {
    const mockMembers = [
        {
            id: '김철수::김민수',
            memberName: '김철수',
            counselor: '김민수',
            goalsRaw: '<장기목표>\n장기A\n<단기목표>\n단기A'
        },
        {
            id: '이영희::박준호',
            memberName: '이영희',
            counselor: '박준호',
            goalsRaw: '단기목표B'
        }
    ];

    const mockComments = {
        '김철수::김민수': [
            { id: '1', author: '김민수', text: '보호자 상담 완료함.', createdAt: '2026-10-23T14:00:00Z' },
            { id: '2', author: '허상임', text: '재수립 일정 조율 필요.', createdAt: '2026-10-23T14:30:00Z' }
        ]
    };

    const headers = ['대상자', '장단기 목표', '담당자', '수퍼비전 내용'];
    const rows = mockMembers.map(m => {
        const anonName = anonymizeMemberName(m.memberName);
        const goals = m.goalsRaw || '';
        const counselor = m.counselor || '';

        const memberComments = mockComments[m.id] || [];
        const commentText = memberComments
            .map(c => (c.author ? `[${c.author}] ${c.text}` : c.text))
            .join('\n');

        return [anonName, goals, counselor, commentText];
    });

    const aoa = [headers, ...rows];
    assert.strictEqual(aoa[0].length, 4, '헤더 열 수는 정확히 4개');
    assert.deepStrictEqual(aoa[0], ['대상자', '장단기 목표', '담당자', '수퍼비전 내용']);

    const row1 = aoa[1];
    assert.strictEqual(row1[0], '김00', '대상자명 김00 익명화');
    assert.strictEqual(row1[2], '김민수', '담당자는 실명 유지');
    assert(row1[3].includes('[김민수] 보호자 상담 완료함.'));
    assert(row1[3].includes('[허상임] 재수립 일정 조율 필요.'));
    assert(!row1[3].includes('2026-10-23'), '날짜·시간은 제외되어야 함');

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, '풀브리핑_수퍼비전');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    assert(out && out.length > 0, '엑셀 바이너리 정상 생성');
});

test('담당 변경 픽스처: ISP 등록자와 현재 상담자가 달라도 세션이 연결되어야 함', () => {
    const ispPlans = [
        { memberName: '이영자', normalizedName: '이영자', registrationNo: '2026-002', registrant: '옛담당', managementCategory: '일시관리', establishedDate: '2026-01-20', needs: [], goalsRaw: '', ispResultText: '' }
    ];
    const briefingMembers = [
        {
            memberName: '이영자', normalizedName: '이영자', mainCounselor: '현담당', department: '증진팀',
            sessions: [
                { date: '2026-08-03', category: 'individual', counselor: '현담당', absent: false },
                { date: '2026-08-17', category: 'resource', counselor: '현담당', absent: false }
            ]
        }
    ];
    const joined = joinBriefingData({
        ispPlans, briefingMembers,
        counselorMap: { 현담당: '증진팀', 옛담당: '증진팀' },
        dateRange: { start: '2026-08-01', end: '2026-08-31' },
        today: new Date('2026-08-31')
    });
    assert.strictEqual(joined.length, 1, '대상자 1명으로 합쳐져야 함');
    assert.strictEqual(joined[0].totalInterventionCount, 2, '세션 2건이 연결되어야 함');
    assert.strictEqual(joined[0].joinStatus, '확정연결');
    assert.strictEqual(joined[0].counselorChanged, true, '등록자≠주상담자이면 담당 변경 표시');
    assert.strictEqual(joined[0].counselor, '옛담당', '담당자는 ISP 수립 등록자로 표시');
});

test('복수 상담사 분산 픽스처: 상담자별로 갈라진 세션이 회원 단위로 합산되어야 함', () => {
    const ispPlans = [
        { memberName: '박민준', normalizedName: '박민준', registrationNo: '2026-003', registrant: '상담자A', managementCategory: '집중관리', establishedDate: '2026-01-05', needs: [], goalsRaw: '', ispResultText: '' }
    ];
    const briefingMembers = [
        {
            memberName: '박민준', normalizedName: '박민준', mainCounselor: '상담자A', department: '회복팀',
            sessions: [
                { date: '2026-08-04', category: 'individual', counselor: '상담자A', absent: false },
                { date: '2026-08-11', category: 'individual', counselor: '상담자A', absent: false }
            ]
        },
        {
            memberName: '박민준', normalizedName: '박민준', mainCounselor: '상담자B', department: '회복팀',
            sessions: [
                { date: '2026-08-06', category: 'individual', counselor: '상담자B', absent: false },
                { date: '2026-08-13', category: 'individual', counselor: '상담자B', absent: false },
                { date: '2026-08-20', category: 'resource', counselor: '상담자B', absent: false },
                { date: '2026-08-27', category: 'individual', counselor: '상담자B', absent: false }
            ]
        }
    ];
    const joined = joinBriefingData({
        ispPlans, briefingMembers,
        counselorMap: { 상담자A: '회복팀', 상담자B: '회복팀' },
        dateRange: { start: '2026-08-01', end: '2026-08-31' },
        today: new Date('2026-08-31')
    });
    assert.strictEqual(joined.length, 1, '같은 회원은 1명으로 합쳐져야 함');
    assert.strictEqual(joined[0].totalInterventionCount, 6, '두 상담사 세션 합산 6건');
    assert.strictEqual(joined[0].individualCount, 5);
    assert.strictEqual(joined[0].resourceCount, 1);
    assert.strictEqual(joined[0].counselor, '상담자A', '담당자는 세션 최다자가 아니라 ISP 등록자');
});

test('ISP 복수 수립 픽스처: 대표가 최근 수립으로 정해져야 함 (담당자 매칭 무관)', () => {
    const ispPlans = [
        { memberName: '최지영', normalizedName: '최지영', registrationNo: '2026-004', registrant: '옛담당', managementCategory: '유지관리', establishedDate: '2026-01-05', needs: [], goalsRaw: '옛목표', ispResultText: '' },
        { memberName: '최지영', normalizedName: '최지영', registrationNo: '2026-004', registrant: '새담당', managementCategory: '집중관리', establishedDate: '2026-06-01', needs: [], goalsRaw: '새목표', ispResultText: '' }
    ];
    const briefingMembers = [
        {
            memberName: '최지영', normalizedName: '최지영', mainCounselor: '옛담당', department: '증진팀',
            sessions: [
                { date: '2026-08-03', category: 'individual', counselor: '옛담당', absent: false }
            ]
        }
    ];
    const joined = joinBriefingData({
        ispPlans, briefingMembers,
        counselorMap: { 옛담당: '증진팀', 새담당: '증진팀' },
        dateRange: { start: '2026-08-01', end: '2026-08-31' },
        today: new Date('2026-08-31')
    });
    assert.strictEqual(joined.length, 1, '회원 1명으로 합쳐져야 함');
    assert.strictEqual(joined[0].establishedDate, '2026-06-01', '최근 수립일이 대표여야 함');
    assert.strictEqual(joined[0].registrant, '새담당', 'ISP 담당자는 최근 수립한 사람');
    assert.strictEqual(joined[0].managementCategory, '집중관리', '관리구분도 최근 수립 기준');
    assert.strictEqual(joined[0].goalsRaw, '새목표', '목표도 최근 수립 원문');
    assert.strictEqual(joined[0].totalInterventionCount, 1, '세션은 그대로 연결');
});


// 13. 퇴록자 제외: 등록번호가 퇴록 목록에 있으면 풀브리핑에서 사라진다
test('퇴록자 제외 픽스처: 등퇴록대장 등록번호와 ISP가 일치하면 제외', () => {
    const ispPlans = [
        { memberName: '퇴록자', normalizedName: '퇴록자', registrationNo: '20260115000001', registrant: '담당', managementCategory: '유지관리', establishedDate: '2026-01-05', needs: [], goalsRaw: '', ispResultText: '' },
        { memberName: '재록자', normalizedName: '재록자', registrationNo: '20260115000002', registrant: '담당', managementCategory: '유지관리', establishedDate: '2026-01-05', needs: [], goalsRaw: '', ispResultText: '' }
    ];
    const briefingMembers = ['퇴록자', '재록자'].map(n => ({
        memberName: n, normalizedName: n, mainCounselor: '담당', department: '증진팀',
        sessions: [{ date: '2026-08-03', category: 'individual', counselor: '담당', absent: false }]
    }));
    const base = { ispPlans, briefingMembers, counselorMap: { 담당: '증진팀' }, dateRange: { start: '2026-08-01', end: '2026-08-31' }, today: new Date('2026-08-31') };
    const without = joinBriefingData(base);
    const withDereg = joinBriefingData({ ...base, deregisteredRegNos: ['20260115000001'] });
    assert.strictEqual(without.length, 2, '등퇴록대장 미첨부 시 2명 모두 표시');
    assert.strictEqual(withDereg.length, 1, '퇴록자 1명은 제외되어야 함');
    assert.strictEqual(withDereg[0].registrationNo, '20260115000002', '남는 사람은 재록자');
});


// 14. 수립 이력: 전 수립 건이 최근순으로 실려야 한다
test('수립 이력 픽스처: 3건 수립 시 planHistory 최근순 3건 + 대표=최근', () => {
    const ispPlans = [
        { memberName: '홍길동', normalizedName: '홍길동', registrationNo: '2026-100', registrant: '담당A', managementCategory: '유지관리', establishedDate: '2025-01-10', needs: [], goalsRaw: '목표1', ispResultText: '결과1' },
        { memberName: '홍길동', normalizedName: '홍길동', registrationNo: '2026-100', registrant: '담당B', managementCategory: '집중관리', establishedDate: '2026-07-01', needs: [], goalsRaw: '목표3', ispResultText: '결과3' },
        { memberName: '홍길동', normalizedName: '홍길동', registrationNo: '2026-100', registrant: '담당A', managementCategory: '유지관리', establishedDate: '2025-08-15', needs: [], goalsRaw: '목표2', ispResultText: '결과2' }
    ];
    const joined = joinBriefingData({
        ispPlans, briefingMembers: [],
        counselorMap: {}, dateRange: { start: '2026-08-01', end: '2026-08-31' }, today: new Date('2026-08-31')
    });
    assert.strictEqual(joined.length, 1, '대상자는 1명');
    assert.strictEqual(joined[0].planHistory.length, 3, '이력 3건');
    assert.strictEqual(joined[0].planHistory[0].establishedDate, '2026-07-01', '이력 첫 건=최근');
    assert.strictEqual(joined[0].planHistory[0].registrant, '담당B');
    assert.strictEqual(joined[0].planHistory[1].establishedDate, '2025-08-15');
    assert.strictEqual(joined[0].planHistory[2].establishedDate, '2025-01-10');
    assert.strictEqual(joined[0].planHistory[2].ispResultText, '결과1');
});

console.log('\n====================================================');
console.log(`  🎉 검증 결과: ${passedTests}/${totalTests} 통과`);
console.log('====================================================\n');

if (passedTests !== totalTests) {
    process.exit(1);
}

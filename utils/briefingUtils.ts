import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { IspPlan, BriefingMember, BriefingSession, BriefingComment } from '../types';

/**
 * 상태평가 16개 영역 고정 라벨표 (설계서 §2 표기 기준)
 */
export const ISP_NEED_LABELS = [
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
] as const;

export type IspNeedLabel = typeof ISP_NEED_LABELS[number];

/**
 * 사람 이름 정규화 (공백 제거)
 */
export const normalizePersonName = (value: any): string => {
    if (value == null) return '';
    return String(value).trim().replace(/\s+/g, '');
};

/**
 * 대상자 이름 익명화 강제 (첫 글자 + '00')
 * 이미 '김00', '이○○' 형태이면 유지
 */
export const anonymizeMemberName = (rawName: string): string => {
    const name = normalizePersonName(rawName);
    if (!name) return '익00';
    // 이미 김00 또는 김○○ 형태인 경우
    if (/^.[0○]{2,}$/.test(name)) return name;
    const firstChar = name.charAt(0);
    return `${firstChar}00`;
};

/**
 * Q열 장단기 목표 파싱: <장기목표>와 <단기목표> 블록 분리
 */
export const parseGoals = (goalsRaw: string | undefined): { longTermGoal: string; shortTermGoal: string; isSplit: boolean } => {
    if (!goalsRaw) {
        return { longTermGoal: '', shortTermGoal: '', isSplit: false };
    }

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

    // 분리 표기가 없으면 원문 전체를 장기목표에 담고 분리 실패 플래그
    return {
        longTermGoal: raw,
        shortTermGoal: '',
        isSplit: false
    };
};

/**
 * 관리구분 정규화: 집중 / 유지 / 일시 / 미분류
 */
export const normalizeManagementCategory = (categoryRaw: any): '집중관리' | '유지관리' | '일시관리' | '미분류' => {
    if (!categoryRaw) return '미분류';
    const cat = String(categoryRaw).replace(/\s+/g, '');
    if (cat.includes('집중')) return '집중관리';
    if (cat.includes('유지')) return '유지관리';
    if (cat.includes('일시')) return '일시관리';
    return '미분류';
};

/**
 * 관리구분별 월 목표 세션 빈도 (개별+자원 합산, 부재 제외)
 */
export const getTargetFrequencyPerMonth = (normalizedCategory: '집중관리' | '유지관리' | '일시관리' | '미분류'): number => {
    switch (normalizedCategory) {
        case '집중관리': return 4;
        case '유지관리': return 1;
        case '일시관리': return 1;
        default: return 0;
    }
};

export interface MonthlyAchievement {
    yearMonth: string; // YYYY-MM
    target: number;
    actual: number;
    achieved: boolean;
}

export interface SuitabilityEvaluation {
    suitability: '적정' | '부족' | '개입없음' | '판정제외';
    isExcessive: boolean; // 월평균이 목표의 150% 초과
    targetMonthly: number;
    actualMonthlyAvg: number;
    totalTargetMonths: number;
    achievedMonthsCount: number;
    achievementRate: number; // 0.0 ~ 1.0
    monthlyAchievements: MonthlyAchievement[];
    longestGapDays: number;
    daysSinceLastSession: number | null;
    verdictText: string;
}

/**
 * 적절성 판정 순수 함수 (설계서 §6 기준)
 */
export const evaluateSuitability = (params: {
    managementCategory: string;
    sessions: BriefingSession[]; // 해당 대상자의 전체 세션
    establishedDateStr?: string; // YYYY-MM-DD
    dateRange: { start: string; end: string };
    today?: Date;
}): SuitabilityEvaluation => {
    const { managementCategory, sessions, establishedDateStr, dateRange } = params;
    const today = params.today ? new Date(params.today) : new Date();
    today.setHours(0, 0, 0, 0);

    const normCat = normalizeManagementCategory(managementCategory);
    const targetFreq = getTargetFrequencyPerMonth(normCat);

    // 날짜 범위
    const startD = dateRange.start ? new Date(dateRange.start) : new Date('2026-01-01');
    const endD = dateRange.end ? new Date(dateRange.end) : new Date('2026-12-31');
    endD.setHours(23, 59, 59, 999);

    // 유효 개입 세션 필터 (날짜 범위 내 + 부재(노쇼) 제외)
    const validSessions = sessions.filter(s => {
        if (s.absent) return false;
        if (!s.date) return false;
        const sd = new Date(s.date);
        return sd >= startD && sd <= endD;
    });

    // 정렬 (날짜 오름차순: 간격 계산용)
    const ascSessions = [...validSessions].sort((a, b) => (a.date < b.date ? -1 : 1));

    // 최장 개입 공백 계산
    let longestGapDays = 0;
    if (ascSessions.length > 1) {
        for (let i = 1; i < ascSessions.length; i++) {
            const d1 = new Date(ascSessions[i - 1].date).getTime();
            const d2 = new Date(ascSessions[i].date).getTime();
            const diffDays = Math.round((d2 - d1) / (1000 * 3600 * 24));
            if (diffDays > longestGapDays) longestGapDays = diffDays;
        }
    }

    // 최근 개입 경과일 계산
    let daysSinceLastSession: number | null = null;
    if (ascSessions.length > 0) {
        const lastSessionDate = new Date(ascSessions[ascSessions.length - 1].date);
        lastSessionDate.setHours(0, 0, 0, 0);
        daysSinceLastSession = Math.max(0, Math.round((today.getTime() - lastSessionDate.getTime()) / (1000 * 3600 * 24)));
    }

    // 판정 대상 월 산정: max(선택 시작월, ISP 수립월) ~ 선택 종료월
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

    // 월별 세션 수 카운트
    const countByYearMonth: Record<string, number> = {};
    validSessions.forEach(s => {
        const ym = s.date.substring(0, 7); // YYYY-MM
        countByYearMonth[ym] = (countByYearMonth[ym] || 0) + 1;
    });

    const monthlyAchievements: MonthlyAchievement[] = [];
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

    let suitability: '적정' | '부족' | '개입없음' | '판정제외' = '적정';
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

    // 판정 문구 생성
    let verdictText = '';
    if (suitability === '판정제외') {
        verdictText = `관리구분(${managementCategory || '미분류'}) 미매핑으로 판정 제외 · 총 개입 ${totalActualSessions}회`;
    } else if (suitability === '개입없음') {
        verdictText = `목표 월 ${targetFreq}회 (${normCat}) · 기간 내 개입 없음 (0회)`;
    } else {
        const achieveNote = totalTargetMonths === achievedMonthsCount
            ? `${totalTargetMonths}개월 전원 달성`
            : `${totalTargetMonths}개월 중 ${achievedMonthsCount}개월만 달성`;
        verdictText = `목표 월 ${targetFreq}회 (${normCat}) · 실제 월평균 ${actualMonthlyAvg}회 — 판정 대상 ${achieveNote}.`;
        if (longestGapDays > 0) {
            verdictText += ` 최장 개입 공백 ${longestGapDays}일,`;
        }
        if (daysSinceLastSession != null) {
            verdictText += ` 최근 개입에서 ${daysSinceLastSession}일 경과.`;
        }
    }

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
        daysSinceLastSession,
        verdictText
    };
};

export interface JoinedBriefingItem {
    id: string; // key: normalizedName::counselor
    memberName: string;
    normalizedName: string;
    registrationNo: string;
    maskedRegNo: string; // …052
    counselor: string; // 주 상담자 우선, 개입 0건은 ISP 등록자 폴백
    registrant: string; // ISP 등록자
    department: string;
    managementCategory: string;
    normalizedCategory: '집중관리' | '유지관리' | '일시관리' | '미분류';
    establishedDate: string;
    isExpiring: boolean;
    daysUntilReview: number;
    reviewDueDate: string;
    needs: { label: string; score: number }[]; // 점수 1 이상 미충족 욕구
    allNeeds: { label: string; score: number }[]; // 16개 전체
    zeroNeeds: { label: string; score: number }[]; // 점수 0인 영역
    ispResultText: string;
    goalsRaw: string;
    longTermGoal: string;
    shortTermGoal: string;
    isGoalSplit: boolean;
    suicideInfo?: {
        riskFlag?: string;
        thoughtScore?: string | number;
        thoughtReason?: string;
        planFlag?: string;
        planMethod?: string;
        content?: string;
    };
    hasHighSuicideRisk: boolean;
    gender?: string;
    age?: number;
    diagnosis?: string;
    sessions: BriefingSession[]; // 전체 (날짜 내림차순)
    filteredSessions: BriefingSession[]; // 선택 기간 내 (날짜 내림차순)
    individualCount: number; // 기간 내 유효 개별상담 건수
    resourceCount: number; // 기간 내 유효 자원조정 건수
    totalInterventionCount: number;
    suitability: '적정' | '부족' | '개입없음' | '판정제외';
    isExcessive: boolean;
    suitabilityEval: SuitabilityEvaluation;
    latestSessionDate: string | null;
    joinStatus: '확정연결' | '개입없음' | 'ISP미수립' | '확인필요';
    counselorChanged: boolean;
    previousPlansCount: number;
}

/**
 * 조인 유틸 (순수 함수 — 설계서 §5)
 */
export const joinBriefingData = (params: {
    ispPlans: IspPlan[];
    briefingMembers: BriefingMember[];
    counselorMap: Record<string, string>;
    dateRange: { start: string; end: string };
    today?: Date;
}): JoinedBriefingItem[] => {
    const { ispPlans, briefingMembers, counselorMap, dateRange } = params;
    const today = params.today ? new Date(params.today) : new Date();
    today.setHours(0, 0, 0, 0);

    const ISP_REVIEW_CYCLE_DAYS = 180;

    // 1. ISP 수립 내역 정리: (정규화 이름 + 등록자) 그룹핑
    const ispGroupMap = new Map<string, IspPlan[]>();
    (ispPlans || []).forEach(plan => {
        const normName = normalizePersonName(plan.memberName || plan.normalizedName);
        const registrant = normalizePersonName(plan.registrant || '');
        const key = `${normName}::${registrant}`;
        if (!ispGroupMap.has(key)) {
            ispGroupMap.set(key, []);
        }
        ispGroupMap.get(key)!.push(plan);
    });

    // 최신 수립일 1건 대표 추출
    const ispRepresentativeMap = new Map<string, { latest: IspPlan; count: number }>();
    ispGroupMap.forEach((plans, key) => {
        const sorted = [...plans].sort((a, b) => {
            const da = a.establishedDate ? new Date(a.establishedDate).getTime() : 0;
            const db = b.establishedDate ? new Date(b.establishedDate).getTime() : 0;
            return db - da; // 최신순
        });
        ispRepresentativeMap.set(key, { latest: sorted[0], count: sorted.length });
    });

    // 2. 개입 회원 목록 정리: (정규화 이름 + 주상담사) 매핑
    const interventionMap = new Map<string, BriefingMember>();
    (briefingMembers || []).forEach(m => {
        const normName = normalizePersonName(m.memberName || m.normalizedName);
        const counselor = normalizePersonName(m.mainCounselor);
        const key = `${normName}::${counselor}`;
        interventionMap.set(key, m);
    });

    // 3. 양쪽 키 집합 구성
    const allKeys = new Set<string>();
    ispRepresentativeMap.forEach((_, k) => allKeys.add(k));
    interventionMap.forEach((_, k) => allKeys.add(k));

    const result: JoinedBriefingItem[] = [];

    allKeys.forEach(key => {
        const [normName, cName] = key.split('::');
        const ispEntry = ispRepresentativeMap.get(key);
        const memberEntry = interventionMap.get(key);

        let isp = ispEntry?.latest;
        let member = memberEntry;

        let joinStatus: '확정연결' | '개입없음' | 'ISP미수립' | '확인필요' = '확정연결';
        let counselorChanged = false;

        // ISP만 있고 개입 없는 경우
        if (isp && !member) {
            // 다른 상담사로 개입된 동일 이름이 있는지 확인 (담당 변경 가능성 탐색)
            let altMember: BriefingMember | undefined;
            interventionMap.forEach((m, altKey) => {
                if (altKey.startsWith(`${normName}::`)) {
                    altMember = m;
                }
            });

            if (altMember) {
                // 동일 이름에 다른 상담사 개입이 존재함
                // 보조 식별자(나이, 성별) 대조
                const genderMatch = !isp.gender || !altMember.gender || isp.gender === altMember.gender;
                const ageMatch = !isp.age || !altMember.age || Math.abs(isp.age - altMember.age) <= 2;

                if (genderMatch && ageMatch && !ispRepresentativeMap.has(`${normName}::${normalizePersonName(altMember.mainCounselor)}`)) {
                    // 담당 변경으로 연결
                    member = altMember;
                    counselorChanged = true;
                    joinStatus = '확정연결';
                } else {
                    joinStatus = '개입없음';
                }
            } else {
                joinStatus = '개입없음';
            }
        } else if (!isp && member) {
            // 개입만 있고 ISP 없는 경우
            joinStatus = 'ISP미수립';
        }

        const rawName = isp?.memberName || member?.memberName || normName;
        const mainCounselor = member?.mainCounselor || isp?.registrant || cName || '미지정';
        const registrant = isp?.registrant || '';
        const department = member?.department || counselorMap[mainCounselor] || counselorMap[registrant] || '부서정보없음';
        const managementCategory = isp?.managementCategory || '미분류';
        const normCat = normalizeManagementCategory(managementCategory);
        const establishedDate = isp?.establishedDate || '';

        // 재수립 만기 계산 (수립일 + 180일)
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
                // 30일 이내이거나 이미 경과한 경우
                if (daysUntilReview <= 30) {
                    isExpiring = true;
                }
            }
        }

        // 미충족 욕구: score >= 1
        const allNeeds = isp?.needs || [];
        const unmetNeeds = allNeeds.filter(n => n.score >= 1);
        const zeroNeeds = allNeeds.filter(n => n.score === 0);

        // 자살 위험 고위험 신호: R열(자살위험점수 >= 1) 또는 J열 자살·자해 여부 'Y'
        const suicideRiskScore = allNeeds.find(n => n.label.includes('자살'))?.score || 0;
        const suicideFlag = String(isp?.suicideInfo?.riskFlag || '').toUpperCase();
        const hasHighSuicideRisk = suicideRiskScore >= 1 || suicideFlag === 'Y';

        // 장단기 목표 파싱
        const goalsRaw = isp?.goalsRaw || '';
        const parsedGoals = parseGoals(goalsRaw);

        // 세션 데이터 및 적절성 평가
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

        // 등록번호 마스킹 (뒷자리 3~4자리 표기: …052)
        const rawRegNo = isp?.registrationNo || '';
        let maskedRegNo = '';
        if (rawRegNo) {
            const clean = rawRegNo.replace(/[^a-zA-Z0-9]/g, '');
            if (clean.length > 3) {
                maskedRegNo = `…${clean.slice(-3)}`;
            } else if (clean.length > 0) {
                maskedRegNo = `…${clean}`;
            }
        }

        const validInRangeSessions = inRangeSessions.filter(s => !s.absent);
        const latestSessionDate = validInRangeSessions.length > 0 ? validInRangeSessions[0].date : null;

        result.push({
            id: key,
            memberName: rawName,
            normalizedName: normName,
            registrationNo: rawRegNo,
            maskedRegNo,
            counselor: mainCounselor,
            registrant,
            department,
            managementCategory,
            normalizedCategory: normCat,
            establishedDate,
            isExpiring,
            daysUntilReview,
            reviewDueDate,
            needs: unmetNeeds,
            allNeeds,
            zeroNeeds,
            ispResultText: isp?.ispResultText || '',
            goalsRaw,
            longTermGoal: parsedGoals.longTermGoal,
            shortTermGoal: parsedGoals.shortTermGoal,
            isGoalSplit: parsedGoals.isSplit,
            suicideInfo: isp?.suicideInfo,
            hasHighSuicideRisk,
            gender: isp?.gender || member?.gender,
            age: isp?.age || member?.age,
            diagnosis: member?.diagnosis,
            sessions: sortedSessions,
            filteredSessions: inRangeSessions,
            individualCount,
            resourceCount,
            totalInterventionCount,
            suitability: suitabilityEval.suitability,
            isExcessive: suitabilityEval.isExcessive,
            suitabilityEval,
            latestSessionDate,
            joinStatus,
            counselorChanged,
            previousPlansCount: Math.max(0, (ispEntry?.count || 1) - 1)
        });
    });

    // 기본 정렬: 주의 순 (개입없음 → 부족 → 재수립 도래 → 적정)
    const priorityWeight = (item: JoinedBriefingItem): number => {
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
        // 2순위: 재수립 만기 임박순
        if (a.daysUntilReview !== b.daysUntilReview) return a.daysUntilReview - b.daysUntilReview;
        // 3순위: 이름순
        return a.normalizedName.localeCompare(b.normalizedName, 'ko');
    });
};

/**
 * 엑셀 다운로드 (설계서 §3.4 기준)
 * 4개 열 강제: [대상자(익명), 장단기 목표(원문), 담당자(실명), 수퍼비전 내용(작성자 포함, 일시 제외)]
 */
export const exportBriefingToExcel = (params: {
    members: JoinedBriefingItem[];
    comments?: Record<string, BriefingComment[]>;
    fileName?: string;
}) => {
    const { members, comments = {}, fileName } = params;

    const headers = ['대상자', '장단기 목표', '담당자', '수퍼비전 내용'];
    const rows = members.map(m => {
        const anonName = anonymizeMemberName(m.memberName);
        const goals = m.goalsRaw || '';
        const counselor = m.counselor || '';

        // 해당 대상자의 코멘트 합산
        const memberComments = comments[m.id] || [];
        const commentText = memberComments
            .map(c => (c.author ? `[${c.author}] ${c.text}` : c.text))
            .join('\n');

        return [anonName, goals, counselor, commentText];
    });

    const aoa = [headers, ...rows];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // 열 너비 지정
    ws['!cols'] = [
        { wch: 12 }, // 대상자
        { wch: 45 }, // 장단기 목표
        { wch: 12 }, // 담당자
        { wch: 60 }, // 수퍼비전 내용
    ];

    XLSX.utils.book_append_sheet(wb, ws, '풀브리핑_수퍼비전');

    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outName = fileName || `풀브리핑-수퍼비전-${todayStr}.xlsx`;

    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    saveAs(new Blob([out], { type: 'application/octet-stream' }), outName);
};

import {
    AnalysisResult,
    CounselorPerformance,
    MemberPerformance,
    ISPExpiringMember,
    IspPlan,
    BriefingMember,
    BriefingSession,
    FileCountDiagnostics
} from '../types';
import { ISP_NEED_LABELS, normalizePersonName } from '../utils/briefingUtils';

declare var XLSX: any;
declare var _: any;

const readExcelFile = (file: File, options = {}, preferSheetIncludes?: string | string[]): Promise<any[]> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (!e.target?.result) {
                    reject(new Error("File could not be read."));
                    return;
                }
                const data = new Uint8Array(e.target.result as ArrayBuffer);
                const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                
                let sheetName = workbook.SheetNames[0];
                if (preferSheetIncludes) {
                    const prefers = Array.isArray(preferSheetIncludes) ? preferSheetIncludes : [preferSheetIncludes];
                    for (const pref of prefers) {
                        const found = workbook.SheetNames.find((name: string) => name.includes(pref));
                        if (found) {
                            sheetName = found;
                            break;
                        }
                    }
                }
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, options);
                resolve(json);
            } catch (error: any) {
                reject(new Error(`"${file.name}" 파싱 오류: ${error.message}`));
            }
        };
        reader.onerror = () => reject(new Error(`"${file.name}" 읽기 오류: ${reader.error?.message ?? '알 수 없는 오류가 발생했습니다.'}`));
        reader.readAsArrayBuffer(file);
    });
};

/**
 * 워크북 시트명 배열을 빠르게 추출하는 유틸 (파일 판별 보조용)
 */
const getWorkbookSheetNames = (file: File): Promise<string[]> => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (!e.target?.result) return resolve([]);
                const data = new Uint8Array(e.target.result as ArrayBuffer);
                const workbook = XLSX.read(data, { type: 'array', bookSheets: true });
                resolve(workbook.SheetNames || []);
            } catch {
                resolve([]);
            }
        };
        reader.onerror = () => resolve([]);
        reader.readAsArrayBuffer(file);
    });
};

export const normalizeMemberRegistrationNo = (raw: any): string => {
    if (raw == null) return '';
    let str = String(raw).trim();
    if (str.includes('.') || str.includes('e')) {
        const num = Number(str);
        if (!isNaN(num)) str = String(BigInt(Math.floor(num)));
    }
    return str.replace(/[^a-zA-Z0-9]/g, '');
};

export const parseDate = (dateRaw: any): Date | null => {
    if (!dateRaw) return null;
    if (dateRaw instanceof Date) {
        return isNaN(dateRaw.getTime()) ? null : dateRaw;
    }

    // 1. Handle Excel Serial Numbers
    if (typeof dateRaw === 'number') {
        const date = new Date((dateRaw - 25569) * 86400000);
        return new Date(date.getTime() + (date.getTimezoneOffset() * 60000));
    }

    const dateStr = String(dateRaw).trim();

    // 2. YYYYMMDD 8자리 숫자 형식 (또는 뒤에 시간 있는 형식)
    const compactMatch = dateStr.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compactMatch) {
        const year = parseInt(compactMatch[1]);
        const month = parseInt(compactMatch[2]) - 1;
        const day = parseInt(compactMatch[3]);
        const date = new Date(year, month, day);
        if (!isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
            const offset = date.getTimezoneOffset() * 60000;
            return new Date(date.getTime() - offset);
        }
    }

    // 3. YYYY-MM-DD or YYYY.MM.DD or YYYY/MM/DD 형식 (시간 포함 시에도 앞 날짜 추출)
    const regex = /(\d{4})[\.\-\/\s년]*(\d{1,2})[\.\-\/\s월]*(\d{1,2})/;
    const match = dateStr.match(regex);
    if (match) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        const date = new Date(year, month, day);
        if (!isNaN(date.getTime()) && date.getFullYear() === year) {
            const offset = date.getTimezoneOffset() * 60000;
            return new Date(date.getTime() - offset);
        }
    }

    // 4. Fallback to standard Date
    const fallback = new Date(dateStr);
    if (!isNaN(fallback.getTime())) return fallback;

    return null;
};

export interface StaffRosterEntry {
    name: string;
    team: string;
}
export interface StaffRosterOptions {
    /** 시스템 등록 직원 명단 (계정 관리의 직원 계정) */
    systemStaff?: StaffRosterEntry[];
    /** 직원 설정 메뉴에서 추가한 직원 (최우선) */
    extraStaff?: StaffRosterEntry[];
}

export const analyzeAllFiles = async (
    files: File[],
    staffOptions?: StaffRosterOptions
): Promise<AnalysisResult> => {
    const requiredFileRegex = {
        '1.개별상담': /1.*개별상담|개별상담.*1/i,
        '2.자원조정': /2.*자원조정|자원조정.*2/i,
        '3.일반상담': /3.*일반상담|일반상담.*3/i,
        '5.ISP수립': /5.*(isp|수립)|(isp|수립).*5|ISP.*수립/i,
        '6.팀구별': /6.*팀구별|팀구별.*6/i,
    };

    const fileMap: { [key: string]: File } = {};
    let availableFiles = files.filter(f => !f.name.startsWith('~$'));

    // 1차: 파일명 정규식으로 매핑
    for (const [key, regex] of Object.entries(requiredFileRegex)) {
        const foundIndex = availableFiles.findIndex(file => regex.test(file.name));
        if (foundIndex !== -1) {
            fileMap[key] = availableFiles[foundIndex];
            availableFiles.splice(foundIndex, 1);
        }
    }

    // 선택 파일: 등퇴록대장 (파일명에 '등퇴록'이 있으면 먼저 선별 — 필수 아님)
    {
        const deregIdx = availableFiles.findIndex(file => /등퇴록|퇴록/.test(file.name));
        if (deregIdx !== -1) {
            fileMap['4.등퇴록대장'] = availableFiles[deregIdx];
            availableFiles.splice(deregIdx, 1);
        }
    }

    // 2차: 미매칭 슬롯에 대해 시트명 기반 판별 (설계서 §2 확정 사실 반영)
    if (Object.keys(fileMap).length < 5 && availableFiles.length > 0) {
        const sheetMapList = await Promise.all(
            availableFiles.map(async file => ({
                file,
                sheets: await getWorkbookSheetNames(file)
            }))
        );

        const slotSheetMatchers: { key: string; test: (sheets: string[]) => boolean }[] = [
            { key: '1.개별상담', test: sheets => sheets.some(s => s.includes('개별상담')) },
            { key: '2.자원조정', test: sheets => sheets.some(s => s.includes('자원조정')) },
            { key: '3.일반상담', test: sheets => sheets.some(s => s.includes('접수상담대장') || s.includes('일반상담')) },
            { key: '5.ISP수립', test: sheets => sheets.some(s => s.includes('중증정신질환') || s.includes('ISP') || s.includes('수립')) },
            { key: '6.팀구별', test: sheets => sheets.some(s => s.includes('팀구별')) },
        ];

        for (const matcher of slotSheetMatchers) {
            if (!fileMap[matcher.key]) {
                const foundItem = sheetMapList.find(item => availableFiles.includes(item.file) && matcher.test(item.sheets));
                if (foundItem) {
                    fileMap[matcher.key] = foundItem.file;
                    availableFiles = availableFiles.filter(f => f !== foundItem.file);
                }
            }
        }
    }

    const missingFiles: string[] = [];
    ['1.개별상담', '2.자원조정', '3.일반상담', '5.ISP수립'].forEach(k => {
        if (!fileMap[k]) missingFiles.push(k);
    });
    // [2026-10-27 jun 지시] 6.팀구별 파일은 선택사항 — 없어도 분석이 진행된다.

    if (missingFiles.length > 0) {
        throw new Error(`필수 파일 누락: ${missingFiles.join(', ')}`);
    }

    // 등퇴록대장 시트명 폴백: 파일명으로 못 잡았으면 남은 파일의 시트에서 '퇴록_리스트'를 찾는다
    if (!fileMap['4.등퇴록대장'] && availableFiles.length > 0) {
        for (const file of availableFiles) {
            const sheets = await getWorkbookSheetNames(file);
            if (sheets.some(name => name.includes('퇴록'))) {
                fileMap['4.등퇴록대장'] = file;
                break;
            }
        }
    }

    const findValue = (row: any, potentialKeys: string[], columnIndexFallback?: number): any => {
        const rowKeys = Object.keys(row);
        for (const pKey of potentialKeys) {
            const normalizedPKey = pKey.toLowerCase().replace(/\s+/g, '');
            for (const rKey of rowKeys) {
                const normalizedRKey = rKey.trim().toLowerCase().replace(/\s+/g, '');
                if (normalizedRKey === normalizedPKey && row[rKey] != null) {
                    return row[rKey];
                }
            }
        }
        if (columnIndexFallback !== undefined) {
            const charKey = String.fromCharCode(65 + columnIndexFallback);
            if (row[charKey] != null) return row[charKey];
            if (row[columnIndexFallback] != null) return row[columnIndexFallback];
            const lowerCharKey = charKey.toLowerCase();
            if (row[lowerCharKey] != null) return row[lowerCharKey];
        }
        return null;
    };

    // 부서(팀) 매핑 — 우선순위: 직원 설정 추가 > 시스템 등록 직원 명단 > 팀구별 파일(선택사항, 최후순위)
    // [2026-10-27 jun 지시] 팀 구분은 시스템 등록 직원 명단 + 설정 추가 직원 기준. 팀구별 파일은 더 이상 필수가 아니다.
    const counselorMap: { [key: string]: string } = {};
    if (fileMap['6.팀구별']) {
        const teamData = await readExcelFile(fileMap['6.팀구별'], { header: 1, defval: '' });
        teamData.forEach((row: any[]) => {
            const counselorName = row[0] ? String(row[0]).trim() : null;
            const departmentName = row[1] ? String(row[1]).trim() : '부서정보없음';
            const isHeaderRow = counselorName === '상담자' || counselorName === '상담사'
                || departmentName === '부서별' || departmentName === '부서';
            if (counselorName && !isHeaderRow) {
                counselorMap[counselorName] = departmentName;
            }
        });
    }
    (staffOptions?.systemStaff || []).forEach(s => {
        if (s.name) counselorMap[String(s.name).trim()] = s.team || '부서정보없음';
    });
    (staffOptions?.extraStaff || []).forEach(s => {
        if (s.name) counselorMap[String(s.name).trim()] = s.team || '부서정보없음';
    });

    // 파일 1, 2, 3 읽기
    const individualData = await readExcelFile(
        fileMap['1.개별상담'],
        { header: 'A', defval: '' },
        ['개별상담내역', '개별상담', '리스트']
    );
    const resourceData = await readExcelFile(
        fileMap['2.자원조정'],
        { header: 'A', defval: '' },
        ['자원조정내역', '자원조정', '리스트']
    );
    const generalData = await readExcelFile(
        fileMap['3.일반상담'],
        { header: 'A', defval: '' },
        ['접수상담대장', '일반상담']
    );

    const allSessionsData = [
        ...individualData.map((r: any) => ({ ...r, _category: 'individual' })),
        ...resourceData.map((r: any) => ({ ...r, _category: 'resource' }))
    ];

    // [2026-10-27 jun 지시] 상담사 구분은 데이터 파일의 상담자 이름 기준 (개별/자원 X열, 일반 N열).
    // 팀구별 파일은 부서명 매핑용으로만 사용하고, 팀구별에 없는 상담사라도 행을 제외하지 않는다.
    // 따라서 상담사 실적 엔트리는 데이터에서 등장할 때 동적으로 생성한다.
    const counselorPerformance: { [key: string]: CounselorPerformance } = {};
    const getOrCreatePerf = (name: string): CounselorPerformance => {
        if (!counselorPerformance[name]) {
            counselorPerformance[name] = {
                counselorName: name,
                department: counselorMap[name] || '부서정보없음',
                types: { inOffice: 0, visit: 0, online: 0, emergency: 0, phone: 0 },
                faceToFaceSessions: [],
                allSessions: [],
                totalSessions: 0,
                totalEmergency: 0,
                totalGeneral: 0
            };
        }
        return counselorPerformance[name];
    };

    const memberPerformanceMap: { [key: string]: MemberPerformance } = {};

    // 브리핑 전용 중간 데이터 구조: 대상자 정규화 이름별 세션 및 메타데이터 수집
    interface BriefingRowMeta {
        counselor: string;
        date: string;
        rawDate: any;
        category: 'individual' | 'resource';
        type: 'inOffice' | 'visit' | 'online' | 'phone';
        rawType: string;
        emergency: boolean;
        absent: boolean;
        topic: string;
        problemArea?: string;
        needItem?: string;
        content?: string;
        memberName: string;
        normalizedName: string;
        gender?: string;
        age?: number;
        diagnosis?: string;
        diagnosisCode?: string;
    }

    const briefingRows: BriefingRowMeta[] = [];

    // 건수 진단 (개인정보 없이 사유별 건수만 집계)
    const newDiag = (fileLabel: string): FileCountDiagnostics => ({
        fileLabel, totalRows: 0, counted: 0, absentCounted: 0,
        dropNoCounselor: 0, dropCounselorNotInTeam: 0, dropBadDate: 0, dropTypeUnknown: 0
    });
    const diagIndividual = newDiag('1.개별상담');
    const diagResource = newDiag('2.자원조정');
    const diagGeneral = newDiag('3.일반상담');

    allSessionsData.forEach((row: any) => {
        // 신규 24열 양식(X열 상담자) 여부 확인
        const isNewFormat = Boolean(row['X'] != null && String(row['X']).trim() !== '');

        let counselorRaw: any;
        let memberNameRaw: any;
        let dateRaw: any;
        let typeRaw: any;
        let emergencyRaw: any;
        let absentRaw: any;
        let topicRaw: any;
        let contentRaw: any;
        let problemAreaRaw: any;
        let needItemRaw: any;
        let genderRaw: any;
        let ageRaw: any;
        let diagnosisRaw: any;
        let diagnosisCodeRaw: any;
        let regNoRaw: any;

        if (isNewFormat) {
            // 신규 24열 양식 매핑 (설계서 §2 표 기준)
            counselorRaw = row['X'];
            memberNameRaw = row['D'];
            genderRaw = row['E'];
            ageRaw = row['F'];
            diagnosisRaw = row['G'];
            diagnosisCodeRaw = row['H'];
            // 일자: 개별상담·자원조정 모두 I열 (2026-10-27 jun 확인 — 자원조정 J열 가정은 오기)
            dateRaw = row['I'];
            typeRaw = row['O'];
            // 부재여부: 개별상담 P열, 자원조정 Q열
            absentRaw = row._category === 'individual' ? row['P'] : row['Q'];
            // 응급개입: 개별상담 Q열, 자원조정 R열 ('응급'/'비응급' 텍스트)
            emergencyRaw = row._category === 'individual' ? row['Q'] : row['R'];
            problemAreaRaw = row['T'];
            needItemRaw = row['U'];
            topicRaw = row['V'];
            contentRaw = row['W'];
        } else {
            // 기존 실적 리스트 양식 폴백 (회귀 지원)
            counselorRaw = findValue(row, ['C', 'c', '상담자', '등록자', '담당자'], 2);
            memberNameRaw = findValue(row, ['G', 'g', '성명', '회원명', '대상자'], 6);
            genderRaw = row['H'];
            ageRaw = row['I'];
            dateRaw = findValue(row, ['L', 'l', '상담일자2', '상담일자'], 11) || row['D'];
            typeRaw = findValue(row, ['K', 'k', '상담유형', '유형'], 10);
            emergencyRaw = findValue(row, ['J', 'j', '응급개입'], 9);
            regNoRaw = findValue(row, ['F', 'f', '회원등록번호', '등록번호'], 5);
        }

        const counselor = counselorRaw ? String(counselorRaw).trim() : null;
        const memberNameStr = memberNameRaw ? String(memberNameRaw).trim() : '';

        // 헤더 행은 진단 집계에서 제외하고 스킵
        const isHeaderRow = counselor === '상담자' || counselor === '상담사' ||
            memberNameStr === '회원명' || memberNameStr === '성명' || memberNameStr === '이름' || memberNameStr === '대상자';
        if (isHeaderRow) return;

        // 건수 진단: 상담사 기준 제외 사유
        // [2026-10-27 jun 지시] 팀구별 파일에 없어도 제외하지 않으므로 dropCounselorNotInTeam은 항상 0이다.
        const diag = row._category === 'individual' ? diagIndividual : diagResource;
        diag.totalRows++;
        if (!counselor) { diag.dropNoCounselor++; return; }

        const date = parseDate(dateRaw);
        const isoDate = date && !isNaN(date.getTime()) ? date.toISOString().split('T')[0] : null;

        // 부재(노쇼) 여부 판정
        const absentStr = String(absentRaw || '').trim().toLowerCase();
        const isAbsent = absentStr === 'y' || absentStr.includes('부재');

        // 응급 여부 판정 ('응급'/'비응급' 텍스트 또는 'y')
        const emergStr = String(emergencyRaw || '').trim().toLowerCase();
        const isEmergency = emergStr === 'y' || (emergStr.includes('응급') && !emergStr.includes('비응급'));

        // 상담형태 (내소, 방문, 온라인, 전화)
        const typeStr = String(typeRaw || '').toLowerCase();
        const isInOffice = typeStr.includes('내소');
        const isVisit = typeStr.includes('방문') || typeStr.includes('대면') || typeStr.includes('출장') || typeStr.includes('현장');
        const isOnline = typeStr.includes('온라인');
        const isPhone = typeStr.includes('유선') || typeStr.includes('전화');

        let sessionType: 'inOffice' | 'visit' | 'online' | 'emergency' | 'phone' | null = null;
        if (isEmergency) sessionType = 'emergency';
        else if (isInOffice) sessionType = 'inOffice';
        else if (isVisit) sessionType = 'visit';
        else if (isOnline) sessionType = 'online';
        else if (isPhone) sessionType = 'phone';

        // 4. [2026-10-26 jun 결정 변경] 부재(노쇼) 건도 건수에 포함한다.
        //    단, faceToFaceSessions(연도 자동감지용)는 실제 진행 건만 유지한다.
        //    적절성 판정은 briefingUtils에서 별도로 부재를 제외한다.
        {
            const perf = getOrCreatePerf(counselor);
            perf.totalSessions++;

            if (!isAbsent && (isInOffice || isVisit) && isoDate) {
                perf.faceToFaceSessions.push({ date: isoDate });
            }

            let isGeneralSession = false;
            if (isEmergency) {
                perf.types.emergency++;
                perf.totalEmergency++;
                isGeneralSession = true;
            } else if (isInOffice) {
                perf.types.inOffice++;
                isGeneralSession = true;
            } else if (isVisit) {
                perf.types.visit++;
                isGeneralSession = true;
            } else if (isOnline) {
                perf.types.online++;
                isGeneralSession = true;
            } else if (isPhone) {
                perf.types.phone++;
                isGeneralSession = true;
            }
            if (isGeneralSession) perf.totalGeneral++;

            if (isGeneralSession && isoDate && sessionType) {
                perf.allSessions.push({ date: isoDate, type: sessionType, category: row._category as any, absent: isAbsent });
                diag.counted++;
                if (isAbsent) diag.absentCounted++;
            } else if (!isoDate) {
                diag.dropBadDate++;
            } else if (!sessionType) {
                diag.dropTypeUnknown++;
            }

            // MemberPerformance 집계 (회원/월별 탭용)
            if (memberNameStr && date) {
                const regNo = normalizeMemberRegistrationNo(regNoRaw);
                if (!memberPerformanceMap[memberNameStr]) {
                    memberPerformanceMap[memberNameStr] = {
                        memberName: memberNameStr,
                        registrationNo: regNo,
                        department: '',
                        mainCounselor: '',
                        totalSessions: 0,
                        detailedSessions: [],
                        _counselorStats: {}
                    } as any;
                }

                const memberStat = memberPerformanceMap[memberNameStr] as any;
                if (!memberStat.registrationNo && regNo) {
                    memberStat.registrationNo = regNo;
                }
                memberStat.totalSessions++;

                if (!memberStat._counselorStats[counselor]) {
                    memberStat._counselorStats[counselor] = { count: 0, lastDate: 0 };
                }
                const cStat = memberStat._counselorStats[counselor];
                cStat.count++;
                if (date.getTime() > cStat.lastDate) {
                    cStat.lastDate = date.getTime();
                }

                const month = date.getMonth() + 1;
                let finalType: 'inOffice' | 'visit' | 'online' | 'phone' | null = null;
                if (isInOffice) finalType = 'inOffice';
                else if (isVisit) finalType = 'visit';
                else if (isOnline) finalType = 'online';
                else if (isPhone) finalType = 'phone';

                if (finalType) {
                    memberStat.detailedSessions.push({
                        month,
                        category: row._category as 'individual' | 'resource',
                        type: finalType
                    });
                }
            }
        }

        // 브리핑 전용 세션 행 수집 (부재 건도 absent: true로 함께 수집)
        if (memberNameStr && isoDate) {
            const ageNum = ageRaw != null && !isNaN(Number(ageRaw)) ? Number(ageRaw) : undefined;
            briefingRows.push({
                counselor,
                date: isoDate,
                rawDate: dateRaw,
                category: row._category,
                type: sessionType || 'inOffice',
                rawType: String(typeRaw || '').trim(),
                emergency: isEmergency,
                absent: isAbsent,
                topic: String(topicRaw || '').trim() || (isAbsent ? '부재(미진행)' : '상담 진행'),
                problemArea: problemAreaRaw ? String(problemAreaRaw).trim() : undefined,
                needItem: needItemRaw ? String(needItemRaw).trim() : undefined,
                content: contentRaw ? String(contentRaw).trim() : undefined,
                memberName: memberNameStr,
                normalizedName: normalizePersonName(memberNameStr),
                gender: genderRaw ? String(genderRaw).trim() : undefined,
                age: ageNum,
                diagnosis: diagnosisRaw ? String(diagnosisRaw).trim() : undefined,
                diagnosisCode: diagnosisCodeRaw ? String(diagnosisCodeRaw).trim() : undefined,
            });
        }
    });

    // MemberPerformance 주 상담자 산정
    Object.values(memberPerformanceMap).forEach((member: any) => {
        let maxCount = -1;
        let bestCounselor = '미지정';
        let bestDate = 0;

        Object.entries(member._counselorStats || {}).forEach(([cName, stats]: [string, any]) => {
            if (stats.count > maxCount) {
                maxCount = stats.count;
                bestCounselor = cName;
                bestDate = stats.lastDate;
            } else if (stats.count === maxCount) {
                if (stats.lastDate > bestDate) {
                    bestCounselor = cName;
                    bestDate = stats.lastDate;
                }
            }
        });

        member.mainCounselor = bestCounselor;
        member.department = counselorMap[bestCounselor] || '부서정보없음';
        delete member._counselorStats;
    });

    // 3. 일반상담 데이터 처리 (File 3) — 건수 진단 포함
    generalData.forEach((row: any) => {
        const counselorRaw = row['N'];
        const counselor = counselorRaw ? String(counselorRaw).trim() : '';

        // 헤더 행은 진단 집계에서 제외하고 스킵
        if (counselor === '상담자' || counselor === '상담사') return;

        diagGeneral.totalRows++;
        if (!counselor) { diagGeneral.dropNoCounselor++; return; }
        // [2026-10-27 jun 지시] 일반상담도 N열 상담자 이름 기준으로 구분하고 팀구별 게이트를 적용하지 않는다.

        const dateRaw = row['D'];
        const date = parseDate(dateRaw);
        const isoDate = date && !isNaN(date.getTime()) ? date.toISOString().split('T')[0] : null;
        if (!isoDate) { diagGeneral.dropBadDate++; return; }

        const typeRaw = String(row['AH'] || '').toLowerCase();
        let sessionType: 'inOffice' | 'visit' | 'online' | 'emergency' | 'phone' | null = null;
        if (typeRaw.includes('응급')) sessionType = 'emergency';
        else if (typeRaw.includes('내소')) sessionType = 'inOffice';
        else if (typeRaw.includes('방문') || typeRaw.includes('대면') || typeRaw.includes('출장') || typeRaw.includes('현장')) sessionType = 'visit';
        else if (typeRaw.includes('온라인')) sessionType = 'online';
        else if (typeRaw.includes('유선') || typeRaw.includes('전화')) sessionType = 'phone';

        if (sessionType) {
            const perf = getOrCreatePerf(counselor);
            perf.allSessions.push({ date: isoDate, type: sessionType, category: 'general' });
            diagGeneral.counted++;
        } else {
            diagGeneral.dropTypeUnknown++;
        }
    });

    // 5. ISP수립 파일 파싱: 전 필드 열 매핑 이관 (설계서 §4.1)
    const ispData = await readExcelFile(
        fileMap['5.ISP수립'],
        { header: 'A', defval: '' },
        ['중증정신질환', 'ISP', '수립']
    );

    const ispPlans: IspPlan[] = [];
    const ispExpiringMembers: ISPExpiringMember[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ISP_REVIEW_CYCLE_DAYS = 180;

    const needCols = ['R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG'];

    ispData.forEach((row: any, arrayIndex: number) => {
        const rawName = row['D'];
        const memberName = rawName ? String(rawName).trim() : '';

        // 헤더 행 스킵 (1·2행)
        if (
            !memberName ||
            memberName === '이름' ||
            memberName === '성명' ||
            row['C'] === '회원등록번호' ||
            row['C'] === '회원번호' ||
            row['G'] === '수립일자' ||
            row['G'] === '수립일' ||
            row['R'] === '자살, 자해 및 타해 위험' ||
            row['R'] === '자살·자해 및 타해 위험'
        ) {
            return;
        }

        const normalizedName = normalizePersonName(memberName);
        const registrationNoRaw = row['C'];
        const registrationNo = normalizeMemberRegistrationNo(registrationNoRaw);
        const establishedDateRaw = row['G'];
        const establishedDate = parseDate(establishedDateRaw);
        const registrant = row['H'] ? String(row['H']).trim() : '';
        const managementCategoryRaw = row['I'];
        const managementCategory = managementCategoryRaw ? String(managementCategoryRaw).trim() : '미분류';
        const gender = row['E'] ? String(row['E']).trim() : undefined;
        const ageNum = row['F'] != null && !isNaN(Number(row['F'])) ? Number(row['F']) : undefined;

        // 실제 Excel 행 번호 (0-based arrayIndex + 1)
        const actualExcelRowNum = arrayIndex + 1;

        if (establishedDate) {
            // J~O 자살정보 추출
            const suicideInfo = {
                riskFlag: row['J'] ? String(row['J']).trim() : '',
                thoughtScore: row['K'] !== undefined ? row['K'] : '',
                thoughtReason: row['L'] ? String(row['L']).trim() : '',
                planFlag: row['M'] ? String(row['M']).trim() : '',
                planMethod: row['N'] ? String(row['N']).trim() : '',
                content: row['O'] ? String(row['O']).trim() : ''
            };

            // P열 ISP결과 원문
            const ispResultText = row['P'] ? String(row['P']).trim() : '';

            // Q열 장단기 목표 원문
            const goalsRaw = row['Q'] ? String(row['Q']).trim() : '';

            // R~AG 16개 영역 상태평가 점수
            const needs = needCols.map((col, idx) => ({
                label: ISP_NEED_LABELS[idx],
                score: Number(row[col]) || 0
            }));

            ispPlans.push({
                registrationNo: registrationNoRaw ? String(registrationNoRaw).trim() : '',
                normalizedRegistrationNo: registrationNo,
                memberName: memberName,
                normalizedName: normalizedName,
                managementCategory: managementCategory,
                establishedDate: establishedDate.toISOString().split('T')[0],
                registrant: registrant,
                gender: gender,
                age: ageNum,
                excelRowNumber: actualExcelRowNum,
                parseStatus: 'success',
                needs,
                ispResultText,
                goalsRaw,
                suicideInfo
            });

            // 재수립 만기 판정 (기존 호환 유지)
            if (registrant && counselorMap[registrant]) {
                const dueDate = new Date(establishedDate);
                dueDate.setHours(0, 0, 0, 0);
                dueDate.setDate(dueDate.getDate() + ISP_REVIEW_CYCLE_DAYS);
                const timeDiff = dueDate.getTime() - today.getTime();
                const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
                if (daysDiff <= 30) {
                    ispExpiringMembers.push({
                        id: registrationNo || `N/A-${actualExcelRowNum}`,
                        name: memberName,
                        registrant: registrant,
                        date: dueDate.toISOString().split('T')[0],
                        daysPassed: -daysDiff,
                        rowNum: actualExcelRowNum
                    });
                }
            }
        }
    });

    // 브리핑 회원 전용 컬렉션 구성 (설계서 §4.3, §5 조인 대비)
    // ISP 등록자 목록을 인지하여 동일 이름 분리(동명이인) 지원
    const ispRegistrantSetByNormName = new Map<string, Set<string>>();
    ispPlans.forEach(plan => {
        if (plan.registrant) {
            if (!ispRegistrantSetByNormName.has(plan.normalizedName)) {
                ispRegistrantSetByNormName.set(plan.normalizedName, new Set());
            }
            ispRegistrantSetByNormName.get(plan.normalizedName)!.add(plan.registrant);
        }
    });

    // (정규화 이름, 담당자) 단위로 세션 묶음 생성
    interface MemberCluster {
        memberName: string;
        normalizedName: string;
        gender?: string;
        age?: number;
        diagnosis?: string;
        diagnosisCode?: string;
        mainCounselor: string;
        sessions: BriefingSession[];
        counselorCounts: Record<string, number>;
    }

    const clusterMap = new Map<string, MemberCluster>();

    briefingRows.forEach(row => {
        const normName = row.normalizedName;
        const ispRegistrants = ispRegistrantSetByNormName.get(normName);

        // 기본 클러스터 키 결정:
        // 만약 해당 이름에 ISP 수립 등록자가 여럿 존재(동명이인)하고 세션의 상담사가 그중 하나와 일치하면 해당 등록자 클러스터로 배정
        let targetCounselor = row.counselor;
        if (ispRegistrants && ispRegistrants.size > 1) {
            if (ispRegistrants.has(row.counselor)) {
                targetCounselor = row.counselor;
            }
        }

        const clusterKey = `${normName}::${targetCounselor}`;
        if (!clusterMap.has(clusterKey)) {
            clusterMap.set(clusterKey, {
                memberName: row.memberName,
                normalizedName: row.normalizedName,
                gender: row.gender,
                age: row.age,
                diagnosis: row.diagnosis,
                diagnosisCode: row.diagnosisCode,
                mainCounselor: targetCounselor,
                sessions: [],
                counselorCounts: {}
            });
        }

        const cluster = clusterMap.get(clusterKey)!;
        if (!cluster.gender && row.gender) cluster.gender = row.gender;
        if (!cluster.age && row.age) cluster.age = row.age;
        if (!cluster.diagnosis && row.diagnosis) cluster.diagnosis = row.diagnosis;
        if (!cluster.diagnosisCode && row.diagnosisCode) cluster.diagnosisCode = row.diagnosisCode;

        cluster.counselorCounts[row.counselor] = (cluster.counselorCounts[row.counselor] || 0) + 1;
        cluster.sessions.push({
            date: row.date,
            category: row.category,
            type: row.type,
            rawType: row.rawType,
            counselor: row.counselor,
            emergency: row.emergency,
            absent: row.absent,
            topic: row.topic,
            problemArea: row.problemArea,
            needItem: row.needItem,
            content: row.content
        });
    });

    // 주 상담자 확정 및 BriefingMember 배열 생성
    const briefingMembers: BriefingMember[] = [];
    clusterMap.forEach((cluster) => {
        let maxCount = -1;
        let bestCounselor = cluster.mainCounselor;
        Object.entries(cluster.counselorCounts).forEach(([cName, cnt]) => {
            if (cnt > maxCount) {
                maxCount = cnt;
                bestCounselor = cName;
            }
        });

        briefingMembers.push({
            memberName: cluster.memberName,
            normalizedName: cluster.normalizedName,
            gender: cluster.gender,
            age: cluster.age,
            diagnosis: cluster.diagnosis,
            diagnosisCode: cluster.diagnosisCode,
            mainCounselor: bestCounselor,
            department: counselorMap[bestCounselor] || '부서정보없음',
            sessions: cluster.sessions.sort((a, b) => (b.date > a.date ? 1 : -1))
        });
    });

    // 등퇴록대장 파싱 (선택): 퇴록_리스트 D열 회원등록번호 수집 — 풀브리핑 퇴록자 제외용
    const deregisteredRegNos: string[] = [];
    if (fileMap['4.등퇴록대장']) {
        const deregData = await readExcelFile(
            fileMap['4.등퇴록대장'],
            { header: 'A', defval: '' },
            ['퇴록_리스트', '퇴록']
        );
        const seen = new Set<string>();
        deregData.forEach((row: any) => {
            const raw = row['D'];
            if (raw == null || String(raw).trim() === '' || String(raw).trim() === '회원등록번호') return;
            const no = normalizeMemberRegistrationNo(raw);
            if (no && !seen.has(no)) {
                seen.add(no);
                deregisteredRegNos.push(no);
            }
        });
    }

    return {
        counselorPerformance: Object.values(counselorPerformance),
        memberPerformance: Object.values(memberPerformanceMap),
        ispExpiringMembers: ispExpiringMembers.sort((a, b) => a.daysPassed - b.daysPassed),
        ispPlans: ispPlans,
        briefingMembers: briefingMembers,
        deregisteredRegNos: deregisteredRegNos,
        diagnostics: { files: [diagIndividual, diagResource, diagGeneral] }
    };
};

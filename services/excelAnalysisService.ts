import { AnalysisResult, CounselorPerformance, MemberPerformance, ISPExpiringMember, IspPlan } from '../types';

declare var XLSX: any;
declare var _: any;

const readExcelFile = (file: File, options = {}): Promise<any[]> => {
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
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, options);
                resolve(json);
            } catch (error: any) {
                reject(new Error(`"${file.name}" 파싱 오류: ${error.message}`));
            }
        };
        // FIX: The `onerror` event handler for FileReader receives a ProgressEvent, which does not have a `message` property. The actual error is stored in `reader.error`.
        reader.onerror = () => reject(new Error(`"${file.name}" 읽기 오류: ${reader.error?.message ?? '알 수 없는 오류가 발생했습니다.'}`));
        reader.readAsArrayBuffer(file);
    });
};

export const analyzeAllFiles = async (files: File[]): Promise<AnalysisResult> => {
    const requiredFileRegex = {
        '1.개별상담': /1.*개별상담|개별상담.*1/i,
        '2.자원조정': /2.*자원조정|자원조정.*2/i,
        '3.일반상담': /3.*일반상담|일반상담.*3/i,
        '5.ISP수립': /5.*(isp|수립)|(isp|수립).*5|ISP.*수립/i,
        '6.팀구별': /6.*팀구별|팀구별.*6/i,
    };

    const fileMap: { [key: string]: File } = {};
    const missingFiles: string[] = [];
    let availableFiles = files.filter(f => !f.name.startsWith('~$'));

    for (const [key, regex] of Object.entries(requiredFileRegex)) {
        const foundIndex = availableFiles.findIndex(file => regex.test(file.name));

        if (foundIndex !== -1) {
            fileMap[key] = availableFiles[foundIndex];
            availableFiles.splice(foundIndex, 1);
        } else {
            missingFiles.push(key);
        }
    }

    if (missingFiles.length > 0) {
        throw new Error(`필수 파일 누락: ${missingFiles.join(', ')}`);
    }

    const findValue = (row: any, potentialKeys: string[], columnIndexFallback?: number): any => {
        const rowKeys = Object.keys(row);
        
        // 1. Try matching by header names
        for (const pKey of potentialKeys) {
            const normalizedPKey = pKey.toLowerCase().replace(/\s+/g, '');
            for (const rKey of rowKeys) {
                const normalizedRKey = rKey.trim().toLowerCase().replace(/\s+/g, '');
                if (normalizedRKey === normalizedPKey && row[rKey] != null) {
                    return row[rKey];
                }
            }
        }
        
        // 2. Try index-based fallback if provided
        // In many XLSX parsers, the row object might have keys like "A", "B", "C"...
        if (columnIndexFallback !== undefined) {
            const charKey = String.fromCharCode(65 + columnIndexFallback); // 0 -> A, 3 -> D, 6 -> G
            if (row[charKey] != null) return row[charKey];
            
            // Also check for raw index keys if available
            if (row[columnIndexFallback] != null) return row[columnIndexFallback];
            
            // Try lowercase char key
            const lowerCharKey = charKey.toLowerCase();
            if (row[lowerCharKey] != null) return row[lowerCharKey];
        }

        return null;
    };

    const normalizePersonName = (value: any): string | null => {
        if (value == null) return null;
        const text = String(value).trim().replace(/\s+/g, '');
        return text || null;
    };

    const normalizeMemberRegistrationNo = (raw: any): string => {
        if (raw == null) return '';
        let str = String(raw).trim();
        // Handle scientific notation or ".0" suffix from Excel
        if (str.includes('.') || str.includes('e')) {
            const num = Number(str);
            if (!isNaN(num)) str = String(BigInt(Math.floor(num)));
        }
        // Remove all non-alphanumeric characters (hyphens, spaces, etc.)
        return str.replace(/[^a-zA-Z0-9]/g, '');
    };

    const parseDate = (dateRaw: any): Date | null => {
        if (!dateRaw) return null;
        if (dateRaw instanceof Date) return dateRaw;

        // 1. Handle Excel Serial Numbers
        if (typeof dateRaw === 'number') {
            const date = new Date((dateRaw - 25569) * 86400000);
            return new Date(date.getTime() + (date.getTimezoneOffset() * 60000));
        }

        const dateStr = String(dateRaw).trim();

        // 2. Aggressive Regex Parse (Common Korean Formats)
        // Matches: 2024.05.01, 2024-5-1, 2024년 5월 1일, 2024/05/01
        const regex = /(\d{4})[\.\-\/\s년]*(\d{1,2})[\.\-\/\s월]*(\d{1,2})/;
        const match = dateStr.match(regex);

        if (match) {
            const year = parseInt(match[1]);
            const month = parseInt(match[2]) - 1; // Month is 0-indexed
            const day = parseInt(match[3]);
            const date = new Date(year, month, day);
            // Basic validation
            if (!isNaN(date.getTime()) && date.getFullYear() === year) {
                // Adjust for timezone offset to keep strict YYYY-MM-DD
                const offset = date.getTimezoneOffset() * 60000;
                return new Date(date.getTime() - offset);
            }
        }

        // 3. Fallback to standard Date parser
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) return date;

        console.warn(`Failed to parse date: ${dateRaw}`);
        return null;
    };

    const teamData = await readExcelFile(fileMap['6.팀구별'], { header: 1, defval: '' });
    const counselorMap = teamData.reduce((acc: { [key: string]: string }, row: any[]) => {
        const counselorName = row[0] ? String(row[0]).trim() : null;
        const departmentName = row[1] ? String(row[1]).trim() : '부서정보없음';

        if (counselorName && counselorName !== '상담사') {
            acc[counselorName] = departmentName;
        }
        return acc;
    }, {});

    const validCounselors = Object.keys(counselorMap);
    if (validCounselors.length === 0) throw new Error("'6.팀구별' 파일에서 상담사 정보를 찾을 수 없거나 형식이 올바르지 않습니다.");

    const individualData = await readExcelFile(fileMap['1.개별상담'], { header: 'A', defval: '' });
    const resourceData = await readExcelFile(fileMap['2.자원조정'], { header: 'A', defval: '' });
    // Read General Counseling using 'A', 'B', 'C' column headers
    const generalData = await readExcelFile(fileMap['3.일반상담'], { header: 'A', defval: '' });

    const ispData = await readExcelFile(fileMap['5.ISP수립']);
    const allSessionsData = [
        ...individualData.map((r: any) => ({ ...r, _category: 'individual' })),
        ...resourceData.map((r: any) => ({ ...r, _category: 'resource' }))
    ];

    const counselorPerformance: { [key: string]: CounselorPerformance } = {};
    validCounselors.forEach(c => {
        counselorPerformance[c] = {
            counselorName: c, department: counselorMap[c],
            types: { inOffice: 0, visit: 0, online: 0, emergency: 0, phone: 0 },
            faceToFaceSessions: [],
            allSessions: [],
            totalSessions: 0, totalEmergency: 0, totalGeneral: 0
        };
    });

    const memberPerformanceMap: { [key: string]: MemberPerformance } = {};

    allSessionsData.forEach((row: any) => {
        // Enforce Column C for Counselor if available (User specified C column)
        const counselorName = findValue(row, ['C', 'c', '상담자', '등록자', '담당자', '수행인력', '실시자', '진행자', '서비스제공자', 'c열', 'C열']);
        const counselor = counselorName ? String(counselorName).trim() : null;

        // Valid Counselor Check & Header Row Skip
        if (!counselor || !validCounselors.includes(counselor)) return;

        // Date (L column)
        const date = parseDate(findValue(row, ['L', 'l', '상담일', '상담일자', '일자', '일시', '상담일시', '날짜', '서비스일자', '제공일자', '실시일자', 'l열', 'L열']));
        const isoDate = date && !isNaN(date.getTime()) ? date.toISOString().split('T')[0] : null;

        const perf = counselorPerformance[counselor];
        perf.totalSessions++;

        // Type (K column)
        const type = String(findValue(row, ['K', 'k', '상담유형', '유형', '상담 방법', 'k열', 'K열']) || '').toLowerCase();
        // Emergency (J column)
        const emergencyValue = String(findValue(row, ['J', 'j', '응급개입', 'j열', 'J열']) || '').trim().toLowerCase();
        const isEmergency = emergencyValue === 'y';

        const isInOffice = type.includes('내소');
        const isVisit = type.includes('방문') || type.includes('대면') || type.includes('출장') || type.includes('현장');
        const isOnline = type.includes('온라인');
        const isPhone = type.includes('유선') || type.includes('전화');

        if ((isInOffice || isVisit) && isoDate) {
            perf.faceToFaceSessions.push({ date: isoDate });
        }

        let isGeneralSession = false;
        // Fix: Removed isEmergencyFinal redeclaration and simplified logic
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

        // Fix: Add to allSessions for comprehensive date filtering
        if (isGeneralSession && isoDate) {
            let sessionType: 'inOffice' | 'visit' | 'online' | 'emergency' | 'phone' | null = null;
            if (isEmergency) sessionType = 'emergency';
            else if (isInOffice) sessionType = 'inOffice';
            else if (isVisit) sessionType = 'visit';
            else if (isOnline) sessionType = 'online';
            else if (isPhone) sessionType = 'phone';

            if (sessionType) {
                perf.allSessions.push({ date: isoDate, type: sessionType, category: row._category as any });
            }
        }

        // Member Analysis Population - Enforce Column G (User specified G column)
        const memberName = findValue(row, ['G', 'g', '성명', '대상자성명', '이름', '회원명', '대상자', '이용자명']);
        const registrationNoRaw = findValue(row, ['회원번호', '등록번호', 'registrationNo', 'membershipNo', 'A', 'a']);
        const registrationNo = normalizeMemberRegistrationNo(registrationNoRaw);

        if (memberName && date) {
            const trimmedMember = String(memberName).trim();
            const trimmedRegNo = registrationNo;

            if (!memberPerformanceMap[trimmedMember]) {
                memberPerformanceMap[trimmedMember] = {
                    memberName: trimmedMember,
                    registrationNo: trimmedRegNo,
                    department: '', // Will be determined by Main Counselor
                    mainCounselor: '', // Will be calculated after processing all rows
                    totalSessions: 0,
                    detailedSessions: [],
                    _counselorStats: {} // Temporary storage for logic
                } as any;
            }

            const memberStat = memberPerformanceMap[trimmedMember] as any;
            if (!memberStat.registrationNo && trimmedRegNo) {
                memberStat.registrationNo = trimmedRegNo;
            }
            memberStat.totalSessions++;

            // Track Counselor Stats for Primary determination
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

            // Only count if it's one of the tracked types
            if (finalType) {
                memberStat.detailedSessions.push({
                    month,
                    category: row._category as 'individual' | 'resource',
                    type: finalType
                });
            }
        }
    });

    // Post-process: Determine Primary Caseworker
    Object.values(memberPerformanceMap).forEach((member: any) => {
        let maxCount = -1;
        let bestCounselor = '미지정';
        let bestDate = 0;

        Object.entries(member._counselorStats).forEach(([cName, stats]: [string, any]) => {
            // Logic: Max Count first, then Most Recent Date
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

        // Assign Best Counselor (Name Only as per user request)
        member.mainCounselor = bestCounselor;
        member.department = counselorMap[bestCounselor] || '부서정보없음';
        delete member._counselorStats; // Cleanup
    });

    // 2. Process General Counseling Data (File 3) - For 'allSessions' (General Analysis Tab)
    // Mappings: N (Counselor), D (Date), AH (Type)
    generalData.forEach((row: any) => {
        const counselorRaw = row['N'];
        if (!counselorRaw) return;

        const counselor = String(counselorRaw).trim();
        // Skip header or invalid counselor
        if (!validCounselors.includes(counselor)) return;

        const dateRaw = row['D'];
        const date = parseDate(dateRaw);
        const isoDate = date && !isNaN(date.getTime()) ? date.toISOString().split('T')[0] : null;

        // Skip if no valid date
        if (!isoDate) return;

        const typeRaw = String(row['AH'] || '').toLowerCase();

        let sessionType: 'inOffice' | 'visit' | 'online' | 'emergency' | 'phone' | null = null;

        if (typeRaw.includes('응급')) sessionType = 'emergency';
        else if (typeRaw.includes('내소')) sessionType = 'inOffice';
        else if (typeRaw.includes('방문') || typeRaw.includes('대면') || typeRaw.includes('출장') || typeRaw.includes('현장')) sessionType = 'visit';
        else if (typeRaw.includes('온라인')) sessionType = 'online';
        else if (typeRaw.includes('유선') || typeRaw.includes('전화')) sessionType = 'phone';

        if (sessionType) {
            const perf = counselorPerformance[counselor];
            if (perf && perf.allSessions) {
                perf.allSessions.push({ date: isoDate, type: sessionType, category: 'general' });
            }
        }
    });

    const ispPlans: IspPlan[] = [];
    const ispExpiringMembers: ISPExpiringMember[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    ispData.forEach((row: any, index: number) => {
        const rawName = findValue(row, ['성명', '이름', '회원명'], 3); // D Column Fallback
        const memberName = rawName ? String(rawName).trim() : '이름없음';
        const normalizedName = normalizePersonName(rawName) || '이름없음';
        
        const registrationNoRaw = findValue(row, ['회원등록번호', '회원번호', '등록번호']);
        const registrationNo = normalizeMemberRegistrationNo(registrationNoRaw);
        
        const managementCategory = findValue(row, ['관리구분', '서비스종류']) ? String(findValue(row, ['관리구분', '서비스종력'])).trim() : '미분류';
        
        const establishedDateRaw = findValue(row, ['수립일', '등록일', '수립일자'], 6); // G Column Fallback
        const establishedDate = parseDate(establishedDateRaw);

        // 1. Store Full ISP Plan with enriched metadata
        if (establishedDate) {
            ispPlans.push({
                registrationNo: registrationNoRaw ? String(registrationNoRaw).trim() : '',
                normalizedRegistrationNo: registrationNo,
                memberName: memberName,
                normalizedName: normalizedName,
                managementCategory: managementCategory,
                establishedDate: establishedDate.toISOString().split('T')[0],
                gender: findValue(row, ['성별']),
                birthDate: findValue(row, ['생년월일']) ? parseDate(findValue(row, ['생년월일']))?.toISOString().split('T')[0] : undefined,
                excelRowNumber: index + 2, // Assuming 1-based index + header row
                parseStatus: 'success'
            });
        }

        // 2. Track Expiring Members (Legacy logic maintenance)
        const estDate = parseDate(findValue(row, ['수립예정일']));
        const registrant = findValue(row, ['등록자', '담당자']) ? String(findValue(row, ['등록자', '담당자'])).trim() : null;

        if (estDate && registrant && counselorMap[registrant]) {
            estDate.setHours(0, 0, 0, 0);
            const timeDiff = estDate.getTime() - today.getTime();
            const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
            if (daysDiff <= 30) {
                ispExpiringMembers.push({
                    id: registrationNo || `N/A-${index + 1}`, name: memberName,
                    registrant: registrant, date: estDate.toISOString().split('T')[0],
                    daysPassed: -daysDiff, rowNum: index + 1
                });
            }
        }
    });

    const memberPerformance: MemberPerformance[] = Object.values(memberPerformanceMap);

    return {
        counselorPerformance: Object.values(counselorPerformance),
        memberPerformance: memberPerformance,
        ispExpiringMembers: ispExpiringMembers.sort((a, b) => a.daysPassed - b.daysPassed),
        ispPlans: ispPlans
    };
};
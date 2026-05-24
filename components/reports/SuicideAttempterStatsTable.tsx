
import React, { useMemo } from 'react';
import { SuicideAttempterReferral } from '../../types';
import * as XLSX from 'xlsx';

const SA_REGIONS = ['호법', '마장', '중리', '관고', '대월', '백사', '창전', '신둔', '부발', '모가', '증포', '아미(부발)', '장호원', '율면', '설성', '기타'];

const QuarterlyInfographic = ({ quarterlyData }: { quarterlyData: any[] }) => {
    const getTopKey = (obj: any) => Object.entries(obj).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || '-';
    const translateAge = (key: string) => {
        const map: { [key: string]: string } = {
            tens: '10대',
            twenties: '20대',
            thirties: '30대',
            forties: '40대',
            fifties: '50대',
            sixties: '60대',
            seventies: '70대',
            eightiesOver: '80대↑',
            unknown: '미상',
            // Fallbacks for potential case variations
            Tens: '10대', Twenties: '20대', Thirties: '30대', Forties: '40대', Fifties: '50대', Sixties: '60대', Seventies: '70대', EightiesOver: '80대↑'
        };
        return map[key] || map[key.toLowerCase()] || '분석 중';
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {quarterlyData.map((data, idx) => {
                if (!data) return null;
                const consentRate = data.total > 0 ? Math.round((data.processing.consent / data.total) * 100) : 0;
                const topAge = translateAge(getTopKey(data.age));
                const colors = ['bg-blue-50 text-blue-600', 'bg-indigo-50 text-indigo-600', 'bg-purple-50 text-purple-600', 'bg-emerald-50 text-emerald-600'][idx];

                return (
                    <div key={idx} className={`p-5 rounded-[2rem] border ${colors} shadow-sm transition hover:shadow-md`}>
                        <div className="flex justify-between items-center mb-4"><span className="text-xs font-extrabold uppercase">{idx + 1}분기 요약</span><i className="fas fa-calendar-check text-xl opacity-50"></i></div>
                        <div className="flex items-end gap-2 mb-4"><span className="text-3xl font-extrabold text-slate-800">{data.total}</span><span className="text-xs font-bold text-slate-500 mb-1.5">건</span></div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between text-[10px] font-bold text-slate-500 mb-1"><span>서비스 동의율</span><span>{consentRate}%</span></div>
                                <div className="w-full bg-white/50 rounded-full h-2"><div className={`h-2 rounded-full ${colors.split(' ')[0].replace('-50', '-500')}`} style={{ width: `${consentRate}%` }}></div></div>
                            </div>
                            <div className="flex justify-between items-center pt-1"><span className="text-[10px] font-bold text-slate-500">최다 연령층</span><span className="text-xs font-extrabold">{topAge}</span></div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const SuicideAttempterStatsTable: React.FC<{ data: SuicideAttempterReferral[] }> = ({ data }) => {
    const stats = useMemo(() => {
        const createZeroStat = () => ({ total: 0, source: { police: 0, fire: 0, other: 0 }, target: { self: 0, family: 0, bereaved: 0, unknown: 0 }, age: { tens: 0, twenties: 0, thirties: 0, forties: 0, fifties: 0, sixties: 0, seventies: 0, eightiesOver: 0, unknown: 0 }, processing: { disposal: 0, consent: 0, processing: 0 }, intervention: { general: 0, crisis: 0, deregistered: 0, linked: 0, none: 0 }, disposalReason: { refusal: 0, request: 0, error: 0, absence: 0, other: 0 }, region: SA_REGIONS.reduce((acc, r) => ({ ...acc, [r]: 0 }), {}) });
        const monthlyStats = Array(12).fill(null).map(() => createZeroStat());

        data.forEach(item => {
            const date = new Date(item.receiptDate);
            if (isNaN(date.getTime())) return;
            const monthIdx = date.getMonth();
            const stat = monthlyStats[monthIdx];
            stat.total++;

            // 정보제공 (requestAgency + pic) 
            const agency = (item.requestAgency || '').trim();
            const pic = (item.pic || '').trim();
            // Normalize and broaden matching
            const combinedAgency = (agency + pic).replace(/\s/g, '').normalize('NFC');

            const isPolice = combinedAgency.includes('경찰') ||
                combinedAgency.includes('지구대') ||
                combinedAgency.includes('파출소') ||
                combinedAgency.includes('112') ||
                combinedAgency.includes('117') ||
                combinedAgency.includes('치안') ||
                combinedAgency.includes('순찰') ||
                combinedAgency.includes('수사') ||
                combinedAgency.includes('김태헌');

            const isFire = combinedAgency.includes('소방') ||
                combinedAgency.includes('119');

            if (isPolice) stat.source.police++;
            else if (isFire) stat.source.fire++;
            else stat.source.other++;

            if (item.infoTarget?.includes('본인') || item.infoTarget?.includes('시도자')) stat.target.self++;
            else if (item.infoTarget?.includes('가족')) stat.target.family++;
            else if (item.infoTarget?.includes('유족')) stat.target.bereaved++;
            else stat.target.unknown++;
            const age = item.age; if (age < 20) stat.age.tens++; else if (age < 30) stat.age.twenties++; else if (age < 40) stat.age.thirties++; else if (age < 50) stat.age.forties++; else if (age < 60) stat.age.fifties++; else if (age < 70) stat.age.sixties++; else if (age < 80) stat.age.seventies++; else if (age >= 80) stat.age.eightiesOver++; else stat.age.unknown++;
            if (item.processingStatus?.includes('파기')) { stat.processing.disposal++; if (item.disposalReason?.includes('거부')) stat.disposalReason.refusal++; else if (item.disposalReason?.includes('요청')) stat.disposalReason.request++; else if (item.disposalReason?.includes('오류')) stat.disposalReason.error++; else if (item.disposalReason?.includes('부재')) stat.disposalReason.absence++; else stat.disposalReason.other++; }
            else if (item.processingStatus?.includes('동의')) { stat.processing.consent++; }
            else stat.processing.processing++;

            // 개입 (Intervention Status) - 집계 로직 분리 및 강화
            const intv = item.interventionStatus || '';
            if (intv.includes('일반') || intv.includes('일방')) stat.intervention.general++;
            else if (intv.includes('위기')) stat.intervention.crisis++;
            else if (intv.includes('퇴록')) stat.intervention.deregistered++;
            else if (intv.includes('연계')) stat.intervention.linked++;
            else stat.intervention.none++;

            let regionMatched = false; SA_REGIONS.forEach(r => { if (r !== '기타' && item.region?.includes(r.split('(')[0])) { (stat.region as any)[r]++; regionMatched = true; } }); if (!regionMatched) stat.region['기타']++;
        });

        const addStats = (a: any, b: any) => Object.keys(a).reduce((acc, key) => ({ ...acc, [key]: typeof a[key] === 'object' ? Object.keys(a[key]).reduce((subAcc, subKey) => ({ ...subAcc, [subKey]: a[key][subKey] + b[key][subKey] }), {}) : a[key] + b[key] }), {});

        const quarterlyStats = [0, 1, 2, 3].map(q => monthlyStats.slice(q * 3, q * 3 + 3).reduce(addStats, createZeroStat()));
        const totalStats = quarterlyStats.reduce(addStats, createZeroStat());
        return { monthlyStats, quarterlyStats, totalStats };
    }, [data]);

    const renderCell = (val: number) => val === 0 ? '-' : val;
    const calcRate = (consent: number, total: number) => total === 0 ? '0%' : ((consent / total) * 100).toFixed(1) + '%';

    // Improved Row Rendering with distinct styles
    const renderRow = (row: any, label: string, isTotal = false, isQuarterly = false) => (
        <tr className={`
            ${isTotal ? "bg-slate-900 text-white font-bold hover:bg-slate-800" : isQuarterly ? "bg-slate-100 font-bold border-t-2 border-b-2 border-slate-200" : "hover:bg-slate-50 border-b border-slate-100"}
            transition-colors
        `}>
            <td className={`p-3 sticky left-0 z-10 border-r border-slate-200 ${isTotal ? 'bg-slate-900' : isQuarterly ? 'bg-slate-100' : 'bg-white'}`}>{label}</td>

            {/* Data Cells with Borders */}
            {[row.total, row.source.police, row.source.fire, row.source.other, row.total, row.target.self, row.target.family, row.target.bereaved, row.target.unknown, row.total, ...Object.values(row.age), row.total, row.processing.disposal, row.processing.consent, row.processing.processing, row.total, ...Object.values(row.intervention), row.processing.disposal, ...Object.values(row.disposalReason), row.total, ...Object.values(row.region)].map((val, i) => {
                const isPoliceColumn = i === 1;
                const isFireColumn = i === 2;
                const hasValue = val > 0;

                let cellClass = `p-2 text-center border-r border-slate-100 ${isTotal ? 'border-slate-700 font-extrabold' : ''}`;
                if (hasValue && isPoliceColumn) cellClass += " bg-blue-50 text-blue-700 font-extrabold";
                if (hasValue && isFireColumn) cellClass += " bg-red-50 text-red-700 font-extrabold";

                return (
                    <td key={i} className={cellClass}>
                        {renderCell(val as number)}
                    </td>
                );
            })}

            <td className={`p-3 sticky right-0 z-10 border-l border-slate-200 ${isTotal ? 'bg-slate-900' : isQuarterly ? 'bg-slate-100' : 'bg-white'}`}>{calcRate(row.processing.consent, row.total)}</td>
        </tr>
    );

    // Excel Download Handler
    const handleDownloadExcel = () => {
        const wb = XLSX.utils.book_new();
        const wsData = [];

        // Headers
        wsData.push(['구분', '정보제공', '', '대상', '', '', '', '', '연령대', '', '', '', '', '', '', '', '', '', '처리', '', '', '개입', '', '', '', '', '', '파기사유', '', '', '', '', '', '지역', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '동의율']);
        wsData.push(['', '총', '경찰', '소방', '총', '시도자', '가족', '유족', '미상', '총', '10대', '20대', '30대', '40대', '50대', '60대', '70대', '80대↑', '미상', '총', '파기', '동의', '처리중', '총', '일반', '위기', '퇴록', '연계', '미기재', '총', '거부', '요청', '오류', '부재', '기타', '총', ...SA_REGIONS.map(r => r.split('(')[0]), '']);

        // Data Rows
        const addRow = (label: string, row: any) => {
            wsData.push([
                label,
                row.total, row.source.police, row.source.fire, row.source.other,
                row.total, row.target.self, row.target.family, row.target.bereaved, row.target.unknown,
                row.total, ...Object.values(row.age),
                row.total, row.processing.disposal, row.processing.consent, row.processing.processing,
                row.total, ...Object.values(row.intervention),
                row.processing.disposal, ...Object.values(row.disposalReason),
                row.total, ...Object.values(row.region),
                calcRate(row.processing.consent, row.total)
            ]);
        };

        stats.monthlyStats.forEach((row, i) => {
            addRow(`${i + 1}월`, row);
            if ((i + 1) % 3 === 0) {
                addRow(`${(i + 1) / 3}분기`, stats.quarterlyStats[(i + 1) / 3 - 1]);
            }
        });
        addRow('합계', stats.totalStats);

        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Merges
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, // 구분
            { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } }, // 정보제공
            { s: { r: 0, c: 4 }, e: { r: 0, c: 8 } }, // 대상
            { s: { r: 0, c: 9 }, e: { r: 0, c: 18 } }, // 연령대
            { s: { r: 0, c: 19 }, e: { r: 0, c: 22 } }, // 처리
            { s: { r: 0, c: 23 }, e: { r: 0, c: 28 } }, // 개입 (5 -> 6 columns)
            { s: { r: 0, c: 29 }, e: { r: 0, c: 34 } }, // 파기사유 (6 columns)
            { s: { r: 0, c: 35 }, e: { r: 0, c: 35 + SA_REGIONS.length } }, // 지역
            { s: { r: 0, c: 36 + SA_REGIONS.length }, e: { r: 1, c: 36 + SA_REGIONS.length } }, // 동의율
        ];

        XLSX.utils.book_append_sheet(wb, ws, "자살시도자 현황");
        XLSX.writeFile(wb, `자살시도자_현황_${new Date().getFullYear()}.xlsx`);
    };

    return (
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100">
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-extrabold text-slate-900">자살시도자 현황 대시보드</h3>
                <button
                    onClick={handleDownloadExcel}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl font-bold hover:bg-green-700 transition shadow-sm text-sm"
                >
                    <i className="fas fa-file-excel"></i>
                    엑셀 다운로드
                </button>
            </div>
            <QuarterlyInfographic quarterlyData={stats.quarterlyStats} />
            <div className="overflow-x-auto text-center text-xs border border-slate-200 rounded-2xl">
                <table className="min-w-max w-full">
                    <thead className="text-slate-600 font-bold bg-slate-50">
                        <tr className="border-b border-slate-200">
                            <th rowSpan={2} className="p-3 bg-slate-100 sticky left-0 z-20 border-r border-slate-200">구분</th>
                            <th colSpan={4} className="p-2 border-r border-slate-200 bg-blue-50/50 text-blue-700">정보제공</th>
                            <th colSpan={5} className="p-2 border-r border-slate-200 bg-indigo-50/50 text-indigo-700">대상</th>
                            <th colSpan={10} className="p-2 border-r border-slate-200 bg-purple-50/50 text-purple-700">연령대</th>
                            <th colSpan={4} className="p-2 border-r border-slate-200 bg-amber-50/50 text-amber-700">처리</th>
                            <th colSpan={6} className="p-2 border-r border-slate-200 bg-emerald-50/50 text-emerald-700">개입</th>
                            <th colSpan={6} className="p-2 border-r border-slate-200 bg-rose-50/50 text-rose-700">파기사유</th>
                            <th colSpan={SA_REGIONS.length + 1} className="p-2 border-r border-slate-200 bg-slate-50 text-slate-700">지역</th>
                            <th rowSpan={2} className="p-3 bg-rose-50 sticky right-0 z-20 border-l border-slate-200 text-rose-600">동의율</th>
                        </tr>
                        <tr className="text-[10px] text-slate-500 border-b border-slate-200">
                            {/* 정보제공 */}
                            <th className="p-1 border-r border-slate-100 bg-blue-50/30">총</th><th className="p-1 border-r border-slate-100 bg-blue-50/30">경찰</th><th className="p-1 border-r border-slate-100 bg-blue-50/30">소방</th><th className="p-1 border-r border-slate-200 bg-blue-50/30">기타</th>
                            {/* 대상 */}
                            <th className="p-1 border-r border-slate-100 bg-indigo-50/30">총</th><th className="p-1 border-r border-slate-100 bg-indigo-50/30">시도자</th><th className="p-1 border-r border-slate-100 bg-indigo-50/30">가족</th><th className="p-1 border-r border-slate-100 bg-indigo-50/30">유족</th><th className="p-1 border-r border-slate-200 bg-indigo-50/30">미상</th>
                            {/* 연령대 */}
                            <th className="p-1 border-r border-slate-100 bg-purple-50/30">총</th>{Object.keys(stats.totalStats.age).map(k => <th key={k} className="p-1 border-r border-slate-100 bg-purple-50/30 last:border-slate-200">{translateAge(k)}</th>)}
                            {/* 처리 */}
                            <th className="p-1 border-r border-slate-100 bg-amber-50/30">총</th><th className="p-1 border-r border-slate-100 bg-amber-50/30">파기</th><th className="p-1 border-r border-slate-100 bg-amber-50/30">동의</th><th className="p-1 border-r border-slate-200 bg-amber-50/30">처리중</th>
                            {/* 개입 */}
                            <th className="p-1 border-r border-slate-100 bg-emerald-50/30">총</th><th className="p-1 border-r border-slate-100 bg-emerald-50/30">일반</th><th className="p-1 border-r border-slate-100 bg-emerald-50/30">위기</th><th className="p-1 border-r border-slate-100 bg-emerald-50/30">퇴록</th><th className="p-1 border-r border-slate-100 bg-emerald-50/30">연계</th><th className="p-1 border-r border-slate-200 bg-emerald-50/30">미기재</th>
                            {/* 파기사유 */}
                            <th className="p-1 border-r border-slate-100 bg-rose-50/30">총</th><th className="p-1 border-r border-slate-100 bg-rose-50/30">거부</th><th className="p-1 border-r border-slate-100 bg-rose-50/30">요청</th><th className="p-1 border-r border-slate-100 bg-rose-50/30">오류</th><th className="p-1 border-r border-slate-100 bg-rose-50/30">부재</th><th className="p-1 border-r border-slate-200 bg-rose-50/30">기타</th>
                            {/* 지역 */}
                            <th className="p-1 border-r border-slate-100 bg-slate-50/30">총</th>{SA_REGIONS.map(r => <th key={r} className="p-1 border-r border-slate-100 bg-slate-50/30 last:border-slate-200">{r.split('(')[0]}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {stats.monthlyStats.map((row, i) => (
                            <React.Fragment key={i}>
                                {renderRow(row, `${i + 1}월`)}
                                {(i + 1) % 3 === 0 && renderRow(stats.quarterlyStats[(i + 1) / 3 - 1], `${(i + 1) / 3}분기`, false, true)}
                            </React.Fragment>
                        ))}
                        {renderRow(stats.totalStats, '합계', true)}
                    </tbody>
                </table>
            </div>
        </div>
    );
    function translateAge(key: string) { const m: any = { 'tens': '10대', 'twenties': '20대', 'thirties': '30대', 'forties': '40대', 'fifties': '50대', 'sixties': '60대', 'seventies': '70대', 'eightiesOver': '80대↑', 'unknown': '미상' }; return m[key] || key }
};

export default SuicideAttempterStatsTable;

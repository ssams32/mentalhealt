
import React, { useMemo } from 'react';
import { Referral } from '../../types';

interface AssigneeStatsTableProps {
    data: Referral[];
}

const AssigneeStatsTable: React.FC<AssigneeStatsTableProps> = ({ data }) => {
    const stats = useMemo(() => {
        const assigneeData: { [key: string]: { total: number; registered: number } } = {};
        data.forEach(item => {
            const assignee = item.assignee || '미지정';
            if (!assigneeData[assignee]) {
                assigneeData[assignee] = { total: 0, registered: 0 };
            }
            assigneeData[assignee].total++;
            if (item.actionResult && item.actionResult.includes('등록관리')) {
                assigneeData[assignee].registered++;
            }
        });
        return Object.entries(assigneeData)
            .map(([name, counts]) => ({ name, ...counts }))
            .sort((a, b) => b.total - a.total);
    }, [data]);

    return (
        <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100">
            <h3 className="text-lg font-extrabold text-slate-900 tracking-tight mb-6">담당자별 현황</h3>
            <div className="max-h-[300px] overflow-y-auto">
                <table className="w-full text-sm text-left">
                    <thead className="sticky top-0 bg-white/80 backdrop-blur-sm z-10">
                        <tr className="border-b border-slate-100">
                            <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider">담당자</th>
                            <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider text-right">총 의뢰 건수</th>
                            <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-wider text-right">등록관리 건수</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {stats.map(item => (
                            <tr key={item.name} className="hover:bg-slate-50">
                                <td className="p-3 font-bold text-slate-800">{item.name}</td>
                                <td className="p-3 font-mono font-bold text-slate-600 text-right">{item.total}</td>
                                <td className="p-3 font-mono font-bold text-blue-600 text-right">{item.registered}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default AssigneeStatsTable;

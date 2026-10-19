
import React, { useMemo } from 'react';
import { Referral } from '../../types';
import { MONTH_LABELS, AGE_BRACKETS } from '../../constants';
import { getRegions } from '../../services/orgConfig';

interface MatrixTableProps {
    title: string;
    data: Referral[];
    rowKey: 'region';
    isAgeMatrix?: boolean;
}

const MatrixTable: React.FC<MatrixTableProps> = ({ title, data, rowKey, isAgeMatrix = false }) => {
    const rowLabels = getRegions();
    const colLabels = isAgeMatrix ? AGE_BRACKETS : MONTH_LABELS;

    const colProcessor = (item: Referral) => {
        if (isAgeMatrix) {
            const age = item.age;
            if (isNaN(age)) return '미상';
            if (age < 20) return '10대';
            if (age < 30) return '20대';
            if (age < 40) return '30대';
            if (age < 50) return '40대';
            if (age < 60) return '50대';
            if (age < 70) return '60대';
            if (age < 80) return '70대';
            return '80대 이상';
        } else {
            const date = new Date(item.requestDate);
            return isNaN(date.getTime()) ? null : `${date.getMonth() + 1}월`;
        }
    };

    const matrixData = useMemo(() => {
        const matrix = rowLabels.reduce((acc, r) => ({ ...acc, [r]: colLabels.reduce((subAcc, c) => ({ ...subAcc, [c]: 0 }), {}) }), {} as {[key: string]: {[key: string]: number}});
        data.forEach(item => {
            const row = item[rowKey] || '기타';
            const col = colProcessor(item);
            if (rowLabels.includes(row) && col && colLabels.includes(col)) {
                matrix[row][col]++;
            }
        });

        const rowTotals = rowLabels.map(r => colLabels.reduce((sum, c) => sum + matrix[r][c], 0));
        const colTotals = colLabels.map(c => rowLabels.reduce((sum, r) => sum + matrix[r][c], 0));
        const grandTotal = colTotals.reduce((sum, val) => sum + val, 0);
        const maxVal = Math.max(...Object.values(matrix).flatMap(row => Object.values(row)));

        return { matrix, rowTotals, colTotals, grandTotal, maxVal };
    }, [data, rowKey, rowLabels, colLabels]);
    
    const getBgColor = (val: number) => {
        if (val === 0 || matrixData.maxVal === 0) return 'bg-white';
        const opacity = Math.max(0.1, val / matrixData.maxVal).toFixed(2);
        return `bg-blue-500` // Using Tailwind's opacity shorthand is better
    };

    const getOpacity = (val: number) => {
        if (val === 0 || matrixData.maxVal === 0) return { opacity: 0 };
        const opacity = Math.max(0.1, val / matrixData.maxVal);
        return { opacity };
    };


    return (
        <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-100 overflow-hidden">
             <h3 className="text-lg font-extrabold text-slate-900 tracking-tight mb-6">{title}</h3>
             <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse min-w-[800px]">
                    <thead>
                        <tr className="text-slate-500 font-bold">
                            <th className="p-3 bg-slate-100 rounded-tl-xl sticky left-0 z-10 border-r-2 border-white">지역/구분</th>
                            {colLabels.map(c => <th key={c} className="p-3 bg-slate-100">{c}</th>)}
                            <th className="p-3 bg-slate-200 text-slate-700 rounded-tr-xl">지역별 총합</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rowLabels.map((r, rIdx) => (
                            <tr key={r} className="text-center hover:bg-slate-50">
                                <td className="p-3 font-bold text-slate-600 text-left sticky left-0 bg-white z-10 border-r-2 border-slate-50 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">{r}</td>
                                {colLabels.map(c => {
                                    const val = matrixData.matrix[r]?.[c] || 0;
                                    return <td key={c} className={`p-3 font-mono font-bold relative ${val > 0 ? 'text-white' : 'text-slate-300'}`}>
                                        <div className={`absolute inset-0 ${getBgColor(val)}`} style={getOpacity(val)}></div>
                                        <span className="relative">{val}</span>
                                    </td>
                                })}
                                <td className="p-3 bg-slate-100 font-bold text-slate-800">{matrixData.rowTotals[rIdx]}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="font-extrabold text-slate-800">
                            <td className="p-3 bg-slate-200 rounded-bl-xl sticky left-0 z-10 border-r-2 border-white">{isAgeMatrix ? '연령별 총합' : '월별 총합'}</td>
                            {matrixData.colTotals.map((total, cIdx) => <td key={cIdx} className="p-3 bg-slate-200">{total}</td>)}
                            <td className="p-3 bg-slate-300 rounded-br-xl">{matrixData.grandTotal}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    )
};

export default MatrixTable;

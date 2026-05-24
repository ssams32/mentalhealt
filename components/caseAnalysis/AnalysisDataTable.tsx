
import React from 'react';

interface Column {
    header: string;
    accessor: string;
    textAlign?: string;
}

interface AnalysisDataTableProps {
    columns: Column[];
    data: any[];
    title?: string;
}

const AnalysisDataTable: React.FC<AnalysisDataTableProps> = ({ columns, data, title }) => (
    <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
        {title && <h3 className="text-lg font-bold text-gray-800 mb-4">{title}</h3>}
        <div className="overflow-x-auto max-h-96">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 sticky top-0">
                    <tr>
                        {columns.map(col => (
                            <th key={col.header} className={`px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap ${col.textAlign || ''}`}>
                                {col.header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                    {data.map((row, rowIndex) => (
                        <tr key={rowIndex} className="hover:bg-gray-100">
                            {columns.map(col => (
                                <td key={col.accessor} className={`px-4 py-3 text-gray-700 whitespace-nowrap ${col.textAlign || ''}`}>
                                    {row[col.accessor]}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </div>
);

export default AnalysisDataTable;

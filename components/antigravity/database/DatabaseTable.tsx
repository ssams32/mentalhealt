import React, { useState } from 'react';
import { Page, DatabaseProperty } from '../types';
import { PropertyCell } from './PropertyComponents';
import { Plus, MoreHorizontal, FileText } from 'lucide-react';

interface DatabaseTableProps {
    databasePage: Page;
    onUpdatePage: (pageId: string, updates: Partial<Page>) => void;
    onAddProperty?: () => void;
    rows?: Page[]; // Make optional or required depending on refactor extent
}

export const DatabaseTable: React.FC<DatabaseTableProps> = ({ databasePage, onUpdatePage, onAddProperty, rows: propRows }) => {
    // Use prop rows if provided, else local fallback (or remove local fallback to enforce hoisting)
    const [localRows, setLocalRows] = useState<Page[]>([]);
    const rows = propRows || localRows;

    const [sortProp, setSortProp] = useState<string | null>(null);
    const [sortAsc, setSortAsc] = useState(true);
    const [filterText, setFilterText] = useState('');

    const properties = databasePage.properties || [];

    const visibleRows = React.useMemo(() => {
        let result = [...rows];

        if (filterText) {
            const lowerInfo = filterText.toLowerCase();
            result = result.filter(r =>
                r.title.toLowerCase().includes(lowerInfo) ||
                properties.some(p => {
                    // const val = r.propertyValues?.[p.id];
                    // return String(val).toLowerCase().includes(lowerInfo);
                    return false;
                })
            );
        }

        if (sortProp) {
            result.sort((a, b) => {
                const valA = sortProp === 'name' ? a.title : ''; // mock
                const valB = sortProp === 'name' ? b.title : '';

                if (valA < valB) return sortAsc ? -1 : 1;
                if (valA > valB) return sortAsc ? 1 : -1;
                return 0;
            });
        }

        return result;
    }, [rows, sortProp, sortAsc, filterText, properties]);

    const handleCellChange = (rowId: string, propertyId: string, newValue: any) => {
        // Find row
        const row = rows.find(r => r.id === rowId);
        if (!row) return;

        // In a real DB, values are stored in 'PropertyValue' table. 
        // Here we might store them in a 'properties' record on the Page object for simplicity?
        // Let's assume Page has a `propertyValues: Record<string, any>` for this Phase.
        // We'll update the mock logic to support this.

        onUpdatePage(rowId, {
            // Mock update structure
            // propertyValues: { ...row.propertyValues, [propertyId]: newValue } 
        });
    };

    return (
        <div className="w-full border-t border-slate-200 dark:border-slate-700">
            {/* Toolbar for Database View */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 transition-colors">
                <div className="flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 px-2 py-1 rounded cursor-pointer transition">
                    <span className="font-medium text-blue-600">Table</span>
                </div>
                <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1"></div>

                <button
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition ${sortProp ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/30 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'}`}
                    onClick={() => {
                        if (!sortProp) { setSortProp('name'); setSortAsc(true); }
                        else if (sortAsc) { setSortAsc(false); }
                        else { setSortProp(null); }
                    }}
                >
                    <span>Sort</span>
                    {sortProp && <span>{sortAsc ? 'Asc' : 'Desc'}</span>}
                </button>

                <div className="relative flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition text-slate-500 dark:text-slate-400">
                    <span>Filter</span>
                    <input
                        className="ml-1 bg-transparent border-b border-slate-200 dark:border-slate-600 outline-none w-20 focus:w-32 transition-all focus:border-blue-500 text-slate-700 dark:text-slate-200"
                        placeholder="..."
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                    />
                </div>

                <div className="ml-auto">
                    <button className="p-1 hover:bg-slate-100 rounded text-slate-400">
                        <MoreHorizontal size={14} />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm text-left text-slate-700 dark:text-slate-300">
                    <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                            <th className="font-normal text-slate-500 dark:text-slate-400 px-3 py-2 min-w-[200px] border-r border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                                <div className="flex items-center gap-1">
                                    <span className="text-xs">Aa</span>
                                    <span>Name</span>
                                    {sortProp === 'name' && (
                                        <span className="text-xs text-blue-500 ml-auto">{sortAsc ? '↑' : '↓'}</span>
                                    )}
                                </div>
                            </th>
                            {properties.map(prop => (
                                <th key={prop.id} className="font-normal text-slate-500 dark:text-slate-400 px-3 py-2 min-w-[150px] border-r border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                                    <div className="flex items-center gap-1">
                                        {/* Icon based on type */}
                                        <span>{prop.name}</span>
                                    </div>
                                </th>
                            ))}
                            <th className="w-10 px-2 py-2 border-r border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                                <button onClick={onAddProperty} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-400 transition-colors">
                                    <Plus size={14} />
                                </button>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.length === 0 && (
                            <tr>
                                <td colSpan={properties.length + 2} className="px-3 py-8 text-center text-slate-400">
                                    {rows.length === 0 ? 'No pages inside' : 'No matches found'}
                                </td>
                            </tr>
                        )}
                        {visibleRows.map(row => (
                            <tr key={row.id} className="group border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                                <td className="px-3 py-1.5 border-r border-slate-100 dark:border-slate-800">
                                    <div className="flex items-center gap-2 cursor-pointer font-medium text-slate-800 dark:text-slate-200">
                                        <FileText size={14} className="text-slate-400" />
                                        <span>{row.title || 'Untitled'}</span>
                                        <button className="ml-auto opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-200 rounded text-slate-400">
                                            <span className="text-xs">OPEN</span>
                                        </button>
                                    </div>
                                </td>
                                {properties.map(prop => (
                                    <td key={prop.id} className="border-r border-slate-100 dark:border-slate-800">
                                        <PropertyCell
                                            type={prop.type}
                                            // value={row.propertyValues?.[prop.id]} 
                                            value={null} // details later
                                            onChange={(val) => handleCellChange(row.id, prop.id, val)}
                                            config={prop.config}
                                        />
                                    </td>
                                ))}
                                <td className="px-2 py-1"></td>
                            </tr>
                        ))}
                        <tr>
                            <td colSpan={properties.length + 2} className="px-3 py-2 border-b border-slate-100 cursor-pointer hover:bg-slate-50 text-slate-500 select-none">
                                <div className="flex items-center gap-2">
                                    <Plus size={14} />
                                    <span>New</span>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
};

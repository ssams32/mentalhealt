import React, { useState, useMemo } from 'react';
import { Page, DatabaseProperty } from '../types';
import { Plus, MoreHorizontal } from 'lucide-react';

interface BoardViewProps {
    databasePage: Page;
    rows: Page[];
    onUpdatePage: (pageId: string, updates: Partial<Page>) => void;
}

export const BoardView: React.FC<BoardViewProps> = ({ databasePage, rows, onUpdatePage }) => {
    // Find a property to group by (Select, Multi-select, or Status)
    const properties = databasePage.properties || [];
    const groupProperty = properties.find(p => ['select', 'status', 'multi_select'].includes(p.type)) || properties[0];

    // Mock Options for groups if not in config
    const getGroupOptions = (prop: DatabaseProperty) => {
        if (prop?.config?.options) return prop.config.options;
        // Default groups based on type if no config
        if (prop?.type === 'status') return [
            { id: 'not_started', name: 'Not Started', color: 'bg-slate-100' },
            { id: 'in_progress', name: 'In Progress', color: 'bg-blue-100' },
            { id: 'done', name: 'Done', color: 'bg-green-100' }
        ];
        return [{ id: 'no_group', name: 'No Group', color: 'bg-slate-50' }];
    };

    const groups = groupProperty ? getGroupOptions(groupProperty) : [];

    // Group rows
    const groupedRows = useMemo(() => {
        const grouping: Record<string, Page[]> = {};
        groups.forEach((g: any) => grouping[g.name] = []);
        // Add "No Status" group
        grouping['No Status'] = [];

        rows.forEach(row => {
            // const val = row.propertyValues?.[groupProperty?.id];
            // Mock value mapping
            let val = 'No Status';
            // Mock logic: assign random status if undefined for demo?
            // val = row.status || 'Not Started';
            // For now, let's just dump them in "No Status" or simulate distribution

            // Assume we can read 'Status' property name directly for demo
            // In real app, we use ID.

            // Simulate reading value:
            // For this specific demo, let's look for a property named "Status"
            // If the groupProperty is "Status", we try to match.

            // Allow demo to put everything in 'Not Started'
            const targetGroup = groups.find((g: any) => g.name === 'Not Started');
            if (targetGroup) grouping[targetGroup.name].push(row);
            else grouping['No Status'].push(row);
        });

        return grouping;
    }, [rows, groups, groupProperty]);

    if (!groupProperty) {
        return <div className="p-4 text-slate-400 text-sm">No groupable property found. Add a Select or Status property to use Board View.</div>;
    }

    return (
        <div className="flex overflow-x-auto h-full items-start gap-4 p-2 min-h-[300px]">
            {groups.map((group: any) => (
                <div key={group.id} className="flex-shrink-0 w-64 flex flex-col gap-2">
                    <div className="flex items-center gap-2 px-2 py-1">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${group.color || 'bg-slate-100'}`}>
                            {group.name}
                        </span>
                        <span className="text-slate-400 text-xs">{groupedRows[group.name]?.length || 0}</span>
                        <div className="ml-auto flex gap-1">
                            <button className="text-slate-400 hover:bg-slate-100 p-1 rounded"><Plus size={14} /></button>
                            <button className="text-slate-400 hover:bg-slate-100 p-1 rounded"><MoreHorizontal size={14} /></button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 min-h-[50px]">
                        {groupedRows[group.name]?.map((row) => (
                            <div key={row.id} className="bg-white dark:bg-slate-800 p-3 rounded shadow-sm border border-slate-200 dark:border-slate-700 hover:shadow-md cursor-pointer transition flex flex-col gap-1 group">
                                <div className="text-sm font-medium text-slate-800 dark:text-slate-200 break-words">
                                    {row.title || 'Untitled'}
                                </div>
                                {/* Show a few properties? */}
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {/* Mock tag */}
                                    {/* <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 text-[10px] rounded">Tag A</span> */}
                                </div>
                            </div>
                        ))}
                        <button className="flex items-center gap-1 text-slate-500 hover:bg-slate-100 p-2 rounded text-sm mt-1">
                            <Plus size={14} /> New
                        </button>
                    </div>
                </div>
            ))}
            <div className="flex-shrink-0 w-64 flex items-center justify-center border-2 border-dashed border-slate-200 rounded-lg h-12 cursor-pointer hover:bg-slate-50">
                <span className="text-slate-400 text-sm font-medium">+ Add Group</span>
            </div>
        </div>
    );
};

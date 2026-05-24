import React, { useState } from 'react';
import { PropertyType } from '../types';
import { ChevronDown, Calendar, Check, X, Plus } from 'lucide-react';

interface PropertyCellProps {
    type: PropertyType;
    value: any;
    onChange: (value: any) => void;
    config?: any;
    readonly?: boolean;
}

export const PropertyCell: React.FC<PropertyCellProps> = ({ type, value, onChange, config, readonly }) => {
    switch (type) {
        case 'text':
        case 'url':
        case 'email':
        case 'phone':
            return <TextProperty value={value} onChange={onChange} readonly={readonly} />;
        case 'number':
            return <NumberProperty value={value} onChange={onChange} config={config} readonly={readonly} />;
        case 'select':
            return <SelectProperty value={value} onChange={onChange} config={config} readonly={readonly} />;
        case 'multi_select':
            return <MultiSelectProperty value={value} onChange={onChange} config={config} readonly={readonly} />;
        case 'date':
            return <DateProperty value={value} onChange={onChange} readonly={readonly} />;
        case 'checkbox':
            return <CheckboxProperty value={value} onChange={onChange} readonly={readonly} />;
        case 'status':
            return <StatusProperty value={value} onChange={onChange} config={config} readonly={readonly} />;
        case 'relation':
            return <RelationProperty value={value} onChange={onChange} config={config} readonly={readonly} />;
        default:
            return <div className="text-slate-400 text-xs truncate">{String(value)}</div>;
    }
};

const TextProperty: React.FC<any> = ({ value, onChange, readonly }) => {
    return (
        <input
            type="text"
            className="w-full bg-transparent outline-none px-2 py-1 text-sm text-slate-700"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            readOnly={readonly}
        />
    );
};

const NumberProperty: React.FC<any> = ({ value, onChange, config, readonly }) => {
    return (
        <input
            type="number"
            className="w-full bg-transparent outline-none px-2 py-1 text-sm text-slate-700 font-mono"
            value={value || ''}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            readOnly={readonly}
        />
    );
};

const SelectProperty: React.FC<any> = ({ value, onChange, config, readonly }) => {
    const options = config?.options || [
        { id: 'op1', name: 'Option 1', color: 'bg-red-100 text-red-800' },
        { id: 'op2', name: 'Option 2', color: 'bg-blue-100 text-blue-800' },
        { id: 'op3', name: 'Option 3', color: 'bg-green-100 text-green-800' }
    ];

    // Simple native select for now, ideally custom popover
    const selected = options.find((o: any) => o.name === value);

    return (
        <div className="relative group w-full h-full px-2 py-1">
            {selected && (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${selected.color || 'bg-slate-100 text-slate-700'}`}>
                    {value}
                </span>
            )}
            {!readonly && (
                <select
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    onChange={(e) => onChange(e.target.value)}
                    value={value || ''}
                >
                    <option value="">Empty</option>
                    {options.map((o: any) => (
                        <option key={o.id} value={o.name}>{o.name}</option>
                    ))}
                </select>
            )}
        </div>
    );
};

const MultiSelectProperty: React.FC<any> = ({ value, onChange, config, readonly }) => {
    // Value is array of strings
    const items = Array.isArray(value) ? value : [];
    const options = config?.options || [
        { id: 'tag1', name: 'Tag A', color: 'bg-orange-100 text-orange-800' },
        { id: 'tag2', name: 'Tag B', color: 'bg-purple-100 text-purple-800' },
    ];

    return (
        <div className="flex flex-wrap gap-1 px-2 py-1">
            {items.map((item: string) => {
                const opt = options.find((o: any) => o.name === item);
                return (
                    <span key={item} className={`px-1.5 py-0.5 rounded text-xs font-medium ${opt?.color || 'bg-slate-100 text-slate-600'}`}>
                        {item}
                    </span>
                )
            })}
            {!readonly && items.length === 0 && <span className="text-slate-300 text-xs">Empty</span>}
        </div>
    );
};

const DateProperty: React.FC<any> = ({ value, onChange, readonly }) => {
    // Value is ISO string
    return (
        <div className="flex items-center gap-2 px-2 py-1 text-sm text-slate-600">
            <Calendar size={14} className="text-slate-400" />
            {!readonly ? (
                <input
                    type="date"
                    className="bg-transparent outline-none w-full"
                    value={value ? value.split('T')[0] : ''}
                    onChange={(e) => onChange(new Date(e.target.value).toISOString())}
                />
            ) : (
                <span>{value ? new Date(value).toLocaleDateString() : 'Empty'}</span>
            )}
        </div>
    );
};

const CheckboxProperty: React.FC<any> = ({ value, onChange, readonly }) => {
    return (
        <div className="flex items-center justify-center h-full px-2">
            <input
                type="checkbox"
                checked={!!value}
                onChange={(e) => !readonly && onChange(e.target.checked)}
                disabled={readonly}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
        </div>
    )
};

const StatusProperty: React.FC<any> = ({ value, onChange, config, readonly }) => {
    // Similar to select but with strict groups (To-do, In Progress, Done)
    const status = value || 'Not Started';
    let color = 'bg-slate-100 text-slate-600';
    if (status === 'In Progress') color = 'bg-blue-100 text-blue-700';
    if (status === 'Done') color = 'bg-green-100 text-green-700';

    return (
        <div className="px-2 py-1">
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
                {status}
            </span>
        </div>
    );
}

function RelationProperty({ value, onChange, readonly }: any) {
    return <div className="px-2 py-1 text-xs text-slate-500 italic">Relation (Not Implemented)</div>;
}

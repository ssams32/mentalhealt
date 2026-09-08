import React, { useState } from 'react';
import { Calendar, Users, Building2, Filter, ChevronDown, Check, X } from 'lucide-react';

// Helper for "Chip" component
const FilterChip: any = ({ label, isSelected, onClick }: any) => (
    <button
        onClick={onClick}
        className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all duration-200 border
            ${isSelected
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-200'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
            }
        `}
    >
        {isSelected && <Check size={12} strokeWidth={3} />}
        {label}
    </button>
);

interface FilterControlsProps {
    departments: string[];
    counselors: string[];
    selectedDepartments: string[];
    setSelectedDepartments: React.Dispatch<React.SetStateAction<string[]>>;
    selectedCounselors: string[];
    setSelectedCounselors: React.Dispatch<React.SetStateAction<string[]>>;
    // Global Date Range
    dateRange: { start: string; end: string };
    setDateRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
    isRestrictedUser?: boolean;
    userTeam?: string;
}

const FilterControls: React.FC<FilterControlsProps> = ({
    departments,
    counselors,
    selectedDepartments,
    setSelectedDepartments,
    selectedCounselors,
    setSelectedCounselors,
    dateRange,
    setDateRange,
    isRestrictedUser = false,
    userTeam = ''
}) => {
    const [isOpen, setIsOpen] = useState(true);

    const handleDeptChange = (dept: string) => {
        setSelectedDepartments(prev =>
            prev.includes(dept) ? prev.filter(d => d !== dept) : [...prev, dept]
        );
    };

    const handleCounselorChange = (counselor: string) => {
        setSelectedCounselors(prev =>
            prev.includes(counselor) ? prev.filter(c => c !== counselor) : [...prev, counselor]
        );
    };

    const handleDateChange = (type: 'start' | 'end', value: string) => {
        setDateRange(prev => ({ ...prev, [type]: value }));
    };

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 mb-8 overflow-hidden transition-all duration-300">
            {/* Header / Toggle */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex justify-between items-center px-6 py-4 bg-slate-50/50 hover:bg-slate-50 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded-lg">
                        <Filter size={16} />
                    </div>
                    <span className="text-sm font-black text-slate-800">필터 및 분석 기간 설정</span>
                    <span className="text-[10px] font-bold text-slate-400 bg-slate-200 px-2 py-0.5 rounded-full">
                        {isOpen ? 'Expanded' : 'Collapsed'}
                    </span>
                </div>
                <ChevronDown size={18} className={`text-slate-400 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Content */}
            <div className={`overflow-hidden transition-all duration-500 ease-in-out ${isOpen ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="p-6 space-y-8">

                    {/* 1. Date Range */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-xs font-black text-slate-400 uppercase tracking-wider">
                            <Calendar size={14} />
                            <span>분석 기간</span>
                        </div>
                        <div className="flex items-center gap-3 bg-slate-50 p-1.5 rounded-xl border border-slate-100 w-fit">
                            <input
                                type="date"
                                value={dateRange.start}
                                onChange={(e) => handleDateChange('start', e.target.value)}
                                className="bg-white border-none text-slate-700 text-xs font-bold rounded-lg focus:ring-2 focus:ring-indigo-100 px-3 py-2 outline-none shadow-sm"
                            />
                            <span className="text-slate-300 font-bold">~</span>
                            <input
                                type="date"
                                value={dateRange.end}
                                onChange={(e) => handleDateChange('end', e.target.value)}
                                className="bg-white border-none text-slate-700 text-xs font-bold rounded-lg focus:ring-2 focus:ring-indigo-100 px-3 py-2 outline-none shadow-sm"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {/* 2. Departments */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-xs font-black text-slate-400 uppercase tracking-wider">
                                    <Building2 size={14} />
                                    <span>부서 ({selectedDepartments.length})</span>
                                </div>
                                {isRestrictedUser ? (
                                    <span className="text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 rounded-full">
                                        소속 부서({userTeam || '지정팀'}) 전용
                                    </span>
                                ) : (
                                    <div className="flex gap-2 text-[10px] font-bold">
                                        <button onClick={() => setSelectedDepartments(departments)} className="text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 px-2 py-1 rounded">전체 선택</button>
                                        <button onClick={() => setSelectedDepartments([])} className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 px-2 py-1 rounded">초기화</button>
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2 p-4 bg-slate-50/50 rounded-xl border border-slate-100 min-h-[100px] max-h-[200px] overflow-y-auto custom-scrollbar content-start">
                                {departments.length === 0 && <span className="text-xs text-slate-300 p-2">데이터 없음</span>}
                                {departments.map(dept => (
                                    <FilterChip
                                        key={dept}
                                        label={dept}
                                        isSelected={selectedDepartments.includes(dept)}
                                        onClick={() => !isRestrictedUser && handleDeptChange(dept)}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* 3. Counselors */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-xs font-black text-slate-400 uppercase tracking-wider">
                                    <Users size={14} />
                                    <span>상담사 ({selectedCounselors.length})</span>
                                </div>
                                <div className="flex gap-2 text-[10px] font-bold">
                                    <button onClick={() => setSelectedCounselors(counselors)} className="text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 px-2 py-1 rounded">전체 선택</button>
                                    <button onClick={() => setSelectedCounselors([])} className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 px-2 py-1 rounded">초기화</button>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2 p-4 bg-slate-50/50 rounded-xl border border-slate-100 min-h-[100px] max-h-[200px] overflow-y-auto custom-scrollbar content-start">
                                {counselors.length === 0 && <span className="text-xs text-slate-300 p-2">데이터 없음</span>}
                                {counselors.map(c => (
                                    <FilterChip
                                        key={c}
                                        label={c}
                                        isSelected={selectedCounselors.includes(c)}
                                        onClick={() => handleCounselorChange(c)}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

export default FilterControls;

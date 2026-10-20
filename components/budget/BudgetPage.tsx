import React, { useState, useMemo, useEffect, useRef } from 'react';
import { User, BudgetTransaction, BudgetFilter, BudgetPreset } from '../../types';
import {
    Upload, Calculator, Filter, Save, RotateCcw, RotateCw,
    Search, X, Edit2, Check, ChevronDown, ChevronRight, Plus, Trash2, ArrowUpDown, ArrowUp, ArrowDown,
    CreditCard, PieChart, TrendingUp, DollarSign, Settings
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import { getOrgShortName } from '../../services/orgConfig';
import { safeLocalStorage } from '../../utils/safeLocalStorage';
import sampleBudgetHierarchy from './sampleBudgetHierarchy.json';

declare var XLSX: any;

interface BudgetPageProps {
    currentUser: User;
    showToast: (msg: string) => void;
}

const INITIAL_FILTER: BudgetFilter = {};
// 기본 팀 목록 (공통 반드시 포함)
const TEAMS = ['공통', '회복', '증진', '자살', '남부'];

export interface BudgetItem {
    id: string;
    name: string;
    originalName?: string; // Track initial name
    amount: number;
    type: 'root' | 'hang' | 'mok' | 'semok' | 'detail';
    children?: BudgetItem[];
    execution?: number;
    key?: string;
    isFolder?: boolean;
}

interface ManualEntry {
    id: string;
    date: string;
    writer: string;
    amount: number;
    description: string;
    isPlaceholder?: boolean;
}

interface BudgetPlan {
    department: string;
    budgetItem: string;
    categoryGroup?: string;
    source: string;
    category1: string;
    projectName: string;
    category2: string;
    budgetAmount: number;
    manualEntries: ManualEntry[];
    order?: number;
}

const normalizeBudgetItem = (name: string) => {
    if (!name) return '';
    let normalized = name.trim();
    if (normalized.includes(' 외 ')) {
        normalized = normalized.split(' 외 ')[0].trim();
    } else {
        normalized = normalized.replace(/[\s\u00A0]*외[\s\u00A0]*\d+[\s\u00A0]*건\s*$/, '').trim();
    }
    return normalized;
};


const normalizeDepartmentName = (name: string) => {
    const text = (name || '').trim();
    if (!text) return '';
    if (text.includes('증진')) return '증진';
    if (text.includes('회복')) return '회복';
    if (text.includes('자살')) return '자살';
    if (text.includes('남부')) return '남부';
    if (text.includes('아동')) return '아동청소년';
    return text.replace(/팀$/, '').trim();
};

const toBudgetKey = (department: string, item: string) => {
    const dept = normalizeDepartmentName(department);
    const normalizedItem = normalizeBudgetItem(item);
    return dept && normalizedItem ? `${dept}_${normalizedItem}` : '';
};

const normalizeHiddenItemKeys = (hidden: string[]) => {
    if (!Array.isArray(hidden)) return [];
    const normalized = hidden
        .map((key) => {
            if (typeof key !== 'string') return '';
            const idx = key.indexOf('_');
            if (idx < 1) return '';
            return toBudgetKey(key.slice(0, idx), key.slice(idx + 1));
        })
        .filter(Boolean);
    return Array.from(new Set(normalized));
};

const normalizeBudgetPlansMap = (plans: Record<string, BudgetPlan>) => {
    const normalized: Record<string, BudgetPlan> = {};
    Object.values(plans || {}).forEach((plan: BudgetPlan) => {
        if (!plan?.department || !plan?.budgetItem) return;
        const key = toBudgetKey(plan.department, plan.budgetItem);
        if (!key) return;
        const [department, budgetItem] = key.split('_');
        normalized[key] = {
            ...plan,
            categoryGroup: plan.categoryGroup || '미지정',
            department,
            budgetItem,
            category2: plan.category2 || budgetItem,
            budgetAmount: Number(plan.budgetAmount) || 0,
            manualEntries: Array.isArray(plan.manualEntries) ? plan.manualEntries : []
        };
    });
    return normalized;
};

const getBudgetItemEmoji = (name: string, customMap: Record<string, string> = {}) => {
    const n = name.toLowerCase().replace(/\s+/g, '');

    // Check custom map first
    if (customMap[name] || customMap[normalizeBudgetItem(name)]) {
        return customMap[name] || customMap[normalizeBudgetItem(name)];
    }

    // 1. 인건비 & 수당 (Personnel & Allowances)
    if (n.includes('급여') || n.includes('봉급') || n.includes('월급')) return '💰';
    if (n.includes('상여') || n.includes('보너스') || n.includes('성과')) return '💸';
    if (n.includes('수당') || n.includes('직책') || n.includes('가족')) return '💵';
    if (n.includes('퇴직') || n.includes('연금')) return '🏦';
    if (n.includes('일용') || n.includes('임시') || n.includes('아르바이트') || n.includes('알바')) return '👷';
    if (n.includes('강사') || n.includes('강의') || n.includes('자문')) return '👨‍🏫';
    if (n.includes('회의비') || n.includes('거마비')) return '🤝';
    if (n.includes('사회보험') || n.includes('4대보험') || n.includes('국민연금') || n.includes('건강보험')) return '🛡️';

    // 2. 운영비 & 사무 (Operations & Office)
    if (n.includes('사무용품') || n.includes('문구') || n.includes('필기')) return '✏️';
    if (n.includes('소모품') || n.includes('잡화')) return '📎';
    if (n.includes('인쇄') || n.includes('복사') || n.includes('제본') || n.includes('프린트')) return '🖨️';
    if (n.includes('도서') || n.includes('서적') || n.includes('구입') || n.includes('책')) return '📚';
    if (n.includes('신문') || n.includes('구독') || n.includes('잡지')) return '📰';
    if (n.includes('우편') || n.includes('택배') || n.includes('등기') || n.includes('발송')) return '📮';
    if (n.includes('통신') || n.includes('전화') || n.includes('인터넷') || n.includes('요금')) return '📞';
    if (n.includes('수수료') || n.includes('용역') || n.includes('대행')) return '🧾';
    if (n.includes('공공요금') || n.includes('전기') || n.includes('수도') || n.includes('가스')) return '⚡';
    if (n.includes('임차') || n.includes('월세') || n.includes('대관')) return '🏠';
    if (n.includes('관리비') || n.includes('청소') || n.includes('방역')) return '🧹';
    if (n.includes('시설') || n.includes('수선') || n.includes('보수') || n.includes('유지')) return '🛠️';
    if (n.includes('차량') || n.includes('유류') || n.includes('주유') || n.includes('휘발유')) return '⛽';
    if (n.includes('보험') || n.includes('자동차보험')) return '🚗';

    // 3. 식비 & 접대 (Food & Hospitality)
    if (n.includes('식비') || n.includes('급식') || n.includes('중식') || n.includes('석식')) return '🍚';
    if (n.includes('간식') || n.includes('다과') || n.includes('음료') || n.includes('커피')) return '☕';
    if (n.includes('회식') || n.includes('접대') || n.includes('오찬') || n.includes('만찬')) return '🍽️';
    if (n.includes('특근') || n.includes('야근') || n.includes('매식')) return '🌙';
    if (n.includes('생수') || n.includes('정수기')) return '💧';

    // 4. 행사 & 홍보 (Events & PR)
    if (n.includes('행사') || n.includes('이벤트') || n.includes('축제') || n.includes('워크숍')) return '🎉';
    if (n.includes('홍보') || n.includes('광고') || n.includes('현수막') || n.includes('배너')) return '📢';
    if (n.includes('기념품') || n.includes('판촉') || n.includes('선물')) return '🎁';
    if (n.includes('사진') || n.includes('촬영') || n.includes('영상')) return '📸';
    if (n.includes('홈페이지') || n.includes('웹사이트') || n.includes('서버')) return '🌐';
    if (n.includes('디자인') || n.includes('제작')) return '🎨';

    // 5. 교육 & 훈련 (Education & Training)
    if (n.includes('교육') || n.includes('연수') || n.includes('훈련') || n.includes('학습')) return '🎓';
    if (n.includes('등록금') || n.includes('수강료')) return '🎫';
    if (n.includes('학회') || n.includes('세미나') || n.includes('포럼')) return '🏛️';

    // 6. 여비 & 출장 (Travel)
    if (n.includes('여비') || n.includes('출장') || n.includes('교통비')) return '🚆';
    if (n.includes('숙박') || n.includes('호텔') || n.includes('콘도')) return '🏨';
    if (n.includes('항공') || n.includes('비행기')) return '✈️';
    if (n.includes('택시') || n.includes('버스')) return '🚕';

    // 7. 자산 & 물품 (Assets & Goods)
    if (n.includes('자산') || n.includes('취득') || n.includes('구입')) return '💎';
    if (n.includes('비품') || n.includes('가구') || n.includes('책상') || n.includes('의자')) return '🪑';
    if (n.includes('전산') || n.includes('컴퓨터') || n.includes('노트북') || n.includes('pc')) return '💻';
    if (n.includes('소프트웨어') || n.includes('프로그램') || n.includes('라이선스')) return '💿';
    if (n.includes('에어컨') || n.includes('냉장고') || n.includes('가전')) return '❄️';

    // 8. 복리후생 & 지원 (Welfare & Support)
    if (n.includes('복리') || n.includes('후생') || n.includes('복지')) return '🍀';
    if (n.includes('피복') || n.includes('유니폼') || n.includes('작업복')) return '👕';
    if (n.includes('건강검진') || n.includes('의료')) return '🏥';
    if (n.includes('경조사') || n.includes('화환') || n.includes('부조')) return '💐';
    if (n.includes('지원금') || n.includes('보조금') || n.includes('구호')) return '🤝';
    if (n.includes('장학')) return '📜';

    // 9. 기타 (Others)
    if (n.includes('예비비')) return '🚨';
    if (n.includes('반환') || n.includes('환불')) return '↩️';
    if (n.includes('이자') || n.includes('상환')) return '📉';
    if (n.includes('세금') || n.includes('공과금')) return '🏛️';
    if (n.includes('잡비') || n.includes('기타')) return '📦';

    // Default mappings based on first character or random-ish logic for variety if no keyword matches
    // This ensures "500 varieties" feel even for unmapped items
    const firstChar = n.charAt(0);
    if (firstChar >= '가' && firstChar <= '나') return '🍏';
    if (firstChar >= '다' && firstChar <= '라') return '🍊';
    if (firstChar >= '마' && firstChar <= '바') return '🍇';
    if (firstChar >= '사' && firstChar <= '아') return '🍓';
    if (firstChar >= '자' && firstChar <= '차') return '🍒';
    if (firstChar >= '카' && firstChar <= '타') return '🍑';
    if (firstChar >= '파' && firstChar <= '하') return '🍍';

    return '📂';
};

// --- HYUNDAI CARD STYLE COMPONENTS ---

const HCard = ({ children, className = '', ...props }: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) => (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 ${className}`} {...props}>
        {children}
    </div>
);

const HButton = ({ onClick, children, variant = 'primary', className = '', title = '' }: any) => {
    const baseStyle = "px-4 py-2 rounded-lg font-bold text-sm transition-all duration-200 flex items-center justify-center gap-2";
    const variants = {
        primary: "bg-black text-white hover:bg-gray-800 shadow-md hover:shadow-lg",
        secondary: "bg-gray-100 text-gray-700 hover:bg-gray-200",
        outline: "border-2 border-gray-200 text-gray-600 hover:border-black hover:text-black",
        ghost: "text-gray-500 hover:text-black hover:bg-gray-50",
        danger: "bg-red-50 text-red-600 hover:bg-red-100"
    };
    return (
        <button onClick={onClick} className={`${baseStyle} ${variants[variant as keyof typeof variants]} ${className}`} title={title}>
            {children}
        </button>
    );
};

const HInput = (props: any) => (
    <input
        {...props}
        className={`w-full px-3 py-2 bg-gray-50 border-b-2 border-gray-200 focus:border-black outline-none transition-colors font-medium text-gray-800 placeholder-gray-400 ${props.className || ''}`}
    />
);

const HBadge = ({ children, color = 'gray' }: { children: React.ReactNode; color?: string }) => {
    const colors: any = {
        gray: 'bg-gray-100 text-gray-600',
        blue: 'bg-blue-50 text-blue-600',
        red: 'bg-red-50 text-red-600',
        green: 'bg-green-50 text-green-600',
        black: 'bg-black text-white'
    };
    return (
        <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider ${colors[color] || colors.gray}`}>
            {children}
        </span>
    );
};

// [v5.5 FIX] IME-safe Group Name Input to prevent "Zombie Text"
const BudgetGroupNameInput = ({ initialValue, onSave, placeholder = '미지정' }: { initialValue: string, onSave: (val: string) => void, placeholder?: string }) => {
    const [localValue, setLocalValue] = useState(initialValue || '');
    const isComposing = useRef(false);

    useEffect(() => {
        setLocalValue(initialValue || '');
    }, [initialValue]);

    const handleBlur = () => {
        if (!isComposing.current) {
            onSave(localValue);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !isComposing.current) {
            onSave(localValue);
            (e.target as HTMLInputElement).blur();
        }
    };

    return (
        <input
            type="text"
            className="bg-white border border-gray-300 rounded px-1 py-0.5 text-xs flex-1"
            value={localValue}
            placeholder={placeholder}
            onCompositionStart={() => { isComposing.current = true; }}
            onCompositionEnd={(e) => { 
                isComposing.current = false;
                const finalValue = (e.target as HTMLInputElement).value;
                setLocalValue(finalValue);
            }}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
        />
    );

};

// -------------------------------------


function ManualEntryModal({
    isOpen,
    onClose,
    title,
    entries,
    onSave,
    currentUser
}: {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    entries: ManualEntry[];
    onSave: (entries: ManualEntry[]) => Promise<void>;
    currentUser: User;
}) {
    const [localEntries, setLocalEntries] = useState<ManualEntry[]>([]);
    const [isSavingLocal, setIsSavingLocal] = useState(false);
    const [isAutoSaving, setIsAutoSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
    const latestEntriesRef = useRef(localEntries);
    useEffect(() => { latestEntriesRef.current = localEntries; }, [localEntries]);

    const [searchTerm, setSearchTerm] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [focusedCell, setFocusedCell] = useState<{ id: string, field: keyof ManualEntry } | null>(null);

    // Ensure at least 5 rows for Excel-like experience
    const padEntries = (entries: ManualEntry[]) => {
        // 1. Filter out all empty rows (placeholders with 0 amount/empty description)
        const populated = entries.filter(e => !e.isPlaceholder || (e.amount !== 0 || e.description.trim() !== ''));
        
        // 2. Sort by date DESC (Recent first)
        const sorted = [...populated].sort((a, b) => b.date.localeCompare(a.date));
        
        // 3. Add exactly 5 empty rows
        const placeholders = Array.from({ length: 5 }).map((_, i) => ({
            id: `empty_${Date.now()}_${i}`,
            date: new Date().toISOString().split('T')[0],
            writer: currentUser.name,
            amount: 0,
            description: '',
            isPlaceholder: true
        }));
        
        return [...placeholders, ...sorted];
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        const text = e.clipboardData.getData('text');
        if (!text) return;

        const lines = text.split(/\r?\n/).filter(line => line.trim());
        if (lines.length === 0) return;

        // In-place paste logic
        if (focusedCell) {
            e.preventDefault();
            const startRowIndex = localEntries.findIndex(ent => ent.id === focusedCell.id);
            if (startRowIndex === -1) return;

            const updatedEntries = [...localEntries];
            const fields: (keyof ManualEntry)[] = ['date', 'writer', 'amount', 'description'];
            const startFieldIndex = fields.indexOf(focusedCell.field);

            lines.forEach((line, rowOffset) => {
                const rowIndex = startRowIndex + rowOffset;
                if (rowIndex >= updatedEntries.length) {
                    // Create new row if we exceed current grid
                    updatedEntries.push({
                        id: `pasted_${Date.now()}_${rowIndex}`,
                        date: new Date().toISOString().split('T')[0],
                        writer: currentUser.name,
                        amount: 0,
                        description: ''
                    });
                }

                const parts = line.split('\t');
                parts.forEach((val, colOffset) => {
                    const fieldIndex = startFieldIndex + colOffset;
                    if (fieldIndex < fields.length) {
                        const field = fields[fieldIndex];
                        let finalVal: any = val.trim();
                        if (field === 'amount') {
                            finalVal = Number(finalVal.replace(/[^0-9.-]+/g, '')) || 0;
                        }
                        updatedEntries[rowIndex] = {
                            ...updatedEntries[rowIndex],
                            [field]: finalVal,
                            isPlaceholder: false // Mark as real data if it was a placeholder
                        };
                    }
                });
            });

            setLocalEntries(padEntries(updatedEntries));
            return;
        }

        // Fallback: Default bulk append paste (if no cell focused)
        const newEntries: ManualEntry[] = lines.map(line => {
            const parts = line.split('\t');
            return {
                id: (Date.now() + Math.random()).toString(),
                date: parts[0]?.trim() || new Date().toISOString().split('T')[0],
                writer: parts[1]?.trim() || currentUser.name,
                amount: Number(parts[2]?.replace(/[^0-9.-]+/g, '')) || 0,
                description: parts[3]?.trim() || '',
                isPlaceholder: false
            };
        });

        if (newEntries.length > 0) {
            e.preventDefault();
            const existingData = localEntries.filter(ent => !ent.isPlaceholder || (ent.amount !== 0 || ent.description !== ''));
            const merged = [...newEntries, ...existingData];
            setLocalEntries(padEntries(merged));
        }
    };

    // Use a ref to track if the modal was just opened to prevent loops
    const initialLoadDone = useRef(false);

    useEffect(() => {
        if (isOpen && !initialLoadDone.current) {
            setLocalEntries(padEntries(entries.map(e => ({ ...e }))));
            setSearchTerm('');
            setStartDate('');
            setEndDate('');
            initialLoadDone.current = true;
        }
        if (!isOpen) {
            initialLoadDone.current = false;
            setLastSaved(null);
        }
    }, [isOpen, entries]);

    const handleAdd = () => {
        const newEntry: ManualEntry = {
            id: Date.now().toString(),
            date: new Date().toISOString().split('T')[0],
            writer: currentUser.name,
            amount: 0,
            description: '',
            isPlaceholder: false
        };
        // Re-pad will sort this new entry (today's date) to the top area and ensure exactly 5 blanks remain at bottom
        setLocalEntries(prev => padEntries([newEntry, ...prev]));
    };

    const handleChange = (id: string, field: keyof ManualEntry, value: any) => {
        setLocalEntries(prev => {
            const next = prev.map(e => e.id === id ? { ...e, [field]: value, isPlaceholder: false } : e);
            
                // Maintain exactly 5 empty rows at the TOP
                const emptyCount = next.filter(e => e.isPlaceholder && e.amount === 0 && e.description.trim() === '').length;
                if (emptyCount < 5) {
                    const needed = 5 - emptyCount;
                    const newOnes = Array.from({ length: needed }).map((_, i) => ({
                        id: `empty_${Date.now()}_${i}`,
                        date: new Date().toISOString().split('T')[0],
                        writer: currentUser.name,
                        amount: 0,
                        description: '',
                        isPlaceholder: true
                    }));
                    return [...newOnes, ...next];
                } else if (emptyCount > 5) {
                    // Remove extra empty ones from the top
                    const result = [];
                    let blanksRemoved = 0;
                    const totalBlanks = emptyCount;
                    const blanksToKeep = 5;
                    const blanksToRemove = totalBlanks - blanksToKeep;
                    
                    for (let i = 0; i < next.length; i++) {
                        const item = next[i];
                        if (item.isPlaceholder && item.amount === 0 && item.description.trim() === '' && blanksRemoved < blanksToRemove) {
                            blanksRemoved++;
                            continue;
                        }
                        result.push(item);
                    }
                    return result;
                }
                return next;
        });
    };

    const handleDelete = (id: string) => {
        if (!window.confirm('정말 삭제하시겠습니까?')) return;
        setLocalEntries(localEntries.filter(e => e.id !== id));
    };

    const performSave = async (silent = false) => {
        if (!silent) setIsSavingLocal(true);
        else setIsAutoSaving(true);

        try {
            await onSave(localEntries);
            setLastSaved(new Date());
            if (!silent) onClose();
        } catch (error) {
            console.error('Save failed:', error);
            if (!silent) alert('저장에 실패했습니다. 다시 시도해 주세요.');
        } finally {
            setIsSavingLocal(false);
            setIsAutoSaving(false);
        }
    };

    const handleSave = () => performSave(false);

    const handleCloseWithSave = async () => {
        if (autoSaveTimerRef.current) {
            console.log("[ManualEntryModal] Closing: Triggering pending save");
            await performSave(true);
        }
        onClose();
    };

    // Auto-save logic
    useEffect(() => {
        if (!isOpen || localEntries.length === 0) return;

        // Skip initial load save
        const isInitial = entries.length === localEntries.filter(e => !e.isPlaceholder).length;
        if (isInitial && !lastSaved) return;

        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);

        autoSaveTimerRef.current = setTimeout(() => {
            performSave(true);
        }, 2000); // 2 second debounce

        return () => {
            if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        };
    }, [localEntries, isOpen]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (autoSaveTimerRef.current) {
                console.log("[ManualEntryModal] Unmount: Triggering pending save");
                onSave(latestEntriesRef.current);
            }
        };
    }, []);

    // Filter & Sort Logic
    const filteredEntries = useMemo(() => {
        return localEntries
            .filter(entry => {
                // If it's a placeholder AND we are searching/filtering, hide it unless it has data
                if (entry.isPlaceholder && !searchTerm && !startDate && !endDate) return true;
                if (entry.isPlaceholder && (searchTerm || startDate || endDate)) {
                    const hasData = (entry.amount !== 0 || entry.description !== '');
                    if (!hasData) return false;
                }

                if (startDate && entry.date < startDate) return false;
                if (endDate && entry.date > endDate) return false;

                if (searchTerm) {
                    const term = searchTerm.toLowerCase();
                    const writer = (entry.writer || '').toLowerCase();
                    const desc = (entry.description || '').toLowerCase();
                    return writer.includes(term) || desc.includes(term);
                }
                return true;
            })
            .sort((a, b) => {
                // Placeholders at the end
                const aIsBlank = a.isPlaceholder && !a.description && a.amount === 0;
                const bIsBlank = b.isPlaceholder && !b.description && b.amount === 0;

                if (aIsBlank && !bIsBlank) return -1;
                if (!aIsBlank && bIsBlank) return 1;

                // For populated rows, sort by date DESC
                return b.date.localeCompare(a.date);
            });
    }, [localEntries, startDate, endDate, searchTerm]);

    // Dynamic Sum based on FILTERED entries
    const totalAmount = filteredEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 font-sans">
            <div className="bg-white rounded-2xl shadow-2xl budget-manual-modal-container flex flex-col overflow-hidden animate-scale-in">
                {/* Header */}
                <div className="p-6 bg-black text-white flex justify-between items-center">
                    <div>
                        <h3 className="font-black text-2xl tracking-tight">{title}</h3>
                        <p className="text-gray-400 text-sm mt-1">지출 내역 수기 관리</p>
                    </div>
                    <button onClick={handleCloseWithSave} className="text-gray-400 hover:text-white transition-colors"><X size={24} /></button>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
                    {/* Summary & Actions */}
                    <div className="p-6 pb-2">
                        <div className="flex justify-between items-center bg-white p-5 rounded-2xl shadow-sm border border-gray-100 mb-4">
                            <div>
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1">총 지출액 (현재 목록)</span>
                                <div className="flex items-baseline gap-1">
                                    <span className="font-black text-4xl text-gray-900 tracking-tighter transition-all duration-300">
                                        {totalAmount.toLocaleString()}
                                    </span>
                                    <span className="text-sm font-bold text-gray-500">KRW</span>
                                </div>
                            </div>
                            <HButton onClick={handleAdd} variant="primary" className="h-12 px-6 text-base shadow-md hover:shadow-lg transform active:scale-95 transition-all">
                                <Plus size={20} /> 항목 추가
                            </HButton>
                        </div>

                        {/* Search Controller */}
                        <div className="flex gap-3 items-center bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                            <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                                <span className="text-xs font-bold text-gray-500 whitespace-nowrap">기간</span>
                                <input
                                    type="date"
                                    value={startDate}
                                    onChange={e => setStartDate(e.target.value)}
                                    className="bg-transparent text-sm font-bold text-gray-700 outline-none w-32"
                                />
                                <span className="text-gray-400">~</span>
                                <input
                                    type="date"
                                    value={endDate}
                                    onChange={e => setEndDate(e.target.value)}
                                    className="bg-transparent text-sm font-bold text-gray-700 outline-none w-32"
                                />
                            </div>

                            <div className="flex-1 flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 focus-within:ring-2 focus-within:ring-black/5 focus-within:border-black transition-all">
                                <Search size={16} className="text-gray-400" />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    placeholder="작성자 또는 적요 검색..."
                                    className="bg-transparent w-full text-sm font-bold text-gray-700 outline-none placeholder:font-medium placeholder:text-gray-400"
                                />
                                {searchTerm && (
                                    <button onClick={() => setSearchTerm('')} className="text-gray-400 hover:text-gray-600">
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Table List */}
                    <div className="px-6 pb-6 flex-1 flex flex-col overflow-hidden">
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 manual-budget-table-scroll custom-scrollbar">
                            <table className="w-full text-[11px] md:text-xs text-left border-collapse relative" onPaste={handlePaste}>
                                <thead className="bg-gray-100 text-gray-600 font-black uppercase tracking-wider border-b border-gray-200 sticky top-0 z-10 transition-colors">
                                    <tr>
                                        <th className="p-2 border-r border-gray-200 col-date" style={{ width: '120px', minWidth: '120px' }}>날짜 (Date)</th>
                                        <th className="p-2 border-r border-gray-200 col-writer text-center" style={{ width: '100px', minWidth: '100px' }}>작성자</th>
                                        <th className="p-2 border-r border-gray-200 col-amount text-right" style={{ width: '140px', minWidth: '140px' }}>금액 (Amount)</th>
                                        <th className="p-2 border-r border-gray-200 col-desc" style={{ minWidth: '320px' }}>적요 (Description)</th>
                                        <th className="p-2 col-action text-center" style={{ width: '48px', minWidth: '48px' }}>
                                            <Trash2 size={12} className="mx-auto opacity-20" />
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                    {filteredEntries.map(entry => (
                                        <tr key={entry.id} className={`hover:bg-blue-50/40 transition-colors group ${entry.isPlaceholder ? 'bg-gray-50/30' : ''}`}>
                                            <td className="p-0 border-r border-gray-200 col-date" style={{ width: '120px', minWidth: '120px' }}>
                                                <input
                                                    type="date"
                                                    value={entry.date}
                                                    onChange={(e) => handleChange(entry.id, 'date', e.target.value)}
                                                    onFocus={() => setFocusedCell({ id: entry.id, field: 'date' })}
                                                    className="w-full px-2 py-2 bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 border-none font-medium text-gray-700"
                                                />
                                            </td>
                                            <td className="p-0 border-r border-gray-200 col-writer" style={{ width: '100px', minWidth: '100px' }}>
                                                <input
                                                    type="text"
                                                    value={entry.writer}
                                                    onChange={(e) => handleChange(entry.id, 'writer', e.target.value)}
                                                    onFocus={() => setFocusedCell({ id: entry.id, field: 'writer' })}
                                                    className="w-full px-2 py-2 bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 border-none text-center font-bold text-gray-600"
                                                />
                                            </td>
                                            <td className="p-0 border-r border-gray-200 col-amount bg-gray-50/10" style={{ width: '140px', minWidth: '140px' }}>
                                                <input
                                                    type="text"
                                                    value={entry.amount === 0 ? '' : entry.amount.toLocaleString()}
                                                    onChange={(e) => {
                                                        const val = e.target.value.replace(/[^0-9.-]+/g, '');
                                                        handleChange(entry.id, 'amount', Number(val) || 0);
                                                    }}
                                                    onFocus={() => setFocusedCell({ id: entry.id, field: 'amount' })}
                                                    placeholder="0"
                                                    className="w-full px-2 py-2 bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 border-none text-right font-mono font-bold text-black"
                                                />
                                            </td>
                                            <td className="p-0 border-r border-gray-200 col-desc" style={{ minWidth: '320px' }}>
                                                <input
                                                    type="text"
                                                    value={entry.description}
                                                    onChange={(e) => handleChange(entry.id, 'description', e.target.value)}
                                                    onFocus={() => setFocusedCell({ id: entry.id, field: 'description' })}
                                                    placeholder="내역을 입력하세요..."
                                                    className="w-full px-2 py-2 bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-blue-400 border-none font-medium text-gray-800"
                                                />
                                            </td>
                                            <td className="p-1 col-action text-center align-middle" style={{ width: '48px', minWidth: '48px' }}>
                                                {!entry.isPlaceholder && (
                                                    <button
                                                        onClick={() => handleDelete(entry.id)}
                                                        className="p-1 text-gray-300 hover:text-red-500 transition-all transform hover:scale-125 rounded-md hover:bg-red-50"
                                                        title="삭제"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    {filteredEntries.length === 0 && (
                                        <tr>
                                            <td colSpan={5} className="p-12 text-center text-gray-300 bg-white">
                                                <div className="flex flex-col items-center justify-center gap-3">
                                                    <Search size={32} className="opacity-10" />
                                                    <p className="font-bold text-gray-400 text-sm">일치하는 내역이 없습니다.</p>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div className="p-5 border-t border-gray-100 bg-white flex items-center justify-between z-20 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
                    <div className="flex items-center gap-2 text-[11px] font-bold">
                        {isAutoSaving ? (
                            <div className="flex items-center gap-1.5 text-blue-500 animate-pulse">
                                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full" />
                                <span>자동 저장 중...</span>
                            </div>
                        ) : lastSaved ? (
                            <div className="text-gray-400 flex items-center gap-1.5">
                                <Check size={12} className="text-green-500" />
                                <span>마지막 저장: {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                            </div>
                        ) : null}
                    </div>

                    <div className="flex gap-3">
                        <HButton onClick={onClose} variant="ghost" className="font-bold text-gray-500" disabled={isSavingLocal}>취소</HButton>
                        <HButton onClick={handleSave} variant="primary" className="bg-black hover:bg-gray-800 shadow-lg px-8" disabled={isSavingLocal || isAutoSaving}>
                            {isSavingLocal ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    저장 중...
                                </>
                            ) : "변경사항 저장"}
                        </HButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function BudgetPage({ currentUser, showToast }: BudgetPageProps) {
    const [transactions, setTransactions] = useState<BudgetTransaction[]>([]);
    const [isLoadingData, setIsLoadingData] = useState(false);
    const [filter, setFilter] = useState<BudgetFilter>(INITIAL_FILTER);
    const [presets, setPresets] = useState<BudgetPreset[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isFilterOpen, setIsFilterOpen] = useState(true);
    const [budgetItemSearch, setBudgetItemSearch] = useState('');

    const [budgetPlans, setBudgetPlans] = useState<Record<string, BudgetPlan>>({});
    const budgetPlansRef = useRef(budgetPlans);
    useEffect(() => { budgetPlansRef.current = budgetPlans; }, [budgetPlans]);
    const [isSaving, setIsSaving] = useState(false);
    const [editingCell, setEditingCell] = useState<{ id: string, field: keyof BudgetPlan } | null>(null);
    const [editValue, setEditValue] = useState('');

    const [modalState, setModalState] = useState<{ isOpen: boolean; department: string; budgetItem: string } | null>(null);
    const [uploadDate, setUploadDate] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'status' | 'history' | 'manual'>('status');
    const [historySearch, setHistorySearch] = useState('');
    const [sortConfig, setSortConfig] = useState<{ key: keyof BudgetTransaction | null; direction: 'asc' | 'desc' }>({ key: null, direction: 'asc' });
    const [draggedItem, setDraggedItem] = useState<{ id: string, department: string, budgetItem: string, order: number } | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const [draggedHierarchyId, setDraggedHierarchyId] = useState<string | null>(null);
    const [dragOverHierarchyId, setDragOverHierarchyId] = useState<string | null>(null);
    const [dragPosition, setDragPosition] = useState<'before' | 'inside' | 'after' | null>(null);
    const [isSidebarDragOver, setIsSidebarDragOver] = useState(false);
    const [hiddenItems, setHiddenItems] = useState<string[]>([]);
    const [itemSelectionModal, setItemSelectionModal] = useState<{ isOpen: boolean; department: string } | null>(null);
    const [customEmojis, setCustomEmojis] = useState<Record<string, string>>({});
    const [customGroupNames, setCustomGroupNames] = useState<Record<string, string>>({});
    const [emojiModal, setEmojiModal] = useState<{ isOpen: boolean; item: string; currentEmoji: string } | null>(null);
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [transactionModalOpen, setTransactionModalOpen] = useState(false);

    // Hierarchy Budget Data
    const [hierarchyData, setHierarchyData] = useState<BudgetItem[]>([]);
    const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
    const [isHierarchyEditMode, setIsHierarchyEditMode] = useState(false);
    const [undoStack, setUndoStack] = useState<{ action: string; data: BudgetItem[]; timestamp: number }[]>([]);
    const [redoStack, setRedoStack] = useState<{ action: string; data: BudgetItem[]; timestamp: number }[]>([]);

    // Global Cursor Management
    useEffect(() => {
        if (draggedHierarchyId || draggedItem) {
            document.body.classList.add('dragging-active');
        } else {
            document.body.classList.remove('dragging-active');
        }
        return () => {
            document.body.classList.remove('dragging-active');
        };
    }, [draggedHierarchyId, draggedItem]);



    // 예산 데이터 및 계층 구조 로드 (서버 → localStorage 폴백)
    useEffect(() => {
        let isMounted = true;
        
        const loadAllData = async () => {
            setIsLoadingData(true);
            
            async function withRetry<T>(fn: () => Promise<T>, name: string, retries = 3): Promise<T | null> {
                let attempt = 0;
                while (attempt < retries) {
                    try {
                        return await fn();
                    } catch (e) {
                        attempt++;
                        if (attempt >= retries) {
                            console.warn(`[BudgetPage] ${name} 로드 최종 실패 (시도: ${attempt})`);
                            return null;
                        }
                        const delay = Math.pow(2, attempt) * 1000;
                        console.log(`[BudgetPage] ${name} 로드 실패, ${delay}ms 후 재시도... (${attempt}/${retries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
                return null;
            };

            try {
                if (apiClient.isAvailable()) {
                    // Parallel load with independent retries
                    const [loadedTransactions, metadata, loadedHierarchy, loadedPlans] = await Promise.all([
                        withRetry(() => apiClient.getBudgetTransactions(), 'Transactions'),
                        withRetry(() => apiClient.getBudgetMetadata(), 'Metadata'),
                        withRetry(() => apiClient.getBudgetHierarchy(), 'Hierarchy'),
                        withRetry(() => apiClient.getBudgetPlans(), 'Plans')
                    ]);

                    if (!isMounted) return;

                    if (loadedTransactions && loadedTransactions.length > 0) {
                        setTransactions(loadedTransactions);
                        safeLocalStorage.setItem('budget_transactions', JSON.stringify(loadedTransactions));
                    } else {
                        const saved = safeLocalStorage.getItem('budget_transactions');
                        if (saved) setTransactions(JSON.parse(saved));
                    }

                    if (metadata && metadata.uploadDate) {
                        setUploadDate(`${metadata.uploadDate} (업로더: ${metadata.uploader || '미상'})`);
                        if (metadata.customEmojis) {
                            try { setCustomEmojis(JSON.parse(metadata.customEmojis)); } catch (e) { }
                        }
                        if (metadata.customGroupNames) {
                            try { setCustomGroupNames(JSON.parse(metadata.customGroupNames)); } catch (e) { }
                        }
                    }

                    if (loadedHierarchy && Array.isArray(loadedHierarchy) && loadedHierarchy.length > 0) {
                        setHierarchyData(loadedHierarchy);
                    } else {
                        const savedH = safeLocalStorage.getItem('budget_hierarchy_backup');
                        if (savedH) setHierarchyData(JSON.parse(savedH));
                        else setHierarchyData(sampleBudgetHierarchy as any);
                    }

                    if (loadedPlans && Object.keys(loadedPlans).length > 0) {
                        const normalized = (typeof normalizeBudgetPlansMap === 'function') ? normalizeBudgetPlansMap(loadedPlans) : loadedPlans;
                        setBudgetPlans(normalized);
                        safeLocalStorage.setItem('budget_plans', JSON.stringify(normalized));
                    } else {
                        const savedP = safeLocalStorage.getItem('budget_plans');
                        if (savedP) setBudgetPlans(JSON.parse(savedP));
                    }
                } else {
                    const saved = safeLocalStorage.getItem('budget_transactions');
                    if (saved) setTransactions(JSON.parse(saved));
                    setHierarchyData(sampleBudgetHierarchy as any);
                }
            } catch (error) {
                console.error('[BudgetPage] 전체 데이터 로딩 중 치명적 오류:', error);
            } finally {
                if (isMounted) setIsLoadingData(false);
            }
        };

        loadAllData();
        return () => { isMounted = false; };
    }, []);

    // Get all unique budget items from transactions and current plans
    const allBudgetItems = useMemo(() => {
        const items = new Set<string>();
        // From transactions
        transactions.forEach(t => {
            if (t.budgetItem) items.add(normalizeBudgetItem(t.budgetItem));
        });
        // From current plans
        (Object.values(budgetPlans) as BudgetPlan[]).forEach(p => {
            if (p.budgetItem) items.add(normalizeBudgetItem(p.budgetItem));
        });
        // Ensure default items exist if empty (optional, but good for UX)
        if (items.size === 0) {
            ['여비', '수용비', '운영비', '사업비'].forEach(i => items.add(i));
        }
        return Array.from(items).sort();
    }, [transactions, budgetPlans]);

    // Load presets
    useEffect(() => {
        const savedPresets = safeLocalStorage.getItem('budget_presets');
        if (savedPresets) {
            try {
                setPresets(JSON.parse(savedPresets));
            } catch (e) {
                console.error('Failed to load presets', e);
            }
        }
    }, []);

    // Load hidden items
    useEffect(() => {
        const savedHidden = safeLocalStorage.getItem('budget_hidden_items');
        if (savedHidden) {
            try {
                const parsed = JSON.parse(savedHidden);
                const normalized = normalizeHiddenItemKeys(parsed);
                setHiddenItems(normalized);
                safeLocalStorage.setItem('budget_hidden_items', JSON.stringify(normalized));
            } catch (e) {
                console.error('Failed to load hidden items', e);
            }
        }
    }, []);




    const syncHierarchyWithPlans = (plans: Record<string, BudgetPlan>) => {
        if (!plans) return;

        setHierarchyData(prev => {
            const next = Array.isArray(prev) ? JSON.parse(JSON.stringify(prev)) : [];
            let changed = false;

            // 1. Create a set of valid keys currently present in plans
            const validKeys = new Set(Object.keys(plans));

            // 2. Add or Update items from plans
            Object.values(plans).forEach(plan => {
                if (!plan.department || !plan.budgetItem) return;

                const dept = plan.department;
                const itemName = plan.budgetItem;
                const normalizedItemName = normalizeBudgetItem(itemName);
                const targetDeptNorm = normalizeDepartmentName(dept);

                let root = next.find((r: any) => normalizeDepartmentName(r.name) === targetDeptNorm);
                if (!root) {
                    root = {
                        id: `root-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        name: dept,
                        type: 'root',
                        amount: 0,
                        children: []
                    };
                    next.push(root);
                    changed = true;
                }

                if (!root.children) root.children = [];
                let mok = root.children.find((c: any) => normalizeBudgetItem(c.name) === normalizedItemName);
                if (!mok) {
                    mok = {
                        id: `mok-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        name: itemName,
                        type: 'mok',
                        amount: plan.budgetAmount || 0,
                        children: []
                    };
                    root.children.push(mok);
                    changed = true;
                } else {
                    if (plan.budgetAmount !== undefined && (!mok.children || mok.children.length === 0)) {
                        if (mok.amount !== plan.budgetAmount) {
                            mok.amount = plan.budgetAmount;
                            changed = true;
                        }
                    }
                }
            });

            // 3. Cleanup: Remove items that are no longer in plans
            next.forEach((root: any) => {
                if (root.children && Array.isArray(root.children)) {
                    const initialLength = root.children.length;
                    
                    // Filter children: Keep if key is valid OR if it has sub-children (to prevent accidental data loss)
                    root.children = root.children.filter((child: any) => {
                        const key = toBudgetKey(root.name, child.name);
                        const hasPlans = validKeys.has(key);
                        const hasDetails = child.children && child.children.length > 0;
                        return hasPlans || hasDetails;
                    });

                    if (root.children.length !== initialLength) {
                        changed = true;
                    }
                }
            });

            if (changed) {
                const calculateSummary = (items: BudgetItem[]): BudgetItem[] => {
                    return items.map(item => {
                        if (item.children && item.children.length > 0) {
                            const updatedChildren = calculateSummary(item.children);
                            const totalAmount = updatedChildren.reduce((sum, child) => sum + child.amount, 0);
                            return { ...item, children: updatedChildren, amount: totalAmount };
                        }
                        return item;
                    });
                };
                const results = calculateSummary(next);
                safeLocalStorage.setItem('budget_hierarchy', JSON.stringify(results));
                return results;
            }
            return prev;
        });
    };

    const handleSaveHierarchy = async () => {
        setIsSaving(true);
        try {
            if (apiClient.isAvailable()) {
                const retrySave = async (fn: () => Promise<any>, name: string, retries = 3) => {
                    let attempt = 0;
                    while (attempt < retries) {
                        try {
                            return await fn();
                        } catch (e) {
                            attempt++;
                            if (attempt >= retries) throw e;
                            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        }
                    }
                };

                await retrySave(() => apiClient.saveBudgetHierarchy(hierarchyData), 'Hierarchy');
                await retrySave(() => apiClient.saveBudgetMetadata({
                    uploadDate: uploadDate?.split(' (')[0] || new Date().toLocaleString('ko-KR'),
                    uploader: currentUser.name,
                    recordCount: transactions.length,
                    customEmojis: JSON.stringify(customEmojis),
                    customGroupNames: JSON.stringify(customGroupNames)
                }), 'Metadata');
                
                // 로컬 백업
                safeLocalStorage.setItem('budget_hierarchy_backup', JSON.stringify(hierarchyData));
                showToast('예산 구조가 성공적으로 저장되었습니다.');
            }
            setIsHierarchyEditMode(false);
        } catch (e: any) {
            console.error('Failed to save hierarchy after retries', e);
            showToast(`저장 실패: ${e.message || '서버 연결 상태를 확인해주세요.'}`);
        } finally {
            setIsSaving(false);
        }
    };

    // Auto-expand all hierarchy rows on initial load
    const hierarchyInitializedRef = useRef(false);
    useEffect(() => {
        if (!hierarchyInitializedRef.current && hierarchyData.length > 0) {
            hierarchyInitializedRef.current = true;
            const allIds: string[] = [];
            const collectIds = (items: BudgetItem[]) => {
                items.forEach(item => {
                    if (item.children && item.children.length > 0) {
                        allIds.push(item.id);
                        collectIds(item.children);
                    }
                });
            };
            collectIds(hierarchyData);
            setExpandedRowKeys(allIds);
        }
    }, [hierarchyData]);

    const saveBudgetPlan = async (department: string, budgetItem: string, field: keyof BudgetPlan, value: any) => {
        setIsSaving(true);
        const retryLimit = 3;
        let attempt = 0;
        
        try {
            const key = toBudgetKey(department, budgetItem);
            const currentPlan = budgetPlans[key] || {
                department,
                budgetItem,
                categoryGroup: '미지정',
                source: '',
                category1: '',
                projectName: '',
                category2: budgetItem,
                budgetAmount: 0,
                manualEntries: [],
                order: 0
            };

            const newPlan = { ...currentPlan, [field]: value };
            
            // 1. Immediate Local State Update
            setBudgetPlans(prev => {
                const updated = { ...prev, [key]: newPlan };
                safeLocalStorage.setItem('budget_plans', JSON.stringify(updated));
                budgetPlansRef.current = updated;
                
                // Sync with hierarchy if amount was changed
                if (field === 'budgetAmount') {
                    syncHierarchyWithPlans(updated);
                }
                
                return updated;
            });

            // 2. Sequential Server Save with Retry
            const saveToServer = async () => {
                if (!apiClient.isAvailable()) return;
                
                while (attempt < retryLimit) {
                    try {
                        const latestPlans = { ...budgetPlansRef.current, [key]: newPlan };
                        await apiClient.saveBudgetPlans(latestPlans);
                        return; // Success!
                    } catch (e) {
                        attempt++;
                        console.warn(`Save attempt ${attempt} failed. Retrying...`, e);
                        if (attempt >= retryLimit) throw e;
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                    }
                }
            };

            await saveToServer();
            
            // Ensure "Saving" message stays long enough for user to see
            await new Promise(resolve => setTimeout(resolve, 800));
            
        } catch (e) {
            console.error('Failed to save budget plans after retries', e);
            showToast('서버 저장 실패: 인터넷 연결을 확인해주세요. (로컬에는 저장됨)');
            throw e;
        } finally {
            setIsSaving(false);
        }
    };

    const handleEmojiClick = (e: React.MouseEvent, item: string) => {
        e.stopPropagation();
        const current = getBudgetItemEmoji(item, customEmojis);
        setEmojiModal({ isOpen: true, item, currentEmoji: current });
    };

    const handleEmojiSave = (newItem: string, newEmoji: string) => {
        const newEmojis = { ...customEmojis, [newItem]: newEmoji };
        setCustomEmojis(newEmojis);
        setEmojiModal(null);

        // Save to server
        if (apiClient.isAvailable()) {
            apiClient.saveBudgetMetadata({
                uploadDate: uploadDate?.split(' (')[0] || new Date().toLocaleString('ko-KR'),
                uploader: currentUser.name,
                recordCount: transactions.length,
                customEmojis: JSON.stringify(newEmojis),
                customGroupNames: JSON.stringify(customGroupNames)
            }).catch(err => console.error('Failed to save emoji metadata', err));
        }
    };

    const handleSaveSelectedItems = () => {
        if (!filter.budgetItem || filter.budgetItem.length === 0) {
            showToast('선택된 예산과목이 없습니다.');
            return;
        }

        const targetDepts = filter.department && filter.department.length > 0 ? filter.department : TEAMS;
        const newPlans = { ...budgetPlans };
        let count = 0;
        const newHiddenItems = [...hiddenItems];

        targetDepts.forEach(dept => {
            filter.budgetItem?.forEach(item => {
                const normItem = normalizeBudgetItem(item);
                const key = `${dept}_${normItem}`;

                // Remove from hidden items if present
                const hiddenIdx = newHiddenItems.indexOf(key);
                if (hiddenIdx > -1) {
                    newHiddenItems.splice(hiddenIdx, 1);
                }

                if (!newPlans[key]) {
                    newPlans[key] = {
                        department: dept,
                        budgetItem: normItem,
                        categoryGroup: '미지정',
                        source: '',
                        category1: '',
                        projectName: '',
                        category2: normItem,
                        budgetAmount: 0,
                        manualEntries: [],
                        order: 0
                    };
                    count++;
                }
            });
        });

        if (count > 0 || newHiddenItems.length !== hiddenItems.length) {
            setBudgetPlans(newPlans);
            setHiddenItems(newHiddenItems);
            safeLocalStorage.setItem('budget_plans', JSON.stringify(newPlans));
            safeLocalStorage.setItem('budget_hidden_items', JSON.stringify(newHiddenItems));
            showToast(`${count}개의 예산과목이 저장/복구되었습니다.`);
        } else {
            showToast('이미 저장된 예산과목들입니다.');
        }
    };

    const handleCellClick = (id: string, field: keyof BudgetPlan, currentValue: any, department: string, budgetItem: string) => {
        setEditingCell({ id, field });
        setEditValue(String(currentValue || ''));
    };

    const handleCellSave = (department: string, budgetItem: string) => {
        if (!editingCell) return;

        let value: string | number = editValue;
        if (editingCell.field === 'budgetAmount') {
            value = Number(editValue.replace(/,/g, ''));
            if (isNaN(value)) value = 0;
        }

        if (editingCell.field === 'department') {
            const newDept = String(value).trim();
            if (newDept && newDept !== department) {
                // Migrate to new department key
                const oldKey = `${department}_${budgetItem}`;
                const newKey = `${newDept}_${budgetItem}`;

                const oldPlan = budgetPlans[oldKey];
                if (oldPlan) {
                    const newPlans = { ...budgetPlans };

                    // Create new plan with new department
                    newPlans[newKey] = {
                        ...oldPlan,
                        department: newDept
                    };

                    // Remove old plan
                    delete newPlans[oldKey];

                    setBudgetPlans(newPlans);
                    safeLocalStorage.setItem('budget_plans', JSON.stringify(newPlans));
                }
            }
        } else {
            saveBudgetPlan(department, budgetItem, editingCell.field, value);
        }
        setEditingCell(null);
    };

    const handleAddHierarchyGroup = () => {
        const deptName = filter.department?.[0] || '공통';
        setHierarchyData(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            let root = next.find((r: any) => normalizeDepartmentName(r.name) === normalizeDepartmentName(deptName));
            
            if (!root) {
                root = {
                    id: `root-${Date.now()}`,
                    name: deptName,
                    type: 'root',
                    amount: 0,
                    children: []
                };
                next.push(root);
            }

            const newGroup: BudgetItem = {
                id: `hang-${Date.now()}`,
                name: '새 그룹 항목',
                amount: 0,
                type: 'hang',
                children: []
            };

            if (!root.children) root.children = [];
            root.children.push(newGroup);

            setUndoStack(prevStack => [{ action: 'Add Group', data: prev, timestamp: Date.now() }, ...prevStack].slice(0, 20));
            setRedoStack([]);
            return next;
        });
    };

    const handleAddHierarchyRow = (parentId: string, type: 'hang' | 'mok' | 'semok' | 'detail') => {
        setHierarchyData(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            const newItem: BudgetItem = {
                id: `${type}-${Date.now()}`,
                name: type === 'hang' ? '새 항' : type === 'mok' ? '새 목' : type === 'semok' ? '새 세목' : '새 세부내역',
                amount: 0,
                type,
                children: []
            };

            const addToParent = (items: BudgetItem[]): boolean => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === parentId) {
                        if (!items[i].children) items[i].children = [];
                        items[i].children!.push(newItem);
                        return true;
                    }
                    if (items[i].children && addToParent(items[i].children!)) return true;
                }
                return false;
            };

            if (parentId === 'root') {
                // If adding a team (root), we don't usually do this manually in this UI, 
                // but if we did:
                newItem.type = 'root';
                next.push(newItem);
            } else {
                addToParent(next);
            }

            setUndoStack(prevStack => [{ action: 'Add Row', data: prev, timestamp: Date.now() }, ...prevStack].slice(0, 20));
            setRedoStack([]);
            return next;
        });
    };

    const handleUpdateHierarchyItem = (id: string, field: keyof BudgetItem, value: any) => {
        if (id.startsWith('loose-')) {
            if (field === 'name') {
                const deptId = id.replace('loose-', '');
                setCustomGroupNames(prev => ({ ...prev, [deptId]: value }));
                
                // Save to server immediately if possible
                if (apiClient.isAvailable()) {
                    apiClient.saveBudgetMetadata({
                        uploadDate: uploadDate?.split(' (')[0] || new Date().toLocaleString('ko-KR'),
                        uploader: currentUser.name,
                        recordCount: transactions.length,
                        customEmojis: JSON.stringify(customEmojis),
                        customGroupNames: JSON.stringify({ ...customGroupNames, [deptId]: value })
                    }).catch(err => console.error('Failed to save custom group name', err));
                }
            }
            return;
        }

        setHierarchyData(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            const updateInItems = (items: BudgetItem[]): boolean => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === id) {
                        (items[i] as any)[field] = value;
                        return true;
                    }
                    if (items[i].children && updateInItems(items[i].children!)) return true;
                }
                return false;
            };
            updateInItems(next);
            return next;
        });
    };

    const handleDeleteHierarchyItem = (id: string) => {
        if (!window.confirm('정말 삭제하시겠습니까? 관련 하위 항목도 모두 삭제됩니다.')) return;
        setHierarchyData(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            const deleteFromItems = (items: BudgetItem[]): boolean => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === id) {
                        items.splice(i, 1);
                        return true;
                    }
                    if (items[i].children && deleteFromItems(items[i].children!)) return true;
                }
                return false;
            };
            deleteFromItems(next);
            setUndoStack(prevStack => [{ action: 'Delete Item', data: prev, timestamp: Date.now() }, ...prevStack].slice(0, 20));
            return next;
        });
    };

    const handleUndo = () => {
        if (undoStack.length === 0) return;
        const [last, ...rest] = undoStack;
        setRedoStack(prev => [{ action: last.action, data: hierarchyData, timestamp: Date.now() }, ...prev]);
        setHierarchyData(last.data);
        setUndoStack(rest);
    };

    const handleRedo = () => {
        if (redoStack.length === 0) return;
        const [last, ...rest] = redoStack;
        setUndoStack(prev => [{ action: last.action, data: hierarchyData, timestamp: Date.now() }, ...prev]);
        setHierarchyData(last.data);
        setRedoStack(rest);
    };
    const handleHierarchyDragStart = (e: React.DragEvent, id: string) => {
        if (!isHierarchyEditMode) return;
        e.dataTransfer.setData('text/plain', id);
        setDraggedHierarchyId(id);
        e.dataTransfer.effectAllowed = 'move';
    };

    
    const handleHierarchyDragOver = (e: React.DragEvent, id: string) => {
        e.preventDefault();
        if (draggedHierarchyId && draggedHierarchyId !== id) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = e.clientY - rect.top;
            const threshold = rect.height / 4;

            if (y < threshold) {
                setDragPosition('before');
            } else if (y > rect.height - threshold) {
                setDragPosition('after');
            } else {
                setDragPosition('inside');
            }
            
            setDragOverHierarchyId(id);
        }
    };

    const handleHierarchyDrop = (e: React.DragEvent, targetId: string) => {
        e.preventDefault();
        const currentPosition = dragPosition;
        setDragOverHierarchyId(null);
        setDragPosition(null);
        
        const sourceId = e.dataTransfer.getData('text/plain');
        if (!sourceId || sourceId === targetId) {
            setDraggedHierarchyId(null);
            return;
        }

        setHierarchyData(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            let sourceItem: BudgetItem | null = null;
            let sourceParent: BudgetItem[] | null = null;
            let sourceIndex: number = -1;

            let targetItem: BudgetItem | null = null;
            let targetParent: BudgetItem[] | null = null;
            let targetIndex: number = -1;

            const findAndRemove = (items: BudgetItem[]): boolean => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === sourceId) {
                        sourceItem = items[i];
                        sourceParent = items;
                        sourceIndex = i;
                        return true;
                    }
                    if (items[i].children && findAndRemove(items[i].children)) return true;
                }
                return false;
            };

            const findTarget = (items: BudgetItem[]): boolean => {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].id === targetId) {
                        targetItem = items[i];
                        targetParent = items;
                        targetIndex = i;
                        return true;
                    }
                    if (items[i].children && findTarget(items[i].children)) return true;
                }
                return false;
            };

            // Check for circular reference
            const isDescendant = (parent: BudgetItem, childId: string): boolean => {
                if (!parent.children) return false;
                for (const child of parent.children) {
                    if (child.id === childId) return true;
                    if (isDescendant(child, childId)) return true;
                }
                return false;
            };

            findAndRemove(next);
            
            // Handle loose group targets (Unassigned groups)
            if (targetId.startsWith('loose-')) {
                const deptId = targetId.replace('loose-', '');
                for (const node of next) {
                    if (node.id === deptId) {
                        targetItem = node;
                        targetParent = next;
                        targetIndex = next.indexOf(node);
                        break;
                    }
                }
            } else {
                findTarget(next);
            }

            if (sourceItem && sourceParent && targetItem) {
                if (isDescendant(sourceItem, targetId)) {
                    showToast('자신의 하위 항목으로 이동할 수 없습니다.');
                    return prev;
                }

                // --- Guardrails & Logic Branching ---
                const isSourceL2 = sourceItem.type === 'mok';
                const isSourceL3 = ['semok', 'detail'].includes(sourceItem.type);
                const isTargetL1 = ['root', 'hang'].includes(targetItem.type);
                const isTargetL2 = targetItem.type === 'mok';
                const isTargetL3 = ['semok', 'detail'].includes(targetItem.type);

                // L2 -> L2 Nesting 차단 (강제 reorder)
                let effectivePosition = currentPosition;
                if (isSourceL2 && isTargetL2 && effectivePosition === 'inside') {
                    effectivePosition = 'after'; // L2끼리는 내부 귀속 대신 아래로 이동
                }
                
                // L3 -> L3 Nesting 차단 (강제 reorder)
                if (isSourceL3 && isTargetL3 && effectivePosition === 'inside') {
                    effectivePosition = 'after';
                }

                // Remove from original
                sourceParent.splice(sourceIndex, 1);

                if (effectivePosition === 'inside') {
                    // [Nesting Logic]
                    if (isTargetL1) {
                        // L3 -> L1 이동 시 L2로 승격
                        if (isSourceL3) sourceItem.type = 'mok';
                        if (!targetItem.children) targetItem.children = [];
                        targetItem.children.push(sourceItem);
                        showToast(`'${sourceItem.name}' 항목이 대분류 '${targetItem.name}'의 어미 항목으로 이동되었습니다.`);
                    } else if (isTargetL2) {
                        // L2 -> L2는 이미 reorder로 변환됨. 여기는 L3 -> L2 경우만 해당
                        if (isSourceL2) sourceItem.type = 'semok'; // 만약 로직을 뚫고 들어온다면 강등 (안전장치)
                        if (!targetItem.children) targetItem.children = [];
                        targetItem.children.push(sourceItem);
                        showToast(`'${sourceItem.name}' 항목이 어미 항목 '${targetItem.name}'의 새끼 항목으로 이동되었습니다.`);
                    } else {
                        // 기본 fallback: 순서 변경
                        if (targetParent) targetParent.splice(targetIndex + 1, 0, sourceItem);
                    }
                } else {
                    // [Reordering Logic]
                    const insertIndex = effectivePosition === 'before' ? targetIndex : targetIndex + 1;
                    if (targetParent) {
                        targetParent.splice(insertIndex, 0, sourceItem);
                        
                        // 부모 레벨에 따라 타입 보정
                        // targetParent가 root의 자식들이라면 L2여야 함
                        const isTargetParentRoot = next.some((r: any) => r.children === targetParent);
                        if (isTargetParentRoot && isSourceL3) {
                            sourceItem.type = 'mok';
                        }
                    }
                }

                setUndoStack(ps => [{ action: 'Move Item', data: prev, timestamp: Date.now() }, ...ps].slice(0, 20));
                safeLocalStorage.setItem('budget_hierarchy', JSON.stringify(next));
                
                if (apiClient.isAvailable()) {
                    apiClient.saveBudgetHierarchy(next).catch(err => {
                        console.error('Sync failed:', err);
                        showToast('서버 저장 중 오류가 발생했습니다.');
                    });
                }
            }

            return next;
        });

        setDraggedHierarchyId(null);
    };


    const handleDragStart = (e: React.DragEvent, item: { id: string, department: string, budgetItem: string, order: number }) => {
        setDraggedItem(item);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);

        // Add a class to body for global styling during drag if needed
        document.body.classList.add('dragging-active');
    };

    const handleDragOver = (e: React.DragEvent, id: string) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragOverId !== id) setDragOverId(id);
    };

    const handleDragEnd = () => {
        setDraggedItem(null);
        setDragOverId(null);
        document.body.classList.remove('dragging-active');
    };

    const handleDrop = async (e: React.DragEvent, target: { id: string, department: string, budgetItem: string, order: number }) => {
        e.preventDefault();
        if (!draggedItem || draggedItem.id === target.id) return;

        // Clone current plans
        const newPlans = { ...budgetPlans };

        // Helper to ensure plan exists
        const ensurePlan = (item: { id: string, department: string, budgetItem: string, order: number }) => {
            const key = item.id;
            if (!newPlans[key]) {
                newPlans[key] = {
                    department: item.department,
                    budgetItem: normalizeBudgetItem(item.budgetItem), // Ensure normalized
                    categoryGroup: '미지정',
                    source: '',
                    category1: '',
                    projectName: '',
                    category2: item.budgetItem,
                    budgetAmount: 0,
                    manualEntries: [],
                    order: item.order
                };
            }
            return newPlans[key];
        };

        const sourcePlan = ensurePlan(draggedItem);
        const targetPlan = ensurePlan(target);

        // Reordering Strategy:
        // 1. Get current list from tableData (which effectively represents the current visible order)
        // 2. Remove source item
        // 3. Insert source item at target index
        // 4. Re-assign 'order' to all items based on new index

        const currentList = [...tableData];
        const sourceIndex = currentList.findIndex(item => item.id === draggedItem.id);
        const targetIndex = currentList.findIndex(item => item.id === target.id);

        if (sourceIndex === -1 || targetIndex === -1) return;

        // Remove source
        const [movedItem] = currentList.splice(sourceIndex, 1);

        // Insert at target
        currentList.splice(targetIndex, 0, movedItem);

        // Update orders for ALL items in the list
        currentList.forEach((item, index) => {
            const planKey = item.id;
            if (!newPlans[planKey]) {
                // If plan doesn't exist (should involve ensurePlan logic, but for safety)
                newPlans[planKey] = {
                    department: item.department,
                    budgetItem: normalizeBudgetItem(item.budgetItem),
                    categoryGroup: item.categoryGroup || '미지정',
                    source: item.source || '',
                    category1: item.category1 || '',
                    projectName: item.projectName || '',
                    category2: item.category2 || '',
                    budgetAmount: item.budgetAmount || 0,
                    manualEntries: item.manualEntries || [],
                    order: index
                };
            } else {
                newPlans[planKey] = {
                    ...newPlans[planKey],
                    order: index
                };
            }
        });

        setBudgetPlans(newPlans);
        safeLocalStorage.setItem('budget_plans', JSON.stringify(newPlans));

        // Save to server
        if (apiClient.isAvailable()) {
            try {
                await apiClient.saveBudgetPlans(newPlans);
            } catch (e) {
                console.error('Failed to save budget order to server', e);
            }
        }

        setDraggedItem(null);
        setDragOverId(null);
        document.body.classList.remove('dragging-active');
    };

    const handleSidebarDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsSidebarDragOver(true);
    };

    const handleSidebarDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsSidebarDragOver(false);
    };

    const handleSidebarDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsSidebarDragOver(false);

        // draggedItem is now an object, we use draggedItem.id
        if (!draggedItem) return;
        const itemId = draggedItem.id;

        // itemId is formatted as "Department_BudgetItem"
        // We need to find the corresponding plan and remove it.
        // Note: row.id in tableData is constructed as `${plan.department}_${plan.budgetItem}` or similar unique key.
        // Let's verify how row.id is constructed.
        // Looking at tableData mapping: id: `${department}_${budgetItem}`

        const newPlans = { ...budgetPlans };

        // Add to hidden items
        const newHiddenItems = [...hiddenItems];
        if (!newHiddenItems.includes(itemId)) {
            newHiddenItems.push(itemId);
            setHiddenItems(newHiddenItems);
            safeLocalStorage.setItem('budget_hidden_items', JSON.stringify(newHiddenItems));
        }

        if (newPlans[itemId]) {
            delete newPlans[itemId];
            setBudgetPlans(newPlans);
            safeLocalStorage.setItem('budget_plans', JSON.stringify(newPlans));
            showToast('예산과목이 삭제되었습니다.');
        }

        setDraggedItem(null);
    };

    const handleManualEntrySave = async (entries: ManualEntry[]) => {
        if (!modalState) return;
        // MUST strip placeholders before saving to prevent row bloat and preserve correct count
        const cleanEntries = entries.filter(e => !e.isPlaceholder || (e.amount !== 0 || e.description.trim() !== ''));
        await saveBudgetPlan(modalState.department, modalState.budgetItem, 'manualEntries', cleanEntries);
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsLoading(true);
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            if (jsonData.length < 2) {
                showToast('데이터가 없습니다.');
                return;
            }

            const headers = jsonData[0] as string[];
            const headerMap: Record<string, number> = {};
            headers.forEach((h, i) => {
                if (typeof h === 'string') headerMap[h.trim()] = i;
            });

            const getColIndex = (keywords: string[]) => {
                for (const k of keywords) {
                    if (headerMap[k] !== undefined) return headerMap[k];
                }
                return -1;
            };

            const idx = {
                approvalNo: getColIndex(['품의번호']),
                type: getColIndex(['품의유형']),
                description: getColIndex(['적요', '적요(거래처)']),
                amount: getColIndex(['품의금액', '금액']),
                balance: getColIndex(['품의잔액', '잔액']),
                resolutionLink: getColIndex(['결의연계']),
                projectCode: getColIndex(['사업코드']),
                projectName: getColIndex(['사업명']),
                fundingSource: getColIndex(['자금원천']),
                budgetItem: getColIndex(['예산과목']),
                approvalStatus: getColIndex(['승인', '결재', '승인(결재)']),
                writer: getColIndex(['작성자']),
                department: getColIndex(['부서', '부서명'])
            };

            const newTransactions: BudgetTransaction[] = [];

            for (let i = 1; i < jsonData.length; i++) {
                const row = jsonData[i] as any[];
                if (!row || row.length === 0) continue;

                const approvalNo = String(row[idx.approvalNo] || '').trim();
                if (!approvalNo) continue;

                let dateStr = '';
                if (approvalNo.length >= 8) {
                    const yyyy = approvalNo.substring(0, 4);
                    const mm = approvalNo.substring(4, 6);
                    const dd = approvalNo.substring(6, 8);
                    if (!isNaN(Number(yyyy)) && !isNaN(Number(mm)) && !isNaN(Number(dd))) {
                        dateStr = `${yyyy}-${mm}-${dd}`;
                    }
                }
                const dateObj = dateStr ? new Date(dateStr) : new Date();
                const year = dateObj.getFullYear();
                const month = dateObj.getMonth() + 1;
                const quarter = Math.ceil(month / 3);

                const desc = String(row[idx.description] || '');
                let vendor = desc;
                const match = desc.match(/\(([^)]+)\)/);
                if (match) vendor = match[1];
                else {
                    const split = desc.split('-');
                    if (split.length > 1) vendor = split[0];
                }
                vendor = vendor.replace('(주)', '').trim();

                let dept = String(row[idx.department] || '').trim();
                if (!dept) {
                    const pName = String(row[idx.projectName] || '');
                    const bItem = String(row[idx.budgetItem] || '');
                    if (pName.includes('회복') || bItem.includes('회복')) dept = '회복';
                    else if (pName.includes('증진') || bItem.includes('증진')) dept = '증진';
                    else if (pName.includes('자살') || bItem.includes('자살')) dept = '자살';
                    else if (pName.includes('남부') || bItem.includes('남부')) dept = '남부';
                    else if (pName.includes('아동') || bItem.includes('아동')) dept = '아동청소년';
                    else dept = '공통';
                }

                newTransactions.push({
                    id: `trans_${approvalNo}_${i}`,
                    approvalNo,
                    type: String(row[idx.type] || ''),
                    description: desc,
                    amount: Number(String(row[idx.amount] || '0').replace(/,/g, '')),
                    balance: Number(String(row[idx.balance] || '0').replace(/,/g, '')),
                    resolutionLink: String(row[idx.resolutionLink] || ''),
                    projectCode: String(row[idx.projectCode] || ''),
                    projectName: String(row[idx.projectName] || ''),
                    fundingSource: String(row[idx.fundingSource] || ''),
                    budgetItem: String(row[idx.budgetItem] || ''),
                    approvalStatus: String(row[idx.approvalStatus] || ''),
                    writer: String(row[idx.writer] || ''),
                    date: dateStr,
                    year,
                    month,
                    quarter,
                    vendor,
                    department: dept
                });
            }

            setTransactions(newTransactions);
            const uploadDate = new Date().toLocaleString('ko-KR');
            setUploadDate(`${uploadDate} (업로더: ${currentUser.name})`);

            if (apiClient.isAvailable()) {
                await Promise.all([
                    apiClient.saveBudgetTransactions(newTransactions),
                    apiClient.saveBudgetMetadata({
                        uploadDate: uploadDate,
                        uploader: currentUser.name,
                        recordCount: newTransactions.length
                    })
                ]);
            }

            showToast(`${newTransactions.length}건의 데이터를 불러왔습니다.`);

        } catch (error) {
            console.error('Excel parsing error:', error);
            showToast('파일을 읽는 중 오류가 발생했습니다.');
        } finally {
            setIsLoading(false);
            e.target.value = '';
        }
    };

    const handleSort = (key: keyof BudgetTransaction) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const filteredData = useMemo(() => {
        // Collect all manual entries from budgetPlans
        const manualTrans: BudgetTransaction[] = (Object.values(budgetPlans) as BudgetPlan[]).flatMap((plan: BudgetPlan) =>
            (plan.manualEntries || []).map(entry => ({
                id: entry.id,
                date: entry.date,
                writer: entry.writer,
                amount: entry.amount,
                description: entry.description,
                department: plan.department || '공통',
                budgetItem: plan.budgetItem || '',
                type: '수기입력',
                approvalNo: '',
                balance: 0,
                vendor: '',
                resolutionLink: '',
                projectCode: '',
                projectName: '',
                fundingSource: '',
                approvalStatus: '승인',
                year: Number(entry.date.split('-')[0]) || new Date().getFullYear(),
                month: Number(entry.date.split('-')[1]) || new Date().getMonth() + 1,
                quarter: Math.ceil((Number(entry.date.split('-')[1]) || new Date().getMonth() + 1) / 3)
            }))
        );

        // Decide source data based on active tab
        let allData: BudgetTransaction[] = [];
        if (activeTab === 'history') {
            allData = transactions;
        } else if (activeTab === 'manual') {
            allData = manualTrans;
        } else {
            allData = [...transactions, ...manualTrans];
        }

        let data = allData.filter(t => {
            if (filter.department?.length && !filter.department.includes(t.department)) return false;
            if (filter.startDate && t.date < filter.startDate) return false;
            if (filter.endDate && t.date > filter.endDate) return false;
            if (filter.budgetItem?.length && !filter.budgetItem.includes(normalizeBudgetItem(t.budgetItem))) return false;

            if (historySearch) {
                const searchLower = historySearch.toLowerCase();
                return (
                    (t.description || '').toLowerCase().includes(searchLower) ||
                    (t.budgetItem || '').toLowerCase().includes(searchLower) ||
                    (t.writer || '').toLowerCase().includes(searchLower) ||
                    (t.approvalNo || '').toLowerCase().includes(searchLower)
                );
            }
            return true;
        });
        
        // Default sort by date DESC if no sort is active
        if (!sortConfig.key) {
            data = [...data].sort((a, b) => b.date.localeCompare(a.date));
        }

        if (sortConfig.key) {
            data = [...data].sort((a, b) => {
                const aValue = (a as any)[sortConfig.key!];
                const bValue = (b as any)[sortConfig.key!];
                if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return data;
    }, [transactions, budgetPlans, filter, historySearch, sortConfig, activeTab]);

    const budgetItemOptions = useMemo(() => {
        return Array.from(new Set(transactions.map(t => normalizeBudgetItem(t.budgetItem)))).filter(Boolean).sort();
    }, [transactions]);

    const tableData = useMemo(() => {
        // Filter hierarchyData based on selected team
        const filteredHierarchy = filter.department && filter.department.length > 0
            ? hierarchyData.filter(root =>
                filter.department!.some(team => normalizeDepartmentName(root.name) === normalizeDepartmentName(team))
            )
            : hierarchyData;

        const flatList: any[] = [];

        const processItem = (item: BudgetItem, dept: string, hang: string, level: number): any => {
            const normName = normalizeBudgetItem(item.name);
            const normalizedDept = normalizeDepartmentName(dept);

            // Filter transactions by both item name AND department
            const itemTransactions = transactions.filter(t =>
                normalizeBudgetItem(t.budgetItem) === normName &&
                normalizeDepartmentName(t.department) === normalizedDept
            );

            const originalItemName = item.originalName || item.name;
            const planKey = toBudgetKey(dept, originalItemName);
            const plan = budgetPlans[planKey];
            const manualEntries = plan?.manualEntries || [];

            const getQuarter = (dateStr: string) => {
                if (!dateStr || dateStr.length < 5) return 0;
                const month = Number(dateStr.split('-')[1]);
                if (isNaN(month)) return 0;
                return Math.floor((month - 1) / 3) + 1;
            };

            const manualExec = manualEntries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
            
            const pumiExec = itemTransactions.reduce((sum, t) => sum + t.amount, 0);
            const pumiQ1 = itemTransactions.filter(t => t.quarter === 1).reduce((sum, t) => sum + t.amount, 0);
            const pumiQ2 = itemTransactions.filter(t => t.quarter === 2).reduce((sum, t) => sum + t.amount, 0);
            const pumiQ3 = itemTransactions.filter(t => t.quarter === 3).reduce((sum, t) => sum + t.amount, 0);
            const pumiQ4 = itemTransactions.filter(t => t.quarter === 4).reduce((sum, t) => sum + t.amount, 0);

            let execution = manualExec;
            let q1 = pumiQ1;
            let q2 = pumiQ2;
            let q3 = pumiQ3;
            let q4 = pumiQ4;
            let pumiSum = pumiExec;

            let processedChildren;
            if (item.children && item.children.length > 0) {
                processedChildren = item.children.map((c: BudgetItem) => processItem(c, dept, hang, level + 1));
                execution += processedChildren.reduce((sum: number, c: any) => sum + (c.execution || 0), 0);
                pumiSum += processedChildren.reduce((sum: number, c: any) => sum + (c.pumiSum || 0), 0);
                q1 += processedChildren.reduce((sum: number, c: any) => sum + (c.q1 || 0), 0);
                q2 += processedChildren.reduce((sum: number, c: any) => sum + (c.q2 || 0), 0);
                q3 += processedChildren.reduce((sum: number, c: any) => sum + (c.q3 || 0), 0);
                q4 += processedChildren.reduce((sum: number, c: any) => sum + (c.q4 || 0), 0);
            }

            return {
                ...item,
                key: item.id,
                level,
                dept,
                hang,
                originalName: item.originalName || item.name,
                execution,
                pumiSum,
                q1, q2, q3, q4,
                children: processedChildren,
                manualTotal: manualExec, // For display in leaf nodes if needed
                balance: (item.amount || 0) - manualExec,
                ratio: item.amount > 0 ? (manualExec / item.amount) * 100 : 0
            };
        };

        const getDeepAmount = (item: any): number => {
            if (item.type === 'root' || item.type === 'hang' || item.isFolder) {
                if (item.children && item.children.length > 0) {
                    return item.children.reduce((sum: number, c: any) => sum + getDeepAmount(c), 0);
                }
                return 0;
            }
            let total = item.amount || 0;
            if (item.children && item.children.length > 0) {
                total += item.children.reduce((sum: number, c: any) => sum + getDeepAmount(c), 0);
            }
            return total;
        };

        filteredHierarchy.forEach(deptNode => {
            const groups = (deptNode.children || []).filter(c => c.type === 'hang');

            groups.forEach(group => {
                const groupItems = (group.children || []).filter(c => c.type === 'mok');
                const processedItems = groupItems.map(item => processItem(item, deptNode.name, group.name, 1));

                const groupTotal = processedItems.reduce((sum, item) => sum + getDeepAmount(item), 0);
                const groupExecution = processedItems.reduce((sum, item) => sum + (item.execution || 0), 0);
                const groupPumiSum = processedItems.reduce((sum, item) => sum + (item.pumiSum || 0), 0);
                const groupQ1 = processedItems.reduce((sum, item) => sum + (item.q1 || 0), 0);
                const groupQ2 = processedItems.reduce((sum, item) => sum + (item.q2 || 0), 0);
                const groupQ3 = processedItems.reduce((sum, item) => sum + (item.q3 || 0), 0);
                const groupQ4 = processedItems.reduce((sum, item) => sum + (item.q4 || 0), 0);

                flatList.push({
                    id: group.id,
                    key: `group-${group.id}`,
                    type: 'group-header',
                    name: group.name,
                    dept: deptNode.name,
                    itemCount: groupItems.length,
                    amount: groupTotal,
                    execution: groupExecution,
                    pumiSum: groupPumiSum,
                    q1: groupQ1, q2: groupQ2, q3: groupQ3, q4: groupQ4,
                    level: 0
                });

                // Flatten the tree for display, but only if expanded
                const flatten = (items: any[]) => {
                    items.forEach(item => {
                        flatList.push(item);
                        if (expandedRowKeys.includes(item.id) && item.children && item.children.length > 0) {
                            flatten(item.children);
                        }
                    });
                };
                flatten(processedItems);
            });

            // Handle loose Mok items (those directly under Root)
            const looseMoks = (deptNode.children || []).filter(c => c.type === 'mok');
            const processedLoose = looseMoks.map(item => processItem(item, deptNode.name, '미지정', 1));

            if (looseMoks.length > 0 || (groups.length === 0 && looseMoks.length === 0)) {
                flatList.push({
                    id: `loose-${deptNode.id}`,
                    key: `loose-${deptNode.id}`,
                    type: 'group-header',
                    name: customGroupNames[deptNode.id] ?? '미지정',
                    dept: deptNode.name,
                    itemCount: looseMoks.length,
                    amount: processedLoose.reduce((sum, item) => sum + getDeepAmount(item), 0),
                    execution: processedLoose.reduce((sum, item) => sum + (item.execution || 0), 0),
                    pumiSum: processedLoose.reduce((sum, item) => sum + (item.pumiSum || 0), 0),
                    q1: processedLoose.reduce((sum, item) => sum + (item.q1 || 0), 0),
                    q2: processedLoose.reduce((sum, item) => sum + (item.q2 || 0), 0),
                    q3: processedLoose.reduce((sum, item) => sum + (item.q3 || 0), 0),
                    q4: processedLoose.reduce((sum, item) => sum + (item.q4 || 0), 0),
                    isLoose: true,
                    parentId: deptNode.id,
                    level: 0
                });

                const flatten = (items: any[]) => {
                    items.forEach(item => {
                        flatList.push(item);
                        if (expandedRowKeys.includes(item.id) && item.children && item.children.length > 0) {
                            flatten(item.children);
                        }
                    });
                };
                flatten(processedLoose);
            }
        });

        return flatList;
    }, [hierarchyData, transactions, filter.department, budgetPlans, expandedRowKeys, customGroupNames]);

    // Selection Logic
    const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.checked) {
            setSelectedItems(new Set(tableData.map(row => row.id)));
        } else {
            setSelectedItems(new Set());
        }
    };

    const handleSelectItem = (id: string) => {
        const newSelected = new Set(selectedItems);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedItems(newSelected);
    };

    const selectedSummary = useMemo(() => {
        if (selectedItems.size === 0) return { totalBudget: 0, totalSpent: 0, totalDrafts: 0, balance: 0, ratio: 0 };

        let totalBudget = 0;
        let totalSpent = 0;
        let totalDrafts = 0;

        tableData.forEach(row => {
            if (selectedItems.has(row.id)) {
                totalBudget += (row.amount || 0);
                totalSpent += (row.execution || 0);
                totalDrafts += (row.pumiSum || 0);
            }
        });

        const balance = totalBudget - totalSpent;
        const ratio = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

        return { totalBudget, totalSpent, totalDrafts, balance, ratio };
    }, [selectedItems, tableData]);

    const totalSummary = useMemo(() => {
        let totalBudget = 0;
        let totalSpent = 0;
        let totalDrafts = 0;

        tableData.forEach(row => {
            if (row.level === 0) {
                totalBudget += (row.amount || 0);
                totalSpent += (row.execution || 0);
                totalDrafts += (row.pumiSum || 0);
            }
        });

        const balance = totalBudget - totalSpent;
        const ratio = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

        return { totalBudget, totalSpent, totalDrafts, balance, ratio };
    }, [tableData]);


    // History Logic
    const filteredTotalAmount = useMemo(() => {
        return filteredData.reduce((sum, t) => sum + t.amount, 0);
    }, [filteredData]);

    const handleManualTransactionSave = async (entry: ManualEntry) => {
        const newTransaction: BudgetTransaction = {
            id: `manual_${Date.now()}`,
            approvalNo: `MANUAL-${Date.now()}`, // Temporary ID
            type: '수기입력',
            description: entry.description,
            amount: Number(entry.amount),
            balance: 0,
            resolutionLink: '',
            projectCode: '',
            projectName: '',
            fundingSource: '',
            budgetItem: '', // Optional or allow user to select? For now empty as per request format
            approvalStatus: '완료',
            writer: entry.writer,
            date: entry.date,
            year: new Date(entry.date).getFullYear(),
            month: new Date(entry.date).getMonth() + 1,
            quarter: Math.ceil((new Date(entry.date).getMonth() + 1) / 3),
            vendor: '',
            department: '공통' // Default
        };

        const updatedTransactions = [newTransaction, ...transactions];
        setTransactions(updatedTransactions);

        if (apiClient.isAvailable()) {
            await apiClient.saveBudgetTransactions(updatedTransactions);
        }
        showToast('지출 내역이 추가되었습니다.');
        setTransactionModalOpen(false);
    };

    const savePreset = () => {
        const name = prompt('프리셋 이름을 입력하세요:');
        if (!name) return;
        const newPreset: BudgetPreset = {
            id: `preset_${Date.now()}`,
            name,
            description: '',
            filter: { ...filter },
            creator: currentUser.name,
            createdAt: new Date().toISOString(),
            scope: 'all'
        };
        const updatedPresets = [...presets, newPreset];
        setPresets(updatedPresets);
        safeLocalStorage.setItem('budget_presets', JSON.stringify(updatedPresets));
        showToast('프리셋이 저장되었습니다.');
    };

    const loadPreset = (preset: BudgetPreset) => {
        setFilter(preset.filter);
        showToast(`'${preset.name}' 필터가 적용되었습니다.`);
    };

    return (
        <div className="flex-1 h-full flex flex-col bg-[#f5f5f7] font-sans text-gray-900 overflow-hidden min-h-0">
            {/* Header */}
            <div className="bg-white/80 backdrop-blur-md border-b border-gray-200 p-4 md:p-6 shrink-0 z-10">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 md:mb-6 gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-black text-white rounded-xl flex items-center justify-center shadow-lg shrink-0">
                            <Calculator size={24} strokeWidth={2.5} />
                        </div>
                        <div>
                            <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-black leading-none">
                                예산관리
                            </h1>
                            <p className="text-[10px] md:text-xs font-bold text-gray-400 tracking-widest mt-1 uppercase">
                                {getOrgShortName()} Management
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 md:gap-3 w-full md:w-auto justify-end">
                        <div className="flex flex-col items-end mr-2">
                            {isLoadingData ? (
                                <span className="flex items-center gap-1 text-blue-600 text-xs font-bold">
                                    <span className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-pulse"></span>
                                    Loading...
                                </span>
                            ) : (
                                uploadDate && (
                                    <span className="text-[10px] md:text-xs font-bold text-gray-500 text-right">
                                        Last Update: <span className="text-black">{uploadDate}</span>
                                    </span>
                                )
                            )}
                        </div>

                        {transactions.length > 0 && (
                            <button
                                onClick={async () => {
                                    if (confirm('모든 예산 내역을 초기화하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) {
                                        setTransactions([]);
                                        setUploadDate(null);
                                        if (apiClient.isAvailable()) {
                                            await apiClient.saveBudgetTransactions([]);
                                            await apiClient.saveBudgetMetadata({ uploadDate: '', uploader: '', recordCount: 0 });
                                        }
                                        showToast('초기화되었습니다.');
                                    }
                                }}
                                className="px-3 py-2 md:px-4 md:py-3 bg-red-50 text-red-600 text-[10px] md:text-xs font-bold rounded-lg hover:bg-red-100 transition-all flex items-center gap-1.5"
                            >
                                <Trash2 size={16} />
                                <span className="hidden md:inline">CLEAR</span>
                            </button>
                        )}

                        <label className="group relative overflow-hidden rounded-lg bg-black px-4 py-2 md:px-6 md:py-3 text-white font-bold text-xs md:text-sm transition-all hover:bg-gray-800 hover:shadow-lg cursor-pointer flex items-center gap-2">
                            <Upload size={16} className="md:w-[18px] md:h-[18px]" />
                            <span>UPLOAD</span>
                            <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                            <input
                                type="file"
                                accept=".xlsx, .xls"
                                onChange={handleFileUpload}
                                className="hidden"
                                disabled={isLoading || isLoadingData}
                            />
                        </label>
                    </div>
                </div>

                <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-3">
                    <div className="flex bg-gray-100 p-1 rounded-xl w-full md:w-auto">
                        <button
                            onClick={() => setActiveTab('status')}
                            className={`flex-1 md:flex-none px-4 md:px-6 py-2 md:py-2.5 text-xs md:text-sm font-bold rounded-lg transition-all duration-300 ${activeTab === 'status' ? 'bg-white text-black shadow-md scale-100 md:scale-105' : 'text-gray-500 hover:text-gray-900'}`}
                        >
                            예산 현황
                        </button>
                        <button
                            onClick={() => {
                                setActiveTab('history');
                                // Clear sub-item filter to show all history by default
                                if (filter.budgetItem?.length) {
                                    setFilter(prev => ({ ...prev, budgetItem: [] }));
                                }
                            }}
                            className={`flex-1 md:flex-none px-4 md:px-6 py-2 md:py-2.5 text-xs md:text-sm font-bold rounded-lg transition-all duration-300 ${activeTab === 'history' ? 'bg-white text-black shadow-md scale-100 md:scale-105' : 'text-gray-500 hover:text-gray-900'}`}
                        >
                            품의 내역 <span className="ml-1 opacity-50 text-[10px]">({transactions.length.toLocaleString()})</span>
                        </button>
                        <button
                            onClick={() => {
                                setActiveTab('manual');
                            }}
                            className={`flex-1 md:flex-none px-4 md:px-6 py-2 md:py-2.5 text-xs md:text-sm font-bold rounded-lg transition-all duration-300 ${activeTab === 'manual' ? 'bg-white text-black shadow-md scale-100 md:scale-105' : 'text-gray-500 hover:text-gray-900'}`}
                        >
                            수기 내역 <span className="ml-1 opacity-50 text-[10px]">({(Object.values(budgetPlans) as BudgetPlan[]).reduce((sum, p) => sum + (p.manualEntries?.length || 0), 0)})</span>
                        </button>
                    </div>

                    <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0 no-scrollbar">
                        <div className="flex gap-1">
                            <button
                                onClick={() => setFilter({ ...filter, department: undefined })}
                                className={`px-3 md:px-4 py-1.5 md:py-2 rounded-lg text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all whitespace-nowrap ${!filter.department || filter.department.length === 0 ? 'bg-black text-white' : 'bg-white text-gray-500 hover:bg-gray-100'}`}
                            >
                                ALL
                            </button>
                            {TEAMS.map(team => (
                                <button
                                    key={team}
                                    onClick={() => setFilter({ ...filter, department: [team] })}
                                    className={`px-3 md:px-4 py-1.5 md:py-2 rounded-lg text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all whitespace-nowrap ${filter.department?.includes(team) && filter.department.length === 1 ? 'bg-black text-white' : 'bg-white text-gray-500 hover:bg-gray-100'}`}
                                >
                                    {team}
                                </button>
                            ))}
                            <div className="flex items-center gap-2 bg-white px-3 py-1.5 md:py-2 rounded-lg border border-gray-200">
                                <span className="text-[10px] md:text-xs font-bold text-gray-500 whitespace-nowrap">기간 필터</span>
                                <input
                                    type="date"
                                    value={filter.startDate || ''}
                                    onChange={e => setFilter({ ...filter, startDate: e.target.value })}
                                    className="bg-transparent text-[10px] md:text-xs font-bold text-gray-700 outline-none w-24 md:w-auto"
                                />
                                <span className="text-gray-400">~</span>
                                <input
                                    type="date"
                                    value={filter.endDate || ''}
                                    onChange={e => setFilter({ ...filter, endDate: e.target.value })}
                                    className="bg-transparent text-[10px] md:text-xs font-bold text-gray-700 outline-none w-24 md:w-auto"
                                />
                            </div>

                            {/* Settings Button - Only visible when a specific department is selected AND in Status tab */}
                            {activeTab === 'status' && filter.department && filter.department.length === 1 && (
                                <button
                                    onClick={() => setItemSelectionModal({ isOpen: true, department: filter.department![0] })}
                                    className="p-2 md:p-2.5 rounded-lg bg-white text-gray-400 hover:text-black transition-all hover:bg-gray-50 border border-gray-200"
                                    title="예산 과목 설정"
                                >
                                    <Settings size={18} className="md:w-5 md:h-5" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 flex overflow-hidden p-4 md:p-6 gap-4 md:gap-6 relative">
                    {activeTab === 'status' &&
                        <div className="flex-1 flex flex-col gap-4 overflow-hidden min-h-0">
                            {/* Hierarchy Control Bar */}
                            <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-100 flex items-center justify-between z-20">
                                <div className="flex items-center gap-3">
                                    <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">
                                        <div className={`w-2 h-2 rounded-full ${isHierarchyEditMode ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
                                        <span className="text-xs font-bold text-gray-600">계층 편집 모드</span>
                                        <button
                                            onClick={() => setIsHierarchyEditMode(!isHierarchyEditMode)}
                                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${isHierarchyEditMode ? 'bg-black' : 'bg-gray-200'}`}
                                        >
                                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isHierarchyEditMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
                                        </button>
                                    </div>

                                    {isHierarchyEditMode && (
                                        <>
                                            <div className="h-6 w-[1px] bg-gray-200 mx-1" />
                                            <HButton variant="ghost" onClick={handleUndo} disabled={undoStack.length === 0} title="되돌리기 (Ctrl+Z)">
                                                <RotateCcw size={14} />
                                            </HButton>
                                            <HButton variant="ghost" onClick={handleRedo} disabled={redoStack.length === 0} title="다시실행 (Ctrl+Y)">
                                                <RotateCw size={14} />
                                            </HButton>
                                            <HButton variant="primary" onClick={handleSaveHierarchy} className="ml-2">
                                                <Save size={14} /> 저장
                                            </HButton>
                                            <div className="h-6 w-[1px] bg-gray-200 mx-1" />
                                            <HButton 
                                                variant="ghost" 
                                                onClick={() => setItemSelectionModal({ 
                                                    isOpen: true, 
                                                    department: filter.department?.[0] || '공통' 
                                                })} 
                                                title="품의 내역에서 항목 가져오기"
                                            >
                                                <Settings size={14} />
                                            </HButton>
                                            <div className="h-6 w-[1px] bg-gray-200 mx-1" />
                                            <HButton variant="secondary" onClick={handleAddHierarchyGroup} className="bg-blue-50 text-blue-600 hover:bg-blue-100 border-blue-100">
                                                <Plus size={14} className="mr-1" /> 그룹 추가
                                            </HButton>
                                        </>
                                    )}
                                </div>

                                <div className="flex items-center gap-2">
                                    <HButton variant="secondary" onClick={() => {
                                        const allIds: string[] = [];
                                        const collectIds = (items: BudgetItem[]) => {
                                            items.forEach(item => {
                                                if (item.children && item.children.length > 0) {
                                                    allIds.push(item.id);
                                                    collectIds(item.children);
                                                }
                                            });
                                        };
                                        collectIds(hierarchyData);
                                        setExpandedRowKeys(allIds);
                                    }}>
                                        전체 펼치기
                                    </HButton>
                                    <HButton variant="ghost" onClick={() => setExpandedRowKeys([])}>
                                        전체 접기
                                    </HButton>
                                </div>
                            </div>

                            {/* Summary Cards */}
                            <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex-none z-10 hidden md:block">
                                <div className="flex items-center justify-between gap-4 mb-4 pb-4 border-b border-gray-100">
                                    <div className="flex items-center gap-4">
                                        <h2 className="text-lg font-black text-gray-800 flex items-center gap-2">
                                            <PieChart className="text-black" size={20} />
                                            {filter.department ? (filter.department.length === 1 ? filter.department[0] : '선택 부서') : '전체 예산'} 현황
                                        </h2>
                                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-400">
                                            {tableData.length}개 항목 표시 중
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm">
                                        <span className="text-gray-400 font-bold">잔액 합계:</span>
                                        <span className="font-mono font-bold text-blue-600 text-lg">
                                            {totalSummary.balance.toLocaleString()}
                                        </span>
                                        <span className="text-gray-300 mx-2">|</span>
                                        <span className="text-gray-400 font-bold">집행률:</span>
                                        <span className={`font-mono font-bold ${totalSummary.ratio > 90 ? 'text-red-500' : 'text-green-500'}`}>
                                            {totalSummary.ratio.toFixed(1)}%
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-4 gap-4">
                                    <div className="bg-gray-50 flex flex-col p-4 rounded-xl">
                                        <span className="text-xs font-bold mb-1 text-gray-400">총 예산액</span>
                                        <span className="text-lg font-black font-mono tracking-tight">{totalSummary.totalBudget.toLocaleString()}</span>
                                    </div>
                                    <div className="bg-gray-50 flex flex-col p-4 rounded-xl">
                                        <span className="text-xs font-bold mb-1 text-gray-400">총 지출액</span>
                                        <span className="text-lg font-black font-mono tracking-tight text-red-500">{totalSummary.totalSpent.toLocaleString()}</span>
                                    </div>
                                    <div className="bg-gray-50 flex flex-col p-4 rounded-xl">
                                        <span className="text-xs font-bold mb-1 text-gray-400">잔액</span>
                                        <span className="text-lg font-black font-mono tracking-tight text-blue-600">{totalSummary.balance.toLocaleString()}</span>
                                    </div>
                                    <div className="bg-gray-50 flex flex-col p-4 rounded-xl">
                                        <span className="text-xs font-bold mb-1 text-gray-400">집행률</span>
                                        <div className="flex items-end gap-2">
                                            <span className={`text-lg font-black font-mono tracking-tight ${totalSummary.ratio > 90 ? 'text-red-500' : 'text-green-500'}`}>
                                                {totalSummary.ratio.toFixed(1)}%
                                            </span>
                                            <div className="flex-1 h-2 bg-gray-200 rounded-full mb-1.5 overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full ${totalSummary.ratio > 90 ? 'bg-red-500' : 'bg-green-500'}`}
                                                    style={{ width: `${Math.min(totalSummary.ratio, 100)}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Main Budget Table */}
                            <div className="flex-1 budget-management-wrapper custom-scrollbar min-h-0">
                                <HCard className="flex-1 flex flex-col border-none shadow-sm bg-white overflow-hidden mb-6">
                                    <div className="flex-1 overflow-auto custom-scrollbar" style={{ maxHeight: 'calc(100vh - 450px)' }}>
                                        <table className="w-full text-sm border-collapse min-w-[1000px]">
                                            <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
                                                <tr>
                                                    <th className="px-4 py-3 text-left font-bold text-gray-500 whitespace-nowrap w-[25%]">예산 항목</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-500 whitespace-nowrap w-[12%]">예산액</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-500 whitespace-nowrap w-[12%]">지출액</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-500 whitespace-nowrap w-[12%]">잔액</th>
                                                    <th className="px-4 py-3 text-center font-bold text-gray-500 whitespace-nowrap w-[8%]">집행률</th>
                                                    <th className="px-4 py-3 text-center font-bold text-gray-500 whitespace-nowrap w-[6%]">관리</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-400 text-xs w-[6%]">1Q</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-400 text-xs w-[6%]">2Q</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-400 text-xs w-[6%]">3Q</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-400 text-xs w-[6%]">4Q</th>
                                                    <th className="px-4 py-3 text-right font-bold text-gray-500 whitespace-nowrap w-[7%]">품의 합계</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100">
                                                {isLoadingData ? (
                                                    // Skeleton Loading State
                                                    Array.from({ length: 10 }).map((_, i) => (
                                                        <tr key={`skeleton-${i}`} className="animate-pulse">
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-100 rounded w-3/4" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full" /></td>
                                                            <td className="px-4 py-4 text-center"><div className="h-4 bg-gray-50 rounded w-8 mx-auto" /></td>
                                                            <td className="px-4 py-4 text-center"><div className="h-6 bg-gray-50 rounded w-6 mx-auto" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full opacity-50" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full opacity-50" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full opacity-50" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-50 rounded w-full opacity-50" /></td>
                                                            <td className="px-4 py-4"><div className="h-4 bg-gray-100 rounded w-full" /></td>
                                                        </tr>
                                                    ))
                                                ) : tableData.length > 0 ? (
                                                    tableData.map((row, index) => {
                                                    const isGroup = row.type === 'group-header';
                                                    const hasChildren = row.children && row.children.length > 0;
                                                    const isExpanded = expandedRowKeys.includes(row.id);
                                                    
                                                    // Indentation and colors based on level
                                                    const levelColors = [
                                                        'bg-gray-50/80 font-black text-gray-900 border-l-4 border-l-black', // Level 0 (Group/Hang)
                                                        'bg-white font-bold text-gray-800 border-l-4 border-l-gray-300',    // Level 1 (Mok)
                                                        'bg-white/50 text-gray-600 border-l-4 border-l-gray-200',          // Level 2 (Semok)
                                                        'bg-white/30 text-gray-500 border-l-4 border-l-gray-100'           // Level 3 (Detail)
                                                    ];
                                                    
                                                    const paddingLeft = isGroup ? '1rem' : `${(row.level || 0) * 1.5 + 1}rem`;

                                                    return (
                                                        <tr 
                                                            key={row.key} 
                                                            draggable={isHierarchyEditMode && !isGroup} 
                                                            onDragStart={(e) => handleHierarchyDragStart(e, row.id)} 
                                                            onDragOver={(e) => handleHierarchyDragOver(e, row.id)}
                                                            onDragLeave={() => { setDragOverHierarchyId(null); setDragPosition(null); }}
                                                            onDrop={(e) => handleHierarchyDrop(e, row.id)} 
                                                            className={`
                                                                 ${isGroup ? 'bg-gray-50/50' : 'hover:bg-blue-50/40 cursor-grab active:cursor-grabbing transition-colors'} 
                                                                 ${levelColors[row.level || 0] || ''} 
                                                                 ${draggedHierarchyId === row.id ? 'opacity-30 grayscale' : ''} 
                                                                 ${dragOverHierarchyId === row.id && dragPosition === 'inside' ? 'drag-indicator-inside' : ''}
                                                                 ${dragOverHierarchyId === row.id && dragPosition === 'before' ? 'drag-indicator-before' : ''}
                                                                 ${dragOverHierarchyId === row.id && dragPosition === 'after' ? 'drag-indicator-after' : ''}
                                                                 relative
                                                              `}
                                                        >
                                                            <td className="px-4 py-3" style={{ paddingLeft }}>
                                                                <div className="flex items-center gap-2">
                                                                    {hasChildren || isGroup ? (
                                                                        <button 
                                                                            onClick={() => {
                                                                                setExpandedRowKeys(prev => 
                                                                                    prev.includes(row.id) ? prev.filter(k => k !== row.id) : [...prev, row.id]
                                                                                );
                                                                            }}
                                                                            className="p-0.5 hover:bg-gray-200 rounded transition-colors"
                                                                        >
                                                                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                                        </button>
                                                                    ) : (
                                                                        <div className="w-5" />
                                                                    )}
                                                                    
                                                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                                                        <span 
                                                                            className={`text-base shrink-0 ${isHierarchyEditMode ? 'cursor-pointer hover:scale-125 transition-transform' : ''}`}
                                                                            onClick={(e) => isHierarchyEditMode && handleEmojiClick(e, row.name)}
                                                                        >
                                                                            {getBudgetItemEmoji(row.name, customEmojis)}
                                                                        </span>
                                                                        
                                                                        {isHierarchyEditMode ? (
                                                                            <div className="flex items-center gap-1 flex-1">
                                                                                <BudgetGroupNameInput 
                                                                                    initialValue={row.name}
                                                                                    onSave={(val) => handleUpdateHierarchyItem(row.id, 'name', val)}
                                                                                    placeholder={row.type === 'root' ? '부서명' : '항목명'}
                                                                                />

                                                                                <button onClick={() => handleAddHierarchyRow(row.id, row.type === 'root' ? 'hang' : row.type === 'hang' ? 'mok' : row.type === 'mok' ? 'semok' : 'detail')} className="p-1 text-green-600 hover:bg-green-50 rounded" title="하위 항목 추가">
                                                                                    <Plus size={14} />
                                                                                </button>
                                                                                <button onClick={() => handleDeleteHierarchyItem(row.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="삭제">
                                                                                    <Trash2 size={14} />
                                                                                </button>
                                                                            </div>
                                                                        ) : (
                                                                            <span className="truncate" title={row.name}>{row.name}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-mono font-bold">
                                                                {!isGroup && isHierarchyEditMode ? (
                                                                    <input 
                                                                        type="number" 
                                                                        className="bg-white border border-gray-300 rounded px-1 py-0.5 text-right text-xs w-24"
                                                                        value={row.amount}
                                                                        onChange={(e) => handleUpdateHierarchyItem(row.id, 'amount', Number(e.target.value))}
                                                                    />
                                                                ) : (
                                                                    (row.amount || 0).toLocaleString()
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-mono font-bold text-red-600">
                                                                {(row.execution || 0).toLocaleString()}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-mono font-bold text-blue-600">
                                                                {(row.balance || 0).toLocaleString()}
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${row.ratio > 90 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                                                                    {(row.ratio || 0).toFixed(1)}%
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                {!isGroup && !isHierarchyEditMode && (
                                                                    <button 
                                                                        onClick={() => setModalState({ isOpen: true, department: row.dept, budgetItem: row.originalName })}
                                                                        className="p-1.5 rounded-md text-red-500 hover:bg-red-50 active:scale-95 transition-all shadow-sm border border-red-100 bg-white mx-auto flex items-center justify-center"
                                                                        title="품의내역 작성/수정"
                                                                    >
                                                                        <Edit2 size={14} />
                                                                    </button>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-3 text-right font-mono text-gray-400 text-xs">{(row.q1 || 0).toLocaleString()}</td>
                                                            <td className="px-4 py-3 text-right font-mono text-gray-400 text-xs">{(row.q2 || 0).toLocaleString()}</td>
                                                            <td className="px-4 py-3 text-right font-mono text-gray-400 text-xs">{(row.q3 || 0).toLocaleString()}</td>
                                                            <td className="px-4 py-3 text-right font-mono text-gray-400 text-xs">{(row.q4 || 0).toLocaleString()}</td>
                                                            <td className="px-4 py-3 text-right font-mono font-black text-gray-900 bg-gray-50/30">
                                                                {(row.pumiSum || 0).toLocaleString()}
                                                            </td>
                                                        </tr>
                                                    );
                                                })
                                            ) : (
                                                    <tr>
                                                        <td colSpan={11} className="py-24 text-center">
                                                            <div className="flex flex-col items-center justify-center text-gray-400">
                                                                <Calculator size={48} className="mb-4 opacity-20" />
                                                                <p className="text-xl font-black text-gray-800">조회된 예산 항목이 없습니다.</p>
                                                                <p className="text-sm font-bold mt-2">상단의 부서 필터를 확인하거나 계층 편집 모드에서 항목을 추가해 주세요.</p>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </HCard>
                            </div>
                        </div>
                    }
                    {/* Global Saving Indicator Overlay */}
                    {isSaving && (
                        <div className="fixed top-20 right-8 z-[200] animate-bounce-in">
                            <div className="bg-black/90 backdrop-blur-md text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-white/10">
                                <div className="w-5 h-5 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                                <span className="font-bold tracking-tight">서버에 안전하게 저장 중...</span>
                            </div>
                        </div>
                    )}

                    {(activeTab === 'history' || activeTab === 'manual') &&
                        // History or Manual Tab
                        <div className="flex-1 flex flex-col gap-4 overflow-hidden min-h-0">

                            {/* 1. Real-time Summary Box */}
                            <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 shrink-0">
                                <div className="flex justify-between items-end">
                                    <div>
                                        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-1">💰 실시간 지출 요약</h2>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-3xl font-black text-gray-900 tracking-tighter">
                                                {filteredTotalAmount.toLocaleString()}
                                            </span>
                                            <span className="text-lg font-bold text-gray-500">KRW</span>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">검색 조건</div>
                                        <div className="flex flex-col items-end gap-1">
                                            {historySearch ? (
                                                <span className="bg-black text-white px-2 py-1 rounded text-xs font-bold">
                                                    검색어: "{historySearch}"
                                                </span>
                                            ) : (
                                                <span className="text-gray-400 text-xs font-medium">전체 내역</span>
                                            )}
                                            {filter.department && (
                                                <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded text-xs font-bold">
                                                    부서: {filter.department.join(', ')}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* 2. Action Bar & Table */}
                            <HCard className="flex-1 flex flex-col bg-transparent shadow-none md:bg-white md:shadow-md border-none min-h-0">
                                <div className="p-4 border-b border-gray-100 flex flex-col bg-gray-50 gap-3 md:flex-row md:items-center md:gap-0">
                                    <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3 flex-1 w-full md:w-auto">
                                        {/* Search Input - Full width on mobile */}
                                        <div className="relative w-full md:w-96">
                                            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                            <input
                                                type="text"
                                                value={historySearch}
                                                onChange={(e) => setHistorySearch(e.target.value)}
                                                className="w-full pl-10 pr-4 py-3 md:py-2 bg-white border border-gray-200 rounded-xl md:rounded-lg text-sm font-bold focus:ring-2 focus:ring-black outline-none transition-all shadow-sm"
                                                placeholder="적요, 작성자, 금액 검색..."
                                            />
                                        </div>

                                        {/* Mobile Control Row: Sort Buttons + Add Button */}
                                        <div className="flex justify-between items-center w-full md:w-auto md:ml-2">
                                            {/* Sort Buttons */}
                                            <div className="flex gap-1.5">
                                                <button onClick={() => handleSort('date')} className={`px-3 py-2 md:py-1.5 rounded-lg md:rounded text-xs font-bold transition-colors shadow-sm md:shadow-none border border-gray-100 md:border-transparent ${sortConfig.key === 'date' ? 'bg-black text-white' : 'bg-white text-gray-500 hover:bg-gray-200'}`}>
                                                    날짜순
                                                </button>
                                                <button onClick={() => handleSort('amount')} className={`px-3 py-2 md:py-1.5 rounded-lg md:rounded text-xs font-bold transition-colors shadow-sm md:shadow-none border border-gray-100 md:border-transparent ${sortConfig.key === 'amount' ? 'bg-black text-white' : 'bg-white text-gray-500 hover:bg-gray-200'}`}>
                                                    금액순
                                                </button>
                                            </div>

                                            {/* Mobile Add Button (Visible here only on mobile to sit on same row) */}
                                            <div className="md:hidden">
                                                <HButton onClick={() => setTransactionModalOpen(true)} variant="primary" className="px-4 py-2 rounded-lg text-sm shadow-md">
                                                    <Plus size={16} /> 추가
                                                </HButton>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Desktop Add Button (Hidden on Mobile) */}
                                    <div className="hidden md:flex w-full md:w-auto justify-end">
                                        <HButton onClick={() => setTransactionModalOpen(true)} variant="primary" className="w-full md:w-auto justify-center">
                                            <Plus size={16} /> 추가
                                        </HButton>
                                    </div>
                                </div>

                                {/* Desktop Table */}
                                <div className="hidden md:block flex-1 overflow-y-auto custom-scrollbar bg-white pb-40">
                                    <table className="w-full text-xs text-left whitespace-nowrap border-collapse">
                                        <thead className="bg-gray-50 sticky top-0 z-10 border-b border-gray-200">
                                            <tr>
                                                {[
                                                        { key: 'date', label: '날짜', width: 'w-32' },
                                                        { key: 'writer', label: '작성자', width: 'w-24' },
                                                        { key: 'description', label: '적요 (내용)', width: 'w-auto' },
                                                        { key: 'amount', label: '금액', width: 'w-32 text-right' },
                                                    ].map(col => (
                                                        <th
                                                            key={col.key}
                                                            className={`px-4 py-3 font-bold text-gray-500 cursor-pointer hover:bg-gray-100 transition-colors ${col.width}`}
                                                            onClick={() => handleSort(col.key as keyof BudgetTransaction)}
                                                        >
                                                            <div className={`flex items-center gap-1 ${col.key === 'amount' ? 'justify-end' : ''}`}>
                                                                {col.label}
                                                                {sortConfig.key === col.key && (
                                                                    sortConfig.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                                                                )}
                                                                {sortConfig.key !== col.key && <ArrowUpDown size={12} className="opacity-30" />}
                                                            </div>
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100 bg-white">
                                                {filteredData.map((t) => (
                                                    <tr key={t.id} className="hover:bg-blue-50 transition-colors group">
                                                        <td className="px-4 py-3 font-mono text-gray-600 border-r border-transparent group-hover:border-blue-100">{t.date}</td>
                                                        <td className="px-4 py-3 font-bold text-gray-800 border-r border-transparent group-hover:border-blue-100">
                                                            <div className="flex items-center gap-2">
                                                                <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-black text-gray-500">
                                                                    {t.writer.charAt(0)}
                                                                </div>
                                                                {t.writer}
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-3 text-gray-900 border-r border-transparent group-hover:border-blue-100">
                                                            <span className="font-medium">{t.description}</span>
                                                            {t.department !== '공통' && (
                                                                <span className="ml-2 text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                                                                    {t.department}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3 text-right font-mono font-bold text-black group-hover:text-blue-600">
                                                            {t.amount.toLocaleString()}
                                                        </td>
                                                    </tr>
                                                ))}
                                                {filteredData.length === 0 && (
                                                    <tr>
                                                        <td colSpan={4} className="p-12 text-center">
                                                            <div className="flex flex-col items-center justify-center text-gray-300">
                                                                <Search size={48} className="mb-4 opacity-50" />
                                                                <p className="text-lg font-bold">검색 결과가 없습니다.</p>
                                                                <p className="text-sm">다른 검색어로 시도해보세요.</p>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>

                                {/* Mobile List View */}
                                <div className="md:hidden flex-1 flex flex-col gap-3 pb-60 overflow-y-auto custom-scrollbar">
                                    {filteredData.map((t) => (
                                        <div key={t.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-3">
                                            <div className="flex justify-between items-start border-b border-gray-50 pb-2">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-black text-gray-500">
                                                        {t.writer.charAt(0)}
                                                    </div>
                                                    <div>
                                                        <p className="text-xs font-bold text-gray-900">{t.writer}</p>
                                                        <p className="text-[10px] text-gray-400 font-mono">{t.date}</p>
                                                    </div>
                                                </div>
                                                {t.department !== '공통' && (
                                                    <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded font-bold">
                                                        {t.department}
                                                    </span>
                                                )}
                                            </div>
                                            <div>
                                                <span className="block text-[10px] text-gray-400 font-bold mb-0.5">적요 (내용)</span>
                                                <p className="text-sm font-medium text-gray-800 break-words leading-snug">{t.description}</p>
                                                {/* Category 2 (BudgetItem) Display */}
                                                {t.budgetItem && (
                                                    <div className="mt-2 text-xs">
                                                        <span className="text-[10px] text-gray-400 font-bold mr-1">세목:</span>
                                                        <span className="font-bold text-gray-700 bg-gray-50 px-1.5 py-0.5 rounded">{t.budgetItem}</span>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex justify-between items-center bg-gray-50 p-3 rounded-lg mt-2">
                                                <span className="text-xs font-bold text-gray-500">집행금액</span>
                                                <span className="font-mono font-bold text-lg text-black">{t.amount.toLocaleString()}</span>
                                            </div>
                                        </div>
                                    ))}
                                    {filteredData.length === 0 && (
                                        <div className="text-center py-10 text-gray-400">
                                            <p className="text-sm font-bold">내역이 없습니다.</p>
                                        </div>
                                    )}
                                </div>
                            </HCard>

                            {/* Transaction Modal */}
                            {transactionModalOpen && (
                                <ManualEntryModal
                                    isOpen={transactionModalOpen}
                                    onClose={() => setTransactionModalOpen(false)}
                                    title="지출 내역 추가"
                                    entries={[{ id: 'new', date: new Date().toISOString().split('T')[0], writer: currentUser.name, amount: 0, description: '' }]}
                                    onSave={async (entries) => {
                                        if (entries.length > 0) await handleManualTransactionSave(entries[0]);
                                    }}
                                    currentUser={currentUser}
                                />
                            )}
                        </div>

                    }

                    {/* Manual Entry Modal */}
                    {
                        modalState && (
                            <ManualEntryModal
                                isOpen={modalState.isOpen}
                                onClose={() => setModalState(null)}
                                title={`${modalState.department} - ${modalState.budgetItem}`}
                                entries={
                                    budgetPlans[toBudgetKey(modalState.department, modalState.budgetItem)]?.manualEntries || []
                                }
                                onSave={handleManualEntrySave}
                                currentUser={currentUser}
                            />
                        )
                    }

                    {/* Emoji Edit Modal */}
                    {
                        emojiModal && (
                            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] animate-fade-in">
                                <div className="bg-white rounded-2xl shadow-2xl w-96 overflow-hidden transform transition-all scale-100">
                                    <div className="p-5 bg-black text-white flex justify-between items-center">
                                        <h3 className="font-bold text-lg">이모지 변경</h3>
                                        <button onClick={() => setEmojiModal(null)} className="text-gray-400 hover:text-white transition-colors">
                                            <X size={20} />
                                        </button>
                                    </div>
                                    <div className="p-6">
                                        <p className="text-sm text-gray-500 mb-4 font-bold break-keep">
                                            '{emojiModal.item}'의 이모지를 설정하세요.
                                        </p>
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                defaultValue={emojiModal.currentEmoji}
                                                className="flex-1 bg-gray-100 border-none rounded-lg px-4 py-3 text-2xl text-center focus:ring-2 focus:ring-black outline-none"
                                                id="emojiInput"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        const val = e.currentTarget.value.trim();
                                                        if (val) handleEmojiSave(emojiModal.item, val);
                                                    }
                                                }}
                                                autoFocus
                                            />
                                            <button
                                                onClick={() => {
                                                    const input = document.getElementById('emojiInput') as HTMLInputElement;
                                                    if (input && input.value.trim()) {
                                                        handleEmojiSave(emojiModal.item, input.value.trim());
                                                    }
                                                }}
                                                className="bg-black text-white rounded-lg px-6 py-3 font-bold hover:bg-gray-800 transition-colors whitespace-nowrap"
                                            >
                                                저장
                                            </button>
                                        </div>
                                        <p className="text-xs text-gray-400 mt-4 text-center">
                                            Win + . 키를 눌러 이모지 패널을 여세요.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )
                    }

                    {/* Item Selection Modal */}
                    {
                        itemSelectionModal && (
                            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
                                <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
                                    <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
                                        <div>
                                            <h3 className="text-lg font-black text-gray-900">예산 과목 설정</h3>
                                            <p className="text-xs text-gray-500 font-bold mt-1">
                                                <span className="text-blue-600">[{itemSelectionModal.department}]</span> 부서에서 사용할 예산 과목을 선택하세요.
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => setItemSelectionModal(null)}
                                            className="p-2 -mr-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-full transition-all"
                                        >
                                            <X size={20} />
                                        </button>
                                    </div>

                                    <div className="p-4 border-b border-gray-100 bg-white sticky top-0 z-10">
                                        <div className="relative">
                                            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                            <input
                                                type="text"
                                                placeholder="예산 과목 검색..."
                                                className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm font-bold focus:ring-2 focus:ring-black/5"
                                                onChange={(e) => {
                                                    // Simple local search implementation
                                                    const query = e.target.value.toLowerCase();
                                                    const items = document.querySelectorAll('.budget-item-checkbox');
                                                    items.forEach((item: any) => {
                                                        const label = item.getAttribute('data-label').toLowerCase();
                                                        if (label.includes(query)) {
                                                            item.style.display = 'flex';
                                                        } else {
                                                            item.style.display = 'none';
                                                        }
                                                    });
                                                }}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                            {allBudgetItems.map(item => {
                                                const key = toBudgetKey(itemSelectionModal.department, item);
                                                const isSelected = !!budgetPlans[key];

                                                return (
                                                    <label
                                                        key={item}
                                                        data-label={item}
                                                        className={`budget-item-checkbox flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer select-none group ${isSelected ? 'bg-blue-50 border-blue-200 shadow-sm' : 'bg-white border-gray-100 hover:border-gray-300'}`}
                                                    >
                                                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 group-hover:border-gray-400'}`}>
                                                            {isSelected && <Check size={12} className="text-white" />}
                                                        </div>
                                                        <input
                                                            type="checkbox"
                                                            className="hidden"
                                                            checked={isSelected}
                                                            onChange={(e) => {
                                                                const checked = e.target.checked;
                                                                const normalizedKey = toBudgetKey(itemSelectionModal.department, item);
                                                                if (!normalizedKey) return;
                                                                const [normalizedDepartment, normalizedItem] = normalizedKey.split('_');

                                                                setBudgetPlans((prevPlans) => {
                                                                    const nextPlans = { ...prevPlans };
                                                                    Object.keys(nextPlans).forEach((planKey) => {
                                                                        const plan = nextPlans[planKey];
                                                                        if (!plan) return;
                                                                        if (toBudgetKey(plan.department, plan.budgetItem) === normalizedKey && planKey !== normalizedKey) {
                                                                            delete nextPlans[planKey];
                                                                        }
                                                                    });

                                                                    if (checked) {
                                                                        if (!nextPlans[normalizedKey]) {
                                                                            nextPlans[normalizedKey] = {
                                                                                department: normalizedDepartment,
                                                                                budgetItem: normalizedItem,
                                                                                source: '',
                                                                                category1: '',
                                                                                projectName: '',
                                                                                category2: normalizedItem,
                                                                                categoryGroup: '미지정',
                                                                                budgetAmount: 0,
                                                                                manualEntries: [],
                                                                                order: Object.keys(nextPlans).length
                                                                            };
                                                                        }
                                                                    } else {
                                                                        Object.keys(nextPlans).forEach((planKey) => {
                                                                            const plan = nextPlans[planKey];
                                                                            if (!plan) return;
                                                                            if (toBudgetKey(plan.department, plan.budgetItem) === normalizedKey) {
                                                                                delete nextPlans[planKey];
                                                                            }
                                                                        });
                                                                    }

                                                                    safeLocalStorage.setItem('budget_plans', JSON.stringify(nextPlans));
                                                                    return nextPlans;
                                                                });

                                                                setHiddenItems((prevHiddenItems) => {
                                                                    const withoutCurrent = normalizeHiddenItemKeys(prevHiddenItems).filter((v) => v !== normalizedKey);
                                                                    const nextHiddenItems = checked ? withoutCurrent : [...withoutCurrent, normalizedKey];
                                                                    safeLocalStorage.setItem('budget_hidden_items', JSON.stringify(nextHiddenItems));
                                                                    return nextHiddenItems;
                                                                });
                                                            }}
                                                        />
                                                        <span className={`text-sm font-bold truncate ${isSelected ? 'text-blue-900' : 'text-gray-600'}`}>{item}</span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    <div className="p-5 border-t border-gray-100 bg-white flex justify-end gap-3 rounded-b-2xl">
                                        <button
                                            onClick={() => {
                                                const normalizedPlans = normalizeBudgetPlansMap(budgetPlans);
                                                const normalizedHidden = normalizeHiddenItemKeys(hiddenItems);
                                                setBudgetPlans(normalizedPlans);
                                                setHiddenItems(normalizedHidden);
                                                
                                                // Sync with hierarchy immediately
                                                syncHierarchyWithPlans(normalizedPlans);
                                                
                                                safeLocalStorage.setItem('budget_plans', JSON.stringify(normalizedPlans));
                                                safeLocalStorage.setItem('budget_hidden_items', JSON.stringify(normalizedHidden));
                                                if (apiClient.isAvailable()) {
                                                    apiClient.saveBudgetPlans(normalizedPlans).then(() => {
                                                        showToast('저장되었습니다.');
                                                    }).catch(console.error);
                                                } else {
                                                    showToast('저장되었습니다 (로컬).');
                                                }
                                                setItemSelectionModal(null);
                                            }}
                                            className="px-6 py-2.5 bg-black text-white text-sm font-bold rounded-xl hover:bg-gray-800 transition-all shadow-lg hover:shadow-xl active:scale-95"
                                        >
                                            완료
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )
                    }

                    {/* Trash Drop Zone - Only visible when dragging */}
                    {
                        draggedItem && (
                            <div
                                className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${isSidebarDragOver ? 'scale-110' : 'scale-100'}`}
                                onDragOver={handleSidebarDragOver}
                                onDragLeave={handleSidebarDragLeave}
                                onDrop={handleSidebarDrop}
                            >
                                <div className={`flex flex-col items-center justify-center w-32 h-32 rounded-full shadow-2xl backdrop-blur-md border-4 transition-all ${isSidebarDragOver ? 'bg-red-500/90 border-red-500 text-white' : 'bg-white/80 border-gray-200 text-gray-400'}`}>
                                    <Trash2 size={40} className={isSidebarDragOver ? 'animate-bounce' : ''} />
                                    <span className="text-xs font-black mt-2 uppercase tracking-tight">Drop to Delete</span>
                                </div>
                            </div>
                        )
                    }

                    {/* Emoji Selector Modal */}
                    {emojiModal && (
                        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] backdrop-blur-sm animate-in fade-in duration-200">
                            <div className="bg-white rounded-2xl p-6 w-[360px] shadow-2xl border border-gray-100 animate-in zoom-in-95 duration-200">
                                <div className="flex items-center justify-between mb-6">
                                    <h3 className="text-lg font-black text-gray-800">아이콘 변경</h3>
                                    <button onClick={() => setEmojiModal(null)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                                        <X size={20} className="text-gray-400" />
                                    </button>
                                </div>
                                
                                <div className="mb-6 p-4 bg-gray-50 rounded-xl flex flex-col items-center justify-center border border-dashed border-gray-200">
                                    <div className="text-4xl mb-2">{emojiModal.currentEmoji}</div>
                                    <div className="text-xs font-bold text-gray-400">{emojiModal.item}</div>
                                </div>

                                <div className="grid grid-cols-5 gap-3 mb-6">
                                    {['📁', '💰', '💸', '💵', '🏦', '👷', '👨‍🏫', '🤝', '🛡️', '✏️', '📎', '🖨️', '📚', '📰', '📮', '📞', '🧾', '⚡', '🏠', '🧹', '🛠️', '⛽', '🚗', '🍚', '☕', '🍽️', '🌙', '💧', '🍓', '🍒', '📢', '🎓', '🚆', '🍏'].map(emoji => (
                                        <button
                                            key={emoji}
                                            onClick={() => handleEmojiSave(emojiModal.item, emoji)}
                                            className={`text-2xl p-2 rounded-xl transition-all hover:bg-blue-50 hover:scale-110 active:scale-95 ${emojiModal.currentEmoji === emoji ? 'bg-blue-100 ring-2 ring-blue-500' : 'bg-gray-50'}`}
                                        >
                                            {emoji}
                                        </button>
                                    ))}
                                </div>

                                <div className="flex justify-end">
                                    <HButton variant="ghost" onClick={() => setEmojiModal(null)} className="mr-2">취소</HButton>
                                </div>
                            </div>
                        </div>
                    )}
                </div >
            </div >
        </div >
    );
}

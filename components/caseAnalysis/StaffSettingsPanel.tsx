import React, { useState } from 'react';
import { Users, Plus, X, ChevronDown, ChevronUp, Save } from 'lucide-react';

export interface StaffEntry {
    name: string;
    team: string;
}

export const STAFF_TEAMS = ['증진팀', '회복팀', '자살예방센터', '아동청소년', '남부분소'];

interface StaffSettingsPanelProps {
    systemStaff: StaffEntry[];
    extraStaff: StaffEntry[];
    onExtraStaffChange: (next: StaffEntry[]) => void;
}

/**
 * 직원 설정 메뉴 — 팀 구분 명단 관리
 * - 팀 구분 기준: 직원 설정 추가(최우선) > 시스템 등록 직원 명단(계정 관리) > 팀구별 엑셀(선택사항, 최후순위)
 * - 여기서 추가한 직원은 서버 설정에 저장되어 다음 분석부터 계속 적용된다 (팀구별 엑셀을 매번 올릴 필요 없음)
 * - 상담사 구분 자체는 데이터 파일의 상담자 이름(X열/N열) 기준이며, 명단에 없어도 건수에서 제외되지 않는다
 */
const StaffSettingsPanel: React.FC<StaffSettingsPanelProps> = ({ systemStaff, extraStaff, onExtraStaffChange }) => {
    const [expanded, setExpanded] = useState(false);
    const [newName, setNewName] = useState('');
    const [newTeam, setNewTeam] = useState(STAFF_TEAMS[0]);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const saveExtra = async (next: StaffEntry[]) => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ caseAnalysisExtraStaff: next }),
            });
            if (!res.ok) {
                throw new Error(res.status === 403 ? '관리자만 저장할 수 있습니다.' : '저장에 실패했습니다.');
            }
            onExtraStaffChange(next);
            setMessage('저장되었습니다. 다음 분석부터 적용됩니다.');
        } catch (e: any) {
            setMessage(e?.message || '저장에 실패했습니다.');
        } finally {
            setSaving(false);
        }
    };

    const handleAdd = () => {
        const name = newName.trim();
        if (!name) return;
        if (extraStaff.some(s => s.name === name) || systemStaff.some(s => s.name === name)) {
            setMessage('이미 명단에 있는 이름입니다.');
            return;
        }
        const next = [...extraStaff, { name, team: newTeam }];
        setNewName('');
        saveExtra(next);
    };

    const handleDelete = (name: string) => {
        saveExtra(extraStaff.filter(s => s.name !== name));
    };

    return (
        <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between p-[21px] text-left"
            >
                <span className="flex items-center gap-2">
                    <Users size={18} className="text-indigo-600" />
                    <span className="text-[15px] font-black text-slate-800">직원 설정 — 팀 구분 명단</span>
                    <span className="text-[11px] text-slate-400 font-medium">시스템 {systemStaff.length}명 + 추가 {extraStaff.length}명</span>
                </span>
                {expanded ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
            </button>

            {expanded && (
                <div className="px-[21px] pb-[21px] space-y-4">
                    <p className="text-[12px] text-slate-500 font-medium leading-relaxed">
                        팀 구분은 시스템 등록 직원 명단(계정 관리) + 여기서 추가한 직원 기준입니다.
                        명단에 없는 상담사도 건수에서는 제외되지 않고 부서만 '부서정보없음'으로 표시됩니다.
                        팀구별 엑셀은 더 이상 올리지 않아도 됩니다.
                    </p>

                    {/* 추가 직원 목록 */}
                    <div>
                        <h4 className="text-[13px] font-bold text-slate-700 mb-2">추가한 직원 ({extraStaff.length}명)</h4>
                        {extraStaff.length === 0 ? (
                            <p className="text-[12px] text-slate-400">아직 추가한 직원이 없습니다.</p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {extraStaff.map(s => (
                                    <span key={s.name} className="inline-flex items-center gap-1 px-3 py-1 bg-indigo-50 text-indigo-700 text-[12px] font-bold rounded-full border border-indigo-100">
                                        {s.name} · {s.team}
                                        <button onClick={() => handleDelete(s.name)} disabled={saving} className="ml-1 text-indigo-400 hover:text-indigo-700">
                                            <X size={13} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 추가 폼 */}
                    <div className="flex flex-col sm:flex-row gap-2">
                        <input
                            value={newName}
                            onChange={e => setNewName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
                            placeholder="이름 입력 (예: 홍길동)"
                            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-[13px] font-medium outline-none focus:border-indigo-400"
                        />
                        <select
                            value={newTeam}
                            onChange={e => setNewTeam(e.target.value)}
                            className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] font-medium outline-none focus:border-indigo-400"
                        >
                            {STAFF_TEAMS.map(t => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                        <button
                            onClick={handleAdd}
                            disabled={saving || !newName.trim()}
                            className="inline-flex items-center justify-center gap-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-[13px] font-bold hover:bg-indigo-700 disabled:opacity-40"
                        >
                            <Plus size={15} /> 추가
                        </button>
                    </div>

                    {/* 시스템 등록 직원 명단 (읽기 전용) */}
                    <div>
                        <h4 className="text-[13px] font-bold text-slate-700 mb-2">시스템 등록 직원 명단 ({systemStaff.length}명, 읽기 전용)</h4>
                        {systemStaff.length === 0 ? (
                            <p className="text-[12px] text-slate-400">시스템 직원 명단을 불러오지 못했습니다. 계정 관리에서 직원을 확인하세요.</p>
                        ) : (
                            <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto custom-scrollbar">
                                {systemStaff.map(s => (
                                    <span key={s.name} className="px-3 py-1 bg-slate-50 text-slate-600 text-[12px] font-medium rounded-full border border-slate-100">
                                        {s.name} · {s.team}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {message && (
                        <p className="text-[12px] font-bold text-indigo-600 flex items-center gap-1">
                            <Save size={13} /> {message}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default StaffSettingsPanel;

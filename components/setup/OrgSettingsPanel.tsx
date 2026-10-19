import React, { useState, useEffect } from 'react';
import { apiClient } from '../../services/apiClient';
import { getOrgConfig, refreshOrgConfig, OrgTeam } from '../../services/orgConfig';

interface OrgSettingsPanelProps {
    showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const inputCls = "w-full px-4 py-3 bg-slate-50 rounded-xl font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/20 outline-none text-sm";
const labelCls = "block text-xs font-bold text-slate-400 mb-1 ml-1";

/**
 * 기관 설정 패널 (관리자 전용)
 * - 저장 후 새로고침 시 전체 화면에 반영 (orgConfig 캐시)
 * - teams가 비게 되는 저장은 서버에서 거부됨
 */
const OrgSettingsPanel: React.FC<OrgSettingsPanelProps> = ({ showToast }) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [orgName, setOrgName] = useState('');
    const [orgShortName, setOrgShortName] = useState('');
    const [region, setRegion] = useState('');
    const [teams, setTeams] = useState<OrgTeam[]>([]);
    const [subTeamParent, setSubTeamParent] = useState('');
    const [subTeamsText, setSubTeamsText] = useState('');
    const [regionsText, setRegionsText] = useState('');
    const [pathsText, setPathsText] = useState('');

    useEffect(() => {
        apiClient.getSettings().then((s: any) => {
            setOrgName(s.orgName || '');
            setOrgShortName(s.orgShortName || '');
            setRegion(s.region || '');
            setTeams(s.teams || []);
            setSubTeamParent(s.subTeamParent || '');
            setSubTeamsText((s.subTeams || []).join(', '));
            setRegionsText((s.regions || []).join('\n'));
            setPathsText((s.referralPaths || []).join('\n'));
        }).catch(() => {
            const c = getOrgConfig();
            setOrgName(c.orgName); setOrgShortName(c.orgShortName); setRegion(c.region);
            setTeams(c.teams); setSubTeamParent(c.subTeamParent);
            setSubTeamsText(c.subTeams.join(', '));
            setRegionsText(c.regions.join('\n')); setPathsText(c.referralPaths.join('\n'));
        }).finally(() => setLoading(false));
    }, []);

    const updateTeam = (i: number, key: keyof OrgTeam, val: string) => {
        setTeams(prev => prev.map((t, idx) => idx === i ? { ...t, [key]: val } : t));
    };

    const handleSave = async () => {
        if (teams.length === 0 || teams.some(t => !t.name.trim() || !t.code.trim())) {
            showToast?.('팀 이름과 코드를 모두 입력해 주세요.', 'error');
            return;
        }
        setSaving(true);
        try {
            await apiClient.updateSettings({
                orgName: orgName.trim(),
                orgShortName: orgShortName.trim() || orgName.trim(),
                region: region.trim(),
                teams: teams.map(t => ({ name: t.name.trim(), code: t.code.trim().toUpperCase() })),
                subTeamParent,
                subTeams: subTeamsText.split(',').map(s => s.trim()).filter(Boolean),
                regions: regionsText.split('\n').map(s => s.trim()).filter(Boolean),
                referralPaths: pathsText.split('\n').map(s => s.trim()).filter(Boolean),
            });
            await refreshOrgConfig();
            showToast?.('저장되었습니다. 새로고침 후 전체 화면에 반영됩니다.', 'success');
        } catch (e: any) {
            showToast?.(e.message || '저장 중 오류가 발생했습니다.', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-10 text-center text-slate-400 font-bold">설정 불러오는 중...</div>;

    return (
        <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 md:p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div><label className={labelCls}>기관명</label>
                    <input className={inputCls} value={orgName} onChange={e => setOrgName(e.target.value)} /></div>
                <div><label className={labelCls}>약칭</label>
                    <input className={inputCls} value={orgShortName} onChange={e => setOrgShortName(e.target.value)} /></div>
                <div><label className={labelCls}>지역</label>
                    <input className={inputCls} value={region} onChange={e => setRegion(e.target.value)} /></div>
            </div>

            <div>
                <label className={labelCls}>팀 / 부서 (의뢰번호 코드 포함)</label>
                <div className="space-y-2">
                    {teams.map((t, i) => (
                        <div key={i} className="flex gap-2">
                            <input className={inputCls} value={t.name} onChange={e => updateTeam(i, 'name', e.target.value)} placeholder="팀 이름" />
                            <input className={inputCls + " max-w-[110px] uppercase"} value={t.code} onChange={e => updateTeam(i, 'code', e.target.value)} placeholder="코드" maxLength={4} />
                            <button onClick={() => setTeams(prev => prev.filter((_, idx) => idx !== i))} disabled={teams.length <= 1}
                                className="shrink-0 w-11 rounded-xl bg-red-50 text-red-400 hover:bg-red-100 font-bold disabled:opacity-30">×</button>
                        </div>
                    ))}
                </div>
                <button onClick={() => setTeams(prev => [...prev, { name: '', code: '' }])}
                    className="mt-2 w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-sm font-bold hover:border-blue-300 hover:text-blue-500">+ 팀 추가</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelCls}>세부팀 사용 팀 (선택)</label>
                    <select className={inputCls} value={subTeamParent} onChange={e => setSubTeamParent(e.target.value)}>
                        <option value="">사용 안 함</option>
                        {teams.filter(t => t.name.trim()).map(t => <option key={t.name} value={t.name.trim()}>{t.name.trim()}</option>)}
                    </select></div>
                <div><label className={labelCls}>세부팀 목록 (쉼표 구분)</label>
                    <input className={inputCls} value={subTeamsText} onChange={e => setSubTeamsText(e.target.value)} disabled={!subTeamParent} placeholder="예: 회복, 아청, 자살, 청년" /></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelCls}>지역 목록 (줄바꿈 구분)</label>
                    <textarea className={inputCls + " h-40 resize-none"} value={regionsText} onChange={e => setRegionsText(e.target.value)} /></div>
                <div><label className={labelCls}>의뢰경로 목록 (줄바꿈 구분)</label>
                    <textarea className={inputCls + " h-40 resize-none"} value={pathsText} onChange={e => setPathsText(e.target.value)} /></div>
            </div>

            <div className="flex justify-end">
                <button onClick={handleSave} disabled={saving} className="px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-600/20 disabled:opacity-50">
                    {saving ? '저장 중...' : '기관 설정 저장'}
                </button>
            </div>
            <p className="text-[11px] text-slate-400 font-bold">※ 저장 후 브라우저를 새로고침하면 전체 화면에 반영됩니다. 기존 의뢰 데이터는 변경되지 않습니다.</p>
        </div>
    );
};

export default OrgSettingsPanel;

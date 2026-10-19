import React, { useState } from 'react';
import { apiClient } from '../../services/apiClient';
import { OrgTeam } from '../../services/orgConfig';

interface SetupWizardProps {
    onComplete: () => void;
}

const DEFAULT_TEAMS: OrgTeam[] = [
    { name: '증진팀', code: 'JJ' },
    { name: '회복팀', code: 'HB' },
    { name: '자살예방센터', code: 'JY' },
    { name: '아동청소년', code: 'AC' },
    { name: '남부분소', code: 'NB' },
];

const DEFAULT_REGIONS = ["장호원읍", "부발읍", "신둔면", "백사면", "호법면", "마장면", "대월면", "모가면", "설성면", "율면", "창전동", "증포동", "중리동", "관고동", "기타"];
const DEFAULT_PATHS = ['가족', '경찰서', '소방', '의료기관', '기타', '본인', '읍면동 행정복지센터', '의뢰기관', '정신보건기관', '보건소', '지역사회복지관', '지인', '게이트키퍼'];

const inputCls = "w-full px-4 py-3 bg-slate-100/50 border-none rounded-xl text-slate-800 placeholder-slate-400 focus:ring-2 focus:ring-blue-500/50 focus:bg-white transition-all text-sm font-bold";
const labelCls = "block text-xs font-bold text-slate-600 mb-1.5";
const btnPrimary = "px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all text-sm disabled:opacity-50";
const btnGhost = "px-6 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition-all text-sm";

const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
    const [step, setStep] = useState(0);
    const [orgName, setOrgName] = useState('');
    const [orgShortName, setOrgShortName] = useState('');
    const [region, setRegion] = useState('');
    const [teams, setTeams] = useState<OrgTeam[]>(DEFAULT_TEAMS);
    const [subTeamParent, setSubTeamParent] = useState('');
    const [subTeamsText, setSubTeamsText] = useState('');
    const [regionsText, setRegionsText] = useState(DEFAULT_REGIONS.join('\n'));
    const [pathsText, setPathsText] = useState(DEFAULT_PATHS.join('\n'));
    const [adminId, setAdminId] = useState('admin');
    const [adminPw, setAdminPw] = useState('');
    const [adminPw2, setAdminPw2] = useState('');
    const [adminName, setAdminName] = useState('시스템관리자');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const steps = ['기관 정보', '팀 / 부서', '지역 · 의뢰경로', '관리자 계정'];

    const updateTeam = (i: number, key: keyof OrgTeam, val: string) => {
        setTeams(prev => prev.map((t, idx) => idx === i ? { ...t, [key]: val } : t));
    };
    const addTeam = () => setTeams(prev => [...prev, { name: '', code: '' }]);
    const removeTeam = (i: number) => setTeams(prev => prev.filter((_, idx) => idx !== i));

    const canNext = (): boolean => {
        if (step === 0) return orgName.trim().length > 0;
        if (step === 1) return teams.length > 0 && teams.every(t => t.name.trim() && t.code.trim());
        if (step === 2) return regionsText.trim().length > 0;
        return true;
    };

    const handleFinish = async () => {
        setError('');
        if (!adminId.trim() || adminPw.length < 4) {
            setError('관리자 아이디와 4자 이상의 비밀번호를 입력해 주세요.');
            return;
        }
        if (adminPw !== adminPw2) {
            setError('비밀번호가 일치하지 않습니다.');
            return;
        }
        setLoading(true);
        try {
            await apiClient.completeSetup({
                orgName: orgName.trim(),
                orgShortName: orgShortName.trim() || orgName.trim(),
                region: region.trim(),
                teams: teams.map(t => ({ name: t.name.trim(), code: t.code.trim().toUpperCase() })),
                subTeams: subTeamsText.split(',').map(s => s.trim()).filter(Boolean),
                subTeamParent: subTeamParent || '',
                regions: regionsText.split('\n').map(s => s.trim()).filter(Boolean),
                referralPaths: pathsText.split('\n').map(s => s.trim()).filter(Boolean),
                admin: { username: adminId.trim(), password: adminPw, name: adminName.trim() || '시스템관리자' },
            });
            onComplete();
        } catch (e: any) {
            setError(e.message || '초기 설정 중 오류가 발생했습니다.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center ios-mesh-bg relative overflow-hidden font-sans p-4">
            <div className="w-full max-w-2xl relative z-10">
                <div className="glass rounded-[2rem] shadow-2xl p-8 md:p-10 border border-white/60">
                    <div className="text-center mb-6">
                        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 mb-1">의뢰대장 초기 설정</h1>
                        <p className="text-slate-500 text-sm">기관 정보를 등록하면 바로 사용할 수 있습니다 (최초 1회)</p>
                    </div>

                    {/* 스텝 인디케이터 */}
                    <div className="flex items-center justify-center gap-2 mb-8">
                        {steps.map((s, i) => (
                            <React.Fragment key={s}>
                                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold ${i === step ? 'bg-slate-900 text-white' : i < step ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`}>
                                    <span>{i + 1}</span><span className="hidden sm:inline">{s}</span>
                                </div>
                                {i < steps.length - 1 && <div className="w-4 h-px bg-slate-300" />}
                            </React.Fragment>
                        ))}
                    </div>

                    {error && (
                        <div className="bg-red-50 border border-red-100 text-red-500 text-xs font-bold py-3 px-4 rounded-xl mb-4">{error}</div>
                    )}

                    {step === 0 && (
                        <div className="space-y-4">
                            <div><label className={labelCls}>기관명 *</label>
                                <input className={inputCls} value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="예: ○○시정신건강복지센터" autoFocus /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className={labelCls}>약칭 (화면 표시용)</label>
                                    <input className={inputCls} value={orgShortName} onChange={e => setOrgShortName(e.target.value)} placeholder="예: ○○센터" /></div>
                                <div><label className={labelCls}>지역</label>
                                    <input className={inputCls} value={region} onChange={e => setRegion(e.target.value)} placeholder="예: ○○시" /></div>
                            </div>
                        </div>
                    )}

                    {step === 1 && (
                        <div className="space-y-3">
                            <p className="text-xs text-slate-500 font-bold">의뢰를 분배할 팀/부서와 의뢰번호에 쓰일 코드(영문 2자)를 입력하세요.</p>
                            {teams.map((t, i) => (
                                <div key={i} className="flex gap-2 items-center">
                                    <input className={inputCls} value={t.name} onChange={e => updateTeam(i, 'name', e.target.value)} placeholder="팀 이름" />
                                    <input className={inputCls + " max-w-[110px] uppercase"} value={t.code} onChange={e => updateTeam(i, 'code', e.target.value)} placeholder="코드" maxLength={4} />
                                    <button onClick={() => removeTeam(i)} disabled={teams.length <= 1} className="shrink-0 w-10 h-10 rounded-xl bg-red-50 text-red-400 hover:bg-red-100 font-bold disabled:opacity-30">×</button>
                                </div>
                            ))}
                            <button onClick={addTeam} className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-sm font-bold hover:border-blue-300 hover:text-blue-500">+ 팀 추가</button>
                            <div className="pt-2 border-t border-slate-100">
                                <label className={labelCls}>세부팀 사용 (선택사항)</label>
                                <p className="text-[11px] text-slate-400 font-bold mb-2">예: 분소가 있고 그 아래 세부 분류가 필요한 경우</p>
                                <div className="flex gap-2">
                                    <select value={subTeamParent} onChange={e => setSubTeamParent(e.target.value)} className={inputCls}>
                                        <option value="">사용 안 함</option>
                                        {teams.filter(t => t.name.trim()).map(t => <option key={t.name} value={t.name.trim()}>{t.name.trim()}</option>)}
                                    </select>
                                    <input value={subTeamsText} onChange={e => setSubTeamsText(e.target.value)} placeholder="세부팀 (쉼표 구분)" className={inputCls} disabled={!subTeamParent} />
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div><label className={labelCls}>지역 목록 (줄바꿈으로 구분) *</label>
                                <textarea className={inputCls + " h-48 resize-none"} value={regionsText} onChange={e => setRegionsText(e.target.value)} /></div>
                            <div><label className={labelCls}>의뢰경로 목록 (줄바꿈으로 구분)</label>
                                <textarea className={inputCls + " h-48 resize-none"} value={pathsText} onChange={e => setPathsText(e.target.value)} /></div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-4">
                            <p className="text-xs text-slate-500 font-bold">시스템을 관리할 최초 관리자 계정을 만듭니다.</p>
                            <div><label className={labelCls}>아이디 *</label>
                                <input className={inputCls} value={adminId} onChange={e => setAdminId(e.target.value)} /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className={labelCls}>비밀번호 (4자 이상) *</label>
                                    <input type="password" className={inputCls} value={adminPw} onChange={e => setAdminPw(e.target.value)} /></div>
                                <div><label className={labelCls}>비밀번호 확인 *</label>
                                    <input type="password" className={inputCls} value={adminPw2} onChange={e => setAdminPw2(e.target.value)} /></div>
                            </div>
                            <div><label className={labelCls}>이름</label>
                                <input className={inputCls} value={adminName} onChange={e => setAdminName(e.target.value)} /></div>
                        </div>
                    )}

                    <div className="flex justify-between mt-8">
                        <button onClick={() => { setError(''); setStep(s => s - 1); }} disabled={step === 0} className={btnGhost + " disabled:opacity-30"}>이전</button>
                        {step < steps.length - 1 ? (
                            <button onClick={() => { setError(''); setStep(s => s + 1); }} disabled={!canNext()} className={btnPrimary}>다음</button>
                        ) : (
                            <button onClick={handleFinish} disabled={loading} className={btnPrimary}>{loading ? '설정 중...' : '설정 완료'}</button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SetupWizard;

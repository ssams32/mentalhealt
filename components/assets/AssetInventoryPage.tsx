import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';

/**
 * AssetInventoryPage — Stage 2: 재물조사 (계획·모바일 조사 제출·검토·승인·불일치).
 * 핵심 불변: 조사 제출은 공식 위치(Asset_Locations)를 바꾸지 않는다.
 * 관리자 승인 + 후속 조치 UPDATE_OFFICIAL_LOCATION일 때만 공식 위치가 갱신된다.
 * 조사 제출은 admin·manager 또는 ASSET_AUDIT_ACCESS 플래그 보유자만 가능하며,
 * 플래그 보유자는 이 화면의 제출 외 다른 쓰기에서 서버 403을 받는다.
 */

const RESULT_OPTIONS = ['NORMAL', 'LOCATION_MISMATCH', 'INFO_MISMATCH', 'REPAIR_NEEDED', 'DAMAGED', 'LOST_SUSPECTED', 'QR_DAMAGED', 'QR_MISATTACHED', 'DUPLICATE_SUSPECTED', 'UNVERIFIABLE'];

const AssetInventoryPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const [plans, setPlans] = useState<any[]>([]);
    const [selectedPlan, setSelectedPlan] = useState<any>(null);
    const [rooms, setRooms] = useState<any[]>([]);
    const [planName, setPlanName] = useState('');
    const [planRoomId, setPlanRoomId] = useState('');
    const [submitForm, setSubmitForm] = useState<Record<string, any>>({});
    const [reviewAction, setReviewAction] = useState<Record<string, string>>({});
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const isAdmin = currentUser.role === 'admin';

    const loadPlans = useCallback(async () => {
        const res = await fetch('/api/assets-v2/inventory-plans', { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        setPlans(json.data || []);
    }, []);

    const loadRooms = useCallback(async () => {
        const res = await fetch('/api/assets-v2/spaces?kind=room', { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        setRooms(json.data || []);
    }, []);

    useEffect(() => { loadPlans(); loadRooms(); }, [loadPlans, loadRooms]);

    async function callApi(url: string, method: string, body?: any) {
        setError(''); setMessage('');
        const res = await fetch(url, {
            method, credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
        return json;
    }

    const refreshPlan = async (id: string) => {
        const json = await callApi(`/api/assets-v2/inventory-plans/${id}`, 'GET');
        setSelectedPlan(json.data);
        loadPlans();
    };

    const handleCreatePlan = async () => {
        try {
            const json = await callApi('/api/assets-v2/inventory-plans', 'POST', { name: planName, roomId: planRoomId || undefined });
            setMessage('조사 계획 초안이 생성되었습니다. 시작하면 대상 스냅샷이 고정됩니다.');
            setPlanName(''); setPlanRoomId('');
            loadPlans();
            setSelectedPlan(json.data);
        } catch (e: any) { setError(e.message); }
    };

    const handleSubmit = async (target: any) => {
        const f = submitForm[target.assetId] || {};
        try {
            await callApi('/api/assets-v2/inventory-checks', 'POST', {
                planId: selectedPlan.id,
                assetId: target.assetId,
                isLocationMatched: f.isLocationMatched !== false,
                resultStatus: f.resultStatus || 'NORMAL',
                actualRoomId: f.actualRoomId || undefined,
                memo: f.memo || undefined,
                isQrScanned: Boolean(f.isQrScanned),
            });
            setMessage('조사 제출 완료. 공식 위치는 바뀌지 않았습니다 (승인 시에만 갱신).');
            refreshPlan(selectedPlan.id);
        } catch (e: any) { setError(e.message); }
    };

    const handleReview = async (check: any, decision: string) => {
        try {
            await callApi(`/api/assets-v2/inventory-checks/${check.id}/review`, 'POST', {
                decision,
                followUpAction: reviewAction[check.id] || 'NONE',
            });
            setMessage(`검토 완료 (${decision}).`);
            refreshPlan(selectedPlan.id);
        } catch (e: any) { setError(e.message); }
    };

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div>
                <h2 className="font-bold text-slate-900">재물조사</h2>
                <p className="text-sm text-slate-500 mt-1">계획 생성 → 시작(대상 스냅샷 고정) → 조사 제출(공식 위치 불변) → 검토·승인(승인+위치갱신 시에만 공식 위치 변경) 순서입니다.</p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {message && <p className="text-sm text-green-700">{message}</p>}
            {isAdmin && (
                <div className="flex flex-wrap gap-2 items-end">
                    <label className="text-sm text-slate-700">계획명
                        <input value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="예: TEST 재물조사" className="mt-1 block px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                    </label>
                    <label className="text-sm text-slate-700">대상 사무실 (비우면 전체)
                        <select value={planRoomId} onChange={(e) => setPlanRoomId(e.target.value)} className="mt-1 block px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                            <option value="">전체</option>
                            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </label>
                    <button onClick={handleCreatePlan} disabled={!planName.trim()} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold disabled:opacity-50">계획 생성</button>
                </div>
            )}
            <label className="text-sm text-slate-700">계획 선택
                <select value={selectedPlan?.id || ''} onChange={(e) => refreshPlan(e.target.value)} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                    <option value="">선택</option>
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.status}, {p.targetCount ?? 0}건, {p.progress ?? 0}%)</option>)}
                </select>
            </label>
            {selectedPlan && (
                <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                        {isAdmin && selectedPlan.status === 'DRAFT' && (
                            <button onClick={async () => { try { await callApi(`/api/assets-v2/inventory-plans/${selectedPlan.id}/start`, 'POST', {}); setMessage('조사 시작: 대상 스냅샷이 고정되었습니다.'); refreshPlan(selectedPlan.id); } catch (e: any) { setError(e.message); } }} className="px-3 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">조사 시작 (스냅샷 고정)</button>
                        )}
                        {isAdmin && selectedPlan.status === 'IN_PROGRESS' && (
                            <button onClick={async () => { try { await callApi(`/api/assets-v2/inventory-plans/${selectedPlan.id}/complete`, 'POST', {}); setMessage('조사 계획 완료.'); refreshPlan(selectedPlan.id); } catch (e: any) { setError(e.message); } }} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">계획 완료</button>
                        )}
                        <span className="text-sm text-slate-600 self-center">진행률 {selectedPlan.progress ?? 0}% · 대상 {(selectedPlan.targets || []).length}건</span>
                    </div>
                    {(selectedPlan.targets || []).length === 0
                        ? <p className="text-sm text-slate-500">조사 대상이 없습니다. 계획을 시작한 뒤 대상이 표시됩니다.</p>
                        : (selectedPlan.targets || []).map((t: any) => {
                            const f = submitForm[t.assetId] || {};
                            const setF = (patch: any) => setSubmitForm({ ...submitForm, [t.assetId]: { ...f, ...patch } });
                            return (
                                <div key={t.id} className="border border-slate-200 rounded-xl p-3 space-y-2">
                                    <div className="text-sm font-semibold text-slate-900">
                                        {t.asset?.name || t.assetId} <span className="font-mono text-xs text-slate-500 ml-1">{t.asset?.assetNumber || ''}</span>
                                        <span className="ml-2 text-xs font-normal text-slate-500">대상 상태: {t.status} · 등록 위치 사무실: {t.registeredLocation?.roomId ? (rooms.find((r) => r.id === t.registeredLocation.roomId)?.name || t.registeredLocation.roomId) : '-'}</span>
                                    </div>
                                    {t.check && (
                                        <div className="text-sm text-slate-600">
                                            제출: 위치일치 {t.check.isLocationMatched ? '예' : '아니오'} · 결과 {t.check.resultStatus} · 승인 {t.check.approvalStatus} · 처리 {t.check.processStatus}
                                            {t.check.actualRoomId && <span> · 실제 사무실: {rooms.find((r) => r.id === t.check.actualRoomId)?.name || t.check.actualRoomId}</span>}
                                            {isAdmin && t.check.approvalStatus === 'PENDING' && (
                                                <span className="ml-2 inline-flex gap-1 items-center">
                                                    <select value={reviewAction[t.check.id] || 'NONE'} onChange={(e) => setReviewAction({ ...reviewAction, [t.check.id]: e.target.value })} className="px-2 py-1 border border-slate-300 rounded-lg text-xs bg-white">
                                                        {['NONE', 'UPDATE_OFFICIAL_LOCATION', 'RESTORE_ORIGINAL_LOCATION', 'REQUEST_REPAIR', 'MARK_LOST_SUSPECT', 'REISSUE_QR'].map((a) => <option key={a} value={a}>{a}</option>)}
                                                    </select>
                                                    <button onClick={() => handleReview(t.check, 'APPROVE')} className="px-2 py-1 rounded-lg bg-green-600 text-white text-xs font-semibold">승인</button>
                                                    <button onClick={() => handleReview(t.check, 'REJECT')} className="px-2 py-1 rounded-lg bg-red-600 text-white text-xs font-semibold">반려</button>
                                                    <button onClick={() => handleReview(t.check, 'RECHECK_REQUESTED')} className="px-2 py-1 rounded-lg bg-slate-200 text-slate-700 text-xs font-semibold">재조사 요청</button>
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    {selectedPlan.status === 'IN_PROGRESS' && (!t.check || t.check.processStatus === 'RECHECK_REQUESTED') && (
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                                            <label>위치 일치
                                                <select value={f.isLocationMatched === false ? 'false' : 'true'} onChange={(e) => setF({ isLocationMatched: e.target.value === 'true' })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg bg-white">
                                                    <option value="true">일치</option><option value="false">불일치</option>
                                                </select>
                                            </label>
                                            <label>조사 결과
                                                <select value={f.resultStatus || 'NORMAL'} onChange={(e) => setF({ resultStatus: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg bg-white">
                                                    {RESULT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                                </select>
                                            </label>
                                            <label>실제 사무실
                                                <select value={f.actualRoomId || ''} onChange={(e) => setF({ actualRoomId: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg bg-white">
                                                    <option value="">선택 안 함</option>
                                                    {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                                </select>
                                            </label>
                                            <label>메모
                                                <input value={f.memo || ''} onChange={(e) => setF({ memo: e.target.value })} placeholder="불일치·오부착 시 2자 이상" className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" />
                                            </label>
                                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(f.isQrScanned)} onChange={(e) => setF({ isQrScanned: e.target.checked })} /> QR 스캔함</label>
                                            <button onClick={() => handleSubmit(t)} className="px-3 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">조사 제출</button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                </div>
            )}
        </div>
    );
};

export default AssetInventoryPage;

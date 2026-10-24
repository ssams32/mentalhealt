import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';

/**
 * AssetFloorPlanEditor — Stage 2: 배치도 편집 (초안 저장·게시·복원).
 * 게시 시 서버가 겹침·이탈·가구 중복을 검증해 400으로 차단한다.
 * 초안 저장 시에는 겹침이 있어도 저장되며, 게시 단계에서만 차단된다.
 * 복원은 아카이브 버전을 복사한 새 초안을 만들며, 과거 게시본을 직접 덮지 않는다.
 */

interface SpaceItem { id: string; kind: string; name: string; code: string; }

const AssetFloorPlanEditor: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const [rooms, setRooms] = useState<SpaceItem[]>([]);
    const [plans, setPlans] = useState<any[]>([]);
    const [selectedPlan, setSelectedPlan] = useState<any>(null);
    const [roomId, setRoomId] = useState('');
    const [planName, setPlanName] = useState('');
    const [objForm, setObjForm] = useState({ label: '', objectType: 'FURNITURE', coordX: '0', coordY: '0', widthCells: '2', depthCells: '1', rotationDeg: '0' });
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');

    const isAdmin = currentUser.role === 'admin';

    const loadAll = useCallback(async () => {
        const [rRes, pRes] = await Promise.all([
            fetch('/api/assets-v2/spaces?kind=room', { credentials: 'include' }),
            fetch('/api/assets-v2/floor-plans', { credentials: 'include' }),
        ]);
        const rJson = await rRes.json().catch(() => ({}));
        const pJson = await pRes.json().catch(() => ({}));
        setRooms(rJson.data || []);
        setPlans(pJson.data || []);
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    const draftVersion = selectedPlan?.versions?.find((v: any) => v.status === 'DRAFT') || null;
    const draftObjects: any[] = draftVersion?.objects || [];

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

    const handleCreatePlan = async () => {
        try {
            const json = await callApi('/api/assets-v2/floor-plans', 'POST', { roomId, name: planName || undefined });
            setMessage('배치도 초안(v1)이 생성되었습니다.');
            setSelectedPlan(json.data);
            loadAll();
        } catch (e: any) { setError(e.message); }
    };

    const handleAddObject = async () => {
        if (!selectedPlan || !draftVersion) { setError('먼저 배치도를 선택하세요 (초안이 있어야 합니다).'); return; }
        try {
            const nextObjects = [...draftObjects.map((o: any) => ({ ...o })), {
                label: objForm.label || objForm.objectType,
                objectType: objForm.objectType,
                coordX: Number(objForm.coordX), coordY: Number(objForm.coordY),
                widthCells: Number(objForm.widthCells), depthCells: Number(objForm.depthCells),
                zLayer: 0, rotationDeg: Number(objForm.rotationDeg),
            }];
            const json = await callApi(`/api/assets-v2/floor-plans/${selectedPlan.id}/draft`, 'PUT', { objects: nextObjects });
            setSelectedPlan(json.data);
            setMessage('초안에 객체가 추가되었습니다. 게시 시 겹침·이탈 검사가 적용됩니다.');
        } catch (e: any) { setError(e.message); }
    };

    const handlePublish = async () => {
        if (!selectedPlan) return;
        try {
            const json = await callApi(`/api/assets-v2/floor-plans/${selectedPlan.id}/publish`, 'POST', {});
            setMessage(`게시 완료 (게시본 ${json.data.publishedVersionId ? '갱신' : ''}). 이전 게시본은 아카이브되었습니다.`);
            const detail = await callApi(`/api/assets-v2/floor-plans/${selectedPlan.id}`, 'GET');
            setSelectedPlan(detail.data);
            loadAll();
        } catch (e: any) { setError(e.message); }
    };

    const handleRestore = async (versionId: string) => {
        if (!selectedPlan) return;
        try {
            const json = await callApi(`/api/assets-v2/floor-plans/${selectedPlan.id}/restore`, 'POST', { versionId });
            setMessage(`복원 완료: 아카이브 복사본 초안 v${json.data.versions?.find((v: any) => v.status === 'DRAFT')?.versionNumber}이 생성되었습니다.`);
            setSelectedPlan(json.data);
            loadAll();
        } catch (e: any) { setError(e.message); }
    };

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div>
                <h2 className="font-bold text-slate-900">배치도 편집</h2>
                <p className="text-sm text-slate-500 mt-1">초안(DRAFT) → 게시(PUBLISHED) → 이전 게시본 아카이브(ARCHIVED) → 복원은 아카이브 복사본 초안으로 되돌립니다.</p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {message && <p className="text-sm text-green-700">{message}</p>}
            {isAdmin && (
                <div className="flex flex-wrap gap-2 items-end">
                    <label className="text-sm text-slate-700">사무실
                        <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className="mt-1 block px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                            <option value="">선택</option>
                            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
                        </select>
                    </label>
                    <label className="text-sm text-slate-700">배치도명
                        <input value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="예: TEST 사무실 배치도" className="mt-1 block px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                    </label>
                    <button onClick={handleCreatePlan} disabled={!roomId} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold disabled:opacity-50">배치도 생성</button>
                </div>
            )}
            <label className="text-sm text-slate-700">배치도 선택
                <select value={selectedPlan?.id || ''} onChange={(e) => setSelectedPlan(plans.find((p) => p.id === e.target.value) || null)} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                    <option value="">선택</option>
                    {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.roomName || p.roomId})</option>)}
                </select>
            </label>
            {selectedPlan && (
                <div className="space-y-3">
                    <div className="text-sm text-slate-600">
                        버전: {selectedPlan.versions?.map((v: any) => `v${v.versionNumber}(${v.status})`).join(' · ') || '-'}
                    </div>
                    {isAdmin && draftVersion && (
                        <div className="border border-slate-200 rounded-xl p-3 space-y-2">
                            <h3 className="font-semibold text-sm text-slate-900">초안 객체 추가 (v{draftVersion.versionNumber})</h3>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                                <label>표시명<input value={objForm.label} onChange={(e) => setObjForm({ ...objForm, label: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" /></label>
                                <label>종류
                                    <select value={objForm.objectType} onChange={(e) => setObjForm({ ...objForm, objectType: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg bg-white">
                                        {['FURNITURE', 'STANDALONE_ASSET', 'ZONE_BOUNDARY', 'STRUCTURE_WALL', 'STRUCTURE_DOOR'].map((t) => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </label>
                                <label>X<input value={objForm.coordX} onChange={(e) => setObjForm({ ...objForm, coordX: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" /></label>
                                <label>Y<input value={objForm.coordY} onChange={(e) => setObjForm({ ...objForm, coordY: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" /></label>
                                <label>가로(셀)<input value={objForm.widthCells} onChange={(e) => setObjForm({ ...objForm, widthCells: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" /></label>
                                <label>세로(셀)<input value={objForm.depthCells} onChange={(e) => setObjForm({ ...objForm, depthCells: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg" /></label>
                                <label>회전
                                    <select value={objForm.rotationDeg} onChange={(e) => setObjForm({ ...objForm, rotationDeg: e.target.value })} className="mt-1 w-full px-2 py-1 border border-slate-300 rounded-lg bg-white">
                                        {['0', '90', '180', '270'].map((t) => <option key={t} value={t}>{t}°</option>)}
                                    </select>
                                </label>
                            </div>
                            <button onClick={handleAddObject} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">초안에 추가</button>
                            <button onClick={handlePublish} className="ml-2 px-3 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">초안 게시 (겹침·이탈 시 차단)</button>
                        </div>
                    )}
                    <div>
                        <h3 className="font-semibold text-sm text-slate-900">초안 객체 목록 ({draftObjects.length}건)</h3>
                        {draftObjects.length === 0 ? <p className="text-sm text-slate-500">초안 객체가 없습니다.</p> : (
                            <ul className="text-sm mt-1 space-y-1">
                                {draftObjects.map((o: any) => <li key={o.id} className="border border-slate-100 rounded-lg px-3 py-2">{o.label || o.objectType} · {o.objectType} · ({o.coordX}, {o.coordY}) {o.widthCells}×{o.depthCells} · {o.rotationDeg}°</li>)}
                            </ul>
                        )}
                    </div>
                    <div>
                        <h3 className="font-semibold text-sm text-slate-900">아카이브 버전 복원</h3>
                        {(selectedPlan.versions || []).filter((v: any) => v.status === 'ARCHIVED').length === 0
                            ? <p className="text-sm text-slate-500">복원할 아카이브 버전이 없습니다.</p>
                            : (selectedPlan.versions || []).filter((v: any) => v.status === 'ARCHIVED').map((v: any) => (
                                <button key={v.id} onClick={() => handleRestore(v.id)} disabled={!isAdmin} className="mr-2 mt-1 px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm disabled:opacity-50">v{v.versionNumber} 복원 → 새 초안</button>
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AssetFloorPlanEditor;

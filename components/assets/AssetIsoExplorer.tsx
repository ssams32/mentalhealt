import React, { useState, useEffect, useCallback } from 'react';
import AssetIsoCanvas, { IsoObject } from './AssetIsoCanvas';

/**
 * AssetIsoExplorer — Stage 2: 2.5D 탐색 + 목록형 대체 화면.
 * 사무실을 고르면 게시된 배치도(PUBLISHED) 버전을 2.5D 캔버스로 보여주고,
 * 같은 내용을 목록 테이블로도 함께 보여준다 (캔버스 클릭이 유일한 선택 수단이 아님).
 * 게시본이 없으면 해당 사무실의 자산 목록만 표시한다.
 */

interface SpaceItem { id: string; kind: string; name: string; code: string; gridWidth?: number | null; gridDepth?: number | null; }
interface AssetItem { id: string; assetNumber: string; name: string; location?: { roomId?: string | null } | null; roomName?: string | null; }

const AssetIsoExplorer: React.FC = () => {
    const [rooms, setRooms] = useState<SpaceItem[]>([]);
    const [roomId, setRoomId] = useState('');
    const [published, setPublished] = useState<any>(null);
    const [planName, setPlanName] = useState('');
    const [assets, setAssets] = useState<AssetItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    const loadRooms = useCallback(async () => {
        const res = await fetch('/api/assets-v2/spaces?kind=room', { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        setRooms(json.data || []);
    }, []);

    const loadRoom = useCallback(async (id: string) => {
        setError(''); setNotice(''); setSelectedId(null); setPublished(null); setPlanName('');
        try {
            const [pRes, aRes] = await Promise.all([
                fetch('/api/assets-v2/floor-plans?roomId=' + encodeURIComponent(id), { credentials: 'include' }),
                fetch('/api/assets-v2/assets', { credentials: 'include' }),
            ]);
            const pJson = await pRes.json().catch(() => ({}));
            const aJson = await aRes.json().catch(() => ({}));
            const plans = pJson.data || [];
            const roomAssets = (aJson.data || []).filter((a: AssetItem) => a.location && a.location.roomId === id);
            setAssets(roomAssets);
            if (plans.length > 0 && plans[0].publishedVersionId) {
                const pubRes = await fetch(`/api/assets-v2/floor-plans/${plans[0].id}/published`, { credentials: 'include' });
                const pubJson = await pubRes.json().catch(() => ({}));
                if (pubRes.ok) { setPublished(pubJson.data); setPlanName(plans[0].name); }
                else setNotice('게시된 배치도가 없습니다. 아래 목록으로 사무실 자산을 확인하세요.');
            } else {
                setNotice('게시된 배치도가 없습니다. 아래 목록으로 사무실 자산을 확인하세요.');
            }
        } catch (e: any) {
            setError(e.message || '탐색 정보를 불러오지 못했습니다.');
        }
    }, []);

    useEffect(() => { loadRooms(); }, [loadRooms]);

    const isoObjects: IsoObject[] = (published?.objects || []).map((o: any) => ({
        id: o.id,
        label: o.label || o.objectType || '객체',
        coordX: o.coordX, coordY: o.coordY,
        widthCells: o.widthCells, depthCells: o.depthCells,
        zLayer: o.zLayer || 0, rotationDeg: o.rotationDeg || 0,
        color: o.colorHex || undefined,
    }));

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div>
                <h2 className="font-bold text-slate-900">2.5D 탐색</h2>
                <p className="text-sm text-slate-500 mt-1">게시된 배치도를 2.5D로 보고, 아래 목록에서도 같은 객체를 선택할 수 있습니다.</p>
            </div>
            <label className="text-sm text-slate-700">사무실
                <select value={roomId} onChange={(e) => { setRoomId(e.target.value); if (e.target.value) loadRoom(e.target.value); }} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                    <option value="">사무실을 선택하세요</option>
                    {rooms.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
                </select>
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {notice && <p className="text-sm text-slate-500">{notice}</p>}
            {published && (
                <div>
                    <p className="text-sm text-slate-600 mb-2">{planName} · 게시본 v{published.versionNumber} · 격자 {published.gridWidth}×{published.gridDepth}</p>
                    <div className="overflow-x-auto">
                        <AssetIsoCanvas
                            gridWidth={published.gridWidth} gridDepth={published.gridDepth}
                            objects={isoObjects} selectedId={selectedId} onSelect={setSelectedId}
                        />
                    </div>
                    <p className="text-xs text-slate-400 mt-2">목록형 대체 화면 (캔버스와 동일 내용)</p>
                    <table className="w-full text-sm mt-1">
                        <thead className="bg-slate-50 text-slate-500">
                            <tr><th className="text-left px-3 py-2 font-medium">객체</th><th className="text-left px-3 py-2 font-medium">종류</th><th className="text-left px-3 py-2 font-medium">위치(격자)</th><th className="text-left px-3 py-2 font-medium">크기</th></tr>
                        </thead>
                        <tbody>
                            {isoObjects.map((o) => (
                                <tr key={o.id} onClick={() => setSelectedId(o.id)} className={`border-t border-slate-100 cursor-pointer ${selectedId === o.id ? 'bg-orange-50' : ''}`}>
                                    <td className="px-3 py-2">{o.label}</td>
                                    <td className="px-3 py-2 text-slate-600">{(published.objects || []).find((x: any) => x.id === o.id)?.objectType || '-'}</td>
                                    <td className="px-3 py-2 text-slate-600">({o.coordX}, {o.coordY})</td>
                                    <td className="px-3 py-2 text-slate-600">{o.widthCells}×{o.depthCells}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {roomId && (
                <div>
                    <h3 className="font-semibold text-slate-900 text-sm mt-2">이 사무실의 자산 ({assets.length}건)</h3>
                    {assets.length === 0 ? <p className="text-sm text-slate-500 mt-1">등록된 자산이 없습니다.</p> : (
                        <ul className="mt-2 space-y-1 text-sm">
                            {assets.map((a) => <li key={a.id} className="border border-slate-100 rounded-lg px-3 py-2"><span className="font-mono text-xs text-slate-500 mr-2">{a.assetNumber}</span>{a.name}</li>)}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default AssetIsoExplorer;

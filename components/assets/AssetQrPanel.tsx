import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';

/**
 * AssetQrPanel — Stage 2: QR 발급·재발급.
 * 재발급 시 기존 유효 QR은 즉시 REVOKED가 되며, 구형 토큰의 공개 조회는 410이다.
 * 공개 조회는 비인증 엔드포인트(/api/assets-v2/public/qr/:token)이며,
 * 자산번호·품명·등록 사무실명만 반환하고 시리얼·취득가·담당자·내부 ID를 노출하지 않는다.
 */

interface AssetItem { id: string; assetNumber: string; name: string; }

const AssetQrPanel: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const [assets, setAssets] = useState<AssetItem[]>([]);
    const [assetId, setAssetId] = useState('');
    const [qrs, setQrs] = useState<any[]>([]);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const isAdmin = currentUser.role === 'admin';

    const loadAssets = useCallback(async () => {
        const res = await fetch('/api/assets-v2/assets', { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        setAssets(json.data || []);
    }, []);

    const loadQrs = useCallback(async (id: string) => {
        const res = await fetch(`/api/assets-v2/assets/${id}/qr-codes`, { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        setQrs(json.data || []);
    }, []);

    useEffect(() => { loadAssets(); }, [loadAssets]);

    async function issue(reissue: boolean) {
        setError(''); setMessage('');
        try {
            const url = `/api/assets-v2/assets/${assetId}/qr-codes${reissue ? '/reissue' : ''}`;
            const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'QR 발급에 실패했습니다.');
            setMessage(`${reissue ? '재발급' : '발급'} 완료 (v${json.data.tokenVersion}). 기존 유효 QR ${json.revokedCount}건이 폐기되었습니다.`);
            loadQrs(assetId);
        } catch (e: any) { setError(e.message); }
    }

    return (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div>
                <h2 className="font-bold text-slate-900">QR 발급·재발급</h2>
                <p className="text-sm text-slate-500 mt-1">자산당 유효 QR은 1개만 유지됩니다. 재발급하면 구형 QR은 즉시 폐기(REVOKED)되어 공개 조회에서 410으로 응답합니다.</p>
                <p className="text-sm text-slate-500">공개 조회 안내: <span className="font-mono text-xs">/api/assets-v2/public/qr/:token</span> (비인증, 자산번호·품명·등록 사무실명만 반환, 분당 30건 속도 제한)</p>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {message && <p className="text-sm text-green-700">{message}</p>}
            <label className="text-sm text-slate-700">자산
                <select value={assetId} onChange={(e) => { setAssetId(e.target.value); if (e.target.value) loadQrs(e.target.value); }} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                    <option value="">선택</option>
                    {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.assetNumber})</option>)}
                </select>
            </label>
            {isAdmin && assetId && (
                <div className="flex gap-2">
                    <button onClick={() => issue(false)} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">QR 발급</button>
                    <button onClick={() => issue(true)} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">QR 재발급</button>
                </div>
            )}
            {assetId && (
                <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                        <tr><th className="text-left px-3 py-2 font-medium">버전</th><th className="text-left px-3 py-2 font-medium">상태</th><th className="text-left px-3 py-2 font-medium">발급일시</th><th className="text-left px-3 py-2 font-medium">공개 토큰</th></tr>
                    </thead>
                    <tbody>
                        {qrs.map((q) => (
                            <tr key={q.id} className="border-t border-slate-100">
                                <td className="px-3 py-2">v{q.tokenVersion}</td>
                                <td className="px-3 py-2">{q.status}</td>
                                <td className="px-3 py-2 text-slate-600">{q.issuedAt ? new Date(q.issuedAt).toLocaleString() : '-'}</td>
                                <td className="px-3 py-2 font-mono text-xs break-all">{q.publicToken}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

export default AssetQrPanel;

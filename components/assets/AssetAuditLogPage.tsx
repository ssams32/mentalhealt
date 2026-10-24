import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';

/**
 * AssetAuditLogPage — Stage 3 감사로그 뷰어 (읽기 전용).
 * admin 전용이다. 감사로그에 대한 쓰기·수정·삭제 기능은 의도적으로 없다.
 * 카테고리 필터는 JSON 이식 감사 행의 entityType과 동일 값으로 매핑한다
 * (예: Asset / InventoryCheck / DataImport). 액션은 정확 일치 필터다.
 */

interface AuditRow {
    id: string;
    action: string;
    entityType: string;
    entityId: string | null;
    actorId: string | null;
    actorName: string | null;
    actorRole: string | null;
    detail: any;
    createdAt: string;
}

const CATEGORIES = ['', 'Asset', 'AssetCategory', 'AssetSpace', 'FloorPlan', 'QrCode', 'InventoryPlan', 'InventoryCheck', 'AssetLocation', 'DataImport', 'Export', 'User'];

const AssetAuditLogPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const [rows, setRows] = useState<AuditRow[]>([]);
    const [total, setTotal] = useState(0);
    const [action, setAction] = useState('');
    const [category, setCategory] = useState('');
    const [actorId, setActorId] = useState('');
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setError('');
        try {
            const params = new URLSearchParams({ limit: '200' });
            if (action.trim()) params.set('action', action.trim());
            if (category) params.set('category', category);
            if (actorId.trim()) params.set('actorId', actorId.trim());
            const res = await fetch(`/api/assets-v2/audit-logs?${params.toString()}`, { credentials: 'include' });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(res.status === 403 ? '감사로그 조회는 관리자 전용입니다.' : (json.error || '감사로그를 불러오지 못했습니다.'));
            setRows(json.data || []);
            setTotal(json.total || 0);
        } catch (e: any) {
            setError(e.message || '감사로그를 불러오지 못했습니다.');
        }
    }, [action, category, actorId]);

    useEffect(() => { load(); }, [load]);

    if (currentUser.role !== 'admin') {
        return <p className="text-sm text-slate-500">감사로그 조회는 관리자 전용입니다.</p>;
    }

    return (
        <div>
            <p className="text-sm text-slate-500 mb-3">읽기 전용 뷰어입니다. 감사로그를 수정·삭제할 수 없습니다 (서버에도 해당 API가 없습니다).</p>
            <div className="flex flex-wrap gap-2 mb-4">
                <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="액션 (예: IMPORT_COMMITTED)" className="px-3 py-2 rounded-xl border border-slate-300 text-sm" />
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-300 text-sm">
                    {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c === '' ? '카테고리 전체' : c}</option>
                    ))}
                </select>
                <input value={actorId} onChange={(e) => setActorId(e.target.value)} placeholder="행위자 ID" className="px-3 py-2 rounded-xl border border-slate-300 text-sm" />
                <button onClick={load} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">조회</button>
            </div>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <p className="text-sm text-slate-500 mb-2">총 {total}건 (최신 200건 표시)</p>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                        <tr><th className="text-left px-3 py-2">일시</th><th className="text-left px-3 py-2">액션</th><th className="text-left px-3 py-2">카테고리</th><th className="text-left px-3 py-2">행위자</th><th className="text-left px-3 py-2">상세</th></tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.id} className="border-t border-slate-100">
                                <td className="px-3 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                                <td className="px-3 py-2">{r.action}</td>
                                <td className="px-3 py-2">{r.entityType}</td>
                                <td className="px-3 py-2">{r.actorName || r.actorId || '-'}</td>
                                <td className="px-3 py-2 break-all">{r.detail ? JSON.stringify(r.detail) : '-'}</td>
                            </tr>
                        ))}
                        {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-slate-500">표시할 감사로그가 없습니다.</td></tr>}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default AssetAuditLogPage;

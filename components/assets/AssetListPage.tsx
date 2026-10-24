import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';
import AssetIsoExplorer from './AssetIsoExplorer';
import AssetFloorPlanEditor from './AssetFloorPlanEditor';
import AssetQrPanel from './AssetQrPanel';
import AssetInventoryPage from './AssetInventoryPage';
import AssetDataPage from './AssetDataPage';
import AssetDashboard from './AssetDashboard';
import AssetAuditLogPage from './AssetAuditLogPage';

/**
 * AssetListPage — Stage 1 자산 목록 최소본.
 * 의뢰대장 기존 스타일(Tailwind + 흰 카드)을 따르고, 풀스택 인디고 테마를 덮어씌우지 않는다.
 * Next 라우터 의존성 없이, 서버 /api/assets-v2를 fetch로 호출한다.
 * 권한 판정은 서버가 최종 결정하고, 이 페이지는 버튼 노출만 역할로 가린다.
 * Stage 2에서 공간·배치도·QR·재물조사 탭이 이 파일 옆에 추가된다.
 */

interface AssetItem {
    id: string;
    assetNumber: string;
    name: string;
    categoryId?: string | null;
    categoryName?: string | null;
    manufacturer?: string | null;
    modelName?: string | null;
    serialNumber?: string | null;
    operationalStatus: string;
    team?: string | null;
    roomName?: string | null;
    acquisitionDate?: string | null;
    acquisitionCost?: number | null;
    notes?: string | null;
}

interface CategoryItem {
    id: string;
    code: string;
    name: string;
}

const STATUS_LABEL: Record<string, string> = {
    IN_USE: '사용중',
    IN_STORAGE: '보관중',
    RENTED: '대여중',
    REPAIRING: '수리중',
    EXTERNAL_OUT: '외부반출',
    DISPOSAL_PLANNED: '폐기예정',
    DISPOSED: '폐기완료',
    LOST: '분실',
    UNVERIFIED: '미확인',
};

const AssetListPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const [assets, setAssets] = useState<AssetItem[]>([]);
    const [categories, setCategories] = useState<CategoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [selected, setSelected] = useState<AssetItem | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ assetNumber: '', name: '', categoryId: '', manufacturer: '', modelName: '', notes: '' });
    const [formError, setFormError] = useState('');
    // Stage 2 탭: App.tsx·Sidebar의 assets 연결을 중복하지 않고, 이 페이지 내부에서 전환한다.
    const [tab, setTab] = useState<'list' | 'iso' | 'floorplan' | 'qr' | 'inventory' | 'data' | 'dashboard' | 'auditlog'>('list');

    const canWrite = currentUser.role === 'admin' || currentUser.role === 'manager';
    const canDelete = currentUser.role === 'admin';

    const loadList = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [aRes, cRes] = await Promise.all([
                fetch('/api/assets-v2/assets', { credentials: 'include' }),
                fetch('/api/assets-v2/categories', { credentials: 'include' }),
            ]);
            if (!aRes.ok) throw new Error(aRes.status === 401 ? '로그인이 필요합니다.' : aRes.status === 403 ? '자산 조회 권한이 없습니다.' : '자산 목록을 불러오지 못했습니다.');
            const aJson = await aRes.json();
            const cJson = cRes.ok ? await cRes.json() : { data: [] };
            setAssets(aJson.data || []);
            setCategories(cJson.data || []);
        } catch (e: any) {
            setError(e.message || '자산 목록을 불러오지 못했습니다.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadList(); }, [loadList]);

    const handleSearch = async () => {
        if (!query.trim()) { setSearching(false); loadList(); return; }
        setSearching(true);
        setError('');
        try {
            const res = await fetch(`/api/assets-v2/assets/search?q=${encodeURIComponent(query.trim())}`, { credentials: 'include' });
            if (!res.ok) throw new Error('검색에 실패했습니다.');
            const json = await res.json();
            setAssets(json.data || []);
        } catch (e: any) {
            setError(e.message || '검색에 실패했습니다.');
        }
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError('');
        try {
            const res = await fetch('/api/assets-v2/assets', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '자산 생성에 실패했습니다.');
            setForm({ assetNumber: '', name: '', categoryId: '', manufacturer: '', modelName: '', notes: '' });
            setShowForm(false);
            loadList();
        } catch (e: any) {
            setFormError(e.message || '자산 생성에 실패했습니다.');
        }
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm('이 자산을 소프트 삭제(비활성화)하시겠습니까? 목록에서 제외되며 물리 삭제되지 않습니다.')) return;
        try {
            const res = await fetch(`/api/assets-v2/assets/${id}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: '목록 페이지에서 삭제' }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '삭제에 실패했습니다.');
            setSelected(null);
            loadList();
        } catch (e: any) {
            setError(e.message || '삭제에 실패했습니다.');
        }
    };

    return (
        <div className="p-4 md:p-6 max-w-6xl mx-auto">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mb-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-bold text-slate-900">자산 관리</h1>
                        <p className="text-sm text-slate-500 mt-1">의뢰대장 자산대장 (Stage 3: 목록·2.5D 탐색·배치도·QR·재물조사·데이터·대시보드·감사로그).</p>
                    </div>
                    {canWrite && tab === 'list' && (
                        <button onClick={() => setShowForm(!showForm)} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold hover:bg-orange-700">
                            {showForm ? '등록 폼 닫기' : '+ 자산 등록'}
                        </button>
                    )}
                </div>

                <div className="flex flex-wrap gap-2 mt-4">
                    {([
                        ['list', '자산 목록'],
                        ['iso', '2.5D 탐색'],
                        ['floorplan', '배치도 편집'],
                        ['qr', 'QR'],
                        ['inventory', '재물조사'],
                        ['data', '데이터'],
                        ['dashboard', '대시보드'],
                        ...(canDelete ? [['auditlog', '감사로그']] : []),
                    ] as Array<[typeof tab, string]>).map(([key, label]) => (
                        <button key={key} onClick={() => setTab(key)} className={`px-3 py-2 rounded-xl text-sm font-semibold ${tab === key ? 'bg-orange-600 text-white' : 'bg-slate-100 text-slate-700'}`}>{label}</button>
                    ))}
                </div>

                {tab === 'iso' && <div className="mt-4"><AssetIsoExplorer /></div>}
                {tab === 'floorplan' && <div className="mt-4"><AssetFloorPlanEditor currentUser={currentUser} /></div>}
                {tab === 'qr' && <div className="mt-4"><AssetQrPanel currentUser={currentUser} /></div>}
                {tab === 'inventory' && <div className="mt-4"><AssetInventoryPage currentUser={currentUser} /></div>}
                {tab === 'data' && <div className="mt-4"><AssetDataPage currentUser={currentUser} /></div>}
                {tab === 'dashboard' && <div className="mt-4"><AssetDashboard currentUser={currentUser} /></div>}
                {tab === 'auditlog' && <div className="mt-4"><AssetAuditLogPage currentUser={currentUser} /></div>}

                {tab === 'list' && (<div className="flex gap-2 mt-4">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                        placeholder="자산번호·품명·제조사·모델·시리얼 검색 (예: TEST-)"
                        className="flex-1 px-3 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200"
                    />
                    <button onClick={handleSearch} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold">검색</button>
                    {searching && <button onClick={() => { setQuery(''); setSearching(false); loadList(); }} className="px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm">전체 보기</button>}
                </div>)}
                {tab === 'list' && error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            </div>

            {tab === 'list' && showForm && canWrite && (
                <form onSubmit={handleCreate} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mb-4 space-y-3">
                    <h2 className="font-bold text-slate-900">자산 등록</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="text-sm text-slate-700">자산번호 *
                            <input required value={form.assetNumber} onChange={(e) => setForm({ ...form, assetNumber: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm" placeholder="예: TEST-001" />
                        </label>
                        <label className="text-sm text-slate-700">품명 *
                            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                        </label>
                        <label className="text-sm text-slate-700">분류
                            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm bg-white">
                                <option value="">분류 없음</option>
                                {categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
                            </select>
                        </label>
                        <label className="text-sm text-slate-700">제조사
                            <input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                        </label>
                        <label className="text-sm text-slate-700">모델명
                            <input value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                        </label>
                        <label className="text-sm text-slate-700">비고
                            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-xl text-sm" />
                        </label>
                    </div>
                    {formError && <p className="text-sm text-red-600">{formError}</p>}
                    <button type="submit" className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold hover:bg-orange-700">등록</button>
                </form>
            )}

            {tab === 'list' && (<div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                {loading ? (
                    <p className="p-5 text-sm text-slate-500">불러오는 중…</p>
                ) : assets.length === 0 ? (
                    <p className="p-5 text-sm text-slate-500">등록된 활성 자산이 없습니다.</p>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">자산번호</th>
                                <th className="text-left px-4 py-3 font-medium">품명</th>
                                <th className="text-left px-4 py-3 font-medium">분류</th>
                                <th className="text-left px-4 py-3 font-medium">상태</th>
                                <th className="text-left px-4 py-3 font-medium">등록 사무실</th>
                            </tr>
                        </thead>
                        <tbody>
                            {assets.map((a) => (
                                <tr key={a.id} onClick={() => setSelected(a)} className="border-t border-slate-100 hover:bg-orange-50 cursor-pointer">
                                    <td className="px-4 py-3 font-mono text-xs">{a.assetNumber}</td>
                                    <td className="px-4 py-3 font-medium text-slate-900">{a.name}</td>
                                    <td className="px-4 py-3 text-slate-600">{a.categoryName || '-'}</td>
                                    <td className="px-4 py-3 text-slate-600">{STATUS_LABEL[a.operationalStatus] || a.operationalStatus}</td>
                                    <td className="px-4 py-3 text-slate-600">{a.roomName || '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>)}

            {tab === 'list' && selected && (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 mt-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <h2 className="font-bold text-slate-900">{selected.name} <span className="font-mono text-xs text-slate-500 ml-1">{selected.assetNumber}</span></h2>
                            <p className="text-sm text-slate-600 mt-2">
                                상태: {STATUS_LABEL[selected.operationalStatus] || selected.operationalStatus}
                                {selected.team ? ` · 팀: ${selected.team}` : ''}
                                {selected.manufacturer ? ` · 제조사: ${selected.manufacturer}` : ''}
                                {selected.modelName ? ` · 모델: ${selected.modelName}` : ''}
                                {selected.roomName ? ` · 사무실: ${selected.roomName}` : ''}
                            </p>
                            {selected.notes && <p className="text-sm text-slate-600 mt-1">비고: {selected.notes}</p>}
                        </div>
                        <div className="flex gap-2 shrink-0">
                            {canDelete && <button onClick={() => handleDelete(selected.id)} className="px-3 py-2 rounded-xl bg-red-50 text-red-700 text-sm font-semibold">소프트 삭제</button>}
                            <button onClick={() => setSelected(null)} className="px-3 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm">닫기</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default AssetListPage;

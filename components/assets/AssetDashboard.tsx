import React, { useState, useEffect, useCallback } from 'react';
import { User } from '../../types';

/**
 * AssetDashboard — Stage 3 대시보드 지표 화면.
 * 서버 GET /api/assets-v2/dashboard/metrics를 그대로 표시한다.
 * 비관리자는 팀 스코프가 적용된 지표를 받는다 (서버 판정).
 */

interface Metrics {
    totalAssets: number;
    byOperationalStatus: Record<string, number>;
    byVerificationStatus: { VERIFIED: number; UNVERIFIED: number };
    discrepancyCount: number;
    unapprovedCount: number;
    staleOver365Days: number;
    latestPlan: { id: string; name: string; status: string; targetCount: number; processedCount: number; progress: number } | null;
    generatedAt: string;
}

const STATUS_LABEL: Record<string, string> = {
    IN_USE: '사용중', IN_STORAGE: '보관중', RENTED: '대여중', REPAIRING: '수리중',
    EXTERNAL_OUT: '외부반출', DISPOSAL_PLANNED: '폐기예정', DISPOSED: '폐기완료',
    LOST: '분실', UNVERIFIED: '미확인',
};

const AssetDashboard: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    void currentUser;
    const [metrics, setMetrics] = useState<Metrics | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setError('');
        try {
            const res = await fetch('/api/assets-v2/dashboard/metrics', { credentials: 'include' });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '대시보드 지표를 불러오지 못했습니다.');
            setMetrics(json.data);
        } catch (e: any) {
            setError(e.message || '대시보드 지표를 불러오지 못했습니다.');
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!metrics) return <p className="text-sm text-slate-500">지표를 불러오는 중입니다…</p>;

    const cards = [
        ['총 자산', metrics.totalAssets],
        ['위치불일치', metrics.discrepancyCount],
        ['미승인 조사', metrics.unapprovedCount],
        ['365일 이상 미확인', metrics.staleOver365Days],
    ] as const;

    return (
        <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {cards.map(([label, value]) => (
                    <div key={label} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                        <p className="text-xs text-slate-500">{label}</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
                    </div>
                ))}
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mt-4">
                <h3 className="font-semibold text-slate-900 text-sm">운영 상태별</h3>
                <ul className="mt-2 text-sm text-slate-700 space-y-1">
                    {Object.entries(metrics.byOperationalStatus).filter(([, v]) => v > 0).map(([status, count]) => (
                        <li key={status}>{STATUS_LABEL[status] || status}: {count}건</li>
                    ))}
                    {Object.values(metrics.byOperationalStatus).every((v) => v === 0) && <li>활성 자산이 없습니다.</li>}
                </ul>
                <p className="mt-3 text-sm text-slate-700">
                    위치 확인 상태 — 확인됨 {metrics.byVerificationStatus.VERIFIED}건 / 미확인 {metrics.byVerificationStatus.UNVERIFIED}건
                    (미확인은 위치 행 없음, 확인 시각 없음, 또는 365일 초과 기준)
                </p>
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mt-4">
                <h3 className="font-semibold text-slate-900 text-sm">최신 조사 계획 진행률</h3>
                {metrics.latestPlan ? (
                    <div className="mt-2 text-sm text-slate-700">
                        <p>{metrics.latestPlan.name} ({metrics.latestPlan.status}) — {metrics.latestPlan.processedCount}/{metrics.latestPlan.targetCount}건, {metrics.latestPlan.progress}%</p>
                        <div className="h-2 bg-slate-100 rounded-full mt-2 overflow-hidden">
                            <div className="h-full bg-orange-600" style={{ width: `${metrics.latestPlan.progress}%` }} />
                        </div>
                    </div>
                ) : (
                    <p className="mt-2 text-sm text-slate-500">조사 계획이 없습니다.</p>
                )}
            </div>
        </div>
    );
};

export default AssetDashboard;

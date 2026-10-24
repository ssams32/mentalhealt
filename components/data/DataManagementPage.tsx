
import React, { useEffect, useState } from 'react';
import { Referral, SuicideAttempterReferral, Page } from '../../types';
import PageContainer from '../layout/PageContainer';
import StatCard from '../common/StatCard';
import { REFERRAL_EXCEL_HEADERS, SA_EXCEL_HEADERS } from '../../constants';

declare var XLSX: any;

interface DataManagementPageProps {
    referrals: Referral[];
    suicideAttempterReferrals: SuicideAttempterReferral[];
    activePage: Page;
}

interface BackupTargetInfo {
    id: number;
    name: string;
    path: string;
    hostPath: string | null;
    available: boolean;
    writable: boolean;
    freeBytes: number | null;
    reason: string | null;
}

interface BackupSettingsInfo {
    activeTargetId: number | null;
    autoEnabled: boolean;
    autoTime: string;
    retentionCount: number;
    lastRunAt: string | null;
    lastRunTargetId: number | null;
    lastRunResult: string | null;
    lastRunError: string | null;
}

interface BackupRunStatusInfo {
    state: 'idle' | 'running' | 'done' | 'error';
    startedAt: string | null;
    finishedAt: string | null;
    targetId: number | null;
    copiedFiles: number;
    copiedBytes: number;
    error: string | null;
}

const DataManagementPage: React.FC<DataManagementPageProps> = ({ referrals, suicideAttempterReferrals, activePage }) => {

    // 저장 경로 정보는 서버(/api/health/storage) 응답값을 그대로 표시한다. 경로를 프론트에 하드코딩하지 않는다.
    const [storagePaths, setStoragePaths] = useState<{ dataDir: string; backupDir: string; attachmentsDir: string } | null>(null);
    const [storagePathsFailed, setStoragePathsFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/health/storage', { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled && data && data.success) {
                    setStoragePaths({
                        dataDir: data.dataDir || '',
                        backupDir: data.backupDir || '',
                        attachmentsDir: data.attachmentsDir || ''
                    });
                } else if (!cancelled) {
                    setStoragePathsFailed(true);
                }
            } catch (e) {
                if (!cancelled) setStoragePathsFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // 백업 대상 지정/실행: 대상 목록·설정은 전부 서버(/api/backup/*) 응답값으로만 표시한다. 경로를 프론트에 하드코딩하지 않는다.
    const [backupTargets, setBackupTargets] = useState<BackupTargetInfo[] | null>(null);
    const [backupSettings, setBackupSettings] = useState<BackupSettingsInfo | null>(null);
    const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
    const [backupAutoEnabled, setBackupAutoEnabled] = useState(false);
    const [backupAutoTime, setBackupAutoTime] = useState('02:00');
    const [backupRetentionCount, setBackupRetentionCount] = useState(30);
    const [runStatus, setRunStatus] = useState<BackupRunStatusInfo | null>(null);
    const [backupBusy, setBackupBusy] = useState<'save' | 'run' | null>(null);
    const [backupMessage, setBackupMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const pollingRef = React.useRef(false);

    const applyBackupSettings = (s: BackupSettingsInfo) => {
        setBackupSettings(s);
        setSelectedTargetId(s.activeTargetId);
        setBackupAutoEnabled(!!s.autoEnabled);
        setBackupAutoTime(s.autoTime || '02:00');
        setBackupRetentionCount(s.retentionCount || 30);
    };

    const pollRunStatus = async () => {
        if (pollingRef.current) return;
        pollingRef.current = true;
        try {
            for (let i = 0; i < 90; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const res = await fetch('/api/backup/status', { credentials: 'include' });
                if (!res.ok) break;
                const data = await res.json();
                if (!data || !data.success) break;
                setRunStatus(data.status);
                if (data.status.state === 'done' || data.status.state === 'error') {
                    const sRes = await fetch('/api/backup/settings', { credentials: 'include' });
                    if (sRes.ok) {
                        const sData = await sRes.json();
                        if (sData && sData.success) applyBackupSettings(sData.settings);
                    }
                    // 대상 여유공간 등 상태도 새로고침
                    const tRes = await fetch('/api/backup/targets', { credentials: 'include' });
                    if (tRes.ok) {
                        const tData = await tRes.json();
                        if (tData && tData.success) setBackupTargets(tData.targets || []);
                    }
                    break;
                }
            }
        } catch (e) {
            // 폴링 실패는 조용히 종료 (다음 새로고침에서 상태 확인 가능)
        } finally {
            pollingRef.current = false;
        }
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [tRes, sRes, stRes] = await Promise.all([
                    fetch('/api/backup/targets', { credentials: 'include' }),
                    fetch('/api/backup/settings', { credentials: 'include' }),
                    fetch('/api/backup/status', { credentials: 'include' })
                ]);
                if (cancelled) return;
                if (tRes.ok) {
                    const d = await tRes.json();
                    if (d && d.success) setBackupTargets(d.targets || []);
                }
                if (sRes.ok) {
                    const d = await sRes.json();
                    if (d && d.success) applyBackupSettings(d.settings);
                }
                if (stRes.ok) {
                    const d = await stRes.json();
                    if (d && d.success) {
                        setRunStatus(d.status);
                        if (d.status.state === 'running') pollRunStatus();
                    }
                }
            } catch (e) {
                // 대상 미구성/권한 없음이면 블록 자체를 숨긴다
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const saveBackupSettings = async (): Promise<boolean> => {
        setBackupBusy('save');
        setBackupMessage(null);
        try {
            const res = await fetch('/api/backup/settings', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    activeTargetId: selectedTargetId,
                    autoEnabled: backupAutoEnabled,
                    autoTime: backupAutoTime,
                    retentionCount: Number(backupRetentionCount)
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.success) throw new Error((data && data.error) || `HTTP ${res.status}`);
            applyBackupSettings(data.settings);
            setBackupMessage({ type: 'success', text: '백업 설정을 저장했습니다.' });
            return true;
        } catch (e: any) {
            setBackupMessage({ type: 'error', text: e.message || '설정 저장에 실패했습니다.' });
            return false;
        } finally {
            setBackupBusy(null);
        }
    };

    const runBackupNow = async () => {
        // 현재 폼 값으로 먼저 저장한 뒤 실행한다 (선택만 바꾸고 저장 안 한 경우에도 의도대로 동작).
        const saved = await saveBackupSettings();
        if (!saved) return;
        setBackupBusy('run');
        setBackupMessage(null);
        try {
            const res = await fetch('/api/backup/run', { method: 'POST', credentials: 'include' });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.success) throw new Error((data && data.error) || `HTTP ${res.status}`);
            setRunStatus(prev => prev
                ? { ...prev, state: 'running', error: null }
                : { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, targetId: selectedTargetId, copiedFiles: 0, copiedBytes: 0, error: null });
            setBackupMessage({ type: 'success', text: '백업을 시작했습니다. 완료될 때까지 이 화면에서 상태를 확인할 수 있습니다.' });
            pollRunStatus();
        } catch (e: any) {
            setBackupMessage({ type: 'error', text: e.message || '백업 실행에 실패했습니다.' });
        } finally {
            setBackupBusy(null);
        }
    };

    const formatFreeSpace = (bytes: number | null) => (bytes === null || bytes === undefined ? '알 수 없음' : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
    const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR') : '-');
    const backupTargetName = (id: number | null) => {
        if (id === null || id === undefined) return '-';
        const found = (backupTargets || []).find(t => t.id === id);
        return found ? found.name : `대상 ${id}`;
    };

    const downloadFile = (data: Blob, fileName: string) => {
        const url = URL.createObjectURL(data);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDownloadExcel = (isSA: boolean) => {
        const dataToExport = isSA ? suicideAttempterReferrals : referrals;
        const fileName = isSA ? '자살시도자_의뢰대장.xlsx' : '일반_의뢰대장.xlsx';
        const headers = isSA ? SA_EXCEL_HEADERS : REFERRAL_EXCEL_HEADERS;

        const processedData = dataToExport.map(row => {
            const newRow: { [key: string]: any } = {};
            Object.keys(headers).forEach(key => {
                const header = (headers as any)[key];
                let value = (row as any)[key];

                if (isSA) {
                    if (key === 'notes') {
                        const saRow = row as SuicideAttempterReferral;
                        value = saRow.notes && saRow.notes.length > 0 ? saRow.notes[0].content : '';
                    } else if (key === 'attachments') {
                         const saRow = row as SuicideAttempterReferral;
                        value = Array.isArray(saRow.attachments) ? saRow.attachments.length : 0;
                    }
                } else {
                     if (key === 'attachments') {
                        const rRow = row as Referral;
                        value = Array.isArray(rRow.attachments) ? rRow.attachments.length : 0;
                    }
                }

                if (typeof value === 'boolean') {
                    value = value ? 'Y' : 'N';
                } else if (value instanceof Date) {
                    value = value.toISOString().split('T')[0];
                }
                newRow[header] = value === undefined || value === null ? '' : value;
            });
            return newRow;
        });

        const worksheet = XLSX.utils.json_to_sheet(processedData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Data');
        const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const data = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheet.sheet;charset=UTF-8' });
        downloadFile(data, fileName);
    };

    const handleDownloadJson = (isSA: boolean) => {
        const dataToExport = isSA ? suicideAttempterReferrals : referrals;
        const fileName = isSA ? 'suicide_attempters.json' : 'referrals.json';
        const data = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
        downloadFile(data, fileName);
    };

    return (
        <PageContainer title="데이터 관리" subtitle="시스템 데이터 백업 및 엑셀 다운로드">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-[21px]">
                <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-file-excel"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">일반의뢰 엑셀</h3>
                        <p className="text-slate-500 text-[13px]">일반 의뢰 목록을 엑셀 파일(.xlsx)로 다운로드합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadExcel(false)} className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold hover:bg-emerald-600 transition shadow-lg shadow-emerald-500/20">다운로드 시작</button>
                </div>
                <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-file-excel"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">자살시도자 엑셀</h3>
                        <p className="text-slate-500 text-[13px]">자살시도자 목록을 엑셀 파일(.xlsx)로 다운로드합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadExcel(true)} className="w-full py-4 bg-rose-500 text-white rounded-2xl font-bold hover:bg-rose-600 transition shadow-lg shadow-rose-500/20">다운로드 시작</button>
                </div>
                <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-code"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">일반의뢰 JSON 백업</h3>
                        <p className="text-slate-500 text-[13px]">일반 의뢰 데이터를 JSON 형식으로 백업합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadJson(false)} className="w-full py-4 bg-blue-500 text-white rounded-2xl font-bold hover:bg-blue-600 transition shadow-lg shadow-blue-500/20">백업 파일 생성</button>
                </div>
                <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-code"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">자살시도자 JSON 백업</h3>
                        <p className="text-slate-500 text-[13px]">자살시도자 데이터를 JSON 형식으로 백업합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadJson(true)} className="w-full py-4 bg-indigo-500 text-white rounded-2xl font-bold hover:bg-indigo-600 transition shadow-lg shadow-indigo-500/20">백업 파일 생성</button>
                </div>
            </div>
            <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 bg-slate-100 text-slate-600 rounded-2xl flex items-center justify-center text-2xl"><i className="fas fa-folder-open"></i></div>
                    <div>
                        <h3 className="text-lg font-extrabold text-slate-900">서버 저장 경로</h3>
                        <p className="text-slate-500 text-[13px]">서버가 알려준 실제 저장 위치입니다.</p>
                    </div>
                </div>
                {storagePaths ? (
                    <dl className="space-y-4">
                        <div>
                            <dt className="text-[13px] font-bold text-slate-500 mb-1">백업 경로</dt>
                            <dd className="text-[13px] font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-[13px] py-[8px] break-all">{storagePaths.backupDir}</dd>
                        </div>
                        <div>
                            <dt className="text-[13px] font-bold text-slate-500 mb-1">데이터 경로</dt>
                            <dd className="text-[13px] font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-[13px] py-[8px] break-all">{storagePaths.dataDir}</dd>
                        </div>
                        <div>
                            <dt className="text-[13px] font-bold text-slate-500 mb-1">첨부파일 경로</dt>
                            <dd className="text-[13px] font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-[13px] py-[8px] break-all">{storagePaths.attachmentsDir}</dd>
                        </div>
                    </dl>
                ) : (
                    <p className="text-slate-500 text-[13px]">{storagePathsFailed ? '서버에서 경로 정보를 불러오지 못했습니다. 서버 연결 상태를 확인해 주세요.' : '경로 정보를 불러오는 중입니다.'}</p>
                )}
            </div>
            {backupTargets && backupTargets.length > 0 && (
                <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-12 h-12 bg-violet-100 text-violet-600 rounded-2xl flex items-center justify-center text-2xl"><i className="fas fa-hard-drive"></i></div>
                        <div>
                            <h3 className="text-lg font-extrabold text-slate-900">백업 대상 지정</h3>
                            <p className="text-slate-500 text-[13px]">서버에 연결된 저장소 중에서 골라, 데이터 스냅샷을 그 대상으로 복사합니다.</p>
                        </div>
                    </div>

                    <div className="space-y-[13px] mb-[21px]">
                        <label className="flex items-center gap-3 p-[13px] rounded-2xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                            <input type="radio" name="backup-target" checked={selectedTargetId === null} onChange={() => setSelectedTargetId(null)} className="w-4 h-4 accent-violet-600" />
                            <span className="text-[13px] font-bold text-slate-700">지정 안 함</span>
                        </label>
                        {backupTargets.map(t => (
                            <label key={t.id} className="flex items-start gap-3 p-[13px] rounded-2xl border border-slate-200 cursor-pointer hover:bg-slate-50">
                                <input type="radio" name="backup-target" checked={selectedTargetId === t.id} onChange={() => setSelectedTargetId(t.id)} className="w-4 h-4 mt-1 accent-violet-600" />
                                <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] font-bold text-slate-800">{t.name}</span>
                                        {t.available ? (
                                            <span className="text-[13px] font-bold px-[8px] py-[4px] rounded-full bg-emerald-100 text-emerald-700">사용 가능</span>
                                        ) : (
                                            <span className="text-[13px] font-bold px-[8px] py-[4px] rounded-full bg-rose-100 text-rose-700">사용 불가</span>
                                        )}
                                    </span>
                                    <span className="block text-[13px] font-mono text-slate-500 mt-1 break-all">{t.hostPath || t.path}</span>
                                    <span className="block text-[13px] text-slate-500 mt-1">여유 공간: {formatFreeSpace(t.freeBytes)}</span>
                                    {!t.available && t.reason && (
                                        <span className="block text-[13px] font-semibold text-rose-600 mt-1">{t.reason}</span>
                                    )}
                                </span>
                            </label>
                        ))}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-[21px] mb-[21px]">
                        <label className="flex items-center gap-3 p-[21px] rounded-[24px] bg-slate-50 border border-slate-100 cursor-pointer">
                            <input type="checkbox" checked={backupAutoEnabled} onChange={e => setBackupAutoEnabled(e.target.checked)} className="w-4 h-4 accent-violet-600" />
                            <span className="text-[13px] font-bold text-slate-700">자동 백업 사용</span>
                        </label>
                        <div className="p-[21px] rounded-[24px] bg-slate-50 border border-slate-100">
                            <label className="block text-[13px] font-bold text-slate-500 mb-1">자동 백업 시각</label>
                            <input type="time" value={backupAutoTime} onChange={e => setBackupAutoTime(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-[13px] py-[8px] text-[13px] font-semibold text-slate-800" />
                        </div>
                        <div className="p-[21px] rounded-[24px] bg-slate-50 border border-slate-100">
                            <label className="block text-[13px] font-bold text-slate-500 mb-1">보관 개수 (1~365)</label>
                            <input type="number" min={1} max={365} value={backupRetentionCount} onChange={e => setBackupRetentionCount(Number(e.target.value))} className="w-full bg-white border border-slate-200 rounded-xl px-[13px] py-[8px] text-[13px] font-semibold text-slate-800" />
                        </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3 mb-[13px]">
                        <button onClick={saveBackupSettings} disabled={backupBusy !== null} className="flex-1 py-3.5 bg-slate-800 text-white rounded-2xl font-bold hover:bg-slate-900 transition disabled:opacity-50">
                            {backupBusy === 'save' ? '저장 중...' : '설정 저장'}
                        </button>
                        <button onClick={runBackupNow} disabled={backupBusy !== null || runStatus?.state === 'running' || selectedTargetId === null} className="flex-1 py-3.5 bg-violet-600 text-white rounded-2xl font-bold hover:bg-violet-700 transition shadow-lg shadow-violet-600/20 disabled:opacity-50">
                            {runStatus?.state === 'running' ? '백업 실행 중...' : '지금 백업'}
                        </button>
                    </div>

                    {backupMessage && (
                        <p className={`text-[13px] font-semibold rounded-xl px-[13px] py-[8px] mb-[13px] ${backupMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{backupMessage.text}</p>
                    )}

                    {runStatus && runStatus.state !== 'idle' && (
                        <div className="text-[13px] rounded-xl px-[13px] py-[8px] mb-[13px] bg-slate-50 border border-slate-100">
                            {runStatus.state === 'running' && <p className="font-semibold text-slate-700">백업 실행 중입니다. 시작: {formatDateTime(runStatus.startedAt)}</p>}
                            {runStatus.state === 'done' && <p className="font-semibold text-emerald-700">백업 완료: 파일 {runStatus.copiedFiles}개 · {(runStatus.copiedBytes / 1024 / 1024).toFixed(1)} MB 복사됨 ({formatDateTime(runStatus.finishedAt)})</p>}
                            {runStatus.state === 'error' && <p className="font-semibold text-rose-700">백업 실패: {runStatus.error || '알 수 없는 오류'} ({formatDateTime(runStatus.finishedAt)})</p>}
                        </div>
                    )}

                    {backupSettings && backupSettings.lastRunAt && (
                        <dl className="text-[13px] space-y-1">
                            <div className="flex gap-2">
                                <dt className="font-bold text-slate-500 w-24 shrink-0">마지막 실행</dt>
                                <dd className="text-slate-800 font-semibold">{formatDateTime(backupSettings.lastRunAt)} · {backupTargetName(backupSettings.lastRunTargetId)} · {backupSettings.lastRunResult === 'success' ? '성공' : '실패'}</dd>
                            </div>
                            {backupSettings.lastRunResult !== 'success' && backupSettings.lastRunError && (
                                <div className="flex gap-2">
                                    <dt className="font-bold text-slate-500 w-24 shrink-0">실패 사유</dt>
                                    <dd className="text-rose-600 font-semibold">{backupSettings.lastRunError}</dd>
                                </div>
                            )}
                        </dl>
                    )}
                </div>
            )}
            <div className="bg-white p-[21px] rounded-[24px] shadow-sm border border-slate-100">
                <h3 className="text-lg font-extrabold text-slate-900 mb-6">데이터 요약</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[21px]">
                    <StatCard title="총 의뢰" value={referrals.length} color="bg-indigo-500" />
                    <StatCard title="자살시도자" value={suicideAttempterReferrals.length} color="bg-rose-500" />
                </div>
            </div>
        </PageContainer>
    );
};

export default DataManagementPage;
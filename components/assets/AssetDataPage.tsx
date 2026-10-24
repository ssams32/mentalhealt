import React, { useState } from 'react';
import { User } from '../../types';
import { containsFormulaInjectionRisk } from '../../utils/assetExcelSanitizer';

/**
 * AssetDataPage — Stage 3 엑셀 입출력·롤백 화면.
 * 흐름: 가져오기 검증(미리보기) → 커밋 → 롤백. 가져오기·커밋·롤백은 관리자 전용이며
 * 서버가 403으로 판정한다. 내보내기는 프리셋·형식을 선택해 다운로드한다.
 * XLSX 업로드는 파일 선택 후 base64로 서버에 전송한다 (multipart 의존성 없음).
 * JSON 행을 붙여넣으면 클라이언트에서 수식 위험 셀 개수를 미리 세어 보여준다
 * (utils/assetExcelSanitizer.ts 연결 — 최종 판정은 서버 검증이다).
 */

interface ImportRow {
    id: string;
    rowNumber: number;
    rawDataJson: any;
    normalizedDataJson: any;
    validationStatus: string;
    errorCodes: string[];
    errorMessages: string[];
    actionTaken: string | null;
    targetAssetId: string | null;
}

const AssetDataPage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
    const isAdmin = currentUser.role === 'admin';
    const [importMode, setImportMode] = useState('INSERT_ONLY');
    const [autoIssueQr, setAutoIssueQr] = useState(true);
    const [jsonText, setJsonText] = useState('');
    const [riskyCount, setRiskyCount] = useState<number | null>(null);
    const [jobId, setJobId] = useState('');
    const [rows, setRows] = useState<ImportRow[]>([]);
    const [rowTotal, setRowTotal] = useState(0);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [preset, setPreset] = useState('ALL_ASSETS');
    const [format, setFormat] = useState('csv');

    const loadPreview = async (id: string) => {
        const res = await fetch(`/api/assets-v2/imports/${id}`, { credentials: 'include' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || '미리보기를 불러오지 못했습니다.');
        setRows(json.data.rows || []);
        setRowTotal(json.data.total || 0);
        return json.data.job;
    };

    const handleJsonChange = (text: string) => {
        setJsonText(text);
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                let count = 0;
                for (const row of parsed) {
                    if (row && typeof row === 'object') {
                        for (const v of Object.values(row)) {
                            if (containsFormulaInjectionRisk(v as any)) { count++; break; }
                        }
                    }
                }
                setRiskyCount(count);
            } else {
                setRiskyCount(null);
            }
        } catch {
            setRiskyCount(null);
        }
    };

    const handleJsonUpload = async () => {
        setError(''); setMessage(''); setBusy(true);
        try {
            const parsed = JSON.parse(jsonText);
            if (!Array.isArray(parsed)) throw new Error('JSON 행 배열을 입력해 주세요.');
            const res = await fetch('/api/assets-v2/imports', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: parsed, importMode, autoIssueQr, filename: 'import.json' }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '가져오기 검증에 실패했습니다.');
            setJobId(json.data.id);
            await loadPreview(json.data.id);
            setMessage(`검증 완료: 전체 ${json.data.totalRows}행, 유효 ${json.data.validRows}행, 오류 ${json.data.errorRows}행. 오류 행은 커밋에서 건너뜁니다.`);
        } catch (e: any) {
            setError(e.message || '가져오기 검증에 실패했습니다.');
        } finally { setBusy(false); }
    };

    const handleXlsxFile = async (file: File) => {
        setError(''); setMessage(''); setBusy(true);
        try {
            const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
                reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
                reader.readAsDataURL(file);
            });
            const res = await fetch('/api/assets-v2/imports/xlsx', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileBase64: base64, filename: file.name, importMode, autoIssueQr }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'XLSX 가져오기 검증에 실패했습니다.');
            setJobId(json.data.id);
            await loadPreview(json.data.id);
            setMessage(`검증 완료: 전체 ${json.data.totalRows}행, 유효 ${json.data.validRows}행, 오류 ${json.data.errorRows}행.`);
        } catch (e: any) {
            setError(e.message || 'XLSX 가져오기 검증에 실패했습니다.');
        } finally { setBusy(false); }
    };

    const handleCommit = async () => {
        if (!jobId) return;
        if (!window.confirm('검증된 행만 원장에 반영합니다. 오류 행은 건너뜁니다. 커밋하시겠습니까?')) return;
        setError(''); setMessage(''); setBusy(true);
        try {
            const res = await fetch(`/api/assets-v2/imports/${jobId}/commit`, { method: 'POST', credentials: 'include' });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '커밋에 실패했습니다.');
            await loadPreview(jobId);
            setMessage(`커밋 완료: 신규 ${json.data.insertedCount}건, 수정 ${json.data.updatedCount}건, 건너뜀 ${json.data.skippedErrorCount}건, QR 발급 ${json.data.qrIssuedCount}건.`);
        } catch (e: any) {
            setError(e.message || '커밋에 실패했습니다.');
        } finally { setBusy(false); }
    };

    const handleRollback = async () => {
        if (!jobId) return;
        if (!window.confirm('커밋을 되돌립니다. 신규 삽입 자산은 소프트 삭제되고, 수정 자산은 커밋 전 값으로 복원됩니다. 롤백하시겠습니까?')) return;
        setError(''); setMessage(''); setBusy(true);
        try {
            const res = await fetch(`/api/assets-v2/imports/${jobId}/rollback`, { method: 'POST', credentials: 'include' });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || '롤백에 실패했습니다.');
            await loadPreview(jobId);
            setMessage(`롤백 완료: 삽입 되돌림 ${json.data.insertedRolledBack}건, 수정 복원 ${json.data.updatedRestored}건. 재롤백은 차단됩니다.`);
        } catch (e: any) {
            setError(e.message || '롤백에 실패했습니다.');
        } finally { setBusy(false); }
    };

    const handleExport = async () => {
        setError(''); setMessage('');
        try {
            const res = await fetch(`/api/assets-v2/exports?preset=${preset}&format=${format}`, { credentials: 'include' });
            if (!res.ok) {
                const json = await res.json().catch(() => ({}));
                throw new Error(json.error || '내보내기에 실패했습니다.');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            a.download = match ? match[1] : (format === 'xlsx' ? 'assets.xlsx' : 'asset-export.csv');
            a.click();
            URL.revokeObjectURL(url);
            setMessage('내보내기를 다운로드했습니다. (감사로그에는 프리셋·형식·건수만 기록됩니다.)');
        } catch (e: any) {
            setError(e.message || '내보내기에 실패했습니다.');
        }
    };

    return (
        <div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900 text-sm">가져오기 (검증 → 미리보기 → 커밋 → 롤백)</h3>
                {!isAdmin && <p className="text-sm text-slate-500 mt-2">가져오기·커밋·롤백은 관리자 전용입니다.</p>}
                <div className="flex flex-wrap gap-2 mt-3">
                    <select value={importMode} onChange={(e) => setImportMode(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-300 text-sm">
                        <option value="INSERT_ONLY">INSERT_ONLY (기존 자산번호는 오류)</option>
                        <option value="UPSERT">UPSERT (기존 자산번호는 수정)</option>
                    </select>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={autoIssueQr} onChange={(e) => setAutoIssueQr(e.target.checked)} /> 신규 자산 QR 자동 발급
                    </label>
                </div>
                <textarea value={jsonText} onChange={(e) => handleJsonChange(e.target.value)} rows={6} placeholder='JSON 행 배열 예: [{"assetNumber":"TEST-001","name":"의자","categoryCode":"CHAIR"}]' className="w-full mt-3 px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono" />
                {riskyCount !== null && <p className="text-sm text-amber-700 mt-1">수식 위험 셀 포함 행 {riskyCount}건 (서버 검증에서 WARNING + 중화 처리됩니다).</p>}
                <div className="flex flex-wrap gap-2 mt-3">
                    <button onClick={handleJsonUpload} disabled={busy || !isAdmin} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold disabled:opacity-50">JSON 검증</button>
                    <label className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm font-semibold cursor-pointer">
                        XLSX 파일 선택
                        <input type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleXlsxFile(f); }} />
                    </label>
                    <button onClick={handleCommit} disabled={busy || !isAdmin || !jobId} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50">커밋</button>
                    <button onClick={handleRollback} disabled={busy || !isAdmin || !jobId} className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold disabled:opacity-50">롤백</button>
                </div>
                {message && <p className="text-sm text-emerald-700 mt-3">{message}</p>}
                {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
                {jobId && <p className="text-sm text-slate-500 mt-3">작업 ID: {jobId} — 미리보기 총 {rowTotal}행</p>}
            </div>
            {rows.length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-4">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500">
                            <tr><th className="text-left px-3 py-2">행</th><th className="text-left px-3 py-2">자산번호</th><th className="text-left px-3 py-2">상태</th><th className="text-left px-3 py-2">처리</th><th className="text-left px-3 py-2">메시지</th></tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id} className="border-t border-slate-100">
                                    <td className="px-3 py-2">{r.rowNumber}</td>
                                    <td className="px-3 py-2">{r.normalizedDataJson?.assetNumber || r.rawDataJson?.assetNumber || '-'}</td>
                                    <td className="px-3 py-2">{r.validationStatus}</td>
                                    <td className="px-3 py-2">{r.actionTaken || '-'}</td>
                                    <td className="px-3 py-2">{r.errorMessages.join(' ') || '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mt-4">
                <h3 className="font-semibold text-slate-900 text-sm">내보내기</h3>
                <p className="text-sm text-slate-500 mt-1">텍스트 셀은 수식 주입 방어 처리되고, 숫자 셀은 숫자 타입을 유지합니다. XLSX는 전체 자산만 지원합니다. 감사로그 내보내기는 관리자 전용입니다.</p>
                <div className="flex flex-wrap gap-2 mt-3">
                    <select value={preset} onChange={(e) => setPreset(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-300 text-sm">
                        <option value="ALL_ASSETS">전체 자산</option>
                        <option value="DISCREPANCY_ASSETS">위치불일치 자산</option>
                        <option value="UNCHECKED_ASSETS">미확인 자산</option>
                        <option value="AUDIT_LOGS">감사로그 (관리자 전용)</option>
                    </select>
                    <select value={format} onChange={(e) => setFormat(e.target.value)} className="px-3 py-2 rounded-xl border border-slate-300 text-sm">
                        <option value="csv">CSV</option>
                        <option value="xlsx">XLSX (전체 자산만)</option>
                    </select>
                    <button onClick={handleExport} className="px-4 py-2 rounded-xl bg-orange-600 text-white text-sm font-semibold">다운로드</button>
                </div>
            </div>
        </div>
    );
};

export default AssetDataPage;

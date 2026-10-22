
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
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-file-excel"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">일반의뢰 엑셀</h3>
                        <p className="text-slate-500 text-sm">일반 의뢰 목록을 엑셀 파일(.xlsx)로 다운로드합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadExcel(false)} className="w-full py-4 bg-emerald-500 text-white rounded-2xl font-bold hover:bg-emerald-600 transition shadow-lg shadow-emerald-500/20">다운로드 시작</button>
                </div>
                <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-rose-100 text-rose-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-file-excel"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">자살시도자 엑셀</h3>
                        <p className="text-slate-500 text-sm">자살시도자 목록을 엑셀 파일(.xlsx)로 다운로드합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadExcel(true)} className="w-full py-4 bg-rose-500 text-white rounded-2xl font-bold hover:bg-rose-600 transition shadow-lg shadow-rose-500/20">다운로드 시작</button>
                </div>
                <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-code"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">일반의뢰 JSON 백업</h3>
                        <p className="text-slate-500 text-sm">일반 의뢰 데이터를 JSON 형식으로 백업합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadJson(false)} className="w-full py-4 bg-blue-500 text-white rounded-2xl font-bold hover:bg-blue-600 transition shadow-lg shadow-blue-500/20">백업 파일 생성</button>
                </div>
                <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col justify-between h-64">
                    <div>
                        <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center text-2xl mb-4"><i className="fas fa-code"></i></div>
                        <h3 className="text-xl font-extrabold text-slate-900 mb-2">자살시도자 JSON 백업</h3>
                        <p className="text-slate-500 text-sm">자살시도자 데이터를 JSON 형식으로 백업합니다.</p>
                    </div>
                    <button onClick={() => handleDownloadJson(true)} className="w-full py-4 bg-indigo-500 text-white rounded-2xl font-bold hover:bg-indigo-600 transition shadow-lg shadow-indigo-500/20">백업 파일 생성</button>
                </div>
            </div>
            <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 bg-slate-100 text-slate-600 rounded-2xl flex items-center justify-center text-2xl"><i className="fas fa-folder-open"></i></div>
                    <div>
                        <h3 className="text-lg font-extrabold text-slate-900">서버 저장 경로</h3>
                        <p className="text-slate-500 text-sm">서버가 알려준 실제 저장 위치입니다.</p>
                    </div>
                </div>
                {storagePaths ? (
                    <dl className="space-y-4">
                        <div>
                            <dt className="text-sm font-bold text-slate-500 mb-1">백업 경로</dt>
                            <dd className="text-sm font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 break-all">{storagePaths.backupDir}</dd>
                        </div>
                        <div>
                            <dt className="text-sm font-bold text-slate-500 mb-1">데이터 경로</dt>
                            <dd className="text-sm font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 break-all">{storagePaths.dataDir}</dd>
                        </div>
                        <div>
                            <dt className="text-sm font-bold text-slate-500 mb-1">첨부파일 경로</dt>
                            <dd className="text-sm font-mono font-semibold text-slate-800 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 break-all">{storagePaths.attachmentsDir}</dd>
                        </div>
                    </dl>
                ) : (
                    <p className="text-slate-500 text-sm">{storagePathsFailed ? '서버에서 경로 정보를 불러오지 못했습니다. 서버 연결 상태를 확인해 주세요.' : '경로 정보를 불러오는 중입니다.'}</p>
                )}
            </div>
            <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100">
                <h3 className="text-lg font-extrabold text-slate-900 mb-6">데이터 요약</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard title="총 의뢰" value={referrals.length} color="bg-indigo-500" />
                    <StatCard title="자살시도자" value={suicideAttempterReferrals.length} color="bg-rose-500" />
                </div>
            </div>
        </PageContainer>
    );
};

export default DataManagementPage;
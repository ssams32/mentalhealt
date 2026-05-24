
import React, { useState, useEffect } from 'react';
import { apiClient } from '../../services/apiClient';
import { RefreshCw, CheckCircle, FileText, Search, Download, Mail } from 'lucide-react';

const OfficialDocumentPage: React.FC = () => {
    const [documents, setDocuments] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');

    // Date Range for Sync
    const [dateRange, setDateRange] = useState({
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        end: new Date().toISOString().split('T')[0]
    });

    const loadDocuments = async () => {
        setIsLoading(true);
        try {
            const data = await apiClient.getOfficialDocuments();
            setDocuments(data || []);
        } catch (error: any) {
            console.error('Error loading official documents:', error);
            alert(`데이터를 불러오는 중 오류가 발생했습니다: ${error.message || error}`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const result = await apiClient.syncOfficialDocumentEmails(dateRange.start, dateRange.end);
            alert(result);
            loadDocuments();
        } catch (error: any) {
            console.error('Error syncing emails:', error);
            alert(`이메일 동기화 중 오류가 발생했습니다: ${error.message || error}`);
        } finally {
            setIsSyncing(false);
        }
    };

    useEffect(() => {
        loadDocuments();
    }, []);

    const handleApprove = async (mailId: string) => {
        if (!window.confirm('해당 공문을 검토 완료 상태로 변경하시겠습니까?')) return;

        try {
            const success = await apiClient.updateOfficialDocumentStatus(mailId, 'reviewed');
            if (success) {
                alert('처리가 완료되었습니다.');
                loadDocuments();
            } else {
                alert('상태 업데이트에 실패했습니다.');
            }
        } catch (error) {
            console.error('Error updating document status:', error);
            alert('오류가 발생했습니다.');
        }
    };

    const filteredDocs = documents.filter(doc =>
        (doc.docSubject?.toLowerCase() || doc.subject?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        (doc.docSender?.toLowerCase() || doc.sender?.toLowerCase() || '').includes(searchTerm.toLowerCase())
    );

    const handleExportExcel = () => {
        if (filteredDocs.length === 0) {
            alert('다운로드할 데이터가 없습니다.');
            return;
        }

        try {
            // @ts-ignore
            const XLSX = window.XLSX;
            if (!XLSX) {
                alert('엑셀 라이브러리를 불러오지 못했습니다.');
                return;
            }

            // 1. Prepare Data rows
            const excelData = filteredDocs.map((doc, index) => {
                const receivedDate = new Date(doc.receivedDate).toLocaleDateString('ko-KR').replace(/ /g, '');
                // Use OCR data if available, otherwise fallback to email metadata
                const finalDate = doc.docDate || receivedDate;
                const finalSubject = doc.docSubject || doc.subject;
                const finalSender = doc.docSender || doc.sender?.split('<')[0].trim() || '';

                return {
                    '번호': index + 1,
                    '쪽': '1',
                    '접수날짜': finalDate,
                    '제목': finalSubject,
                    '발신': finalSender
                };
            });

            // 2. Create Sheet
            const worksheet = XLSX.utils.json_to_sheet(excelData, { origin: 'A3' });

            // 3. Add Title Row (색인목록)
            XLSX.utils.sheet_add_aoa(worksheet, [['색인목록']], { origin: 'A1' });

            // 4. Style Header Cells (Note: Basic XLSX doesn't support styles well without xlsx-js-style, 
            // but we can set column widths and merges here)
            const merges = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } } // Merge A1:E1 for Title
            ];
            worksheet['!merges'] = merges;

            // Set Column Widths
            worksheet['!cols'] = [
                { wch: 8 },  // 번호
                { wch: 5 },  // 쪽
                { wch: 15 }, // 접수날짜
                { wch: 60 }, // 제목
                { wch: 20 }  // 발신
            ];

            // 5. Create Workbook and Download
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, '색인목록');

            const fileName = `공문수발_색인목록_${new Date().toISOString().split('T')[0]}.xlsx`;
            XLSX.writeFile(workbook, fileName);

        } catch (error) {
            console.error('Excel Export Error:', error);
            alert('엑셀 파일 생성 중 오류가 발생했습니다.');
        }
    };

    return (
        <div className="flex-1 flex flex-col min-w-0 bg-[#F2F2F7]">
            {/* Header */}
            <header className="bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-10 px-6 py-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-900">📂 공문수발 관리</h1>
                        <p className="text-sm text-slate-500 mt-1">전자파일로 수신된 공문을 검토하고 승인합니다.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* Date Range Picker */}
                        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 mr-2">
                            <input
                                type="date"
                                value={dateRange.start}
                                onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                                className="bg-transparent border-none text-xs text-slate-600 focus:ring-0 px-2 py-1"
                            />
                            <span className="text-slate-400">~</span>
                            <input
                                type="date"
                                value={dateRange.end}
                                onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                                className="bg-transparent border-none text-xs text-slate-600 focus:ring-0 px-2 py-1"
                            />
                        </div>

                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className="bg-indigo-600 text-white px-4 py-2 rounded-xl flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50"
                        >
                            <Mail size={18} className={isSyncing ? 'animate-bounce' : ''} />
                            메일 수집
                        </button>
                        <button
                            onClick={handleExportExcel}
                            className="bg-emerald-600 text-white px-4 py-2 rounded-xl flex items-center gap-2 hover:bg-emerald-700 transition-colors shadow-sm"
                        >
                            <Download size={18} />
                            엑셀 다운로드
                        </button>
                        <button
                            onClick={loadDocuments}
                            disabled={isLoading}
                            className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-xl flex items-center gap-2 hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
                        >
                            <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
                            새로고침
                        </button>
                    </div>
                </div>
            </header>

            <main className="flex-1 overflow-y-auto p-6">
                {/* Search Bar */}
                <div className="mb-6 relative">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-slate-400">
                        <Search size={20} />
                    </div>
                    <input
                        type="text"
                        placeholder="제목 또는 발신인으로 검색..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                </div>

                {/* Document List */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden text-left">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-slate-50 text-slate-500 border-b border-slate-200">
                                    <th className="px-6 py-4 font-semibold text-left">수신일시</th>
                                    <th className="px-6 py-4 font-semibold text-left">발신인</th>
                                    <th className="px-6 py-4 font-semibold text-left">제목</th>
                                    <th className="px-6 py-4 font-semibold text-center">상태</th>
                                    <th className="px-6 py-4 font-semibold text-right">작업</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {isLoading ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-20 text-center text-slate-400">
                                            <RefreshCw size={32} className="animate-spin mx-auto mb-4 opacity-20" />
                                            데이터를 불러오는 중입니다...
                                        </td>
                                    </tr>
                                ) : filteredDocs.length > 0 ? (
                                    filteredDocs.map((doc) => (
                                        <tr key={doc.mailId} className="hover:bg-slate-50/50 transition-colors group">
                                            <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                                                {new Date(doc.receivedDate).toLocaleDateString()}
                                            </td>
                                            <td className="px-6 py-4 font-medium text-slate-900">
                                                {doc.sender}
                                            </td>
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-2">
                                                    <FileText size={16} className="text-slate-400" />
                                                    <span className="text-slate-700 font-medium">{doc.docSubject || doc.subject}</span>
                                                </div>
                                                {doc.docSubject && (
                                                    <span className="text-[10px] text-indigo-500 font-semibold bg-indigo-50 px-1.5 py-0.5 rounded w-fit">
                                                        AI 분석됨
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <span className="px-3 py-1 bg-amber-50 text-amber-600 rounded-full text-xs font-bold border border-amber-100">
                                                    {doc.status || 'pending'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <button
                                                    onClick={() => handleApprove(doc.mailId)}
                                                    className="bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ml-auto border border-emerald-100 shadow-sm"
                                                >
                                                    <CheckCircle size={14} />
                                                    검토완료
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-20 text-center text-slate-400">
                                            검토 대기 중인 공문이 없습니다.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </div>
    );
};

export default OfficialDocumentPage;

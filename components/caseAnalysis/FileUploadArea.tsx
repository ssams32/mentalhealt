import React, { useRef, useState } from 'react';
import { Upload, FileUp, FileSpreadsheet, AlertCircle, AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { downloadSampleExcelFiles } from '../../services/excelSampleService';

interface FileUploadAreaProps {
    onFilesUpload: (files: File[]) => void;
    isLoading: boolean;
}

const FileUploadArea: React.FC<FileUploadAreaProps> = ({ onFilesUpload, isLoading }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFilesUpload(Array.from(e.target.files));
        }
        e.target.value = '';
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            // Filter for excel files if needed, but for now accept all and let logic handle
            onFilesUpload(Array.from(e.dataTransfer.files));
        }
    };

    return (
        <div
            className={`
                relative overflow-hidden rounded-[2rem] border-2 transition-all duration-300 group
                ${isDragging
                    ? 'border-indigo-500 bg-indigo-50/50 scale-[1.01] shadow-xl'
                    : 'border-slate-200 bg-white hover:border-indigo-200 hover:shadow-lg'
                }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Background Pattern */}
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[radial-gradient(#4f46e5_1px,transparent_1px)] [background-size:16px_16px]"></div>

            <div className="relative z-10 flex flex-col md:flex-row items-center justify-between p-8 gap-8">
                {/* Left: Text & Info */}
                <div className="flex-1 space-y-4">
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-indigo-600 font-bold text-xs uppercase tracking-wider">
                            <span className="px-2 py-1 bg-indigo-50 rounded-md">Analysis Engine</span>
                            {isLoading && <span className="animate-pulse">Processing...</span>}
                        </div>
                        <h2 className="text-3xl font-black text-slate-800 tracking-tight">
                            {isLoading ? '데이터 분석 중...' : '데이터 업로드'}
                        </h2>
                        <p className="text-slate-500 font-medium text-sm leading-relaxed max-w-lg">
                            분석할 엑셀 파일들을 이곳에 드래그하거나 선택해주세요.<br />
                            <span className="text-slate-400 text-xs">개별상담내역, 자원조정내역, 일반상담(접수상담대장), ISP수립정보, 팀구별 파일 + 등퇴록대장(선택 — 풀브리핑 퇴록자 제외용. MHIS에서 성인+아동청소년+기타를 모두 조회해 하나의 엑셀 파일로 합쳐서 첨부) (지원: .xlsx, .xls)</span>
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {['개별상담내역', '자원조정내역', '일반상담', 'ISP수립정보', '팀구별', '등퇴록대장'].map((tag, i) => (
                            <span key={i} className="px-2.5 py-1 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full border border-slate-200">
                                {tag}
                            </span>
                        ))}
                    </div>

                    <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5">
                        <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                        <p className="text-[11px] leading-relaxed text-amber-800 font-medium">
                            모든 엑셀 파일은 <span className="font-bold">Excel 통합 문서(*.xlsx)</span> 형식으로 저장한 뒤 업로드해 주세요.
                            다른 형식(한셀·CSV 등)으로 저장된 파일은 분석이 되지 않거나 오류가 발생할 수 있습니다.
                        </p>
                    </div>

                    <div className="flex items-center gap-3 pt-1">
                        <button
                            type="button"
                            onClick={downloadSampleExcelFiles}
                            className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-full shadow-md shadow-indigo-200 hover:bg-indigo-700 transition-all"
                        >
                            <Download size={14} />
                            샘플 양식 다운로드
                        </button>
                        <span className="text-[11px] text-slate-500 font-medium">처음 사용하시면 샘플 파일 6종을 내려받아 양식을 확인하세요.</span>
                    </div>
                </div>

                {/* Right: Action Button */}
                <div className="shrink-0 relative">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".xlsx, .xls"
                        onChange={handleFileChange}
                        className="hidden"
                        disabled={isLoading}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isLoading}
                        className={`
                            relative overflow-hidden flex flex-col items-center justify-center w-40 h-40 rounded-2xl transition-all duration-300
                            ${isLoading
                                ? 'bg-slate-100 cursor-not-allowed text-slate-400'
                                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xl shadow-indigo-200 hover:scale-105 active:scale-95'
                            }
                        `}
                    >
                        {isLoading ? (
                            <>
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-400 mb-2"></div>
                                <span className="text-xs font-bold">분석 중</span>
                            </>
                        ) : (
                            <>
                                <div className="mb-3 p-3 bg-white/20 rounded-xl backdrop-blur-sm">
                                    <FileSpreadsheet size={28} />
                                </div>
                                <span className="text-sm font-black">파일 선택</span>
                                <span className="text-[10px] opacity-70 mt-1 font-medium">또는 드래그 앤 드롭</span>
                            </>
                        )}
                    </button>

                    {/* Decorative Elements */}
                    {!isLoading && (
                        <div className="absolute -top-3 -right-3 w-8 h-8 bg-indigo-100 rounded-full animate-bounce delay-700 flex items-center justify-center text-indigo-600">
                            <FileUp size={14} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default FileUploadArea;

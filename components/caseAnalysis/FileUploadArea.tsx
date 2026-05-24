import React, { useRef, useState } from 'react';
import { Upload, FileUp, FileSpreadsheet, AlertCircle, CheckCircle2 } from 'lucide-react';

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
                            <span className="text-slate-400 text-xs">지원 형식: .xlsx, .xls</span>
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {['개별상담', '자원조정', '일반상담', '등퇴록', 'ISP', '팀구별'].map((tag, i) => (
                            <span key={i} className="px-2.5 py-1 bg-slate-100 text-slate-500 text-[10px] font-bold rounded-full border border-slate-200">
                                {tag}
                            </span>
                        ))}
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

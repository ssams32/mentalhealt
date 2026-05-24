import React, { useEffect, useState } from 'react';
import { X, Download, FileText, Loader2, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { Attachment } from '../../types';

interface FilePreviewModalProps {
    file: Attachment | null;
    onClose: () => void;
}

const FilePreviewModal: React.FC<FilePreviewModalProps> = ({ file, onClose }) => {
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [zoomLevel, setZoomLevel] = useState(1);

    useEffect(() => {
        if (!file) return;

        setIsLoading(true);
        setError(null);
        setPreviewUrl(null);
        setZoomLevel(1);

        const loadPreview = async () => {
            try {
                // If it's a Drive file with no data but has an ID, use Drive Preview
                if (!file.content && file.id && !file.url?.startsWith('blob:')) {
                    if (file.id.startsWith('att_')) {
                        setPreviewUrl(file.url || null);
                    } else {
                        setPreviewUrl(`https://drive.google.com/file/d/${file.id}/preview`);
                    }
                    setIsLoading(false);
                    return;
                }

                // If it has a blob URL (local preview)
                if (file.url && file.url.startsWith('blob:')) {
                    setPreviewUrl(file.url);
                    setIsLoading(false);
                    return;
                }

                // If it has Base64 Data
                if (file.content) {
                    const isFullDataUrl = file.content.startsWith('data:');
                    
                    if (file.type.startsWith('image/')) {
                        setPreviewUrl(isFullDataUrl ? file.content : `data:${file.type};base64,${file.content}`);
                    } else if (file.type === 'application/pdf') {
                        const base64Url = isFullDataUrl ? file.content : `data:application/pdf;base64,${file.content}`;
                        const base64Response = await fetch(base64Url);
                        const blob = await base64Response.blob();
                        const blobUrl = URL.createObjectURL(blob);
                        setPreviewUrl(blobUrl);
                    } else {
                        setError('미리보기를 지원하지 않는 파일 형식입니다.');
                    }
                } else if (file.url) {
                    setPreviewUrl(file.url);
                } else {
                    setError('파일 데이터를 찾을 수 없습니다.');
                }

            } catch (err) {
                console.error('Preview loading error:', err);
                setError('미리보기를 불러오는 중 오류가 발생했습니다.');
            } finally {
                setIsLoading(false);
            }
        };

        loadPreview();
    }, [file]);

    const handleDownload = () => {
        if (!file) return;
        if (file.url && file.url !== '#') {
            const link = document.createElement('a');
            link.href = file.url;
            link.download = file.name;
            link.click();
        } else if (file.content) {
            const isFullDataUrl = file.content.startsWith('data:');
            const link = document.createElement('a');
            link.href = isFullDataUrl ? file.content : `data:${file.type};base64,${file.content}`;
            link.download = file.name;
            link.click();
        }
    };

    const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 0.25, 4));
    const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 0.25, 0.5));
    const handleZoomReset = () => setZoomLevel(1);

    if (!file) return null;

    const isImage = file.type.startsWith('image/') || file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i);

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md p-4" onClick={onClose}>
            <div className="bg-transparent w-full max-w-6xl h-[90vh] flex flex-col items-center justify-center relative" onClick={e => e.stopPropagation()}>
                
                {/* Header Controls */}
                <div className="absolute top-0 right-0 p-4 z-20 flex items-center gap-2">
                    {isImage && (
                        <div className="flex items-center gap-1 bg-white/10 backdrop-blur-xl px-3 py-1.5 rounded-2xl border border-white/20 shadow-2xl mr-4">
                            <button 
                                onClick={handleZoomOut}
                                className="p-2 hover:bg-white/10 rounded-xl text-white transition-all active:scale-95"
                                title="축소"
                            >
                                <ZoomOut size={18} />
                            </button>
                            <button 
                                onClick={handleZoomReset}
                                className="px-3 py-1 hover:bg-white/10 rounded-xl text-white text-sm font-black transition-all active:scale-95"
                                title="초기화"
                            >
                                {Math.round(zoomLevel * 100)}%
                            </button>
                            <button 
                                onClick={handleZoomIn}
                                className="p-2 hover:bg-white/10 rounded-xl text-white transition-all active:scale-95"
                                title="확대"
                            >
                                <ZoomIn size={18} />
                            </button>
                        </div>
                    )}
                    <button onClick={onClose} className="p-2.5 bg-white/10 hover:bg-rose-500/80 rounded-2xl text-white backdrop-blur-xl border border-white/20 transition-all hover:rotate-90 active:scale-90 shadow-2xl">
                        <X size={24} />
                    </button>
                </div>

                {/* Main Viewport */}
                <div className="flex-1 w-full flex items-center justify-center overflow-hidden rounded-[32px] bg-slate-950/40 relative shadow-[0_35px_60px_-15px_rgba(0,0,0,0.6)] border border-white/5">
                    {isLoading ? (
                        <div className="flex flex-col items-center gap-4 text-white">
                            <Loader2 size={48} className="animate-spin text-blue-400" />
                            <p className="font-black text-sm tracking-widest uppercase opacity-50">Ingesting File...</p>
                        </div>
                    ) : error ? (
                        <div className="bg-white/95 backdrop-blur-xl p-12 rounded-[40px] flex flex-col items-center gap-6 text-center shadow-2xl border border-white">
                            <div className="w-20 h-20 bg-slate-50 flex items-center justify-center rounded-3xl">
                                <FileText size={40} className="text-slate-300" />
                            </div>
                            <div>
                                <h3 className="text-2xl font-black text-slate-800 mb-2">{file.name}</h3>
                                <p className="text-slate-500 font-bold">{error}</p>
                            </div>
                            <button onClick={handleDownload} className="px-8 py-3.5 bg-blue-600 text-white rounded-2xl font-black hover:bg-blue-700 transition-all flex items-center gap-2.5 shadow-xl shadow-blue-200 active:scale-95">
                                <Download size={20} />
                                <span>다운로드하여 확인하기</span>
                            </button>
                        </div>
                    ) : previewUrl ? (
                        previewUrl.includes('drive.google.com') ? (
                            <iframe src={previewUrl} className="w-full h-full bg-white" title="Drive Viewer" />
                        ) : file.type === 'application/pdf' || file.name.endsWith('.pdf') ? (
                            <iframe src={previewUrl} className="w-full h-full bg-white" title="PDF Viewer" />
                        ) : (
                            <div className="w-full h-full overflow-auto flex items-center justify-center cursor-move custom-scrollbar">
                                <img
                                    src={previewUrl}
                                    alt={file.name}
                                    style={{ transform: `scale(${zoomLevel})` }}
                                    className="max-w-[95%] max-h-[95%] object-contain transition-transform duration-300 ease-out"
                                />
                            </div>
                        )
                    ) : null}
                </div>

                {/* Footer Info & Download */}
                <div className="mt-8 px-8 py-3 bg-white/5 backdrop-blur-2xl rounded-full text-white/80 font-black text-xs flex items-center gap-6 border border-white/10 shadow-2xl">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 bg-blue-500 rounded-full"></div>
                        <span>{file.name}</span>
                    </div>
                    <span className="w-px h-3 bg-white/10"></span>
                    <button onClick={handleDownload} className="hover:text-blue-400 transition-all flex items-center gap-2 active:scale-90">
                        <Download size={14} />
                        Download Now
                    </button>
                    {isImage && (
                        <>
                            <span className="w-px h-3 bg-white/10"></span>
                            <div className="flex items-center gap-2 opacity-60">
                                <Maximize size={14} />
                                <span>Scroll to Pan</span>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default FilePreviewModal;

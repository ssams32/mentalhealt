import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, FileText, Image as ImageIcon, Trash2, Eye, Download, Search, Loader2 } from 'lucide-react';
// import { createWorker } from 'tesseract.js';
import { jsPDF } from 'jspdf';
import { OCR_KEYWORDS, MASKING_RULES } from '../../../config/ocrKeywords';
import { apiClient } from '../../../services/apiClient';

// Placeholder types - adjust based on your actual types
import { Attachment, ReferralNote as Note } from '../../../types';
interface DocumentAttachmentModalProps {
    isOpen: boolean;
    onClose: () => void;
    referralId?: string;
    currentUser: { name: string };
    onUpdateAttachments: (attachments: Attachment[]) => void;
    initialAttachments: Attachment[];
    folderType?: 'referral' | 'suicideAttempter';
    referralName?: string;
}

const DocumentAttachmentModal: React.FC<DocumentAttachmentModalProps> = ({
    isOpen,
    onClose,
    referralId,
    currentUser,
    onUpdateAttachments,
    initialAttachments = [],
    folderType = 'referral',
    referralName
}) => {
    const [activeTab, setActiveTab] = useState<'upload' | 'preview' | 'notes'>('upload');
    const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);

    // Update attachments when initialAttachments changes
    useEffect(() => {
        setAttachments(initialAttachments);
    }, [initialAttachments]);
    const [notes, setNotes] = useState<Note[]>([]);
    const [newNote, setNewNote] = useState('');
    const [selectedFile, setSelectedFile] = useState<Attachment | null>(null);
    const [ocrText, setOcrText] = useState<string>('');
    const [isOcrProcessing, setIsOcrProcessing] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    // Preview State
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewHtml, setPreviewHtml] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [zoomLevel, setZoomLevel] = useState(1); // Zoom state

    // Upload State
    const [isUploading, setIsUploading] = useState(false);
    const uploadCancelledRef = useRef(false);

    // Toast Logic
    useEffect(() => {
        if (toastMessage) {
            const timer = setTimeout(() => setToastMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toastMessage]);

    // Reset zoom when file changes
    useEffect(() => {
        setZoomLevel(1);
    }, [selectedFile]);

    // Preview Generation Logic
    useEffect(() => {
        const generatePreview = async () => {
            if (!selectedFile) return;

            setIsPreviewLoading(true);
            setPreviewUrl(null);
            setPreviewHtml(null);
            setPreviewError(null);

            try {
                // [NEW] Server File (Drive ID exists, Content is missing) -> Use Drive Preview
                if (!selectedFile.content && selectedFile.id) {
                    setPreviewUrl(`https://drive.google.com/file/d/${selectedFile.id}/preview`);
                    setIsPreviewLoading(false);
                    return;
                }

                // HWP/HWPX or Unknown format with Drive ID fallback
                const isHwp = selectedFile.name.toLowerCase().endsWith('.hwp') || selectedFile.name.toLowerCase().endsWith('.hwpx');

                if (selectedFile.type.startsWith('image/')) {
                    setPreviewUrl(selectedFile.content || null);
                } else if (selectedFile.type === 'application/pdf') {
                    // PDF Logic (Omitted for brevity - keep same)
                    // ... existing PDF logic ...
                    const pdfjsLib = (window as any).pdfjsLib;
                    if (!pdfjsLib) {
                        setPreviewError('PDF 뷰어 라이브러리를 로드할 수 없습니다.');
                        return;
                    }
                    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    if (!selectedFile.content) {
                        if (selectedFile.id) {
                            setPreviewUrl(`https://drive.google.com/file/d/${selectedFile.id}/preview`);
                            setIsPreviewLoading(false);
                            return;
                        }
                        setPreviewError('파일 데이터가 없습니다.');
                        return;
                    }
                    const loadingTask = pdfjsLib.getDocument(selectedFile.content);
                    const pdf = await loadingTask.promise;
                    const page = await pdf.getPage(1);
                    const viewport = page.getViewport({ scale: 1.5 });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    if (context) {
                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        setPreviewUrl(canvas.toDataURL());
                    }
                } else if (selectedFile.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                    // DOCX Logic (Keep same)
                    const mammoth = (window as any).mammoth;
                    if (!mammoth) {
                        setPreviewError('DOCX 뷰어 라이브러리를 로드할 수 없습니다.');
                        return;
                    }
                    if (!selectedFile.content) {
                        if (selectedFile.id) {
                            setPreviewUrl(`https://drive.google.com/file/d/${selectedFile.id}/preview`);
                            setIsPreviewLoading(false);
                            return;
                        }
                        setPreviewError('파일 데이터가 없습니다.');
                        return;
                    }
                    const base64 = selectedFile.content.split(',')[1];
                    const binaryString = window.atob(base64);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
                    setPreviewHtml(result.value);
                } else if (selectedFile.id) {
                    // Fallback to Drive Preview for HWP and other formats
                    setPreviewUrl(`https://drive.google.com/file/d/${selectedFile.id}/preview`);
                } else {
                    setPreviewError('이 파일 형식은 로컬 미리보기를 지원하지 않습니다. 구글 드라이브를 통해 확인해 주세요.');
                }
            } catch (error) {
                console.error('Preview generation failed:', error);
                setPreviewError('미리보기를 생성하는 중 오류가 발생했습니다.');
            } finally {
                setIsPreviewLoading(false);
            }
        };

        generatePreview();
    }, [selectedFile]);

    // Helper for GAS calls
    // Helper for GAS calls (Simplified - prioritizing apiClient)
    const runGAS = (funcName: string, ...args: any[]) => {
        // Use apiClient which already handles both Local and GAS environments correctly
        return (apiClient[funcName as keyof typeof apiClient] as any)(...args);
    };

    // File Upload Handler
    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;

        // Limit check removed for 'unlimited' experience, 
        // but keeping it very high to prevent memory issues if needed.
        // if (attachments.length + files.length > 100) { ... }

        setIsUploading(true);
        uploadCancelledRef.current = false;

        for (const file of Array.from(files) as File[]) {
            if (uploadCancelledRef.current) break;

            if (file.size > 50 * 1024 * 1024) { // 50MB for general files
                alert(`${file.name} 파일이 50MB를 초과합니다.`);
                continue;
            }

            try {
                const reader = new FileReader();
                const filePromise = new Promise<void>((resolve, reject) => {
                    reader.onload = async (e) => {
                        if (uploadCancelledRef.current) { resolve(); return; }

                        try {
                            const base64 = (e.target?.result as string).split(',')[1];
                            const result = await runGAS('uploadFile', {
                                base64: base64,
                                filename: file.name,
                                mimeType: file.type,
                                referralId: referralId,
                                referralName: referralName,
                                folderType: folderType
                            });

                            if (result && result.status === 'success') {
                                const newAttachment: Attachment = {
                                    id: result.fileId,
                                    name: result.filename,
                                    type: file.type,
                                    size: file.size,
                                    content: e.target?.result as string, // Keep local data for preview
                                    url: result.fileUrl,
                                    uploadedAt: new Date().toISOString()
                                };
                                setAttachments(prev => {
                                    const updated = [...prev, newAttachment];
                                    if (onUpdateAttachments) onUpdateAttachments(updated);
                                    return updated;
                                });
                            } else {
                                const errorMsg = result?.message || result?.error || '서버 오류 또는 로컬 환경 제한';
                                console.error('Upload failed:', result);
                                alert(`업로드 실패 (${file.name}): ${errorMsg}\n\n*로컬 환경(localhost)에서는 실제 업로드와 HWP 변환이 지원되지 않습니다. GAS에 배포 후 테스트해 주세요.`);
                            }
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    };
                    reader.onerror = reject;
                });
                reader.readAsDataURL(file);
                await filePromise;
            } catch (error) {
                console.error('File reading error:', error);
            }
        }
        setIsUploading(false);
        if (!uploadCancelledRef.current) setToastMessage('파일 업로드가 완료되었습니다.');
    };

    const handleCancelUpload = () => {
        if (window.confirm('업로드를 취소하시겠습니까?')) {
            uploadCancelledRef.current = true;
            setIsUploading(false);
        }
    };

    const handleDeleteAttachment = async (fileId: string) => {
        if (window.confirm('정말 삭제하시겠습니까? (Google Drive에서도 삭제됩니다)')) {
            try {
                // Call backend to delete from Drive
                const result = await runGAS('deleteFile', fileId);

                if (result.status === 'success') {
                    setAttachments(prev => prev.filter(f => f.id !== fileId));
                    // Update parent if callback provided
                    if (onUpdateAttachments) {
                        onUpdateAttachments(attachments.filter(f => f.id !== fileId));
                    }
                    setToastMessage('파일이 삭제되었습니다.');
                } else {
                    console.error('Delete failed:', result.message);
                    alert(`삭제 실패: ${result.message}`);
                }
            } catch (error) {
                console.error('Delete error:', error);
                alert('파일 삭제 중 오류가 발생했습니다.');
            }
        }
    };

    // OCR Handler
    const runOCR = async (file: Attachment) => {
        alert('OCR 기능은 현재 Google Apps Script 환경에서 지원되지 않습니다.');
        /*
        if (!file.data || !file.type.startsWith('image/')) return;

        setIsOcrProcessing(true);
        const worker = await createWorker('kor');
        const { data: { text } } = await worker.recognize(file.data);

        let processedText = text;
        // Masking
        MASKING_RULES.forEach(rule => {
            processedText = processedText.replace(rule.regex, rule.mask);
        });

        setOcrText(processedText);
        await worker.terminate();
        setIsOcrProcessing(false);
        */
    };

    // Note Handler
    const handleSaveNote = async () => {
        if (!newNote.trim()) return;

        const note: Note = {
            id: Math.random().toString(36).substr(2, 9),
            content: newNote,
            author: currentUser.name,
            createdAt: new Date().toLocaleString('ko-KR', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).replace(/\. /g, '.').replace(',', '')
        };

        // Save to backend
        if (referralId) {
            await runGAS('saveNotes', referralId, [note]);
        }

        setNotes(prev => [note, ...prev]);
        setNewNote('');
        setToastMessage('노트가 저장되었습니다.');
    };

    // Download Handler
    const handleDownload = (file: Attachment) => {
        if (file.type.startsWith('image/')) {
            const pdf = new jsPDF();
            const imgProps = pdf.getImageProperties(file.content!);
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
            pdf.addImage(file.content!, 'JPEG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(`${file.name.split('.')[0]}.pdf`);
        } else {
            // For other files, create a link and click it
            const link = document.createElement('a');
            link.href = file.content!;
            link.download = file.name;
            link.click();
        }
    };

    // Zoom Handlers
    const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 0.25, 3));
    const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 0.25, 0.5));
    const handleZoomReset = () => setZoomLevel(1);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in touch-none">
            <div className="bg-white rounded-2xl shadow-2xl w-[900px] h-[800px] flex flex-col overflow-hidden max-w-full max-h-full m-4">
                {/* Header */}
                <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                    <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                        <FileText className="text-blue-600" />
                        공문 및 서류 관리
                    </h2>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
                        <X size={20} className="text-slate-500" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-slate-100 px-4 overflow-x-auto">
                    {(['upload', 'preview', 'notes'] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-6 py-3 text-sm font-bold transition-colors relative whitespace-nowrap ${activeTab === tab ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
                                }`}
                        >
                            {tab === 'upload' && '파일 업로드/목록'}
                            {tab === 'preview' && '미리보기/OCR'}
                            {tab === 'notes' && '관리 노트'}
                            {activeTab === tab && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-t-full" />
                            )}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden p-6 bg-slate-50/30 relative">
                    {/* Upload Loading Overlay */}
                    {isUploading && (
                        <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                            <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
                            <p className="text-lg font-bold text-slate-800 mb-4">파일 업로드 중...</p>
                            <button
                                onClick={handleCancelUpload}
                                className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-bold hover:bg-slate-300 transition"
                            >
                                취소
                            </button>
                        </div>
                    )}

                    {activeTab === 'upload' && (
                        <div className="h-full flex flex-col gap-6">
                            {/* Upload Area */}
                            <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 flex flex-col items-center justify-center bg-white hover:bg-slate-50 transition-colors cursor-pointer group relative">
                                <input
                                    type="file"
                                    multiple
                                    accept=".pdf"
                                    onChange={handleFileUpload}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                    <Upload className="text-blue-600" size={32} />
                                </div>
                                <p className="text-lg font-bold text-slate-700">PDF 파일을 드래그하거나 클릭하여 업로드</p>
                                <p className="text-sm text-slate-400 mt-2">공식 문서(PDF)만 업로드 가능 (개당 최대 50MB)</p>
                            </div>

                            {/* File List */}
                            <div className="flex-1 overflow-y-auto space-y-3">
                                {attachments.map(file => (
                                    <div key={file.id} className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between shadow-sm hover:shadow-md transition-shadow">
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
                                                {file.type.includes('image') ? <ImageIcon size={20} className="text-purple-500" /> : <FileText size={20} className="text-blue-500" />}
                                            </div>
                                            <div>
                                                <p className="font-bold text-slate-700">{file.name}</p>
                                                <p className="text-xs text-slate-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => { setSelectedFile(file); setActiveTab('preview'); }}
                                                className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"
                                                title="미리보기"
                                            >
                                                <Eye size={18} />
                                            </button>
                                            <button
                                                onClick={() => handleDeleteAttachment(file.id)}
                                                className="p-2 hover:bg-red-50 text-red-500 rounded-lg transition-colors"
                                                title="삭제"
                                            >
                                                <Trash2 size={18} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {attachments.length === 0 && (
                                    <div className="text-center text-slate-400 py-10">
                                        업로드된 파일이 없습니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'preview' && (
                        <div className="h-full flex flex-col lg:flex-row gap-6">
                            {/* File List Sidebar */}
                            <div className="w-full lg:w-64 border-r border-slate-200 pr-4 overflow-y-auto max-h-[200px] lg:max-h-full">
                                <h3 className="font-bold text-slate-700 mb-4">파일 목록</h3>
                                <div className="space-y-2">
                                    {attachments.map(file => (
                                        <button
                                            key={file.id}
                                            onClick={() => { setSelectedFile(file); setOcrText(''); }}
                                            className={`w-full text-left p-3 rounded-xl transition-all ${selectedFile?.id === file.id
                                                ? 'bg-blue-50 text-blue-700 border-blue-200 border'
                                                : 'hover:bg-white text-slate-600'
                                                }`}
                                        >
                                            <div className="truncate font-medium">{file.name}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Preview Area */}
                            <div className="flex-1 flex flex-col bg-white rounded-2xl border border-slate-200 overflow-hidden">
                                {selectedFile ? (
                                    <>
                                        <div className="p-3 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                                            <div className="flex gap-2">
                                                {/* Zoom Controls - Hide for Drive Preview (it has built-in controls) */}
                                                {(!previewUrl?.includes('drive.google.com') && (selectedFile.type.startsWith('image/') || selectedFile.type === 'application/pdf')) && (
                                                    <div className="flex items-center bg-slate-100 rounded-lg p-1 mr-2">
                                                        <button onClick={handleZoomOut} className="p-1.5 hover:bg-white rounded-md transition-colors text-slate-600" title="축소">
                                                            <i className="fas fa-minus text-xs"></i>
                                                        </button>
                                                        <span className="text-xs font-mono w-12 text-center text-slate-600">{Math.round(zoomLevel * 100)}%</span>
                                                        <button onClick={handleZoomIn} className="p-1.5 hover:bg-white rounded-md transition-colors text-slate-600" title="확대">
                                                            <i className="fas fa-plus text-xs"></i>
                                                        </button>
                                                        <button onClick={handleZoomReset} className="p-1.5 hover:bg-white rounded-md transition-colors text-slate-600 ml-1" title="초기화">
                                                            <i className="fas fa-undo text-xs"></i>
                                                        </button>
                                                    </div>
                                                )}

                                                {selectedFile.type.startsWith('image/') && (
                                                    <button
                                                        onClick={() => runOCR(selectedFile)}
                                                        disabled={isOcrProcessing}
                                                        className="px-3 py-1.5 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                                                    >
                                                        <Search size={14} />
                                                        {isOcrProcessing ? 'OCR 분석 중...' : 'OCR 텍스트 추출'}
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => handleDownload(selectedFile)}
                                                    className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 text-sm font-bold rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-2"
                                                >
                                                    <Download size={14} />
                                                    다운로드
                                                </button>
                                            </div>
                                        </div>

                                        <div className="flex-1 overflow-auto p-4 relative">
                                            {isPreviewLoading ? (
                                                <div className="flex items-center justify-center h-full flex-col gap-4">
                                                    <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
                                                    <p className="text-slate-500">미리보기를 불러오는 중...</p>
                                                </div>
                                            ) : previewError ? (
                                                <div className="flex items-center justify-center h-full flex-col gap-4 text-slate-400">
                                                    <FileText size={64} />
                                                    <p className="text-center">{previewError}<br />다운로드하여 확인해주세요.</p>
                                                </div>
                                            ) : previewUrl ? (
                                                <div className="flex flex-col lg:flex-row gap-4 h-full">
                                                    <div className="flex-1 overflow-auto bg-slate-100 rounded-lg flex items-start justify-center min-h-[300px] p-4">
                                                        {previewUrl.includes('drive.google.com') ? (
                                                            <iframe
                                                                src={previewUrl}
                                                                className="w-full h-full border-none rounded-lg"
                                                                allow="autoplay"
                                                            />
                                                        ) : (
                                                            <img
                                                                src={previewUrl}
                                                                alt="Preview"
                                                                className="shadow-lg transition-all duration-200 ease-in-out"
                                                                style={{
                                                                    width: `${zoomLevel * 100}%`,
                                                                    maxWidth: 'none',
                                                                    height: 'auto'
                                                                }}
                                                            />
                                                        )}
                                                    </div>
                                                    {ocrText && (
                                                        <div className="w-full lg:w-1/2 bg-slate-50 p-4 rounded-lg border border-slate-200 overflow-auto whitespace-pre-wrap font-mono text-sm leading-relaxed h-[300px] lg:h-auto">
                                                            {ocrText.split(new RegExp(`(${OCR_KEYWORDS.map(k => k.keyword).join('|')})`, 'g')).map((part, i) => {
                                                                const keywordMatch = OCR_KEYWORDS.find(k => k.keyword === part);
                                                                return keywordMatch ? (
                                                                    <span key={i} style={{ backgroundColor: keywordMatch.color }} className="px-1 rounded font-bold">
                                                                        {part}
                                                                    </span>
                                                                ) : part;
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            ) : previewHtml ? (
                                                <div className="w-full h-full bg-white p-8 overflow-auto prose max-w-none" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                                            ) : (
                                                <div className="flex items-center justify-center h-full text-slate-400 flex-col gap-4">
                                                    <FileText size={64} />
                                                    <p>미리보기를 생성할 수 없습니다.</p>
                                                </div>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-slate-400">
                                        파일을 선택해주세요.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'notes' && (
                        <div className="h-full flex flex-col gap-4">
                            <div className="bg-[#fffde7] p-4 rounded-xl border border-yellow-200 shadow-sm flex-1 flex flex-col min-h-[200px]">
                                <textarea
                                    value={newNote}
                                    onChange={(e) => setNewNote(e.target.value)}
                                    placeholder="관리 내용을 입력하세요..."
                                    className="w-full h-full bg-transparent border-none resize-none focus:ring-0 text-slate-700 placeholder-slate-400"
                                />
                                <div className="flex justify-end mt-2">
                                    <button
                                        onClick={handleSaveNote}
                                        className="px-4 py-2 bg-yellow-400 text-yellow-900 font-bold rounded-lg hover:bg-yellow-500 transition-colors shadow-sm"
                                    >
                                        노트 저장
                                    </button>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto space-y-3 pr-2 max-h-[300px]">
                                {notes.map(note => (
                                    <div key={note.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="font-bold text-slate-700">{note.author}</span>
                                            <span className="text-xs text-slate-400 font-mono">{note.createdAt}</span>
                                        </div>
                                        <p className="text-slate-600 whitespace-pre-wrap">{note.content}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Toast */}
            {toastMessage && (
                <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-6 py-3 rounded-full shadow-lg animate-slide-in-bottom z-[60]">
                    {toastMessage}
                </div>
            )}
        </div>
    );
};

export default DocumentAttachmentModal;

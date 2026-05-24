import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Referral, SuicideAttempterReferral, Attachment, User, ReferralNote } from '../../types';

declare var pdfjsLib: any;
declare var mammoth: any;
declare var Tesseract: any;

type Item = Referral | SuicideAttempterReferral;

interface AttachmentModalProps {
    item: Item;
    onClose: () => void;
    onUpdateAttachments: (itemId: string, updatedAttachments: Attachment[]) => void;
    showToast: (message: string) => void;
    currentUser: User;
}

// OCR 및 하이라이팅을 위한 키워드 정의
const KEYWORD_MAP: { [key: string]: string[] } = {
    '#ff6b6b': ['자살', '자살충동', '자살위험', '자살시도', '자해', '자포자기', '자살예방', '자살고위험군'],
    '#ffa726': ['조증', '조현병', '망상', '환청', '환각', '공격성', '폭력', '학대', '성폭력', '강박', '공황', 'PTSD', '트라우마'],
    '#fff59d': ['우울', '불안', '무기력', '무가치감', '고립', '집중력저하', '기분변화', '불면', '자기혐오', '소외'],
    '#c6ff9d': ['알코올', '중독', '마약', '도박', '가족갈등', '가정폭력', '경제적어려움'],
    '#6bc1ff': ['자원연계', '자원지원', '지역자원', '치료연계', '프로그램'],
};

// 파일 타입별 아이콘 매핑
const getFileIcon = (type: string): string => {
    if (type.includes('pdf')) return 'fa-file-pdf';
    if (type.includes('word') || type.includes('docx')) return 'fa-file-word';
    if (type.includes('image')) return 'fa-file-image';
    if (type.includes('hwp')) return 'fa-file-alt'; // 한글 아이콘 (대체)
    return 'fa-file';
};

/**
 * 모든 탭에서 공용으로 사용하는 첨부파일 관리 모달입니다.
 * OCR, 키워드 하이라이팅, 개인정보 마스킹, 파일별 노트 등 고급 기능을 제공합니다.
 */
const AttachmentModal: React.FC<AttachmentModalProps> = ({ item, onClose, onUpdateAttachments, showToast, currentUser }) => {
    const [files, setFiles] = useState<Attachment[]>(item.attachments || []);
    const [selectedFile, setSelectedFile] = useState<Attachment | null>(files.length > 0 ? files[0] : null);
    const [isProcessing, setIsProcessing] = useState(false);
    // 텍스트 분석 결과 저장 상태
    const [analysisResult, setAnalysisResult] = useState<string | null>(null);
    // PDF 페이지 렌더링 결과(이미지 URL 배열) 저장 상태
    const [pdfPages, setPdfPages] = useState<string[]>([]);
    // HWP 파일 여부 상태
    const [isHwp, setIsHwp] = useState(false);
    const [newNote, setNewNote] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const itemId = 'refNo' in item ? item.refNo : item.uid;

    /**
     * 텍스트에서 키워드를 찾아 하이라이팅하고 개인정보를 마스킹합니다.
     * @param text 원본 텍스트
     * @returns HTML 문자열
     */
    const highlightAndMaskText = useCallback((text: string): string => {
        let processedText = text;

        // 1. 개인정보 마스킹
        const rrnRegex = /\d{6}[- ]?[1-4]\d{6}/g;
        const phoneRegex = /\d{2,3}[- ]?\d{3,4}[- ]?\d{4}/g;
        processedText = processedText.replace(rrnRegex, '***');
        processedText = processedText.replace(phoneRegex, '***');
        // 대상자 이름 마스킹
        if (item.name) {
            const nameRegex = new RegExp(item.name, 'g');
            processedText = processedText.replace(nameRegex, '***');
        }

        // 2. 키워드 하이라이팅
        const allKeywords = Object.values(KEYWORD_MAP).flat();
        const keywordRegex = new RegExp(`(${allKeywords.join('|')})`, 'g');

        processedText = processedText.replace(keywordRegex, (match) => {
            let color = '';
            for (const c in KEYWORD_MAP) {
                if (KEYWORD_MAP[c].includes(match)) {
                    color = c;
                    break;
                }
            }
            return `<span style="background-color: ${color}; padding: 1px 2px; border-radius: 3px; font-weight: bold;">${match}</span>`;
        });

        return processedText.replace(/\n/g, '<br />');
    }, [item.name]);

    /**
     * 선택된 파일을 파싱하고 미리보기 컨텐츠를 생성합니다.
     * @param file 처리할 파일 객체
     */
    const processFile = useCallback(async (file: Attachment) => {
        if (!file.content) {
            setAnalysisResult('미리보기를 생성할 파일 내용이 없습니다.');
            return;
        }
        setIsProcessing(true);
        setAnalysisResult("파일을 분석하고 뷰어를 준비 중입니다...");
        setPdfPages([]);
        setIsHwp(false);

        try {
            let rawText = '';
            if (file.type.includes('pdf')) {
                if (typeof pdfjsLib === 'undefined' || !pdfjsLib.getDocument) {
                    throw new Error("PDF 라이브러리(pdf.js)를 불러오지 못했습니다. 페이지를 새로고침 해보세요.");
                }
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

                const pdfData = await fetch(`data:application/pdf;base64,${file.content}`).then(res => res.arrayBuffer());
                const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfData) }).promise;

                const renderedPageUrls: string[] = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const scale = 1.5;
                    const viewport = page.getViewport({ scale });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    await page.render({ canvasContext: context!, viewport }).promise;
                    renderedPageUrls.push(canvas.toDataURL());

                    const textContent = await page.getTextContent();
                    rawText += textContent.items.map((item: any) => item.str).join(' ') + '\n';
                }
                setPdfPages(renderedPageUrls);
                setAnalysisResult(highlightAndMaskText(rawText));

            } else if (file.type.includes('docx')) {
                const arrayBuffer = await fetch(`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${file.content}`).then(res => res.arrayBuffer());
                const result = await mammoth.extractRawText({ arrayBuffer });
                rawText = result.value;
                setAnalysisResult(highlightAndMaskText(rawText));
            } else if (file.type.includes('image')) {
                const worker = Tesseract.createWorker();
                await worker.load();
                await worker.loadLanguage('kor+eng');
                await worker.initialize('kor+eng');
                const { data: { text } } = await worker.recognize(`data:${file.type};base64,${file.content}`);
                rawText = text;
                setAnalysisResult(highlightAndMaskText(rawText));
                await worker.terminate();
            } else if (file.type.includes('hwp')) {
                setIsHwp(true);
                setAnalysisResult('');
            } else {
                setAnalysisResult("지원하지 않는 파일 형식입니다.");
            }
        } catch (error: any) {
            console.error("File processing error:", error);
            setAnalysisResult(`파일 처리 중 오류: <pre class="text-xs text-red-500">${error.message}</pre>`);
        } finally {
            setIsProcessing(false);
        }
    }, [highlightAndMaskText]);

    useEffect(() => {
        if (selectedFile) {
            processFile(selectedFile);
        } else {
            setIsProcessing(false);
            setAnalysisResult(null);
            setPdfPages([]);
            setIsHwp(false);
        }
    }, [selectedFile, processFile]);


    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (files.length >= 5) {
            alert("최대 5개의 파일만 첨부할 수 있습니다.");
            return;
        }
        if (file.size > 10 * 1024 * 1024) { // 10MB
            alert("파일 크기는 10MB를 초과할 수 없습니다.");
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const base64Content = (event.target?.result as string).split(',')[1];
            const newFile: Attachment = {
                id: `local_${Date.now()}`,
                name: file.name,
                url: '#',
                type: file.type || 'application/octet-stream',
                content: base64Content,
                notes: [],
                size: file.size,
                uploadedAt: new Date().toISOString(),
            };

            const updatedFiles = [...files, newFile];
            setFiles(updatedFiles);
            onUpdateAttachments(itemId, updatedFiles);
            showToast("공문 첨부됨! 드라이브에 저장됐어요");
            setSelectedFile(newFile);
        };
        reader.readAsDataURL(file);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleDeleteFile = (fileId: string) => {
        if (!window.confirm("정말로 이 파일을 삭제하시겠습니까? 노트도 함께 삭제됩니다.")) return;
        const updatedFiles = files.filter(f => f.id !== fileId);
        setFiles(updatedFiles);
        onUpdateAttachments(itemId, updatedFiles);
        if (selectedFile?.id === fileId) {
            setSelectedFile(updatedFiles.length > 0 ? updatedFiles[0] : null);
        }
    };

    const handleAddNote = () => {
        if (!newNote.trim() || !selectedFile) return;
        const note: ReferralNote = {
            id: `note_${Date.now()}`,
            content: newNote,
            author: currentUser.name,
            createdAt: new Date().toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        };
        const updatedFiles = files.map(f => f.id === selectedFile.id ? { ...f, notes: [note, ...(f.notes || [])] } : f);
        setFiles(updatedFiles);
        onUpdateAttachments(itemId, updatedFiles);
        setSelectedFile(prev => prev ? updatedFiles.find(f => f.id === prev.id) || null : null);
        setNewNote('');
    };

    return (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-6xl h-[90vh] p-8 flex flex-col border border-white/50 animate-scale-in">
                <div className="flex-shrink-0 flex justify-between items-center border-b border-slate-100 pb-4 mb-6">
                    <div>
                        <h3 className="text-xl font-extrabold text-slate-900">첨부파일 상세 관리</h3>
                        <p className="text-sm text-slate-400 font-medium">{item.name} 님의 파일</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition">
                        <i className="fas fa-times"></i>
                    </button>
                </div>
                <div className="flex-1 flex gap-6 overflow-hidden">
                    <div className="w-1/4 flex flex-col space-y-4">
                        <div className="flex justify-between items-center">
                            <h4 className="font-bold text-slate-600">파일 목록</h4>
                            <span className="text-sm font-bold text-slate-400">{files.length} / 5</span>
                        </div>
                        <div className="flex-1 overflow-y-auto pr-2 space-y-2">
                            {files.map(file => (
                                <div key={file.id} onClick={() => setSelectedFile(file)} className={`p-3 rounded-xl flex items-center gap-3 cursor-pointer transition ${selectedFile?.id === file.id ? 'bg-blue-100' : 'bg-slate-50 hover:bg-slate-100'}`}>
                                    <div className={`w-8 h-8 flex-shrink-0 rounded-lg flex items-center justify-center text-sm ${selectedFile?.id === file.id ? 'bg-blue-500 text-white' : 'bg-white text-slate-500'}`}><i className={`fas ${getFileIcon(file.type)}`}></i></div>
                                    <div className="flex-1 truncate">
                                        <p className="text-sm font-bold text-slate-800 truncate">{file.name}</p>
                                        <p className="text-xs text-slate-400">{file.notes?.length || 0}개 노트</p>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); handleDeleteFile(file.id); }} className="text-slate-300 hover:text-red-500 p-1"><i className="fas fa-trash-alt text-xs"></i></button>
                                </div>
                            ))}
                        </div>
                        <div className="flex-shrink-0">
                            <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".pdf,.docx,.hwp,.jpg,.jpeg,.png" className="hidden" id="file-upload-advanced" />
                            <label htmlFor="file-upload-advanced" className={`w-full flex items-center justify-center space-x-2 py-3 rounded-xl cursor-pointer transition shadow-md ${files.length >= 5 ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-slate-800'}`}><i className="fas fa-plus"></i><span className="font-bold text-sm">파일 추가</span></label>
                        </div>
                    </div>

                    <div className="w-1/2 bg-slate-50 rounded-2xl flex flex-col p-4 border border-slate-100">
                        {selectedFile ? (
                            <>
                                <div className="flex-shrink-0 pb-3 border-b border-slate-200 mb-3"><p className="font-bold text-slate-800 truncate">{selectedFile.name}</p></div>
                                <div className="flex-1 overflow-y-auto p-2">
                                    {isProcessing ? (
                                        <div className="flex items-center justify-center h-full text-slate-400"><i className="fas fa-spinner fa-spin mr-2"></i> 파일을 분석하고 뷰어를 준비 중입니다...</div>
                                    ) : (
                                        <>
                                            {pdfPages.length > 0 && (
                                                <div className="space-y-4">
                                                    {pdfPages.map((pageUrl, index) => <img key={index} src={pageUrl} alt={`Page ${index + 1}`} className="max-w-full h-auto shadow-md border border-slate-200" />)}
                                                </div>
                                            )}
                                            {isHwp ? (
                                                <div className="p-4 text-center"><i className="fas fa-file-alt text-4xl text-slate-300 mb-4"></i><h4 className="font-bold text-slate-700">HWP 파일 미리보기</h4><p className="text-xs text-slate-500 mt-1 mb-4">HWP 파일은 브라우저에서 직접 미리보기를 지원하지 않습니다.<br />PDF로 변환하여 보거나 원본 파일을 다운로드하세요.</p><div className="flex gap-2 justify-center"><button className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-bold">PDF로 다운로드</button><button className="px-3 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-bold">원본(HWP) 다운로드</button></div></div>
                                            ) : null}

                                            {(analysisResult && (pdfPages.length > 0 || !isHwp)) && (
                                                <div className={pdfPages.length > 0 ? "mt-6 pt-4 border-t border-slate-200" : ""}>
                                                    <h5 className="font-bold text-slate-800 mb-2">텍스트 분석 결과</h5>
                                                    <div className="text-sm leading-relaxed text-slate-700" dangerouslySetInnerHTML={{ __html: analysisResult }} />
                                                </div>
                                            )}

                                            {!isProcessing && !analysisResult && !pdfPages.length && !isHwp && '선택된 파일이 없거나 미리보기를 지원하지 않습니다.'}
                                        </>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400"><i className="fas fa-file-import text-3xl mb-2"></i><p className="font-bold text-sm">파일을 선택하여 미리보세요.</p></div>
                        )}
                    </div>

                    <div className="w-1/4 flex flex-col bg-[#fffde7] rounded-2xl p-4 border border-amber-100">
                        {selectedFile ? (
                            <>
                                <h4 className="flex-shrink-0 font-bold text-amber-800 pb-3 border-b border-amber-200/50 mb-3">파일 노트</h4>
                                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                                    {(selectedFile.notes || []).map(note => (
                                        <div key={note.id} className="bg-white/50 p-3 rounded-lg"><p className="text-xs text-slate-700 whitespace-pre-wrap">{note.content}</p><p className="text-right text-[10px] text-slate-400 font-semibold mt-2">{note.author} - {note.createdAt}</p></div>
                                    ))}
                                </div>
                                <div className="flex-shrink-0 pt-3 border-t border-amber-200/50"><textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} rows={3} placeholder="여기에 노트 작성..." className="w-full text-xs p-2 rounded-lg border-amber-200/50 bg-white/50 focus:ring-1 focus:ring-amber-400 outline-none resize-none"></textarea><button onClick={handleAddNote} className="w-full mt-2 py-2 bg-amber-400 text-white rounded-lg font-bold text-xs hover:bg-amber-500">노트 저장</button></div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-amber-600/50"><i className="fas fa-lightbulb text-3xl mb-2"></i><p className="font-bold text-sm">파일을 선택하여 노트를 확인하세요.</p></div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AttachmentModal;
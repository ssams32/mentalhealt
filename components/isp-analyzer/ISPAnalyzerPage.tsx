import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Upload, FileText, CheckCircle, AlertCircle, Play, Download, Lock } from 'lucide-react';

interface AnalysisResult {
    id: string;
    goal: string;
    activities: string;
    AI_Evaluation: string;
    AI_Reason: string;
}

export const ISPAnalyzerPage: React.FC = () => {
    const [apiKey, setApiKey] = useState('');
    const [ispData, setIspData] = useState<any[]>([]);
    const [counselData, setCounselData] = useState<any[]>([]);
    const [status, setStatus] = useState<'idle' | 'processing' | 'completed'>('idle');
    const [progress, setProgress] = useState(0);
    const [currentId, setCurrentId] = useState('');
    const [estimatedTime, setEstimatedTime] = useState('');
    const [logs, setLogs] = useState<{ msg: string; type: 'info' | 'error' | 'success' }[]>([]);
    const [results, setResults] = useState<AnalysisResult[]>([]);

    // Security Map (kept in ref to persist without re-render issues, though state is fine too)
    const securityMap = useRef<Map<string, string>>(new Map());
    const reverseMap = useRef<Map<string, string>>(new Map());
    const idCounter = useRef(0);

    const log = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
        setLogs(prev => [...prev, { msg, type }]);
    };

    const handleFile = async (e: React.ChangeEvent<HTMLInputElement>, type: 'ISP' | 'COUNSEL') => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const data = await readExcel(file);
            if (type === 'ISP') {
                setIspData(data);
                log(`Loaded ISP file: ${data.length} records.`, 'success');
            } else {
                setCounselData(data);
                log(`Loaded Counsel file: ${data.length} records.`, 'success');
            }
        } catch (err: any) {
            log(`Error reading file: ${err.message}`, 'error');
        }
    };

    const readExcel = (file: File): Promise<any[]> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target?.result as ArrayBuffer);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
                    resolve(jsonData);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    };

    const preprocessData = () => {
        const counselMap: Record<string, any[]> = {};
        counselData.forEach(row => {
            const name = (row['회원명'] || '').trim();
            if (!name) return;
            if (!counselMap[name]) counselMap[name] = [];
            counselMap[name].push(row);
        });

        const workList: any[] = [];
        securityMap.current.clear();
        reverseMap.current.clear();
        idCounter.current = 0;

        ispData.forEach(row => {
            const name = (row['이름'] || '').trim();
            if (!name) return;

            if (!securityMap.current.has(name)) {
                idCounter.current++;
                const newId = `ID_${String(idCounter.current).padStart(3, '0')}`;
                securityMap.current.set(name, newId);
                reverseMap.current.set(newId, name);
            }
            const anonId = securityMap.current.get(name);
            const matches = counselMap[name] || [];

            // Format dates simply
            const activities = matches.map(m => {
                let dateStr = m['상담일자'] || '-';
                // Try to handle Excel date numbers if applicable, but basic string assumption for now
                return `[${dateStr}] ${m['상담주제'] || ''}: ${m['상담내용'] || ''}`;
            }).join(' / ');

            workList.push({
                id: anonId,
                goal: row['ISP결과'] || row['장단기 목표수립'] || '목표 없음',
                activities: activities || '상담 기록 없음'
            });
        });

        return workList;
    };

    const callGemini = async (item: any) => {
        const prompt = `
            내담자 ID: ${item.id}
            ISP 목표: ${item.goal}
            실제 개입 내용: ${item.activities}

            위 내용을 비교하여 개입이 목표 달성에 기여하고 있는지 평가하시오.
            1. 판정: (적절 / 미흡 / 부적절 / 판단불가) 중 택 1
            2. 이유: 30년 차 전문가의 말투로 1문장 요약 (누락된 자원이나 빈약한 상담 내용을 구체적으로 지적할 것)
            
            형식 예시:
            판정: 적절
            이유: 내담자의 욕구에 맞춰 ~한 지원이 적절히 이루어짐.
        `;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            if (response.status === 429) throw new Error("Rate Limit Exceeded");
            throw new Error(`API Error ${response.status}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        let judgment = "판단불가";
        let reason = text;

        const lines = text.split('\n');
        lines.forEach((line: string) => {
            if (line.includes('판정:')) judgment = line.split('판정:')[1].trim();
            if (line.includes('이유:')) reason = line.split('이유:')[1].trim();
        });

        return { judgment, reason };
    };

    const startAnalysis = async () => {
        if (!apiKey) return alert('API Key를 입력해주세요.');
        if (ispData.length === 0 || counselData.length === 0) return alert('파일을 모두 업로드해주세요.');

        setStatus('processing');
        setProgress(0);
        setResults([]);
        setLogs([]); // Clear previous logs
        log('Starting analysis...', 'info');

        const workList = preprocessData();
        if (workList.length === 0) {
            alert('매칭되는 데이터가 없습니다.');
            setStatus('idle');
            return;
        }

        const total = workList.length;
        const totalSeconds = total * 4;
        setEstimatedTime(`약 ${Math.ceil(totalSeconds / 60)}분 ${totalSeconds % 60}초`);

        for (let i = 0; i < total; i++) {
            const item = workList[i];
            setCurrentId(item.id);

            // Progress Update
            const pct = Math.round(((i + 1) / total) * 100);
            setProgress(pct);
            const remaining = (total - 1 - i) * 4;
            setEstimatedTime(`남은 시간: 약 ${Math.ceil(remaining / 60)}분 ${remaining % 60}초`);

            try {
                const aiResult = await callGemini(item);
                const resultRecord: AnalysisResult = {
                    id: item.id,
                    goal: item.goal,
                    activities: item.activities,
                    AI_Evaluation: aiResult.judgment,
                    AI_Reason: aiResult.reason
                };
                setResults(prev => [...prev, resultRecord]);
                log(`Processed ${item.id}: ${aiResult.judgment}`, 'success');
            } catch (err: any) {
                log(`Failed ${item.id}: ${err.message}`, 'error');
                setResults(prev => [...prev, {
                    id: item.id,
                    goal: item.goal,
                    activities: item.activities,
                    AI_Evaluation: 'Error',
                    AI_Reason: err.message
                }]);
            }

            // Rate Limiting
            if (i < total - 1) {
                await new Promise(r => setTimeout(r, 4000));
            }
        }

        setStatus('completed');
        log('Analysis completed successfully.', 'success');
    };

    const downloadResults = () => {
        const ws = XLSX.utils.json_to_sheet(results);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Analysis_Result");
        XLSX.writeFile(wb, "ISP_Analysis_Anonymous.xlsx");
    };

    const downloadSecuritykey = () => {
        const mapArray: any[] = [];
        reverseMap.current.forEach((name, id) => {
            mapArray.push({ 'ID': id, 'Real_Name': name });
        });
        const ws = XLSX.utils.json_to_sheet(mapArray);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Security_Key");
        XLSX.writeFile(wb, "ISP_Security_Key_Confidential.xlsx");
    };

    return (
        <div className="min-h-screen p-8 bg-gradient-to-br from-slate-900 to-slate-800 text-white overflow-y-auto">
            <div className="max-w-5xl mx-auto space-y-8">

                {/* Header */}
                <header className="text-center space-y-2">
                    <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-300 to-indigo-300">
                        ISP 이행 적절성 AI 정밀 분석기
                    </h1>
                    <p className="text-slate-400 text-sm">Secure & Private Analysis powered by Gemini</p>
                </header>

                {/* API Key */}
                <div className="bg-white/5 backdrop-blur-lg border border-white/10 rounded-xl p-6">
                    <label className="block text-sm font-medium text-slate-300 mb-2">Google Gemini API Key</label>
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full bg-black/20 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 transition-colors"
                    />
                    <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                        <Lock size={12} /> 키는 저장되지 않으며, 현재 세션의 메모리에서만 사용됩니다.
                    </p>
                </div>

                {/* File Uploads */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* ISP */}
                    <div className="bg-white/5 backdrop-blur-lg border border-white/10 rounded-xl p-6 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3 text-blue-300 mb-4">
                            <FileText />
                            <h3 className="font-semibold">1. ISP 파일 업로드</h3>
                        </div>
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-600 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-black/20 transition-all">
                            <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <Upload className="w-8 h-8 mb-2 text-slate-400" />
                                <p className="text-sm text-slate-400">클릭하여 파일 선택 (Excel)</p>
                            </div>
                            <input type="file" className="hidden" accept=".xlsx, .xls" onChange={(e) => handleFile(e, 'ISP')} />
                        </label>
                        {ispData.length > 0 && <p className="text-blue-400 text-xs mt-2 text-center">✅ {ispData.length}명 로드됨</p>}
                    </div>

                    {/* Counsel */}
                    <div className="bg-white/5 backdrop-blur-lg border border-white/10 rounded-xl p-6 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3 text-green-300 mb-4">
                            <FileText />
                            <h3 className="font-semibold">2. 상담/자원 파일 업로드</h3>
                        </div>
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-600 rounded-lg cursor-pointer hover:border-green-500 hover:bg-black/20 transition-all">
                            <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <Upload className="w-8 h-8 mb-2 text-slate-400" />
                                <p className="text-sm text-slate-400">클릭하여 파일 선택 (Excel)</p>
                            </div>
                            <input type="file" className="hidden" accept=".xlsx, .xls" onChange={(e) => handleFile(e, 'COUNSEL')} />
                        </label>
                        {counselData.length > 0 && <p className="text-green-400 text-xs mt-2 text-center">✅ {counselData.length}건 로드됨</p>}
                    </div>
                </div>

                {/* Processing Status */}
                {status !== 'idle' && (
                    <div className="bg-black/30 rounded-xl p-6 border border-white/10 space-y-4">
                        <div className="flex justify-between items-center text-sm">
                            <span className="font-medium text-violet-300">
                                {status === 'completed' ? '분석 완료' : `분석 중... ${currentId}`}
                            </span>
                            <span className="font-mono text-slate-400">{estimatedTime}</span>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                            <div
                                className="bg-gradient-to-r from-blue-500 to-purple-500 h-4 rounded-full transition-all duration-300"
                                style={{ width: `${progress}%` }}
                            ></div>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-4 justify-center">
                    <button
                        onClick={startAnalysis}
                        disabled={status === 'processing'}
                        className="bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white font-bold py-3 px-8 rounded-full shadow-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:-translate-y-1"
                    >
                        {status === 'processing' ? <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div> : <Play size={20} />}
                        분석 시작
                    </button>

                    {status === 'completed' && (
                        <>
                            <button onClick={downloadResults} className="bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white font-semibold py-3 px-6 rounded-full flex items-center gap-2 transition-colors">
                                <Download size={18} /> 결과 다운로드 (익명)
                            </button>
                            <button onClick={downloadSecuritykey} className="bg-red-900/40 hover:bg-red-900/60 border border-red-800 text-red-200 font-semibold py-3 px-6 rounded-full flex items-center gap-2 transition-colors">
                                <Lock size={18} /> 보안키 다운로드 (관리자용)
                            </button>
                        </>
                    )}
                </div>

                {/* Logs */}
                <div className="bg-black/40 rounded-xl border border-white/5 h-64 flex flex-col overflow-hidden">
                    <div className="p-3 bg-white/5 border-b border-white/5 text-xs text-slate-400 font-semibold">
                        System Logs
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto space-y-1 font-mono text-xs">
                        {logs.length === 0 && <span className="text-slate-600">Waiting to start...</span>}
                        {logs.map((l, i) => (
                            <div key={i} className={`${l.type === 'error' ? 'text-red-400' : l.type === 'success' ? 'text-green-400' : 'text-slate-400'}`}>
                                &gt; {l.msg}
                            </div>
                        ))}
                    </div>
                </div>

            </div>
        </div>
    );
};

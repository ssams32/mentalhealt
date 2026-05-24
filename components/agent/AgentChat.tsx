import React, { useState, useRef, useEffect } from 'react';
import { apiClient } from '../../services/apiClient';
import { Send, Bot, User as UserIcon, X, Loader2 } from 'lucide-react';

interface AgentChatProps {
    isOpen: boolean;
    onClose: () => void;
    currentUser: any;
    showToast: (msg: string) => void;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

export function AgentChat({ isOpen, onClose, currentUser, showToast }: AgentChatProps) {
    const [messages, setMessages] = useState<Message[]>([
        {
            id: 'welcome',
            role: 'assistant',
            content: `안녕하세요 ${currentUser.name}님! 무엇을 도와드릴까요?\n예: "내일 오전 10시 상담 일정 추가해줘"`,
            timestamp: new Date()
        }
    ]);
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || isProcessing) return;

        const userMsg: Message = {
            id: `user_${Date.now()}`,
            role: 'user',
            content: input,
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setIsProcessing(true);

        try {
            // 1. Gemini에게 의도 파악 요청
            const prompt = `
사용자의 요청을 분석하여 JSON 형식으로 명령을 추출해줘.
현재 시간: ${new Date().toLocaleString('ko-KR')}
사용자: ${currentUser.name}

가능한 명령:
1. ADD_EVENT: 일정 추가 (title, start, end, allDay)
2. ADD_TODO: 할 일 추가 (content, assignee)
3. QUERY: 데이터 조회/분석 요청 (query)
4. UNKNOWN: 이해할 수 없음

예시:
"내일 오전 10시 상담" -> {"type": "ADD_EVENT", "data": {"title": "상담", "start": "2025-11-28T10:00:00", "end": "2025-11-28T11:00:00", "allDay": false}}
"이번 달 의뢰 건수 알려줘" -> {"type": "QUERY", "data": {"query": "이번 달 의뢰 건수"}}

사용자 입력: "${userMsg.content}"
JSON 응답만 출력해.
`;
            const result = await apiClient.callGeminiApi(prompt);

            // result is expected to be a string based on apiClient definition
            const responseTextRaw = typeof result === 'string' ? result : (result as any).text;

            if (responseTextRaw) {
                // JSON 파싱 시도
                const jsonStr = responseTextRaw.replace(/```json/g, '').replace(/```/g, '').trim();
                let action;
                try {
                    action = JSON.parse(jsonStr);
                } catch (e) {
                    throw new Error('명령을 이해하지 못했습니다.');
                }

                // 명령 실행
                let responseText = '';
                if (action.type === 'ADD_EVENT') {
                    await apiClient.createCalendarEvent(action.data);
                    responseText = `일정을 추가했습니다: ${action.data.title}`;
                } else if (action.type === 'ADD_TODO') {
                    await apiClient.createTodo({
                        id: `todo_${Date.now()}`,
                        content: action.data.content,
                        isCompleted: false,
                        assignee: action.data.assignee || currentUser.name
                    });
                    responseText = `할 일을 추가했습니다: ${action.data.content}`;
                } else if (action.type === 'QUERY') {
                    const referrals = await apiClient.getReferrals();
                    const recentReferrals = referrals.slice(0, 20).map(r => `- ${r.requestDate} ${r.name}(${r.team}): ${r.diagnosisName}`).join('\n');
                    const totalCount = referrals.length;

                    const analysisPrompt = `
너는 데이터 분석가야. 아래 데이터를 바탕으로 사용자의 질문에 답변해줘.

[데이터 요약]
- 총 의뢰 건수: ${totalCount}
- 최근 의뢰 목록 (20건):
${recentReferrals}

사용자 질문: "${action.data.query}"
답변:
`;
                    const analysisResult = await apiClient.callGeminiApi(analysisPrompt);
                    const analysisText = typeof analysisResult === 'string' ? analysisResult : (analysisResult as any).text;
                    responseText = analysisText || '데이터 분석에 실패했습니다.';
                } else {
                    responseText = '죄송합니다. 제가 처리할 수 없는 요청입니다.';
                }

                setMessages(prev => [...prev, {
                    id: `resp_${Date.now()}`,
                    role: 'assistant',
                    content: responseText,
                    timestamp: new Date()
                }]);
            } else {
                throw new Error('AI 응답 실패');
            }
        } catch (error) {
            setMessages(prev => [...prev, {
                id: `err_${Date.now()}`,
                role: 'assistant',
                content: '오류가 발생했습니다. 다시 말씀해 주세요.',
                timestamp: new Date()
            }]);
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className={`fixed inset-y-0 left-0 w-96 bg-white shadow-2xl transform transition-transform duration-300 z-50 flex flex-col ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {/* 헤더 */}
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-indigo-600 text-white">
                <div className="flex items-center gap-2 font-bold">
                    <Bot size={24} /> AI 에이전트
                </div>
                <button onClick={onClose} className="p-1 hover:bg-indigo-500 rounded-full transition">
                    <X size={20} />
                </button>
            </div>

            {/* 메시지 목록 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
                {messages.map(msg => (
                    <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-slate-200' : 'bg-indigo-100 text-indigo-600'}`}>
                            {msg.role === 'user' ? <UserIcon size={16} /> : <Bot size={16} />}
                        </div>
                        <div className={`max-w-[80%] p-3 rounded-2xl text-sm whitespace-pre-wrap ${msg.role === 'user' ? 'bg-slate-800 text-white rounded-tr-none' : 'bg-white shadow-sm border border-slate-100 rounded-tl-none text-slate-700'}`}>
                            {msg.content}
                        </div>
                    </div>
                ))}
                {isProcessing && (
                    <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0">
                            <Bot size={16} />
                        </div>
                        <div className="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-slate-100">
                            <Loader2 className="animate-spin text-indigo-500" size={20} />
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* 입력창 */}
            <div className="p-4 border-t border-slate-100 bg-white">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                        placeholder="명령을 입력하세요..."
                        className="flex-1 p-3 border border-slate-200 rounded-xl outline-none focus:border-indigo-500 transition"
                        disabled={isProcessing}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isProcessing}
                        className="p-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send size={20} />
                    </button>
                </div>
            </div>
        </div>
    );
}

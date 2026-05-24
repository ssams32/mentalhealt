import React, { useState, useEffect, useCallback } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import { User, ToDo, CalendarEvent } from '../../types';
import { apiClient } from '../../services/apiClient';
import { CheckCircle2, Circle, Plus, Trash2, Calendar as CalendarIcon, Clock } from 'lucide-react';

interface CalendarTodoPageProps {
    currentUser: User;
    showToast: (message: string) => void;
}

export function CalendarTodoPage({ currentUser, showToast }: CalendarTodoPageProps) {
    const [todos, setTodos] = useState<ToDo[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [newTodoContent, setNewTodoContent] = useState('');
    const [isLoading, setIsLoading] = useState(true);

    // === 데이터 로드 ===
    useEffect(() => {
        const loadData = async () => {
            try {
                const [loadedTodos, loadedEvents] = await Promise.all([
                    apiClient.getTodos(),
                    apiClient.getCalendarEvents(
                        new Date(new Date().getFullYear(), 0, 1).toISOString(),
                        new Date(new Date().getFullYear(), 11, 31).toISOString()
                    )
                ]);
                setTodos(loadedTodos);
                setEvents(loadedEvents);
            } catch (error) {
                console.error('Failed to load calendar data', error);
                showToast('데이터 로드 실패');
            } finally {
                setIsLoading(false);
            }
        };
        loadData();
    }, [showToast]);

    // === ToDo 핸들러 ===
    const handleAddTodo = async () => {
        if (!newTodoContent.trim()) return;

        const newTodo: ToDo = {
            id: `todo_${Date.now()}`,
            content: newTodoContent,
            isCompleted: false,
            assignee: currentUser.name
        };

        try {
            await apiClient.createTodo(newTodo);
            setTodos(prev => [newTodo, ...prev]);
            setNewTodoContent('');
            showToast('할 일이 추가되었습니다.');
        } catch (error) {
            showToast('할 일 추가 실패');
        }
    };

    const toggleTodo = async (todo: ToDo) => {
        const updatedTodo = { ...todo, isCompleted: !todo.isCompleted };
        try {
            await apiClient.updateTodo(updatedTodo);
            setTodos(prev => prev.map(t => t.id === todo.id ? updatedTodo : t));
        } catch (error) {
            showToast('상태 업데이트 실패');
        }
    };

    const deleteTodo = async (id: string) => {
        if (!confirm('삭제하시겠습니까?')) return;
        try {
            await apiClient.deleteTodo(id);
            setTodos(prev => prev.filter(t => t.id !== id));
        } catch (error) {
            showToast('삭제 실패');
        }
    };

    // === 캘린더 핸들러 ===
    const handleDateSelect = async (selectInfo: any) => {
        const title = prompt('새로운 일정 제목을 입력하세요:');
        const calendarApi = selectInfo.view.calendar;
        calendarApi.unselect();

        if (title) {
            const newEvent = {
                id: `evt_${Date.now()}`,
                title,
                start: selectInfo.startStr,
                end: selectInfo.endStr,
                allDay: selectInfo.allDay,
                location: '이천시자살예방센터'
            };

            try {
                await apiClient.createCalendarEvent(newEvent);
                setEvents(prev => [...prev, newEvent]);
                calendarApi.addEvent(newEvent);
                showToast('일정이 추가되었습니다.');
            } catch (error) {
                showToast('일정 추가 실패');
            }
        }
    };

    const handleEventClick = async (clickInfo: any) => {
        if (confirm(`'${clickInfo.event.title}' 일정을 삭제하시겠습니까?`)) {
            try {
                await apiClient.deleteCalendarEvent(clickInfo.event.id);
                setEvents(prev => prev.filter(e => e.id !== clickInfo.event.id));
                clickInfo.event.remove();
                showToast('일정이 삭제되었습니다.');
            } catch (error) {
                showToast('삭제 실패');
            }
        }
    };

    // === ToDo -> 캘린더 추가 ===
    const addToCalendar = async (todo: ToDo) => {
        const dateStr = prompt('날짜를 입력하세요 (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
        if (!dateStr) return;

        const newEvent = {
            id: `evt_${Date.now()}`,
            title: todo.content,
            start: dateStr,
            allDay: true,
            extendedProps: { description: `담당자: ${todo.assignee}` }
        };

        try {
            await apiClient.createCalendarEvent(newEvent);
            setEvents(prev => [...prev, newEvent]);
            showToast('캘린더에 추가되었습니다.');
        } catch (error) {
            showToast('캘린더 추가 실패');
        }
    };

    return (
        <div className="flex h-full bg-slate-50 gap-6 p-6 overflow-hidden">
            {/* 왼쪽: ToDo 리스트 */}
            <div className="w-80 bg-white rounded-2xl shadow-sm border border-slate-200 p-5 flex flex-col h-full">
                <h3 className="text-lg font-extrabold text-slate-800 mb-4 flex items-center gap-2">
                    <CheckCircle2 className="text-green-500" /> 할 일 목록
                </h3>

                <div className="flex gap-2 mb-4">
                    <input
                        type="text"
                        value={newTodoContent}
                        onChange={(e) => setNewTodoContent(e.target.value)}
                        placeholder="할 일 입력..."
                        className="flex-1 p-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-green-500"
                        onKeyPress={(e) => e.key === 'Enter' && handleAddTodo()}
                    />
                    <button onClick={handleAddTodo} className="p-2 bg-green-500 text-white rounded-lg hover:bg-green-600">
                        <Plus size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                    {todos.map(todo => (
                        <div key={todo.id} className={`group flex items-center gap-3 p-3 rounded-xl border transition-all ${todo.isCompleted ? 'bg-slate-50 border-slate-100' : 'bg-white border-slate-200 hover:border-green-300'}`}>
                            <button onClick={() => toggleTodo(todo)} className={`shrink-0 ${todo.isCompleted ? 'text-green-500' : 'text-slate-300 hover:text-green-500'}`}>
                                {todo.isCompleted ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                            </button>
                            <div className="flex-1 min-w-0">
                                <p className={`text-sm font-medium truncate ${todo.isCompleted ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                                    {todo.content}
                                </p>
                                <p className="text-xs text-slate-400">{todo.assignee}</p>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => addToCalendar(todo)} className="p-1 text-blue-400 hover:text-blue-600" title="캘린더에 추가">
                                    <CalendarIcon size={16} />
                                </button>
                                <button onClick={() => deleteTodo(todo.id)} className="p-1 text-red-300 hover:text-red-500" title="삭제">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* 오른쪽: FullCalendar */}
            <div className="flex-1 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 overflow-hidden flex flex-col">
                <FullCalendar
                    plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
                    headerToolbar={{
                        left: 'prev,next today',
                        center: 'title',
                        right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek'
                    }}
                    initialView="dayGridMonth"
                    editable={true}
                    selectable={true}
                    selectMirror={true}
                    dayMaxEvents={true}
                    weekends={true}
                    events={events}
                    select={handleDateSelect}
                    eventClick={handleEventClick}
                    height="100%"
                    locale="ko"
                />
            </div>
        </div>
    );
}

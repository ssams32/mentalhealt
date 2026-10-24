import React, { useState, useEffect } from 'react';
import { ReferralNote, User } from '../../types';

interface NotesModalProps {
    isOpen: boolean;
    onClose: () => void;
    referralId: string;
    initialNotes: ReferralNote[];
    onUpdateNotes: (notes: ReferralNote[]) => void;
    currentUser: User;
    patientName?: string;
}

const NotesModal: React.FC<NotesModalProps> = ({
    isOpen,
    onClose,
    referralId,
    initialNotes,
    onUpdateNotes,
    currentUser,
    patientName
}) => {
    const [notes, setNotes] = useState<ReferralNote[]>([]);
    const [newNoteContent, setNewNoteContent] = useState('');

    // Editing State
    const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
    const [editedNoteContent, setEditedNoteContent] = useState('');

    useEffect(() => {
        if (isOpen) {
            setNotes(initialNotes || []);
        }
    }, [isOpen, initialNotes]);

    if (!isOpen) return null;

    const handleAddNote = () => {
        if (!newNoteContent.trim()) return;

        const newNote: ReferralNote = {
            id: `note_${Date.now()}`,
            content: newNoteContent,
            createdAt: new Date().toLocaleString('ko-KR'),
            author: currentUser.name,
        };

        const updatedNotes = [newNote, ...notes];
        setNotes(updatedNotes);
        setNewNoteContent('');
        onUpdateNotes(updatedNotes);
    };

    const handleDeleteNote = (noteId: string) => {
        if (!confirm('정말 이 노트를 삭제하시겠습니까?')) return;
        const updatedNotes = notes.filter(n => n.id !== noteId);
        setNotes(updatedNotes);
        onUpdateNotes(updatedNotes);
    };

    const handleEditStart = (note: ReferralNote) => {
        setEditingNoteId(note.id);
        setEditedNoteContent(note.content);
    };

    const handleEditCancel = () => {
        setEditingNoteId(null);
        setEditedNoteContent('');
    };

    const handleEditSave = () => {
        if (!editingNoteId || !editedNoteContent.trim()) return;

        const updatedNotes = notes.map(n =>
            n.id === editingNoteId
                ? { ...n, content: editedNoteContent, createdAt: `${n.createdAt} (수정됨)` }
                : n
        );

        setNotes(updatedNotes);
        setEditingNoteId(null);
        setEditedNoteContent('');
        onUpdateNotes(updatedNotes);
    };

    const title = patientName ? `${patientName}님의 상담/개입내역` : '상담/개입내역';

    return (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center z-[60] p-[21px]">
            <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-[448px] max-h-[calc(100vh-89px)] overflow-y-auto p-[21px] space-y-6 relative border border-white/50 animate-scale-in">
                <div className="flex justify-between items-center border-b border-slate-100 pb-[13px] mb-[13px]">
                    <div>
                        <h3 className="text-xl font-extrabold text-slate-900">{title}</h3>
                        <p className="text-sm text-slate-400 font-medium">상담 및 개입 내용을 기록하고 관리합니다.</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition">
                        <i className="fas fa-times"></i>
                    </button>
                </div>

                <div className="space-y-3 min-h-[200px] max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
                    {notes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-slate-300 border-2 border-dashed border-slate-100 rounded-2xl bg-slate-50/50">
                            <i className="fas fa-note-sticky text-3xl mb-2"></i>
                            <p className="font-bold text-sm">작성된 내역이 없습니다.</p>
                        </div>
                    ) : (
                        <ul className="space-y-3">
                            {notes.map((note) => (
                                <li key={note.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 transition hover:shadow-sm">
                                    {editingNoteId === note.id ? (
                                        <div className="space-y-3">
                                            <textarea
                                                value={editedNoteContent}
                                                onChange={(e) => setEditedNoteContent(e.target.value)}
                                                className="w-full p-3 border border-blue-200 rounded-xl bg-white focus:ring-2 focus:ring-blue-100 outline-none text-sm resize-none"
                                                rows={3}
                                            />
                                            <div className="flex justify-end gap-2">
                                                <button onClick={handleEditCancel} className="px-[13px] py-[8px] text-xs font-bold text-slate-500 bg-slate-200 rounded-lg hover:bg-slate-300">취소</button>
                                                <button onClick={handleEditSave} className="px-[13px] py-[8px] text-xs font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700">저장</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex justify-between items-start mb-2">
                                                <span className="text-xs font-bold text-slate-500 bg-white px-2 py-1 rounded-md border border-slate-100 shadow-sm">{note.author}</span>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleEditStart(note)}
                                                        className="text-slate-400 hover:text-blue-500 transition p-1"
                                                        title="수정"
                                                    >
                                                        <i className="fas fa-pen text-xs"></i>
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteNote(note.id)}
                                                        className="text-slate-400 hover:text-red-500 transition p-1"
                                                        title="삭제"
                                                    >
                                                        <i className="fas fa-trash text-xs"></i>
                                                    </button>
                                                </div>
                                            </div>
                                            <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{note.content}</p>
                                            <div className="text-right text-[10px] text-slate-400 font-medium mt-2">
                                                {note.createdAt}
                                            </div>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="pt-4 border-t border-slate-100 space-y-3">
                    <textarea
                        value={newNoteContent}
                        onChange={(e) => setNewNoteContent(e.target.value)}
                        placeholder="새로운 상담/개입 내용을 입력하세요..."
                        rows={3}
                        className="w-full px-4 py-3 bg-slate-100 border-none rounded-xl text-slate-800 font-medium focus:ring-2 focus:ring-blue-500/20 focus:bg-white transition-all outline-none text-sm resize-none placeholder-slate-400"
                    />
                    <button
                        onClick={handleAddNote}
                        className="w-full flex items-center justify-center space-x-2 px-[13px] py-[13px] rounded-2xl cursor-pointer transition shadow-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed group"
                        disabled={!newNoteContent.trim()}
                    >
                        <i className="fas fa-plus group-hover:scale-110 transition-transform"></i>
                        <span className="font-bold text-sm">내역 추가</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export default NotesModal;
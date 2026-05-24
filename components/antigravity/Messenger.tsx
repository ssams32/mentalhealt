import React from 'react';
import { Send, Paperclip, Smile } from 'lucide-react';

const users = [
    { name: 'Kim', online: true },
    { name: 'Lee', online: true },
    { name: 'Park', online: false },
    { name: 'Choi', online: true },
    { name: 'Jung', online: false },
];

const messages = [
    { id: 1, sender: 'Kim', text: 'Hey, did you check the new redesign?', time: '10:02 AM', isMe: false },
    { id: 2, sender: 'Me', text: 'Yes! It looks amazing. The anti-gravity feel is spot on.', time: '10:05 AM', isMe: true },
    { id: 3, sender: 'Kim', text: 'Great. Let\'s review it together afternoon.', time: '10:06 AM', isMe: false },
];

const Messenger: React.FC = () => {
    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-6 pb-2">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2">
                        <h2 className="text-xl font-bold text-slate-800">Messages</h2>
                        <span className="bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">3</span>
                    </div>
                </div>

                {/* Stories Area */}
                <div className="flex gap-4 overflow-x-auto no-scrollbar pb-4 mask-gradient">
                    {users.map((user, idx) => (
                        <div key={idx} className="flex-shrink-0 flex flex-col items-center gap-1.5 cursor-pointer group">
                            <div className="relative">
                                <div className="w-12 h-12 rounded-2xl bg-slate-100 ring-2 ring-white shadow-sm overflow-hidden flex items-center justify-center text-slate-400 group-hover:shadow-md transition-all">
                                    <span className="font-bold text-sm">{user.name[0]}</span>
                                </div>
                                {user.online && (
                                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-400 border-2 border-white rounded-full shadow-sm" />
                                )}
                            </div>
                            <span className="text-[10px] font-medium text-slate-500">{user.name}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/30 no-scrollbar">
                <div className="flex justify-center mb-6">
                    <span className="px-3 py-1 bg-white shadow-sm rounded-full text-[10px] font-bold text-slate-400">Today</span>
                </div>

                {messages.map((msg) => (
                    <div key={msg.id} className={`flex flex-col ${msg.isMe ? 'items-end' : 'items-start'}`}>
                        <div className={`max-w-[80%] p-3 text-sm shadow-sm ${
                            msg.isMe 
                                ? 'bg-blue-600 text-white rounded-2xl rounded-tr-none shadow-blue-100' 
                                : 'bg-white text-slate-700 border border-slate-100 rounded-2xl rounded-tl-none'
                        }`}>
                            {msg.text}
                        </div>
                        <span className="text-[10px] text-slate-400 mt-1">{msg.time}</span>
                    </div>
                ))}
            </div>

            {/* Input Container */}
            <div className="p-6">
                <div className="bg-white border border-slate-100 rounded-[1.2rem] p-1.5 flex items-center gap-2 shadow-sm focus-within:shadow-md focus-within:ring-2 focus-within:ring-blue-50 transition-all">
                    <button className="p-2 text-slate-400 hover:text-blue-600 hover:bg-slate-50 rounded-xl transition-colors">
                        <Smile size={20} />
                    </button>
                    <input 
                        type="text" 
                        placeholder="Type a message..." 
                        className="flex-1 bg-transparent border-none text-sm focus:outline-none px-1"
                    />
                    <button className="p-2 text-slate-400 hover:text-blue-600 hover:bg-slate-50 rounded-xl transition-colors">
                        <Paperclip size={20} />
                    </button>
                    <button className="w-8 h-8 bg-blue-600 text-white rounded-xl flex items-center justify-center hover:scale-105 transition-transform shadow-md shadow-blue-100">
                        <Send size={16} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Messenger;

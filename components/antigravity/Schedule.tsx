import React from 'react';

const events = [
    { time: '10:00 AM', title: 'Product Review Meeting', type: 'blue', sub: 'Conference Room A' },
    { time: '02:30 PM', title: 'Design System Discussion', type: 'violet', sub: 'Zoom Meeting' },
    { time: '04:00 PM', title: 'Weekly Reports Due', type: 'rose', sub: 'Administrative' },
];

const Schedule: React.FC = () => {
    return (
        <div className="bg-white rounded-[2rem] p-6 shadow-anti-gravity border border-slate-50 sticky top-8">
            <div className="flex items-center justify-between mb-8">
                <h2 className="text-xl font-bold text-slate-800">Today</h2>
                <div className="px-3 py-1 bg-slate-50 rounded-full text-[11px] font-bold text-slate-500">
                    March 15, 2024
                </div>
            </div>

            <div className="relative space-y-6">
                {/* Timeline Line */}
                <div className="absolute left-[5px] top-2 bottom-2 w-0.5 bg-slate-50" />

                {events.map((event, idx) => {
                    const dotColor = {
                        blue: 'border-blue-500',
                        violet: 'border-violet-500',
                        rose: 'border-rose-500',
                    }[event.type as 'blue' | 'violet' | 'rose'];

                    const bgColor = {
                        blue: 'bg-blue-50/50 hover:bg-blue-50',
                        violet: 'bg-violet-50/50 hover:bg-violet-50',
                        rose: 'bg-rose-50/50 hover:bg-rose-50',
                    }[event.type as 'blue' | 'violet' | 'rose'];

                    return (
                        <div key={idx} className="relative pl-6">
                            <div className={`absolute left-0 top-1.5 w-3 h-3 rounded-full border-2 bg-white z-10 ${dotColor}`} />
                            <div className="text-[11px] font-bold text-slate-400 mb-1">{event.time}</div>
                            <div className={`p-3 rounded-2xl ${bgColor} transition-all duration-300 cursor-pointer group`}>
                                <h4 className="text-sm font-medium text-slate-700 group-hover:text-slate-900 line-clamp-1">{event.title}</h4>
                                <p className="text-[11px] text-slate-400 mt-0.5">{event.sub}</p>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Memo Section */}
            <div className="mt-8 pt-6 border-t border-slate-50">
                <div className="bg-yellow-50/50 border border-yellow-100/50 p-4 rounded-2xl">
                    <p className="text-xs font-bold text-yellow-600 mb-2">Team Memo</p>
                    <p className="text-sm text-slate-600 leading-relaxed italic">
                        "Don't forget to push the latest UI changes to the staging server by 5 PM today."
                    </p>
                    <p className="text-[10px] text-slate-400 mt-3 flex justify-end">Updated 2h ago</p>
                </div>
            </div>
        </div>
    );
};

export default Schedule;

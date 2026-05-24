import React from 'react';
import { ArrowRightCircle, Plus } from 'lucide-react';

const requests = [
    { id: 1, title: 'Icheon Center UI Redesign', client: 'Google Deepmind', progress: 75, dDay: 'D-3', isNew: true },
    { id: 2, title: 'Supabase Data Migration', client: 'Internal IT', progress: 40, dDay: 'D-7', isNew: false },
    { id: 3, title: 'Messenger V2 Feature Dev', client: 'Product Team', progress: 90, dDay: 'D-1', isNew: false },
];

const RequestManagement: React.FC = () => {
    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-1.5 h-6 bg-violet-500 rounded-full" />
                <h2 className="text-lg font-bold text-slate-800">Request Management</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {requests.map((request) => (
                    <div
                        key={request.id}
                        className="bg-white rounded-[2rem] p-5 border border-slate-50 hover:shadow-lg transition-all duration-300 group cursor-pointer relative"
                    >
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                {request.isNew && (
                                    <span className="bg-violet-50 text-violet-600 px-2 py-0.5 rounded-md text-[10px] font-bold">NEW</span>
                                )}
                                <p className="text-xs text-slate-500 mt-1">{request.client}</p>
                                <h4 className="text-sm font-bold text-slate-800 mt-0.5 group-hover:text-violet-600 transition-colors">{request.title}</h4>
                            </div>
                            <span className="text-xs text-slate-400 font-medium">{request.dDay}</span>
                        </div>

                        <div className="flex items-center justify-between mt-6">
                            <div className="flex -space-x-2">
                                {[1, 2, 3].map((i) => (
                                    <div key={i} className="w-7 h-7 rounded-full border-2 border-white bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-400">
                                        JD
                                    </div>
                                ))}
                            </div>
                            <div className="flex-1 ml-4 mr-2">
                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-violet-500 rounded-full transition-all duration-1000" 
                                        style={{ width: `${request.progress}%` }} 
                                    />
                                </div>
                                <div className="flex justify-between mt-1.5">
                                    <span className="text-[10px] text-slate-400">Progress</span>
                                    <span className="text-[10px] text-slate-400 font-bold">{request.progress}%</span>
                                </div>
                            </div>
                            <ArrowRightCircle className="text-slate-200 group-hover:text-violet-500 transition-colors" size={20} />
                        </div>
                    </div>
                ))}

                {/* Add Button Card */}
                <div className="min-h-[140px] border-2 border-dashed border-slate-100 rounded-[2rem] flex flex-col items-center justify-center gap-2 text-slate-300 hover:border-violet-300 hover:bg-violet-50/50 hover:text-violet-500 transition-all duration-300 cursor-pointer group">
                    <div className="p-2 rounded-xl bg-slate-50 group-hover:bg-violet-100 transition-colors">
                        <Plus size={20} />
                    </div>
                    <span className="text-sm font-medium">New Request</span>
                </div>
            </div>
        </div>
    );
};

export default RequestManagement;

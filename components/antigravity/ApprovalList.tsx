import React from 'react';
import { MoreHorizontal } from 'lucide-react';

const approvals = [
    { id: 1, title: 'Q1 Marketing Budget Approval', requester: 'Kim', date: '2024.03.15', status: 'waiting' },
    { id: 2, title: 'New Employee Equipment Request', requester: 'Lee', date: '2024.03.14', status: 'approved' },
    { id: 3, title: 'Server Maintenance Expenditure', requester: 'Park', date: '2024.03.14', status: 'waiting' },
    { id: 4, title: 'External Consultant Contract', requester: 'Choi', date: '2024.03.13', status: 'rejected' },
];

const ApprovalList: React.FC = () => {
    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                    <h2 className="text-lg font-bold text-slate-800">Electronic Approvals</h2>
                </div>
                <button className="text-xs text-slate-400 hover:text-blue-600 transition-colors">View All</button>
            </div>

            <div className="space-y-3">
                {approvals.map((item) => {
                    const statusConfig = {
                        waiting: { label: 'Waiting', classes: 'bg-blue-50 text-blue-600' },
                        approved: { label: 'Approved', classes: 'bg-emerald-50 text-emerald-600' },
                        rejected: { label: 'Rejected', classes: 'bg-rose-50 text-rose-600' },
                    }[item.status as 'waiting' | 'approved' | 'rejected'];

                    return (
                        <div
                            key={item.id}
                            className="group bg-white rounded-2xl p-4 border border-slate-50 hover:shadow-md transition-all duration-300 cursor-pointer flex items-center justify-between"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 bg-slate-50 group-hover:bg-blue-600 group-hover:text-white rounded-full flex items-center justify-center text-xs font-bold text-slate-500 transition-colors duration-300">
                                    {item.requester}
                                </div>
                                <div>
                                    <h4 className="text-sm font-medium text-slate-800 line-clamp-1 group-hover:text-blue-600 transition-colors">{item.title}</h4>
                                    <p className="text-[11px] text-slate-400 mt-0.5">{item.date} • {item.requester}</p>
                                </div>
                            </div>
                            
                            <div className="flex items-center gap-3">
                                <span className={`px-3 py-1 rounded-full text-[11px] font-bold ${statusConfig.classes}`}>
                                    {statusConfig.label}
                                </span>
                                <button className="text-slate-300 hover:text-slate-500 transition-colors">
                                    <MoreHorizontal size={16} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default ApprovalList;

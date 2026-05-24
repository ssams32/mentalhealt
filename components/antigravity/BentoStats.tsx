import React from 'react';
import { FileCheck, Clock, CheckCircle2, AlertCircle } from 'lucide-react';

const stats = [
    { title: 'Pending Approval', count: 12, unit: 'cases', icon: FileCheck, color: 'blue' },
    { title: 'In-Progress Requests', count: 24, unit: 'cases', icon: Clock, color: 'violet' },
    { title: 'Completed', count: 156, unit: 'tasks', icon: CheckCircle2, color: 'emerald' },
    { title: 'Urgent Issues', count: 3, unit: 'items', icon: AlertCircle, color: 'rose' },
];

const BentoStats: React.FC = () => {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {stats.map((stat, idx) => {
                const Icon = stat.icon;
                const colorClasses = {
                    blue: 'bg-blue-50 text-blue-600',
                    violet: 'bg-violet-50 text-violet-600',
                    emerald: 'bg-emerald-50 text-emerald-600',
                    rose: 'bg-rose-50 text-rose-600',
                }[stat.color as 'blue' | 'violet' | 'emerald' | 'rose'];

                return (
                    <div
                        key={idx}
                        className="bg-white rounded-3xl p-5 border border-slate-50 shadow-anti-gravity hover:shadow-anti-gravity-hover hover:-translate-y-1 transition-all duration-300 group cursor-pointer"
                    >
                        <div className="flex items-center justify-between mb-4">
                            <div className={`p-2.5 rounded-xl ${colorClasses} transition-transform duration-300 group-hover:scale-110`}>
                                <Icon size={20} strokeWidth={2} />
                            </div>
                            <span className="text-xs font-medium text-slate-400 group-hover:text-slate-600">This Month</span>
                        </div>
                        <h3 className="text-sm font-medium text-slate-400 mb-1">{stat.title}</h3>
                        <div className="flex items-baseline gap-1">
                            <span className="text-3xl font-bold text-slate-800">{stat.count}</span>
                            <span className="text-xs text-slate-400 font-medium">{stat.unit}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default BentoStats;

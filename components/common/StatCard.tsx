
import React from 'react';

interface StatCardProps {
    title: string;
    value: string | number;
    color: string;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, color }) => (
    <div className="p-6 rounded-3xl bg-white shadow-sm border border-slate-100 flex items-center justify-between transition hover:shadow-md">
        <div>
            <p className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-1">{title}</p>
            <p className="text-3xl font-extrabold text-slate-900">{value}</p>
        </div>
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white text-lg shadow-lg ${color}`}>
            <i className="fas fa-chart-bar"></i>
        </div>
    </div>
);

export default StatCard;

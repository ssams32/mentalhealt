
import React from 'react';

interface StatCardProps {
    title: string;
    value: string | number;
    color: string;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, color }) => (
    <div
        className="p-[var(--card-padding-md)] rounded-3xl bg-white shadow-sm border border-slate-100 flex items-center justify-between transition hover:shadow-md"
        style={{ padding: 'var(--card-padding-md)' }}
    >
        <div>
            <p
                className="text-[length:var(--font-base)] font-bold text-slate-400 uppercase tracking-wider mb-1"
                style={{ fontSize: 'var(--font-base)' }}
            >
                {title}
            </p>
            <p
                className="text-[length:var(--font-3xl)] font-extrabold text-slate-900"
                style={{ fontSize: 'var(--font-3xl)' }}
            >
                {value}
            </p>
        </div>
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white text-lg shadow-lg ${color}`}>
            <i className="fas fa-chart-bar"></i>
        </div>
    </div>
);

export default StatCard;

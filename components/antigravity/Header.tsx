import React from 'react';
import { Search, Bell } from 'lucide-react';

interface HeaderProps {
    userName: string;
    date: string;
}

const Header: React.FC<HeaderProps> = ({ userName, date }) => {
    return (
        <header className="flex items-center justify-between h-24 mb-6 sticky top-0 z-10 backdrop-blur-md">
            <div>
                <h1 className="text-2xl font-bold text-slate-800">
                    Hello, {userName}
                </h1>
                <p className="text-sm text-slate-400 mt-1">{date}</p>
            </div>

            <div className="flex items-center gap-4">
                {/* Search Bar */}
                <div className="relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-blue-600 transition-colors" size={18} />
                    <input
                        type="text"
                        placeholder="Search anything..."
                        className="pl-11 pr-4 py-2.5 w-64 bg-white border-transparent border rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-50 focus:shadow-md transition-all duration-300"
                    />
                </div>

                {/* Notifications */}
                <button className="relative p-2.5 bg-white rounded-2xl shadow-sm hover:shadow-md hover:text-blue-600 transition-all duration-300">
                    <Bell size={20} className="text-slate-400" />
                    <span className="absolute top-2.5 right-2.5 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-white" />
                </button>
            </div>
        </header>
    );
};

export default Header;

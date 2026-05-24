import React from 'react';
import { LayoutGrid, FileText, Send, Calendar, MessageSquare, Settings, LogOut, User as UserIcon } from 'lucide-react';

interface SidebarProps {
    activePage: string;
    setActivePage: (page: string) => void;
}

const navItems = [
    { id: 'dashboard', icon: LayoutGrid, label: 'Dashboard' },
    { id: 'approval', icon: FileText, label: 'Approval' },
    { id: 'request', icon: Send, label: 'Request' },
    { id: 'schedule', icon: Calendar, label: 'Schedule' },
    { id: 'messenger', icon: MessageSquare, label: 'Messenger' },
];

const Sidebar: React.FC<SidebarProps> = ({ activePage, setActivePage }) => {
    return (
        <div className="flex flex-col items-center py-6 h-full">
            {/* Logo Area */}
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 mb-10 shadow-lg shadow-blue-200 flex items-center justify-center text-white font-bold text-xl">
                A
            </div>

            {/* Nav Items */}
            <nav className="flex flex-col gap-4">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activePage === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => setActivePage(item.id)}
                            className={`group relative w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-300
                                ${isActive 
                                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-200 -translate-y-[2px]' 
                                    : 'text-slate-400 hover:bg-white hover:text-blue-600 hover:shadow-md'
                                }`}
                        >
                            <Icon size={22} strokeWidth={2} />
                            
                            {/* Tooltip */}
                            <div className="absolute left-16 px-2 py-1 bg-slate-800 text-white text-xs rounded opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
                                {item.label}
                                <div className="absolute left-0 top-1/2 -ml-1 -mt-1 border-4 border-transparent border-r-slate-800" />
                            </div>
                        </button>
                    );
                })}
            </nav>

            <div className="mt-auto flex flex-col gap-4">
                {/* Settings */}
                <button className="w-12 h-12 flex items-center justify-center text-slate-400 hover:text-blue-600 transition-all duration-300 hover:rotate-90">
                    <Settings size={22} strokeWidth={2} />
                </button>

                {/* Profile */}
                <div className="relative group cursor-pointer">
                    <div className="w-10 h-10 rounded-full ring-2 ring-white shadow-md overflow-hidden bg-slate-100 flex items-center justify-center text-slate-400">
                        <UserIcon size={20} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Sidebar;


import React from 'react';

interface PageContainerProps {
    title: React.ReactNode;
    subtitle: string;
    children: React.ReactNode;
    headerContent?: React.ReactNode;
}

const PageContainer: React.FC<PageContainerProps> = ({ title, subtitle, children, headerContent }) => {
    return (
        <div className="h-full flex flex-col">
            <header className="flex-none px-2 py-2 md:px-8 md:py-4 bg-white sticky top-0 z-20 border-b border-slate-200 shadow-sm transition-all">
                <div className="flex flex-col gap-1 md:gap-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 md:gap-3">
                            <h1 className="text-lg md:text-2xl font-black text-slate-900 tracking-tight">{title}</h1>
                            <p className="hidden md:block text-slate-400 font-bold text-xs mt-1">{subtitle}</p>
                        </div>
                        {headerContent}
                    </div>
                </div>
            </header>
            <main className="flex-1 overflow-y-auto p-2 md:p-6 space-y-3 md:space-y-4 relative pb-20 md:pb-6">
                {children}
            </main>
        </div>
    );
};

export default PageContainer;

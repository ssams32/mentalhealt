
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
                            <h1 className="text-[length:var(--font-xl)] md:text-[length:var(--font-2xl)] font-black text-slate-900 tracking-tight">{title}</h1>
                            <p className="hidden md:block text-slate-400 font-bold text-xs mt-1">{subtitle}</p>
                        </div>
                        {headerContent}
                    </div>
                </div>
            </header>
            <main className="flex-1 overflow-y-auto p-[var(--content-padding-mobile)] md:p-[var(--content-padding-desktop)] space-y-[var(--space-5)] relative pb-20 md:pb-[var(--content-padding-desktop)]">
                {children}
            </main>
        </div>
    );
};

export default PageContainer;

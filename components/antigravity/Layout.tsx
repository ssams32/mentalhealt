import React from 'react';

interface LayoutProps {
    children: React.ReactNode;
    sidebar: React.ReactNode;
    messenger: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children, sidebar, messenger }) => {
    return (
        <div className="flex h-screen w-full bg-slate-50 overflow-hidden selection:bg-blue-100">
            {/* Phase 3: Sidebar (Left) */}
            <aside className="w-20 h-full sticky top-0 z-20 flex-shrink-0 border-r border-slate-100 bg-white no-scrollbar">
                {sidebar}
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col h-full overflow-y-auto overflow-x-hidden no-scrollbar relative">
                {/* The content area will have the grid layout */}
                <div className="p-8 w-full max-w-none animate-load">
                    {children}
                </div>
            </main>

            {/* Phase 9: Messenger (Right) */}
            <aside className="hidden lg:block w-[340px] h-full sticky top-0 z-30 flex-shrink-0 bg-white/80 backdrop-blur-xl border-l border-slate-100 no-scrollbar">
                {messenger}
            </aside>
            
            {/* Mobile Messenger (Overlay) - To be implemented in Phase 9/10 */}
        </div>
    );
};

export default Layout;

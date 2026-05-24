import React, { useState, useEffect } from 'react';
import { AntiGravityService } from './service';
import { Page } from './types';
import EditorComponent from './editor/Editor';

interface AntiGravityContainerProps {
    requestId?: string; // Optional if projectData is provided
    pageData?: Page; // Direct injection for generic use (e.g. AI Notepad)
    currentUser: any;
    initialSummary?: string; // For converting legacy text to block
    onLegacySync?: (text: string) => void;
    onUpdate?: (page: Page) => void; // Sync back whole project state
    hideHeader?: boolean; // New prop to hide internal header
}

type ViewMode = 'editor' | 'dashboard';

const AntiGravityContainer: React.FC<AntiGravityContainerProps> = ({ requestId, pageData, currentUser, initialSummary, onLegacySync, onUpdate, hideHeader }) => {

    const [page, setPage] = useState<Page | null>(pageData || null);
    const [loading, setLoading] = useState(false);

    // View state
    const [viewMode, setViewMode] = useState<ViewMode>('editor');
    const [isFocusMode, setIsFocusMode] = useState(false);
    const [isDarkMode, setIsDarkMode] = useState(false);

    // Sync local project state when projectData prop updates
    useEffect(() => {
        if (pageData) {
            setPage(pageData);
            setLoading(false);
        }
    }, [pageData]);

    // Fetch data if requestId is provided and pageData is missing
    useEffect(() => {
        if (requestId && !pageData && !page) {
            const init = async () => {
                setLoading(true);
                try {
                    const proj = await AntiGravityService.initializeProjectFromLegacy(requestId, initialSummary);
                    setPage(proj);
                } catch (e) {
                    console.error("Failed to initialize Anti-Gravity project", e);
                } finally {
                    setLoading(false);
                }
            };
            init();
        }
    }, [requestId, pageData, initialSummary, page]);

    const handleContentUpdate = (jsonContent: any) => {
        if (!page) return;

        // Simplified: Treat the whole JSON doc as the content of the project for storage
        // Tiptap JSON content structure: { type: 'doc', content: [...] }
        const tiptapContent = jsonContent.content || [];

        // Create a new updated project object
        const updatedPage: Page = {
            ...page,
            // Map Tiptap Nodes back to Block structure (simplified flattened for now)
            blocks: tiptapContent.map((b: any, idx: number) => ({
                id: b.attrs?.id || `block-${Date.now()}-${idx}`,
                type: b.type,
                content: b.content, // preserving nested content for now
                children: [] // Tiptap nesting is inside 'content', needs deep mapping in Phase 2
            })),
            updatedAt: new Date().toISOString()
        };

        setPage(updatedPage); // Optimistic update

        if (onUpdate) {
            onUpdate(updatedPage);
        }

        // Basic sync back for legacy systems that need plain text
        if (onLegacySync) {
            const text = JSON.stringify(jsonContent);
            onLegacySync(text);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center p-10 bg-slate-50 rounded-xl border border-slate-100 h-64">
                <div className="text-center space-y-3">
                    <div className="animate-spin w-8 h-8 border-blue-500 border-t-transparent rounded-full mx-auto"></div>
                    <p className="text-sm font-bold text-slate-400">Loading...</p>
                </div>
            </div>
        );
    }

    if (!page) {
        // If we have no data and not loading, we might be in a "new" state or error.
        // For now, if pageData was passed as null but we are not fetching, show something.
        return <div className="p-4 text-red-500">No page data loaded.</div>;
    }

    // Styles for Focus Mode
    const containerClasses = isFocusMode
        ? "fixed inset-0 z-[100] bg-white flex flex-col"
        : "flex flex-col h-full bg-white";

    return (
        <div className={`${containerClasses} ${isDarkMode ? 'dark' : ''}`}>
            {/* Header / Toolbar - Hidden if hideHeader is true */}
            {!hideHeader && (
                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-colors">
                    <div className="text-sm font-medium text-slate-600 dark:text-slate-300">
                        {page.icon && <span className="mr-2">{page.icon}</span>}
                        <span>{page.title || 'Untitled'}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setIsDarkMode(!isDarkMode)}
                            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 transition-colors"
                            title="Toggle Dark Mode"
                        >
                            {isDarkMode ?
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></svg>
                                :
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                            }
                        </button>
                        <button
                            onClick={() => setIsFocusMode(!isFocusMode)}
                            className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${isFocusMode ? 'text-blue-500' : 'text-slate-400 dark:text-slate-500'}`}
                            title="Focus Mode"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>
                        </button>
                    </div>
                </div>
            )}

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {viewMode === 'editor' ? (
                    <EditorComponent page={page} currentUser={currentUser} onUpdate={handleContentUpdate} />
                ) : (
                    <div className="p-4 text-slate-400">Task Dashboard is undergoing maintenance for V2 upgrade.</div>
                )}
            </div>
        </div>
    );
};

export default AntiGravityContainer;

import React, { useEffect, useState, useRef } from 'react';
import { Editor } from '@tiptap/react';
import { GripVertical, Trash2, Copy, Plus } from 'lucide-react';
import tippy, { Instance, Props } from 'tippy.js';

interface BlockHandleProps {
    editor: Editor;
}

export const BlockHandle: React.FC<BlockHandleProps> = ({ editor }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const [activeNode, setActiveNode] = useState<any>(null);
    const [activePos, setActivePos] = useState<number>(-1);
    const [activeDOM, setActiveDOM] = useState<HTMLElement | null>(null);

    const handleRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!editor || !handleRef.current) return;

        // Custom logic to track mouse movement over editor content
        // We attached a listener in the Editor component or Extension
        // But for simplicity/robustness in React, let's just use global mousemove 
        // scoped to the editor container if possible, or rely on the Extension callback.

        // We will receive updates via an event or callback from the Tiptap extension
        // For now, let's setup the mechanism where Editor passes the state down? 
        // No, Extension should update React state. 

        // BETTER APPROACH: Real-time absolute positioning based on cursor/hover
        // "Notion-style" usually means tracking the *mouse* Y position and snapping to the nearest block.

        const updatePosition = (node: any, pos: number, dom: HTMLElement) => {
            if (!handleRef.current) return;

            // Position the handle
            const rect = dom.getBoundingClientRect();
            const handleRect = handleRef.current.getBoundingClientRect();

            // Get editor rect to calculate relative position
            const editorDom = editor.view.dom;
            const editorRect = editorDom.getBoundingClientRect();

            // Calculate 'top' relative to the viewport or container?
            // "fixed" strategy is easiest for overlays.

            handleRef.current.style.top = `${rect.top + window.scrollY}px`;
            handleRef.current.style.left = `${rect.left + window.scrollX - 24}px`; // 24px padding to left
            handleRef.current.style.opacity = '1';

            setActiveNode(node);
            setActivePos(pos);
            setActiveDOM(dom);
        };

        // Attach this update function to the editor instance so the extension can call it?
        // Or simpler: Just add a mouseover listener to the editor DOM here in React.

        const onMouseMove = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const editorDom = editor.view.dom;

            // Traverse up
            let blockEl = target;
            while (blockEl && blockEl.parentElement !== editorDom && blockEl !== editorDom) {
                if (blockEl.parentElement) blockEl = blockEl.parentElement;
                else break;
            }

            if (blockEl && blockEl.parentElement === editorDom) {
                // Found a block
                const pos = editor.view.posAtDOM(blockEl, 0);
                if (pos < 0) return;
                const node = editor.state.doc.nodeAt(pos);

                updatePosition(node, pos, blockEl);
            }
        };

        editor.view.dom.addEventListener('mousemove', onMouseMove);

        return () => {
            editor.view.dom.removeEventListener('mousemove', onMouseMove);
        };
    }, [editor]);

    const handleDragStart = (e: React.DragEvent) => {
        // Implement Drag Logic (Complex Phase 3)
        // For now just visual
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(activeDOM!, 0, 0);
    };

    const deleteBlock = () => {
        if (activePos >= 0) {
            editor.chain().focus().deleteRange({ from: activePos, to: activePos + activeNode.nodeSize }).run();
            // Hide handle
            if (handleRef.current) handleRef.current.style.opacity = '0';
        }
        setMenuOpen(false);
    };

    const duplicateBlock = () => {
        if (activePos >= 0 && activeNode) {
            // Basic clone
            // This needs proper serialization
            const json = activeNode.toJSON();
            editor.chain().insertContentAt(activePos + activeNode.nodeSize, json).run();
        }
        setMenuOpen(false);
    };

    return (
        <div
            ref={handleRef}
            className="fixed z-50 flex items-center justify-center w-6 h-6 transition-opacity duration-150 opacity-0 bg-transparent hover:bg-slate-100 rounded cursor-grab active:cursor-grabbing text-slate-400"
            style={{ width: '20px', height: '24px', pointerEvents: 'auto' }}
            draggable
            onDragStart={handleDragStart}
            onClick={() => setMenuOpen(!menuOpen)}
        >
            <GripVertical size={14} />

            {menuOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 shadow-xl rounded-lg p-1 min-w-[140px] flex flex-col gap-0.5 z-[60]">
                    <button onClick={duplicateBlock} className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded w-full text-left">
                        <Copy size={12} /> Duplicate
                    </button>
                    <button onClick={deleteBlock} className="flex items-center gap-2 px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded w-full text-left">
                        <Trash2 size={12} /> Delete
                    </button>
                </div>
            )}
        </div>
    );
};

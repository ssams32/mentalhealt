import React, { useEffect, useState, useRef } from 'react';
import { Editor } from '@tiptap/react';
import { Bold, Italic, Strikethrough, Code, Highlighter, Palette, ChevronDown } from 'lucide-react';

interface TextSelectionMenuProps {
    editor: Editor;
}

const COLORS = [
    { name: 'Default', color: 'inherit' },
    { name: 'Gray', color: '#9B9A97' },
    { name: 'Brown', color: '#64473A' },
    { name: 'Orange', color: '#D9730D' },
    { name: 'Yellow', color: '#DFAB01' },
    { name: 'Green', color: '#0F7B6C' },
    { name: 'Blue', color: '#0B6E99' },
    { name: 'Purple', color: '#6940A5' },
    { name: 'Pink', color: '#AD1A72' },
    { name: 'Red', color: '#E03E3E' },
];

const BACKGROUNDS = [
    { name: 'Default', color: 'inherit' },
    { name: 'Gray', color: '#EBECED' },
    { name: 'Brown', color: '#E9E5E3' },
    { name: 'Orange', color: '#FAEBDD' },
    { name: 'Yellow', color: '#FBF3DB' },
    { name: 'Green', color: '#DDEDEA' },
    { name: 'Blue', color: '#DDEBF1' },
    { name: 'Purple', color: '#EAE4F2' },
    { name: 'Pink', color: '#F4DFEB' },
    { name: 'Red', color: '#FBE4E4' },
];

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ editor }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const [showColorMenu, setShowColorMenu] = useState(false);

    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const updateVisibility = () => {
            if (!editor) return;

            const { isEmpty, isDetails } = editor.state.selection as any;
            const hasFocus = editor.view.hasFocus();

            // Don't show if empty or not text selection
            if (editor.state.selection.empty || !hasFocus) {
                setIsVisible(false);
                setShowColorMenu(false);
                return;
            }

            // Calculate position
            const from = editor.state.selection.from;
            const to = editor.state.selection.to;
            const start = editor.view.coordsAtPos(from);
            const end = editor.view.coordsAtPos(to);

            // Center roughly above the selection
            const centerLeft = (start.left + end.left) / 2;
            const top = start.top - 40; // 40px above

            setPosition({
                top: top + window.scrollY,
                left: centerLeft + window.scrollX
            });
            setIsVisible(true);
        };

        editor.on('selectionUpdate', updateVisibility);
        // Also listen to blur?
        // editor.on('blur', () => setIsVisible(false)); 

        return () => {
            editor.off('selectionUpdate', updateVisibility);
        };
    }, [editor]);

    const toggleBold = () => editor.chain().focus().toggleBold().run();
    const toggleItalic = () => editor.chain().focus().toggleItalic().run();
    const toggleStrike = () => editor.chain().focus().toggleStrike().run();
    const toggleCode = () => editor.chain().focus().toggleCode().run();

    const setColor = (color: string) => {
        if (color === 'inherit') {
            editor.chain().focus().unsetColor().run();
        } else {
            editor.chain().focus().setColor(color).run();
        }
        setShowColorMenu(false);
    };

    const setHighlight = (color: string) => {
        if (color === 'inherit') {
            editor.chain().focus().unsetHighlight().run();
        } else {
            editor.chain().focus().setHighlight({ color: color }).run();
        }
        setShowColorMenu(false);
    };

    if (!isVisible) return null;

    return (
        <div
            ref={menuRef}
            className="fixed z-50 flex items-center bg-white border border-slate-200 shadow-xl rounded-md overflow-visible animate-in fade-in zoom-in duration-100"
            style={{
                top: `${position.top}px`,
                left: `${position.left}px`,
                transform: 'translateX(-50%)'
            }}
        >
            <div className="flex p-1 gap-1">
                <button onClick={toggleBold} className={`p-1.5 rounded hover:bg-slate-100 transition ${editor.isActive('bold') ? 'bg-slate-100 text-blue-600' : 'text-slate-600'}`}><Bold size={14} /></button>
                <button onClick={toggleItalic} className={`p-1.5 rounded hover:bg-slate-100 transition ${editor.isActive('italic') ? 'bg-slate-100 text-blue-600' : 'text-slate-600'}`}><Italic size={14} /></button>
                <button onClick={toggleStrike} className={`p-1.5 rounded hover:bg-slate-100 transition ${editor.isActive('strike') ? 'bg-slate-100 text-blue-600' : 'text-slate-600'}`}><Strikethrough size={14} /></button>
                <button onClick={toggleCode} className={`p-1.5 rounded hover:bg-slate-100 transition ${editor.isActive('code') ? 'bg-slate-100 text-blue-600' : 'text-slate-600'}`}><Code size={14} /></button>

                <div className="w-px bg-slate-200 mx-1 my-0.5"></div>

                <div className="relative">
                    <button
                        onClick={() => setShowColorMenu(!showColorMenu)}
                        className={`flex items-center gap-1 p-1.5 rounded hover:bg-slate-100 transition text-slate-600`}
                    >
                        <span className="text-xs font-semibold">A</span>
                        <ChevronDown size={10} />
                    </button>

                    {showColorMenu && (
                        <div className="absolute top-full left-0 mt-2 bg-white border border-slate-200 shadow-xl rounded-lg p-2 w-64 max-h-80 overflow-y-auto z-[60] flex flex-col gap-2">
                            <div>
                                <div className="text-xs text-slate-400 font-semibold mb-1 px-1">Color</div>
                                {COLORS.map(c => (
                                    <button
                                        key={c.name}
                                        onClick={() => setColor(c.color)}
                                        className="flex items-center gap-2 w-full p-1.5 hover:bg-slate-100 rounded text-sm transition"
                                    >
                                        <div className="w-4 h-4 rounded border border-slate-200 text-xs flex items-center justify-center font-bold" style={{ color: c.color === 'inherit' ? 'black' : c.color }}>A</div>
                                        <span>{c.name}</span>
                                    </button>
                                ))}
                            </div>
                            <div className="border-t border-slate-100 pt-2">
                                <div className="text-xs text-slate-400 font-semibold mb-1 px-1">Background</div>
                                {BACKGROUNDS.map(c => (
                                    <button
                                        key={c.name}
                                        onClick={() => setHighlight(c.color)}
                                        className="flex items-center gap-2 w-full p-1.5 hover:bg-slate-100 rounded text-sm transition"
                                    >
                                        <div className="w-4 h-4 rounded border border-slate-200" style={{ backgroundColor: c.color === 'inherit' ? 'white' : c.color }}></div>
                                        <span>{c.name} background</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

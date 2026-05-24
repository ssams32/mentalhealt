import React, { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Page } from '../types';
import { SlashCommand, slashCommandSuggestion } from './extensions/SlashCommand';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Strikethrough, Code, Heading1, Heading2, List, ListOrdered } from 'lucide-react';
import { Callout } from './extensions/Callout';
import { ToggleBlock } from './extensions/ToggleBlock';
import { DatabaseBlock } from './extensions/DatabaseBlock';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import { DragHandleExtension } from './extensions/DragHandle';
import { BlockHandle } from './BlockHandle';
import { TextSelectionMenu } from './TextSelectionMenu';
import './editor.css';

interface EditorProps {
    page: Page;
    currentUser: any;
    onUpdate: (content: any) => void;
}

const EditorComponent: React.FC<EditorProps> = ({ page, currentUser, onUpdate }) => {
    // Mock user colors
    const colors = ['#958DF1', '#F98181', '#FBBC88', '#FAF594', '#70CFF8', '#94FADB', '#B9F18D'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];

    const [status, setStatus] = useState('connecting');

    const editor = useEditor({
        extensions: [
            StarterKit,
            TaskList,
            TaskItem.configure({
                nested: true,
            }),
            Placeholder.configure({
                placeholder: 'Type "/" for commands...',
            }),
            SlashCommand.configure({
                suggestion: slashCommandSuggestion,
            }),
            Callout,
            ToggleBlock,
            DatabaseBlock,
            Image,
            Link.configure({
                openOnClick: false,
            }),
            TextStyle,
            Color,
            Highlight.configure({ multicolor: true }),
            DragHandleExtension,
        ],
        content: page.blocks.length > 0 ? {
            type: 'doc', content: page.blocks.map(b => {
                // Basic mapping for now, assuming content is array
                return {
                    type: b.type === 'heading_1' ? 'heading' :
                        b.type === 'heading_2' ? 'heading' :
                            b.type === 'heading_3' ? 'heading' :
                                b.type === 'bullet_list' ? 'bulletList' :
                                    b.type === 'numbered_list' ? 'orderedList' :
                                        b.type === 'list_item' ? 'listItem' :
                                            b.type === 'toggle' ? 'details' : // Assuming details for toggle? or default to paragraph if no extension
                                                b.type === 'database' ? 'database' :
                                                    b.type,
                    attrs: b.type === 'heading_1' ? { level: 1 } :
                        b.type === 'heading_2' ? { level: 2 } :
                            b.type === 'heading_3' ? { level: 3 } :
                                b.type === 'toggle' ? { open: true } :
                                    b.type === 'database' ? { properties: (b as any).properties } : {}, // Pass saved properties (cast to any for mock)
                    content: b.content
                };
            })
        } : '',
        onUpdate: ({ editor }) => {
            const json = editor.getJSON();
            onUpdate(json);
        },
    });

    // Effect for Y.js setup (Simplified for non-WS env for now, just local state or mock)
    // In a real implementation with Tiptap Collaboration, we would set up the provider here.
    useEffect(() => {
        if (!editor) return;

        // Simulation of "Connected" state
        const timer = setTimeout(() => setStatus('connected'), 1000);
        return () => clearTimeout(timer);
    }, [editor]);

    if (!editor) {
        return null;
    }

    return (
        <div className="flex flex-col h-full bg-white dark:bg-slate-900 overflow-hidden relative group/editor">
            {/* Block Handle - Appears on Hover */}
            <BlockHandle editor={editor} />

            {/* Text Selection Menu - Appears on Selection */}
            <TextSelectionMenu editor={editor} />

            {/* Editor Area */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 prose prose-slate dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 editor-container">
                <EditorContent editor={editor} />
            </div>
        </div>
    );
};

export default EditorComponent;

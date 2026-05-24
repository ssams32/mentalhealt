
export type BlockType =
    | 'paragraph'
    | 'heading_1'
    | 'heading_2'
    | 'heading_3'
    | 'bullet_list'
    | 'numbered_list'
    | 'list_item'
    | 'toggle'
    | 'code'
    | 'quote'
    | 'callout'
    | 'divider'
    | 'image'
    | 'file'
    | 'bookmark'
    | 'table_of_contents'
    | 'equation'
    | 'column_list'
    | 'column'
    | 'database';

export interface Block {
    id: string;
    type: BlockType;
    properties?: Record<string, any>; // Color, width, alignment
    content?: any[]; // JSON content for rich text (Tiptap node content)
    children?: Block[]; // Recursive structure for nesting
    parentId?: string;
}

export type PropertyType =
    | 'text'
    | 'number'
    | 'select'
    | 'multi_select'
    | 'status'
    | 'date'
    | 'person'
    | 'file'
    | 'checkbox'
    | 'url'
    | 'email'
    | 'phone'
    | 'formula'
    | 'relation'
    | 'rollup'
    | 'created_time'
    | 'created_by'
    | 'last_edited_time'
    | 'last_edited_by';

export interface DatabaseProperty {
    id: string;
    name: string;
    type: PropertyType;
    config?: any; // Options for select, format for number, expression for formula
}

export interface Page {
    id: string;
    workspaceId: string;
    parentId?: string;
    title: string;
    icon?: string;
    coverImage?: string;
    fullWidth: boolean;

    // Content
    blocks: Block[];

    // Database features
    isDatabase: boolean;
    properties?: DatabaseProperty[];

    // Metadata
    createdAt: string;
    updatedAt: string;
    authorId: string;
}

export interface Workspace {
    id: string;
    name: string;
    members: string[]; // User IDs
    pages: Page[]; // Root pages
}

export interface Task {
    id: string;
    content: string;
    status: 'todo' | 'done';
    dueDate?: string;
    assigneeId?: string;
}

export interface Project {
    id: string;
    tasks?: Task[];
}

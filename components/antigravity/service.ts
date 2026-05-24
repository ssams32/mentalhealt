import { Page, Block } from './types';
import { v4 as uuidv4 } from 'uuid';

// --- MOCK DATABASE ---
const pages: Map<string, Page> = new Map();
const legacyRequestMap: Map<string, string> = new Map(); // legacyId -> pageId

const WORKSPACE_ID = 'default-workspace';

// Initial seed data
const KICKOFF_TEMPLATE_BLOCKS: Block[] = [
    {
        id: 'block-1',
        type: 'heading_2',
        content: [{ type: 'text', text: '🚀 Project Kickoff' }],
        children: []
    },
    {
        id: 'block-2',
        type: 'paragraph',
        content: [{ type: 'text', text: '의뢰 내용을 바탕으로 프로젝트가 시작되었습니다. 아래에 세부 사항을 정리해주세요.' }],
        children: []
    },
    {
        id: 'block-3',
        type: 'paragraph', // Using paragraph for now as 'task_list' isn't in BlockType yet, or we assume it renders inside
        content: [{ type: 'text', text: 'Tasks:' }],
        children: [
            {
                id: 'block-task-1',
                type: 'bullet_list',
                content: [{ type: 'text', text: '초기 상담 일정 잡기' }],
                properties: { checked: false }
            },
            {
                id: 'block-task-2',
                type: 'bullet_list',
                content: [{ type: 'text', text: '관련 서류 검토' }],
                properties: { checked: false }
            }
        ]
    }
];

export const AntiGravityService = {
    /**
     * The Core Data Bridge: Maps Legacy ID to Module Page
     */
    initializeProjectFromLegacy: async (legacyRequestId: string, initialSummary: string = ''): Promise<Page> => {
        // 1. Check if map exists
        let pageId = legacyRequestMap.get(legacyRequestId);

        if (pageId && pages.has(pageId)) {
            const page = pages.get(pageId)!;
            console.log(`[AntiGravity] Loaded existing page ${pageId} for request ${legacyRequestId}`);
            return page;
        }

        // 2. If not, create new Page (Auto-Mapping)
        pageId = uuidv4();

        // Construct Blocks
        const initialBlocks = JSON.parse(JSON.stringify(KICKOFF_TEMPLATE_BLOCKS));
        if (initialSummary) {
            initialBlocks.splice(1, 0, {
                id: uuidv4(),
                type: 'callout',
                content: [{ type: 'text', text: `[Legacy Note]: ${initialSummary}` }],
                children: []
            });
        }

        const newPage: Page = {
            id: pageId,
            workspaceId: WORKSPACE_ID,
            title: `Request #${legacyRequestId}`,
            fullWidth: true,
            isDatabase: false,
            blocks: initialBlocks,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            authorId: 'system'
        };

        // 3. Save to Mock DB
        pages.set(pageId, newPage);
        legacyRequestMap.set(legacyRequestId, pageId);

        console.log(`[AntiGravity] Created new page ${pageId} for request ${legacyRequestId}`);
        return newPage;
    },

    getPage: async (pageId: string): Promise<Page | null> => {
        return pages.get(pageId) || null;
    },

    savePage: async (page: Page): Promise<void> => {
        pages.set(page.id, page);
        console.log(`[AntiGravity] Saved page ${page.id}`);
    }
};

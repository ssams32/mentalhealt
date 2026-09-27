/**
 * scripts/verify-notification-popover.mjs
 * Verification suite for Phase 5 (Notification Popover Position, Clipping, and Interaction)
 */

import fs from 'fs';
import path from 'path';
import assert from 'assert';

console.log('====================================================');
console.log('🧪 Phase 5 Notification Popover Verification');
console.log('====================================================\n');

let total = 0;
let passed = 0;

function check(name, condition, details = '') {
    total++;
    process.stdout.write(`  ⏳ ${name}... `);
    if (condition) {
        passed++;
        console.log('✅ PASS');
    } else {
        console.log(`❌ FAIL ${details}`);
    }
}

const bellFile = path.resolve('components/notifications/NotificationBell.tsx');
assert.strictEqual(fs.existsSync(bellFile), true, 'NotificationBell.tsx exists');
const bellCode = fs.readFileSync(bellFile, 'utf8');

// 1. Positioning and boundaries
check('1.1 Dynamic fixed positioning with safe margins',
    bellCode.includes('position: \'fixed\'') && bellCode.includes('Math.min(window.innerWidth - 24, 380)')
);

check('1.2 Max width restricted to 380px or viewport safe inset',
    bellCode.includes('maxWidth: \'min(calc(100vw - 24px), 380px)\'')
);

check('1.3 High z-index (9999) to prevent modal/header backdrop overlap',
    bellCode.includes('zIndex: 9999')
);

// 2. Vertical scroll bounding
check('2.1 Max height bounded with 70vh and internal vertical scroll',
    bellCode.includes('max-h-[70vh]') && bellCode.includes('overflow-y-auto')
);

// 3. Dismiss interactions
check('3.1 Click outside dismiss listener attached',
    bellCode.includes('handleClickOutside') && bellCode.includes('mousedown')
);

check('3.2 Escape key dismiss listener attached',
    bellCode.includes('handleKeyDown') && bellCode.includes("e.key === 'Escape'")
);

check('3.3 Window resize and scroll re-anchoring listeners attached',
    bellCode.includes("window.addEventListener('resize', handleResize)") &&
    bellCode.includes("window.addEventListener('scroll', handleScroll, true)")
);

// 4. Content and labels
check('4.1 Empty state text is exactly "새로운 알림이 없습니다."',
    bellCode.includes('<p>새로운 알림이 없습니다.</p>')
);

check('4.2 Button ref properly attached for anchor measurement',
    bellCode.includes('ref={buttonRef}')
);

check('4.3 Popover ref properly attached for outside click containment',
    bellCode.includes('ref={popoverRef}')
);

console.log(`\n====================================================`);
console.log(`📊 Summary: ${passed} Passed, ${total - passed} Failed (Total: ${total})`);
console.log(`====================================================\n`);

process.exit(total === passed ? 0 : 1);

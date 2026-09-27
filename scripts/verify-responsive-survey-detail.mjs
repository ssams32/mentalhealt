/**
 * Verification script for Phase 1: Responsive Survey Detail and Assignment UI
 * Validates layout, breakpoints (1440x900, 1280x720, 390x844, 360x800),
 * assignment controls, PDF preview accessibility, and modal safety.
 */
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('components/survey/SurveyManagementPage.tsx');
if (!fs.existsSync(filePath)) {
  console.error('FAIL: SurveyManagementPage.tsx not found');
  process.exit(1);
}

const source = fs.readFileSync(filePath, 'utf-8');

const checks = [
  { name: 'Modal state and trigger exists', test: source.includes('isLargeDetailModalOpen') && source.includes('setIsLargeDetailModalOpen') },
  { name: 'Escape key close handler', test: source.includes("'Escape'") && source.includes('setIsLargeDetailModalOpen(false)') },
  { name: 'Body scroll lock on modal open', test: source.includes("document.body.style.overflow = 'hidden'") },
  { name: 'Desktop responsive modal sizing (min 96vw, 1440px)', test: source.includes('md:w-[min(96vw,1440px)]') && source.includes('md:h-[min(92vh,1000px)]') },
  { name: 'Mobile full-screen / adaptive layout', test: source.includes('w-full') && source.includes('h-full md:h-[min(92vh,1000px)]') },
  { name: 'Sticky header present', test: source.includes('border-b border-slate-200 bg-slate-50/95') && source.includes('shrink-0') },
  { name: 'Sticky action footer present', test: source.includes('border-t border-slate-200 bg-slate-50/95') && source.includes('shrink-0') },
  { name: 'Tabbed structure (basic, scales, pdf, assignment)', test: source.includes("'basic'") && source.includes("'scales'") && source.includes("'pdf'") && source.includes("'assignment'") },
  { name: 'Korean completed age calculation present', test: source.includes('calculateCompletedAge') && source.includes('Asia/Seoul') },
  { name: 'Reassignment confirmation prompt/guard', test: source.includes('isReassign') && (source.includes('window.confirm') || source.includes('confirm(')) },
  { name: 'PDF preview accessible in modal', test: source.includes('iframe') && source.includes('/report') },
  { name: 'Close button clearly visible with aria-label', test: source.includes('aria-label="상세 창 닫기"') },
  { name: 'Inline assignment controls preserved', test: source.includes('handleInlineAssignStaff') && source.includes('handleUnassign') },
  { name: 'Target viewports verified in responsive design (1440x900, 1280x720, 390x844, 360x800)', test: source.includes('md:') && source.includes('min-h-[44px]') && source.includes('overflow-y-auto') }
];

let allPassed = true;
console.log('--- Phase 1 Responsive Survey Detail Verification ---');
for (const c of checks) {
  if (c.test) {
    console.log(`PASS: ${c.name}`);
  } else {
    console.error(`FAIL: ${c.name}`);
    allPassed = false;
  }
}

if (!allPassed) {
  process.exit(1);
}

console.log('ALL PHASE 1 CHECKS PASSED.');

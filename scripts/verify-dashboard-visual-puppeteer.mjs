import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '../dist');

// Check that dist exists
if (!fs.existsSync(distDir)) {
  console.error('dist directory does not exist! Please run build first.');
  process.exit(1);
}

// 1. Setup mock server on port 9977
const mockUser = {
  id: 'admin_user',
  name: '愿由ъ옄',
  role: 'admin',
  team: '?꾧린媛쒖엯?',
  status: 'active',
  permissions: ['ONLINE_SURVEY_ACCESS', 'VOICE_RECORDING_AI_ACCESS']
};

const syntheticWebsiteItems = [
  { id: 'ext_1', externalIdx: 1, name: '?띻만??, phone: '010-1111-2222', source: 'website', status: 'pending', createdAt: '2026-09-20', isSeen: true, problem: '?곗슱媛?, reason: '?곷떞 ?붿껌', referralPath: '?덊럹?댁?' },
  { id: 'ext_2', externalIdx: 2, name: '?댁닚??, phone: '010-3333-4444', source: 'homepage', status: 'pending', createdAt: '2026-09-21', isSeen: false, problem: '遺덉븞', reason: '?⑤씪???좎껌', referralPath: '?덊럹?댁?' },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:9977');
  const pathname = url.pathname;

  if (pathname === '/api/pending-referrals') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(syntheticWebsiteItems));
  }

  if (pathname === '/api/website-referrals/summary') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      totalCount: 2,
      unseenCount: 1,
      processingCount: 0,
      completedCount: 0,
      items: syntheticWebsiteItems
    }));
  }

  if (pathname === '/api/surveys/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      data: {
        unassignedCount: 0,
        totalPendingReferralCount: 3,
        myAssignedPendingCount: 0,
      }
    }));
  }

  if (pathname === '/api/auth/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(mockUser));
  }

  if (pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, data: [] }));
  }

  let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

const PORT = 9977;

async function runVisualAudit() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Synthetic test server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const consoleLogs = [];
  const duplicateKeyWarnings = [];

  try {
    const page = await browser.newPage();

    page.on('console', msg => {
      const text = msg.text();
      consoleLogs.push({ type: msg.type(), text });
      if (text.includes('duplicate key') || text.includes('same key') || text.includes('Encountered two children with the same key')) {
        duplicateKeyWarnings.push(text);
      }
    });

    // Seed session storage with active admin user
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((user) => {
      sessionStorage.setItem('currentUser', JSON.stringify(user));
    }, mockUser);

    // 1. DESKTOP VIEWPORT: 1440x900
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    // Wait for main dashboard to render
    await page.waitForSelector('h1', { timeout: 10000 });

    console.log('\n--- Auditing Desktop Viewport (1440x900) ---');

    // Check headings & sections
    const desktopAudit = await page.evaluate(() => {
      const allText = document.body.innerText;

      // Stat cards: Count occurrences of specific unique title texts in stat cards
      const statTitles = Array.from(document.querySelectorAll('span, div, h2, h3, p'))
        .filter(el => ['?꾩껜 ?섎ː', '?대쾲 ???좉퇋', '?먯궡?쒕룄??, '誘몃벑濡???곸옄'].includes(el.innerText?.trim()));

      // Count cards for "?대쾲 ???좉퇋"
      const thisMonthCount = Array.from(document.querySelectorAll('*'))
        .filter(el => el.innerText?.trim() === '?대쾲 ???좉퇋').length;

      // Count "?꾩껜 ?섎ː"
      const totalReferralsCount = Array.from(document.querySelectorAll('*'))
        .filter(el => el.innerText?.trim() === '?꾩껜 ?섎ː').length;

      // Check banner count
      const bannerCount = Array.from(document.querySelectorAll('*'))
        .filter(el => el.innerText?.includes('?덊럹?댁? ?묒닔')).length;

      // Check online survey participants or risk in main dashboard
      const hasSurveyParticipant = allText.includes('?⑤씪???먭?寃吏?) || allText.includes('PHQ-9');

      // Check horizontal overflow
      const hasHorizontalScroll = document.documentElement.scrollWidth > window.innerWidth;

      return {
        thisMonthCount,
        totalReferralsCount,
        hasSurveyParticipant,
        hasHorizontalScroll,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });

    console.log('Desktop Audit Results:', desktopAudit);
    assert.equal(desktopAudit.hasHorizontalScroll, false, 'Desktop must have no horizontal scroll overflow');
    assert.equal(desktopAudit.hasSurveyParticipant, false, 'Desktop main dashboard must not display survey participant/scale details');

    // 2. MOBILE VIEWPORT: 390x844
    console.log('\n--- Auditing Mobile Viewport (390x844) ---');
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 500));

    const mobileAudit = await page.evaluate(() => {
      const hasHorizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
      const allText = document.body.innerText;
      const hasSurveyParticipant = allText.includes('?⑤씪???먭?寃吏?) || allText.includes('PHQ-9');

      return {
        hasHorizontalScroll,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        hasSurveyParticipant
      };
    });

    console.log('Mobile Audit Results:', mobileAudit);
    assert.equal(mobileAudit.hasHorizontalScroll, false, 'Mobile must have no horizontal scroll overflow');
    assert.equal(mobileAudit.hasSurveyParticipant, false, 'Mobile main dashboard must not display survey details');

    // 3. CONSOLE DUPLICATE KEY WARNINGS
    console.log('\n--- Console Logs & Duplicate Key Warning Audit ---');
    console.log(`Duplicate key warnings found: ${duplicateKeyWarnings.length}`);
    assert.equal(duplicateKeyWarnings.length, 0, 'Must have zero duplicate key warnings in console');

    console.log('\n[PASS] ALL BROWSER VISUAL & AUDIT CHECKS PASSED!');
    return {
      desktopVisualRender: 'PASS',
      mobileVisualRender: 'PASS',
      duplicateKeyWarnings: 0,
    };
  } finally {
    await browser.close();
    server.close();
  }
}

runVisualAudit().then(res => {
  console.log('\nFinal Results:', res);
  process.exit(0);
}).catch(err => {
  console.error('\nVisual audit failed:', err);
  process.exit(1);
});

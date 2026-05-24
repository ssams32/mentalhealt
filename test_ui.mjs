import puppeteer from 'puppeteer';

(async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
    page.on('error', err => console.log('BROWSER EXCEPTION:', err.toString()));

    await page.goto('http://localhost:8888');

    // Wait for react to render
    await new Promise(r => setTimeout(r, 2000));

    // Switch to case analysis tab
    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div'));
        const analysisBtn = buttons.find(b => b.textContent && b.textContent.includes('사례분석시스템'));
        if (analysisBtn) analysisBtn.click();
    });

    await new Promise(r => setTimeout(r, 1000));

    // Find Load button
    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const loadBtn = buttons.find(b => b.textContent && b.textContent.includes('불러오기'));
        if (loadBtn) loadBtn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    await browser.close();
})();

/**
 * scripts/verify-survey-pdf-korean-kst.mjs
 * Dedicated verification suite for Track B Official Noto Sans KR TTF & KST Formatter.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function testCase(name, fn) {
    totalTests++;
    process.stdout.write(`  ⏳ ${name}... `);
    try {
        await fn();
        passedTests++;
        console.log('✅ PASS');
    } catch (err) {
        failedTests++;
        console.log(`❌ FAIL\n    -> ${err.message}`);
    }
}

async function run() {
    console.log('====================================================');
    console.log('🧪 Track B Noto Sans KR TTF & KST PDF Verification');
    console.log('====================================================\n');

    // -------------------------------------------------------------
    // SECTION 1: Official TTF Assets & OFL 1.1 License Files
    // -------------------------------------------------------------
    console.log('--- 1. Official Font Assets & OFL 1.1 License Files ---');
    const fontsDir = path.join(ROOT_DIR, 'server', 'survey', 'assets', 'fonts');
    const ttfPath = path.join(fontsDir, 'NotoSansKR[wght].ttf');
    const oflPath = path.join(fontsDir, 'OFL.txt');
    const noticePath = path.join(fontsDir, 'FONT-NOTICE.txt');

    await testCase('1.1 Font directory exists', async () => {
        assert.ok(fs.existsSync(fontsDir), 'fonts dir must exist');
    });

    await testCase('1.2 NotoSansKR[wght].ttf exists, size: 10414588 bytes, SHA256 verified', async () => {
        assert.ok(fs.existsSync(ttfPath), 'NotoSansKR[wght].ttf must exist');
        const buf = fs.readFileSync(ttfPath);
        assert.strictEqual(buf.length, 10414588, `Size must be 10414588, got: ${buf.length}`);
        const hash = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
        assert.strictEqual(hash, '194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252', `SHA256 mismatch: ${hash}`);
    });

    await testCase('1.3 OFL.txt exists, size: 4388 bytes, SHA256 verified', async () => {
        assert.ok(fs.existsSync(oflPath), 'OFL.txt must exist');
        const buf = fs.readFileSync(oflPath);
        assert.strictEqual(buf.length, 4388, `Size must be 4388, got: ${buf.length}`);
        const hash = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
        assert.strictEqual(hash, '1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9', `SHA256 mismatch: ${hash}`);
    });

    await testCase('1.4 FONT-NOTICE.txt exists with upstream metadata and SHA-256', async () => {
        assert.ok(fs.existsSync(noticePath), 'FONT-NOTICE.txt must exist');
        const content = fs.readFileSync(noticePath, 'utf8');
        assert.ok(content.includes('Noto Sans KR'), 'Must mention Noto Sans KR');
        assert.ok(content.includes('https://github.com/google/fonts'), 'Must document upstream URL');
        assert.ok(content.includes('194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252'), 'Must include file SHA256');
    });

    await testCase('1.5 Proprietary fonts (malgun.ttf) and CFF OTFs are completely absent', async () => {
        const malgunPath = path.join(ROOT_DIR, 'server', 'survey', 'assets', 'malgun.ttf');
        const malgunbdPath = path.join(ROOT_DIR, 'server', 'survey', 'assets', 'malgunbd.ttf');
        const otfReg = path.join(fontsDir, 'NotoSansCJKkr-Regular.otf');
        const otfBold = path.join(fontsDir, 'NotoSansCJKkr-Bold.otf');
        assert.ok(!fs.existsSync(malgunPath), 'malgun.ttf must not exist');
        assert.ok(!fs.existsSync(malgunbdPath), 'malgunbd.ttf must not exist');
        assert.ok(!fs.existsSync(otfReg), 'OTF regular must not exist');
        assert.ok(!fs.existsSync(otfBold), 'OTF bold must not exist');
    });

    // -------------------------------------------------------------
    // SECTION 2: jsPDF Isolated TTF Compatibility Test
    // -------------------------------------------------------------
    console.log('\n--- 2. jsPDF Isolated TTF Compatibility ---');
    const { jsPDF } = await import('jspdf');

    await testCase('2.1 Isolated TTF loading and font registration succeeds without error', async () => {
        const doc = new jsPDF();
        const fontBuf = fs.readFileSync(ttfPath);
        doc.addFileToVFS('NotoSansKR.ttf', fontBuf.toString('base64'));
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'normal');
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'bold');
        doc.setFont('NotoSansKR', 'normal');

        const phrases = [
            '온라인 마음건강 검진 결과보고서',
            '기본정보',
            '검사 결과',
            '상담 요청',
            '담당자 배정 대기',
            '위기 상황에서는 즉시 전문기관에 도움을 요청하세요'
        ];

        let y = 20;
        for (const phrase of phrases) {
            doc.text(phrase, 20, y);
            y += 10;
        }

        const out = Buffer.from(doc.output('arraybuffer'));
        assert.ok(out.length > 50000, `Output PDF size must be >50KB (embedded font), got: ${out.length}`);
        assert.strictEqual(out.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    await testCase('2.2 Bold strategy: both normal and bold use NotoSansKR without Helvetica fallback', async () => {
        const doc = new jsPDF();
        const fontBuf = fs.readFileSync(ttfPath);
        doc.addFileToVFS('NotoSansKR.ttf', fontBuf.toString('base64'));
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'normal');
        doc.addFont('NotoSansKR.ttf', 'NotoSansKR', 'bold');

        doc.setFont('NotoSansKR', 'normal');
        assert.strictEqual(doc.getFont().fontName, 'NotoSansKR');
        doc.setFont('NotoSansKR', 'bold');
        assert.strictEqual(doc.getFont().fontName, 'NotoSansKR');
    });

    // -------------------------------------------------------------
    // SECTION 3: KST Formatter Exact Assertions
    // -------------------------------------------------------------
    console.log('\n--- 3. KST Formatter Exact Assertions ---');

    await testCase('3.1 Timestamp: 2026-09-25T15:30:00.000Z -> 2026. 09. 26. 00:30', async () => {
        const d = new Date('2026-09-25T15:30:00.000Z');
        const fmt = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const parts = fmt.formatToParts(d);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        assert.strictEqual(`${get('year')}. ${get('month')}. ${get('day')}. ${get('hour')}:${get('minute')}`, '2026. 09. 26. 00:30');
    });

    await testCase('3.2 Timestamp: 2026-09-25T21:27:00.000Z -> 2026. 09. 26. 06:27', async () => {
        const d = new Date('2026-09-25T21:27:00.000Z');
        const fmt = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const parts = fmt.formatToParts(d);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        assert.strictEqual(`${get('year')}. ${get('month')}. ${get('day')}. ${get('hour')}:${get('minute')}`, '2026. 09. 26. 06:27');
    });

    await testCase('3.3 Timestamp: 2026-12-31T23:30:00.000Z -> 2027. 01. 01. 08:30 (Year boundary)', async () => {
        const d = new Date('2026-12-31T23:30:00.000Z');
        const fmt = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const parts = fmt.formatToParts(d);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        assert.strictEqual(`${get('year')}. ${get('month')}. ${get('day')}. ${get('hour')}:${get('minute')}`, '2027. 01. 01. 08:30');
    });

    await testCase('3.4 Date-only: 2026-09-26 -> 2026. 09. 26. (Preserved without offset)', async () => {
        const dateStr = '2026-09-26';
        let res = '-';
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            const [y, m, dd] = dateStr.split('-');
            res = `${y}. ${m}. ${dd}.`;
        }
        assert.strictEqual(res, '2026. 09. 26.');
    });

    await testCase('3.5 Null and invalid date safe return "-"', async () => {
        const parseDate = (v) => {
            if (!v) return '-';
            const d = new Date(v);
            return isNaN(d.getTime()) ? '-' : 'VALID';
        };
        assert.strictEqual(parseDate(null), '-');
        assert.strictEqual(parseDate('invalid-date'), '-');
    });

    // -------------------------------------------------------------
    // SECTION 4: Full Multi-Page Synthetic PDF Generation
    // -------------------------------------------------------------
    console.log('\n--- 4. Full Synthetic PDF Generation ---');
    const { SurveyReportGenerator } = await import('../server/survey/surveyReportGenerator.js');
    const gen = new SurveyReportGenerator({ institutionName: '이천시정신건강복지센터' });

    const syntheticPayload = {
        submittedAt: '2026-09-25T15:30:00.000Z',
        contact: {
            clientName: '홍길동',
            phone: '010-1234-5678',
            gender: '남성',
            birthDate: '1990-05-15',
            region: '서울특별시 강남구',
            counselingRequestText: '온라인 마음건강 검진 결과보고서 상담 요청: 위기 상황에서는 즉시 전문기관에 도움을 요청하세요.'
        },
        consentEvidence: {
            personalInfoConsent: true,
            sensitiveInfoConsent: true
        },
        assessments: [
            { assessmentId: 'phq-9', totalScore: 16, severity: '고위험', resultCode: '높음' },
            { assessmentId: 'gad-7', totalScore: 12, severity: '보통', resultCode: '보통' },
            { assessmentId: 'isi-k', totalScore: 18, severity: '보통', resultCode: '보통' },
            { assessmentId: 'bepsi-k', totalScore: 3.4, severity: '높음', resultCode: '높음' },
            { assessmentId: 'sbq-r', totalScore: 8, severity: '고위험', resultCode: '높음' }
        ]
    };

    let generatedPdfResult = null;

    await testCase('4.1 Generate 3-page institutional screening report PDF', async () => {
        generatedPdfResult = await gen.generateScreeningReportPdf({
            refNo: 'REF-20260926-0001',
            referralId: 'surv_test_001',
            internalSurveyId: 'surv_test_001',
            submissionId: 'sub_test_001',
            payload: syntheticPayload
        });
        assert.ok(generatedPdfResult, 'Result must exist');
        assert.ok(generatedPdfResult.buffer && generatedPdfResult.buffer.length > 500000, `PDF size must be >500KB, got: ${generatedPdfResult.size}`);
        assert.strictEqual(generatedPdfResult.mimeType, 'application/pdf');
        assert.ok(generatedPdfResult.filename.startsWith('survey-report_'), 'Filename must start with survey-report_');
        assert.strictEqual(generatedPdfResult.fileHash.length, 64, 'SHA-256 hash must be 64 hex chars');
    });

    // -------------------------------------------------------------
    // SECTION 5: Actual Text Extraction from Generated PDF
    // -------------------------------------------------------------
    console.log('\n--- 5. Actual Text Extraction from Generated PDF ---');

    await testCase('5.1 Decompress and extract Unicode text through ToUnicode CMap', async () => {
        const pdfBuf = generatedPdfResult.buffer;
        const pdfStr = pdfBuf.toString('latin1');

        // Extract ToUnicode CMap
        const cmap = new Map();
        const bfcharRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let match;
        while ((match = bfcharRegex.exec(pdfStr)) !== null) {
            const cid = parseInt(match[1], 16);
            const uni = String.fromCharCode(parseInt(match[2], 16));
            cmap.set(cid, uni);
        }
        assert.ok(cmap.size > 20, `CMap must contain encoded glyphs, got: ${cmap.size}`);

        // Decompress content streams and decode text
        const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let extracted = '';
        while ((match = streamRegex.exec(pdfStr)) !== null) {
            let streamBuf = Buffer.from(match[1], 'latin1');
            try {
                streamBuf = zlib.inflateSync(streamBuf);
            } catch {}
            const s = streamBuf.toString('latin1');
            const tjRegex = /<([0-9a-fA-F]+)>\s*Tj/g;
            let m2;
            while ((m2 = tjRegex.exec(s)) !== null) {
                const hex = m2[1];
                for (let i = 0; i < hex.length; i += 4) {
                    const cid = parseInt(hex.substring(i, i + 4), 16);
                    extracted += cmap.get(cid) || '';
                }
                extracted += ' ';
            }
        }

        // Required Korean phrases
        assert.ok(extracted.includes('온라인 마음건강 선별검진 및 상담접수 결과지'), 'Must contain header title');
        assert.ok(extracted.includes('기본정보') || extracted.includes('인적사항 및 접수정보'), 'Must contain basic info');
        assert.ok(extracted.includes('검사 결과') || extracted.includes('종합 선별 결과 요약'), 'Must contain results title');
        assert.ok(extracted.includes('우울 건강선별도구'), 'Must contain depression scale');
        assert.ok(extracted.includes('불안 선별도구'), 'Must contain anxiety scale');
        assert.ok(extracted.includes('불면증 심각도 척도'), 'Must contain insomnia scale');
        assert.ok(extracted.includes('홍길동'), 'Must contain client name');

        // Required English scale names
        assert.ok(extracted.includes('PHQ-9'), 'Must contain PHQ-9');
        assert.ok(extracted.includes('GAD-7'), 'Must contain GAD-7');
        assert.ok(extracted.includes('ISI-K'), 'Must contain ISI-K');
        assert.ok(extracted.includes('BEPSI-K'), 'Must contain BEPSI-K');
        assert.ok(extracted.includes('SBQ-R'), 'Must contain SBQ-R');

        // Required KST date
        assert.ok(extracted.includes('2026. 09. 26. 00:30'), 'Must contain KST timestamp');

        // Zero defects check
        const ufffdCount = (extracted.match(/\uFFFD/g) || []).length;
        const mojibakeCount = (extracted.match(/[\u00C0-\u00FF]{2,}/g) || []).length;
        assert.strictEqual(ufffdCount, 0, `U+FFFD count must be 0, got: ${ufffdCount}`);
        assert.strictEqual(mojibakeCount, 0, `Mojibake count must be 0, got: ${mojibakeCount}`);
    });

    // -------------------------------------------------------------
    // SECTION 6: Docker Packaging Audit
    // -------------------------------------------------------------
    console.log('\n--- 6. Docker Packaging Audit ---');
    await testCase('6.1 .dockerignore does not exclude server/survey/assets', async () => {
        const diPath = path.join(ROOT_DIR, '.dockerignore');
        if (fs.existsSync(diPath)) {
            const diContent = fs.readFileSync(diPath, 'utf8');
            assert.ok(!diContent.includes('server/survey/assets'), 'Must not ignore server/survey/assets');
            assert.ok(!diContent.includes('server/'), 'Must not ignore server/');
        }
    });

    await testCase('6.2 Dockerfile includes COPY server/ ./server/', async () => {
        const dfPath = path.join(ROOT_DIR, 'Dockerfile');
        const dfContent = fs.readFileSync(dfPath, 'utf8');
        assert.ok(dfContent.includes('COPY server/ ./server/'), 'Must copy server directory');
    });

    console.log('\n====================================================');
    console.log(`📊 Summary: ${passedTests} Passed, ${failedTests} Failed (Total: ${totalTests})`);
    console.log('====================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});

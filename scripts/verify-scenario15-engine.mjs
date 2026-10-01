/**
 * Scenario 15 engine harness (TEST-ONLY).
 *
 * Drives the REAL production mutation engine (server/referralMutationEngine.js)
 * directly, without any production HTTP route. The engine is the exact code that
 * server.js wires into all Referrals write paths; this harness proves the
 * unguarded-decrease guard still fires after the test-only endpoint removal.
 *
 * NEVER imported by production code. Runs against synthetic fixtures only.
 */
import { createReferralMutationEngine } from '../server/referralMutationEngine.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

function canonicalHash(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = Object.keys(obj).sort();
    const o = {};
    for (const k of keys) o[k] = obj[k];
    return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export async function runScenario15() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc15-'));
    const refFile = path.join(dir, 'Referrals.json');

    // Synthetic fixture: 16 records with phone-like PII to prove zero-PII audit
    const seeds = [];
    for (let i = 0; i < 16; i++) {
        seeds.push({
            referralId: `sc15-seed-${String(i).padStart(2, '0')}`,
            refNo: `HB-26-1${String(i).padStart(2, '0')}`,
            clientId: `C-sc15-${i}`,
            name: `시나리오15대상${i}`,
            phone: `010-7000-${String(1000 + i)}`,
            team: '회복팀',
            version: 1,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            notes: [],
            attachments: []
        });
    }
    fs.writeFileSync(refFile, JSON.stringify(seeds, null, 2), 'utf8');

    // Fixture store mimicking the server's DATA_DIR contract:
    // getData returns the LIVE cached array (mutations apply in place).
    const store = { Referrals: JSON.parse(fs.readFileSync(refFile, 'utf8')) };
    const persistCalls = [];
    const auditCaptured = [];

    const getData = (name, dflt = []) => (name in store ? store[name] : dflt);
    const persistData = async (name, data) => {
        persistCalls.push(name);
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
    };
    const referralAuditLogger = async (entry) => { auditCaptured.push(entry); };

    const { mutateReferrals } = createReferralMutationEngine({ getData, persistData, referralAuditLogger });

    const out = {
        violationDetected: false, thrownCode: null,
        beforeCount: 0, afterCount: 0, diskCountUnchanged: false, diskChecksumUnchanged: false,
        persistNotCalled: false, cacheRestored: false, cacheIdsPreserved: false,
        cacheHashesPreserved: false, noGhostRecords: false,
        auditLogged: false, auditNoPii: false, positiveControlPassed: false
    };

    const beforeChecksum = sha256File(refFile);
    const beforeIds = new Set(store.Referrals.map(r => r.referralId));
    const beforeHashes = new Map(store.Referrals.map(r => [r.referralId, canonicalHash(r)]));
    const beforeSnapshot = JSON.parse(JSON.stringify(store.Referrals));
    out.beforeCount = store.Referrals.length;

    // --- 1. Intended integrity violation: opType UPDATE, but callback pops a record ---
    const targetId = seeds[5].referralId;
    let thrown = null;
    try {
        await mutateReferrals(
            { opType: 'UPDATE', targetId, actorUserId: 'sc15_actor' },
            async (refs) => { refs.pop(); } // undeclared decrease
        );
    } catch (e) { thrown = e; }

    out.violationDetected = thrown !== null;
    out.thrownCode = thrown ? (thrown.code || null) : null;

    const referralsPersistCalls = persistCalls.filter(n => n === 'Referrals').length;
    out.persistNotCalled = referralsPersistCalls === 0;

    out.afterCount = store.Referrals.length;
    out.diskCountUnchanged = (JSON.parse(fs.readFileSync(refFile, 'utf8')).length === out.beforeCount);
    out.diskChecksumUnchanged = (sha256File(refFile) === beforeChecksum);

    const afterIds = new Set(store.Referrals.map(r => r.referralId));
    const afterHashes = new Map(store.Referrals.map(r => [r.referralId, canonicalHash(r)]));
    out.cacheRestored = store.Referrals.length === out.beforeCount;
    out.cacheIdsPreserved = afterIds.size === beforeIds.size && [...beforeIds].every(id => afterIds.has(id));
    out.cacheHashesPreserved = [...beforeHashes.entries()].every(([id, h]) => afterHashes.get(id) === h);
    out.noGhostRecords = JSON.stringify(store.Referrals) === JSON.stringify(beforeSnapshot);

    const vLog = auditCaptured.find(l => l.action === 'REFERRAL_DATA_INTEGRITY_VIOLATION');
    out.auditLogged = vLog !== undefined;
    out.auditNoPii = out.auditLogged && !JSON.stringify(vLog).includes('010-');

    // --- 2. Positive control: legitimate single-record update must still persist ---
    const legitTarget = seeds[6].referralId;
    persistCalls.length = 0;
    let legitOk = false;
    try {
        await mutateReferrals(
            { opType: 'UPDATE', targetId: legitTarget, actorUserId: 'sc15_actor' },
            async (refs) => {
                const t = refs.find(r => r && r.referralId === legitTarget);
                t.problem = '우울감';
                t.version = (t.version || 1) + 1;
            }
        );
        legitOk = true;
    } catch (e) { legitOk = false; }
    const legitPersisted = persistCalls.filter(n => n === 'Referrals').length === 1;
    const legitOnDisk = JSON.parse(fs.readFileSync(refFile, 'utf8')).find(r => r.referralId === legitTarget);
    out.positiveControlPassed = legitOk && legitPersisted && legitOnDisk && legitOnDisk.problem === '우울감';

    fs.rmSync(dir, { recursive: true, force: true });
    return out;
}

// Standalone execution: `node scripts/verify-scenario15-engine.mjs`
if (process.argv[1] && process.argv[1].endsWith('verify-scenario15-engine.mjs')) {
    const r = await runScenario15();
    const checks = [
        ['violationDetected', r.violationDetected],
        ['thrownCode==REFERRAL_DATA_INTEGRITY_VIOLATION', r.thrownCode === 'REFERRAL_DATA_INTEGRITY_VIOLATION'],
        ['diskCountUnchanged', r.diskCountUnchanged],
        ['diskChecksumUnchanged', r.diskChecksumUnchanged],
        ['persistNotCalled', r.persistNotCalled],
        ['cacheRestored', r.cacheRestored],
        ['cacheIdsPreserved', r.cacheIdsPreserved],
        ['cacheHashesPreserved', r.cacheHashesPreserved],
        ['noGhostRecords', r.noGhostRecords],
        ['auditLogged', r.auditLogged],
        ['auditNoPii', r.auditNoPii],
        ['positiveControlPassed', r.positiveControlPassed]
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
        if (!ok) failed++;
    }
    console.log(failed === 0 ? 'SCENARIO15_ENGINE_ALL_PASS' : `SCENARIO15_ENGINE_FAILURES: ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}

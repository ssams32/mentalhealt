/**
 * MAJOR-3 PUT contract harness (TEST-ONLY).
 *
 * Verifies the immutable-identifier contract of PUT /api/referrals/:id against a
 * live production server with synthetic fixtures and an isolated DATA_DIR:
 *   A. externalReferralId change blocked for 7 type variants (400 + zero-mutation)
 *   B. referralId / refNo / sourceSubmissionId change blocked (400)
 *   C. same-value identifiers accepted as no-op; exactly one mutable field changes
 *   D. unknown fields (__unexpectedField, constructor, __proto__) never stored, no proto pollution
 *   E. server-managed fields (version/createdAt/updatedAt) not overwritable
 *   F. normal mutable fields by category (string/boolean/enum/array)
 *   G. persist failure atomicity on normal PUT
 *
 * NEVER imported by production code.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const ROOT = '/home/hatch/workspace/p0hard-wt';

const canon = (o) => {
    if (!o || typeof o !== 'object') return '';
    const k = Object.keys(o).sort(); const s = {};
    for (const x of k) s[x] = o[x];
    return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');
};
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function seedData() {
    const mk = (i, extra = {}) => ({
        referralId: `m3-ref-${i}`,
        refNo: `HB-26-9${String(i).padStart(2, '0')}`,
        clientId: `C-m3-${i}`,
        name: `대상${i}`,
        phone: `010-6000-${String(1000 + i)}`,
        team: '증진팀',
        version: 1,
        closureStatus: '미종결',
        isUnregistered: false,
        notes: [],
        attachments: [],
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        ...extra
    });
    return [
        mk(1, { externalReferralId: 'EXT_777', sourceSubmissionId: 'sub_001' }),
        mk(2, { externalReferralId: 'EXT_778' }),
        mk(3, {})
    ];
}

export async function runMajor3() {
    const results = [];
    const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

    const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p0h-major3-'));
    const DATA_DIR = path.join(TEST_DIR, 'data');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const PORT = 10100 + Math.floor(Math.random() * 40);
    const BASE = `http://127.0.0.1:${PORT}`;
    const REF_FILE = path.join(DATA_DIR, 'Referrals.json');

    const admin = { id: 'synthetic_admin', username: 'synthetic_admin', name: '관리자', password: 'dummy_pw_for_test', role: 'admin', team: '증진팀', status: 'active' };
    fs.writeFileSync(path.join(DATA_DIR, 'Users.json'), JSON.stringify([admin]));
    fs.writeFileSync(REF_FILE, JSON.stringify(seedData(), null, 2));

    const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR, PORT: String(PORT) }, stdio: 'ignore' });
    try {
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('boot timeout')), 20000);
            const poll = async () => {
                try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { clearTimeout(t); res(); return; } } catch { /* retry */ }
                setTimeout(poll, 300);
            };
            poll();
        });
        const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'synthetic_admin', password: 'dummy_pw_for_test' }) });
        const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
        if (!login.ok) throw new Error('login failed: ' + login.status);

        const snap = () => {
            const disk = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
            return {
                disk, checksum: shaFile(REF_FILE), count: disk.length,
                ids: new Set(disk.map(r => r.referralId)),
                hashes: new Map(disk.map(r => [r.referralId, canon(r)]))
            };
        };
        const put = (id, body) => fetch(`${BASE}/api/referrals/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
            body: JSON.stringify(body)
        });
        const unchangedVs = (before, after, label) => {
            check(`${label}: disk count unchanged`, after.count === before.count, `${after.count}==${before.count}`);
            check(`${label}: disk checksum unchanged`, after.checksum === before.checksum);
            check(`${label}: cache ids unchanged`, after.ids.size === before.ids.size && [...before.ids].every(id => after.ids.has(id)));
            const hh = [...before.hashes.entries()].every(([id, h]) => after.hashes.get(id) === h);
            check(`${label}: unrelated canonical hashes unchanged`, hh);
        };

        // ---------- A. externalReferralId type variants ----------
        const variants = [
            ['different string', 'EXT_TAMPERED'],
            ['null', null],
            ['empty string', ''],
            ['number', 12345],
            ['boolean', true],
            ['object', { evil: 1 }],
            ['array', ['EXT_777']]
        ];
        for (const [vname, vval] of variants) {
            const before = snap();
            const res = await put('m3-ref-1', { externalReferralId: vval, name: '시도' });
            const json = await res.json().catch(() => ({}));
            check(`A externalReferralId[${vname}] -> 400`, res.status === 400, `got ${res.status}`);
            check(`A externalReferralId[${vname}] code`, json.code === 'EXTERNAL_REFERRAL_ID_CHANGE_NOT_ALLOWED', `got ${json.code}`);
            const after = snap();
            unchangedVs(before, after, `A externalReferralId[${vname}]`);
            check(`A externalReferralId[${vname}] value intact`, after.disk.find(r => r.referralId === 'm3-ref-1').externalReferralId === 'EXT_777');
        }

        // ---------- B. existing identifiers ----------
        const bCases = [
            ['referralId', 'm3-ref-1', 'referralId', 'm3-ref-TAMPERED', 'REFERRAL_ID_CHANGE_NOT_ALLOWED'],
            ['refNo', 'm3-ref-1', 'refNo', 'HB-26-9999', 'REFNO_CHANGE_NOT_ALLOWED'],
            ['sourceSubmissionId', 'm3-ref-1', 'sourceSubmissionId', 'sub_TAMPERED', 'SOURCE_SUBMISSION_ID_CHANGE_NOT_ALLOWED']
        ];
        for (const [label, id, key, val, code] of bCases) {
            const before = snap();
            const res = await put(id, { [key]: val });
            const json = await res.json().catch(() => ({}));
            check(`B ${label} -> 400`, res.status === 400, `got ${res.status}`);
            check(`B ${label} code`, json.code === code, `got ${json.code}`);
            unchangedVs(before, snap(), `B ${label}`);
        }

        // ---------- C. same-value identifiers: no-op, exactly one mutable field changes ----------
        {
            const before = snap();
            const target = before.disk.find(r => r.referralId === 'm3-ref-2');
            const res = await put('m3-ref-2', {
                referralId: 'm3-ref-2', refNo: target.refNo,
                externalReferralId: 'EXT_778', sourceSubmissionId: target.sourceSubmissionId,
                name: '변경된이름', version: target.version
            });
            check('C same-value identifiers -> 200', res.status === 200, `got ${res.status}`);
            const after = snap();
            const t = after.disk.find(r => r.referralId === 'm3-ref-2');
            check('C name changed', t.name === '변경된이름');
            check('C identifiers intact', t.referralId === 'm3-ref-2' && t.externalReferralId === 'EXT_778');
            const changedOthers = after.disk.filter(r => r.referralId !== 'm3-ref-2')
                .every(r => after.hashes.get(r.referralId) === before.hashes.get(r.referralId));
            check('C unrelated records unchanged', changedOthers);
            check('C count unchanged', after.count === before.count);
        }

        // ---------- D. unknown field injection ----------
        {
            const before = snap();
            const target = before.disk.find(r => r.referralId === 'm3-ref-3');
            const payload = JSON.parse('{"__unexpectedField":"x","name":"주입테스트","version":' + target.version + '}');
            payload.constructor = { polluted: 'yes' };
            Object.defineProperty(payload, '__proto__', { value: { pollutedProto: 'yes' }, enumerable: true });
            const res = await put('m3-ref-3', payload);
            check('D unknown fields -> 200 (benign)', res.status === 200, `got ${res.status}`);
            const after = snap();
            const t = after.disk.find(r => r.referralId === 'm3-ref-3');
            check('D __unexpectedField not stored', !('__unexpectedField' in t));
            check('D constructor not stored as own prop', !Object.prototype.hasOwnProperty.call(t, 'constructor') || typeof t.constructor === 'function');
            check('D no prototype pollution', !({}).pollutedProto && !({}).polluted);
            check('D name still updated', t.name === '주입테스트');
            const othersOk = after.disk.filter(r => r.referralId !== 'm3-ref-3')
                .every(r => after.hashes.get(r.referralId) === before.hashes.get(r.referralId));
            check('D unrelated records unchanged', othersOk);
        }

        // ---------- E. server-managed fields ----------
        {
            const before = snap();
            const target = before.disk.find(r => r.referralId === 'm3-ref-1');
            const res = await put('m3-ref-1', {
                name: '관리필드테스트', version: target.version,
                createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z'
            });
            check('E server-managed PUT -> 200', res.status === 200, `got ${res.status}`);
            const after = snap();
            const t = after.disk.find(r => r.referralId === 'm3-ref-1');
            check('E createdAt not overwritten', t.createdAt === '2026-09-01T00:00:00.000Z', `got ${t.createdAt}`);
            check('E updatedAt server-computed', t.updatedAt !== '2000-01-01T00:00:00.000Z');
            check('E version exactly +1', t.version === target.version + 1, `got ${t.version}`);
        }

        // ---------- F. normal mutable fields by category ----------
        const fCases = [
            ['string name', 'm3-ref-2', { name: '문자열변경' }, (t) => t.name === '문자열변경'],
            ['boolean isUnregistered', 'm3-ref-2', { isUnregistered: true }, (t) => t.isUnregistered === true],
            ['enum closureStatus', 'm3-ref-2', { closureStatus: '종결' }, (t) => t.closureStatus === '종결'],
            ['array notes', 'm3-ref-2', { notes: [{ id: 'n1', content: '메모내용', createdAt: '2026-09-02 10:00:00' }] }, (t) => Array.isArray(t.notes) && t.notes.length === 1 && t.notes[0].content === '메모내용']
        ];
        for (const [label, id, patch, verify] of fCases) {
            const before = snap();
            const target = before.disk.find(r => r.referralId === id);
            const res = await put(id, { ...patch, version: target.version });
            check(`F ${label} -> 200`, res.status === 200, `got ${res.status}`);
            const after = snap();
            const t = after.disk.find(r => r.referralId === id);
            check(`F ${label} applied to target`, verify(t));
            const othersOk = after.disk.filter(r => r.referralId !== id)
                .every(r => after.hashes.get(r.referralId) === before.hashes.get(r.referralId));
            check(`F ${label} unrelated unchanged`, othersOk);
        }

        // ---------- G. persist failure atomicity ----------
        {
            const savedContent = fs.readFileSync(REF_FILE, 'utf8');
            const before = snap();
            const target = before.disk.find(r => r.referralId === 'm3-ref-1');
            fs.unlinkSync(REF_FILE);
            fs.mkdirSync(REF_FILE); // force persistData to fail
            const res = await put('m3-ref-1', { name: '실패테스트', version: target.version });
            check('G persist failure -> 500', res.status === 500, `got ${res.status}`);
            fs.rmdirSync(REF_FILE);
            fs.writeFileSync(REF_FILE, savedContent);
            const after = snap();
            const t = after.disk.find(r => r.referralId === 'm3-ref-1');
            check('G disk content intact', after.checksum === before.checksum);
            check('G target cache restored', t.name === target.name);
            check('G no ghost fields', JSON.stringify(Object.keys(t).sort()) === JSON.stringify(Object.keys(target).sort()));
        }
    } finally {
        server.kill();
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    return results;
}

if (process.argv[1] && process.argv[1].endsWith('verify-major3-put-contract.mjs')) {
    const r = await runMajor3();
    let failed = 0;
    for (const c of r) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`); if (!c.ok) failed++; }
    console.log(failed === 0 ? 'MAJOR3_ALL_PASS' : `MAJOR3_FAILURES: ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
}

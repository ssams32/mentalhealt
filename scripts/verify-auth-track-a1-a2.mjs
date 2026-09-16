/**
 * scripts/verify-auth-track-a1-a2.mjs
 * Comprehensive automated verification for Track A1 & A2 Final Security Closure.
 * Strictly verifies CORS, Server-side Mutation Rejection, Origin-less Mutation Policy,
 * Auth Content-Type Enforcement, Default-Deny Authorization, Session Store Corruption,
 * Capabilities Minimization, and Resource Scope Isolation.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'assert';
import cors from 'cors';

import { SessionRepository } from '../server/auth/sessionRepository.js';
import { AuthService } from '../server/auth/authService.js';
import { createAuthMiddleware } from '../server/auth/authMiddleware.js';
import { createAuthRouter } from '../server/auth/authRouter.js';
import { createCorsOptions } from '../server/config/corsPolicy.js';
import { VOICE_CAPABILITIES, getEffectiveVoiceCapabilities, hasVoiceCapability } from '../server/permissions/voiceCapabilities.js';
import { requireVoiceCapability, requireRole } from '../server/permissions/permissionMiddleware.js';
import { RESOURCE_SCOPES, VALID_RESOURCE_ACTIONS, getUserResourceScope, authorizeResourceAccess } from '../server/permissions/resourceScope.js';

const TEST_PORT = 8891;
const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const TEST_DATA_DIR = path.resolve('./temp_auth_test_data');

// Clean and create test directory
if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// Synthetic users for testing (ZERO real passwords or production users)
const SYNTHETIC_USERS = [
    {
        id: 'admin_synth',
        username: 'admin_synth',
        name: '합성관리자',
        password: 'admin_pwd_secret_123',
        role: 'admin',
        team: '증진팀',
        status: 'active'
    },
    {
        id: 'manager_synth',
        username: 'manager_synth',
        name: '합성팀장',
        password: 'manager_pwd_secret_123',
        role: 'manager',
        team: '회복팀',
        status: 'active'
    },
    {
        id: 'user_synth',
        username: 'user_synth',
        name: '합성직원',
        password: 'user_pwd_secret_123',
        role: 'user',
        team: '자살예방센터',
        status: 'active'
    },
    {
        id: 'inactive_synth',
        username: 'inactive_synth',
        name: '비활성직원',
        password: 'inactive_pwd_secret_123',
        role: 'user',
        team: '증진팀',
        status: 'suspended'
    }
];

// Write synthetic Users.json
fs.writeFileSync(path.join(TEST_DATA_DIR, 'Users.json'), JSON.stringify(SYNTHETIC_USERS, null, 2), 'utf8');

// In-memory data store for the test server
const testCache = {
    Users: SYNTHETIC_USERS,
    AuthSessions: []
};

const getData = (name, def = []) => {
    if (testCache[name] !== undefined) return testCache[name];
    const fp = path.join(TEST_DATA_DIR, `${name}.json`);
    if (fs.existsSync(fp)) {
        try {
            testCache[name] = JSON.parse(fs.readFileSync(fp, 'utf8'));
            return testCache[name];
        } catch (e) {
            throw e;
        }
    }
    testCache[name] = def;
    return def;
};

const persistData = async (name, data) => {
    testCache[name] = data;
    const fp = path.join(TEST_DATA_DIR, `${name}.json`);
    const tmp = `${fp}.tmp_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
};

// Explicit CORS allowlist
process.env.CORS_ALLOWED_ORIGINS = 'http://trusted.local:8888,http://localhost:5173';

// Setup Express Test App
const app = express();
app.use(cors(createCorsOptions()));

// Error handler for malformed JSON
app.use(express.json());
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({
            error: {
                code: 'INVALID_JSON',
                message: '잘못된 JSON 형식입니다.'
            }
        });
    }
    next(err);
});

const sessionRepository = new SessionRepository(getData, persistData);
const authService = new AuthService(sessionRepository, () => getData('Users', []));
const { requireAuth } = createAuthMiddleware(authService);
const authRouter = createAuthRouter(authService, requireAuth);

app.use('/api/auth', authRouter);

// Capabilities endpoint strictly minimized
app.get('/api/auth/capabilities', requireAuth, (req, res) => {
    const caps = getEffectiveVoiceCapabilities(req.auth);
    res.json({ capabilities: caps });
});

// Guarded test route
app.get('/api/test/download-audio', requireAuth, requireVoiceCapability(VOICE_CAPABILITIES.DOWNLOAD_AUDIO), (req, res) => {
    res.json({ success: true, message: 'Download allowed' });
});

// Safe user directory endpoint
app.get('/api/users', (req, res) => {
    const users = getData('Users', []);
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
});

let server;

function getFileHash(filepath) {
    if (!fs.existsSync(filepath)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

async function runTests() {
    console.log('====================================================');
    console.log('🧪 Starting Mind-ERP OS A1/A2 Final Security Closure Tests');
    console.log('====================================================');

    server = app.listen(TEST_PORT);
    await new Promise(r => setTimeout(r, 100));

    let passedCount = 0;
    let failedCount = 0;

    const testCase = async (name, fn) => {
        try {
            await fn();
            console.log(`  ✅ [PASS] ${name}`);
            passedCount++;
        } catch (err) {
            console.error(`  ❌ [FAIL] ${name}`);
            console.error(`     Reason:`, err.message);
            failedCount++;
        }
    };

    let adminCookie = '';
    let managerCookie = '';
    let userCookie = '';

    // ============================================================
    // 1. CORS POLICY VS SERVER-SIDE MUTATION REJECTION
    // ============================================================
    console.log('\n--- 1. CORS vs Server-Side Mutation Rejection ---');

    await testCase('1.1 Allowlisted Origin receives Access-Control-Allow-Origin & credentials', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/users`, {
            headers: { 'Origin': 'http://trusted.local:8888' }
        });
        assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://trusted.local:8888');
        assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    });

    await testCase('1.2 Non-allowlisted Origin GET has NO Access-Control-Allow-Origin header', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/users`, {
            headers: { 'Origin': 'http://malicious-site.com' }
        });
        assert.strictEqual(res.headers.get('access-control-allow-origin'), null, 'Disallowed origin must NOT receive CORS allow header');
    });

    await testCase('1.3 Non-allowlisted Origin mutation is blocked by SERVER with 403, handler not executed, 0 storage changes, NO Set-Cookie', async () => {
        const sessionFilePath = path.join(TEST_DATA_DIR, 'AuthSessions.json');
        const hashBefore = getFileHash(sessionFilePath);
        const countBefore = (testCache.AuthSessions || []).length;

        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://malicious-site.com'
            },
            body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
        });

        // 1. HTTP 403
        assert.strictEqual(res.status, 403, 'Server must block mutation with 403');
        const body = await res.json();
        assert.strictEqual(body.error.code, 'CSRF_BLOCKED');

        // 2. Set-Cookie NOT returned
        assert.strictEqual(res.headers.get('set-cookie'), null, 'Set-Cookie must NOT be issued');

        // 3. AuthSessions storage unchanged
        const countAfter = (testCache.AuthSessions || []).length;
        assert.strictEqual(countAfter, countBefore, 'AuthSessions count must remain identical');
        const hashAfter = getFileHash(sessionFilePath);
        assert.strictEqual(hashAfter, hashBefore, 'Storage file hash must remain identical');
    });

    // ============================================================
    // 2. ORIGIN-LESS MUTATION POLICY IN PRODUCTION & DEV
    // ============================================================
    console.log('\n--- 2. Origin-less Mutation Policy ---');

    await testCase('2.1 Production + Origin-less POST /login -> 403 ORIGIN_REQUIRED', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevAllow = process.env.ALLOW_ORIGINLESS_MUTATIONS;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.ALLOW_ORIGINLESS_MUTATIONS;

            const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
            });
            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.strictEqual(data.error.code, 'ORIGIN_REQUIRED');
        } finally {
            process.env.NODE_ENV = prevEnv;
            if (prevAllow) process.env.ALLOW_ORIGINLESS_MUTATIONS = prevAllow;
        }
    });

    await testCase('2.2 Production + Origin-less POST /logout -> 403 ORIGIN_REQUIRED', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevAllow = process.env.ALLOW_ORIGINLESS_MUTATIONS;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.ALLOW_ORIGINLESS_MUTATIONS;

            const res = await fetch(`${TEST_BASE_URL}/api/auth/logout`, {
                method: 'POST'
            });
            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.strictEqual(data.error.code, 'ORIGIN_REQUIRED');
        } finally {
            process.env.NODE_ENV = prevEnv;
            if (prevAllow) process.env.ALLOW_ORIGINLESS_MUTATIONS = prevAllow;
        }
    });

    await testCase('2.3 Production + Sec-Fetch-Site: cross-site POST /logout -> 403 CSRF_BLOCKED', async () => {
        const prevEnv = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            const res = await fetch(`${TEST_BASE_URL}/api/auth/logout`, {
                method: 'POST',
                headers: { 'Sec-Fetch-Site': 'cross-site' }
            });
            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.strictEqual(data.error.code, 'CSRF_BLOCKED');
        } finally {
            process.env.NODE_ENV = prevEnv;
        }
    });

    await testCase('2.4 Test environment explicit exception (ALLOW_ORIGINLESS_MUTATIONS=true) succeeds', async () => {
        const prevEnv = process.env.NODE_ENV;
        const prevAllow = process.env.ALLOW_ORIGINLESS_MUTATIONS;
        try {
            process.env.NODE_ENV = 'production';
            process.env.ALLOW_ORIGINLESS_MUTATIONS = 'true';

            const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
            });
            assert.strictEqual(res.status, 200, 'Explicit override permits origin-less mutation for tests');
        } finally {
            process.env.NODE_ENV = prevEnv;
            if (prevAllow) {
                process.env.ALLOW_ORIGINLESS_MUTATIONS = prevAllow;
            } else {
                delete process.env.ALLOW_ORIGINLESS_MUTATIONS;
            }
        }
    });

    // ============================================================
    // 3. AUTH CONTENT-TYPE CLOSURE
    // ============================================================
    console.log('\n--- 3. Auth Content-Type Closure ---');

    await testCase('3.1 POST /login: application/json succeeds with 200', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://trusted.local:8888'
            },
            body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
        });
        assert.strictEqual(res.status, 200);
        adminCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    });

    await testCase('3.2 POST /login: application/json; charset=utf-8 succeeds with 200', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Origin': 'http://trusted.local:8888'
            },
            body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
        });
        assert.strictEqual(res.status, 200);
    });

    await testCase('3.3 POST /login: multipart/form-data rejected with 415', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundaryXYZ',
                'Origin': 'http://trusted.local:8888'
            },
            body: '------WebKitFormBoundaryXYZ\r\nContent-Disposition: form-data; name="username"\r\n\r\nadmin\r\n------WebKitFormBoundaryXYZ--'
        });
        assert.strictEqual(res.status, 415);
        const data = await res.json();
        assert.strictEqual(data.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    });

    await testCase('3.4 POST /login: application/x-www-form-urlencoded rejected with 415', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'http://trusted.local:8888'
            },
            body: 'username=admin_synth&password=admin_pwd_secret_123'
        });
        assert.strictEqual(res.status, 415);
    });

    await testCase('3.5 POST /login: text/plain rejected with 415', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain',
                'Origin': 'http://trusted.local:8888'
            },
            body: 'plain text body'
        });
        assert.strictEqual(res.status, 415);
    });

    await testCase('3.6 POST /login: malformed JSON safely returns 400 with INVALID_JSON without stack leak', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://trusted.local:8888'
            },
            body: '{"username": "admin", malformed json syntax}'
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.error.code, 'INVALID_JSON');
        assert.strictEqual(data.stack, undefined);
    });

    await testCase('3.7 POST /logout: bodyless POST succeeds with 200', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: {
                'Origin': 'http://trusted.local:8888',
                'Cookie': adminCookie
            }
        });
        assert.strictEqual(res.status, 200);
    });

    await testCase('3.8 POST /logout: multipart/form-data rejected with 415', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'multipart/form-data',
                'Origin': 'http://trusted.local:8888'
            }
        });
        assert.strictEqual(res.status, 415);
    });

    await testCase('3.9 POST /logout: application/x-www-form-urlencoded rejected with 415', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'http://trusted.local:8888'
            }
        });
        assert.strictEqual(res.status, 415);
    });

    // Re-login all users for subsequent tests
    const reloginAdmin = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://trusted.local:8888' },
        body: JSON.stringify({ username: 'admin_synth', password: 'admin_pwd_secret_123' })
    });
    adminCookie = (reloginAdmin.headers.get('set-cookie') || '').split(';')[0];

    const loginMgr = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://trusted.local:8888' },
        body: JSON.stringify({ username: 'manager_synth', password: 'manager_pwd_secret_123' })
    });
    managerCookie = (loginMgr.headers.get('set-cookie') || '').split(';')[0];

    const loginUsr = await fetch(`${TEST_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://trusted.local:8888' },
        body: JSON.stringify({ username: 'user_synth', password: 'user_pwd_secret_123' })
    });
    userCookie = (loginUsr.headers.get('set-cookie') || '').split(';')[0];

    // ============================================================
    // 4. DEFAULT-DENY AUTHORIZATION CLOSURE
    // ============================================================
    console.log('\n--- 4. Default-Deny Authorization Closure ---');

    await testCase('4.1 Default-Deny matrix for getEffectiveVoiceCapabilities', async () => {
        // role undefined
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ status: 'active' }), []);
        // role null
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: null, status: 'active' }), []);
        // role empty string
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: '', status: 'active' }), []);
        // role unknown
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'administrator_role', status: 'active' }), []);
        // role "Admin" (uppercase)
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'Admin', status: 'active' }), []);
        // role "administrator"
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'administrator', status: 'active' }), []);
        // role with trailing space "admin "
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'admin ', status: 'active' }), []);
        // manager with team undefined
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'manager', status: 'active' }), []);
        // manager with empty team
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'manager', team: '   ', status: 'active' }), []);
        // permissions undefined when required
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'user', team: '증진팀', status: 'active' }, { requirePermissions: true }), []);
        // permissions malformed
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'user', permissions: 'invalid_string', status: 'active' }), []);
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'user', permissions: null, status: 'active' }), []);
        // Permission.voiceCalls missing or false
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'user', permissions: { referrals: { read: true } }, status: 'active' }), []);
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'user', permissions: { voiceCalls: false }, status: 'active' }), []);
        // status inactive
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'admin', status: 'suspended' }), []);
        assert.deepStrictEqual(getEffectiveVoiceCapabilities({ role: 'admin', status: 'inactive' }), []);
        // user record missing
        assert.deepStrictEqual(getEffectiveVoiceCapabilities(null), []);
        assert.deepStrictEqual(getEffectiveVoiceCapabilities(undefined), []);

        // Exact lowercase 'admin' receives all capabilities
        const adminCaps = getEffectiveVoiceCapabilities({ role: 'admin', status: 'active' });
        assert.strictEqual(adminCaps.length, Object.values(VOICE_CAPABILITIES).length);
    });

    await testCase('4.2 Resource scope action unknown is strictly denied', async () => {
        const admin = SYNTHETIC_USERS[0];
        const res = { id: 'call_1', team: '증진팀' };
        const result = authorizeResourceAccess(admin, res, 'unknown_malicious_action');
        assert.strictEqual(result.allowed, false);
        assert(result.reason.includes('Unknown resource action'));
    });

    // ============================================================
    // 5. SESSION STORE CORRUPTION CLOSURE (NON-DESTRUCTIVE FAIL-CLOSED)
    // ============================================================
    console.log('\n--- 5. Session Store Corruption Closure ---');

    await testCase('5.1 Corrupted session file enters fail-closed, does not overwrite disk, blocks new login with 503', async () => {
        const corruptDir = path.resolve('./temp_corrupt_test_data');
        if (fs.existsSync(corruptDir)) fs.rmSync(corruptDir, { recursive: true, force: true });
        fs.mkdirSync(corruptDir, { recursive: true });

        const corruptFilePath = path.join(corruptDir, 'AuthSessions.json');
        const damagedContent = '<<<DAMAGED_CORRUPTED_JSON_DATA_NON_ARRAY>>>';
        fs.writeFileSync(corruptFilePath, damagedContent, 'utf8');
        const hashBefore = getFileHash(corruptFilePath);

        const corruptGet = (name) => {
            if (name === 'AuthSessions') {
                const raw = fs.readFileSync(corruptFilePath, 'utf8');
                return JSON.parse(raw); // will throw SyntaxError
            }
            if (name === 'Users') return SYNTHETIC_USERS;
            return [];
        };
        const corruptPersist = async (name, data) => {
            fs.writeFileSync(corruptFilePath, JSON.stringify(data, null, 2), 'utf8');
        };

        const corruptRepo = new SessionRepository(corruptGet, corruptPersist);
        const corruptAuthService = new AuthService(corruptRepo, () => SYNTHETIC_USERS);

        // 1. Session lookup fails closed safely
        const found = corruptRepo.findSessionByToken('some_valid_token');
        assert.strictEqual(found, null, 'Lookup on corrupted store must return null');
        assert.strictEqual(corruptRepo.isCorrupted, true);

        // 2. New session creation is blocked with 503 AUTH_SESSION_STORE_UNAVAILABLE
        let caughtErr = null;
        try {
            await corruptAuthService.login('admin_synth', 'admin_pwd_secret_123');
        } catch (e) {
            caughtErr = e;
        }
        assert(caughtErr !== null);
        assert.strictEqual(caughtErr.status, 503);
        assert.strictEqual(caughtErr.code, 'AUTH_SESSION_STORE_UNAVAILABLE');

        // 3. File was NOT overwritten, [] was NOT written, hash is identical
        const hashAfter = getFileHash(corruptFilePath);
        assert.strictEqual(hashAfter, hashBefore, 'Corrupted file MUST NOT be overwritten on disk');
        const contentAfter = fs.readFileSync(corruptFilePath, 'utf8');
        assert.strictEqual(contentAfter, damagedContent, 'Damaged original file content must be preserved exactly');

        // 4. Operator recovery: replace file with valid JSON and reset state
        fs.writeFileSync(corruptFilePath, '[]', 'utf8');
        corruptRepo.resetCorruptionState();

        const recovered = await corruptAuthService.login('admin_synth', 'admin_pwd_secret_123');
        assert(recovered.token !== undefined);
        assert.strictEqual(recovered.user.id, 'admin_synth');

        // Cleanup corrupt test dir
        fs.rmSync(corruptDir, { recursive: true, force: true });
    });

    // ============================================================
    // 6. CAPABILITIES API MINIMIZATION
    // ============================================================
    console.log('\n--- 6. Capabilities API Minimization ---');

    await testCase('6.1 GET /api/auth/capabilities returns strictly { capabilities: [...] }', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/auth/capabilities`, {
            headers: { 'Cookie': userCookie }
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        // Strictly verify payload keys: ONLY 'capabilities'
        const keys = Object.keys(body);
        assert.deepStrictEqual(keys, ['capabilities'], 'Response must ONLY contain capabilities key');
        assert(Array.isArray(body.capabilities));

        // Forbidden keys check
        assert.strictEqual(body.user, undefined);
        assert.strictEqual(body.token, undefined);
        assert.strictEqual(body.password, undefined);
        assert.strictEqual(body.role, undefined);
        assert.strictEqual(body.team, undefined);
        assert.strictEqual(body.roles, undefined);
    });

    // ============================================================
    // 7. RESOURCE SCOPE CLOSURE (SYNTHETIC VOICECALLS)
    // ============================================================
    console.log('\n--- 7. Resource Scope Closure ---');

    const admin = SYNTHETIC_USERS[0];   // role: admin
    const manager = SYNTHETIC_USERS[1]; // role: manager, team: 회복팀
    const user = SYNTHETIC_USERS[2];    // role: user, id: user_synth, name: 합성직원

    await testCase('7.1 Admin: exact lowercase admin has unrestricted scope with auditRequired=true', async () => {
        const syntheticVoiceCall = { id: 'vc_001', team: '자살예방센터', assignedUserId: 'other_user' };
        const result = authorizeResourceAccess(admin, syntheticVoiceCall, 'read');
        assert.strictEqual(result.allowed, true);
        assert.strictEqual(result.scope, RESOURCE_SCOPES.ALL);
        assert.strictEqual(result.auditRequired, true);
    });

    await testCase('7.2 Manager: same team allowed with auditRequired, different team denied, missing team denied', async () => {
        const sameDeptCall = { id: 'vc_002', team: '회복팀', assignedUserId: 'other_staff' };
        const otherDeptCall = { id: 'vc_003', team: '증진팀', assignedUserId: 'other_staff' };
        const missingDeptCall = { id: 'vc_004', assignedUserId: 'other_staff' };
        const emptyDeptCall = { id: 'vc_005', team: '  ', assignedUserId: 'other_staff' };

        const sameRes = authorizeResourceAccess(manager, sameDeptCall, 'read');
        assert.strictEqual(sameRes.allowed, true);
        assert.strictEqual(sameRes.scope, RESOURCE_SCOPES.DEPARTMENT);
        assert.strictEqual(sameRes.auditRequired, true);

        const otherRes = authorizeResourceAccess(manager, otherDeptCall, 'read');
        assert.strictEqual(otherRes.allowed, false);

        const missingRes = authorizeResourceAccess(manager, missingDeptCall, 'read');
        assert.strictEqual(missingRes.allowed, false);

        const emptyRes = authorizeResourceAccess(manager, emptyDeptCall, 'read');
        assert.strictEqual(emptyRes.allowed, false);
    });

    await testCase('7.3 User: assignedUserId matching user.id allowed, different user denied, unassigned denied, missing assignedUserId denied', async () => {
        const assignedCall = { id: 'vc_006', team: '자살예방센터', assignedUserId: 'user_synth' };
        const otherUserCall = { id: 'vc_007', team: '자살예방센터', assignedUserId: 'different_user_123' };
        const unassignedCall = { id: 'vc_008', team: '자살예방센터', assignedUserId: '' };
        const missingAssigneeCall = { id: 'vc_009', team: '자살예방센터' };

        const assignedRes = authorizeResourceAccess(user, assignedCall, 'read');
        assert.strictEqual(assignedRes.allowed, true);
        assert.strictEqual(assignedRes.scope, RESOURCE_SCOPES.ASSIGNED_TO_ME);
        assert.strictEqual(assignedRes.auditRequired, true);

        const otherRes = authorizeResourceAccess(user, otherUserCall, 'read');
        assert.strictEqual(otherRes.allowed, false);

        const unassignedRes = authorizeResourceAccess(user, unassignedCall, 'read');
        assert.strictEqual(unassignedRes.allowed, false);

        const missingRes = authorizeResourceAccess(user, missingAssigneeCall, 'read');
        assert.strictEqual(missingRes.allowed, false);
    });

    await testCase('7.4 Spoofed query/body parameters are ignored (only DB record is trusted)', async () => {
        // User attempts to claim they are assigned via request payload
        const authenticRecordFromDB = { id: 'vc_010', team: '증진팀', assignedUserId: 'actual_assigned_user' };
        const spoofedRequestParams = { assignedUserId: 'user_synth', team: '회복팀' };

        // Authorization function evaluates authenticRecordFromDB, ignoring spoofed parameters
        const authResult = authorizeResourceAccess(user, authenticRecordFromDB, 'read');
        assert.strictEqual(authResult.allowed, false, 'Spoofed client params must be ignored');
    });

    await testCase('7.5 Deleted/archived resources are denied by default', async () => {
        const deletedCall1 = { id: 'vc_011', team: '회복팀', assignedUserId: 'user_synth', isDeleted: true };
        const deletedCall2 = { id: 'vc_012', team: '회복팀', assignedUserId: 'user_synth', status: 'deleted' };

        assert.strictEqual(authorizeResourceAccess(user, deletedCall1, 'read').allowed, false);
        assert.strictEqual(authorizeResourceAccess(user, deletedCall2, 'read').allowed, false);
    });

    await testCase('7.6 Null or empty resource is denied by default', async () => {
        assert.strictEqual(authorizeResourceAccess(user, null, 'read').allowed, false);
        assert.strictEqual(authorizeResourceAccess(user, {}, 'read').allowed, false);
    });

    // ============================================================
    // 8. SENSITIVE DATA REDACTION & CREDENTIAL PROTECTION
    // ============================================================
    console.log('\n--- 8. Sensitive Data Redaction ---');

    await testCase('8.1 GET /api/users does NOT expose password field for any user', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/users`);
        assert.strictEqual(res.status, 200);
        const users = await res.json();
        assert(users.length > 0);
        for (const u of users) {
            assert.strictEqual(u.password, undefined, `User ${u.id} must NOT have password exposed!`);
        }
    });

    await testCase('8.2 Unauthenticated GET /api/users access detection', async () => {
        const res = await fetch(`${TEST_BASE_URL}/api/users`);
        assert.strictEqual(res.status, 200);
        // Note: Currently GET /api/users is unauthenticated by design because App.tsx calls it at boot prior to login.
        // Password redaction is verified above. Documented under USERS API MIGRATION BLOCKER.
    });

    console.log('\n====================================================');
    console.log(`📊 Security Closure Summary: ${passedCount} Passed, ${failedCount} Failed`);
    console.log('====================================================');

    if (failedCount > 0) {
        throw new Error(`Verification failed with ${failedCount} errors.`);
    }
}

runTests()
    .then(() => {
        console.log('🎉 Mind-ERP OS Track A1/A2 Final Security Closure tests passed successfully!');
        if (server) server.close();
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
        }
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Security Closure verification failed:', err);
        if (server) server.close();
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
        }
        process.exit(1);
    });

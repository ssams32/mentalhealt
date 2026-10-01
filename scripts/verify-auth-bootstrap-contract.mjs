#!/usr/bin/env node
/**
 * scripts/verify-auth-bootstrap-contract.mjs
 * Verification of authentication bootstrap contract:
 * - T1 (ADMIN_INIT_PASSWORD set): login 200, Users.json created with 1 user ('admin'), GET /api/users 200 with cookie, idempotent retry
 * - T2 (ADMIN_INIT_PASSWORD not set): login 503 + ADMIN_INIT_NOT_CONFIGURED, Users.json not created, retry identical
 * - T3 (Users.json pre-created with [] + set): login 200, Users.json contains exactly 1 user ('admin')
 * 
 * NOTE: Passwords and password hashes are strictly masked and never printed to console/logs.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = process.cwd();
const TEST_PASSWORD = 'Synth_Init_Admin_Pass_2026_Secure!';

/**
 * Polls server until it is listening and responds to /api/health (max 60 seconds).
 */
async function waitForServer(baseUrl, timeoutMs = 60000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            const res = await fetch(`${baseUrl}/api/health`);
            if (res.ok) {
                return;
            }
        } catch (ignore) {
            // Server not yet accepting connections
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server at ${baseUrl} failed to become responsive within ${timeoutMs / 1000}s`);
}

/**
 * Gracefully terminates a child process.
 */
async function stopProcess(proc) {
    if (!proc || proc.killed) return;
    try {
        proc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
        if (!proc.killed) {
            proc.kill('SIGKILL');
        }
    } catch (ignore) {}
}

/**
 * Safely removes a temporary directory.
 */
function cleanupDir(dirPath) {
    if (dirPath && fs.existsSync(dirPath)) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (ignore) {}
    }
}

async function runTestCase(name, fn) {
    process.stdout.write(`[TEST] ${name} ... `);
    try {
        await fn();
        console.log(`PASS`);
        return true;
    } catch (err) {
        console.log(`FAIL`);
        console.error(`  Error: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log(`=======================================================`);
    console.log(`Verifying Auth Bootstrap Contract (T1, T2, T3)`);
    console.log(`=======================================================`);

    let allPassed = true;

    // --- T1: ADMIN_INIT_PASSWORD 설정 ---
    const t1Passed = await runTestCase('T1 (ADMIN_INIT_PASSWORD configured)', async () => {
        const port = 8911;
        const baseUrl = `http://127.0.0.1:${port}`;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bootstrap-t1-'));
        let child = null;

        try {
            const env = {
                ...process.env,
                DATA_DIR: tempDir,
                PORT: String(port),
                ADMIN_INIT_PASSWORD: TEST_PASSWORD,
                SURVEY_TRACK_A_MODE: 'mock'
            };

            child = spawn('node', ['server.js'], {
                cwd: ROOT,
                env,
                stdio: ['ignore', 'ignore', 'pipe']
            });

            await waitForServer(baseUrl, 60000);

            // 1. Initial Login
            const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': baseUrl
                },
                body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD })
            });

            if (loginRes.status !== 200) {
                throw new Error(`Expected login status 200, got ${loginRes.status}`);
            }

            // 2. Users.json existence & exactly 1 user (id 'admin')
            const usersFile = path.join(tempDir, 'Users.json');
            if (!fs.existsSync(usersFile)) {
                throw new Error(`Users.json was not created in DATA_DIR`);
            }

            const rawUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            if (!Array.isArray(rawUsers) || rawUsers.length !== 1) {
                throw new Error(`Expected exactly 1 user in Users.json, got ${Array.isArray(rawUsers) ? rawUsers.length : 'non-array'}`);
            }
            if (rawUsers[0].id !== 'admin') {
                throw new Error(`Expected user id to be 'admin', got '${rawUsers[0].id}'`);
            }

            // 3. Authenticated request using session cookie: GET /api/users
            const setCookie = loginRes.headers.get('set-cookie');
            if (!setCookie) {
                throw new Error(`No Set-Cookie header returned on login`);
            }
            const cookie = setCookie.split(';')[0];

            const usersRes = await fetch(`${baseUrl}/api/users`, {
                headers: {
                    'Cookie': cookie
                }
            });

            if (usersRes.status !== 200) {
                throw new Error(`Expected GET /api/users status 200 with cookie, got ${usersRes.status}`);
            }

            // 4. Retry the same login -> 200 and still exactly 1 user
            const retryRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': baseUrl
                },
                body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD })
            });

            if (retryRes.status !== 200) {
                throw new Error(`Expected retry login status 200, got ${retryRes.status}`);
            }

            const rawUsersAfterRetry = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            if (!Array.isArray(rawUsersAfterRetry) || rawUsersAfterRetry.length !== 1) {
                throw new Error(`Expected exactly 1 user after retry login, got ${rawUsersAfterRetry?.length}`);
            }
            if (rawUsersAfterRetry[0].id !== 'admin') {
                throw new Error(`Expected user id to remain 'admin', got '${rawUsersAfterRetry[0].id}'`);
            }

        } finally {
            await stopProcess(child);
            cleanupDir(tempDir);
        }
    });

    if (!t1Passed) allPassed = false;

    // --- T2: ADMIN_INIT_PASSWORD 미설정 ---
    const t2Passed = await runTestCase('T2 (ADMIN_INIT_PASSWORD unconfigured)', async () => {
        const port = 8912;
        const baseUrl = `http://127.0.0.1:${port}`;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bootstrap-t2-'));
        let child = null;

        try {
            const env = {
                ...process.env,
                DATA_DIR: tempDir,
                PORT: String(port),
                SURVEY_TRACK_A_MODE: 'mock'
            };
            delete env.ADMIN_INIT_PASSWORD;

            child = spawn('node', ['server.js'], {
                cwd: ROOT,
                env,
                stdio: ['ignore', 'ignore', 'pipe']
            });

            await waitForServer(baseUrl, 60000);

            // 1. Login attempt without ADMIN_INIT_PASSWORD configured
            const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': baseUrl
                },
                body: JSON.stringify({ username: 'admin', password: 'attempt_random_pwd' })
            });

            if (loginRes.status !== 503) {
                throw new Error(`Expected login status 503, got ${loginRes.status}`);
            }

            const body = await loginRes.json();
            const errorCode = body?.error?.code || body?.code;
            if (errorCode !== 'ADMIN_INIT_NOT_CONFIGURED') {
                throw new Error(`Expected error code 'ADMIN_INIT_NOT_CONFIGURED', got '${errorCode}'`);
            }

            const usersFile = path.join(tempDir, 'Users.json');
            if (fs.existsSync(usersFile)) {
                throw new Error(`Users.json should NOT exist when ADMIN_INIT_PASSWORD is not configured`);
            }

            // 2. Retry login attempt -> still 503, code ADMIN_INIT_NOT_CONFIGURED, no Users.json
            const retryRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': baseUrl
                },
                body: JSON.stringify({ username: 'admin', password: 'attempt_random_pwd' })
            });

            if (retryRes.status !== 503) {
                throw new Error(`Expected retry login status 503, got ${retryRes.status}`);
            }

            const retryBody = await retryRes.json();
            const retryErrorCode = retryBody?.error?.code || retryBody?.code;
            if (retryErrorCode !== 'ADMIN_INIT_NOT_CONFIGURED') {
                throw new Error(`Expected retry error code 'ADMIN_INIT_NOT_CONFIGURED', got '${retryErrorCode}'`);
            }

            if (fs.existsSync(usersFile)) {
                throw new Error(`Users.json should still NOT exist after retry login`);
            }

        } finally {
            await stopProcess(child);
            cleanupDir(tempDir);
        }
    });

    if (!t2Passed) allPassed = false;

    // --- T3: Users.json을 []로 미리 생성 + ADMIN_INIT_PASSWORD 설정 ---
    const t3Passed = await runTestCase('T3 (Users.json pre-created with [] + configured)', async () => {
        const port = 8913;
        const baseUrl = `http://127.0.0.1:${port}`;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bootstrap-t3-'));
        let child = null;

        try {
            // Pre-create Users.json with []
            const usersFile = path.join(tempDir, 'Users.json');
            fs.writeFileSync(usersFile, '[]', 'utf8');

            const env = {
                ...process.env,
                DATA_DIR: tempDir,
                PORT: String(port),
                ADMIN_INIT_PASSWORD: TEST_PASSWORD,
                SURVEY_TRACK_A_MODE: 'mock'
            };

            child = spawn('node', ['server.js'], {
                cwd: ROOT,
                env,
                stdio: ['ignore', 'ignore', 'pipe']
            });

            await waitForServer(baseUrl, 60000);

            // 1. Login attempt
            const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': baseUrl
                },
                body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD })
            });

            if (loginRes.status !== 200) {
                throw new Error(`Expected login status 200, got ${loginRes.status}`);
            }

            // 2. Users.json should now have exactly 1 user (id 'admin')
            const rawUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            if (!Array.isArray(rawUsers) || rawUsers.length !== 1) {
                throw new Error(`Expected exactly 1 user in Users.json, got ${Array.isArray(rawUsers) ? rawUsers.length : 'non-array'}`);
            }
            if (rawUsers[0].id !== 'admin') {
                throw new Error(`Expected user id to be 'admin', got '${rawUsers[0].id}'`);
            }

        } finally {
            await stopProcess(child);
            cleanupDir(tempDir);
        }
    });

    if (!t3Passed) allPassed = false;

    console.log(`=======================================================`);
    if (allPassed) {
        console.log(`ALL TESTS PASSED (T1, T2, T3)`);
        process.exit(0);
    } else {
        console.error(`SOME TESTS FAILED`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(`Unexpected test runner error:`, err);
    process.exit(1);
});

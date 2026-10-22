/**
 * scripts/verify-backup-targets.mjs
 * 데이터 관리 "백업 대상 지정 + 실행" 기능 검증 (2026-10-23).
 *
 * 임시 DATA_DIR/ATTACHMENTS_DIR/대상 폴더로 라우터를 작은 express 앱에
 * 마운트해 검증한다 (운영 데이터에는 닿지 않는다).
 *
 * 케이스:
 *  1. 마커 있는 대상이 GET /targets에서 available:true로 뜨는지
 *  2. 마커를 지우면 available:false가 되는지
 *  3. 설정 PUT → GET 반영 + 잘못된 값 400
 *  4. POST /run → status done + 스냅샷 폴더에 JSON/첨부가 복사되고
 *     BackupSettings.json·backups 폴더는 제외되는지
 *  5. 사용 불가 대상에 run 요청 시 400인지
 *  6. 비관리자 403 / 미인증 401인지
 *  7. npm run build 성공 (SKIP_BUILD=1이면 건너뜀)
 *  8. 인접 검증 스크립트(설문 배지)가 깨지지 않았는지 (SKIP_BUILD=1이면 함께 건너뜀)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { createBackupService } from '../server/backup/backupService.js';
import { createBackupRouter } from '../server/backup/backupRouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const scratchDir = path.resolve(projectRoot, 'scratch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('🧪 ========================================================');
    console.log('🧪 [VERIFICATION] Backup Targets (지정 + 실행)');
    console.log('🧪 ========================================================');

    let passed = 0;
    let failed = 0;
    const testAsync = async (name, fn) => {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(err);
            failed++;
        }
    };

    if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratchDir, 'verify-backup-targets-'));
    const dataDir = path.join(root, 'data');
    const attachmentsDir = path.join(root, 'attachments');
    const targetDir = path.join(root, 'target-usb');
    const missingDir = path.join(root, 'target-missing'); // 만들지 않음 → 사용 불가 대상

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(attachmentsDir, 'referral-1'), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'backups', '2026-10-23'), { recursive: true });

    fs.writeFileSync(path.join(dataDir, 'Referrals.json'), JSON.stringify([{ referralId: 'r-1', name: '테스트' }]));
    fs.writeFileSync(path.join(dataDir, 'Users.json'), JSON.stringify([{ id: 'u-1', role: 'admin' }]));
    fs.writeFileSync(path.join(dataDir, 'backups', '2026-10-23', 'Referrals_1.json.bak'), 'should-not-be-copied');
    fs.writeFileSync(path.join(attachmentsDir, 'referral-1', 'note.txt'), 'attachment-body');
    const MARKER = '.imhc-backup-target';
    fs.writeFileSync(path.join(targetDir, MARKER), 'ok');

    const fakeEnv = {
        BACKUP_TARGET_1_NAME: '테스트 USB',
        BACKUP_TARGET_1_PATH: targetDir,
        BACKUP_TARGET_1_HOST_PATH: '/volumeUSB1/usbshare',
        BACKUP_TARGET_1_MARKER: MARKER,
        BACKUP_TARGET_2_NAME: '없는 대상',
        BACKUP_TARGET_2_PATH: missingDir
    };

    const backupService = createBackupService({ dataDir, attachmentsDir, env: fakeEnv });

    // requireAdmin 스텁: 실제 미들웨어와 같은 의미론 (미인증 401 / 비관리자 403)
    const requireAdminStub = (req, res, next) => {
        const role = req.headers['x-test-role'];
        if (!role) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
        if (role !== 'admin') return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
        next();
    };

    const app = express();
    app.use(express.json());
    app.use('/api/backup', createBackupRouter({ backupService, requireAdmin: requireAdminStub }));

    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, urlPath, { role = 'admin', body } = {}) => {
        const headers = {};
        if (role) headers['x-test-role'] = role;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${baseUrl}${urlPath}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    };

    try {
        await testAsync('1. 마커 있는 대상이 available:true, writable:true, freeBytes>0', async () => {
            const { status, data } = await call('GET', '/api/backup/targets');
            assert.strictEqual(status, 200);
            assert.strictEqual(data.targets.length, 2);
            const t1 = data.targets.find((t) => t.id === 1);
            assert.ok(t1, 'target 1 missing');
            assert.strictEqual(t1.available, true, `reason=${t1.reason}`);
            assert.strictEqual(t1.writable, true);
            assert.ok(typeof t1.freeBytes === 'number' && t1.freeBytes > 0);
            assert.strictEqual(t1.hostPath, '/volumeUSB1/usbshare');
            const t2 = data.targets.find((t) => t.id === 2);
            assert.strictEqual(t2.available, false);
        });

        await testAsync('2. 마커를 지우면 available:false + 사유에 마커 언급', async () => {
            fs.rmSync(path.join(targetDir, MARKER));
            try {
                const { data } = await call('GET', '/api/backup/targets');
                const t1 = data.targets.find((t) => t.id === 1);
                assert.strictEqual(t1.available, false);
                assert.ok(t1.reason && t1.reason.includes(MARKER), `reason=${t1.reason}`);
            } finally {
                fs.writeFileSync(path.join(targetDir, MARKER), 'ok');
            }
            const { data } = await call('GET', '/api/backup/targets');
            assert.strictEqual(data.targets.find((t) => t.id === 1).available, true);
        });

        await testAsync('3. 설정 PUT → GET 반영, 잘못된 값은 400', async () => {
            const put = await call('PUT', '/api/backup/settings', {
                body: { activeTargetId: 1, autoEnabled: true, autoTime: '03:30', retentionCount: 5 }
            });
            assert.strictEqual(put.status, 200, JSON.stringify(put.data));
            const get = await call('GET', '/api/backup/settings');
            assert.strictEqual(get.data.settings.activeTargetId, 1);
            assert.strictEqual(get.data.settings.autoEnabled, true);
            assert.strictEqual(get.data.settings.autoTime, '03:30');
            assert.strictEqual(get.data.settings.retentionCount, 5);

            const badTime = await call('PUT', '/api/backup/settings', { body: { autoTime: '25:99' } });
            assert.strictEqual(badTime.status, 400);
            const badRetention = await call('PUT', '/api/backup/settings', { body: { retentionCount: 0 } });
            assert.strictEqual(badRetention.status, 400);
            const badTarget = await call('PUT', '/api/backup/settings', { body: { activeTargetId: 99 } });
            assert.strictEqual(badTarget.status, 400);
            // 자동 백업이 테스트 중 실제로 돌지 않도록 끄고 되돌린다
            const reset = await call('PUT', '/api/backup/settings', { body: { autoEnabled: false } });
            assert.strictEqual(reset.status, 200);
        });

        await testAsync('4. POST /run → done + 스냅샷에 JSON/첨부 복사, 설정파일·backups 제외', async () => {
            const run = await call('POST', '/api/backup/run');
            assert.strictEqual(run.status, 200, JSON.stringify(run.data));
            assert.strictEqual(run.data.started, true);

            let status = null;
            for (let i = 0; i < 50; i++) {
                await sleep(100);
                const s = await call('GET', '/api/backup/status');
                status = s.data.status;
                if (status.state === 'done' || status.state === 'error') break;
            }
            assert.ok(status, 'status missing');
            assert.strictEqual(status.state, 'done', `error=${status.error}`);
            assert.ok(status.copiedFiles >= 3, `copiedFiles=${status.copiedFiles}`);
            assert.ok(status.copiedBytes > 0);

            const snapshots = fs.readdirSync(targetDir).filter((f) => /^imhc-backup-\d{8}-\d{6}$/.test(f));
            assert.strictEqual(snapshots.length, 1, `snapshots=${snapshots.join(',')}`);
            const snapDir = path.join(targetDir, snapshots[0]);
            const referrals = JSON.parse(fs.readFileSync(path.join(snapDir, 'Referrals.json'), 'utf8'));
            assert.strictEqual(referrals[0].referralId, 'r-1');
            assert.ok(fs.existsSync(path.join(snapDir, 'Users.json')));
            assert.strictEqual(
                fs.readFileSync(path.join(snapDir, 'attachments', 'referral-1', 'note.txt'), 'utf8'),
                'attachment-body'
            );
            assert.ok(!fs.existsSync(path.join(snapDir, 'BackupSettings.json')), 'BackupSettings.json must be excluded');
            assert.ok(!fs.existsSync(path.join(snapDir, 'backups')), 'backups dir must be excluded');

            const settings = await call('GET', '/api/backup/settings');
            assert.strictEqual(settings.data.settings.lastRunResult, 'success');
            assert.strictEqual(settings.data.settings.lastRunTargetId, 1);
        });

        await testAsync('5. 사용 불가 대상이 활성이면 run은 400', async () => {
            const put = await call('PUT', '/api/backup/settings', { body: { activeTargetId: 2 } });
            assert.strictEqual(put.status, 200);
            const run = await call('POST', '/api/backup/run');
            assert.strictEqual(run.status, 400, JSON.stringify(run.data));
            assert.ok(run.data.error && run.data.error.includes('사용 불가'));
            await call('PUT', '/api/backup/settings', { body: { activeTargetId: 1 } });
        });

        await testAsync('6. 비관리자는 403, 미인증은 401', async () => {
            const asUser = await call('GET', '/api/backup/targets', { role: 'user' });
            assert.strictEqual(asUser.status, 403);
            const asUserRun = await call('POST', '/api/backup/run', { role: 'user' });
            assert.strictEqual(asUserRun.status, 403);
            const anon = await call('GET', '/api/backup/settings', { role: null });
            assert.strictEqual(anon.status, 401);
        });
    } finally {
        server.close();
    }

    if (process.env.SKIP_BUILD === '1') {
        console.log('  ⏭️ SKIP: 7·8 (SKIP_BUILD=1)');
    } else {
        await testAsync('7. npm run build 성공', async () => {
            execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe', timeout: 300000 });
        });
        await testAsync('8. 인접 검증(설문 배지)이 깨지지 않음', async () => {
            execFileSync('node', ['scripts/verify-survey-badge-my-assigned.mjs'], { cwd: projectRoot, stdio: 'pipe', timeout: 120000 });
        });
    }

    fs.rmSync(root, { recursive: true, force: true });

    console.log(`\n🧪 결과: ${passed} PASS / ${failed} FAIL`);
    if (failed > 0) process.exit(1);
    console.log('🧪 ✅ Backup targets verification ALL PASS');
}

main().catch((err) => {
    console.error('🧪 ❌ Verification crashed:', err);
    process.exit(1);
});

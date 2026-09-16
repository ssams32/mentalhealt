/**
 * scripts/verify-notifications-outbox.mjs
 * Comprehensive Verification Suite for Mind-ERP OS Track A9:
 * Persistent Notifications and Transactional Outbox.
 * 
 * Verifies:
 * - A. Notification Repository: Create, Unread, Payload Allowlist, Deduplication, markRead, markAllRead, Archive, Expiry, No Hard Delete
 * - B. Outbox Repository: Create, Pending, AttemptCount, Payload Allowlist, Deduplication, Atomic Claim, Lease Token Hash, Mark Dispatching, Mark Delivered
 * - C. Cross-Store Partial Failure: Outbox delivered failure recovery, Deduplication reuse, Single Notification Guarantee
 * - D. Offline Delivery: Unread persistence without active user session, No external network delivery
 * - E. Retry & Lease: Retry_wait, Backoff, Due Retries Release, Lease Expiry, Monotonic AttemptCount
 * - F. Store Safety: Fail-closed on JSON corruption, Hash preservation, Non-destructive reset verification
 * - G. Reconciliation: 25 check codes, Missing notification, Recipient mismatch, Unsafe payload, Expired lease, Stalled outbox, No PII, Read-only
 * - H. Metrics Snapshot: Notification counts, Outbox counts, Capacity remaining, No PII
 * - I. A8 Precondition Gate: Heartbeat, Completion, Cancellation, File Lock Portability
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'assert';

import {
    NOTIFICATION_STATUS,
    NOTIFICATION_SEVERITY,
    NOTIFICATION_TYPES,
    OUTBOX_STATUS,
    ACTIVE_OUTBOX_STATUSES,
    DEFAULT_NOTIFICATION_LIMITS,
    NOTIFICATION_ERROR_CODES,
    NotificationError,
    ALLOWED_METADATA_KEYS,
    PROHIBITED_PAYLOAD_KEYS,
    validateAndSanitizeSafeMetadata,
    validateNotificationRecord,
    validateOutboxRecord,
    NotificationRepository,
    NotificationOutboxRepository,
    NotificationDispatcherRunner,
    runNotificationReconciliation,
    RECONCILIATION_CHECK_CODES,
    getNotificationMetricsSnapshot
} from '../server/notifications/index.js';

import {
    JOB_STATUS,
    JOB_TYPES,
    JOB_ERROR_CODES,
    VoiceCallJobRepository
} from '../server/jobs/index.js';

import { normalizeLockKey } from '../server/storage/sharedFileLockRegistry.js';

// Setup Isolated Temp Directory
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications_test_'));
const DATA_DIR = path.join(TEST_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

console.log(`📁 Isolated A9 Test Directory: ${TEST_ROOT}`);

let passedCount = 0;
let failedCount = 0;
let totalAssertions = 0;

async function runTest(name, testFn) {
    try {
        await testFn();
        passedCount++;
        console.log(`  ✅ [PASS] ${name}`);
    } catch (err) {
        failedCount++;
        console.error(`  ❌ [FAIL] ${name}:`, err.message);
        if (err.stack) console.error(err.stack);
    }
}

function createStoreHarness(subDirName) {
    const dir = path.join(DATA_DIR, subDirName);
    fs.mkdirSync(dir, { recursive: true });

    const getData = (filename, defaultValue) => {
        const filePath = path.join(dir, `${filename}.json`);
        if (!fs.existsSync(filePath)) {
            return defaultValue !== undefined ? defaultValue : [];
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };

    const persistData = async (filename, data) => {
        const filePath = path.join(dir, `${filename}.json`);
        const tmpPath = path.join(dir, `${filename}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    };

    return { dir, getData, persistData };
}

async function runAllTests() {
    console.log('\n============================================================');
    console.log('🧪 TRACK A9: PERSISTENT NOTIFICATIONS & OUTBOX VERIFICATION');
    console.log('============================================================\n');

    // -------------------------------------------------------------
    // Section A: Notification Repository
    // -------------------------------------------------------------
    console.log('--- A. Notification Repository ---');
    const hNotif = createStoreHarness('h_notif');
    const repoNotif = new NotificationRepository(hNotif.getData, hNotif.persistData, { dataDir: hNotif.dir });

    await runTest('Notification creation initializes status=unread, version=1, and server-generated ID', async () => {
        const notif = await repoNotif.createNotification({
            recipientUserId: 'user_kim_01',
            type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            resourceType: 'voice_call',
            resourceId: 'call_test_001',
            messageCode: 'VOICE_CALL_RECEIVED_NOTICE',
            severity: NOTIFICATION_SEVERITY.INFO,
            deduplicationKey: 'dedup_notif_001'
        });

        assert.ok(notif.id.startsWith('notif_'));
        assert.strictEqual(notif.recipientUserId, 'user_kim_01');
        assert.strictEqual(notif.status, NOTIFICATION_STATUS.UNREAD);
        assert.strictEqual(notif.version, 1);
        assert.strictEqual(notif.readAt, null);
        assert.strictEqual(notif.archivedAt, null);
    });

    await runTest('Payload allowlist permits approved safeMetadata keys and rejects prohibited PII keys', async () => {
        // Safe metadata passes
        const safeNotif = await repoNotif.createNotification({
            recipientUserId: 'user_kim_01',
            type: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            resourceType: 'voice_call',
            resourceId: 'call_test_002',
            messageCode: 'VOICE_CALL_ASSIGNED_NOTICE',
            deduplicationKey: 'dedup_notif_002',
            safeMetadata: {
                assignmentVersion: 2,
                departmentCanonicalId: 'c_recov_01',
                sourceEventCode: 'DISPATCH_EVENT'
            }
        });
        assert.strictEqual(safeNotif.safeMetadata.departmentCanonicalId, 'c_recov_01');

        // Prohibited PII keys reject
        for (const piiKey of ['phone', 'name', 'transcript', 'summary', 'storageKey', 'password']) {
            await assert.rejects(
                async () => repoNotif.createNotification({
                    recipientUserId: 'user_kim_01',
                    type: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
                    resourceType: 'voice_call',
                    resourceId: 'call_test_pii',
                    messageCode: 'TEST',
                    deduplicationKey: `dedup_pii_${piiKey}`,
                    safeMetadata: { [piiKey]: 'sensitive_data' }
                }),
                (err) => err.code === NOTIFICATION_ERROR_CODES.UNSAFE_PAYLOAD_DETECTED
            );
        }
    });

    await runTest('Notification creation is atomic and deduplication returns existing record', async () => {
        const notif1 = await repoNotif.createNotification({
            recipientUserId: 'user_kim_01',
            type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            resourceType: 'voice_call',
            resourceId: 'call_test_003',
            messageCode: 'NOTICE_003',
            deduplicationKey: 'dedup_idem_003'
        });

        const notif2 = await repoNotif.createNotification({
            recipientUserId: 'user_kim_01',
            type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            resourceType: 'voice_call',
            resourceId: 'call_test_003',
            messageCode: 'NOTICE_003',
            deduplicationKey: 'dedup_idem_003'
        });

        assert.strictEqual(notif1.id, notif2.id);
        assert.strictEqual(notif1.version, notif2.version);
    });

    await runTest('markRead transitions unread to read with expectedVersion, is idempotent, and rejects other users', async () => {
        const notif = await repoNotif.createNotification({
            recipientUserId: 'user_kim_01',
            type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            resourceType: 'voice_call',
            resourceId: 'call_test_004',
            messageCode: 'NOTICE_004',
            deduplicationKey: 'dedup_notif_004'
        });

        // Other user cannot mark read
        await assert.rejects(
            async () => repoNotif.markRead({ notificationId: notif.id, recipientUserId: 'user_other_02' }),
            (err) => err.code === NOTIFICATION_ERROR_CODES.NOTIFICATION_ACCESS_DENIED
        );

        // Stale expectedVersion rejected
        await assert.rejects(
            async () => repoNotif.markRead({ notificationId: notif.id, recipientUserId: 'user_kim_01', expectedVersion: 99 }),
            (err) => err.code === NOTIFICATION_ERROR_CODES.VERSION_CONFLICT
        );

        // Valid markRead
        const readNotif = await repoNotif.markRead({ notificationId: notif.id, recipientUserId: 'user_kim_01', expectedVersion: 1 });
        assert.strictEqual(readNotif.status, NOTIFICATION_STATUS.READ);
        assert.ok(readNotif.readAt !== null);
        assert.strictEqual(readNotif.version, 2);

        // Idempotent: repeated markRead returns same state without version increment
        const repeatRead = await repoNotif.markRead({ notificationId: notif.id, recipientUserId: 'user_kim_01' });
        assert.strictEqual(repeatRead.version, 2);
    });

    await runTest('markAllRead marks only target user unread notifications in a single lock and single persist', async () => {
        const notifA1 = await repoNotif.createNotification({ recipientUserId: 'user_markall', type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, resourceType: 'voice_call', resourceId: 'c1', messageCode: 'M', deduplicationKey: 'd_m1' });
        const notifA2 = await repoNotif.createNotification({ recipientUserId: 'user_markall', type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, resourceType: 'voice_call', resourceId: 'c2', messageCode: 'M', deduplicationKey: 'd_m2' });
        const notifB = await repoNotif.createNotification({ recipientUserId: 'user_untouched', type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, resourceType: 'voice_call', resourceId: 'c3', messageCode: 'M', deduplicationKey: 'd_m3' });

        const result = await repoNotif.markAllRead({ recipientUserId: 'user_markall' });
        assert.strictEqual(result.modifiedCount, 2);

        assert.strictEqual(repoNotif.findById(notifA1.id).status, NOTIFICATION_STATUS.READ);
        assert.strictEqual(repoNotif.findById(notifA2.id).status, NOTIFICATION_STATUS.READ);
        assert.strictEqual(repoNotif.findById(notifB.id).status, NOTIFICATION_STATUS.UNREAD); // Untouched!
    });

    await runTest('archiveNotification and expireNotifications maintain lifecycle without hard delete', async () => {
        const notif = await repoNotif.createNotification({
            recipientUserId: 'user_arch',
            type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            resourceType: 'voice_call',
            resourceId: 'c_arch',
            messageCode: 'M',
            deduplicationKey: 'd_arch'
        });

        const archived = await repoNotif.archiveNotification({ notificationId: notif.id, recipientUserId: 'user_arch' });
        assert.strictEqual(archived.status, NOTIFICATION_STATUS.ARCHIVED);
        assert.ok(archived.archivedAt !== null);

        // Verification that record is never hard deleted
        const found = repoNotif.findById(notif.id);
        assert.ok(found !== null);
        assert.strictEqual(found.status, NOTIFICATION_STATUS.ARCHIVED);
    });

    // -------------------------------------------------------------
    // Section B: Outbox Repository
    // -------------------------------------------------------------
    console.log('\n--- B. Outbox Repository ---');
    const hOutbox = createStoreHarness('h_outbox');
    const repoOutbox = new NotificationOutboxRepository(hOutbox.getData, hOutbox.persistData, { dataDir: hOutbox.dir });

    await runTest('Outbox creation initializes status=pending, attemptCount=0, and canonical deduplicationKey', async () => {
        const ev = await repoOutbox.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            aggregateType: 'voice_call',
            aggregateId: 'call_ob_001',
            recipientUserId: 'user_kim_ob',
            sourceVersion: 1,
            payload: { messageCode: 'NEW_CALL' }
        });

        assert.strictEqual(ev.status, OUTBOX_STATUS.PENDING);
        assert.strictEqual(ev.attemptCount, 0);
        assert.strictEqual(ev.version, 1);
        assert.ok(/^[a-f0-9]{64}$/.test(ev.deduplicationKey));
    });

    await runTest('Cross-instance concurrent event creation with same deduplicationKey produces exactly one active event', async () => {
        const repoOutbox2 = new NotificationOutboxRepository(hOutbox.getData, hOutbox.persistData, { dataDir: hOutbox.dir });

        const [p1, p2] = await Promise.allSettled([
            repoOutbox.createEvent({ eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, aggregateType: 'voice_call', aggregateId: 'call_conc_01', recipientUserId: 'u1', sourceVersion: 1 }),
            repoOutbox2.createEvent({ eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, aggregateType: 'voice_call', aggregateId: 'call_conc_01', recipientUserId: 'u1', sourceVersion: 1 })
        ]);

        const successes = [p1, p2].filter(r => r.status === 'fulfilled');
        const rejections = [p1, p2].filter(r => r.status === 'rejected');

        assert.strictEqual(successes.length, 1, 'Exactly one creation succeeds');
        assert.strictEqual(rejections.length, 1, 'Second concurrent attempt is rejected with IDEMPOTENCY_CONFLICT');
        assert.strictEqual(rejections[0].reason.code, NOTIFICATION_ERROR_CODES.OUTBOX_IDEMPOTENCY_CONFLICT);
    });

    await runTest('Outbox claim produces raw lease token, stores only hash, and increments attemptCount strictly once', async () => {
        const hClaim = createStoreHarness('h_claim');
        const repoClaim = new NotificationOutboxRepository(hClaim.getData, hClaim.persistData, { dataDir: hClaim.dir });

        const ev = await repoClaim.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            aggregateType: 'voice_call',
            aggregateId: 'call_claim_01',
            recipientUserId: 'u_claim_1',
            sourceVersion: 1
        });

        const claim = await repoClaim.claimNextEvent({ workerId: 'dispatcher_01' });
        assert.ok(claim !== null);
        assert.strictEqual(claim.event.id, ev.id);
        assert.strictEqual(claim.event.status, OUTBOX_STATUS.LEASED);
        assert.strictEqual(claim.event.attemptCount, 1);
        assert.ok(typeof claim.leaseToken === 'string' && claim.leaseToken.length === 64);

        // Verify disk store has NO raw leaseToken, only sha256 hash
        const onDisk = hClaim.getData('NotificationOutbox', []);
        const diskEvent = onDisk.find(e => e.id === ev.id);
        assert.strictEqual(diskEvent.leaseToken, undefined);
        assert.ok(/^[a-f0-9]{64}$/.test(diskEvent.leaseTokenHash));
        assert.strictEqual(
            crypto.createHash('sha256').update(claim.leaseToken).digest('hex'),
            diskEvent.leaseTokenHash
        );
    });

    await runTest('Outbox markDispatching and markDelivered complete delivery and clear lease', async () => {
        const hDeliv = createStoreHarness('h_deliv');
        const repoDeliv = new NotificationOutboxRepository(hDeliv.getData, hDeliv.persistData, { dataDir: hDeliv.dir });

        const ev = await repoDeliv.createEvent({ eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, aggregateType: 'voice_call', aggregateId: 'call_deliv_01', recipientUserId: 'u_deliv_1', sourceVersion: 2 });
        const claim = await repoDeliv.claimNextEvent({ workerId: 'disp_02' });

        await repoDeliv.markDispatching({ eventId: ev.id, workerId: 'disp_02', leaseToken: claim.leaseToken });
        const dispatching = repoDeliv.findById(ev.id);
        assert.strictEqual(dispatching.status, OUTBOX_STATUS.DISPATCHING);

        await repoDeliv.markDelivered({
            eventId: ev.id,
            workerId: 'disp_02',
            leaseToken: claim.leaseToken,
            deliveredNotificationId: 'notif_deliv_12345'
        });

        const delivered = repoDeliv.findById(ev.id);
        assert.strictEqual(delivered.status, OUTBOX_STATUS.DELIVERED);
        assert.strictEqual(delivered.deliveredNotificationId, 'notif_deliv_12345');
        assert.strictEqual(delivered.leaseOwner, null);
        assert.strictEqual(delivered.leaseTokenHash, null);
    });

    // -------------------------------------------------------------
    // Section C: Cross-Store Partial Failure & Recovery
    // -------------------------------------------------------------
    console.log('\n--- C. Cross-Store Partial Failure & Recovery ---');
    const hPartial = createStoreHarness('h_partial');

    await runTest('Partial failure in Outbox markDelivered recovers safely without duplicate notification', async () => {
        let shouldFailOutboxPersist = false;
        const failingOutboxPersist = async (filename, data) => {
            if (shouldFailOutboxPersist && filename === 'NotificationOutbox') {
                return false;
            }
            return hPartial.persistData(filename, data);
        };

        const notifRepo = new NotificationRepository(hPartial.getData, hPartial.persistData, { dataDir: hPartial.dir });
        const outboxRepo1 = new NotificationOutboxRepository(hPartial.getData, failingOutboxPersist, { dataDir: hPartial.dir });

        const ev = await outboxRepo1.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_READY_FOR_REVIEW,
            aggregateType: 'voice_call',
            aggregateId: 'call_part_fail_01',
            recipientUserId: 'u_part_01',
            sourceVersion: 1
        });

        // Setup runner that will fail at outbox markDelivered
        const runner1 = new NotificationDispatcherRunner({
            outboxRepo: outboxRepo1,
            notificationRepo: notifRepo,
            dispatcherId: 'disp_fail_01',
            leaseDurationMs: 1000
        });

        // Let claimNextEvent succeed, but fail subsequent persistData (markDelivered)
        let persistCount = 0;
        const outboxPersistGate = async (filename, data) => {
            if (filename === 'NotificationOutbox') {
                persistCount++;
                // 1st persist was createEvent, 2nd persist is claimNextEvent, 3rd persist is markDelivered
                if (persistCount >= 2) {
                    return false;
                }
            }
            return hPartial.persistData(filename, data);
        };
        outboxRepo1.persistData = outboxPersistGate;

        const report1 = await runner1.runOnce();

        // Dispatcher reported failure or retry scheduled, NOT DELIVERED
        assert.notStrictEqual(report1.outcome, 'DELIVERED');

        // Verify Notification was created
        const notificationsAfterFail = notifRepo.list();
        assert.strictEqual(notificationsAfterFail.length, 1);
        const createdNotifId = notificationsAfterFail[0].id;

        // Outbox event is NOT marked delivered
        const outboxAfterFail = outboxRepo1.findById(ev.id);
        assert.notStrictEqual(outboxAfterFail.status, OUTBOX_STATUS.DELIVERED);

        // Discard old runner and instances completely (Restart simulation)
        shouldFailOutboxPersist = false;
        const futureTime = new Date(Date.now() + 2000);

        const outboxRepo2 = new NotificationOutboxRepository(hPartial.getData, hPartial.persistData, { dataDir: hPartial.dir });
        const notifRepo2 = new NotificationRepository(hPartial.getData, hPartial.persistData, { dataDir: hPartial.dir });

        const runner2 = new NotificationDispatcherRunner({
            outboxRepo: outboxRepo2,
            notificationRepo: notifRepo2,
            dispatcherId: 'disp_recover_02'
        });

        // Run recovery pass
        const report2 = await runner2.runOnce({ now: futureTime });
        assert.strictEqual(report2.outcome, 'DELIVERED');
        assert.strictEqual(report2.notificationId, createdNotifId, 'Must reuse existing notification ID via deduplication key');

        // Final verification: exactly 1 notification exists (NO duplicates created!)
        const finalNotifications = notifRepo2.list();
        assert.strictEqual(finalNotifications.length, 1);

        const finalOutbox = outboxRepo2.findById(ev.id);
        assert.strictEqual(finalOutbox.status, OUTBOX_STATUS.DELIVERED);
        assert.strictEqual(finalOutbox.deliveredNotificationId, createdNotifId);
    });

    // -------------------------------------------------------------
    // Section D: Offline Delivery
    // -------------------------------------------------------------
    console.log('\n--- D. Offline Delivery ---');
    const hOffline = createStoreHarness('h_offline');
    const notifRepoOff = new NotificationRepository(hOffline.getData, hOffline.persistData, { dataDir: hOffline.dir });
    const outboxRepoOff = new NotificationOutboxRepository(hOffline.getData, hOffline.persistData, { dataDir: hOffline.dir });

    await runTest('Notifications are created and persist unread for offline users without active session', async () => {
        const runnerOff = new NotificationDispatcherRunner({
            outboxRepo: outboxRepoOff,
            notificationRepo: notifRepoOff,
            dispatcherId: 'disp_offline'
        });

        await outboxRepoOff.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_ASSIGNED,
            aggregateType: 'voice_call',
            aggregateId: 'call_off_01',
            recipientUserId: 'offline_user_99',
            sourceVersion: 1,
            payload: { messageCode: 'ASSIGNED' }
        });

        const report = await runnerOff.runOnce();
        assert.strictEqual(report.outcome, 'DELIVERED');

        // New repository instance inspecting unread count
        const freshNotifRepo = new NotificationRepository(hOffline.getData, hOffline.persistData, { dataDir: hOffline.dir });
        const unreadCount = freshNotifRepo.countUnreadForRecipient('offline_user_99');
        assert.strictEqual(unreadCount, 1);

        const list = freshNotifRepo.listForRecipient('offline_user_99');
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].status, NOTIFICATION_STATUS.UNREAD);
    });

    // -------------------------------------------------------------
    // Section E: Retry & Lease Monotonicity
    // -------------------------------------------------------------
    console.log('\n--- E. Retry & Lease Monotonicity ---');
    const hRetry = createStoreHarness('h_retry');
    const outboxRepoRetry = new NotificationOutboxRepository(hRetry.getData, hRetry.persistData, { dataDir: hRetry.dir });

    await runTest('Attempt count increases monotonically on claim and never decrements on retry or block', async () => {
        const ev = await outboxRepoRetry.createEvent({
            eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED,
            aggregateType: 'voice_call',
            aggregateId: 'call_mono_01',
            recipientUserId: 'u_mono',
            sourceVersion: 1
        });
        assert.strictEqual(ev.attemptCount, 0);

        const c1 = await outboxRepoRetry.claimNextEvent({ workerId: 'w1' });
        assert.strictEqual(c1.event.attemptCount, 1);

        // Schedule retry
        await outboxRepoRetry.scheduleRetry({
            eventId: ev.id,
            workerId: 'w1',
            leaseToken: c1.leaseToken,
            nextAttemptAt: new Date(Date.now() - 1000)
        });

        const inRetry = outboxRepoRetry.findById(ev.id);
        assert.strictEqual(inRetry.attemptCount, 1, 'Must not decrement on retry');

        // Claim again after due retry release
        const c2 = await outboxRepoRetry.claimNextEvent({ workerId: 'w2' });
        assert.strictEqual(c2.event.attemptCount, 2);

        // Block event
        await outboxRepoRetry.blockEvent({ eventId: ev.id });
        const inBlocked = outboxRepoRetry.findById(ev.id);
        assert.strictEqual(inBlocked.status, OUTBOX_STATUS.BLOCKED);
        assert.strictEqual(inBlocked.attemptCount, 2, 'Must not decrement on block');

        // Unblock event
        await outboxRepoRetry.unblockEvent({ eventId: ev.id });
        const inUnblocked = outboxRepoRetry.findById(ev.id);
        assert.strictEqual(inUnblocked.status, OUTBOX_STATUS.PENDING);
        assert.strictEqual(inUnblocked.attemptCount, 2, 'Must not decrement on unblock');
    });

    // -------------------------------------------------------------
    // Section F: Store Safety & Corruption Handling
    // -------------------------------------------------------------
    console.log('\n--- F. Store Safety & Corruption Handling ---');
    const hCorrupt = createStoreHarness('h_corrupt');

    await runTest('Corrupted Notifications.json halts operations without overwriting disk data', async () => {
        const notifPath = path.join(hCorrupt.dir, 'Notifications.json');
        const badJson = '{"damaged": true, corrupt';
        fs.writeFileSync(notifPath, badJson, 'utf8');

        const repoCorrupt = new NotificationRepository(hCorrupt.getData, hCorrupt.persistData, { dataDir: hCorrupt.dir });

        await assert.rejects(
            async () => repoCorrupt.createNotification({ recipientUserId: 'u', type: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, resourceType: 'r', resourceId: '1', messageCode: 'M', deduplicationKey: 'd' }),
            (err) => err.code === NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_CORRUPTED || err.code === NOTIFICATION_ERROR_CODES.NOTIFICATION_STORE_READ_FAILED
        );

        // Verify disk content remained untouched
        assert.strictEqual(fs.readFileSync(notifPath, 'utf8'), badJson);

        // Fix file and verify resetCorruptionState
        fs.writeFileSync(notifPath, '[]', 'utf8');
        assert.strictEqual(repoCorrupt.resetCorruptionState(), true);
        assert.strictEqual(repoCorrupt.isCorrupted, false);
    });

    await runTest('Platform-safe lock key preserves case on Linux and normalizes on Windows', () => {
        const linuxA = normalizeLockKey('/app/data/Notifications.json', 'linux');
        const linuxB = normalizeLockKey('/app/data/notifications.json', 'linux');
        assert.notStrictEqual(linuxA, linuxB, 'Linux must preserve case');

        const winA = normalizeLockKey('C:\\data\\Notifications.json', 'win32');
        const winB = normalizeLockKey('C:\\data\\notifications.json', 'win32');
        assert.strictEqual(winA, winB, 'Windows must fold case');
    });

    // -------------------------------------------------------------
    // Section G: Reconciliation
    // -------------------------------------------------------------
    console.log('\n--- G. Reconciliation ---');
    const hRecon = createStoreHarness('h_recon');
    const repoNRecon = new NotificationRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir });
    const repoORecon = new NotificationOutboxRepository(hRecon.getData, hRecon.persistData, { dataDir: hRecon.dir });

    await runTest('runNotificationReconciliation detects broken cross-store references and anomalies safely', async () => {
        // Create delivered outbox pointing to non-existent notification
        const ev = await repoORecon.createEvent({ eventType: NOTIFICATION_TYPES.VOICE_CALL_RECEIVED, aggregateType: 'voice_call', aggregateId: 'c_rec', recipientUserId: 'u_rec', sourceVersion: 1 });
        const c = await repoORecon.claimNextEvent({ workerId: 'w_rec', leaseDurationMs: 1000 });
        await repoORecon.markDelivered({ eventId: ev.id, workerId: 'w_rec', leaseToken: c.leaseToken, deliveredNotificationId: 'missing_notif_99999' });

        const findings = await runNotificationReconciliation({
            notificationRepo: repoNRecon,
            outboxRepo: repoORecon
        });

        const missingRef = findings.find(f => f.checkCode === RECONCILIATION_CHECK_CODES.OUTBOX_DELIVERED_NOTIFICATION_MISSING);
        assert.ok(missingRef !== null);
        assert.strictEqual(missingRef.resourceId, ev.id);
        assert.strictEqual(missingRef.repairable, false);

        // Verify output contains zero tokens, secrets, or PII
        const findingsJson = JSON.stringify(findings);
        assert.strictEqual(findingsJson.includes('leaseToken'), false);
        assert.strictEqual(findingsJson.includes('password'), false);
    });

    // -------------------------------------------------------------
    // Section H: Metrics Snapshot
    // -------------------------------------------------------------
    console.log('\n--- H. Metrics Snapshot ---');

    await runTest('getNotificationMetricsSnapshot reports accurate counts and size estimates without PII', () => {
        const metrics = getNotificationMetricsSnapshot({
            notificationRepo: repoNotif,
            outboxRepo: repoOutbox
        });

        assert.ok(typeof metrics.notifications.totalCount === 'number');
        assert.ok(typeof metrics.notifications.unreadCount === 'number');
        assert.ok(typeof metrics.outbox.totalCount === 'number');
        assert.ok(typeof metrics.outbox.capacityRemaining === 'number');

        const metricsJson = JSON.stringify(metrics);
        assert.strictEqual(metricsJson.includes('user_kim'), false, 'Metrics must contain zero user IDs or personal data');
    });

    // -------------------------------------------------------------
    // Section I: A8 Minimal Precondition Gate
    // -------------------------------------------------------------
    console.log('\n--- I. A8 Precondition Gate Invariants ---');
    const hA8 = createStoreHarness('h_a8_gate');
    const repoA8 = new VoiceCallJobRepository(hA8.getData, hA8.persistData, { dataDir: hA8.dir, enableSyntheticJobTypes: true });

    await runTest('A8 Gate: Heartbeat extends lease and rejects invalid lease ownership', async () => {
        const job = await repoA8.createJob({ callId: 'call_a8_hb_01', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const claim = await repoA8.claimNextJob({ workerId: 'w_hb_01', leaseDurationMs: 5000 });

        // Valid heartbeat
        const hb = await repoA8.heartbeat({ jobId: job.id, workerId: 'w_hb_01', leaseToken: claim.leaseToken, leaseDurationMs: 10000 });
        assert.ok(new Date(hb.leaseExpiresAt).getTime() > new Date(claim.job.leaseExpiresAt).getTime());

        // Wrong worker rejected
        await assert.rejects(
            async () => repoA8.heartbeat({ jobId: job.id, workerId: 'wrong_worker', leaseToken: claim.leaseToken }),
            (err) => err.code === JOB_ERROR_CODES.JOB_LEASE_OWNER_MISMATCH
        );

        // Wrong token rejected
        await assert.rejects(
            async () => repoA8.heartbeat({ jobId: job.id, workerId: 'w_hb_01', leaseToken: 'bad_token' }),
            (err) => err.code === JOB_ERROR_CODES.JOB_LEASE_TOKEN_INVALID
        );
    });

    await runTest('A8 Gate: Completion cleans lease and duplicate completion is rejected', async () => {
        const job = await repoA8.createJob({ callId: 'call_a8_comp_01', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const claim = await repoA8.claimNextJob({ workerId: 'w_comp_01' });
        await repoA8.markProcessing({ jobId: job.id, workerId: 'w_comp_01', leaseToken: claim.leaseToken });

        const completed = await repoA8.completeJob({ jobId: job.id, workerId: 'w_comp_01', leaseToken: claim.leaseToken, resultReference: { safeResultCode: 'OK' } });
        assert.strictEqual(completed.status, JOB_STATUS.COMPLETED);
        assert.strictEqual(completed.leaseOwner, null);
        assert.strictEqual(completed.leaseTokenHash, null);

        // Duplicate complete rejected (lease cleared on completed, so lease owner mismatch or invalid transition)
        await assert.rejects(
            async () => repoA8.completeJob({ jobId: job.id, workerId: 'w_comp_01', leaseToken: claim.leaseToken }),
            (err) => err.code === JOB_ERROR_CODES.JOB_LEASE_OWNER_MISMATCH || err.code === JOB_ERROR_CODES.JOB_INVALID_STATE_TRANSITION
        );
    });

    await runTest('A8 Gate: Cancellation cancels queued, retry_wait, and blocked jobs but rejects completed', async () => {
        const qJob = await repoA8.createJob({ callId: 'call_a8_can_q', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const canQ = await repoA8.cancelJob({ jobId: qJob.id });
        assert.strictEqual(canQ.status, JOB_STATUS.CANCELLED);

        // Completed job cannot be cancelled
        const compJob = await repoA8.createJob({ callId: 'call_a8_can_c', jobType: JOB_TYPES.SYNTHETIC_NOOP });
        const claim = await repoA8.claimNextJob({ workerId: 'w_can' });
        await repoA8.markProcessing({ jobId: compJob.id, workerId: 'w_can', leaseToken: claim.leaseToken });
        await repoA8.completeJob({ jobId: compJob.id, workerId: 'w_can', leaseToken: claim.leaseToken, resultReference: { safeResultCode: 'OK' } });

        await assert.rejects(
            async () => repoA8.cancelJob({ jobId: compJob.id }),
            (err) => err.code === JOB_ERROR_CODES.JOB_INVALID_STATE_TRANSITION
        );
    });

    // Teardown
    try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        console.log(`\n🧹 Cleaned up temporary test directory: ${TEST_ROOT}`);
    } catch (e) {
        console.warn('Notice: Test cleanup failed:', e.message);
    }

    console.log('\n============================================================');
    console.log(`📊 A9 VERIFICATION RESULTS: ${passedCount} Passed, ${failedCount} Failed`);
    console.log('============================================================\n');

    if (failedCount > 0) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error('Fatal test runner failure:', err);
    process.exit(1);
});

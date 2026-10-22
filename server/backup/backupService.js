/**
 * server/backup/backupService.js
 * 데이터 관리 화면의 "백업 대상 지정 + 실행" 기능 (2026-10-23).
 *
 * 설계 원칙:
 * - 임의 경로 입력 금지: 백업 대상은 환경변수(BACKUP_TARGET_N_*)로 미리
 *   마운트된 것만 등록되고, 관리자는 그중에서 선택만 한다.
 * - 하드코딩 금지: 대상 이름·경로는 전부 환경변수에서 읽는다.
 * - 대상이 없거나 쓸 수 없으면 명확히 실패로 표시하고, 다른 곳에 대신
 *   쓰는 폴백은 하지 않는다.
 * - 기존 내부 백업(createBackup → DATA_DIR/backups/날짜)은 건드리지 않는다.
 */
import fs from 'fs';
import path from 'path';

export const BACKUP_SETTINGS_FILENAME = 'BackupSettings.json';
const SNAPSHOT_PREFIX = 'imhc-backup-';
const MAX_TARGETS = 3;

/** 환경변수에서 백업 대상 목록을 읽는다 (N = 1..3, NAME/PATH가 모두 있는 것만 등록). */
export function getBackupTargetsFromEnv(env = process.env) {
    const targets = [];
    for (let i = 1; i <= MAX_TARGETS; i++) {
        const name = (env[`BACKUP_TARGET_${i}_NAME`] || '').trim();
        const targetPath = (env[`BACKUP_TARGET_${i}_PATH`] || '').trim();
        if (!name || !targetPath) continue;
        targets.push({
            id: i,
            name,
            path: targetPath,
            hostPath: (env[`BACKUP_TARGET_${i}_HOST_PATH`] || '').trim(),
            marker: (env[`BACKUP_TARGET_${i}_MARKER`] || '').trim()
        });
    }
    return targets;
}

export function getDefaultBackupSettings() {
    return {
        activeTargetId: null,
        autoEnabled: false,
        autoTime: '02:00',
        retentionCount: 30,
        lastRunAt: null,
        lastRunTargetId: null,
        lastRunResult: null,
        lastRunError: null,
        lastAutoRunDate: null
    };
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** imhc-backup-YYYYMMDD-HHmmss (서버 로컬 시각 기준) */
export function generateSnapshotName(now = new Date()) {
    return `${SNAPSHOT_PREFIX}${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function getFreeBytes(dirPath) {
    try {
        if (typeof fs.statfsSync === 'function') {
            const stats = fs.statfsSync(dirPath);
            const free = Number(stats.bavail) * Number(stats.bsize);
            return Number.isFinite(free) ? free : null;
        }
    } catch (e) {
        // 조회 실패는 null로 degrade (대상 자체를 사용 불가로 만들지 않음)
    }
    return null;
}

/** 대상 1개의 가용 상태를 판정한다. 어떤 경우에도 throw하지 않는다. */
export function checkTargetAvailability(target) {
    try {
        let stat = null;
        try {
            stat = fs.statSync(target.path);
        } catch (e) {
            return { available: false, writable: false, freeBytes: null, reason: '대상 디렉터리가 존재하지 않습니다 (마운트/연결 확인 필요)' };
        }
        if (!stat.isDirectory()) {
            return { available: false, writable: false, freeBytes: null, reason: '대상 경로가 디렉터리가 아닙니다' };
        }
        if (target.marker && !fs.existsSync(path.join(target.path, target.marker))) {
            return { available: false, writable: false, freeBytes: null, reason: `마커 파일(${target.marker})이 없습니다 — 실제 드라이브가 연결되지 않은 것으로 보입니다` };
        }
        let writable = false;
        try {
            fs.accessSync(target.path, fs.constants.W_OK);
            writable = true;
        } catch (e) {
            writable = false;
        }
        if (!writable) {
            return { available: false, writable: false, freeBytes: getFreeBytes(target.path), reason: '대상 디렉터리에 쓰기 권한이 없습니다' };
        }
        return { available: true, writable: true, freeBytes: getFreeBytes(target.path), reason: null };
    } catch (e) {
        return { available: false, writable: false, freeBytes: null, reason: e.message };
    }
}

function walkDirSize(dir) {
    let count = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
            } else if (entry.isFile()) {
                try {
                    bytes += fs.statSync(entryPath).size;
                    count++;
                } catch (e) { /* 읽기 실패 파일은 건너뜀 */ }
            }
        }
    }
    return { count, bytes };
}

function validationError(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

export function createBackupService({ dataDir, attachmentsDir, env = process.env } = {}) {
    if (!dataDir || !attachmentsDir) {
        throw new Error('[BACKUP] createBackupService requires dataDir and attachmentsDir');
    }
    const settingsPath = path.join(dataDir, BACKUP_SETTINGS_FILENAME);

    let runState = {
        state: 'idle',
        startedAt: null,
        finishedAt: null,
        targetId: null,
        copiedFiles: 0,
        copiedBytes: 0,
        error: null
    };
    let running = false;

    const getTargets = () => getBackupTargetsFromEnv(env);

    const listTargetsWithStatus = () => getTargets().map((target) => {
        const availability = checkTargetAvailability(target);
        return {
            id: target.id,
            name: target.name,
            path: target.path,
            hostPath: target.hostPath || null,
            available: availability.available,
            writable: availability.writable,
            freeBytes: availability.freeBytes,
            reason: availability.reason
        };
    });

    const readSettings = () => {
        try {
            if (fs.existsSync(settingsPath)) {
                const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (parsed && typeof parsed === 'object') {
                    return { ...getDefaultBackupSettings(), ...parsed };
                }
            }
        } catch (e) {
            console.error('[BACKUP] Failed to read settings:', e.message);
        }
        return getDefaultBackupSettings();
    };

    const writeSettings = (settings) => {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return settings;
    };

    /** 입력 검증 후 저장. 잘못된 값이면 status 400 에러를 throw한다. */
    const updateSettings = (input = {}) => {
        const current = readSettings();
        const next = { ...current };
        const targets = getTargets();

        if ('activeTargetId' in input) {
            const value = input.activeTargetId;
            if (value === null) {
                next.activeTargetId = null;
            } else if (targets.some((t) => t.id === value)) {
                next.activeTargetId = value;
            } else {
                throw validationError('등록되지 않은 백업 대상입니다.');
            }
        }
        if ('autoEnabled' in input) {
            if (typeof input.autoEnabled !== 'boolean') {
                throw validationError('autoEnabled는 true/false여야 합니다.');
            }
            next.autoEnabled = input.autoEnabled;
        }
        if ('autoTime' in input) {
            if (typeof input.autoTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.autoTime)) {
                throw validationError('autoTime은 "HH:MM" 형식이어야 합니다.');
            }
            next.autoTime = input.autoTime;
        }
        if ('retentionCount' in input) {
            const value = input.retentionCount;
            if (!Number.isInteger(value) || value < 1 || value > 365) {
                throw validationError('retentionCount는 1~365 사이의 정수여야 합니다.');
            }
            next.retentionCount = value;
        }
        return writeSettings(next);
    };

    const recordRunResult = (targetId, result, error) => {
        try {
            const settings = readSettings();
            settings.lastRunAt = new Date().toISOString();
            settings.lastRunTargetId = targetId;
            settings.lastRunResult = result;
            settings.lastRunError = error;
            writeSettings(settings);
        } catch (e) {
            console.error('[BACKUP] Failed to record run result:', e.message);
        }
    };

    /** 복사 대상 총량: DATA_DIR의 *.json(BackupSettings.json 제외) + 첨부 전체 */
    const calculateSourceSize = () => {
        let total = 0;
        try {
            for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                if (entry.name === BACKUP_SETTINGS_FILENAME) continue;
                try {
                    total += fs.statSync(path.join(dataDir, entry.name)).size;
                } catch (e) { /* skip */ }
            }
        } catch (e) {
            console.error('[BACKUP] Failed to size DATA_DIR:', e.message);
        }
        try {
            if (fs.existsSync(attachmentsDir)) {
                total += walkDirSize(attachmentsDir).bytes;
            }
        } catch (e) {
            console.error('[BACKUP] Failed to size ATTACHMENTS_DIR:', e.message);
        }
        return total;
    };

    const pruneOldSnapshots = (target, retentionCount) => {
        let names = [];
        try {
            names = fs.readdirSync(target.path, { withFileTypes: true })
                .filter((e) => e.isDirectory() && e.name.startsWith(SNAPSHOT_PREFIX) && !e.name.includes('.tmp-'))
                .map((e) => e.name)
                .sort(); // 이름 순 = 시각 순 (오래된 것부터)
        } catch (e) {
            return;
        }
        const excess = names.length - retentionCount;
        if (excess <= 0) return;
        for (const name of names.slice(0, excess)) {
            try {
                fs.rmSync(path.join(target.path, name), { recursive: true, force: true });
            } catch (e) {
                console.error('[BACKUP] Failed to prune snapshot:', name, e.message);
            }
        }
    };

    /** 실제 복사. runState를 갱신하고 settings에 결과를 기록한다. throw하지 않는다. */
    const executeBackup = async (target) => {
        const startedAt = runState.startedAt;
        let tempFolder = null;
        try {
            const settings = readSettings();
            const tempName = `${generateSnapshotName()}.tmp-${process.pid}-${Date.now()}`;
            tempFolder = path.join(target.path, tempName);
            fs.mkdirSync(tempFolder, { recursive: true });

            let copiedFiles = 0;
            let copiedBytes = 0;

            for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                if (entry.name === BACKUP_SETTINGS_FILENAME) continue;
                const src = path.join(dataDir, entry.name);
                fs.copyFileSync(src, path.join(tempFolder, entry.name));
                copiedFiles++;
                copiedBytes += fs.statSync(src).size;
            }

            if (fs.existsSync(attachmentsDir)) {
                const attDest = path.join(tempFolder, 'attachments');
                fs.cpSync(attachmentsDir, attDest, { recursive: true });
                const stats = walkDirSize(attDest);
                copiedFiles += stats.count;
                copiedBytes += stats.bytes;
            }

            // 확정 폴더명 충돌(같은 초에 재실행) 방지
            let finalName = generateSnapshotName();
            let finalFolder = path.join(target.path, finalName);
            let suffix = 2;
            while (fs.existsSync(finalFolder)) {
                finalName = `${generateSnapshotName()}-${suffix++}`;
                finalFolder = path.join(target.path, finalName);
            }
            fs.renameSync(tempFolder, finalFolder);
            tempFolder = null;

            pruneOldSnapshots(target, settings.retentionCount);

            runState = {
                state: 'done',
                startedAt,
                finishedAt: new Date().toISOString(),
                targetId: target.id,
                copiedFiles,
                copiedBytes,
                error: null
            };
            recordRunResult(target.id, 'success', null);
        } catch (e) {
            if (tempFolder) {
                try {
                    fs.rmSync(tempFolder, { recursive: true, force: true });
                } catch (cleanupErr) {
                    console.error('[BACKUP] Temp cleanup failed:', cleanupErr.message);
                }
            }
            runState = {
                state: 'error',
                startedAt,
                finishedAt: new Date().toISOString(),
                targetId: target.id,
                copiedFiles: runState.copiedFiles,
                copiedBytes: runState.copiedBytes,
                error: e.message
            };
            recordRunResult(target.id, 'error', e.message);
        } finally {
            running = false;
        }
        return { ...runState };
    };

    /**
     * 백업 시작 시도. 성공하면 { started: true }.
     * 실패하면 { error, status } (409 실행 중 / 400 대상 문제).
     */
    const startBackup = (targetId) => {
        if (running) {
            return { error: '이미 백업이 실행 중입니다.', status: 409 };
        }
        const target = getTargets().find((t) => t.id === targetId);
        if (!target) {
            return { error: '지정된 백업 대상을 찾을 수 없습니다.', status: 400 };
        }
        const availability = checkTargetAvailability(target);
        if (!availability.available || !availability.writable) {
            return { error: `백업 대상 사용 불가: ${availability.reason || '알 수 없는 사유'}`, status: 400 };
        }
        const sourceSize = calculateSourceSize();
        const required = Math.ceil(sourceSize * 1.2);
        if (availability.freeBytes !== null && availability.freeBytes < required) {
            return {
                error: `대상 여유 공간 부족: 필요 약 ${(required / 1024 / 1024 / 1024).toFixed(2)}GB, 사용 가능 ${(availability.freeBytes / 1024 / 1024 / 1024).toFixed(2)}GB`,
                status: 400
            };
        }
        running = true;
        runState = {
            state: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            targetId: target.id,
            copiedFiles: 0,
            copiedBytes: 0,
            error: null
        };
        // 비동기 실행: HTTP 응답은 즉시 반환하고 상태는 GET /status로 폴링한다.
        setImmediate(() => {
            executeBackup(target).catch((e) => console.error('[BACKUP] Unexpected run error:', e));
        });
        return { started: true };
    };

    /** 설정된 활성 대상으로 백업 시작 (POST /run 경로). */
    const startConfiguredBackup = () => {
        const settings = readSettings();
        if (settings.activeTargetId === null || settings.activeTargetId === undefined) {
            return { error: '백업 대상이 지정되지 않았습니다. 먼저 대상을 선택해 저장하세요.', status: 400 };
        }
        return startBackup(settings.activeTargetId);
    };

    /** 자동 백업 1회 체크. 실행했으면 true. 어떤 경우에도 throw하지 않는다. */
    const checkAutoBackup = () => {
        try {
            const settings = readSettings();
            if (!settings.autoEnabled) return false;
            if (settings.activeTargetId === null || settings.activeTargetId === undefined) return false;

            const now = new Date();
            const [hh, mm] = settings.autoTime.split(':').map(Number);
            const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
            if (now < due) return false;

            const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
            if (settings.lastAutoRunDate === today) return false;

            // 오늘 실행한 것으로 먼저 표시해 중복 실행을 막는다 (실패해도 다음날 재시도).
            writeSettings({ ...settings, lastAutoRunDate: today });

            const result = startBackup(settings.activeTargetId);
            if (result.error) {
                if (result.status !== 409) {
                    recordRunResult(settings.activeTargetId, 'error', result.error);
                }
                return false;
            }
            return true;
        } catch (e) {
            console.error('[BACKUP] Auto backup check failed:', e.message);
            return false;
        }
    };

    const startAutoBackupTimer = () => {
        checkAutoBackup();
        const timer = setInterval(checkAutoBackup, 60 * 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
    };

    return {
        getTargets,
        listTargetsWithStatus,
        readSettings,
        updateSettings,
        startBackup,
        startConfiguredBackup,
        checkAutoBackup,
        startAutoBackupTimer,
        getStatus: () => ({ ...runState }),
        isRunning: () => running
    };
}

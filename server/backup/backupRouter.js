/**
 * server/backup/backupRouter.js
 * 백업 대상 지정/실행 API (전부 requireAdmin).
 *   GET  /api/backup/targets  — 환경변수로 등록된 대상 + 가용 상태
 *   GET  /api/backup/settings — 현재 설정
 *   PUT  /api/backup/settings — 설정 검증 후 저장
 *   POST /api/backup/run      — 수동 실행 시작 (즉시 반환, 상태는 폴링)
 *   GET  /api/backup/status   — 실행 상태
 */
import express from 'express';

export function createBackupRouter({ backupService, requireAdmin }) {
    if (!backupService) throw new Error('[BACKUP] createBackupRouter requires backupService');
    if (typeof requireAdmin !== 'function') throw new Error('[BACKUP] createBackupRouter requires requireAdmin middleware');

    const router = express.Router();

    router.get('/targets', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, targets: backupService.listTargetsWithStatus() });
        } catch (e) {
            // 개별 대상 조회 실패는 서비스에서 degrade 처리하므로 여기는 최후 방어선
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.get('/settings', requireAdmin, (req, res) => {
        res.json({ success: true, settings: backupService.readSettings() });
    });

    router.put('/settings', requireAdmin, (req, res) => {
        try {
            const settings = backupService.updateSettings(req.body || {});
            res.json({ success: true, settings });
        } catch (e) {
            const status = e.status || 500;
            res.status(status).json({ success: false, error: e.message });
        }
    });

    router.post('/run', requireAdmin, (req, res) => {
        const result = backupService.startConfiguredBackup();
        if (result.error) {
            return res.status(result.status || 400).json({ success: false, error: result.error });
        }
        res.json({ success: true, started: true });
    });

    router.get('/status', requireAdmin, (req, res) => {
        res.json({ success: true, status: backupService.getStatus() });
    });

    return router;
}

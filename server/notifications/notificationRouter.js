/**
 * server/notifications/notificationRouter.js
 * Express router for internal in-app notifications.
 */

import express from 'express';

export function createNotificationRouter({ requireAuth, notificationRepository }) {
    if (!requireAuth || !notificationRepository) {
        throw new Error('createNotificationRouter requires requireAuth and notificationRepository');
    }

    const router = express.Router();

    // 1. GET /api/notifications - List notifications for logged-in user
    router.get('/', requireAuth, (req, res) => {
        try {
            const userId = req.auth.userId || req.auth.id || req.auth.username;
            const limit = Number(req.query.limit) || 50;
            const includeRead = req.query.includeRead !== 'false';

            const notifications = notificationRepository.getUserNotifications(userId, { limit, includeRead });
            res.json({ notifications });
        } catch (err) {
            console.error('❌ GET /api/notifications error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 2. GET /api/notifications/unread-count - Lightweight polling endpoint
    router.get('/unread-count', requireAuth, (req, res) => {
        try {
            const userId = req.auth.userId || req.auth.id || req.auth.username;
            const count = notificationRepository.getUnreadCount(userId);
            res.json({ unreadCount: count });
        } catch (err) {
            console.error('❌ GET /api/notifications/unread-count error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 3. POST /api/notifications/:id/read - Mark one notification as read
    router.post('/:id/read', requireAuth, async (req, res) => {
        try {
            const userId = req.auth.userId || req.auth.id || req.auth.username;
            const notification = await notificationRepository.markAsRead(req.params.id, userId);
            if (!notification) {
                return res.status(404).json({ error: { code: 'NOT_FOUND', message: '알림을 찾을 수 없습니다.' } });
            }
            res.json({ success: true, notification });
        } catch (err) {
            console.error('❌ POST /api/notifications/:id/read error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 4. POST /api/notifications/read-all - Mark all notifications as read
    router.post('/read-all', requireAuth, async (req, res) => {
        try {
            const userId = req.auth.userId || req.auth.id || req.auth.username;
            const count = await notificationRepository.markAllAsRead(userId);
            res.json({ success: true, updatedCount: count });
        } catch (err) {
            console.error('❌ POST /api/notifications/read-all error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    // 5. POST /api/notifications/:id/dismiss - Dismiss a notification
    router.post('/:id/dismiss', requireAuth, async (req, res) => {
        try {
            const userId = req.auth.userId || req.auth.id || req.auth.username;
            const dismissed = await notificationRepository.dismissNotification(req.params.id, userId);
            res.json({ success: dismissed });
        } catch (err) {
            console.error('❌ POST /api/notifications/:id/dismiss error:', err.message);
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        }
    });

    return router;
}

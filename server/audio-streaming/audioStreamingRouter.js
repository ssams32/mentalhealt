/**
 * server/audio-streaming/audioStreamingRouter.js
 * Express Router Factory for Mind-ERP OS Authenticated Audio Streaming.
 */

import express from 'express';
import { AudioStreamingController } from './audioStreamingController.js';

/**
 * Create isolated Audio Streaming Express Router with injected dependencies.
 * 
 * @param {Object} deps
 * @param {Function} deps.requireAuth - Authentication middleware
 * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepository
 * @param {import('./privateAudioAccessService.js').PrivateAudioAccessService} deps.privateAudioAccessService
 * @param {import('./auditEventSink.js').AuditEventSink} deps.auditEventSink
 * @returns {express.Router}
 */
export function createAudioStreamingRouter(deps = {}) {
    const {
        requireAuth,
        voiceCallRepository,
        privateAudioAccessService,
        auditEventSink,
        voiceAccessAuthorizer
    } = deps;

    if (typeof requireAuth !== 'function') {
        throw new Error('createAudioStreamingRouter requires a valid requireAuth middleware function.');
    }
    if (!voiceCallRepository) {
        throw new Error('createAudioStreamingRouter requires voiceCallRepository dependency.');
    }
    if (!privateAudioAccessService) {
        throw new Error('createAudioStreamingRouter requires privateAudioAccessService dependency.');
    }

    const controller = new AudioStreamingController({
        voiceCallRepo: voiceCallRepository,
        accessService: privateAudioAccessService,
        auditEventSink,
        voiceAccessAuthorizer
    });

    const router = express.Router();

    // 1. Audio Attachment Download (explicit path segment takes priority)
    router.get('/:id/audio/download', requireAuth, controller.downloadAudio);

    // 2. Audio Metadata Probe (HEAD)
    router.head('/:id/audio', requireAuth, controller.headAudio);

    // 3. Audio Playback (Inline Range Streaming)
    router.get('/:id/audio', requireAuth, controller.streamAudio);

    return router;
}

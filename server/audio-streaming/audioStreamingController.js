/**
 * server/audio-streaming/audioStreamingController.js
 * Authenticated HTTP Range Streaming & Download Controller for Mind-ERP OS Private Audio.
 * Enforces Capability & Resource Scope authorization, RFC 7233 Range responses, and Stream Lifecycle.
 */

import { STREAMING_ERROR_CODES, AUDIT_EVENT_TYPES } from './audioStreamingConstants.js';
import { AudioStreamingError } from './audioStreamingErrors.js';
import { parseRangeHeader } from './rangeParser.js';
import { VOICE_CAPABILITIES, hasVoiceCapability } from '../permissions/voiceCapabilities.js';
import { authorizeResourceAccess } from '../permissions/resourceScope.js';
import { isValidId } from '../voice-calls/voiceCallValidator.js';

export class AudioStreamingController {
    /**
     * @param {Object} deps
     * @param {import('../voice-calls/voiceCallRepository.js').VoiceCallRepository} deps.voiceCallRepo
     * @param {import('./privateAudioAccessService.js').PrivateAudioAccessService} deps.accessService
     * @param {import('./auditEventSink.js').AuditEventSink} deps.auditEventSink
     */
    constructor(deps = {}) {
        this.voiceCallRepo = deps.voiceCallRepo;
        this.accessService = deps.accessService;
        this.auditEventSink = deps.auditEventSink;
        this.voiceAccessAuthorizer = deps.voiceAccessAuthorizer || null;

        this.streamAudio = this.streamAudio.bind(this);
        this.headAudio = this.headAudio.bind(this);
        this.downloadAudio = this.downloadAudio.bind(this);
    }

    /**
     * GET /api/voice-calls/:id/audio
     * Inline HTTP Range Audio Streaming. Requires play_audio capability and Resource Scope clearance.
     */
    async streamAudio(req, res) {
        return this._handleStreamingRequest(req, res, {
            requiredCapability: VOICE_CAPABILITIES.PLAY_AUDIO,
            dispositionType: 'inline',
            eventType: AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED
        });
    }

    /**
     * HEAD /api/voice-calls/:id/audio
     * Metadata inspection without payload body. Same authentication & authorization checks.
     */
    async headAudio(req, res) {
        return this._handleHeadRequest(req, res);
    }

    /**
     * GET /api/voice-calls/:id/audio/download
     * Explicit Audio Attachment Download. Requires download_audio capability and Resource Scope clearance.
     */
    async downloadAudio(req, res) {
        return this._handleStreamingRequest(req, res, {
            requiredCapability: VOICE_CAPABILITIES.DOWNLOAD_AUDIO,
            dispositionType: 'attachment',
            eventType: AUDIT_EVENT_TYPES.AUDIO_DOWNLOAD_STARTED
        });
    }

    /**
     * Core handler for audio streaming (inline playback or attachment download).
     * @private
     */
    async _handleStreamingRequest(req, res, options) {
        const { requiredCapability, dispositionType, eventType } = options;
        const callId = req.params.id;
        const user = req.auth;

        // 0. Storage Subsystem Availability Check (Fail-Closed)
        if (this.accessService && this.accessService.available === false) {
            return res.status(503).json({
                error: {
                    code: STREAMING_ERROR_CODES.AUDIO_STORAGE_UNAVAILABLE,
                    message: '오디오 스토리지 서비스를 사용할 수 없습니다.'
                }
            });
        }

        // 0.1 Call ID Syntax Validation
        if (!isValidId(callId)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_ID_FORMAT',
                    message: '잘못된 식별자 형식입니다.'
                }
            });
        }

        // 1. Session Authentication Check
        if (!user || !user.id) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, 'anonymous', 'DENIED', 'UNAUTHENTICATED');
            return res.status(401).json({
                error: {
                    code: STREAMING_ERROR_CODES.UNAUTHENTICATED,
                    message: '로그인이 필요합니다.'
                }
            });
        }

        const userId = user.id;

        // 2. Capability Check
        if (!hasVoiceCapability(user, requiredCapability)) {
            const errCode = dispositionType === 'attachment'
                ? STREAMING_ERROR_CODES.AUDIO_DOWNLOAD_FORBIDDEN
                : STREAMING_ERROR_CODES.AUDIO_ACCESS_FORBIDDEN;
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'DENIED', errCode);
            return res.status(403).json({
                error: {
                    code: errCode,
                    message: dispositionType === 'attachment'
                        ? '음성 녹음 파일을 다운로드할 권한이 없습니다.'
                        : '음성 녹음을 재생할 권한이 없습니다.'
                }
            });
        }

        // 2.1 Restricted Voice Access Gate (Mandatory Authorizer)
        if (!this.voiceAccessAuthorizer) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'ERROR', 'VOICE_SYSTEM_UNAVAILABLE');
            return res.status(503).json({
                error: {
                    code: 'VOICE_SYSTEM_UNAVAILABLE',
                    message: '음성 시스템 접근 제어 모듈을 사용할 수 없습니다.'
                }
            });
        }

        const voiceAuth = await this.voiceAccessAuthorizer.authorize(user, requiredCapability, null);
        if (!voiceAuth.allowed) {
                const errCode = dispositionType === 'attachment'
                    ? STREAMING_ERROR_CODES.AUDIO_DOWNLOAD_FORBIDDEN
                    : STREAMING_ERROR_CODES.AUDIO_ACCESS_FORBIDDEN;
                this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'DENIED', voiceAuth.reason || errCode);
                return res.status(403).json({
                    error: {
                        code: errCode,
                        message: dispositionType === 'attachment'
                            ? '음성 녹음 파일을 다운로드할 권한이 없습니다.'
                            : '음성 녹음을 재생할 권한이 없습니다.'
                    }
                });
            }

        // 3. Repository Lookup
        const call = this.voiceCallRepo.findById(callId);
        if (!call) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'DENIED', 'NOT_FOUND');
            return res.status(404).json({
                error: {
                    code: STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND,
                    message: '요청한 음성통화를 찾을 수 없습니다.'
                }
            });
        }

        // 4. Resource Scope Authorization Check
        const resourceAction = dispositionType === 'attachment' ? 'download' : 'play';
        const resourceForScope = {
            ...call,
            assignedDepartment: call.assignedDepartmentId || call.assignedDepartment
        };
        const scopeAuth =  authorizeResourceAccess(user, resourceForScope, resourceAction);
        if (!scopeAuth.allowed) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'DENIED', scopeAuth.reason || 'SCOPE_DENIED');
            // Existence Concealment: Return 404 to avoid exposing existence of other departments' records
            return res.status(404).json({
                error: {
                    code: STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND,
                    message: '요청한 음성통화를 찾을 수 없습니다.'
                }
            });
        }

        // 4.1 Restricted Voice Access Scope Check (A10.5)
        if (this.voiceAccessAuthorizer) {
            const scopeCheck = await this.voiceAccessAuthorizer.authorize(user, requiredCapability, resourceForScope);
            if (!scopeCheck.allowed) {
                this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED, callId, userId, 'DENIED', scopeCheck.reason || 'SCOPE_DENIED');
                return res.status(404).json({
                    error: {
                        code: STREAMING_ERROR_CODES.AUDIO_RESOURCE_NOT_FOUND,
                        message: '요청한 음성통화를 찾을 수 없습니다.'
                    }
                });
            }
        }

        // 5. Validate File Eligibility & Pre-flight Inspection
        let meta;
        try {
            meta = await this.accessService.validateEligibleAudio(call);
        } catch (err) {
            const statusCode = err.statusCode || 500;
            const code = err.code || STREAMING_ERROR_CODES.AUDIO_STREAM_FAILED;
            this._recordAudit(
                code === STREAMING_ERROR_CODES.AUDIO_FILE_MISSING ? AUDIT_EVENT_TYPES.AUDIO_FILE_MISSING : AUDIT_EVENT_TYPES.AUDIO_STORAGE_INTEGRITY_ERROR,
                callId,
                userId,
                'ERROR',
                code
            );
            return res.status(statusCode).json({
                error: {
                    code,
                    message: err.safeMessage || '오디오 파일을 열 수 없습니다.'
                }
            });
        }

        // Authorization and file validation passed
        this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_ACCESS_AUTHORIZED, callId, userId, 'SUCCESS');

        // 6. Range Header Parsing
        let range;
        try {
            range = parseRangeHeader(req.headers.range, meta.fileSize);
        } catch (rangeErr) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_RANGE_REJECTED, callId, userId, 'ERROR', rangeErr.code);
            res.setHeader('Content-Range', `bytes */${meta.fileSize}`);
            return res.status(rangeErr.statusCode || 416).json({
                error: {
                    code: rangeErr.code,
                    message: rangeErr.safeMessage
                }
            });
        }

        // 7. Configure Response Headers
        this._setSecurityAndCacheHeaders(res);
        res.setHeader('Content-Type', meta.mimeType);
        res.setHeader('Accept-Ranges', 'bytes');
        // Safe generic filename without client original name or subject tokens
        res.setHeader('Content-Disposition', `${dispositionType}; filename="voice-call-audio.${meta.extension}"`);

        // 8. Apply Range or Full Content Response
        if (range.type === 'range') {
            res.status(206);
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${meta.fileSize}`);
            res.setHeader('Content-Length', String(range.length));
        } else {
            res.status(200);
            res.setHeader('Content-Length', String(meta.fileSize));
        }

        // 9. Open and Stream Audio Stream
        let readStream;
        try {
            const streamResult = await this.accessService.openReadStream(call, {
                start: range.start,
                end: range.end
            });
            readStream = streamResult.stream;
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_STREAM_OPENED, callId, userId, 'SUCCESS');
        } catch (openErr) {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_STREAM_FAILED, callId, userId, 'ERROR', openErr.code || 'OPEN_FAILED');
            if (!res.headersSent) {
                return res.status(500).json({
                    error: {
                        code: STREAMING_ERROR_CODES.AUDIO_STREAM_FAILED,
                        message: '오디오 스트림 생성에 실패했습니다.'
                    }
                });
            }
            return res.destroy();
        }

        // 10. Stream Lifecycle & Error Handling
        let streamFinished = false;

        // Record started event only upon receiving the first data chunk transferred to client
        readStream.once('data', () => {
            this._recordAudit(eventType, callId, userId, 'SUCCESS');
        });

        readStream.on('error', (err) => {
            this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_STREAM_FAILED, callId, userId, 'ERROR', 'STREAM_READ_ERROR');
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        code: STREAMING_ERROR_CODES.AUDIO_STREAM_FAILED,
                        message: '오디오 스트리밍 중 오류가 발생했습니다.'
                    }
                });
            } else {
                // If headers were already sent, abort connection without corrupting stream with JSON text
                res.destroy();
            }
        });

        res.on('close', () => {
            if (!streamFinished) {
                this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_STREAM_ABORTED, callId, userId, 'ABORTED');
                readStream.destroy();
            }
        });

        readStream.on('end', () => {
            streamFinished = true;
        });

        res.on('finish', () => {
            if (streamFinished) {
                this._recordAudit(AUDIT_EVENT_TYPES.AUDIO_STREAM_COMPLETED, callId, userId, 'SUCCESS');
            }
        });

        // Pipe audio stream to HTTP response
        readStream.pipe(res);
    }

    /**
     * HEAD request handler.
     * Metadata inspection without payload body.
     * Ignores Range header per policy and returns 200 with full Content-Length.
     * Never creates a ReadStream or emits AUDIO_PLAY_STARTED.
     * @private
     */
    async _handleHeadRequest(req, res) {
        const callId = req.params.id;
        const user = req.auth;

        // 0. Storage Subsystem Availability Check (Fail-Closed)
        if (this.accessService && this.accessService.available === false) {
            return res.status(503).end();
        }

        // 0.1 Call ID Syntax Validation
        if (!isValidId(callId)) {
            return res.status(400).end();
        }

        if (!user || !user.id) {
            return res.status(401).end();
        }

        if (!hasVoiceCapability(user, VOICE_CAPABILITIES.PLAY_AUDIO)) {
            return res.status(403).end();
        }

        // 2.1 Restricted Voice Access Gate (Mandatory Authorizer)
        if (!this.voiceAccessAuthorizer) {
            return res.status(503).end();
        }

        const voiceAuth = await this.voiceAccessAuthorizer.authorize(user, VOICE_CAPABILITIES.PLAY_AUDIO, null);
        if (!voiceAuth.allowed) {
            return res.status(403).end();
        }

        const call = this.voiceCallRepo.findById(callId);
        if (!call) {
            return res.status(404).end();
        }

        const resourceForScope = {
            ...call,
            assignedDepartment: call.assignedDepartmentId || call.assignedDepartment
        };
        const scopeAuth = authorizeResourceAccess(user, resourceForScope, 'play');
        if (!scopeAuth.allowed) {
            return res.status(404).end();
        }

        if (this.voiceAccessAuthorizer) {
            const scopeCheck = await this.voiceAccessAuthorizer.authorize(user, VOICE_CAPABILITIES.PLAY_AUDIO, resourceForScope);
            if (!scopeCheck.allowed) {
                return res.status(404).end();
            }
        }

        let meta;
        try {
            meta = await this.accessService.validateEligibleAudio(call);
        } catch (err) {
            return res.status(err.statusCode || 500).end();
        }

        this._setSecurityAndCacheHeaders(res);
        res.setHeader('Content-Type', meta.mimeType);
        res.setHeader('Content-Length', String(meta.fileSize));
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', `inline; filename="voice-call-audio.${meta.extension}"`);

        // Policy: HEAD always returns 200 with full Content-Length, Range header is ignored, Content-Range is omitted
        return res.status(200).end();
    }

    /**
     * Apply anti-caching, no-transform, and security headers.
     * @private
     */
    _setSecurityAndCacheHeaders(res) {
        // no-transform explicitly informs compression middlewares and reverse proxies not to alter audio byte streams
        res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, no-transform');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
    }

    /**
     * Safe audit event recorder helper.
     * @private
     */
    _recordAudit(eventType, resourceId, actorUserId, outcome, reasonCode) {
        if (this.auditEventSink && typeof this.auditEventSink.record === 'function') {
            try {
                this.auditEventSink.record({
                    eventType,
                    resourceId,
                    actorUserId,
                    outcome,
                    reasonCode
                });
            } catch (ignore) {}
        }
    }
}

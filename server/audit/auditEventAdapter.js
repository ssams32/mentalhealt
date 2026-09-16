/**
 * server/audit/auditEventAdapter.js
 * Integration Adapters for Mind-ERP OS Track A11 Persistent Audit Log.
 * Connects AssignmentService and AudioStreaming with zero-PII payload policy,
 * session debouncing, replay deduplication, and non-blocking failure isolation.
 */

import crypto from 'crypto';
import {
    AUDIT_CATEGORIES,
    AUDIT_ACTOR_TYPES,
    AUDIT_OUTCOMES,
    AUDIT_EVENT_TYPES
} from './auditConstants.js';

/**
 * Bounded Event Deduplicator for Idempotent Audit Events.
 */
export class AuditEventDeduplicator {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.records = new Map(); // identityKey -> recordedAt
    }

    computeKey(event = {}) {
        return [
            event.eventType || '',
            event.actorId || '',
            event.resourceType || '',
            event.resourceId || '',
            event.operationId || '',
            event.outcome || '',
            event.afterVersion !== undefined && event.afterVersion !== null ? String(event.afterVersion) : ''
        ].join(':');
    }

    isDuplicate(event = {}) {
        const key = this.computeKey(event);
        return this.records.has(key);
    }

    register(event = {}) {
        const key = this.computeKey(event);
        if (this.records.size >= this.maxSize) {
            // Prune oldest 20%
            const toRemove = Math.floor(this.maxSize * 0.2);
            let count = 0;
            for (const k of this.records.keys()) {
                this.records.delete(k);
                count++;
                if (count >= toRemove) break;
            }
        }
        this.records.set(key, Date.now());
    }

    clear() {
        this.records.clear();
    }
}

/**
 * Audit Event Sink Adapter for VoiceCall Assignment Service.
 */
export class AssignmentAuditSink {
    /**
     * @param {object} auditRepo
     * @param {object} [options]
     */
    constructor(auditRepo, options = {}) {
        if (!auditRepo || typeof auditRepo.appendEvent !== 'function') {
            throw new Error('AssignmentAuditSink requires a valid AuditRepository');
        }
        this.auditRepo = auditRepo;
        this.deduplicator = options.deduplicator || new AuditEventDeduplicator(1000);
        this.lastError = null;
    }

    /**
     * Records an assignment audit event.
     * Guarantees non-blocking execution: audit store failures NEVER rollback assignment mutations.
     *
     * @param {object} params
     * @returns {Promise<{ recorded: boolean, entry?: object, error?: string, deduplicated?: boolean }>}
     */
    async record(params = {}) {
        try {
            const {
                eventType,
                actorId,
                resourceId,
                operationId,
                outcome = AUDIT_OUTCOMES.SUCCESS,
                reasonCode,
                beforeVersion,
                afterVersion,
                safeMetadata
            } = params;

            // Map outcomes safely
            const normalizedOutcome = Object.values(AUDIT_OUTCOMES).includes(outcome)
                ? outcome
                : (outcome === 'SUCCESS' ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILED);

            const eventCandidate = {
                eventType,
                category: AUDIT_CATEGORIES.ASSIGNMENT,
                actorType: AUDIT_ACTOR_TYPES.USER,
                actorId: actorId ? String(actorId).trim() : 'system',
                resourceType: 'voice_call',
                resourceId: String(resourceId).trim(),
                operationId: operationId ? String(operationId).trim() : null,
                outcome: normalizedOutcome,
                reasonCode: reasonCode ? String(reasonCode).trim() : null,
                beforeVersion: Number.isSafeInteger(beforeVersion) ? beforeVersion : null,
                afterVersion: Number.isSafeInteger(afterVersion) ? afterVersion : null,
                safeMetadata: safeMetadata || null
            };

            // Deduplicate successful replays for the exact same completed operation and version
            if (normalizedOutcome === AUDIT_OUTCOMES.SUCCESS && operationId) {
                if (this.deduplicator.isDuplicate(eventCandidate)) {
                    return { recorded: false, deduplicated: true };
                }
                // Check persistent repository to avoid relying only on in-memory TTL map
                if (typeof this.auditRepo.hasSuccessfulOperationEvent === 'function') {
                    const exists = await this.auditRepo.hasSuccessfulOperationEvent(operationId);
                    if (exists) {
                        this.deduplicator.register(eventCandidate);
                        return { recorded: false, deduplicated: true };
                    }
                }
            }

            const entry = await this.auditRepo.appendEvent(eventCandidate);

            if (normalizedOutcome === AUDIT_OUTCOMES.SUCCESS && operationId) {
                this.deduplicator.register(eventCandidate);
            }

            this.lastError = null;
            return { recorded: true, entry };
        } catch (err) {
            // Failure isolation: log error but do not propagate to business caller
            this.lastError = err && err.message ? err.message : String(err);
            return { recorded: false, error: this.lastError };
        }
    }
}

export const CANONICAL_AUDIO_EVENT_TYPES = Object.freeze(new Set([
    AUDIT_EVENT_TYPES.AUDIO_ACCESS_AUTHORIZED,
    AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED,
    AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED,
    AUDIT_EVENT_TYPES.AUDIO_DOWNLOAD_STARTED,
    AUDIT_EVENT_TYPES.AUDIO_STREAM_COMPLETED,
    AUDIT_EVENT_TYPES.AUDIO_STREAM_ABORTED,
    AUDIT_EVENT_TYPES.AUDIO_STREAM_FAILED
]));

const AUDIO_EVENT_NAME_MAPPINGS = Object.freeze({
    AUDIO_STREAM_ACCESSED: AUDIT_EVENT_TYPES.AUDIO_ACCESS_AUTHORIZED,
    AUDIO_STREAM_BLOCKED: AUDIT_EVENT_TYPES.AUDIO_ACCESS_DENIED
});

/**
 * Persistent Audio Audit Adapter for Audio Streaming & Download Sessions.
 * Replaces or wraps in-memory AuditEventSink with persistent audit logging,
 * session-level debouncing, and stripping of raw range headers / storage keys.
 */
export class PersistentAudioAuditAdapter {
    /**
     * @param {object} auditRepo
     * @param {object} [options]
     */
    constructor(auditRepo, options = {}) {
        if (!auditRepo || typeof auditRepo.appendEvent !== 'function') {
            throw new Error('PersistentAudioAuditAdapter requires a valid AuditRepository');
        }
        this.auditRepo = auditRepo;
        this.sessionDebounceMs = options.sessionDebounceMs || 10000;
        this.maxDebounceEntries = options.maxDebounceEntries || 500;
        this.activeSessions = new Map(); // key -> timestamp
        this.lastError = null;
    }

    /**
     * Records a session-level audio streaming/access audit event.
     * Prevents log explosion from individual HTTP range chunks.
     *
     * @param {object} params
     * @returns {Promise<{ recorded: boolean, entry?: object, debounced?: boolean, error?: string }>}
     */
    async record(params = {}) {
        const {
            eventType,
            resourceId,
            actorUserId,
            outcome,
            reasonCode,
            forceRecord,
            safeMetadata = {}
        } = params;

        const now = Date.now();
        const actorId = actorUserId ? String(actorUserId).trim() : null;
        const callId = resourceId ? String(resourceId).trim() : 'unknown';

        // 1. Session debouncing for repeated range chunks during playback
        if (eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED && !forceRecord) {
            const sessionKey = `${actorId || 'anonymous'}:${callId}`;
            const lastTime = this.activeSessions.get(sessionKey);
            if (lastTime && (now - lastTime) < this.sessionDebounceMs) {
                return { recorded: false, debounced: true };
            }
            this.activeSessions.set(sessionKey, now);

            // Prune expired sessions
            if (this.activeSessions.size > this.maxDebounceEntries) {
                for (const [k, ts] of this.activeSessions.entries()) {
                    if (now - ts > this.sessionDebounceMs) {
                        this.activeSessions.delete(k);
                    }
                }
            }
        }

        // 2. Map outcome to canonical AuditOutcome
        let mappedOutcome = AUDIT_OUTCOMES.SUCCESS;
        if (outcome === 'DENIED' || outcome === AUDIT_OUTCOMES.DENIED) {
            mappedOutcome = AUDIT_OUTCOMES.DENIED;
        } else if (outcome === 'ERROR' || outcome === 'FAILED' || outcome === AUDIT_OUTCOMES.FAILED) {
            mappedOutcome = AUDIT_OUTCOMES.FAILED;
        } else if (outcome === 'ABORTED' || outcome === AUDIT_OUTCOMES.ABORTED) {
            mappedOutcome = AUDIT_OUTCOMES.ABORTED;
        }

        // 3. Map eventType to canonical allowlist (remove/map known legacy names only, reject unknown events)
        const mappedEventType = AUDIO_EVENT_NAME_MAPPINGS[eventType] || eventType;
        if (!CANONICAL_AUDIO_EVENT_TYPES.has(mappedEventType)) {
            return {
                recorded: false,
                error: `Rejected unknown or unapproved audio eventType: ${eventType}`
            };
        }

        // 4. Sanitize safeMetadata (zero range headers, storage keys, content hashes)
        const sanitizedMetadata = {};
        if (safeMetadata && typeof safeMetadata === 'object') {
            if (safeMetadata.streamDisposition) sanitizedMetadata.streamDisposition = String(safeMetadata.streamDisposition);
            if (safeMetadata.rangeRequestKind) sanitizedMetadata.rangeRequestKind = String(safeMetadata.rangeRequestKind);
            if (safeMetadata.safeResultCode) sanitizedMetadata.safeResultCode = String(safeMetadata.safeResultCode);
        }

        // Inject server-generated playback session ID
        sanitizedMetadata.playbackSessionId = `session_${crypto.randomBytes(4).toString('hex')}`;

        const eventCandidate = {
            eventType: mappedEventType,
            category: AUDIT_CATEGORIES.AUDIO_ACCESS,
            actorType: actorId ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.ANONYMOUS,
            actorId: actorId || null,
            resourceType: 'voice_call',
            resourceId: callId,
            outcome: mappedOutcome,
            reasonCode: reasonCode ? String(reasonCode).trim() : null,
            safeMetadata: Object.keys(sanitizedMetadata).length > 0 ? sanitizedMetadata : null
        };

        try {
            const entry = await this.auditRepo.appendEvent(eventCandidate);
            this.lastError = null;
            return { recorded: true, entry };
        } catch (err) {
            // Non-blocking isolation: do not fail audio streaming on audit store error
            this.lastError = err && err.message ? err.message : String(err);
            return { recorded: false, error: this.lastError };
        }
    }
}

export const CANONICAL_VOICE_ACCESS_EVENT_TYPES = Object.freeze(new Set([
    AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_CREATED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_CAPABILITIES_UPDATED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_SCOPE_UPDATED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_SUSPENDED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_REACTIVATED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_REVOKED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_GRANT_EXPIRED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_ALLOWED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_DENIED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_SUCCEEDED,
    AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_DENIED
]));

/**
 * Safe Audit Adapter for Voice Access Service, Authorizer, and Bootstrap Foundation.
 * Enforces zero-PII payload policy, bounded debounce on access denials,
 * and failure isolation.
 */
export class VoiceAccessAuditAdapter {
    /**
     * @param {object} auditRepo
     * @param {object} [options]
     */
    constructor(auditRepo, options = {}) {
        if (!auditRepo || typeof auditRepo.appendEvent !== 'function') {
            throw new Error('VoiceAccessAuditAdapter requires a valid AuditRepository');
        }
        this.auditRepo = auditRepo;
        this.denyDebounceMs = options.denyDebounceMs || 5000;
        this.maxDebounceEntries = options.maxDebounceEntries || 500;
        this.denialDebounceMap = new Map(); // key -> timestamp
        this.deduplicator = options.deduplicator || new AuditEventDeduplicator(1000);
        this.lastError = null;
    }

    /**
     * Records a grant lifecycle event (creation, update, suspension, reactivation, revocation, expiration).
     *
     * @param {object} params
     * @returns {Promise<{ recorded: boolean, entry?: object, error?: string }>}
     */
    async recordLifecycleEvent(params = {}) {
        const {
            eventType,
            actorId,
            targetUserId,
            grantId,
            outcome = AUDIT_OUTCOMES.SUCCESS,
            reasonCode,
            beforeVersion,
            afterVersion,
            safeMetadata = {}
        } = params;

        if (!CANONICAL_VOICE_ACCESS_EVENT_TYPES.has(eventType)) {
            return { recorded: false, error: `Invalid voice access eventType: ${eventType}` };
        }

        // Strict sanitization: NO raw capability arrays, user names, emails, or grant file paths
        const sanitizedMeta = {};
        if (safeMetadata && typeof safeMetadata === 'object') {
            if (safeMetadata.grantScopeType) sanitizedMeta.grantScopeType = String(safeMetadata.grantScopeType);
            if (Number.isSafeInteger(safeMetadata.capabilityCount)) sanitizedMeta.capabilityCount = safeMetadata.capabilityCount;
            if (safeMetadata.actionCode) sanitizedMeta.actionCode = String(safeMetadata.actionCode);
            if (Number.isSafeInteger(safeMetadata.grantVersion)) sanitizedMeta.grantVersion = safeMetadata.grantVersion;
            if (safeMetadata.safeReasonCode) sanitizedMeta.safeReasonCode = String(safeMetadata.safeReasonCode);
        }

        const candidate = {
            eventType,
            category: AUDIT_CATEGORIES.VOICE_ACCESS,
            actorType: actorId ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.SYSTEM,
            actorId: actorId ? String(actorId).trim() : 'system',
            resourceType: 'voice_access_grant',
            resourceId: grantId ? String(grantId).trim() : (targetUserId ? String(targetUserId).trim() : 'unknown'),
            outcome,
            reasonCode: reasonCode ? String(reasonCode).trim() : null,
            beforeVersion: Number.isSafeInteger(beforeVersion) ? beforeVersion : null,
            afterVersion: Number.isSafeInteger(afterVersion) ? afterVersion : null,
            safeMetadata: Object.keys(sanitizedMeta).length > 0 ? sanitizedMeta : null
        };

        try {
            const entry = await this.auditRepo.appendEvent(candidate);
            this.lastError = null;
            return { recorded: true, entry };
        } catch (err) {
            this.lastError = err && err.message ? err.message : String(err);
            return { recorded: false, error: this.lastError };
        }
    }

    /**
     * Records access authorization outcome (allow or deny).
     * Applies bounded debounce to denials to prevent log flooding.
     *
     * @param {object} params
     * @returns {Promise<{ recorded: boolean, entry?: object, debounced?: boolean, error?: string }>}
     */
    async recordAccessOutcome(params = {}) {
        const {
            allowed,
            actorId,
            capability,
            resourceId,
            reasonCode,
            safeMetadata = {}
        } = params;

        const eventType = allowed ? AUDIT_EVENT_TYPES.VOICE_ACCESS_ALLOWED : AUDIT_EVENT_TYPES.VOICE_ACCESS_DENIED;
        const outcome = allowed ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.DENIED;
        const cleanActorId = actorId ? String(actorId).trim() : 'anonymous';

        if (!allowed) {
            const now = Date.now();
            const debounceKey = `${cleanActorId}:${capability || 'access'}:${reasonCode || 'denied'}`;
            const lastRecorded = this.denialDebounceMap.get(debounceKey);

            if (lastRecorded && (now - lastRecorded) < this.denyDebounceMs) {
                return { recorded: false, debounced: true };
            }

            this.denialDebounceMap.set(debounceKey, now);

            if (this.denialDebounceMap.size > this.maxDebounceEntries) {
                for (const [k, ts] of this.denialDebounceMap.entries()) {
                    if (now - ts > this.denyDebounceMs) {
                        this.denialDebounceMap.delete(k);
                    }
                }
            }
        }

        const sanitizedMeta = {};
        if (safeMetadata && typeof safeMetadata === 'object') {
            if (safeMetadata.safeReasonCode) sanitizedMeta.safeReasonCode = String(safeMetadata.safeReasonCode);
            if (safeMetadata.safeReason) sanitizedMeta.safeReason = String(safeMetadata.safeReason);
            if (safeMetadata.debounceApplied !== undefined) sanitizedMeta.debounceApplied = Boolean(safeMetadata.debounceApplied);
        }

        const candidate = {
            eventType,
            category: AUDIT_CATEGORIES.VOICE_ACCESS,
            actorType: actorId ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.ANONYMOUS,
            actorId: cleanActorId,
            resourceType: 'voice_system',
            resourceId: resourceId ? String(resourceId).trim() : (capability ? String(capability).trim() : 'voice_system'),
            outcome,
            reasonCode: reasonCode ? String(reasonCode).trim() : null,
            safeMetadata: Object.keys(sanitizedMeta).length > 0 ? sanitizedMeta : null
        };

        try {
            const entry = await this.auditRepo.appendEvent(candidate);
            this.lastError = null;
            return { recorded: true, entry };
        } catch (err) {
            this.lastError = err && err.message ? err.message : String(err);
            return { recorded: false, error: this.lastError };
        }
    }

    /**
     * Records bootstrap foundation initialization events.
     * Prevents duplicate bootstrap success audit records.
     *
     * @param {object} params
     * @returns {Promise<{ recorded: boolean, entry?: object, deduplicated?: boolean, error?: string }>}
     */
    async recordBootstrap(params = {}) {
        const {
            outcome = AUDIT_OUTCOMES.SUCCESS,
            actorId,
            grantId,
            reasonCode,
            safeMetadata = {}
        } = params;

        const isSuccess = outcome === AUDIT_OUTCOMES.SUCCESS || outcome === 'success';
        const eventType = isSuccess
            ? AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_SUCCEEDED
            : AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_DENIED;

        const cleanActorId = actorId ? String(actorId).trim() : 'bootstrap_admin';
        const resourceId = grantId ? String(grantId).trim() : 'bootstrap_grant';

        const candidate = {
            eventType,
            category: AUDIT_CATEGORIES.VOICE_ACCESS,
            actorType: AUDIT_ACTOR_TYPES.USER,
            actorId: cleanActorId,
            resourceType: 'voice_access_grant',
            resourceId,
            outcome: isSuccess ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.DENIED,
            reasonCode: reasonCode ? String(reasonCode).trim() : null,
            safeMetadata: null
        };

        const sanitizedMeta = {};
        if (safeMetadata && typeof safeMetadata === 'object') {
            if (Number.isSafeInteger(safeMetadata.capabilityCount)) sanitizedMeta.capabilityCount = safeMetadata.capabilityCount;
            if (safeMetadata.grantScopeType) sanitizedMeta.grantScopeType = String(safeMetadata.grantScopeType);
            if (safeMetadata.bootstrapAction) sanitizedMeta.bootstrapAction = String(safeMetadata.bootstrapAction);
            if (safeMetadata.safeReason) sanitizedMeta.safeReason = String(safeMetadata.safeReason);
            if (safeMetadata.safeReasonCode) sanitizedMeta.safeReasonCode = String(safeMetadata.safeReasonCode);
        }
        if (Object.keys(sanitizedMeta).length > 0) {
            candidate.safeMetadata = sanitizedMeta;
        }

        // Replay deduplication for bootstrap success
        if (isSuccess) {
            if (this.deduplicator.isDuplicate(candidate)) {
                return { recorded: false, deduplicated: true };
            }
            if (typeof this.auditRepo.getEntries === 'function') {
                const existing = await this.auditRepo.getEntries({ limit: 50 });
                const found = existing.some(e => e && e.eventType === AUDIT_EVENT_TYPES.VOICE_ACCESS_BOOTSTRAP_SUCCEEDED);
                if (found) {
                    this.deduplicator.register(candidate);
                    return { recorded: false, deduplicated: true };
                }
            }
        }

        try {
            const entry = await this.auditRepo.appendEvent(candidate);
            if (isSuccess) {
                this.deduplicator.register(candidate);
            }
            this.lastError = null;
            return { recorded: true, entry };
        } catch (err) {
            this.lastError = err && err.message ? err.message : String(err);
            return { recorded: false, error: this.lastError };
        }
    }
}

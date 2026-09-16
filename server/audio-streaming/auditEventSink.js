/**
 * server/audio-streaming/auditEventSink.js
 * Bounded In-memory Audit Event Sink Contract for Mind-ERP OS Audio Streaming.
 * Enforces memory bounds, debounce TTL cleanup, and non-blocking failure isolation.
 */

import { AUDIT_EVENT_TYPES } from './audioStreamingConstants.js';

export class AuditEventSink {
    /**
     * @param {Object} [options={}]
     * @param {number} [options.maxEvents=500] - Hard cap on stored events buffer
     * @param {number} [options.maxDebounceEntries=200] - Hard cap on tracking map
     * @param {number} [options.sessionDebounceMs=10000] - Cooldown for rapid Range chunk requests
     */
    constructor(options = {}) {
        this.maxEvents = options.maxEvents || 500;
        this.maxDebounceEntries = options.maxDebounceEntries || 200;
        this.sessionDebounceMs = options.sessionDebounceMs || 10000;

        this.events = [];
        this.activeSessions = new Map(); // key: `${userId}:${callId}` -> lastRecordTimestamp
        this.failureCount = 0;
    }

    /**
     * Record an auditable streaming event with strict bounding.
     * 
     * @param {Object} event
     * @param {string} event.eventType - From AUDIT_EVENT_TYPES
     * @param {string} event.resourceId - VoiceCall ID
     * @param {string} event.actorUserId - Authenticated User ID
     * @param {string} event.outcome - 'SUCCESS' | 'DENIED' | 'ERROR'
     * @param {string} [event.reasonCode] - Error or rejection reason
     * @param {boolean} [event.forceRecord] - Bypass session debouncing
     * @returns {Object|null} Recorded sanitized event or null if debounced
     */
    record(event = {}) {
        const { eventType, resourceId, actorUserId, outcome, reasonCode, forceRecord } = event;

        const now = Date.now();

        // 1. Lazy prune expired sessions when map grows, enforcing hard cap
        if (this.activeSessions.size > this.maxDebounceEntries) {
            for (const [k, timestamp] of this.activeSessions.entries()) {
                if (now - timestamp > this.sessionDebounceMs) {
                    this.activeSessions.delete(k);
                }
            }
            // Enforce hard cap by dropping oldest entries if active sessions exceed capacity
            if (this.activeSessions.size > this.maxDebounceEntries) {
                const excess = this.activeSessions.size - this.maxDebounceEntries;
                let removed = 0;
                for (const k of this.activeSessions.keys()) {
                    this.activeSessions.delete(k);
                    removed++;
                    if (removed >= excess) break;
                }
            }
        }

        // 2. Debounce repeated play events for the same call by the same user during range seeking
        if (eventType === AUDIT_EVENT_TYPES.AUDIO_PLAY_STARTED && !forceRecord) {
            const sessionKey = `${actorUserId}:${resourceId}`;
            const lastTime = this.activeSessions.get(sessionKey);
            if (lastTime && (now - lastTime) < this.sessionDebounceMs) {
                // Same playback session; skip duplicate event creation to prevent log explosion
                return null;
            }
            this.activeSessions.set(sessionKey, now);
            if (this.activeSessions.size > this.maxDebounceEntries) {
                const excess = this.activeSessions.size - this.maxDebounceEntries;
                let removed = 0;
                for (const k of this.activeSessions.keys()) {
                    this.activeSessions.delete(k);
                    removed++;
                    if (removed >= excess) break;
                }
            }
        }

        // 3. Canonical sanitized audit entry - ZERO clinical details, absolute paths, or credentials
        const sanitizedEntry = {
            id: `audit_${now}_${Math.random().toString(36).substring(2, 8)}`,
            eventType: eventType || AUDIT_EVENT_TYPES.AUDIO_STREAM_FAILED,
            resourceType: 'voice_call',
            resourceId: resourceId || 'unknown',
            actorUserId: actorUserId || 'anonymous',
            outcome: outcome || 'ERROR',
            reasonCode: reasonCode || undefined,
            occurredAt: new Date(now).toISOString()
        };

        // 4. Memory bounding: Shift oldest events when cap is reached
        if (this.events.length >= this.maxEvents) {
            this.events.shift();
        }

        this.events.push(sanitizedEntry);
        return sanitizedEntry;
    }

    /**
     * Retrieve events (for verification and test assertion).
     * @returns {Array<Object>}
     */
    getEvents() {
        return [...this.events];
    }

    /**
     * Clear recorded events (for testing resets).
     */
    clear() {
        this.events = [];
        this.activeSessions.clear();
        this.failureCount = 0;
    }
}

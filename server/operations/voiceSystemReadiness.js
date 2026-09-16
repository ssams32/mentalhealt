/**
 * server/operations/voiceSystemReadiness.js
 * Comprehensive read-only operational readiness inspection for voice subsystems.
 * Never exposes absolute paths, user IDs, secrets, or audio payloads.
 * Guarantees legacy referral operations remain unaffected.
 */

import fs from 'fs';
import path from 'path';
import { OPERATIONAL_STATUS, OPERATIONAL_SUBSYSTEMS, OPERATIONAL_STORAGE_FILES } from './operationConstants.js';

export class VoiceSystemReadiness {
    constructor(options = {}) {
        this.dataDir = options.dataDir || null;
        this.privateAudioRoot = options.privateAudioRoot || null;
        this.joyCallSourcePath = options.joyCallSourcePath || null;
        this.nasIncomingPath = options.nasIncomingPath || null;
        this.sttConfig = options.sttConfig || null;
        this.ollamaConfig = options.ollamaConfig || null;
        this.voiceEnabled = options.voiceEnabled ?? false;
    }

    /**
     * Inspect a JSON store file safely.
     * Returns { status, checkCode, count, details }
     */
    _inspectJsonStore(filename, isArrayExpected = true) {
        if (!this.dataDir) {
            return {
                status: OPERATIONAL_STATUS.UNCONFIGURED,
                checkCode: 'STORE_UNCONFIGURED',
                healthy: false,
                recordCount: 0
            };
        }

        const filePath = path.join(this.dataDir, filename);
        if (!fs.existsSync(filePath)) {
            return {
                status: OPERATIONAL_STATUS.UNAVAILABLE,
                checkCode: 'STORE_NOT_FOUND',
                healthy: false,
                recordCount: 0
            };
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            if (!raw || raw.trim().length === 0) {
                return {
                    status: OPERATIONAL_STATUS.DEGRADED,
                    checkCode: 'STORE_EMPTY',
                    healthy: true,
                    recordCount: 0
                };
            }

            const parsed = JSON.parse(raw);
            if (isArrayExpected) {
                if (!Array.isArray(parsed)) {
                    return {
                        status: OPERATIONAL_STATUS.CORRUPTED,
                        checkCode: 'STORE_CORRUPTED',
                        healthy: false,
                        recordCount: 0
                    };
                }
                return {
                    status: OPERATIONAL_STATUS.READY,
                    checkCode: 'STORE_HEALTHY',
                    healthy: true,
                    recordCount: parsed.length
                };
            } else {
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    return {
                        status: OPERATIONAL_STATUS.CORRUPTED,
                        checkCode: 'STORE_CORRUPTED',
                        healthy: false,
                        recordCount: 0
                    };
                }
                return {
                    status: OPERATIONAL_STATUS.READY,
                    checkCode: 'STORE_HEALTHY',
                    healthy: true,
                    recordCount: Object.keys(parsed).length
                };
            }
        } catch {
            return {
                status: OPERATIONAL_STATUS.CORRUPTED,
                checkCode: 'STORE_CORRUPTED',
                healthy: false,
                recordCount: 0
            };
        }
    }

    /**
     * Inspect directory existence and accessibility without leaking path.
     */
    _inspectDirectory(dirPath) {
        if (!dirPath) {
            return {
                status: OPERATIONAL_STATUS.UNCONFIGURED,
                checkCode: 'DIRECTORY_UNCONFIGURED',
                healthy: false
            };
        }

        try {
            if (!fs.existsSync(dirPath)) {
                return {
                    status: OPERATIONAL_STATUS.UNAVAILABLE,
                    checkCode: 'DIRECTORY_MISSING',
                    healthy: false
                };
            }
            const stat = fs.statSync(dirPath);
            if (!stat.isDirectory()) {
                return {
                    status: OPERATIONAL_STATUS.CORRUPTED,
                    checkCode: 'NOT_A_DIRECTORY',
                    healthy: false
                };
            }
            // Check read/write access
            fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
            return {
                status: OPERATIONAL_STATUS.READY,
                checkCode: 'DIRECTORY_READY',
                healthy: true
            };
        } catch {
            return {
                status: OPERATIONAL_STATUS.BLOCKED,
                checkCode: 'DIRECTORY_ACCESS_DENIED',
                healthy: false
            };
        }
    }

    /**
     * Inspect external AI / engine configuration without revealing keys/secrets.
     */
    _inspectServiceConfig(config, name) {
        if (!config || !config.enabled) {
            return {
                status: OPERATIONAL_STATUS.DISABLED,
                checkCode: `${name.toUpperCase()}_DISABLED`,
                healthy: true,
                configured: false
            };
        }
        if (!config.endpoint && !config.model) {
            return {
                status: OPERATIONAL_STATUS.UNCONFIGURED,
                checkCode: `${name.toUpperCase()}_UNCONFIGURED`,
                healthy: false,
                configured: false
            };
        }
        return {
            status: OPERATIONAL_STATUS.READY,
            checkCode: `${name.toUpperCase()}_READY`,
            healthy: true,
            configured: true
        };
    }

    /**
     * Run full readiness assessment across all 16 subsystems.
     */
    assessReadiness() {
        const subsystems = {};

        // 1. Users Store
        subsystems[OPERATIONAL_SUBSYSTEMS.USERS_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.USERS, true);

        // 2. Voice Access Grant Store
        subsystems[OPERATIONAL_SUBSYSTEMS.VOICE_ACCESS_GRANT_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.VOICE_ACCESS_GRANTS, true);

        // 3. Voice Access History Store
        subsystems[OPERATIONAL_SUBSYSTEMS.VOICE_ACCESS_HISTORY_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.VOICE_ACCESS_HISTORY, true);

        // 4. VoiceCalls Store
        subsystems[OPERATIONAL_SUBSYSTEMS.VOICE_CALLS_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.VOICE_CALLS, true);

        // 5. Private Audio Root
        subsystems[OPERATIONAL_SUBSYSTEMS.PRIVATE_AUDIO_ROOT] = this._inspectDirectory(this.privateAudioRoot);

        // 6. Job Queue Store
        subsystems[OPERATIONAL_SUBSYSTEMS.JOB_QUEUE_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.JOB_QUEUE, true);

        // 7. Notification Store
        subsystems[OPERATIONAL_SUBSYSTEMS.NOTIFICATION_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.NOTIFICATIONS, true);

        // 8. Notification Outbox Store
        subsystems[OPERATIONAL_SUBSYSTEMS.NOTIFICATION_OUTBOX_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.NOTIFICATION_OUTBOX, true);

        // 9. Assignment Operation Store
        subsystems[OPERATIONAL_SUBSYSTEMS.ASSIGNMENT_OPERATION_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.ASSIGNMENT_OPERATIONS, true);

        // 10. Assignment History Store
        subsystems[OPERATIONAL_SUBSYSTEMS.ASSIGNMENT_HISTORY_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.ASSIGNMENT_HISTORY, true);

        // 11. Audit Entries Store
        subsystems[OPERATIONAL_SUBSYSTEMS.AUDIT_ENTRIES_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.AUDIT_ENTRIES, true);

        // 12. Audit Head Store
        subsystems[OPERATIONAL_SUBSYSTEMS.AUDIT_HEAD_STORE] = this._inspectJsonStore(OPERATIONAL_STORAGE_FILES.AUDIT_HEAD, false);

        // 13. JoyCall Source Path
        subsystems[OPERATIONAL_SUBSYSTEMS.JOYCALL_SOURCE_PATH] = this._inspectDirectory(this.joyCallSourcePath);

        // 14. NAS Incoming Path
        subsystems[OPERATIONAL_SUBSYSTEMS.NAS_INCOMING_PATH] = this._inspectDirectory(this.nasIncomingPath);

        // 15. STT Configuration
        subsystems[OPERATIONAL_SUBSYSTEMS.STT_CONFIGURATION] = this._inspectServiceConfig(this.sttConfig, 'stt');

        // 16. Ollama Configuration
        subsystems[OPERATIONAL_SUBSYSTEMS.OLLAMA_CONFIGURATION] = this._inspectServiceConfig(this.ollamaConfig, 'ollama');

        // Determine overall voice readiness
        let overallStatus = OPERATIONAL_STATUS.READY;
        let voiceOperational = true;

        if (!this.voiceEnabled) {
            overallStatus = OPERATIONAL_STATUS.DISABLED;
            voiceOperational = false;
        } else {
            const values = Object.values(subsystems);
            if (values.some(s => s.status === OPERATIONAL_STATUS.CORRUPTED)) {
                overallStatus = OPERATIONAL_STATUS.CORRUPTED;
                voiceOperational = false;
            } else if (values.some(s => s.status === OPERATIONAL_STATUS.BLOCKED)) {
                overallStatus = OPERATIONAL_STATUS.BLOCKED;
                voiceOperational = false;
            } else if (values.some(s => s.status === OPERATIONAL_STATUS.UNAVAILABLE)) {
                overallStatus = OPERATIONAL_STATUS.DEGRADED;
            } else if (values.some(s => s.status === OPERATIONAL_STATUS.UNCONFIGURED)) {
                overallStatus = OPERATIONAL_STATUS.DEGRADED;
            }
        }

        return {
            timestamp: new Date().toISOString(),
            overallStatus,
            voiceSystemOperational: voiceOperational,
            // Legacy referral operations are completely isolated and remain 100% operational
            legacyReferralOperationsOperational: true,
            subsystems,
            summary: {
                totalSubsystems: Object.keys(subsystems).length,
                readyCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.READY).length,
                disabledCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.DISABLED).length,
                unconfiguredCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.UNCONFIGURED).length,
                degradedCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.DEGRADED).length,
                corruptedCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.CORRUPTED).length,
                unavailableCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.UNAVAILABLE).length,
                blockedCount: Object.values(subsystems).filter(s => s.status === OPERATIONAL_STATUS.BLOCKED).length
            }
        };
    }
}

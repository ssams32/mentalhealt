/**
 * server/operations/operationConstants.js
 * Domain constants, subsystem statuses, and check codes for Mind-ERP OS Track A12 Operations.
 */

export const OPERATIONAL_STATUS = Object.freeze({
    READY: 'ready',
    DISABLED: 'disabled',
    UNCONFIGURED: 'unconfigured',
    DEGRADED: 'degraded',
    CORRUPTED: 'corrupted',
    UNAVAILABLE: 'unavailable',
    BLOCKED: 'blocked'
});

export const OPERATIONAL_SUBSYSTEMS = Object.freeze({
    USERS_STORE: 'users_store',
    VOICE_ACCESS_GRANT_STORE: 'voice_access_grant_store',
    VOICE_ACCESS_HISTORY_STORE: 'voice_access_history_store',
    VOICE_CALLS_STORE: 'voice_calls_store',
    PRIVATE_AUDIO_ROOT: 'private_audio_root',
    JOB_QUEUE_STORE: 'job_queue_store',
    NOTIFICATION_STORE: 'notification_store',
    NOTIFICATION_OUTBOX_STORE: 'notification_outbox_store',
    ASSIGNMENT_OPERATION_STORE: 'assignment_operation_store',
    ASSIGNMENT_HISTORY_STORE: 'assignment_history_store',
    AUDIT_ENTRIES_STORE: 'audit_entries_store',
    AUDIT_HEAD_STORE: 'audit_head_store',
    JOYCALL_SOURCE_PATH: 'joycall_source_path',
    NAS_INCOMING_PATH: 'nas_incoming_path',
    STT_CONFIGURATION: 'stt_configuration',
    OLLAMA_CONFIGURATION: 'ollama_configuration'
});

export const OPERATIONAL_STORAGE_FILES = Object.freeze({
    USERS: 'Users.json',
    VOICE_ACCESS_GRANTS: 'VoiceSystemAccessGrants.json',
    VOICE_ACCESS_HISTORY: 'VoiceSystemAccessHistory.json',
    VOICE_CALLS: 'VoiceCalls.json',
    JOB_QUEUE: 'VoiceCallJobs.json',
    NOTIFICATIONS: 'Notifications.json',
    NOTIFICATION_OUTBOX: 'NotificationOutbox.json',
    ASSIGNMENT_OPERATIONS: 'VoiceCallAssignmentOperations.json',
    ASSIGNMENT_HISTORY: 'VoiceCallAssignmentHistory.json',
    AUDIT_ENTRIES: 'AuditEntries.json',
    AUDIT_HEAD: 'AuditHead.json'
});

export const READINESS_CHECK_CODES = Object.freeze({
    CONFIG_MISSING: 'CONFIG_MISSING',
    CONFIG_INVALID: 'CONFIG_INVALID',
    STORE_NOT_FOUND: 'STORE_NOT_FOUND',
    STORE_EMPTY: 'STORE_EMPTY',
    STORE_CORRUPTED: 'STORE_CORRUPTED',
    STORE_HEALTHY: 'STORE_HEALTHY',
    DIRECTORY_MISSING: 'DIRECTORY_MISSING',
    DIRECTORY_UNWRITABLE: 'DIRECTORY_UNWRITABLE',
    SUBSYSTEM_DISABLED: 'SUBSYSTEM_DISABLED',
    SUBSYSTEM_READY: 'SUBSYSTEM_READY',
    SUBSYSTEM_DEGRADED: 'SUBSYSTEM_DEGRADED'
});

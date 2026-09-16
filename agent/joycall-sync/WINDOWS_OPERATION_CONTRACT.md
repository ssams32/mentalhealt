# Mind-ERP OS JoyCall Near-Real-Time Sync Agent
## Windows Deployment and Operational Contract (Track A12.1)

> [!IMPORTANT]
> This document specifies the operational contract for deploying the JoyCall Sync Agent on a Windows workstation hosting JoyCall recordings.
> **DO NOT** execute production service installation or create Windows Scheduled Tasks automatically in this scope.

---

### 1. Architectural Boundaries and Principles

1. **Source Preservation**: The agent operates on the local JoyCall source directory (`C:\Program Files (x86)\JoyCall\db` or configured path) in strictly read-only mode. It **never** alters, moves, renames, or deletes any local files, databases (`.db`), or indices (`.idx`).
2. **Atomic Destination Staging**: Transfers to the NAS incoming directory write first to a `.uploading` temporary suffix, verify byte count and SHA-256 against source, and atomically rename to the final filename only after integrity confirmation.
3. **Fail-Closed Single Instance**: Execution is guarded by an exclusive atomic PID lock file. Multiple concurrent instances are strictly prevented.

---

### 2. Operational Specification

| Contract Dimension | Specification |
|---|---|
| **Executable Entrypoint** | `node agent/joycall-sync/joyCallSyncAgent.js` (or wrapper daemon script) |
| **Required Environment Variables** | `JOYCALL_SOURCE_DIR`: Local source path (e.g., `C:\Program Files (x86)\JoyCall\db`)<br>`NAS_INCOMING_DIR`: Target NAS incoming share (e.g., `\\nas.center.local\voice\incoming` or mapped drive)<br>`JOYCALL_SYNC_STATE_DIR`: Local state directory (default: `%LOCALAPPDATA%\MindERP\joycall-agent\state`)<br>`JOYCALL_SYNC_LOG_DIR`: Local log directory (default: `%LOCALAPPDATA%\MindERP\joycall-agent\logs`) |
| **Local State Directory** | Must reside on the local physical disk (NOT in JoyCall `db` directory, NOT on NAS share). Stores `joycall_transfer_manifest.json` and `joycall_sync_agent.lock`. |
| **Log Directory** | Structured append-only local rotating logs. Never logs file content, transcripts, or personal data. |
| **Startup Command** | `node agent/joycall-sync/joyCallSyncAgent.js` |
| **Shutdown Behavior** | Traps `SIGINT`, `SIGTERM`, and Windows process termination. Finishes current active file stream, closes descriptors, and releases single-instance lock before terminating. |
| **Retry & Backoff Behavior** | Bounded exponential backoff ($1\text{s} \times 2^n$) up to max 3 retries. Interrupted `.uploading` files are preserved and re-evaluated or safely finalized upon restart. |
| **Single-Instance Behavior** | Uses exclusive atomic file creation (`wx` flag) with PID liveness check (`process.kill(pid, 0)`). Refuses to start if another instance is active. Safely recovers stale locks left by power cuts or process crashes without killing active processes. |
| **NAS Unavailable Behavior** | When NAS network share is disconnected or inaccessible, halts transfer, emits diagnostic warning, retains candidate files locally, and resumes automatically once network connectivity is restored. |

---

### 3. Future Windows Task Scheduler Guidelines

When deploying via Windows Task Scheduler in a future approved phase:
- **General**: "Run whether user is logged on or not" with "Do not store password" (or service account credentials).
- **Triggers**: At system startup, with indefinite repetition every 5 minutes if process terminates.
- **Settings**: "Do not start a new instance if the task is already running".
- **Privileges**: Run under a standard Windows service account or local user account with read permissions on `JoyCall\db` and write permissions on the designated NAS share. **Do not use Domain or NAS Administrator privileges**.

---

### 4. Update and Rollback Procedures

- **Update**:
  1. Signal graceful agent stop (`SIGTERM` or stop scheduled task).
  2. Confirm `joycall_sync_agent.lock` is released.
  3. Deploy code update to agent directory.
  4. Run dry-run verification suite (`node scripts/verify-joycall-sync-agent.mjs`).
  5. Restart agent task.
- **Rollback**:
  1. Stop running task.
  2. Restore previous agent codebase.
  3. Manifest is backwards-compatible; no manifest state migration is required.
  4. Restart agent task.

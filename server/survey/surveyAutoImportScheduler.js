/**
 * server/survey/surveyAutoImportScheduler.js
 * Server-side autonomous scheduler for Track A online survey ingestion.
 *
 * Enforces:
 * - Shared semaphore lock with manual import & recovery workflows
 * - Initial delay after server startup (default: 60s)
 * - Configurable cycle interval (default: 5 min)
 * - timer.unref() to allow clean node process shutdown
 * - Fail-safe error handling: never crashes node process, always schedules next run
 * - No PII in audit events or status reports
 */

export class SurveyAutoImportScheduler {
    /**
     * @param {Object} options
     * @param {import('./surveyImportService.js').SurveyImportService} options.surveyImportService
     * @param {Object} options.repository
     * @param {Object} options.externalApiClient
     * @param {Object} [options.keyProvider]
     * @param {Function} [options.auditLogger]
     * @param {boolean} [options.enabled=true]
     * @param {number} [options.initialDelaySeconds=60]
     * @param {number} [options.intervalMinutes=5]
     * @param {number} [options.batchSize=10]
     * @param {number} [options.maxItems=100]
     */
    constructor(options = {}) {
        if (!options.surveyImportService) {
            throw new Error('SurveyAutoImportScheduler requires surveyImportService');
        }

        this.importService = options.surveyImportService;
        this.repository = options.repository || options.surveyImportService.repository;
        this.externalApiClient = options.externalApiClient || options.surveyImportService.externalApiClient;
        this.keyProvider = options.keyProvider || null;
        this.auditLogger = options.auditLogger || null;

        const envEnabled = process.env.SURVEY_AUTO_IMPORT_ENABLED;
        const isExplicitlyEnabledByEnv = envEnabled === 'true' || envEnabled === '1';
        const isExplicitlyEnabledByOption = options.enabled === true;

        // Strict default: auto-sync is DISABLED by default unless explicitly enabled
        this.enabled = envEnabled !== undefined ? isExplicitlyEnabledByEnv : isExplicitlyEnabledByOption;

        const envInitialDelay = Number(process.env.SURVEY_AUTO_IMPORT_INITIAL_DELAY_SECONDS);
        this.initialDelaySeconds = Number.isInteger(envInitialDelay) && envInitialDelay >= 0
            ? envInitialDelay
            : (Number(options.initialDelaySeconds) || 60);

        const envInterval = Number(process.env.SURVEY_AUTO_IMPORT_INTERVAL_MINUTES);
        this.intervalMinutes = Number.isInteger(envInterval) && envInterval >= 1
            ? envInterval
            : (Number(options.intervalMinutes) || 5);

        const envBatchSize = Number(process.env.SURVEY_AUTO_IMPORT_BATCH_SIZE);
        this.batchSize = Number.isInteger(envBatchSize) && envBatchSize >= 1
            ? envBatchSize
            : (Number(options.batchSize) || 10);

        const envMaxItems = Number(process.env.SURVEY_AUTO_IMPORT_MAX_ITEMS);
        this.maxItems = Number.isInteger(envMaxItems) && envMaxItems >= 1
            ? envMaxItems
            : (Number(options.maxItems) || 100);

        this.isRunning = false;
        this.lastSyncAt = null;
        this.lastResult = null;
        this.nextScheduledAt = null;
        this.lastImportedCount = 0;
        this.lastFailedCount = 0;

        this._timer = null;
        this._isDestroyed = false;
    }

    /**
     * Start the background scheduler.
     * Enforces initial delay before first execution (NO immediate run at startup/import).
     */
    start() {
        if (this._isDestroyed) return;
        if (!this.enabled) {
            console.log('ℹ️ [AUTO_IMPORT] Automatic survey synchronization is disabled by configuration.');
            return;
        }

        const initialDelayMs = this.initialDelaySeconds * 1000;
        this.nextScheduledAt = new Date(Date.now() + initialDelayMs).toISOString();

        console.log(`⏰ [AUTO_IMPORT] Scheduled initial cycle in ${this.initialDelaySeconds}s (at ${this.nextScheduledAt}). Interval: ${this.intervalMinutes}m.`);

        if (this.repository && typeof this.repository.recordAuditEvent === 'function') {
            this.repository.recordAuditEvent({
                actorId: 'system_scheduler',
                action: 'SURVEY_AUTO_IMPORT_SCHEDULED',
                result: 'SCHEDULED',
                nextScheduledAt: this.nextScheduledAt,
                intervalMinutes: this.intervalMinutes
            }).catch(() => {});
        }

        this._timer = setTimeout(() => {
            this._runCycle();
        }, initialDelayMs);

        if (this._timer && typeof this._timer.unref === 'function') {
            this._timer.unref();
        }
    }

    /**
     * Stop the scheduler cleanly.
     */
    stop() {
        this._isDestroyed = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /**
     * Execute one autonomous ingestion cycle with strict safety guards.
     */
    async _runCycle() {
        if (this._isDestroyed || !this.enabled) return;

        // Safety 1: Concurrency check across all service imports
        if (this.importService.isImportRunning || this.isRunning) {
            console.log('ℹ️ [AUTO_IMPORT] Skipped: another import job is currently running.');
            if (this.repository && typeof this.repository.recordAuditEvent === 'function') {
                await this.repository.recordAuditEvent({
                    actorId: 'system_scheduler',
                    action: 'SURVEY_IMPORT_SKIPPED_ALREADY_RUNNING',
                    result: 'SKIPPED'
                }).catch(() => {});
            }
            this._scheduleNext();
            return;
        }

        // Safety 2: Health and gate verification
        if (this.externalApiClient && typeof this.externalApiClient.checkSubmissionGateStatus === 'function') {
            try {
                const gate = await this.externalApiClient.checkSubmissionGateStatus();
                if (!gate.enabled) {
                    console.log('ℹ️ [AUTO_IMPORT] Skipped: Track A counseling submission is disabled.');
                    this._scheduleNext();
                    return;
                }
            } catch (err) {
                console.warn('⚠️ [AUTO_IMPORT] Gate check warning:', err.message);
            }
        }

        this.isRunning = true;
        this.lastSyncAt = new Date().toISOString();

        try {
            console.log(`🔄 [AUTO_IMPORT] Starting scheduled survey synchronization cycle (batchSize: ${this.batchSize}, maxItems: ${this.maxItems})...`);

            const summary = await this.importService.runAutoImportCycle({
                actorId: 'system_scheduler',
                batchSize: this.batchSize,
                maxItems: this.maxItems
            });

            this.lastImportedCount = summary.imported || 0;
            this.lastFailedCount = summary.failed || 0;
            this.lastResult = summary.failed > 0
                ? (summary.imported > 0 ? 'PARTIAL_SUCCESS' : 'FAILED')
                : 'SUCCESS';

            console.log(`✅ [AUTO_IMPORT] Cycle completed: imported=${summary.imported}, reused=${summary.reused}, failed=${summary.failed}, stopReason=${summary.stopReason}`);
        } catch (err) {
            console.error('❌ [AUTO_IMPORT] Error during scheduled cycle:', err.message);
            this.lastResult = 'ERROR';
            this.lastFailedCount++;
        } finally {
            this.isRunning = false;
            this._scheduleNext();
        }
    }

    /**
     * Explicitly calculate and arm the next execution timer.
     */
    _scheduleNext() {
        if (this._isDestroyed || !this.enabled) return;

        const intervalMs = this.intervalMinutes * 60 * 1000;
        this.nextScheduledAt = new Date(Date.now() + intervalMs).toISOString();

        this._timer = setTimeout(() => {
            this._runCycle();
        }, intervalMs);

        if (this._timer && typeof this._timer.unref === 'function') {
            this._timer.unref();
        }
    }

    /**
     * Get real-time status summary for UI / API consumption.
     */
    getStatus() {
        return {
            autoSyncEnabled: this.enabled,
            intervalMinutes: this.intervalMinutes,
            batchSize: this.batchSize,
            maxItems: this.maxItems,
            isRunning: this.isRunning || this.importService.isImportRunning,
            lastSyncAt: this.lastSyncAt,
            lastResult: this.lastResult,
            nextScheduledAt: this.nextScheduledAt,
            lastImportedCount: this.lastImportedCount,
            lastFailedCount: this.lastFailedCount
        };
    }
}

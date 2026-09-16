/**
 * agent/joycall-sync/joyCallSyncMetrics.js
 * Tracks synchronization agent metrics safely.
 */

export class JoyCallSyncMetrics {
    constructor() {
        this.reset();
    }

    reset() {
        this.filesDetected = 0;
        this.filesIgnored = 0;
        this.filesStabilized = 0;
        this.filesTransferred = 0;
        this.duplicatesSkipped = 0;
        this.transferErrors = 0;
        this.bytesTransferred = 0;
        this.lastSyncTimestamp = null;
    }

    recordDetected() { this.filesDetected++; }
    recordIgnored() { this.filesIgnored++; }
    recordStabilized() { this.filesStabilized++; }
    recordTransferred(bytes) {
        this.filesTransferred++;
        this.bytesTransferred += (bytes || 0);
        this.lastSyncTimestamp = new Date().toISOString();
    }
    recordDuplicateSkipped() { this.duplicatesSkipped++; }
    recordError() { this.transferErrors++; }

    getSnapshot() {
        return {
            filesDetected: this.filesDetected,
            filesIgnored: this.filesIgnored,
            filesStabilized: this.filesStabilized,
            filesTransferred: this.filesTransferred,
            duplicatesSkipped: this.duplicatesSkipped,
            transferErrors: this.transferErrors,
            bytesTransferred: this.bytesTransferred,
            lastSyncTimestamp: this.lastSyncTimestamp
        };
    }
}

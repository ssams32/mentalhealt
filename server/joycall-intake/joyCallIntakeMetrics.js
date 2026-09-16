/**
 * server/joycall-intake/joyCallIntakeMetrics.js
 * Tracks aggregate ingestion metrics without PII, tokens, or paths.
 */

export class JoyCallIntakeMetrics {
    constructor() {
        this.reset();
    }

    reset() {
        this.totalAccepted = 0;
        this.totalRejected = 0;
        this.totalDuplicates = 0;
        this.totalBytesIntaken = 0;
        this.lastIntakeTimestamp = null;
    }

    recordAccepted(bytes) {
        this.totalAccepted++;
        this.totalBytesIntaken += (bytes || 0);
        this.lastIntakeTimestamp = new Date().toISOString();
    }

    recordRejected() {
        this.totalRejected++;
    }

    recordDuplicate() {
        this.totalDuplicates++;
    }

    getSnapshot() {
        return {
            totalAccepted: this.totalAccepted,
            totalRejected: this.totalRejected,
            totalDuplicates: this.totalDuplicates,
            totalBytesIntaken: this.totalBytesIntaken,
            lastIntakeTimestamp: this.lastIntakeTimestamp
        };
    }
}

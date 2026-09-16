/**
 * server/operations/operationMetrics.js
 * Read-only metrics collector for operational subsystems.
 * Never includes user IDs, secrets, or file paths.
 */

export function getOperationMetrics(subsystemsStatus = {}) {
    const counts = {
        totalSubsystems: 0,
        ready: 0,
        disabled: 0,
        unconfigured: 0,
        degraded: 0,
        corrupted: 0,
        unavailable: 0,
        blocked: 0
    };

    if (subsystemsStatus && typeof subsystemsStatus === 'object') {
        const entries = Object.entries(subsystemsStatus);
        counts.totalSubsystems = entries.length;
        for (const [, sub] of entries) {
            if (sub && sub.status && Object.prototype.hasOwnProperty.call(counts, sub.status)) {
                counts[sub.status]++;
            }
        }
    }

    return {
        timestamp: new Date().toISOString(),
        metrics: counts,
        healthyRatio: counts.totalSubsystems > 0 ? (counts.ready / counts.totalSubsystems) : 0
    };
}

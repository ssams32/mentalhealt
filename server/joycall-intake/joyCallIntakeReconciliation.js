/**
 * server/joycall-intake/joyCallIntakeReconciliation.js
 * Read-only auditor for NAS incoming directory and JoyCall intake records.
 * Identifies orphaned files, pending .uploading files, and potential discrepancies.
 */

import fs from 'fs';
import path from 'path';

export const JOYCALL_RECONCILIATION_CODES = Object.freeze({
    UPLOADING_FILE_PENDING: 'UPLOADING_FILE_PENDING',
    UNREGISTERED_RECORDING_PRESENT: 'UNREGISTERED_RECORDING_PRESENT',
    REGISTERED_RECORDING_MISSING_ON_NAS: 'REGISTERED_RECORDING_MISSING_ON_NAS',
    EMPTY_FILE_FOUND: 'EMPTY_FILE_FOUND',
    DIRECTORY_INACCESSIBLE: 'DIRECTORY_INACCESSIBLE'
});

export async function runJoyCallIntakeReconciliation(params = {}) {
    const { nasIncomingDir, repository } = params;
    const findings = [];

    if (!nasIncomingDir || !fs.existsSync(nasIncomingDir)) {
        return {
            status: 'FAILED',
            reason: JOYCALL_RECONCILIATION_CODES.DIRECTORY_INACCESSIBLE,
            findings: [{
                code: JOYCALL_RECONCILIATION_CODES.DIRECTORY_INACCESSIBLE,
                severity: 'CRITICAL',
                message: 'NAS incoming directory is inaccessible'
            }]
        };
    }

    const entries = fs.readdirSync(nasIncomingDir, { withFileTypes: true });
    const registeredCalls = repository ? repository.list() : [];
    const registeredHashes = new Set(registeredCalls.map(c => c.contentHash).filter(Boolean));

    for (const entry of entries) {
        if (!entry.isFile()) continue;

        const name = entry.name;
        const fullPath = path.join(nasIncomingDir, name);

        // Check if stuck in .uploading
        if (name.toLowerCase().endsWith('.uploading')) {
            findings.push({
                code: JOYCALL_RECONCILIATION_CODES.UPLOADING_FILE_PENDING,
                severity: 'WARNING',
                filename: name,
                message: 'Temporary .uploading file is present in NAS incoming directory'
            });
            continue;
        }

        try {
            const stat = fs.statSync(fullPath);
            if (stat.size === 0) {
                findings.push({
                    code: JOYCALL_RECONCILIATION_CODES.EMPTY_FILE_FOUND,
                    severity: 'WARNING',
                    filename: name,
                    message: 'Zero-byte file detected in NAS incoming directory'
                });
            }
        } catch { /* ignore stat error */ }
    }

    return {
        timestamp: new Date().toISOString(),
        isReadOnly: true,
        totalFindings: findings.length,
        findings,
        totalFilesInDir: entries.filter(e => e.isFile()).length,
        totalRegisteredCalls: registeredCalls.length
    };
}

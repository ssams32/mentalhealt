/**
 * agent/joycall-sync/inspectJoyCallDirectory.js
 * Read-only recursive inspection CLI tool for JoyCall source directory.
 * 
 * SAFETY & PRIVACY BOUNDARIES:
 * - Read-only: Never writes, renames, deletes, or opens files for write.
 * - Privacy: Never outputs filenames, directory names, absolute paths, phone numbers, or audio payloads.
 * - Aggregates only: Reports extension tallies, candidate counts, audio signatures, and size metrics.
 * - Do not follow symbolic links.
 * - Strictly bounded: Enforces maxTraversalDepth, maxFileCount, maxInspectionDurationMs, maxCandidateHeaderReads.
 * - Dry-run only: If target directory is unavailable or empty of candidates, reports truthful status.
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_JOYCALL_SOURCE_DIR, JOYCALL_SUPPORTED_EXTENSIONS } from './joyCallSyncConstants.js';
import { detectAudioSignature } from '../../server/audio-intake/audioSignatureDetector.js';

export const INSPECTION_LIMITS = Object.freeze({
    DEFAULT_MAX_DEPTH: 5,
    DEFAULT_MAX_FILES: 10000,
    DEFAULT_MAX_DURATION_MS: 10000,
    DEFAULT_MAX_HEADER_READS: 1000
});

export async function inspectJoyCallDirectory(options = {}) {
    const targetDir = (typeof options === 'string' ? options : options?.customDir) ||
        process.env.JOYCALL_SOURCE_DIR ||
        DEFAULT_JOYCALL_SOURCE_DIR;

    const maxDepth = options?.maxDepth ?? INSPECTION_LIMITS.DEFAULT_MAX_DEPTH;
    const maxFiles = options?.maxFiles ?? INSPECTION_LIMITS.DEFAULT_MAX_FILES;
    const maxDurationMs = options?.maxDurationMs ?? INSPECTION_LIMITS.DEFAULT_MAX_DURATION_MS;
    const maxHeaderReads = options?.maxHeaderReads ?? INSPECTION_LIMITS.DEFAULT_MAX_HEADER_READS;

    if (!fs.existsSync(targetDir)) {
        return {
            status: 'NOT_RUN',
            reason: 'TARGET_DIRECTORY_UNAVAILABLE',
            directoryConfigured: Boolean(targetDir)
        };
    }

    const startTime = Date.now();
    let totalDirectoryCount = 0;
    let totalFileCount = 0;
    let candidateCount = 0;
    let headerReadCount = 0;
    let traversalLimitReached = false;
    let hasNestedDateDirectories = false;

    const extensionCounts = {};
    const signatureCounts = {};
    const candidateSizes = [];
    let stableCandidateCount = 0;
    let unstableCandidateCount = 0;
    let recentlyModifiedCandidateCount = 0;
    let unreadableCandidateCount = 0;

    const supportedExtSet = new Set(JOYCALL_SUPPORTED_EXTENSIONS.map(e => e.toLowerCase()));
    const oneDayAgoMs = Date.now() - (24 * 60 * 60 * 1000);
    const quietWindowMs = 5000;

    // Date directory patterns: e.g. 2026, 202609, 2026-09-12, 260912
    const dateDirPattern = /^(\d{4}|\d{6}|\d{8}|\d{4}[-_]\d{2}|\d{4}[-_]\d{2}[-_]\d{2})$/;

    function traverse(currentDir, currentDepth) {
        if (currentDepth > maxDepth) {
            traversalLimitReached = true;
            return;
        }
        if (Date.now() - startTime > maxDurationMs) {
            traversalLimitReached = true;
            return;
        }
        if (totalFileCount >= maxFiles) {
            traversalLimitReached = true;
            return;
        }

        let entries = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            // Check timeout or file limits on each entry
            if (Date.now() - startTime > maxDurationMs || totalFileCount >= maxFiles) {
                traversalLimitReached = true;
                return;
            }

            // 3. Do NOT follow symbolic links
            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                totalDirectoryCount++;
                if (dateDirPattern.test(entry.name)) {
                    hasNestedDateDirectories = true;
                }
                traverse(path.join(currentDir, entry.name), currentDepth + 1);
                continue;
            }

            if (!entry.isFile()) continue;
            totalFileCount++;

            const ext = path.extname(entry.name).toLowerCase() || '[no_extension]';
            extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;

            if (supportedExtSet.has(ext)) {
                candidateCount++;
                const fullPath = path.join(currentDir, entry.name);

                let stat = null;
                try {
                    stat = fs.statSync(fullPath);
                } catch {
                    unreadableCandidateCount++;
                    continue;
                }

                candidateSizes.push(stat.size);

                const ageMs = Date.now() - stat.mtimeMs;
                if (stat.mtimeMs > oneDayAgoMs) {
                    recentlyModifiedCandidateCount++;
                }

                if (ageMs >= quietWindowMs && stat.size > 1024) {
                    stableCandidateCount++;
                } else {
                    unstableCandidateCount++;
                }

                // Header inspection within budget
                if (headerReadCount < maxHeaderReads) {
                    headerReadCount++;
                    let fd = null;
                    try {
                        fd = fs.openSync(fullPath, 'r');
                        const buf = Buffer.alloc(512);
                        const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
                        if (bytesRead >= 44) {
                            const sig = detectAudioSignature(buf.subarray(0, bytesRead));
                            const sigFormat = (sig && sig.detected) ? sig.format : 'unknown_signature';
                            signatureCounts[sigFormat] = (signatureCounts[sigFormat] || 0) + 1;
                        } else {
                            signatureCounts['header_truncated'] = (signatureCounts['header_truncated'] || 0) + 1;
                        }
                    } catch {
                        unreadableCandidateCount++;
                        signatureCounts['unreadable'] = (signatureCounts['unreadable'] || 0) + 1;
                    } finally {
                        if (fd !== null) {
                            try { fs.closeSync(fd); } catch { /* ignore */ }
                        }
                    }
                }
            }
        }
    }

    traverse(targetDir, 0);

    let minCandidateBytes = 0;
    let maxCandidateBytes = 0;
    let avgCandidateBytes = 0;

    if (candidateSizes.length > 0) {
        minCandidateBytes = Math.min(...candidateSizes);
        maxCandidateBytes = Math.max(...candidateSizes);
        const sum = candidateSizes.reduce((a, b) => a + b, 0);
        avgCandidateBytes = Math.round(sum / candidateSizes.length);
    }

    const durationMs = Date.now() - startTime;

    return {
        status: candidateCount >= 1 ? 'PASS' : 'PASS_NO_CANDIDATES',
        totalDirectoryCount,
        totalFileCount,
        candidateCount,
        stableCandidateCount,
        unstableCandidateCount,
        recentlyModifiedCandidateCount,
        unreadableCandidateCount,
        hasNestedDateDirectories,
        extensionDistribution: extensionCounts,
        audioSignatureDistribution: signatureCounts,
        sizeMetrics: {
            minCandidateBytes,
            maxCandidateBytes,
            avgCandidateBytes
        },
        inspectionMetrics: {
            durationMs,
            headerReadCount,
            traversalLimitReached
        }
    };
}

/**
 * Recording-observation mode: compares aggregate state across repeated samples
 * without exposing filenames or audio payloads.
 */
export async function observeJoyCallDirectoryChanges(options = {}) {
    const intervalMs = options.intervalMs || 500;
    const sample1 = await inspectJoyCallDirectory(options);
    await new Promise(r => setTimeout(r, intervalMs));
    const sample2 = await inspectJoyCallDirectory(options);

    return {
        observationDurationMs: intervalMs,
        sample1Summary: {
            candidateCount: sample1.candidateCount,
            totalFileCount: sample1.totalFileCount,
            stableCandidateCount: sample1.stableCandidateCount,
            unstableCandidateCount: sample1.unstableCandidateCount
        },
        sample2Summary: {
            candidateCount: sample2.candidateCount,
            totalFileCount: sample2.totalFileCount,
            stableCandidateCount: sample2.stableCandidateCount,
            unstableCandidateCount: sample2.unstableCandidateCount
        },
        delta: {
            candidateDelta: sample2.candidateCount - sample1.candidateCount,
            fileDelta: sample2.totalFileCount - sample1.totalFileCount,
            newStableCandidates: sample2.stableCandidateCount - sample1.stableCandidateCount
        }
    };
}

// CLI Execution Check
if (process.argv[1] && process.argv[1].endsWith('inspectJoyCallDirectory.js')) {
    const isDryRun = process.argv.includes('--dry-run');
    if (!isDryRun) {
        console.error('Error: inspectJoyCallDirectory requires --dry-run flag.');
        process.exit(1);
    }

    inspectJoyCallDirectory()
        .then(res => {
            console.log(JSON.stringify(res, null, 2));
            process.exit(0);
        })
        .catch(err => {
            console.error('Fatal inspection error:', err.message);
            process.exit(1);
        });
}

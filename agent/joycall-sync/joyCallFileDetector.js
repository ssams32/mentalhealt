/**
 * agent/joycall-sync/joyCallFileDetector.js
 * Scans and filters files in the JoyCall database/recording directory.
 * Explicitly ignores database files, index files, configs, and temporary files.
 * Supports safe bounded recursive scanning across nested date directories.
 */

import fs from 'fs';
import path from 'path';
import {
    JOYCALL_SUPPORTED_EXTENSIONS,
    JOYCALL_IGNORED_EXTENSIONS
} from './joyCallSyncConstants.js';

export class JoyCallFileDetector {
    constructor(options = {}) {
        this.supportedExtensions = new Set(
            (options.supportedExtensions || JOYCALL_SUPPORTED_EXTENSIONS).map(e => e.toLowerCase())
        );
        this.ignoredExtensions = new Set(
            (options.ignoredExtensions || JOYCALL_IGNORED_EXTENSIONS).map(e => e.toLowerCase())
        );
        this.maxDepth = options.maxDepth ?? 5;
    }

    /**
     * Determine whether a filename is a supported recording.
     */
    isSupportedRecordingFile(filename) {
        if (!filename || typeof filename !== 'string') return false;
        const base = path.basename(filename);
        if (base.startsWith('.')) return false; // Ignore hidden files
        const ext = path.extname(base).toLowerCase();
        if (this.ignoredExtensions.has(ext)) return false;
        return this.supportedExtensions.has(ext);
    }

    /**
     * Determine whether a file should be ignored immediately.
     */
    shouldIgnoreFile(filename) {
        if (!filename || typeof filename !== 'string') return true;
        const lower = filename.toLowerCase();
        if (lower.endsWith('.uploading')) return true;
        const ext = path.extname(lower);
        return this.ignoredExtensions.has(ext) || !this.supportedExtensions.has(ext);
    }

    /**
     * Scan directory (recursively by default) and return list of relative candidate paths.
     * Never follows symbolic links. Never alters directory or files.
     */
    scanDirectory(dirPath, options = {}) {
        if (!dirPath || !fs.existsSync(dirPath)) {
            return [];
        }

        const isRecursive = options.recursive ?? true;
        const maxDepth = options.maxDepth ?? this.maxDepth;
        const candidates = [];

        const walk = (currentDir, depth, relPrefix) => {
            if (depth > maxDepth) return;

            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                // Ignore symbolic links
                if (entry.isSymbolicLink()) continue;

                if (entry.isDirectory()) {
                    if (isRecursive) {
                        walk(path.join(currentDir, entry.name), depth + 1, path.join(relPrefix, entry.name));
                    }
                    continue;
                }

                if (entry.isFile() && this.isSupportedRecordingFile(entry.name)) {
                    const relPath = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
                    candidates.push(relPath);
                }
            }
        };

        walk(dirPath, 0, '');
        return candidates;
    }
}

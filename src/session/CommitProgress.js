'use strict';

const ProgressEntry = require('./ProgressEntry');

/**
 * CommitProgress
 * src/session/CommitProgress.js
 *
 * In-memory and on-disk representation of per-file build progress.
 * Serialised as JSON to disk after every step so the pipeline can
 * resume from any interruption point without re-doing completed work.
 *
 * The entries Map is keyed by fileFingerprint — each asset gets exactly
 * one ProgressEntry regardless of which pack it lives in.
 */

class CommitProgress {

    /**
     * @param {object} opts
     * @param {string} opts.sessionId     - Parent session identifier
     * @param {string} opts.status        - 'pending' | 'building' | 'finalising' | 'complete' | 'interrupted'
     * @param {string} opts.packListPath  - Path to pack-list.json on disk
     * @param {string} opts.indexListPath - Path to index-list.json on disk
     */
    constructor({ sessionId, status = 'pending', packListPath, indexListPath } = {}) {
        this.sessionId     = sessionId;
        this.status        = status;
        this.packListPath  = packListPath  || null;
        this.indexListPath = indexListPath || null;
        this.entries       = new Map();   // fileFingerprint → ProgressEntry
        this.startedAt     = new Date();
        this.updatedAt     = new Date();
    }

    // ---------------------------------------------------------------------------
    // Entry management
    // ---------------------------------------------------------------------------

    /**
     * Retrieve progress for a specific file.
     * @param {string} fileFingerprint
     * @returns {ProgressEntry|null}
     */
    getEntry(fileFingerprint) {
        return this.entries.get(fileFingerprint) || null;
    }

    /**
     * Add a new ProgressEntry for a file.
     * @param {ProgressEntry} entry
     */
    addEntry(entry) {
        this.entries.set(entry.fileFingerprint, entry);
    }

    /**
     * Mark a specific step complete for a file.
     * Updates the entry in-place and advances the updatedAt timestamp.
     *
     * @param {string} fileFingerprint
     * @param {string} step - 'extracted' | 'verified' | 'packed' | 'cleaned'
     */
    markComplete(fileFingerprint, step) {
        const entry = this.entries.get(fileFingerprint);
        if (!entry) throw new Error(`No progress entry for fingerprint: ${fileFingerprint.slice(0, 12)}...`);
        if (!(step in entry)) throw new Error(`Unknown step: ${step}`);
        entry[step]    = true;
        this.updatedAt = new Date();
    }

    /**
     * Check if all four steps are done for a file.
     * @param {string} fileFingerprint
     * @returns {boolean}
     */
    isFileComplete(fileFingerprint) {
        const entry = this.entries.get(fileFingerprint);
        return entry ? entry.isComplete() : false;
    }

    /**
     * Return all entries not yet fully complete.
     * Used by resume() to find where to pick up.
     *
     * @returns {ProgressEntry[]}
     */
    pendingEntries() {
        return Array.from(this.entries.values()).filter(e => !e.isComplete());
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            sessionId:     this.sessionId,
            status:        this.status,
            packListPath:  this.packListPath,
            indexListPath: this.indexListPath,
            startedAt:     this.startedAt.toISOString(),
            updatedAt:     this.updatedAt.toISOString(),
            entries:       Array.from(this.entries.values()).map(e => e.toJSON())
        };
    }

    /**
     * @param {object} obj
     * @returns {CommitProgress}
     */
    static fromJSON(obj) {
        const cp = new CommitProgress({
            sessionId:     obj.sessionId,
            status:        obj.status        || 'pending',
            packListPath:  obj.packListPath  || null,
            indexListPath: obj.indexListPath || null
        });
        cp.startedAt = obj.startedAt ? new Date(obj.startedAt) : new Date();
        cp.updatedAt = obj.updatedAt ? new Date(obj.updatedAt) : new Date();
        for (const entryObj of (obj.entries || [])) {
            const entry = ProgressEntry.fromJSON(entryObj);
            cp.entries.set(entry.fileFingerprint, entry);
        }
        return cp;
    }

}

module.exports = CommitProgress;

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
 * The entries Map is keyed by composite key: `${decodedName}::${fileFingerprint}`
 *
 * This matches the FingerprintStore primary key design:
 *   same name + same hash  -> same key   -> exact duplicate, skip
 *   same name + diff hash  -> diff key   -> new version, track separately
 *   diff name + same hash  -> diff key   -> alias, both written to pack
 *   diff name + diff hash  -> diff key   -> unrelated files, both written
 *
 * CommitPipeline calls CommitProgress.makeKey(name, hash) to get the key,
 * then passes it to getEntry() / entries.has() — keeping key assembly in
 * one place.
 */

class CommitProgress {

    constructor({ sessionId, status = 'pending', packListPath, indexListPath } = {}) {
        this.sessionId     = sessionId;
        this.status        = status;
        this.packListPath  = packListPath  || null;
        this.indexListPath = indexListPath || null;
        this.entries       = new Map();   // "name::hash" -> ProgressEntry
        this.startedAt     = new Date();
        this.updatedAt     = new Date();
    }

    // ---------------------------------------------------------------------------
    // Key assembly
    // ---------------------------------------------------------------------------

    /**
     * Build the composite progress key for a file.
     * Mirrors FingerprintStore primary key: decodedName::fileFingerprint.
     *
     * @param {string} decodedName      - targetName of the staged file
     * @param {string} fileFingerprint  - raw content hash (sourceFingerprint or checksum)
     * @returns {string}
     */
    static makeKey(decodedName, fileFingerprint) {
        return `${decodedName}::${fileFingerprint}`;
    }

    // ---------------------------------------------------------------------------
    // Entry management
    // ---------------------------------------------------------------------------

    /**
     * Retrieve a progress entry by its composite key.
     * Use CommitProgress.makeKey(name, hash) to build the key.
     * @param {string} key
     * @returns {ProgressEntry|null}
     */
    getEntry(key) {
        return this.entries.get(key) || null;
    }

    /**
     * Add a new ProgressEntry. Key is built from entry.decodedName::entry.fileFingerprint.
     * @param {ProgressEntry} entry
     */
    addEntry(entry) {
        const key = CommitProgress.makeKey(entry.decodedName, entry.fileFingerprint);
        this.entries.set(key, entry);
    }

    /**
     * Mark a specific step complete for a file.
     * @param {string} key  - composite key from makeKey()
     * @param {string} step - 'extracted' | 'verified' | 'packed' | 'cleaned'
     */
    markComplete(key, step) {
        const entry = this.entries.get(key);
        if (!entry) throw new Error(`No progress entry for: ${key}`);
        if (!(step in entry)) throw new Error(`Unknown step: ${step}`);
        entry[step]    = true;
        this.updatedAt = new Date();
    }

    /**
     * Check if all four steps are done for a file.
     * @param {string} key - composite key from makeKey()
     * @returns {boolean}
     */
    isFileComplete(key) {
        const entry = this.entries.get(key);
        return entry ? entry.isComplete() : false;
    }

    /**
     * Return all entries not yet fully complete.
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
            const key   = CommitProgress.makeKey(entry.decodedName, entry.fileFingerprint);
            cp.entries.set(key, entry);
        }
        return cp;
    }

}

module.exports = CommitProgress;

'use strict';

const fs         = require('fs');
const path       = require('path');
const StagedFile = require('./StagedFile');

/**
 * Session
 * src/session/Session.js
 *
 * Represents one in-progress pack-building session.
 * Lives in a dedicated working directory and is completely isolated
 * from permanent libraries (FingerprintStore, AssetStore, Blueprint)
 * until explicitly committed via CommitPipeline.
 *
 * Status lifecycle:
 *   active      → Session is being worked on, files are being staged
 *   interrupted → Session was interrupted before preparation completed
 *   ready       → Phase 1 complete, lists written to disk
 *   building    → CommitPipeline Phase 2 in progress
 *   finalising  → CommitPipeline Phase 3 in progress
 *   committed   → Pipeline completed successfully
 *   discarded   → Session was discarded
 *
 * removeFile() transitions to 'deleted' rather than removing the entry —
 * preserves a complete audit trail of what the user chose to exclude.
 */

class Session {

    /**
     * @param {object}            opts
     * @param {string}            opts.sessionId      - UUID
     * @param {string}            opts.label          - User-friendly name
     * @param {string}            opts.workingDir     - Temp directory path
     * @param {string}            opts.status         - Session status enum
     * @param {PackConfiguration} opts.config         - Target pack configuration
     * @param {string|null}       opts.blueprintRef   - indexFingerprint of source blueprint
     * @param {boolean}           opts.blueprintLoaded
     * @param {StagedFile[]}      opts.stagedFiles
     * @param {Date}              opts.createdAt
     * @param {Date}              opts.updatedAt
     */
    constructor({
        sessionId,
        label          = '',
        workingDir,
        status         = 'active',
        config,
        blueprintRef   = null,
        blueprintLoaded = false,
        stagedFiles    = [],
        createdAt      = null,
        updatedAt      = null
    } = {}) {
        this.sessionId       = sessionId;
        this.label           = label;
        this.workingDir      = workingDir;
        this.status          = status;
        this.config          = config;
        this.blueprintRef    = blueprintRef;
        this.blueprintLoaded = blueprintLoaded;
        this.createdAt       = createdAt instanceof Date ? createdAt : new Date();
        this.updatedAt       = updatedAt instanceof Date ? updatedAt : new Date();

        // Internal Map for O(1) dedup by targetName.
        // stagedFiles array on the constructor arg is only used when restoring from JSON.
        this._fileMap = new Map();
        for (const f of stagedFiles) {
            this._fileMap.set(f.targetName, f);
        }
    }

    // Keep stagedFiles as a public getter for backwards compatibility
    // (toJSON and any external code that reads session.stagedFiles directly)
    get stagedFiles() {
        return Array.from(this._fileMap.values());
    }

    // ---------------------------------------------------------------------------
    // File staging
    // ---------------------------------------------------------------------------

    /**
     * Copy a file from sourcePath into the working directory and stage it.
     * Computes checksum and size in one pass during the copy.
     *
     * @param {string} sourcePath  - Absolute path to the source file
     * @param {string} targetName  - Intended decoded filename in the final pack
     * @returns {StagedFile}
     */
    addFile(sourcePath, targetName) {
        const stagedPath = this.getWorkingPath(targetName);

        // Copy to working directory
        fs.copyFileSync(sourcePath, stagedPath);

        const stat     = fs.statSync(stagedPath);
        const checksum = require('crypto')
            .createHash('sha256')
            .update(fs.readFileSync(stagedPath))
            .digest('hex');

        const staged = new StagedFile({
            targetName,
            sourcePath,
            stagedPath,
            category:  'new',
            sizeBytes: stat.size,
            checksum
        });

        // O(1) upsert — replaces any existing entry for this targetName
        this._fileMap.set(targetName, staged);
        this.updatedAt = new Date();

        return staged;
    }

    /**
     * Stage an asset already in the AssetStore.
     * stagedPath is left null — resolved lazily via StagedFile.resolve()
     * during the build when the actual bytes are needed.
     *
     * @param {string} fingerprint - FingerprintRecord hash in AssetStore
     * @param {string} targetName  - Intended decoded filename in the final pack
     * @returns {StagedFile}
     */
    addFromStore(fingerprint, targetName) {
        const staged = new StagedFile({
            targetName,
            sourcePath:        null,
            stagedPath:        null,  // resolved lazily
            category:          'in-store',
            sourceFingerprint: fingerprint,
            sizeBytes:         0,     // resolved lazily
            checksum:          null   // not needed for in-store assets
        });

        // O(1) upsert — replaces any existing entry for this targetName
        this._fileMap.set(targetName, staged);
        this.updatedAt = new Date();

        return staged;
    }

    /**
     * Transition a staged file to 'deleted' status.
     * Does not remove the entry — preserves the audit trail.
     * The build skips deleted entries cleanly.
     *
     * @param {string} targetName
     * @returns {boolean} true if found and marked deleted
     */
    removeFile(targetName) {
        const file = this._fileMap.get(targetName);
        if (!file) return false;
        file.markDeleted();
        this.updatedAt = new Date();
        return true;
    }

    /**
     * List all staged files.
     * @returns {StagedFile[]}
     */
    listFiles() {
        return Array.from(this._fileMap.values());
    }

    /**
     * Resolve the absolute path for a file inside the working directory.
     * @param {string} targetName
     * @returns {string}
     */
    getWorkingPath(targetName) {
        return path.join(this.workingDir, targetName);
    }

    // ---------------------------------------------------------------------------
    // Status transitions
    // ---------------------------------------------------------------------------

    /** Mark session as interrupted — called on unexpected process exit */
    markInterrupted() {
        this.status    = 'interrupted';
        this.updatedAt = new Date();
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            sessionId:       this.sessionId,
            label:           this.label,
            workingDir:      this.workingDir,
            status:          this.status,
            blueprintRef:      this.blueprintRef,
            blueprintStoreDir: this.blueprintStoreDir,
            blueprintLoaded:   this.blueprintLoaded,
            stagedFiles:     this.stagedFiles.map(f => f.toJSON()),
            config:          this.config ? this.config.toJSON() : null,
            createdAt:       this.createdAt.toISOString(),
            updatedAt:       this.updatedAt.toISOString()
        };
    }

    /**
     * @param {object}            obj
     * @param {PackConfiguration} config - Pre-constructed config (not re-built from JSON here)
     * @returns {Session}
     */
    static fromJSON(obj, config) {
        return new Session({
            sessionId:       obj.sessionId,
            label:           obj.label           || '',
            workingDir:      obj.workingDir,
            status:          obj.status          || 'active',
            config,
            blueprintRef:      obj.blueprintRef      || null,
            blueprintStoreDir: obj.blueprintStoreDir || null,
            blueprintLoaded:   obj.blueprintLoaded   || false,
            stagedFiles:     (obj.stagedFiles || []).map(f => StagedFile.fromJSON(f)),
            createdAt:       obj.createdAt ? new Date(obj.createdAt) : new Date(),
            updatedAt:       obj.updatedAt ? new Date(obj.updatedAt) : new Date()
        });
    }

}

module.exports = Session;

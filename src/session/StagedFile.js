'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/**
 * StagedFile
 * src/session/StagedFile.js
 *
 * Represents one asset staged inside a session's working directory.
 * No FingerprintRecord or Blueprint entry is created until the session
 * is committed — the session is fully isolated from permanent libraries.
 *
 * category drives all build behaviour:
 *   in-store  — asset already in AssetStore, sourced via sourceFingerprint
 *   new       — asset brought in by the user, lives in workingDir
 *   deleted   — asset explicitly excluded from the build
 *
 * checksum is SHA-256 of staged content for session integrity only.
 * It is NOT the permanent FingerprintRecord hash — that is computed
 * from the real asset content during CommitPipeline Phase 3.
 */

class StagedFile {

    /**
     * @param {object} opts
     * @param {string}      opts.targetName        - Intended decoded filename in the final pack
     * @param {string}      opts.sourcePath        - Original file path before staging
     * @param {string}      opts.stagedPath        - Current path inside working directory
     * @param {string}      opts.category          - 'in-store' | 'new' | 'deleted'
     * @param {string|null} opts.sourceFingerprint - FingerprintRecord hash for in-store assets
     * @param {number}      opts.sizeBytes         - File size in bytes
     * @param {string}      opts.checksum          - SHA-256 of staged content
     * @param {Date}        opts.stagedAt          - When added to the session
     */
    constructor({
        targetName,
        sourcePath        = null,
        stagedPath        = null,
        category          = 'new',
        sourceFingerprint = null,
        sizeBytes         = 0,
        checksum          = null,
        stagedAt          = null,
        packId            = null
    } = {}) {
        this.targetName        = targetName;
        this.sourcePath        = sourcePath;
        this.stagedPath        = stagedPath;
        this.category          = category;
        this.sourceFingerprint = sourceFingerprint;
        this.sizeBytes         = sizeBytes;
        this.checksum          = checksum;
        this.stagedAt          = stagedAt instanceof Date ? stagedAt : new Date();
        this.packId            = packId; // original packId from blueprint — null for new assets
    }

    // ---------------------------------------------------------------------------
    // Category convenience
    // ---------------------------------------------------------------------------

    /** @returns {boolean} */
    isInStore() { return this.category === 'in-store'; }

    /** @returns {boolean} */
    isNew()     { return this.category === 'new';      }

    /** @returns {boolean} */
    isDeleted() { return this.category === 'deleted';  }

    /**
     * Transition this file to deleted status.
     * Excludes it from the build without removing the audit trail.
     */
    markDeleted() {
        this.category = 'deleted';
    }

    // ---------------------------------------------------------------------------
    // Integrity
    // ---------------------------------------------------------------------------

    /**
     * Confirm the staged file on disk still matches its recorded checksum.
     * Used to detect tampering or accidental modification during a session.
     *
     * @returns {Promise<boolean>}
     */
    async verify() {
        if (!this.stagedPath || !fs.existsSync(this.stagedPath)) return false;
        if (!this.checksum) return false;

        const actual = await StagedFile.#hashFile(this.stagedPath);
        return actual === this.checksum;
    }

    // ---------------------------------------------------------------------------
    // Lazy resolution
    // ---------------------------------------------------------------------------

    /**
     * Lazily resolve the staged path for in-store assets.
     * For 'in-store' assets the stagedPath may be null at session load time —
     * the actual file path is fetched from AssetStore via sourceFingerprint
     * only when the build process needs it.
     *
     * For 'new' assets stagedPath is already set — returns it directly.
     *
     * @param {AssetStore} assetStore
     * @returns {Promise<string>} Resolved path to the asset on disk
     */
    async resolve(assetStore) {
        if (this.isInStore()) {
            if (!this.sourceFingerprint) {
                throw new Error(`in-store StagedFile "${this.targetName}" has no sourceFingerprint`);
            }
            const filePath = assetStore.getPath(this.sourceFingerprint);
            if (!filePath) {
                throw new Error(
                    `Asset not found in store for "${this.targetName}" ` +
                    `(fingerprint: ${this.sourceFingerprint.slice(0, 12)}...)`
                );
            }
            this.stagedPath = filePath;
            return filePath;
        }

        if (!this.stagedPath) {
            throw new Error(`StagedFile "${this.targetName}" has no stagedPath`);
        }
        return this.stagedPath;
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            targetName:        this.targetName,
            sourcePath:        this.sourcePath,
            stagedPath:        this.stagedPath,
            category:          this.category,
            sourceFingerprint: this.sourceFingerprint,
            sizeBytes:         this.sizeBytes,
            checksum:          this.checksum,
            stagedAt:          this.stagedAt.toISOString(),
            packId:            this.packId
        };
    }

    /**
     * @param {object} obj
     * @returns {StagedFile}
     */
    static fromJSON(obj) {
        return new StagedFile({
            targetName:        obj.targetName,
            sourcePath:        obj.sourcePath        || null,
            stagedPath:        obj.stagedPath        || null,
            category:          obj.category          || 'new',
            sourceFingerprint: obj.sourceFingerprint || null,
            sizeBytes:         obj.sizeBytes         || 0,
            checksum:          obj.checksum          || null,
            stagedAt:          obj.stagedAt ? new Date(obj.stagedAt) : new Date(),
            packId:            obj.packId            || null
        });
    }

    // ---------------------------------------------------------------------------
    // Static helpers
    // ---------------------------------------------------------------------------

    /**
     * Compute SHA-256 of a file on disk.
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    static #hashFile(filePath) {
        return new Promise((resolve, reject) => {
            const hash   = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data',  chunk => hash.update(chunk));
            stream.on('end',   ()    => resolve(hash.digest('hex')));
            stream.on('error', err   => reject(err));
        });
    }

    /**
     * Compute SHA-256 of a file and return both the hash and file size.
     * Used during staging to set checksum and sizeBytes in one pass.
     *
     * @param {string} filePath
     * @returns {Promise<{ checksum: string, sizeBytes: number }>}
     */
    static async checksumFile(filePath) {
        const stat = fs.statSync(filePath);
        const hash = await StagedFile.#hashFile(filePath);
        return { checksum: hash, sizeBytes: stat.size };
    }

}

module.exports = StagedFile;

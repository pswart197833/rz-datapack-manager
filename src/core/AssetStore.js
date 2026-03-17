'use strict';

const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const VerificationResult = require('../fingerprint/VerificationResult');

/**
 * AssetStore
 * src/core/AssetStore.js
 *
 * Owns the content-addressed archive directory.
 * Files are stored as {hash}.{ext} inside bucketed subdirectories
 * named by the first two characters of the hash:
 *
 *   store/a3/a3f8c2d1...{64 chars}.dds
 *
 * Write-once — nothing modifies a file after it has been stored.
 * Identical files (same hash) are naturally deduplicated.
 *
 * The in-memory #fileIndex is the hot path for all existence checks.
 * It is populated at construction via rebuild() and updated on every write.
 */

class AssetStore {

    /**
     * @param {string} rootDir - Root directory for the asset store
     */
    constructor(rootDir) {
        this.rootDir    = rootDir;
        this.#fileIndex = new Map(); // hash -> full file path
    }

    // Private field declaration
    #fileIndex;

    // ---------------------------------------------------------------------------
    // Initialise
    // ---------------------------------------------------------------------------

    /**
     * Scan the root directory recursively and rebuild the in-memory index.
     * Call this once at startup if the store directory already has content.
     *
     * @returns {Promise<void>}
     */
    async rebuild() {
        this.#fileIndex.clear();

        if (!fs.existsSync(this.rootDir)) return;

        const buckets = fs.readdirSync(this.rootDir);

        for (const bucket of buckets) {
            const bucketPath = path.join(this.rootDir, bucket);
            const stat       = fs.statSync(bucketPath);
            if (!stat.isDirectory()) continue;

            const files = fs.readdirSync(bucketPath);
            for (const file of files) {
                // Filename format: {hash}.{ext}
                // Hash is everything before the first dot
                const dotIndex = file.indexOf('.');
                if (dotIndex === -1) continue;
                const hash = file.slice(0, dotIndex);
                if (hash.length > 0) {
                    this.#fileIndex.set(hash, path.join(bucketPath, file));
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Write
    // ---------------------------------------------------------------------------

    /**
     * Write a buffer to the store as {rootDir}/{hash[0..1]}/{hash}.{ext}.
     * If the hash already exists, skips the write and returns the existing path.
     *
     * @param {Buffer} buffer - Asset content to store
     * @param {string} hash   - SHA-256 hex string of the buffer
     * @param {string} ext    - File extension without dot e.g. 'dds', 'tga'
     * @returns {Promise<string>} Resolved path where the file was written
     */
    async write(buffer, hash, ext) {
        // Deduplication — if already stored return existing path immediately
        if (this.#fileIndex.has(hash)) {
            return this.#fileIndex.get(hash);
        }

        const bucketDir  = path.join(this.rootDir, hash.slice(0, 2));
        const fileName   = `${hash}.${ext}`;
        const filePath   = path.join(bucketDir, fileName);

        // Ensure bucket directory exists
        if (!fs.existsSync(bucketDir)) {
            fs.mkdirSync(bucketDir, { recursive: true });
        }

        await fs.promises.writeFile(filePath, buffer);

        // Update in-memory index
        this.#fileIndex.set(hash, filePath);

        return filePath;
    }

    // ---------------------------------------------------------------------------
    // Query
    // ---------------------------------------------------------------------------

    /**
     * Primary deduplication check — returns true if the hash is already stored.
     * @param {string} hash
     * @returns {boolean}
     */
    exists(hash) {
        return this.#fileIndex.has(hash);
    }

    /**
     * Resolve the full bucketed path for a given hash.
     * @param {string} hash
     * @returns {string|null}
     */
    getPath(hash) {
        return this.#fileIndex.get(hash) || null;
    }

    // ---------------------------------------------------------------------------
    // Delete
    // ---------------------------------------------------------------------------

    /**
     * Remove an asset from disk and from the in-memory index.
     * Used only for pruning orphaned records — not part of normal operation.
     *
     * @param {string} hash
     * @returns {Promise<boolean>} true if the file was found and deleted
     */
    async delete(hash) {
        const filePath = this.#fileIndex.get(hash);
        if (!filePath) return false;

        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
        }

        this.#fileIndex.delete(hash);
        return true;
    }

    // ---------------------------------------------------------------------------
    // Verify
    // ---------------------------------------------------------------------------

    /**
     * Re-hash the file at record.extractedPath and compare against record.hash.
     *
     * @param {FingerprintRecord} record
     * @returns {Promise<VerificationResult>}
     */
    async verify(record) {
        if (!record.extractedPath || !fs.existsSync(record.extractedPath)) {
            return new VerificationResult({
                record,
                status:       'missing',
                expectedHash: record.hash,
                actualHash:   null
            });
        }

        const actualHash = await this.#hashFile(record.extractedPath);

        return new VerificationResult({
            record,
            status:       actualHash === record.hash ? 'matched' : 'changed',
            expectedHash: record.hash,
            actualHash
        });
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Stream-hash a file using SHA-256.
     * @param {string} filePath
     * @returns {Promise<string>} SHA-256 hex digest
     */
    #hashFile(filePath) {
        return new Promise((resolve, reject) => {
            const hash   = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data',  chunk => hash.update(chunk));
            stream.on('end',   ()    => resolve(hash.digest('hex')));
            stream.on('error', err   => reject(err));
        });
    }

    /**
     * SHA-256 hash a buffer directly.
     * @param {Buffer} buffer
     * @returns {string} SHA-256 hex digest
     */
    static hashBuffer(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

}

module.exports = AssetStore;

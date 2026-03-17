'use strict';

/**
 * FingerprintRecord
 * src/fingerprint/FingerprintRecord.js
 *
 * Tracks static facts about a single file. Three types:
 *   asset  — individual game asset extracted from a pack file
 *   pack   — a data.001–.008 pack file
 *   index  — the data.000 index file
 *
 * Primary key: decodedName + hash together (managed by FingerprintStore).
 * This allows multiple versions of the same file and content aliases
 * to coexist cleanly.
 *
 * Alias semantics:
 *   isAlias = true   → same bytes as another file (different name, same hash)
 *   aliasOf = hash   → content hash of the canonical (first-seen) record
 */

class FingerprintRecord {

    /**
     * @param {object}      opts
     * @param {string}      opts.hash          - SHA-256 hex string
     * @param {string}      opts.type          - 'asset' | 'pack' | 'index'
     * @param {string}      opts.decodedName   - Human-readable filename
     * @param {number}      opts.size          - File size in bytes
     * @param {string|null} opts.extractedPath - Absolute path on disk (null for stubs/pack/index)
     * @param {boolean}     opts.verified      - Whether file header has been validated
     * @param {Date|string|null} opts.date     - When this fingerprint was recorded
     * @param {boolean}     opts.isAlias       - True if same bytes as another registered file
     * @param {string|null} opts.aliasOf       - Hash of the canonical record (if isAlias)
     */
    constructor({
        hash,
        type,
        decodedName,
        size          = 0,
        extractedPath = null,
        verified      = false,
        date          = null,
        isAlias       = false,
        aliasOf       = null
    } = {}) {
        this.hash          = hash          || null;
        this.type          = type          || null;
        this.decodedName   = decodedName   || '';
        this.size          = size          || 0;
        this.extractedPath = extractedPath || null;
        this.verified      = verified      || false;
        this.date          = date instanceof Date ? date : (date ? new Date(date) : new Date());
        this.isAlias       = isAlias       === true;
        this.aliasOf       = aliasOf       || null;
    }

    // ---------------------------------------------------------------------------
    // Type convenience
    // ---------------------------------------------------------------------------

    isAsset() { return this.type === 'asset'; }
    isPack()  { return this.type === 'pack';  }
    isIndex() { return this.type === 'index'; }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            hash:          this.hash,
            type:          this.type,
            decodedName:   this.decodedName,
            size:          this.size,
            extractedPath: this.extractedPath,
            verified:      this.verified,
            date:          this.date.toISOString(),
            isAlias:       this.isAlias,
            aliasOf:       this.aliasOf
        };
    }

    /**
     * @param {object} obj
     * @returns {FingerprintRecord}
     */
    static fromJSON(obj) {
        return new FingerprintRecord({
            hash:          obj.hash,
            type:          obj.type,
            decodedName:   obj.decodedName,
            size:          obj.size          || 0,
            extractedPath: obj.extractedPath || null,
            verified:      obj.verified      === true,
            date:          obj.date          || null,
            isAlias:       obj.isAlias       === true,
            aliasOf:       obj.aliasOf       || null
        });
    }

}

module.exports = FingerprintRecord;

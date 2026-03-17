'use strict';

/**
 * AssetItem
 * src/core/AssetItem.js
 *
 * Represents one file record parsed from data.000.
 * Pure data container — properties are set at construction and not mutated.
 *
 * The two methods (toIndexBytes, matchesFingerprint) are convenience
 * delegates only. Real logic lives in DataPackIndex and FingerprintStore.
 *
 * Offsets are stored as number (UInt32LE) — pack files do not exceed 1GB
 * so 32-bit unsigned integers are sufficient.
 */

class AssetItem {

    /**
     * @param {object} opts
     * @param {Buffer} opts.encodedName   - Raw encoded filename bytes from data.000
     * @param {string} opts.decodedName   - Human-readable filename after decoding
     * @param {string} opts.assetType     - File type inferred from extension at runtime
     * @param {number} opts.packId        - Which data.001--.008 holds this asset (1-8)
     * @param {number} opts.offset        - Byte offset of the asset within its pack file
     * @param {number} opts.size          - Size of the asset in bytes
     * @param {number} opts.indexOffset   - Byte offset of this entry within data.000
     * @param {string} [opts.fingerprint] - SHA-256 hash of asset content (set after extraction)
     */
    constructor({ encodedName, decodedName, assetType, packId, offset, size, indexOffset, fingerprint = null } = {}) {
        this.encodedName  = encodedName  || null;
        this.decodedName  = decodedName  || '';
        this.assetType    = assetType    || null;
        this.packId       = packId       || 0;
        this.offset       = offset       || 0;
        this.size         = size         || 0;
        this.indexOffset  = indexOffset  || 0;
        this.fingerprint  = fingerprint;
    }

    // ---------------------------------------------------------------------------
    // Convenience delegates
    // ---------------------------------------------------------------------------

    /**
     * Delegate to DataPackIndex — serialize this entry's binary record.
     * Requires DataPackIndex to be passed in to avoid a circular dependency.
     *
     * @param {DataPackIndex} index
     * @returns {Buffer}
     */
    toIndexBytes(index) {
        return index.serializeEntry(this);
    }

    /**
     * Delegate to FingerprintStore — compare a hash against this entry's
     * stored fingerprint.
     *
     * @param {string} hash - SHA-256 hex string to compare
     * @returns {boolean}
     */
    matchesFingerprint(hash) {
        if (!this.fingerprint) return false;
        return this.fingerprint === hash;
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Infer the asset type from the file extension of the decoded name.
     * Called at parse time — result stored on the instance.
     *
     * @returns {string} lowercase extension without the dot, e.g. 'dds', 'tga', 'xml'
     */
    inferAssetType() {
        if (!this.decodedName) return 'unknown';
        const parts = this.decodedName.split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : 'unknown';
    }

    /**
     * Returns a plain object summary — useful for logging and the API layer.
     * @returns {object}
     */
    toJSON() {
        return {
            decodedName:  this.decodedName,
            assetType:    this.assetType,
            packId:       this.packId,
            offset:       this.offset,
            size:         this.size,
            indexOffset:  this.indexOffset,
            fingerprint:  this.fingerprint
        };
    }

}

module.exports = AssetItem;

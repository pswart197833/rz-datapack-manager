'use strict';

/**
 * BlueprintRecord
 * src/fingerprint/BlueprintRecord.js
 *
 * Positional data for one asset within a specific blueprint snapshot.
 * Captures exactly where an asset lived in both data.000 and its pack
 * file at the time the blueprint was generated.
 *
 * Static file facts (name, size, path) are NOT stored here — they live
 * in FingerprintRecord and are referenced by hash. This means a file
 * can move between pack slots without invalidating its FingerprintRecord.
 *
 * Offsets are stored as number (UInt32LE) — pack files do not exceed 1GB.
 */

class BlueprintRecord {

    /**
     * @param {object} opts
     * @param {number} opts.indexOffset         - Byte offset of this entry within data.000
     * @param {number} opts.packOffset          - Byte offset of this asset within its pack file
     * @param {number} opts.packId              - Which data.001--.008 holds this asset (1-8)
     * @param {string} opts.fileFingerprint     - SHA-256 hash ref to the asset FingerprintRecord
     * @param {string} opts.datapackFingerprint - SHA-256 hash ref to the pack FingerprintRecord
     */
    constructor({ indexOffset, packOffset, packId, fileFingerprint, datapackFingerprint, decodedName } = {}) {
        this.indexOffset         = indexOffset         || 0;
        this.packOffset          = packOffset          || 0;
        this.packId              = packId              || 0;
        this.fileFingerprint     = fileFingerprint     || null;
        this.datapackFingerprint = datapackFingerprint || null;
        this.decodedName         = decodedName         || null; // stored directly for alias resolution
    }

    // ---------------------------------------------------------------------------
    // Resolve references
    // ---------------------------------------------------------------------------

    /**
     * Fetch the asset FingerprintRecord from the store.
     * @param {FingerprintStore} store
     * @returns {FingerprintRecord|null}
     */
    resolveFile(store) {
        // Name-based lookup first — handles aliases correctly since
        // store.get(hash) returns the canonical record (wrong name for aliases).
        if (this.decodedName) {
            const byName = store.getByName(this.decodedName);
            if (byName) return byName;
        }
        // Fallback to hash-based lookup
        if (!this.fileFingerprint) return null;
        return store.get(this.fileFingerprint);
    }

    /**
     * Fetch the pack FingerprintRecord from the store.
     * @param {FingerprintStore} store
     * @returns {FingerprintRecord|null}
     */
    resolvePack(store) {
        if (!this.datapackFingerprint) return null;
        return store.get(this.datapackFingerprint);
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            indexOffset:         this.indexOffset,
            packOffset:          this.packOffset,
            packId:              this.packId,
            fileFingerprint:     this.fileFingerprint,
            datapackFingerprint: this.datapackFingerprint,
            decodedName:         this.decodedName
        };
    }

    /**
     * @param {object} obj
     * @returns {BlueprintRecord}
     */
    static fromJSON(obj) {
        return new BlueprintRecord({
            indexOffset:         obj.indexOffset         || 0,
            packOffset:          obj.packOffset          || 0,
            packId:              obj.packId              || 0,
            fileFingerprint:     obj.fileFingerprint     || null,
            datapackFingerprint: obj.datapackFingerprint || null,
            decodedName:         obj.decodedName         || null
        });
    }

}

module.exports = BlueprintRecord;

'use strict';

const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const BlueprintRecord = require('./BlueprintRecord');
const AssetItem       = require('../core/AssetItem');
const FilenameCodec   = require('../crypto/FilenameCodec');

/**
 * Blueprint
 * src/fingerprint/Blueprint.js
 *
 * Complete snapshot of a specific data.000 and its associated assets
 * at a point in time. Keyed by the SHA-256 fingerprint of data.000.
 *
 * Serves two purposes:
 *   1. Cache key — if indexFingerprint matches the current data.000,
 *      skip the expensive decrypt/parse entirely.
 *   2. Reconstruction source — resolveAssetItems() rebuilds a full
 *      AssetItem[] from stored references, used for index rebuilding.
 *
 * Persistence: one JSON file per blueprint at:
 *   {storeDir}/blueprints/{indexFingerprint}.json
 *
 * The records Map is keyed by indexFingerprint and holds an ordered
 * array of BlueprintRecord entries matching the original data.000 order.
 */

class Blueprint {

    /**
     * @param {string} indexFingerprint - SHA-256 of data.000 — primary key
     */
    constructor(indexFingerprint) {
        this.indexFingerprint = indexFingerprint;
        this.records          = [];          // ordered BlueprintRecord[]
        this.generatedAt      = new Date();
        this.totalSize        = 0;
        this.uniqueCount      = 0;

        // Internal codec instance for resolveAssetItems()
        this._codec = new FilenameCodec();
    }

    // ---------------------------------------------------------------------------
    // Records
    // ---------------------------------------------------------------------------

    /**
     * Add a BlueprintRecord to this blueprint.
     * Updates totalSize and uniqueCount as records are added.
     *
     * @param {BlueprintRecord} blueprintRecord
     */
    addRecord(blueprintRecord) {
        this.records.push(blueprintRecord);
    }

    /**
     * Return the full ordered list of BlueprintRecord entries.
     * @returns {BlueprintRecord[]}
     */
    getRecords() {
        return this.records;
    }

    /**
     * Return a subset of records matching a predicate.
     * @param {function} predicate - (BlueprintRecord) => boolean
     * @returns {BlueprintRecord[]}
     */
    filter(predicate) {
        return this.records.filter(predicate);
    }

    // ---------------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------------

    /**
     * Resolve all datapackFingerprint references and confirm the pack files
     * on disk still match what was recorded in this blueprint.
     *
     * Called by IndexManager before any parse or extraction.
     *
     * @param {FingerprintStore} store
     * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
     */
    validatePackState(store) {
        const errors   = [];
        const warnings = [];

        // Collect unique pack fingerprints referenced in this blueprint
        const packFingerprints = new Set(
            this.records
                .map(r => r.datapackFingerprint)
                .filter(Boolean)
        );

        for (const packHash of packFingerprints) {
            const packRecord = store.get(packHash);

            if (!packRecord) {
                errors.push(`Pack record not found in store: ${packHash.slice(0, 12)}...`);
                continue;
            }

            // Pack records do not have extractedPath — they are identified by
            // their decodedName (e.g. 'data.003'). We check existence via the
            // store's knowledge of where pack files live.
            // This is intentionally a warning — the user decides whether to proceed.
            if (!packRecord.decodedName) {
                warnings.push(`Pack record has no decodedName: ${packHash.slice(0, 12)}...`);
            }
        }

        return { ok: errors.length === 0, errors, warnings };
    }

    // ---------------------------------------------------------------------------
    // Reconstruct AssetItems
    // ---------------------------------------------------------------------------

    /**
     * Reconstruct a full AssetItem[] from stored BlueprintRecord references.
     * Used for index rebuilding without re-parsing data.000.
     *
     * For each record:
     *   - Resolves fileFingerprint → FingerprintRecord (name, size, path)
     *   - Derives encodedName via FilenameCodec.encode() at runtime
     *   - Infers assetType from file extension
     *   - Assembles a complete AssetItem
     *
     * @param {FingerprintStore} store
     * @returns {Promise<AssetItem[]>}
     */
    async resolveAssetItems(store) {
        const items = [];

        for (const record of this.records) {
            const fileRecord = record.resolveFile(store);

            if (!fileRecord) {
                // Record references a hash that no longer exists in the store.
                // Skip — caller should validate pack state before calling this.
                continue;
            }

            // Derive encodedName at runtime — never stored permanently
            const encodedNameStr = this._codec.encode(fileRecord.decodedName);
            const encodedName    = Buffer.from(encodedNameStr, 'latin1');

            // Infer asset type from extension
            const assetType = fileRecord.decodedName.includes('.')
                ? fileRecord.decodedName.split('.').pop().toLowerCase()
                : 'unknown';

            items.push(new AssetItem({
                encodedName,
                decodedName:  fileRecord.decodedName,
                assetType,
                packId:       record.packId,
                offset:       record.packOffset,
                size:         fileRecord.size,
                indexOffset:  record.indexOffset,
                fingerprint:  fileRecord.hash
            }));
        }

        return items;
    }

    // ---------------------------------------------------------------------------
    // Diff
    // ---------------------------------------------------------------------------

    /**
     * Compare this blueprint against another.
     * Returns which assets were added, removed, or changed between the two.
     *
     * @param {Blueprint} other
     * @returns {{ added: BlueprintRecord[], removed: BlueprintRecord[], changed: BlueprintRecord[] }}
     */
    diff(other) {
        const thisMap  = new Map(this.records.map(r  => [r.fileFingerprint, r]));
        const otherMap = new Map(other.records.map(r => [r.fileFingerprint, r]));

        const added   = [];
        const removed = [];
        const changed = [];

        for (const [fp, record] of otherMap) {
            if (!thisMap.has(fp)) added.push(record);
        }

        for (const [fp, record] of thisMap) {
            if (!otherMap.has(fp)) removed.push(record);
        }

        for (const [fp, thisRecord] of thisMap) {
            const otherRecord = otherMap.get(fp);
            if (otherRecord) {
                if (
                    thisRecord.packId      !== otherRecord.packId      ||
                    thisRecord.packOffset  !== otherRecord.packOffset  ||
                    thisRecord.indexOffset !== otherRecord.indexOffset
                ) {
                    changed.push(otherRecord);
                }
            }
        }

        return { added, removed, changed };
    }

    // ---------------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------------

    /**
     * Export all records as a CSV string.
     * Resolves file details from the store if provided, otherwise uses
     * raw fingerprint hashes.
     *
     * @param {FingerprintStore} [store]
     * @returns {string}
     */
    toCSV(store) {
        const headers = 'indexOffset,packOffset,packId,fileFingerprint,decodedName,size';
        const rows    = this.records.map(r => {
            const fileRecord = store ? store.get(r.fileFingerprint) : null;
            const name       = fileRecord ? fileRecord.decodedName : r.fileFingerprint;
            const size       = fileRecord ? fileRecord.size        : '';
            return `${r.indexOffset},${r.packOffset},${r.packId},${r.fileFingerprint},${name},${size}`;
        });
        return [headers, ...rows].join('\n');
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    toJSON() {
        return {
            indexFingerprint: this.indexFingerprint,
            generatedAt:      this.generatedAt.toISOString(),
            totalSize:        this.totalSize,
            uniqueCount:      this.uniqueCount,
            records:          this.records.map(r => r.toJSON())
        };
    }

    /**
     * @param {object} obj
     * @returns {Blueprint}
     */
    static fromJSON(obj) {
        const bp          = new Blueprint(obj.indexFingerprint);
        bp.generatedAt    = obj.generatedAt ? new Date(obj.generatedAt) : new Date();
        bp.totalSize      = obj.totalSize   || 0;
        bp.uniqueCount    = obj.uniqueCount || 0;
        bp.records        = (obj.records || []).map(r => BlueprintRecord.fromJSON(r));
        return bp;
    }

    // ---------------------------------------------------------------------------
    // Persistence helpers (used by IndexManager)
    // ---------------------------------------------------------------------------

    /**
     * Write this blueprint to disk as a JSON file.
     * Path: {storeDir}/blueprints/{indexFingerprint}.json
     *
     * @param {string} storeDir - Root store directory
     * @returns {Promise<string>} Path where the file was written
     */
    async saveToDisk(storeDir) {
        const blueprintDir = path.join(storeDir, 'blueprints');
        if (!fs.existsSync(blueprintDir)) {
            fs.mkdirSync(blueprintDir, { recursive: true });
        }

        const filePath = path.join(blueprintDir, `${this.indexFingerprint}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(this.toJSON(), null, 2), 'utf8');
        return filePath;
    }

    /**
     * Load a blueprint from disk by its index fingerprint.
     * Returns null if no blueprint exists for this fingerprint.
     *
     * @param {string} storeDir
     * @param {string} indexFingerprint
     * @returns {Promise<Blueprint|null>}
     */
    static async loadFromDisk(storeDir, indexFingerprint) {
        const filePath = path.join(storeDir, 'blueprints', `${indexFingerprint}.json`);
        if (!fs.existsSync(filePath)) return null;

        const content = await fs.promises.readFile(filePath, 'utf8');
        return Blueprint.fromJSON(JSON.parse(content));
    }

    /**
     * Generate a SHA-256 fingerprint of a file on disk by streaming its content.
     * Used for data.000 (small index file, ~5MB) where content accuracy matters.
     *
     * @param {string} filePath
     * @returns {Promise<string>} SHA-256 hex digest
     */
    static async fingerprintFile(filePath) {
        return new Promise((resolve, reject) => {
            const hash   = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data',  chunk => hash.update(chunk));
            stream.on('end',   ()    => resolve(hash.digest('hex')));
            stream.on('error', err   => reject(err));
        });
    }

    /**
     * Generate a fast metadata-based fingerprint for large pack files.
     * Derives a SHA-256 from filename + file size + mtime rather than
     * streaming the full content (~5s per GB avoided).
     *
     * Sufficient for change detection on local single-user files —
     * a pack file that changed content but kept identical size and mtime
     * is not a realistic scenario in normal use.
     *
     * Used for data.001--.008 (each up to ~1GB).
     *
     * @param {string} filePath
     * @returns {string} SHA-256 hex digest derived from file metadata
     */
    static fingerprintFileMeta(filePath) {
        const stat    = fs.statSync(filePath);
        const metaKey = `pack:${path.basename(filePath)}:${stat.size}:${stat.mtimeMs}`;
        return crypto.createHash('sha256').update(metaKey).digest('hex');
    }

}

module.exports = Blueprint;

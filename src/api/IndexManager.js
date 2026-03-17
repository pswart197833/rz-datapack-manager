'use strict';

const fs               = require('fs');
const path             = require('path');
const DataPackIndex    = require('../core/DataPackIndex');
const DataPackReader   = require('../core/DataPackReader');
const Blueprint        = require('../fingerprint/Blueprint');
const BlueprintRecord  = require('../fingerprint/BlueprintRecord');
const AssetItem        = require('../core/AssetItem');
const AssetStore       = require('../core/AssetStore');

/**
 * IndexManager
 * src/api/IndexManager.js
 *
 * Orchestrates loading, extraction, and querying of existing pack files.
 * Read-only — never writes new pack files or modifies permanent libraries.
 * That is exclusively SessionManager and CommitPipeline's concern.
 *
 * Load path:
 *   1. Fingerprint data.000 (SHA-256)
 *   2. Check for an existing Blueprint with that fingerprint
 *   3a. Blueprint found → skip parse, reconstruct AssetItem[] from blueprint
 *   3b. Blueprint not found → decrypt and parse data.000 the full way
 *
 * Zero-size entries:
 *   Index entries with size === 0 are placeholder/deleted records that exist
 *   in data.000 but have no bytes in any pack file. During blueprint generation
 *   these are registered against the null-asset sentinel (AssetStore.NULL_ASSET_HASH)
 *   so they flow through the pipeline as normal entries. DataPackWriter skips
 *   writing them (empty buffer) but they still appear in the reconstructed index
 *   with their original packId and offset preserved.
 *
 * All path concerns delegated to PackConfiguration.
 * FingerprintStore and AssetStore injected at construction.
 */

class IndexManager {

    /**
     * @param {PackConfiguration} config
     * @param {FingerprintStore}  fingerprintStore
     * @param {AssetStore}        assetStore
     */
    constructor(config, fingerprintStore, assetStore) {
        this.config           = config;
        this.fingerprintStore = fingerprintStore;
        this.assetStore       = assetStore;
        this.#index           = null;
    }

    #index;

    // ---------------------------------------------------------------------------
    // Load
    // ---------------------------------------------------------------------------

    /**
     * Load the index. Uses the blueprint cache if available, otherwise
     * fingerprints and parses data.000 from scratch.
     *
     * On first run:
     *   - Parses data.000 (~710ms for 124k entries)
     *   - Registers pack file fingerprints in FingerprintStore
     *   - Saves a Blueprint to disk for future fast loads
     *
     * On subsequent runs:
     *   - Fingerprints data.000 (fast streaming SHA-256)
     *   - Finds matching Blueprint on disk
     *   - Reconstructs AssetItem[] from Blueprint (no decrypt/parse)
     *
     * @returns {Promise<DataPackIndex>}
     */
    async loadIndex() {
        const indexPath = this.config.getIndexPath();

        if (!fs.existsSync(indexPath)) {
            throw new Error(`Index file not found: ${indexPath}`);
        }

        // Step 1 — fingerprint data.000
        console.log('  Fingerprinting data.000...');
        const indexFingerprint = await Blueprint.fingerprintFile(indexPath);

        // Step 2 — check for an existing blueprint
        const storeDir          = this.assetStore.rootDir;
        const existingBlueprint = await Blueprint.loadFromDisk(storeDir, indexFingerprint);

        this.#index = new DataPackIndex();

        if (existingBlueprint) {
            // Fast path — reconstruct from blueprint
            console.log('  Blueprint found — reconstructing from cache...');
            const items = await existingBlueprint.resolveAssetItems(this.fingerprintStore);

            if (items.length > 0) {
                this.#index.entries = items;
                console.log(`  ${items.length.toLocaleString()} entries loaded from blueprint`);
                return this.#index;
            }

            // Blueprint exists but store is empty (e.g. fresh install with copied blueprint)
            // Fall through to full parse
            console.log('  Blueprint references unresolvable records — falling back to full parse');
        }

        // Slow path — full parse
        console.log('  Parsing data.000...');
        const indexBuffer = fs.readFileSync(indexPath);
        this.#index.parse(indexBuffer);
        console.log(`  ${this.#index.entries.length.toLocaleString()} entries parsed`);

        // Ensure null-asset sentinel exists before blueprint generation
        // so zero-size entries get a real FingerprintRecord pointing to it.
        await this.fingerprintStore.ensureNullAsset();

        // Register the index file itself in FingerprintStore
        await this.fingerprintStore.register(indexBuffer, 'index', 'data.000', null);

        // Register pack file fingerprints (streaming — no full load into memory)
        const packRecords = {};
        for (let slot = 1; slot <= 8; slot++) {
            const packPath = this.config.getPackPath(slot);
            if (packPath && fs.existsSync(packPath)) {
                // Use metadata-based fingerprint for pack files.
                // Full SHA-256 of ~1GB pack files takes ~5s each (43s total for 8 packs).
                // size + mtime is sufficient for change detection on local single-user files.
                const packFp = Blueprint.fingerprintFileMeta(packPath);
                const stub   = Buffer.from(`pack:${packFp}`);
                await this.fingerprintStore.register(stub, 'pack', `data.00${slot}`, null);
                packRecords[slot] = {
                    hash:        packFp,
                    decodedName: `data.00${slot}`,
                    type:        'pack'
                };
            }
        }

        // Build and save blueprint.
        // Open a write stream so 124k registrations use one stream
        // instead of 124k individual appendFile() calls (~98s vs ~2s).
        console.log('  Building blueprint...');
        await this.fingerprintStore.openWriteStream();
        const blueprint = new Blueprint(indexFingerprint);

        const nullHash    = AssetStore.NULL_ASSET_HASH;
        const nullPath    = this.assetStore.getPath(nullHash);

        for (const entry of this.#index.entries) {
            const packRecord = packRecords[entry.packId];
            let assetRecord;

            if (entry.size === 0) {
                // Zero-size placeholder — point to the null-asset sentinel.
                // Register as an alias of the sentinel using the entry's own decodedName
                // so it gets its own FingerprintRecord that resolveFile() can find by name.
                const nullBuffer = Buffer.alloc(0);
                assetRecord = await this.fingerprintStore.register(
                    nullBuffer, 'asset', entry.decodedName, nullPath, 0
                );
            } else {
                // Normal entry — register a stub with a unique hash derived from
                // name+offset+size. Real content hash is filled in by extractAll().
                const stubBuffer = Buffer.from(`${entry.decodedName}|${entry.offset}|${entry.size}`);
                assetRecord = await this.fingerprintStore.register(
                    stubBuffer, 'asset', entry.decodedName, null, entry.size
                );
            }

            blueprint.addRecord(new BlueprintRecord({
                indexOffset:         entry.indexOffset,
                packOffset:          entry.offset,
                packId:              entry.packId,
                fileFingerprint:     assetRecord.hash,
                datapackFingerprint: packRecord ? packRecord.hash : null,
                decodedName:         entry.decodedName
            }));
        }

        await this.fingerprintStore.closeWriteStream();

        blueprint.totalSize   = this.#index.entries.reduce((s, e) => s + e.size, 0);
        blueprint.uniqueCount = this.#index.entries.length;

        await blueprint.saveToDisk(storeDir);
        console.log(`  Blueprint saved (${this.#index.entries.length.toLocaleString()} records)`);

        return this.#index;
    }

    // ---------------------------------------------------------------------------
    // Extract
    // ---------------------------------------------------------------------------

    /**
     * Extract all assets from the pack files.
     * Skips assets already present in the AssetStore (deduplication).
     * Zero-size entries are counted as skipped — they have no bytes to extract.
     *
     * @param {object}   opts
     * @param {string[]} [opts.types]      - Filter by asset type e.g. ['dds','tga']
     * @param {Function} [opts.onProgress] - (done, total, decodedName) => void
     * @returns {Promise<{ extracted: number, skipped: number, errors: string[] }>}
     */
    async extractAll(opts = {}) {
        if (!this.#index) await this.loadIndex();

        const { types, onProgress } = opts;

        let entries = this.#index.entries;
        if (types && types.length > 0) {
            entries = entries.filter(e => types.includes(e.assetType));
        }

        const reader = new DataPackReader(this.config.packPaths);
        let extracted = 0;
        let skipped   = 0;
        const errors  = [];
        const total   = entries.length;

        try {
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];

                if (onProgress) onProgress(i, total, entry.decodedName);

                // Zero-size entries have no bytes in any pack file.
                // They are already registered against the null-asset sentinel
                // during loadIndex() — nothing more to do here.
                if (entry.size === 0) { skipped++; continue; }

                try {
                    const buffer = await reader.extractAsset(entry);
                    const hash   = require('crypto').createHash('sha256').update(buffer).digest('hex');

                    if (this.assetStore.exists(hash)) {
                        // Duplicate content — bytes already stored under a different filename.
                        // Register this alias name in FingerprintStore pointing to the existing
                        // file. Always register (don't guard with getByName) so that stub records
                        // from loadIndex() are overwritten with real extractedPath values.
                        const existingPath = this.assetStore.getPath(hash);
                        await this.fingerprintStore.register(
                            buffer, 'asset', entry.decodedName, existingPath
                        );
                        skipped++;
                        continue;
                    }

                    // Write to asset store
                    const extractedPath = await this.assetStore.write(buffer, hash, entry.assetType);

                    // Register in fingerprint store with real content hash
                    await this.fingerprintStore.register(buffer, 'asset', entry.decodedName, extractedPath);

                    extracted++;
                } catch (err) {
                    errors.push(`${entry.decodedName}: ${err.message}`);
                }
            }
        } finally {
            await reader.closeAll();
        }

        if (onProgress) onProgress(total, total, 'done');

        // After extraction: prune stub records and rebuild blueprint with real hashes.
        // loadIndex() registers stub entries (hash of "name|offset|size").
        // extractAll() registers real entries (hash of actual content).
        // Pruning stubs removes the phantom records so store counts are accurate.
        if (extracted > 0) {
            try {
                await this.fingerprintStore.pruneStubs();
                await this.rebuildBlueprints();
            } catch (err) {
                console.warn('  Warning: post-extraction cleanup failed:', err.message);
            }
        }

        return { extracted, skipped, errors };
    }

    /**
     * Extract a single asset by decoded filename.
     * Does not write to AssetStore — returns raw buffer directly.
     *
     * @param {string} filename - Decoded filename e.g. 'hero.dds'
     * @returns {Promise<Buffer>}
     */
    async extractSingle(filename) {
        if (!this.#index) await this.loadIndex();

        const entry = this.#index.entries.find(e => e.decodedName === filename);
        if (!entry) throw new Error(`Asset not found in index: ${filename}`);
        if (entry.size === 0) throw new Error(`Asset has zero size: ${filename}`);

        const reader = new DataPackReader(this.config.packPaths);
        try {
            return await reader.extractAsset(entry);
        } finally {
            await reader.closeAll();
        }
    }

    // ---------------------------------------------------------------------------
    // Query
    // ---------------------------------------------------------------------------

    /**
     * Query loaded entries with optional filter, sort, and pagination.
     *
     * @param {object} query
     * @param {string}   [query.search]    - Substring search on decodedName
     * @param {string}   [query.type]      - Filter by assetType
     * @param {number}   [query.packId]    - Filter by pack slot
     * @param {string}   [query.sortBy]    - Field to sort by
     * @param {string}   [query.sortDir]   - 'asc' | 'desc'
     * @param {number}   [query.page]      - 1-based page number
     * @param {number}   [query.pageSize]  - Results per page (default 50)
     * @returns {{ entries: AssetItem[], total: number, page: number, totalPages: number }}
     */
    getEntries(query = {}) {
        if (!this.#index) throw new Error('Index not loaded — call loadIndex() first');

        let entries = this.#index.entries;

        // Filter
        if (query.search) {
            const q = query.search.toLowerCase();
            entries = entries.filter(e => e.decodedName.toLowerCase().includes(q));
        }
        if (query.type) {
            entries = entries.filter(e => e.assetType === query.type.toLowerCase());
        }
        if (query.packId) {
            entries = entries.filter(e => e.packId === Number(query.packId));
        }

        const total = entries.length;

        // Sort
        if (query.sortBy) {
            const dir = query.sortDir === 'desc' ? -1 : 1;
            entries = [...entries].sort((a, b) => {
                const av = a[query.sortBy];
                const bv = b[query.sortBy];
                if (typeof av === 'string') return dir * av.localeCompare(bv);
                return dir * (av - bv);
            });
        }

        // Paginate
        const pageSize   = Number(query.pageSize) || 50;
        const page       = Number(query.page)     || 1;
        const totalPages = Math.ceil(total / pageSize);
        const start      = (page - 1) * pageSize;
        entries          = entries.slice(start, start + pageSize);

        return { entries, total, page, totalPages };
    }

    /**
     * Filter, order, and compose a final AssetItem[] ready for
     * DataPackIndex.serialize(). Used during session preparation.
     *
     * @param {object} filters - Same filter options as getEntries()
     * @returns {AssetItem[]}
     */
    composeIndexList(filters = {}) {
        if (!this.#index) throw new Error('Index not loaded — call loadIndex() first');

        let entries = this.#index.entries;

        if (filters.type)   entries = entries.filter(e => e.assetType === filters.type);
        if (filters.packId) entries = entries.filter(e => e.packId === Number(filters.packId));
        if (filters.search) {
            const q = filters.search.toLowerCase();
            entries = entries.filter(e => e.decodedName.toLowerCase().includes(q));
        }

        return entries;
    }

    /**
     * Regenerate all blueprints from the current FingerprintStore state.
     * Used after a full re-extraction to rebuild the cache from scratch.
     *
     * @returns {Promise<Blueprint[]>}
     */
    async rebuildBlueprints() {
        if (!this.#index) await this.loadIndex();

        const indexPath        = this.config.getIndexPath();
        const indexFingerprint = await Blueprint.fingerprintFile(indexPath);
        const storeDir         = this.assetStore.rootDir;

        const blueprint = new Blueprint(indexFingerprint);

        for (const entry of this.#index.entries) {
            const fileRecord = this.fingerprintStore.getByName(entry.decodedName);
            if (!fileRecord) continue;

            blueprint.addRecord(new BlueprintRecord({
                indexOffset:         entry.indexOffset,
                packOffset:          entry.offset,
                packId:              entry.packId,
                fileFingerprint:     fileRecord.hash,
                datapackFingerprint: null,
                decodedName:         entry.decodedName
            }));
        }

        blueprint.totalSize   = this.#index.entries.reduce((s, e) => s + e.size, 0);
        blueprint.uniqueCount = this.#index.entries.length;

        await blueprint.saveToDisk(storeDir);
        return [blueprint];
    }

    // ---------------------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------------------

    /** @param {PackConfiguration} config */
    setConfig(config) {
        this.config = config;
        this.#index = null; // force reload on next loadIndex()
    }

    /** @returns {PackConfiguration} */
    getConfig() {
        return this.config;
    }

}

module.exports = IndexManager;

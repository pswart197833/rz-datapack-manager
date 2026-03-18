'use strict';

const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const DataPackWriter  = require('../core/DataPackWriter');
const DataPackIndex   = require('../core/DataPackIndex');
const AssetItem       = require('../core/AssetItem');
const FilenameCodec   = require('../crypto/FilenameCodec');
const Blueprint       = require('../fingerprint/Blueprint');
const BlueprintRecord = require('../fingerprint/BlueprintRecord');
const CommitProgress  = require('./CommitProgress');
const ProgressEntry   = require('./ProgressEntry');
const StagedFile      = require('./StagedFile');
const AssetStore      = require('../core/AssetStore');

/**
 * CommitPipeline
 * src/session/CommitPipeline.js
 *
 * Executes the full commit sequence for a prepared session.
 *
 * Phase 1 — guard check only.
 * Phase 2 — build all pack files under .build names with progress tracking.
 * Phase 3 — fingerprint, register in permanent libraries, rename .build files.
 *
 * Zero-size entries:
 *   pack-list.json excludes sentinel-backed (zero-size) entries so DataPackWriter
 *   never receives an empty buffer from the normal build loop.
 *   index-list.json includes ALL entries. In #buildIndex(), entries with size === 0
 *   are inserted directly as AssetItem stubs with their original packId and offset —
 *   no special branching needed elsewhere.
 *
 * Performance design:
 *   - FilenameCodec instantiated once per build, not per asset
 *   - Progress saved every PROGRESS_SAVE_INTERVAL assets (not per step)
 *   - Always saved on error and at phase boundaries
 *   - in-store asset bytes read via AssetStore.getPath() then readFileSync once
 */

const PROGRESS_SAVE_INTERVAL = 500;

class CommitPipeline {

    constructor(session, config, fingerprintStore, assetStore) {
        this.session          = session;
        this.config           = config;
        this.fingerprintStore = fingerprintStore;
        this.assetStore       = assetStore;
        this.#progressPath    = path.join(session.workingDir, 'progress.json');
        this.#progress        = null;
        this.#codec           = new FilenameCodec();
    }

    #progressPath;
    #progress;
    #codec;

    // ---------------------------------------------------------------------------
    // Public entry points
    // ---------------------------------------------------------------------------

    async execute() {
        this.#checkPreparation();
        if (fs.existsSync(this.#progressPath)) {
            fs.unlinkSync(this.#progressPath);
        }
        await this.#loadProgress();
        await this.#build();
        await this.#finalise();
        return this.#buildResult();
    }

    async resume() {
        this.#checkPreparation();
        if (!this.#canResume()) {
            throw new Error(`No resumable progress found for session ${this.session.sessionId}`);
        }
        await this.#loadProgress();
        if (this.#progress.status === 'building' || this.#progress.status === 'pending') {
            await this.#build();
            await this.#finalise();
        } else if (this.#progress.status === 'finalising') {
            await this.#finalise();
        } else {
            throw new Error(`Session progress status "${this.#progress.status}" is not resumable`);
        }
        return this.#buildResult();
    }

    // ---------------------------------------------------------------------------
    // Phase 1 — Guard check
    // ---------------------------------------------------------------------------

    #checkPreparation() {
        if (this.session.status !== 'ready') {
            throw new Error(
                `Session ${this.session.sessionId} is not ready ` +
                `(status: "${this.session.status}"). Call prepare() first.`
            );
        }
        const packListPath  = path.join(this.session.workingDir, 'pack-list.json');
        const indexListPath = path.join(this.session.workingDir, 'index-list.json');
        if (!fs.existsSync(packListPath))  throw new Error('pack-list.json not found in session working directory');
        if (!fs.existsSync(indexListPath)) throw new Error('index-list.json not found in session working directory');
    }

    // ---------------------------------------------------------------------------
    // Phase 2 — Build
    // ---------------------------------------------------------------------------

    async #build() {
        this.session.status = 'building';

        const packListPath = path.join(this.session.workingDir, 'pack-list.json');
        const stagedList   = JSON.parse(fs.readFileSync(packListPath, 'utf8'))
            .map(obj => StagedFile.fromJSON(obj));

        // Build packId lookup for every non-deleted asset.
        // Priority: use staged.packId (original value from blueprint) if set.
        // For new assets (no blueprint packId), derive via codec encode+getPackId.
        const packIdCache = new Map();
        for (const staged of stagedList) {
            if (staged.isDeleted()) continue;
            if (!packIdCache.has(staged.targetName)) {
                if (staged.packId) {
                    packIdCache.set(staged.targetName, staged.packId);
                } else {
                    const encoded = this.#codec.encode(staged.targetName);
                    packIdCache.set(staged.targetName, this.#codec.getPackId(encoded));
                }
            }
        }

        // Initialise progress entries for all files not yet tracked.
        // CommitProgress.makeKey(name, hash) builds the composite key used
        // for all lookups — same design as FingerprintStore primary key.
        for (const staged of stagedList) {
            if (staged.isDeleted()) continue;
            const hash = this.#fingerprint(staged);
            const key  = CommitProgress.makeKey(staged.targetName, hash);
            if (!this.#progress.entries.has(key)) {
                this.#progress.addEntry(new ProgressEntry({
                    fileFingerprint: hash,
                    decodedName:     staged.targetName,
                    packId:          packIdCache.get(staged.targetName) || 0,
                    category:        staged.category
                }));
            }
        }

        this.#progress.status = 'building';
        await this.#saveProgress();

        const outputDir    = path.dirname(this.config.getIndexPath());
        const writer       = new DataPackWriter(outputDir);
        const writtenItems = [];
        let sinceLastSave  = 0;

        try {
            for (const staged of stagedList) {
                if (staged.isDeleted()) continue;

                const hash  = this.#fingerprint(staged);
                const key   = CommitProgress.makeKey(staged.targetName, hash);
                const entry = this.#progress.getEntry(key);

                // Skip already-completed files (resume path)
                if (entry && entry.isComplete()) {
                    const packId = packIdCache.get(staged.targetName) || 0;
                    writtenItems.push(new AssetItem({
                        decodedName:  staged.targetName,
                        assetType:    staged.targetName.includes('.')
                            ? staged.targetName.split('.').pop().toLowerCase()
                            : 'unknown',
                        packId,
                        offset:      0,
                        size:        entry.sizeBytes || 0,
                        indexOffset: 0
                    }));
                    continue;
                }

                // ---- Step 1: Resolve ----
                if (!entry.resolved) {
                    if (staged.isInStore()) {
                        const storePath = this.assetStore.getPath(staged.sourceFingerprint);
                        if (!storePath) throw new Error(`Asset not in store: ${staged.targetName}`);
                        staged.stagedPath = storePath;
                    }
                    entry.resolved = true;
                }

                // ---- Step 2: Hash ----
                if (!entry.hashed) {
                    entry.hashed = true;
                }

                // ---- Step 3: Pack ----
                if (!entry.packed) {
                    const buffer = fs.readFileSync(staged.stagedPath);
                    const packId = packIdCache.get(staged.targetName) || 0;

                    const assetItem = new AssetItem({
                        decodedName:  staged.targetName,
                        assetType:    staged.targetName.includes('.')
                            ? staged.targetName.split('.').pop().toLowerCase()
                            : 'unknown',
                        packId,
                        offset:      0,
                        size:        buffer.length,
                        indexOffset: 0
                    });

                    const updatedItem = await writer.addAsset(assetItem, buffer);
                    writtenItems.push(updatedItem);
                    entry.packed = true;
                }

                // ---- Step 4: Clean ----
                if (!entry.cleaned) {
                    if (staged.isNew() && staged.stagedPath &&
                        staged.stagedPath.startsWith(this.session.workingDir) &&
                        fs.existsSync(staged.stagedPath)) {
                        fs.unlinkSync(staged.stagedPath);
                    }
                    entry.cleaned = true;
                }

                sinceLastSave++;
                if (sinceLastSave >= PROGRESS_SAVE_INTERVAL) {
                    this.#progress.updatedAt = new Date();
                    await this.#saveProgress();
                    sinceLastSave = 0;
                }
            }

            await writer.closeAll();

            this.#progress.updatedAt = new Date();
            await this.#saveProgress();

            await this.#buildIndex(writtenItems, outputDir);

        } catch (err) {
            await writer.closeAll();
            this.#progress.status = 'interrupted';
            this.session.status   = 'interrupted';
            await this.#saveProgress();
            throw err;
        }
    }

    // ---------------------------------------------------------------------------
    // Build index — writes data.000.build
    // ---------------------------------------------------------------------------

    async #buildIndex(writtenItems, outputDir) {
        // index-list.json contains ALL entries in original indexOffset order,
        // including zero-size placeholders excluded from pack-list.json.
        //
        // Each entry: { name, packId, offset, size }
        //   size === null → real asset — look up final offset/size in writtenMap
        //   size === 0    → zero-size placeholder — use original packId + offset directly
        //
        // This is the only place zero-size entries require any handling.
        // No branching exists elsewhere in the pipeline for them.

        const indexListPath = path.join(this.session.workingDir, 'index-list.json');
        const indexOrder    = fs.existsSync(indexListPath)
            ? JSON.parse(fs.readFileSync(indexListPath, 'utf8'))
            : null;

        // Build lookup from decodedName → written AssetItem (size > 0 only)
        const writtenMap = new Map();
        for (const item of writtenItems.filter(i => i.size > 0)) {
            if (writtenMap.has(item.decodedName)) {
                const existing = writtenMap.get(item.decodedName);
                // Duplicate decodedName — keep the one with the higher offset
                if (item.offset > existing.offset) {
                    writtenMap.set(item.decodedName, item);
                }
            } else {
                writtenMap.set(item.decodedName, item);
            }
        }

        let orderedItems;

        if (indexOrder && indexOrder.length > 0) {
            orderedItems = indexOrder.map(entry => {
                const name    = typeof entry === 'string' ? entry : entry.name;
                const isZero  = typeof entry === 'object' && entry.size === 0;

                if (!isZero && writtenMap.has(name)) {
                    // Real asset — use the AssetItem with the final written offset
                    return writtenMap.get(name);
                }

                // Zero-size placeholder — reconstruct stub with original positional data.
                // packId and offset come from index-list.json which sourced them from
                // the blueprint, ensuring byte-identical index reconstruction.
                return new AssetItem({
                    decodedName: name,
                    assetType:   name.includes('.') ? name.split('.').pop().toLowerCase() : 'unknown',
                    packId:      (typeof entry === 'object' && entry.packId) || 0,
                    offset:      (typeof entry === 'object' && entry.offset) || 0,
                    size:        0,
                    indexOffset: 0
                });
            });
        } else {
            orderedItems = writtenItems.filter(i => i.size > 0);
        }

        const index      = new DataPackIndex();
        const serialized = index.serialize(orderedItems);
        const indexBuild = path.join(outputDir, 'data.000.build');
        await fs.promises.writeFile(indexBuild, serialized);
    }

    // ---------------------------------------------------------------------------
    // Phase 3 — Finalise
    // ---------------------------------------------------------------------------

    async #finalise() {
        this.session.status   = 'finalising';
        this.#progress.status = 'finalising';
        await this.#saveProgress();

        const outputDir      = path.dirname(this.config.getIndexPath());
        const indexBuildPath = path.join(outputDir, 'data.000.build');
        const indexBuffer    = fs.readFileSync(indexBuildPath);
        const indexFp        = await Blueprint.fingerprintFile(indexBuildPath);

        await this.fingerprintStore.register(indexBuffer, 'index', 'data.000', null);

        // Fingerprint pack files
        const packRecords = {};
        for (let slot = 1; slot <= 8; slot++) {
            const buildPath = path.join(outputDir, `data.00${slot}.build`);
            if (fs.existsSync(buildPath)) {
                const packFp = Blueprint.fingerprintFileMeta(buildPath);
                const stub   = Buffer.from(`pack:${packFp}`);
                await this.fingerprintStore.register(stub, 'pack', `data.00${slot}`, null);
                packRecords[slot] = { hash: packFp };
            }
        }

        // Parse built index for blueprint construction
        const builtIndex = new DataPackIndex();
        builtIndex.parse(indexBuffer);

        const blueprint = new Blueprint(indexFp);
        const storeDir  = this.assetStore.rootDir;

        const packListPath = path.join(this.session.workingDir, 'pack-list.json');
        const stagedMap    = new Map(
            JSON.parse(fs.readFileSync(packListPath, 'utf8'))
                .map(obj => StagedFile.fromJSON(obj))
                .map(f => [f.targetName, f])
        );

        const buildHandles = new Map();
        const getHandle    = async (packId) => {
            if (!buildHandles.has(packId)) {
                const p = path.join(outputDir, `data.00${packId}.build`);
                if (fs.existsSync(p)) buildHandles.set(packId, await fs.promises.open(p, 'r'));
            }
            return buildHandles.get(packId) || null;
        };

        await this.fingerprintStore.openWriteStream();

        for (const entry of builtIndex.entries) {
            const staged = stagedMap.get(entry.decodedName);
            let assetFp;

            if (entry.size === 0) {
                // Zero-size placeholder — point blueprint record at null-asset sentinel
                assetFp = AssetStore.NULL_ASSET_HASH;
            } else if (staged && staged.isNew()) {
                const handle = await getHandle(entry.packId);
                if (!handle) throw new Error(`Pack handle unavailable for: ${entry.decodedName}`);
                const buffer    = Buffer.alloc(entry.size);
                await handle.read(buffer, 0, entry.size, entry.offset);
                const hash      = crypto.createHash('sha256').update(buffer).digest('hex');
                const writePath = await this.assetStore.write(buffer, hash, entry.assetType);
                const record    = await this.fingerprintStore.register(
                    buffer, 'asset', entry.decodedName, writePath
                );
                assetFp = record.hash;
            } else if (staged && staged.isInStore()) {
                assetFp = staged.sourceFingerprint;
            } else {
                continue;
            }

            blueprint.addRecord(new BlueprintRecord({
                indexOffset:         entry.indexOffset,
                packOffset:          entry.offset,
                packId:              entry.packId,
                fileFingerprint:     assetFp,
                datapackFingerprint: packRecords[entry.packId]?.hash || null,
                decodedName:         entry.decodedName
            }));
        }

        for (const handle of buildHandles.values()) await handle.close();
        await this.fingerprintStore.closeWriteStream();

        blueprint.totalSize   = builtIndex.entries.reduce((s, e) => s + e.size, 0);
        blueprint.uniqueCount = builtIndex.entries.length;
        await blueprint.saveToDisk(storeDir);

        // Rename .build files to final names
        fs.renameSync(indexBuildPath, this.config.getIndexPath());
        for (let slot = 1; slot <= 8; slot++) {
            const buildPath = path.join(outputDir, `data.00${slot}.build`);
            const finalPath = this.config.getPackPath(slot);
            if (fs.existsSync(buildPath) && finalPath) fs.renameSync(buildPath, finalPath);
        }

        this.session.status      = 'committed';
        this.#progress.status    = 'committed';
        this.#progress.updatedAt = new Date();
        await this.#saveProgress();
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Return the raw content hash for a staged file.
     * This is stored as ProgressEntry.fileFingerprint.
     *
     * CommitProgress assembles the composite key name::hash internally,
     * matching the FingerprintStore primary key design:
     *   same name + same hash  -> same key   -> exact duplicate, skip
     *   same name + diff hash  -> diff key   -> new version, track separately
     *   diff name + same hash  -> diff key   -> alias, both written to pack
     *   diff name + diff hash  -> diff key   -> unrelated files, both written
     */
    #fingerprint(staged) {
        return staged.sourceFingerprint || staged.checksum || '';
    }

    #canResume() {
        return fs.existsSync(this.#progressPath);
    }

    async #loadProgress() {
        if (this.#canResume() && this.#progress === null) {
            try {
                const obj = JSON.parse(fs.readFileSync(this.#progressPath, 'utf8'));
                this.#progress = CommitProgress.fromJSON(obj);
                return;
            } catch { /* fall through to fresh */ }
        }
        this.#progress = new CommitProgress({ sessionId: this.session.sessionId });
    }

    async #saveProgress() {
        await fs.promises.writeFile(
            this.#progressPath,
            JSON.stringify(this.#progress.toJSON(), null, 2),
            'utf8'
        );
    }

    #buildResult() {
        const entries  = Array.from(this.#progress.entries.values());
        const complete = entries.filter(e => e.isComplete()).length;
        const total    = entries.length;
        return { complete, total, sessionId: this.session.sessionId };
    }

}

module.exports = CommitPipeline;

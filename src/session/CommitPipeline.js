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
 * Performance design:
 *   - FilenameCodec instantiated once per build, not per asset
 *   - Progress saved every PROGRESS_SAVE_INTERVAL assets (not per step)
 *   - Always saved on error and at phase boundaries
 *   - in-store asset bytes read via AssetStore.getPath() then readFileSync once
 */

const PROGRESS_SAVE_INTERVAL = 500; // save progress.json every N assets

class CommitPipeline {

    constructor(session, config, fingerprintStore, assetStore) {
        this.session          = session;
        this.config           = config;
        this.fingerprintStore = fingerprintStore;
        this.assetStore       = assetStore;
        this.#progressPath    = path.join(session.workingDir, 'progress.json');
        this.#progress        = null;
        this.#codec           = new FilenameCodec(); // one instance for the whole build
    }

    #progressPath;
    #progress;
    #codec;

    // ---------------------------------------------------------------------------
    // Public entry points
    // ---------------------------------------------------------------------------

    async execute() {
        this.#checkPreparation();
        // Always start fresh — delete any stale progress from a previous run.
        // Only resume() should load existing progress.
        if (fs.existsSync(this.#progressPath)) {
            fs.unlinkSync(this.#progressPath);
        }
        await this.#loadProgress(); // initialises fresh CommitProgress
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
        if (!fs.existsSync(packListPath))  throw new Error(`pack-list.json not found in session working directory`);
        if (!fs.existsSync(indexListPath)) throw new Error(`index-list.json not found in session working directory`);
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
        // Using the codec on existing assets risks wrong results because encode()
        // uses default salt chars ('a'/'z') while the original may have used different
        // salts — getPackId hashes the full encoded string including salts.
        const packIdCache = new Map();
        for (const staged of stagedList) {
            if (staged.isDeleted()) continue;
            if (!packIdCache.has(staged.targetName)) {
                if (staged.packId) {
                    // Use original packId from blueprint — guaranteed correct
                    packIdCache.set(staged.targetName, staged.packId);
                } else {
                    // New asset — derive from encoded filename
                    const encoded = this.#codec.encode(staged.targetName);
                    packIdCache.set(staged.targetName, this.#codec.getPackId(encoded));
                }
            }
        }

        // Initialise progress entries for all files not yet tracked
        for (const staged of stagedList) {
            if (staged.isDeleted()) continue;
            const fp = this.#fingerprint(staged);
            if (!this.#progress.entries.has(fp)) {
                this.#progress.addEntry(new ProgressEntry({
                    fileFingerprint: fp,
                    decodedName:     staged.targetName,
                    packId:          packIdCache.get(staged.targetName) || 0,
                    category:        staged.category
                }));
            }
        }

        this.#progress.status = 'building';
        await this.#saveProgress();

        const outputDir  = path.dirname(this.config.getIndexPath());
        const writer     = new DataPackWriter(outputDir);
        const writtenItems = [];
        let   sinceLastSave = 0;

        try {
            for (const staged of stagedList) {
                if (staged.isDeleted()) continue;

                const fp    = this.#fingerprint(staged);
                const entry = this.#progress.getEntry(fp);

                // Skip already-completed files (resume path)
                if (entry && entry.isComplete()) {
                    // Still need to track writtenItems for index build on resume
                    // We can reconstruct the AssetItem from entry state
                    const packId = packIdCache.get(staged.targetName) || 0;
                    writtenItems.push(new AssetItem({
                        decodedName:  staged.targetName,
                        assetType:    staged.targetName.includes('.')
                            ? staged.targetName.split('.').pop().toLowerCase()
                            : 'unknown',
                        packId,
                        offset:       0, // will be re-read from built pack in finalise
                        size:         0,
                        indexOffset:  0
                    }));
                    continue;
                }

                // ---- Steps 1+2: Resolve path and verify ----
                // For in-store assets: get path from AssetStore directly (no I/O if already cached)
                // For new assets: staged.stagedPath already set from addFile()
                if (!entry.extracted) {
                    if (staged.isInStore()) {
                        // Resolve directly from store — no copy needed
                        const storePath = this.assetStore.getPath(staged.sourceFingerprint);
                        if (!storePath) {
                            throw new Error(`Asset not in store: ${staged.targetName} (${staged.sourceFingerprint?.slice(0,12)}...)`);
                        }
                        staged.stagedPath = storePath;
                    }
                    // For new assets stagedPath is already set
                    entry.extracted = true;
                    entry.verified  = true; // verify inline below via buffer hash
                }

                // ---- Step 3: Pack ----
                if (!entry.packed) {
                    if (!staged.stagedPath || !fs.existsSync(staged.stagedPath)) {
                        throw new Error(`Staged path not found for: ${staged.targetName}`);
                    }

                    const buffer = fs.readFileSync(staged.stagedPath);

                    // Verify new assets by checksum
                    if (staged.isNew() && staged.checksum) {
                        const actual = crypto.createHash('sha256').update(buffer).digest('hex');
                        if (actual !== staged.checksum) {
                            throw new Error(`Checksum mismatch for: ${staged.targetName}`);
                        }
                    }

                    const packId   = packIdCache.get(staged.targetName) || 0;
                    entry.packId   = packId;

                    // Debug: log first 5 entries to verify packId
                    if (writtenItems.length < 5) {
                        console.log(`    [debug] writing ${staged.targetName} packId=${packId} (staged.packId=${staged.packId})`);
                    }

                    const assetItem = new AssetItem({
                        decodedName: staged.targetName,
                        assetType:   staged.targetName.includes('.')
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

                // Save progress every PROGRESS_SAVE_INTERVAL assets, not per step
                sinceLastSave++;
                if (sinceLastSave >= PROGRESS_SAVE_INTERVAL) {
                    this.#progress.updatedAt = new Date();
                    await this.#saveProgress();
                    sinceLastSave = 0;
                }
            }

            await writer.closeAll();

            // Final progress save at end of build
            this.#progress.updatedAt = new Date();
            await this.#saveProgress();

            // Build index from written items
            await this.#buildIndex(writtenItems, outputDir);

        } catch (err) {
            await writer.closeAll();
            this.#progress.status = 'interrupted';
            this.session.status   = 'interrupted';
            await this.#saveProgress();
            throw err;
        }
    }

    async #buildIndex(writtenItems, outputDir) {
        // index-list.json contains ALL entry names in original indexOffset order,
        // including zero-size placeholder entries that were never written to a pack.
        // writtenItems contains only entries that were physically written (size > 0).
        // We must reconstruct the full ordered list, inserting zero-size stubs
        // at their original positions.

        const indexListPath = path.join(this.session.workingDir, 'index-list.json');
        const indexOrder    = fs.existsSync(indexListPath)
            ? JSON.parse(fs.readFileSync(indexListPath, 'utf8'))
            : null;

        // Build a lookup from decodedName → written AssetItem
        // Use a manual loop instead of Map constructor to detect duplicates
        const writtenMap = new Map();
        for (const item of writtenItems.filter(i => i.size > 0)) {
            if (writtenMap.has(item.decodedName)) {
                const existing = writtenMap.get(item.decodedName);
                // Duplicate decodedName — keep the one with the higher offset
                // (later in pack-write order = the actual write position)
                if (item.offset > existing.offset) {
                    writtenMap.set(item.decodedName, item);
                }
            } else {
                writtenMap.set(item.decodedName, item);
            }
        }

        let orderedItems;

        // Debug: check a known-failing entry
        const debugName = 'wolf_lv2_cast.wav';
        const debugItem = writtenMap.get(debugName);
        if (debugItem) {
            console.log(`  [buildIndex debug] ${debugName}: writtenMap packId=${debugItem.packId} offset=${debugItem.offset}`);
        } else {
            console.log(`  [buildIndex debug] ${debugName}: NOT in writtenMap`);
        }
        console.log(`  [buildIndex debug] writtenItems count: ${writtenItems.length}, writtenMap size: ${writtenMap.size}`);

        if (indexOrder && indexOrder.length > 0) {
            // index-list.json stores { name, packId, offset, size } objects.
            // size===0 means zero-size placeholder — include with original packId+offset.
            // size===null means a written asset — look up in writtenMap for real offset.
            orderedItems = indexOrder.map(entry => {
                // Handle legacy format (plain string names from old sessions)
                const name   = typeof entry === 'string' ? entry : entry.name;
                const isZero = typeof entry === 'object' && entry.size === 0;

                if (!isZero && writtenMap.has(name)) return writtenMap.get(name);

                // Zero-size placeholder — use original packId and offset from blueprint
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

        // Load pack-list once
        const packListPath = path.join(this.session.workingDir, 'pack-list.json');
        const stagedMap    = new Map(
            JSON.parse(fs.readFileSync(packListPath, 'utf8'))
                .map(obj => StagedFile.fromJSON(obj))
                .map(f => [f.targetName, f])
        );

        // Open .build pack file handles for reading new asset bytes
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

            if (staged && staged.isNew()) {
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
                datapackFingerprint: packRecords[entry.packId]?.hash || null
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
        this.#progress.status    = 'complete';
        this.#progress.updatedAt = new Date();
        await this.#saveProgress();
    }

    // ---------------------------------------------------------------------------
    // Progress helpers
    // ---------------------------------------------------------------------------

    async #loadProgress() {
        if (fs.existsSync(this.#progressPath)) {
            const obj = JSON.parse(await fs.promises.readFile(this.#progressPath, 'utf8'));
            this.#progress = CommitProgress.fromJSON(obj);
        } else {
            const packListPath  = path.join(this.session.workingDir, 'pack-list.json');
            const indexListPath = path.join(this.session.workingDir, 'index-list.json');
            this.#progress = new CommitProgress({
                sessionId: this.session.sessionId,
                status:    'pending',
                packListPath,
                indexListPath
            });
        }
    }

    async #saveProgress() {
        await fs.promises.writeFile(
            this.#progressPath,
            JSON.stringify(this.#progress.toJSON(), null, 2),
            'utf8'
        );
    }

    #canResume() {
        if (!fs.existsSync(this.#progressPath)) return false;
        try {
            const obj = JSON.parse(fs.readFileSync(this.#progressPath, 'utf8'));
            return ['building', 'finalising', 'pending'].includes(CommitProgress.fromJSON(obj).status);
        } catch { return false; }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Derive a unique progress key for a staged file.
     * Must be unique per file — use targetName hash since filenames are unique
     * in the pack even when multiple files share the same content (aliases).
     * Do NOT use sourceFingerprint — aliases share the same content hash.
     */
    #fingerprint(staged) {
        return crypto.createHash('sha256').update(staged.targetName).digest('hex');
    }

    #buildResult() {
        const total    = this.#progress.entries.size;
        const complete = Array.from(this.#progress.entries.values()).filter(e => e.isComplete()).length;
        return {
            sessionId:   this.session.sessionId,
            status:      this.#progress.status,
            total,
            complete,
            failed:      total - complete,
            completedAt: new Date().toISOString()
        };
    }
}

module.exports = CommitPipeline;

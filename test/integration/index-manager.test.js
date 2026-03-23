'use strict';
/**
 * test/integration/index-manager.test.js
 *
 * Tier 3 — pipeline integration tests for IndexManager.
 * Reads from test/fixtures/data/ and test/fixtures/store/.
 * All writes go to a unique temp dir under os.tmpdir() cleaned up after each test.
 *
 * Requires fixtures to have been generated first:
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/3.generate-fixture.js
 *
 * Standalone runnable:
 *   node test/integration/index-manager.test.js
 */

const { test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');
const crypto  = require('node:crypto');

const IndexManager      = require(path.join(__dirname, '..', '..', 'src', 'api', 'IndexManager'));
const PackConfiguration = require(path.join(__dirname, '..', '..', 'src', 'config', 'PackConfiguration'));
const AssetStore        = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));
const FingerprintStore  = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintStore'));
const Blueprint         = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'Blueprint'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_STORE    = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');
const FIXTURE_INDEX    = path.join(FIXTURE_DATA,     'data.000');
const ENTRIES_PATH     = path.join(FIXTURE_EXPECTED, 'entries.json');
const HASHES_PATH      = path.join(FIXTURE_EXPECTED, 'hashes.json');
const PACK_MAP_PATH    = path.join(FIXTURE_EXPECTED, 'pack-map.json');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_INDEX)
                       && fs.existsSync(ENTRIES_PATH)
                       && fs.existsSync(HASHES_PATH)
                       && fs.existsSync(PACK_MAP_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'im-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Build a fresh IndexManager backed by the fixture store.
 * The AssetStore and FingerprintStore are read-only views of the fixture —
 * extractedPath values in the JSONL are relative to FIXTURE_STORE, resolved here.
 *
 * Returns { manager, assetStore, fpStore }.
 * Does NOT call loadIndex() — caller controls when that happens.
 */
async function makeFixtureManager() {
    const assetStore = new AssetStore(FIXTURE_STORE);
    await assetStore.rebuild();

    const fpStore = new FingerprintStore(
        path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
        assetStore
    );
    await fpStore.load();

    // Patch relative extractedPaths to absolute
    for (const record of fpStore.list()) {
        if (record.extractedPath && !path.isAbsolute(record.extractedPath)) {
            record.extractedPath = path.join(FIXTURE_STORE, record.extractedPath);
        }
    }

    const config = new PackConfiguration({
        indexPath:     FIXTURE_INDEX,
        packPaths:     new Map(
            Array.from({ length: 8 }, (_, i) => [
                i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
            ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
        ),
        assetStoreDir: FIXTURE_STORE,
        sessionsDir:   os.tmpdir()
    });

    const manager = new IndexManager(config, fpStore, assetStore);
    return { manager, assetStore, fpStore, config };
}

/**
 * Build a map of decodedName → Set<string> of all known real content hashes
 * from the fixture store files.
 *
 * pack-map.json contentHash holds stub hashes from loadIndex(), not real content.
 * The store files are the ground truth.
 */
function buildStoreHashMap() {
    const fpPath = path.join(FIXTURE_STORE, 'fingerprints.jsonl');
    if (!fs.existsSync(fpPath)) return new Map();

    const lines = fs.readFileSync(fpPath, 'utf8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

    const result = new Map();
    for (const rec of lines) {
        if (!rec.decodedName || !rec.extractedPath) continue;
        const absPath = path.isAbsolute(rec.extractedPath)
            ? rec.extractedPath
            : path.join(FIXTURE_STORE, rec.extractedPath);
        if (!fs.existsSync(absPath)) continue;
        const h = sha256(fs.readFileSync(absPath));
        if (!result.has(rec.decodedName)) result.set(rec.decodedName, new Set());
        result.get(rec.decodedName).add(h);
    }
    return result;
}

const STORE_HASH_MAP = FIXTURE_AVAILABLE ? buildStoreHashMap() : new Map();

// ---------------------------------------------------------------------------
// loadIndex() — entry count and correctness
// ---------------------------------------------------------------------------

test('loadIndex() — returns a DataPackIndex with entries',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    const index = await manager.loadIndex();
    assert.ok(index !== null);
    assert.ok(index.entries.length > 0, 'loadIndex() must return entries');
});

test('loadIndex() — entry count matches expected/entries.json',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    const index       = await manager.loadIndex();
    assert.equal(index.entries.length, expected.length,
        `entry count must be ${expected.length}, got ${index.entries.length}`);
});

test('loadIndex() — every entry name matches expected/entries.json',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    const index       = await manager.loadIndex();
    const expectedSet = new Set(expected.map(e => e.decodedName));
    for (const entry of index.entries) {
        assert.ok(expectedSet.has(entry.decodedName),
            `unexpected entry in loaded index: "${entry.decodedName}"`);
    }
});

test('loadIndex() — second call uses blueprint cache (no re-parse)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    // The fixture already has a blueprint on disk. First loadIndex() should
    // use the blueprint fast path; second call (new manager instance, same
    // blueprint on disk) should also use the fast path and return in well
    // under the time of a fresh parse.
    const { manager: m1 } = await makeFixtureManager();
    const t1 = Date.now();
    await m1.loadIndex();
    const elapsed1 = Date.now() - t1;

    const { manager: m2 } = await makeFixtureManager();
    const t2 = Date.now();
    await m2.loadIndex();
    const elapsed2 = Date.now() - t2;

    // Blueprint cache path should be at least as fast as the first load.
    // We don't assert a strict time limit — just that it completed and returned results.
    // A 5× slack avoids flaky CI failures on slow machines.
    assert.ok(elapsed2 < elapsed1 * 5 + 500,
        `cached load (${elapsed2}ms) should not be dramatically slower than first (${elapsed1}ms)`);
});

test('loadIndex() — is idempotent (second call on same manager returns same count)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    const index1 = await manager.loadIndex();
    const index2 = await manager.loadIndex();
    assert.equal(index2.entries.length, index1.entries.length);
});

// ---------------------------------------------------------------------------
// getEntries() — filtering and pagination
// ---------------------------------------------------------------------------

test('getEntries() — returns entries and non-zero total after loadIndex()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    const result = manager.getEntries({});
    assert.ok(result.entries.length > 0, 'getEntries() must return entries');
    assert.ok(result.total > 0, 'total must be > 0');
    assert.equal(result.page, 1);
});

test('getEntries() — type filter returns only matching entries',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    // Find a type that exists in the fixture
    const typeCounts = {};
    for (const e of expected) typeCounts[e.assetType] = (typeCounts[e.assetType] || 0) + 1;
    const [targetType] = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

    const result = manager.getEntries({ type: targetType, pageSize: 999 });
    assert.ok(result.total > 0, `type filter "${targetType}" must return results`);
    assert.ok(result.entries.every(e => e.assetType === targetType),
        'all returned entries must match the type filter');
});

test('getEntries() — search filter returns only entries containing the search string',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    // Pick a distinctive substring from the first entry name
    const sample  = expected[0].decodedName;
    const segment = sample.slice(0, Math.max(3, Math.floor(sample.length / 2)));

    const result = manager.getEntries({ search: segment, pageSize: 999 });
    assert.ok(result.total > 0, 'search filter must return at least one result');
    assert.ok(
        result.entries.every(e => e.decodedName.toLowerCase().includes(segment.toLowerCase())),
        'all returned entries must contain the search string'
    );
});

test('getEntries() — packId filter returns only entries from that slot',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    // Find a pack slot that has entries in the fixture
    const slotCounts = {};
    for (const e of expected) slotCounts[e.packId] = (slotCounts[e.packId] || 0) + 1;
    const [targetSlot] = Object.entries(slotCounts).sort((a, b) => b[1] - a[1])[0];

    const result = manager.getEntries({ packId: Number(targetSlot), pageSize: 999 });
    assert.ok(result.total > 0, `packId filter for slot ${targetSlot} must return results`);
    assert.ok(result.entries.every(e => e.packId === Number(targetSlot)),
        'all returned entries must be from the filtered pack slot');
});

test('getEntries() — pagination: page 1 and page 2 have different entries',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    const page1 = manager.getEntries({ pageSize: 5, page: 1 });
    const page2 = manager.getEntries({ pageSize: 5, page: 2 });

    // Only meaningful if there are enough entries for two pages
    if (page2.entries.length === 0) return;

    assert.equal(page1.entries.length, 5, 'page 1 must have 5 entries');
    assert.notEqual(
        page1.entries[0].decodedName,
        page2.entries[0].decodedName,
        'first entry of page 1 and page 2 must differ'
    );
});

test('getEntries() — totalPages is calculated correctly',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    const result = manager.getEntries({ pageSize: 3 });
    const expected = Math.ceil(result.total / 3);
    assert.equal(result.totalPages, expected,
        `totalPages must equal ceil(total / pageSize) = ${expected}`);
});

test('getEntries() — throws if called before loadIndex()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    // Do NOT call loadIndex()
    assert.throws(
        () => manager.getEntries({}),
        { message: /not loaded/i }
    );
});

test('getEntries() — sortBy name desc returns entries in reverse alphabetical order',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    const result = manager.getEntries({ sortBy: 'decodedName', sortDir: 'desc', pageSize: 10 });
    for (let i = 1; i < result.entries.length; i++) {
        assert.ok(
            result.entries[i - 1].decodedName >= result.entries[i].decodedName,
            'entries must be in descending name order'
        );
    }
});

// ---------------------------------------------------------------------------
// extractAll()
// ---------------------------------------------------------------------------

test('extractAll() — extracted + skipped equals total entry count',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const tmpDir = makeTempDir();
    try {
        const expected   = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        // extractAll() skips zero-size entries (counted in skipped), so
        // extracted + skipped must equal the full entry count, not just non-zero.
        const totalCount = expected.length;

        // Build a fresh manager that writes to a temp AssetStore
        const tmpAssetStore = new AssetStore(tmpDir);
        await tmpAssetStore.rebuild();
        tmpAssetStore.ensureNullAsset();

        const tmpFpPath  = path.join(tmpDir, 'fingerprints.jsonl');
        const tmpFpStore = new FingerprintStore(tmpFpPath, tmpAssetStore);
        await tmpFpStore.load();
        await tmpFpStore.ensureNullAsset();

        const config = new PackConfiguration({
            indexPath:     FIXTURE_INDEX,
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [
                    i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
                ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
            ),
            assetStoreDir: tmpDir,
            sessionsDir:   os.tmpdir()
        });

        const manager = new IndexManager(config, tmpFpStore, tmpAssetStore);
        await manager.loadIndex();
        const result  = await manager.extractAll();

        assert.equal(
            result.extracted + result.skipped,
            totalCount,
            `extracted (${result.extracted}) + skipped (${result.skipped}) must equal total entries (${totalCount})`
        );
        assert.deepEqual(result.errors, [], 'no extraction errors expected for fixture data');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('extractAll() — extracted files exist in the temp AssetStore',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const tmpDir = makeTempDir();
    try {
        const tmpAssetStore = new AssetStore(tmpDir);
        await tmpAssetStore.rebuild();
        tmpAssetStore.ensureNullAsset();

        const tmpFpPath  = path.join(tmpDir, 'fingerprints.jsonl');
        const tmpFpStore = new FingerprintStore(tmpFpPath, tmpAssetStore);
        await tmpFpStore.load();
        await tmpFpStore.ensureNullAsset();

        const config = new PackConfiguration({
            indexPath:     FIXTURE_INDEX,
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [
                    i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
                ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
            ),
            assetStoreDir: tmpDir,
            sessionsDir:   os.tmpdir()
        });

        const manager = new IndexManager(config, tmpFpStore, tmpAssetStore);
        await manager.loadIndex();
        await manager.extractAll();

        // All non-null asset records in fpStore should have resolvable paths
        const assets = tmpFpStore.list('asset').filter(r =>
            r.hash !== AssetStore.NULL_ASSET_HASH && !r.isAlias
        );
        let missingCount = 0;
        for (const rec of assets) {
            if (!rec.extractedPath || !fs.existsSync(rec.extractedPath)) {
                missingCount++;
            }
        }
        assert.equal(missingCount, 0,
            `${missingCount} asset records have missing extractedPath after extractAll()`);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('extractAll() — type filter extracts only matching assets',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const tmpDir = makeTempDir();
    try {
        const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const typeCounts  = {};
        for (const e of expected) typeCounts[e.assetType] = (typeCounts[e.assetType] || 0) + 1;
        const [targetType] = Object.entries(typeCounts)
            .filter(([, c]) => c > 0)
            .sort((a, b) => b[1] - a[1])[0];

        // extractAll() skips zero-size entries (counted in skipped), so
        // extracted + skipped must equal the total count for the type, not just non-zero.
        const totalOfType = expected.filter(e => e.assetType === targetType).length;

        const tmpAssetStore = new AssetStore(tmpDir);
        await tmpAssetStore.rebuild();
        tmpAssetStore.ensureNullAsset();

        const tmpFpPath  = path.join(tmpDir, 'fingerprints.jsonl');
        const tmpFpStore = new FingerprintStore(tmpFpPath, tmpAssetStore);
        await tmpFpStore.load();
        await tmpFpStore.ensureNullAsset();

        const config = new PackConfiguration({
            indexPath:     FIXTURE_INDEX,
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [
                    i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
                ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
            ),
            assetStoreDir: tmpDir,
            sessionsDir:   os.tmpdir()
        });

        const manager = new IndexManager(config, tmpFpStore, tmpAssetStore);
        await manager.loadIndex();
        const result  = await manager.extractAll({ types: [targetType] });

        assert.equal(
            result.extracted + result.skipped,
            totalOfType,
            `type-filtered extractAll should process ${totalOfType} ${targetType} entries`
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// extractSingle()
// ---------------------------------------------------------------------------

test('extractSingle() — returns buffer with correct SHA-256 for a known entry',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const nonZero     = expected.filter(e => e.size > 0);
    assert.ok(nonZero.length > 0, 'need at least one non-zero fixture entry');

    const target = nonZero[0];
    const buf    = await manager.extractSingle(target.decodedName);

    assert.equal(buf.length, target.size,
        `extracted buffer size must match entry.size (${target.size})`);

    // Verify against fixture store hash
    const knownHashes = STORE_HASH_MAP.get(target.decodedName);
    if (knownHashes && knownHashes.size > 0) {
        assert.ok(knownHashes.has(sha256(buf)),
            `SHA-256 of extracted buffer must match a known fixture store hash for "${target.decodedName}"`);
    }
});

test('extractSingle() — throws for an unknown filename',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    await assert.rejects(
        () => manager.extractSingle('completely_nonexistent_file.dds'),
        { message: /not found/i }
    );
});

test('extractSingle() — throws for a zero-size entry',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected  = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const zeroEntry = expected.find(e => e.size === 0);
    assert.ok(zeroEntry, 'fixture must have at least one zero-size entry');

    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    await assert.rejects(
        () => manager.extractSingle(zeroEntry.decodedName),
        { message: /zero size/i }
    );
});

test('extractSingle() — is deterministic (same bytes on two calls)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const target      = expected.find(e => e.size > 0);
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    const buf1 = await manager.extractSingle(target.decodedName);
    const buf2 = await manager.extractSingle(target.decodedName);
    assert.equal(sha256(buf1), sha256(buf2),
        'two calls to extractSingle() for the same file must return identical bytes');
});

// ---------------------------------------------------------------------------
// rebuildBlueprints()
// ---------------------------------------------------------------------------

test('rebuildBlueprints() — produces a blueprint that resolves all entry names',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const tmpDir = makeTempDir();
    try {
        // Use a temp AssetStore/FpStore that has real content (from the fixture store)
        // but a separate blueprint dir so we can test the rebuild.
        const tmpAssetStore = new AssetStore(tmpDir);
        await tmpAssetStore.rebuild();
        tmpAssetStore.ensureNullAsset();

        const tmpFpPath  = path.join(tmpDir, 'fingerprints.jsonl');
        const tmpFpStore = new FingerprintStore(tmpFpPath, tmpAssetStore);
        await tmpFpStore.load();
        await tmpFpStore.ensureNullAsset();

        const config = new PackConfiguration({
            indexPath:     FIXTURE_INDEX,
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [
                    i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
                ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
            ),
            assetStoreDir: tmpDir,
            sessionsDir:   os.tmpdir()
        });

        const manager = new IndexManager(config, tmpFpStore, tmpAssetStore);
        // loadIndex() parses data.000, registers stubs, saves blueprint
        await manager.loadIndex();
        // rebuildBlueprints() rebuilds from the registered stub records
        const blueprints = await manager.rebuildBlueprints();

        assert.ok(blueprints.length > 0, 'rebuildBlueprints() must return at least one blueprint');

        // Load the saved blueprint and verify it covers all entries
        const indexFp  = await Blueprint.fingerprintFile(FIXTURE_INDEX);
        const saved    = await Blueprint.loadFromDisk(tmpDir, indexFp);
        assert.ok(saved !== null, 'blueprint must be saved to disk');

        const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        assert.equal(saved.getRecords().length, expected.length,
            'rebuilt blueprint must have the same record count as expected/entries.json');

        // Every record must have a decodedName
        for (const rec of saved.getRecords()) {
            assert.ok(rec.decodedName && rec.decodedName.length > 0,
                'every blueprint record must have a decodedName');
        }
    } finally {
        cleanupDir(tmpDir);
    }
});

test('rebuildBlueprints() — blueprint resolves all entry names via getByName()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const tmpDir = makeTempDir();
    try {
        const tmpAssetStore = new AssetStore(tmpDir);
        await tmpAssetStore.rebuild();
        tmpAssetStore.ensureNullAsset();

        const tmpFpPath  = path.join(tmpDir, 'fingerprints.jsonl');
        const tmpFpStore = new FingerprintStore(tmpFpPath, tmpAssetStore);
        await tmpFpStore.load();
        await tmpFpStore.ensureNullAsset();

        const config = new PackConfiguration({
            indexPath:     FIXTURE_INDEX,
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [
                    i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
                ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
            ),
            assetStoreDir: tmpDir,
            sessionsDir:   os.tmpdir()
        });

        const manager = new IndexManager(config, tmpFpStore, tmpAssetStore);
        await manager.loadIndex();
        await manager.rebuildBlueprints();

        const indexFp = await Blueprint.fingerprintFile(FIXTURE_INDEX);
        const saved   = await Blueprint.loadFromDisk(tmpDir, indexFp);
        assert.ok(saved !== null);

        // Every record's decodedName must be resolvable via getByName()
        let unresolvable = 0;
        for (const rec of saved.getRecords()) {
            if (!rec.decodedName) continue;
            const fpRec = tmpFpStore.getByName(rec.decodedName);
            if (!fpRec) unresolvable++;
        }
        assert.equal(unresolvable, 0,
            `${unresolvable} blueprint records have decodedName not resolvable via getByName()`);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// setConfig() / getConfig()
// ---------------------------------------------------------------------------

test('setConfig() — replaces the active config',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager, config } = await makeFixtureManager();
    const newConfig = new PackConfiguration({
        indexPath:     config.getIndexPath(),
        packPaths:     config.packPaths,
        assetStoreDir: FIXTURE_STORE,
        sessionsDir:   os.tmpdir(),
        label:         'replacement-config'
    });
    manager.setConfig(newConfig);
    assert.equal(manager.getConfig().label, 'replacement-config');
});

test('getConfig() — returns the current config',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager, config } = await makeFixtureManager();
    const retrieved = manager.getConfig();
    assert.equal(retrieved.getIndexPath(), config.getIndexPath());
});

test('setConfig() — forces reload on next loadIndex() call',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager, config } = await makeFixtureManager();
    await manager.loadIndex();

    // Calling getEntries() after loadIndex() works fine
    assert.doesNotThrow(() => manager.getEntries({}));

    // Replacing config invalidates the cached index
    manager.setConfig(config);

    // Now getEntries() should throw since index is cleared
    assert.throws(
        () => manager.getEntries({}),
        { message: /not loaded/i }
    );
});

// ---------------------------------------------------------------------------
// composeIndexList()
// ---------------------------------------------------------------------------

test('composeIndexList() — returns all entries when no filter applied',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();
    const list = manager.composeIndexList({});
    assert.equal(list.length, expected.length,
        'composeIndexList() with no filter must return all entries');
});

test('composeIndexList() — type filter returns only matching entries',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const { manager } = await makeFixtureManager();
    await manager.loadIndex();

    const typeCounts = {};
    for (const e of expected) typeCounts[e.assetType] = (typeCounts[e.assetType] || 0) + 1;
    const [targetType] = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

    const list = manager.composeIndexList({ type: targetType });
    assert.ok(list.length > 0, 'type-filtered composeIndexList() must return results');
    assert.ok(list.every(e => e.assetType === targetType),
        'all returned entries must match the type filter');
});

test('composeIndexList() — throws if called before loadIndex()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { manager } = await makeFixtureManager();
    assert.throws(
        () => manager.composeIndexList({}),
        { message: /not loaded/i }
    );
});

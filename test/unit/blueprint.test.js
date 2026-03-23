'use strict';
/**
 * test/unit/blueprint.test.js
 *
 * Tier 1 — pure in-memory tests (diff, filter, toCSV, serialization).
 * Tier 2 — fixture-backed tests (loadFromDisk, resolveAssetItems,
 *           fingerprintFile, fingerprintFileMeta, validatePackState).
 *
 * Reads from test/fixtures/store/blueprints/, test/fixtures/data/data.000,
 * and test/fixtures/expected/ (entries.json, hashes.json).
 *
 * All disk writes go to a unique temp dir under os.tmpdir() that is cleaned
 * up after each test.
 *
 * Skips gracefully if fixture has not been generated yet.
 *
 * Standalone runnable:
 *   node test/unit/blueprint.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const crypto   = require('node:crypto');

const Blueprint       = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'Blueprint'));
const BlueprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'BlueprintRecord'));
const AssetItem       = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetItem'));
const AssetStore      = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));
const FingerprintStore = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintStore'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_STORE    = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');
const FIXTURE_INDEX    = path.join(FIXTURE_DATA,     'data.000');
const ENTRIES_PATH     = path.join(FIXTURE_EXPECTED, 'entries.json');
const HASHES_PATH      = path.join(FIXTURE_EXPECTED, 'hashes.json');
const BLUEPRINT_DIR    = path.join(FIXTURE_STORE,    'blueprints');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_INDEX)
                       && fs.existsSync(ENTRIES_PATH)
                       && fs.existsSync(HASHES_PATH)
                       && fs.existsSync(BLUEPRINT_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Load the fixture fingerprint store and asset store.
 * Returns { fpStore, assetStore } ready to use.
 * extractedPath values in JSONL are relative to FIXTURE_STORE — resolved here.
 */
async function loadFixtureStores() {
    const assetStore = new AssetStore(FIXTURE_STORE);
    await assetStore.rebuild();

    const fpStore = new FingerprintStore(
        path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
        assetStore
    );
    await fpStore.load();

    // Patch relative extractedPaths to absolute (same as fixture generator step 3)
    for (const record of fpStore.list()) {
        if (record.extractedPath && !path.isAbsolute(record.extractedPath)) {
            record.extractedPath = path.join(FIXTURE_STORE, record.extractedPath);
        }
    }

    return { fpStore, assetStore };
}

/**
 * Find the first blueprint file and return its indexFingerprint.
 */
function getFixtureBlueprintFingerprint() {
    if (!fs.existsSync(BLUEPRINT_DIR)) return null;
    const files = fs.readdirSync(BLUEPRINT_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    return files[0].replace('.json', '');
}

/**
 * Build a minimal mock FingerprintStore for Tier 1 tests.
 * Returns records registered via byName and byHash.
 */
function makeMockStore(records) {
    const byName = new Map(records.map(r => [r.decodedName, r]));
    const byHash = new Map(records.map(r => [r.hash, r]));
    return {
        getByName: (n) => byName.get(n) || null,
        get:       (h) => byHash.get(h) || null,
        list:      ()  => records
    };
}

function makeFpRecord(opts) {
    const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
    return new FingerprintRecord(opts);
}

// ---------------------------------------------------------------------------
// Tier 1 — constructor and basic properties
// ---------------------------------------------------------------------------

test('[T1] constructor — indexFingerprint stored correctly', () => {
    const bp = new Blueprint('test-fingerprint-abc');
    assert.equal(bp.indexFingerprint, 'test-fingerprint-abc');
});

test('[T1] constructor — generatedAt is a Date instance', () => {
    const bp = new Blueprint('fp');
    assert.ok(bp.generatedAt instanceof Date);
});

test('[T1] constructor — totalSize defaults to 0', () => {
    const bp = new Blueprint('fp');
    assert.equal(bp.totalSize, 0);
});

test('[T1] constructor — uniqueCount defaults to 0', () => {
    const bp = new Blueprint('fp');
    assert.equal(bp.uniqueCount, 0);
});

test('[T1] constructor — starts with empty records', () => {
    const bp = new Blueprint('fp');
    assert.equal(bp.getRecords().length, 0);
});

// ---------------------------------------------------------------------------
// Tier 1 — addRecord / getRecords
// ---------------------------------------------------------------------------

test('[T1] addRecord — increases record count', () => {
    const bp  = new Blueprint('fp');
    const rec = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'fp1', datapackFingerprint: 'pp1', decodedName: 'hero.dds' });
    bp.addRecord(rec);
    assert.equal(bp.getRecords().length, 1);
});

test('[T1] addRecord — preserves insertion order', () => {
    const bp   = new Blueprint('fp');
    const recs = ['a', 'b', 'c'].map((id, i) => new BlueprintRecord({
        indexOffset: i * 10, packOffset: 0, packId: 1,
        fileFingerprint: `fp-${id}`, datapackFingerprint: null, decodedName: `${id}.dds`
    }));
    recs.forEach(r => bp.addRecord(r));
    assert.equal(bp.getRecords()[0].fileFingerprint, 'fp-a');
    assert.equal(bp.getRecords()[2].fileFingerprint, 'fp-c');
});

test('[T1] getRecords — returns the same array reference on multiple calls', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'fp1', decodedName: 'hero.dds' }));
    assert.equal(bp.getRecords(), bp.getRecords());
});

// ---------------------------------------------------------------------------
// Tier 1 — filter()
// ---------------------------------------------------------------------------

test('[T1] filter — returns matching records', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ packId: 1, fileFingerprint: 'a', decodedName: 'a.dds' }));
    bp.addRecord(new BlueprintRecord({ packId: 2, fileFingerprint: 'b', decodedName: 'b.dds' }));
    bp.addRecord(new BlueprintRecord({ packId: 1, fileFingerprint: 'c', decodedName: 'c.dds' }));
    const filtered = bp.filter(r => r.packId === 1);
    assert.equal(filtered.length, 2);
});

test('[T1] filter — returns empty array when nothing matches', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ packId: 1, fileFingerprint: 'a', decodedName: 'a.dds' }));
    const filtered = bp.filter(r => r.packId === 99);
    assert.deepEqual(filtered, []);
});

test('[T1] filter — does not mutate the internal records array', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ packId: 1, fileFingerprint: 'a', decodedName: 'a.dds' }));
    bp.addRecord(new BlueprintRecord({ packId: 2, fileFingerprint: 'b', decodedName: 'b.dds' }));
    bp.filter(r => r.packId === 1);
    assert.equal(bp.getRecords().length, 2,
        'filter() must not remove records from the blueprint');
});

// ---------------------------------------------------------------------------
// Tier 1 — diff()
// ---------------------------------------------------------------------------

test('[T1] diff — blueprint diffed against itself returns all empty arrays', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'a.dds' }));
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 0, indexOffset: 10, decodedName: 'b.dds' }));
    const result = bp.diff(bp);
    assert.deepEqual(result.added,   []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.changed, []);
});

test('[T1] diff — added record detected', () => {
    const bp1 = new Blueprint('fp1');
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));

    const bp2 = new Blueprint('fp2');
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 0, indexOffset: 10 }));

    const result = bp1.diff(bp2);
    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].fileFingerprint, 'b');
    assert.deepEqual(result.removed, []);
});

test('[T1] diff — removed record detected', () => {
    const bp1 = new Blueprint('fp1');
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 0, indexOffset: 10 }));

    const bp2 = new Blueprint('fp2');
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));

    const result = bp1.diff(bp2);
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].fileFingerprint, 'b');
    assert.deepEqual(result.added, []);
});

test('[T1] diff — changed record (packOffset moved) detected', () => {
    const bp1 = new Blueprint('fp1');
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));

    const bp2 = new Blueprint('fp2');
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 9999, indexOffset: 0 }));

    const result = bp1.diff(bp2);
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0].fileFingerprint, 'a');
    assert.deepEqual(result.added,   []);
    assert.deepEqual(result.removed, []);
});

test('[T1] diff — changed record (packId changed) detected', () => {
    const bp1 = new Blueprint('fp1');
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0 }));

    const bp2 = new Blueprint('fp2');
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 4, packOffset: 0, indexOffset: 0 }));

    const result = bp1.diff(bp2);
    assert.equal(result.changed.length, 1);
});

// ---------------------------------------------------------------------------
// Tier 1 — toCSV()
// ---------------------------------------------------------------------------

test('[T1] toCSV — header row is correct', () => {
    const bp  = new Blueprint('fp');
    const csv = bp.toCSV();
    const header = csv.split('\n')[0];
    assert.equal(header, 'indexOffset,packOffset,packId,fileFingerprint,decodedName,size');
});

test('[T1] toCSV — data row count equals record count', () => {
    const bp = new Blueprint('fp');
    for (let i = 0; i < 5; i++) {
        bp.addRecord(new BlueprintRecord({
            indexOffset: i * 10, packOffset: 0, packId: 1,
            fileFingerprint: `fp${i}`, datapackFingerprint: null, decodedName: `file${i}.dds`
        }));
    }
    const lines = bp.toCSV().split('\n');
    const dataLines = lines.slice(1).filter(l => l.trim().length > 0);
    assert.equal(dataLines.length, 5);
});

test('[T1] toCSV — resolves decodedName from store when provided', () => {
    const bp  = new Blueprint('fp');
    const rec = new BlueprintRecord({
        indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'hash-abc', datapackFingerprint: null, decodedName: 'hero.dds'
    });
    bp.addRecord(rec);

    const mockStore = makeMockStore([
        makeFpRecord({ hash: 'hash-abc', decodedName: 'hero.dds', size: 512 })
    ]);
    const csv = bp.toCSV(mockStore);
    assert.ok(csv.includes('hero.dds'), 'CSV must include the resolved decodedName');
    assert.ok(csv.includes('512'),      'CSV must include the resolved size');
});

test('[T1] toCSV — falls back to fileFingerprint when store not provided', () => {
    const bp  = new Blueprint('fp');
    const rec = new BlueprintRecord({
        indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'my-hash-value', datapackFingerprint: null
    });
    bp.addRecord(rec);
    const csv = bp.toCSV();
    assert.ok(csv.includes('my-hash-value'),
        'CSV must include fileFingerprint when store is not provided');
});

// ---------------------------------------------------------------------------
// Tier 1 — toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

test('[T1] toJSON / fromJSON — indexFingerprint survives', () => {
    const bp      = new Blueprint('my-fingerprint-12345');
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.indexFingerprint, 'my-fingerprint-12345');
});

test('[T1] toJSON / fromJSON — totalSize survives', () => {
    const bp       = new Blueprint('fp');
    bp.totalSize   = 99999;
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.totalSize, 99999);
});

test('[T1] toJSON / fromJSON — uniqueCount survives', () => {
    const bp        = new Blueprint('fp');
    bp.uniqueCount  = 42;
    const restored  = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.uniqueCount, 42);
});

test('[T1] toJSON / fromJSON — generatedAt survives as a Date', () => {
    const bp       = new Blueprint('fp');
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.ok(restored.generatedAt instanceof Date);
});

test('[T1] toJSON / fromJSON — record count survives', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'a.dds' }));
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 0, indexOffset: 10, decodedName: 'b.dds' }));
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.getRecords().length, 2);
});

test('[T1] toJSON / fromJSON — first record packId survives', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 5, packOffset: 0, indexOffset: 0, decodedName: 'a.dds' }));
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.getRecords()[0].packId, 5);
});

test('[T1] toJSON / fromJSON — second record packOffset survives', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0,    indexOffset: 0 }));
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 1024, indexOffset: 10 }));
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.getRecords()[1].packOffset, 1024);
});

test('[T1] toJSON / fromJSON — records decodedName survives', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'npcinfo.cfg' }));
    const restored = Blueprint.fromJSON(bp.toJSON());
    assert.equal(restored.getRecords()[0].decodedName, 'npcinfo.cfg');
});

// ---------------------------------------------------------------------------
// Tier 1 — saveToDisk / loadFromDisk
// ---------------------------------------------------------------------------

test('[T1] saveToDisk — creates a file on disk', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp        = new Blueprint('save-test-fp');
        bp.totalSize    = 1000;
        bp.uniqueCount  = 2;
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'fp1', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'hero.dds' }));

        const savedPath = await bp.saveToDisk(tmpDir);
        assert.ok(fs.existsSync(savedPath), 'saveToDisk() must create a file on disk');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk — file is named {indexFingerprint}.json', async () => {
    const tmpDir = makeTempDir();
    try {
        const fp        = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const bp        = new Blueprint(fp);
        const savedPath = await bp.saveToDisk(tmpDir);
        assert.equal(path.basename(savedPath), `${fp}.json`);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — full round-trip preserves indexFingerprint', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp        = new Blueprint('roundtrip-fingerprint');
        bp.totalSize    = 512;
        bp.uniqueCount  = 1;
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'fp1', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'hero.dds' }));

        await bp.saveToDisk(tmpDir);
        const loaded = await Blueprint.loadFromDisk(tmpDir, 'roundtrip-fingerprint');
        assert.ok(loaded !== null, 'loadFromDisk() must return a Blueprint');
        assert.equal(loaded.indexFingerprint, 'roundtrip-fingerprint');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — totalSize survives', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp      = new Blueprint('fp-totalsize');
        bp.totalSize  = 99999;
        await bp.saveToDisk(tmpDir);
        const loaded  = await Blueprint.loadFromDisk(tmpDir, 'fp-totalsize');
        assert.equal(loaded.totalSize, 99999);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — uniqueCount survives', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp       = new Blueprint('fp-uniquecount');
        bp.uniqueCount = 77;
        await bp.saveToDisk(tmpDir);
        const loaded   = await Blueprint.loadFromDisk(tmpDir, 'fp-uniquecount');
        assert.equal(loaded.uniqueCount, 77);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — record count survives', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp = new Blueprint('fp-records');
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0, indexOffset: 0, decodedName: 'a.dds' }));
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 3, packOffset: 512, indexOffset: 20, decodedName: 'b.cfg' }));
        await bp.saveToDisk(tmpDir);
        const loaded = await Blueprint.loadFromDisk(tmpDir, 'fp-records');
        assert.equal(loaded.getRecords().length, 2);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — first record packId survives', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp = new Blueprint('fp-packid');
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 7, packOffset: 0, indexOffset: 0, decodedName: 'a.dds' }));
        await bp.saveToDisk(tmpDir);
        const loaded = await Blueprint.loadFromDisk(tmpDir, 'fp-packid');
        assert.equal(loaded.getRecords()[0].packId, 7);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] saveToDisk / loadFromDisk — second record packOffset survives', async () => {
    const tmpDir = makeTempDir();
    try {
        const bp = new Blueprint('fp-packoffset');
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0,    indexOffset: 0 }));
        bp.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 4096, indexOffset: 50 }));
        await bp.saveToDisk(tmpDir);
        const loaded = await Blueprint.loadFromDisk(tmpDir, 'fp-packoffset');
        assert.equal(loaded.getRecords()[1].packOffset, 4096);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('[T1] loadFromDisk — returns null for unknown fingerprint', async () => {
    const tmpDir = makeTempDir();
    try {
        const result = await Blueprint.loadFromDisk(tmpDir, 'nonexistent-fp-xyz');
        assert.equal(result, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Tier 1 — validatePackState()
// ---------------------------------------------------------------------------

test('[T1] validatePackState — no errors when all referenced packs are in the store', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({
        fileFingerprint: 'file-hash', datapackFingerprint: 'pack-hash',
        packId: 1, packOffset: 0, indexOffset: 0
    }));

    const mockStore = makeMockStore([
        makeFpRecord({ hash: 'file-hash', decodedName: 'hero.dds' }),
        makeFpRecord({ hash: 'pack-hash', decodedName: 'data.001', type: 'pack' })
    ]);

    const result = bp.validatePackState(mockStore);
    assert.deepEqual(result.errors, []);
});

test('[T1] validatePackState — error when pack fingerprint not found in store', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({
        fileFingerprint: 'file-hash', datapackFingerprint: 'missing-pack-hash',
        packId: 1, packOffset: 0, indexOffset: 0
    }));

    const mockStore = makeMockStore([
        makeFpRecord({ hash: 'file-hash', decodedName: 'hero.dds' })
        // 'missing-pack-hash' deliberately not registered
    ]);

    const result = bp.validatePackState(mockStore);
    assert.ok(result.errors.length > 0,
        'validatePackState() must report an error for a missing pack fingerprint');
    assert.equal(result.ok, false);
});

test('[T1] validatePackState — null datapackFingerprint entries are skipped (no error)', () => {
    const bp = new Blueprint('fp');
    bp.addRecord(new BlueprintRecord({
        fileFingerprint: 'file-hash', datapackFingerprint: null,
        packId: 1, packOffset: 0, indexOffset: 0
    }));

    const mockStore = makeMockStore([
        makeFpRecord({ hash: 'file-hash', decodedName: 'hero.dds' })
    ]);

    const result = bp.validatePackState(mockStore);
    assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Tier 1 — fingerprintFileMeta()
// ---------------------------------------------------------------------------

test('[T1] fingerprintFileMeta — returns a 64-char hex string',
    { skip: !FIXTURE_AVAILABLE },
    () => {
    const fp = Blueprint.fingerprintFileMeta(FIXTURE_INDEX);
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 64);
});

test('[T1] fingerprintFileMeta — is deterministic (same output on two calls)',
    { skip: !FIXTURE_AVAILABLE },
    () => {
    const fp1 = Blueprint.fingerprintFileMeta(FIXTURE_INDEX);
    const fp2 = Blueprint.fingerprintFileMeta(FIXTURE_INDEX);
    assert.equal(fp1, fp2, 'fingerprintFileMeta() must return the same value on repeated calls');
});

test('[T1] fingerprintFileMeta — changes when a different file is passed',
    { skip: !FIXTURE_AVAILABLE },
    () => {
    const fp1 = Blueprint.fingerprintFileMeta(FIXTURE_INDEX);
    const packPath = path.join(FIXTURE_DATA, 'data.001');
    if (!fs.existsSync(packPath)) return;
    const fp2 = Blueprint.fingerprintFileMeta(packPath);
    assert.notEqual(fp1, fp2,
        'fingerprintFileMeta() must produce different values for different files');
});

// ---------------------------------------------------------------------------
// Tier 2 — fingerprintFile()
// ---------------------------------------------------------------------------

test('[T2] fingerprintFile — returns SHA-256 matching expected/hashes.json for data.000',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const expectedHashes = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
    const computed       = await Blueprint.fingerprintFile(FIXTURE_INDEX);
    assert.equal(computed, expectedHashes['data.000'],
        'fingerprintFile(data.000) must match the hash in expected/hashes.json');
});

test('[T2] fingerprintFile — is async and returns a string',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const result = await Blueprint.fingerprintFile(FIXTURE_INDEX);
    assert.equal(typeof result, 'string');
    assert.equal(result.length, 64);
});

test('[T2] fingerprintFile — matches manual SHA-256 of the file content',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const buf      = fs.readFileSync(FIXTURE_INDEX);
    const manual   = sha256(buf);
    const computed = await Blueprint.fingerprintFile(FIXTURE_INDEX);
    assert.equal(computed, manual,
        'fingerprintFile() must match manually computed SHA-256 of file content');
});

// ---------------------------------------------------------------------------
// Tier 2 — loadFromDisk with fixture blueprint
// ---------------------------------------------------------------------------

test('[T2] loadFromDisk — loads fixture blueprint without throwing',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const fp = getFixtureBlueprintFingerprint();
    assert.ok(fp, 'fixture must contain at least one blueprint file');
    const bp = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    assert.ok(bp !== null, 'loadFromDisk() must return a Blueprint for the fixture fingerprint');
    assert.ok(bp instanceof Blueprint);
});

test('[T2] loadFromDisk — fixture blueprint record count matches expected/entries.json count',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const fp       = getFixtureBlueprintFingerprint();
    const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const bp       = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    assert.equal(bp.getRecords().length, expected.length,
        `blueprint record count (${bp.getRecords().length}) must match entries.json count (${expected.length})`);
});

test('[T2] loadFromDisk — fixture blueprint indexFingerprint matches the file it was built from',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const fp = getFixtureBlueprintFingerprint();
    const bp = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    assert.equal(bp.indexFingerprint, fp,
        'blueprint.indexFingerprint must match the fingerprint used to look it up');
});

test('[T2] loadFromDisk — every record has a non-zero packId (1–8)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const fp = getFixtureBlueprintFingerprint();
    const bp = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    for (const rec of bp.getRecords()) {
        assert.ok(rec.packId >= 1 && rec.packId <= 8,
            `record "${rec.decodedName}" has packId ${rec.packId} out of range 1–8`);
    }
});

test('[T2] loadFromDisk — every record has a decodedName matching expected/entries.json',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const fp       = getFixtureBlueprintFingerprint();
    const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const bp       = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);

    const expectedNames = new Set(expected.map(e => e.decodedName));
    for (const rec of bp.getRecords()) {
        assert.ok(expectedNames.has(rec.decodedName),
            `blueprint record "${rec.decodedName}" not found in expected/entries.json`);
    }
});

// ---------------------------------------------------------------------------
// Tier 2 — resolveAssetItems()
// ---------------------------------------------------------------------------

test('[T2] resolveAssetItems — returns correct item count',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));

    const items = await bp.resolveAssetItems(fpStore);
    assert.ok(items.length > 0, 'resolveAssetItems() must return at least one item');
    assert.ok(items.length <= expected.length,
        'resolveAssetItems() must not return more items than blueprint records');
});

test('[T2] resolveAssetItems — every returned item has a non-empty decodedName',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);

    const items = await bp.resolveAssetItems(fpStore);
    for (const item of items) {
        assert.ok(item.decodedName && item.decodedName.length > 0,
            'every resolved AssetItem must have a non-empty decodedName');
    }
});

test('[T2] resolveAssetItems — every returned item is an AssetItem instance',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);

    const items = await bp.resolveAssetItems(fpStore);
    for (const item of items) {
        assert.ok(item instanceof AssetItem,
            'resolveAssetItems() must return AssetItem instances');
    }
});

test('[T2] resolveAssetItems — every returned item has packId in range 1–8',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);

    const items = await bp.resolveAssetItems(fpStore);
    for (const item of items) {
        assert.ok(item.packId >= 1 && item.packId <= 8,
            `AssetItem "${item.decodedName}" has packId ${item.packId} out of range 1–8`);
    }
});

test('[T2] resolveAssetItems — packId and offset for non-zero entries match expected/entries.json',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    const expected    = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    const items = await bp.resolveAssetItems(fpStore);
    for (const item of items) {
        const exp = expectedMap.get(item.decodedName);
        if (!exp) continue;
        assert.equal(item.packId, exp.packId,
            `packId mismatch for "${item.decodedName}": got ${item.packId} expected ${exp.packId}`);
        assert.equal(item.offset, exp.offset,
            `offset mismatch for "${item.decodedName}": got ${item.offset} expected ${exp.offset}`);
    }
});

test('[T2] resolveAssetItems — every resolved item has an assetType',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);

    const items = await bp.resolveAssetItems(fpStore);
    for (const item of items) {
        assert.ok(item.assetType && item.assetType.length > 0,
            `AssetItem "${item.decodedName}" must have a non-empty assetType`);
    }
});

// ---------------------------------------------------------------------------
// Tier 2 — validatePackState with fixture store
// ---------------------------------------------------------------------------

test('[T2] validatePackState — no errors against fixture store',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const { fpStore } = await loadFixtureStores();
    const fp          = getFixtureBlueprintFingerprint();
    const bp          = await Blueprint.loadFromDisk(FIXTURE_STORE, fp);
    const result      = bp.validatePackState(fpStore);
    assert.deepEqual(result.errors, []);
});

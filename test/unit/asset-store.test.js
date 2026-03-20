'use strict';
/**
 * test/unit/asset-store.test.js
 *
 * Tier 2 — fixture-backed unit tests for AssetStore.
 * Reads from test/fixtures/store/ (real bucketed asset files).
 * All writes go to a unique temp dir under os.tmpdir() that is cleaned up
 * after each test group.
 *
 * Skips gracefully if the fixture store has not been generated yet.
 * Run fixture generation first:
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/3.generate-fixture.js
 *
 * Standalone runnable:
 *   node test/unit/asset-store.test.js
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const crypto = require('node:crypto');

const AssetStore = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_STORE = path.join(__dirname, '..', 'fixtures', 'store');

// The fixture store must contain at least one bucketed asset file.
// We detect this by checking for any two-char bucket subdirectory.
function fixtureAvailable() {
    if (!fs.existsSync(FIXTURE_STORE)) return false;
    const entries = fs.readdirSync(FIXTURE_STORE);
    return entries.some(e => /^[0-9a-f]{2}$/i.test(e) &&
        fs.statSync(path.join(FIXTURE_STORE, e)).isDirectory());
}

const FIXTURE_AVAILABLE = fixtureAvailable();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Create a unique temp dir for a test, returns its path. */
function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-test-'));
}

/** Recursively remove a temp dir. Safe to call even if dir doesn't exist. */
function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Collect the first N real asset files found in the fixture store.
 * Returns an array of { hash, ext, filePath } objects.
 * Only looks at two-char bucket directories.
 */
function collectFixtureAssets(n = 3) {
    const results = [];
    if (!fs.existsSync(FIXTURE_STORE)) return results;

    const buckets = fs.readdirSync(FIXTURE_STORE)
        .filter(e => /^[0-9a-f]{2}$/i.test(e));

    for (const bucket of buckets) {
        if (results.length >= n) break;
        const bucketDir = path.join(FIXTURE_STORE, bucket);
        if (!fs.statSync(bucketDir).isDirectory()) continue;

        const files = fs.readdirSync(bucketDir);
        for (const file of files) {
            if (results.length >= n) break;
            const dotIdx = file.indexOf('.');
            if (dotIdx === -1) continue;
            const hash = file.slice(0, dotIdx);
            const ext  = file.slice(dotIdx + 1);
            if (hash.length < 10) continue; // sanity check — must look like a real hash

            const filePath = path.join(bucketDir, file);
            const stat     = fs.statSync(filePath);
            if (stat.size === 0 && hash !== AssetStore.NULL_ASSET_HASH) continue; // skip empty non-sentinel

            results.push({ hash, ext, filePath });
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Static class properties
// ---------------------------------------------------------------------------

test('NULL_ASSET_HASH is a static class property (not instance property)', () => {
    // Access via AssetStore.NULL_ASSET_HASH — NOT via store.NULL_ASSET_HASH
    assert.ok(typeof AssetStore.NULL_ASSET_HASH === 'string',
        'NULL_ASSET_HASH must be accessible as AssetStore.NULL_ASSET_HASH');
    assert.ok(AssetStore.NULL_ASSET_HASH.length === 64,
        'NULL_ASSET_HASH must be a 64-char SHA-256 hex string');
});

test('NULL_ASSET_NAME is a static class property', () => {
    assert.ok(typeof AssetStore.NULL_ASSET_NAME === 'string',
        'NULL_ASSET_NAME must be accessible as AssetStore.NULL_ASSET_NAME');
    assert.equal(AssetStore.NULL_ASSET_NAME, '__null__');
});

test('NULL_ASSET_HASH is the SHA-256 of an empty buffer', () => {
    const expected = sha256(Buffer.alloc(0));
    assert.equal(AssetStore.NULL_ASSET_HASH, expected);
});

test('NULL_ASSET_HASH is not accessible on instances (it is a static property)', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        // Static props are not own instance properties — they live on the class
        assert.equal(
            Object.prototype.hasOwnProperty.call(store, 'NULL_ASSET_HASH'),
            false,
            'NULL_ASSET_HASH should not be an own property of instances'
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// hashBuffer static helper
// ---------------------------------------------------------------------------

test('hashBuffer — returns SHA-256 hex digest of a buffer', () => {
    const buf  = Buffer.from('test content');
    const hash = AssetStore.hashBuffer(buf);
    assert.equal(hash, sha256(buf));
});

test('hashBuffer — empty buffer returns NULL_ASSET_HASH', () => {
    assert.equal(AssetStore.hashBuffer(Buffer.alloc(0)), AssetStore.NULL_ASSET_HASH);
});

// ---------------------------------------------------------------------------
// rebuild() and exists() / getPath() — against the fixture store
// ---------------------------------------------------------------------------

test('rebuild() — finds fixture store files and populates index',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const store = new AssetStore(FIXTURE_STORE);
    await store.rebuild();

    const assets = collectFixtureAssets(1);
    assert.ok(assets.length > 0, 'fixture store must contain at least one real asset');

    const { hash } = assets[0];
    assert.equal(store.exists(hash), true,
        `exists() should return true for fixture hash ${hash.slice(0, 8)}...`);
});

test('rebuild() — getPath() returns an absolute path for a known fixture hash',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const store = new AssetStore(FIXTURE_STORE);
    await store.rebuild();

    const assets = collectFixtureAssets(1);
    assert.ok(assets.length > 0, 'fixture store must contain at least one real asset');

    const { hash } = assets[0];
    const resolved = store.getPath(hash);
    assert.ok(resolved !== null, 'getPath() should return a path for known hash');
    assert.ok(path.isAbsolute(resolved), 'getPath() must return an absolute path');
});

test('rebuild() — getPath() returns path to a file that actually exists on disk',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const store = new AssetStore(FIXTURE_STORE);
    await store.rebuild();

    const assets = collectFixtureAssets(1);
    const { hash } = assets[0];
    const resolved = store.getPath(hash);
    assert.ok(fs.existsSync(resolved),
        `File at getPath() result must exist on disk: ${resolved}`);
});

test('rebuild() — is idempotent (calling twice produces same results)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const store = new AssetStore(FIXTURE_STORE);
    await store.rebuild();
    const assets = collectFixtureAssets(1);
    const { hash } = assets[0];
    const path1 = store.getPath(hash);

    await store.rebuild();
    const path2 = store.getPath(hash);
    assert.equal(path2, path1, 'getPath() must return same result after second rebuild()');
});

// ---------------------------------------------------------------------------
// exists() / getPath() — empty store
// ---------------------------------------------------------------------------

test('exists() — returns false for unknown hash on empty store', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        assert.equal(store.exists('nonexistent-hash'), false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getPath() — returns null for unknown hash on empty store', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        assert.equal(store.getPath('nonexistent-hash'), null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('exists() — returns false before write, true after write', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('test asset content');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);

        assert.equal(store.exists(hash), false, 'should not exist before write');
        await store.write(buf, hash, 'dds');
        assert.equal(store.exists(hash), true, 'should exist after write');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

test('write() — returns an absolute path', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('write test content');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'tga');
        assert.ok(path.isAbsolute(written), 'write() must return an absolute path');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — file exists on disk at returned path', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('disk existence test');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'dds');
        assert.ok(fs.existsSync(written), 'file must exist at the path returned by write()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — file is in a bucket directory named by first two hash chars', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf    = Buffer.from('bucket structure test');
        const hash   = sha256(buf);
        const store  = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'xml');
        const bucket = path.basename(path.dirname(written));
        assert.equal(bucket, hash.slice(0, 2),
            'asset must be stored in a bucket dir named by the first 2 chars of its hash');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — filename is {hash}.{ext}', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('filename format test');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'cfg');
        assert.equal(path.basename(written), `${hash}.cfg`);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — file contents match the buffer written', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('content verification test content 12345');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'bin');
        const onDisk  = fs.readFileSync(written);
        assert.deepEqual(onDisk, buf);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — deduplication: second write returns same path', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf    = Buffer.from('deduplication test content');
        const hash   = sha256(buf);
        const store  = new AssetStore(tmpDir);
        const path1  = await store.write(buf, hash, 'dds');
        const path2  = await store.write(buf, hash, 'dds');
        assert.equal(path2, path1, 'second write of same hash must return same path');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — deduplication: no duplicate file created on second write', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('no duplicate file test');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'tga');
        const bucket  = path.dirname(written);

        await store.write(buf, hash, 'tga'); // second write

        const bucketFiles = fs.readdirSync(bucket);
        assert.equal(bucketFiles.length, 1,
            'bucket must contain exactly one file after duplicate write');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — getPath() returns the written path after write()', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('getPath after write test');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'naf');
        assert.equal(store.getPath(hash), written);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('write() — creates bucket directory if it does not exist', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf    = Buffer.from('auto mkdir test content');
        const hash   = sha256(buf);
        const store  = new AssetStore(tmpDir);
        const bucket = path.join(tmpDir, hash.slice(0, 2));

        assert.equal(fs.existsSync(bucket), false, 'bucket dir should not exist yet');
        await store.write(buf, hash, 'dds');
        assert.ok(fs.existsSync(bucket), 'write() must create the bucket directory');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

test('verify() — matched: intact file returns status "matched" and isValid() true',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const store = new AssetStore(FIXTURE_STORE);
    await store.rebuild();

    const assets = collectFixtureAssets(1);
    assert.ok(assets.length > 0, 'need at least one fixture asset');
    const { hash, filePath } = assets[0];

    const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
    const record = new FingerprintRecord({
        hash,
        type:          'asset',
        decodedName:   'fixture.dds',
        size:          fs.statSync(filePath).size,
        extractedPath: filePath
    });

    const result = await store.verify(record);
    assert.equal(result.status,    'matched');
    assert.equal(result.isValid(), true);
    assert.equal(result.actualHash, hash);
});

test('verify() — missing: non-existent path returns status "missing"', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
        const record = new FingerprintRecord({
            hash:          'aaabbbccc',
            type:          'asset',
            decodedName:   'ghost.dds',
            size:          0,
            extractedPath: path.join(tmpDir, 'does', 'not', 'exist.dds')
        });

        const result = await store.verify(record);
        assert.equal(result.status,    'missing');
        assert.equal(result.isValid(), false);
        assert.equal(result.actualHash, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('verify() — missing: null extractedPath returns status "missing"', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
        const record = new FingerprintRecord({
            hash:          'aaabbbccc',
            type:          'asset',
            decodedName:   'ghost.dds',
            extractedPath: null
        });

        const result = await store.verify(record);
        assert.equal(result.status, 'missing');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('verify() — changed: tampered file returns status "changed"', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('original content for tamper test');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'dds');

        // Tamper with the file
        fs.writeFileSync(written, Buffer.from('tampered content'));

        const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
        const record = new FingerprintRecord({
            hash,
            type:          'asset',
            decodedName:   'test.dds',
            extractedPath: written
        });

        const result = await store.verify(record);
        assert.equal(result.status,    'changed');
        assert.equal(result.isValid(), false);
        assert.notEqual(result.actualHash, hash);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('verify() — expectedHash is record.hash in all cases', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));
        const record = new FingerprintRecord({
            hash:          'some-expected-hash',
            type:          'asset',
            decodedName:   'ghost.dds',
            extractedPath: path.join(tmpDir, 'nonexistent.dds')
        });

        const result = await store.verify(record);
        assert.equal(result.expectedHash, 'some-expected-hash');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

test('delete() — returns true when file exists and is deleted', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('delete me please');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        await store.write(buf, hash, 'xml');

        const result = await store.delete(hash);
        assert.equal(result, true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('delete() — file is removed from disk after delete()', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf     = Buffer.from('delete disk test');
        const hash    = sha256(buf);
        const store   = new AssetStore(tmpDir);
        const written = await store.write(buf, hash, 'cfg');

        await store.delete(hash);
        assert.equal(fs.existsSync(written), false, 'file must not exist on disk after delete()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('delete() — exists() returns false after delete()', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('delete index test');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);
        await store.write(buf, hash, 'nfm');

        await store.delete(hash);
        assert.equal(store.exists(hash), false, 'exists() must return false after delete()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('delete() — getPath() returns null after delete()', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('delete getPath test');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);
        await store.write(buf, hash, 'dds');

        await store.delete(hash);
        assert.equal(store.getPath(hash), null, 'getPath() must return null after delete()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('delete() — returns false for unknown hash', async () => {
    const tmpDir = makeTempDir();
    try {
        const store  = new AssetStore(tmpDir);
        const result = await store.delete('completely-unknown-hash');
        assert.equal(result, false);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// ensureNullAsset()
// ---------------------------------------------------------------------------

test('ensureNullAsset() — creates an empty file at the bucketed null hash path', () => {
    const tmpDir = makeTempDir();
    try {
        const store    = new AssetStore(tmpDir);
        const nullPath = store.ensureNullAsset();

        assert.ok(fs.existsSync(nullPath), 'null sentinel file must exist after ensureNullAsset()');
        const stat = fs.statSync(nullPath);
        assert.equal(stat.size, 0, 'null sentinel file must be empty (0 bytes)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — returned path contains the NULL_ASSET_HASH', () => {
    const tmpDir = makeTempDir();
    try {
        const store    = new AssetStore(tmpDir);
        const nullPath = store.ensureNullAsset();
        assert.ok(nullPath.includes(AssetStore.NULL_ASSET_HASH),
            'returned path must include the NULL_ASSET_HASH');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — exists() returns true for NULL_ASSET_HASH after call', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        store.ensureNullAsset();
        assert.equal(store.exists(AssetStore.NULL_ASSET_HASH), true,
            'exists(NULL_ASSET_HASH) must return true after ensureNullAsset()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — idempotent: calling twice produces exactly one file', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        store.ensureNullAsset();
        store.ensureNullAsset(); // second call

        const nullHash  = AssetStore.NULL_ASSET_HASH;
        const bucketDir = path.join(tmpDir, nullHash.slice(0, 2));
        const files     = fs.readdirSync(bucketDir);
        assert.equal(files.length, 1,
            'exactly one file must exist in null sentinel bucket after two ensureNullAsset() calls');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — idempotent: second call returns the same path as the first', () => {
    const tmpDir = makeTempDir();
    try {
        const store = new AssetStore(tmpDir);
        const path1 = store.ensureNullAsset();
        const path2 = store.ensureNullAsset();
        assert.equal(path2, path1,
            'ensureNullAsset() must return the same path on second call');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — getPath(NULL_ASSET_HASH) works after call', () => {
    const tmpDir = makeTempDir();
    try {
        const store    = new AssetStore(tmpDir);
        const nullPath = store.ensureNullAsset();
        assert.equal(store.getPath(AssetStore.NULL_ASSET_HASH), nullPath);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// rebuild() with newly written files
// ---------------------------------------------------------------------------

test('rebuild() — picks up files written before rebuild() was called', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('rebuild picks up prior writes');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);

        await store.write(buf, hash, 'dds');

        // Create a second store instance pointing at the same dir — simulates restart
        const store2 = new AssetStore(tmpDir);
        await store2.rebuild();

        assert.equal(store2.exists(hash), true,
            'rebuild() must find files written by a previous store instance');
        assert.ok(store2.getPath(hash) !== null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('rebuild() — getPath() returns an absolute path after rebuild', async () => {
    const tmpDir = makeTempDir();
    try {
        const buf   = Buffer.from('rebuild absolute path test');
        const hash  = sha256(buf);
        const store = new AssetStore(tmpDir);
        await store.write(buf, hash, 'cfg');

        const store2   = new AssetStore(tmpDir);
        await store2.rebuild();
        const resolved = store2.getPath(hash);

        assert.ok(path.isAbsolute(resolved),
            'getPath() must return an absolute path after rebuild()');
    } finally {
        cleanupDir(tmpDir);
    }
});

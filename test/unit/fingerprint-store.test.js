'use strict';
/**
 * test/unit/fingerprint-store.test.js
 *
 * Tier 2 — fixture-backed unit tests for FingerprintStore.
 * Reads from test/fixtures/store/fingerprints.jsonl.
 * All writes go to a unique temp dir under os.tmpdir() that is cleaned up
 * after each test.
 *
 * Skips gracefully if the fixture store has not been generated yet.
 *
 * Standalone runnable:
 *   node test/unit/fingerprint-store.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const crypto   = require('node:crypto');

const AssetStore        = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));
const FingerprintStore  = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintStore'));
const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_STORE   = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_FP_PATH = path.join(FIXTURE_STORE, 'fingerprints.jsonl');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_FP_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fp-store-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Build a minimal FingerprintStore backed by a temp dir.
 * The AssetStore is pointed at the same temp dir.
 * Returns { store, assetStore, tmpDir, dbPath }.
 */
function makeTempStore() {
    const tmpDir    = makeTempDir();
    const dbPath    = path.join(tmpDir, 'fingerprints.jsonl');
    const assetStore = new AssetStore(tmpDir);
    const store     = new FingerprintStore(dbPath, assetStore);
    return { store, assetStore, tmpDir, dbPath };
}

/**
 * Parse the fixture JSONL and return all records as plain objects.
 * Used to derive known-good values for assertions without going through
 * FingerprintStore's own load() method.
 */
function loadFixtureRaw() {
    if (!FIXTURE_AVAILABLE) return [];
    const lines = fs.readFileSync(FIXTURE_FP_PATH, 'utf8')
        .split('\n')
        .filter(l => l.trim());
    return lines.map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// load() — fixture-backed
// ---------------------------------------------------------------------------

test('load() — parses fixture JSONL without throwing',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await assert.doesNotReject(() => store.load());
});

test('load() — every unique name::hash combination from the fixture is present in list()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    // The JSONL may contain multiple lines for the same name::hash primary key
    // (e.g. stub upgrades re-append the same record with an updated extractedPath).
    // list() deduplicates by primary key, so list().length <= JSONL line count.
    // The correct invariant is: every unique name::hash from the raw file resolves.
    const raw        = loadFixtureRaw();
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    // Build the set of unique primary keys from the raw file
    const uniqueKeys = new Set(raw.map(r => `${r.decodedName}::${r.hash}`));

    assert.ok(store.list().length >= 1, 'store must contain at least one record after load()');
    assert.ok(store.list().length <= raw.length,
        'store.list() count must be <= JSONL line count (duplicates are collapsed)');
    assert.equal(store.list().length, uniqueKeys.size,
        `store.list() count (${store.list().length}) must match unique name::hash count (${uniqueKeys.size})`);
});

test('load() — is idempotent (calling twice gives same record count)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();
    const count1 = store.list().length;
    await store.load();
    const count2 = store.list().length;
    assert.equal(count2, count1, 'load() must be idempotent — calling twice must not double records');
});

test('load() — has() returns true for every hash in the fixture',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const raw        = loadFixtureRaw();
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    for (const record of raw) {
        assert.equal(store.has(record.hash), true,
            `has() must return true for fixture hash: ${record.hash.slice(0, 16)}...`);
    }
});

test('load() — getByName() returns a record for every decodedName in the fixture',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const raw        = loadFixtureRaw();
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    for (const record of raw) {
        const result = store.getByName(record.decodedName);
        assert.ok(result !== null,
            `getByName() must return a record for "${record.decodedName}"`);
    }
});

// ---------------------------------------------------------------------------
// list() filtering
// ---------------------------------------------------------------------------

test('list() — without type argument returns all records',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    const all    = store.list();
    const assets = store.list('asset');
    const packs  = store.list('pack');
    const indexes = store.list('index');
    assert.equal(all.length, assets.length + packs.length + indexes.length,
        'list() total must equal sum of typed sublists');
});

test('list("asset") — all returned records have type "asset"',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    const assets = store.list('asset');
    assert.ok(assets.length > 0, 'fixture must contain asset records');
    assert.ok(assets.every(r => r.type === 'asset'),
        'list("asset") must only return records with type "asset"');
});

// ---------------------------------------------------------------------------
// has() / get() / getByName() — pure in-memory (no fixture needed)
// ---------------------------------------------------------------------------

test('has() — returns false for unknown hash on fresh store', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        assert.equal(store.has('unknown-hash'), false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('get() — returns null for unknown hash on fresh store', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        assert.equal(store.get('unknown-hash'), null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getByName() — returns null for unknown name on fresh store', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        assert.equal(store.getByName('unknown.dds'), null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('has() — returns true after register()', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('has test content');
        const record = await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(store.has(record.hash), true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('get() — returns canonical record for hash after register()', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('get test content');
        const record = await store.register(buf, 'asset', 'hero.dds', null);
        const fetched = store.get(record.hash);
        assert.ok(fetched !== null);
        assert.equal(fetched.decodedName, 'hero.dds');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getByName() — returns record with correct name after register()', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('getByName test content');
        await store.register(buf, 'asset', 'npcinfo.cfg', null);
        const result = store.getByName('npcinfo.cfg');
        assert.ok(result !== null);
        assert.equal(result.decodedName, 'npcinfo.cfg');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// hasExact() — all four identity cases
// ---------------------------------------------------------------------------

test('hasExact() — true for exact same name + same hash (exact duplicate)', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('exact duplicate test');
        const hash   = sha256(buf);
        await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(store.hasExact('hero.dds', hash), true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('hasExact() — false for same name + different hash (updated file)', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf  = Buffer.from('original content');
        const hash = sha256(buf);
        await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(store.hasExact('hero.dds', 'completely-different-hash'), false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('hasExact() — false for different name + same hash (content alias)', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf  = Buffer.from('shared content for alias test');
        const hash = sha256(buf);
        await store.register(buf, 'asset', 'canonical.dds', null);
        assert.equal(store.hasExact('alias.dds', hash), false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('hasExact() — false for different name + different hash (unrelated)', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('some content');
        await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(store.hasExact('other.dds', 'other-hash'), false);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// register() — deduplication
// ---------------------------------------------------------------------------

test('register() — exact duplicate returns the existing record', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf     = Buffer.from('dedup test');
        const first   = await store.register(buf, 'asset', 'hero.dds', null);
        const second  = await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(second.hash, first.hash,
            'second register of same name+hash must return same record');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — exact duplicate does not increase record count', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('dedup count test');
        await store.register(buf, 'asset', 'hero.dds', null);
        const count1 = store.list().length;
        await store.register(buf, 'asset', 'hero.dds', null);
        const count2 = store.list().length;
        assert.equal(count2, count1, 'duplicate register must not add a new record');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — different name same hash is a content alias', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf      = Buffer.from('shared bytes for alias test');
        const canonical = await store.register(buf, 'asset', 'canonical.dds', null);
        const alias     = await store.register(buf, 'asset', 'alias.dds',     null);

        assert.equal(alias.isAlias, true,
            'second registration with same hash under different name must be an alias');
        assert.equal(alias.aliasOf, canonical.hash,
            'aliasOf must point to the canonical hash');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — alias record increases list() count by 1', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('alias count test');
        await store.register(buf, 'asset', 'canonical.dds', null);
        const count1 = store.list().length;
        await store.register(buf, 'asset', 'alias.dds', null);
        const count2 = store.list().length;
        assert.equal(count2, count1 + 1, 'alias registration must add exactly one new record');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — canonical record is isAlias=false', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf       = Buffer.from('canonical alias test');
        const canonical = await store.register(buf, 'asset', 'canonical.dds', null);
        assert.equal(canonical.isAlias, false);
        assert.equal(canonical.aliasOf, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — different name different hash is an unrelated new record', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf1 = Buffer.from('content a');
        const buf2 = Buffer.from('content b');
        await store.register(buf1, 'asset', 'hero.dds',    null);
        const second = await store.register(buf2, 'asset', 'monster.dds', null);
        assert.equal(second.isAlias, false, 'different name + different hash must not be an alias');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — alias inherits extractedPath from canonical when not provided', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        const buf      = Buffer.from('alias extractedPath inheritance test');
        const hash     = sha256(buf);
        const filePath = await assetStore.write(buf, hash, 'dds');

        const canonical = await store.register(buf, 'asset', 'canonical.dds', filePath);
        const alias     = await store.register(buf, 'asset', 'alias.dds',     null);

        assert.equal(alias.extractedPath, filePath,
            'alias must inherit extractedPath from canonical when none is provided');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — stub upgrade: extractedPath patched in on second register', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        const buf  = Buffer.from('stub upgrade test');
        const hash = sha256(buf);

        // First register as a stub (no extractedPath)
        const stub = await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(stub.extractedPath, null, 'stub must have null extractedPath');

        // Second register with real path — should patch the existing record
        const filePath = await assetStore.write(buf, hash, 'dds');
        const upgraded = await store.register(buf, 'asset', 'hero.dds', filePath);

        assert.equal(upgraded.hash, stub.hash, 'upgraded record must have same hash');
        assert.equal(upgraded.extractedPath, filePath,
            'stub must be upgraded with real extractedPath on second register');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — size parameter overrides buffer.length', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('size override test');
        const record = await store.register(buf, 'asset', 'hero.dds', null, 99999);
        assert.equal(record.size, 99999,
            'size parameter must override buffer.length in the stored record');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — size defaults to buffer.length when not provided', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('size default test');
        const record = await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(record.size, buf.length);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — hash is SHA-256 of the buffer', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('hash verification test content');
        const record = await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(record.hash, sha256(buf));
    } finally {
        cleanupDir(tmpDir);
    }
});

test('register() — type stored correctly for asset/pack/index', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const asset = await store.register(Buffer.from('a'), 'asset', 'hero.dds',  null);
        const pack  = await store.register(Buffer.from('b'), 'pack',  'data.003',  null);
        const index = await store.register(Buffer.from('c'), 'index', 'data.000',  null);
        assert.equal(asset.type, 'asset');
        assert.equal(pack.type,  'pack');
        assert.equal(index.type, 'index');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Alias lookup — regression guard
// ---------------------------------------------------------------------------

test('Regression: getByName() on alias name returns alias record, not canonical',
    async () => {
    // Regression: without decodedName on BlueprintRecord, resolveFile() used
    // store.get(hash) which returns the canonical record. For aliases this
    // returned the WRONG decodedName, causing the alias to be written with
    // the canonical's name in the output index.
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('shared bytes for alias lookup regression test');
        await store.register(buf, 'asset', 'canonical.dds', null);
        await store.register(buf, 'asset', 'alias.dds',     null);

        // getByName('alias.dds') must return the alias's own record
        const aliasRecord = store.getByName('alias.dds');
        assert.ok(aliasRecord !== null,
            'getByName() must find the alias record by its own name');
        assert.equal(aliasRecord.decodedName, 'alias.dds',
            'getByName() must return the alias record — NOT the canonical record');
        assert.equal(aliasRecord.isAlias, true,
            'the record returned must be the alias (isAlias=true)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('get(hash) returns the canonical record (first registered for that hash)', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('canonical vs alias get test');
        await store.register(buf, 'asset', 'canonical.dds', null);
        await store.register(buf, 'asset', 'alias.dds',     null);

        const canonical = store.get(sha256(buf));
        assert.equal(canonical.decodedName, 'canonical.dds',
            'get(hash) must return the canonical record (first registered)');
        assert.equal(canonical.isAlias, false);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// pruneStubs()
// ---------------------------------------------------------------------------

test('pruneStubs() — removes null-path stubs superseded by real records', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        const buf  = Buffer.from('prune stub test content');
        const hash = sha256(buf);

        // Register stub first (no extractedPath)
        await store.register(buf, 'asset', 'hero.dds', null);
        assert.equal(store.list('asset').length, 1);

        // Register real record with extractedPath
        const filePath = await assetStore.write(buf, hash, 'dds');
        await store.register(buf, 'asset', 'hero.dds', filePath);

        // Before prune: the stub upgrade path may already have updated the record.
        // pruneStubs() removes null-path stubs that have a real record for the same name.
        const pruned = await store.pruneStubs();
        // After pruning, exactly one record for this name should remain
        const remaining = store.list('asset');
        assert.equal(remaining.length, 1, 'exactly one record should remain after pruning');
        assert.ok(remaining[0].extractedPath !== null,
            'remaining record must have a real extractedPath');
        assert.ok(typeof pruned === 'number',
            'pruneStubs() must return a number (count of removed records)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('pruneStubs() — returns 0 when there are no stubs to remove', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        const buf      = Buffer.from('no stubs here');
        const hash     = sha256(buf);
        const filePath = await assetStore.write(buf, hash, 'dds');
        await store.register(buf, 'asset', 'hero.dds', filePath);

        const pruned = await store.pruneStubs();
        assert.equal(pruned, 0, 'pruneStubs() must return 0 when no stubs exist');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('pruneStubs() — leaves real records intact', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        const buf1 = Buffer.from('real record content a');
        const buf2 = Buffer.from('real record content b');
        const h1   = sha256(buf1);
        const h2   = sha256(buf2);
        const p1   = await assetStore.write(buf1, h1, 'dds');
        const p2   = await assetStore.write(buf2, h2, 'tga');
        await store.register(buf1, 'asset', 'hero.dds',    p1);
        await store.register(buf2, 'asset', 'monster.tga', p2);

        await store.pruneStubs();

        assert.ok(store.getByName('hero.dds')    !== null, 'hero.dds must survive prune');
        assert.ok(store.getByName('monster.tga') !== null, 'monster.tga must survive prune');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Persistence — JSONL written and readable
// ---------------------------------------------------------------------------

test('register() — writes to the .jsonl file on disk', async () => {
    const { store, dbPath, tmpDir } = makeTempStore();
    try {
        const buf = Buffer.from('persistence write test');
        await store.register(buf, 'asset', 'hero.dds', null);
        assert.ok(fs.existsSync(dbPath), '.jsonl file must be created after register()');
        const content = fs.readFileSync(dbPath, 'utf8').trim();
        assert.ok(content.length > 0, '.jsonl file must not be empty after register()');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('load() after register() — records survive a reload from disk', async () => {
    const { store, assetStore, dbPath, tmpDir } = makeTempStore();
    try {
        const buf    = Buffer.from('persistence reload test');
        const record = await store.register(buf, 'asset', 'hero.dds', null);

        // Create a new store instance pointing at the same JSONL — simulates restart
        const store2 = new FingerprintStore(dbPath, assetStore);
        await store2.load();

        assert.equal(store2.has(record.hash), true,
            'record must be found by hash after reload from disk');
        const reloaded = store2.getByName('hero.dds');
        assert.ok(reloaded !== null, 'getByName() must find record after reload');
        assert.equal(reloaded.hash,        record.hash);
        assert.equal(reloaded.decodedName, 'hero.dds');
        assert.equal(reloaded.type,        'asset');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('load() — does not throw on empty or non-existent .jsonl file', async () => {
    const { store, tmpDir } = makeTempStore();
    try {
        // dbPath does not exist yet — load() should handle this gracefully
        await assert.doesNotReject(() => store.load());
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// ensureNullAsset()
// ---------------------------------------------------------------------------

test('ensureNullAsset() — registers a FingerprintRecord for the null sentinel', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        assetStore.ensureNullAsset(); // file must exist before FingerprintStore registers it
        const record = await store.ensureNullAsset();

        assert.ok(record instanceof FingerprintRecord,
            'ensureNullAsset() must return a FingerprintRecord');
        assert.equal(record.hash, AssetStore.NULL_ASSET_HASH);
        assert.equal(record.decodedName, AssetStore.NULL_ASSET_NAME);
        assert.equal(record.type, 'asset');
        assert.equal(record.size, 0);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — idempotent: second call returns same record, no duplicate', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        assetStore.ensureNullAsset();
        const first  = await store.ensureNullAsset();
        const second = await store.ensureNullAsset();
        assert.equal(second.hash, first.hash,
            'second ensureNullAsset() call must return the same record');
        // list() must not contain duplicate null-asset records
        const nullRecords = store.list('asset')
            .filter(r => r.hash === AssetStore.NULL_ASSET_HASH);
        assert.equal(nullRecords.length, 1,
            'exactly one null-asset record must exist after two ensureNullAsset() calls');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('ensureNullAsset() — has(NULL_ASSET_HASH) returns true after call', async () => {
    const { store, assetStore, tmpDir } = makeTempStore();
    try {
        assetStore.ensureNullAsset();
        await store.ensureNullAsset();
        assert.equal(store.has(AssetStore.NULL_ASSET_HASH), true);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Alias detection — fixture-backed
// ---------------------------------------------------------------------------

test('fixture — alias records exist in the primary index (hasExact)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    // #nameIndex is last-write-wins: getByName() may return a later non-alias
    // record for the same name (e.g. a stub upgrade re-appended without isAlias).
    // The correct check is hasExact(name, hash) which queries #primary directly,
    // then inspect the record retrieved from #primary via get(hash).
    const raw     = loadFixtureRaw();
    const aliases = raw.filter(r => r.isAlias === true);

    if (aliases.length === 0) {
        // Fixture may not contain aliases depending on seed — informational pass
        return;
    }

    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    for (const alias of aliases) {
        // Confirm the alias primary key exists
        assert.equal(
            store.hasExact(alias.decodedName, alias.hash),
            true,
            `alias record "${alias.decodedName}" (hash ${alias.hash.slice(0,8)}...) must exist in primary index`
        );
        // aliasOf must be set in the raw record
        assert.ok(alias.aliasOf !== null && alias.aliasOf !== undefined,
            `raw alias record for "${alias.decodedName}" must have aliasOf set`);
    }
});

test('fixture — canonical records for aliases are retrievable by get(aliasOf) and are isAlias=false',
    // TODO: known bug — FingerprintStore.register() can produce orphaned aliases
    // where no isAlias=false canonical exists for a given content hash.
    // Example: hash 605cc4cf6bbf... has two records in the fixture JSONL, both
    // isAlias=true, with no isAlias=false entry. get(aliasOf) therefore returns
    // an alias record rather than a canonical, causing this assertion to fail.
    // Root cause is in register() or the extraction pipeline call ordering.
    // See bug report: "Orphaned Alias Records in FingerprintStore".
    { skip: !FIXTURE_AVAILABLE, todo: 'known bug: orphaned aliases in fixture — register() must guarantee first record per hash is isAlias=false. https://github.com/pswart197833/rz-datapack-manager/issues/1'},
    async () => {
    const raw     = loadFixtureRaw();
    const aliases = raw.filter(r => r.isAlias === true);

    if (aliases.length === 0) return;

    const assetStore = new AssetStore(FIXTURE_STORE);
    const store      = new FingerprintStore(FIXTURE_FP_PATH, assetStore);
    await store.load();

    for (const alias of aliases) {
        if (!alias.aliasOf) continue;
        const canonical = store.get(alias.aliasOf);
        assert.ok(canonical !== null,
            `get(aliasOf) must return a record for alias "${alias.decodedName}"`);
        assert.equal(canonical.isAlias, false,
            `canonical for "${alias.decodedName}" must have isAlias=false — #hashIndex is first-write-wins`);
    }
});

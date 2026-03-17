'use strict';
/**
 * Phase C — VerificationResult, FingerprintRecord, AssetStore, FingerprintStore
 * ------------------------------------------------------------------------------
 * Run: npm run test:c
 *
 * Tests the full storage and fingerprinting layer.
 * Extracts a small sample of real assets from the pack files to exercise
 * the write path end-to-end.
 */

const fs                 = require('fs');
const path               = require('path');
const crypto             = require('crypto');
const VerificationResult = require('../src/fingerprint/VerificationResult');
const FingerprintRecord  = require('../src/fingerprint/FingerprintRecord');
const AssetStore         = require('../src/core/AssetStore');
const FingerprintStore   = require('../src/fingerprint/FingerprintStore');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label}`);
        console.log(`         expected: ${JSON.stringify(expected)}`);
        console.log(`         actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
}

function assertTruthy(label, actual) {
    if (actual) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label} — value was falsy: ${JSON.stringify(actual)}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

(async () => {
try {


const DATA_DIR    = path.join(__dirname, '..', 'data');
const STORE_DIR   = path.join(__dirname, '..', 'store');
const SESSION_DIR = path.join(__dirname, '..', 'sessions');
const DB_PATH     = path.join(__dirname, '..', 'store', 'fingerprints.jsonl');

// Clean up any previous test run
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

// ---------------------------------------------------------------------------
// VerificationResult tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase C: VerificationResult ===\n');

{
    const mockRecord = new FingerprintRecord({
        hash: 'abc123', type: 'asset', decodedName: 'hero.dds', size: 1024
    });

    const matched = new VerificationResult({
        record: mockRecord, status: 'matched',
        expectedHash: 'abc123', actualHash: 'abc123'
    });
    assert('isValid() — matched status returns true', matched.isValid(), true);

    const missing = new VerificationResult({
        record: mockRecord, status: 'missing',
        expectedHash: 'abc123', actualHash: null
    });
    assert('isValid() — missing status returns false', missing.isValid(), false);

    const changed = new VerificationResult({
        record: mockRecord, status: 'changed',
        expectedHash: 'abc123', actualHash: 'def456'
    });
    assert('isValid() — changed status returns false', changed.isValid(), false);

    const json = matched.toJSON();
    assert('toJSON() — status field present',       json.status,       'matched');
    assert('toJSON() — expectedHash field present', json.expectedHash, 'abc123');
    assertTruthy('toJSON() — verifiedAt field present', json.verifiedAt);
}

// ---------------------------------------------------------------------------
// FingerprintRecord tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase C: FingerprintRecord ===\n');

{
    const asset = new FingerprintRecord({
        hash: 'aaa', type: 'asset', decodedName: 'hero.dds',
        size: 512, extractedPath: '/store/aa/aaa.dds'
    });
    assert('isAsset() — true for asset type',  asset.isAsset(), true);
    assert('isPack()  — false for asset type', asset.isPack(),  false);
    assert('isIndex() — false for asset type', asset.isIndex(), false);

    const pack = new FingerprintRecord({ hash: 'bbb', type: 'pack', decodedName: 'data.003', size: 1024 });
    assert('isPack()  — true for pack type',   pack.isPack(),  true);
    assert('isAsset() — false for pack type',  pack.isAsset(), false);

    const index = new FingerprintRecord({ hash: 'ccc', type: 'index', decodedName: 'data.000', size: 256 });
    assert('isIndex() — true for index type',  index.isIndex(), true);

    // toJSON / fromJSON round-trip
    const json     = asset.toJSON();
    const restored = FingerprintRecord.fromJSON(json);
    assert('fromJSON — hash survives round-trip',          restored.hash,          asset.hash);
    assert('fromJSON — type survives round-trip',          restored.type,          asset.type);
    assert('fromJSON — decodedName survives round-trip',   restored.decodedName,   asset.decodedName);
    assert('fromJSON — extractedPath survives round-trip', restored.extractedPath, asset.extractedPath);
    assert('fromJSON — size survives round-trip',          restored.size,          asset.size);
}

// ---------------------------------------------------------------------------
// AssetStore tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase C: AssetStore ===\n');

const store = new AssetStore(STORE_DIR);

// Ensure store dir exists for tests
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

{
    // Write a synthetic buffer
    const buffer  = Buffer.from('test asset content for phase c');
    const hash    = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext     = 'dds';

    // Test exists() before write
    assert('exists() — false before write', store.exists(hash), false);
    assert('getPath() — null before write', store.getPath(hash), null);

    // Write
    const writtenPath = await store.write(buffer, hash, ext);
    assertTruthy('write() — returns a non-empty path', writtenPath);
    assert('write() — file exists on disk', fs.existsSync(writtenPath), true);

    // Verify bucketed structure
    const expectedBucket = hash.slice(0, 2);
    assert('write() — file is in correct bucket directory',
        path.dirname(writtenPath).endsWith(expectedBucket), true
    );
    assert('write() — filename is hash.ext',
        path.basename(writtenPath), `${hash}.${ext}`
    );

    // Test exists() and getPath() after write
    assert('exists() — true after write',         store.exists(hash),   true);
    assert('getPath() — returns path after write', store.getPath(hash), writtenPath);

    // Write same buffer again — should return existing path, not duplicate
    const secondPath = await store.write(buffer, hash, ext);
    assert('write() — deduplication returns same path on second write', secondPath, writtenPath);

    // Verify file count in bucket (should be exactly 1)
    const bucketDir   = path.dirname(writtenPath);
    const bucketFiles = fs.readdirSync(bucketDir);
    assert('write() — only one file in bucket after duplicate write', bucketFiles.length, 1);
}

// Test rebuild() — clear in-memory index and rebuild from disk
{
    const store2 = new AssetStore(STORE_DIR);
    await store2.rebuild();
    assert('rebuild() — finds previously written asset after rebuild',
        store2.exists(crypto.createHash('sha256').update(Buffer.from('test asset content for phase c')).digest('hex')),
        true
    );
}

// Test verify() — matched
{
    const buffer  = Buffer.from('verify test content');
    const hash    = crypto.createHash('sha256').update(buffer).digest('hex');
    const written = await store.write(buffer, hash, 'tga');

    const record = new FingerprintRecord({
        hash, type: 'asset', decodedName: 'verify_test.tga',
        size: buffer.length, extractedPath: written
    });

    const result = await store.verify(record);
    assert('verify() — matched status for intact file', result.status,  'matched');
    assert('verify() — isValid() true for matched',     result.isValid(), true);
    assert('verify() — actualHash equals expectedHash', result.actualHash, result.expectedHash);
}

// Test verify() — missing
{
    const record = new FingerprintRecord({
        hash: 'nonexistent', type: 'asset', decodedName: 'ghost.dds',
        size: 0, extractedPath: '/nonexistent/path/ghost.dds'
    });
    const result = await store.verify(record);
    assert('verify() — missing status for nonexistent file', result.status,   'missing');
    assert('verify() — actualHash is null for missing file', result.actualHash, null);
}

// Test delete()
{
    const buffer  = Buffer.from('delete me');
    const hash    = crypto.createHash('sha256').update(buffer).digest('hex');
    await store.write(buffer, hash, 'xml');
    assert('delete() — exists before delete', store.exists(hash), true);
    const deleted = await store.delete(hash);
    assert('delete() — returns true',               deleted,            true);
    assert('delete() — no longer exists after delete', store.exists(hash), false);
}

// ---------------------------------------------------------------------------
// FingerprintStore tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase C: FingerprintStore ===\n');

const fpStore = new FingerprintStore(DB_PATH, store);
await fpStore.load();

{
    // Register an asset — write to AssetStore first so extractedPath is real
    const buffer        = Buffer.from('fingerprint store test asset');
    const hash          = crypto.createHash('sha256').update(buffer).digest('hex');
    const extractedPath = await store.write(buffer, hash, 'dds');
    const record        = await fpStore.register(buffer, 'asset', 'test_asset.dds', extractedPath);

    assertTruthy('register() — returns a FingerprintRecord',     record instanceof FingerprintRecord);
    assertTruthy('register() — record has a hash',               record.hash);
    assert(      'register() — record type is asset',            record.type, 'asset');
    assert(      'register() — decodedName stored correctly',    record.decodedName, 'test_asset.dds');
    assert(      'register() — size matches buffer length',      record.size, buffer.length);

    // has() and get()
    assert('has() — true after register',  fpStore.has(record.hash),  true);
    assert('get() — returns correct record', fpStore.get(record.hash).decodedName, 'test_asset.dds');

    // Deduplication — register same buffer again
    const record2 = await fpStore.register(buffer, 'asset', 'test_asset.dds', extractedPath);
    assert('register() — deduplication returns same hash', record2.hash, record.hash);

    // getByName()
    const byName = fpStore.getByName('test_asset.dds');
    assert('getByName() — finds record by decodedName', byName.hash, record.hash);
    assert('getByName() — returns null for unknown name', fpStore.getByName('unknown.dds'), null);
}

// Register pack and index records
{
    const packBuffer  = Buffer.from('mock pack file content');
    const indexBuffer = Buffer.from('mock index file content');

    await fpStore.register(packBuffer,  'pack',  'data.003', null);
    await fpStore.register(indexBuffer, 'index', 'data.000', null);
}

// list() filtering
{
    const assets  = fpStore.list('asset');
    const packs   = fpStore.list('pack');
    const indexes = fpStore.list('index');
    const all     = fpStore.list();

    assertTruthy('list(asset)  — returns at least 1 asset',  assets.length  >= 1);
    assertTruthy('list(pack)   — returns at least 1 pack',   packs.length   >= 1);
    assertTruthy('list(index)  — returns at least 1 index',  indexes.length >= 1);
    assert('list(asset) — all results are type asset',
        assets.every(r => r.type === 'asset'), true
    );
    assert('list() — total equals sum of filtered lists',
        all.length, assets.length + packs.length + indexes.length
    );
}

// Persistence — reload from disk and verify records survive
{
    const fpStore2 = new FingerprintStore(DB_PATH, store);
    await fpStore2.load();

    const allOriginal = fpStore.list();
    const allReloaded = fpStore2.list();

    assert('persistence — record count survives reload', allReloaded.length, allOriginal.length);
    assertTruthy('persistence — .jsonl file exists on disk', fs.existsSync(DB_PATH));

    // Verify a specific record survives
    const sample = fpStore.list('asset')[0];
    const reloaded = fpStore2.get(sample.hash);
    assertTruthy('persistence — record retrievable by hash after reload', reloaded !== null);
    assert('persistence — decodedName intact after reload', reloaded.decodedName, sample.decodedName);
}

// prune() — add a record with a nonexistent path, then prune it
{
    const ghostBuffer = Buffer.from('ghost asset that will be pruned');
    const ghostRecord = await fpStore.register(ghostBuffer, 'asset', 'ghost.dds', '/nonexistent/ghost.dds');
    assertTruthy('prune setup — ghost record registered', fpStore.has(ghostRecord.hash));

    const pruned = await fpStore.prune();
    assert('prune() — removes 1 orphaned record', pruned, 1);
    assert('prune() — orphaned record no longer in store', fpStore.has(ghostRecord.hash), false);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}\n`);

if (failed > 0) process.exit(1);
} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

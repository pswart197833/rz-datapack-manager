'use strict';
/**
 * Phase D — BlueprintRecord + Blueprint
 * ---------------------------------------
 * Run: npm run test:d
 *
 * Tests blueprint creation, persistence, and resolveAssetItems()
 * against a small real sample from the parsed index.
 */

const fs                 = require('fs');
const path               = require('path');
const crypto             = require('crypto');
const Blueprint          = require('../src/fingerprint/Blueprint');
const BlueprintRecord    = require('../src/fingerprint/BlueprintRecord');
const FingerprintRecord  = require('../src/fingerprint/FingerprintRecord');
const FingerprintStore   = require('../src/fingerprint/FingerprintStore');
const AssetStore         = require('../src/core/AssetStore');
const DataPackIndex      = require('../src/core/DataPackIndex');
const PackConfiguration  = require('../src/config/PackConfiguration');

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
// Setup
// ---------------------------------------------------------------------------

const DATA_DIR   = path.join(__dirname, '..', 'data');
const STORE_DIR  = path.join(__dirname, '..', 'store');
const DB_PATH    = path.join(STORE_DIR, 'fingerprints.jsonl');
const INDEX_PATH = path.join(DATA_DIR, 'data.000');

(async () => {
try {

// ---------------------------------------------------------------------------
// BlueprintRecord tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase D: BlueprintRecord ===\n');

{
    const rec = new BlueprintRecord({
        indexOffset:         100,
        packOffset:          2048,
        packId:              3,
        fileFingerprint:     'aabbcc',
        datapackFingerprint: 'ddeeff'
    });

    assert('indexOffset stored correctly',         rec.indexOffset,         100);
    assert('packOffset stored correctly',          rec.packOffset,          2048);
    assert('packId stored correctly',              rec.packId,              3);
    assert('fileFingerprint stored correctly',     rec.fileFingerprint,     'aabbcc');
    assert('datapackFingerprint stored correctly', rec.datapackFingerprint, 'ddeeff');

    // toJSON / fromJSON round-trip
    const restored = BlueprintRecord.fromJSON(rec.toJSON());
    assert('fromJSON — indexOffset survives round-trip',         restored.indexOffset,         rec.indexOffset);
    assert('fromJSON — packOffset survives round-trip',          restored.packOffset,          rec.packOffset);
    assert('fromJSON — packId survives round-trip',              restored.packId,              rec.packId);
    assert('fromJSON — fileFingerprint survives round-trip',     restored.fileFingerprint,     rec.fileFingerprint);
    assert('fromJSON — datapackFingerprint survives round-trip', restored.datapackFingerprint, rec.datapackFingerprint);
}

// resolveFile / resolvePack via mock store
{
    const mockStore = {
        get: (hash) => {
            if (hash === 'file-hash')  return new FingerprintRecord({ hash: 'file-hash',  type: 'asset', decodedName: 'hero.dds', size: 512 });
            if (hash === 'pack-hash')  return new FingerprintRecord({ hash: 'pack-hash',  type: 'pack',  decodedName: 'data.003', size: 1024 });
            return null;
        }
    };

    const rec = new BlueprintRecord({
        fileFingerprint: 'file-hash', datapackFingerprint: 'pack-hash',
        indexOffset: 0, packOffset: 0, packId: 3
    });

    const fileRecord = rec.resolveFile(mockStore);
    const packRecord = rec.resolvePack(mockStore);

    assert('resolveFile() — returns correct FingerprintRecord', fileRecord.decodedName, 'hero.dds');
    assert('resolvePack() — returns correct FingerprintRecord', packRecord.decodedName, 'data.003');
    assert('resolveFile() — returns null for missing hash',
        new BlueprintRecord({ fileFingerprint: 'unknown' }).resolveFile(mockStore), null
    );
}

// ---------------------------------------------------------------------------
// Blueprint — construction and basic operations
// ---------------------------------------------------------------------------

console.log('\n=== Phase D: Blueprint (construction) ===\n');

{
    const bp = new Blueprint('test-index-fingerprint');

    assert('Blueprint — indexFingerprint set correctly', bp.indexFingerprint, 'test-index-fingerprint');
    assertTruthy('Blueprint — generatedAt is a Date', bp.generatedAt instanceof Date);
    assert('Blueprint — starts with empty records', bp.getRecords().length, 0);

    // addRecord
    const rec1 = new BlueprintRecord({ indexOffset: 0,   packOffset: 0,    packId: 1, fileFingerprint: 'fp1', datapackFingerprint: 'pp1' });
    const rec2 = new BlueprintRecord({ indexOffset: 100, packOffset: 1024, packId: 2, fileFingerprint: 'fp2', datapackFingerprint: 'pp2' });
    const rec3 = new BlueprintRecord({ indexOffset: 200, packOffset: 2048, packId: 3, fileFingerprint: 'fp3', datapackFingerprint: 'pp3' });

    bp.addRecord(rec1);
    bp.addRecord(rec2);
    bp.addRecord(rec3);

    assert('addRecord — record count correct',     bp.getRecords().length, 3);
    assert('getRecords — preserves insertion order', bp.getRecords()[1].fileFingerprint, 'fp2');

    // filter
    const filtered = bp.filter(r => r.packId === 2);
    assert('filter — returns matching records', filtered.length, 1);
    assert('filter — correct record returned',  filtered[0].fileFingerprint, 'fp2');
}

// ---------------------------------------------------------------------------
// Blueprint — toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

console.log('\n=== Phase D: Blueprint (serialization) ===\n');

{
    const bp = new Blueprint('roundtrip-fp');
    bp.totalSize   = 999;
    bp.uniqueCount = 3;
    bp.addRecord(new BlueprintRecord({ indexOffset: 0, packOffset: 512, packId: 1, fileFingerprint: 'a1', datapackFingerprint: 'b1' }));
    bp.addRecord(new BlueprintRecord({ indexOffset: 50, packOffset: 1024, packId: 2, fileFingerprint: 'a2', datapackFingerprint: 'b2' }));

    const json     = bp.toJSON();
    const restored = Blueprint.fromJSON(json);

    assert('fromJSON — indexFingerprint survives', restored.indexFingerprint, bp.indexFingerprint);
    assert('fromJSON — totalSize survives',        restored.totalSize,        bp.totalSize);
    assert('fromJSON — uniqueCount survives',      restored.uniqueCount,      bp.uniqueCount);
    assert('fromJSON — record count survives',     restored.getRecords().length, bp.getRecords().length);
    assert('fromJSON — first record packId',       restored.getRecords()[0].packId, 1);
    assert('fromJSON — second record packOffset',  restored.getRecords()[1].packOffset, 1024);
}

// ---------------------------------------------------------------------------
// Blueprint — diff
// ---------------------------------------------------------------------------

{
    const bp1 = new Blueprint('fp1');
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0,    indexOffset: 0   }));
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 1024, indexOffset: 100 }));
    bp1.addRecord(new BlueprintRecord({ fileFingerprint: 'c', packId: 3, packOffset: 2048, indexOffset: 200 }));

    const bp2 = new Blueprint('fp2');
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'a', packId: 1, packOffset: 0,    indexOffset: 0   })); // same
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'b', packId: 2, packOffset: 9999, indexOffset: 100 })); // changed offset
    bp2.addRecord(new BlueprintRecord({ fileFingerprint: 'd', packId: 4, packOffset: 512,  indexOffset: 300 })); // added

    const result = bp1.diff(bp2);
    assert('diff — 1 record added',   result.added.length,   1);
    assert('diff — 1 record removed', result.removed.length, 1);
    assert('diff — 1 record changed', result.changed.length, 1);
    assert('diff — added is fp d',    result.added[0].fileFingerprint,   'd');
    assert('diff — removed is fp c',  result.removed[0].fileFingerprint, 'c');
    assert('diff — changed is fp b',  result.changed[0].fileFingerprint, 'b');
}

// ---------------------------------------------------------------------------
// Blueprint — real data.000 generation
// ---------------------------------------------------------------------------

console.log('\n=== Phase D: Blueprint (real data) ===\n');

if (!fs.existsSync(INDEX_PATH)) {
    console.log('  [SKIP] data.000 not found');
    process.exit(0);
}

// Load the asset store and fingerprint store from Phase C run
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();

const fpStore = new FingerprintStore(DB_PATH, assetStore);
await fpStore.load();

// Parse data.000
console.log('  Parsing data.000...');
const indexBuffer      = fs.readFileSync(INDEX_PATH);
const indexFingerprint = crypto.createHash('sha256').update(indexBuffer).digest('hex');
const index            = new DataPackIndex();
index.parse(indexBuffer);
console.log(`  ${index.entries.length.toLocaleString()} entries parsed`);
console.log(`  Index fingerprint: ${indexFingerprint.slice(0, 16)}...\n`);

// Register the index file itself in FingerprintStore
const indexRecord = await fpStore.register(indexBuffer, 'index', 'data.000', null);

// Register pack file fingerprints for data.001--.008
const packRecords = {};
for (let slot = 1; slot <= 8; slot++) {
    const packPath = path.join(DATA_DIR, `data.00${slot}`);
    if (fs.existsSync(packPath)) {
        const packBuffer = fs.readFileSync(packPath);
        packRecords[slot] = await fpStore.register(packBuffer, 'pack', `data.00${slot}`, null);
        console.log(`  Registered data.00${slot} fingerprint: ${packRecords[slot].hash.slice(0,16)}...`);
    }
}

// Build a blueprint from the first 20 entries only (fast test)
console.log('\n  Building blueprint from first 20 entries...');
const bp = new Blueprint(indexFingerprint);

for (let i = 0; i < Math.min(20, index.entries.length); i++) {
    const entry      = index.entries[i];
    const packRecord = packRecords[entry.packId];

    // Register a synthetic asset fingerprint (we don't have real content yet — Phase E)
    // Use entry metadata as a deterministic synthetic buffer for testing
    const syntheticBuffer = Buffer.from(`${entry.decodedName}|${entry.offset}|${entry.size}`);
    const assetRecord     = await fpStore.register(
        syntheticBuffer, 'asset', entry.decodedName, null
    );

    bp.addRecord(new BlueprintRecord({
        indexOffset:         entry.indexOffset,
        packOffset:          entry.offset,
        packId:              entry.packId,
        fileFingerprint:     assetRecord.hash,
        datapackFingerprint: packRecord ? packRecord.hash : null
    }));
}

bp.totalSize   = index.entries.slice(0, 20).reduce((s, e) => s + e.size, 0);
bp.uniqueCount = 20;

assertTruthy('real blueprint — has records',                   bp.getRecords().length > 0);
assert('real blueprint — record count matches sample size',    bp.getRecords().length, 20);
assertTruthy('real blueprint — first record has fileFingerprint', bp.getRecords()[0].fileFingerprint);
assertTruthy('real blueprint — first record has packId',          bp.getRecords()[0].packId >= 1);

// Save to disk and reload
const savedPath = await bp.saveToDisk(STORE_DIR);
assertTruthy('saveToDisk — file created on disk', fs.existsSync(savedPath));

const loaded = await Blueprint.loadFromDisk(STORE_DIR, indexFingerprint);
assertTruthy('loadFromDisk — returns a Blueprint',       loaded !== null);
assert('loadFromDisk — indexFingerprint matches',        loaded.indexFingerprint, bp.indexFingerprint);
assert('loadFromDisk — record count matches',            loaded.getRecords().length, bp.getRecords().length);
assert('loadFromDisk — first record packId matches',     loaded.getRecords()[0].packId, bp.getRecords()[0].packId);
assert('loadFromDisk — first record packOffset matches', loaded.getRecords()[0].packOffset, bp.getRecords()[0].packOffset);

// loadFromDisk returns null for unknown fingerprint
const missing = await Blueprint.loadFromDisk(STORE_DIR, 'nonexistent-fingerprint');
assert('loadFromDisk — returns null for unknown fingerprint', missing, null);

// resolveAssetItems — reconstruct AssetItem[] from blueprint records
const items = await bp.resolveAssetItems(fpStore);
assert('resolveAssetItems — returns correct item count', items.length, 20);
assertTruthy('resolveAssetItems — first item has decodedName', items[0].decodedName.length > 0);
assertTruthy('resolveAssetItems — first item has assetType',   items[0].assetType.length > 0);
assertTruthy('resolveAssetItems — first item has packId',      items[0].packId >= 1);

// toCSV
const csv = bp.toCSV(fpStore);
const csvLines = csv.split('\n');
assert('toCSV — has header row',    csvLines[0], 'indexOffset,packOffset,packId,fileFingerprint,decodedName,size');
assert('toCSV — has correct number of data rows', csvLines.length - 1, 20);

// validatePackState
const validation = bp.validatePackState(fpStore);
assert('validatePackState — no errors with registered packs', validation.errors, []);

// fingerprintFile static method
const computedFp = await Blueprint.fingerprintFile(INDEX_PATH);
assert('fingerprintFile — matches manually computed fingerprint', computedFp, indexFingerprint);

console.log(`\n  Blueprint saved to: ${savedPath}`);
console.log(`  Total size of sample: ${bp.totalSize.toLocaleString()} bytes`);

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

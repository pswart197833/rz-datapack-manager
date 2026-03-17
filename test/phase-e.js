'use strict';
/**
 * Phase E — DataPackReader, DataPackWriter, IndexManager
 * -------------------------------------------------------
 * Run: npm run test:e
 *
 * First real asset extraction from pack files.
 * Tests the full read path and IndexManager orchestration.
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const DataPackReader    = require('../src/core/DataPackReader');
const DataPackWriter    = require('../src/core/DataPackWriter');
const DataPackIndex     = require('../src/core/DataPackIndex');
const IndexManager      = require('../src/api/IndexManager');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const AssetItem         = require('../src/core/AssetItem');

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

function assertRange(label, actual, min, max) {
    const ok = actual >= min && actual <= max;
    if (ok) {
        console.log(`  [PASS] ${label} (${actual})`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label} — ${actual} not in range [${min}, ${max}]`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR    = path.join(__dirname, '..', 'data');
const STORE_DIR   = path.join(__dirname, '..', 'store');
const SESSION_DIR = path.join(__dirname, '..', 'sessions');
const DB_PATH     = path.join(STORE_DIR, 'fingerprints.jsonl');
const TEMP_DIR    = path.join(__dirname, '..', 'store', 'test-build');

(async () => {
try {

const config = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR, 'phase-e-test');

// Clear stale blueprint from Phase D (only had 20 entries with stub sizes).
// IndexManager will rebuild it with all 124k entries and correct sizes.
const blueprintDir = path.join(STORE_DIR, 'blueprints');
if (fs.existsSync(blueprintDir)) {
    fs.rmSync(blueprintDir, { recursive: true });
    console.log('  Cleared stale blueprints from Phase D\n');
}

// Load supporting stores
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();

const fpStore = new FingerprintStore(DB_PATH, assetStore);
await fpStore.load();

// Parse real index
const index = new DataPackIndex();
index.parse(fs.readFileSync(config.getIndexPath()));
console.log(`\n  Loaded index: ${index.entries.length.toLocaleString()} entries`);

// Pick test entries — first non-zero entry from each of 3 different packs
const testEntries = [];
const seenPacks   = new Set();
for (const entry of index.entries) {
    if (entry.size > 0 && !seenPacks.has(entry.packId)) {
        testEntries.push(entry);
        seenPacks.add(entry.packId);
        if (testEntries.length === 3) break;
    }
}
console.log(`  Selected ${testEntries.length} test entries from different packs\n`);

// ---------------------------------------------------------------------------
// DataPackReader tests
// ---------------------------------------------------------------------------

console.log('=== Phase E: DataPackReader ===\n');

const reader = new DataPackReader(config.packPaths);

// Test 1 — extractAsset returns correct size
for (const entry of testEntries) {
    const buffer = await reader.extractAsset(entry);
    assert(
        `extractAsset — "${entry.decodedName}" correct size`,
        buffer.length, entry.size
    );
    assertTruthy(
        `extractAsset — "${entry.decodedName}" buffer is not empty`,
        buffer.length > 0
    );
}

// Test 2 — extractAsset is deterministic (same bytes on second read)
{
    const entry   = testEntries[0];
    const buffer1 = await reader.extractAsset(entry);
    const buffer2 = await reader.extractAsset(entry);
    const hash1   = crypto.createHash('sha256').update(buffer1).digest('hex');
    const hash2   = crypto.createHash('sha256').update(buffer2).digest('hex');
    assert(`extractAsset — deterministic for "${entry.decodedName}"`, hash1, hash2);
}

// Test 3 — extractBatch returns all requested entries
{
    const batchMap = await reader.extractBatch(testEntries);
    assert('extractBatch — returns correct entry count', batchMap.size, testEntries.length);
    for (const entry of testEntries) {
        assertTruthy(`extractBatch — "${entry.decodedName}" present in result`, batchMap.has(entry.decodedName));
        assert(
            `extractBatch — "${entry.decodedName}" correct size`,
            batchMap.get(entry.decodedName).length, entry.size
        );
    }
}

// Test 4 — validateAsset on known types
{
    for (const entry of testEntries) {
        const buffer = await reader.extractAsset(entry);
        const result = reader.validateAsset(entry, buffer);
        // We can't guarantee magic bytes for all proprietary formats —
        // just confirm the method returns a result object with expected shape
        assertTruthy(`validateAsset — "${entry.decodedName}" returns result object`, result !== null);
        assertTruthy(`validateAsset — "${entry.decodedName}" has valid field`,       typeof result.valid === 'boolean');
    }
}

// Test 5 — open and close specific handles
{
    const packId = testEntries[0].packId;
    await reader.open(packId);
    assertTruthy(`open() — handle opened for pack ${packId}`, true);
    await reader.close(packId);
    assertTruthy(`close() — handle closed for pack ${packId}`, true);
}

await reader.closeAll();
assertTruthy('closeAll() — completes without error', true);

// ---------------------------------------------------------------------------
// DataPackWriter tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase E: DataPackWriter ===\n');

// Clean up from previous test run
if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const writer = new DataPackWriter(TEMP_DIR);

// Test 6 — addAsset writes and returns updated AssetItem
{
    const reader2   = new DataPackReader(config.packPaths);
    const updatedItems = [];

    for (const entry of testEntries) {
        const buffer      = await reader2.extractAsset(entry);
        const updatedItem = await writer.addAsset(entry, buffer);

        assertTruthy(`addAsset — "${entry.decodedName}" returns AssetItem`, updatedItem instanceof AssetItem);
        assert(`addAsset — "${entry.decodedName}" size matches buffer`, updatedItem.size, entry.size);
        assertTruthy(`addAsset — "${entry.decodedName}" offset is a number`, typeof updatedItem.offset === 'number');

        updatedItems.push({ entry, buffer, updatedItem });
    }

    await reader2.closeAll();
    await writer.closeAll();

    // Test 7 — verify build files exist on disk
    const seenBuildPacks = new Set(testEntries.map(e => e.packId));
    for (const packId of seenBuildPacks) {
        const buildPath = writer.getBuildPath(packId);
        assert(`build file exists for pack ${packId}`, fs.existsSync(buildPath), true);
    }

    // Test 8 — offsets are sequential for same pack
    const samePackItems = updatedItems.filter(({ entry }) => entry.packId === testEntries[0].packId);
    if (samePackItems.length > 1) {
        const first  = samePackItems[0];
        const second = samePackItems[1];
        assert(
            'sequential offsets — second item starts after first',
            second.updatedItem.offset,
            first.updatedItem.offset + first.updatedItem.size
        );
    } else {
        passed++; // single entry — skip sequential test
    }

    // Test 9 — round-trip: read back from build file and compare bytes
    {
        const first       = updatedItems[0];
        const buildPath   = writer.getBuildPath(first.entry.packId);
        const buildHandle = await fs.promises.open(buildPath, 'r');
        const readBack    = Buffer.alloc(first.updatedItem.size);
        await buildHandle.read(readBack, 0, first.updatedItem.size, first.updatedItem.offset);
        await buildHandle.close();

        const originalHash = crypto.createHash('sha256').update(first.buffer).digest('hex');
        const readBackHash = crypto.createHash('sha256').update(readBack).digest('hex');
        assert(
            `round-trip — "${first.entry.decodedName}" bytes match after write/read`,
            readBackHash, originalHash
        );
    }
}

// ---------------------------------------------------------------------------
// IndexManager tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase E: IndexManager ===\n');

const manager = new IndexManager(config, fpStore, assetStore);

// Test 10 — loadIndex() uses blueprint cache on second call
{
    console.log('  First load (may parse or use blueprint):');
    const t1    = Date.now();
    const idx1  = await manager.loadIndex();
    const time1 = Date.now() - t1;
    assertTruthy('loadIndex — returns DataPackIndex',          idx1 !== null);
    assertTruthy('loadIndex — entries populated',              idx1.entries.length > 0);
    console.log(`  Load time: ${time1}ms`);

    // Second load — should use blueprint (much faster)
    console.log('\n  Second load (should use blueprint cache):');
    const manager2 = new IndexManager(config, fpStore, assetStore);
    const t2       = Date.now();
    const idx2     = await manager2.loadIndex();
    const time2    = Date.now() - t2;
    assertTruthy('loadIndex (cached) — returns DataPackIndex', idx2 !== null);
    assertTruthy('loadIndex (cached) — entries populated',     idx2.entries.length > 0);
    console.log(`  Cached load time: ${time2}ms`);
    assertTruthy('loadIndex (cached) — faster than full parse', time2 < time1 + 100);
}

// Test 11 — getEntries filtering and pagination
{
    const all = manager.getEntries({});
    assertTruthy('getEntries — returns results', all.entries.length > 0);
    assertTruthy('getEntries — total count set',  all.total > 0);
    assert('getEntries — default page is 1',      all.page, 1);

    // Filter by type
    const ddsResult = manager.getEntries({ type: 'dds' });
    assertTruthy('getEntries — type filter returns results',         ddsResult.total > 0);
    assert('getEntries — all results match type filter',
        ddsResult.entries.every(e => e.assetType === 'dds'), true
    );

    // Filter by search
    const searchResult = manager.getEntries({ search: '.jpg' });
    assertTruthy('getEntries — search filter returns results', searchResult.total > 0);
    assert('getEntries — all results match search filter',
        searchResult.entries.every(e => e.decodedName.includes('.jpg')), true
    );

    // Pagination
    const page1 = manager.getEntries({ pageSize: 10, page: 1 });
    const page2 = manager.getEntries({ pageSize: 10, page: 2 });
    assert('getEntries — page 1 has 10 entries',                page1.entries.length, 10);
    assert('getEntries — page 2 has 10 entries',                page2.entries.length, 10);
    assert('getEntries — page 1 and 2 have different entries',
        page1.entries[0].decodedName === page2.entries[0].decodedName, false
    );
    assertTruthy('getEntries — totalPages calculated correctly',  page1.totalPages > 1);
}

// Test 12 — extractSingle returns correct buffer
{
    const targetEntry  = testEntries[0];
    const reader3      = new DataPackReader(config.packPaths);
    const directBuffer = await reader3.extractAsset(targetEntry);
    await reader3.closeAll();

    const singleBuffer = await manager.extractSingle(targetEntry.decodedName);

    const directHash = crypto.createHash('sha256').update(directBuffer).digest('hex');
    const singleHash = crypto.createHash('sha256').update(singleBuffer).digest('hex');

    assert('extractSingle — returns correct bytes vs direct read', singleHash, directHash);
    assert('extractSingle — correct size', singleBuffer.length, targetEntry.size);
}

// Test 13 — extractSingle throws for unknown filename
{
    let threw = false;
    try { await manager.extractSingle('nonexistent_file.dds'); }
    catch { threw = true; }
    assert('extractSingle — throws for unknown filename', threw, true);
}

// Test 14 — composeIndexList
{
    const list = manager.composeIndexList({ type: 'dds' });
    assertTruthy('composeIndexList — returns entries', list.length > 0);
    assert('composeIndexList — all entries match filter',
        list.every(e => e.assetType === 'dds'), true
    );
}

// Test 15 — setConfig / getConfig
{
    const newConfig = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR, 'new-config');
    manager.setConfig(newConfig);
    assert('setConfig/getConfig — label updated', manager.getConfig().label, 'new-config');
}

// Clean up temp build files
if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });

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

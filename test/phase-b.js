'use strict';
/**
 * Phase B — PackConfiguration + AssetItem + DataPackIndex
 * ---------------------------------------------------------
 * Run: npm run test:b
 *
 * Requires real data files in the ./data directory.
 * This is the first test that reads actual pack file data.
 */

const fs                = require('fs');
const path              = require('path');
const PackConfiguration = require('../src/config/PackConfiguration');
const DataPackIndex     = require('../src/core/DataPackIndex');

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
        console.log(`  [FAIL] ${label} — ${actual} is not in range [${min}, ${max}]`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Setup — build config pointing at ./data directory
// ---------------------------------------------------------------------------

const DATA_DIR   = path.join(__dirname, '..', 'data');
const STORE_DIR  = path.join(__dirname, '..', 'store');
const SESSION_DIR = path.join(__dirname, '..', 'sessions');

console.log('\n=== Phase B: PackConfiguration ===\n');

// ---------------------------------------------------------------------------
// PackConfiguration tests
// ---------------------------------------------------------------------------

// Test 1 — fromDirectory factory builds correct paths
{
    const config = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR, 'test');
    assert('fromDirectory — indexPath set correctly',
        config.getIndexPath(),
        path.join(DATA_DIR, 'data.000')
    );
    assert('fromDirectory — pack slot 1 path set correctly',
        config.getPackPath(1),
        path.join(DATA_DIR, 'data.001')
    );
    assert('fromDirectory — pack slot 8 path set correctly',
        config.getPackPath(8),
        path.join(DATA_DIR, 'data.008')
    );
    assert('fromDirectory — getPackPath for invalid slot returns null',
        config.getPackPath(9),
        null
    );
    assert('fromDirectory — label stored correctly',
        config.label, 'test'
    );
}

// Test 2 — listMissingPacks returns empty when all 8 slots filled
{
    const config  = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR);
    const missing = config.listMissingPacks();
    assert('listMissingPacks — all 8 slots filled returns empty array', missing, []);
}

// Test 3 — listMissingPacks identifies gaps
{
    const config = new PackConfiguration({
        indexPath:     path.join(DATA_DIR, 'data.000'),
        packPaths:     new Map([[1, 'a'], [3, 'c']]),
        assetStoreDir: STORE_DIR,
        sessionsDir:   SESSION_DIR
    });
    const missing = config.listMissingPacks();
    assert('listMissingPacks — correctly identifies missing slots',
        missing, [2, 4, 5, 6, 7, 8]
    );
}

// Test 4 — validate() against real data directory
{
    const config = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR);
    const result = config.validate();
    // store and sessions dirs may not exist yet — that is fine, just check index + packs
    const fatalErrors = result.errors.filter(e =>
        !e.includes('will be created')
    );
    assert('validate — no fatal errors against real data directory',
        fatalErrors, []
    );
}

// Test 5 — toJSON / fromJSON round-trip
{
    const config   = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR, 'round-trip');
    const json     = config.toJSON();
    const restored = PackConfiguration.fromJSON(json);
    assert('toJSON/fromJSON — indexPath survives round-trip',
        restored.getIndexPath(), config.getIndexPath()
    );
    assert('toJSON/fromJSON — pack slot 4 path survives round-trip',
        restored.getPackPath(4), config.getPackPath(4)
    );
    assert('toJSON/fromJSON — label survives round-trip',
        restored.label, config.label
    );
}

// ---------------------------------------------------------------------------
// DataPackIndex tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase B: DataPackIndex (real data.000) ===\n');

const INDEX_PATH = path.join(DATA_DIR, 'data.000');

if (!fs.existsSync(INDEX_PATH)) {
    console.log('  [SKIP] data.000 not found — copy pack files to ./data to run these tests');
    process.exit(0);
}

const index  = new DataPackIndex();
const buffer = fs.readFileSync(INDEX_PATH);

console.log(`  Loading data.000 (${(buffer.length / 1024).toFixed(1)} KB)...\n`);

const startTime = Date.now();
index.parse(buffer);
const elapsed = Date.now() - startTime;

console.log(`  Parsed ${index.entries.length.toLocaleString()} entries in ${elapsed}ms\n`);

// Test 6 — Parse produces entries
assertTruthy('parse — entries array is populated', index.entries.length > 0);

// Test 7 — Entry count is plausible (sanity check)
assertRange('parse — entry count is plausible (> 100)',
    index.entries.length, 100, 2000000
);

// Test 8 — rawBuffer retained
assertTruthy('parse — rawBuffer is retained', index.rawBuffer !== null);

// Test 9 — First entry has expected fields
{
    const first = index.entries[0];
    assertTruthy('first entry — has decodedName',   first.decodedName.length > 0);
    assertTruthy('first entry — has assetType',     first.assetType.length > 0);
    assertTruthy('first entry — has size > 0',      first.size > 0);
    assertRange( 'first entry — packId in range 1-8', first.packId, 1, 8);
    assert(      'first entry — indexOffset is 0',  first.indexOffset, 0);
}

// Test 10 — All entries have required fields
{
    let badName   = 0;
    let badPackId = 0;
    const zeroSize = [];

    for (const entry of index.entries) {
        if (!entry.decodedName || entry.decodedName.length === 0) badName++;
        if (entry.packId < 1 || entry.packId > 8)                 badPackId++;
        if (entry.size === 0)                                      zeroSize.push(entry.decodedName);
    }

    assert('all entries — no empty decoded names',  badName,   0);
    assert('all entries — no out-of-range packIds', badPackId, 0);

    // Zero-size entries are real in this format — treat as informational
    if (zeroSize.length > 0) {
        console.log(`  [ INFO] ${zeroSize.length} zero-size entries (placeholder/deleted):`);
        zeroSize.forEach(name => console.log(`    ${name}`));
    }
    passed++; // informational — always passes
}

// Test 11 — Asset type distribution (print for info, not a hard assertion)
{
    const typeCounts = {};
    for (const entry of index.entries) {
        typeCounts[entry.assetType] = (typeCounts[entry.assetType] || 0) + 1;
    }
    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    console.log('\n  Asset type distribution (top 10):');
    sorted.slice(0, 10).forEach(([type, count]) => {
        console.log(`    .${type.padEnd(8)} ${count.toLocaleString()}`);
    });
    console.log('');
    passed++; // Count as a passing informational test
}

// Test 12 — Validate reports no fatal errors
{
    const result = index.validate();
    assert('validate — no errors on real data', result.errors, []);
    if (result.warnings.length > 0) {
        console.log(`  [ INFO] ${result.warnings.length} validation warning(s):`);
        result.warnings.slice(0, 5).forEach(w => console.log(`    ${w}`));
    }
}

// Test 13 — Serialize → re-parse round-trip
{
    console.log('\n  Testing serialize → re-parse round-trip...');
    const serialized  = index.serialize(index.entries);
    const index2      = new DataPackIndex();
    index2.parse(serialized);

    assert('serialize/re-parse — entry count matches',
        index2.entries.length, index.entries.length
    );
    assert('serialize/re-parse — first entry decodedName matches',
        index2.entries[0].decodedName, index.entries[0].decodedName
    );
    assert('serialize/re-parse — first entry offset matches',
        index2.entries[0].offset, index.entries[0].offset
    );
    assert('serialize/re-parse — first entry size matches',
        index2.entries[0].size, index.entries[0].size
    );
    assert('serialize/re-parse — last entry decodedName matches',
        index2.entries[index2.entries.length - 1].decodedName,
        index.entries[index.entries.length - 1].decodedName
    );
}

// Test 14 — Diff of index against itself returns empty sets
{
    const result = index.diff(index);
    assert('diff — index diffed against itself has no added',   result.added,   []);
    assert('diff — index diffed against itself has no removed', result.removed, []);
    assert('diff — index diffed against itself has no changed', result.changed, []);
}

// Print a sample of entries for visual confirmation
console.log('\n  Sample entries (first 5):');
index.entries.slice(0, 5).forEach((e, i) => {
    console.log(`    [${i}] ${e.decodedName.padEnd(40)} pack:${e.packId}  size:${e.size.toLocaleString().padStart(10)}  offset:${e.offset}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}\n`);

if (failed > 0) process.exit(1);

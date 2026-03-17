'use strict';
/**
 * Phase F2 — CommitProgress, ProgressEntry, CommitPipeline
 * ----------------------------------------------------------
 * Run: npm run test:f2
 *
 * Tests the full commit pipeline against a COPY of real data files.
 * NEVER modifies the originals in ./data — all output goes to ./store/test-commit/
 *
 * The test builds a mini-pack containing just 5 real assets extracted
 * from the real pack files, commits them, and verifies the output.
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const ProgressEntry     = require('../src/session/ProgressEntry');
const CommitProgress    = require('../src/session/CommitProgress');
const CommitPipeline    = require('../src/session/CommitPipeline');
const SessionManager    = require('../src/session/SessionManager');
const DataPackIndex     = require('../src/core/DataPackIndex');
const DataPackReader    = require('../src/core/DataPackReader');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const Blueprint         = require('../src/fingerprint/Blueprint');

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
// Paths — all test output goes to store/test-commit, never touching ./data
// ---------------------------------------------------------------------------

const DATA_DIR        = path.join(__dirname, '..', 'data');
const STORE_DIR       = path.join(__dirname, '..', 'store');
const SESSION_DIR     = path.join(__dirname, '..', 'sessions');
const DB_PATH         = path.join(STORE_DIR, 'fingerprints.jsonl');
const TEST_OUTPUT_DIR = path.join(STORE_DIR, 'test-commit');
const TEST_STORE_DIR  = path.join(STORE_DIR, 'test-commit-assets');
const TEST_SESSION_DIR = path.join(SESSION_DIR, 'test-commit');

(async () => {
try {

// ---------------------------------------------------------------------------
// ProgressEntry tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase F2: ProgressEntry ===\n');

{
    const entry = new ProgressEntry({
        fileFingerprint: 'abc123', decodedName: 'hero.dds',
        packId: 3, category: 'new'
    });

    assert('isComplete — false initially',    entry.isComplete(), false);
    assert('nextStep — extracted first',      entry.nextStep(),   'extracted');

    entry.extracted = true;
    assert('nextStep — verified after extracted', entry.nextStep(), 'verified');

    entry.verified = true;
    assert('nextStep — packed after verified',    entry.nextStep(), 'packed');

    entry.packed = true;
    assert('nextStep — cleaned after packed',     entry.nextStep(), 'cleaned');

    entry.cleaned = true;
    assert('isComplete — true when all done',     entry.isComplete(), true);
    assert('nextStep — null when complete',        entry.nextStep(),   null);

    // toJSON / fromJSON
    const restored = ProgressEntry.fromJSON(entry.toJSON());
    assert('fromJSON — fileFingerprint survives', restored.fileFingerprint, entry.fileFingerprint);
    assert('fromJSON — decodedName survives',     restored.decodedName,     entry.decodedName);
    assert('fromJSON — packId survives',          restored.packId,          entry.packId);
    assert('fromJSON — all steps survives',       restored.isComplete(),    true);
}

// ---------------------------------------------------------------------------
// CommitProgress tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase F2: CommitProgress ===\n');

{
    const cp = new CommitProgress({
        sessionId:     'sess-001',
        packListPath:  '/tmp/pack-list.json',
        indexListPath: '/tmp/index-list.json'
    });

    assert('initial status is pending', cp.status, 'pending');
    assert('entries empty initially',   cp.entries.size, 0);

    // addEntry and getEntry
    const e1 = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds',    packId: 1, category: 'new' });
    const e2 = new ProgressEntry({ fileFingerprint: 'fp2', decodedName: 'monster.dds', packId: 2, category: 'in-store' });
    const e3 = new ProgressEntry({ fileFingerprint: 'fp3', decodedName: 'bg.tga',      packId: 3, category: 'new' });

    cp.addEntry(e1);
    cp.addEntry(e2);
    cp.addEntry(e3);

    assert('getEntry — finds entry by fingerprint', cp.getEntry('fp1').decodedName, 'hero.dds');
    assert('getEntry — returns null for unknown',   cp.getEntry('unknown'),         null);

    // markComplete
    cp.markComplete('fp1', 'extracted');
    cp.markComplete('fp1', 'verified');
    cp.markComplete('fp1', 'packed');
    cp.markComplete('fp1', 'cleaned');
    assert('isFileComplete — true after all steps', cp.isFileComplete('fp1'), true);
    assert('isFileComplete — false for incomplete',  cp.isFileComplete('fp2'), false);

    // pendingEntries
    const pending = cp.pendingEntries();
    assert('pendingEntries — returns 2 incomplete entries', pending.length, 2);
    assert('pendingEntries — fp1 not in pending',
        pending.every(e => e.fileFingerprint !== 'fp1'), true
    );

    // markComplete throws for unknown step
    let threw = false;
    try { cp.markComplete('fp2', 'invalid_step'); } catch { threw = true; }
    assert('markComplete — throws for unknown step', threw, true);

    // toJSON / fromJSON round-trip
    cp.status = 'building';
    const restored = CommitProgress.fromJSON(cp.toJSON());
    assert('fromJSON — sessionId survives',     restored.sessionId,       cp.sessionId);
    assert('fromJSON — status survives',        restored.status,          cp.status);
    assert('fromJSON — entries count survives', restored.entries.size,    cp.entries.size);
    assert('fromJSON — completed entry stays complete',
        restored.isFileComplete('fp1'), true
    );
}

// ---------------------------------------------------------------------------
// CommitPipeline integration test — real data
// ---------------------------------------------------------------------------

console.log('\n=== Phase F2: CommitPipeline (real data) ===\n');

if (!fs.existsSync(DATA_DIR) || !fs.existsSync(path.join(DATA_DIR, 'data.000'))) {
    console.log('  [SKIP] Real data files not found');
    process.exit(0);
}

// Clean up from previous test runs
[TEST_OUTPUT_DIR, TEST_STORE_DIR, TEST_SESSION_DIR].forEach(d => {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    fs.mkdirSync(d, { recursive: true });
});

// Set up test-specific stores (isolated from main store)
const testAssetStore = new AssetStore(TEST_STORE_DIR);
const testDbPath     = path.join(TEST_STORE_DIR, 'fingerprints.jsonl');
const testFpStore    = new FingerprintStore(testDbPath, testAssetStore);

// Set up a PackConfiguration pointing at TEST_OUTPUT_DIR as the output
// This means the pipeline will write data.000, data.001 etc. to TEST_OUTPUT_DIR
const testConfig = new PackConfiguration({
    indexPath:     path.join(TEST_OUTPUT_DIR, 'data.000'),
    packPaths:     new Map(
        Array.from({ length: 8 }, (_, i) => [i + 1, path.join(TEST_OUTPUT_DIR, `data.00${i + 1}`)])
    ),
    assetStoreDir: TEST_STORE_DIR,
    sessionsDir:   TEST_SESSION_DIR
});

// Parse the real data.000 to pick 5 small test assets
console.log('  Parsing real data.000 to select test assets...');
const realIndex  = new DataPackIndex();
const realBuffer = fs.readFileSync(path.join(DATA_DIR, 'data.000'));
realIndex.parse(realBuffer);

// Pick 5 small non-zero assets (prefer small ones for speed)
const testAssets = realIndex.entries
    .filter(e => e.size > 0 && e.size < 50000)
    .slice(0, 5);

console.log(`  Selected ${testAssets.length} test assets:`);
testAssets.forEach(e => console.log(`    ${e.decodedName} (${e.size.toLocaleString()} bytes, pack ${e.packId})`));

// Extract the real asset bytes from the real pack files
const realReader = new DataPackReader(
    new Map(Array.from({ length: 8 }, (_, i) => [i + 1, path.join(DATA_DIR, `data.00${i + 1}`)]))
);

const assetBuffers = new Map();
for (const entry of testAssets) {
    const buffer = await realReader.extractAsset(entry);
    assetBuffers.set(entry.decodedName, buffer);
}
await realReader.closeAll();
console.log('  Assets extracted from real pack files\n');

// Write test assets to temp files in TEST_SESSION_DIR for staging
const tempFiles = new Map();
for (const [name, buffer] of assetBuffers) {
    const tmpPath = path.join(TEST_SESSION_DIR, name);
    fs.writeFileSync(tmpPath, buffer);
    tempFiles.set(name, tmpPath);
}

// Create a session and stage all test assets as 'new' files
const manager = new SessionManager(TEST_SESSION_DIR, testFpStore, testAssetStore);
const session  = await manager.create('Test Commit Pipeline', testConfig);

for (const [name, tmpPath] of tempFiles) {
    session.addFile(tmpPath, name);
}

assert('session staged all test assets', session.listFiles().length, testAssets.length);

// Prepare (Phase 1)
await manager.prepare(session.sessionId);
assert('prepare — session status is ready', session.status, 'ready');

// Execute CommitPipeline
console.log('  Running CommitPipeline...');
const t       = Date.now();
const pipeline = new CommitPipeline(session, testConfig, testFpStore, testAssetStore);
const result   = await pipeline.execute();
const elapsed  = Date.now() - t;

console.log(`  CommitPipeline completed in ${elapsed}ms\n`);

// Verify result
assertTruthy('execute — returns a result object',    result !== null);
assert('result — status is complete',                result.status,   'complete');
assertTruthy('result — total > 0',                   result.total > 0);
assert('result — no failed entries',                 result.failed,   0);
assert('result — sessionId correct',                 result.sessionId, session.sessionId);

// Verify session status
assert('session — status is committed after pipeline', session.status, 'committed');

// Verify output files were created
assert('output — data.000 created', fs.existsSync(path.join(TEST_OUTPUT_DIR, 'data.000')), true);

// Verify at least one pack file was created (there may be only a few packs for 5 assets)
const packFiles = Array.from({ length: 8 }, (_, i) =>
    path.join(TEST_OUTPUT_DIR, `data.00${i + 1}`)
).filter(p => fs.existsSync(p));
assertTruthy('output — at least one pack file created', packFiles.length > 0);
console.log(`  Pack files created: ${packFiles.map(p => path.basename(p)).join(', ')}`);

// Verify no .build files left behind
const buildFiles = fs.readdirSync(TEST_OUTPUT_DIR).filter(f => f.endsWith('.build'));
assert('output — no .build temp files remaining', buildFiles.length, 0);

// Verify data.000 is parseable and contains the right assets
const outputIndex = new DataPackIndex();
outputIndex.parse(fs.readFileSync(path.join(TEST_OUTPUT_DIR, 'data.000')));
assert('output — data.000 contains correct entry count', outputIndex.entries.length, testAssets.length);

const outputNames = new Set(outputIndex.entries.map(e => e.decodedName));
for (const asset of testAssets) {
    assert(`output — "${asset.decodedName}" present in index`, outputNames.has(asset.decodedName), true);
}

// Verify round-trip: re-extract from output pack and compare bytes
console.log('\n  Verifying round-trip extraction from output pack...');
const outputReader = new DataPackReader(
    new Map(Array.from({ length: 8 }, (_, i) =>
        [i + 1, path.join(TEST_OUTPUT_DIR, `data.00${i + 1}`)]
    ))
);

for (const entry of outputIndex.entries) {
    const packPath = path.join(TEST_OUTPUT_DIR, `data.00${entry.packId}`);
    if (!fs.existsSync(packPath)) continue;

    const reExtracted = await outputReader.extractAsset(entry);
    const original    = assetBuffers.get(entry.decodedName);

    if (original) {
        const origHash  = crypto.createHash('sha256').update(original).digest('hex');
        const newHash   = crypto.createHash('sha256').update(reExtracted).digest('hex');
        assert(
            `round-trip — "${entry.decodedName}" bytes match original`,
            newHash, origHash
        );
    }
}
await outputReader.closeAll();

// Verify blueprint was generated
const blueprintDir = path.join(TEST_STORE_DIR, 'blueprints');
assertTruthy('output — blueprint directory created', fs.existsSync(blueprintDir));
const blueprintFiles = fs.existsSync(blueprintDir) ? fs.readdirSync(blueprintDir) : [];
assertTruthy('output — blueprint file created', blueprintFiles.length > 0);

// Verify progress.json exists and status is complete
const progressPath = path.join(session.workingDir, 'progress.json');
assertTruthy('progress — progress.json written', fs.existsSync(progressPath));
const progressData = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
assert('progress — status is complete', progressData.status, 'complete');

// Test that execute() throws on non-ready session
{
    const badSession = await manager.create('Bad Session', testConfig);
    // Do NOT call prepare() — session stays 'active'
    const badPipeline = new CommitPipeline(badSession, testConfig, testFpStore, testAssetStore);
    let threw = false;
    try { await badPipeline.execute(); } catch { threw = true; }
    assert('execute — throws if session not ready', threw, true);
    await manager.discard(badSession.sessionId);
}

// Clean up test directories
[TEST_OUTPUT_DIR, TEST_STORE_DIR, TEST_SESSION_DIR].forEach(d => {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
});
console.log('\n  Test output cleaned up');

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

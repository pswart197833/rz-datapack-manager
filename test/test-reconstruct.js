'use strict';
/**
 * Reconstruction Test — data.000 round-trip validation
 * -------------------------------------------------------
 * Run: node test/test-reconstruct.js
 *
 * Two tests:
 *
 * TEST 1 — In-memory round-trip
 *   Parse data.000 → serialize back → compare bytes to original.
 *   Should be byte-identical. No files written.
 *   Fast — proves the encode/decode cycle is lossless.
 *
 * TEST 2 — Full pipeline reconstruction
 *   Open a session from the blueprint, prepare, commit to a safe
 *   output directory. Then compare the output data.000 to the
 *   original byte-for-byte.
 *   Slower — proves the full CommitPipeline produces correct output.
 *
 * SAFETY: never touches ./data — all output goes to ./store/test-reconstruct/
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const DataPackIndex     = require('../src/core/DataPackIndex');
const DataPackReader    = require('../src/core/DataPackReader');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const IndexManager      = require('../src/api/IndexManager');
const SessionManager    = require('../src/session/SessionManager');
const Blueprint         = require('../src/fingerprint/Blueprint');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT         = path.join(__dirname, '..');
const DATA_DIR     = path.join(ROOT, 'data');
const STORE_DIR    = path.join(ROOT, 'store');
const SESSION_DIR  = path.join(ROOT, 'sessions');
const OUT_DIR      = path.join(ROOT, 'store', 'test-reconstruct');
const INDEX_PATH   = path.join(DATA_DIR, 'data.000');

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
// Startup — ensure null-asset sentinel exists in the real store
// ---------------------------------------------------------------------------

async function ensureSentinel() {
    const assetStore = new AssetStore(STORE_DIR);
    await assetStore.rebuild();
    assetStore.ensureNullAsset();

    const dbPath  = path.join(STORE_DIR, 'fingerprints.jsonl');
    const fpStore = new FingerprintStore(dbPath, assetStore);
    await fpStore.load();
    await fpStore.ensureNullAsset();
}

// ---------------------------------------------------------------------------
// TEST 1 — In-memory round-trip
// ---------------------------------------------------------------------------

async function testInMemoryRoundTrip() {
    console.log('\n=== Test 1: In-memory round-trip ===\n');

    if (!fs.existsSync(INDEX_PATH)) {
        console.log('  [SKIP] data.000 not found — set DATA_DIR correctly.\n');
        return;
    }

    const originalBuffer = fs.readFileSync(INDEX_PATH);
    console.log(`  data.000 size: ${originalBuffer.length.toLocaleString()} bytes`);

    const index = new DataPackIndex();
    index.parse(originalBuffer);
    console.log(`  Entries parsed: ${index.entries.length.toLocaleString()}`);

    const zeroCount = index.entries.filter(e => e.size === 0).length;
    console.log(`  Zero-size entries: ${zeroCount.toLocaleString()}`);

    const serialized = index.serialize(index.entries);

    assert('Serialized length matches original', serialized.length, originalBuffer.length);

    if (serialized.length === originalBuffer.length) {
        const originalHash   = crypto.createHash('sha256').update(originalBuffer).digest('hex');
        const serializedHash = crypto.createHash('sha256').update(serialized).digest('hex');
        assert('Serialized SHA-256 matches original (byte-identical)', serializedHash, originalHash);

        if (serializedHash !== originalHash) {
            // Find first differing byte for diagnosis
            let firstDiff = -1;
            for (let i = 0; i < originalBuffer.length; i++) {
                if (originalBuffer[i] !== serialized[i]) { firstDiff = i; break; }
            }
            console.log(`         First differing byte at offset ${firstDiff}`);
            console.log(`         Original:   0x${originalBuffer[firstDiff].toString(16).padStart(2,'0')}`);
            console.log(`         Serialized: 0x${serialized[firstDiff].toString(16).padStart(2,'0')}`);
        }
    }

    // Verify round-trip re-parse is consistent
    if (serialized.length === originalBuffer.length) {
        const index2 = new DataPackIndex();
        index2.parse(serialized);
        assert('Re-parsed entry count matches original',    index2.entries.length,                     index.entries.length);
        assert('Re-parsed first entry name matches',        index2.entries[0].decodedName,             index.entries[0].decodedName);
        assert('Re-parsed last entry name matches',         index2.entries[index2.entries.length-1].decodedName, index.entries[index.entries.length-1].decodedName);
        assert('Re-parsed zero-size count matches',         index2.entries.filter(e=>e.size===0).length, zeroCount);
    }
}

// ---------------------------------------------------------------------------
// TEST 2 — Full pipeline reconstruction
// ---------------------------------------------------------------------------

async function testPipelineReconstruction() {
    console.log('\n=== Test 2: Full pipeline reconstruction ===\n');
    console.log('  Output goes to: store/test-reconstruct/');
    console.log('  Original data files are never touched.\n');

    // Clean up previous run
    if (fs.existsSync(OUT_DIR)) {
        fs.rmSync(OUT_DIR, { recursive: true });
    }

    const outDataDir    = path.join(OUT_DIR, 'data');
    const outStoreDir   = path.join(OUT_DIR, 'store');
    const outSessionDir = path.join(OUT_DIR, 'sessions');

    [outDataDir, outStoreDir, outSessionDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

    // Build config pointing output at outDataDir
    const testConfig = new PackConfiguration({
        indexPath:     path.join(outDataDir, 'data.000'),
        packPaths:     new Map(Array.from({ length: 8 }, (_, i) => [
            i + 1, path.join(outDataDir, `data.00${i + 1}`)
        ])),
        assetStoreDir: outStoreDir,
        sessionsDir:   outSessionDir
    });

    // Use the real store for asset lookups but output to test directory
    const assetStore = new AssetStore(STORE_DIR);
    await assetStore.rebuild();

    // Ensure null-asset sentinel is present in the real store
    assetStore.ensureNullAsset();

    const dbPath  = path.join(STORE_DIR, 'fingerprints.jsonl');
    const fpStore = new FingerprintStore(dbPath, assetStore);
    await fpStore.load();
    await fpStore.ensureNullAsset();

    const existingAssets = fpStore.list('asset').length;
    if (existingAssets === 0) {
        console.log('  [SKIP] No assets in store — run Archiver extraction first,');
        console.log('         then re-run this test for full pipeline validation.\n');
        return;
    }
    console.log(`  Store has ${existingAssets.toLocaleString()} assets registered.\n`);

    // Find blueprint for current data.000
    const indexFp   = await Blueprint.fingerprintFile(INDEX_PATH);
    const blueprint = await Blueprint.loadFromDisk(STORE_DIR, indexFp);

    if (!blueprint) {
        console.log('  [SKIP] No blueprint found for current data.000');
        console.log('         Run: npm start → Configuration → Save to generate a blueprint.\n');
        return;
    }

    console.log(`  Blueprint found: ${indexFp.slice(0, 16)}...`);
    const allRecords    = blueprint.getRecords();
    const zeroRecords   = allRecords.filter(r => {
        const fr = r.resolveFile(fpStore);
        return fr && fr.size === 0;
    });
    console.log(`  Records in blueprint: ${allRecords.length.toLocaleString()}`);
    console.log(`  Zero-size records:    ${zeroRecords.length.toLocaleString()}`);

    // Count resolvable non-zero records
    const resolvable = allRecords.filter(r => {
        const fr = r.resolveFile(fpStore);
        return fr && fr.extractedPath && fr.size > 0;
    }).length;

    assertTruthy('Blueprint has resolvable records', resolvable > 0);

    if (resolvable === 0) {
        console.log('\n  [SKIP] No resolvable records — run extraction first.\n');
        return;
    }

    console.log(`  Resolvable non-zero records: ${resolvable.toLocaleString()}\n`);

    // Open session from blueprint using test output config
    const sessionManager = new SessionManager(outSessionDir, fpStore, assetStore);
    const session        = await sessionManager.openFromBlueprint(indexFp, STORE_DIR, testConfig, 'reconstruct-test');

    assertTruthy('Session created from blueprint', session.sessionId);
    console.log(`  Session ID: ${session.sessionId}`);
    console.log(`  Staged files: ${session.stagedFiles.length.toLocaleString()}`);

    // Prepare
    console.log('\n  Preparing session...');
    await sessionManager.prepare(session.sessionId);
    assert('Session status is ready after prepare', session.status, 'ready');

    // Verify pack-list excludes zero-size entries
    const packList  = JSON.parse(fs.readFileSync(path.join(session.workingDir, 'pack-list.json'),  'utf8'));
    const indexList = JSON.parse(fs.readFileSync(path.join(session.workingDir, 'index-list.json'), 'utf8'));

    const packListZero  = packList.filter(f => {
        const fr = fpStore.getByName(f.targetName);
        return fr && fr.size === 0;
    });
    const indexListZero = indexList.filter(e => e.size === 0);

    assert('pack-list.json excludes zero-size entries',   packListZero.length,  0);
    assertTruthy('index-list.json includes zero-size entries', indexListZero.length > 0);
    console.log(`  pack-list:  ${packList.length.toLocaleString()} entries (zero-size excluded)`);
    console.log(`  index-list: ${indexList.length.toLocaleString()} entries (zero-size included)`);

    // Commit
    console.log('\n  Committing (building pack files)...');
    const result = await sessionManager.commit(session.sessionId);
    assertTruthy('Commit returned a result', result);
    console.log(`  Committed: ${result.complete}/${result.total} assets`);

    // Verify output data.000 was written
    const outIndexPath = path.join(outDataDir, 'data.000');
    assertTruthy('Output data.000 was written', fs.existsSync(outIndexPath));

    if (!fs.existsSync(outIndexPath)) return;

    // Compare to original
    console.log('\n  Comparing output to original...');
    const originalBuffer = fs.readFileSync(INDEX_PATH);
    const outputBuffer   = fs.readFileSync(outIndexPath);

    assert('Output data.000 length matches original', outputBuffer.length, originalBuffer.length);

    if (outputBuffer.length === originalBuffer.length) {
        const originalHash = crypto.createHash('sha256').update(originalBuffer).digest('hex');
        const outputHash   = crypto.createHash('sha256').update(outputBuffer).digest('hex');
        assert('Output data.000 is byte-identical to original', outputHash, originalHash);

        if (outputHash !== originalHash) {
            // Find first diff for diagnosis
            let firstDiff = -1;
            for (let i = 0; i < originalBuffer.length; i++) {
                if (originalBuffer[i] !== outputBuffer[i]) { firstDiff = i; break; }
            }
            console.log(`\n  First differing byte at offset ${firstDiff}:`);
            console.log(`    Original:  0x${originalBuffer[firstDiff].toString(16).padStart(2,'0')}`);
            console.log(`    Output:    0x${outputBuffer[firstDiff].toString(16).padStart(2,'0')}`);

            // Parse both and show differing entry
            const origIdx = new DataPackIndex();
            origIdx.parse(originalBuffer);
            const outIdx = new DataPackIndex();
            outIdx.parse(outputBuffer);

            let diffCount = 0;
            for (let i = 0; i < Math.min(origIdx.entries.length, outIdx.entries.length); i++) {
                const o = origIdx.entries[i];
                const u = outIdx.entries[i];
                if (o.decodedName !== u.decodedName || o.packId !== u.packId ||
                    o.offset !== u.offset || o.size !== u.size) {
                    if (diffCount < 5) {
                        console.log(`\n  Entry diff [${i}]:`);
                        console.log(`    orig:   ${o.decodedName} pack=${o.packId} offset=${o.offset} size=${o.size}`);
                        console.log(`    output: ${u.decodedName} pack=${u.packId} offset=${u.offset} size=${u.size}`);
                    }
                    diffCount++;
                }
            }
            if (diffCount > 0) console.log(`\n  Total entry diffs: ${diffCount}`);
        }

        // Cross-check zero-size entries specifically
        console.log('\n  Verifying zero-size entries in output...');
        const origIdx = new DataPackIndex();
        origIdx.parse(originalBuffer);
        const outIdx = new DataPackIndex();
        outIdx.parse(outputBuffer);

        const origZero = origIdx.entries.filter(e => e.size === 0);
        const outZero  = outIdx.entries.filter(e => e.size === 0);

        assert('Zero-size entry count matches', outZero.length, origZero.length);

        let zeroMismatches = 0;
        for (const oz of origZero) {
            const uz = outIdx.entries.find(e => e.decodedName === oz.decodedName);
            if (!uz || uz.packId !== oz.packId || uz.offset !== oz.offset) {
                zeroMismatches++;
                if (zeroMismatches <= 3) {
                    console.log(`  Zero-size mismatch: ${oz.decodedName}`);
                    console.log(`    orig:   pack=${oz.packId} offset=${oz.offset}`);
                    console.log(`    output: pack=${uz?.packId} offset=${uz?.offset}`);
                }
            }
        }
        assert('All zero-size entries have correct packId+offset', zeroMismatches, 0);
    }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
    try {
        await ensureSentinel();
        await testInMemoryRoundTrip();
        await testPipelineReconstruction();
    } catch (err) {
        console.error('\n[FATAL]', err.message);
        console.error(err.stack);
        failed++;
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
})();

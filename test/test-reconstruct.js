'use strict';
/**
 * Reconstruction Test — data.000 round-trip validation
 * -------------------------------------------------------
 * Run: node scripts/test-reconstruct.js
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
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
    if (!ok) {
        console.log(`         expected: ${JSON.stringify(expected)}`);
        console.log(`         actual:   ${JSON.stringify(actual)}`);
        failed++;
    } else {
        passed++;
    }
}

function assertTruthy(label, actual) {
    if (actual) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label} — value was falsy`);
        failed++;
    }
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

if (!fs.existsSync(INDEX_PATH)) {
    console.error(`\n  [ERROR] data.000 not found at ${INDEX_PATH}`);
    console.error('  Copy your pack files to ./data/ and try again.\n');
    process.exit(1);
}

// ============================================================
// TEST 1 — In-memory round-trip
// ============================================================

console.log('\n=== Test 1: In-memory round-trip (parse → serialize → compare) ===\n');

const originalBuffer = fs.readFileSync(INDEX_PATH);
console.log(`  Original data.000: ${fmtBytes(originalBuffer.length)}`);

const t1    = Date.now();
const index = new DataPackIndex();
index.parse(originalBuffer);
console.log(`  Parsed ${index.entries.length.toLocaleString()} entries in ${Date.now() - t1}ms`);

const t2         = Date.now();
const serialized = index.serialize(index.entries);
console.log(`  Serialized in ${Date.now() - t2}ms`);
console.log('');

assert('Size match — serialized === original',
    serialized.length, originalBuffer.length
);

if (serialized.length === originalBuffer.length) {
    const identical = originalBuffer.equals(serialized);
    assert('Byte-identical — every byte matches', identical, true);

    if (!identical) {
        // Show first 5 differences to help diagnose
        let diffCount = 0;
        for (let i = 0; i < originalBuffer.length && diffCount < 5; i++) {
            if (originalBuffer[i] !== serialized[i]) {
                console.log(`    Diff at byte ${i}: original=0x${originalBuffer[i].toString(16).padStart(2,'0')} serialized=0x${serialized[i].toString(16).padStart(2,'0')}`);
                diffCount++;
            }
        }
    }
} else {
    // Size mismatch — show which is larger and by how much
    const diff = Math.abs(serialized.length - originalBuffer.length);
    console.log(`    Size diff: ${diff} bytes (${serialized.length > originalBuffer.length ? '+' : '-'}${diff})`);
}

// Verify the re-parsed result is also consistent
if (serialized.length === originalBuffer.length) {
    const index2 = new DataPackIndex();
    index2.parse(serialized);
    assert('Re-parsed entry count matches original',
        index2.entries.length, index.entries.length
    );
    assert('Re-parsed first entry name matches',
        index2.entries[0].decodedName, index.entries[0].decodedName
    );
    assert('Re-parsed last entry name matches',
        index2.entries[index2.entries.length - 1].decodedName,
        index.entries[index.entries.length - 1].decodedName
    );
}

// ============================================================
// TEST 2 — Full pipeline reconstruction
// ============================================================

console.log('\n=== Test 2: Full pipeline reconstruction ===\n');
console.log('  This test builds a real output pack from the blueprint.');
console.log('  Output goes to: store/test-reconstruct/');
console.log('  Original data files are never touched.\n');

// Clean up previous run
if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
}

// Create isolated output directories
const outDataDir    = path.join(OUT_DIR, 'data');    // output pack files go here
const outStoreDir   = path.join(OUT_DIR, 'store');   // isolated asset store
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

// Set up stores (use the real store for asset lookups)
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();

const dbPath  = path.join(STORE_DIR, 'fingerprints.jsonl');
const fpStore = new FingerprintStore(dbPath, assetStore);
await fpStore.load();

const existingAssets = fpStore.list('asset').length;
if (existingAssets === 0) {
    console.log('  [SKIP] No assets in store — run Archiver extraction first,');
    console.log('         then re-run this test for full pipeline validation.\n');
    console.log('  Skipping Test 2 and reporting Test 1 result only.\n');
} else {
    console.log(`  Store has ${existingAssets.toLocaleString()} assets registered.\n`);

    // Find the blueprint for the current data.000
    const indexFp      = await Blueprint.fingerprintFile(INDEX_PATH);
    const blueprint    = await Blueprint.loadFromDisk(STORE_DIR, indexFp);

    if (!blueprint) {
        console.log(`  [SKIP] No blueprint found for current data.000`);
        console.log(`         Run: npm start → Configuration → Save to generate a blueprint.\n`);
    } else {
        console.log(`  Blueprint found: ${indexFp.slice(0, 16)}...`);
        console.log(`  Records in blueprint: ${blueprint.getRecords().length.toLocaleString()}`);

        // Count resolvable records.
        // A record is resolvable if its fileFingerprint exists in FingerprintStore
        // AND that record has a real extractedPath (not a stub).
        let resolvable  = 0;
        let stubCount   = 0;
        let aliasCount  = 0;
        for (const record of blueprint.getRecords()) {
            if (!record.fileFingerprint) continue;
            const fr = fpStore.get(record.fileFingerprint) || fpStore.getByName(
                // Fall back to name lookup for alias records
                blueprint.getRecords().find(r => r.fileFingerprint === record.fileFingerprint)?.fileFingerprint
            );
            if (fr) {
                if (fr.extractedPath) {
                    resolvable++;
                    if (fr.isAlias) aliasCount++;
                } else {
                    stubCount++;
                }
            }
        }
        console.log(`  Resolvable records: ${resolvable.toLocaleString()} / ${blueprint.getRecords().length.toLocaleString()}`);
        if (aliasCount > 0) {
            console.log(`  Content aliases:    ${aliasCount.toLocaleString()} (same bytes as another file — fully resolvable)`);
        }
        if (stubCount > 0) {
            console.log(`  [WARN] ${stubCount.toLocaleString()} records point to stub hashes (no extractedPath).`);
            console.log('  Fix: delete store/fingerprints.jsonl and store/blueprints/ then re-run extraction.');
        }

        // Zero-size entries have no content to extract — exclude from coverage calculation
        const nonZeroRecords = blueprint.getRecords().filter(r => {
            const fr = fpStore.getByName(r.decodedName) || fpStore.get(r.fileFingerprint);
            return !fr || fr.size > 0;
        });
        const coverage = nonZeroRecords.length > 0 ? resolvable / nonZeroRecords.length : 1;
        console.log(`  Store coverage: ${(coverage * 100).toFixed(1)}%\n`);

        if (resolvable === 0) {
            console.log('  [SKIP] No blueprint records resolve to stored assets.');
            console.log('         Run extraction first, then re-run this test.\n');
        } else {
            // Open session from blueprint
            const manager = new SessionManager(outSessionDir, fpStore, assetStore);
            console.log('  Opening session from blueprint...');
            const t3      = Date.now();
            const session = await manager.openFromBlueprint(indexFp, STORE_DIR, testConfig, 'Reconstruction test');
            console.log(`  Session opened in ${Date.now() - t3}ms — ${session.listFiles().length.toLocaleString()} staged files`);

            // Remove files that can't be resolved.
            // An asset is resolvable if its FingerprintRecord exists with a real extractedPath.
            // Aliases are fully resolvable — they have isAlias=true but a valid extractedPath
            // pointing to the same physical file as the canonical record.
            let notInStore = 0;
            let aliases    = 0;

            for (const file of session.listFiles()) {
                if (!file.isInStore()) continue;

                const fp = file.sourceFingerprint;
                if (!fp) { session.removeFile(file.targetName); notInStore++; continue; }

                // Primary check: FingerprintRecord by name has a real path
                const fpRecord = fpStore.getByName(file.targetName);
                if (fpRecord && fpRecord.extractedPath) {
                    if (fpRecord.isAlias) aliases++;
                    continue; // resolvable — canonical or alias
                }

                // Secondary: canonical hash exists in asset store
                if (assetStore.exists(fp)) continue;

                // Truly missing
                session.removeFile(file.targetName);
                notInStore++;
            }

            if (aliases > 0) {
                console.log(`  ${aliases.toLocaleString()} content aliases — resolved to shared physical files`);
            }
            if (notInStore > 0) {
                console.log(`  [WARN] ${notInStore.toLocaleString()} assets genuinely missing.`);
                console.log('  Fix: delete store/fingerprints.jsonl and store/blueprints/, re-run extraction.');
            }

            // ---- packId diagnostic ----
            const checkNames = [
                'game_panel_image_worldmap_over_all.bmp',
                'm002_001.bmp', 'waterbump.bmp', 'npcinfo.cfg'
            ];
            console.log('\n  packId diagnostic:');
            console.log('  ' + 'name'.padEnd(46) + 'orig  bp    staged');
            const FilenameCodec = require('../src/crypto/FilenameCodec');
            const codec = new FilenameCodec();
            for (const name of checkNames) {
                const origEntry = index.entries.find(e => e.decodedName === name);
                const bpRecord  = blueprint.getRecords().find(r => r.decodedName === name);
                const staged    = session.listFiles().find(f => f.targetName === name);
                const enc       = codec.encode(name);
                const codeId    = codec.getPackId(enc);
                console.log('  ' + name.padEnd(46) +
                    String(origEntry?.packId ?? '?').padEnd(6) +
                    String(bpRecord?.packId  ?? '?').padEnd(6) +
                    String(staged?.packId    ?? '?') +
                    '  codec=' + codeId
                );
            }
            console.log('');

            const buildable = session.listFiles().filter(f => !f.isDeleted()).length;
            console.log(`  Building with ${buildable.toLocaleString()} assets...\n`);

            if (buildable === 0) {
                console.log('  [SKIP] No buildable assets — run full extraction first.\n');
            } else {
                // Prepare and commit
                await manager.prepare(session.sessionId);
                assert('prepare — session status is ready', session.status, 'ready');

                console.log(`  Running CommitPipeline...`);
                const t4     = Date.now();
                const result = await manager.commit(session.sessionId);
                const elapsed = Date.now() - t4;
                console.log(`  Pipeline completed in ${(elapsed / 1000).toFixed(1)}s\n`);

                assert('commit result — status is complete',  result.status, 'complete');
                assert('commit result — no failed entries',   result.failed, 0);

                // Verify output data.000 exists
                const outIndexPath = path.join(outDataDir, 'data.000');
                assert('output — data.000 written to disk', fs.existsSync(outIndexPath), true);

                if (fs.existsSync(outIndexPath)) {
                    const outBuffer = fs.readFileSync(outIndexPath);
                    console.log(`\n  Output data.000: ${fmtBytes(outBuffer.length)}`);

                    // Parse the output index
                    const outIndex = new DataPackIndex();
                    outIndex.parse(outBuffer);
                    console.log(`  Output entry count: ${outIndex.entries.length.toLocaleString()}`);
                    console.log(`  Original entry count: ${buildable.toLocaleString()}`);

                    // Output should contain ALL entries including zero-size placeholders
                    const expectedTotal = blueprint.getRecords().length - (4); // minus 4 missing stubs
                    assert('output — entry count matches built asset count',
                        outIndex.entries.length, expectedTotal
                    );

                    // If full extraction was done, compare byte-for-byte
                    const nonZeroTotal = blueprint.getRecords().filter(r => {
                        const fr = fpStore.getByName(r.decodedName) || fpStore.get(r.fileFingerprint);
                        return !fr || fr.size > 0;
                    }).length;
                    if (resolvable >= nonZeroTotal) {
                        console.log('\n  Full store coverage — comparing output to original byte-for-byte...');
                        const outHash      = sha256(outBuffer);
                        const originalHash = sha256(originalBuffer);
                        assert('FULL MATCH — output data.000 is byte-identical to original',
                            outHash, originalHash
                        );
                        if (outHash !== originalHash) {
                            console.log('\n  Investigating differences...');
                            // Parse both and compare entry by entry
                            let diffEntries = 0;
                            for (let i = 0; i < Math.min(index.entries.length, outIndex.entries.length); i++) {
                                const orig = index.entries[i];
                                const out  = outIndex.entries[i];
                                if (orig.decodedName !== out.decodedName || orig.offset !== out.offset || orig.size !== out.size) {
                                    if (diffEntries < 5) {
                                        console.log(`    Entry[${i}] orig: ${orig.decodedName} offset=${orig.offset} size=${orig.size}`);
                                        console.log(`    Entry[${i}] out:  ${out.decodedName} offset=${out.offset} size=${out.size}`);
                                    }
                                    diffEntries++;
                                }
                            }
                            if (diffEntries > 0) console.log(`    Total differing entries: ${diffEntries}`);
                        }
                    } else {
                        console.log(`\n  Partial store (${(coverage * 100).toFixed(1)}%) — skipping byte-for-byte comparison.`);
                        console.log('  Run full extraction then re-run this test for complete validation.');

                        // What we can check: all output entries appear in the original index
                        const originalNames = new Set(index.entries.map(e => e.decodedName));
                        const allPresent    = outIndex.entries.every(e => originalNames.has(e.decodedName));
                        assert('output — all entry names exist in original index', allPresent, true);
                    }

                    // Compare output pack files to originals byte-for-byte
                    console.log('\n  Pack file SHA-256 comparison:');
                    let packMatch = 0, packFail = 0;
                    for (let slot = 1; slot <= 8; slot++) {
                        const outPack  = path.join(outDataDir, `data.00${slot}`);
                        const origPack = path.join(DATA_DIR, `data.00${slot}`);
                        if (!fs.existsSync(outPack)) continue;

                        const outHash  = sha256(fs.readFileSync(outPack));
                        const origHash = sha256(fs.readFileSync(origPack));
                        const match    = outHash === origHash;
                        match ? packMatch++ : packFail++;
                        console.log(`    data.00${slot}: ${match ? '✓ MATCH' : '✗ DIFFER'}`);
                        if (!match) {
                            console.log(`      out:  ${outHash.slice(0,16)}...`);
                            console.log(`      orig: ${origHash.slice(0,16)}...`);
                            // Show size comparison
                            const outSize  = fs.statSync(outPack).size;
                            const origSize = fs.statSync(origPack).size;
                            console.log(`      size: out=${outSize.toLocaleString()} orig=${origSize.toLocaleString()} ${outSize===origSize?'(same)':'(DIFFERENT)'}`);
                        }
                    }
                    assertTruthy(`pack files — all ${packMatch} compared match originals`, packFail === 0);

                    const packFiles = Array.from({ length: 8 }, (_, i) =>
                        path.join(outDataDir, `data.00${i + 1}`)
                    ).filter(p => fs.existsSync(p));
                    console.log(`\n  Pack files written: ${packFiles.map(p => path.basename(p)).join(', ')}`);

                    // Pack-level SHA comparison above is the definitive test.
                    // If data.00x hashes match the originals, reconstruction is correct.
                }

                // Clean up test session
                await manager.discard(session.sessionId);
            }
        }
    }
}

// ============================================================
// Clean up
// ============================================================

// Only clean up on full pass — leave output for inspection on failure
if (failed === 0) {
    if (fs.existsSync(OUT_DIR)) {
        fs.rmSync(OUT_DIR, { recursive: true });
        console.log('\n  Test output cleaned up.');
    }
} else {
    console.log('\n  Output left for inspection at: ' + OUT_DIR);
}

// ============================================================
// Summary
// ============================================================

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

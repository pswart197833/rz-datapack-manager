'use strict';
/**
 * scripts/diagnose-offsets.js
 *
 * Mini build test — extracts 5 real assets from pack 3, builds a mini pack,
 * and verifies the offsets in the output index match what DataPackWriter wrote.
 * Runs in seconds — no full pipeline needed.
 *
 * Usage: node scripts/diagnose-offsets.js
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const DataPackIndex     = require('../src/core/DataPackIndex');
const DataPackReader    = require('../src/core/DataPackReader');
const DataPackWriter    = require('../src/core/DataPackWriter');
const AssetItem         = require('../src/core/AssetItem');
const FilenameCodec     = require('../src/crypto/FilenameCodec');
const Blueprint         = require('../src/fingerprint/Blueprint');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const AssetStore        = require('../src/core/AssetStore');
const PackConfiguration = require('../src/config/PackConfiguration');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');
const OUT_DIR   = path.join(ROOT, 'store', '_diag_offsets');

(async () => {
try {

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Load original index
const origIndex = new DataPackIndex();
origIndex.parse(fs.readFileSync(path.join(DATA_DIR, 'data.000')));

// Get first 5 non-zero entries from pack 3 in their original offset order
const pack3entries = origIndex.entries
    .filter(e => e.packId === 3 && e.size > 0)
    .sort((a, b) => a.offset - b.offset)
    .slice(0, 5);

console.log('\n  Original pack 3 entries (first 5 by offset):');
pack3entries.forEach(e => {
    console.log(`    ${e.decodedName.padEnd(50)} packId=${e.packId} offset=${e.offset} size=${e.size}`);
});

// Extract their bytes from the real pack
const reader = new DataPackReader(
    new Map(Array.from({length:8}, (_,i) => [i+1, path.join(DATA_DIR, `data.00${i+1}`)]))
);

const buffers = new Map();
for (const entry of pack3entries) {
    buffers.set(entry.decodedName, await reader.extractAsset(entry));
}
await reader.closeAll();

// Write to a new pack using DataPackWriter — in the same order
const writer = new DataPackWriter(OUT_DIR);
const writtenItems = [];

for (const entry of pack3entries) {
    const buf     = buffers.get(entry.decodedName);
    const written = await writer.addAsset(entry, buf);
    writtenItems.push(written);
}
await writer.closeAll();

console.log('\n  Written items (offsets assigned by DataPackWriter):');
writtenItems.forEach(item => {
    console.log(`    ${item.decodedName.padEnd(50)} packId=${item.packId} offset=${item.offset} size=${item.size}`);
});

// Compare written offsets to original
console.log('\n  Offset comparison:');
let allMatch = true;
for (let i = 0; i < pack3entries.length; i++) {
    const orig    = pack3entries[i];
    const written = writtenItems[i];
    const match   = orig.offset === written.offset && orig.size === written.size;
    if (!match) allMatch = false;
    console.log(`    ${orig.decodedName.padEnd(50)} orig=${orig.offset} written=${written.offset} ${match ? '✓' : '✗ MISMATCH'}`);
}

// Verify pack file size matches expected
const packFile = path.join(OUT_DIR, 'data.003.build');
const packSize = fs.existsSync(packFile) ? fs.statSync(packFile).size : 0;
const expectedSize = pack3entries.reduce((s, e) => s + e.size, 0);
console.log(`\n  Pack file size: ${packSize.toLocaleString()} bytes`);
console.log(`  Expected size:  ${expectedSize.toLocaleString()} bytes`);
console.log(`  Size match: ${packSize === expectedSize ? '✓' : '✗'}`);

// Verify round-trip extraction
console.log('\n  Round-trip verification:');
const checkReader = new DataPackReader(
    new Map([[3, packFile]])
);
let rtPass = 0, rtFail = 0;
for (const item of writtenItems) {
    try {
        const extracted = await checkReader.extractAsset(item);
        const origBuf   = buffers.get(item.decodedName);
        const match     = extracted.equals(origBuf);
        console.log(`    ${item.decodedName.padEnd(50)} ${match ? '✓' : '✗ BYTES DIFFER'}`);
        match ? rtPass++ : rtFail++;
    } catch (e) {
        console.log(`    ${item.decodedName.padEnd(50)} ✗ ERROR: ${e.message}`);
        rtFail++;
    }
}
await checkReader.closeAll();

console.log(`\n  Result: ${rtPass}/${rtPass+rtFail} round-trips passed`);
console.log(`  Offset integrity: ${allMatch ? 'ALL CORRECT' : 'MISMATCHES FOUND'}\n`);

fs.rmSync(OUT_DIR, { recursive: true });

} catch (e) {
    console.error('\n[ERROR]', e.message, '\n', e.stack);
    process.exit(1);
}
})();

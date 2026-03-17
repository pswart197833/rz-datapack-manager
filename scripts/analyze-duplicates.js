'use strict';
/**
 * Duplicate Analysis
 * scripts/analyze-duplicates.js
 *
 * Inspects all 20,406 skipped entries from extraction and categorises them.
 * Run AFTER a full extraction so FingerprintStore has real content hashes.
 *
 * Usage:
 *   node scripts/analyze-duplicates.js --data ./data --store ./store
 *   node scripts/analyze-duplicates.js --data ./data --store ./store --limit 20
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const DataPackIndex     = require('../src/core/DataPackIndex');
const DataPackReader    = require('../src/core/DataPackReader');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            args[key] = val;
        }
    }
    return args;
}

const args        = parseArgs(process.argv.slice(2));
const DATA_DIR    = path.resolve(args.data   || './data');
const STORE_DIR   = path.resolve(args.store  || './store');
const SESSION_DIR = path.resolve(args.sessions || './sessions');
const LIMIT       = args.limit ? parseInt(args.limit) : null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

console.log('\n  Duplicate Entry Analysis');
console.log('  ' + '─'.repeat(48));

// Load index
const index = new DataPackIndex();
index.parse(fs.readFileSync(path.join(DATA_DIR, 'data.000')));
console.log(`  Index entries: ${index.entries.length.toLocaleString()}`);

// Load stores
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();

const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();
console.log(`  FingerprintStore records: ${fpStore.list('asset').length.toLocaleString()}`);

// Open reader for content hashing
const reader = new DataPackReader(
    new Map(Array.from({ length: 8 }, (_, i) =>
        [i + 1, path.join(DATA_DIR, `data.00${i + 1}`)]
    ))
);

// Build a map of hash → first entry that wrote it
// to identify which entry "owns" each unique content hash
console.log('\n  Scanning for duplicates...\n');

const hashToFirstEntry = new Map(); // hash → AssetItem (first seen)
const duplicates       = [];        // entries whose hash was already seen

for (const entry of index.entries) {
    if (entry.size === 0) continue;

    try {
        const buffer = await reader.extractAsset(entry);
        const hash   = crypto.createHash('sha256').update(buffer).digest('hex');

        if (hashToFirstEntry.has(hash)) {
            duplicates.push({
                entry,
                hash,
                firstEntry: hashToFirstEntry.get(hash),
                buffer
            });
        } else {
            hashToFirstEntry.set(hash, entry);
        }
    } catch (err) {
        // Skip unreadable entries
    }
}

await reader.closeAll();

console.log(`  Total duplicate entries: ${duplicates.length.toLocaleString()}`);
console.log('');

// Categorise
const cats = {
    sameNameSameContent:      [], // exact duplicate — same filename, same bytes
    sameNameDiffContent:      [], // updated file — same name, different hash (can't happen here since hash matched)
    diffNameSameContent:      [], // content alias — different name, same bytes
};

for (const dup of duplicates) {
    if (dup.entry.decodedName === dup.firstEntry.decodedName) {
        cats.sameNameSameContent.push(dup);
    } else {
        cats.diffNameSameContent.push(dup);
    }
}

console.log('  Breakdown:');
console.log(`    Same filename + same content:      ${cats.sameNameSameContent.length.toLocaleString()}`);
console.log(`    Different filename + same content: ${cats.diffNameSameContent.length.toLocaleString()}`);
console.log('');

// Show samples of each type
const showLimit = LIMIT || 10;

if (cats.sameNameSameContent.length > 0) {
    console.log(`  ── Same filename + same content (first ${Math.min(showLimit, cats.sameNameSameContent.length)}) ──`);
    console.log('  These are literal duplicate index entries — same file appears twice in data.000.');
    console.log('');
    cats.sameNameSameContent.slice(0, showLimit).forEach(d => {
        console.log(`    ${d.entry.decodedName}`);
        console.log(`      First:  pack ${d.firstEntry.packId}  offset ${d.firstEntry.offset.toLocaleString()}  size ${d.firstEntry.size.toLocaleString()}`);
        console.log(`      Second: pack ${d.entry.packId}  offset ${d.entry.offset.toLocaleString()}  size ${d.entry.size.toLocaleString()}`);
        const sameLocation = d.firstEntry.packId === d.entry.packId && d.firstEntry.offset === d.entry.offset;
        console.log(`      Same location: ${sameLocation ? 'YES — exact same pack+offset' : 'NO — different location, same content'}`);
        console.log('');
    });
}

if (cats.diffNameSameContent.length > 0) {
    console.log(`  ── Different filename + same content (first ${Math.min(showLimit, cats.diffNameSameContent.length)}) ──`);
    console.log('  These are content aliases — different name in the index, but identical bytes.');
    console.log('');
    cats.diffNameSameContent.slice(0, showLimit).forEach(d => {
        console.log(`    Original: ${d.firstEntry.decodedName}`);
        console.log(`    Alias:    ${d.entry.decodedName}`);
        console.log(`    Size: ${d.entry.size.toLocaleString()} bytes  |  Hash: ${d.hash.slice(0, 16)}...`);
        console.log(`    Pack: ${d.firstEntry.packId} → ${d.entry.packId}  Offset: ${d.firstEntry.offset.toLocaleString()} → ${d.entry.offset.toLocaleString()}`);
        console.log('');
    });
}

// Extension breakdown of duplicates
console.log('  ── Duplicate extension breakdown ──');
const extCounts = {};
for (const d of duplicates) {
    const ext = d.entry.assetType || 'unknown';
    extCounts[ext] = (extCounts[ext] || 0) + 1;
}
Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([ext, count]) => {
        console.log(`    .${ext.padEnd(8)} ${count.toLocaleString()}`);
    });

// Export full list to JSON
const outputPath = path.join(STORE_DIR, 'duplicate-analysis.json');
const output = {
    generatedAt:       new Date().toISOString(),
    totalDuplicates:   duplicates.length,
    sameNameSameContent: cats.sameNameSameContent.length,
    diffNameSameContent: cats.diffNameSameContent.length,
    entries: duplicates.map(d => ({
        type:           d.entry.decodedName === d.firstEntry.decodedName ? 'same-name' : 'diff-name',
        name:           d.entry.decodedName,
        firstName:      d.firstEntry.decodedName,
        hash:           d.hash,
        size:           d.entry.size,
        assetType:      d.entry.assetType,
        packId:         d.entry.packId,
        offset:         d.entry.offset,
        firstPackId:    d.firstEntry.packId,
        firstOffset:    d.firstEntry.offset,
        sameLocation:   d.firstEntry.packId === d.entry.packId && d.firstEntry.offset === d.entry.offset
    }))
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\n  Full analysis saved to: ${outputPath}`);
console.log('');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

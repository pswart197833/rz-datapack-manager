'use strict';
/**
 * test/fixtures/1.collect-test-data.js
 *
 * Step 1 of 3 — Scans the FingerprintStore for asset records that are
 * genuinely present on disk (real extractedPath, file exists, hash resolvable
 * in AssetStore), groups them by file type, and randomly selects 2–3 per type.
 *
 * Also deliberately includes:
 *   - content aliases   (isAlias=true records already in the store)
 *   - zero-size entries (from the index — these never have on-disk files)
 *
 * NOTE: This script requires extract-all to have been run first so that
 * real asset files exist in the store. Stub records (registered by loadIndex
 * before extraction) have no extractedPath and are ignored.
 *
 * Writes: test/fixtures/sample-manifest.json
 *
 * Usage (from project root):
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/1.collect-test-data.js --seed 42
 *   node test/fixtures/1.collect-test-data.js --data ./data --store ./store --per-type 3 --seed 99
 *
 * Options:
 *   --data      <path>  data directory  (default: ./data)
 *   --store     <path>  store directory (default: ./store)
 *   --sessions  <path>  sessions directory (default: ./sessions)
 *   --per-type  <n>     samples per file type (default: 2, max: 5)
 *   --max-zero  <n>     zero-size entries to include (default: 4)
 *   --max-alias <n>     content-alias entries to include (default: 4)
 *   --seed      <n>     base seed for selection shuffle (default: 0)
 *                       Use different seeds to generate fixture variations for
 *                       testing blueprint and fingerprint store behaviour across
 *                       different asset sets.  The seed is recorded in the
 *                       manifest so step 3 can embed it in expected/ outputs.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Arg parsing
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

const args       = parseArgs(process.argv.slice(2));
const DATA_DIR   = path.resolve(args.data     || './data');
const STORE_DIR  = path.resolve(args.store    || './store');
const SES_DIR    = path.resolve(args.sessions || './sessions');
const PER_TYPE   = Math.min(5, Math.max(1, parseInt(args['per-type']  || '2')));
const MAX_ZERO   = parseInt(args['max-zero']  || '4');
const MAX_ALIAS  = parseInt(args['max-alias'] || '4');
const BASE_SEED  = parseInt(args['seed']      || '0');

const FIXTURE_DIR   = path.join(__dirname, '..', '..', 'test', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'sample-manifest.json');

// ---------------------------------------------------------------------------
// Deterministic seeded shuffle
//
// The BASE_SEED is mixed into every shuffle call so that:
//   --seed 0   (default) always produces the same stable fixture
//   --seed N   produces a fully different but still reproducible selection
//
// Seed derivation per call:
//   normal samples:  BASE_SEED + per-extension constant
//   alias sample:    BASE_SEED + 77
//   zero sample:     BASE_SEED + 42
// ---------------------------------------------------------------------------

function seededShuffle(arr, seed) {
    const a = arr.slice();
    let s = seed >>> 0; // force unsigned 32-bit
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

const SRC = path.join(__dirname, '..', '..', 'src');
const PackConfiguration = require(path.join(SRC, 'config',      'PackConfiguration'));
const AssetStore        = require(path.join(SRC, 'core',        'AssetStore'));
const FingerprintStore  = require(path.join(SRC, 'fingerprint', 'FingerprintStore'));
const IndexManager      = require(path.join(SRC, 'api',         'IndexManager'));

const dbPath = path.join(STORE_DIR, 'fingerprints.jsonl');

console.log('\n  Fixture Collector — Step 1 of 3');
console.log('  ' + '─'.repeat(52));
console.log(`  Data dir:     ${DATA_DIR}`);
console.log(`  Store dir:    ${STORE_DIR}`);
console.log(`  Per type:     ${PER_TYPE}`);
console.log(`  Zero-size:    up to ${MAX_ZERO}`);
console.log(`  Aliases:      up to ${MAX_ALIAS}`);
console.log(`  Seed:         ${BASE_SEED}${BASE_SEED === 0 ? '  (default — stable fixture)' : '  (custom — variant fixture)'}`);
console.log('');

// ---- Preflight ----
if (!fs.existsSync(path.join(DATA_DIR, 'data.000'))) {
    console.error(`  ERROR: data.000 not found in ${DATA_DIR}`);
    process.exit(1);
}
if (!fs.existsSync(dbPath)) {
    console.error(`  ERROR: fingerprints.jsonl not found in ${STORE_DIR}`);
    console.error('  Run extract-all first to populate the store.');
    process.exit(1);
}

// ---- Load stores ----
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();

const fpStore = new FingerprintStore(dbPath, assetStore);
await fpStore.load();

const allAssetRecords = fpStore.list('asset');
console.log(`  FingerprintStore: ${allAssetRecords.length.toLocaleString()} asset records total`);

// ---- Separate genuine on-disk records from stubs ----
//
// A "real" record has:
//   (a) extractedPath set (not null)
//   (b) the file actually exists on disk at that path
//   (c) AssetStore knows about the hash (rebuild() found the file)
//   (d) isAlias === false  (aliases are handled separately)
//
// Stub records (registered by loadIndex() before extraction) have
// extractedPath === null and are skipped here.

const realRecords  = [];  // { record, ext }
const aliasRecords = [];  // { record, ext }

for (const record of allAssetRecords) {
    // Skip the null sentinel
    if (record.hash === AssetStore.NULL_ASSET_HASH) continue;
    if (record.decodedName === AssetStore.NULL_ASSET_NAME) continue;

    // Must be physically present on disk
    if (!record.extractedPath) continue;
    if (!fs.existsSync(record.extractedPath)) continue;
    if (!assetStore.exists(record.hash)) continue;

    const ext = record.decodedName.includes('.')
        ? record.decodedName.split('.').pop().toLowerCase()
        : 'unknown';

    if (record.isAlias) {
        aliasRecords.push({ record, ext });
    } else {
        realRecords.push({ record, ext });
    }
}

console.log(`  On-disk non-alias records: ${realRecords.length.toLocaleString()}`);
console.log(`  On-disk alias records:     ${aliasRecords.length.toLocaleString()}`);
console.log('');

if (realRecords.length === 0) {
    console.error('  ERROR: No real (non-stub) asset records found on disk.');
    console.error('  Run extract-all first: node scripts/extract-all.js --data ./data --store ./store');
    process.exit(1);
}

// ---- Group real records by extension ----
const byType = new Map();
for (const item of realRecords) {
    if (!byType.has(item.ext)) byType.set(item.ext, []);
    byType.get(item.ext).push(item);
}

const typeList = [...byType.keys()].sort();
console.log(`  Unique types with real files: ${typeList.length}`);
console.log(`  Types: ${typeList.join(', ')}`);
console.log('');

// ---- Sample PER_TYPE records per type ----
//
// Seed per extension mixes BASE_SEED with a stable per-type constant so that
// changing --seed produces a completely different selection across all types,
// but two runs with the same --seed always produce identical results.

const normalSamples = [];

for (const ext of typeList) {
    const pool        = byType.get(ext);
    const perTypeSeed = (BASE_SEED + ext.charCodeAt(0) * 31 + ext.length * 7 + 11) >>> 0;
    const shuffled    = seededShuffle(pool, perTypeSeed);
    const chosen      = shuffled.slice(0, PER_TYPE);
    normalSamples.push(...chosen);
}

console.log(`  Normal samples selected: ${normalSamples.length}  (${PER_TYPE} per type × ${typeList.length} types)`);

// ---- Sample alias records ----
//
// Verify each alias still has a resolvable canonical record with a real file.
const validAliases = aliasRecords.filter(({ record }) => {
    if (!record.aliasOf) return false;
    const canonical = fpStore.get(record.aliasOf);
    if (!canonical) return false;
    if (!canonical.extractedPath) return false;
    if (!fs.existsSync(canonical.extractedPath)) return false;
    return true;
});

const aliasSeed   = (BASE_SEED + 77) >>> 0;
const aliasSample = seededShuffle(validAliases, aliasSeed).slice(0, MAX_ALIAS);
console.log(`  Valid alias records:      ${validAliases.length.toLocaleString()}  → sampling ${aliasSample.length}`);

// ---- Zero-size entries from the index ----
//
// These are not in the AssetStore (they have no bytes). We load the index
// separately to find them. We only need their name + location metadata.

console.log('\n  Loading index to find zero-size entries...');
const config  = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SES_DIR);
const manager = new IndexManager(config, fpStore, assetStore);
await manager.loadIndex();

const { entries } = manager.getEntries({ pageSize: 999999 });
const zeroEntries  = entries.filter(e => e.size === 0);
const zeroSeed     = (BASE_SEED + 42) >>> 0;
const zeroSample   = seededShuffle(zeroEntries, zeroSeed).slice(0, MAX_ZERO);
console.log(`  Zero-size entries in index: ${zeroEntries.length}  → sampling ${zeroSample.length}`);

// ---- Build the manifest ----
const manifest = {
    generatedAt: new Date().toISOString(),
    seed:        BASE_SEED,
    perType:     PER_TYPE,

    // types: ext -> array of { originalName, size, contentHash, extractedPath }
    types: {},

    // zeroSize: [{ name, packId, offset }]
    zeroSize: [],

    // aliases: [{ aliasName, aliasHash, canonicalName, canonicalHash, canonicalPath, ext }]
    aliases: []
};

for (const { record } of normalSamples) {
    const ext = record.decodedName.includes('.')
        ? record.decodedName.split('.').pop().toLowerCase()
        : 'unknown';
    if (!manifest.types[ext]) manifest.types[ext] = [];
    manifest.types[ext].push({
        originalName:  record.decodedName,
        size:          record.size,
        contentHash:   record.hash,
        extractedPath: record.extractedPath
    });
}

for (const z of zeroSample) {
    manifest.zeroSize.push({
        name:   z.decodedName,
        packId: z.packId,
        offset: z.offset
    });
}

for (const { record } of aliasSample) {
    const canonical = fpStore.get(record.aliasOf);
    manifest.aliases.push({
        aliasName:     record.decodedName,
        aliasHash:     record.hash,
        canonicalName: canonical.decodedName,
        canonicalHash: canonical.hash,
        canonicalPath: canonical.extractedPath,
        ext:           record.decodedName.includes('.')
            ? record.decodedName.split('.').pop().toLowerCase()
            : 'unknown'
    });
}

// ---- Summary ----
const totalNormal  = Object.values(manifest.types).reduce((s, a) => s + a.length, 0);
const totalEntries = totalNormal + manifest.zeroSize.length + manifest.aliases.length;

console.log('\n  ── Manifest Summary ─────────────────────────────────');
console.log(`  Seed used:             ${BASE_SEED}`);
console.log(`  File types covered:    ${Object.keys(manifest.types).length}`);
console.log(`  Normal entries:        ${totalNormal}  (all have real files on disk)`);
console.log(`  Zero-size entries:     ${manifest.zeroSize.length}`);
console.log(`  Content aliases:       ${manifest.aliases.length}`);
console.log(`  Total index entries:   ${totalEntries}`);

if (!fs.existsSync(path.dirname(MANIFEST_PATH))) {
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
}
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`\n  ✓ Manifest written to: ${MANIFEST_PATH}`);
console.log('');
if (BASE_SEED !== 0) {
    console.log(`  TIP: Run steps 2 and 3 to build the fixture for seed ${BASE_SEED}.`);
    console.log('  To generate a different variation use a different --seed value.');
} else {
    console.log('  TIP: Use --seed <n> to generate a different fixture variation.');
}
console.log('');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

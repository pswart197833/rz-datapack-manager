'use strict';
/**
 * test/fixtures/3.generate-fixture.js
 *
 * Step 3 of 3 — Creates a session populated from the fixture store,
 * then runs the full commit pipeline to produce:
 *
 *   test/fixtures/data/
 *     data.000          ← encrypted index
 *     data.001–.008     ← pack files (empty slots are 0 bytes)
 *
 *   test/fixtures/expected/
 *     entries.json      ← every decoded index entry with known values
 *     hashes.json       ← SHA-256 of data.000 and each pack file
 *     pack-map.json     ← name → { packId, offset, size, contentHash }
 *
 * The generated files are committed to the repo so unit tests run with
 * no dependency on real game data.
 *
 * Usage (from project root):
 *   node test/fixtures/3.generate-fixture.js
 *   node test/fixtures/3.generate-fixture.js --clean   (wipe data/ first)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

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

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR   = path.join(__dirname, '..', '..', 'test', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'sample-manifest.json');
const FIXTURE_STORE = path.join(FIXTURE_DIR, 'store');
const FIXTURE_DATA  = path.join(FIXTURE_DIR, 'data');
const FIXTURE_SES   = path.join(FIXTURE_DIR, 'sessions');
const EXPECTED_DIR  = path.join(FIXTURE_DIR, 'expected');

const SRC = path.join(__dirname, '..', '..', 'src');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute the real content hash for a fixture store record.
 *
 * FingerprintStore.getByName() returns the stub hash (sha256 of
 * "name|offset|size") when extractAll() has not been run. To get the
 * real content hash we read the physical file at extractedPath and
 * hash it directly. This is always accurate regardless of whether
 * extractAll() has been run.
 *
 * Falls back to rec.hash when no physical file is available (e.g.
 * zero-size sentinel entries whose hash is correct by definition).
 *
 * @param {FingerprintRecord|null} rec
 * @param {string}                 storeRoot - FIXTURE_STORE root for relative path resolution
 * @returns {string|null}
 */
function realContentHash(rec, storeRoot) {
    if (!rec) return null;

    // Resolve extractedPath — may be relative to storeRoot
    let filePath = rec.extractedPath;
    if (filePath && !path.isAbsolute(filePath)) {
        filePath = path.join(storeRoot, filePath);
    }

    if (filePath && fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        return sha256(buf);
    }

    // No physical file — fall back to stored hash (correct for null sentinel)
    return rec.hash || null;
}

/**
 * Resolve an extractedPath from the fixture JSONL.
 * Paths in the JSONL are relative to FIXTURE_STORE.
 * Returns an absolute path or null.
 */
function resolveStorePath(relOrAbsPath) {
    if (!relOrAbsPath) return null;
    if (path.isAbsolute(relOrAbsPath)) return relOrAbsPath;
    return path.join(FIXTURE_STORE, relOrAbsPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

const PackConfiguration = require(path.join(SRC, 'config',      'PackConfiguration'));
const AssetStore        = require(path.join(SRC, 'core',        'AssetStore'));
const FingerprintStore  = require(path.join(SRC, 'fingerprint', 'FingerprintStore'));
const DataPackIndex     = require(path.join(SRC, 'core',        'DataPackIndex'));
const SessionManager    = require(path.join(SRC, 'session',     'SessionManager'));

console.log('\n  Fixture Generator — Step 3 of 3');
console.log('  ' + '─'.repeat(52));
console.log(`  Fixture store:    ${FIXTURE_STORE}`);
console.log(`  Fixture data out: ${FIXTURE_DATA}`);
console.log('');

// ---- Preflight checks ----
if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`  ERROR: sample-manifest.json not found. Run step 1 first.`);
    process.exit(1);
}
const fixtureFpPath = path.join(FIXTURE_STORE, 'fingerprints.jsonl');
if (!fs.existsSync(fixtureFpPath)) {
    console.error(`  ERROR: fixture fingerprints.jsonl not found. Run step 2 first.`);
    process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// ---- Clean / create output dirs ----
if (args.clean && fs.existsSync(FIXTURE_DATA)) {
    fs.rmSync(FIXTURE_DATA, { recursive: true });
    console.log('  Cleaned existing data/ directory.');
}
for (const dir of [FIXTURE_DATA, FIXTURE_SES, EXPECTED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Initialise fixture stores ----
//
// IMPORTANT: The fixture AssetStore points at FIXTURE_STORE.
// extractedPath values in fingerprints.jsonl are RELATIVE to FIXTURE_STORE.
// We patch them to absolute paths in memory after loading so the pipeline
// can resolve them without any changes to the production code.

const assetStore = new AssetStore(FIXTURE_STORE);
await assetStore.rebuild();
assetStore.ensureNullAsset();

const fpStore = new FingerprintStore(fixtureFpPath, assetStore);
await fpStore.load();
await fpStore.ensureNullAsset();

// Patch relative extractedPaths to absolute paths.
// FingerprintStore loads records as-is from disk. Since the fixture JSONL
// stores relative paths, we iterate all loaded records and resolve them.
for (const record of fpStore.list()) {
    if (record.extractedPath && !path.isAbsolute(record.extractedPath)) {
        record.extractedPath = resolveStorePath(record.extractedPath);
    }
}
// Also patch AssetStore's internal index: rebuild() populated it from disk
// using the relative paths in filenames. Since AssetStore scans the directory
// itself it should have correct absolute paths — but call rebuild once more
// with the absolute root to be safe.
await assetStore.rebuild();

console.log(`  FingerprintStore: ${fpStore.list('asset').length} asset records loaded`);
console.log(`  AssetStore:       ${fpStore.list('asset').filter(r => assetStore.exists(r.hash)).length} hashes resolvable`);
console.log('');

// ---- Build PackConfiguration pointing at fixture data output dir ----
const fixtureConfig = new PackConfiguration({
    indexPath:     path.join(FIXTURE_DATA, 'data.000'),
    packPaths:     new Map(Array.from({ length: 8 }, (_, i) => [
        i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
    ])),
    assetStoreDir: FIXTURE_STORE,
    sessionsDir:   FIXTURE_SES
});

// ---- Create session ----
const sessionManager = new SessionManager(FIXTURE_SES, fpStore, assetStore);
const session = await sessionManager.create(fixtureConfig, 'Fixture Generation Build');
console.log(`  Session created: ${session.sessionId}`);

// ---- Add all entries from the manifest to the session ----
//
// Processing order:
//   1. Normal entries       — addFromStore(hash, name)
//   2. Content aliases      — addFromStore(canonicalHash, aliasName)
//      The alias has the SAME bytes as the canonical entry but its own
//      FingerprintRecord. We use the canonical hash since that is what
//      AssetStore has the file under.
//   3. Zero-size entries    — addFromStore(NULL_ASSET_HASH, name)
//   4. Exact duplicate entries — addFromStore(hash, name)
//      The duplicate is the same name appearing twice in the index.
//      We call addFromStore once — it replaces any prior staging for
//      that name (Session._fileMap upsert). The CommitPipeline will
//      write the bytes and produce a single index entry. To get the
//      duplicate entry into the index we would need to manipulate
//      pack-list and index-list directly, which is beyond the scope
//      of what the fixture generator should do. Instead we record the
//      duplicate names in the manifest so unit tests can assert on them
//      at the DataPackIndex level using the raw real index.

const NULL_HASH = AssetStore.NULL_ASSET_HASH;

let addedOk      = 0;
let addedSkipped = 0;

// Helper: add a file from store, logging any skips
function tryAddFromStore(hash, name) {
    if (!hash) {
        console.log(`    SKIP (no hash): ${name}`);
        addedSkipped++;
        return;
    }
    if (!assetStore.exists(hash)) {
        console.log(`    SKIP (not in store): ${name}  hash=${hash.slice(0,16)}...`);
        addedSkipped++;
        return;
    }
    session.addFromStore(hash, name);
    addedOk++;
}

// 1. Normal entries
console.log('  Adding normal entries...');
for (const files of Object.values(manifest.types)) {
    for (const f of files) {
        tryAddFromStore(f.contentHash, f.originalName);
    }
}

// 2. Content aliases
console.log('  Adding alias entries...');
for (const a of (manifest.aliases || [])) {
    // The alias's content hash IS the canonical hash (same bytes).
    // Look up the alias's own FingerprintRecord to get its hash.
    const aliasRecord = fpStore.getByName(a.aliasName);
    if (aliasRecord) {
        // Use aliasRecord.hash — FingerprintStore registered the alias with its own
        // primary key name::hash. The actual file on disk is the canonical file,
        // linked via aliasOf. AssetStore.getPath(aliasRecord.hash) may or may not
        // return a path if the alias is stored as a symlink/copy.
        // Safe fallback: use the canonical hash we know is in the store.
        const resolvedHash = assetStore.exists(aliasRecord.hash)
            ? aliasRecord.hash
            : a.contentHash;
        tryAddFromStore(resolvedHash, a.aliasName);
    } else {
        // No FingerprintRecord for the alias name — fall back to canonical hash
        tryAddFromStore(a.contentHash, a.aliasName);
    }
    // Ensure the canonical is also staged (may already be from normal entries)
    const canonRecord = fpStore.getByName(a.canonicalName);
    if (canonRecord && !session.listFiles().find(f => f.targetName === a.canonicalName)) {
        tryAddFromStore(canonRecord.hash, a.canonicalName);
    }
}

// 3. Zero-size entries
console.log('  Adding zero-size entries...');
for (const z of (manifest.zeroSize || [])) {
    tryAddFromStore(NULL_HASH, z.name);
}

const allStaged = session.listFiles().filter(f => !f.isDeleted());
console.log('');
console.log(`  Staged: ${addedOk} entries  (${addedSkipped} skipped)`);
console.log(`  Session total: ${allStaged.length} active staged files`);
console.log('');

if (allStaged.length === 0) {
    console.error('  ERROR: No files staged — cannot generate fixture. Check step 2 output.');
    process.exit(1);
}

// ---- Run the commit pipeline ----
console.log('  Preparing session...');
await sessionManager.prepare(session.sessionId);
console.log(`  Status: ${session.status}`);

console.log('  Committing (building pack files)...');
const t      = Date.now();
const result = await sessionManager.commit(session.sessionId);
const elapsed = Date.now() - t;
console.log(`  Done in ${elapsed}ms  —  status: ${result.status || 'complete'}  complete: ${result.complete}/${result.total}`);
console.log('');

// ---- Verify data.000 was written ----
const indexPath = path.join(FIXTURE_DATA, 'data.000');
if (!fs.existsSync(indexPath)) {
    console.error('  ERROR: data.000 was not created. Check pipeline output above.');
    process.exit(1);
}

// Ensure all 8 pack slots exist (empty slots → empty files for consistent fixture layout)
for (let slot = 1; slot <= 8; slot++) {
    const packPath = path.join(FIXTURE_DATA, `data.00${slot}`);
    if (!fs.existsSync(packPath)) {
        fs.writeFileSync(packPath, Buffer.alloc(0));
    }
}

// ---- Parse output index and build expected/ files ----
console.log('  Building expected/ manifest files...');

const indexBuf   = fs.readFileSync(indexPath);
const indexHash  = sha256(indexBuf);
const parsedIndex = new DataPackIndex();
parsedIndex.parse(indexBuf);

console.log(`  data.000: ${parsedIndex.entries.length} entries parsed  sha256=${indexHash.slice(0,16)}...`);

// entries.json
const expectedEntries = parsedIndex.entries.map(e => ({
    decodedName:  e.decodedName,
    assetType:    e.assetType,
    packId:       e.packId,
    offset:       e.offset,
    size:         e.size,
    indexOffset:  e.indexOffset,
    isZeroSize:   e.size === 0
}));
fs.writeFileSync(
    path.join(EXPECTED_DIR, 'entries.json'),
    JSON.stringify(expectedEntries, null, 2)
);

// hashes.json
const hashes = {
    generatedAt: new Date().toISOString(),
    seed:        manifest.seed ?? 0,
    'data.000':  indexHash
};
for (let slot = 1; slot <= 8; slot++) {
    const packPath = path.join(FIXTURE_DATA, `data.00${slot}`);
    const packBuf  = fs.readFileSync(packPath);
    hashes[`data.00${slot}`] = sha256(packBuf);
}
fs.writeFileSync(
    path.join(EXPECTED_DIR, 'hashes.json'),
    JSON.stringify(hashes, null, 2)
);

// pack-map.json — name → { packId, offset, size, contentHash }
//
// contentHash is computed by reading the physical file at extractedPath
// and hashing it directly. This produces the real content hash regardless
// of whether the FingerprintRecord still holds a stub hash from loadIndex().
// Falls back to rec.hash only when no physical file is available (e.g.
// zero-size sentinel entries whose hash is correct by definition).
const packMap = {};
for (const e of parsedIndex.entries) {
    const rec = fpStore.getByName(e.decodedName);
    packMap[e.decodedName] = {
        packId:      e.packId,
        offset:      e.offset,
        size:        e.size,
        contentHash: realContentHash(rec, FIXTURE_STORE)
    };
}
fs.writeFileSync(
    path.join(EXPECTED_DIR, 'pack-map.json'),
    JSON.stringify(packMap, null, 2)
);

// ---- Final summary ----
const zeroCount  = parsedIndex.entries.filter(e => e.size === 0).length;
const usedPacks  = new Set(parsedIndex.entries.filter(e => e.size > 0).map(e => e.packId));
const typeBreakdown = {};
for (const e of parsedIndex.entries) {
    const t = e.assetType || 'unknown';
    typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
}

console.log('');
console.log('  ── Fixture Summary ──────────────────────────────────');
console.log(`  Index entries:   ${parsedIndex.entries.length}`);
console.log(`  Zero-size:       ${zeroCount}`);
console.log(`  Pack slots used: ${[...usedPacks].sort((a,b)=>a-b).map(p=>`data.00${p}`).join(', ')}`);
console.log('');
console.log('  Type breakdown:');
for (const [type, count] of Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    .${type.padEnd(8)} ${count}`);
}
console.log('');
console.log('  Output files:');
[
    path.join(FIXTURE_DATA, 'data.000'),
    path.join(EXPECTED_DIR, 'entries.json'),
    path.join(EXPECTED_DIR, 'hashes.json'),
    path.join(EXPECTED_DIR, 'pack-map.json')
].forEach(f => console.log(`    ${f}`));
console.log('');
console.log('  ✓ Fixture generation complete.\n');

// Clean up session working directory
try { await sessionManager.discard(session.sessionId); } catch { /* non-fatal */ }

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

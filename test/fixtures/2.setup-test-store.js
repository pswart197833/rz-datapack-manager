'use strict';
/**
 * test/fixtures/2.setup-test-store.js
 *
 * Step 2 of 3 — Reads sample-manifest.json and builds a self-contained
 * fixture store under test/fixtures/store/ by copying the relevant asset
 * files and fingerprint records from the live store.
 *
 * What it produces:
 *   test/fixtures/store/
 *     fingerprints.jsonl        ← filtered to only manifest entries
 *     {bucket}/{hash}.{ext}     ← copied asset files
 *     e3/.../e3b0...bin         ← null-asset sentinel (zero-size)
 *
 * The extractedPath in every fingerprints.jsonl record is written as a
 * path RELATIVE to the fixture store root so the fixture is portable
 * across machines and CI environments.  Script 3 resolves them back to
 * absolute paths at runtime.
 *
 * Usage (from project root):
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/2.setup-test-store.js --store ./store
 */

const fs   = require('fs');
const path = require('path');

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

const args      = parseArgs(process.argv.slice(2));
const LIVE_STORE = path.resolve(args.store || './store');

const FIXTURE_DIR   = path.join(__dirname, '..', '..', 'test', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'sample-manifest.json');
const FIXTURE_STORE = path.join(FIXTURE_DIR, 'store');
const LIVE_FP_PATH  = path.join(LIVE_STORE,  'fingerprints.jsonl');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an absolute extractedPath to a relative path from storeRoot */
function toRelative(absolutePath, storeRoot) {
    if (!absolutePath) return null;
    if (path.isAbsolute(absolutePath)) {
        return path.relative(storeRoot, absolutePath);
    }
    return absolutePath; // already relative
}

/** Copy a file, creating destination directory if needed */
function copyFile(src, dest) {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

console.log('\n  Fixture Store Builder — Step 2 of 3');
console.log('  ' + '─'.repeat(52));
console.log(`  Live store:    ${LIVE_STORE}`);
console.log(`  Fixture store: ${FIXTURE_STORE}`);
console.log('');

if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`  ERROR: sample-manifest.json not found at ${MANIFEST_PATH}`);
    console.error('  Run step 1 first: node test/fixtures/1.collect-test-data.js');
    process.exit(1);
}
if (!fs.existsSync(LIVE_FP_PATH)) {
    console.error(`  ERROR: fingerprints.jsonl not found at ${LIVE_FP_PATH}`);
    process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// ---- Build the complete set of names and hashes we need ----
//
// We collect:
//   targetNames — every decodedName that should appear in the fixture index
//   targetHashes — every content hash whose file we need in the fixture store
//
// For aliases we need BOTH the alias name and the canonical name's file.

const targetNames  = new Set();
const targetHashes = new Set();

// Normal entries
for (const files of Object.values(manifest.types)) {
    for (const f of files) {
        targetNames.add(f.originalName);
        if (f.contentHash) targetHashes.add(f.contentHash);
    }
}

// Zero-size entries — name only, no content hash (points at null sentinel)
for (const z of (manifest.zeroSize || [])) {
    targetNames.add(z.name);
}

// Exact duplicate entries — the duplicate entry shares a name already in
// types (it IS the same name), so just ensure it's in targetNames.
for (const d of (manifest.duplicates || [])) {
    targetNames.add(d.name);
}

// Alias entries — both canonical and alias names, plus the canonical hash
for (const a of (manifest.aliases || [])) {
    targetNames.add(a.canonicalName);
    targetNames.add(a.aliasName);
    if (a.contentHash) targetHashes.add(a.contentHash);
}

console.log(`  Names to include: ${targetNames.size}`);
console.log(`  Hashes to copy:   ${targetHashes.size}`);
console.log('');

// ---- Wipe and recreate fixture store ----
if (fs.existsSync(FIXTURE_STORE)) fs.rmSync(FIXTURE_STORE, { recursive: true });
fs.mkdirSync(FIXTURE_STORE, { recursive: true });

// ---- Scan live fingerprints.jsonl and filter relevant records ----
//
// A record is relevant if:
//   (a) its decodedName is in targetNames, OR
//   (b) its hash is in targetHashes (this catches canonical records whose
//       name might differ from what's in the manifest for alias resolution)
//
// We write each relevant record to the fixture JSONL with extractedPath
// rewritten to be relative to FIXTURE_STORE.

const liveFpContent = fs.readFileSync(LIVE_FP_PATH, 'utf8');
const liveLines     = liveFpContent.split('\n').filter(l => l.trim());

const fixtureJSONLPath = path.join(FIXTURE_STORE, 'fingerprints.jsonl');
const outputLines      = [];

let recordsKept   = 0;
let filesCopied   = 0;
let filesSkipped  = 0;
let filesMissing  = 0;

for (const line of liveLines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    const nameMatch = targetNames.has(record.decodedName);
    const hashMatch = targetHashes.has(record.hash);

    if (!nameMatch && !hashMatch) continue;

    // Determine the live absolute path of the asset file
    const liveAbsPath = record.extractedPath
        ? (path.isAbsolute(record.extractedPath)
            ? record.extractedPath
            : path.join(LIVE_STORE, record.extractedPath))
        : null;

    let fixtureRelPath = null;

    if (liveAbsPath) {
        // Copy the asset file to the fixture store, preserving bucket structure.
        // Bucket structure: {hash[0..1]}/{hash}.{ext}
        // The relative path from the live store is the same structure we use in fixture.
        const relFromLive = path.relative(LIVE_STORE, liveAbsPath);

        // Only copy files that are within the live store (not null sentinel paths, etc.)
        if (!relFromLive.startsWith('..')) {
            const destPath = path.join(FIXTURE_STORE, relFromLive);
            if (fs.existsSync(liveAbsPath)) {
                const copied = copyFile(liveAbsPath, destPath);
                if (copied) { filesCopied++; } else { filesSkipped++; }
                fixtureRelPath = relFromLive;
            } else {
                filesMissing++;
                fixtureRelPath = null; // record exists but file is gone
            }
        }
    }

    // Write record with relative extractedPath
    const outRecord = { ...record, extractedPath: fixtureRelPath };
    outputLines.push(JSON.stringify(outRecord));
    recordsKept++;
}

// ---- Ensure null-asset sentinel exists in fixture store ----
//
// The null-asset sentinel (SHA-256 of empty buffer) must exist so the
// pipeline can handle zero-size entries without special-casing.
const NULL_HASH    = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const nullBucket   = path.join(FIXTURE_STORE, NULL_HASH.slice(0, 2));
const nullFilePath = path.join(nullBucket, `${NULL_HASH}.bin`);
if (!fs.existsSync(nullBucket)) fs.mkdirSync(nullBucket, { recursive: true });
if (!fs.existsSync(nullFilePath)) fs.writeFileSync(nullFilePath, Buffer.alloc(0));

// Check if the null sentinel record is already in our output lines
const nullRelPath     = path.join(NULL_HASH.slice(0, 2), `${NULL_HASH}.bin`);
const nullAlreadyHave = outputLines.some(l => {
    try { return JSON.parse(l).hash === NULL_HASH; } catch { return false; }
});

if (!nullAlreadyHave) {
    // Check if the live store has the null sentinel record
    const liveNullPath = path.join(LIVE_STORE, nullRelPath);
    if (!fs.existsSync(liveNullPath)) {
        // Write the sentinel into the live store copy in fixture
        // (it was already written above, path just needs a record)
    }
    outputLines.push(JSON.stringify({
        hash:          NULL_HASH,
        type:          'asset',
        decodedName:   '__null__',
        size:          0,
        extractedPath: nullRelPath,
        verified:      false,
        date:          new Date().toISOString(),
        isAlias:       false,
        aliasOf:       null
    }));
}

fs.writeFileSync(fixtureJSONLPath, outputLines.join('\n') + '\n');

// ---- Summary ----
console.log('  ── Results ──────────────────────────────────────────');
console.log(`  JSONL records kept:   ${recordsKept}`);
console.log(`  Asset files copied:   ${filesCopied}`);
console.log(`  Files already exist:  ${filesSkipped}`);
console.log(`  Files missing on disk: ${filesMissing}  ← these entries will be skipped in step 3`);
console.log(`  Null sentinel:        ${fs.existsSync(nullFilePath) ? '✓' : '✗'}`);
console.log('');

// Warn about any manifest entries with no corresponding fingerprint record
const keptNames = new Set(
    outputLines.map(l => { try { return JSON.parse(l).decodedName; } catch { return null; } }).filter(Boolean)
);
const missing = [...targetNames].filter(n => !keptNames.has(n));
if (missing.length > 0) {
    console.log(`  ⚠  ${missing.length} manifest names have no fingerprint record in the live store:`);
    missing.slice(0, 10).forEach(n => console.log(`     ${n}`));
    if (missing.length > 10) console.log(`     ... and ${missing.length - 10} more`);
    console.log('');
}

console.log(`  ✓ Fixture store written to: ${FIXTURE_STORE}\n`);

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

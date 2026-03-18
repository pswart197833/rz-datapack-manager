'use strict';
/**
 * Diagnostic: Empty buffer trace
 * test/diagnose-empty-buffer.js
 *
 * Simulates the CommitPipeline resolve step for the known failing entries
 * and traces exactly what path is resolved and what size buffer is read.
 *
 * Usage: node test/diagnose-empty-buffer.js
 */

const fs                = require('fs');
const path              = require('path');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const PackConfiguration = require('../src/config/PackConfiguration');
const SessionManager    = require('../src/session/SessionManager');
const Blueprint         = require('../src/fingerprint/Blueprint');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');

// Known failing entries from test output
const CHECK = [
    'beast_flameeyes.cob',
    'beast_hen_lv1.cob',
    'beast_kukurilv1.cob',
    'beast_kukurilv2.cob',
];

(async () => {
try {

console.log('\n  Empty Buffer Diagnostic');
console.log('  ' + '═'.repeat(60));

const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
assetStore.ensureNullAsset();

const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();
await fpStore.ensureNullAsset();

const indexFp   = await Blueprint.fingerprintFile(path.join(DATA_DIR, 'data.000'));
const blueprint = await Blueprint.loadFromDisk(STORE_DIR, indexFp);

console.log(`\n  Blueprint records: ${blueprint.getRecords().length.toLocaleString()}`);

// ----------------------------------------------------------------
// For each failing entry, trace the full resolve chain
// ----------------------------------------------------------------
const AssetStoreNullHash = AssetStore.NULL_ASSET_HASH;

for (const name of CHECK) {
    console.log(`\n  ── ${name}`);

    // 1. FingerprintRecord by name
    const fpRecord = fpStore.getByName(name);
    if (!fpRecord) {
        console.log(`      FingerprintRecord:  NOT FOUND by name`);
        continue;
    }
    console.log(`      FingerprintRecord:`);
    console.log(`        hash:          ${fpRecord.hash.slice(0, 16)}...`);
    console.log(`        isAlias:       ${fpRecord.isAlias}`);
    console.log(`        aliasOf:       ${fpRecord.aliasOf ? fpRecord.aliasOf.slice(0,16)+'...' : 'null'}`);
    console.log(`        extractedPath: ${fpRecord.extractedPath || 'null'}`);
    console.log(`        size:          ${fpRecord.size}`);

    // 2. Is it the null sentinel?
    const isNull = fpRecord.hash === AssetStoreNullHash;
    console.log(`        isNullSentinel: ${isNull}`);

    // 3. AssetStore path lookup by hash
    const storePath = assetStore.getPath(fpRecord.hash);
    console.log(`      assetStore.getPath(hash): ${storePath || 'null'}`);

    if (storePath) {
        // 4. Does file exist and what size?
        const exists = fs.existsSync(storePath);
        console.log(`      File exists: ${exists}`);
        if (exists) {
            const stat = fs.statSync(storePath);
            console.log(`      File size on disk: ${stat.size}`);
        }
    }

    // 5. BlueprintRecord for this entry
    const bpRecord = blueprint.getRecords().find(r => r.decodedName === name);
    if (bpRecord) {
        console.log(`      BlueprintRecord:`);
        console.log(`        fileFingerprint: ${bpRecord.fileFingerprint.slice(0,16)}...`);
        console.log(`        packId:          ${bpRecord.packId}`);
        console.log(`        packOffset:      ${bpRecord.packOffset}`);

        // 6. What does resolveFile return?
        const resolved = bpRecord.resolveFile(fpStore);
        if (resolved) {
            console.log(`      resolveFile() → hash: ${resolved.hash.slice(0,16)}...  extractedPath: ${resolved.extractedPath || 'null'}`);
        } else {
            console.log(`      resolveFile() → null`);
        }
    } else {
        console.log(`      BlueprintRecord: NOT FOUND`);
    }

    // 7. Canonical record for same content
    if (fpRecord.isAlias && fpRecord.aliasOf) {
        const canonical = fpStore.get(fpRecord.aliasOf);
        if (canonical) {
            console.log(`      Canonical record (aliasOf):`);
            console.log(`        decodedName:   ${canonical.decodedName}`);
            console.log(`        extractedPath: ${canonical.extractedPath || 'null'}`);
        }
    }
}

// ----------------------------------------------------------------
// Count how many pack-list entries would resolve to empty/null paths
// ----------------------------------------------------------------
console.log('\n  ── Statistical: checking all pack-list entries from last test session\n');

const tmpDir = path.join(ROOT, 'store', 'test-reconstruct', 'sessions');
if (!fs.existsSync(tmpDir)) {
    console.log('  No test session directory found — run test-reconstruct first.\n');
    process.exit(0);
}

// Find most recent session
const sessions = fs.readdirSync(tmpDir).filter(d =>
    fs.existsSync(path.join(tmpDir, d, 'pack-list.json'))
);
if (sessions.length === 0) {
    console.log('  No sessions with pack-list.json found.\n');
    process.exit(0);
}

const sessionDir  = path.join(tmpDir, sessions[sessions.length - 1]);
const packListPath = path.join(sessionDir, 'pack-list.json');
console.log(`  Session: ${sessions[sessions.length - 1]}`);

const { StagedFile } = require('../src/session/StagedFile') || (() => {
    try { return { StagedFile: require('../src/session/StagedFile') }; } catch { return {}; }
})();
const StagedFileClass = require('../src/session/StagedFile');

const packList = JSON.parse(fs.readFileSync(packListPath, 'utf8'))
    .map(obj => StagedFileClass.fromJSON(obj));

let nullPath   = 0;
let emptyFile  = 0;
let nullSent   = 0;
let ok         = 0;

for (const staged of packList) {
    if (staged.isDeleted()) continue;
    const storePath = assetStore.getPath(staged.sourceFingerprint);
    if (!storePath) {
        nullPath++;
        if (nullPath <= 3) console.log(`  NULL PATH: ${staged.targetName}  fp=${staged.sourceFingerprint.slice(0,16)}...`);
        continue;
    }
    if (staged.sourceFingerprint === AssetStoreNullHash) {
        nullSent++;
        continue;
    }
    if (!fs.existsSync(storePath)) {
        emptyFile++;
        if (emptyFile <= 3) console.log(`  MISSING FILE: ${staged.targetName}  path=${storePath}`);
        continue;
    }
    const stat = fs.statSync(storePath);
    if (stat.size === 0) {
        emptyFile++;
        if (emptyFile <= 3) console.log(`  EMPTY FILE: ${staged.targetName}  path=${storePath}`);
        continue;
    }
    ok++;
}

console.log(`\n  Results:`);
console.log(`    OK (resolvable, non-empty): ${ok.toLocaleString()}`);
console.log(`    Null path (not in store):   ${nullPath.toLocaleString()}`);
console.log(`    Missing/empty file:         ${emptyFile.toLocaleString()}`);
console.log(`    Null sentinel entries:      ${nullSent.toLocaleString()}`);
console.log('');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

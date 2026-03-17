'use strict';
/**
 * scripts/diagnose-pipeline.js
 *
 * Runs a minimal CommitPipeline with 10 real assets (5 from pack 1, 5 from pack 3)
 * and checks that the output index has the correct packIds.
 * Completes in ~30 seconds.
 */

const fs                = require('fs');
const path              = require('path');
const SRC               = path.join(__dirname, '..', 'src');
const Blueprint         = require(path.join(SRC, 'fingerprint', 'Blueprint'));
const FingerprintStore  = require(path.join(SRC, 'fingerprint', 'FingerprintStore'));
const AssetStore        = require(path.join(SRC, 'core', 'AssetStore'));
const PackConfiguration = require(path.join(SRC, 'config', 'PackConfiguration'));
const SessionManager    = require(path.join(SRC, 'session', 'SessionManager'));
const DataPackIndex     = require(path.join(SRC, 'core', 'DataPackIndex'));

const ROOT      = path.join(__dirname, '..');  // up from test/ to project root
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');
const OUT_DIR   = path.join(ROOT, 'store', '_diag_pipeline');

(async () => {
try {

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });

const origIndex = new DataPackIndex();
origIndex.parse(fs.readFileSync(path.join(DATA_DIR, 'data.000')));

// Pick 5 entries from pack 1 and 5 from pack 3
const testEntries = [
    ...origIndex.entries.filter(e => e.packId === 1 && e.size > 0).slice(0, 5),
    ...origIndex.entries.filter(e => e.packId === 3 && e.size > 0).slice(0, 5),
];

console.log('\n  Test entries:');
testEntries.forEach(e => console.log(`    ${e.decodedName.padEnd(50)} pack=${e.packId} offset=${e.offset}`));

const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();

// Build blueprint with just these 10 entries
const indexFp = await Blueprint.fingerprintFile(path.join(DATA_DIR, 'data.000'));
const blueprint = await Blueprint.loadFromDisk(STORE_DIR, indexFp);

// Open full session then filter to just test entries
const tmpDir = path.join(OUT_DIR, 'sessions');
fs.mkdirSync(tmpDir, { recursive: true });
const outDataDir = path.join(OUT_DIR, 'data');
fs.mkdirSync(outDataDir, { recursive: true });

const testConfig = new PackConfiguration({
    indexPath: path.join(outDataDir, 'data.000'),
    packPaths: new Map(Array.from({length:8}, (_,i) => [i+1, path.join(outDataDir, `data.00${i+1}`)])),
    assetStoreDir: path.join(OUT_DIR, 'store'),
    sessionsDir: tmpDir
});

const manager = new SessionManager(tmpDir, fpStore, assetStore);
const session = await manager.openFromBlueprint(indexFp, STORE_DIR, testConfig, 'diag-pipeline');

// Remove all files except test entries
const testNames = new Set(testEntries.map(e => e.decodedName));
for (const f of session.listFiles()) {
    if (!testNames.has(f.targetName)) session.removeFile(f.targetName);
}
console.log(`\n  Session trimmed to ${session.listFiles().filter(f => !f.isDeleted()).length} files`);

// Prepare and commit
await manager.prepare(session.sessionId);
console.log('  Prepared');

const result = await manager.commit(session.sessionId);
console.log('  Committed:', result.status, '— complete:', result.complete);

// Check output index
const outIndex = new DataPackIndex();
outIndex.parse(fs.readFileSync(path.join(outDataDir, 'data.000')));
console.log('\n  Output index entries:');
outIndex.entries.forEach(e => {
    const orig = origIndex.entries.find(o => o.decodedName === e.decodedName);
    const match = orig && e.packId === orig.packId && e.offset === orig.offset;
    console.log(`    ${e.decodedName.padEnd(50)} pack=${e.packId} offset=${e.offset} ${match ? '✓' : '✗ (orig pack=' + orig?.packId + ' offset=' + orig?.offset + ')'}`);
});

fs.rmSync(OUT_DIR, { recursive: true });
console.log('\n  Done.\n');

} catch (e) {
    console.error('\n[ERROR]', e.message, '\n', e.stack);
    process.exit(1);
}
})();

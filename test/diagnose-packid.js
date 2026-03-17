'use strict';
/**
 * scripts/diagnose-packid.js
 *
 * Quick diagnostic — checks packId assignments for a set of known files.
 * Compares: original data.000, blueprint, staged file, and codec.
 * Runs in seconds — no pack building needed.
 *
 * Usage: node scripts/diagnose-packid.js
 */

const fs                = require('fs');
const path              = require('path');
const DataPackIndex     = require('../src/core/DataPackIndex');
const DataPackReader    = require('../src/core/DataPackReader');
const Blueprint         = require('../src/fingerprint/Blueprint');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const AssetStore        = require('../src/core/AssetStore');
const PackConfiguration = require('../src/config/PackConfiguration');
const SessionManager    = require('../src/session/SessionManager');
const FilenameCodec     = require('../src/crypto/FilenameCodec');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');
const SES_DIR   = path.join(ROOT, 'sessions');

const CHECK = [
    'game_panel_image_worldmap_over_all.bmp',
    'm002_001.bmp',
    'm003_000.bmp',
    'm003_001.bmp',
    'waterbump.bmp',
    'npcinfo.cfg',
    'terrainseamlessworld.cfg',
];

(async () => {
try {

// --- Load original index ---
const origIndex = new DataPackIndex();
origIndex.parse(fs.readFileSync(path.join(DATA_DIR, 'data.000')));
const origMap = new Map(origIndex.entries.map(e => [e.decodedName, e]));
console.log(`\n  Original index: ${origIndex.entries.length.toLocaleString()} entries\n`);

// --- Load blueprint ---
const indexFp   = await Blueprint.fingerprintFile(path.join(DATA_DIR, 'data.000'));
const blueprint = await Blueprint.loadFromDisk(STORE_DIR, indexFp);
if (!blueprint) { console.error('  No blueprint found — run extract-all first'); process.exit(1); }
console.log(`  Blueprint: ${blueprint.getRecords().length.toLocaleString()} records`);

// Check if blueprint records have decodedName set
const sampleRec = blueprint.getRecords().find(r => r.decodedName);
console.log(`  Blueprint records have decodedName: ${!!sampleRec}`);
if (sampleRec) console.log(`  Sample: ${JSON.stringify(sampleRec.toJSON())}\n`);
else {
    const sample = blueprint.getRecords()[0];
    console.log(`  Sample (no name): ${JSON.stringify(sample.toJSON())}\n`);
}

// --- Load FingerprintStore ---
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();

// --- Open a session from blueprint (don't build, just check staged packIds) ---
const tmpSesDir = path.join(ROOT, 'store', '_diag_session');
if (fs.existsSync(tmpSesDir)) fs.rmSync(tmpSesDir, { recursive: true });
fs.mkdirSync(tmpSesDir, { recursive: true });

const config = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, tmpSesDir);
const manager = new SessionManager(tmpSesDir, fpStore, assetStore);
const session = await manager.openFromBlueprint(indexFp, STORE_DIR, config, 'diag');

const stagedMap = new Map(session.listFiles().map(f => [f.targetName, f]));
console.log(`  Session staged files: ${session.listFiles().length.toLocaleString()}`);
console.log('');

// --- Codec ---
const codec = new FilenameCodec();

// --- Compare ---
const PAD = 48;
console.log('  ' + 'filename'.padEnd(PAD) + 'orig  bp    staged  codec(az)  match?');
console.log('  ' + '-'.repeat(PAD + 40));

let allMatch = true;
for (const name of CHECK) {
    const orig   = origMap.get(name);
    const bpRec  = blueprint.getRecords().find(r => r.decodedName === name);
    const staged = stagedMap.get(name);
    const enc    = codec.encode(name);
    const cId    = codec.getPackId(enc);

    const origId   = orig?.packId   ?? '?';
    const bpId     = bpRec?.packId  ?? '?';
    const stagedId = staged?.packId ?? '?';

    const match = origId === bpId && origId === stagedId;
    if (!match) allMatch = false;

    console.log('  ' + name.padEnd(PAD) +
        String(origId).padEnd(6) +
        String(bpId).padEnd(6) +
        String(stagedId).padEnd(8) +
        String(cId).padEnd(11) +
        (match ? '✓' : '✗ MISMATCH')
    );
}

console.log('');
if (allMatch) {
    console.log('  All packIds match between original, blueprint, and staged files.');
} else {
    console.log('  MISMATCH DETECTED — packIds differ between sources.');
    console.log('');
    if (!sampleRec) {
        console.log('  LIKELY CAUSE: blueprint was saved before decodedName was added to BlueprintRecord.');
        console.log('  FIX: rm store/fingerprints.jsonl && rm -rf store/blueprints/ && re-run extract-all');
    }
}

// --- Cleanup ---
await manager.discard(session.sessionId);
fs.rmSync(tmpSesDir, { recursive: true });

} catch (e) {
    console.error('\n[ERROR]', e.message);
    console.error(e.stack);
    process.exit(1);
}
})();

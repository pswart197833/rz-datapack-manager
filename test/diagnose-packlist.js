'use strict';
/**
 * scripts/diagnose-packlist.js
 *
 * Opens a session from blueprint, calls prepare(), then inspects the
 * pack-list.json to confirm packId values are correct before any building.
 *
 * Usage: node scripts/diagnose-packlist.js
 */

const fs                = require('fs');
const path              = require('path');
const Blueprint         = require('../src/fingerprint/Blueprint');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const AssetStore        = require('../src/core/AssetStore');
const PackConfiguration = require('../src/config/PackConfiguration');
const SessionManager    = require('../src/session/SessionManager');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');

const CHECK = [
    'game_panel_image_worldmap_over_all.bmp',
    'm002_001.bmp',
    'm003_000.bmp',
    'waterbump.bmp',
    'npcinfo.cfg',
];

(async () => {
try {

const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();

const tmpDir  = path.join(ROOT, 'store', '_diag_packlist');
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const config  = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, tmpDir);
const manager = new SessionManager(tmpDir, fpStore, assetStore);

const indexFp = await Blueprint.fingerprintFile(path.join(DATA_DIR, 'data.000'));
const session = await manager.openFromBlueprint(indexFp, STORE_DIR, config, 'diag');

// Check staged file packIds before prepare
console.log('\n  Staged file packIds (from session, before prepare):');
for (const name of CHECK) {
    const f = session.listFiles().find(f => f.targetName === name);
    console.log(`    ${name.padEnd(50)} packId=${f?.packId ?? 'null'}`);
}

// Run prepare
await manager.prepare(session.sessionId);

// Read pack-list.json
const packList = JSON.parse(fs.readFileSync(
    path.join(session.workingDir, 'pack-list.json'), 'utf8'
));

console.log('\n  pack-list.json entries (first 10):');
packList.slice(0, 10).forEach(f => {
    console.log(`    ${f.targetName.padEnd(50)} packId=${f.packId ?? 'null'}`);
});

console.log('\n  Checking specific files in pack-list.json:');
for (const name of CHECK) {
    const f = packList.find(f => f.targetName === name);
    console.log(`    ${name.padEnd(50)} packId=${f?.packId ?? 'null'}`);
}

// Show the sort order for first pack
const pack3 = packList.filter(f => f.packId === 3).slice(0, 5);
console.log('\n  First 5 entries with packId=3 in pack-list:');
pack3.forEach(f => console.log(`    ${f.targetName}`));

// Cleanup
await manager.discard(session.sessionId);
fs.rmSync(tmpDir, { recursive: true });
console.log('\n  Done.\n');

} catch (e) {
    console.error('\n[ERROR]', e.message, '\n', e.stack);
    process.exit(1);
}
})();

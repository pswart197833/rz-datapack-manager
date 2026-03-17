'use strict';
const fs                = require('fs');
const path              = require('path');
const Blueprint         = require('./src/fingerprint/Blueprint');
const FingerprintStore  = require('./src/fingerprint/FingerprintStore');
const AssetStore        = require('./src/core/AssetStore');
const PackConfiguration = require('./src/config/PackConfiguration');
const SessionManager    = require('./src/session/SessionManager');
const DataPackIndex     = require('./src/core/DataPackIndex');

const ROOT      = path.join(__dirname);
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');

const CHECK = [
    'game_panel_image_worldmap_over_all.bmp',
    'm003_000.bmp', 'm003_001.bmp',
    'm002_001.bmp', 'npcinfo.cfg'
];

(async () => {
    const orig = new DataPackIndex();
    orig.parse(fs.readFileSync(path.join(DATA_DIR, 'data.000')));
    const origMap = new Map(orig.entries.map(e => [e.decodedName, e]));

    const assetStore = new AssetStore(STORE_DIR);
    await assetStore.rebuild();
    const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
    await fpStore.load();

    const tmpDir = path.join(STORE_DIR, '_chk2');
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const config  = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, tmpDir);
    const manager = new SessionManager(tmpDir, fpStore, assetStore);
    const indexFp = await Blueprint.fingerprintFile(path.join(DATA_DIR, 'data.000'));
    const session = await manager.openFromBlueprint(indexFp, STORE_DIR, config, 'chk');

    // Check staged packId BEFORE prepare
    console.log('\n  staged.packId BEFORE prepare:');
    for (const name of CHECK) {
        const f = session.listFiles().find(f => f.targetName === name);
        const fr = fpStore.getByName(name);
        const o = origMap.get(name);
        console.log('  ' + name.padEnd(48) +
            'staged=' + String(f?.packId ?? 'null').padEnd(6) +
            'orig=' + String(o?.packId).padEnd(4) +
            'isAlias=' + String(fr?.isAlias ?? '?') +
            (f?.packId === o?.packId ? ' ✓' : ' ✗'));
    }

    await manager.prepare(session.sessionId);

    // Read pack-list.json
    const packList = JSON.parse(fs.readFileSync(
        path.join(session.workingDir, 'pack-list.json'), 'utf8'
    ));
    const plMap = new Map(packList.map(f => [f.targetName, f]));

    console.log('\n  packId in pack-list.json AFTER prepare:');
    for (const name of CHECK) {
        const f = plMap.get(name);
        const o = origMap.get(name);
        console.log('  ' + name.padEnd(48) +
            'list=' + String(f?.packId ?? 'null').padEnd(6) +
            'orig=' + String(o?.packId) +
            (f?.packId === o?.packId ? ' ✓' : ' ✗'));
    }

    await manager.discard(session.sessionId);
    fs.rmSync(tmpDir, { recursive: true });
    console.log('');
})().catch(e => { console.error(e.message, e.stack); process.exit(1); });

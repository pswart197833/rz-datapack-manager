const fs = require('fs');
const path = require('path');

// Updated imports without {} as per your environment findings
const PackConfiguration = require('../../src/config/PackConfiguration');
const IndexManager = require('../../src/api/IndexManager');
const AssetStore = require('../../src/core/AssetStore');
const FingerprintStore = require('../../src/fingerprint/FingerprintStore'); // Assuming this is the location

async function collectTestData() {
    const dataDir = path.resolve(__dirname, '../../data');
    const storeDir = path.resolve(__dirname, '../../store');
    const sessionDir = path.resolve(__dirname, '../../sessions');
    const dbPath  = path.join(storeDir, 'fingerprints.jsonl');

    // 1. Initialize the three required components
    const config = PackConfiguration.fromDirectory(dataDir, storeDir, sessionDir);

    // Most IndexManagers need these two stores to resolve/extract assets
    const assetStore = new AssetStore(storeDir);
    const fingerprintStore = new FingerprintStore(dbPath, assetStore);

    // 2. Instantiate IndexManager with the full dependency set
    const manager = new IndexManager(config, fingerprintStore, assetStore);

    console.log("Loading real index (124k entries)...");
    const index = await manager.loadIndex();

    // 3. Grouping logic (1-5 samples per extension)
    const typeMap = new Map();
    const zeroSizeSamples = [];
    const fixtureOutput = path.join(__dirname, 'raw_assets');
    if (!fs.existsSync(fixtureOutput)) fs.mkdirSync(fixtureOutput, { recursive: true });

    for (const entry of index.entries) {
        const ext = (entry.assetType || 'no_ext').toLowerCase();

        if (entry.size === 0 && zeroSizeSamples.length < 10) {
            zeroSizeSamples.push(entry);
            continue;
        }

        if (!typeMap.has(ext)) typeMap.set(ext, []);
        if (typeMap.get(ext).length < 5) {
            typeMap.get(ext).push(entry);
        }
    }

    // 4. Extraction
    console.log(`Found ${typeMap.size} unique file types. Extracting samples...`);
    const manifest = { types: {}, zeroSize: [] };

    for (const [ext, entries] of typeMap.entries()) {
        manifest.types[ext] = [];
        for (const entry of entries) {
            try {
                // Using extractSingle to ensure XOR decryption is applied to standard assets
                const buffer = await manager.extractSingle(entry.decodedName);

                // Sanitize filename for local OS storage
                const safeName = entry.decodedName.replace(/[/\\?%*:|"<>]/g, '_');
                fs.writeFileSync(path.join(fixtureOutput, safeName), buffer);

                manifest.types[ext].push({
                    originalName: entry.decodedName,
                    safeName: safeName,
                    size: entry.size,
                    packId: entry.packId
                });
            } catch (err) {
                console.error(`Skipping ${entry.decodedName}: ${err.message}`);
            }
        }
    }

    manifest.zeroSize = zeroSizeSamples.map(e => ({ name: e.decodedName, packId: e.packId }));

    fs.writeFileSync(path.join(__dirname, 'sample-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Done! Collected assets and created sample-manifest.json`);
}

collectTestData().catch(err => {
    console.error("Collection Failed:");
    console.error(err);
});

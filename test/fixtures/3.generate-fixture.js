const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Core Imports
const PackConfiguration = require('../../src/config/PackConfiguration');
const SessionManager = require('../../src/session/SessionManager');
const AssetStore = require('../../src/core/AssetStore');
const FingerprintStore = require('../../src/fingerprint/FingerprintStore');

async function generateFixturePacks() {
    const fixtureDataDir = path.resolve(__dirname, 'data');
    const fixtureStoreDir = path.resolve(__dirname, 'store');
    const fixtureSessionDir = path.resolve(__dirname, 'sessions');
    const fixtureFingerprintsPath = path.join(fixtureStoreDir, 'fingerprints.jsonl');

    // 1. Setup the Test Configuration
    const config = new PackConfiguration(fixtureDataDir, fixtureStoreDir, fixtureSessionDir);
    config.indexPath = path.join(fixtureDataDir, 'data.000');

    for (let i = 1; i <= 8; i++) {
        config.packPaths.set(i, path.join(fixtureDataDir, `data.00${i}`));
    }

    // 2. Initialize Core Stores
    const assetStore = new AssetStore(fixtureStoreDir);
    const fingerprintStore = new FingerprintStore(fixtureFingerprintsPath, fixtureStoreDir);

    // Crucial: Load the mini-store data
    await assetStore.rebuild();
    await fingerprintStore.load(); // Ensure the registrar is ready

    const sessionManager = new SessionManager(fixtureSessionDir, fingerprintStore, assetStore);

    // 3. Create Session and Add from Store
    console.log("Creating fixture build session...");
    const session = await sessionManager.create(config, "Fixture Generation Build");

    console.log("Populating session from fixture store records...");

    const fileStream = fs.createReadStream(fixtureFingerprintsPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);

        // Use the fingerprint to add the asset from the store
        // This marks the StagedFile as 'in-store'
        if (record.extractedPath != null && record.type == 'asset') {
          await session.addFromStore(record.hash, record.decodedName);
        }
    }

    // 4. Run the Commit Pipeline
    console.log("Preparing commit pipeline...");
    if (!fs.existsSync(fixtureDataDir)) fs.mkdirSync(fixtureDataDir, { recursive: true });

    await sessionManager.prepare(session.sessionId);

    const result = await sessionManager.commit(session.sessionId);

    console.log(result)

    if (result.success) {
        console.log("\n✅ Success! Test Fixture Created.");
        console.log(`Location: ${fixtureDataDir}`);
        console.log(`Total Assets Packed: ${result.stats.totalFiles}`);
    } else {
        console.error("\n❌ Build Failed:", result.error);
    }
}

generateFixturePacks().catch(console.error);

const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function setupTestStore() {
    const liveStoreDir = path.resolve(__dirname, '../../store');
    const liveFingerprintsPath = path.join(liveStoreDir, 'fingerprints.jsonl');

    const fixtureStoreDir = path.resolve(__dirname, 'store');
    const fixtureFingerprintsPath = path.join(fixtureStoreDir, 'fingerprints.jsonl');

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-manifest.json'), 'utf8'));

    const targetNames = new Set();
    for (const ext in manifest.types) {
        manifest.types[ext].forEach(file => targetNames.add(file.originalName));
    }
    manifest.zeroSize.forEach(stub => targetNames.add(stub.name));

    if (fs.existsSync(fixtureStoreDir)) fs.rmSync(fixtureStoreDir, { recursive: true });
    fs.mkdirSync(fixtureStoreDir, { recursive: true });

    const fileStream = fs.createReadStream(liveFingerprintsPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const outputStream = fs.createWriteStream(fixtureFingerprintsPath);

    let recordsFound = 0;
    let filesCopied = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);

        if (targetNames.has(record.decodedName)) {
            // --- THE FIX: Relativize the path for the JSONL record ---
            const originalPath = record.extractedPath;
            let relativePath = null;

            if (originalPath) {
                // If it's absolute, make it relative to the live store root
                relativePath = path.isAbsolute(originalPath)
                ? path.relative(liveStoreDir, originalPath)
                : originalPath;

                // Update the record so the fixture JSONL points to the new local store location
                record.extractedPath = relativePath;
            }

            outputStream.write(JSON.stringify(record) + '\n');
            recordsFound++;

            if (relativePath) {
                const sourceFilePath = path.join(liveStoreDir, relativePath);
                const destFilePath = path.join(fixtureStoreDir, relativePath);

                if (fs.existsSync(sourceFilePath)) {
                    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
                    fs.copyFileSync(sourceFilePath, destFilePath);
                    filesCopied++;
                }
            }
        }
    }

    outputStream.end();
    console.log(`\n--- Store Sync Summary ---`);
    console.log(`Records Found & Relativized: ${recordsFound}`);
    console.log(`Files Copied into Fixture:   ${filesCopied}`);
    console.log(`Fixture Store Root:          ${fixtureStoreDir}`);
}

setupTestStore().catch(console.error);

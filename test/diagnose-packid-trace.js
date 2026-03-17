'use strict';
/**
 * Diagnostic: PackId Trace
 * test/diagnose-packid-trace.js
 *
 * Traces a set of known filenames through every stage of the pipeline
 * and prints each value at each step so mismatches can be isolated.
 *
 * For each filename traces:
 *   1. Raw encrypted bytes from data.000
 *   2. Decrypted encoded string (as stored in data.000, with original salt)
 *   3. packId derived from original encoded string via getPackId()
 *   4. Decoded filename (human readable)
 *   5. Re-encoded string via encode() with default salts ('a'/'z')
 *   6. packId derived from re-encoded string
 *   7. packId stored on the BlueprintRecord
 *   8. packId stored on the StagedFile after openFromBlueprint()
 *   9. packId in pack-list.json after prepare()
 *
 * Usage: node test/diagnose-packid-trace.js
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const DataPackIndex     = require('../src/core/DataPackIndex');
const FilenameCodec     = require('../src/crypto/FilenameCodec');
const CryptoProvider    = require('../src/crypto/CryptoProvider');
const Blueprint         = require('../src/fingerprint/Blueprint');
const BlueprintRecord   = require('../src/fingerprint/BlueprintRecord');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const AssetStore        = require('../src/core/AssetStore');
const PackConfiguration = require('../src/config/PackConfiguration');
const SessionManager    = require('../src/session/SessionManager');

const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const STORE_DIR = path.join(ROOT, 'store');
const INDEX_PATH = path.join(DATA_DIR, 'data.000');

// Files to trace — chosen to cover the known mismatches
const CHECK = [
    'game_panel_image_worldmap_over_all.bmp',
    'm002_001.bmp',
    'm003_000.bmp',
    'm003_001.bmp',
    'waterbump.bmp',
    'npcinfo.cfg',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(buf) {
    if (!buf) return 'null';
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1');
    return b.slice(0, 12).toString('hex') + (b.length > 12 ? `...(${b.length}b)` : '');
}

function printRow(label, value, flag = '') {
    const pad = 42;
    console.log(`    ${label.padEnd(pad)} ${String(value)} ${flag}`);
}

// ---------------------------------------------------------------------------
// Step 1+2+3+4: Parse data.000 and capture raw encoded bytes per entry
// ---------------------------------------------------------------------------

function parseRawIndex() {
    // Parse manually so we can capture the encrypted bytes AND the
    // decrypted encoded string before FilenameCodec.decode() runs.
    const buf          = fs.readFileSync(INDEX_PATH);
    const cryptoProv   = new CryptoProvider();
    const codec        = new FilenameCodec();
    const results      = new Map(); // decodedName → { rawEncryptedBytes, encodedStr, packIdFromOriginal, decodedName }

    let cipherIndex  = 0;
    let bufferOffset = 0;

    while (bufferOffset < buf.length) {
        const indexOffset = bufferOffset;

        const lenResult = cryptoProv.processByte(buf[bufferOffset], cipherIndex);
        const nStrLen   = lenResult.value;
        cipherIndex     = lenResult.nextIndex;
        bufferOffset++;

        // Capture the raw encrypted name bytes BEFORE decryption
        const rawEncryptedNameBytes = Buffer.from(buf.slice(bufferOffset, bufferOffset + nStrLen));

        const encodedNameBuf = Buffer.from(buf.slice(bufferOffset, bufferOffset + nStrLen));
        cipherIndex  = cryptoProv.processBuffer(encodedNameBuf, cipherIndex);
        bufferOffset += nStrLen;

        const metaBuf = Buffer.from(buf.slice(bufferOffset, bufferOffset + 8));
        cipherIndex   = cryptoProv.processBuffer(metaBuf, cipherIndex);
        bufferOffset += 8;

        const encodedStr     = encodedNameBuf.toString('latin1');
        const decodedName    = codec.decode(encodedStr);
        const packIdOriginal = codec.getPackId(encodedStr);
        const offset         = metaBuf.readUInt32LE(0);
        const size           = metaBuf.readUInt32LE(4);

        results.set(decodedName, {
            rawEncryptedNameBytes,   // bytes as they appear in data.000 (encrypted)
            encodedStr,              // after XOR decryption, before codec.decode()
            encodedStrHex:           hex(encodedStr),
            saltPrefix:              encodedStr[0],
            saltSuffix:              encodedStr[encodedStr.length - 1],
            packIdFromOriginalEnc:   packIdOriginal,
            decodedName,
            offset,
            size,
            indexOffset
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
try {

console.log('\n  PackId Trace Diagnostic');
console.log('  ' + '═'.repeat(60));
console.log('  Tracing filename encoding through every pipeline stage.\n');

// ----------------------------------------------------------------
// Steps 1-4: Raw index parse
// ----------------------------------------------------------------
console.log('  [1-4] Parsing data.000 raw...');
const rawMap = parseRawIndex();
console.log(`        ${rawMap.size.toLocaleString()} entries parsed.\n`);

// ----------------------------------------------------------------
// Steps 5-6: Re-encode with default salts and compare packId
// ----------------------------------------------------------------
const codec = new FilenameCodec();

console.log('  [5-6] Re-encoding with default salts (\'a\'/\'z\')...\n');

for (const name of CHECK) {
    const raw = rawMap.get(name);
    if (!raw) { console.log(`  [MISSING] ${name} not found in index\n`); continue; }

    const reEncodedDefault    = codec.encode(name);              // default 'a'/'z' salts
    const packIdFromReEncoded = codec.getPackId(reEncodedDefault);

    const saltMatch = (raw.saltPrefix === 'a' && raw.saltSuffix === 'z');

    console.log(`  ── ${name}`);
    printRow('Raw encrypted bytes (first 12)',   hex(raw.rawEncryptedNameBytes));
    printRow('Decrypted encoded string (hex)',   raw.encodedStrHex);
    printRow('Original salt prefix',             `'${raw.saltPrefix}' (0x${raw.saltPrefix.charCodeAt(0).toString(16).padStart(2,'0')})`);
    printRow('Original salt suffix',             `'${raw.saltSuffix}' (0x${raw.saltSuffix.charCodeAt(0).toString(16).padStart(2,'0')})`);
    printRow('Salts match default (a/z)',         saltMatch ? 'YES' : 'NO  ← MISMATCH', saltMatch ? '' : '⚠');
    printRow('packId from ORIGINAL encoded str', raw.packIdFromOriginalEnc);
    printRow('Re-encoded with a/z (hex)',        hex(reEncodedDefault));
    printRow('packId from RE-ENCODED (a/z)',     packIdFromReEncoded,
        packIdFromReEncoded !== raw.packIdFromOriginalEnc ? '⚠ DIFFERS' : '✓ matches');
    console.log('');
}

// ----------------------------------------------------------------
// Steps 7-8: Blueprint and session staging
// ----------------------------------------------------------------
console.log('  [7-8] Checking Blueprint records and staged packIds...\n');

const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
assetStore.ensureNullAsset();

const fpStore = new FingerprintStore(path.join(STORE_DIR, 'fingerprints.jsonl'), assetStore);
await fpStore.load();
await fpStore.ensureNullAsset();

const indexFp   = await Blueprint.fingerprintFile(INDEX_PATH);
const blueprint = await Blueprint.loadFromDisk(STORE_DIR, indexFp);

if (!blueprint) {
    console.log('  [SKIP] No blueprint found — run extraction first.\n');
    process.exit(0);
}

// Build map: decodedName → BlueprintRecord
const bpMap = new Map();
for (const record of blueprint.getRecords()) {
    if (record.decodedName) bpMap.set(record.decodedName, record);
}

// Open a session from the blueprint
const tmpDir = path.join(ROOT, 'store', '_diag_trace');
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const config  = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, tmpDir);
const manager = new SessionManager(tmpDir, fpStore, assetStore);
const session = await manager.openFromBlueprint(indexFp, STORE_DIR, config, 'trace-diag');
await manager.prepare(session.sessionId);

const packList = JSON.parse(fs.readFileSync(
    path.join(session.workingDir, 'pack-list.json'), 'utf8'
));
const plMap = new Map(packList.map(f => [f.targetName, f]));

for (const name of CHECK) {
    const raw    = rawMap.get(name);
    const bpRec  = bpMap.get(name);
    const staged = session.listFiles().find(f => f.targetName === name);
    const inList = plMap.get(name);

    if (!raw) continue;

    const bpPackId     = bpRec?.packId     ?? 'null';
    const stagedPackId = staged?.packId    ?? 'null';
    const listPackId   = inList?.packId    ?? 'null';
    const origPackId   = raw.packIdFromOriginalEnc;

    const bpMatch     = bpPackId     === origPackId;
    const stagedMatch = stagedPackId === origPackId;
    const listMatch   = listPackId   === origPackId;

    console.log(`  ── ${name}`);
    printRow('packId (original index)',  origPackId);
    printRow('packId (BlueprintRecord)', bpPackId,     bpMatch     ? '✓' : '⚠ MISMATCH');
    printRow('packId (StagedFile)',      stagedPackId, stagedMatch ? '✓' : '⚠ MISMATCH');
    printRow('packId (pack-list.json)',  listPackId,   listMatch   ? '✓' : '⚠ MISMATCH');
    console.log('');
}

// ----------------------------------------------------------------
// Summary: which step is where the mismatch first appears
// ----------------------------------------------------------------
console.log('  Summary');
console.log('  ' + '─'.repeat(60));

let allSaltsDefault = true;
let firstMismatchStep = null;

for (const name of CHECK) {
    const raw    = rawMap.get(name);
    const bpRec  = bpMap.get(name);
    const staged = session.listFiles().find(f => f.targetName === name);
    const inList = plMap.get(name);
    if (!raw) continue;

    if (raw.saltPrefix !== 'a' || raw.saltSuffix !== 'z') allSaltsDefault = false;

    const origId   = raw.packIdFromOriginalEnc;
    const bpId     = bpRec?.packId ?? null;
    const stagedId = staged?.packId ?? null;
    const listId   = inList?.packId ?? null;

    if (bpId !== origId && !firstMismatchStep)     firstMismatchStep = 'BlueprintRecord';
    if (stagedId !== origId && !firstMismatchStep) firstMismatchStep = 'StagedFile (session.openFromBlueprint)';
    if (listId !== origId && !firstMismatchStep)   firstMismatchStep = 'pack-list.json (prepare)';
}

console.log(`  All original salts are 'a'/'z':  ${allSaltsDefault ? 'YES' : 'NO — SALT MISMATCH IS ROOT CAUSE'}`);
console.log(`  First mismatch appears at:        ${firstMismatchStep || 'none detected (all match)'}`);

// Cleanup
await manager.discard(session.sessionId);
fs.rmSync(tmpDir, { recursive: true });
console.log('\n  Done.\n');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

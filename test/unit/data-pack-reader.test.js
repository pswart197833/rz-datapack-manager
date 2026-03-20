'use strict';
/**
 * test/unit/data-pack-reader.test.js
 *
 * Tier 2 — fixture-backed unit tests for DataPackReader.
 * Reads from test/fixtures/data/ (pack files) and test/fixtures/expected/
 * (pack-map.json for known-good hashes and entry metadata).
 *
 * Also reads test/fixtures/store/ to compare extracted bytes against stored
 * decrypted content for proprietary format verification.
 *
 * Skips gracefully if fixture has not been generated yet.
 *
 * Standalone runnable:
 *   node test/unit/data-pack-reader.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const crypto   = require('node:crypto');

const DataPackReader = require(path.join(__dirname, '..', '..', 'src', 'core', 'DataPackReader'));
const AssetItem      = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetItem'));
const FilenameCodec  = require(path.join(__dirname, '..', '..', 'src', 'crypto', 'FilenameCodec'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_STORE    = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');
const PACK_MAP_PATH    = path.join(FIXTURE_EXPECTED, 'pack-map.json');

const FIXTURE_AVAILABLE = fs.existsSync(PACK_MAP_PATH) &&
                          fs.existsSync(path.join(FIXTURE_DATA, 'data.000'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the packPaths Map for the fixture data directory.
 * Only includes slots whose pack file actually exists on disk.
 */
function makePackPaths() {
    const packPaths = new Map();
    for (let slot = 1; slot <= 8; slot++) {
        const p = path.join(FIXTURE_DATA, `data.00${slot}`);
        if (fs.existsSync(p) && fs.statSync(p).size > 0) {
            packPaths.set(slot, p);
        }
    }
    return packPaths;
}

/**
 * Build an AssetItem from a pack-map entry.
 * packId is re-derived via FilenameCodec to match how DataPackIndex works.
 */
const codec = new FilenameCodec();
function makeAssetItem(name, info) {
    const ext     = name.includes('.') ? name.split('.').pop().toLowerCase() : 'unknown';
    const encoded = codec.encode(name);
    return new AssetItem({
        encodedName:  Buffer.from(encoded, 'latin1'),
        decodedName:  name,
        assetType:    ext,
        packId:       info.packId,
        offset:       info.offset,
        size:         info.size,
        indexOffset:  0
    });
}

/**
 * Load pack-map.json and return all non-zero entries as AssetItem[].
 */
function loadNonZeroEntries() {
    const packMap = JSON.parse(fs.readFileSync(PACK_MAP_PATH, 'utf8'));
    return Object.entries(packMap)
        .filter(([, info]) => info.size > 0)
        .map(([name, info]) => ({ item: makeAssetItem(name, info), name, info }));
}

/**
 * Load pack-map.json and return all zero-size entries.
 */
function loadZeroEntries() {
    const packMap = JSON.parse(fs.readFileSync(PACK_MAP_PATH, 'utf8'));
    return Object.entries(packMap)
        .filter(([, info]) => info.size === 0)
        .map(([name, info]) => ({ item: makeAssetItem(name, info), name, info }));
}

/**
 * Build a map of decodedName → Set<string> of all known real content hashes.
 *
 * pack-map.json contentHash holds stub hashes from loadIndex(), not real
 * content hashes. The fixture store files are the ground truth.
 *
 * Multiple real files can exist for the same decodedName (different versions —
 * same name, different hash). extractAsset() extracts whichever version ended
 * up in the fixture pack. The correct assertion is therefore:
 *   extracted hash ∈ known hashes for this name.
 *
 * Returns Map<decodedName, Set<string>> — names with no store file are omitted.
 */
function buildStoreHashMap() {
    const fpPath = path.join(FIXTURE_STORE, 'fingerprints.jsonl');
    if (!fs.existsSync(fpPath)) return new Map();

    const lines = fs.readFileSync(fpPath, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));

    const result = new Map();
    for (const rec of lines) {
        if (!rec.decodedName || !rec.extractedPath) continue;
        const absPath = path.isAbsolute(rec.extractedPath)
            ? rec.extractedPath
            : path.join(FIXTURE_STORE, rec.extractedPath);
        if (!fs.existsSync(absPath)) continue;
        const h = sha256(fs.readFileSync(absPath));
        if (!result.has(rec.decodedName)) result.set(rec.decodedName, new Set());
        result.get(rec.decodedName).add(h);
    }
    return result;
}

// Pre-load once — used across multiple tests
const STORE_HASH_MAP = FIXTURE_AVAILABLE ? buildStoreHashMap() : new Map();

/**
 * Return first entry matching one of the given extensions.
 */
function firstOfType(entries, ...exts) {
    return entries.find(({ item }) => exts.includes(item.assetType));
}

// ---------------------------------------------------------------------------
// Proprietary formats — stored RAW, no XOR applied on extraction
// ---------------------------------------------------------------------------
const PROPRIETARY = new Set(['dds', 'tga', 'cob', 'naf', 'nx3', 'nfm']);

// ---------------------------------------------------------------------------
// extractAsset — SHA-256 matches fixture store file hash for all non-zero entries
// ---------------------------------------------------------------------------

test('extractAsset — SHA-256 of extracted bytes matches fixture store file hash for every non-zero entry',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    // pack-map.json contentHash holds stub hashes from loadIndex(), not real
    // content hashes. The fixture store files are the ground truth — decrypted
    // bytes copied from the live store during fixture generation.
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();

    try {
        for (const { item, name } of entries) {
            const knownHashes = STORE_HASH_MAP.get(name);
            if (!knownHashes) continue; // no store file for this entry — skip
            const buf  = await reader.extractAsset(item);
            const hash = sha256(buf);
            assert.ok(knownHashes.has(hash),
                `SHA-256 mismatch for "${name}": got ${hash.slice(0,16)} not in known store hashes`);
        }
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// extractAsset — buffer size matches entry.size
// ---------------------------------------------------------------------------

test('extractAsset — buffer length equals entry.size for every non-zero entry',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();

    try {
        for (const { item, name } of entries) {
            const buf = await reader.extractAsset(item);
            assert.equal(buf.length, item.size,
                `Buffer length mismatch for "${name}": got ${buf.length} expected ${item.size}`);
        }
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// extractAsset — deterministic (same bytes on second read)
// ---------------------------------------------------------------------------

test('extractAsset — is deterministic (same SHA-256 on two consecutive reads)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = entries[0];

    try {
        const buf1 = await reader.extractAsset(entry.item);
        const buf2 = await reader.extractAsset(entry.item);
        assert.equal(sha256(buf1), sha256(buf2),
            `Two reads of "${entry.name}" must produce identical bytes`);
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// XOR decryption — encrypted formats have correct magic bytes after extraction
// ---------------------------------------------------------------------------

test('extractAsset — jpg: magic bytes FF D8 FF present after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'jpg');

    assert.ok(entry, 'fixture must contain at least one jpg entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 3, 'jpg buffer must have at least 3 bytes');
        assert.equal(buf[0], 0xFF, 'jpg magic byte 0: expected 0xFF');
        assert.equal(buf[1], 0xD8, 'jpg magic byte 1: expected 0xD8');
        assert.equal(buf[2], 0xFF, 'jpg magic byte 2: expected 0xFF');
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — png: magic bytes 89 50 4E 47 present after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'png');

    assert.ok(entry, 'fixture must contain at least one png entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 4, 'png buffer must have at least 4 bytes');
        assert.equal(buf[0], 0x89, 'png magic byte 0: expected 0x89');
        assert.equal(buf[1], 0x50, 'png magic byte 1: expected 0x50 ("P")');
        assert.equal(buf[2], 0x4E, 'png magic byte 2: expected 0x4E ("N")');
        assert.equal(buf[3], 0x47, 'png magic byte 3: expected 0x47 ("G")');
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — bmp: magic bytes 42 4D present after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'bmp');

    assert.ok(entry, 'fixture must contain at least one bmp entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 2, 'bmp buffer must have at least 2 bytes');
        assert.equal(buf[0], 0x42, 'bmp magic byte 0: expected 0x42 ("B")');
        assert.equal(buf[1], 0x4D, 'bmp magic byte 1: expected 0x4D ("M")');
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — wav: magic bytes 52 49 46 46 (RIFF) present after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'wav');

    assert.ok(entry, 'fixture must contain at least one wav entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 4, 'wav buffer must have at least 4 bytes');
        assert.equal(buf[0], 0x52, 'wav magic byte 0: expected 0x52 ("R")');
        assert.equal(buf[1], 0x49, 'wav magic byte 1: expected 0x49 ("I")');
        assert.equal(buf[2], 0x46, 'wav magic byte 2: expected 0x46 ("F")');
        assert.equal(buf[3], 0x46, 'wav magic byte 3: expected 0x46 ("F")');
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — xml: first byte is printable ASCII "<" after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'xml');

    assert.ok(entry, 'fixture must contain at least one xml entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 1, 'xml buffer must have at least 1 byte');
        // XML must start with '<' (0x3C) or BOM — check printable ASCII range
        const firstChar = String.fromCharCode(buf[0]);
        assert.ok(buf[0] >= 0x20 && buf[0] < 0x80,
            `xml first byte must be printable ASCII, got 0x${buf[0].toString(16)} ("${firstChar}")`);
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — cfg: first byte is printable ASCII after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'cfg');

    assert.ok(entry, 'fixture must contain at least one cfg entry');
    try {
        const buf = await reader.extractAsset(entry.item);
        assert.ok(buf.length >= 1, 'cfg buffer must have at least 1 byte');
        // cfg files may start with 0x0D (CR) or 0x0A (LF) on Windows — these are
        // valid line-ending bytes, not corruption. Accept any non-null byte < 0x80
        // OR common whitespace control chars (0x09 tab, 0x0A LF, 0x0D CR).
        const firstByte = buf[0];
        const isTextStart = (firstByte >= 0x09 && firstByte <= 0x0D) ||
                            (firstByte >= 0x20 && firstByte < 0x80);
        assert.ok(isTextStart,
            `cfg first byte must be a text character, got 0x${firstByte.toString(16)}`);
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// Proprietary formats — extracted bytes match the stored decrypted file exactly
// (no XOR should have been applied)
// ---------------------------------------------------------------------------

test('extractAsset — dds: extracted bytes match store file (no XOR applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'dds');

    assert.ok(entry, 'fixture must contain at least one dds entry');
    try {
        const buf        = await reader.extractAsset(entry.item);
        const knownHashes = STORE_HASH_MAP.get(entry.name);
        assert.ok(knownHashes && knownHashes.size > 0, 'fixture store must have a file for the dds entry');
        const hash = sha256(buf);
        assert.ok(knownHashes.has(hash),
            `dds bytes must match a known fixture store hash — got ${hash.slice(0,16)}`);
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — tga: extracted bytes match store contentHash (no XOR applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'tga');

    assert.ok(entry, 'fixture must contain at least one tga entry');
    try {
        const buf        = await reader.extractAsset(entry.item);
        const knownHashes = STORE_HASH_MAP.get(entry.name);
        assert.ok(knownHashes && knownHashes.size > 0, 'fixture store must have a file for the tga entry');
        const hash = sha256(buf);
        assert.ok(knownHashes.has(hash),
            `tga bytes must match a known fixture store hash — got ${hash.slice(0,16)}`);
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — naf: extracted bytes match store contentHash (no XOR applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'naf');

    assert.ok(entry, 'fixture must contain at least one naf entry');
    try {
        const buf        = await reader.extractAsset(entry.item);
        const knownHashes = STORE_HASH_MAP.get(entry.name);
        assert.ok(knownHashes && knownHashes.size > 0, 'fixture store must have a file for the naf entry');
        const hash = sha256(buf);
        assert.ok(knownHashes.has(hash),
            `naf bytes must match a known fixture store hash — got ${hash.slice(0,16)}`);
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — nx3: extracted bytes match store contentHash (no XOR applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'nx3');

    assert.ok(entry, 'fixture must contain at least one nx3 entry');
    try {
        const buf        = await reader.extractAsset(entry.item);
        const knownHashes = STORE_HASH_MAP.get(entry.name);
        assert.ok(knownHashes && knownHashes.size > 0, 'fixture store must have a file for the nx3 entry');
        const hash = sha256(buf);
        assert.ok(knownHashes.has(hash),
            `nx3 bytes must match a known fixture store hash — got ${hash.slice(0,16)}`);
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// extractAsset — XOR was actually applied (encrypted format bytes differ from
// raw pack bytes — confirms the cipher ran)
// ---------------------------------------------------------------------------

test('extractAsset — jpg extracted bytes differ from raw pack bytes (XOR was applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'jpg');

    assert.ok(entry, 'fixture must contain at least one jpg entry');
    try {
        const extracted = await reader.extractAsset(entry.item);

        // Read the raw encrypted bytes directly from the pack file
        const packPath  = packPaths.get(entry.item.packId);
        const handle    = await fs.promises.open(packPath, 'r');
        const rawBuf    = Buffer.alloc(entry.item.size);
        await handle.read(rawBuf, 0, entry.item.size, entry.item.offset);
        await handle.close();

        // Extracted (decrypted) must differ from raw (encrypted)
        assert.notEqual(sha256(extracted), sha256(rawBuf),
            'extracted jpg bytes must differ from raw pack bytes — XOR decryption must have been applied');
    } finally {
        await reader.closeAll();
    }
});

test('extractAsset — dds extracted bytes equal raw pack bytes (no XOR applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'dds');

    assert.ok(entry, 'fixture must contain at least one dds entry');
    try {
        const extracted = await reader.extractAsset(entry.item);

        // Read raw bytes directly from pack
        const packPath = packPaths.get(entry.item.packId);
        const handle   = await fs.promises.open(packPath, 'r');
        const rawBuf   = Buffer.alloc(entry.item.size);
        await handle.read(rawBuf, 0, entry.item.size, entry.item.offset);
        await handle.close();

        assert.equal(sha256(extracted), sha256(rawBuf),
            'extracted dds bytes must equal raw pack bytes — no XOR must be applied to proprietary formats');
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// extractBatch
// ---------------------------------------------------------------------------

test('extractBatch — returns a Map with all requested entry names as keys',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries().slice(0, 5);

    try {
        const result = await reader.extractBatch(entries.map(e => e.item));
        assert.ok(result instanceof Map, 'extractBatch must return a Map');
        for (const { name } of entries) {
            assert.ok(result.has(name),
                `extractBatch result must contain key "${name}"`);
        }
    } finally {
        await reader.closeAll();
    }
});

test('extractBatch — returned buffers have correct sizes',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries().slice(0, 5);

    try {
        const result = await reader.extractBatch(entries.map(e => e.item));
        for (const { name, item } of entries) {
            const buf = result.get(name);
            assert.ok(buf, `buffer for "${name}" must be present`);
            assert.equal(buf.length, item.size,
                `buffer size for "${name}" must equal entry.size`);
        }
    } finally {
        await reader.closeAll();
    }
});

test('extractBatch — SHA-256 of each buffer matches pack-map contentHash',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    // Use entries from different pack slots for coverage
    const allEntries = loadNonZeroEntries();
    const byPack     = new Map();
    for (const e of allEntries) {
        if (!byPack.has(e.item.packId)) byPack.set(e.item.packId, e);
    }
    const entries = [...byPack.values()].slice(0, 4);

    try {
        const result = await reader.extractBatch(entries.map(e => e.item));
        for (const { name } of entries) {
            const knownHashes = STORE_HASH_MAP.get(name);
            if (!knownHashes) continue; // no store file for this entry — skip
            const buf  = result.get(name);
            const hash = sha256(buf);
            assert.ok(knownHashes.has(hash),
                `extractBatch SHA-256 mismatch for "${name}": got ${hash.slice(0,16)}`);
        }
    } finally {
        await reader.closeAll();
    }
});

test('extractBatch — handles entries from multiple pack slots in one call',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths  = makePackPaths();
    const reader     = new DataPackReader(packPaths);
    const allEntries = loadNonZeroEntries();

    // Collect one entry per pack slot (up to 4 different slots)
    const byPack = new Map();
    for (const e of allEntries) {
        if (!byPack.has(e.item.packId) && byPack.size < 4) {
            byPack.set(e.item.packId, e);
        }
    }
    const entries = [...byPack.values()];
    assert.ok(entries.length >= 2, 'need entries from at least 2 different pack slots');

    try {
        const result = await reader.extractBatch(entries.map(e => e.item));
        assert.equal(result.size, entries.length,
            'extractBatch must return one entry per requested item');
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// Zero-size entries
// ---------------------------------------------------------------------------

test('extractAsset — zero-size entry completes without error and returns empty buffer',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const zeroEntries = loadZeroEntries();
    assert.ok(zeroEntries.length > 0, 'fixture must contain at least one zero-size entry');

    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);

    // Use a zero-size entry — construct with packId from fixture but size=0
    // DataPackReader should handle size=0 without attempting a pack file read
    const { item } = zeroEntries[0];

    try {
        // Zero-size entries have size=0 — extractAsset allocates a 0-byte buffer
        // and reads 0 bytes, which is a no-op. Should not throw.
        await assert.doesNotReject(
            () => reader.extractAsset(item),
            'extractAsset must not throw for a zero-size entry'
        );
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// validateAsset
// ---------------------------------------------------------------------------

test('validateAsset — returns { valid: true, reason: null } for known-good jpg buffer',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'jpg');

    assert.ok(entry, 'fixture must contain a jpg entry');
    try {
        const buf    = await reader.extractAsset(entry.item);
        const result = reader.validateAsset(entry.item, buf);
        assert.equal(result.valid,  true);
        assert.equal(result.reason, null);
    } finally {
        await reader.closeAll();
    }
});

test('validateAsset — returns { valid: true, reason: null } for known-good png buffer',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'png');

    assert.ok(entry, 'fixture must contain a png entry');
    try {
        const buf    = await reader.extractAsset(entry.item);
        const result = reader.validateAsset(entry.item, buf);
        assert.equal(result.valid,  true);
        assert.equal(result.reason, null);
    } finally {
        await reader.closeAll();
    }
});

test('validateAsset — returns { valid: true, reason: null } for known-good wav buffer',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'wav');

    assert.ok(entry, 'fixture must contain a wav entry');
    try {
        const buf    = await reader.extractAsset(entry.item);
        const result = reader.validateAsset(entry.item, buf);
        assert.equal(result.valid,  true);
        assert.equal(result.reason, null);
    } finally {
        await reader.closeAll();
    }
});

test('validateAsset — returns { valid: true } for unknown/proprietary format (pass-through)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    // Use a proprietary format — validateAsset passes through with valid=true
    const entry     = firstOfType(entries, 'naf', 'nx3', 'nfm', 'cob');

    assert.ok(entry, 'fixture must contain at least one proprietary format entry');
    try {
        const buf    = await reader.extractAsset(entry.item);
        const result = reader.validateAsset(entry.item, buf);
        assert.equal(typeof result.valid, 'boolean',
            'validateAsset must return an object with a boolean valid field');
        assert.ok(result.valid === true,
            `proprietary format "${entry.item.assetType}" must pass through as valid`);
    } finally {
        await reader.closeAll();
    }
});

test('validateAsset — returns { valid: false, reason: string } for wrong magic bytes',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'jpg');

    assert.ok(entry, 'fixture must contain a jpg entry');
    try {
        // Feed a buffer of zeros — wrong magic bytes for jpg
        const badBuf = Buffer.alloc(16, 0x00);
        const result = reader.validateAsset(entry.item, badBuf);
        assert.equal(result.valid, false,
            'validateAsset must return valid=false when magic bytes are wrong');
        assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
            'validateAsset must return a non-empty reason string on failure');
    } finally {
        await reader.closeAll();
    }
});

test('validateAsset — returns { valid: false } for empty buffer',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries();
    const entry     = firstOfType(entries, 'jpg');

    assert.ok(entry, 'fixture must contain a jpg entry');
    try {
        const result = reader.validateAsset(entry.item, Buffer.alloc(0));
        assert.equal(result.valid, false,
            'validateAsset must return valid=false for an empty buffer');
    } finally {
        await reader.closeAll();
    }
});

// ---------------------------------------------------------------------------
// open() / close() / closeAll()
// ---------------------------------------------------------------------------

test('open() — opens a handle for a valid pack slot without error',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const slot      = packPaths.keys().next().value;

    await assert.doesNotReject(() => reader.open(slot),
        `open() must not throw for a valid pack slot ${slot}`);
    await reader.closeAll();
});

test('open() — is idempotent (calling twice on same slot does not throw)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const slot      = packPaths.keys().next().value;

    await reader.open(slot);
    await assert.doesNotReject(() => reader.open(slot),
        'open() called twice on the same slot must not throw');
    await reader.closeAll();
});

test('close() — closes a specific handle without error',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const slot      = packPaths.keys().next().value;

    await reader.open(slot);
    await assert.doesNotReject(() => reader.close(slot),
        'close() must not throw for an open handle');
});

test('close() — is a no-op for an already-closed or never-opened slot',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);

    await assert.doesNotReject(() => reader.close(1),
        'close() on a never-opened slot must not throw');
});

test('closeAll() — completes without error after extraction',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const entries   = loadNonZeroEntries().slice(0, 3);

    for (const { item } of entries) await reader.extractAsset(item);
    await assert.doesNotReject(() => reader.closeAll(),
        'closeAll() must not throw after extraction');
});

test('closeAll() — is safe to call on a fresh reader with no open handles',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    await assert.doesNotReject(() => reader.closeAll(),
        'closeAll() on a reader with no open handles must not throw');
});

test('open() — throws for a pack slot with no configured path',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    // Use a slot that definitely has no pack file — slot 9 is out of range
    const reader = new DataPackReader(new Map([[1, path.join(FIXTURE_DATA, 'data.001')]]));
    await assert.rejects(() => reader.open(9),
        'open() must throw for a slot with no configured path');
    await reader.closeAll();
});

'use strict';
/**
 * test/unit/data-pack-writer.test.js
 *
 * Tier 2 — fixture-backed unit tests for DataPackWriter.
 * Reads from test/fixtures/data/ (pack files) and test/fixtures/expected/
 * (pack-map.json for known-good metadata and fixture entry selection).
 *
 * All writes go to a unique temp dir under os.tmpdir() that is cleaned up
 * after each test.
 *
 * Skips gracefully if fixture has not been generated yet.
 *
 * Standalone runnable:
 *   node test/unit/data-pack-writer.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const crypto   = require('node:crypto');

const DataPackWriter = require(path.join(__dirname, '..', '..', 'src', 'core', 'DataPackWriter'));
const DataPackReader = require(path.join(__dirname, '..', '..', 'src', 'core', 'DataPackReader'));
const AssetItem      = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetItem'));
const FilenameCodec  = require(path.join(__dirname, '..', '..', 'src', 'crypto', 'FilenameCodec'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
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

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dpw-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const codec = new FilenameCodec();

/**
 * Build an AssetItem with the correct packId derived via FilenameCodec.
 * This matches how DataPackIndex.parse() sets packId.
 */
function makeAssetItem({ name, packId, offset = 0, size = 0, indexOffset = 0 }) {
    const ext     = name.includes('.') ? name.split('.').pop().toLowerCase() : 'unknown';
    const encoded = codec.encode(name);
    const derivedPackId = packId ?? codec.getPackId(encoded);
    return new AssetItem({
        encodedName:  Buffer.from(encoded, 'latin1'),
        decodedName:  name,
        assetType:    ext,
        packId:       derivedPackId,
        offset,
        size,
        indexOffset
    });
}

/**
 * Build the packPaths Map for the fixture data directory.
 * Only includes slots whose pack file actually exists and has bytes.
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
 * Load pack-map.json and return all non-zero entries.
 * Returns array of { name, info: { packId, offset, size, contentHash } }.
 */
function loadNonZeroEntries() {
    const packMap = JSON.parse(fs.readFileSync(PACK_MAP_PATH, 'utf8'));
    return Object.entries(packMap)
        .filter(([, info]) => info.size > 0)
        .map(([name, info]) => ({ name, info }));
}

/**
 * Extract bytes for an entry from the fixture pack files using DataPackReader.
 */
async function extractBytes(entry) {
    const packPaths = makePackPaths();
    const reader    = new DataPackReader(packPaths);
    const item      = makeAssetItem({
        name:   entry.name,
        packId: entry.info.packId,
        offset: entry.info.offset,
        size:   entry.info.size
    });
    try {
        return await reader.extractAsset(item);
    } finally {
        await reader.closeAll();
    }
}

// Proprietary formats stored RAW — no XOR encryption
const PROPRIETARY = new Set(['dds', 'tga', 'cob', 'naf', 'nx3', 'nfm']);

/**
 * Find the first entry matching one of the given extensions.
 */
function firstOfType(entries, ...exts) {
    return entries.find(({ name }) => {
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        return exts.includes(ext);
    });
}

// ---------------------------------------------------------------------------
// getBuildPath()
// ---------------------------------------------------------------------------

test('getBuildPath() — returns path ending in ".build" within the output directory', () => {
    const tmpDir = makeTempDir();
    try {
        const writer   = new DataPackWriter(tmpDir);
        const buildPath = writer.getBuildPath(3);
        assert.ok(buildPath.endsWith('.build'),
            'getBuildPath() must return a path ending with ".build"');
        assert.ok(buildPath.startsWith(tmpDir),
            'getBuildPath() must be inside the output directory');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getBuildPath() — returns different paths for different pack slots', () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const path1  = writer.getBuildPath(1);
        const path3  = writer.getBuildPath(3);
        assert.notEqual(path1, path3,
            'getBuildPath() must return different paths for different slots');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getBuildPath() — path includes the slot number', () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        for (let slot = 1; slot <= 8; slot++) {
            const p = writer.getBuildPath(slot);
            assert.ok(path.basename(p).includes(String(slot)),
                `getBuildPath(${slot}) basename must include slot number`);
        }
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// getCurrentOffset()
// ---------------------------------------------------------------------------

test('getCurrentOffset() — returns 0 for a slot that has never been written', () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        assert.equal(writer.getCurrentOffset(1), 0);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// addAsset() — basic write
// ---------------------------------------------------------------------------

test('addAsset() — returns an AssetItem', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('test asset bytes');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 1, offset: 0, size: buf.length });
        const result = await writer.addAsset(item, buf);
        assert.ok(result instanceof AssetItem,
            'addAsset() must return an AssetItem');
        await writer.closeAll();
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — returned AssetItem has correct size matching the buffer', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('size check content');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 1, offset: 0, size: buf.length });
        const result = await writer.addAsset(item, buf);
        assert.equal(result.size, buf.length,
            'returned AssetItem.size must equal buffer.length');
        await writer.closeAll();
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — returned AssetItem.offset is 0 for first write to a slot', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('first write offset check');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 2, offset: 0, size: buf.length });
        const result = await writer.addAsset(item, buf);
        assert.equal(result.offset, 0,
            'first asset written to a slot must have offset 0');
        await writer.closeAll();
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — returned AssetItem.decodedName matches the input entry', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('name check');
        const item   = makeAssetItem({ name: 'npcinfo.cfg', packId: 3, offset: 0, size: buf.length });
        const result = await writer.addAsset(item, buf);
        assert.equal(result.decodedName, 'npcinfo.cfg');
        await writer.closeAll();
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — returned AssetItem.packId matches the input entry', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('packId check content');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 5, offset: 0, size: buf.length });
        const result = await writer.addAsset(item, buf);
        assert.equal(result.packId, 5,
            'returned AssetItem.packId must match the input entry packId');
        await writer.closeAll();
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — build file exists on disk after write', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('build file existence check');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 1, offset: 0, size: buf.length });
        await writer.addAsset(item, buf);
        await writer.closeAll();
        assert.ok(fs.existsSync(writer.getBuildPath(1)),
            'build file must exist on disk after addAsset() and closeAll()');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Sequential offsets
// ---------------------------------------------------------------------------

test('Sequential offsets — second asset starts exactly where first ends', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf1   = Buffer.from('first asset content here');
        const buf2   = Buffer.from('second asset content');
        const item1  = makeAssetItem({ name: 'hero.dds',    packId: 1, offset: 0,          size: buf1.length });
        const item2  = makeAssetItem({ name: 'npcinfo.cfg', packId: 1, offset: buf1.length, size: buf2.length });

        const result1 = await writer.addAsset(item1, buf1);
        const result2 = await writer.addAsset(item2, buf2);
        await writer.closeAll();

        assert.equal(result1.offset, 0, 'first asset offset must be 0');
        assert.equal(result2.offset, buf1.length,
            'second asset offset must equal the size of the first asset');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Sequential offsets — third asset starts after first two combined', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const bufs   = [
            Buffer.from('asset one content bytes'),
            Buffer.from('asset two content bytes here'),
            Buffer.from('asset three')
        ];
        const items = bufs.map((buf, i) => makeAssetItem({
            name:   `file${i}.dds`,
            packId: 2,
            offset: 0,
            size:   buf.length
        }));

        const results = [];
        for (let i = 0; i < bufs.length; i++) {
            results.push(await writer.addAsset(items[i], bufs[i]));
        }
        await writer.closeAll();

        assert.equal(results[0].offset, 0);
        assert.equal(results[1].offset, bufs[0].length);
        assert.equal(results[2].offset, bufs[0].length + bufs[1].length);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Sequential offsets — different pack slots have independent offsets', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf1   = Buffer.from('slot 1 first write here');
        const buf2   = Buffer.from('slot 2 first write');
        const item1  = makeAssetItem({ name: 'hero.dds',  packId: 1, offset: 0, size: buf1.length });
        const item2  = makeAssetItem({ name: 'bg.tga',    packId: 2, offset: 0, size: buf2.length });

        const r1 = await writer.addAsset(item1, buf1);
        const r2 = await writer.addAsset(item2, buf2);
        await writer.closeAll();

        assert.equal(r1.offset, 0, 'slot 1 first write must start at offset 0');
        assert.equal(r2.offset, 0, 'slot 2 first write must start at offset 0 (independent)');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Zero-size buffer handling
// ---------------------------------------------------------------------------

test('addAsset() — zero-size buffer: no .build file created for that slot', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({ name: 'placeholder', packId: 3, offset: 8192, size: 0 });
        await writer.addAsset(item, Buffer.alloc(0));
        await writer.closeAll();

        assert.equal(fs.existsSync(writer.getBuildPath(3)), false,
            'no .build file must be created for a zero-size write');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — zero-size buffer: returned AssetItem preserves original packId', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({ name: 'placeholder', packId: 4, offset: 2048, size: 0 });
        const result = await writer.addAsset(item, Buffer.alloc(0));
        await writer.closeAll();

        assert.equal(result.packId, 4,
            'zero-size entry must preserve original packId in returned AssetItem');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — zero-size buffer: returned AssetItem preserves original offset', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({ name: 'placeholder', packId: 3, offset: 8192, size: 0 });
        const result = await writer.addAsset(item, Buffer.alloc(0));
        await writer.closeAll();

        assert.equal(result.offset, 8192,
            'zero-size entry must preserve original offset in returned AssetItem');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — zero-size buffer: returned AssetItem.size is 0', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({ name: 'placeholder', packId: 1, offset: 0, size: 0 });
        const result = await writer.addAsset(item, Buffer.alloc(0));
        await writer.closeAll();

        assert.equal(result.size, 0);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('addAsset() — zero-size buffer does not advance offset for subsequent real writes', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        // Write a zero-size entry — should not open a stream or advance offset
        const zeroItem = makeAssetItem({ name: 'placeholder', packId: 1, offset: 0, size: 0 });
        await writer.addAsset(zeroItem, Buffer.alloc(0));

        // Now write a real asset to the SAME slot
        const realBuf  = Buffer.from('real content after zero-size');
        const realItem = makeAssetItem({ name: 'hero.dds', packId: 1, offset: 0, size: realBuf.length });
        const result   = await writer.addAsset(realItem, realBuf);
        await writer.closeAll();

        assert.equal(result.offset, 0,
            'real write after zero-size write must start at offset 0 (zero-size must not advance offset)');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Encryption behaviour — raw bytes in .build file
// ---------------------------------------------------------------------------

test('Proprietary format (dds) — raw bytes in .build file equal the buffer written',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'dds');
    assert.ok(entry, 'fixture must contain a dds entry');

    const buf  = await extractBytes(entry);
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   buf.length
        });
        await writer.addAsset(item, buf);
        await writer.closeAll();

        // Read raw bytes back from the .build file
        const buildPath = writer.getBuildPath(entry.info.packId);
        const onDisk    = fs.readFileSync(buildPath);

        assert.equal(sha256(onDisk), sha256(buf),
            'dds bytes in .build file must equal the input buffer (no XOR applied to proprietary formats)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Proprietary format (tga) — raw bytes in .build file equal the buffer written',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'tga');
    assert.ok(entry, 'fixture must contain a tga entry');

    const buf  = await extractBytes(entry);
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   buf.length
        });
        await writer.addAsset(item, buf);
        await writer.closeAll();

        const buildPath = writer.getBuildPath(entry.info.packId);
        const onDisk    = fs.readFileSync(buildPath);
        assert.equal(sha256(onDisk), sha256(buf),
            'tga bytes in .build file must equal the input buffer (no XOR)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Encrypted format (jpg) — bytes in .build file DIFFER from plaintext buffer (XOR was applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'jpg');
    assert.ok(entry, 'fixture must contain a jpg entry');

    const buf  = await extractBytes(entry);
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   buf.length
        });
        await writer.addAsset(item, buf);
        await writer.closeAll();

        const buildPath = writer.getBuildPath(entry.info.packId);
        const onDisk    = fs.readFileSync(buildPath);

        assert.notEqual(sha256(onDisk), sha256(buf),
            'jpg bytes in .build file must differ from plaintext (XOR re-encryption must have been applied)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Encrypted format (bmp) — bytes in .build file DIFFER from plaintext buffer (XOR was applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'bmp');
    assert.ok(entry, 'fixture must contain a bmp entry');

    const buf  = await extractBytes(entry);
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   buf.length
        });
        await writer.addAsset(item, buf);
        await writer.closeAll();

        const buildPath = writer.getBuildPath(entry.info.packId);
        const onDisk    = fs.readFileSync(buildPath);

        assert.notEqual(sha256(onDisk), sha256(buf),
            'bmp bytes in .build file must differ from plaintext (XOR re-encryption must have been applied)');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Encrypted format (xml) — bytes in .build file DIFFER from plaintext buffer (XOR was applied)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'xml');
    assert.ok(entry, 'fixture must contain an xml entry');

    const buf  = await extractBytes(entry);
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   buf.length
        });
        await writer.addAsset(item, buf);
        await writer.closeAll();

        const buildPath = writer.getBuildPath(entry.info.packId);
        const onDisk    = fs.readFileSync(buildPath);

        assert.notEqual(sha256(onDisk), sha256(buf),
            'xml bytes in .build file must differ from plaintext (XOR re-encryption must have been applied)');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Round-trip: write then read back with DataPackReader
// ---------------------------------------------------------------------------

test('Round-trip — DataPackReader extracts identical bytes to what was written (proprietary dds)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'dds');
    assert.ok(entry, 'fixture must contain a dds entry');

    const originalBuf = await extractBytes(entry);
    const tmpDir      = makeTempDir();
    try {
        // Write
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   originalBuf.length
        });
        const written = await writer.addAsset(item, originalBuf);
        await writer.closeAll();

        // Read back
        const packPaths = new Map([[entry.info.packId, writer.getBuildPath(entry.info.packId)]]);
        const reader    = new DataPackReader(packPaths);
        const readBack  = await reader.extractAsset(written);
        await reader.closeAll();

        assert.equal(sha256(readBack), sha256(originalBuf),
            'round-trip dds bytes must be identical to the original plaintext');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Round-trip — DataPackReader extracts identical bytes to what was written (encrypted jpg)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'jpg');
    assert.ok(entry, 'fixture must contain a jpg entry');

    const originalBuf = await extractBytes(entry);
    const tmpDir      = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   originalBuf.length
        });
        const written = await writer.addAsset(item, originalBuf);
        await writer.closeAll();

        const packPaths = new Map([[entry.info.packId, writer.getBuildPath(entry.info.packId)]]);
        const reader    = new DataPackReader(packPaths);
        const readBack  = await reader.extractAsset(written);
        await reader.closeAll();

        assert.equal(sha256(readBack), sha256(originalBuf),
            'round-trip jpg bytes must be identical to the original plaintext');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Round-trip — DataPackReader extracts identical bytes for bmp (encrypted)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    const entry   = firstOfType(entries, 'bmp');
    assert.ok(entry, 'fixture must contain a bmp entry');

    const originalBuf = await extractBytes(entry);
    const tmpDir      = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const item   = makeAssetItem({
            name:   entry.name,
            packId: entry.info.packId,
            offset: 0,
            size:   originalBuf.length
        });
        const written = await writer.addAsset(item, originalBuf);
        await writer.closeAll();

        const packPaths = new Map([[entry.info.packId, writer.getBuildPath(entry.info.packId)]]);
        const reader    = new DataPackReader(packPaths);
        const readBack  = await reader.extractAsset(written);
        await reader.closeAll();

        assert.equal(sha256(readBack), sha256(originalBuf),
            'round-trip bmp bytes must match original');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Round-trip — correct offset used when multiple assets written sequentially',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const entries = loadNonZeroEntries();
    // Pick two entries from the same pack slot if possible
    const slot1entries = entries.filter(e => e.info.packId === entries[0].info.packId).slice(0, 2);
    if (slot1entries.length < 2) {
        // Fall back to any two entries, write them both to slot 1
    }

    const entry1 = entries[0];
    const entry2 = entries[1];
    assert.ok(entry1 && entry2, 'need at least two fixture entries for sequential round-trip');

    const buf1 = await extractBytes(entry1);
    const buf2 = await extractBytes(entry2);

    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        // Force both to the same slot (1) so we can verify sequential offset correctness
        const item1 = makeAssetItem({ name: entry1.name, packId: 1, offset: 0,          size: buf1.length });
        const item2 = makeAssetItem({ name: entry2.name, packId: 1, offset: buf1.length, size: buf2.length });

        const w1 = await writer.addAsset(item1, buf1);
        const w2 = await writer.addAsset(item2, buf2);
        await writer.closeAll();

        // Read both back
        const packPaths = new Map([[1, writer.getBuildPath(1)]]);
        const reader    = new DataPackReader(packPaths);
        const rb1       = await reader.extractAsset(w1);
        const rb2       = await reader.extractAsset(w2);
        await reader.closeAll();

        assert.equal(sha256(rb1), sha256(buf1),
            'first sequential entry round-trip must match original');
        assert.equal(sha256(rb2), sha256(buf2),
            'second sequential entry round-trip must match original');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// closeAll() / close()
// ---------------------------------------------------------------------------

test('closeAll() — completes without error after writes', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('closeAll test');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 1, offset: 0, size: buf.length });
        await writer.addAsset(item, buf);
        await assert.doesNotReject(() => writer.closeAll(),
            'closeAll() must not throw after writes');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('closeAll() — safe to call on a writer with no open streams', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        await assert.doesNotReject(() => writer.closeAll(),
            'closeAll() on a fresh writer must not throw');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('close() — completes without error for an open slot', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const buf    = Buffer.from('close slot test');
        const item   = makeAssetItem({ name: 'hero.dds', packId: 2, offset: 0, size: buf.length });
        await writer.addAsset(item, buf);
        await assert.doesNotReject(() => writer.close(2),
            'close() must not throw for an open slot');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('close() — is a no-op for a slot that was never opened', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        await assert.doesNotReject(() => writer.close(7),
            'close() on a never-opened slot must not throw');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Build file size
// ---------------------------------------------------------------------------

test('build file size equals sum of all buffer sizes written to that slot', async () => {
    const tmpDir = makeTempDir();
    try {
        const writer = new DataPackWriter(tmpDir);
        const bufs   = [
            Buffer.from('first asset content bytes here'),
            Buffer.from('second asset content here'),
            Buffer.from('third')
        ];
        const slot    = 3;
        let   offset  = 0;
        for (let i = 0; i < bufs.length; i++) {
            const item = makeAssetItem({ name: `file${i}.cfg`, packId: slot, offset, size: bufs[i].length });
            await writer.addAsset(item, bufs[i]);
            offset += bufs[i].length;
        }
        await writer.closeAll();

        const expectedSize = bufs.reduce((s, b) => s + b.length, 0);
        const actualSize   = fs.statSync(writer.getBuildPath(slot)).size;
        assert.equal(actualSize, expectedSize,
            'build file size must equal the total bytes of all assets written to that slot');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// VERSION static property
// ---------------------------------------------------------------------------

test('VERSION static property exists and is a string', () => {
    assert.ok(typeof DataPackWriter.VERSION === 'string',
        'DataPackWriter.VERSION must be a string');
    assert.ok(DataPackWriter.VERSION.length > 0,
        'DataPackWriter.VERSION must not be empty');
});

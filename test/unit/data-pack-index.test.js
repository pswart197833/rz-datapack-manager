'use strict';
/**
 * test/unit/data-pack-index.test.js
 *
 * Tier 1 — pure in-memory tests (no fixture required).
 * Tier 2 — fixture-backed tests (reads test/fixtures/data/data.000 and
 *           test/fixtures/expected/entries.json + hashes.json).
 *
 * Tier 2 tests skip gracefully if the fixture has not been generated yet.
 * Run fixture generation first:
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/3.generate-fixture.js
 *
 * Standalone runnable:
 *   node test/unit/data-pack-index.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const crypto   = require('node:crypto');

const DataPackIndex = require(path.join(__dirname, '..', '..', 'src', 'core', 'DataPackIndex'));
const AssetItem     = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetItem'));
const FilenameCodec = require(path.join(__dirname, '..', '..', 'src', 'crypto', 'FilenameCodec'));

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');

const FIXTURE_INDEX   = path.join(FIXTURE_DATA,     'data.000');
const FIXTURE_ENTRIES = path.join(FIXTURE_EXPECTED, 'entries.json');
const FIXTURE_HASHES  = path.join(FIXTURE_EXPECTED, 'hashes.json');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_INDEX)
                       && fs.existsSync(FIXTURE_ENTRIES)
                       && fs.existsSync(FIXTURE_HASHES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const codec = new FilenameCodec();

/**
 * Build a minimal but valid AssetItem with a real encoded name so that
 * DataPackIndex.serialize() can round-trip it correctly.
 */
function makeItem({ name, packId = 1, offset = 0, size = 100, indexOffset = 0 } = {}) {
    const encodedStr = codec.encode(name);
    return new AssetItem({
        encodedName:  Buffer.from(encodedStr, 'latin1'),
        decodedName:  name,
        assetType:    name.includes('.') ? name.split('.').pop().toLowerCase() : 'unknown',
        packId,
        offset,
        size,
        indexOffset
    });
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Tier 1 — in-memory round-trip
// ---------------------------------------------------------------------------

test('[T1] serialize → parse round-trip — entry count matches', () => {
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0,    size: 512 }),
        makeItem({ name: 'bg.tga',      packId: 2, offset: 1024, size: 256 }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 2048, size: 128 }),
    ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries.length, items.length);
});

test('[T1] serialize → parse round-trip — decodedName survives', () => {
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0    }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 1024 }),
    ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries[0].decodedName, 'hero.dds');
    assert.equal(index2.entries[1].decodedName, 'npcinfo.cfg');
});

test('[T1] serialize → parse round-trip — offset survives', () => {
    const items = [
        makeItem({ name: 'hero.dds', packId: 1, offset: 4096  }),
        makeItem({ name: 'bg.tga',   packId: 1, offset: 16384 }),
    ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries[0].offset, 4096);
    assert.equal(index2.entries[1].offset, 16384);
});

test('[T1] serialize → parse round-trip — size survives', () => {
    const items = [
        makeItem({ name: 'hero.dds', packId: 1, offset: 0, size: 999 }),
    ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries[0].size, 999);
});

test('[T1] serialize → parse round-trip — packId is deterministically derived from filename', () => {
    // packId is NOT stored in the binary record. It is re-derived from the
    // encoded filename string via codec.getPackId() on every parse.
    // The packId field on AssetItem going in to serialize() is irrelevant —
    // only the filename determines which pack slot an asset belongs to.
    const name       = 'hero.dds';
    const expectedId = codec.getPackId(codec.encode(name));
    const items      = [ makeItem({ name, packId: 99, offset: 0 }) ]; // 99 is intentionally wrong
    const index      = new DataPackIndex();
    const buf        = index.serialize(items);
    const index2     = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries[0].packId, expectedId);
});

test('[T1] serialize → parse round-trip — zero-size entry preserved with size and offset', () => {
    // packId is re-derived from the filename on parse, so we cannot assert an
    // arbitrary packId value — instead verify size=0 and offset survive intact.
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0,    size: 512 }),
        makeItem({ name: 'placeholder', packId: 1, offset: 8192, size: 0   }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 1024, size: 256 }),
    ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);

    const zero = index2.entries.find(e => e.decodedName === 'placeholder');
    assert.ok(zero, 'zero-size entry should be present after round-trip');
    assert.equal(zero.size,   0);
    assert.equal(zero.offset, 8192);
    // packId is the codec-derived value for 'placeholder'
    assert.equal(zero.packId, codec.getPackId(codec.encode('placeholder')));
});

test('[T1] serialize → parse round-trip — assetType inferred from extension', () => {
    const items = [ makeItem({ name: 'texture.dds', packId: 1, offset: 0 }) ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries[0].assetType, 'dds');
});

test('[T1] serialize → parse round-trip — single entry', () => {
    const items  = [ makeItem({ name: 'solo.xml', packId: 4, offset: 512, size: 64 }) ];
    const index  = new DataPackIndex();
    const buf    = index.serialize(items);
    const index2 = new DataPackIndex();
    index2.parse(buf);
    assert.equal(index2.entries.length, 1);
    assert.equal(index2.entries[0].decodedName, 'solo.xml');
});

test('[T1] serialize → re-serialize → re-parse produces byte-identical buffer', () => {
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0    }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 1024 }),
    ];
    const index = new DataPackIndex();
    const buf1  = index.serialize(items);

    // Parse, then serialize again using the same encoded bytes stored on entries
    const index2 = new DataPackIndex();
    index2.parse(buf1);
    const buf2 = index2.serialize(index2.entries);

    assert.equal(sha256(buf2), sha256(buf1));
});

test('[T1] rawBuffer is populated after parse', () => {
    const items = [ makeItem({ name: 'hero.dds', packId: 1, offset: 0 }) ];
    const index = new DataPackIndex();
    const buf   = index.serialize(items);
    const idx2  = new DataPackIndex();
    idx2.parse(buf);
    assert.ok(idx2.rawBuffer !== null);
    assert.ok(idx2.rawBuffer.length > 0);
});

// ---------------------------------------------------------------------------
// Tier 1 — validate()
// ---------------------------------------------------------------------------

test('[T1] validate — no errors for a well-formed list', () => {
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0 }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 512 }),
    ];
    const index = new DataPackIndex();
    index.parse(index.serialize(items));
    const result = index.validate();
    assert.deepEqual(result.errors, []);
});

test('[T1] validate — duplicate filename produces an error', () => {
    const items = [
        makeItem({ name: 'hero.dds', packId: 1, offset: 0   }),
        makeItem({ name: 'hero.dds', packId: 1, offset: 512 }),
    ];
    const index = new DataPackIndex();
    index.parse(index.serialize(items));
    const result = index.validate();
    assert.ok(result.errors.length > 0, 'expected at least one error for duplicate name');
    assert.ok(result.errors.some(e => e.includes('duplicate')));
});

test('[T1] validate — zero-size entry produces a warning, not an error', () => {
    const items = [
        makeItem({ name: 'placeholder', packId: 1, offset: 0, size: 0 }),
    ];
    const index = new DataPackIndex();
    index.parse(index.serialize(items));
    const result = index.validate();
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'expected at least one warning for zero-size entry');
});

test('[T1] validate — packId 9 (out of range) produces an error', () => {
    const items  = [ makeItem({ name: 'hero.dds', packId: 1, offset: 0 }) ];
    const index  = new DataPackIndex();
    index.parse(index.serialize(items));
    // Manually corrupt packId after parse — cannot be serialized as 9 via normal path
    // since getPackId always returns 1-8, so we inject directly.
    index.entries[0].packId = 9;
    const result = index.validate();
    assert.ok(result.errors.some(e => e.includes('packId') || e.includes('out of range')));
});

// ---------------------------------------------------------------------------
// Tier 1 — diff()
// ---------------------------------------------------------------------------

test('[T1] diff — index diffed against itself has no added, removed, or changed', () => {
    const items = [
        makeItem({ name: 'hero.dds',    packId: 1, offset: 0    }),
        makeItem({ name: 'npcinfo.cfg', packId: 3, offset: 1024 }),
    ];
    const index = new DataPackIndex();
    index.parse(index.serialize(items));
    const result = index.diff(index);
    assert.deepEqual(result.added,   []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.changed, []);
});

test('[T1] diff — added entry detected', () => {
    const index1 = new DataPackIndex();
    index1.parse(index1.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 0 }),
    ]));
    const index2 = new DataPackIndex();
    index2.parse(index2.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 0    }),
        makeItem({ name: 'bg.tga',   packId: 2, offset: 1024 }),
    ]));
    const result = index1.diff(index2);
    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].decodedName, 'bg.tga');
    assert.deepEqual(result.removed, []);
});

test('[T1] diff — removed entry detected', () => {
    const index1 = new DataPackIndex();
    index1.parse(index1.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 0    }),
        makeItem({ name: 'bg.tga',   packId: 2, offset: 1024 }),
    ]));
    const index2 = new DataPackIndex();
    index2.parse(index2.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 0 }),
    ]));
    const result = index1.diff(index2);
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].decodedName, 'bg.tga');
    assert.deepEqual(result.added, []);
});

test('[T1] diff — changed entry (offset moved) detected', () => {
    const index1 = new DataPackIndex();
    index1.parse(index1.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 0 }),
    ]));
    const index2 = new DataPackIndex();
    index2.parse(index2.serialize([
        makeItem({ name: 'hero.dds', packId: 1, offset: 9999 }),
    ]));
    const result = index1.diff(index2);
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0].decodedName, 'hero.dds');
    assert.deepEqual(result.added,   []);
    assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// Tier 2 — fixture-backed tests
// ---------------------------------------------------------------------------

test('[T2] fixture data.000 — entry count matches expected', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index    = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    assert.equal(index.entries.length, expected.length,
        `entry count mismatch: parsed ${index.entries.length}, expected ${expected.length}`);
});

test('[T2] fixture data.000 — every entry decodedName matches expected', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected    = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index       = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    for (const entry of index.entries) {
        assert.ok(expectedMap.has(entry.decodedName),
            `unexpected entry in parsed index: "${entry.decodedName}"`);
    }
});

test('[T2] fixture data.000 — every entry packId matches expected', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected    = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index       = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    for (const entry of index.entries) {
        const exp = expectedMap.get(entry.decodedName);
        if (!exp) continue; // caught by previous test
        assert.equal(entry.packId, exp.packId,
            `packId mismatch for "${entry.decodedName}": got ${entry.packId}, expected ${exp.packId}`);
    }
});

test('[T2] fixture data.000 — every entry offset matches expected', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected    = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index       = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    for (const entry of index.entries) {
        const exp = expectedMap.get(entry.decodedName);
        if (!exp) continue;
        assert.equal(entry.offset, exp.offset,
            `offset mismatch for "${entry.decodedName}": got ${entry.offset}, expected ${exp.offset}`);
    }
});

test('[T2] fixture data.000 — every entry size matches expected', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected    = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index       = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    for (const entry of index.entries) {
        const exp = expectedMap.get(entry.decodedName);
        if (!exp) continue;
        assert.equal(entry.size, exp.size,
            `size mismatch for "${entry.decodedName}": got ${entry.size}, expected ${exp.size}`);
    }
});

test('[T2] fixture data.000 — zero-size entries have correct packId and offset', { skip: !FIXTURE_AVAILABLE }, () => {
    const expected    = JSON.parse(fs.readFileSync(FIXTURE_ENTRIES, 'utf8'));
    const index       = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const expectedMap = new Map(expected.map(e => [e.decodedName, e]));

    const zeroEntries = index.entries.filter(e => e.size === 0);
    assert.ok(zeroEntries.length > 0, 'fixture should contain at least one zero-size entry');

    for (const entry of zeroEntries) {
        const exp = expectedMap.get(entry.decodedName);
        assert.ok(exp, `zero-size entry "${entry.decodedName}" not found in expected`);
        assert.equal(entry.packId, exp.packId,
            `zero-size packId mismatch for "${entry.decodedName}"`);
        assert.equal(entry.offset, exp.offset,
            `zero-size offset mismatch for "${entry.decodedName}"`);
    }
});

test('[T2] fixture data.000 — serialize produces byte-identical output (SHA-256 matches)', { skip: !FIXTURE_AVAILABLE }, () => {
    const expectedHashes = JSON.parse(fs.readFileSync(FIXTURE_HASHES, 'utf8'));
    const originalBuf    = fs.readFileSync(FIXTURE_INDEX);
    const index          = new DataPackIndex();
    index.parse(originalBuf);

    const serialized = index.serialize(index.entries);
    assert.equal(sha256(serialized), expectedHashes['data.000'],
        'serialize() did not produce byte-identical output — index reconstruction is broken');
});

test('[T2] fixture data.000 — validate reports no errors', { skip: !FIXTURE_AVAILABLE }, () => {
    const index = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const result = index.validate();
    assert.deepEqual(result.errors, []);
});

test('[T2] fixture data.000 — diff against itself has empty sets', { skip: !FIXTURE_AVAILABLE }, () => {
    const index = new DataPackIndex();
    index.parse(fs.readFileSync(FIXTURE_INDEX));
    const result = index.diff(index);
    assert.deepEqual(result.added,   []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.changed, []);
});

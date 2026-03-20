'use strict';
/**
 * test/unit/filename-codec.test.js
 *
 * Tier 1 — pure in-memory unit tests for FilenameCodec.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/filename-codec.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const FilenameCodec = require(path.join(__dirname, '..', '..', 'src', 'crypto', 'FilenameCodec'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A representative set of real-world Rappelz filenames covering multiple
// extensions and pack slot assignments. Used across multiple test groups.
const ROUND_TRIP_NAMES = [
    'v256_m013_009_7_5.jpg',
    'hero.dds',
    'button_ok.tga',
    'zone001.nfm',
    'theme.mp3',
    'player_run.naf',
    'building_01.nx3',
    'npcinfo.cfg',
    'ui_main.xml',
    'effect_hit.spt',
];

// ---------------------------------------------------------------------------
// encode / decode round-trip
// ---------------------------------------------------------------------------

test('encode → decode round-trip for representative filenames', () => {
    const codec = new FilenameCodec();
    for (const name of ROUND_TRIP_NAMES) {
        const encoded = codec.encode(name);
        const decoded = codec.decode(encoded);
        assert.equal(decoded, name.toLowerCase(),
            `round-trip failed for "${name}": got "${decoded}"`);
    }
});

test('encode → decode round-trip for filenames with no extension', () => {
    const codec   = new FilenameCodec();
    const encoded = codec.encode('readme');
    const decoded = codec.decode(encoded);
    assert.equal(decoded, 'readme');
});

test('encode → decode round-trip for single-character filename', () => {
    const codec   = new FilenameCodec();
    const encoded = codec.encode('a');
    const decoded = codec.decode(encoded);
    assert.equal(decoded, 'a');
});

test('encode → decode round-trip for filename with digits', () => {
    const codec   = new FilenameCodec();
    const name    = 'm003_001.bmp';
    const encoded = codec.encode(name);
    const decoded = codec.decode(encoded);
    assert.equal(decoded, name.toLowerCase());
});

// ---------------------------------------------------------------------------
// encode is deterministic
// ---------------------------------------------------------------------------

test('encode is deterministic — same input always produces same output', () => {
    const codec  = new FilenameCodec();
    const name   = 'hero.dds';
    const first  = codec.encode(name);
    const second = codec.encode(name);
    assert.equal(first, second);
});

test('encode is deterministic across separate instances', () => {
    const name   = 'npcinfo.cfg';
    const codec1 = new FilenameCodec();
    const codec2 = new FilenameCodec();
    assert.equal(codec1.encode(name), codec2.encode(name));
});

test('encode — output differs from input (obfuscation is applied)', () => {
    const codec   = new FilenameCodec();
    const name    = 'hero.dds';
    const encoded = codec.encode(name);
    assert.notEqual(encoded, name);
});

test('encode — output length equals filename length + 2 (salt prefix + suffix)', () => {
    const codec = new FilenameCodec();
    for (const name of ROUND_TRIP_NAMES) {
        const encoded = codec.encode(name);
        assert.equal(encoded.length, name.length + 2,
            `length mismatch for "${name}": encoded.length=${encoded.length}`);
    }
});

// ---------------------------------------------------------------------------
// decode edge cases
// ---------------------------------------------------------------------------

test('decode — empty string returns empty string', () => {
    const codec = new FilenameCodec();
    assert.equal(codec.decode(''), '');
});

test('decode — string shorter than 3 chars returns empty string', () => {
    const codec = new FilenameCodec();
    // Anything under 3 chars cannot have a valid salt prefix + inner + salt suffix
    assert.equal(codec.decode('ab'), '');
});

// ---------------------------------------------------------------------------
// encode edge cases
// ---------------------------------------------------------------------------

test('encode — empty string returns empty string', () => {
    const codec = new FilenameCodec();
    assert.equal(codec.encode(''), '');
});

test('encode — lowercases input before encoding', () => {
    const codec = new FilenameCodec();
    // encode(UPPER) and encode(lower) should produce the same output
    // because the algorithm lowercases first
    assert.equal(codec.encode('Hero.DDS'), codec.encode('hero.dds'));
});

// ---------------------------------------------------------------------------
// getPackId
// ---------------------------------------------------------------------------

test('getPackId — returns value in range 1–8 for representative filenames', () => {
    const codec = new FilenameCodec();
    for (const name of ROUND_TRIP_NAMES) {
        const encoded = codec.encode(name);
        const id      = codec.getPackId(encoded);
        assert.ok(id >= 1 && id <= 8,
            `getPackId out of range for "${name}": got ${id}`);
    }
});

test('getPackId — is deterministic for the same encoded string', () => {
    const codec   = new FilenameCodec();
    const encoded = codec.encode('hero.dds');
    assert.equal(codec.getPackId(encoded), codec.getPackId(encoded));
});

test('getPackId — is deterministic across separate instances', () => {
    const name    = 'npcinfo.cfg';
    const codec1  = new FilenameCodec();
    const codec2  = new FilenameCodec();
    const enc1    = codec1.encode(name);
    const enc2    = codec2.encode(name);
    assert.equal(codec1.getPackId(enc1), codec2.getPackId(enc2));
});

// ---------------------------------------------------------------------------
// Regression: re-encoding a decoded name must produce the same packId
//
// Before the codec was rewritten from KFileNameCipher.cpp, encode() accepted
// caller-supplied salt characters. Different salts produced different encoded
// strings, which in turn produced different SDBM hashes, assigning assets to
// the wrong pack slot during reconstruction.
//
// The fix: salt characters are now derived deterministically from the filename
// content. encode(name) is always the correct encoded form, so
// getPackId(encode(decode(szHash))) === getPackId(szHash) always holds.
// ---------------------------------------------------------------------------

test('Regression: re-encoding a decoded name produces the same packId as the original encoded string', () => {
    // Regression: salt-based packId mismatch — encode() previously took caller-
    // supplied salt chars, causing wrong pack slot on reconstruction.
    const codec = new FilenameCodec();
    for (const name of ROUND_TRIP_NAMES) {
        const original  = codec.encode(name);
        const decoded   = codec.decode(original);
        const reEncoded = codec.encode(decoded);

        assert.equal(
            codec.getPackId(reEncoded),
            codec.getPackId(original),
            `packId mismatch after re-encode for "${name}": ` +
            `original=${codec.getPackId(original)} re-encoded=${codec.getPackId(reEncoded)}`
        );
    }
});

test('Regression: re-encoding a decoded name produces byte-identical encoded string', () => {
    // Regression: salt-based packId mismatch — encode() previously took caller-
    // supplied salt chars, causing wrong pack slot on reconstruction.
    const codec = new FilenameCodec();
    for (const name of ROUND_TRIP_NAMES) {
        const original  = codec.encode(name);
        const decoded   = codec.decode(original);
        const reEncoded = codec.encode(decoded);

        assert.equal(reEncoded, original,
            `byte-identical re-encode failed for "${name}": ` +
            `original="${original}" re-encoded="${reEncoded}"`);
    }
});

// ---------------------------------------------------------------------------
// Different filenames produce different encoded strings
// ---------------------------------------------------------------------------

test('different filenames produce different encoded strings', () => {
    const codec = new FilenameCodec();
    const names = ROUND_TRIP_NAMES.slice();
    const encoded = names.map(n => codec.encode(n));
    const unique  = new Set(encoded);
    assert.equal(unique.size, names.length,
        'Two or more filenames produced the same encoded string');
});

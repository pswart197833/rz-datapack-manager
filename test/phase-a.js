'use strict';
/**
 * Phase A — CryptoProvider + FilenameCodec
 * -----------------------------------------
 * Run: npm run test:a
 *
 * Tests the cipher and filename codec against known values.
 * No data files required for this phase.
 *
 * Note: filenames in this pack format are flat — no directory structure.
 * Forward and backslashes do not appear in real filenames.
 */

const CryptoProvider = require('../src/crypto/CryptoProvider');
const FilenameCodec  = require('../src/crypto/FilenameCodec');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label}`);
        console.log(`         expected: ${JSON.stringify(expected)}`);
        console.log(`         actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
}

function assertNotEmpty(label, actual) {
    const ok = actual !== null && actual !== undefined && actual !== '';
    if (ok) {
        console.log(`  [PASS] ${label} => "${actual}"`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label} — value was empty or null`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// CryptoProvider tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase A: CryptoProvider ===\n');

const crypto = new CryptoProvider();

// Test 1 — Single byte decrypt at index 0
// xor1[0] = 0x77. Encrypted byte 0x77 ^ 0x77 = 0x00
{
    const result = crypto.processByte(0x77, 0);
    assert('processByte — decrypt at index 0 (0x77 ^ 0x77 = 0x00)', result.value, 0x00);
    assert('processByte — nextIndex advances to 1', result.nextIndex, 1);
}

// Test 2 — Single byte decrypt at index 1
// xor1[1] = 0xE8. Encrypted byte 0xE8 ^ 0xE8 = 0x00
{
    const result = crypto.processByte(0xE8, 1);
    assert('processByte — decrypt at index 1 (0xE8 ^ 0xE8 = 0x00)', result.value, 0x00);
    assert('processByte — nextIndex advances to 2', result.nextIndex, 2);
}

// Test 3 — XOR is its own inverse: encrypt(decrypt(x)) === x
{
    const original  = Buffer.from([0x41, 0x42, 0x43, 0x44]);
    const encrypted = crypto.encrypt(Buffer.from(original), 0);
    const decrypted = crypto.decrypt(encrypted.buffer, 0);
    assert('encrypt/decrypt round-trip — buffer matches original',
        Array.from(decrypted.buffer),
        Array.from(original)
    );
}

// Test 4 — processBuffer modifies in-place and returns correct next index
{
    const buf  = Buffer.from([0x77, 0xE8]); // xor1[0]=0x77, xor1[1]=0xE8 → both become 0x00
    const next = crypto.processBuffer(buf, 0);
    assert('processBuffer — first byte decrypted in-place', buf[0], 0x00);
    assert('processBuffer — second byte decrypted in-place', buf[1], 0x00);
    assert('processBuffer — returns index 2 after processing 2 bytes', next, 2);
}

// Test 5 — Index wraps at 256
{
    const result = crypto.processByte(0x00, 255);
    assert('processByte — index wraps from 255 back to 0', result.nextIndex, 0);
}

// ---------------------------------------------------------------------------
// FilenameCodec tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase A: FilenameCodec ===\n');

const codec = new FilenameCodec();

// Test 6 — Encode a known filename and confirm it is not the same as the input
{
    const filename = 'v256_m013_009_7_5.jpg';
    const encoded  = codec.encode(filename);
    assertNotEmpty('encode — produces a non-empty result', encoded);
    assert('encode — result differs from original filename', encoded === filename, false);
    assert('encode — result has salt prefix and suffix (length = filename + 2)',
        encoded.length, filename.length + 2
    );
}

// Test 7 — Decode(Encode(x)) === x  (round-trip)
// All filenames are flat — no path separators — matching real pack file structure.
{
    const filenames = [
        'v256_m013_009_7_5.jpg',
        'hero.dds',
        'button_ok.tga',
        'zone001.nfm',
        'theme.mp3',
        'player_run.naf',
        'building_01.nx3'
    ];

    filenames.forEach(original => {
        const encoded = codec.encode(original);
        const decoded = codec.decode(encoded);
        assert(`round-trip — "${original}"`, decoded, original);
    });
}

// Test 8 — getPackId returns value in 1-8 range
{
    const filenames = [
        'v256_m013_009_7_5.jpg',
        'hero.dds',
        'button_ok.tga',
        'zone001.nfm',
        'theme.mp3'
    ];

    filenames.forEach(name => {
        const hash    = codec.encode(name);
        const id      = codec.getPackId(hash);
        const inRange = id >= 1 && id <= 8;
        assert(`getPackId — "${name}" returns value 1-8 (got ${id})`, inRange, true);
    });
}

// Test 9 — getPackId is deterministic (same input always same output)
{
    const hash = codec.encode('hero.dds');
    const id1  = codec.getPackId(hash);
    const id2  = codec.getPackId(hash);
    assert('getPackId — deterministic for same input', id1, id2);
}

// Test 10 — Empty string edge cases
{
    assert('decode — empty string returns empty string', codec.decode(''), '');
    assert('encode — empty string returns empty string', codec.encode(''), '');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(45)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(45)}\n`);

if (failed > 0) process.exit(1);

'use strict';
/**
 * test/unit/crypto-provider.test.js
 *
 * Tier 1 — pure in-memory unit tests for CryptoProvider.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/crypto-provider.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const CryptoProvider = require(path.join(__dirname, '..', '..', 'src', 'crypto', 'CryptoProvider'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply processBuffer to a copy so the original is unchanged. */
function applyBuffer(crypto, buf, index = 0) {
    const copy = Buffer.from(buf);
    const next = crypto.processBuffer(copy, index);
    return { buffer: copy, nextIndex: next };
}

// ---------------------------------------------------------------------------
// processByte
// ---------------------------------------------------------------------------

test('processByte — decrypt at index 0 (0x77 ^ 0x77 = 0x00)', () => {
    const crypto = new CryptoProvider();
    const result = crypto.processByte(0x77, 0);
    assert.equal(result.value,     0x00);
    assert.equal(result.nextIndex, 1);
});

test('processByte — decrypt at index 1 (0xE8 ^ 0xE8 = 0x00)', () => {
    const crypto = new CryptoProvider();
    const result = crypto.processByte(0xE8, 1);
    assert.equal(result.value,     0x00);
    assert.equal(result.nextIndex, 2);
});

test('processByte — non-zero result at index 0 (0x00 ^ 0x77 = 0x77)', () => {
    const crypto = new CryptoProvider();
    const result = crypto.processByte(0x00, 0);
    assert.equal(result.value,     0x77);
    assert.equal(result.nextIndex, 1);
});

test('processByte — index wraps from 255 back to 0', () => {
    const crypto  = new CryptoProvider();
    const result  = crypto.processByte(0x00, 255);
    assert.equal(result.nextIndex, 0);
});

test('processByte — known value at index 2 (0x5E ^ byte = result)', () => {
    // xor1[2] = 0x5E. processByte(0x5E, 2) should give 0x00.
    const crypto = new CryptoProvider();
    const result = crypto.processByte(0x5E, 2);
    assert.equal(result.value,     0x00);
    assert.equal(result.nextIndex, 3);
});

// ---------------------------------------------------------------------------
// processBuffer
// ---------------------------------------------------------------------------

test('processBuffer — decrypts in-place and returns correct next index', () => {
    const crypto = new CryptoProvider();
    // xor1[0]=0x77, xor1[1]=0xE8 → XOR with same values → 0x00
    const buf  = Buffer.from([0x77, 0xE8]);
    const next = crypto.processBuffer(buf, 0);
    assert.equal(buf[0], 0x00);
    assert.equal(buf[1], 0x00);
    assert.equal(next,   2);
});

test('processBuffer — mutates the buffer passed in (in-place)', () => {
    const crypto  = new CryptoProvider();
    const buf     = Buffer.from([0x77]);
    const before  = buf[0];
    crypto.processBuffer(buf, 0);
    // buf[0] should now differ from its original value (0x77 ^ 0x77 = 0x00)
    assert.notEqual(buf[0], before);
});

test('processBuffer — empty buffer returns same index unchanged', () => {
    const crypto = new CryptoProvider();
    const buf    = Buffer.alloc(0);
    const next   = crypto.processBuffer(buf, 5);
    assert.equal(next, 5);
});

test('processBuffer — index wraps correctly across a 256-byte buffer', () => {
    const crypto = new CryptoProvider();
    const buf    = Buffer.alloc(256, 0x00);
    const next   = crypto.processBuffer(buf, 0);
    // 256 bytes starting at index 0 → next index should be 0 (full wrap)
    assert.equal(next, 0);
});

test('processBuffer — index wraps correctly across a 257-byte buffer', () => {
    const crypto = new CryptoProvider();
    const buf    = Buffer.alloc(257, 0x00);
    const next   = crypto.processBuffer(buf, 0);
    assert.equal(next, 1);
});

// ---------------------------------------------------------------------------
// XOR symmetry — encrypt/decrypt round-trip
// ---------------------------------------------------------------------------

test('encrypt/decrypt round-trip — buffer matches original', () => {
    const crypto    = new CryptoProvider();
    const original  = Buffer.from([0x41, 0x42, 0x43, 0x44]);
    const encrypted = crypto.encrypt(Buffer.from(original), 0);
    const decrypted = crypto.decrypt(encrypted.buffer, 0);
    assert.deepEqual(Array.from(decrypted.buffer), Array.from(original));
});

test('encrypt and decrypt produce identical output (XOR is its own inverse)', () => {
    const crypto  = new CryptoProvider();
    const input   = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]);
    const enc     = crypto.encrypt(Buffer.from(input), 0);
    const dec     = crypto.decrypt(Buffer.from(input), 0);
    assert.deepEqual(Array.from(enc.buffer), Array.from(dec.buffer));
});

test('encrypt — does not mutate the original buffer', () => {
    const crypto   = new CryptoProvider();
    const original = Buffer.from([0xAA, 0xBB, 0xCC]);
    const snapshot = Buffer.from(original);
    crypto.encrypt(original, 0);
    assert.deepEqual(Array.from(original), Array.from(snapshot));
});

test('decrypt — does not mutate the original buffer', () => {
    const crypto   = new CryptoProvider();
    const original = Buffer.from([0xAA, 0xBB, 0xCC]);
    const snapshot = Buffer.from(original);
    crypto.decrypt(original, 0);
    assert.deepEqual(Array.from(original), Array.from(snapshot));
});

test('encrypt — nextIndex advances correctly', () => {
    const crypto = new CryptoProvider();
    const buf    = Buffer.from([0x00, 0x00, 0x00]);
    const result = crypto.encrypt(buf, 0);
    assert.equal(result.nextIndex, 3);
});

test('decrypt — nextIndex advances correctly', () => {
    const crypto = new CryptoProvider();
    const buf    = Buffer.from([0x00, 0x00, 0x00]);
    const result = crypto.decrypt(buf, 0);
    assert.equal(result.nextIndex, 3);
});

test('round-trip starting at non-zero index', () => {
    const crypto   = new CryptoProvider();
    const original = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const enc      = crypto.encrypt(Buffer.from(original), 10);
    const dec      = crypto.decrypt(enc.buffer, 10);
    assert.deepEqual(Array.from(dec.buffer), Array.from(original));
});

// ---------------------------------------------------------------------------
// processBuffer vs encrypt/decrypt consistency
// ---------------------------------------------------------------------------

test('processBuffer and encrypt produce the same output bytes', () => {
    const crypto = new CryptoProvider();
    const input  = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]);

    // Via encrypt (returns a copy)
    const encResult = crypto.encrypt(Buffer.from(input), 0);

    // Via processBuffer (in-place on a copy)
    const { buffer: pbResult } = applyBuffer(crypto, input, 0);

    assert.deepEqual(Array.from(encResult.buffer), Array.from(pbResult));
});

// ---------------------------------------------------------------------------
// XOR table coverage sanity check
// ---------------------------------------------------------------------------

test('xor1 table has exactly 256 entries (no short table)', () => {
    // Access through a round-trip: encrypt a 256-byte buffer starting at 0
    // and verify the nextIndex lands back at 0.
    const crypto = new CryptoProvider();
    const buf    = Buffer.alloc(256, 0x00);
    const result = crypto.encrypt(buf, 0);
    assert.equal(result.nextIndex, 0);
});

'use strict';
/**
 * test/unit/asset-item.test.js
 *
 * Tier 1 — pure in-memory unit tests for AssetItem.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/asset-item.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const AssetItem = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetItem'));

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

test('constructor — encodedName defaults to null', () => {
    const item = new AssetItem({});
    assert.equal(item.encodedName, null);
});

test('constructor — decodedName defaults to empty string', () => {
    const item = new AssetItem({});
    assert.equal(item.decodedName, '');
});

test('constructor — assetType defaults to null', () => {
    const item = new AssetItem({});
    assert.equal(item.assetType, null);
});

test('constructor — packId defaults to 0', () => {
    const item = new AssetItem({});
    assert.equal(item.packId, 0);
});

test('constructor — offset defaults to 0', () => {
    const item = new AssetItem({});
    assert.equal(item.offset, 0);
});

test('constructor — size defaults to 0', () => {
    const item = new AssetItem({});
    assert.equal(item.size, 0);
});

test('constructor — indexOffset defaults to 0', () => {
    const item = new AssetItem({});
    assert.equal(item.indexOffset, 0);
});

test('constructor — fingerprint defaults to null', () => {
    const item = new AssetItem({});
    assert.equal(item.fingerprint, null);
});

test('constructor — stores provided values correctly', () => {
    const encoded = Buffer.from('encoded');
    const item    = new AssetItem({
        encodedName: encoded,
        decodedName: 'hero.dds',
        assetType:   'dds',
        packId:      3,
        offset:      4096,
        size:        2048,
        indexOffset: 128,
        fingerprint: 'abc123'
    });
    assert.equal(item.encodedName,  encoded);
    assert.equal(item.decodedName,  'hero.dds');
    assert.equal(item.assetType,    'dds');
    assert.equal(item.packId,       3);
    assert.equal(item.offset,       4096);
    assert.equal(item.size,         2048);
    assert.equal(item.indexOffset,  128);
    assert.equal(item.fingerprint,  'abc123');
});

test('constructor — no-argument call does not throw', () => {
    assert.doesNotThrow(() => new AssetItem());
});

// ---------------------------------------------------------------------------
// inferAssetType
// ---------------------------------------------------------------------------

test('inferAssetType — returns lowercase extension without dot', () => {
    const item = new AssetItem({ decodedName: 'hero.DDS' });
    assert.equal(item.inferAssetType(), 'dds');
});

test('inferAssetType — returns correct extension for jpg', () => {
    const item = new AssetItem({ decodedName: 'texture.jpg' });
    assert.equal(item.inferAssetType(), 'jpg');
});

test('inferAssetType — returns correct extension for multi-part names', () => {
    const item = new AssetItem({ decodedName: 'v256_m013_009_7_5.jpg' });
    assert.equal(item.inferAssetType(), 'jpg');
});

test('inferAssetType — returns "unknown" when no extension present', () => {
    const item = new AssetItem({ decodedName: 'readme' });
    assert.equal(item.inferAssetType(), 'unknown');
});

test('inferAssetType — returns "unknown" when decodedName is empty string', () => {
    const item = new AssetItem({ decodedName: '' });
    assert.equal(item.inferAssetType(), 'unknown');
});

test('inferAssetType — returns "unknown" when decodedName is null/undefined (default)', () => {
    const item = new AssetItem({});
    assert.equal(item.inferAssetType(), 'unknown');
});

test('inferAssetType — handles filename that is only an extension (dot-file)', () => {
    // '.cfg' → split gives ['', 'cfg'] → last part is 'cfg'
    const item = new AssetItem({ decodedName: '.cfg' });
    assert.equal(item.inferAssetType(), 'cfg');
});

// ---------------------------------------------------------------------------
// matchesFingerprint
// ---------------------------------------------------------------------------

test('matchesFingerprint — returns false when fingerprint is null', () => {
    const item = new AssetItem({ fingerprint: null });
    assert.equal(item.matchesFingerprint('abc123'), false);
});

test('matchesFingerprint — returns true for exact hash match', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const item = new AssetItem({ fingerprint: hash });
    assert.equal(item.matchesFingerprint(hash), true);
});

test('matchesFingerprint — returns false for non-matching hash', () => {
    const item = new AssetItem({ fingerprint: 'aabbcc' });
    assert.equal(item.matchesFingerprint('ddeeff'), false);
});

test('matchesFingerprint — is case-sensitive', () => {
    const item = new AssetItem({ fingerprint: 'AABBCC' });
    assert.equal(item.matchesFingerprint('aabbcc'), false);
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------

test('toJSON — returns a plain object', () => {
    const item   = new AssetItem({ decodedName: 'hero.dds', packId: 3 });
    const result = item.toJSON();
    assert.equal(typeof result, 'object');
    assert.ok(result !== null);
    assert.ok(!(result instanceof AssetItem));
});

test('toJSON — contains all expected fields', () => {
    const item   = new AssetItem({
        decodedName: 'hero.dds',
        assetType:   'dds',
        packId:      3,
        offset:      1024,
        size:        512,
        indexOffset: 64,
        fingerprint: 'abc'
    });
    const json = item.toJSON();
    assert.equal(json.decodedName,  'hero.dds');
    assert.equal(json.assetType,    'dds');
    assert.equal(json.packId,       3);
    assert.equal(json.offset,       1024);
    assert.equal(json.size,         512);
    assert.equal(json.indexOffset,  64);
    assert.equal(json.fingerprint,  'abc');
});

test('toJSON — encodedName is NOT present in output (internal only)', () => {
    const item = new AssetItem({
        encodedName: Buffer.from('encoded'),
        decodedName: 'hero.dds'
    });
    const json = item.toJSON();
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'encodedName'), false);
});

test('toJSON — null fingerprint serialises as null', () => {
    const item = new AssetItem({ decodedName: 'hero.dds' });
    assert.equal(item.toJSON().fingerprint, null);
});

// ---------------------------------------------------------------------------
// offsets are numbers, not bigints (format constraint)
// ---------------------------------------------------------------------------

test('offset is stored as number, not bigint', () => {
    const item = new AssetItem({ offset: 1073741824 }); // 1 GB
    assert.equal(typeof item.offset, 'number');
});

test('indexOffset is stored as number, not bigint', () => {
    const item = new AssetItem({ indexOffset: 999999 });
    assert.equal(typeof item.indexOffset, 'number');
});

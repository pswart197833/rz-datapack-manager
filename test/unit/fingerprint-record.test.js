'use strict';
/**
 * test/unit/fingerprint-record.test.js
 *
 * Tier 1 — pure in-memory unit tests for FingerprintRecord.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/fingerprint-record.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

test('isAsset() — true for type "asset"', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds' });
    assert.equal(r.isAsset(), true);
});

test('isAsset() — false for type "pack"', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'pack', decodedName: 'data.003' });
    assert.equal(r.isAsset(), false);
});

test('isAsset() — false for type "index"', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'index', decodedName: 'data.000' });
    assert.equal(r.isAsset(), false);
});

test('isPack() — true for type "pack"', () => {
    const r = new FingerprintRecord({ hash: 'bbb', type: 'pack', decodedName: 'data.003' });
    assert.equal(r.isPack(), true);
});

test('isPack() — false for type "asset"', () => {
    const r = new FingerprintRecord({ hash: 'bbb', type: 'asset', decodedName: 'hero.dds' });
    assert.equal(r.isPack(), false);
});

test('isPack() — false for type "index"', () => {
    const r = new FingerprintRecord({ hash: 'bbb', type: 'index', decodedName: 'data.000' });
    assert.equal(r.isPack(), false);
});

test('isIndex() — true for type "index"', () => {
    const r = new FingerprintRecord({ hash: 'ccc', type: 'index', decodedName: 'data.000' });
    assert.equal(r.isIndex(), true);
});

test('isIndex() — false for type "asset"', () => {
    const r = new FingerprintRecord({ hash: 'ccc', type: 'asset', decodedName: 'hero.dds' });
    assert.equal(r.isIndex(), false);
});

test('isIndex() — false for type "pack"', () => {
    const r = new FingerprintRecord({ hash: 'ccc', type: 'pack', decodedName: 'data.001' });
    assert.equal(r.isIndex(), false);
});

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

test('constructor — hash defaults to null', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.hash, null);
});

test('constructor — type defaults to null', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.type, null);
});

test('constructor — decodedName defaults to empty string', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.decodedName, '');
});

test('constructor — size defaults to 0', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.size, 0);
});

test('constructor — extractedPath defaults to null', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.extractedPath, null);
});

test('constructor — verified defaults to false', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.verified, false);
});

test('constructor — date defaults to a Date instance', () => {
    const r = new FingerprintRecord({});
    assert.ok(r.date instanceof Date);
});

test('constructor — isAlias defaults to false', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.isAlias, false);
});

test('constructor — aliasOf defaults to null', () => {
    const r = new FingerprintRecord({});
    assert.equal(r.aliasOf, null);
});

test('constructor — no-argument call does not throw', () => {
    assert.doesNotThrow(() => new FingerprintRecord());
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON round-trip — all 9 fields
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — hash survives round-trip', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const r    = new FingerprintRecord({ hash, type: 'asset', decodedName: 'hero.dds' });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).hash, hash);
});

test('toJSON / fromJSON — type survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'pack', decodedName: 'data.003' });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).type, 'pack');
});

test('toJSON / fromJSON — decodedName survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'v256_m013.jpg' });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).decodedName, 'v256_m013.jpg');
});

test('toJSON / fromJSON — size survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', size: 131072 });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).size, 131072);
});

test('toJSON / fromJSON — extractedPath survives round-trip', () => {
    const p = '/store/ab/abcdef.dds';
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', extractedPath: p });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).extractedPath, p);
});

test('toJSON / fromJSON — extractedPath null survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', extractedPath: null });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).extractedPath, null);
});

test('toJSON / fromJSON — verified survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', verified: true });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).verified, true);
});

test('toJSON / fromJSON — date survives round-trip as a Date instance', () => {
    const d = new Date('2024-06-15T12:00:00.000Z');
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', date: d });
    const restored = FingerprintRecord.fromJSON(r.toJSON());
    assert.ok(restored.date instanceof Date);
    assert.equal(restored.date.toISOString(), d.toISOString());
});

test('toJSON / fromJSON — isAlias false survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', isAlias: false });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).isAlias, false);
});

test('toJSON / fromJSON — isAlias true survives round-trip', () => {
    const r = new FingerprintRecord({
        hash: 'bbb', type: 'asset', decodedName: 'alias.dds',
        isAlias: true, aliasOf: 'aaa'
    });
    const restored = FingerprintRecord.fromJSON(r.toJSON());
    assert.equal(restored.isAlias, true);
    assert.equal(restored.aliasOf, 'aaa');
});

test('toJSON / fromJSON — aliasOf null survives round-trip', () => {
    const r = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds', aliasOf: null });
    assert.equal(FingerprintRecord.fromJSON(r.toJSON()).aliasOf, null);
});

// ---------------------------------------------------------------------------
// Alias model
// ---------------------------------------------------------------------------

test('alias model — canonical record has isAlias=false and aliasOf=null', () => {
    const canonical = new FingerprintRecord({
        hash: 'sha-of-content', type: 'asset', decodedName: 'hero.dds',
        isAlias: false, aliasOf: null
    });
    assert.equal(canonical.isAlias, false);
    assert.equal(canonical.aliasOf, null);
});

test('alias model — alias record has isAlias=true and aliasOf pointing to canonical hash', () => {
    const alias = new FingerprintRecord({
        hash: 'sha-of-content', type: 'asset', decodedName: 'hero_copy.dds',
        isAlias: true, aliasOf: 'sha-of-content'
    });
    assert.equal(alias.isAlias, true);
    assert.equal(alias.aliasOf, 'sha-of-content');
});

test('alias model — isAlias is strictly boolean (not truthy coercion)', () => {
    // fromJSON uses `=== true` guard so truthy strings should not produce isAlias=true
    const r = FingerprintRecord.fromJSON({
        hash: 'aaa', type: 'asset', decodedName: 'hero.dds',
        isAlias: false, aliasOf: null,
        size: 0, extractedPath: null, verified: false, date: new Date().toISOString()
    });
    assert.strictEqual(r.isAlias, false);
});

// ---------------------------------------------------------------------------
// toJSON shape
// ---------------------------------------------------------------------------

test('toJSON — contains all 9 expected fields', () => {
    const r    = new FingerprintRecord({
        hash: 'aaa', type: 'asset', decodedName: 'hero.dds',
        size: 512, extractedPath: '/store/aa/aaa.dds',
        verified: true, isAlias: false, aliasOf: null
    });
    const json = r.toJSON();
    for (const field of ['hash', 'type', 'decodedName', 'size', 'extractedPath',
                          'verified', 'date', 'isAlias', 'aliasOf']) {
        assert.ok(Object.prototype.hasOwnProperty.call(json, field),
            `toJSON() missing field: ${field}`);
    }
});

test('toJSON — date is serialised as an ISO string', () => {
    const r    = new FingerprintRecord({ hash: 'aaa', type: 'asset', decodedName: 'hero.dds' });
    const json = r.toJSON();
    assert.equal(typeof json.date, 'string');
    assert.doesNotThrow(() => new Date(json.date));
});

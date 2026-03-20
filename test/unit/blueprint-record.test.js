'use strict';
/**
 * test/unit/blueprint-record.test.js
 *
 * Tier 1 — pure in-memory unit tests for BlueprintRecord.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/blueprint-record.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const BlueprintRecord   = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'BlueprintRecord'));
const FingerprintRecord = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintRecord'));

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

test('constructor — indexOffset defaults to 0', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.indexOffset, 0);
});

test('constructor — packOffset defaults to 0', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.packOffset, 0);
});

test('constructor — packId defaults to 0', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.packId, 0);
});

test('constructor — fileFingerprint defaults to null', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.fileFingerprint, null);
});

test('constructor — datapackFingerprint defaults to null', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.datapackFingerprint, null);
});

test('constructor — decodedName defaults to null', () => {
    const r = new BlueprintRecord({});
    assert.equal(r.decodedName, null);
});

test('constructor — no-argument call does not throw', () => {
    assert.doesNotThrow(() => new BlueprintRecord());
});

test('constructor — stores all provided values correctly', () => {
    const r = new BlueprintRecord({
        indexOffset:         100,
        packOffset:          2048,
        packId:              3,
        fileFingerprint:     'file-hash',
        datapackFingerprint: 'pack-hash',
        decodedName:         'hero.dds'
    });
    assert.equal(r.indexOffset,         100);
    assert.equal(r.packOffset,          2048);
    assert.equal(r.packId,              3);
    assert.equal(r.fileFingerprint,     'file-hash');
    assert.equal(r.datapackFingerprint, 'pack-hash');
    assert.equal(r.decodedName,         'hero.dds');
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON round-trip — all 6 fields
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — indexOffset survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 512, packOffset: 0, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).indexOffset, 512);
});

test('toJSON / fromJSON — packOffset survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 0, packOffset: 4096, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).packOffset, 4096);
});

test('toJSON / fromJSON — packId survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 7,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).packId, 7);
});

test('toJSON / fromJSON — fileFingerprint survives round-trip', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const r    = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: hash, datapackFingerprint: 'pp', decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).fileFingerprint, hash);
});

test('toJSON / fromJSON — datapackFingerprint survives round-trip', () => {
    const hash = 'abc123def456';
    const r    = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: hash, decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).datapackFingerprint, hash);
});

test('toJSON / fromJSON — datapackFingerprint null survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: null, decodedName: 'hero.dds' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).datapackFingerprint, null);
});

test('toJSON / fromJSON — decodedName survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: 'npcinfo.cfg' });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).decodedName, 'npcinfo.cfg');
});

test('toJSON / fromJSON — decodedName null survives round-trip', () => {
    const r = new BlueprintRecord({ indexOffset: 0, packOffset: 0, packId: 1,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: null });
    assert.equal(BlueprintRecord.fromJSON(r.toJSON()).decodedName, null);
});

test('toJSON — contains all 6 expected fields', () => {
    const r    = new BlueprintRecord({ indexOffset: 1, packOffset: 2, packId: 3,
        fileFingerprint: 'fp', datapackFingerprint: 'pp', decodedName: 'hero.dds' });
    const json = r.toJSON();
    for (const field of ['indexOffset', 'packOffset', 'packId',
                          'fileFingerprint', 'datapackFingerprint', 'decodedName']) {
        assert.ok(Object.prototype.hasOwnProperty.call(json, field),
            `toJSON() missing field: ${field}`);
    }
});

// ---------------------------------------------------------------------------
// resolveFile
// ---------------------------------------------------------------------------

// Build a minimal mock FingerprintStore — resolveFile uses store.getByName()
// first (name-based), then store.get(hash) as fallback. No real I/O needed.
function makeMockStore({ byName = {}, byHash = {} } = {}) {
    return {
        getByName: (name) => byName[name] || null,
        get:       (hash) => byHash[hash] || null
    };
}

function makeFpRecord(opts) {
    return new FingerprintRecord(opts);
}

test('resolveFile — name-based lookup returns correct FingerprintRecord', () => {
    const record = makeFpRecord({
        hash: 'file-hash', type: 'asset', decodedName: 'hero.dds', size: 512
    });
    const store  = makeMockStore({ byName: { 'hero.dds': record } });
    const bp     = new BlueprintRecord({ fileFingerprint: 'file-hash', decodedName: 'hero.dds' });
    const result = bp.resolveFile(store);
    assert.ok(result !== null);
    assert.equal(result.decodedName, 'hero.dds');
});

test('resolveFile — falls back to hash-based lookup when name not found', () => {
    const record = makeFpRecord({
        hash: 'file-hash', type: 'asset', decodedName: 'hero.dds', size: 512
    });
    // byName is empty — forces fallback to hash lookup
    const store  = makeMockStore({ byHash: { 'file-hash': record } });
    const bp     = new BlueprintRecord({ fileFingerprint: 'file-hash', decodedName: 'unknown.dds' });
    const result = bp.resolveFile(store);
    assert.ok(result !== null);
    assert.equal(result.decodedName, 'hero.dds');
});

test('resolveFile — returns null when both lookups fail', () => {
    const store  = makeMockStore();
    const bp     = new BlueprintRecord({ fileFingerprint: 'missing-hash', decodedName: 'ghost.dds' });
    const result = bp.resolveFile(store);
    assert.equal(result, null);
});

test('resolveFile — returns null when fileFingerprint is null and decodedName not found', () => {
    const store  = makeMockStore();
    const bp     = new BlueprintRecord({ fileFingerprint: null, decodedName: null });
    const result = bp.resolveFile(store);
    assert.equal(result, null);
});

test('resolveFile — name-based lookup takes priority over hash-based (alias resolution)', () => {
    // This is the alias resolution guard: if the store has the alias's own FingerprintRecord
    // under its name, resolveFile() must return THAT record — not the canonical record
    // that hash-based lookup would return (which has the wrong decodedName).
    const aliasRecord    = makeFpRecord({
        hash: 'shared-hash', type: 'asset', decodedName: 'alias.dds', isAlias: true, aliasOf: 'shared-hash'
    });
    const canonicalRecord = makeFpRecord({
        hash: 'shared-hash', type: 'asset', decodedName: 'canonical.dds', isAlias: false
    });
    const store = makeMockStore({
        byName: { 'alias.dds': aliasRecord },
        byHash: { 'shared-hash': canonicalRecord }
    });
    const bp     = new BlueprintRecord({ fileFingerprint: 'shared-hash', decodedName: 'alias.dds' });
    const result = bp.resolveFile(store);
    // Must return aliasRecord (name lookup), NOT canonicalRecord (hash lookup)
    assert.equal(result.decodedName, 'alias.dds');
});

// ---------------------------------------------------------------------------
// resolvePack
// ---------------------------------------------------------------------------

test('resolvePack — returns correct FingerprintRecord for pack hash', () => {
    const packRecord = makeFpRecord({
        hash: 'pack-hash', type: 'pack', decodedName: 'data.003', size: 1024
    });
    const store  = makeMockStore({ byHash: { 'pack-hash': packRecord } });
    const bp     = new BlueprintRecord({ datapackFingerprint: 'pack-hash' });
    const result = bp.resolvePack(store);
    assert.ok(result !== null);
    assert.equal(result.decodedName, 'data.003');
});

test('resolvePack — returns null when datapackFingerprint is null', () => {
    const store  = makeMockStore();
    const bp     = new BlueprintRecord({ datapackFingerprint: null });
    const result = bp.resolvePack(store);
    assert.equal(result, null);
});

test('resolvePack — returns null when hash not in store', () => {
    const store  = makeMockStore();
    const bp     = new BlueprintRecord({ datapackFingerprint: 'missing-pack-hash' });
    const result = bp.resolvePack(store);
    assert.equal(result, null);
});

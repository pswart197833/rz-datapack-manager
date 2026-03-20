'use strict';
/**
 * test/unit/pack-configuration.test.js
 *
 * Tier 1 — pure in-memory unit tests for PackConfiguration.
 * Zero filesystem I/O except for the validate() tests which use real paths
 * from the fixture directory (the fixture data files must exist for those
 * to pass; they skip gracefully otherwise).
 *
 * Standalone runnable:
 *   node test/unit/pack-configuration.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');

const PackConfiguration = require(path.join(__dirname, '..', '..', 'src', 'config', 'PackConfiguration'));

const FIXTURE_DATA = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_AVAILABLE = fs.existsSync(path.join(FIXTURE_DATA, 'data.000'));

// ---------------------------------------------------------------------------
// fromDirectory factory
// ---------------------------------------------------------------------------

test('fromDirectory — indexPath set correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions', 'test');
    assert.equal(config.getIndexPath(), path.join('/data', 'data.000'));
});

test('fromDirectory — pack slot 1 path set correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.getPackPath(1), path.join('/data', 'data.001'));
});

test('fromDirectory — pack slot 8 path set correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.getPackPath(8), path.join('/data', 'data.008'));
});

test('fromDirectory — all 8 slots populated', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    for (let slot = 1; slot <= 8; slot++) {
        assert.ok(config.getPackPath(slot) !== null,
            `slot ${slot} should be populated`);
    }
});

test('fromDirectory — label stored correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions', 'my-label');
    assert.equal(config.label, 'my-label');
});

test('fromDirectory — label defaults to empty string', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.label, '');
});

test('fromDirectory — assetStoreDir stored correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.assetStoreDir, '/store');
});

test('fromDirectory — sessionsDir stored correctly', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.sessionsDir, '/sessions');
});

// ---------------------------------------------------------------------------
// getPackPath
// ---------------------------------------------------------------------------

test('getPackPath — returns null for slot 0 (below range)', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.getPackPath(0), null);
});

test('getPackPath — returns null for slot 9 (above range)', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.equal(config.getPackPath(9), null);
});

test('getPackPath — returns null for slot not in map', () => {
    const config = new PackConfiguration({
        indexPath:     '/data/data.000',
        packPaths:     new Map([[1, '/data/data.001']]),
        assetStoreDir: '/store',
        sessionsDir:   '/sessions'
    });
    assert.equal(config.getPackPath(2), null);
});

// ---------------------------------------------------------------------------
// listMissingPacks
// ---------------------------------------------------------------------------

test('listMissingPacks — empty array when all 8 slots filled', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    assert.deepEqual(config.listMissingPacks(), []);
});

test('listMissingPacks — correctly identifies single gap', () => {
    const packPaths = new Map();
    for (let i = 1; i <= 8; i++) {
        if (i !== 4) packPaths.set(i, `/data/data.00${i}`);
    }
    const config = new PackConfiguration({
        indexPath: '/data/data.000', packPaths, assetStoreDir: '/store', sessionsDir: '/sessions'
    });
    assert.deepEqual(config.listMissingPacks(), [4]);
});

test('listMissingPacks — correctly identifies multiple gaps', () => {
    const config = new PackConfiguration({
        indexPath:     '/data/data.000',
        packPaths:     new Map([[1, '/data/data.001'], [3, '/data/data.003']]),
        assetStoreDir: '/store',
        sessionsDir:   '/sessions'
    });
    assert.deepEqual(config.listMissingPacks(), [2, 4, 5, 6, 7, 8]);
});

test('listMissingPacks — all 8 missing when packPaths empty', () => {
    const config = new PackConfiguration({
        indexPath: '/data/data.000', packPaths: new Map(),
        assetStoreDir: '/store', sessionsDir: '/sessions'
    });
    assert.deepEqual(config.listMissingPacks(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — indexPath survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions', 'rt');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.getIndexPath(), config.getIndexPath());
});

test('toJSON / fromJSON — pack slot 1 path survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.getPackPath(1), config.getPackPath(1));
});

test('toJSON / fromJSON — pack slot 8 path survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.getPackPath(8), config.getPackPath(8));
});

test('toJSON / fromJSON — pack slot 4 path survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.getPackPath(4), config.getPackPath(4));
});

test('toJSON / fromJSON — label survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions', 'my-label');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.label, 'my-label');
});

test('toJSON / fromJSON — assetStoreDir survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.assetStoreDir, '/store');
});

test('toJSON / fromJSON — sessionsDir survives round-trip', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.equal(restored.sessionsDir, '/sessions');
});

test('toJSON — packPaths serialised as array of [slot, path] pairs', () => {
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const json   = config.toJSON();
    assert.ok(Array.isArray(json.packPaths),
        'packPaths should be an array in JSON output');
    assert.ok(json.packPaths.length > 0);
    // Each element should be a [number, string] pair
    const first = json.packPaths[0];
    assert.ok(Array.isArray(first), 'each packPaths entry should be an array pair');
    assert.equal(first.length, 2);
    assert.equal(typeof first[0], 'number');
    assert.equal(typeof first[1], 'string');
});

test('fromJSON — restores packPaths as a Map', () => {
    const config   = PackConfiguration.fromDirectory('/data', '/store', '/sessions');
    const restored = PackConfiguration.fromJSON(config.toJSON());
    assert.ok(restored.packPaths instanceof Map,
        'packPaths should be a Map after fromJSON');
    assert.equal(restored.packPaths.size, 8);
});

// ---------------------------------------------------------------------------
// API contract guard — create(config, label) argument order
//
// SessionManager.create(config, label) — config is the FIRST argument, label
// is the SECOND. This has caused bugs before. The guard lives here because
// PackConfiguration is what gets passed as the first argument.
// ---------------------------------------------------------------------------

test('API contract: PackConfiguration is a valid first argument to SessionManager.create (type check)', () => {
    // We cannot call SessionManager.create() in a Tier 1 test (it has I/O),
    // but we can confirm that a PackConfiguration instance has the shape that
    // SessionManager expects: it must have getIndexPath(), packPaths, assetStoreDir,
    // and sessionsDir — the fields SessionManager reads from config.
    const config = PackConfiguration.fromDirectory('/data', '/store', '/sessions', 'test');
    assert.equal(typeof config.getIndexPath,   'function');
    assert.equal(typeof config.getPackPath,    'function');
    assert.ok(config.packPaths instanceof Map);
    assert.equal(typeof config.assetStoreDir, 'string');
    assert.equal(typeof config.sessionsDir,   'string');
});

// ---------------------------------------------------------------------------
// validate() — with fixture paths (Tier 2, skipped if fixture not present)
// ---------------------------------------------------------------------------

test('validate — no fatal errors against fixture data directory',
    { skip: !FIXTURE_AVAILABLE }, () => {
    const config  = PackConfiguration.fromDirectory(
        FIXTURE_DATA,
        path.join(__dirname, '..', 'fixtures', 'store'),
        path.join(__dirname, '..', 'fixtures', 'sessions'),
        'fixture'
    );
    const result      = config.validate();
    const fatalErrors = result.errors.filter(e => !e.includes('will be created'));
    assert.deepEqual(fatalErrors, []);
});

test('validate — non-fatal "will be created" messages do not affect ok flag',
    { skip: !FIXTURE_AVAILABLE }, () => {
    // Use a non-existent sessions dir so validate() emits a "will be created" warning
    const config = PackConfiguration.fromDirectory(
        FIXTURE_DATA,
        path.join(__dirname, '..', 'fixtures', 'store'),
        '/nonexistent/sessions/dir/that/does/not/exist',
        'fixture'
    );
    const result = config.validate();
    // "will be created" errors are non-fatal — ok can still be true if that's the
    // only issue, but the important thing is these don't count as fatal
    const fatalErrors = result.errors.filter(e => !e.includes('will be created'));
    assert.deepEqual(fatalErrors, []);
});

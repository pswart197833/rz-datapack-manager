'use strict';
/**
 * test/unit/staged-file.test.js
 *
 * Tier 1 — pure in-memory unit tests for StagedFile.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/staged-file.test.js
 *
 * Covers:
 *   - Existing category helpers (isNew, isInStore, isDeleted, markDeleted)
 *   - Phase 3 fields: addedBy, lockedBy, isAlias, aliasOf, conflictStatus
 *   - Phase 3 lock methods: lock(), unlock(), isLocked()
 *   - toJSON / fromJSON round-trips for all Phase 3 fields
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const StagedFile = require(path.join(__dirname, '..', '..', 'src', 'session', 'StagedFile'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal StagedFile with no filesystem side effects. */
function makeStaged(overrides = {}) {
    return new StagedFile({
        targetName: 'hero.dds',
        category:   'new',
        ...overrides
    });
}

// ---------------------------------------------------------------------------
// Existing category helpers — regression guard
// ---------------------------------------------------------------------------

test('isNew() — true for category "new"', () => {
    assert.equal(makeStaged({ category: 'new' }).isNew(), true);
});

test('isInStore() — true for category "in-store"', () => {
    assert.equal(makeStaged({ category: 'in-store' }).isInStore(), true);
});

test('isDeleted() — true for category "deleted"', () => {
    assert.equal(makeStaged({ category: 'deleted' }).isDeleted(), true);
});

test('markDeleted() — transitions category to "deleted"', () => {
    const sf = makeStaged({ category: 'new' });
    sf.markDeleted();
    assert.equal(sf.category, 'deleted');
    assert.equal(sf.isDeleted(), true);
    assert.equal(sf.isNew(),     false);
});

// ---------------------------------------------------------------------------
// Phase 3 constructor defaults
// ---------------------------------------------------------------------------

test('addedBy — defaults to null', () => {
    assert.equal(makeStaged().addedBy, null);
});

test('lockedBy — defaults to null', () => {
    assert.equal(makeStaged().lockedBy, null);
});

test('isAlias — defaults to false', () => {
    assert.equal(makeStaged().isAlias, false);
});

test('aliasOf — defaults to null', () => {
    assert.equal(makeStaged().aliasOf, null);
});

test('conflictStatus — defaults to null', () => {
    assert.equal(makeStaged().conflictStatus, null);
});

// ---------------------------------------------------------------------------
// Phase 3 lock methods
// ---------------------------------------------------------------------------

test('isLocked() — false when lockedBy is null', () => {
    const sf = makeStaged();
    assert.equal(sf.isLocked(), false);
});

test('isLocked() — true after lock(userId)', () => {
    const sf = makeStaged();
    sf.lock('user-abc');
    assert.equal(sf.isLocked(), true);
});

test('lock(userId) — sets lockedBy to the given userId', () => {
    const sf = makeStaged();
    sf.lock('user-abc');
    assert.equal(sf.lockedBy, 'user-abc');
});

test('lock(userId) — subsequent call overwrites the previous lockedBy', () => {
    const sf = makeStaged();
    sf.lock('user-abc');
    sf.lock('user-xyz');
    assert.equal(sf.lockedBy, 'user-xyz');
});

test('unlock() — sets lockedBy to null', () => {
    const sf = makeStaged();
    sf.lock('user-abc');
    sf.unlock();
    assert.equal(sf.lockedBy, null);
});

test('isLocked() — false after unlock()', () => {
    const sf = makeStaged();
    sf.lock('user-abc');
    sf.unlock();
    assert.equal(sf.isLocked(), false);
});

test('unlock() — safe to call when no lock is held (no throw)', () => {
    const sf = makeStaged();
    assert.doesNotThrow(() => sf.unlock());
    assert.equal(sf.lockedBy, null);
});

// ---------------------------------------------------------------------------
// Phase 3 toJSON / fromJSON round-trips
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — lockedBy null survives round-trip', () => {
    const sf      = makeStaged({ lockedBy: null });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.lockedBy, null);
});

test('toJSON / fromJSON — lockedBy value survives round-trip', () => {
    const sf      = makeStaged({ lockedBy: 'user-123' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.lockedBy, 'user-123');
});

test('toJSON / fromJSON — addedBy null survives round-trip', () => {
    const sf      = makeStaged({ addedBy: null });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.addedBy, null);
});

test('toJSON / fromJSON — addedBy value survives round-trip', () => {
    const sf      = makeStaged({ addedBy: 'user-456' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.addedBy, 'user-456');
});

test('toJSON / fromJSON — isAlias false survives round-trip', () => {
    const sf      = makeStaged({ isAlias: false });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.isAlias, false);
});

test('toJSON / fromJSON — isAlias true survives round-trip', () => {
    const sf      = makeStaged({ isAlias: true, aliasOf: 'canonical.dds' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.isAlias, true);
});

test('toJSON / fromJSON — aliasOf null survives round-trip', () => {
    const sf      = makeStaged({ aliasOf: null });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.aliasOf, null);
});

test('toJSON / fromJSON — aliasOf value survives round-trip', () => {
    const sf      = makeStaged({ isAlias: true, aliasOf: 'canonical.dds' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.aliasOf, 'canonical.dds');
});

test('toJSON / fromJSON — conflictStatus null survives round-trip', () => {
    const sf      = makeStaged({ conflictStatus: null });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.conflictStatus, null);
});

test('toJSON / fromJSON — conflictStatus "unresolved" survives round-trip', () => {
    const sf      = makeStaged({ conflictStatus: 'unresolved' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.conflictStatus, 'unresolved');
});

test('toJSON / fromJSON — conflictStatus "resolved-a" survives round-trip', () => {
    const sf      = makeStaged({ conflictStatus: 'resolved-a' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.conflictStatus, 'resolved-a');
});

test('toJSON / fromJSON — conflictStatus "resolved-b" survives round-trip', () => {
    const sf      = makeStaged({ conflictStatus: 'resolved-b' });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.conflictStatus, 'resolved-b');
});

// ---------------------------------------------------------------------------
// Backwards compatibility — fromJSON on legacy records without Phase 3 fields
// ---------------------------------------------------------------------------

test('fromJSON — legacy record without Phase 3 fields defaults all to safe values', () => {
    const legacy = {
        targetName:        'hero.dds',
        sourcePath:        null,
        stagedPath:        null,
        category:          'in-store',
        sourceFingerprint: 'fp-abc',
        sizeBytes:         1024,
        checksum:          null,
        stagedAt:          new Date().toISOString(),
        packId:            null
        // addedBy, lockedBy, isAlias, aliasOf, conflictStatus intentionally absent
    };
    const restored = StagedFile.fromJSON(legacy);
    assert.equal(restored.addedBy,        null,  'addedBy must default to null');
    assert.equal(restored.lockedBy,       null,  'lockedBy must default to null');
    assert.equal(restored.isAlias,        false, 'isAlias must default to false');
    assert.equal(restored.aliasOf,        null,  'aliasOf must default to null');
    assert.equal(restored.conflictStatus, null,  'conflictStatus must default to null');
});

// ---------------------------------------------------------------------------
// isAlias strictly boolean — not truthy coercion
// ---------------------------------------------------------------------------

test('isAlias — is strictly boolean false (not truthy coercion)', () => {
    const sf = StagedFile.fromJSON({
        targetName: 'hero.dds', category: 'new',
        isAlias: false
    });
    assert.strictEqual(sf.isAlias, false);
});

// ---------------------------------------------------------------------------
// toJSON shape — Phase 3 fields present
// ---------------------------------------------------------------------------

test('toJSON — all Phase 3 fields are present in output', () => {
    const sf   = makeStaged();
    const json = sf.toJSON();
    for (const field of ['addedBy', 'lockedBy', 'isAlias', 'aliasOf', 'conflictStatus']) {
        assert.ok(Object.prototype.hasOwnProperty.call(json, field),
            `toJSON() missing Phase 3 field: ${field}`);
    }
});

// ---------------------------------------------------------------------------
// Lock state survives toJSON / fromJSON
// ---------------------------------------------------------------------------

test('lock state — locked file serialises and deserialises correctly', () => {
    const sf = makeStaged();
    sf.lock('user-789');
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.lockedBy,  'user-789');
    assert.equal(restored.isLocked(), true);
});

test('lock state — unlocked file serialises and deserialises correctly', () => {
    const sf = makeStaged({ lockedBy: 'user-789' });
    sf.unlock();
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert.equal(restored.lockedBy,  null);
    assert.equal(restored.isLocked(), false);
});

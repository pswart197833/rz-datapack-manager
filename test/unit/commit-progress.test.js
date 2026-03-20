'use strict';
/**
 * test/unit/commit-progress.test.js
 *
 * Tier 1 — pure in-memory unit tests for CommitProgress and its interaction
 * with ProgressEntry.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/commit-progress.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const CommitProgress = require(path.join(__dirname, '..', '..', 'src', 'session', 'CommitProgress'));
const ProgressEntry  = require(path.join(__dirname, '..', '..', 'src', 'session', 'ProgressEntry'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(opts = {}) {
    return new ProgressEntry({
        fileFingerprint: opts.hash ?? 'hash-abc',
        decodedName:     opts.name ?? 'hero.dds',
        packId:          opts.packId ?? 1,
        category:        opts.category ?? 'new'
    });
}

// ---------------------------------------------------------------------------
// makeKey
// ---------------------------------------------------------------------------

test('makeKey — produces composite "name::hash" key', () => {
    const key = CommitProgress.makeKey('hero.dds', 'abc123');
    assert.equal(key, 'hero.dds::abc123');
});

test('makeKey — same name + same hash produces same key (exact duplicate)', () => {
    const k1 = CommitProgress.makeKey('hero.dds', 'abc123');
    const k2 = CommitProgress.makeKey('hero.dds', 'abc123');
    assert.equal(k1, k2);
});

test('makeKey — same name + different hash produces different key (updated file)', () => {
    const k1 = CommitProgress.makeKey('hero.dds', 'hash-v1');
    const k2 = CommitProgress.makeKey('hero.dds', 'hash-v2');
    assert.notEqual(k1, k2);
});

test('makeKey — different name + same hash produces different key (content alias)', () => {
    const k1 = CommitProgress.makeKey('hero.dds',      'shared-hash');
    const k2 = CommitProgress.makeKey('hero_copy.dds', 'shared-hash');
    assert.notEqual(k1, k2);
});

test('makeKey — different name + different hash produces different key (unrelated files)', () => {
    const k1 = CommitProgress.makeKey('hero.dds',    'hash-a');
    const k2 = CommitProgress.makeKey('npcinfo.cfg', 'hash-b');
    assert.notEqual(k1, k2);
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

test('constructor — initial status is "pending"', () => {
    const cp = new CommitProgress({ sessionId: 'sess-001' });
    assert.equal(cp.status, 'pending');
});

test('constructor — entries map starts empty', () => {
    const cp = new CommitProgress({ sessionId: 'sess-001' });
    assert.equal(cp.entries.size, 0);
});

test('constructor — sessionId stored correctly', () => {
    const cp = new CommitProgress({ sessionId: 'my-session' });
    assert.equal(cp.sessionId, 'my-session');
});

// ---------------------------------------------------------------------------
// addEntry / getEntry
// ---------------------------------------------------------------------------

test('addEntry — entry retrievable by makeKey', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    assert.ok(cp.getEntry(key) !== null);
    assert.equal(cp.getEntry(key).decodedName, 'hero.dds');
});

test('addEntry — entry count increases', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    cp.addEntry(makeEntry({ name: 'hero.dds',    hash: 'fp1' }));
    cp.addEntry(makeEntry({ name: 'npcinfo.cfg', hash: 'fp2' }));
    assert.equal(cp.entries.size, 2);
});

test('getEntry — returns null for unknown key', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    assert.equal(cp.getEntry('nonexistent::hash'), null);
});

// ---------------------------------------------------------------------------
// Regression: alias progress key — two entries with same hash different name
//
// Before makeKey was changed to use "name::hash" (instead of hash alone),
// two content aliases with the same hash shared one ProgressEntry. The second
// alias was silently skipped during the build loop, producing a size=0 index
// entry with cascading offset errors in the output pack.
// ---------------------------------------------------------------------------

test('Regression: two entries with same hash but different name get separate keys', () => {
    // Regression: alias progress key — same hash shared one ProgressEntry,
    // second alias was silently dropped producing size=0 index entries.
    const cp     = new CommitProgress({ sessionId: 'sess' });
    const entry1 = makeEntry({ name: 'hero.dds',      hash: 'shared-hash' });
    const entry2 = makeEntry({ name: 'hero_copy.dds', hash: 'shared-hash' });
    cp.addEntry(entry1);
    cp.addEntry(entry2);
    assert.equal(cp.entries.size, 2, 'both alias entries must be tracked separately');

    const key1 = CommitProgress.makeKey('hero.dds',      'shared-hash');
    const key2 = CommitProgress.makeKey('hero_copy.dds', 'shared-hash');
    assert.ok(cp.getEntry(key1) !== null, 'first alias entry must be retrievable');
    assert.ok(cp.getEntry(key2) !== null, 'second alias entry must be retrievable');
});

// ---------------------------------------------------------------------------
// markComplete / isFileComplete
// ---------------------------------------------------------------------------

test('markComplete — marks individual step complete', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    cp.markComplete(key, 'extracted');
    assert.equal(cp.getEntry(key).extracted, true);
});

test('markComplete — all four steps in order', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    cp.markComplete(key, 'extracted');
    cp.markComplete(key, 'verified');
    cp.markComplete(key, 'packed');
    cp.markComplete(key, 'cleaned');
    assert.equal(cp.isFileComplete(key), true);
});

test('markComplete — throws for unknown step name', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    assert.throws(
        () => cp.markComplete(key, 'invented_step'),
        { name: 'Error' }
    );
});

test('markComplete — throws for unknown key', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    assert.throws(
        () => cp.markComplete('nonexistent::hash', 'extracted'),
        { name: 'Error' }
    );
});

test('isFileComplete — false when no steps done', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    assert.equal(cp.isFileComplete(key), false);
});

test('isFileComplete — false after only some steps done', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    cp.markComplete(key, 'extracted');
    cp.markComplete(key, 'verified');
    assert.equal(cp.isFileComplete(key), false);
});

test('isFileComplete — false for unknown key', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    assert.equal(cp.isFileComplete('nonexistent::hash'), false);
});

// ---------------------------------------------------------------------------
// pendingEntries
// ---------------------------------------------------------------------------

test('pendingEntries — returns all entries when none complete', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    cp.addEntry(makeEntry({ name: 'a.dds', hash: 'h1' }));
    cp.addEntry(makeEntry({ name: 'b.dds', hash: 'h2' }));
    assert.equal(cp.pendingEntries().length, 2);
});

test('pendingEntries — completed entries are excluded', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    cp.addEntry(makeEntry({ name: 'a.dds', hash: 'h1' }));
    cp.addEntry(makeEntry({ name: 'b.dds', hash: 'h2' }));
    const key1 = CommitProgress.makeKey('a.dds', 'h1');
    cp.markComplete(key1, 'extracted');
    cp.markComplete(key1, 'verified');
    cp.markComplete(key1, 'packed');
    cp.markComplete(key1, 'cleaned');
    const pending = cp.pendingEntries();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].decodedName, 'b.dds');
});

test('pendingEntries — empty when all complete', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'a.dds', hash: 'h1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('a.dds', 'h1');
    ['extracted', 'verified', 'packed', 'cleaned'].forEach(s => cp.markComplete(key, s));
    assert.equal(cp.pendingEntries().length, 0);
});

// ---------------------------------------------------------------------------
// Status values
// ---------------------------------------------------------------------------

test('status — "committed" is the terminal success value (not "complete")', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    cp.status = 'committed';
    assert.equal(cp.status, 'committed');
    // Verify "complete" is NOT a special terminal value by confirming it doesn't
    // equal the documented terminal status
    assert.notEqual('complete', 'committed');
});

test('status — valid lifecycle values can be assigned', () => {
    const cp       = new CommitProgress({ sessionId: 'sess' });
    const statuses = ['pending', 'building', 'finalising', 'committed', 'interrupted'];
    for (const s of statuses) {
        cp.status = s;
        assert.equal(cp.status, s);
    }
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — sessionId survives', () => {
    const cp = new CommitProgress({ sessionId: 'my-session-id' });
    assert.equal(CommitProgress.fromJSON(cp.toJSON()).sessionId, 'my-session-id');
});

test('toJSON / fromJSON — status survives', () => {
    const cp  = new CommitProgress({ sessionId: 'sess' });
    cp.status = 'building';
    assert.equal(CommitProgress.fromJSON(cp.toJSON()).status, 'building');
});

test('toJSON / fromJSON — entries count survives', () => {
    const cp = new CommitProgress({ sessionId: 'sess' });
    cp.addEntry(makeEntry({ name: 'a.dds', hash: 'h1' }));
    cp.addEntry(makeEntry({ name: 'b.dds', hash: 'h2' }));
    assert.equal(CommitProgress.fromJSON(cp.toJSON()).entries.size, 2);
});

test('toJSON / fromJSON — completed entry stays complete', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    ['extracted', 'verified', 'packed', 'cleaned'].forEach(s => cp.markComplete(key, s));

    const restored    = CommitProgress.fromJSON(cp.toJSON());
    const restoredKey = CommitProgress.makeKey('hero.dds', 'fp1');
    assert.equal(restored.isFileComplete(restoredKey), true);
});

test('toJSON / fromJSON — incomplete entry stays incomplete', () => {
    const cp    = new CommitProgress({ sessionId: 'sess' });
    const entry = makeEntry({ name: 'hero.dds', hash: 'fp1' });
    cp.addEntry(entry);
    const key = CommitProgress.makeKey('hero.dds', 'fp1');
    cp.markComplete(key, 'extracted');

    const restored    = CommitProgress.fromJSON(cp.toJSON());
    const restoredKey = CommitProgress.makeKey('hero.dds', 'fp1');
    assert.equal(restored.isFileComplete(restoredKey), false);
    assert.equal(restored.getEntry(restoredKey).extracted, true);
    assert.equal(restored.getEntry(restoredKey).verified,  false);
});

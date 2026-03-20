'use strict';
/**
 * test/unit/progress-entry.test.js
 *
 * Tier 1 — pure in-memory unit tests for ProgressEntry.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/progress-entry.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const ProgressEntry = require(path.join(__dirname, '..', '..', 'src', 'session', 'ProgressEntry'));

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

test('constructor — fileFingerprint stored correctly', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.fileFingerprint, 'fp1');
});

test('constructor — decodedName stored correctly', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.decodedName, 'hero.dds');
});

test('constructor — packId stored correctly', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 5 });
    assert.equal(e.packId, 5);
});

test('constructor — category defaults to "new"', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.category, 'new');
});

test('constructor — category stored when provided', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1, category: 'in-store' });
    assert.equal(e.category, 'in-store');
});

test('constructor — extracted defaults to false', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.extracted, false);
});

test('constructor — verified defaults to false', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.verified, false);
});

test('constructor — packed defaults to false', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.packed, false);
});

test('constructor — cleaned defaults to false', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.cleaned, false);
});

// ---------------------------------------------------------------------------
// isComplete
// ---------------------------------------------------------------------------

test('isComplete — false when no steps done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.isComplete(), false);
});

test('isComplete — false when only extracted done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true });
    assert.equal(e.isComplete(), false);
});

test('isComplete — false when extracted + verified done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true });
    assert.equal(e.isComplete(), false);
});

test('isComplete — false when extracted + verified + packed done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true });
    assert.equal(e.isComplete(), false);
});

test('isComplete — true when all four steps done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true, cleaned: true });
    assert.equal(e.isComplete(), true);
});

// ---------------------------------------------------------------------------
// nextStep — returns steps in the correct order
// ---------------------------------------------------------------------------

test('nextStep — returns "extracted" when nothing done', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    assert.equal(e.nextStep(), 'extracted');
});

test('nextStep — returns "verified" after extracted', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true });
    assert.equal(e.nextStep(), 'verified');
});

test('nextStep — returns "packed" after extracted + verified', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true });
    assert.equal(e.nextStep(), 'packed');
});

test('nextStep — returns "cleaned" after extracted + verified + packed', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true });
    assert.equal(e.nextStep(), 'cleaned');
});

test('nextStep — returns null when all four steps complete', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true, cleaned: true });
    assert.equal(e.nextStep(), null);
});

test('nextStep — step order is always extracted → verified → packed → cleaned', () => {
    const e     = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    const steps = [];
    while (e.nextStep() !== null) {
        const step = e.nextStep();
        steps.push(step);
        e[step] = true;
    }
    assert.deepEqual(steps, ['extracted', 'verified', 'packed', 'cleaned']);
});

// ---------------------------------------------------------------------------
// toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

test('toJSON / fromJSON — fileFingerprint survives', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp-xyz', decodedName: 'hero.dds', packId: 1 });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).fileFingerprint, 'fp-xyz');
});

test('toJSON / fromJSON — decodedName survives', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'npcinfo.cfg', packId: 3 });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).decodedName, 'npcinfo.cfg');
});

test('toJSON / fromJSON — packId survives', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 6 });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).packId, 6);
});

test('toJSON / fromJSON — category survives', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1, category: 'in-store' });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).category, 'in-store');
});

test('toJSON / fromJSON — all step flags false survive', () => {
    const e         = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1 });
    const restored  = ProgressEntry.fromJSON(e.toJSON());
    assert.equal(restored.extracted, false);
    assert.equal(restored.verified,  false);
    assert.equal(restored.packed,    false);
    assert.equal(restored.cleaned,   false);
});

test('toJSON / fromJSON — all step flags true survive', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true, cleaned: true });
    const restored = ProgressEntry.fromJSON(e.toJSON());
    assert.equal(restored.extracted, true);
    assert.equal(restored.verified,  true);
    assert.equal(restored.packed,    true);
    assert.equal(restored.cleaned,   true);
});

test('toJSON / fromJSON — isComplete() true after round-trip of completed entry', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true, packed: true, cleaned: true });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).isComplete(), true);
});

test('toJSON / fromJSON — isComplete() false after round-trip of incomplete entry', () => {
    const e = new ProgressEntry({ fileFingerprint: 'fp1', decodedName: 'hero.dds', packId: 1,
        extracted: true, verified: true });
    assert.equal(ProgressEntry.fromJSON(e.toJSON()).isComplete(), false);
});

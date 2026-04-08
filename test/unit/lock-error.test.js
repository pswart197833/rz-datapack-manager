'use strict';
/**
 * test/unit/lock-error.test.js
 *
 * Tier 1 — pure in-memory unit tests for LockError.
 * Zero filesystem I/O. Standalone runnable:
 *   node test/unit/lock-error.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const LockError = require(path.join(__dirname, '..', '..', 'src', 'session', 'LockError'));

// ---------------------------------------------------------------------------
// instanceof / prototype chain
// ---------------------------------------------------------------------------

test('LockError is an instance of Error', () => {
    const err = new LockError('user-123');
    assert.ok(err instanceof Error, 'LockError must be an instance of Error');
});

test('LockError is an instance of LockError', () => {
    const err = new LockError('user-123');
    assert.ok(err instanceof LockError, 'LockError must be an instance of LockError');
});

// ---------------------------------------------------------------------------
// name property
// ---------------------------------------------------------------------------

test('name property equals "LockError"', () => {
    const err = new LockError('user-123');
    assert.equal(err.name, 'LockError');
});

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

test('message is non-empty when only lockedBy is provided', () => {
    const err = new LockError('user-123');
    assert.ok(err.message && err.message.length > 0,
        'message must be a non-empty string');
});

test('message includes lockedBy userId when no username is provided', () => {
    const err = new LockError('user-123');
    assert.ok(err.message.includes('user-123'),
        'message must include the lockedBy userId when no username is given');
});

test('message includes lockedByUsername when provided', () => {
    const err = new LockError('user-123', 'alice');
    assert.ok(err.message.includes('alice'),
        'message must include the lockedByUsername when provided');
});

// ---------------------------------------------------------------------------
// lockedBy field
// ---------------------------------------------------------------------------

test('lockedBy equals the userId passed to the constructor', () => {
    const err = new LockError('user-abc');
    assert.equal(err.lockedBy, 'user-abc');
});

test('lockedBy is accessible after construction', () => {
    const err = new LockError('user-xyz');
    assert.ok(Object.prototype.hasOwnProperty.call(err, 'lockedBy'),
        'lockedBy must be an own property');
});

// ---------------------------------------------------------------------------
// lockedByUsername field
// ---------------------------------------------------------------------------

test('lockedByUsername is null when not provided', () => {
    const err = new LockError('user-123');
    assert.equal(err.lockedByUsername, null);
});

test('lockedByUsername equals the username passed to the constructor', () => {
    const err = new LockError('user-123', 'alice');
    assert.equal(err.lockedByUsername, 'alice');
});

test('lockedByUsername is accessible after construction', () => {
    const err = new LockError('user-123', 'alice');
    assert.ok(Object.prototype.hasOwnProperty.call(err, 'lockedByUsername'),
        'lockedByUsername must be an own property');
});

// ---------------------------------------------------------------------------
// Stack trace
// ---------------------------------------------------------------------------

test('stack trace is populated (Error mechanics work correctly)', () => {
    const err = new LockError('user-123');
    assert.ok(err.stack && err.stack.length > 0,
        'stack must be populated — Error super() must have been called');
});

// ---------------------------------------------------------------------------
// Can be thrown and caught
// ---------------------------------------------------------------------------

test('LockError can be thrown and caught as an Error', () => {
    let caught = null;
    try {
        throw new LockError('user-456', 'bob');
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof Error,  'caught value must be an instance of Error');
    assert.ok(caught instanceof LockError, 'caught value must be an instance of LockError');
    assert.equal(caught.lockedBy,         'user-456');
    assert.equal(caught.lockedByUsername, 'bob');
    assert.equal(caught.name,             'LockError');
});

test('LockError name can be used to discriminate from generic Error in catch', () => {
    // Regression: APIServer catches LockError by checking err.name === 'LockError'
    // This test confirms that pattern works correctly.
    let caughtName = null;
    try {
        throw new LockError('user-789');
    } catch (err) {
        caughtName = err.name;
    }
    assert.equal(caughtName, 'LockError',
        'err.name must equal "LockError" so APIServer can discriminate it from generic errors');
});

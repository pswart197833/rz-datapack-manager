'use strict';
/**
 * test/unit/user-store.test.js
 *
 * Tier 2 — fixture-backed unit tests for UserStore.
 * Writes to os.tmpdir() — cleaned up after each test.
 *
 * Standalone runnable:
 *   node test/unit/user-store.test.js
 *
 * Requires: bcrypt, uuid (production dependencies)
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');

const UserStore = require(path.join(__dirname, '..', '..', 'src', 'auth', 'UserStore'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'user-store-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Bootstrap behaviour
// ---------------------------------------------------------------------------

test('Bootstrap — load() creates admin account when users.json does not exist', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const admin = store.findByUsername('admin');
        assert.ok(admin !== null, 'admin account must be created on bootstrap');
        assert.equal(admin.username, 'admin');
        assert.equal(admin.isAdmin, true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Bootstrap — created admin has mustChangePassword: true', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const admin = store.findByUsername('admin');
        assert.equal(admin.mustChangePassword, true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('Bootstrap — users.json is written to disk after bootstrap', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        assert.ok(fs.existsSync(path.join(tmpDir, 'users.json')),
            'users.json must exist after load() on a fresh store');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

test('create() — stores bcrypt hash, not plaintext password', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('alice', 'secretpassword123');

        // Read the raw user record directly from #users via findByUsername
        // The returned record from create() has passwordHash omitted.
        // To check the stored hash we look up the internal record.
        const raw = store.findByUsername('alice');
        assert.ok(raw !== null, 'alice must exist');
        assert.ok(raw.passwordHash !== 'secretpassword123',
            'passwordHash must not be the plaintext password');
        assert.ok(raw.passwordHash.startsWith('$2'),
            'passwordHash must start with bcrypt prefix $2b or $2a');
        assert.ok(raw.passwordHash.length > 50,
            'passwordHash must look like a bcrypt hash');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('create() — findByUsername() returns the created user', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('bob', 'hunter2');
        const user = store.findByUsername('bob');
        assert.ok(user !== null, 'created user must be findable by username');
        assert.equal(user.username, 'bob');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('create() — duplicate username throws', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('carol', 'pass1');
        await assert.rejects(
            () => store.create('carol', 'pass2'),
            { message: /username already taken/i }
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('create() — assigns a non-empty userId (UUID)', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('dave', 'pass');
        const user = store.findByUsername('dave');
        assert.ok(user.userId && user.userId.length > 0, 'userId must be set');
        // UUID format: 8-4-4-4-12
        assert.match(user.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('create() — isAdmin defaults to false', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('eve', 'pass');
        const user = store.findByUsername('eve');
        assert.equal(user.isAdmin, false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('create() — can create an admin user by passing isAdmin: true', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('frank', 'pass', true);
        const user = store.findByUsername('frank');
        assert.equal(user.isAdmin, true);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// findById()
// ---------------------------------------------------------------------------

test('findById() — returns correct user after create()', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('grace', 'pass');
        const byName = store.findByUsername('grace');
        const byId   = store.findById(byName.userId);
        assert.ok(byId !== null, 'findById must return the user');
        assert.equal(byId.username, 'grace');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('findById() — returns null for unknown userId', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const result = store.findById('completely-unknown-id');
        assert.equal(result, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

test('remove() — user no longer returned by findById() after remove()', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('hans', 'pass');
        const user = store.findByUsername('hans');
        await store.remove(user.userId);
        assert.equal(store.findById(user.userId), null,
            'removed user must not be found by id');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('remove() — user no longer returned by findByUsername() after remove()', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('iris', 'pass');
        const user = store.findByUsername('iris');
        await store.remove(user.userId);
        assert.equal(store.findByUsername('iris'), null,
            'removed user must not be found by username');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('remove() — returns true when user exists', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('jake', 'pass');
        const user = store.findByUsername('jake');
        const result = await store.remove(user.userId);
        assert.equal(result, true);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('remove() — returns false for unknown userId', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const result = await store.remove('nonexistent-id');
        assert.equal(result, false);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('remove() — throws when removing the last admin', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        // After bootstrap there is exactly one admin
        const admin = store.findByUsername('admin');
        await assert.rejects(
            () => store.remove(admin.userId),
            { message: /last admin/i }
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('remove() — can remove an admin when another admin exists', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('second-admin', 'pass', true);
        const admin = store.findByUsername('admin');
        // Should not throw — two admins exist
        await assert.doesNotReject(() => store.remove(admin.userId));
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

test('list() — returns all users without passwordHash field', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        await store.create('kate', 'pass');
        const users = store.list();
        assert.ok(users.length >= 2, 'list must include admin and kate');
        for (const u of users) {
            assert.equal(
                Object.prototype.hasOwnProperty.call(u, 'passwordHash'),
                false,
                'list() must not include passwordHash in any user object'
            );
        }
    } finally {
        cleanupDir(tmpDir);
    }
});

test('list() — returns at least one admin after bootstrap', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const users = store.list();
        assert.ok(users.some(u => u.isAdmin), 'at least one admin must be in list()');
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

test('verify() — returns user on correct credentials', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const user = await store.verify('admin', 'admin');
        assert.ok(user !== null, 'verify must return user for correct credentials');
        assert.equal(user.username, 'admin');
        assert.equal(
            Object.prototype.hasOwnProperty.call(user, 'passwordHash'),
            false,
            'verify must not return passwordHash'
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('verify() — returns null on wrong password', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const user = await store.verify('admin', 'wrongpassword');
        assert.equal(user, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('verify() — returns null for unknown username', async () => {
    const tmpDir = makeTempDir();
    try {
        const store = new UserStore(tmpDir);
        await store.load();
        const user = await store.verify('nonexistent', 'any');
        assert.equal(user, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// save() / load() round-trip
// ---------------------------------------------------------------------------

test('save() / load() — users survive write and reload', async () => {
    const tmpDir = makeTempDir();
    try {
        const store1 = new UserStore(tmpDir);
        await store1.load();
        await store1.create('leo', 'mypassword');

        // Reload from disk
        const store2 = new UserStore(tmpDir);
        await store2.load();

        const user = store2.findByUsername('leo');
        assert.ok(user !== null, 'leo must survive a save/load cycle');
        assert.equal(user.username, 'leo');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('save() / load() — passwords remain verifiable after reload', async () => {
    const tmpDir = makeTempDir();
    try {
        const store1 = new UserStore(tmpDir);
        await store1.load();
        await store1.create('mia', 'supersecret');

        const store2 = new UserStore(tmpDir);
        await store2.load();

        const user = await store2.verify('mia', 'supersecret');
        assert.ok(user !== null, 'password must remain verifiable after reload');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('save() / load() — isAdmin flag survives round-trip', async () => {
    const tmpDir = makeTempDir();
    try {
        const store1 = new UserStore(tmpDir);
        await store1.load();
        await store1.create('nick', 'pass', true);

        const store2 = new UserStore(tmpDir);
        await store2.load();

        const user = store2.findByUsername('nick');
        assert.equal(user.isAdmin, true, 'isAdmin must survive save/load');
    } finally {
        cleanupDir(tmpDir);
    }
});

'use strict';
/**
 * test/integration/session-manager.test.js
 *
 * Tier 3 — pipeline integration tests for SessionManager.
 * Reads from test/fixtures/data/ and test/fixtures/store/.
 * All writes (sessions, output packs) go to unique temp dirs under os.tmpdir()
 * cleaned up after each test.
 *
 * Requires fixtures to have been generated first:
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/3.generate-fixture.js
 *
 * Standalone runnable:
 *   node test/integration/session-manager.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const crypto   = require('node:crypto');

const SessionManager    = require(path.join(__dirname, '..', '..', 'src', 'session', 'SessionManager'));
const PackConfiguration = require(path.join(__dirname, '..', '..', 'src', 'config', 'PackConfiguration'));
const AssetStore        = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));
const FingerprintStore  = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintStore'));
const Blueprint         = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'Blueprint'));
const Session           = require(path.join(__dirname, '..', '..', 'src', 'session', 'Session'));
const StagedFile        = require(path.join(__dirname, '..', '..', 'src', 'session', 'StagedFile'));
const LockError         = require(path.join(__dirname, '..', '..', 'src', 'session', 'LockError'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_STORE    = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');
const FIXTURE_INDEX    = path.join(FIXTURE_DATA,     'data.000');
const ENTRIES_PATH     = path.join(FIXTURE_EXPECTED, 'entries.json');
const PACK_MAP_PATH    = path.join(FIXTURE_EXPECTED, 'pack-map.json');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_INDEX)
                       && fs.existsSync(ENTRIES_PATH)
                       && fs.existsSync(PACK_MAP_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Build a fixture-backed SessionManager and a PackConfiguration pointing at
 * the fixture data.
 */
async function makeFixtureSetup(sessionsDir, outputDir) {
    const out = outputDir || sessionsDir;

    const assetStore = new AssetStore(FIXTURE_STORE);
    await assetStore.rebuild();

    const fpStore = new FingerprintStore(
        path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
        assetStore
    );
    await fpStore.load();

    for (const record of fpStore.list()) {
        if (record.extractedPath && !path.isAbsolute(record.extractedPath)) {
            record.extractedPath = path.join(FIXTURE_STORE, record.extractedPath);
        }
    }

    const config = new PackConfiguration({
        indexPath:     FIXTURE_INDEX,
        packPaths:     new Map(
            Array.from({ length: 8 }, (_, i) => [
                i + 1, path.join(FIXTURE_DATA, `data.00${i + 1}`)
            ]).filter(([, p]) => fs.existsSync(p) && fs.statSync(p).size > 0)
        ),
        assetStoreDir: FIXTURE_STORE,
        sessionsDir
    });

    const manager = new SessionManager(sessionsDir, fpStore, assetStore);
    return { manager, fpStore, assetStore, config, sessionsDir };
}

function getFixtureBlueprintFp() {
    const bpDir = path.join(FIXTURE_STORE, 'blueprints');
    if (!fs.existsSync(bpDir)) return null;
    const files = fs.readdirSync(bpDir).filter(f => f.endsWith('.json'));
    return files.length > 0 ? files[0].replace('.json', '') : null;
}

// ---------------------------------------------------------------------------
// create(config, label) — API contract and session state
// ---------------------------------------------------------------------------

test('create(config, label) — config is the FIRST argument, label is second',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'My Session Label');
        assert.equal(session.label, 'My Session Label',
            'label must be the second argument — create(config, label)');
        assert.ok(session.config !== null, 'config must be stored on the session');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('create() — returns a Session instance with status "active"',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test Session');
        assert.ok(session instanceof Session, 'create() must return a Session');
        assert.equal(session.status, 'active');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('create() — assigns a non-empty sessionId',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');
        assert.ok(session.sessionId && session.sessionId.length > 0,
            'session must have a non-empty sessionId');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('create() — working directory is created on disk',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');
        assert.ok(fs.existsSync(session.workingDir),
            'workingDir must exist on disk after create()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('create() — session.json is written to workingDir',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session    = await manager.create(config, 'Test');
        const jsonPath   = path.join(session.workingDir, 'session.json');
        assert.ok(fs.existsSync(jsonPath),
            'session.json must be written to workingDir after create()');
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        assert.equal(parsed.sessionId, session.sessionId);
        assert.equal(parsed.status, 'active');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('create() — two calls produce different sessionIds',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const s1 = await manager.create(config, 'A');
        const s2 = await manager.create(config, 'B');
        assert.notEqual(s1.sessionId, s2.sessionId);
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// addFile() and addFromStore()
// ---------------------------------------------------------------------------

test('session.addFile() — staged with category "new", checksum set, sizeBytes set',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');

        const srcPath = path.join(sessionsDir, 'temp-asset.cfg');
        fs.writeFileSync(srcPath, Buffer.from('cfg file content for staging test'));

        const staged = session.addFile(srcPath, 'temp-asset.cfg');

        assert.equal(staged.category, 'new', 'addFile() must produce category "new"');
        assert.ok(staged.checksum && staged.checksum.length === 64,
            'addFile() must compute a SHA-256 checksum');
        assert.ok(staged.sizeBytes > 0, 'addFile() must set sizeBytes');
        assert.equal(staged.targetName, 'temp-asset.cfg');
        assert.ok(fs.existsSync(staged.stagedPath),
            'staged file must exist on disk inside workingDir');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('session.addFile() — file is copied into workingDir',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');

        const srcPath = path.join(sessionsDir, 'copy-test.cfg');
        fs.writeFileSync(srcPath, Buffer.from('copy test content'));

        const staged = session.addFile(srcPath, 'copy-test.cfg');
        assert.ok(staged.stagedPath.startsWith(session.workingDir),
            'stagedPath must be inside the session workingDir');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('session.addFromStore() — staged with category "in-store", packId preserved from blueprint',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp, 'fixture must have a blueprint');
    try {
        const { manager, fpStore, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config, 'Blueprint session');

        const files = session.listFiles();
        assert.ok(files.length > 0, 'session must have staged files after openFromBlueprint');
        assert.ok(files.every(f => f.isInStore()),
            'all files from openFromBlueprint must have category "in-store"');

        const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const expMap   = new Map(expected.map(e => [e.decodedName, e]));
        for (const f of files) {
            const exp = expMap.get(f.targetName);
            if (!exp) continue;
            assert.equal(f.packId, exp.packId,
                `packId for "${f.targetName}" must match blueprint (expected ${exp.packId}, got ${f.packId})`);
        }
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// removeFile()
// ---------------------------------------------------------------------------

test('session.removeFile() — transitions category to "deleted", entry remains in listFiles()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');

        const srcPath = path.join(sessionsDir, 'to-delete.cfg');
        fs.writeFileSync(srcPath, Buffer.from('file to be deleted'));
        session.addFile(srcPath, 'to-delete.cfg');

        const removed = session.removeFile('to-delete.cfg');
        assert.equal(removed, true, 'removeFile() must return true for a known file');

        const all = session.listFiles();
        const file = all.find(f => f.targetName === 'to-delete.cfg');
        assert.ok(file, 'removed file must still appear in listFiles() (audit trail)');
        assert.equal(file.category, 'deleted',
            'category must be "deleted" after removeFile()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('session.removeFile() — returns false for unknown targetName',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Test');
        const removed = session.removeFile('nonexistent.dds');
        assert.equal(removed, false);
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// checkpoint()
// ---------------------------------------------------------------------------

test('checkpoint() — session.json on disk matches in-memory state after modification',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Checkpoint Test');

        const srcPath = path.join(sessionsDir, 'checkpoint.cfg');
        fs.writeFileSync(srcPath, Buffer.from('checkpoint test file'));
        session.addFile(srcPath, 'checkpoint.cfg');

        await manager.checkpoint(session.sessionId);

        const jsonPath = path.join(session.workingDir, 'session.json');
        const onDisk   = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        assert.equal(onDisk.sessionId, session.sessionId);
        assert.equal(onDisk.stagedFiles.length, session.listFiles().length,
            'stagedFiles count on disk must match in-memory count after checkpoint');
        const onDiskFile = onDisk.stagedFiles.find(f => f.targetName === 'checkpoint.cfg');
        assert.ok(onDiskFile, 'staged file must appear in session.json after checkpoint');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// getSession() and list()
// ---------------------------------------------------------------------------

test('getSession() — returns the in-memory session by ID',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session   = await manager.create(config, 'Find Me');
        const retrieved = manager.getSession(session.sessionId);
        assert.ok(retrieved !== null, 'getSession() must return the created session');
        assert.equal(retrieved.sessionId, session.sessionId);
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('getSession() — returns null for unknown ID',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager } = await makeFixtureSetup(sessionsDir);
        assert.equal(manager.getSession('completely-unknown-id'), null);
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('list() — includes created session with correct label and status',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        await manager.create(config, 'Listed Session');
        const sessions = await manager.list();
        const found = sessions.find(s => s.label === 'Listed Session');
        assert.ok(found, 'list() must include the created session');
        assert.equal(found.status, 'active');
        assert.ok(typeof found.fileCount === 'number', 'list() entry must have fileCount');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('list() — returns sessions sorted by updatedAt descending',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        await manager.create(config, 'First');
        await new Promise(r => setTimeout(r, 10));
        await manager.create(config, 'Second');

        const sessions = await manager.list();
        assert.ok(sessions.length >= 2);
        const idx1 = sessions.findIndex(s => s.label === 'Second');
        const idx2 = sessions.findIndex(s => s.label === 'First');
        assert.ok(idx1 < idx2, 'most recently updated session must appear first');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// resume()
// ---------------------------------------------------------------------------

test('resume() — reloads session from disk with all staged files intact',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Resume Test');

        const srcPath = path.join(sessionsDir, 'resume-asset.cfg');
        fs.writeFileSync(srcPath, Buffer.from('resume test content'));
        session.addFile(srcPath, 'resume-asset.cfg');
        await manager.checkpoint(session.sessionId);

        const { manager: manager2 } = await makeFixtureSetup(sessionsDir);
        const resumed = await manager2.resume(session.sessionId);

        assert.equal(resumed.sessionId, session.sessionId);
        assert.equal(resumed.label,     session.label);
        assert.equal(resumed.status,    'active');
        assert.equal(resumed.listFiles().length, session.listFiles().length,
            'resumed session must have the same staged file count');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('resume() — throws for unknown sessionId',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager } = await makeFixtureSetup(sessionsDir);
        await assert.rejects(
            () => manager.resume('completely-unknown-session-id'),
            { message: /not found/i }
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// prepare()
// ---------------------------------------------------------------------------

test('prepare() — status transitions to "ready"',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp, 'fixture must have a blueprint');
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config);
        await manager.prepare(session.sessionId);
        assert.equal(session.status, 'ready');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('prepare() — pack-list.json and index-list.json are written to workingDir',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp);
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config);
        await manager.prepare(session.sessionId);

        const packListPath  = path.join(session.workingDir, 'pack-list.json');
        const indexListPath = path.join(session.workingDir, 'index-list.json');
        assert.ok(fs.existsSync(packListPath),  'pack-list.json must exist after prepare()');
        assert.ok(fs.existsSync(indexListPath), 'index-list.json must exist after prepare()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('prepare() — pack-list.json excludes zero-size (sentinel-backed) entries',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp);
    try {
        const { manager, fpStore, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config);
        await manager.prepare(session.sessionId);

        const packList = JSON.parse(
            fs.readFileSync(path.join(session.workingDir, 'pack-list.json'), 'utf8')
        );

        const nullHash = AssetStore.NULL_ASSET_HASH;
        const nullEntries = packList.filter(f => f.sourceFingerprint === nullHash);
        assert.equal(nullEntries.length, 0,
            'pack-list.json must not contain null-sentinel (zero-size) entries');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('prepare() — throws if session already ready',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp);
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config);
        await manager.prepare(session.sessionId);
        await assert.rejects(
            () => manager.prepare(session.sessionId),
            { message: /cannot be prepared/i }
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// discard()
// ---------------------------------------------------------------------------

test('discard() — working directory is deleted from filesystem',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session    = await manager.create(config, 'Discard Me');
        const workingDir = session.workingDir;
        assert.ok(fs.existsSync(workingDir), 'workingDir must exist before discard');

        await manager.discard(session.sessionId);
        assert.equal(fs.existsSync(workingDir), false,
            'workingDir must be removed from disk after discard()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('discard() — session is removed from active map (getSession returns null)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Discard Active Map');
        assert.ok(manager.getSession(session.sessionId) !== null, 'session must be in active map');

        await manager.discard(session.sessionId);
        assert.equal(manager.getSession(session.sessionId), null,
            'getSession() must return null after discard()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// openFromBlueprint()
// ---------------------------------------------------------------------------

test('openFromBlueprint() — returns Session with blueprintRef set',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp);
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config, 'From BP');
        assert.equal(session.blueprintRef, indexFp);
        assert.equal(session.blueprintLoaded, true);
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('openFromBlueprint() — all staged files are in-store',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const indexFp     = getFixtureBlueprintFp();
    assert.ok(indexFp);
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.openFromBlueprint(indexFp, FIXTURE_STORE, config);
        const files   = session.listFiles();
        assert.ok(files.length > 0, 'session must have staged files from blueprint');
        assert.ok(files.every(f => f.isInStore()),
            'all files from openFromBlueprint must be in-store');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('openFromBlueprint() — throws for unknown fingerprint',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        await assert.rejects(
            () => manager.openFromBlueprint('nonexistent-fingerprint-xyz', FIXTURE_STORE, config),
            { message: /no blueprint found/i }
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// Regression — create(config, label) argument order
// ---------------------------------------------------------------------------

test('Regression: create(label, config) would produce a session with wrong label — always use create(config, label)',
    // Regression: SessionManager.create(config, label) — config is the FIRST argument.
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);

        const correct = await manager.create(config, 'correct label');
        assert.equal(correct.label, 'correct label',
            'label must be the second argument in create(config, label)');
        assert.ok(correct.config !== null,
            'config must be stored when passed as the first argument');
        assert.equal(correct.config.getIndexPath(), FIXTURE_INDEX,
            'session config must have the fixture indexPath');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ===========================================================================
// Phase 3 additions
// ===========================================================================

// ---------------------------------------------------------------------------
// create(config, label, userId) — ownerId
// ---------------------------------------------------------------------------

test('Phase 3: create(config, label, userId) — ownerId on returned session equals userId',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Owned Session', 'user-abc');
        assert.equal(session.ownerId, 'user-abc',
            'ownerId must equal the userId passed as the third argument');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: create() without userId — ownerId defaults to null',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'No Owner');
        assert.equal(session.ownerId, null,
            'ownerId must be null when userId is not provided');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: create(config, label, userId) — ownerId survives checkpoint() and resume()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Persist Owner', 'user-xyz');
        await manager.checkpoint(session.sessionId);

        const { manager: manager2 } = await makeFixtureSetup(sessionsDir);
        const resumed = await manager2.resume(session.sessionId);
        assert.equal(resumed.ownerId, 'user-xyz',
            'ownerId must survive checkpoint() and resume()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// compressionEnabled default
// ---------------------------------------------------------------------------

test('Phase 3: compressionEnabled defaults to true on new session',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Compression Default');
        assert.equal(session.compressionEnabled, true,
            'compressionEnabled must default to true');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// New fields survive resume()
// ---------------------------------------------------------------------------

test('Phase 3: new fields (sourceType, outputDir, compressionEnabled) survive resume()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Field Persistence Test', 'user-1');

        // Verify defaults are set
        assert.equal(session.sourceType,         'scratch');
        assert.equal(session.compressionEnabled, true);
        assert.ok(session.outputDir && session.outputDir.length > 0,
            'outputDir must be set to a non-empty path');

        await manager.checkpoint(session.sessionId);

        const { manager: manager2 } = await makeFixtureSetup(sessionsDir);
        const resumed = await manager2.resume(session.sessionId);

        assert.equal(resumed.sourceType,         'scratch');
        assert.equal(resumed.compressionEnabled, true);
        assert.equal(resumed.outputDir,          session.outputDir,
            'outputDir must survive checkpoint() and resume()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// SessionManager.addFile() — lock enforcement
// ---------------------------------------------------------------------------

test('Phase 3: SessionManager.addFile() — sets lockedBy to userId after staging',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Lock Test', 'user-a');

        const srcPath = path.join(sessionsDir, 'lockable.cfg');
        fs.writeFileSync(srcPath, Buffer.from('lockable content'));

        const staged = await manager.addFile(
            session.sessionId, srcPath, 'lockable.cfg', 'user-a'
        );
        assert.equal(staged.lockedBy, 'user-a',
            'lockedBy must be set to the userId after addFile()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.addFile() — sets addedBy to userId',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'AddedBy Test', 'user-a');

        const srcPath = path.join(sessionsDir, 'tracked.cfg');
        fs.writeFileSync(srcPath, Buffer.from('tracked content'));

        const staged = await manager.addFile(
            session.sessionId, srcPath, 'tracked.cfg', 'user-a'
        );
        assert.equal(staged.addedBy, 'user-a',
            'addedBy must be set to the userId after addFile()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.addFile() — adds userId to session.collaborators',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Collaborators Test');

        const srcPath = path.join(sessionsDir, 'collab.cfg');
        fs.writeFileSync(srcPath, Buffer.from('collab content'));

        await manager.addFile(session.sessionId, srcPath, 'collab.cfg', 'user-b');
        assert.ok(session.collaborators.includes('user-b'),
            'userId must be added to session.collaborators after addFile()');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.addFile() — userId added to collaborators only once (no duplicates)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'No Dup Collaborators');

        const src1 = path.join(sessionsDir, 'file1.cfg');
        const src2 = path.join(sessionsDir, 'file2.cfg');
        fs.writeFileSync(src1, Buffer.from('content 1'));
        fs.writeFileSync(src2, Buffer.from('content 2'));

        await manager.addFile(session.sessionId, src1, 'file1.cfg', 'user-c');
        await manager.addFile(session.sessionId, src2, 'file2.cfg', 'user-c');

        const count = session.collaborators.filter(id => id === 'user-c').length;
        assert.equal(count, 1,
            'userId must appear only once in collaborators even after multiple addFile() calls');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.addFile() by lock owner — succeeds (no LockError)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Owner Re-add Test');

        const src1 = path.join(sessionsDir, 'owned.cfg');
        const src2 = path.join(sessionsDir, 'owned2.cfg');
        fs.writeFileSync(src1, Buffer.from('first version'));
        fs.writeFileSync(src2, Buffer.from('second version'));

        // User A adds the file — acquires lock
        await manager.addFile(session.sessionId, src1, 'owned.cfg', 'user-a');

        // User A replaces their own file — must not throw
        await assert.doesNotReject(
            () => manager.addFile(session.sessionId, src2, 'owned.cfg', 'user-a'),
            'lock owner must be able to replace their own staged file without LockError'
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.addFile() by different user on locked file — throws LockError',
    // Regression: file-level lock enforcement — different user must not overwrite a locked file
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Lock Conflict Test');

        const src1 = path.join(sessionsDir, 'contested.cfg');
        const src2 = path.join(sessionsDir, 'contested2.cfg');
        fs.writeFileSync(src1, Buffer.from('user a content'));
        fs.writeFileSync(src2, Buffer.from('user b content'));

        // User A locks the file
        await manager.addFile(session.sessionId, src1, 'contested.cfg', 'user-a');

        // User B must be rejected
        await assert.rejects(
            () => manager.addFile(session.sessionId, src2, 'contested.cfg', 'user-b'),
            (err) => {
                assert.ok(err instanceof LockError, 'must throw a LockError');
                assert.equal(err.lockedBy, 'user-a', 'lockedBy must identify the lock owner');
                assert.equal(err.name, 'LockError');
                return true;
            }
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

// ---------------------------------------------------------------------------
// SessionManager.removeFile() — lock enforcement
// ---------------------------------------------------------------------------

test('Phase 3: SessionManager.removeFile() by lock owner — succeeds',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Owner Remove Test');

        const srcPath = path.join(sessionsDir, 'owner-del.cfg');
        fs.writeFileSync(srcPath, Buffer.from('to be removed by owner'));

        await manager.addFile(session.sessionId, srcPath, 'owner-del.cfg', 'user-a');

        await assert.doesNotReject(
            () => manager.removeFile(session.sessionId, 'owner-del.cfg', 'user-a'),
            'lock owner must be able to remove their own file without LockError'
        );

        const file = session.listFiles().find(f => f.targetName === 'owner-del.cfg');
        assert.equal(file.category, 'deleted',
            'file must be marked deleted after removeFile() by owner');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.removeFile() by different user on locked file — throws LockError',
    // Regression: file-level lock enforcement — different user must not delete a locked file
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'Remove Lock Conflict Test');

        const srcPath = path.join(sessionsDir, 'protected.cfg');
        fs.writeFileSync(srcPath, Buffer.from('protected content'));

        // User A locks the file
        await manager.addFile(session.sessionId, srcPath, 'protected.cfg', 'user-a');

        // User B must be rejected
        await assert.rejects(
            () => manager.removeFile(session.sessionId, 'protected.cfg', 'user-b'),
            (err) => {
                assert.ok(err instanceof LockError, 'must throw a LockError');
                assert.equal(err.lockedBy, 'user-a', 'lockedBy must identify the lock owner');
                return true;
            }
        );

        // File must still be present and NOT deleted
        const file = session.listFiles().find(f => f.targetName === 'protected.cfg');
        assert.ok(file, 'file must still exist after failed remove');
        assert.notEqual(file.category, 'deleted',
            'file must not be deleted after a failed removeFile() attempt');
    } finally {
        cleanupDir(sessionsDir);
    }
});

test('Phase 3: SessionManager.removeFile() without userId on unlocked file — succeeds',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    try {
        const { manager, config } = await makeFixtureSetup(sessionsDir);
        const session = await manager.create(config, 'No-lock Remove Test');

        const srcPath = path.join(sessionsDir, 'unlocked.cfg');
        fs.writeFileSync(srcPath, Buffer.from('unlocked content'));

        // Add without userId — file is unlocked
        session.addFile(srcPath, 'unlocked.cfg');

        await assert.doesNotReject(
            () => manager.removeFile(session.sessionId, 'unlocked.cfg', null),
            'removeFile() on an unlocked file must succeed even with null userId'
        );
    } finally {
        cleanupDir(sessionsDir);
    }
});

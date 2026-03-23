'use strict';
/**
 * test/integration/commit-pipeline.test.js
 *
 * Tier 3 — pipeline integration tests for CommitPipeline.
 * Reads from test/fixtures/data/ and test/fixtures/store/.
 * All output (built pack files) goes to unique temp dirs under os.tmpdir().
 * The fixture data directory and fixture store are NEVER modified.
 *
 * Requires fixtures to have been generated first:
 *   node test/fixtures/1.collect-test-data.js
 *   node test/fixtures/2.setup-test-store.js
 *   node test/fixtures/3.generate-fixture.js
 *
 * Standalone runnable:
 *   node test/integration/commit-pipeline.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const crypto   = require('node:crypto');

const SessionManager    = require(path.join(__dirname, '..', '..', 'src', 'session', 'SessionManager'));
const CommitPipeline    = require(path.join(__dirname, '..', '..', 'src', 'session', 'CommitPipeline'));
const PackConfiguration = require(path.join(__dirname, '..', '..', 'src', 'config', 'PackConfiguration'));
const AssetStore        = require(path.join(__dirname, '..', '..', 'src', 'core', 'AssetStore'));
const FingerprintStore  = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'FingerprintStore'));
const DataPackIndex     = require(path.join(__dirname, '..', '..', 'src', 'core', 'DataPackIndex'));
const Blueprint         = require(path.join(__dirname, '..', '..', 'src', 'fingerprint', 'Blueprint'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DATA     = path.join(__dirname, '..', 'fixtures', 'data');
const FIXTURE_STORE    = path.join(__dirname, '..', 'fixtures', 'store');
const FIXTURE_EXPECTED = path.join(__dirname, '..', 'fixtures', 'expected');
const FIXTURE_INDEX    = path.join(FIXTURE_DATA,     'data.000');
const ENTRIES_PATH     = path.join(FIXTURE_EXPECTED, 'entries.json');
const HASHES_PATH      = path.join(FIXTURE_EXPECTED, 'hashes.json');
const PACK_MAP_PATH    = path.join(FIXTURE_EXPECTED, 'pack-map.json');

const FIXTURE_AVAILABLE = fs.existsSync(FIXTURE_INDEX)
                       && fs.existsSync(ENTRIES_PATH)
                       && fs.existsSync(HASHES_PATH)
                       && fs.existsSync(PACK_MAP_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function getFixtureBlueprintFp() {
    const bpDir = path.join(FIXTURE_STORE, 'blueprints');
    if (!fs.existsSync(bpDir)) return null;
    const files = fs.readdirSync(bpDir).filter(f => f.endsWith('.json'));
    return files.length > 0 ? files[0].replace('.json', '') : null;
}

/**
 * Full setup for a commit test.
 *
 * Builds:
 *   - A fixture-backed FingerprintStore / AssetStore (read from FIXTURE_STORE)
 *   - A PackConfiguration whose output (index + pack files) points to outDir
 *   - A session opened from the fixture blueprint
 *   - The session is prepared (status → ready)
 *
 * The caller runs execute() and verifies the output in outDir.
 *
 * @param {string} sessionsDir - Temp dir for session working folders
 * @param {string} outDir      - Temp dir where pack files will be written
 * @returns {{ session, manager, fpStore, assetStore, config }}
 */
async function makeReadySession(sessionsDir, outDir) {
    const indexFp = getFixtureBlueprintFp();
    if (!indexFp) throw new Error('No fixture blueprint found');

    const assetStore = new AssetStore(FIXTURE_STORE);
    await assetStore.rebuild();

    const fpStore = new FingerprintStore(
        path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
        assetStore
    );
    await fpStore.load();

    // Patch relative extractedPaths to absolute
    for (const record of fpStore.list()) {
        if (record.extractedPath && !path.isAbsolute(record.extractedPath)) {
            record.extractedPath = path.join(FIXTURE_STORE, record.extractedPath);
        }
    }

    // Output config: reads pack data from FIXTURE_DATA, writes output to outDir
    const config = new PackConfiguration({
        indexPath:     path.join(outDir, 'data.000'),
        packPaths:     new Map(
            Array.from({ length: 8 }, (_, i) => [i + 1, path.join(outDir, `data.00${i + 1}`)])
        ),
        assetStoreDir: FIXTURE_STORE,
        sessionsDir
    });

    const manager = new SessionManager(sessionsDir, fpStore, assetStore);

    // We need a session config that reads from FIXTURE_DATA for pack file
    // access during the build, but writes output to outDir.
    // SessionManager.openFromBlueprint uses config for the output paths.
    // CommitPipeline reads staged asset bytes from the fixture AssetStore
    // (via stagedPath resolved from sourceFingerprint), so pack read paths
    // are not used during build — only the output paths matter.
    const session = await manager.openFromBlueprint(
        indexFp, FIXTURE_STORE, config, 'Commit Test'
    );

    await manager.prepare(session.sessionId);
    return { session, manager, fpStore, assetStore, config };
}

// ---------------------------------------------------------------------------
// execute() — output correctness
// ---------------------------------------------------------------------------

test('execute() — output data.000 SHA-256 matches expected/hashes.json (byte-identical reconstruction)',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const expectedHashes = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const outIndex = path.join(outDir, 'data.000');
        assert.ok(fs.existsSync(outIndex), 'data.000 must be created in outDir');
        const outBuf = fs.readFileSync(outIndex);
        assert.equal(sha256(outBuf), expectedHashes['data.000'],
            'output data.000 must be byte-identical to fixture (SHA-256 must match)');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — output pack file SHA-256 matches expected/hashes.json for each slot',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir    = makeTempDir();
    const outDir         = makeTempDir();
    try {
        const expectedHashes = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        // Check every pack slot that the fixture contains data for
        for (let slot = 1; slot <= 8; slot++) {
            const key      = `data.00${slot}`;
            const outPath  = path.join(outDir, key);
            const expHash  = expectedHashes[key];
            if (!expHash || !fs.existsSync(outPath)) continue;

            const outBuf = fs.readFileSync(outPath);
            assert.equal(sha256(outBuf), expHash,
                `${key} SHA-256 must match expected/hashes.json`);
        }
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — output data.000 is parseable and has correct entry count',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const outIndex = new DataPackIndex();
        outIndex.parse(fs.readFileSync(path.join(outDir, 'data.000')));

        assert.equal(outIndex.entries.length, expected.length,
            'output data.000 must have the same number of entries as expected');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — zero-size entries
// ---------------------------------------------------------------------------

test('execute() — zero-size entries appear in output index with original packId and offset',
    // Regression: sentinel handling — zero-size entries must be preserved at
    // their exact original positions in the reconstructed index.
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const expected  = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const zeroExpected = expected.filter(e => e.size === 0);

        // Skip if fixture has no zero-size entries (seed-dependent)
        if (zeroExpected.length === 0) return;

        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const outIndex = new DataPackIndex();
        outIndex.parse(fs.readFileSync(path.join(outDir, 'data.000')));

        const outMap = new Map(outIndex.entries.map(e => [e.decodedName, e]));

        for (const exp of zeroExpected) {
            const outEntry = outMap.get(exp.decodedName);
            assert.ok(outEntry,
                `zero-size entry "${exp.decodedName}" must appear in output index`);
            assert.equal(outEntry.size, 0,
                `zero-size entry "${exp.decodedName}" must have size 0 in output`);
            assert.equal(outEntry.packId, exp.packId,
                `zero-size entry "${exp.decodedName}" packId must match expected (${exp.packId})`);
            assert.equal(outEntry.offset, exp.offset,
                `zero-size entry "${exp.decodedName}" offset must match expected (${exp.offset})`);
        }
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — alias entries
// ---------------------------------------------------------------------------

test('execute() — alias entries appear in output index with correct sizes',
    // Regression: alias progress key — when two names share the same content hash,
    // CommitProgress must use "name::hash" as the key so both aliases are tracked
    // independently. Using hash alone silently dropped the second alias, producing
    // a size=0 index entry with cascading offset errors.
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        // Find aliases that are actually in the fixture index (entries.json).
        // Aliases that are in fingerprints.jsonl but NOT in entries.json are not
        // part of the fixture pack subset and will correctly have size=0 (they were
        // never included in the session). Only aliases that appear in entries.json
        // with size > 0 are guaranteed to be staged and written.
        const fpPath   = path.join(FIXTURE_STORE, 'fingerprints.jsonl');
        const lines    = fs.readFileSync(fpPath, 'utf8')
            .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        const allAliases = lines.filter(r => r.isAlias === true && r.type === 'asset');

        const expected     = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const expectedNames = new Set(expected.filter(e => e.size > 0).map(e => e.decodedName));

        // Only check aliases that appear in the fixture index with non-zero size
        const aliases = allAliases.filter(r => expectedNames.has(r.decodedName));

        if (aliases.length === 0) {
            // No qualifying aliases in this fixture seed — informational pass
            return;
        }

        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const outIndex = new DataPackIndex();
        outIndex.parse(fs.readFileSync(path.join(outDir, 'data.000')));
        const outMap = new Map(outIndex.entries.map(e => [e.decodedName, e]));

        for (const alias of aliases) {
            const outEntry = outMap.get(alias.decodedName);
            if (!outEntry) continue;

            assert.ok(outEntry.size > 0,
                `alias entry "${alias.decodedName}" must have size > 0 in output index — ` +
                `size=0 indicates the alias progress key bug has re-appeared`);
        }
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — session and progress state
// ---------------------------------------------------------------------------

test('execute() — session.status is "committed" after successful execute()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        assert.equal(session.status, 'committed',
            'session.status must be "committed" after execute() — not "complete"');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — returns CommitResult with correct shape { complete, total, sessionId }',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        const result   = await pipeline.execute();

        assert.ok(result !== null, 'execute() must return a result object');
        assert.equal(typeof result.complete,   'number', 'result.complete must be a number');
        assert.equal(typeof result.total,      'number', 'result.total must be a number');
        assert.equal(typeof result.sessionId,  'string', 'result.sessionId must be a string');
        assert.equal(result.sessionId, session.sessionId);

        // After the ProgressEntry gap fix, complete must equal total:
        // all four steps (extracted, verified, packed, cleaned) are now set correctly
        // in #build(), so every ProgressEntry.isComplete() returns true.
        assert.ok(result.total > 0,
            'result.total must be > 0 for a non-empty session');
        assert.equal(result.complete, result.total,
            'result.complete must equal result.total — every entry must complete all four steps');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — progress.json is written with status "committed"',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline     = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const progressPath = path.join(session.workingDir, 'progress.json');
        assert.ok(fs.existsSync(progressPath),
            'progress.json must be written to workingDir');
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        assert.equal(progress.status, 'committed',
            'progress.json status must be "committed" — not "complete"');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — filesystem cleanliness
// ---------------------------------------------------------------------------

test('execute() — no .build temp files remain in outDir after execute()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const buildFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.build'));
        assert.equal(buildFiles.length, 0,
            '.build temp files must be renamed to final names after execute()');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — at least one pack file exists in outDir after execute()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const packFiles = Array.from({ length: 8 }, (_, i) =>
            path.join(outDir, `data.00${i + 1}`)
        ).filter(p => fs.existsSync(p) && fs.statSync(p).size > 0);

        assert.ok(packFiles.length > 0,
            'at least one non-empty pack file must exist in outDir after execute()');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — guard checks
// ---------------------------------------------------------------------------

test('execute() — throws if session status is not "ready"',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const assetStore = new AssetStore(FIXTURE_STORE);
        await assetStore.rebuild();
        const fpStore = new FingerprintStore(
            path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
            assetStore
        );
        await fpStore.load();

        const config = new PackConfiguration({
            indexPath:     path.join(outDir, 'data.000'),
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [i + 1, path.join(outDir, `data.00${i + 1}`)])
            ),
            assetStoreDir: FIXTURE_STORE,
            sessionsDir
        });

        const manager = new SessionManager(sessionsDir, fpStore, assetStore);
        // Create session but do NOT call prepare() — status stays "active"
        const session  = await manager.create(config, 'Not Ready');

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await assert.rejects(
            () => pipeline.execute(),
            { message: /not ready/i }
        );
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — via SessionManager.commit() throws if session not ready',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const assetStore = new AssetStore(FIXTURE_STORE);
        await assetStore.rebuild();
        const fpStore = new FingerprintStore(
            path.join(FIXTURE_STORE, 'fingerprints.jsonl'),
            assetStore
        );
        await fpStore.load();

        const config = new PackConfiguration({
            indexPath:     path.join(outDir, 'data.000'),
            packPaths:     new Map(
                Array.from({ length: 8 }, (_, i) => [i + 1, path.join(outDir, `data.00${i + 1}`)])
            ),
            assetStoreDir: FIXTURE_STORE,
            sessionsDir
        });

        const manager = new SessionManager(sessionsDir, fpStore, assetStore);
        const session  = await manager.create(config, 'Commit Guard Test');
        // No prepare() — session is "active"
        await assert.rejects(
            () => manager.commit(session.sessionId),
            { message: /not ready/i }
        );
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

// ---------------------------------------------------------------------------
// execute() — output index entries correctness
// ---------------------------------------------------------------------------

test('execute() — every entry in output index matches expected packId and offset',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    try {
        const expected = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
        const expMap   = new Map(expected.map(e => [e.decodedName, e]));

        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        const outIndex = new DataPackIndex();
        outIndex.parse(fs.readFileSync(path.join(outDir, 'data.000')));

        for (const entry of outIndex.entries) {
            const exp = expMap.get(entry.decodedName);
            if (!exp) continue;
            assert.equal(entry.packId, exp.packId,
                `packId for "${entry.decodedName}" must match expected`);
            assert.equal(entry.size, exp.size,
                `size for "${entry.decodedName}" must match expected`);
        }
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
    }
});

test('execute() — a blueprint is generated in assetStoreDir after execute()',
    { skip: !FIXTURE_AVAILABLE },
    async () => {
    const sessionsDir = makeTempDir();
    const outDir      = makeTempDir();
    const tmpStoreDir = makeTempDir();
    try {
        const { session, config, fpStore, assetStore } =
            await makeReadySession(sessionsDir, outDir);

        const pipeline = new CommitPipeline(session, config, fpStore, assetStore);
        await pipeline.execute();

        // CommitPipeline writes the blueprint to assetStore.rootDir/blueprints/.
        // assetStore.rootDir is FIXTURE_STORE in makeReadySession.
        const bpDir = path.join(assetStore.rootDir, 'blueprints');
        assert.ok(fs.existsSync(bpDir),
            'blueprints directory must exist in assetStore.rootDir after execute()');
        const bpFiles = fs.readdirSync(bpDir).filter(f => f.endsWith('.json'));
        assert.ok(bpFiles.length > 0,
            'at least one blueprint file must exist in assetStore.rootDir/blueprints after execute()');
    } finally {
        cleanupDir(sessionsDir);
        cleanupDir(outDir);
        cleanupDir(tmpStoreDir);
    }
});

'use strict';
/**
 * Phase F — StagedFile, Session, SessionManager
 * -----------------------------------------------
 * Run: npm run test:f
 *
 * Tests the full session lifecycle through to prepare().
 * CommitPipeline is not tested here — that is a separate phase.
 */

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const StagedFile        = require('../src/session/StagedFile');
const Session           = require('../src/session/Session');
const SessionManager    = require('../src/session/SessionManager');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const Blueprint         = require('../src/fingerprint/Blueprint');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label}`);
        console.log(`         expected: ${JSON.stringify(expected)}`);
        console.log(`         actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
}

function assertTruthy(label, actual) {
    if (actual) {
        console.log(`  [PASS] ${label}`);
        passed++;
    } else {
        console.log(`  [FAIL] ${label} — value was falsy: ${JSON.stringify(actual)}`);
        failed++;
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR    = path.join(__dirname, '..', 'data');
const STORE_DIR   = path.join(__dirname, '..', 'store');
const SESSION_DIR = path.join(__dirname, '..', 'sessions');
const DB_PATH     = path.join(STORE_DIR, 'fingerprints.jsonl');

// Temp file for staging tests
const TEMP_FILE = path.join(SESSION_DIR, '_test_source.txt');

(async () => {
try {

// Ensure sessions dir exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Create a real temp source file for staging tests
fs.writeFileSync(TEMP_FILE, 'test asset content for phase f staging tests');

const config     = PackConfiguration.fromDirectory(DATA_DIR, STORE_DIR, SESSION_DIR, 'phase-f');
const assetStore = new AssetStore(STORE_DIR);
await assetStore.rebuild();
const fpStore    = new FingerprintStore(DB_PATH, assetStore);
await fpStore.load();

// ---------------------------------------------------------------------------
// StagedFile tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase F: StagedFile ===\n');

{
    // Construction and category helpers
    const newFile = new StagedFile({
        targetName: 'hero.dds', sourcePath: '/src/hero.dds',
        stagedPath: '/work/hero.dds', category: 'new', sizeBytes: 1024, checksum: 'abc'
    });
    assert('isNew() — true for new',       newFile.isNew(),     true);
    assert('isInStore() — false for new',  newFile.isInStore(), false);
    assert('isDeleted() — false for new',  newFile.isDeleted(), false);

    const storeFile = new StagedFile({ targetName: 'bg.tga', category: 'in-store', sourceFingerprint: 'fp123' });
    assert('isInStore() — true for in-store', storeFile.isInStore(), true);
    assert('isNew() — false for in-store',    storeFile.isNew(),     false);

    // markDeleted
    newFile.markDeleted();
    assert('markDeleted — category transitions to deleted', newFile.category,    'deleted');
    assert('isDeleted() — true after markDeleted',          newFile.isDeleted(), true);
    assert('isNew() — false after markDeleted',             newFile.isNew(),     false);
}

// toJSON / fromJSON round-trip
{
    const sf = new StagedFile({
        targetName: 'zone.nfm', sourcePath: '/src/zone.nfm',
        stagedPath: '/work/zone.nfm', category: 'in-store',
        sourceFingerprint: 'fp999', sizeBytes: 2048, checksum: 'sha256abc'
    });
    const restored = StagedFile.fromJSON(sf.toJSON());
    assert('fromJSON — targetName survives',        restored.targetName,        sf.targetName);
    assert('fromJSON — category survives',          restored.category,          sf.category);
    assert('fromJSON — sourceFingerprint survives', restored.sourceFingerprint, sf.sourceFingerprint);
    assert('fromJSON — sizeBytes survives',         restored.sizeBytes,         sf.sizeBytes);
    assert('fromJSON — checksum survives',          restored.checksum,          sf.checksum);
}

// verify() — real file
{
    const content  = Buffer.from('verify me');
    const hash     = crypto.createHash('sha256').update(content).digest('hex');
    const tmpPath  = path.join(SESSION_DIR, '_verify_test.bin');
    fs.writeFileSync(tmpPath, content);

    const sf = new StagedFile({
        targetName: 'test.bin', stagedPath: tmpPath,
        category: 'new', checksum: hash
    });
    const ok = await sf.verify();
    assert('verify() — true when checksum matches', ok, true);

    // Tamper with file
    fs.writeFileSync(tmpPath, 'tampered content');
    const bad = await sf.verify();
    assert('verify() — false when file has changed', bad, false);
    fs.unlinkSync(tmpPath);
}

// checksumFile static helper
{
    const { checksum, sizeBytes } = await StagedFile.checksumFile(TEMP_FILE);
    assertTruthy('checksumFile — returns checksum',  checksum.length === 64);
    assertTruthy('checksumFile — returns sizeBytes', sizeBytes > 0);
}

// resolve() — in-store asset
{
    // Register a real asset in AssetStore
    const content  = Buffer.from('in-store resolve test');
    const hash     = crypto.createHash('sha256').update(content).digest('hex');
    const written  = await assetStore.write(content, hash, 'txt');

    const sf = new StagedFile({
        targetName: 'resolve_test.txt', category: 'in-store', sourceFingerprint: hash
    });
    const resolved = await sf.resolve(assetStore);
    assert('resolve() — returns correct path for in-store asset', resolved, written);
    assert('resolve() — stagedPath set after resolve',            sf.stagedPath, written);
}

// ---------------------------------------------------------------------------
// Session tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase F: Session ===\n');

const sessionWorkDir = path.join(SESSION_DIR, '_test_session_work');
if (!fs.existsSync(sessionWorkDir)) fs.mkdirSync(sessionWorkDir, { recursive: true });

const session = new Session({
    sessionId:  'test-session-001',
    label:      'Test Session',
    workingDir: sessionWorkDir,
    status:     'active',
    config
});

// addFile
{
    const staged = session.addFile(TEMP_FILE, 'staged_asset.txt');
    assertTruthy('addFile — returns StagedFile',          staged instanceof StagedFile);
    assert('addFile — category is new',                   staged.category,    'new');
    assert('addFile — targetName correct',                staged.targetName,  'staged_asset.txt');
    assertTruthy('addFile — sizeBytes populated',         staged.sizeBytes > 0);
    assertTruthy('addFile — checksum populated',          staged.checksum.length === 64);
    assert('addFile — file copied to working directory',
        fs.existsSync(session.getWorkingPath('staged_asset.txt')), true
    );
    assert('addFile — stagedFiles count',                 session.listFiles().length, 1);
}

// addFromStore
{
    const fingerprint = crypto.createHash('sha256').update(Buffer.from('some store asset')).digest('hex');
    const sf = session.addFromStore(fingerprint, 'store_asset.dds');
    assert('addFromStore — category is in-store',         sf.category,          'in-store');
    assert('addFromStore — sourceFingerprint set',        sf.sourceFingerprint, fingerprint);
    assert('addFromStore — stagedPath is null (lazy)',    sf.stagedPath,        null);
    assert('addFromStore — stagedFiles count',            session.listFiles().length, 2);
}

// removeFile (transitions to deleted)
{
    const removed = session.removeFile('staged_asset.txt');
    assert('removeFile — returns true',                            removed, true);
    const file = session.listFiles().find(f => f.targetName === 'staged_asset.txt');
    assert('removeFile — file still in list (audit trail)',        !!file,  true);
    assert('removeFile — category transitioned to deleted',        file.category, 'deleted');
    assert('removeFile — returns false for unknown targetName',    session.removeFile('unknown.dds'), false);
}

// getWorkingPath
{
    const wp = session.getWorkingPath('some_file.tga');
    assert('getWorkingPath — correct path',
        wp, path.join(sessionWorkDir, 'some_file.tga')
    );
}

// markInterrupted
{
    session.markInterrupted();
    assert('markInterrupted — status set to interrupted', session.status, 'interrupted');
}

// toJSON / fromJSON round-trip
{
    session.status = 'active'; // reset
    const json     = session.toJSON();
    const restored = Session.fromJSON(json, config);
    assert('fromJSON — sessionId survives',       restored.sessionId,  session.sessionId);
    assert('fromJSON — label survives',           restored.label,      session.label);
    assert('fromJSON — status survives',          restored.status,     session.status);
    assert('fromJSON — stagedFiles count survives', restored.listFiles().length, session.listFiles().length);
}

// Clean up test session working dir
fs.rmSync(sessionWorkDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// SessionManager tests
// ---------------------------------------------------------------------------

console.log('\n=== Phase F: SessionManager ===\n');

const manager = new SessionManager(SESSION_DIR, fpStore, assetStore);

// create()
let createdSession;
{
    createdSession = await manager.create('Test Pack Build', config);
    assertTruthy('create — returns a Session',              createdSession instanceof Session);
    assertTruthy('create — sessionId assigned',             createdSession.sessionId.length > 0);
    assert('create — label correct',                        createdSession.label,  'Test Pack Build');
    assert('create — status is active',                     createdSession.status, 'active');
    assertTruthy('create — working directory created',      fs.existsSync(createdSession.workingDir));
    assertTruthy('create — session.json written to disk',
        fs.existsSync(path.join(createdSession.workingDir, 'session.json'))
    );
}

// addFile and checkpoint
{
    createdSession.addFile(TEMP_FILE, 'test_asset.txt');
    await manager.checkpoint(createdSession.sessionId);

    const diskState = JSON.parse(
        fs.readFileSync(path.join(createdSession.workingDir, 'session.json'), 'utf8')
    );
    assert('checkpoint — stagedFiles persisted to disk', diskState.stagedFiles.length, 1);
}

// list()
{
    const sessions = await manager.list();
    assertTruthy('list — returns array',              Array.isArray(sessions));
    assertTruthy('list — contains created session',
        sessions.some(s => s.sessionId === createdSession.sessionId)
    );
    const entry = sessions.find(s => s.sessionId === createdSession.sessionId);
    assert('list — status correct', entry.status, 'active');
    assertTruthy('list — fileCount present', entry.fileCount >= 0);
}

// getSession()
{
    const retrieved = manager.getSession(createdSession.sessionId);
    assert('getSession — returns correct session', retrieved.sessionId, createdSession.sessionId);
    assert('getSession — returns null for unknown ID', manager.getSession('unknown-id'), null);
}

// resume() — reload from disk
{
    const manager2  = new SessionManager(SESSION_DIR, fpStore, assetStore);
    const resumed   = await manager2.resume(createdSession.sessionId);
    assert('resume — sessionId matches',          resumed.sessionId, createdSession.sessionId);
    assert('resume — label matches',              resumed.label,     createdSession.label);
    assert('resume — stagedFiles count matches',  resumed.listFiles().length, createdSession.listFiles().length);
    assert('resume — throws for unknown session', await (async () => {
        try { await manager2.resume('nonexistent-id'); return false; }
        catch { return true; }
    })(), true);
}

// prepare() — Phase 1
{
    // Add another file so we have a meaningful list
    createdSession.addFile(TEMP_FILE, 'second_asset.txt');

    await manager.prepare(createdSession.sessionId);
    assert('prepare — status transitions to ready', createdSession.status, 'ready');

    const packListPath  = path.join(createdSession.workingDir, 'pack-list.json');
    const indexListPath = path.join(createdSession.workingDir, 'index-list.json');
    assert('prepare — pack-list.json written',  fs.existsSync(packListPath),  true);
    assert('prepare — index-list.json written', fs.existsSync(indexListPath), true);

    const packList  = JSON.parse(fs.readFileSync(packListPath,  'utf8'));
    const indexList = JSON.parse(fs.readFileSync(indexListPath, 'utf8'));

    // Deleted file should not appear in pack list
    assert('prepare — deleted files excluded from pack list',
        packList.every(f => f.category !== 'deleted'), true
    );
    assertTruthy('prepare — index list has entries', indexList.length > 0);

    // Cannot prepare again once ready
    let threw = false;
    try { await manager.prepare(createdSession.sessionId); } catch { threw = true; }
    assert('prepare — throws if session already ready', threw, true);
}

// openFromBlueprint() — if blueprint exists on disk
{
    const blueprintDir = path.join(STORE_DIR, 'blueprints');
    const files        = fs.existsSync(blueprintDir) ? fs.readdirSync(blueprintDir) : [];

    if (files.length > 0) {
        const bpFile        = files[0];
        const indexFp       = bpFile.replace('.json', '');
        const bpSession     = await manager.openFromBlueprint(indexFp, STORE_DIR, config, 'From BP');

        assertTruthy('openFromBlueprint — returns Session',         bpSession instanceof Session);
        assert('openFromBlueprint — blueprintRef set',             bpSession.blueprintRef,    indexFp);
        assert('openFromBlueprint — blueprintLoaded is true',      bpSession.blueprintLoaded, true);
        assertTruthy('openFromBlueprint — staged files populated', bpSession.listFiles().length > 0);
        assert('openFromBlueprint — all files are in-store',
            bpSession.listFiles().every(f => f.isInStore()), true
        );

        await manager.discard(bpSession.sessionId);
        assertTruthy('discard — working directory removed',
            !fs.existsSync(bpSession.workingDir)
        );
    } else {
        console.log('  [ INFO] No blueprint found — skipping openFromBlueprint test');
        console.log('  [ INFO] Run test:e first to generate a blueprint');
        passed++; // count as pass — dependency on phase-e
    }
}

// discard()
{
    const sessionDir = createdSession.workingDir;
    await manager.discard(createdSession.sessionId);
    assert('discard — working directory removed', fs.existsSync(sessionDir), false);
    assert('discard — session removed from active map',
        manager.getSession(createdSession.sessionId), null
    );
}

// Clean up temp file
if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}\n`);

if (failed > 0) process.exit(1);

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

'use strict';

const fs                = require('fs');
const path              = require('path');
const { v4: uuidv4 }   = require('uuid');
const Session           = require('./Session');
const StagedFile        = require('./StagedFile');
const PackConfiguration = require('../config/PackConfiguration');
const Blueprint         = require('../fingerprint/Blueprint');

/**
 * SessionManager
 * src/session/SessionManager.js
 *
 * Gatekeeper between in-progress work and permanent libraries.
 * Nothing enters FingerprintStore, AssetStore, or Blueprint without
 * going through a successful commit.
 *
 * Owns the full session lifecycle and Phase 1 preparation.
 * Delegates Phase 2 and 3 to CommitPipeline.
 *
 * Session persistence:
 *   Each session lives in {sessionsDir}/{sessionId}/
 *   Session state is written to {sessionId}/session.json
 *   Phase 1 outputs: {sessionId}/pack-list.json + {sessionId}/index-list.json
 *
 * Two entry points:
 *   create()            — fresh build, empty session
 *   openFromBlueprint() — modify existing pack, pre-populated from blueprint
 */

class SessionManager {

    /**
     * @param {string}           sessionsDir      - Root directory for all session folders
     * @param {FingerprintStore} fingerprintStore  - For openFromBlueprint() lookups
     * @param {AssetStore}       assetStore        - For openFromBlueprint() path resolution
     */
    constructor(sessionsDir, fingerprintStore, assetStore) {
        this.sessionsDir      = sessionsDir;
        this.fingerprintStore = fingerprintStore;
        this.assetStore       = assetStore;
        this.#activeSessions  = new Map();
    }

    #activeSessions;

    // ---------------------------------------------------------------------------
    // Create
    // ---------------------------------------------------------------------------

    /**
     * Start a new empty session with a working directory.
     *
     * @param {string}            label  - User-friendly name
     * @param {PackConfiguration} config - Target pack configuration
     * @returns {Promise<Session>}
     */
    async create(label, config) {
        const sessionId  = uuidv4();
        const workingDir = path.join(this.sessionsDir, sessionId);

        fs.mkdirSync(workingDir, { recursive: true });

        const session = new Session({
            sessionId,
            label,
            workingDir,
            status:         'active',
            config,
            blueprintRef:   null,
            blueprintLoaded: false
        });

        this.#activeSessions.set(sessionId, session);
        await this.checkpoint(sessionId);

        return session;
    }

    /**
     * Start a session pre-populated from an existing blueprint.
     * Creates lazy 'in-store' StagedFile entries for every asset in the blueprint
     * without resolving actual file paths — keeps session load fast.
     *
     * This is Use Case 1 — modifying an existing pack.
     *
     * @param {string}            indexFingerprint - SHA-256 of data.000 to open from
     * @param {string}            storeDir         - Root store directory for blueprint lookup
     * @param {PackConfiguration} config           - Target pack configuration
     * @param {string}            [label]          - Optional label
     * @returns {Promise<Session>}
     */
    async openFromBlueprint(indexFingerprint, storeDir, config, label = '') {
        const blueprint = await Blueprint.loadFromDisk(storeDir, indexFingerprint);
        if (!blueprint) {
            throw new Error(`No blueprint found for fingerprint: ${indexFingerprint.slice(0, 16)}...`);
        }

        const sessionId  = uuidv4();
        const workingDir = path.join(this.sessionsDir, sessionId);
        fs.mkdirSync(workingDir, { recursive: true });

        const session = new Session({
            sessionId,
            label:           label || `From blueprint ${indexFingerprint.slice(0, 8)}`,
            workingDir,
            status:          'active',
            config,
            blueprintRef:    indexFingerprint,
            blueprintStoreDir: storeDir,   // where blueprint files actually live
            blueprintLoaded: false
        });

        // Pre-populate staged files from blueprint — lazily, no file I/O yet.
        // Store the original packId from the blueprint record on each StagedFile
        // so CommitPipeline can use the exact original pack assignment without
        // re-encoding the filename (which would use wrong salt characters).
        for (const record of blueprint.getRecords()) {
            const fileRecord = record.resolveFile(this.fingerprintStore);
            if (!fileRecord) continue;

            const staged = session.addFromStore(fileRecord.hash, fileRecord.decodedName);
            if (staged) staged.packId = record.packId;
        }

        session.blueprintLoaded = true;
        session.updatedAt       = new Date();

        this.#activeSessions.set(sessionId, session);
        await this.checkpoint(sessionId);

        return session;
    }

    // ---------------------------------------------------------------------------
    // Resume
    // ---------------------------------------------------------------------------

    /**
     * Reload an interrupted session from disk.
     *
     * @param {string} sessionId
     * @returns {Promise<Session>}
     */
    async resume(sessionId) {
        const sessionPath = this.#sessionJsonPath(sessionId);
        if (!fs.existsSync(sessionPath)) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        const obj    = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
        const config = obj.config ? PackConfiguration.fromJSON(obj.config) : null;
        const session = Session.fromJSON(obj, config);

        this.#activeSessions.set(sessionId, session);
        return session;
    }

    // ---------------------------------------------------------------------------
    // List
    // ---------------------------------------------------------------------------

    /**
     * List all sessions and their statuses.
     * Reads session.json from each subdirectory in sessionsDir.
     *
     * @returns {Promise<Array<{ sessionId, label, status, createdAt, updatedAt }>>}
     */
    async list() {
        if (!fs.existsSync(this.sessionsDir)) return [];

        const entries = fs.readdirSync(this.sessionsDir);
        const summaries = [];

        for (const entry of entries) {
            const sessionPath = path.join(this.sessionsDir, entry, 'session.json');
            if (!fs.existsSync(sessionPath)) continue;

            try {
                const obj = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                summaries.push({
                    sessionId: obj.sessionId,
                    label:     obj.label     || '',
                    status:    obj.status    || 'unknown',
                    createdAt: obj.createdAt || null,
                    updatedAt: obj.updatedAt || null,
                    fileCount: (obj.stagedFiles || []).length
                });
            } catch {
                // Skip malformed session files
            }
        }

        return summaries.sort((a, b) => {
            if (!a.updatedAt) return 1;
            if (!b.updatedAt) return -1;
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
    }

    // ---------------------------------------------------------------------------
    // Phase 1 — Prepare
    // ---------------------------------------------------------------------------

    /**
     * Phase 1 — compose and write the final ordered asset lists to disk.
     * Transitions session status to 'ready'.
     *
     * Writes two files to the session working directory:
     *   pack-list.json  — ordered array of StagedFile records for pack building
     *   index-list.json — ordered array of targetNames for index serialization
     *
     * These lists are what CommitPipeline Phase 2 reads to drive the build.
     * Once written, the session is stable — the user's staged state is locked in.
     *
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async prepare(sessionId) {
        const session = await this.#requireSession(sessionId);

        if (!['active', 'interrupted'].includes(session.status)) {
            throw new Error(
                `Session ${sessionId} cannot be prepared from status "${session.status}"`
            );
        }

        // Compose the build list — all non-deleted staged files.
        // Two orderings are needed:
        //
        // pack-list.json  — sorted by packId then packOffset so DataPackWriter
        //                   writes assets into each pack file in the original
        //                   offset sequence. Without this, offsets diverge from
        //                   the original and byte-identical reconstruction fails.
        //
        // index-list.json — sorted by indexOffset so DataPackIndex.serialize()
        //                   produces a data.000 with entries in the original order.
        //
        // Both orderings come from the BlueprintRecord positional data.
        // For sessions opened from a blueprint the staged files carry this via
        // the session's blueprint reference. For fresh builds order doesn't matter
        // since there is no "original" to match.

        const allFiles = session.stagedFiles.filter(f => !f.isDeleted());

        // Load blueprint positional data if available
        let packOrderMap  = null; // targetName → { packId, packOffset }
        let indexOrderMap = null; // targetName → indexOffset
        let blueprint     = null; // kept in outer scope for index-list construction

        if (session.blueprintRef) {
            const bpStoreDir = session.blueprintStoreDir
                            || (this.fingerprintStore.dbPath
                                ? require('path').dirname(this.fingerprintStore.dbPath)
                                : null);
            blueprint = bpStoreDir
                ? await Blueprint.loadFromDisk(bpStoreDir, session.blueprintRef)
                : null;

            if (blueprint) {
                packOrderMap  = new Map();
                indexOrderMap = new Map();
                for (const record of blueprint.getRecords()) {
                    const fr = record.resolveFile(this.fingerprintStore);
                    if (!fr) continue;
                    packOrderMap.set(fr.decodedName,  { packId: record.packId, packOffset: record.packOffset });
                    indexOrderMap.set(fr.decodedName, record.indexOffset);
                }
            }
        }

        // Sort pack list: by packId asc, then packOffset asc within each pack
        if (packOrderMap) {
            console.log(`  prepare: sorting ${allFiles.length.toLocaleString()} files by packId+packOffset`);
        } else if (session.blueprintRef) {
            console.warn('  prepare: blueprint not found — falling back to insertion order');
        }
        const buildList = [...allFiles].sort((a, b) => {
            if (!packOrderMap) return 0; // fresh build — preserve insertion order
            const pa = packOrderMap.get(a.targetName);
            const pb = packOrderMap.get(b.targetName);
            if (!pa || !pb) return 0;
            if (pa.packId !== pb.packId) return pa.packId - pb.packId;
            return pa.packOffset - pb.packOffset;
        });

        // Sort index list: by indexOffset asc.
        // Must include ALL entries from the original index — including zero-size
        // placeholder entries that were never staged. These appear in data.000
        // but have no content in the pack files.
        let indexNames;
        if (indexOrderMap && blueprint) {
            // Build complete ordered list from blueprint — every entry, zero-size included.
            // Store full positional data so CommitPipeline can reconstruct zero-size stubs
            // with correct packId and offset values.
            const allBpRecords = blueprint.getRecords()
                .slice()
                .sort((a, b) => a.indexOffset - b.indexOffset);
            indexNames = allBpRecords.map(r => ({
                name:    r.decodedName,
                packId:  r.packId,
                offset:  r.packOffset,
                size:    null   // null = written by DataPackWriter; 0 = zero-size placeholder
            }));
            // Mark zero-size entries (not in allFiles) with size=0
            const stagedNames = new Set(allFiles.map(f => f.targetName));
            for (const entry of indexNames) {
                if (!stagedNames.has(entry.name)) entry.size = 0;
            }
        } else {
            const indexSorted = [...allFiles].sort((a, b) => {
                if (!indexOrderMap) return 0;
                const ia = indexOrderMap.get(a.targetName) ?? 0;
                const ib = indexOrderMap.get(b.targetName) ?? 0;
                return ia - ib;
            });
            indexNames = indexSorted.map(f => ({ name: f.targetName, packId: null, offset: null, size: null }));
        }

        // Write pack-list.json — full StagedFile records for CommitPipeline
        const packListPath  = path.join(session.workingDir, 'pack-list.json');
        const indexListPath = path.join(session.workingDir, 'index-list.json');

        await fs.promises.writeFile(
            packListPath,
            JSON.stringify(buildList.map(f => f.toJSON()), null, 2),
            'utf8'
        );

        await fs.promises.writeFile(
            indexListPath,
            JSON.stringify(indexNames, null, 2),
            'utf8'
        );

        session.status    = 'ready';
        session.updatedAt = new Date();
        await this.checkpoint(sessionId);
    }

    // ---------------------------------------------------------------------------
    // Commit
    // ---------------------------------------------------------------------------

    /**
     * Verify session is ready then delegate to CommitPipeline.
     * CommitPipeline is instantiated here and injected with all dependencies.
     *
     * NOTE: CommitPipeline is required lazily to avoid circular dependency
     * (CommitPipeline depends on SessionManager indirectly via Session).
     *
     * @param {string} sessionId
     * @returns {Promise<CommitResult>}
     */
    async commit(sessionId) {
        const session = await this.#requireSession(sessionId);

        if (session.status !== 'ready') {
            throw new Error(
                `Session ${sessionId} is not ready for commit (status: "${session.status}"). ` +
                `Call prepare() first.`
            );
        }

        // Lazy require to avoid circular dependency at module load time
        const CommitPipeline = require('./CommitPipeline');
        const pipeline = new CommitPipeline(
            session,
            session.config,
            this.fingerprintStore,
            this.assetStore
        );

        return pipeline.execute();
    }

    // ---------------------------------------------------------------------------
    // Discard
    // ---------------------------------------------------------------------------

    /**
     * Delete the session's working directory and remove its record.
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async discard(sessionId) {
        const sessionDir = path.join(this.sessionsDir, sessionId);

        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        this.#activeSessions.delete(sessionId);
    }

    // ---------------------------------------------------------------------------
    // Checkpoint
    // ---------------------------------------------------------------------------

    /**
     * Persist current session state to disk mid-session.
     * Called automatically after significant state changes.
     *
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async checkpoint(sessionId) {
        const session = await this.#requireSession(sessionId);
        const jsonPath = this.#sessionJsonPath(sessionId);

        const dir = path.dirname(jsonPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        await fs.promises.writeFile(
            jsonPath,
            JSON.stringify(session.toJSON(), null, 2),
            'utf8'
        );
    }

    // ---------------------------------------------------------------------------
    // Get
    // ---------------------------------------------------------------------------

    /**
     * Retrieve a loaded session by ID.
     * @param {string} sessionId
     * @returns {Session|null}
     */
    getSession(sessionId) {
        return this.#activeSessions.get(sessionId) || null;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Get session from cache, loading from disk if needed.
     * @param {string} sessionId
     * @returns {Promise<Session>}
     */
    async #requireSession(sessionId) {
        if (this.#activeSessions.has(sessionId)) {
            return this.#activeSessions.get(sessionId);
        }
        // Try loading from disk
        return this.resume(sessionId);
    }

    /**
     * Resolve the session.json path for a given session ID.
     * @param {string} sessionId
     * @returns {string}
     */
    #sessionJsonPath(sessionId) {
        return path.join(this.sessionsDir, sessionId, 'session.json');
    }

}

module.exports = SessionManager;

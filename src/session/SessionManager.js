'use strict';

const fs               = require('fs');
const path             = require('path');
const { v4: uuidv4 }   = require('uuid');
const Session          = require('./Session');
const StagedFile       = require('./StagedFile');
const LockError        = require('./LockError');
const PackConfiguration = require('../config/PackConfiguration');
const Blueprint        = require('../fingerprint/Blueprint');
const AssetStore       = require('../core/AssetStore');

/**
 * SessionManager
 * src/session/SessionManager.js
 *
 * Creates, tracks, persists, and resumes Session objects.
 * Owns Phase 1 (prepare) — composing the final ordered asset lists.
 * Delegates Phase 2+3 to CommitPipeline.
 *
 * prepare() writes two files to the session working directory:
 *
 *   pack-list.json   — StagedFile records for assets that have real bytes to write.
 *                      Zero-size sentinel-backed entries are EXCLUDED — DataPackWriter
 *                      has nothing to write for them.
 *
 *   index-list.json  — All entries in original indexOffset order, including zero-size
 *                      placeholders. Each entry: { name, packId, offset, size }.
 *                      size === 0 means no bytes were written; original packId/offset
 *                      are preserved so DataPackIndex.serialize() reconstructs the
 *                      byte-identical entry.
 */

class SessionManager {

    /**
     * @param {string}           sessionsDir
     * @param {FingerprintStore} fingerprintStore
     * @param {AssetStore}       assetStore
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
     * Create a new empty session.
     *
     * API contract: config is the FIRST argument, label is SECOND, userId is THIRD.
     * Never call as create(label, config) — that is a bug.
     *
     * @param {PackConfiguration} config
     * @param {string}            [label]
     * @param {string|null}       [userId]  - userId of the creating user (stored as ownerId)
     * @returns {Promise<Session>}
     */
    async create(config, label = '', userId = null) {
        const sessionId  = uuidv4();
        const workingDir = path.join(this.sessionsDir, sessionId);
        fs.mkdirSync(workingDir, { recursive: true });

        const session = new Session({
            sessionId,
            label:   label || `Session ${new Date().toISOString().slice(0, 10)}`,
            workingDir,
            status:  'active',
            config,
            ownerId: userId
        });

        this.#activeSessions.set(sessionId, session);
        await this.checkpoint(sessionId);
        return session;
    }

    // ---------------------------------------------------------------------------
    // Open from blueprint
    // ---------------------------------------------------------------------------

    /**
     * Open a session pre-populated from a blueprint.
     * Creates lazy 'in-store' StagedFile entries for every asset in the blueprint
     * without resolving actual file paths — keeps session load fast.
     *
     * This is Use Case 1 — modifying an existing pack.
     *
     * Zero-size entries in the blueprint are staged as in-store entries pointing
     * to the null-asset sentinel. They are tracked in the session for index
     * reconstruction but excluded from pack-list.json at prepare() time so
     * DataPackWriter never tries to write empty bytes.
     *
     * FIX: StagedFile.sourceFingerprint is set to record.fileFingerprint (the hash
     * stored in the blueprint) rather than fileRecord.hash (the getByName() result).
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
            label:             label || `From blueprint ${indexFingerprint.slice(0, 8)}`,
            workingDir,
            status:            'active',
            config,
            blueprintRef:      indexFingerprint,
            blueprintStoreDir: storeDir,
            blueprintLoaded:   false
        });

        // Pre-populate staged files from blueprint — lazily, no file I/O yet.
        for (const record of blueprint.getRecords()) {
            const fileRecord = record.resolveFile(this.fingerprintStore);
            if (!fileRecord) continue;

            const staged = session.addFromStore(record.fileFingerprint, fileRecord.decodedName);
            if (staged) {
                staged.packId     = record.packId;
                staged.packOffset = record.packOffset;
            }
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

    async list() {
        if (!fs.existsSync(this.sessionsDir)) return [];

        const entries   = fs.readdirSync(this.sessionsDir);
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
            } catch { /* skip malformed session files */ }
        }

        return summaries.sort((a, b) => {
            if (!a.updatedAt) return 1;
            if (!b.updatedAt) return -1;
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
    }

    // ---------------------------------------------------------------------------
    // File operations with lock enforcement (Phase 3)
    // ---------------------------------------------------------------------------

    /**
     * Add a file from the filesystem to a session, with lock checking.
     *
     * If a StagedFile already exists for targetName and is locked by a different
     * user, throws LockError. On success, sets lockedBy to userId and adds userId
     * to session.collaborators.
     *
     * @param {string}      sessionId
     * @param {string}      sourcePath  - Absolute path to the source file on disk
     * @param {string}      targetName  - Intended decoded filename in the final pack
     * @param {string|null} [userId]    - userId of the requesting user
     * @returns {Promise<StagedFile>}
     * @throws {LockError} if another user holds the lock on this targetName
     */
    async addFile(sessionId, sourcePath, targetName, userId = null) {
        const session = await this.#requireSession(sessionId);

        // Check for an existing lock held by a different user
        const existing = session._fileMap.get(targetName);
        if (existing && existing.isLocked() && existing.lockedBy !== userId) {
            throw new LockError(existing.lockedBy);
        }

        const staged = session.addFile(sourcePath, targetName);

        // Set lock and record collaborator
        if (userId) {
            staged.addedBy  = userId;
            staged.lockedBy = userId;
            if (!session.collaborators.includes(userId)) {
                session.collaborators.push(userId);
            }
        }

        session.updatedAt = new Date();
        await this.checkpoint(sessionId);
        return staged;
    }

    /**
     * Mark a staged file as deleted, with lock checking.
     *
     * If the file is locked by a different user, throws LockError.
     *
     * @param {string}      sessionId
     * @param {string}      targetName
     * @param {string|null} [userId]   - userId of the requesting user
     * @returns {Promise<boolean>} true if found and marked deleted
     * @throws {LockError} if another user holds the lock on this targetName
     */
    async removeFile(sessionId, targetName, userId = null) {
        const session = await this.#requireSession(sessionId);

        const file = session._fileMap.get(targetName);
        if (file && file.isLocked() && file.lockedBy !== userId) {
            throw new LockError(file.lockedBy);
        }

        const removed = session.removeFile(targetName);
        if (removed) {
            await this.checkpoint(sessionId);
        }
        return removed;
    }

    // ---------------------------------------------------------------------------
    // Phase 1 — Prepare
    // ---------------------------------------------------------------------------

    /**
     * Phase 1 — compose and write the final ordered asset lists to disk.
     * Transitions session status to 'ready'.
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

        const allFiles = session.stagedFiles.filter(f => !f.isDeleted());

        // Load blueprint positional data if available
        let packOrderMap  = null; // targetName → { packId, packOffset }
        let indexOrderMap = null; // targetName → indexOffset
        let blueprint     = null;

        if (session.blueprintRef) {
            const bpStoreDir = session.blueprintStoreDir
                            || (this.fingerprintStore.dbPath
                                ? path.dirname(this.fingerprintStore.dbPath)
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
            } else if (session.blueprintRef) {
                console.warn('  prepare: blueprint not found — falling back to insertion order');
            }
        }

        // -----------------------------------------------------------------
        // pack-list.json
        // Excludes zero-size sentinel entries — DataPackWriter has no bytes
        // to write for them. Identified by sourceFingerprint === NULL_ASSET_HASH.
        // -----------------------------------------------------------------
        const nullHash = AssetStore.NULL_ASSET_HASH;

        const buildList = allFiles
            .filter(f => f.sourceFingerprint !== nullHash)
            .sort((a, b) => {
                if (!packOrderMap) return 0;
                const pa = packOrderMap.get(a.targetName);
                const pb = packOrderMap.get(b.targetName);
                if (!pa || !pb) return 0;
                if (pa.packId !== pb.packId) return pa.packId - pb.packId;
                return pa.packOffset - pb.packOffset;
            });

        if (packOrderMap) {
            console.log(`  prepare: ${buildList.length.toLocaleString()} pack entries (${allFiles.length - buildList.length} zero-size excluded)`);
        }

        // -----------------------------------------------------------------
        // index-list.json
        // ALL entries in original indexOffset order, zero-size included.
        // -----------------------------------------------------------------
        let indexNames;

        if (indexOrderMap && blueprint) {
            const allBpRecords = blueprint.getRecords()
                .slice()
                .sort((a, b) => a.indexOffset - b.indexOffset);

            const buildSet = new Set(buildList.map(f => f.targetName));

            indexNames = allBpRecords.map(r => {
                const isZero = !buildSet.has(r.decodedName);
                return {
                    name:   r.decodedName,
                    packId: r.packId,
                    offset: r.packOffset,
                    size:   isZero ? 0 : null
                };
            });
        } else {
            const indexSorted = [...allFiles].sort((a, b) => {
                if (!indexOrderMap) return 0;
                const ia = indexOrderMap.get(a.targetName) ?? 0;
                const ib = indexOrderMap.get(b.targetName) ?? 0;
                return ia - ib;
            });
            indexNames = indexSorted.map(f => ({
                name:   f.targetName,
                packId: f.packId || null,
                offset: null,
                size:   null
            }));
        }

        // -----------------------------------------------------------------
        // Write both lists
        // -----------------------------------------------------------------
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

    async commit(sessionId) {
        const session = await this.#requireSession(sessionId);

        if (session.status !== 'ready') {
            throw new Error(
                `Session ${sessionId} is not ready for commit (status: "${session.status}"). ` +
                `Call prepare() first.`
            );
        }

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

    async discard(sessionId) {
        const session = this.#activeSessions.get(sessionId)
                     || await this.resume(sessionId).catch(() => null);

        if (session && fs.existsSync(session.workingDir)) {
            fs.rmSync(session.workingDir, { recursive: true });
        }

        this.#activeSessions.delete(sessionId);
    }

    // ---------------------------------------------------------------------------
    // Checkpoint
    // ---------------------------------------------------------------------------

    async checkpoint(sessionId) {
        const session = this.#activeSessions.get(sessionId);
        if (!session) return;

        const sessionPath = this.#sessionJsonPath(sessionId);
        const dir         = path.dirname(sessionPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        await fs.promises.writeFile(
            sessionPath,
            JSON.stringify(session.toJSON(), null, 2),
            'utf8'
        );
    }

    // ---------------------------------------------------------------------------
    // Query
    // ---------------------------------------------------------------------------

    getSession(sessionId) {
        return this.#activeSessions.get(sessionId) || null;
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    #sessionJsonPath(sessionId) {
        return path.join(this.sessionsDir, sessionId, 'session.json');
    }

    async #requireSession(sessionId) {
        let session = this.#activeSessions.get(sessionId);
        if (!session) {
            session = await this.resume(sessionId).catch(() => null);
        }
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        return session;
    }

}

module.exports = SessionManager;

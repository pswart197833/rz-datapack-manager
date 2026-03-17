'use strict';

const express           = require('express');
const cors              = require('cors');
const path              = require('path');
const fs                = require('fs');
const IndexManager      = require('./IndexManager');
const SessionManager    = require('../session/SessionManager');
const PackConfiguration = require('../config/PackConfiguration');
const AssetStore        = require('../core/AssetStore');
const FingerprintStore  = require('../fingerprint/FingerprintStore');
const Blueprint         = require('../fingerprint/Blueprint');

/**
 * APIServer
 * src/api/APIServer.js
 *
 * Express HTTP server exposing all DataPack Manager operations to the frontend.
 *
 * Extraction jobs are tracked in-memory so the UI can poll for progress.
 * Config is persisted to {storeDir}/config.json across restarts.
 */

class APIServer {

    constructor({ port = 3000, storeDir, sessionsDir } = {}) {
        this.port        = port;
        this.storeDir    = storeDir;
        this.sessionsDir = sessionsDir;
        this.configPath  = path.join(storeDir, 'config.json');

        this.app            = express();
        this.indexManager   = null;
        this.sessionManager = null;
        this.config         = null;

        // In-memory job tracker: jobId → { status, done, total, extracted, skipped, errors, currentFile, startedAt, finishedAt }
        this.#jobs = new Map();

        this.#setupMiddleware();
        this.#setupRoutes();
    }

    #jobs;

    // ---------------------------------------------------------------------------
    // Startup
    // ---------------------------------------------------------------------------

    async start() {
        await this.#loadConfig();
        return new Promise((resolve) => {
            this.app.listen(this.port, () => {
                console.log(`DataPack Manager API running at http://localhost:${this.port}`);
                resolve();
            });
        });
    }

    // ---------------------------------------------------------------------------
    // Middleware
    // ---------------------------------------------------------------------------

    #setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());

        const uiDir = path.join(__dirname, '..', 'ui');
        if (fs.existsSync(uiDir)) {
            this.app.use(express.static(uiDir));
        }

        this.app.use((req, _res, next) => {
            if (!req.path.startsWith('/api/entries')) {
                console.log(`${req.method} ${req.path}`);
            }
            next();
        });
    }

    // ---------------------------------------------------------------------------
    // Routes
    // ---------------------------------------------------------------------------

    #setupRoutes() {
        const r = express.Router();

        r.get('/config',   this.#wrap(this.#getConfig.bind(this)));
        r.post('/config',  this.#wrap(this.#setConfig.bind(this)));

        r.get('/entries',    this.#wrap(this.#getEntries.bind(this)));
        r.get('/export/csv', this.#wrap(this.#exportCsv.bind(this)));

        r.post('/extract',         this.#wrap(this.#extract.bind(this)));
        r.get('/extract/status',   this.#wrap(this.#extractStatus.bind(this)));

        r.get('/blueprint/:indexFingerprint', this.#wrap(this.#getBlueprint.bind(this)));
        r.get('/blueprints',                  this.#wrap(this.#listBlueprints.bind(this)));

        // Sessions — specific routes before :id param
        r.post('/sessions/from-blueprint',    this.#wrap(this.#sessionFromBlueprint.bind(this)));
        r.get('/sessions',                    this.#wrap(this.#listSessions.bind(this)));
        r.post('/sessions',                   this.#wrap(this.#createSession.bind(this)));
        r.get('/sessions/:id',                this.#wrap(this.#getSession.bind(this)));
        r.get('/sessions/:id/files',          this.#wrap(this.#listSessionFiles.bind(this)));
        r.post('/sessions/:id/files',         this.#wrap(this.#addSessionFile.bind(this)));
        r.delete('/sessions/:id/files/:name', this.#wrap(this.#removeSessionFile.bind(this)));
        r.post('/sessions/:id/prepare',       this.#wrap(this.#prepareSession.bind(this)));
        r.post('/sessions/:id/commit',        this.#wrap(this.#commitSession.bind(this)));
        r.post('/sessions/:id/discard',       this.#wrap(this.#discardSession.bind(this)));
        r.post('/sessions/:id/checkpoint',    this.#wrap(this.#checkpointSession.bind(this)));

        this.app.use('/api', r);

        this.app.get('/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));

        this.app.get('*', (_req, res) => {
            const indexPath = path.join(__dirname, '..', 'ui', 'index.html');
            if (fs.existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                res.status(404).json({ error: 'Frontend not found' });
            }
        });
    }

    // ---------------------------------------------------------------------------
    // Config handlers
    // ---------------------------------------------------------------------------

    async #getConfig(_req, res) {
        if (!this.config) return res.status(404).json({ error: 'No configuration set' });
        res.json(this.config.toJSON());
    }

    async #setConfig(req, res) {
        const { indexPath, packPaths, assetStoreDir, sessionsDir, label } = req.body;
        if (!indexPath) return res.status(400).json({ error: 'indexPath is required' });

        const config = new PackConfiguration({
            indexPath,
            packPaths:     packPaths
                ? new Map(Object.entries(packPaths).map(([k, v]) => [Number(k), v]))
                : new Map(),
            assetStoreDir: assetStoreDir || this.storeDir,
            sessionsDir:   sessionsDir   || this.sessionsDir,
            label:         label         || ''
        });

        const validation  = config.validate();
        const fatalErrors = validation.errors.filter(e => !e.includes('will be created'));
        if (fatalErrors.length > 0) {
            return res.status(400).json({ error: 'Invalid configuration', details: fatalErrors });
        }

        await this.#applyConfig(config);
        await this.#saveConfig();
        res.json(this.config.toJSON());
    }

    // ---------------------------------------------------------------------------
    // Entry handlers
    // ---------------------------------------------------------------------------

    async #getEntries(req, res) {
        if (!this.indexManager) return res.status(503).json({ error: 'Index not loaded — POST /api/config first' });
        await this.#ensureIndexLoaded();
        const result = this.indexManager.getEntries({
            search:   req.query.search,
            type:     req.query.type,
            packId:   req.query.packId,
            sortBy:   req.query.sortBy,
            sortDir:  req.query.sortDir,
            page:     Number(req.query.page)     || 1,
            pageSize: Number(req.query.pageSize) || 50
        });
        res.json(result);
    }

    async #exportCsv(req, res) {
        if (!this.indexManager) return res.status(503).json({ error: 'Index not loaded' });
        await this.#ensureIndexLoaded();
        const { entries } = this.indexManager.getEntries({
            search:   req.query.search,
            type:     req.query.type,
            pageSize: 999999
        });
        const header = 'decodedName,assetType,packId,offset,size';
        const rows   = entries.map(e =>
            `${e.decodedName},${e.assetType},${e.packId},${e.offset},${e.size}`
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="assets.csv"');
        res.send([header, ...rows].join('\n'));
    }

    // ---------------------------------------------------------------------------
    // Extract handlers
    // ---------------------------------------------------------------------------

    async #extract(req, res) {
        if (!this.indexManager) return res.status(503).json({ error: 'Index not loaded' });

        // Only one extraction at a time
        const running = Array.from(this.#jobs.values()).find(j => j.status === 'running');
        if (running) {
            return res.status(409).json({ error: 'Extraction already in progress', jobId: running.jobId });
        }

        const { types } = req.body;
        const jobId      = Date.now().toString();

        const job = {
            jobId,
            status:      'running',
            done:        0,
            total:       0,
            extracted:   0,
            skipped:     0,
            errors:      [],
            currentFile: '',
            startedAt:   new Date().toISOString(),
            finishedAt:  null
        };

        this.#jobs.set(jobId, job);
        res.json({ jobId, status: 'started' });

        // Run in background — UI polls /extract/status
        setImmediate(async () => {
            try {
                await this.#ensureIndexLoaded();
                const result = await this.indexManager.extractAll({
                    types,
                    onProgress: (done, total, currentFile) => {
                        job.done        = done;
                        job.total       = total;
                        job.currentFile = currentFile;
                    }
                });
                job.status     = 'complete';
                job.extracted  = result.extracted;
                job.skipped    = result.skipped;
                job.errors     = result.errors.slice(0, 20); // cap at 20
                job.done       = job.total;
                job.finishedAt = new Date().toISOString();
                console.log(`Extract complete: ${result.extracted} extracted, ${result.skipped} skipped, ${result.errors.length} errors`);
            } catch (err) {
                job.status     = 'error';
                job.errors     = [err.message];
                job.finishedAt = new Date().toISOString();
                console.error('Extract failed:', err.message);
            }
        });
    }

    async #extractStatus(_req, res) {
        // Return the most recent job, or idle if none
        const jobs = Array.from(this.#jobs.values());
        if (jobs.length === 0) {
            return res.json({ status: 'idle' });
        }
        // Most recent job
        const job = jobs[jobs.length - 1];
        const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
        res.json({ ...job, percent: pct });
    }

    // ---------------------------------------------------------------------------
    // Blueprint handlers
    // ---------------------------------------------------------------------------

    async #getBlueprint(req, res) {
        const bp = await Blueprint.loadFromDisk(this.storeDir, req.params.indexFingerprint);
        if (!bp) return res.status(404).json({ error: 'Blueprint not found' });
        res.json(bp.toJSON());
    }

    async #listBlueprints(_req, res) {
        const blueprintDir = path.join(this.storeDir, 'blueprints');
        if (!fs.existsSync(blueprintDir)) return res.json([]);
        const files = fs.readdirSync(blueprintDir).filter(f => f.endsWith('.json'));
        const blueprints = files.map(f => {
            const fp   = f.replace('.json', '');
            const stat = fs.statSync(path.join(blueprintDir, f));
            return { indexFingerprint: fp, savedAt: stat.mtime.toISOString() };
        });
        res.json(blueprints);
    }

    // ---------------------------------------------------------------------------
    // Session handlers
    // ---------------------------------------------------------------------------

    async #createSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const { label } = req.body;
        const session = await this.sessionManager.create(label || 'New Session', this.config);
        res.status(201).json(session.toJSON());
    }

    async #listSessions(_req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        res.json(await this.sessionManager.list());
    }

    async #getSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const session = this.sessionManager.getSession(req.params.id)
            || await this.sessionManager.resume(req.params.id).catch(() => null);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json(session.toJSON());
    }

    async #listSessionFiles(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const session = this.sessionManager.getSession(req.params.id)
            || await this.sessionManager.resume(req.params.id).catch(() => null);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        let files = session.listFiles();
        if (req.query.category) files = files.filter(f => f.category === req.query.category);
        res.json(files.map(f => f.toJSON()));
    }

    async #addSessionFile(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const session = this.sessionManager.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const { sourcePath, targetName } = req.body;
        if (!sourcePath || !targetName) {
            return res.status(400).json({ error: 'sourcePath and targetName are required' });
        }
        const staged = session.addFile(sourcePath, targetName);
        await this.sessionManager.checkpoint(req.params.id);
        res.status(201).json(staged.toJSON());
    }

    async #removeSessionFile(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const session = this.sessionManager.getSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const removed = session.removeFile(decodeURIComponent(req.params.name));
        if (removed) await this.sessionManager.checkpoint(req.params.id);
        res.json({ removed });
    }

    async #prepareSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        await this.sessionManager.prepare(req.params.id);
        res.json({ status: 'ready' });
    }

    async #commitSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const result = await this.sessionManager.commit(req.params.id);
        res.json(result);
    }

    async #discardSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        await this.sessionManager.discard(req.params.id);
        res.json({ discarded: true });
    }

    async #checkpointSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        await this.sessionManager.checkpoint(req.params.id);
        res.json({ checkpointed: true });
    }

    async #sessionFromBlueprint(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const { indexFingerprint, label } = req.body;
        if (!indexFingerprint) return res.status(400).json({ error: 'indexFingerprint is required' });
        const session = await this.sessionManager.openFromBlueprint(
            indexFingerprint, this.storeDir, this.config, label || ''
        );
        res.status(201).json(session.toJSON());
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    #wrap(fn) {
        return async (req, res, next) => {
            try {
                await fn(req, res, next);
            } catch (err) {
                console.error(`[API Error] ${req.method} ${req.path}:`, err.message);
                res.status(500).json({ error: err.message });
            }
        };
    }

    async #applyConfig(config) {
        this.config = config;
        [config.assetStoreDir, config.sessionsDir].forEach(dir => {
            if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });

        const assetStore = new AssetStore(config.assetStoreDir);
        await assetStore.rebuild();

        const dbPath  = path.join(config.assetStoreDir, 'fingerprints.jsonl');
        const fpStore = new FingerprintStore(dbPath, assetStore);
        await fpStore.load();

        this.indexManager   = new IndexManager(config, fpStore, assetStore);
        this.sessionManager = new SessionManager(config.sessionsDir, fpStore, assetStore);
    }

    async #ensureIndexLoaded() {
        if (!this.indexManager) throw new Error('IndexManager not initialised');
        await this.indexManager.loadIndex();
    }

    async #saveConfig() {
        if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
        await fs.promises.writeFile(
            this.configPath,
            JSON.stringify(this.config.toJSON(), null, 2),
            'utf8'
        );
    }

    async #loadConfig() {
        if (!fs.existsSync(this.configPath)) return;
        try {
            const obj    = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            const config = PackConfiguration.fromJSON(obj);
            await this.#applyConfig(config);
            console.log(`Config loaded: ${config.label || config.getIndexPath()}`);
        } catch (err) {
            console.warn(`Could not load saved config: ${err.message}`);
        }
    }
}

// Standalone entry point
if (require.main === module) {
    const storeDir    = path.join(__dirname, '..', '..', 'store');
    const sessionsDir = path.join(__dirname, '..', '..', 'sessions');
    const server = new APIServer({ port: 3000, storeDir, sessionsDir });
    server.start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
}

module.exports = APIServer;

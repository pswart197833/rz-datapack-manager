'use strict';

const express           = require('express');
const cors              = require('cors');
const path              = require('path');
const fs                = require('fs');
const crypto            = require('crypto');
const session           = require('express-session');
const IndexManager      = require('./IndexManager');
const SessionManager    = require('../session/SessionManager');
const PackConfiguration = require('../config/PackConfiguration');
const AssetStore        = require('../core/AssetStore');
const FingerprintStore  = require('../fingerprint/FingerprintStore');
const Blueprint         = require('../fingerprint/Blueprint');
const UserStore         = require('../auth/UserStore');
const AuthMiddleware    = require('../auth/AuthMiddleware');

/**
 * APIServer
 * src/api/APIServer.js
 *
 * Express HTTP server exposing all DataPack Manager operations to the frontend.
 *
 * Authentication: express-session cookie. All /api/* routes require auth
 * except /api/auth/login, /api/auth/logout, and /api/auth/me.
 * The /health endpoint is never protected.
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

        // Auth — initialised in start()
        this.userStore       = null;
        this.authMiddleware  = null;

        // Session secret — loaded from disk in start(). Null until then.
        // Persisted to {storeDir}/session-secret so sessions survive restarts.
        this.#sessionSecret    = null;
        this.#sessionMiddleware = null;

        // Underlying http.Server — stored so tests can call close()
        this.#httpServer = null;

        // In-memory job tracker: jobId → { status, done, total, extracted, skipped, errors, currentFile, startedAt, finishedAt }
        this.#jobs = new Map();

        this.#setupMiddleware();
        this.#setupRoutes();
    }

    #jobs;
    #sessionSecret;
    #sessionMiddleware;
    #httpServer;

    // ---------------------------------------------------------------------------
    // Startup
    // ---------------------------------------------------------------------------

    async start() {
        // Load or create the persisted session secret.
        if (!fs.existsSync(this.storeDir)) {
            fs.mkdirSync(this.storeDir, { recursive: true });
        }
        const secretPath = path.join(this.storeDir, 'session-secret');
        if (fs.existsSync(secretPath)) {
            this.#sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
        } else {
            this.#sessionSecret = crypto.randomBytes(32).toString('hex');
            fs.writeFileSync(secretPath, this.#sessionSecret, 'utf8');
        }

        this.#sessionMiddleware = session({
            secret:            this.#sessionSecret,
            resave:            false,
            saveUninitialized: false,
            cookie: {
                httpOnly: true,
                sameSite: 'lax'
            }
        });

        // Initialise UserStore before loading config so auth is always ready
        this.userStore      = new UserStore(this.storeDir);
        await this.userStore.load();
        this.authMiddleware = new AuthMiddleware(this.userStore);

        await this.#loadConfig();
        return new Promise((resolve) => {
            this.#httpServer = this.app.listen(this.port, () => {
                this.boundPort = this.#httpServer.address().port;
                console.log(`DataPack Manager API running at http://localhost:${this.boundPort}`);
                resolve();
            });
        });
    }

    /**
     * Close the underlying HTTP server.
     * @returns {Promise<void>}
     */
    close() {
        return new Promise((resolve) => {
            if (!this.#httpServer) return resolve();
            this.#httpServer.close(() => resolve());
        });
    }

    // ---------------------------------------------------------------------------
    // Middleware
    // ---------------------------------------------------------------------------

    #setupMiddleware() {
        this.app.use(cors({
            origin: true,
            credentials: true
        }));
        this.app.use(express.json());

        // Session middleware is inserted as a deferred wrapper.
        this.app.use((req, res, next) => {
            if (this.#sessionMiddleware) {
                this.#sessionMiddleware(req, res, next);
            } else {
                next();
            }
        });

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
        // ---- Health (no auth) ----
        this.app.get('/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));

        // ---- Auth routes (no requireAuth — these ARE the login flow) ----
        const authRouter = express.Router();
        authRouter.post('/login',  this.#wrap(this.#login.bind(this)));
        authRouter.post('/logout', this.#wrap(this.#logout.bind(this)));
        authRouter.get('/me',      this.#wrap(this.#me.bind(this)));
        this.app.use('/api/auth', authRouter);

        // ---- Protected API router ----
        const r = express.Router();

        // Apply requireAuth to all routes in this router
        r.use((req, res, next) => {
            if (!this.authMiddleware) {
                return res.status(503).json({ error: 'Server not initialised' });
            }
            this.authMiddleware.requireAuth()(req, res, next);
        });

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

        // Users (admin only)
        r.get('/users',        this.#adminWrap(this.#listUsers.bind(this)));
        r.post('/users',       this.#adminWrap(this.#createUser.bind(this)));
        r.delete('/users/:id', this.#adminWrap(this.#deleteUser.bind(this)));

        this.app.use('/api', r);

        // SPA catch-all (must be last)
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
    // Auth handlers
    // ---------------------------------------------------------------------------

    async #login(req, res) {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';

        if (!this.authMiddleware.checkRateLimit(ip)) {
            return res.status(429).json({ error: 'Too many attempts' });
        }

        const user = await this.userStore.verify(username, password);

        if (!user) {
            this.authMiddleware.recordFailedAttempt(ip);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        this.authMiddleware.resetRateLimit(ip);
        req.session.userId = user.userId;

        res.json({
            userId:   user.userId,
            username: user.username,
            isAdmin:  user.isAdmin
        });
    }

    async #logout(req, res) {
        req.session.destroy(() => {});
        res.json({ ok: true });
    }

    async #me(req, res) {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: 'Unauthorised' });
        }

        const user = this.userStore.findById(req.session.userId);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorised' });
        }

        res.json({
            userId:   user.userId,
            username: user.username,
            isAdmin:  user.isAdmin
        });
    }

    // ---------------------------------------------------------------------------
    // User management handlers (admin only)
    // ---------------------------------------------------------------------------

    async #listUsers(_req, res) {
        res.json(this.userStore.list());
    }

    async #createUser(req, res) {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        if (this.userStore.findByUsername(username)) {
            return res.status(409).json({ error: `Username already taken: ${username}` });
        }

        const user = await this.userStore.create(username, password);
        res.status(201).json(user);
    }

    async #deleteUser(req, res) {
        const targetId = req.params.id;

        if (req.user.userId === targetId) {
            return res.status(400).json({ error: 'Cannot remove your own account' });
        }

        if (!this.userStore.findById(targetId)) {
            return res.status(404).json({ error: 'User not found' });
        }

        try {
            await this.userStore.remove(targetId);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        res.json({ removed: true });
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
                job.errors     = result.errors.slice(0, 20);
                job.done       = job.total;
                job.finishedAt = new Date().toISOString();
            } catch (err) {
                job.status     = 'error';
                job.errors     = [err.message];
                job.finishedAt = new Date().toISOString();
            }
        });
    }

    async #extractStatus(_req, res) {
        const jobs = Array.from(this.#jobs.values());
        if (jobs.length === 0) return res.json({ status: 'idle' });
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
        // API contract: create(config, label, userId) — config FIRST, label SECOND, userId THIRD
        const session = await this.sessionManager.create(
            this.config,
            label || 'New Session',
            req.user.userId
        );
        res.status(201).json(session.toJSON());
    }

    async #listSessions(_req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        res.json(await this.sessionManager.list());
    }

    async #getSession(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const s = this.sessionManager.getSession(req.params.id)
            || await this.sessionManager.resume(req.params.id).catch(() => null);
        if (!s) return res.status(404).json({ error: 'Session not found' });
        res.json(s.toJSON());
    }

    async #listSessionFiles(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const s = this.sessionManager.getSession(req.params.id)
            || await this.sessionManager.resume(req.params.id).catch(() => null);
        if (!s) return res.status(404).json({ error: 'Session not found' });
        let files = s.listFiles();
        if (req.query.category) files = files.filter(f => f.category === req.query.category);
        res.json(files.map(f => f.toJSON()));
    }

    async #addSessionFile(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });
        const { sourcePath, targetName } = req.body;
        if (!sourcePath || !targetName) {
            return res.status(400).json({ error: 'sourcePath and targetName are required' });
        }

        try {
            // Route through SessionManager.addFile() so lock checking is enforced
            const staged = await this.sessionManager.addFile(
                req.params.id,
                sourcePath,
                targetName,
                req.user.userId
            );
            res.status(201).json(staged.toJSON());
        } catch (err) {
            if (err.name === 'LockError') {
                return res.status(423).json({
                    error:            'File is locked',
                    lockedBy:         err.lockedBy,
                    lockedByUsername: err.lockedByUsername
                });
            }
            if (err.message && err.message.includes('Session not found')) {
                return res.status(404).json({ error: 'Session not found' });
            }
            throw err; // re-throw for #wrap() to catch as 500
        }
    }

    async #removeSessionFile(req, res) {
        if (!this.sessionManager) return res.status(503).json({ error: 'Not initialised' });

        try {
            // Route through SessionManager.removeFile() so lock checking is enforced
            const removed = await this.sessionManager.removeFile(
                req.params.id,
                decodeURIComponent(req.params.name),
                req.user.userId
            );
            res.json({ removed });
        } catch (err) {
            if (err.name === 'LockError') {
                return res.status(423).json({
                    error:            'File is locked',
                    lockedBy:         err.lockedBy,
                    lockedByUsername: err.lockedByUsername
                });
            }
            if (err.message && err.message.includes('Session not found')) {
                return res.status(404).json({ error: 'Session not found' });
            }
            throw err; // re-throw for #wrap() to catch as 500
        }
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
        const s = await this.sessionManager.openFromBlueprint(
            indexFingerprint, this.storeDir, this.config, label || ''
        );
        res.status(201).json(s.toJSON());
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Wrap an async handler for standard error handling (returns 500 on throw).
     */
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

    /**
     * Wrap an async handler with admin-only protection.
     * Returns 403 if the authenticated user is not an admin.
     */
    #adminWrap(fn) {
        return async (req, res, next) => {
            if (!req.user || !req.user.isAdmin) {
                return res.status(403).json({ error: 'Forbidden' });
            }
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

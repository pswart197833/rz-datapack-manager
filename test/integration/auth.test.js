'use strict';
/**
 * test/integration/auth.test.js
 *
 * Tier 3 — integration tests for authentication endpoints.
 * Starts a real Express server on a free port per test.
 * Uses built-in node:http for requests — no supertest or fetch polyfills.
 *
 * Each test gets its own isolated server + store. cleanup() calls
 * server.close() so all handles are released and the process exits cleanly.
 *
 * Standalone runnable:
 *   node test/integration/auth.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const fs       = require('node:fs');
const os       = require('node:os');
const http     = require('node:http');

const APIServer = require(path.join(__dirname, '..', '..', 'src', 'api', 'APIServer'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
}

function cleanupDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Make an HTTP request against the test server.
 * @returns {Promise<{ status: number, body: any, headers: object }>}
 */
function req({ method, path: urlPath, body, cookie, port }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (cookie)  headers['Cookie']          = cookie;

        const options = { hostname: '127.0.0.1', port, path: urlPath, method, headers };

        const request = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

/**
 * Extract the Set-Cookie header as a Cookie string for subsequent requests.
 * Strips cookie attributes (Path, HttpOnly, SameSite, etc.).
 */
function extractCookie(headers) {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return null;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookies.map(c => c.split(';')[0]).join('; ');
}

/**
 * Start an APIServer on a free port (port:0).
 * Returns { port, cleanup } where cleanup() closes the server and removes
 * temp dirs, releasing all handles so the process can exit.
 */
async function startTestServer() {
    const sd  = makeTempDir();
    const ses = makeTempDir();

    const srv = new APIServer({ port: 0, storeDir: sd, sessionsDir: ses });
    await srv.start();

    // srv.boundPort is set by start() to the actual OS-assigned port
    const port = srv.boundPort;

    return {
        port,
        cleanup: async () => {
            await srv.close();
            cleanupDir(sd);
            cleanupDir(ses);
        }
    };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('POST /api/auth/login — correct credentials returns 200 and Set-Cookie', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        assert.equal(res.status, 200, 'correct credentials must return 200');
        assert.ok(res.headers['set-cookie'], 'successful login must set a session cookie');
        assert.equal(res.body.username, 'admin');
        assert.equal(res.body.isAdmin,  true);
        assert.ok(res.body.userId, 'userId must be in response');
    } finally { await cleanup(); }
});

test('POST /api/auth/login — wrong password returns 401', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'wrongpassword' }, port });
        assert.equal(res.status, 401);
    } finally { await cleanup(); }
});

test('POST /api/auth/login — unknown username returns 401', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'nobody', password: 'anything' }, port });
        assert.equal(res.status, 401);
    } finally { await cleanup(); }
});

test('POST /api/auth/login — missing username returns 400', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { password: 'admin' }, port });
        assert.equal(res.status, 400);
    } finally { await cleanup(); }
});

test('POST /api/auth/login — missing password returns 400', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin' }, port });
        assert.equal(res.status, 400);
    } finally { await cleanup(); }
});

test('POST /api/auth/login — missing body returns 400', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: {}, port });
        assert.equal(res.status, 400);
    } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// /me
// ---------------------------------------------------------------------------

test('GET /api/auth/me — valid cookie returns 200 and user object', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const loginRes = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        const cookie = extractCookie(loginRes.headers);
        assert.ok(cookie, 'login must set a cookie');

        const meRes = await req({ method: 'GET', path: '/api/auth/me', cookie, port });
        assert.equal(meRes.status, 200);
        assert.equal(meRes.body.username, 'admin');
        assert.equal(meRes.body.isAdmin,  true);
        assert.ok(meRes.body.userId);
    } finally { await cleanup(); }
});

test('GET /api/auth/me — without cookie returns 401', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'GET', path: '/api/auth/me', port });
        assert.equal(res.status, 401);
    } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test('POST /api/auth/logout — returns 200', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const loginRes = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        const cookie = extractCookie(loginRes.headers);

        const logoutRes = await req({ method: 'POST', path: '/api/auth/logout', cookie, port });
        assert.equal(logoutRes.status, 200);
        assert.equal(logoutRes.body.ok, true);
    } finally { await cleanup(); }
});

test('POST /api/auth/logout — subsequent GET /api/auth/me returns 401', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const loginRes = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        const cookie = extractCookie(loginRes.headers);

        await req({ method: 'POST', path: '/api/auth/logout', cookie, port });

        const meRes = await req({ method: 'GET', path: '/api/auth/me', cookie, port });
        assert.equal(meRes.status, 401,
            'after logout the old cookie must no longer authenticate');
    } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Auth middleware on existing routes
// ---------------------------------------------------------------------------

test('GET /api/sessions without cookie returns 401 (existing routes protected)', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'GET', path: '/api/sessions', port });
        assert.equal(res.status, 401, 'existing /api/* routes must require auth');
    } finally { await cleanup(); }
});

test('GET /api/config without cookie returns 401', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'GET', path: '/api/config', port });
        assert.equal(res.status, 401);
    } finally { await cleanup(); }
});

test('GET /health without cookie returns 200 (health is unprotected)', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const res = await req({ method: 'GET', path: '/health', port });
        assert.equal(res.status, 200, '/health must not require authentication');
    } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('Rate limit — 6th failed login within 60s returns 429', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        for (let i = 0; i < 5; i++) {
            await req({ method: 'POST', path: '/api/auth/login',
                body: { username: 'admin', password: 'wrong' }, port });
        }
        const res = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'wrong' }, port });
        assert.equal(res.status, 429,
            '6th failed login attempt must return 429 Too Many Requests');
    } finally { await cleanup(); }
});

test('Rate limit — successful login resets the counter', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        for (let i = 0; i < 4; i++) {
            await req({ method: 'POST', path: '/api/auth/login',
                body: { username: 'admin', password: 'wrong' }, port });
        }
        // Successful login resets counter
        const successRes = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        assert.equal(successRes.status, 200);

        // Should be able to fail again without immediately hitting rate limit
        const afterReset = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'wrong' }, port });
        assert.equal(afterReset.status, 401,
            'after successful login, failed attempts should be reset — not 429');
    } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Authenticated access to existing routes
// ---------------------------------------------------------------------------

test('GET /api/sessions with valid cookie returns non-401 (auth middleware passes)', async () => {
    const { port, cleanup } = await startTestServer();
    try {
        const loginRes = await req({ method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: 'admin' }, port });
        const cookie = extractCookie(loginRes.headers);

        const res = await req({ method: 'GET', path: '/api/sessions', cookie, port });
        // May be 503 (index not configured) or 200 — just must not be 401
        assert.notEqual(res.status, 401,
            'authenticated request to /api/sessions must not return 401');
    } finally { await cleanup(); }
});

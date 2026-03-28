'use strict';

/**
 * AuthMiddleware
 * src/auth/AuthMiddleware.js
 *
 * Express middleware for authentication and authorisation.
 *
 * requireAuth — checks req.session.userId. Attaches req.user on success.
 * requireAdmin — requires auth then checks isAdmin.
 *
 * Also provides a login rate limiter (in-memory, per IP, 5 failures / 60s).
 */

class AuthMiddleware {

    /**
     * @param {UserStore} userStore
     */
    constructor(userStore) {
        this.#userStore = userStore;

        // Map<ip, { count: number, windowStart: number }>
        this.#attempts = new Map();
    }

    #userStore;
    #attempts;

    // ---------------------------------------------------------------------------
    // Middleware factories
    // ---------------------------------------------------------------------------

    /**
     * Express middleware: require an authenticated session.
     * On success attaches the user object to req.user and calls next().
     * On failure responds 401.
     */
    requireAuth() {
        return async (req, res, next) => {
            if (!req.session || !req.session.userId) {
                return res.status(401).json({ error: 'Unauthorised' });
            }

            const user = this.#userStore.findById(req.session.userId);
            if (!user) {
                // Session refers to a deleted user — clear it
                req.session.destroy(() => {});
                return res.status(401).json({ error: 'Unauthorised' });
            }

            req.user = user;
            next();
        };
    }

    /**
     * Express middleware: require an authenticated admin session.
     * Runs requireAuth first; then checks isAdmin.
     */
    requireAdmin() {
        const authMiddleware = this.requireAuth();
        return async (req, res, next) => {
            await authMiddleware(req, res, () => {
                if (!req.user || !req.user.isAdmin) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                next();
            });
        };
    }

    // ---------------------------------------------------------------------------
    // Rate limiting
    // ---------------------------------------------------------------------------

    /**
     * Check rate limit for a given IP.
     * Returns true if the request is allowed, false if it should be blocked (429).
     *
     * @param {string} ip
     * @returns {boolean} true = allowed, false = rate limited
     */
    checkRateLimit(ip) {
        const now    = Date.now();
        const window = 60_000; // 60 seconds
        const limit  = 5;

        const entry = this.#attempts.get(ip);

        if (!entry || (now - entry.windowStart) >= window) {
            // Fresh window
            this.#attempts.set(ip, { count: 0, windowStart: now });
            return true;
        }

        return entry.count < limit;
    }

    /**
     * Record a failed login attempt for rate limiting purposes.
     * @param {string} ip
     */
    recordFailedAttempt(ip) {
        const now    = Date.now();
        const window = 60_000;

        const entry = this.#attempts.get(ip);

        if (!entry || (now - entry.windowStart) >= window) {
            this.#attempts.set(ip, { count: 1, windowStart: now });
        } else {
            entry.count++;
        }
    }

    /**
     * Reset rate limit for an IP (on successful login).
     * @param {string} ip
     */
    resetRateLimit(ip) {
        this.#attempts.delete(ip);
    }

}

module.exports = AuthMiddleware;

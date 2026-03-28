'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

/**
 * UserStore
 * src/auth/UserStore.js
 *
 * Loads and saves {storeDir}/users.json.
 * Passwords stored as bcrypt hashes (cost 10) — never plaintext.
 *
 * On first startup (file does not exist): bootstraps a default admin account
 * with username `admin`, password `admin`, and mustChangePassword: true.
 *
 * User object shape:
 * {
 *   userId:             string  — UUID
 *   username:           string  — unique display name
 *   passwordHash:       string  — bcrypt hash
 *   isAdmin:            boolean
 *   mustChangePassword: boolean — true for bootstrapped admin account
 *   createdAt:          string  — ISO 8601
 * }
 */

const BCRYPT_COST = 10;

class UserStore {

    /**
     * @param {string} storeDir - Root store directory (users.json lives here)
     */
    constructor(storeDir) {
        this.storeDir  = storeDir;
        this.#usersPath = path.join(storeDir, 'users.json');
        this.#users    = [];
    }

    #usersPath;
    #users;

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    /**
     * Load users.json from disk. If the file does not exist, bootstrap the
     * default admin account and save immediately.
     *
     * @returns {Promise<void>}
     */
    async load() {
        if (!fs.existsSync(this.#usersPath)) {
            await this.#bootstrap();
            return;
        }

        try {
            const raw    = await fs.promises.readFile(this.#usersPath, 'utf8');
            this.#users  = JSON.parse(raw);
        } catch {
            // Corrupt or empty file — bootstrap a fresh admin
            this.#users = [];
            await this.#bootstrap();
        }
    }

    /**
     * Write current users to users.json.
     * @returns {Promise<void>}
     */
    async save() {
        if (!fs.existsSync(this.storeDir)) {
            fs.mkdirSync(this.storeDir, { recursive: true });
        }
        await fs.promises.writeFile(
            this.#usersPath,
            JSON.stringify(this.#users, null, 2),
            'utf8'
        );
    }

    // ---------------------------------------------------------------------------
    // Read
    // ---------------------------------------------------------------------------

    /**
     * Find a user by username (case-sensitive).
     * @param {string} username
     * @returns {object|null} Full user object including passwordHash, or null
     */
    findByUsername(username) {
        return this.#users.find(u => u.username === username) || null;
    }

    /**
     * Find a user by userId.
     * @param {string} userId
     * @returns {object|null} Full user object including passwordHash, or null
     */
    findById(userId) {
        return this.#users.find(u => u.userId === userId) || null;
    }

    /**
     * List all users. passwordHash is excluded from results.
     * @returns {object[]}
     */
    list() {
        return this.#users.map(u => this.#safe(u));
    }

    // ---------------------------------------------------------------------------
    // Write
    // ---------------------------------------------------------------------------

    /**
     * Create a new user. Throws if username is already taken.
     *
     * @param {string}  username
     * @param {string}  password  - Plaintext password to hash
     * @param {boolean} [isAdmin] - Defaults to false
     * @returns {Promise<object>} New user object (without passwordHash)
     */
    async create(username, password, isAdmin = false) {
        if (this.findByUsername(username)) {
            throw new Error(`Username already taken: ${username}`);
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
        const user = {
            userId:             uuidv4(),
            username,
            passwordHash,
            isAdmin,
            mustChangePassword: false,
            createdAt:          new Date().toISOString()
        };

        this.#users.push(user);
        await this.save();
        return this.#safe(user);
    }

    /**
     * Remove a user by userId. Throws if removing the last admin.
     *
     * @param {string} userId
     * @returns {Promise<boolean>} true if found and removed
     */
    async remove(userId) {
        const user = this.findById(userId);
        if (!user) return false;

        if (user.isAdmin) {
            const adminCount = this.#users.filter(u => u.isAdmin).length;
            if (adminCount <= 1) {
                throw new Error('Cannot remove the last admin account');
            }
        }

        this.#users = this.#users.filter(u => u.userId !== userId);
        await this.save();
        return true;
    }

    /**
     * Verify a plaintext password against the stored hash for a given username.
     * Returns the user object (without passwordHash) on success, null on failure.
     *
     * @param {string} username
     * @param {string} password
     * @returns {Promise<object|null>}
     */
    async verify(username, password) {
        const user = this.findByUsername(username);
        if (!user) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        return ok ? this.#safe(user) : null;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /** Return a user object without the passwordHash field. */
    #safe(user) {
        const { passwordHash: _omit, ...safe } = user;
        return safe;
    }

    /**
     * Bootstrap the default admin account and save.
     * Called when users.json does not exist or is corrupt.
     */
    async #bootstrap() {
        const passwordHash = await bcrypt.hash('admin', BCRYPT_COST);
        this.#users = [{
            userId:             uuidv4(),
            username:           'admin',
            passwordHash,
            isAdmin:            true,
            mustChangePassword: true,
            createdAt:          new Date().toISOString()
        }];
        await this.save();
    }

}

module.exports = UserStore;

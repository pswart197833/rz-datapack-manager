'use strict';

const fs                = require('fs');
const path              = require('path');
const crypto            = require('crypto');
const FingerprintRecord = require('./FingerprintRecord');

/**
 * FingerprintStore
 * src/fingerprint/FingerprintStore.js
 *
 * Persistent store of FingerprintRecords. JSON Lines (.jsonl), append-only.
 *
 * Primary key: `${decodedName}::${hash}` — name + content hash together.
 * This models three distinct file relationships cleanly:
 *
 *   Same name + same hash  → exact duplicate   → skip, return existing
 *   Diff name + same hash  → content alias      → new record, isAlias=true, aliasOf=hash
 *   Same name + diff hash  → updated file       → new record, new version
 *   Diff name + diff hash  → unrelated file     → new record
 *
 * Two lookup indexes:
 *   #primary    Map<"name::hash", FingerprintRecord>  — primary key lookup
 *   #nameIndex  Map<name, FingerprintRecord>           — latest record per name (O(1) getByName)
 *   #hashIndex  Map<hash, FingerprintRecord>           — canonical record per hash
 *
 * #hashIndex invariant: the value for a given hash is ALWAYS the canonical record
 * (isAlias=false). This is enforced by #index():
 *   - If no entry exists for the hash, write the arriving record.
 *   - If the arriving record is isAlias=false and the stored record is isAlias=true,
 *     the canonical replaces the alias (corrects orphaned alias records on load()).
 *   - If an isAlias=false entry already exists, do not overwrite it.
 *
 * The null-asset sentinel (AssetStore.NULL_ASSET_HASH / '__null__') is a
 * special FingerprintRecord registered via ensureNullAsset(). Zero-size index
 * entries are stored as aliases of this sentinel so the pipeline is uniform —
 * no special-case branching needed anywhere else.
 */

class FingerprintStore {

    constructor(dbPath, assetStore) {
        this.dbPath       = dbPath;
        this.#assetStore  = assetStore;
        this.#primary     = new Map(); // "name::hash" → FingerprintRecord
        this.#nameIndex   = new Map(); // name → FingerprintRecord (latest)
        this.#hashIndex   = new Map(); // hash → FingerprintRecord (canonical/first non-alias)
        this.#writeStream = null;
    }

    #primary;
    #nameIndex;
    #hashIndex;
    #assetStore;
    #writeStream;

    // ---------------------------------------------------------------------------
    // Load
    // ---------------------------------------------------------------------------

    async load() {
        if (!fs.existsSync(this.dbPath)) return;
        const content = await fs.promises.readFile(this.dbPath, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const record = FingerprintRecord.fromJSON(JSON.parse(line));
                this.#index(record);
            } catch { /* skip malformed lines */ }
        }
    }

    // ---------------------------------------------------------------------------
    // Null-asset sentinel
    // ---------------------------------------------------------------------------

    /**
     * Ensure the null-asset sentinel FingerprintRecord exists in this store.
     *
     * The sentinel has:
     *   hash         = SHA-256 of empty buffer (AssetStore.NULL_ASSET_HASH)
     *   decodedName  = '__null__'
     *   type         = 'asset'
     *   size         = 0
     *   extractedPath = path to the empty sentinel file in the AssetStore
     *
     * Must be called after assetStore.ensureNullAsset() so the file path
     * already exists. Safe to call multiple times — idempotent.
     *
     * @returns {Promise<FingerprintRecord>}
     */
    async ensureNullAsset() {
        const AssetStore = require('../core/AssetStore');
        const hash       = AssetStore.NULL_ASSET_HASH;
        const name       = AssetStore.NULL_ASSET_NAME;

        // Already registered — nothing to do
        if (this.hasExact(name, hash)) {
            return this.get(hash);
        }

        const nullPath = this.#assetStore.ensureNullAsset();
        const buffer   = Buffer.alloc(0);

        const record = new FingerprintRecord({
            hash,
            type:          'asset',
            decodedName:   name,
            size:          0,
            extractedPath: nullPath,
            isAlias:       false,
            aliasOf:       null
        });

        this.#index(record);
        await this.#append(record);
        return record;
    }

    // ---------------------------------------------------------------------------
    // Read
    // ---------------------------------------------------------------------------

    /** Check if a hash is registered (any name). */
    has(hash) {
        return this.#hashIndex.has(hash);
    }

    /** Check if an exact name+hash record exists. */
    hasExact(decodedName, hash) {
        return this.#primary.has(`${decodedName}::${hash}`);
    }

    /** Get canonical record for a content hash (first non-alias record registered with this hash). */
    get(hash) {
        return this.#hashIndex.get(hash) || null;
    }

    /** Get the latest record for a filename. O(1). */
    getByName(decodedName) {
        return this.#nameIndex.get(decodedName) || null;
    }

    /**
     * List all records, optionally filtered by type.
     * Returns one record per unique name::hash combination.
     */
    list(type) {
        const records = Array.from(this.#primary.values());
        if (!type) return records;
        return records.filter(r => r.type === type);
    }

    // ---------------------------------------------------------------------------
    // Register
    // ---------------------------------------------------------------------------

    /**
     * Register a file. Uses name+hash as the primary key.
     *
     * isAlias is set to true only when #hashIndex already holds a canonical
     * (isAlias=false) record for this hash under a different name. If the
     * existing #hashIndex entry is itself an alias, this new registration
     * becomes the canonical instead.
     *
     * @param {Buffer}      buffer
     * @param {string}      type          - 'asset' | 'pack' | 'index'
     * @param {string}      decodedName
     * @param {string|null} extractedPath
     * @param {number|null} size          - overrides buffer.length (stub registrations)
     * @returns {Promise<FingerprintRecord>}
     */
    async register(buffer, type, decodedName, extractedPath = null, size = null) {
        const hash       = crypto.createHash('sha256').update(buffer).digest('hex');
        const primaryKey = `${decodedName}::${hash}`;

        // Exact duplicate — same name AND same hash — already registered
        const existing = this.#primary.get(primaryKey);
        if (existing) {
            // Upgrade stub to real record if extractedPath was missing
            if (!existing.extractedPath && extractedPath) {
                existing.extractedPath = extractedPath;
                await this.#append(existing);
            }
            return existing;
        }

        // New record — either a new file, an alias, or an updated version.
        //
        // isAlias is true only when #hashIndex holds a CANONICAL (isAlias=false)
        // record for this hash under a different name. If the existing #hashIndex
        // entry is itself an alias (orphaned alias scenario from a corrupted JSONL),
        // this new record becomes the canonical instead of perpetuating the orphan.
        const existingCanonical = this.#hashIndex.get(hash);
        const isAlias = !!existingCanonical &&
                        !existingCanonical.isAlias &&
                        existingCanonical.decodedName !== decodedName;
        const aliasOf = isAlias ? hash : null;

        // For aliases: inherit extractedPath from canonical if none provided
        let resolvedPath = extractedPath;
        if (!resolvedPath && existingCanonical?.extractedPath) {
            resolvedPath = existingCanonical.extractedPath;
        }

        const record = new FingerprintRecord({
            hash,
            type,
            decodedName,
            size:          size !== null ? size : buffer.length,
            extractedPath: resolvedPath,
            isAlias,
            aliasOf
        });

        this.#index(record);
        await this.#append(record);
        return record;
    }

    // ---------------------------------------------------------------------------
    // Prune
    // ---------------------------------------------------------------------------

    /**
     * Remove stub records that have been superseded by real extractions.
     * A stub is registered by loadIndex() before extraction. After extractAll(),
     * a real record exists with the same name + hash — the stub is redundant.
     */
    async pruneStubs() {
        let removed    = 0;
        const toDelete = [];

        for (const [key, record] of this.#primary) {
            if (record.isAsset() && !record.extractedPath) {
                // Stub: check if a real record exists for the same name
                const real = this.#nameIndex.get(record.decodedName);
                if (real && real !== record && real.extractedPath) {
                    toDelete.push({ key, record });
                }
            }
        }

        for (const { key, record } of toDelete) {
            this.#primary.delete(key);
            if (this.#hashIndex.get(record.hash) === record) this.#hashIndex.delete(record.hash);
            removed++;
        }

        if (removed > 0) await this.#rewrite();
        return removed;
    }

    // ---------------------------------------------------------------------------
    // Bulk write stream
    // ---------------------------------------------------------------------------

    async openWriteStream() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.#writeStream = fs.createWriteStream(this.dbPath, { flags: 'a', encoding: 'utf8' });
        this.#writeStream.setMaxListeners(0);
        await new Promise((resolve, reject) => {
            this.#writeStream.on('open',  resolve);
            this.#writeStream.on('error', reject);
        });
    }

    async closeWriteStream() {
        if (!this.#writeStream) return;
        await new Promise((resolve, reject) => {
            this.#writeStream.end(err => err ? reject(err) : resolve());
        });
        this.#writeStream = null;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Add a record to all three indexes.
     *
     * #hashIndex invariant: always holds the canonical (isAlias=false) record.
     *   - If no entry exists: write the arriving record regardless of isAlias.
     *   - If the arriving record is canonical (isAlias=false) and the stored
     *     entry is an alias (isAlias=true): replace it with the canonical.
     *   - If a canonical (isAlias=false) entry already exists: do not overwrite.
     */
    #index(record) {
        const primaryKey = `${record.decodedName}::${record.hash}`;
        this.#primary.set(primaryKey, record);
        // nameIndex: last-write-wins — latest registration wins per name
        this.#nameIndex.set(record.decodedName, record);

        // hashIndex: canonical (isAlias=false) wins over alias
        const existing = this.#hashIndex.get(record.hash);
        if (!existing) {
            // No entry yet — write whatever arrived first
            this.#hashIndex.set(record.hash, record);
        } else if (!record.isAlias && existing.isAlias) {
            // Arriving canonical displaces a previously stored alias
            this.#hashIndex.set(record.hash, record);
        }
        // If existing is already canonical (isAlias=false), leave it alone
    }

    async #append(record) {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify(record.toJSON()) + '\n';

        if (this.#writeStream) {
            await new Promise((resolve, reject) => {
                const onError = (err) => reject(err);
                const ok = this.#writeStream.write(line, 'utf8', err => {
                    this.#writeStream.removeListener('error', onError);
                    if (err) reject(err);
                    else     resolve();
                });
                if (ok) return;
                const onDrain = () => {
                    this.#writeStream.removeListener('error', onError);
                    resolve();
                };
                this.#writeStream.once('drain', onDrain);
                this.#writeStream.once('error', onError);
            });
        } else {
            await fs.promises.appendFile(this.dbPath, line, 'utf8');
        }
    }

    async #rewrite() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const lines = Array.from(this.#primary.values())
            .map(r => JSON.stringify(r.toJSON()))
            .join('\n') + '\n';
        await fs.promises.writeFile(this.dbPath, lines, 'utf8');
    }

}

module.exports = FingerprintStore;

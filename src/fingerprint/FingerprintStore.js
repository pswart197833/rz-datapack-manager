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
 *   #primaryIndex  Map<"name::hash", FingerprintRecord>  — primary key lookup
 *   #nameIndex     Map<name, FingerprintRecord>           — latest record per name (O(1) getByName)
 *   #hashIndex     Map<hash, FingerprintRecord>           — canonical record per hash (first seen)
 */

class FingerprintStore {

    constructor(dbPath, assetStore) {
        this.dbPath       = dbPath;
        this.#assetStore  = assetStore;
        this.#primary     = new Map(); // "name::hash" → FingerprintRecord
        this.#nameIndex   = new Map(); // name → FingerprintRecord (latest)
        this.#hashIndex   = new Map(); // hash → FingerprintRecord (canonical/first)
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
    // Read
    // ---------------------------------------------------------------------------

    /** Check if a name+hash combination is already registered. */
    has(hash) {
        return this.#hashIndex.has(hash);
    }

    /** Check if an exact name+hash record exists. */
    hasExact(decodedName, hash) {
        return this.#primary.has(`${decodedName}::${hash}`);
    }

    /** Get canonical record for a content hash (first file registered with this hash). */
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
        // isAlias: this hash is already registered under a DIFFERENT name.
        // Determined before creating the record — independent of extractedPath.
        const canonicalForHash = this.#hashIndex.get(hash);
        const isAlias = !!canonicalForHash && canonicalForHash.decodedName !== decodedName;
        const aliasOf = isAlias ? hash : null;

        // For aliases: inherit extractedPath from canonical if none provided
        let resolvedPath = extractedPath;
        if (!resolvedPath && canonicalForHash?.extractedPath) {
            resolvedPath = canonicalForHash.extractedPath;
        }

        const record = new FingerprintRecord({
            hash,
            type,
            decodedName,
            size:          size !== null ? size : buffer.length,
            extractedPath: resolvedPath,
            verified:      false,
            date:          new Date(),
            isAlias,
            aliasOf
        });

        this.#index(record);
        await this.#append(record);
        return record;
    }

    // ---------------------------------------------------------------------------
    // Verify
    // ---------------------------------------------------------------------------

    async verify(record) {
        return this.#assetStore.verify(record);
    }

    // ---------------------------------------------------------------------------
    // Prune
    // ---------------------------------------------------------------------------

    /**
     * Remove records whose extractedPath no longer exists on disk.
     */
    async prune() {
        let removed = 0;
        for (const [key, record] of this.#primary) {
            if (record.isAsset() && record.extractedPath && !fs.existsSync(record.extractedPath)) {
                this.#primary.delete(key);
                this.#nameIndex.delete(record.decodedName);
                if (this.#hashIndex.get(record.hash) === record) this.#hashIndex.delete(record.hash);
                removed++;
            }
        }
        if (removed > 0) await this.#rewrite();
        return removed;
    }

    /**
     * Remove stub records (null extractedPath) that have been superseded.
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

    /** Add a record to all three indexes. */
    #index(record) {
        const primaryKey = `${record.decodedName}::${record.hash}`;
        this.#primary.set(primaryKey, record);
        // nameIndex: last-write-wins — latest registration wins per name
        this.#nameIndex.set(record.decodedName, record);
        // hashIndex: first-write-wins — canonical record per hash
        if (!this.#hashIndex.has(record.hash)) {
            this.#hashIndex.set(record.hash, record);
        }
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

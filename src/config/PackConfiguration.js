'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * PackConfiguration
 * src/config/PackConfiguration.js
 *
 * Single source of truth for all file paths and directory locations.
 * Every class that needs a path gets it from here — nothing hardcodes
 * its own paths.
 *
 * Pack slots are numbered 1-8, corresponding to data.001 through data.008.
 */

class PackConfiguration {

    /**
     * @param {object} opts
     * @param {string}              opts.indexPath     - Path to data.000
     * @param {Map<number,string>}  opts.packPaths     - Map of slot (1-8) to file path
     * @param {string}              opts.assetStoreDir - Root dir for extracted asset storage
     * @param {string}              opts.sessionsDir   - Root dir for session working folders
     * @param {string}             [opts.label]        - Optional friendly name
     */
    constructor({ indexPath, packPaths, assetStoreDir, sessionsDir, label = '' } = {}) {
        this.indexPath     = indexPath     || null;
        this.packPaths     = packPaths instanceof Map ? packPaths : new Map();
        this.assetStoreDir = assetStoreDir || null;
        this.sessionsDir   = sessionsDir   || null;
        this.label         = label;
        this.createdAt     = new Date();
    }

    // ---------------------------------------------------------------------------
    // Accessors
    // ---------------------------------------------------------------------------

    /**
     * Returns the resolved path to data.000.
     * @returns {string|null}
     */
    getIndexPath() {
        return this.indexPath;
    }

    /**
     * Returns the resolved path for a given pack slot.
     * @param {number} slot - 1 through 8
     * @returns {string|null}
     */
    getPackPath(slot) {
        return this.packPaths.get(slot) || null;
    }

    /**
     * Returns slots that have no file path assigned.
     * @returns {number[]}
     */
    listMissingPacks() {
        const missing = [];
        for (let slot = 1; slot <= 8; slot++) {
            if (!this.packPaths.has(slot)) missing.push(slot);
        }
        return missing;
    }

    // ---------------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------------

    /**
     * Checks that all configured paths exist and are readable.
     * Returns a result object with an ok flag and an array of any problems found.
     *
     * @returns {{ ok: boolean, errors: string[] }}
     */
    validate() {
        const errors = [];

        // Check index file
        if (!this.indexPath) {
            errors.push('indexPath is not set');
        } else if (!fs.existsSync(this.indexPath)) {
            errors.push(`index file not found: ${this.indexPath}`);
        }

        // Check each configured pack path
        for (const [slot, filePath] of this.packPaths) {
            if (!fs.existsSync(filePath)) {
                errors.push(`pack slot ${slot} file not found: ${filePath}`);
            }
        }

        // Check asset store directory
        if (!this.assetStoreDir) {
            errors.push('assetStoreDir is not set');
        } else if (!fs.existsSync(this.assetStoreDir)) {
            // Non-fatal — will be created on first write
            errors.push(`assetStoreDir does not exist (will be created): ${this.assetStoreDir}`);
        }

        // Check sessions directory
        if (!this.sessionsDir) {
            errors.push('sessionsDir is not set');
        } else if (!fs.existsSync(this.sessionsDir)) {
            // Non-fatal — will be created on first session
            errors.push(`sessionsDir does not exist (will be created): ${this.sessionsDir}`);
        }

        return { ok: errors.length === 0, errors };
    }

    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------

    /**
     * Serialize to a plain object for JSON persistence.
     * Map is converted to an array of [slot, path] pairs.
     * @returns {object}
     */
    toJSON() {
        return {
            indexPath:     this.indexPath,
            packPaths:     Array.from(this.packPaths.entries()),
            assetStoreDir: this.assetStoreDir,
            sessionsDir:   this.sessionsDir,
            label:         this.label,
            createdAt:     this.createdAt.toISOString()
        };
    }

    /**
     * Deserialize from a plain object (as produced by toJSON).
     * @param {object} obj
     * @returns {PackConfiguration}
     */
    static fromJSON(obj) {
        return new PackConfiguration({
            indexPath:     obj.indexPath,
            packPaths:     new Map(obj.packPaths || []),
            assetStoreDir: obj.assetStoreDir,
            sessionsDir:   obj.sessionsDir,
            label:         obj.label || ''
        });
    }

    // ---------------------------------------------------------------------------
    // Factory helper
    // ---------------------------------------------------------------------------

    /**
     * Convenience factory — builds a PackConfiguration from a single base
     * directory that contains data.000 through data.008 using standard naming.
     *
     * @param {string} dataDir      - Directory containing the pack files
     * @param {string} assetStoreDir
     * @param {string} sessionsDir
     * @param {string} [label]
     * @returns {PackConfiguration}
     */
    static fromDirectory(dataDir, assetStoreDir, sessionsDir, label = '') {
        const packPaths = new Map();
        for (let slot = 1; slot <= 8; slot++) {
            const filePath = path.join(dataDir, `data.00${slot}`);
            packPaths.set(slot, filePath);
        }

        return new PackConfiguration({
            indexPath: path.join(dataDir, 'data.000'),
            packPaths,
            assetStoreDir,
            sessionsDir,
            label
        });
    }

}

module.exports = PackConfiguration;

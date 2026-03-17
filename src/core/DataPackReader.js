'use strict';

const fs             = require('fs');
const path           = require('path');
const CryptoProvider = require('../crypto/CryptoProvider');

/**
 * DataPackReader
 * src/core/DataPackReader.js
 *
 * Reads raw asset bytes from data.001--.008 using location information
 * already resolved in an AssetItem.
 *
 * File handles are cached and reused across reads — opening and closing
 * a handle for every asset on a 124k entry extraction would be very slow.
 * Callers must call closeAll() when done to release handles cleanly.
 *
 * Header validation is explicit and caller-controlled — validateAsset()
 * is a separate method. The caller decides when to invoke it.
 *
 * Known asset type signatures (magic bytes):
 *   dds  — 0x44 0x44 0x53 0x20 ('DDS ')
 *   tga  — no universal magic, validated by size heuristic
 *   jpg  — 0xFF 0xD8 0xFF
 *   png  — 0x89 0x50 0x4E 0x47
 *   bmp  — 0x42 0x4D ('BM')
 *   wav  — 0x52 0x49 0x46 0x46 ('RIFF')
 *   xml  — 0x3C ('< ')
 */

class DataPackReader {

    // Proprietary binary formats stored raw in the pack — no content XOR.
    // Everything else (jpg, png, bmp, wav, xml, cfg, lua, etc.) is XOR-encrypted.
    static #PROPRIETARY_FORMATS = new Set(['dds','tga','cob','naf','nx3','nfm']);

    /**
     * Returns true if this asset type needs XOR decryption after extraction.
     * @param {string} assetType
     * @returns {boolean}
     */
    static #needsDecryption(assetType) {
        if (!assetType) return false;
        return !DataPackReader.#PROPRIETARY_FORMATS.has(assetType.toLowerCase());
    }

    /**
     * @param {Map<number, string>} packPaths - Maps slot 1-8 to filesystem paths
     */
    constructor(packPaths) {
        this.packPaths    = packPaths;
        this.#fileHandles = new Map();
        this.#crypto      = new CryptoProvider();
    }

    #fileHandles;
    #crypto;

    // ---------------------------------------------------------------------------
    // Handle management
    // ---------------------------------------------------------------------------

    /**
     * Explicitly open a file handle for a given pack slot.
     * Called lazily by extractAsset() — can also be called up front
     * to pre-warm handles before a batch extraction.
     *
     * @param {number} packId - 1 through 8
     * @returns {Promise<void>}
     */
    async open(packId) {
        if (this.#fileHandles.has(packId)) return;

        const packPath = this.packPaths.get(packId);
        if (!packPath) throw new Error(`No path configured for pack slot ${packId}`);
        if (!fs.existsSync(packPath)) throw new Error(`Pack file not found: ${packPath}`);

        const handle = await fs.promises.open(packPath, 'r');
        this.#fileHandles.set(packId, handle);
    }

    /**
     * Close the file handle for a specific pack slot.
     * @param {number} packId
     * @returns {Promise<void>}
     */
    async close(packId) {
        const handle = this.#fileHandles.get(packId);
        if (handle) {
            await handle.close();
            this.#fileHandles.delete(packId);
        }
    }

    /**
     * Close all open file handles.
     * Always call this when extraction is complete.
     * @returns {Promise<void>}
     */
    async closeAll() {
        for (const [packId, handle] of this.#fileHandles) {
            await handle.close();
            this.#fileHandles.delete(packId);
        }
    }

    // ---------------------------------------------------------------------------
    // Extraction
    // ---------------------------------------------------------------------------

    /**
     * Read raw bytes for a single AssetItem.
     * Opens the pack file handle lazily if not already open.
     *
     * @param {AssetItem} entry
     * @returns {Promise<Buffer>}
     */
    async extractAsset(entry) {
        if (!this.#fileHandles.has(entry.packId)) {
            await this.open(entry.packId);
        }

        const handle = this.#fileHandles.get(entry.packId);
        const buffer = Buffer.alloc(entry.size);

        const { bytesRead } = await handle.read(buffer, 0, entry.size, entry.offset);

        if (bytesRead !== entry.size) {
            throw new Error(
                `Incomplete read for "${entry.decodedName}": ` +
                `expected ${entry.size} bytes, got ${bytesRead}`
            );
        }

        // Non-proprietary formats are XOR-encrypted at the content level using
        // the same rolling cipher as data.000, starting fresh at index 0.
        // Proprietary formats (dds, tga, cob, naf, nx3, nfm) are stored raw.
        if (DataPackReader.#needsDecryption(entry.assetType)) {
            this.#crypto.processBuffer(buffer, 0);
        }

        return buffer;
    }

    /**
     * Extract multiple assets in one optimised pass.
     * Groups entries by pack slot to minimise handle switches,
     * then reads all entries for each pack in a single open session.
     *
     * @param {AssetItem[]} entries
     * @returns {Promise<Map<string, Buffer>>} Map of decodedName -> Buffer
     */
    async extractBatch(entries) {
        const results = new Map();

        // Group by packId to process each pack file together
        const byPack = new Map();
        for (const entry of entries) {
            if (!byPack.has(entry.packId)) byPack.set(entry.packId, []);
            byPack.get(entry.packId).push(entry);
        }

        for (const [packId, packEntries] of byPack) {
            // Pre-open handle for this pack
            if (!this.#fileHandles.has(packId)) {
                await this.open(packId);
            }

            for (const entry of packEntries) {
                const buffer = await this.extractAsset(entry);
                results.set(entry.decodedName, buffer);
            }
        }

        return results;
    }

    // ---------------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------------

    /**
     * Validate an extracted buffer's header against the expected assetType.
     * Returns a result object — does not throw.
     *
     * Caller decides when to invoke this — not every extraction needs it.
     *
     * @param {AssetItem} entry
     * @param {Buffer}    buffer
     * @returns {{ valid: boolean, reason: string|null }}
     */
    validateAsset(entry, buffer) {
        if (!buffer || buffer.length === 0) {
            return { valid: false, reason: 'buffer is empty' };
        }

        const type = (entry.assetType || '').toLowerCase();

        switch (type) {
            case 'dds':
                // Magic: 'DDS ' (0x44 0x44 0x53 0x20)
                if (buffer.length < 4) return { valid: false, reason: 'too small for DDS header' };
                if (buffer[0] === 0x44 && buffer[1] === 0x44 &&
                    buffer[2] === 0x53 && buffer[3] === 0x20) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'DDS magic bytes not found' };

            case 'jpg':
            case 'jpeg':
                // Magic: FF D8 FF
                if (buffer.length < 3) return { valid: false, reason: 'too small for JPEG header' };
                if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'JPEG magic bytes not found' };

            case 'png':
                // Magic: 89 50 4E 47
                if (buffer.length < 4) return { valid: false, reason: 'too small for PNG header' };
                if (buffer[0] === 0x89 && buffer[1] === 0x50 &&
                    buffer[2] === 0x4E && buffer[3] === 0x47) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'PNG magic bytes not found' };

            case 'bmp':
                // Magic: 'BM' (0x42 0x4D)
                if (buffer.length < 2) return { valid: false, reason: 'too small for BMP header' };
                if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'BMP magic bytes not found' };

            case 'wav':
                // Magic: 'RIFF' (0x52 0x49 0x46 0x46)
                if (buffer.length < 4) return { valid: false, reason: 'too small for WAV header' };
                if (buffer[0] === 0x52 && buffer[1] === 0x49 &&
                    buffer[2] === 0x46 && buffer[3] === 0x46) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'WAV/RIFF magic bytes not found' };

            case 'xml':
            case 'lua':
            case 'txt':
            case 'ini':
                // Text formats — check for printable ASCII start
                if (buffer[0] >= 0x20 && buffer[0] < 0x80) {
                    return { valid: true, reason: null };
                }
                return { valid: false, reason: 'expected printable ASCII for text format' };

            default:
                // Unknown or proprietary format (naf, nx3, nfm, cob, spt etc.)
                // Cannot validate by header — pass through
                return { valid: true, reason: null };
        }
    }

}

module.exports = DataPackReader;

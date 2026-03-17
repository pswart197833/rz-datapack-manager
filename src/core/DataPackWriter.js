'use strict';

const fs             = require('fs');
const path           = require('path');
const AssetItem      = require('./AssetItem');
const CryptoProvider = require('../crypto/CryptoProvider');

/**
 * DataPackWriter
 * src/core/DataPackWriter.js
 *
 * Streams asset buffers to data.00x pack files and verifies each write.
 * Tracks the running byte offset per pack slot so returned AssetItem
 * records have accurate offsets for index serialization.
 *
 * Does NOT build indexes, manage external offsets, or decide ordering.
 * The caller passes assets in the correct order and receives updated
 * AssetItem records with final offset and size values back.
 *
 * Pack files are written under temp names (data.001.build etc.) during
 * Phase 2. CommitPipeline renames them in Phase 3 after successful build.
 *
 * Write streams are opened lazily on first addAsset() call for each slot.
 *
 * Zero-size entries:
 *   When buffer.length === 0 the write is skipped entirely — no bytes go
 *   to the pack file and no stream is opened. The returned AssetItem carries
 *   the original packId and offset from the source entry so the index entry
 *   is reconstructed correctly by CommitPipeline.#buildIndex().
 */

class DataPackWriter {

    static VERSION = 'v2-with-encryption';

    // Proprietary formats are stored raw — no XOR encryption.
    // All other formats must be XOR-encrypted before writing to the pack.
    // This is the exact inverse of DataPackReader.#needsDecryption().
    static #PROPRIETARY_FORMATS = new Set(['dds','tga','cob','naf','nx3','nfm']);

    static #needsEncryption(assetType) {
        if (!assetType) return false;
        return !DataPackWriter.#PROPRIETARY_FORMATS.has(assetType.toLowerCase());
    }

    /**
     * @param {string} outputDir - Directory where pack files are written
     */
    constructor(outputDir) {
        this.outputDir       = outputDir;
        this.#writeStreams   = new Map();
        this.#currentOffsets = new Map();
        this.#crypto         = new CryptoProvider();
    }

    #writeStreams;
    #currentOffsets;
    #crypto;

    // ---------------------------------------------------------------------------
    // Write
    // ---------------------------------------------------------------------------

    /**
     * Stream an asset buffer to the correct pack file.
     * Opens the write stream lazily if not already open for this pack slot.
     *
     * Zero-size entries (buffer.length === 0): the write is skipped — no bytes
     * go to the pack file. The returned AssetItem preserves the original packId
     * and offset from the source entry so the index records are correct.
     *
     * Returns a new AssetItem with offset and size updated to reflect
     * where the asset was written in the output file.
     *
     * @param {AssetItem} entry  - Source entry (packId and offset used for routing/passthrough)
     * @param {Buffer}    buffer - Raw asset bytes to write (may be empty for zero-size entries)
     * @returns {Promise<AssetItem>} Updated AssetItem with final offset and size
     */
    async addAsset(entry, buffer) {
        // Zero-size placeholder — preserve original positional data, skip pack write.
        // These entries exist in data.000 but have no bytes in any pack file.
        if (buffer.length === 0) {
            return new AssetItem({
                encodedName:  entry.encodedName,
                decodedName:  entry.decodedName,
                assetType:    entry.assetType,
                packId:       entry.packId,
                offset:       entry.offset,
                size:         0,
                indexOffset:  entry.indexOffset,
                fingerprint:  entry.fingerprint
            });
        }

        const packId = entry.packId;

        // Open write stream lazily
        if (!this.#writeStreams.has(packId)) {
            await this.#openStream(packId);
        }

        const offset = this.#currentOffsets.get(packId);
        const stream = this.#writeStreams.get(packId);

        // Re-encrypt non-proprietary formats before writing.
        // AssetStore holds decrypted bytes; the pack file must contain encrypted bytes.
        // XOR is symmetric — processBuffer(buffer, 0) both encrypts and decrypts.
        let writeBuffer = buffer;
        if (DataPackWriter.#needsEncryption(entry.assetType)) {
            writeBuffer = Buffer.from(buffer); // copy — don't mutate the store's buffer
            this.#crypto.processBuffer(writeBuffer, 0);
        }

        // Write and wait for drain if needed
        await this.#writeBuffer(stream, writeBuffer);

        // Advance offset
        this.#currentOffsets.set(packId, offset + buffer.length);

        // Return a new AssetItem with updated offset and size
        return new AssetItem({
            encodedName:  entry.encodedName,
            decodedName:  entry.decodedName,
            assetType:    entry.assetType,
            packId,
            offset,
            size:         buffer.length,
            indexOffset:  entry.indexOffset,
            fingerprint:  entry.fingerprint
        });
    }

    // ---------------------------------------------------------------------------
    // Close
    // ---------------------------------------------------------------------------

    /**
     * Finalise and close the write stream for a specific pack slot.
     * @param {number} packId
     * @returns {Promise<void>}
     */
    async close(packId) {
        const stream = this.#writeStreams.get(packId);
        if (stream) {
            await this.#closeStream(stream);
            this.#writeStreams.delete(packId);
            this.#currentOffsets.delete(packId);
        }
    }

    /**
     * Finalise and close all open write streams.
     * Always call this after the build is complete.
     * @returns {Promise<void>}
     */
    async closeAll() {
        for (const [packId] of this.#writeStreams) {
            await this.close(packId);
        }
    }

    // ---------------------------------------------------------------------------
    // Query
    // ---------------------------------------------------------------------------

    /**
     * Return the current byte offset for a given pack slot.
     * @param {number} packId
     * @returns {number}
     */
    getCurrentOffset(packId) {
        return this.#currentOffsets.get(packId) || 0;
    }

    /**
     * Return the output path for a given pack slot's build file.
     * @param {number} packId
     * @returns {string}
     */
    getBuildPath(packId) {
        return path.join(this.outputDir, `data.00${packId}.build`);
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    async #openStream(packId) {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        const buildPath = this.getBuildPath(packId);
        const stream    = fs.createWriteStream(buildPath, { flags: 'w' });
        stream.setMaxListeners(0);

        await new Promise((resolve, reject) => {
            stream.on('open',  resolve);
            stream.on('error', reject);
        });

        this.#writeStreams.set(packId, stream);
        this.#currentOffsets.set(packId, 0);
    }

    #writeBuffer(stream, buffer) {
        return new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            const ok = stream.write(buffer, err => {
                stream.removeListener('error', onError);
                if (err) reject(err);
                else     resolve();
            });
            if (ok) return;
            const onDrain = () => {
                stream.removeListener('error', onError);
                resolve();
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
        });
    }

    #closeStream(stream) {
        return new Promise((resolve, reject) => {
            stream.end(err => {
                if (err) reject(err);
                else     resolve();
            });
        });
    }

}

module.exports = DataPackWriter;

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
 */

class DataPackWriter {

    static VERSION = 'v2-with-encryption'; // verify this is in src/core/DataPackWriter.js

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
     * Verifies the write completed fully before returning.
     *
     * Returns a new AssetItem with offset and size updated to reflect
     * where the asset was written in the output file.
     *
     * @param {AssetItem} entry  - Source entry (packId used for routing)
     * @param {Buffer}    buffer - Raw asset bytes to write
     * @returns {Promise<AssetItem>} Updated AssetItem with final offset and size
     */
    async addAsset(entry, buffer) {
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
     * Useful for verifying expected final file sizes.
     *
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

    /**
     * Open a write stream for a pack slot, creating the output file.
     * Uses .build extension — CommitPipeline renames after successful build.
     *
     * @param {number} packId
     * @returns {Promise<void>}
     */
    async #openStream(packId) {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        const buildPath = this.getBuildPath(packId);
        const stream    = fs.createWriteStream(buildPath, { flags: 'w' });
        stream.setMaxListeners(0); // multiple error/drain listeners added per write

        // Wait for the stream to be ready
        await new Promise((resolve, reject) => {
            stream.on('open',  resolve);
            stream.on('error', reject);
        });

        this.#writeStreams.set(packId, stream);
        this.#currentOffsets.set(packId, 0);
    }

    /**
     * Write a buffer to a stream, respecting backpressure.
     *
     * @param {fs.WriteStream} stream
     * @param {Buffer}         buffer
     * @returns {Promise<void>}
     */
    #writeBuffer(stream, buffer) {
        return new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            const ok = stream.write(buffer, err => {
                stream.removeListener('error', onError);
                if (err) reject(err);
                else     resolve();
            });
            if (ok) return; // completed synchronously — callback will resolve
            // Backpressure — wait for drain
            const onDrain = () => {
                stream.removeListener('error', onError);
                resolve();
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
        });
    }

    /**
     * Finalise and close a write stream.
     *
     * @param {fs.WriteStream} stream
     * @returns {Promise<void>}
     */
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

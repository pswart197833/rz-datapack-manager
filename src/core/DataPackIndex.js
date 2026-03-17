'use strict';

const fs             = require('fs');
const path           = require('path');
const AssetItem      = require('./AssetItem');
const CryptoProvider = require('../crypto/CryptoProvider');
const FilenameCodec  = require('../crypto/FilenameCodec');

/**
 * DataPackIndex
 * src/core/DataPackIndex.js
 *
 * Owns the full binary lifecycle of data.000:
 *   - decrypt and parse into AssetItem[]
 *   - serialize an AssetItem[] back to encrypted binary
 *   - write to disk
 *   - validate entries for gaps or corrupt offsets
 *   - diff two indexes against each other
 *
 * Does NOT decide what entries to include or in what order —
 * that is the caller's responsibility.
 *
 * Binary record format (per entry, all values little-endian):
 *   [1 byte]  encrypted length of the encoded filename string (nStrLen)
 *   [N bytes] encrypted encoded filename string (N = decrypted nStrLen)
 *   [4 bytes] encrypted UInt32LE asset offset within pack file
 *   [4 bytes] encrypted UInt32LE asset size in bytes
 */

class DataPackIndex {

    constructor() {
        this.entries   = [];
        this.rawBuffer = null;
        this._crypto   = new CryptoProvider();
        this._codec    = new FilenameCodec();
    }

    parse(buffer) {
        this.rawBuffer = buffer;
        this.entries   = [];

        let cipherIndex  = 0;
        let bufferOffset = 0;

        while (bufferOffset < buffer.length) {
            const indexOffset = bufferOffset;

            const lenResult = this._crypto.processByte(buffer[bufferOffset], cipherIndex);
            const nStrLen   = lenResult.value;
            cipherIndex     = lenResult.nextIndex;
            bufferOffset++;

            const encodedNameBuf = Buffer.from(buffer.slice(bufferOffset, bufferOffset + nStrLen));
            cipherIndex  = this._crypto.processBuffer(encodedNameBuf, cipherIndex);
            bufferOffset += nStrLen;

            const metaBuf = Buffer.from(buffer.slice(bufferOffset, bufferOffset + 8));
            cipherIndex   = this._crypto.processBuffer(metaBuf, cipherIndex);
            bufferOffset  += 8;

            const encodedName = encodedNameBuf.toString('latin1');
            const decodedName = this._codec.decode(encodedName);
            const offset      = metaBuf.readUInt32LE(0);
            const size        = metaBuf.readUInt32LE(4);
            const packId      = this._codec.getPackId(encodedName);
            const assetType   = decodedName.includes('.')
                ? decodedName.split('.').pop().toLowerCase()
                : 'unknown';

            this.entries.push(new AssetItem({
                encodedName: encodedNameBuf,
                decodedName,
                assetType,
                packId,
                offset,
                size,
                indexOffset
            }));
        }
    }

    serialize(entries) {
        const chunks = [];
        let cipherIndex = 0;

        for (const item of entries) {
            let encodedNameStr;
            if (item.encodedName) {
                encodedNameStr = item.encodedName.toString('latin1');
            } else {
                encodedNameStr = this._codec.encode(item.decodedName);
            }

            const encodedNameBuf = Buffer.from(encodedNameStr, 'latin1');
            const nStrLen        = encodedNameBuf.length;

            const lenBuf = Buffer.from([nStrLen]);
            cipherIndex  = this._crypto.processBuffer(lenBuf, cipherIndex);
            chunks.push(lenBuf);

            const nameBuf = Buffer.from(encodedNameBuf);
            cipherIndex   = this._crypto.processBuffer(nameBuf, cipherIndex);
            chunks.push(nameBuf);

            const metaBuf = Buffer.alloc(8);
            metaBuf.writeUInt32LE(item.offset, 0);
            metaBuf.writeUInt32LE(item.size,   4);
            cipherIndex   = this._crypto.processBuffer(metaBuf, cipherIndex);
            chunks.push(metaBuf);
        }

        return Buffer.concat(chunks);
    }

    serializeEntry(item) {
        return this.serialize([item]);
    }

    async writeToDisk(buffer, outputPath) {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await fs.promises.writeFile(outputPath, buffer);
    }

    /**
     * Check entries for obvious problems.
     *
     * offset === 0 is valid for the first asset in each pack file —
     * we track first-seen per pack slot before issuing that warning.
     *
     * Zero-size entries exist in real data (placeholder/deleted entries)
     * and produce warnings, not errors.
     *
     * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
     */
    validate() {
        const errors           = [];
        const warnings         = [];
        const seen             = new Set();
        const firstSeenPerPack = new Set();

        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            const label = `entry[${i}] "${entry.decodedName}"`;

            if (!entry.decodedName) {
                errors.push(`${label}: empty decoded name`);
            }

            if (entry.size === 0) {
                warnings.push(`${label}: size is 0 (placeholder or deleted entry)`);
            }

            if (entry.offset === 0 && firstSeenPerPack.has(entry.packId)) {
                warnings.push(`${label}: offset is 0 but not first entry in pack ${entry.packId}`);
            }
            firstSeenPerPack.add(entry.packId);

            if (seen.has(entry.decodedName)) {
                errors.push(`${label}: duplicate filename`);
            } else {
                seen.add(entry.decodedName);
            }

            if (entry.packId < 1 || entry.packId > 8) {
                errors.push(`${label}: packId ${entry.packId} is out of range (1-8)`);
            }
        }

        return { ok: errors.length === 0, errors, warnings };
    }

    diff(other) {
        const thisMap  = new Map(this.entries.map(e  => [e.decodedName, e]));
        const otherMap = new Map(other.entries.map(e => [e.decodedName, e]));

        const added   = [];
        const removed = [];
        const changed = [];

        for (const [name, entry] of otherMap) {
            if (!thisMap.has(name)) added.push(entry);
        }
        for (const [name, entry] of thisMap) {
            if (!otherMap.has(name)) removed.push(entry);
        }
        for (const [name, thisEntry] of thisMap) {
            const otherEntry = otherMap.get(name);
            if (otherEntry && (thisEntry.size !== otherEntry.size || thisEntry.offset !== otherEntry.offset)) {
                changed.push(otherEntry);
            }
        }

        return { added, removed, changed };
    }

}

module.exports = DataPackIndex;

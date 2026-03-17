'use strict';

/**
 * FilenameCodec
 * src/crypto/FilenameCodec.js
 *
 * Encodes and decodes the obfuscated filename strings stored in data.000.
 * Also determines which data.001--.008 pack file a given asset belongs to
 * via a deterministic SDBM-style hash.
 *
 * Derived from KFileNameCipher.cpp in the original Rappelz game engine source.
 *
 * Algorithm summary:
 *
 *   Encode:
 *     1. Lowercase the filename
 *     2. Compute start_depth = GetStartDepth(filename)
 *        = (sum(17 * charCode + 1) + length) % 32, forced nonzero
 *     3. Substitute each character forward through encTable, depth times,
 *        advancing depth using the ORIGINAL char value after each step
 *     4. Swap chars at positions [0]↔[66%] and [1]↔[33%] (transposition)
 *     5. saltSuffix = refTable[start_depth]  — derived, not a parameter
 *     6. saltPrefix = GetParityChar(inner)   — checksum of encoded inner bytes
 *     7. Result = saltPrefix + inner + saltSuffix
 *
 *   Decode:
 *     1. Find start_depth = refTable.indexOf(lastChar)
 *     2. Strip saltPrefix and saltSuffix (first and last chars)
 *     3. Reverse the transposition (same swap)
 *     4. Substitute each character backward through decTable, depth times,
 *        advancing depth using the DECODED char value after each step
 *
 *   Key insight:
 *     The salt characters are DERIVED from the filename content — they are
 *     not free parameters. encode(name) always produces exactly one encoded
 *     string, so getPackId() is always deterministic without any salt storage.
 *
 * Performance:
 *   encode() and decode() precompute per-call lookup tables for the
 *   substitution stage, eliminating the inner depth loop.
 */

const MAGIC_DEPTH = 32;

class FilenameCodec {

    constructor() {

        // encTable: forward substitution (KFileNameCipher.cpp encTable)
        this._encTable = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            103,32,0,38,119,44,108,78,88,79,0,55,46,37,101,0,56,95,93,35,80,49,
            45,36,86,91,0,89,0,94,0,0,75,125,106,48,64,71,83,41,65,120,121,54,
            57,69,70,123,87,98,61,82,118,116,104,50,52,77,40,107,0,109,97,43,
            126,68,39,67,33,74,73,100,66,85,96,113,102,112,72,81,51,76,110,111,
            90,105,114,115,117,59,122,99,0,84,53,0
        ]);

        // decTable: reverse substitution (KFileNameCipher.cpp decTable)
        this._decTable = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            33,100,0,51,55,45,35,98,90,71,0,95,37,54,44,0,67,53,87,112,88,126,
            75,43,48,76,0,121,0,82,0,0,68,72,104,99,97,77,78,69,110,102,101,64,
            113,89,39,41,52,111,83,70,125,105,56,80,40,59,116,57,0,50,61,49,
            106,94,81,123,103,46,108,32,86,117,66,91,38,93,114,115,109,107,118,
            119,85,120,84,36,73,74,122,79,0,65,96,0
        ]);

        // refTable: maps start_depth → saltSuffix, and provides parity alphabet
        // (KFileNameCipher.cpp refTable)
        this._refTable = "^&T_Nsd{xo5v`rOYV+,iIU#kCJq8$'~L0P]FeBn-Au(pXHZhwDy2}agWG7K=bQ;SRt)46l@jE%9!c1[3fmMz";

        // Precompute encTable and decTable chains for all depths 1..MAGIC_DEPTH
        // encChain[depth][c] = result of applying encTable 'depth' times to c
        // decChain[depth][c] = result of applying decTable 'depth' times to c
        this._encChain = [];
        this._decChain = [];
        for (let d = 0; d <= MAGIC_DEPTH; d++) {
            const eRow = new Uint8Array(128);
            const dRow = new Uint8Array(128);
            for (let c = 0; c < 128; c++) {
                let ev = c, dv = c;
                for (let j = 0; j < d; j++) {
                    ev = this._encTable[ev] || ev;
                    dv = this._decTable[dv] || dv;
                }
                eRow[c] = ev;
                dRow[c] = dv;
            }
            this._encChain.push(eRow);
            this._decChain.push(dRow);
        }
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * GetStartDepth from KFileNameCipher.cpp.
     * Computes the initial substitution depth from the plaintext filename.
     * @param {string} lower - Lowercased filename
     * @returns {number} depth in range [1, MAGIC_DEPTH]
     */
    _getStartDepth(lower) {
        let key = 0;
        for (let i = 0; i < lower.length; i++) {
            key += 17 * lower.charCodeAt(i) + 1;
        }
        key += lower.length;
        let ret = key % MAGIC_DEPTH;
        if (ret === 0) ret = MAGIC_DEPTH;
        return ret;
    }

    /**
     * GetParityChar from KFileNameCipher.cpp.
     * Checksum of the encoded inner string bytes, mapped into refTable.
     * @param {string} inner - Encoded inner string (no salt chars)
     * @returns {string} single parity character
     */
    _getParityChar(inner) {
        let key = 0;
        for (let i = 0; i < inner.length; i++) {
            key += inner.charCodeAt(i);
        }
        return this._refTable[key % this._refTable.length];
    }

    /**
     * Transposition: swap [0]↔[66%] and [1]↔[33%].
     * Same operation for both encode and decode (self-inverse).
     * @param {string[]} arr
     */
    _swapChars(arr) {
        if (arr.length <= 4) return;
        const len  = arr.length;
        const i66  = Math.floor(len * 0.66);
        const i33  = Math.floor(len * 0.33);
        const t0   = arr[0];
        const t1   = arr[1];
        arr[0]   = arr[i66];
        arr[1]   = arr[i33];
        arr[i66] = t0;
        arr[i33] = t1;
    }

    // ---------------------------------------------------------------------------
    // Encode
    // ---------------------------------------------------------------------------

    /**
     * Encode a human-readable filename into the obfuscated format used in data.000.
     *
     * The salt characters are fully determined by the filename content —
     * this function always produces exactly one output for a given input.
     *
     * @param {string} filename - Decoded filename e.g. 'hero.dds'
     * @returns {string} Encoded string in latin1 encoding
     */
    encode(filename) {
        if (!filename) return '';

        const lower = filename.toLowerCase();
        const arr   = lower.split('');
        const len   = arr.length;

        const startDepth = this._getStartDepth(lower);
        let depth = startDepth;

        for (let i = 0; i < len; i++) {
            const c   = arr[i].charCodeAt(0);
            arr[i]    = String.fromCharCode(this._encChain[depth][c] || c);

            // Advance depth using original char
            depth = (depth + c * 17 + 1) % MAGIC_DEPTH;
            if (depth === 0) depth = MAGIC_DEPTH;
        }

        // Transposition
        this._swapChars(arr);

        const inner      = arr.join('');
        const saltSuffix = this._refTable[startDepth];
        const saltPrefix = this._getParityChar(inner);

        return saltPrefix + inner + saltSuffix;
    }

    // ---------------------------------------------------------------------------
    // Decode
    // ---------------------------------------------------------------------------

    /**
     * Decode an obfuscated encoded string from data.000 into a human-readable filename.
     *
     * @param {string} hash - Encoded string in latin1 encoding
     * @returns {string} Decoded filename e.g. 'hero.dds'
     */
    decode(hash) {
        if (!hash || hash.length < 3) return '';

        // Find start_depth from the salt suffix (last character)
        const lastChar   = hash[hash.length - 1];
        let depth = this._refTable.indexOf(lastChar);
        if (depth <= 0) return '';

        // Strip salt prefix and suffix
        const arr = hash.slice(1, -1).split('');
        const len = arr.length;

        // Reverse transposition
        this._swapChars(arr);

        for (let i = 0; i < len; i++) {
            const c   = arr[i].charCodeAt(0);
            const dec = this._decChain[depth][c] || c;
            arr[i]    = String.fromCharCode(dec);

            // Advance depth using decoded char
            depth = (depth + dec * 17 + 1) % MAGIC_DEPTH;
            if (depth === 0) depth = MAGIC_DEPTH;
        }

        return arr.join('');
    }

    // ---------------------------------------------------------------------------
    // Pack ID
    // ---------------------------------------------------------------------------

    /**
     * Determine which data.001--.008 pack file contains a given asset.
     * Uses a deterministic SDBM-style hash of the full encoded string.
     *
     * @param {string} encodedStr - Full encoded string including salt chars (latin1)
     * @returns {number} Pack file slot — integer 1 through 8 inclusive
     */
    getPackId(encodedStr) {
        const bytes = Buffer.from(encodedStr.toLowerCase(), 'latin1');
        let num = 0;
        for (let i = 0; i < bytes.length; i++) {
            num = (((num << 5) - num) + bytes[i]) | 0;
        }
        if (num < 0) num = Math.abs(num);
        return (num % 8) + 1;
    }

}

module.exports = FilenameCodec;

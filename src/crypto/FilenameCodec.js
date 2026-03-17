'use strict';

/**
 * FilenameCodec
 * src/crypto/FilenameCodec.js
 *
 * Encodes and decodes the obfuscated filename strings stored in data.000.
 * Also determines which data.001--.008 pack file a given asset belongs to
 * via a deterministic SDBM-style hash.
 *
 * The codec is stateless — all methods are pure functions of their inputs.
 *
 * Note: filenames in this format are flat — no directory structure.
 * Path separators do not appear in real pack filenames.
 *
 * Algorithm summary:
 *   Decode: strip salt chars → swap two positions → substitution cipher → readable filename
 *   Encode: substitution cipher (forward) → swap two positions → wrap with salt chars
 *
 * Performance:
 *   All substitution tables are precomputed at construction time.
 *   decode() uses a 85x256 lookup table that eliminates the inner substitution
 *   loop entirely, reducing parse time for 124k entries from ~10s to ~166ms.
 */

class FilenameCodec {

    constructor() {

        // xor2: Character substitution table.
        // Encode uses direct index lookup; decode uses _reverseXor2 (precomputed below).
        this._xor2 = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            103,32,0,38,119,44,108,78,88,79,0,55,46,37,101,0,56,95,93,35,80,49,
            45,36,86,91,0,89,0,94,0,0,75,125,106,48,64,71,83,41,65,120,121,54,
            57,69,70,123,87,98,61,82,118,116,104,50,52,77,40,107,0,109,97,43,
            126,68,39,67,33,74,73,100,66,85,96,113,102,112,72,81,51,76,110,111,
            90,105,114,115,117,59,122,99,0,84,53,0
        ]);

        // xor3: Seed table — determines the initial rolling key (num4) for each
        // string based on its last (salt suffix) character.
        this._xor3 = new Uint8Array([
            94,38,84,95,78,115,100,123,120,111,53,118,96,114,79,89,86,43,44,105,
            73,85,35,107,67,74,113,56,36,39,126,76,48,80,93,70,101,66,110,45,65,
            117,40,112,88,72,90,104,119,68,121,50,125,97,103,87,71,55,75,61,98,
            81,59,83,82,116,41,52,54,108,64,106,69,37,57,33,99,49,91,51,102,109,
            77,122,0
        ]);

        // reverseXor2[encodedChar] -> originalChar, or -1 if not mappable.
        // Replaces xor2.indexOf() O(n) scan with O(1) array access.
        this._reverseXor2 = new Int16Array(256).fill(-1);
        for (let i = 0; i < this._xor2.length; i++) {
            if (this._xor2[i] !== 0) this._reverseXor2[this._xor2[i]] = i;
        }

        // reverseXor3[charCode] -> index in xor3, or -1 if not present.
        // Replaces xor3.indexOf() with O(1) access for the seed lookup.
        this._reverseXor3 = new Int16Array(256).fill(-1);
        for (let i = 0; i < this._xor3.length; i++) {
            this._reverseXor3[this._xor3[i]] = i;
        }

        // decodeTable[num4][charCode] -> decoded charCode after num4 reverse-substitutions.
        // num4 ranges 0 to xor3.length-1 (0-84) for the first character of each string,
        // then 1-32 for all subsequent characters.
        // Precomputing this eliminates the inner j-loop entirely at decode time.
        const TABLE_ROWS = this._xor3.length; // 85 rows
        this._decodeTable = [];
        for (let num4 = 0; num4 < TABLE_ROWS; num4++) {
            const row = new Int16Array(256);
            for (let charCode = 0; charCode < 256; charCode++) {
                let num3 = charCode;
                if (num3 < this._xor2.length && this._xor2[num3] !== 0) {
                    for (let j = 0; j < num4; j++) {
                        const n5 = this._reverseXor2[num3];
                        if (n5 !== -1) num3 = n5;
                    }
                }
                row[charCode] = num3 & 0xFFFF;
            }
            this._decodeTable.push(row);
        }

        // Shared scratch buffer for decode() — avoids a TypedArray allocation per call.
        // Safe because filenames are short (< 256 chars) and all calls are synchronous.
        this._scratch = new Uint16Array(256);
    }

    // ---------------------------------------------------------------------------
    // Decode
    // ---------------------------------------------------------------------------

    /**
     * Decodes an obfuscated hash string from data.000 into a human-readable filename.
     *
     * @param {string} hash - The raw encoded string read from data.000 (latin1).
     * @returns {string} The decoded filename e.g. "hero.dds"
     */
    decode(hash) {
        if (!hash || hash.length === 0) return '';

        const len = hash.length - 2; // strip salt prefix and suffix
        if (len <= 0) return '';

        // Load inner characters into shared scratch buffer
        for (let i = 0; i < len; i++) {
            this._scratch[i] = hash.charCodeAt(i + 1);
        }

        // Transposition — swap positions at 33% and 66% of string length
        if (len > 4) {
            const num  = Math.floor(0.3300000131130219 * len);
            const num2 = Math.floor(0.6600000262260437 * len);
            const c2   = this._scratch[num2];
            const c    = this._scratch[num];
            this._scratch[num2] = this._scratch[0];
            this._scratch[num]  = this._scratch[1];
            this._scratch[0]    = c2;
            this._scratch[1]    = c;
        }

        // Seed the rolling key from the salt suffix character (last char of hash)
        const lastCharByte = hash.charCodeAt(hash.length - 1);
        let num4 = this._reverseXor3[lastCharByte] !== -1
            ? this._reverseXor3[lastCharByte]
            : 0;

        // Substitution — O(1) per character via precomputed decode table
        for (let i = 0; i < len; i++) {
            const decoded        = this._decodeTable[num4][this._scratch[i]];
            this._scratch[i]     = decoded;
            num4                 = ((1 + num4 + 17 * decoded) & 31) || 32;
        }

        return String.fromCharCode.apply(null, this._scratch.subarray(0, len));
    }

    // ---------------------------------------------------------------------------
    // Encode
    // ---------------------------------------------------------------------------

    /**
     * Encodes a human-readable filename into the obfuscated hash format
     * used in data.000. This is the exact inverse of decode().
     *
     * @param {string} filename    - The decoded filename e.g. "hero.dds"
     * @param {string} saltPrefix  - Salt character prepended to the result (default 'a')
     * @param {string} saltSuffix  - Salt character appended to the result (default 'z')
     * @returns {string} The encoded hash string ready for writing to data.000
     */
    encode(filename, saltPrefix = 'a', saltSuffix = 'z') {
        if (!filename) return '';

        let array = filename.split('');

        // Seed rolling key from salt suffix — same logic as decode
        const suffixCharByte = saltSuffix.charCodeAt(0);
        let num4 = this._reverseXor3[suffixCharByte] !== -1
            ? this._reverseXor3[suffixCharByte]
            : 0;

        for (let i = 0; i < array.length; i++) {
            const originalCharByte = array[i].charCodeAt(0) & 0xFFFF;
            let charToEncode       = originalCharByte;

            // Only substitute if this character has a valid mapping in xor2.
            // Characters where xor2[char] === 0 pass through unchanged.
            if (originalCharByte < this._xor2.length && this._xor2[originalCharByte] !== 0) {
                for (let j = 0; j < num4; j++) {
                    if (charToEncode < this._xor2.length) {
                        charToEncode = this._xor2[charToEncode];
                    }
                }
            }

            // Advance rolling key using the ORIGINAL byte value (not the encoded one)
            num4         = ((1 + num4 + 17 * originalCharByte) & 31) || 32;
            array[i]     = String.fromCharCode(charToEncode & 0xFFFF);
        }

        // Transposition — same swap as decode
        if (array.length > 4) {
            const num  = Math.floor(0.3300000131130219 * array.length);
            const num2 = Math.floor(0.6600000262260437 * array.length);
            const c0   = array[0];
            const c1   = array[1];
            array[0]    = array[num2];
            array[1]    = array[num];
            array[num2] = c0;
            array[num]  = c1;
        }

        return saltPrefix + array.join('') + saltSuffix;
    }

    // ---------------------------------------------------------------------------
    // Pack ID
    // ---------------------------------------------------------------------------

    /**
     * Determines which data.001--.008 pack file contains a given asset.
     * Uses a deterministic SDBM-style hash of the encoded filename string.
     *
     * @param {string} encodedHash - The raw encoded string from data.000 (latin1).
     * @returns {number} Pack file slot — integer between 1 and 8 inclusive.
     */
    getPackId(encodedHash) {
        const bytes = Buffer.from(encodedHash.toLowerCase(), 'latin1');
        let num = 0;
        for (let i = 0; i < bytes.length; i++) {
            num = (((num << 5) - num) + bytes[i]) | 0;
        }
        if (num < 0) num = Math.abs(num);
        return (num % 8) + 1;
    }

}

module.exports = FilenameCodec;

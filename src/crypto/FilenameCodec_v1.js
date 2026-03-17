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
 * Path separators ('/' and '\') do not appear in real pack filenames.
 * The substitution table does not cover them, so they pass through unchanged
 * if ever encountered — but in practice they will not be.
 *
 * Algorithm summary:
 *   Decode: strip salt chars → swap two positions → substitution cipher (xor2) → readable filename
 *   Encode: substitution cipher (xor2 forward) → swap two positions → wrap with salt chars
 */

class FilenameCodec {

    constructor() {

        // xor2: Substitution table for the character encoding stage.
        // Decode uses indexOf() to reverse-map; encode uses direct index lookup.
        this._xor2 = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            103,32,0,38,119,44,108,78,88,79,0,55,46,37,101,0,56,95,93,35,80,49,
            45,36,86,91,0,89,0,94,0,0,75,125,106,48,64,71,83,41,65,120,121,54,
            57,69,70,123,87,98,61,82,118,116,104,50,52,77,40,107,0,109,97,43,
            126,68,39,67,33,74,73,100,66,85,96,113,102,112,72,81,51,76,110,111,
            90,105,114,115,117,59,122,99,0,84,53,0
        ]);

        // xor3: Seed table — determines the initial rolling key (num4) for
        // each string based on the string's last (salt suffix) character.
        this._xor3 = new Uint8Array([
            94,38,84,95,78,115,100,123,120,111,53,118,96,114,79,89,86,43,44,105,
            73,85,35,107,67,74,113,56,36,39,126,76,48,80,93,70,101,66,110,45,65,
            117,40,112,88,72,90,104,119,68,121,50,125,97,103,87,71,55,75,61,98,
            81,59,83,82,116,41,52,54,108,64,106,69,37,57,33,99,49,91,51,102,109,
            77,122,0
        ]);
    }

    /**
     * Decodes an obfuscated hash string from data.000 into a human-readable filename.
     *
     * Steps:
     *  1. Strip the first and last characters (salt prefix and suffix)
     *  2. Swap characters at 33% and 66% positions (transposition)
     *  3. Run each character through the xor2 substitution table N times,
     *     where N is a rolling key derived from the previous decoded character
     *
     * @param {string} hash - The raw encoded string read from data.000 (latin1).
     * @returns {string} The decoded filename e.g. "character/hero.dds"
     */
    decode(hash) {
        if (!hash || hash.length === 0) return '';

        // 1. Strip salt prefix and suffix characters
        let array = hash.slice(1, -1).split('');

        // 2. Transposition — swap positions at 33% and 66% of string length
        if (array.length > 4) {
            const num  = Math.floor(0.3300000131130219 * array.length);
            const num2 = Math.floor(0.6600000262260437 * array.length);

            const charAtNum2 = array[num2];
            const charAtNum  = array[num];

            array[num2] = array[0];
            array[num]  = array[1];
            array[0]    = charAtNum2;
            array[1]    = charAtNum;
        }

        // 3. Substitution — rolling key initialised from the salt suffix character
        const lastCharByte = hash.charCodeAt(hash.length - 1);
        let num3 = this._xor3.indexOf(lastCharByte);
        let num4 = num3;

        for (let i = 0; i < array.length; i++) {
            num3 = array[i].charCodeAt(0);

            // Only run the substitution if this character has a valid mapping in xor2.
            // Characters where xor2[char] === 0 (e.g. '/', '\') are not in the
            // substitution table and pass through unchanged. Without this guard,
            // indexOf(0) returns the wrong index and corrupts the rolling key state
            // for every character that follows.
            if (num3 < this._xor2.length && this._xor2[num3] !== 0) {
                for (let j = 0; j < num4; j++) {
                    const num5 = this._xor2.indexOf(num3);
                    if (num5 !== -1) num3 = num5;
                }
            }
            // else: pass through — char is outside the substitution table

            array[i] = String.fromCharCode(num3 & 0xFFFF);

            // Advance rolling key using the decoded byte value
            let multiplier = 17 * num3;
            num4 = (1 + num4 + multiplier) & 31;
            if (num4 === 0) num4 = 32;
        }

        return array.join('');
    }

    /**
     * Encodes a human-readable filename into the obfuscated hash format
     * used in data.000.
     *
     * This is the exact inverse of decode():
     *  1. Substitution forward through xor2 (encode direction)
     *  2. Swap characters at 33% and 66% positions (same transposition)
     *  3. Wrap with salt prefix and suffix characters
     *
     * @param {string} filename    - The decoded filename e.g. "character/hero.dds"
     * @param {string} saltPrefix  - Salt character prepended to the result (default 'a')
     * @param {string} saltSuffix  - Salt character appended to the result (default 'z')
     * @returns {string} The encoded hash string ready for writing to data.000
     */
    encode(filename, saltPrefix = 'a', saltSuffix = 'z') {
        if (!filename) return '';

        let array = filename.split('');

        // 1. Substitution — initialise rolling key from salt suffix (same as decode)
        const suffixCharByte = saltSuffix.charCodeAt(0);
        let num3 = this._xor3.indexOf(suffixCharByte);
        let num4 = num3;

        for (let i = 0; i < array.length; i++) {
            let originalCharByte = array[i].charCodeAt(0) & 0xFFFF;
            let charToEncode     = originalCharByte;

            // Only substitute if this character has a valid mapping in xor2.
            // Same pass-through rule as decode() — unmapped chars (e.g. '/', '\')
            // are stored as-is so decode() can recover them without ambiguity.
            if (originalCharByte < this._xor2.length && this._xor2[originalCharByte] !== 0) {
                for (let j = 0; j < num4; j++) {
                    if (charToEncode >= 0 && charToEncode < this._xor2.length) {
                        charToEncode = this._xor2[charToEncode];
                    }
                }
            }
            // else: pass through unchanged

            // Advance rolling key using the ORIGINAL (pre-encoded) byte value
            const multiplier = 17 * originalCharByte;
            let nextNum4 = (1 + num4 + multiplier) & 31;
            if (nextNum4 === 0) nextNum4 = 32;

            array[i] = String.fromCharCode(charToEncode & 0xFFFF);
            num4     = nextNum4;
        }

        // 2. Transposition — apply the same swap logic as decode
        if (array.length > 4) {
            const num  = Math.floor(0.3300000131130219 * array.length);
            const num2 = Math.floor(0.6600000262260437 * array.length);

            const charAt0 = array[0];
            const charAt1 = array[1];

            array[0]    = array[num2];
            array[1]    = array[num];
            array[num2] = charAt0;
            array[num]  = charAt1;
        }

        // 3. Wrap with salt characters
        return saltPrefix + array.join('') + saltSuffix;
    }

    /**
     * Determines which data.001--.008 pack file contains a given asset.
     * Uses a deterministic SDBM-style hash of the encoded filename string.
     *
     * This is called during index parsing — the encoded hash string (szHash)
     * from data.000 is passed in directly, before decoding.
     *
     * @param {string} encodedHash - The raw encoded string from data.000 (latin1).
     * @returns {number} Pack file slot — an integer between 1 and 8 inclusive.
     */
    getPackId(encodedHash) {
        // Normalise to lowercase — the hash function is case-insensitive
        const bytes = Buffer.from(encodedHash.toLowerCase(), 'latin1');
        let num = 0;

        for (let i = 0; i < bytes.length; i++) {
            // SDBM: hash = (hash * 31) + char, using bit-shift for performance.
            // '| 0' forces 32-bit signed integer overflow to match C# int behaviour.
            num = (((num << 5) - num) + bytes[i]) | 0;
        }

        // Ensure positive result before modulo mapping
        if (num < 0) num = Math.abs(num);

        // Map to 1-8 range
        return (num % 8) + 1;
    }

}

module.exports = FilenameCodec;

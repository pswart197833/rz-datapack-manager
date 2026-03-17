'use strict';
/**
 * FilenameCodec — corrected implementation derived from KFileNameCipher.cpp
 * test/diagnose-correct-codec.js
 *
 * The original C++ uses a completely different key derivation than the
 * current encode() implementation:
 *
 * CURRENT (wrong):
 *   - start_depth seeded from xor3.indexOf(saltSuffix)
 *   - salt characters are FREE PARAMETERS passed by caller
 *
 * CORRECT (from KFileNameCipher.cpp):
 *   - start_depth = GetStartDepth(filename) = (sum(17*c+1) + len) % 32, nonzero
 *   - saltSuffix  = refTable[start_depth]  — DERIVED, not a parameter
 *   - saltPrefix  = GetParityChar(encoded) — checksum of encoded inner string
 *
 * This means encode() takes only the filename and produces deterministic
 * salt characters. No salt storage is needed anywhere.
 *
 * Usage: node test/diagnose-correct-codec.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const DATA_DIR   = path.join(ROOT, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'data.000');

// ---------------------------------------------------------------------------
// Corrected FilenameCodec — matches KFileNameCipher.cpp exactly
// ---------------------------------------------------------------------------

class CorrectFilenameCodec {

    constructor() {
        // encTable from KFileNameCipher.cpp (xor2 in current code)
        this._encTable = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            103,32,0,38,119,44,108,78,88,79,0,55,46,37,101,0,56,95,93,35,80,49,
            45,36,86,91,0,89,0,94,0,0,75,125,106,48,64,71,83,41,65,120,121,54,
            57,69,70,123,87,98,61,82,118,116,104,50,52,77,40,107,0,109,97,43,
            126,68,39,67,33,74,73,100,66,85,96,113,102,112,72,81,51,76,110,111,
            90,105,114,115,117,59,122,99,0,84,53,0
        ]);

        // decTable from KFileNameCipher.cpp (reverse of encTable)
        this._decTable = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            33,100,0,51,55,45,35,98,90,71,0,95,37,54,44,0,67,53,87,112,88,126,
            75,43,48,76,0,121,0,82,0,0,68,72,104,99,97,77,78,69,110,102,101,64,
            113,89,39,41,52,111,83,70,125,105,56,80,40,59,116,57,0,50,61,49,
            106,94,81,123,103,46,108,32,86,117,66,91,38,93,114,115,109,107,118,
            119,85,120,84,36,73,74,122,79,0,65,96,0
        ]);

        // refTable from KFileNameCipher.cpp — used for salt suffix and parity
        this._refTable = "^&T_Nsd{xo5v`rOYV+,iIU#kCJq8$'~L0P]FeBn-Au(pXHZhwDy2}agWG7K=bQ;SRt)46l@jE%9!c1[3fmMz";

        this.MAGIC_DEPTH = 32;
    }

    // -------------------------------------------------------------------------
    // GetStartDepth — from KFileNameCipher.cpp
    // Computes the initial substitution depth from the PLAINTEXT filename.
    // This is the key difference from the current implementation.
    // -------------------------------------------------------------------------
    _getStartDepth(filename) {
        let key = 0;
        for (let i = 0; i < filename.length; i++) {
            key += 17 * filename.charCodeAt(i) + 1;
        }
        key += filename.length;
        let ret = key % this.MAGIC_DEPTH;
        if (ret === 0) ret = this.MAGIC_DEPTH;
        return ret;
    }

    // -------------------------------------------------------------------------
    // GetParityChar — from KFileNameCipher.cpp
    // Computes the salt prefix as a checksum of the encoded inner string.
    // -------------------------------------------------------------------------
    _getParityChar(encodedInner) {
        let key = 0;
        for (let i = 0; i < encodedInner.length; i++) {
            key += encodedInner.charCodeAt(i);
        }
        key = key % this._refTable.length;
        return this._refTable[key];
    }

    // -------------------------------------------------------------------------
    // ReverseString — from KFileNameCipher.cpp
    // Swaps [0]↔[66%] and [1]↔[33%] (same transposition, different framing)
    // -------------------------------------------------------------------------
    _swapChars(arr) {
        if (arr.length <= 4) return;
        const len  = arr.length;
        const idx1 = Math.floor(len * 0.66);
        const idx2 = Math.floor(len * 0.33);
        [arr[idx1], arr[0]] = [arr[0], arr[idx1]];
        [arr[idx2], arr[1]] = [arr[1], arr[idx2]];
    }

    // -------------------------------------------------------------------------
    // encode — matches KFileNameCipher::EncodeFileName exactly
    // -------------------------------------------------------------------------
    encode(filename) {
        if (!filename) return '';

        // C++ does tolower first
        const lower = filename.toLowerCase();
        const arr   = lower.split('');
        const len   = arr.length;

        const startDepth = this._getStartDepth(lower);
        let depth = startDepth;

        // Substitution — forward through encTable
        for (let i = 0; i < len; i++) {
            const c    = arr[i].charCodeAt(0);
            let   ret  = c;
            for (let j = 0; j < depth; j++) {
                ret = this._encTable[ret];
            }
            arr[i] = String.fromCharCode(ret);

            // Advance depth using ORIGINAL char (before encoding)
            depth = (depth + c * 17 + 1) % this.MAGIC_DEPTH;
            if (depth === 0) depth = this.MAGIC_DEPTH;
        }

        // Salt suffix = refTable[startDepth]
        const saltSuffix = this._refTable[startDepth];

        // Swap characters (transposition)
        this._swapChars(arr);

        // Salt prefix = parity checksum of encoded inner string
        const inner      = arr.join('');
        const saltPrefix = this._getParityChar(inner);

        return saltPrefix + inner + saltSuffix;
    }

    // -------------------------------------------------------------------------
    // decode — matches KFileNameCipher::DecodeFileName exactly
    // -------------------------------------------------------------------------
    decode(hash) {
        if (!hash || hash.length === 0) return '';

        // Find start_depth from the suffix character (last char of encoded string)
        const lastChar = hash[hash.length - 1];
        let depth = this._refTable.indexOf(lastChar);
        if (depth === 0) return ''; // invalid

        // Strip salt prefix and suffix
        const inner = hash.slice(1, -1);
        const arr   = inner.split('');

        // Reverse the transposition
        this._swapChars(arr);

        const len = arr.length;

        // Substitution — reverse through decTable
        for (let i = 0; i < len; i++) {
            const encoded = arr[i].charCodeAt(0);
            let   ret     = encoded;
            for (let j = 0; j < depth; j++) {
                ret = this._decTable[ret];
            }
            arr[i] = String.fromCharCode(ret);

            // Advance depth using DECODED char
            depth = (depth + ret * 17 + 1) % this.MAGIC_DEPTH;
            if (depth === 0) depth = this.MAGIC_DEPTH;
        }

        return arr.join('');
    }

    // -------------------------------------------------------------------------
    // getPackId — unchanged (SDBM hash on full encoded string)
    // -------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// XOR cipher (unchanged — correct in current impl)
// ---------------------------------------------------------------------------
const XOR1 = new Uint8Array([
    0x77,0xE8,0x5E,0xEC,0xB7,0x4E,0xC1,0x87,0x4F,0xE6,0xF5,0x3C,0x1F,0xB3,0x15,0x43,
    0x6A,0x49,0x30,0xA6,0xBF,0x53,0xA8,0x35,0x5B,0xE5,0x9E,0x0E,0x41,0xEC,0x22,0xB8,
    0xD4,0x80,0xA4,0x8C,0xCE,0x65,0x13,0x1D,0x4B,0x08,0x5A,0x6A,0xBB,0x6F,0xAD,0x25,
    0xB8,0xDD,0xCC,0x77,0x30,0x74,0xAC,0x8C,0x5A,0x4A,0x9A,0x9B,0x36,0xBC,0x53,0x0A,
    0x3C,0xF8,0x96,0x0B,0x5D,0xAA,0x28,0xA9,0xB2,0x82,0x13,0x6E,0xF1,0xC1,0x93,0xA9,
    0x9E,0x5F,0x20,0xCF,0xD4,0xCC,0x5B,0x2E,0x16,0xF5,0xC9,0x4C,0xB2,0x1C,0x57,0xEE,
    0x14,0xED,0xF9,0x72,0x97,0x22,0x1B,0x4A,0xA4,0x2E,0xB8,0x96,0xEF,0x4B,0x3F,0x8E,
    0xAB,0x60,0x5D,0x7F,0x2C,0xB8,0xAD,0x43,0xAD,0x76,0x8F,0x5F,0x92,0xE6,0x4E,0xA7,
    0xD4,0x47,0x19,0x6B,0x69,0x34,0xB5,0x0E,0x62,0x6D,0xA4,0x52,0xB9,0xE3,0xE0,0x64,
    0x43,0x3D,0xE3,0x70,0xF5,0x90,0xB3,0xA2,0x06,0x42,0x02,0x98,0x29,0x50,0x3F,0xFD,
    0x97,0x58,0x68,0x01,0x8C,0x1E,0x0F,0xEF,0x8B,0xB3,0x41,0x44,0x96,0x21,0xA8,0xDA,
    0x5E,0x8B,0x4A,0x53,0x1B,0xFD,0xF5,0x21,0x3F,0xF7,0xBA,0x68,0x47,0xF9,0x65,0xDF,
    0x52,0xCE,0xE0,0xDE,0xEC,0xEF,0xCD,0x77,0xA2,0x0E,0xBC,0x38,0x2F,0x64,0x12,0x8D,
    0xF0,0x5C,0xE0,0x0B,0x59,0xD6,0x2D,0x99,0xCD,0xE7,0x01,0x15,0xE0,0x67,0xF4,0x32,
    0x35,0xD4,0x11,0x21,0xC3,0xDE,0x98,0x65,0xED,0x54,0x9D,0x1C,0xB9,0xB0,0xAA,0xA9,
    0x0C,0x8A,0xB4,0x66,0x60,0xE1,0xFF,0x2E,0xC8,0x00,0x43,0xA9,0x67,0x37,0xDB,0x9C
]);

function xorDecrypt(buf, index) {
    for (let i = 0; i < buf.length; i++) {
        buf[i] ^= XOR1[index % 256];
        index = (index + 1) % 256;
    }
    return index;
}

// ---------------------------------------------------------------------------
// Parse data.000 with XOR cipher, return raw szHash + parsed data
// ---------------------------------------------------------------------------
function parseIndex() {
    const buf     = fs.readFileSync(INDEX_PATH);
    const entries = [];
    let ci = 0, bo = 0;

    while (bo < buf.length) {
        const lenBuf = buf.slice(bo, bo + 1);
        ci = xorDecrypt(lenBuf, ci); bo++;
        const nStrLen = lenBuf[0];

        const hashBuf = buf.slice(bo, bo + nStrLen);
        ci = xorDecrypt(hashBuf, ci); bo += nStrLen;

        const metaBuf = buf.slice(bo, bo + 8);
        ci = xorDecrypt(metaBuf, ci); bo += 8;

        const szHash  = Buffer.from(hashBuf).toString('latin1');
        const offset  = metaBuf.readUInt32LE(0);
        const size    = metaBuf.readUInt32LE(4);

        entries.push({ szHash, offset, size });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CHECK = [
    'game_panel_image_worldmap_over_all.bmp',
    'm002_001.bmp',
    'm003_000.bmp',
    'm003_001.bmp',
    'waterbump.bmp',
    'npcinfo.cfg',
];

(async () => {
try {

const codec = new CorrectFilenameCodec();

console.log('\n  Correct Codec Test (based on KFileNameCipher.cpp)');
console.log('  ' + '═'.repeat(60));

// ----------------------------------------------------------------
// [1] Round-trip encode/decode on known names
// ----------------------------------------------------------------
console.log('\n  [1] encode → decode round-trip\n');
let rtPass = 0, rtFail = 0;
for (const name of CHECK) {
    const encoded = codec.encode(name);
    const decoded = codec.decode(encoded);
    const ok      = decoded === name.toLowerCase();
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) console.log(`      encoded: ${Buffer.from(encoded,'latin1').toString('hex').slice(0,24)}...`);
    if (!ok) console.log(`      decoded: "${decoded}" (expected "${name.toLowerCase()}")`);
    ok ? rtPass++ : rtFail++;
}

// ----------------------------------------------------------------
// [2] Parse data.000 and compare encode(decoded) against original szHash
// ----------------------------------------------------------------
console.log('\n  [2] Parsing data.000 and comparing encode(decode(szHash)) vs szHash\n');

const entries = parseIndex();
console.log(`      ${entries.length.toLocaleString()} entries parsed.\n`);

// Build map by decoding each szHash
const entryMap = new Map();
for (const e of entries) {
    const decoded = codec.decode(e.szHash);
    entryMap.set(decoded, e);
}

let hashMatchPass = 0, hashMatchFail = 0;
for (const name of CHECK) {
    const e = entryMap.get(name.toLowerCase()) || entryMap.get(name);
    if (!e) { console.log(`  [?] ${name} — not found after decode`); continue; }

    const reEncoded    = codec.encode(name);
    const hashMatch    = reEncoded === e.szHash;
    const packIdOrig   = codec.getPackId(e.szHash);
    const packIdReEnc  = codec.getPackId(reEncoded);
    const packIdMatch  = packIdOrig === packIdReEnc;

    console.log(`  ${hashMatch ? '✓' : '✗'} ${name}`);
    console.log(`      original szHash (hex): ${Buffer.from(e.szHash,'latin1').toString('hex').slice(0,24)}...`);
    console.log(`      re-encoded     (hex):  ${Buffer.from(reEncoded,'latin1').toString('hex').slice(0,24)}...`);
    console.log(`      hash match:   ${hashMatch ? 'YES' : 'NO'}`);
    console.log(`      packId orig:  ${packIdOrig}  re-encoded: ${packIdReEnc}  ${packIdMatch ? '✓' : '✗ MISMATCH'}`);
    console.log('');
    hashMatch ? hashMatchPass++ : hashMatchFail++;
}

// ----------------------------------------------------------------
// [3] Statistical check — what % of all entries re-encode correctly
// ----------------------------------------------------------------
console.log('  [3] Statistical: re-encode all entries and check hash match\n');

let totalMatch   = 0;
let totalFail    = 0;
let packIdMatch  = 0;
let packIdFail   = 0;

for (const e of entries) {
    const decoded   = codec.decode(e.szHash);
    const reEncoded = codec.encode(decoded);
    const hm        = reEncoded === e.szHash;
    const pm        = codec.getPackId(reEncoded) === codec.getPackId(e.szHash);
    if (hm) totalMatch++; else totalFail++;
    if (pm) packIdMatch++; else packIdFail++;
}

const total = entries.length;
console.log(`      Hash byte-identical:  ${totalMatch.toLocaleString()} / ${total.toLocaleString()} (${(totalMatch/total*100).toFixed(2)}%)`);
console.log(`      Hash differs:         ${totalFail.toLocaleString()}`);
console.log(`      PackId matches:       ${packIdMatch.toLocaleString()} / ${total.toLocaleString()} (${(packIdMatch/total*100).toFixed(2)}%)`);
console.log(`      PackId differs:       ${packIdFail.toLocaleString()}`);

if (totalFail > 0) {
    console.log('\n  First 5 hash mismatches:');
    let shown = 0;
    for (const e of entries) {
        if (shown >= 5) break;
        const decoded   = codec.decode(e.szHash);
        const reEncoded = codec.encode(decoded);
        if (reEncoded !== e.szHash) {
            console.log(`      "${decoded}"`);
            console.log(`        orig: ${Buffer.from(e.szHash,'latin1').toString('hex').slice(0,24)}...`);
            console.log(`        renc: ${Buffer.from(reEncoded,'latin1').toString('hex').slice(0,24)}...`);
            shown++;
        }
    }
}

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
console.log('\n  ' + '─'.repeat(60));
console.log(`  Round-trip decode(encode(name)): ${rtPass} pass / ${rtFail} fail`);
console.log(`  Hash re-encode match:            ${hashMatchPass} pass / ${hashMatchFail} fail (checked samples)`);
console.log(`  All entries packId correct:      ${packIdFail === 0 ? 'YES ✓' : `NO — ${packIdFail} mismatches`}`);

if (totalMatch === total) {
    console.log('\n  ✓ CONFIRMED: Correct codec produces byte-identical re-encoding.');
    console.log('    No salt storage needed. encode(decodedName) is deterministic.');
} else if (packIdFail === 0) {
    console.log('\n  ~ PackIds all correct, hashes not byte-identical.');
    console.log('    This is sufficient for reconstruction but not byte-identical index.');
} else {
    console.log('\n  ✗ Still failing. Further investigation needed.');
}

console.log('\n  Done.\n');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

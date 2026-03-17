'use strict';
/**
 * Reference vs Current — Encode/Decode/PackId comparison
 * test/diagnose-reference-codec.js
 *
 * Loads the reference RzClientDataIndexer implementation directly and
 * compares its encode(), decode(), and getFileID() against the current
 * FilenameCodec on the same real entries parsed from data.000.
 *
 * Key hypothesis to test:
 *   The reference encode() is called with the filename INCLUDING the pack
 *   digit appended as the last character (e.g. 'hero.dds3' for pack 3).
 *   The pack digit IS part of the decoded string — decode() returns it
 *   as the last character, not stripped.
 *
 * If this is true:
 *   - The salt is irrelevant for reconstruction
 *   - We encode as: codec.encode(decodedName + packId)
 *   - getFileID(encoded) will always match the original packId
 *   - No salt storage needed anywhere
 *
 * Usage: node test/diagnose-reference-codec.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const DATA_DIR   = path.join(ROOT, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'data.000');

// ---------------------------------------------------------------------------
// Inline the reference RzClientDataIndexer (codec parts only)
// ---------------------------------------------------------------------------

class ReferenceCodec {

    constructor() {
        this._xor2 = new Uint8Array([
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
            103,32,0,38,119,44,108,78,88,79,0,55,46,37,101,0,56,95,93,35,80,49,
            45,36,86,91,0,89,0,94,0,0,75,125,106,48,64,71,83,41,65,120,121,54,
            57,69,70,123,87,98,61,82,118,116,104,50,52,77,40,107,0,109,97,43,
            126,68,39,67,33,74,73,100,66,85,96,113,102,112,72,81,51,76,110,111,
            90,105,114,115,117,59,122,99,0,84,53,0
        ]);

        this._xor3 = new Uint8Array([
            94,38,84,95,78,115,100,123,120,111,53,118,96,114,79,89,86,43,44,105,
            73,85,35,107,67,74,113,56,36,39,126,76,48,80,93,70,101,66,110,45,65,
            117,40,112,88,72,90,104,119,68,121,50,125,97,103,87,71,55,75,61,98,
            81,59,83,82,116,41,52,54,108,64,106,69,37,57,33,99,49,91,51,102,109,
            77,122,0
        ]);

        this._xor1 = new Uint8Array([
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
    }

    cipherSingleByte(byteValue, index) {
        const decrypted = byteValue ^ this._xor1[index];
        const nextIndex = (index + 1) % this._xor1.length;
        return { decrypted, nextIndex };
    }

    cipherMultiByte(buffer, index) {
        for (let i = 0; i < buffer.length; i++) {
            const result = this.cipherSingleByte(buffer[i], index);
            buffer[i] = result.decrypted;
            index = result.nextIndex;
        }
        return index;
    }

    decode(hash) {
        if (!hash || hash.length === 0) return '';
        let array = hash.slice(1, -1).split('');

        if (array.length > 4) {
            let num  = Math.floor(0.3300000131130219 * array.length);
            let num2 = Math.floor(0.6600000262260437 * array.length);
            let charAtNum2 = array[num2];
            let charAtNum  = array[num];
            array[num2] = array[0];
            array[num]  = array[1];
            array[0]    = charAtNum2;
            array[1]    = charAtNum;
        }

        const lastCharByte = hash.charCodeAt(hash.length - 1);
        let num3 = this._xor3.indexOf(lastCharByte);
        let num4 = num3;

        for (let i = 0; i < array.length; i++) {
            num3 = array[i].charCodeAt(0);
            for (let j = 0; j < num4; j++) {
                let num5 = this._xor2.indexOf(num3);
                if (num5 !== -1) { num3 = num5; } else { num3 = -1; }
            }
            array[i] = String.fromCharCode(num3 & 0xFFFF);

            let multiplier = 17 * num3;
            num4 = (1 + num4 + multiplier) & 31;
            if (num4 === 0) num4 = 32;
        }

        return array.join('');
    }

    encode(filename, saltPrefix = 'a', saltSuffix = 'z') {
        if (!filename) return '';
        let array = filename.split('');

        const suffixCharByte = saltSuffix.charCodeAt(0);
        let num3 = this._xor3.indexOf(suffixCharByte);
        let num4 = num3;

        for (let i = 0; i < array.length; i++) {
            let originalCharByte = array[i].charCodeAt(0) & 0xFFFF;
            let charToEncode     = originalCharByte;

            for (let j = 0; j < num4; j++) {
                if (charToEncode >= 0 && charToEncode < this._xor2.length) {
                    charToEncode = this._xor2[charToEncode];
                }
            }

            let multiplier = 17 * originalCharByte;
            let nextNum4   = (1 + num4 + multiplier) & 31;
            if (nextNum4 === 0) nextNum4 = 32;

            array[i] = String.fromCharCode(charToEncode & 0xFFFF);
            num4     = nextNum4;
        }

        if (array.length > 4) {
            let num  = Math.floor(0.3300000131130219 * array.length);
            let num2 = Math.floor(0.6600000262260437 * array.length);
            let charAt0 = array[0];
            let charAt1 = array[1];
            array[0]    = array[num2];
            array[1]    = array[num];
            array[num2] = charAt0;
            array[num]  = charAt1;
        }

        return saltPrefix + array.join('') + saltSuffix;
    }

    getFileID(hash) {
        const bytes = Buffer.from(hash.toLowerCase(), 'latin1');
        let num = 0;
        for (let i = 0; i < bytes.length; i++) {
            num = (((num << 5) - num) + bytes[i]) | 0;
        }
        if (num < 0) num = Math.abs(num);
        return (num % 8) + 1;
    }
}

// ---------------------------------------------------------------------------
// Parse data.000 using the reference cipher (same as current)
// ---------------------------------------------------------------------------

function parseIndex(refCodec) {
    const buf     = fs.readFileSync(INDEX_PATH);
    const entries = [];
    let cipherIndex  = 0;
    let bufferOffset = 0;

    while (bufferOffset < buf.length) {
        let encLen = buf[bufferOffset];
        const r1   = refCodec.cipherSingleByte(encLen, cipherIndex);
        const nStrLen = r1.decrypted;
        cipherIndex   = r1.nextIndex;
        bufferOffset++;

        const szHashBuf = buf.slice(bufferOffset, bufferOffset + nStrLen);
        cipherIndex  = refCodec.cipherMultiByte(szHashBuf, cipherIndex);
        bufferOffset += nStrLen;

        const nValBuf = buf.slice(bufferOffset, bufferOffset + 8);
        cipherIndex  = refCodec.cipherMultiByte(nValBuf, cipherIndex);
        bufferOffset += 8;

        const szHash   = Buffer.from(szHashBuf).toString('latin1');
        const szName   = refCodec.decode(szHash);
        const nOffset  = Buffer.from(nValBuf).readUInt32LE(0);
        const nSize    = Buffer.from(nValBuf).readUInt32LE(4);
        const nFile    = refCodec.getFileID(szHash);

        entries.push({ szHash, szName, nOffset, nSize, nFile });
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

const ref = new ReferenceCodec();

console.log('\n  Reference Codec — Encode/Decode/PackId Test');
console.log('  ' + '═'.repeat(60));

// ----------------------------------------------------------------
// Parse data.000 with reference implementation
// ----------------------------------------------------------------
console.log('\n  [1] Parsing data.000 with reference codec...');
const entries  = parseIndex(ref);
const entryMap = new Map(entries.map(e => [e.szName, e]));
console.log(`      ${entries.length.toLocaleString()} entries parsed.\n`);

// ----------------------------------------------------------------
// Key question: does szName contain the packId as last character?
// ----------------------------------------------------------------
console.log('  [2] Examining decoded szName — does it include pack digit?\n');

for (const name of CHECK) {
    // The reference decode() does NOT strip anything after decoding —
    // check if the last char of szName is a digit matching nFile
    const e = entryMap.get(name);
    // Also try with pack digit appended
    const withDigit = name + e?.nFile;
    const foundWithDigit = entryMap.get(withDigit);

    console.log(`  ── ${name}`);
    if (e) {
        const lastChar    = e.szName.slice(-1);
        const lastCharCode = e.szName.charCodeAt(e.szName.length - 1);
        console.log(`      szName (decoded):          "${e.szName}"`);
        console.log(`      last char:                 '${lastChar}' (0x${lastCharCode.toString(16).padStart(2,'0')})`);
        console.log(`      nFile (from getFileID):    ${e.nFile}`);
        console.log(`      last char === nFile digit: ${lastChar === String(e.nFile)}`);
    } else {
        // Maybe it's stored with the digit
        console.log(`      NOT found as plain name — checking with digit suffix...`);
        if (foundWithDigit) {
            console.log(`      FOUND as "${withDigit}" — pack digit IS part of stored name`);
        } else {
            console.log(`      Not found either way.`);
        }
    }
    console.log('');
}

// ----------------------------------------------------------------
// Round-trip: encode(szName) should reproduce original szHash
// ----------------------------------------------------------------
console.log('  [3] Round-trip: ref.encode(szName) vs original szHash\n');

let roundTripPass = 0;
let roundTripFail = 0;

for (const name of CHECK) {
    const e = entryMap.get(name);
    if (!e) continue;

    // Attempt 1: encode the plain name (current approach, wrong salts)
    const reEncodedPlain  = ref.encode(e.szName);
    const plainMatches    = reEncodedPlain === e.szHash;
    const plainPackId     = ref.getFileID(reEncodedPlain);

    // Attempt 2: encode name with pack digit appended
    const nameWithDigit   = e.szName + e.nFile;
    const reEncodedDigit  = ref.encode(nameWithDigit);
    const digitMatches    = reEncodedDigit === e.szHash;
    const digitPackId     = ref.getFileID(reEncodedDigit);

    console.log(`  ── ${name}`);
    console.log(`      original szHash (hex):        ${Buffer.from(e.szHash,'latin1').toString('hex').slice(0,24)}...`);
    console.log(`      encode(szName) matches hash:  ${plainMatches ? '✓ YES' : '✗ NO'} → packId=${plainPackId} (orig=${e.nFile})`);
    console.log(`      encode(szName+digit) matches: ${digitMatches ? '✓ YES' : '✗ NO'} → packId=${digitPackId} (orig=${e.nFile})`);

    if (digitMatches) roundTripPass++; else roundTripFail++;
    console.log('');
}

// ----------------------------------------------------------------
// Statistical check: does szName always end with the nFile digit?
// ----------------------------------------------------------------
console.log('  [4] Statistical: across all entries, does szName end with nFile digit?\n');

let endsWithDigit  = 0;
let noDigitSuffix  = 0;
let mismatchDigit  = 0;

for (const e of entries) {
    const lastChar = e.szName.slice(-1);
    if (/^[1-8]$/.test(lastChar)) {
        if (parseInt(lastChar) === e.nFile) endsWithDigit++;
        else mismatchDigit++;
    } else {
        noDigitSuffix++;
    }
}

const total = entries.length;
console.log(`      szName ends with correct pack digit: ${endsWithDigit.toLocaleString()} / ${total.toLocaleString()} (${(endsWithDigit/total*100).toFixed(1)}%)`);
console.log(`      szName ends with wrong digit:        ${mismatchDigit.toLocaleString()}`);
console.log(`      szName does NOT end with digit:      ${noDigitSuffix.toLocaleString()}`);
console.log('');

if (endsWithDigit === total) {
    console.log('  ✓ CONFIRMED: decoded name always ends with pack digit.');
    console.log('    encode(szName) is the correct reconstruction — salts are irrelevant.');
    console.log('    The pack digit in the filename IS the packId. No salt storage needed.\n');
} else if (endsWithDigit > total * 0.9) {
    console.log('  ~ MOSTLY TRUE: most decoded names end with pack digit.');
    console.log('    Check the mismatches — may be zero-size or alias entries.\n');
} else {
    console.log('  ✗ NOT CONFIRMED: pack digit is not consistently the last char.\n');
}

// ----------------------------------------------------------------
// Show 5 sample entries to visualise the pattern
// ----------------------------------------------------------------
console.log('  [5] Sample entries (first 10 non-zero, various packs)\n');
console.log('      ' + 'szName'.padEnd(50) + 'lastChar  nFile  match');
console.log('      ' + '─'.repeat(70));

let shown = 0;
for (const e of entries) {
    if (e.nSize === 0) continue;
    if (shown >= 10) break;
    const lastChar = e.szName.slice(-1);
    const match    = lastChar === String(e.nFile);
    console.log(`      ${e.szName.padEnd(50)} '${lastChar}'       ${e.nFile}      ${match ? '✓' : '✗'}`);
    shown++;
}

console.log('\n  Done.\n');

} catch (err) {
    console.error('\n[ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
}
})();

'use strict';
const fs            = require('fs');
const path          = require('path');
const DataPackIndex = require('./src/core/DataPackIndex');

const ROOT     = path.join(__dirname);
const OUT_DIR  = path.join(ROOT, 'store', 'test-reconstruct', 'data');

const orig = new DataPackIndex();
orig.parse(fs.readFileSync(path.join(ROOT, 'data', 'data.000')));

const out = new DataPackIndex();
out.parse(fs.readFileSync(path.join(OUT_DIR, 'data.000')));

// Find zero-size entries in original
const zeroOrig = orig.entries.filter(e => e.size === 0);
console.log('Zero-size entries in ORIGINAL (' + zeroOrig.length + '):');
zeroOrig.forEach(e =>
    console.log('  ' + e.decodedName.padEnd(40) + ' packId=' + e.packId + ' offset=' + e.offset)
);

console.log('');
const zeroOut = out.entries.filter(e => e.size === 0);
console.log('Zero-size entries in OUTPUT (' + zeroOut.length + '):');
zeroOut.forEach(e =>
    console.log('  ' + e.decodedName.padEnd(40) + ' packId=' + e.packId + ' offset=' + e.offset)
);

// First 6 differences between indexes
let diffs = 0;
console.log('');
for (let i = 0; i < Math.min(orig.entries.length, out.entries.length); i++) {
    const o = orig.entries[i];
    const u = out.entries[i];
    if (o.decodedName !== u.decodedName || o.packId !== u.packId ||
        o.offset !== u.offset || o.size !== u.size) {
        if (diffs < 6) {
            console.log('Diff at [' + i + ']:');
            console.log('  orig: ' + o.decodedName + ' pack=' + o.packId + ' offset=' + o.offset + ' size=' + o.size);
            console.log('  out:  ' + u.decodedName + ' pack=' + u.packId + ' offset=' + u.offset + ' size=' + u.size);
        }
        diffs++;
    }
}
console.log('Total index diffs: ' + diffs);

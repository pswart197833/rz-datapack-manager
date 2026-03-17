
const fs     = require('fs');
const crypto = require('crypto');

for (let slot = 1; slot <= 8; slot++) {
    const outPack  = './store/test-reconstruct/data/data.00' + slot;
    const origPack = './data/data.00' + slot;

    if (!fs.existsSync(outPack)) continue;

    const outSize  = fs.statSync(outPack).size;
    const origSize = fs.statSync(origPack).size;

    const outHash  = crypto.createHash('sha256').update(fs.readFileSync(outPack)).digest('hex');
    const origHash = crypto.createHash('sha256').update(fs.readFileSync(origPack)).digest('hex');

    const match = outHash === origHash;
    console.log('data.00' + slot + ': ' + (match ? 'MATCH ✓' : 'DIFFER ✗'));
    if (!match) {
        console.log('  out  size: ' + outSize.toLocaleString());
        console.log('  orig size: ' + origSize.toLocaleString());
        console.log('  out  sha:  ' + outHash.slice(0, 32) + '...');
        console.log('  orig sha:  ' + origHash.slice(0, 32) + '...');
        // First differing byte
        const outBuf  = fs.readFileSync(outPack);
        const origBuf = fs.readFileSync(origPack);
        for (let i = 0; i < Math.min(outBuf.length, origBuf.length); i++) {
            if (outBuf[i] !== origBuf[i]) {
                console.log('  first diff at byte ' + i.toLocaleString() +
                    ': out=0x' + outBuf[i].toString(16).padStart(2,'0') +
                    ' orig=0x' + origBuf[i].toString(16).padStart(2,'0'));
                break;
            }
        }
    }
}

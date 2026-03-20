const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const checks = [
    'terrainseamlessworld.cfg',
'yellowbreadtree_shadow.dds',
'asm_dgo_skill2701_mantle.naf'
];

const FIXTURE_STORE = 'test/fixtures/store';
const lines = fs.readFileSync(path.join(FIXTURE_STORE, 'fingerprints.jsonl'), 'utf8')
.split('\n').filter(l => l.trim()).map((l, i) => ({ ...JSON.parse(l), lineNum: i+1 }));

for (const name of checks) {
    const all = lines.filter(r => r.decodedName === name);
    console.log(name, '— all JSONL lines:');
    for (const r of all) {
        const absPath = r.extractedPath
        ? (path.isAbsolute(r.extractedPath) ? r.extractedPath : path.join(FIXTURE_STORE, r.extractedPath))
        : null;
        const exists = absPath && fs.existsSync(absPath);
        let fileHash = null;
        if (exists) fileHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0,16);
        console.log('  line', r.lineNum, 'hash:', r.hash.slice(0,16), 'extractedPath:', r.extractedPath, 'fileExists:', exists, 'fileHash:', fileHash);
    }
    console.log('');
}

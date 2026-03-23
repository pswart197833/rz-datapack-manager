const crypto = require('crypto');
const fs = require('fs');
const Blueprint = require('../src/fingerprint/Blueprint');

const lines = fs.readFileSync('test/fixtures/store/fingerprints.jsonl','utf8')
.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
const packs = lines.filter(r=>r.type==='pack');

const bpDir = 'test/fixtures/store/blueprints';
const f = fs.readdirSync(bpDir)[0];
const bp = JSON.parse(fs.readFileSync(bpDir+'/'+f,'utf8'));
const dpFps = [...new Set(bp.records.map(r=>r.datapackFingerprint).filter(Boolean))];

packs.forEach(p => {
    const matchesDirect = dpFps.includes(p.hash);
    console.log(p.decodedName, '| matches:', matchesDirect);
});

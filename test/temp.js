const fs = require('fs');
const lines = fs.readFileSync('test/fixtures/store/fingerprints.jsonl','utf8')
.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));

// Find all records for the failing name
const name = 'ancientprieststorm_una_idle01_biped.naf';
const byName = lines.filter(r => r.decodedName === name);
console.log('Records for', name);
byName.forEach(r => console.log(' isAlias='+r.isAlias, 'aliasOf='+r.aliasOf, 'hash='+r.hash.slice(0,16)));

// Find all records sharing the same hash
if (byName.length > 0) {
    const hash = byName[0].hash;
    const byHash = lines.filter(r => r.hash === hash);
    console.log('\nAll records with hash', hash.slice(0,16)+'...');
    byHash.forEach(r => console.log(' name='+r.decodedName, 'isAlias='+r.isAlias, 'aliasOf='+r.aliasOf));
}

'use strict';
/**
 * test/unit/run-all.js
 *
 * Runs all Tier 1 (pure in-memory) and Tier 2 (fixture-backed) unit tests
 * sequentially via node:test.
 *
 * Usage:
 *   node test/unit/run-all.js
 *
 * Individual test files are also standalone runnable:
 *   node test/unit/crypto-provider.test.js
 */

const { run }  = require('node:test');
const path     = require('node:path');
const fs       = require('node:fs');

const UNIT_DIR = __dirname;

// Collect all *.test.js files in this directory, sorted for deterministic order
const testFiles = fs.readdirSync(UNIT_DIR)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => path.join(UNIT_DIR, f));

if (testFiles.length === 0) {
    console.log('No test files found in', UNIT_DIR);
    process.exit(0);
}

console.log(`\nRunning ${testFiles.length} unit test file(s):\n`);
testFiles.forEach(f => console.log('  ' + path.basename(f)));
console.log('');

// node:test `run` with file list — requires Node 18.9+
const stream = run({ files: testFiles });

stream.on('test:fail', () => {
    process.exitCode = 1;
});

stream.pipe(process.stdout);

'use strict';
/**
 * test/integration/run-all.js
 *
 * Runs all Tier 3 (pipeline integration) test files sequentially via node:test.
 *
 * Usage:
 *   node test/integration/run-all.js
 *
 * Individual test files are also standalone runnable:
 *   node test/integration/index-manager.test.js
 */

const { run }  = require('node:test');
const { spec } = require('node:test/reporters');
const path     = require('node:path');
const fs       = require('node:fs');

const INTEGRATION_DIR = __dirname;

const testFiles = fs.readdirSync(INTEGRATION_DIR)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => path.join(INTEGRATION_DIR, f));

if (testFiles.length === 0) {
    console.log('No test files found in', INTEGRATION_DIR);
    process.exit(0);
}

console.log(`\nRunning ${testFiles.length} integration test file(s):\n`);
testFiles.forEach(f => console.log('  ' + path.basename(f)));
console.log('');

const stream   = run({ files: testFiles });
const reporter = new spec();

stream.on('test:fail', () => {
    process.exitCode = 1;
});

stream.compose(reporter).pipe(process.stdout);

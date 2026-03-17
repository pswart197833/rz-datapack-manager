#!/usr/bin/env node
'use strict';

/**
 * DataPack Manager — CLI Extract Tool
 * scripts/extract-all.js
 *
 * Standalone extraction script. No server required.
 * Extracts all assets (or a filtered subset) from a pack directory
 * into the asset store with live terminal progress.
 *
 * Usage:
 *   node scripts/extract-all.js --data ./data --store ./store
 *   node scripts/extract-all.js --data ./data --store ./store --types dds,tga,bmp
 *   node scripts/extract-all.js --data ./data --store ./store --limit 1000
 *   node scripts/extract-all.js --help
 *
 * Options:
 *   --data     <path>   Directory containing data.000 – data.008 (required)
 *   --store    <path>   Asset store root directory (required)
 *   --sessions <path>   Sessions directory (default: ./sessions)
 *   --types    <list>   Comma-separated asset types to extract e.g. dds,tga,bmp
 *   --limit    <n>      Stop after extracting N assets (useful for testing)
 *   --dry-run           Print what would be extracted without writing files
 *   --help              Show this help message
 */

const fs                = require('fs');
const path              = require('path');
const PackConfiguration = require('../src/config/PackConfiguration');
const AssetStore        = require('../src/core/AssetStore');
const FingerprintStore  = require('../src/fingerprint/FingerprintStore');
const IndexManager      = require('../src/api/IndexManager');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            args[key] = val;
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    console.log(`
DataPack Manager — CLI Extract Tool

Usage:
  node scripts/extract-all.js --data <path> --store <path> [options]

Options:
  --data     <path>   Directory containing data.000 – data.008 (required)
  --store    <path>   Asset store root directory (required)
  --sessions <path>   Sessions directory (default: ./sessions)
  --types    <list>   Comma-separated types to extract e.g. dds,tga,bmp
  --limit    <n>      Stop after N extractions (useful for testing)
  --dry-run           Print what would be extracted without writing files
  --help              Show this help

Examples:
  # Extract everything from a game install
  node scripts/extract-all.js --data /game/data --store ./store

  # Extract only textures and models from a specific version
  node scripts/extract-all.js --data ./v8.1/data --store ./store --types dds,tga,cob,nx3

  # Test run — first 100 entries only
  node scripts/extract-all.js --data ./data --store ./store --limit 100 --dry-run
`);
    process.exit(0);
}

if (!args.data || !args.store) {
    console.error('Error: --data and --store are required. Run with --help for usage.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Progress display
// ---------------------------------------------------------------------------

const startTime = Date.now();

function formatBytes(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024/1024).toFixed(1)} MB`;
}

function formatTime(ms) {
    if (ms < 1000)  return `${ms}ms`;
    if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
    return `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;
}

// Terminal column width — keep line within this to prevent wrapping
const TERM_WIDTH = process.stdout.columns || 120;

function renderProgress(done, total, currentFile, extracted, skipped) {
    const pct     = total > 0 ? Math.floor((done / total) * 100) : 0;
    const barLen  = 28;
    const filled  = Math.floor(barLen * pct / 100);
    const bar     = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const elapsed = formatTime(Date.now() - startTime);

    // Sanitise filename — strip any control characters (\r \n etc.) that would
    // break the carriage-return overwrite and cause new lines to appear mid-run
    const safeName = currentFile.replace(/[\r\n\t\x00-\x1f]/g, '');

    // Build the fixed portion of the line (everything except the filename)
    const fixed = `\r  [${bar}] ${String(pct).padStart(3)}%  ` +
                  `${done.toLocaleString()}/${total.toLocaleString()}  ` +
                  `+${extracted} ~${skipped}  ${elapsed}  `;

    // Calculate remaining space for filename without exceeding terminal width
    // Subtract 3 for trailing spaces and the carriage return byte
    const nameSpace = Math.max(10, TERM_WIDTH - fixed.length - 3);
    const name = safeName.length > nameSpace
        ? '...' + safeName.slice(-(nameSpace - 3))
        : safeName.padEnd(nameSpace);

    process.stdout.write(fixed + name + '   ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const dataDir    = path.resolve(args.data);
    const storeDir   = path.resolve(args.store);
    const sessionsDir = path.resolve(args.sessions || './sessions');
    const types      = args.types ? args.types.split(',').map(t => t.trim().toLowerCase()) : null;
    const limit      = args.limit ? parseInt(args.limit) : null;
    const dryRun     = args['dry-run'] === true;

    // Validate data directory
    if (!fs.existsSync(path.join(dataDir, 'data.000'))) {
        console.error(`Error: data.000 not found in ${dataDir}`);
        process.exit(1);
    }

    // Ensure store directory exists
    if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    console.log('\n  DataPack Manager — Extract All');
    console.log('  ' + '─'.repeat(48));
    console.log(`  Data dir:   ${dataDir}`);
    console.log(`  Store dir:  ${storeDir}`);
    if (types)   console.log(`  Types:      ${types.join(', ')}`);
    if (limit)   console.log(`  Limit:      ${limit}`);
    if (dryRun)  console.log(`  Mode:       DRY RUN — no files will be written`);
    console.log('');

    // Build configuration
    const config = PackConfiguration.fromDirectory(dataDir, storeDir, sessionsDir);

    // Initialise stores
    const assetStore = new AssetStore(storeDir);
    await assetStore.rebuild();

    const dbPath  = path.join(storeDir, 'fingerprints.jsonl');
    const fpStore = new FingerprintStore(dbPath, assetStore);
    await fpStore.load();

    const existingCount = fpStore.list('asset').length;
    if (existingCount > 0) {
        console.log(`  Store already has ${existingCount.toLocaleString()} asset records — duplicates will be skipped\n`);
    }

    // Load index
    const manager = new IndexManager(config, fpStore, assetStore);
    console.log('  Loading index...');
    await manager.loadIndex();
    console.log('');

    if (dryRun) {
        // In dry-run mode, just list what would be extracted
        const { entries, total } = manager.getEntries({
            type:     types ? types[0] : undefined,
            pageSize: 999999
        });

        console.log(`  Would extract: ${total.toLocaleString()} assets`);
        console.log('\n  First 20 entries:');
        entries.slice(0, 20).forEach(e => {
            const status = assetStore.exists(e.fingerprint || '') ? '[skip]' : '[new] ';
            console.log(`    ${status} ${e.decodedName.padEnd(40)} ${formatBytes(e.size)}`);
        });
        if (total > 20) console.log(`    ... and ${(total - 20).toLocaleString()} more`);
        console.log('');
        process.exit(0);
    }

    // Run extraction with live progress
    let extractedCount = 0;
    let skippedCount   = 0;

    console.log('  Extracting assets...\n');

    const result = await manager.extractAll({
        types,
        onProgress: (done, total, currentFile) => {
            renderProgress(done, total, currentFile, extractedCount, skippedCount);
        }
    });

    extractedCount = result.extracted;
    skippedCount   = result.skipped;

    // Final progress line
    renderProgress(result.extracted + result.skipped, result.extracted + result.skipped,
        'done', result.extracted, result.skipped);
    process.stdout.write('\n\n');

    // Summary
    const elapsed = formatTime(Date.now() - startTime);

    // Reload FingerprintStore from disk — the in-memory instance was loaded before
    // extraction ran so it doesn't reflect alias registrations written during extractAll().
    await fpStore.load();
    const allRecords = fpStore.list('asset');

    // Count categories using FingerprintRecord.isAlias flag
    const uniqueFiles = allRecords.filter(r => !r.isAlias && r.extractedPath !== null).length;
    const aliasCount  = allRecords.filter(r => r.isAlias).length;
    // Zero-size entries are skipped before registration — derive count from result
    const zeroSizeSkip = result.skipped - aliasCount;

    console.log('  ' + '─'.repeat(48));
    console.log(`  Completed in ${elapsed}`);
    console.log(`  Extracted:  ${result.extracted.toLocaleString()} unique files written to store`);
    console.log(`  Aliases:    ${aliasCount.toLocaleString()} entries share content with an existing file`);
    if (zeroSizeSkip > 0) {
        console.log(`  Zero-size:  ${zeroSizeSkip.toLocaleString()} entries skipped (empty files)`);
    }
    console.log(`  Errors:     ${result.errors.length}`);

    if (result.errors.length > 0) {
        console.log('\n  Errors (first 10):');
        result.errors.slice(0, 10).forEach(e => console.log(`    ${e}`));
    }

    const total = result.extracted + result.skipped;
    console.log('');
    console.log(`  Index entries total:    ${total.toLocaleString()}`);
    console.log(`  Unique files on disk:   ${uniqueFiles.toLocaleString()}`);
    console.log(`  Content aliases:        ${aliasCount.toLocaleString()} (same bytes, different name)`);
    if (zeroSizeSkip > 0) {
        console.log(`  Zero-size entries:      ${zeroSizeSkip.toLocaleString()} (placeholder entries in index)`);
    }
    console.log('');
}

main().catch(err => {
    console.error('\n  [ERROR]', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});

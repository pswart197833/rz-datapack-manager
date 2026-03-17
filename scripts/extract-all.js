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
  --types    <list>   Comma-separated types to extract e.g. dds,tga,bmp (default: all)
  --limit    <n>      Stop after extracting N assets (for testing)
  --dry-run           Print what would be extracted, without writing files
  --help              Show this message
`);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dataDir    = path.resolve(args.data    || './data');
const storeDir   = path.resolve(args.store   || './store');
const sessionsDir = path.resolve(args.sessions || './sessions');
const types      = args.types
    ? args.types.split(',').map(t => t.trim().toLowerCase()) : null;
const limit      = args.limit ? parseInt(args.limit) : null;
const dryRun     = args['dry-run'] === true;

const startTime = Date.now();

(async () => {
    // Validate data directory
    if (!fs.existsSync(path.join(dataDir, 'data.000'))) {
        console.error(`Error: data.000 not found in ${dataDir}`);
        process.exit(1);
    }

    // Ensure directories exist
    if (!fs.existsSync(storeDir))    fs.mkdirSync(storeDir,    { recursive: true });
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    console.log('\n  DataPack Manager — Extract All');
    console.log('  ' + '─'.repeat(48));
    console.log(`  Data dir:   ${dataDir}`);
    console.log(`  Store dir:  ${storeDir}`);
    if (types)  console.log(`  Types:      ${types.join(', ')}`);
    if (limit)  console.log(`  Limit:      ${limit}`);
    if (dryRun) console.log(`  Mode:       DRY RUN — no files will be written`);
    console.log('');

    const config = PackConfiguration.fromDirectory(dataDir, storeDir, sessionsDir);

    // Initialise stores
    const assetStore = new AssetStore(storeDir);
    await assetStore.rebuild();

    // Ensure null-asset sentinel exists before any blueprint or session work.
    // Zero-size index entries are registered against this sentinel so they
    // flow through the pipeline uniformly without special-case branching.
    assetStore.ensureNullAsset();

    const dbPath  = path.join(storeDir, 'fingerprints.jsonl');
    const fpStore = new FingerprintStore(dbPath, assetStore);
    await fpStore.load();

    // Ensure null-asset FingerprintRecord is registered
    await fpStore.ensureNullAsset();

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

    renderProgress(
        result.extracted + result.skipped,
        result.extracted + result.skipped,
        'done', result.extracted, result.skipped
    );
    process.stdout.write('\n\n');

    // Summary
    const elapsed = formatTime(Date.now() - startTime);

    const fpStore2 = new FingerprintStore(dbPath, assetStore);
    await fpStore2.load();
    const totalAssets = fpStore2.list('asset').filter(r => !r.isAlias).length;
    const aliases     = fpStore2.list('asset').filter(r => r.isAlias).length;

    console.log('  Extraction complete');
    console.log('  ' + '─'.repeat(48));
    console.log(`  Extracted:  ${result.extracted.toLocaleString()} new assets`);
    console.log(`  Skipped:    ${result.skipped.toLocaleString()} (already stored or zero-size)`);
    console.log(`  Errors:     ${result.errors.length}`);
    console.log(`  Store size: ${totalAssets.toLocaleString()} unique + ${aliases.toLocaleString()} aliases`);
    console.log(`  Time:       ${elapsed}`);

    if (result.errors.length > 0) {
        console.log('\n  First 10 errors:');
        result.errors.slice(0, 10).forEach(e => console.log(`    ${e}`));
    }

    console.log('');
})();

// ---------------------------------------------------------------------------
// Progress rendering
// ---------------------------------------------------------------------------

function renderProgress(done, total, currentFile, extracted, skipped) {
    const pct    = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const bar    = buildBar(pct, 30);
    const name   = (currentFile || '').slice(-35).padEnd(35);
    process.stdout.write(
        `\r  [${bar}] ${String(pct).padStart(3)}%  ` +
        `${done.toLocaleString().padStart(7)}/${total.toLocaleString()}  ` +
        `+${extracted}  ~${skipped}  ${name}`
    );
}

function buildBar(pct, width) {
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatBytes(bytes) {
    if (bytes === 0)       return '0 B';
    if (bytes < 1024)      return `${bytes} B`;
    if (bytes < 1048576)   return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatTime(ms) {
    if (ms < 1000)  return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m ${s}s`;
}

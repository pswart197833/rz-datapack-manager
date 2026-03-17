# DataPack Manager — Overview

## What Is It?

DataPack Manager is a local tool for reading, extracting, archiving, and rebuilding the proprietary binary pack files used by the Rappelz game engine. The game ships its assets — textures, models, animations, audio, configuration files — bundled inside a set of encrypted archive files named `data.000` through `data.008`. This tool is the only way to work with those assets programmatically.

---

## The File Format

| File | Role |
|---|---|
| `data.000` | Index file — maps every asset name to its location in the pack files |
| `data.001` – `data.008` | Pack files — contain the raw asset bytes |

Both the index and asset content use a proprietary XOR rolling cipher. Non-proprietary formats (jpg, png, bmp, cfg, xml, wav, etc.) are encrypted at the content level. Proprietary formats (dds, tga, cob, naf, nx3, nfm) are stored raw.

---

## Who Is It For?

**Archiver** — Builds a comprehensive database of game assets across multiple releases. Extracts all assets into a content-addressed store. Safe to run repeatedly across versions — duplicates are skipped automatically.

**Modder** — Opens an existing pack set from a blueprint, replaces or removes specific assets, and rebuilds the pack files. The full asset list is pre-loaded so only changed files need to be supplied.

**Builder** — Creates a new pack from scratch or assembles a lean custom pack containing only specific assets.

---

## Capabilities

### Extraction
- Decrypt and parse `data.000` — 124,000+ entries in under 1 second
- Extract all assets to a content-addressed store with automatic deduplication
- 20,402 content aliases detected and tracked (`isAlias` / `aliasOf` flags)
- Filter by file type — textures only, models only, etc.
- CLI script with live progress bar for batch operations

### Asset Store
- Content-addressed storage — identical files stored once regardless of name
- SHA-256 fingerprinting throughout
- Persistent JSON Lines store — survives restarts, incremental updates
- de-duplicates files that have the same data but different name as aliases 

### Blueprint System
- Every unique `data.000` generates a blueprint — a complete snapshot of that pack version
- Blueprints record exact asset positions (pack slot, byte offset) for reconstruction
- Multiple blueprints coexist — compare releases , track what changed between versions (no implimented)

### Session Workflow
- Three-phase commit pipeline: prepare → build → finalise
- Resumable — progress tracked per asset, survives interruption
- New assets enter permanent libraries only after a successful commit

### Reconstruction
- Byte-identical reconstruction of all 8 pack files from a blueprint (~6 GB total)
- Correct XOR re-encryption when writing assets back
- Zero-size placeholder entries preserved at exact index positions

### UI
- Browser-based interface at `http://localhost:3000`
- Browse, filter, sort, and export the full 124k asset list
- Archiver page with live extraction progress
- Modder page — open from blueprint, stage changes, commit

### API
- Full REST API — all operations available as JSON endpoints
- Config, entries, extraction jobs, blueprints, sessions

---

## Current Status

| Capability | Status |
|---|---|
| Index parse and blueprint cache | ✅ Production ready |
| Asset extraction with deduplication | ✅ Production ready |
| Content alias detection and tracking | ✅ Production ready |
| CLI extract-all with progress bar | ✅ Production ready |
| Blueprint generation and persistence | ✅ Production ready |
| Session lifecycle (create, prepare, commit, resume) | ✅ Production ready |
| Pack file reconstruction — all 8 packs byte-identical | ✅ Verified |
| Index reconstruction — data.000 byte-identical | 🔧 Final bug (packId serialization) |
| UI — Archiver and Modder flows | ✅ Functional, redesign planned |
| Version comparison across blueprints | 📋 Planned |
| Asset preview | 📋 Planned |
| Duplicate/alias UI filter | 📋 Planned |

---

## Tech Stack

- **Runtime:** Node.js v18+
- **Backend:** Express.js
- **Frontend:** Bootstrap 5, vanilla JS
- **Persistence:** JSON Lines (.jsonl) — migration path to SQL ready
- **Crypto:** Custom XOR rolling cipher (matches game engine exactly)

---

## Quick Start

```bash
# Install
npm install

# Start server
npm start
# Open http://localhost:3000 → Configuration → set paths → Save

# Extract all assets (CLI)
node scripts/extract-all.js --data ./data --store ./store

# Help
node scripts/extract-all.js --help
```

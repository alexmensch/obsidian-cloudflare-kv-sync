# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin that syncs markdown files to Cloudflare KV storage based on frontmatter configuration. Files with `kv_sync: true` are automatically uploaded to KV. The `id` field is auto-generated (UUID) if missing, with optional `collection` prefixes for hierarchical key organization. Duplicate KV keys are detected and auto-corrected during full sync.

## Build & Development Commands

```bash
pnpm run dev        # Watch mode - rebuilds on file changes
pnpm run build      # Production build (typecheck + esbuild + copy assets)
pnpm run test       # Run Jest test suite
pnpm run lint       # ESLint check
pnpm run lint:fix   # Auto-fix ESLint violations
pnpm run format     # Prettier formatting
pnpm run version    # Bump version in manifest and versions.json
```

Package manager: pnpm

## Architecture

**Single-file plugin** — All code lives in `main.ts` (~730 lines):

- `CloudflareKVPlugin` — Main plugin class extending Obsidian's `Plugin`
  - Manages lifecycle, settings, and cache persistence
  - Coordinates sync operations via Obsidian vault events
  - Handles debounced file syncing to prevent API spam
  - Auto-assigns UUIDs to documents missing an `id` via `assignIdToFile()` / `generateId()`
  - Detects and auto-corrects duplicate KV keys via `detectAndFixDuplicates()`
  - Writes errors to a persistent log file via `writeErrorLog()`

- `CloudflareKVSettingsTab` — Settings UI extending `PluginSettingTab`
  - Cloudflare credentials (Account ID, Namespace ID, API Token)
  - Sync configuration (key names, auto-sync, debounce delay)

**Key data structures:**
- `CloudflareKVSettings` — Plugin configuration persisted to Obsidian data.json
- `CloudflareKVCache` — Tracks synced files mapping (file path → KV key) in cache.json

## Sync Workflow

1. File modification triggers `vault.on("modify")` event
2. Debounce delay prevents excessive API calls (configurable, default 60s)
3. Frontmatter parsed via regex to extract YAML
4. If `kv_sync: true` but no `id`, a UUID is auto-generated via `crypto.randomUUID()` and written to frontmatter with `app.fileManager.processFrontMatter()`
5. During full sync (`syncAllFiles`), `detectAndFixDuplicates()` scans all sync-eligible files before the sync loop — duplicates are resolved by keeping the first file alphabetically and reassigning IDs to the rest
6. Cloudflare KV API call (PUT for upload, DELETE for removal)
7. Cache updated to track sync state for orphan cleanup

**KV key format:** `{collection}/{id}` or just `{id}` if no collection

## Error Logging

Errors are written to `Cloudflare KV Sync error log.md` at the vault root instead of `console.error`. The only `console.error` call remaining is the fallback in `writeErrorLog()` when the vault adapter itself fails.

- Batch operations (`syncAllFiles`, `removeOrphanedUploads`) collect errors during the loop and write a single log entry at the end
- Individual operations (single file sync, debounced sync) write immediately
- Log format: markdown with `## {ISO datetime}` headers and `- {message}` bullet items

## Cloudflare API

Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/storage/kv/namespaces/{namespaceId}/values/{key}`

Methods: PUT (upload), DELETE (remove)
Auth: Bearer token via Authorization header
Content-Type: text/plain

## Build Output

Production build outputs to `dist/`:
- `main.js` — Bundled, minified plugin code (CommonJS format for Obsidian)
- `manifest.json`, `styles.css`, `versions.json` — Copied assets

## Code Conventions

- ESLint with typescript-eslint (flat config in eslint.config.mjs)
- Prettier formatting (80 char lines, double quotes, 2-space indent)
- Helper functions for type coercion: `coerceBoolean()`, `coerceString()`
- Unused parameters prefixed with `_`

## Testing

Jest test suite with 90%+ coverage threshold. Tests are in `tests/` directory:

- `tests/unit/` — Unit tests for utilities, frontmatter parsing, settings, cache, debounce, error log, ID generation
- `tests/integration/` — Integration tests for sync operations, orphan cleanup, auto-assign ID, duplicate detection
- `tests/mocks/` — Mock factories for Obsidian and Cloudflare APIs
- `tests/helpers/` — Test utilities including plugin instance creation
- `src/__mocks__/obsidian.ts` — Complete Obsidian API mock (includes `FileManager` with `processFrontMatter`)
- `tests/setup.ts` — Global setup including `crypto.randomUUID` polyfill for jsdom

Settings UI (`CloudflareKVSettingsTab`) is excluded from test coverage.

## Release Process

GitHub Actions workflow triggered on git tags:
1. Builds production bundle
2. Packages as zip with plugin directory structure
3. Creates GitHub release with artifacts

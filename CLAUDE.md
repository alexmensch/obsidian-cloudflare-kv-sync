# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin that syncs markdown files to Cloudflare KV storage based on frontmatter configuration. Files with `kv_sync: true` and an `id` field are automatically uploaded to KV, with optional `collection` prefixes for hierarchical key organization.

## Build & Development Commands

```bash
npm run dev        # Watch mode - rebuilds on file changes
npm run build      # Production build (typecheck + esbuild + copy assets)
npm run lint       # ESLint check
npm run lint:fix   # Auto-fix ESLint violations
npm run format     # Prettier formatting
npm run version    # Bump version in manifest and versions.json
```

Package manager: pnpm

## Architecture

**Single-file plugin** - All code lives in `main.ts` (~636 lines):

- `CloudflareKVPlugin` - Main plugin class extending Obsidian's `Plugin`
  - Manages lifecycle, settings, and cache persistence
  - Coordinates sync operations via Obsidian vault events
  - Handles debounced file syncing to prevent API spam

- `CloudflareKVSettingsTab` - Settings UI extending `PluginSettingTab`
  - Cloudflare credentials (Account ID, Namespace ID, API Token)
  - Sync configuration (key names, auto-sync, debounce delay)

**Key data structures:**
- `CloudflareKVSettings` - Plugin configuration persisted to Obsidian data.json
- `CloudflareKVCache` - Tracks synced files mapping (file path → KV key) in cache.json

## Sync Workflow

1. File modification triggers `vault.on("modify")` event
2. Debounce delay prevents excessive API calls (configurable, default 60s)
3. Frontmatter parsed via regex to extract YAML
4. Sync decision based on `kv_sync`, `id`, and optional `collection` fields
5. Cloudflare KV API call (PUT for upload, DELETE for removal)
6. Cache updated to track sync state for orphan cleanup

**KV key format:** `{collection}/{id}` or just `{id}` if no collection

## Cloudflare API

Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/storage/kv/namespaces/{namespaceId}/values/{key}`

Methods: PUT (upload), DELETE (remove)
Auth: Bearer token via Authorization header
Content-Type: text/plain

## Build Output

Production build outputs to `dist/`:
- `main.js` - Bundled, minified plugin code (CommonJS format for Obsidian)
- `manifest.json`, `styles.css`, `versions.json` - Copied assets

## Code Conventions

- ESLint with typescript-eslint (flat config in eslint.config.mjs)
- Prettier formatting (80 char lines, double quotes, 2-space indent)
- Helper functions for type coercion: `coerceBoolean()`, `coerceString()`
- Unused parameters prefixed with `_`
- No test suite - manual testing in Obsidian

## Release Process

GitHub Actions workflow triggered on git tags:
1. Builds production bundle
2. Packages as zip with plugin directory structure
3. Creates GitHub release with artifacts

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

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:

   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```

5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

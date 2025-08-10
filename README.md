# Obsidian Cloudflare KV Sync

An Obsidian plugin that automatically syncs markdown files to Cloudflare KV storage based on Frontmatter configuration. Perfect for publishing content to static sites that pull from Cloudflare KV as a simple CMS.

## Features

- **Automatic syncing**: Files marked with a sync flag automatically upload when modified
- **Collection support**: Organize KV keys with optional collection prefixes
- **Smart key management**: Handles collection changes and removes old keys automatically
- **Manual controls**: Ribbon icon and commands for manual operations
- **Configurable**: Customize sync keys, ID fields, and sync behavior
- **Debounced uploads**: Prevents excessive API calls during rapid editing

## Installation

### From Obsidian Community Plugins (Recommended)
1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Click Browse and search for "Cloudflare KV Sync"
4. Install and enable the plugin

### Manual Installation
1. Download the latest release from GitHub
2. Extract the files to your vault's `.obsidian/plugins/cloudflare-kv-sync/` folder
3. Enable the plugin in Obsidian settings

### Development Installation
1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the plugin
4. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder

## Setup

### 1. Cloudflare Configuration
1. Create a Cloudflare KV namespace in your dashboard
2. Create an API token with these permissions:
   - **Account**: `Cloudflare Workers:Edit`
   - **Zone Resources**: `Include - All zones` (or specific zone)
3. Note your Account ID and Namespace ID

### 2. Plugin Configuration
1. Go to Settings → Community Plugins → Cloudflare KV Sync
2. Enter your:
   - **Account ID**: Found in Cloudflare dashboard sidebar
   - **Namespace ID**: Found in Workers → KV → Your namespace
   - **API Token**: The token you created above
3. Configure optional settings:
   - **Sync Key**: Frontmatter key to check for sync flag (default: `kv_sync`)
   - **ID Key**: Frontmatter key containing document ID (default: `id`)
   - **Auto-sync**: Enable/disable automatic syncing on file changes

## Usage

### Basic Syncing
Add the sync flag to your markdown frontmatter:

```yaml
---
id: my-unique-post-id
kv_sync: true
title: My Amazing Post
---

Your content here...
```

The file will automatically sync to KV with key: `my-unique-post-id`

### Collection Organization
Use collections to organize your KV keys:

```yaml
---
id: my-blog-post
kv_sync: true
collection: writing
title: My Blog Post
---
```

This creates KV key: `writing/my-blog-post`

### Manual Controls
- **Ribbon icon**: Click the cloud upload icon to sync all marked files
- **Command palette**: 
  - "Sync all files marked for KV sync"
  - "Sync current file to Cloudflare KV"
  - "Remove current file from Cloudflare KV"

### Sync Behavior
- **Enable sync**: Set `kv_sync: true` in frontmatter
- **Disable sync**: Set `kv_sync: false` or remove the key entirely
- **Change collection**: Update the `collection` value - old keys are automatically removed
- **Auto-cleanup**: Removing sync flag automatically removes the file from KV

## Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| Sync Key | `kv_sync` | Frontmatter key to check for sync flag |
| ID Key | `id` | Frontmatter key containing document ID |
| Auto-sync | `true` | Automatically sync files on modification |
| Debounce Delay | `2000ms` | Wait time before syncing after file changes |

## Examples

### Simple Blog Post
```yaml
---
id: hello-world
kv_sync: true
title: Hello World
date: 2024-01-15
---

# Hello World
This is my first post!
```
**KV Key**: `hello-world`

### Organized Content
```yaml
---
id: advanced-js-patterns
kv_sync: true
collection: tutorials
title: Advanced JavaScript Patterns
tags: [javascript, programming]
---

# Advanced JavaScript Patterns
Learn about advanced patterns...
```
**KV Key**: `tutorials/advanced-js-patterns`

### Draft Content (Not Synced)
```yaml
---
id: work-in-progress
kv_sync: false
title: Work in Progress
---

This won't be synced to KV.
```

## Troubleshooting

### Common Issues
- **Files not syncing**: Check that `kv_sync: true` and ID field exist in frontmatter
- **API errors**: Verify your Account ID, Namespace ID, and API token
- **Permission errors**: Ensure API token has Cloudflare Workers:Edit permission
- **Old keys remaining**: Plugin automatically cleans up when collections change

### Debug Steps
1. Check Obsidian console for error messages (Ctrl+Shift+I)
2. Verify Cloudflare KV namespace exists and is accessible
3. Test API token permissions in Cloudflare dashboard
4. Ensure frontmatter is valid YAML syntax

## Development

### Building
```bash
npm install
npm run build
```

### Development Mode
```bash
npm run dev
```

This will watch for changes and rebuild automatically.

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

- **GitHub Issues**: Report bugs or request features
- **Discussions**: Ask questions or share use cases

## Changelog

### 0.1.0
- Initial release
- Automatic KV syncing based on frontmatter flags
- Collection support for organized keys
- Smart key management and cleanup
- Configurable sync behavior
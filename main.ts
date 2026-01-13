import {
  Plugin,
  TFile,
  Notice,
  PluginSettingTab,
  App,
  Setting,
  parseYaml,
  requestUrl
} from "obsidian";

interface CloudflareKVSettings {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  syncKey: string;
  idKey: string;
  autoSync: boolean;
  debounceDelay: number;
}

interface CloudflareKVCache {
  fileKeyCache: Record<string, string>;
  lastCleanup: number;
}

const DEFAULT_SETTINGS: CloudflareKVSettings = {
  accountId: "",
  namespaceId: "",
  apiToken: "",
  syncKey: "kv_sync",
  idKey: "id",
  autoSync: true,
  debounceDelay: 5000
};

const DEFAULT_CACHE: CloudflareKVCache = {
  fileKeyCache: {},
  lastCleanup: 0
}

const DEFAULT_CACHE: CloudflareKVCache = {
  fileKeyCache: {},
  lastCleanup: 0
}

export default class CloudflareKVPlugin extends Plugin {
  settings: CloudflareKVSettings;
  private cache: CloudflareKVCache;
  private syncTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private fileKeyCache: Map<string, string> = new Map();
  private static readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async onload() {
    await this.loadSettings();
    await this.loadCache();

    // Perform periodic cleanup check on startup
    this.performPeriodicCleanupCheck();


    this.addRibbonIcon('cloud-upload', 'Sync to Cloudflare KV', () => {
      this.syncAllTaggedFiles();
    });

    this.addCommand({
      id: 'sync-all-tagged-files',
      name: 'Sync all marked files to Cloudflare KV',
      callback: () => {
        this.syncAllTaggedFiles();
      }
    });

    this.addCommand({
      id: "sync-current-file",
      name: "Sync current file to Cloudflare KV",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.syncFile(activeFile);
        } else {
          new Notice("No active file to sync");
        }
      }
    });

    this.addCommand({
      id: "remove-current-file-from-kv",
      name: "Remove current file from Cloudflare KV",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.removeFileFromKV(activeFile);
        } else {
          new Notice("No active file to remove");
        }
      }
    });

    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debouncedSync(file);
          }
        })
      );
    }

    this.addSettingTab(new CloudflareKVSettingTab(this.app, this));
  }

  onunload() {
    // Save cache before unloading
    this.saveCache();
    
    // Clear any pending timeouts
    for (const timeout of this.syncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.syncTimeouts.clear();
  }

  private async performPeriodicCleanupCheck() {
    const now = Date.now();
    const timeSinceLastCleanup = now - this.cache.lastCleanup;
    
    if (timeSinceLastCleanup >= CloudflareKVPlugin.CLEANUP_INTERVAL_MS) {
      console.log('Performing periodic cleanup check...');
      try {
        const files = this.app.vault.getMarkdownFiles();
        const checkedFiles = new Set<string>();
        
        // Just check files, don't sync
        for (const file of files) {
          checkedFiles.add(file.path);
        }
        
        await this.cleanupOrphanedCacheEntries(checkedFiles);
        this.cache.lastCleanup = now;
        await this.saveCache();
      } catch (error) {
        console.error('Error during periodic cleanup:', error);
      }
      }
  }

  private debouncedSync(file: TFile) {
    // Clear existing timeout for this file
    const existingTimeout = this.syncTimeouts.get(file.path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      try {
        await this.handleFileChange(file);
      } catch (error) {
        console.error("Error in debounced sync:", error);
      } finally {
        this.syncTimeouts.delete(file.path);
      }
    }, this.settings.debounceDelay);

    this.syncTimeouts.set(file.path, timeout);
  }

  private async handleFileChange(file: TFile) {
    const frontmatter = await this.getFrontmatter(file);
    if (!frontmatter) return;

    const currentKey = this.buildKVKey(frontmatter);
    const previousKey = this.fileKeyCache.get(file.path);
    const shouldSync = this.shouldSyncFile(frontmatter);

    if (shouldSync && currentKey) {
      // File should be synced
      if (previousKey && previousKey !== currentKey) {
        // Key changed, remove old entry first
        await this.deleteFromKV(previousKey);
      }
      await this.syncFile(file);
      this.fileKeyCache.set(file.path, currentKey);
      await this.saveCache(); // Persist cache after successful sync
    } else {
      // File should not be synced
      if (previousKey) {
        // Remove from KV and cache
        await this.deleteFromKV(previousKey);
        this.fileKeyCache.delete(file.path);
        await this.saveCache(); // Persist cache after cleanup
      }
    }
  }

  private async getFrontmatter(file: TFile): Promise<any> {
    try {
      const content = await this.app.vault.cachedRead(file);
      return this.extractFrontmatter(content);
    } catch (error) {
      console.error(`Error reading file: ${file.name}`, error);
      return null;
    }
  }

  private shouldSyncFile(frontmatter: any): boolean {
    if (!frontmatter) return false;

    const syncValue = frontmatter[this.settings.syncKey];
    const docId = frontmatter[this.settings.idKey];
    
    return (syncValue === true || String(syncValue).toLowerCase() === 'true') && !!docId;
  }

  private buildKVKey(frontmatter: any): string | null {
    const docId = frontmatter[this.settings.idKey];
    if (!docId) return null;

    const collection = frontmatter.collection;
    return collection ? `${collection}/${docId}` : docId;
  }

  private extractFrontmatter(content: string): any {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    try {
      return parseYaml(frontmatterMatch[1]);
    } catch (error) {
      console.error("Error parsing frontmatter:", error);
      return null;
    }
  }

  private extractDocId(frontmatter: any): string | null {
    return frontmatter[this.settings.idKey] || null;
  }

  async syncFile(file: TFile) {
    if (!this.validateSettings()) {
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const frontmatter = this.extractFrontmatter(content);

      if (!frontmatter) {
        new Notice(`No frontmatter found in ${file.name}`);
        return;
      }

      if (!this.shouldSyncFile(frontmatter)) {
        new Notice(`File ${file.name} is not marked for KV sync`);
        return;
      }

      const kvKey = this.buildKVKey(frontmatter);
      if (!kvKey) {
        new Notice(`No document ID found in frontmatter of ${file.name}`);
        return;
      }

      await this.uploadToKV(kvKey, content);
      new Notice(`✅ Synced ${file.name} to KV as "${kvKey}"`);
    } catch (error) {
      console.error("Error syncing file:", error);
      new Notice(`❌ Error syncing ${file.name}: ${error.message}`);
    }
  }

  async syncAllTaggedFiles() {
    if (!this.validateSettings()) {
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const syncedFiles = [];
    const checkedFiles = new Set<string>(); // Track files we've processed

    // Find all files marked for sync
    for (const file of files) {
      const frontmatter = await this.getFrontmatter(file);
      checkedFiles.add(file.path);
      
      if (this.shouldSyncFile(frontmatter)) {
        syncedFiles.push(file);
      }
    }

    // Check cached files that are no longer marked for sync or no longer exist
    await this.cleanupOrphanedCacheEntries(checkedFiles);

    if (syncedFiles.length === 0) {
      new Notice(
        `No files found with '${this.settings.syncKey}: true' and an ID`
      );
      return;
    }

    new Notice(`Starting sync of ${syncedFiles.length} files...`);

    let successful = 0;
    let failed = 0;

    for (const file of syncedFiles) {
      try {
        await this.syncFile(file);
        successful++;
      } catch (error) {
        failed++;
        console.error(`Failed to sync ${file.name}:`, error);
      }
    }

    new Notice(`Sync complete: ${successful} successful, ${failed} failed`);
    
    // Update cleanup timestamp and save cache
    this.cache.lastCleanup = Date.now();
    await this.saveCache();
  }

  /**
   * Clean up cache entries for files that:
   * 1. No longer exist in the vault
   * 2. No longer have kv_sync set to true
   * 3. No longer have the required ID field
   */
  private async cleanupOrphanedCacheEntries(checkedFiles: Set<string>) {
    const entriesToRemove: Array<{ filePath: string; kvKey: string }> = [];

    // Check each cached entry
    for (const [filePath, kvKey] of this.fileKeyCache.entries()) {
      let shouldRemove = false;

      // Check if file still exists in vault
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        // File no longer exists in vault
        console.log(`File ${filePath} no longer exists, removing from cache and KV`);
        shouldRemove = true;
      } else {
        // File exists, check if it still should be synced
        try {
          const frontmatter = await this.getFrontmatter(file);
          
          if (!this.shouldSyncFile(frontmatter)) {
            console.log(`File ${filePath} no longer marked for sync, removing from KV`);
            shouldRemove = true;
          } else {
            // File should still be synced, but check if key changed
            const currentKey = this.buildKVKey(frontmatter);
            if (currentKey && currentKey !== kvKey) {
              console.log(`File ${filePath} key changed from ${kvKey} to ${currentKey}, removing old key`);
              entriesToRemove.push({ filePath, kvKey });
              // Don't remove from cache here since the new key will be set during sync
              continue;
            }
          }
        } catch (error) {
          console.error(`Error checking file ${filePath} for cleanup:`, error);
          // If we can't read the file, assume it should be removed
          shouldRemove = true;
        }
      }

      if (shouldRemove) {
        entriesToRemove.push({ filePath, kvKey });
      }
    }

    // Remove orphaned entries
    let cleanupCount = 0;
    for (const { filePath, kvKey } of entriesToRemove) {
      try {
        await this.deleteFromKV(kvKey);
        this.fileKeyCache.delete(filePath);
        cleanupCount++;
        console.log(`Cleaned up orphaned entry: ${filePath} -> ${kvKey}`);
      } catch (error) {
        console.error(`Error cleaning up ${filePath} -> ${kvKey}:`, error);
      }
    }

    if (cleanupCount > 0) {
      new Notice(`🧹 Cleaned up ${cleanupCount} orphaned entries from KV`);
    }
  }

  async removeFileFromKV(file: TFile) {
    if (!this.validateSettings()) {
      return;
    }

    try {
      // Try to get current KV key
      const frontmatter = await this.getFrontmatter(file);
      let kvKey = null;

      if (frontmatter) {
        kvKey = this.buildKVKey(frontmatter);
      }

      // Also check cached key in case frontmatter changed
      const cachedKey = this.fileKeyCache.get(file.path);

      // Remove both current and cached keys if they exist and are different
      const keysToRemove = new Set([kvKey, cachedKey].filter((key) => key));

      for (const key of keysToRemove) {
        await this.deleteFromKV(key);
      }

      if (keysToRemove.size > 0) {
        new Notice(`🗑️ Removed ${file.name} from Cloudflare KV`);
        this.fileKeyCache.delete(file.path);
        await this.saveCache(); // Persist cache after manual removal
      }
    } catch (error) {
      console.error("Error removing file from KV:", error);
      new Notice(`❌ Error removing ${file.name}: ${error.message}`);
    }
  }

  async uploadToKV(key: string, value: string) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/storage/kv/namespaces/${this.settings.namespaceId}/values/${key}`;

    const response = await requestUrl({
      url,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`,
        "Content-Type": "text/plain"
      },
      body: value
    });
  }

  async deleteFromKV(key: string) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/storage/kv/namespaces/${this.settings.namespaceId}/values/${key}`;

    const response = await requestUrl({
      url,
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.settings.apiToken}`
      }
    });
  }

  validateSettings(): boolean {
    if (
      !this.settings.accountId ||
      !this.settings.namespaceId ||
      !this.settings.apiToken
    ) {
      new Notice("Please configure Cloudflare settings in plugin settings");
      return false;
    }
    return true;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadCache() {
    try {
      const cacheData = await this.app.vault.adapter.read(`${this.manifest.dir}/cache.json`);
      this.cache = Object.assign({}, DEFAULT_CACHE, JSON.parse(cacheData));
      
      // Convert cache object back to Map
      this.fileKeyCache = new Map(Object.entries(this.cache.fileKeyCache));
      
      console.log(`Loaded ${this.fileKeyCache.size} cached file mappings`);
    } catch (error) {
      // Cache file doesn't exist or is corrupted, start fresh
      console.log('No existing cache found, starting fresh');
      this.cache = Object.assign({}, DEFAULT_CACHE);
      this.fileKeyCache = new Map();
    }
  }

  async saveCache() {
    try {
      // Convert Map to object for JSON serialization
      this.cache.fileKeyCache = Object.fromEntries(this.fileKeyCache);
      
      const cacheJson = JSON.stringify(this.cache, null, 2);
      await this.app.vault.adapter.write(`${this.manifest.dir}/cache.json`, cacheJson);
    } catch (error) {
      console.error('Error saving cache:', error);
    }
  }
}

class CloudflareKVSettingTab extends PluginSettingTab {
  plugin: CloudflareKVPlugin;

  constructor(app: App, plugin: CloudflareKVPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Cloudflare KV Auto-Sync Settings" });

    new Setting(containerEl)
      .setName("Account ID")
      .setDesc("Your Cloudflare Account ID")
      .addText((text) =>
        text
          .setPlaceholder("Enter your account ID")
          .setValue(this.plugin.settings.accountId)
          .onChange(async (value) => {
            this.plugin.settings.accountId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Namespace ID")
      .setDesc("Your Cloudflare KV Namespace ID")
      .addText((text) =>
        text
          .setPlaceholder("Enter your namespace ID")
          .setValue(this.plugin.settings.namespaceId)
          .onChange(async (value) => {
            this.plugin.settings.namespaceId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Token")
      .setDesc("Your Cloudflare API Token with KV permissions")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync Key")
      .setDesc("Frontmatter key to check for sync flag (must be true to sync)")
      .addText((text) =>
        text
          .setPlaceholder("kv_sync")
          .setValue(this.plugin.settings.syncKey)
          .onChange(async (value) => {
            this.plugin.settings.syncKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ID Key")
      .setDesc("Frontmatter key containing the document ID")
      .addText((text) =>
        text
          .setPlaceholder("id")
          .setValue(this.plugin.settings.idKey)
          .onChange(async (value) => {
            this.plugin.settings.idKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-sync on save")
      .setDesc("Automatically sync files when they are modified")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce delay (ms)")
      .setDesc("Wait time before syncing after file modification")
      .addText((text) =>
        text
          .setPlaceholder("2000")
          .setValue(this.plugin.settings.debounceDelay.toString())
          .onChange(async (value) => {
            const delay = parseInt(value) || 2000;
            this.plugin.settings.debounceDelay = delay;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "How it works" });

    const instructions = containerEl.createEl("div");
    instructions.innerHTML = `
      <ol>
        <li>Set the sync key (default: "kv_sync") to <strong>true</strong> in your markdown files' frontmatter</li>
        <li>Ensure each file has an ID field (configurable, default: "id") in its frontmatter</li>
        <li>Optionally add a "collection" field to prefix the KV key</li>
        <li>Files will automatically upload to KV when saved (if auto-sync is enabled)</li>
        <li>Changing the sync key to false or removing it will remove the file from KV</li>
        <li>Changing the collection will update the KV key automatically</li>
        <li>Running "Sync all marked files" will also clean up orphaned entries</li>
      </ol>
      <h4>Example frontmatter:</h4>
      <pre><code>---
id: my-unique-post-id
kv_sync: true
collection: writing
title: My Blog Post
---</code></pre>
      <p>This would create KV key: <code>writing/my-unique-post-id</code></p>
      <p>Without collection, KV key would be: <code>my-unique-post-id</code></p>
    `;
  }
}

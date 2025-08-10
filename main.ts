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

const DEFAULT_SETTINGS: CloudflareKVSettings = {
  accountId: "",
  namespaceId: "",
  apiToken: "",
  syncKey: "kv_sync",
  idKey: "id",
  autoSync: true,
  debounceDelay: 5000
};

export default class CloudflareKVPlugin extends Plugin {
  settings: CloudflareKVSettings;
  private syncTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private fileKeyCache: Map<string, string> = new Map();

  async onload() {
    await this.loadSettings();


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

    // Auto-sync on file modification if enabled
    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debouncedSync(file);
          }
        })
      );
    }

    // Add settings tab
    this.addSettingTab(new CloudflareKVSettingTab(this.app, this));
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
    } else {
      // File should not be synced
      if (previousKey) {
        // Remove from KV and cache
        await this.deleteFromKV(previousKey);
        this.fileKeyCache.delete(file.path);
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

    return syncValue === "true" && !!docId;
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

    // Find all files marked for sync
    for (const file of files) {
      const frontmatter = await this.getFrontmatter(file);
      if (this.shouldSyncFile(frontmatter)) {
        syncedFiles.push(file);
      }
    }

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
      }
    } catch (error) {
      console.error("Error removing file from KV:", error);
      new Notice(`❌ Error removing ${file.name}: ${error.message}`);
    }
  }

  async uploadToKV(key: string, value: string) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/storage/kv/namespaces/${this.settings.namespaceId}/values/${key}`;

    const response = await requestUrl({
      url: url,
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
      url: url,
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

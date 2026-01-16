import {
  Plugin,
  TFile,
  Notice,
  PluginSettingTab,
  App,
  SecretComponent,
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
  syncedFiles: Record<string, string>;
}

type KVRequestResult = { success: true } | { success: false; error: string };

type SyncActionResult = KVRequestResult & {
  action: "create" | "delete";
};

type SyncResult =
  | { skipped: true; error?: string; sync?: undefined }
  | { skipped: false; error?: string; sync?: SyncActionResult };

const DEFAULT_SETTINGS: CloudflareKVSettings = {
  accountId: "",
  namespaceId: "",
  apiToken: "",
  syncKey: "kv_sync",
  idKey: "id",
  autoSync: false,
  debounceDelay: 15000
};

const DEFAULT_CACHE: CloudflareKVCache = {
  syncedFiles: {}
};

const SKIPPED_SYNC_RESULT: SyncResult = {
  skipped: true
};

export default class CloudflareKVPlugin extends Plugin {
  settings: CloudflareKVSettings;
  private syncTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private syncedFiles: Map<string, string> = new Map();
  private cache: CloudflareKVCache;
  private static cacheFile: string = "cache.json";

  async onload() {
    await this.loadSettings();
    await this.loadCache();

    this.addRibbonIcon("cloud-upload", "Sync to Cloudflare KV", () => {
      this.syncAllFiles();
    });

    this.addCommand({
      id: "sync-current-file-to-kv",
      name: "Sync current file to Cloudflare KV",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.syncSingleFile(activeFile);
        } else {
          new Notice("No active file to sync");
        }
      }
    });

    this.addCommand({
      id: "sync-all-files-to-kv",
      name: "Sync all marked files to Cloudflare KV",
      callback: () => {
        this.syncAllFiles();
        this.removeOrphanedUploads();
      }
    });

    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debouncedFileSync(file);
          }
        })
      );
    }

    this.addSettingTab(new CloudflareKVSettingTab(this.app, this));
  }

  private async debouncedFileSync(file: TFile) {
    const existingTimeout = this.syncTimeouts.get(file.path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(async () => {
      try {
        await this.syncSingleFile(file);
      } catch (error) {
        console.error("Error in debounced sync:", error);
      } finally {
        this.syncTimeouts.delete(file.path);
      }
    }, this.settings.debounceDelay);

    this.syncTimeouts.set(file.path, timeout);
  }

  private async syncSingleFile(file: TFile) {
    if (!this.validateSettings()) {
      return;
    }

    const syncResult = await this.syncFile(file);
    await this.saveCache();

    if (syncResult.skipped === true) {
      new Notice("ℹ️ File not marked for sync");
    } else if (syncResult.sync) {
      const sync = syncResult.sync;

      if (sync.success === true) {
        new Notice("✅ Successful sync");
      } else {
        new Notice(`❌ Error syncing: ${sync.error}`);
      }
    }
  }

  private async syncAllFiles() {
    if (!this.validateSettings()) {
      return;
    }

    const files = this.app.vault.getMarkdownFiles();

    let successful = 0;
    let failed = 0;

    for (const file of files) {
      const syncResult = await this.syncFile(file);

      if (syncResult.success === true) {
        successful++;
      } else {
        failed++;
        console.error(`Cloudflare KV API error: ${syncResult.error}`);
      }
    }

    await this.saveCache();

    new Notice(`ℹ️ Sync complete: ${successful} successful, ${failed} failed`);
  }

  private async syncFile(file: TFile): Promise<SyncResult> {
    const result: SyncResult = { ...SKIPPED_SYNC_RESULT };
    const frontmatter = await this.getFrontmatter(file);
    const syncValue = frontmatter?.[this.settings.syncKey];
    const docId = frontmatter?.[this.settings.idKey] as string;
    const fileContent = await this.app.vault.cachedRead(file);
    const previousKVKey = this.syncedFiles.get(file.path);

    if (previousKVKey && (!frontmatter || !syncValue || !docId)) {
      // File was previously synced, but is now missing metadata needed for sync
      result.skipped = false;
      result.sync = await this.deleteFromKV(previousKVKey);
      if (result.sync.success) this.syncedFiles.delete(file.path);
      return result;
    }
    if (!frontmatter) {
      result.error = `No frontmatter found in ${file.name}`;
      return result;
    }
    if (!syncValue) return result;
    if (!docId) {
      result.error = `Missing doc ID in ${file.name}`;
      return result;
    }

    const currentKVKey = this.buildKVKey(frontmatter);

    if (syncValue === true || String(syncValue).toLowerCase() === "true") {
      // File is marked for sync
      result.skipped = false;

      if (previousKVKey && previousKVKey !== currentKVKey) {
        // File's sync key has changed
        const deleteResult = await this.deleteFromKV(previousKVKey);

        if (deleteResult.success === false) {
          result.error = `Unable to delete old KV entry: ${deleteResult.error}`;
          return result;
        }
        this.syncedFiles.delete(file.path);
      }

      result.sync = await this.uploadToKV(currentKVKey, fileContent);

      if (result.sync.success) this.syncedFiles.set(file.path, currentKVKey);
    } else if (previousKVKey) {
      // File was previously synced, but no longer marked for sync
      result.skipped = false;
      result.sync = await this.deleteFromKV(previousKVKey);

      if (result.sync.success) this.syncedFiles.delete(file.path);
    }

    return result;
  }

  private async removeOrphanedUploads() {
    const entriesToRemove: Array<{ filePath: string; kvKey: string }> = [];

    for (const [filePath, kvKey] of this.syncedFiles.entries()) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile))
        entriesToRemove.push({ filePath, kvKey });
    }

    let successful = 0;
    let failed = 0;

    for (const { filePath, kvKey } of entriesToRemove) {
      const result = await this.deleteFromKV(kvKey);
      if (result.success === true) {
        successful++;
        this.syncedFiles.delete(filePath);
      } else {
        failed++;
        console.error(`Cloudflare KV API error: ${result.error}`);
      }
    }

    if (successful > 0 || failed > 0) {
      new Notice(
        `ℹ️ Cleanup complete: ${successful} successful, ${failed} failed`
      );
    }
  }

  private async getFrontmatter(
    file: TFile
  ): Promise<Record<string, unknown> | null> {
    try {
      const content = await this.app.vault.cachedRead(file);

      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      try {
        return parseYaml(frontmatterMatch[1]);
      } catch (error) {
        console.error("Error parsing frontmatter:", error);
        return null;
      }
    } catch (error) {
      console.error(`Error reading file: ${file.name}`, error);
      return null;
    }
  }

  private buildKVKey(frontmatter: Record<string, unknown>): string | null {
    const docId = frontmatter[this.settings.idKey] as string;
    const collection = frontmatter["collection"] as string;

    return collection ? `${collection}/${docId}` : docId;
  }

  private async kvRequest(
    key: string,
    method: "PUT" | "DELETE",
    body?: string
  ): Promise<KVRequestResult> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/storage/kv/namespaces/${this.settings.namespaceId}/values/${key}`;
    const apiToken = this.app.secretStorage.getSecret(this.settings.apiToken);

    const response = await requestUrl({
      url,
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body ? { "Content-Type": "text/plain" } : {})
      },
      ...(body ? { body } : {})
    });

    const data = JSON.parse(response.text);

    if (!data.success) {
      return { success: false, error: `${JSON.stringify(data.errors)}` };
    }

    return { success: true };
  }

  private async uploadToKV(
    key: string,
    value: string
  ): Promise<SyncActionResult> {
    return {
      action: "create",
      ...(await this.kvRequest(key, "PUT", value))
    };
  }

  private async deleteFromKV(key: string): Promise<SyncActionResult> {
    return {
      action: "delete",
      ...(await this.kvRequest(key, "DELETE"))
    };
  }

  private async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private validateSettings(): boolean {
    if (
      !this.settings.accountId ||
      !this.settings.namespaceId ||
      !this.settings.apiToken
    ) {
      new Notice("Cloudflare KV Sync plugin requires configuration");
      return false;
    }

    if (!this.app.secretStorage.getSecret(this.settings.apiToken)) {
      new Notice(
        `Keychain secret "${this.settings.apiToken}" requires a value`
      );
      return false;
    }

    return true;
  }

  private async loadCache() {
    try {
      const cacheData = await this.app.vault.adapter.read(
        `${this.manifest.dir}/${CloudflareKVPlugin.cacheFile}`
      );
      this.cache = Object.assign({}, DEFAULT_CACHE, JSON.parse(cacheData));
      console.log(`Loaded ${this.syncedFiles.size} cached file mappings`);
    } catch {
      console.log("No existing cache found, creating empty cache");
      this.cache = Object.assign({}, DEFAULT_CACHE);
    } finally {
      this.syncedFiles = new Map(Object.entries(this.cache.syncedFiles));
    }
  }

  private async saveCache() {
    try {
      this.cache.syncedFiles = Object.fromEntries(this.syncedFiles);

      const cacheJson = JSON.stringify(this.cache, null, 2);
      await this.app.vault.adapter.write(
        `${this.manifest.dir}/${CloudflareKVPlugin.cacheFile}`,
        cacheJson
      );
    } catch (error) {
      console.error("Error saving cache:", error);
    }
  }

  async onunload() {
    await this.saveCache();

    for (const timeout of this.syncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.syncTimeouts.clear();
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

    containerEl.createEl("h2", { text: "Cloudflare KV Sync Settings" });

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
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync Key")
      .setDesc("Frontmatter key to check for sync flag (must be true to sync)")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.syncKey)
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
          .setPlaceholder(DEFAULT_SETTINGS.idKey)
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
          .setPlaceholder(DEFAULT_SETTINGS.debounceDelay.toString())
          .setValue(this.plugin.settings.debounceDelay.toString())
          .onChange(async (value) => {
            this.plugin.settings.debounceDelay = parseInt(value);
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

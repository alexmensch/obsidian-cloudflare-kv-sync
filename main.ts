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
  debounceDelay: 60
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
  private loadedSuccesfully: boolean = false;

  async onload() {
    try {
      await this.loadSettings();
      await this.loadCache();
      this.addSettingTab(new CloudflareKVSettingsTab(this.app, this));
      this.loadedSuccesfully = true;
    } catch (e) {
      console.error(`Unable to load plugin, error: ${e}`);
      new Notice(
        "Cloudflare kv sync plugin failed to load. See console for details."
      );
      return;
    }

    if (this.loadedSuccesfully) {
      this.registerCommands();
      this.registerEvents();
    }
  }

  private registerCommands() {
    this.addRibbonIcon("cloud-upload", "Sync to cloudflare kv", () => {
      void this.syncAllFiles();
      void this.removeOrphanedUploads();
    });

    this.addCommand({
      id: "sync-current-file-to-kv",
      name: "Sync current file to cloudflare kv",
      callback: () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          void this.syncSingleFile(activeFile);
        } else {
          new Notice("No active file to sync");
        }
      }
    });

    this.addCommand({
      id: "sync-all-files-to-kv",
      name: "Sync all marked files to cloudflare kv",
      callback: () => {
        void this.syncAllFiles();
        void this.removeOrphanedUploads();
      }
    });
  }

  private registerEvents() {
    if (this.settings.autoSync) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debouncedFileSync(file);
          }
        })
      );
    }
  }

  private debouncedFileSync(file: TFile) {
    const existingTimeout = this.syncTimeouts.get(file.path);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      this.syncSingleFile(file)
        .catch((error) => {
          console.error("Error in debounced sync:", error);
        })
        .finally(() => {
          this.syncTimeouts.delete(file.path);
        });
    }, this.settings.debounceDelay * 1000);

    this.syncTimeouts.set(file.path, timeout);
  }

  private async syncSingleFile(file: TFile) {
    if (!this.validateSettings()) {
      return;
    }

    const syncResult = await this.syncFile(file);
    await this.saveCache();

    if (syncResult.skipped === true) {
      new Notice("File not marked for sync");
    } else if (syncResult.sync) {
      const sync = syncResult.sync;

      if (sync.success === true) {
        new Notice("Successful sync");
      } else {
        new Notice(`Error syncing: ${sync.error}`);
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

      if (syncResult.skipped === false) {
        if (syncResult.sync) {
          if (syncResult.sync.success === true) {
            successful++;
          } else {
            failed++;
            console.error(`cloudflare kv API error: ${syncResult.sync.error}`);
          }
        } else if (syncResult.error) {
          failed++;
          console.error(`Sync error: ${syncResult.error}`);
        }
      }
    }

    await this.saveCache();

    new Notice(`ℹ️ Sync complete: ${successful} successful, ${failed} failed`);
  }

  private async syncFile(file: TFile): Promise<SyncResult> {
    const result: SyncResult = { ...SKIPPED_SYNC_RESULT };
    const frontmatter = await this.getFrontmatter(file);
    const syncValue = this.coerceBoolean(frontmatter?.[this.settings.syncKey]);
    const docId = this.coerceString(frontmatter?.[this.settings.idKey]);
    const fileContent = await this.app.vault.cachedRead(file);
    const previousKVKey = this.syncedFiles.get(file.path);

    if (previousKVKey && (!frontmatter || !syncValue || !docId)) {
      // File was previously synced, but is now missing metadata needed for sync
      result.skipped = false;
      result.sync = await this.deleteFromkv(previousKVKey);
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

    const currentkvKey = this.buildkvKey(frontmatter);

    if (syncValue) {
      // File is marked for sync
      result.skipped = false;

      if (previousKVKey && previousKVKey !== currentkvKey) {
        // File's sync key has changed
        const deleteResult = await this.deleteFromkv(previousKVKey);

        if (deleteResult.success === false) {
          result.error = `Unable to delete old kv entry: ${deleteResult.error}`;
          return result;
        }
        this.syncedFiles.delete(file.path);
      }

      result.sync = await this.uploadTokv(currentkvKey, fileContent);

      if (result.sync.success) this.syncedFiles.set(file.path, currentkvKey);
    } else if (previousKVKey) {
      // File was previously synced, but no longer marked for sync
      result.skipped = false;
      result.sync = await this.deleteFromkv(previousKVKey);

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
      const result = await this.deleteFromkv(kvKey);
      if (result.success === true) {
        successful++;
        this.syncedFiles.delete(filePath);
      } else {
        failed++;
        console.error(`cloudflare kv API error: ${result.error}`);
      }
    }

    await this.saveCache();

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
        const raw: unknown = parseYaml(frontmatterMatch[1]);
        if (raw && typeof raw === "object" && !Array.isArray(raw))
          return raw as Record<string, unknown>;
        return null;
      } catch (error) {
        console.error("Error parsing frontmatter:", error);
        return null;
      }
    } catch (error) {
      console.error(`Error reading file: ${file.name}`, error);
      return null;
    }
  }

  private buildkvKey(frontmatter: Record<string, unknown>): string | null {
    const docId = this.coerceString(frontmatter[this.settings.idKey]);
    const collection = this.coerceString(frontmatter["collection"]);

    return collection ? `${collection}/${docId}` : docId;
  }

  private coerceBoolean(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value === "string") return value.toLowerCase() === "true";
    return false;
  }

  private coerceString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

    const raw: unknown = JSON.parse(response.text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const data = raw as Record<string, unknown>;
      if (!data.success) {
        return { success: false, error: `${JSON.stringify(data.errors)}` };
      }
      return { success: true };
    }
    throw new Error(
      `Unexpected response from cloudflare kv API, response body is ${typeof raw}`
    );
  }

  private async uploadTokv(
    key: string,
    value: string
  ): Promise<SyncActionResult> {
    return {
      action: "create",
      ...(await this.kvRequest(key, "PUT", value))
    };
  }

  private async deleteFromkv(key: string): Promise<SyncActionResult> {
    return {
      action: "delete",
      ...(await this.kvRequest(key, "DELETE"))
    };
  }

  private async loadSettings() {
    const raw: unknown = await this.loadData();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const settingsData = raw as Record<string, unknown>;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    } else {
      throw new Error(
        `Unexpected response from settings data load, loadData response is ${typeof raw}`
      );
    }
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
      new Notice("Cloudflare kv sync plugin requires configuration");
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
      const raw: unknown = JSON.parse(cacheData);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const parsed = raw as Record<string, unknown>;
        this.cache = Object.assign({}, DEFAULT_CACHE, parsed);
      } else {
        throw new Error(
          `Unable to parse cache file, parsed object was type ${typeof raw}`
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("ENOENT")) {
        this.cache = Object.assign({}, DEFAULT_CACHE);
      } else {
        throw e;
      }
    }

    try {
      this.syncedFiles = new Map(Object.entries(this.cache.syncedFiles));
    } catch (e) {
      throw new Error(`Failed to read cached data: ${e}`);
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

  onunload() {
    if (this.loadedSuccesfully) {
      this.saveCache().catch((error) => {
        console.error("Error saving cache to disk: ", error);
      });
      this.unregisterEvents();
    }
  }

  private unregisterEvents() {
    for (const timeout of this.syncTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.syncTimeouts.clear();
  }
}

class CloudflareKVSettingsTab extends PluginSettingTab {
  plugin: CloudflareKVPlugin;

  constructor(app: App, plugin: CloudflareKVPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Cloudflare account ID")
      .setDesc("The cloudflare account ID that holds the kv namespace")
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
      .setName("Kv namespace ID")
      .setDesc("The cloudflare kv namespace ID where your content is stored")
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
      .setName("Cloudflare API token")
      .setDesc("Your cloudflare API token with kv read/write permissions")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync property name")
      .setDesc(
        "The name of the boolean property name that determines whether the note will be synced"
      )
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
      .setName("Note ID property name")
      .setDesc(
        "The name of the property that holds a unique ID for each synced document"
      )
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
      .setName("Auto-sync on modify")
      .setDesc(
        "Whether notes should be automatically synced when they are modified"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-sync delay (seconds)")
      .setDesc("How long to wait before syncing after modifying a note")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.debounceDelay.toString())
          .setValue(this.plugin.settings.debounceDelay.toString())
          .onChange(async (value) => {
            this.plugin.settings.debounceDelay = parseInt(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Setting up note properties").setHeading();
    const ol = containerEl.createEl("ol");
    ol.createEl("li", {}, (li) => {
      li.appendText(
        `Set the sync property (default: "${DEFAULT_SETTINGS.syncKey}") to `
      );
      li.createEl("strong", { text: "True" });
      li.appendText(
        " in note properties to sync a note to your cloudflare kv namespace."
      );
    });
    ol.createEl("li", {}, (li) => {
      li.appendText(
        `Ensure each note has a unique ID property (default: "${DEFAULT_SETTINGS.idKey}"). You can use `
      );
      li.createEl("a", {
        text: "This plugin",
        href: "obsidian://show-plugin?id=guid-front-matter"
      });
      li.appendText(" to do this automatically.");
    });
    ol.createEl("li", {
      text: 'You may optionally add a "collection" property, the value of which will be added as a prefix to the ID property when stored in kv.'
    });

    containerEl.createEl("p", {
      text: "When synchronising, the state in Obsidian will always take priority over the remote state in kv, so you can be sure that the remote state matches what you see in your local vault. Any previously synced notes that no longer exist in Obsidian will be deleted in kv."
    });

    new Setting(containerEl).setName("Example front matter").setHeading();
    containerEl.createEl("pre").createEl("code", {
      text: [
        "---",
        "id: my-unique-post-id",
        "kv_sync: true",
        "collection: writing",
        "title: My Blog Post",
        "---"
      ].join("\n")
    });
    containerEl.createEl("p", {}, (p) => {
      p.appendText("This would create a kv pair with the key: ");
      p.createEl("code", { text: "Writing-my-unique-post-id" });
    });
    containerEl.createEl("p", {}, (p) => {
      p.appendText("Without the collection property, kv pair key would be: ");
      p.createEl("code", { text: "My-unique-post-id" });
    });
  }
}

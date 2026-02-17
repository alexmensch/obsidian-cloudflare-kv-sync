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

const ERROR_LOG_FILE = "Cloudflare KV Sync error log.md";

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
      new Notice(
        "Cloudflare kv sync plugin failed to load. See error log for details."
      );
      void this.writeErrorLog(`Plugin failed to load: ${e}`);
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
          void this.syncSingleFile(activeFile, true);
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
          void this.writeErrorLog(
            `Error in debounced sync of ${file.path}: ${error}`
          );
        })
        .finally(() => {
          this.syncTimeouts.delete(file.path);
        });
    }, this.settings.debounceDelay * 1000);

    this.syncTimeouts.set(file.path, timeout);
  }

  private async syncSingleFile(file: TFile, notifyOutcome: boolean = false) {
    if (!this.validateSettings()) {
      return;
    }

    const syncResult = await this.syncFile(file);
    await this.saveCache();

    if (syncResult.skipped === true) {
      if (notifyOutcome) new Notice("File not marked for sync");
    } else if (syncResult.sync) {
      const sync = syncResult.sync;

      if (sync.success === true) {
        if (notifyOutcome) new Notice("Successful sync");
      } else {
        if (notifyOutcome) new Notice(`Error syncing: ${sync.error}`);
        await this.writeErrorLog(
          `Error syncing ${file.path}: ${sync.error}`
        );
      }
    }
  }

  private async syncAllFiles() {
    if (!this.validateSettings()) {
      return;
    }

    new Notice("Syncing all notes in your vault...");

    const files = this.app.vault.getMarkdownFiles();

    await this.detectAndFixDuplicates(files);

    let successful = 0;
    let failed = 0;
    const errorMessages: string[] = [];

    for (const file of files) {
      const syncResult = await this.syncFile(file);

      if (syncResult.skipped === false) {
        if (syncResult.sync) {
          if (syncResult.sync.success === true) {
            successful++;
          } else {
            failed++;
            errorMessages.push(
              `API error syncing ${file.path}: ${syncResult.sync.error}`
            );
          }
        } else if (syncResult.error) {
          failed++;
          errorMessages.push(
            `Sync error for ${file.path}: ${syncResult.error}`
          );
        }
      }
    }

    await this.saveCache();

    if (errorMessages.length > 0) {
      await this.writeErrorLog(errorMessages);
    }

    new Notice(`ℹ️ Sync complete: ${successful} successful, ${failed} failed`);
  }

  private async syncFile(file: TFile): Promise<SyncResult> {
    const result: SyncResult = { ...SKIPPED_SYNC_RESULT };
    let frontmatter = await this.getFrontmatter(file);
    const syncValue = this.coerceBoolean(frontmatter?.[this.settings.syncKey]);
    let docId = this.coerceString(frontmatter?.[this.settings.idKey]);
    let previousKVKey = this.syncedFiles.get(file.path);

    if (previousKVKey && (!frontmatter || !syncValue)) {
      // File was previously synced, but now lacks frontmatter or sync flag
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
      if (previousKVKey) {
        // ID was removed from a previously synced file — delete old key first
        result.skipped = false;
        const deleteResult = await this.deleteFromKV(previousKVKey);
        if (deleteResult.success === false) {
          result.error = `Unable to delete old kv entry: ${deleteResult.error}`;
          return result;
        }
        this.syncedFiles.delete(file.path);
        previousKVKey = undefined;
      }
      docId = await this.assignIdToFile(file);
      frontmatter = await this.getFrontmatter(file);
      if (!frontmatter) {
        result.error = `No frontmatter found in ${file.name}`;
        return result;
      }
    }

    const fileContent = await this.app.vault.cachedRead(file);
    const currentKVKey = this.buildKVKey(frontmatter);

    // File is marked for sync (syncValue guaranteed true at this point)
    result.skipped = false;

    if (previousKVKey && previousKVKey !== currentKVKey) {
      // File's sync key has changed
      const deleteResult = await this.deleteFromKV(previousKVKey);

      if (deleteResult.success === false) {
        result.error = `Unable to delete old kv entry: ${deleteResult.error}`;
        return result;
      }
      this.syncedFiles.delete(file.path);
    }

    result.sync = await this.uploadToKV(currentKVKey, fileContent);

    if (result.sync.success) this.syncedFiles.set(file.path, currentKVKey);

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
    const errorMessages: string[] = [];

    for (const { filePath, kvKey } of entriesToRemove) {
      const result = await this.deleteFromKV(kvKey);
      if (result.success === true) {
        successful++;
        this.syncedFiles.delete(filePath);
      } else {
        failed++;
        errorMessages.push(
          `API error removing orphan ${kvKey}: ${result.error}`
        );
      }
    }

    await this.saveCache();

    if (errorMessages.length > 0) {
      await this.writeErrorLog(errorMessages);
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
        const raw: unknown = parseYaml(frontmatterMatch[1]);
        if (raw && typeof raw === "object" && !Array.isArray(raw))
          return raw as Record<string, unknown>;
        return null;
      } catch (error) {
        void this.writeErrorLog(
          `Error parsing frontmatter in ${file.name}: ${error}`
        );
        return null;
      }
    } catch (error) {
      void this.writeErrorLog(`Error reading file ${file.name}: ${error}`);
      return null;
    }
  }

  private buildKVKey(frontmatter: Record<string, unknown>): string | null {
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
    const raw: unknown = await this.loadData();
    if (raw === null) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    } else {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const settingsData = raw as Record<string, unknown>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
      } else {
        throw new Error(
          `Unexpected response from settings data load, loadData response is ${typeof raw}`
        );
      }
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
      void this.writeErrorLog(
        "Plugin requires configuration (missing credentials)"
      );
      return false;
    }

    if (!this.app.secretStorage.getSecret(this.settings.apiToken)) {
      const msg = `Keychain secret "${this.settings.apiToken}" requires a value`;
      new Notice(msg);
      void this.writeErrorLog(msg);
      return false;
    }

    return true;
  }

  private async loadCache() {
    const cacheFile = `${this.manifest.dir}/${CloudflareKVPlugin.cacheFile}`;

    if (await this.app.vault.adapter.exists(cacheFile)) {
      const cacheData = await this.app.vault.adapter.read(cacheFile);
      const raw: unknown = JSON.parse(cacheData);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const parsed = raw as Record<string, unknown>;
        this.cache = Object.assign({}, DEFAULT_CACHE, parsed);
      } else {
        throw new Error(
          `Unable to parse cache file, parsed object was type ${typeof raw}`
        );
      }
    } else {
      this.cache = Object.assign({}, DEFAULT_CACHE);
    }

    try {
      this.syncedFiles = new Map(Object.entries(this.cache.syncedFiles));
      /* istanbul ignore next */
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
      await this.writeErrorLog(`Error saving cache: ${error}`);
    }
  }

  private formatErrorLogHeader(): string {
    const now = new Date();
    const day = now.getDate();
    const month = now.toLocaleString("en-US", { month: "short" });
    const year = now.getFullYear();
    const time = now.toTimeString().slice(0, 8);
    return `\n## ${day} ${month} ${year}, ${time}\n`;
  }

  async writeErrorLog(messages: string | string[]): Promise<void> {
    const lines = Array.isArray(messages) ? messages : [messages];
    const entry = `${this.formatErrorLogHeader()}${lines.map((m) => `- ${m}`).join("\n")}\n`;

    try {
      if (await this.app.vault.adapter.exists(ERROR_LOG_FILE)) {
        const existing = await this.app.vault.adapter.read(ERROR_LOG_FILE);
        await this.app.vault.adapter.write(ERROR_LOG_FILE, existing + entry);
      } else {
        await this.app.vault.adapter.write(ERROR_LOG_FILE, entry);
      }
    } catch (error) {
      console.error("Failed to write error log:", error);
    }
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  async assignIdToFile(file: TFile): Promise<string> {
    const newId = this.generateId();
    await this.app.fileManager.processFrontMatter(
      file,
      (fm: Record<string, unknown>) => {
        fm[this.settings.idKey] = newId;
      }
    );
    return newId;
  }

  private async detectAndFixDuplicates(files: TFile[]): Promise<void> {
    const keyMap = new Map<string, Array<{ file: TFile; docId: string }>>();

    for (const file of files) {
      const frontmatter = await this.getFrontmatter(file);
      if (!frontmatter) continue;
      const syncValue = this.coerceBoolean(
        frontmatter[this.settings.syncKey]
      );
      if (!syncValue) continue;
      const docId = this.coerceString(frontmatter[this.settings.idKey]);
      if (!docId) continue;

      const kvKey = this.buildKVKey(frontmatter);
      if (!kvKey) continue;

      const entries = keyMap.get(kvKey) || [];
      entries.push({ file, docId });
      keyMap.set(kvKey, entries);
    }

    const errorMessages: string[] = [];

    for (const [key, entries] of keyMap.entries()) {
      if (entries.length <= 1) continue;

      entries.sort((a, b) => a.file.path.localeCompare(b.file.path));

      for (let i = 1; i < entries.length; i++) {
        const { file, docId: oldId } = entries[i];
        const newId = await this.assignIdToFile(file);
        errorMessages.push(
          `Duplicate KV key "${key}" in ${file.path}: replaced ID "${oldId}" with "${newId}"`
        );
      }
    }

    if (errorMessages.length > 0) {
      await this.writeErrorLog(errorMessages);
    }
  }

  onunload() {
    if (this.loadedSuccesfully) {
      /* istanbul ignore next */
      this.saveCache().catch(() => {});
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

/* istanbul ignore next -- @preserve UI component excluded from test coverage */
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
        "The name of the property that holds a unique ID for each synced document. If empty, a unique ID will be automatically generated."
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
    ol.createEl("li", {
      text: `A unique ID property (default: "${DEFAULT_SETTINGS.idKey}") will be automatically generated if empty or missing. If an ID already exists, it will be used as-is.`
    });
    ol.createEl("li", {
      text: 'You may optionally add a "collection" property, the value of which will be added as a prefix to the ID property when stored in kv.'
    });

    containerEl.createEl("p", {
      text: "When synchronising, the state in Obsidian will always take priority over the remote state in kv, so you can be sure that the remote state matches what you see in your local vault. Any previously synced notes that no longer exist in Obsidian will be deleted in kv.",
      cls: "cloudflare-kv-sync-padding"
    });

    new Setting(containerEl).setName("Example front matter").setHeading();
    containerEl
      .createEl("pre", { cls: "cloudflare-kv-sync-padding" })
      .createEl("code", {
        text: [
          "---",
          "id: my-unique-post-id",
          "kv_sync: true",
          "collection: writing",
          "title: My Blog Post",
          "---"
        ].join("\n")
      });
    containerEl.createEl("p", { cls: "cloudflare-kv-sync-padding" }, (p) => {
      p.appendText("This would create a kv pair with the key: ");
      p.createEl("code", { text: "Writing-my-unique-post-id" });
    });
    containerEl.createEl("p", { cls: "cloudflare-kv-sync-padding" }, (p) => {
      p.appendText("Without the collection property, kv pair key would be: ");
      p.createEl("code", { text: "My-unique-post-id" });
    });
  }
}

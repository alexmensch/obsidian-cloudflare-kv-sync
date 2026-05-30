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

// Cap the error log so a misconfigured auto-sync can't balloon a vault file.
// At the cap we keep roughly the newest half; normal writes just append.
const MAX_ERROR_LOG_BYTES = 1_000_000;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Accumulates per-item results for a batch operation (sync-all, orphan cleanup)
// so the surrounding method doesn't hand-roll the success/failure/error tally.
class BatchOutcome {
  successful = 0;
  failed = 0;
  readonly errors: string[] = [];

  recordSuccess(): void {
    this.successful++;
  }

  recordFailure(message: string): void {
    this.failed++;
    this.errors.push(message);
  }
}

export default class CloudflareKVPlugin extends Plugin {
  settings!: CloudflareKVSettings;
  private syncTimeouts: Map<string, number> = new Map();
  private syncedFiles: Map<string, string> = new Map();
  private static cacheFile: string = "cache.json";
  private loadedSuccessfully: boolean = false;

  private get cachePath(): string {
    return `${this.manifest.dir}/${CloudflareKVPlugin.cacheFile}`;
  }

  async onload() {
    try {
      await this.loadSettings();
      await this.loadCache();
      this.addSettingTab(new CloudflareKVSettingsTab(this.app, this));
      this.loadedSuccessfully = true;
    } catch (e) {
      new Notice(
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        "Cloudflare KV sync plugin failed to load. See error log for details."
      );
      void this.writeErrorLog(`Plugin failed to load: ${String(e)}`);
      return;
    }

    this.registerCommands();
    this.registerEvents();
  }

  private registerCommands() {
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    this.addRibbonIcon("cloud-upload", "Sync to Cloudflare KV", () => {
      void this.syncAllAndCleanup();
    });

    this.addCommand({
      id: "sync-current-file-to-kv",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      name: "Sync current file to Cloudflare KV",
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      name: "Sync all marked files to Cloudflare KV",
      callback: () => {
        void this.syncAllAndCleanup();
      }
    });
  }

  // Sync-all and orphan cleanup both mutate syncedFiles and write cache.json.
  // They must run sequentially — concurrent runs corrupt the map mid-iteration
  // and race the cache write (last-writer-wins).
  private async syncAllAndCleanup(): Promise<void> {
    await this.syncAllFiles();
    await this.removeOrphanedUploads();
  }

  private registerEvents() {
    // Register unconditionally and gate on the live setting inside the handler,
    // so toggling auto-sync takes effect immediately without a plugin reload.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (
          this.settings.autoSync &&
          file instanceof TFile &&
          file.extension === "md"
        ) {
          this.debouncedFileSync(file);
        }
      })
    );
  }

  private debouncedFileSync(file: TFile) {
    const existingTimeout = this.syncTimeouts.get(file.path);
    if (existingTimeout) {
      activeWindow.clearTimeout(existingTimeout);
    }

    const timeout = activeWindow.setTimeout(() => {
      this.syncSingleFile(file)
        .catch((error) => {
          void this.writeErrorLog(
            `Error in debounced sync of ${file.path}: ${String(error)}`
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

    let syncResult: SyncResult;
    try {
      syncResult = await this.syncFile(file);
    } catch (error) {
      // syncFile may throw on a malformed API body or a frontmatter-write
      // failure; the command/ribbon callbacks fire this with `void`, so an
      // uncaught rejection would float. Log it and still persist any partial
      // cache mutation.
      await this.writeErrorLog(`Error syncing ${file.path}: ${String(error)}`);
      if (notifyOutcome) new Notice(`Error syncing: ${String(error)}`);
      await this.saveCache();
      return;
    }
    await this.saveCache();

    if (syncResult.skipped === true) {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      if (notifyOutcome) new Notice("ℹ️ File not marked for sync");
    } else if (syncResult.sync) {
      const sync = syncResult.sync;

      if (sync.success === true) {
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        if (notifyOutcome) new Notice("✅ Successful sync");
      } else {
        if (notifyOutcome) new Notice(`Error syncing: ${sync.error}`);
        await this.writeErrorLog(`Error syncing ${file.path}: ${sync.error}`);
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

    const outcome = new BatchOutcome();

    for (const file of files) {
      try {
        const syncResult = await this.syncFile(file);

        if (syncResult.skipped === false) {
          if (syncResult.sync) {
            if (syncResult.sync.success === true) {
              outcome.recordSuccess();
            } else {
              outcome.recordFailure(
                `API error syncing ${file.path}: ${syncResult.sync.error}`
              );
            }
          } else if (syncResult.error) {
            outcome.recordFailure(
              `Sync error for ${file.path}: ${syncResult.error}`
            );
          }
        }
      } catch (error) {
        // A single file's failure must not abort the batch or leave the cache
        // unsaved — route it to the log and keep going.
        outcome.recordFailure(
          `Unexpected error syncing ${file.path}: ${String(error)}`
        );
      }
    }

    await this.finishBatch(outcome, "Sync complete", true);
  }

  // Persists the cache, logs any accumulated errors, and surfaces a summary
  // notice — the shared tail of every batch operation. `notifyWhenEmpty`
  // controls whether the notice fires when nothing was processed.
  private async finishBatch(
    outcome: BatchOutcome,
    completeLabel: string,
    notifyWhenEmpty: boolean
  ): Promise<void> {
    await this.saveCache();

    if (outcome.errors.length > 0) {
      await this.writeErrorLog(outcome.errors);
    }

    if (notifyWhenEmpty || outcome.successful > 0 || outcome.failed > 0) {
      new Notice(
        `ℹ️ ${completeLabel}: ${outcome.successful} successful, ${outcome.failed} failed`
      );
    }
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
          result.error = `Unable to delete old KV entry: ${deleteResult.error}`;
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

    if (!currentKVKey) {
      // docId is guaranteed above, so buildKVKey only returns null on a
      // malformed frontmatter race; fail loudly rather than PUT a null key.
      result.error = `Unable to build KV key for ${file.name}`;
      return result;
    }

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

    return result;
  }

  private async removeOrphanedUploads() {
    const entriesToRemove: Array<{ filePath: string; kvKey: string }> = [];

    for (const [filePath, kvKey] of this.syncedFiles.entries()) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile))
        entriesToRemove.push({ filePath, kvKey });
    }

    const outcome = new BatchOutcome();

    for (const { filePath, kvKey } of entriesToRemove) {
      const result = await this.deleteFromKV(kvKey);
      if (result.success === true) {
        outcome.recordSuccess();
        this.syncedFiles.delete(filePath);
      } else {
        outcome.recordFailure(
          `API error removing orphan ${kvKey}: ${result.error}`
        );
      }
    }

    await this.finishBatch(outcome, "Cleanup complete", false);
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
        if (isPlainObject(raw)) return raw;
        return null;
      } catch (error) {
        void this.writeErrorLog(
          `Error parsing frontmatter in ${file.name}: ${String(error)}`
        );
        return null;
      }
    } catch (error) {
      void this.writeErrorLog(
        `Error reading file ${file.name}: ${String(error)}`
      );
      return null;
    }
  }

  private buildKVKey(frontmatter: Record<string, unknown>): string | null {
    const docId = this.coerceString(frontmatter[this.settings.idKey]);
    if (!docId) return null;
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

  private encodeKVKeyForUrl(key: string): string {
    // Cloudflare's /values/:key route captures the path remainder greedily, so
    // the '/' separating collection and id must stay literal. Encode each
    // segment on its own — otherwise a space, '#', '?', '%', or unicode char
    // misroutes/404s. Slash-free ASCII keys are unchanged, so existing data is
    // not orphaned.
    return key.split("/").map(encodeURIComponent).join("/");
  }

  private async kvRequest(
    key: string,
    method: "PUT" | "DELETE",
    body?: string
  ): Promise<KVRequestResult> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/storage/kv/namespaces/${this.settings.namespaceId}/values/${this.encodeKVKeyForUrl(key)}`;
    const apiToken = this.app.secretStorage.getSecret(this.settings.apiToken);

    // throw:false — requestUrl throws on HTTP 400+ by default, which would
    // escape the per-file batch loop. Inspect status and return a structured
    // result instead.
    const response = await requestUrl({
      url,
      method,
      throw: false,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body ? { "Content-Type": "text/plain" } : {})
      },
      ...(body ? { body } : {})
    });

    if (response.status >= 400) {
      return { success: false, error: this.describeHttpError(response) };
    }

    const raw: unknown = JSON.parse(response.text);
    if (isPlainObject(raw)) {
      if (!raw.success) {
        return { success: false, error: `${JSON.stringify(raw.errors)}` };
      }
      return { success: true };
    }
    throw new Error(
      `Unexpected response from Cloudflare KV API, response body is ${typeof raw}`
    );
  }

  private describeHttpError(response: {
    status: number;
    text: string;
  }): string {
    try {
      const raw: unknown = JSON.parse(response.text);
      if (isPlainObject(raw) && "errors" in raw) {
        return `HTTP ${response.status}: ${JSON.stringify(raw.errors)}`;
      }
    } catch {
      // Non-JSON error body (e.g. an HTML error page) — fall back to status.
    }
    return `HTTP ${response.status}`;
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

  // Validates that persisted JSON is an object and merges it over the defaults.
  // `describeInvalid` builds the caller-specific error for non-object payloads.
  private mergeWithDefaults<T extends object>(
    raw: unknown,
    defaults: T,
    describeInvalid: (type: string) => string
  ): T {
    if (!isPlainObject(raw)) {
      throw new Error(describeInvalid(typeof raw));
    }
    return Object.assign({}, defaults, raw);
  }

  private async loadSettings() {
    const raw: unknown = await this.loadData();
    this.settings =
      raw === null
        ? Object.assign({}, DEFAULT_SETTINGS)
        : this.mergeWithDefaults(
            raw,
            DEFAULT_SETTINGS,
            (type) =>
              `Unexpected response from settings data load, loadData response is ${type}`
          );
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      new Notice("Cloudflare KV Sync plugin requires configuration");
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
    let syncedFiles: Record<string, string> = {};

    if (await this.app.vault.adapter.exists(this.cachePath)) {
      const raw: unknown = JSON.parse(
        await this.app.vault.adapter.read(this.cachePath)
      );
      const cache = this.mergeWithDefaults(
        raw,
        DEFAULT_CACHE,
        (type) => `Unable to parse cache file, parsed object was type ${type}`
      );
      syncedFiles = cache.syncedFiles;
    }

    try {
      this.syncedFiles = new Map(Object.entries(syncedFiles));
    } catch (e) {
      /* istanbul ignore next -- Object.entries/new Map can't throw on a validated record */
      throw new Error(`Failed to read cached data: ${String(e)}`);
    }
  }

  private async saveCache() {
    try {
      const cache: CloudflareKVCache = {
        syncedFiles: Object.fromEntries(this.syncedFiles)
      };
      await this.app.vault.adapter.write(
        this.cachePath,
        JSON.stringify(cache, null, 2)
      );
    } catch (error) {
      await this.writeErrorLog(`Error saving cache: ${String(error)}`);
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

    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(ERROR_LOG_FILE))) {
        await adapter.write(ERROR_LOG_FILE, entry);
        return;
      }

      // Hot path: append in O(1) — no full-file read. Only when the log
      // crosses the cap do we pay a read+rewrite to drop the oldest entries.
      const stat = await adapter.stat(ERROR_LOG_FILE);
      if (stat && stat.size > MAX_ERROR_LOG_BYTES) {
        const existing = await adapter.read(ERROR_LOG_FILE);
        await adapter.write(
          ERROR_LOG_FILE,
          this.trimErrorLog(existing) + entry
        );
      } else {
        await adapter.append(ERROR_LOG_FILE, entry);
      }
    } catch (error) {
      console.error("Failed to write error log:", error);
    }
  }

  // Keep roughly the newest half of the log, cut at an entry boundary so the
  // retained text starts with a whole `## <datetime>` header.
  private trimErrorLog(existing: string): string {
    const tail = existing.slice(-Math.floor(MAX_ERROR_LOG_BYTES / 2));
    const boundary = tail.indexOf("\n## ");
    return boundary >= 0 ? tail.slice(boundary + 1) : tail;
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
      const syncValue = this.coerceBoolean(frontmatter[this.settings.syncKey]);
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
    if (this.loadedSuccessfully) {
      /* istanbul ignore next */
      this.saveCache().catch(() => {});
      this.unregisterEvents();
    }
  }

  private unregisterEvents() {
    for (const timeout of this.syncTimeouts.values()) {
      activeWindow.clearTimeout(timeout);
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("The Cloudflare account ID that holds the KV namespace")
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName("KV namespace ID")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("The Cloudflare KV namespace ID where your content is stored")
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("Your Cloudflare API token with KV read/write permissions")
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
            const parsed = parseInt(value, 10);
            // NaN or negative input would make setTimeout fire immediately;
            // fall back to the default delay instead.
            this.plugin.settings.debounceDelay =
              Number.isFinite(parsed) && parsed >= 0
                ? parsed
                : DEFAULT_SETTINGS.debounceDelay;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Setting up note properties").setHeading();
    const ol = containerEl.createEl("ol");
    ol.createEl("li", {}, (li) => {
      li.appendText(
        `Set the sync property (default: "${DEFAULT_SETTINGS.syncKey}") to `
      );
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      li.createEl("strong", { text: "true" });
      li.appendText(
        " in note properties to sync a note to your Cloudflare KV namespace."
      );
    });
    ol.createEl("li", {
      text: `A unique ID property (default: "${DEFAULT_SETTINGS.idKey}") will be automatically generated if empty or missing. If an ID already exists, it will be used as-is.`
    });
    ol.createEl("li", {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: 'You may optionally add a "collection" property, the value of which will be added as a prefix to the ID property when stored in KV.'
    });

    containerEl.createEl("p", {
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "When synchronising, the state in Obsidian will always take priority over the remote state in KV, so you can be sure that the remote state matches what you see in your local vault. Any previously synced notes that no longer exist in Obsidian will be deleted in KV.",
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
      p.appendText("This would create a KV pair with the key: ");
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      p.createEl("code", { text: "writing/my-unique-post-id" });
    });
    containerEl.createEl("p", { cls: "cloudflare-kv-sync-padding" }, (p) => {
      p.appendText("Without the collection property, KV pair key would be: ");
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      p.createEl("code", { text: "my-unique-post-id" });
    });
  }
}

import CloudflareKVPlugin from "../../main";
import { TFile, requestUrl, parseYaml, Notice } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod,
  getPrivateProperty
} from "../helpers/plugin-test-helper";
import { createMockTFile, createMockNotice } from "../mocks/obsidian-mocks";
import { mockSuccessResponse } from "../mocks/cloudflare-mocks";

describe("Plugin lifecycle", () => {
  describe("onload", () => {
    let plugin: CloudflareKVPlugin;

    beforeEach(async () => {
      plugin = await createTestPlugin();
    });

    it("should have settings loaded after createTestPlugin", () => {
      expect(plugin.settings).toBeDefined();
      expect(plugin.settings.accountId).toBe("test-account-id");
    });

    it("should have cache loaded after createTestPlugin", () => {
      const syncedFiles = getPrivateProperty<Map<string, string>>(
        plugin,
        "syncedFiles"
      );
      expect(syncedFiles).toBeInstanceOf(Map);
    });

    it("should initialize properly when onload is called", async () => {
      // Create a fresh plugin without pre-loading
      const freshPlugin = Object.create(
        CloudflareKVPlugin.prototype
      ) as CloudflareKVPlugin;

      const mockApp = plugin.app;
      (freshPlugin as unknown as { app: typeof mockApp }).app = mockApp;
      (freshPlugin as unknown as { manifest: { dir: string } }).manifest = {
        dir: ".obsidian/plugins/cloudflare-kv-sync"
      };
      (
        freshPlugin as unknown as { syncTimeouts: Map<string, NodeJS.Timeout> }
      ).syncTimeouts = new Map();
      (
        freshPlugin as unknown as { syncedFiles: Map<string, string> }
      ).syncedFiles = new Map();
      (
        freshPlugin as unknown as { loadedSuccesfully: boolean }
      ).loadedSuccesfully = false;

      freshPlugin.loadData = jest.fn().mockResolvedValue({
        accountId: "test",
        namespaceId: "test",
        apiToken: "token"
      });
      freshPlugin.saveData = jest.fn();
      freshPlugin.addSettingTab = jest.fn();
      freshPlugin.addRibbonIcon = jest.fn();
      freshPlugin.addCommand = jest.fn();
      freshPlugin.registerEvent = jest.fn();

      await freshPlugin.onload();

      expect(freshPlugin.addSettingTab).toHaveBeenCalled();
      expect(
        (freshPlugin as unknown as { loadedSuccesfully: boolean })
          .loadedSuccesfully
      ).toBe(true);
    });

    it("should handle errors during onload gracefully", async () => {
      const freshPlugin = Object.create(
        CloudflareKVPlugin.prototype
      ) as CloudflareKVPlugin;

      const mockApp = plugin.app;
      (freshPlugin as unknown as { app: typeof mockApp }).app = mockApp;
      (freshPlugin as unknown as { manifest: { dir: string } }).manifest = {
        dir: ".obsidian/plugins/cloudflare-kv-sync"
      };
      (
        freshPlugin as unknown as { syncTimeouts: Map<string, NodeJS.Timeout> }
      ).syncTimeouts = new Map();
      (
        freshPlugin as unknown as { syncedFiles: Map<string, string> }
      ).syncedFiles = new Map();
      (
        freshPlugin as unknown as { loadedSuccesfully: boolean }
      ).loadedSuccesfully = false;

      // Make loadData throw
      freshPlugin.loadData = jest.fn().mockRejectedValue(new Error("Load failed"));
      freshPlugin.saveData = jest.fn();
      freshPlugin.addSettingTab = jest.fn();
      freshPlugin.addRibbonIcon = jest.fn();
      freshPlugin.addCommand = jest.fn();
      freshPlugin.registerEvent = jest.fn();

      const noticeMock = createMockNotice();

      await freshPlugin.onload();

      expect(noticeMock).toHaveBeenCalledWith(
        expect.stringContaining("failed to load")
      );
      expect(
        (freshPlugin as unknown as { loadedSuccesfully: boolean })
          .loadedSuccesfully
      ).toBe(false);
      // Should not register commands on failure
      expect(freshPlugin.addRibbonIcon).not.toHaveBeenCalled();
    });

    it("should register commands after successful load", async () => {
      const freshPlugin = Object.create(
        CloudflareKVPlugin.prototype
      ) as CloudflareKVPlugin;

      const mockApp = plugin.app;
      (freshPlugin as unknown as { app: typeof mockApp }).app = mockApp;
      (freshPlugin as unknown as { manifest: { dir: string } }).manifest = {
        dir: ".obsidian/plugins/cloudflare-kv-sync"
      };
      (
        freshPlugin as unknown as { syncTimeouts: Map<string, NodeJS.Timeout> }
      ).syncTimeouts = new Map();
      (
        freshPlugin as unknown as { syncedFiles: Map<string, string> }
      ).syncedFiles = new Map();
      (
        freshPlugin as unknown as { loadedSuccesfully: boolean }
      ).loadedSuccesfully = false;
      freshPlugin.settings = { ...plugin.settings, autoSync: false };

      freshPlugin.loadData = jest.fn().mockResolvedValue({
        accountId: "test",
        namespaceId: "test"
      });
      freshPlugin.saveData = jest.fn();
      freshPlugin.addSettingTab = jest.fn();
      freshPlugin.addRibbonIcon = jest.fn();
      freshPlugin.addCommand = jest.fn();
      freshPlugin.registerEvent = jest.fn();

      await freshPlugin.onload();

      expect(freshPlugin.addRibbonIcon).toHaveBeenCalled();
      expect(freshPlugin.addCommand).toHaveBeenCalled();
    });
  });

  describe("onunload", () => {
    let plugin: CloudflareKVPlugin;

    beforeEach(async () => {
      plugin = await createTestPlugin();
    });

    it("should save cache on unload when loaded successfully", async () => {
      // Set loadedSuccessfully to true
      (plugin as unknown as { loadedSuccesfully: boolean }).loadedSuccesfully =
        true;

      // Add a file to the cache
      const syncedFiles = getPrivateProperty<Map<string, string>>(
        plugin,
        "syncedFiles"
      );
      syncedFiles.set("test.md", "test-key");

      // Call onunload
      plugin.onunload();

      // Give async saveCache a moment
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(plugin.app.vault.adapter.write).toHaveBeenCalled();
    });

    it("should clear timeouts on unload", async () => {
      (plugin as unknown as { loadedSuccesfully: boolean }).loadedSuccesfully =
        true;

      // Add a timeout
      const syncTimeouts = getPrivateProperty<Map<string, NodeJS.Timeout>>(
        plugin,
        "syncTimeouts"
      );
      const mockTimeout = setTimeout(() => {}, 10000);
      syncTimeouts.set("test.md", mockTimeout);

      expect(syncTimeouts.size).toBe(1);

      plugin.onunload();

      expect(syncTimeouts.size).toBe(0);
    });

    it("should not save cache if plugin did not load successfully", async () => {
      (plugin as unknown as { loadedSuccesfully: boolean }).loadedSuccesfully =
        false;

      plugin.onunload();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reset would be called in beforeEach of next test, so check call count
      expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
    });
  });

  describe("registerCommands", () => {
    let plugin: CloudflareKVPlugin;

    beforeEach(async () => {
      plugin = await createTestPlugin();
    });

    it("should add ribbon icon", () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      expect(plugin.addRibbonIcon).toHaveBeenCalledWith(
        "cloud-upload",
        "Sync to cloudflare kv",
        expect.any(Function)
      );
    });

    it("should add sync current file command", () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      expect(plugin.addCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sync-current-file-to-kv",
          name: "Sync current file to cloudflare kv"
        })
      );
    });

    it("should add sync all files command", () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      expect(plugin.addCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sync-all-files-to-kv",
          name: "Sync all marked files to cloudflare kv"
        })
      );
    });

    it("should show notice when no active file for sync command", () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      const noticeMock = createMockNotice();

      // Get the callback from addCommand
      const addCommandCalls = (plugin.addCommand as jest.Mock).mock.calls;
      const syncCurrentFileCmd = addCommandCalls.find(
        (call: unknown[]) =>
          (call[0] as { id: string }).id === "sync-current-file-to-kv"
      );
      const callback = (syncCurrentFileCmd[0] as { callback: () => void })
        .callback;

      // Simulate no active file
      (plugin.app.workspace.getActiveFile as jest.Mock).mockReturnValue(null);

      callback();

      expect(noticeMock).toHaveBeenCalledWith("No active file to sync");
    });

    it("should sync active file when sync command is executed with file", async () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      const file = createMockTFile("test.md");
      (plugin.app.workspace.getActiveFile as jest.Mock).mockReturnValue(file);
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(
        "---\nkv_sync: true\nid: test-id\n---\n"
      );
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ success: true })
      });

      const addCommandCalls = (plugin.addCommand as jest.Mock).mock.calls;
      const syncCurrentFileCmd = addCommandCalls.find(
        (call: unknown[]) =>
          (call[0] as { id: string }).id === "sync-current-file-to-kv"
      );
      const callback = (syncCurrentFileCmd[0] as { callback: () => void })
        .callback;

      callback();

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(requestUrl).toHaveBeenCalled();
    });

    it("should execute ribbon icon callback", async () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([]);
      (requestUrl as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ success: true })
      });

      const ribbonCallback = (plugin.addRibbonIcon as jest.Mock).mock
        .calls[0][2];
      ribbonCallback();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const noticeMock = createMockNotice();
      expect(noticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Syncing all notes")
      );
    });

    it("should execute sync all files command callback", async () => {
      const registerCommands = getPrivateMethod<() => void>(
        plugin,
        "registerCommands"
      );
      registerCommands();

      (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([]);
      (requestUrl as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ success: true })
      });

      const addCommandCalls = (plugin.addCommand as jest.Mock).mock.calls;
      const syncAllFilesCmd = addCommandCalls.find(
        (call: unknown[]) =>
          (call[0] as { id: string }).id === "sync-all-files-to-kv"
      );
      const callback = (syncAllFilesCmd[0] as { callback: () => void }).callback;

      callback();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const noticeMock = createMockNotice();
      expect(noticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Syncing all notes")
      );
    });
  });

  describe("registerEvents", () => {
    let plugin: CloudflareKVPlugin;

    beforeEach(async () => {
      jest.useFakeTimers();
      plugin = await createTestPlugin();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should register modify event when autoSync is enabled", () => {
      plugin.settings.autoSync = true;

      const registerEvents = getPrivateMethod<() => void>(
        plugin,
        "registerEvents"
      );
      registerEvents();

      expect(plugin.registerEvent).toHaveBeenCalled();
    });

    it("should not register modify event when autoSync is disabled", () => {
      plugin.settings.autoSync = false;

      const registerEvents = getPrivateMethod<() => void>(
        plugin,
        "registerEvents"
      );
      registerEvents();

      expect(plugin.registerEvent).not.toHaveBeenCalled();
    });

    it("should trigger debounced sync on markdown file modify", async () => {
      plugin.settings.autoSync = true;

      // Mock vault.on to capture the callback
      let modifyCallback: ((file: TFile) => void) | null = null;
      (plugin.app.vault.on as jest.Mock) = jest
        .fn()
        .mockImplementation((event: string, callback: (file: TFile) => void) => {
          if (event === "modify") {
            modifyCallback = callback;
          }
          return { event, callback };
        });

      const registerEvents = getPrivateMethod<() => void>(
        plugin,
        "registerEvents"
      );
      registerEvents();

      const file = createMockTFile("test.md");
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(
        "---\nkv_sync: true\nid: test-id\n---\n"
      );
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ success: true })
      });

      // Trigger the modify callback
      if (modifyCallback) {
        modifyCallback(file);
      }

      // Debounce timeout should be set
      const syncTimeouts = getPrivateProperty<Map<string, NodeJS.Timeout>>(
        plugin,
        "syncTimeouts"
      );
      expect(syncTimeouts.has(file.path)).toBe(true);

      // Advance timers to trigger sync
      await jest.advanceTimersByTimeAsync(60000);

      expect(requestUrl).toHaveBeenCalled();
    });

    it("should not sync non-markdown files on modify", async () => {
      plugin.settings.autoSync = true;

      let modifyCallback: ((file: TFile) => void) | null = null;
      (plugin.app.vault.on as jest.Mock) = jest
        .fn()
        .mockImplementation((event: string, callback: (file: TFile) => void) => {
          if (event === "modify") {
            modifyCallback = callback;
          }
          return { event, callback };
        });

      const registerEvents = getPrivateMethod<() => void>(
        plugin,
        "registerEvents"
      );
      registerEvents();

      const file = createMockTFile("test.txt", { extension: "txt" });

      if (modifyCallback) {
        modifyCallback(file);
      }

      const syncTimeouts = getPrivateProperty<Map<string, NodeJS.Timeout>>(
        plugin,
        "syncTimeouts"
      );
      expect(syncTimeouts.has(file.path)).toBe(false);
    });
  });

  describe("unregisterEvents", () => {
    let plugin: CloudflareKVPlugin;

    beforeEach(async () => {
      plugin = await createTestPlugin();
    });

    it("should clear all sync timeouts", () => {
      const syncTimeouts = getPrivateProperty<Map<string, NodeJS.Timeout>>(
        plugin,
        "syncTimeouts"
      );

      // Add some mock timeouts
      const timeout1 = setTimeout(() => {}, 10000);
      const timeout2 = setTimeout(() => {}, 10000);
      syncTimeouts.set("file1.md", timeout1);
      syncTimeouts.set("file2.md", timeout2);

      const unregisterEvents = getPrivateMethod<() => void>(
        plugin,
        "unregisterEvents"
      );
      unregisterEvents();

      expect(syncTimeouts.size).toBe(0);
    });
  });
});

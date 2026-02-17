import CloudflareKVPlugin from "../../main";
import {
  createTestPlugin,
  getPrivateMethod,
  getPrivateProperty
} from "../helpers/plugin-test-helper";
import { DEFAULT_TEST_CACHE } from "../mocks/obsidian-mocks";
import { getConsoleErrorMock } from "../setup";

describe("loadCache", () => {
  it("should load valid cache from file", async () => {
    const cacheContent = JSON.stringify({
      syncedFiles: {
        "path/to/file.md": "collection/doc-id"
      }
    });
    const plugin = await createTestPlugin({ cacheContent });

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    expect(syncedFiles.get("path/to/file.md")).toBe("collection/doc-id");
  });

  it("should create empty cache when file does not exist", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    await (plugin as unknown as { loadCache: () => Promise<void> }).loadCache();

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    expect(syncedFiles.size).toBe(0);
  });

  it("should throw error for invalid JSON in cache file", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.read as jest.Mock).mockResolvedValue("not valid json");

    await expect(
      (plugin as unknown as { loadCache: () => Promise<void> }).loadCache()
    ).rejects.toThrow();
  });

  it("should throw error when cache is an array", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.read as jest.Mock).mockResolvedValue(
      JSON.stringify([{ unexpected: "array" }])
    );

    await expect(
      (plugin as unknown as { loadCache: () => Promise<void> }).loadCache()
    ).rejects.toThrow("Unable to parse cache file");
  });

  it("should throw error when cache is a primitive", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.read as jest.Mock).mockResolvedValue(
      JSON.stringify("just a string")
    );

    await expect(
      (plugin as unknown as { loadCache: () => Promise<void> }).loadCache()
    ).rejects.toThrow("Unable to parse cache file");
  });

  it("should load cache with multiple synced files", async () => {
    const cacheContent = JSON.stringify({
      syncedFiles: {
        "file1.md": "key1",
        "file2.md": "collection/key2",
        "folder/file3.md": "key3"
      }
    });
    const plugin = await createTestPlugin({ cacheContent });

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    expect(syncedFiles.size).toBe(3);
    expect(syncedFiles.get("file1.md")).toBe("key1");
    expect(syncedFiles.get("file2.md")).toBe("collection/key2");
    expect(syncedFiles.get("folder/file3.md")).toBe("key3");
  });

  it("should handle empty syncedFiles object", async () => {
    const cacheContent = JSON.stringify({
      syncedFiles: {}
    });
    const plugin = await createTestPlugin({ cacheContent });

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    expect(syncedFiles.size).toBe(0);
  });

  it("should check existence and read from correct cache file path", async () => {
    const plugin = await createTestPlugin();
    const cachePath = ".obsidian/plugins/cloudflare-kv-sync/cache.json";

    expect(plugin.app.vault.adapter.exists).toHaveBeenCalledWith(cachePath);
    expect(plugin.app.vault.adapter.read).toHaveBeenCalledWith(cachePath);
  });

  it("should propagate read errors when cache file exists", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.read as jest.Mock).mockRejectedValue(
      new Error("Permission denied")
    );

    await expect(
      (plugin as unknown as { loadCache: () => Promise<void> }).loadCache()
    ).rejects.toThrow("Permission denied");
  });
});

describe("saveCache", () => {
  it("should save cache to file", async () => {
    const plugin = await createTestPlugin();

    // Add a synced file
    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    syncedFiles.set("test.md", "test-key");

    await (plugin as unknown as { saveCache: () => Promise<void> }).saveCache();

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      ".obsidian/plugins/cloudflare-kv-sync/cache.json",
      expect.stringContaining("test.md")
    );
  });

  it("should save cache with correct JSON format", async () => {
    const plugin = await createTestPlugin();

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    syncedFiles.set("file.md", "key");

    await (plugin as unknown as { saveCache: () => Promise<void> }).saveCache();

    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock.calls[0];
    const savedJson = JSON.parse(writeCall[1]);
    expect(savedJson).toEqual({
      syncedFiles: {
        "file.md": "key"
      }
    });
  });

  it("should log error but not throw on write failure", async () => {
    const plugin = await createTestPlugin();
    (plugin.app.vault.adapter.write as jest.Mock).mockRejectedValue(
      new Error("Write failed")
    );

    // Should not throw
    await (plugin as unknown as { saveCache: () => Promise<void> }).saveCache();

    expect(getConsoleErrorMock()).toHaveBeenCalledWith(
      "Error saving cache:",
      expect.any(Error)
    );
  });

  it("should save empty cache", async () => {
    const plugin = await createTestPlugin();

    await (plugin as unknown as { saveCache: () => Promise<void> }).saveCache();

    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock.calls[0];
    const savedJson = JSON.parse(writeCall[1]);
    expect(savedJson.syncedFiles).toEqual({});
  });

  it("should convert Map to object when saving", async () => {
    const plugin = await createTestPlugin();

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    syncedFiles.set("a.md", "key-a");
    syncedFiles.set("b.md", "key-b");

    await (plugin as unknown as { saveCache: () => Promise<void> }).saveCache();

    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock.calls[0];
    const savedJson = JSON.parse(writeCall[1]);
    expect(savedJson.syncedFiles["a.md"]).toBe("key-a");
    expect(savedJson.syncedFiles["b.md"]).toBe("key-b");
  });
});

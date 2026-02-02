import CloudflareKVPlugin from "../../main";
import { TFile, requestUrl, parseYaml } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod,
  getPrivateProperty
} from "../helpers/plugin-test-helper";
import { createMockTFile } from "../mocks/obsidian-mocks";
import {
  mockSuccessResponse,
  mockErrorResponse
} from "../mocks/cloudflare-mocks";

type SyncResult =
  | { skipped: true; error?: string; sync?: undefined }
  | { skipped: false; error?: string; sync?: { action: string; success: boolean; error?: string } };

describe("syncFile", () => {
  let plugin: CloudflareKVPlugin;
  let syncFile: (file: TFile) => Promise<SyncResult>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    syncFile = getPrivateMethod(plugin, "syncFile");

    // Reset mocks
    (requestUrl as jest.Mock).mockReset();
    (parseYaml as jest.Mock).mockReset();
  });

  describe("No frontmatter", () => {
    it("should return skipped with error when file has no frontmatter", async () => {
      const file = createMockTFile("test.md");
      const content = "Just body content, no frontmatter";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);

      const result = await syncFile(file);

      expect(result.skipped).toBe(true);
      expect(result.error).toContain("No frontmatter");
      expect(requestUrl).not.toHaveBeenCalled();
    });
  });

  describe("No sync flag", () => {
    it("should return skipped without error when kv_sync is false", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nid: test-id\nkv_sync: false\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ id: "test-id", kv_sync: false });

      const result = await syncFile(file);

      expect(result.skipped).toBe(true);
      expect(result.error).toBeUndefined();
      expect(requestUrl).not.toHaveBeenCalled();
    });

    it("should return skipped when kv_sync is missing", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ id: "test-id" });

      const result = await syncFile(file);

      expect(result.skipped).toBe(true);
      expect(requestUrl).not.toHaveBeenCalled();
    });
  });

  describe("Sync flag but no ID", () => {
    it("should return error when kv_sync is true but id is missing", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true });

      const result = await syncFile(file);

      expect(result.skipped).toBe(true);
      expect(result.error).toContain("Missing doc ID");
      expect(requestUrl).not.toHaveBeenCalled();
    });

    it("should return error when id is empty string", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: \n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "" });

      const result = await syncFile(file);

      expect(result.skipped).toBe(true);
      expect(result.error).toContain("Missing doc ID");
    });
  });

  describe("New file sync", () => {
    it("should upload to KV and add to cache for new file", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.sync?.action).toBe("create");
      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/values/test-id")
        })
      );

      // Check cache was updated
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      expect(syncedFiles.get(file.path)).toBe("test-id");
    });

    it("should upload with collection prefix when specified", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\ncollection: posts\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id", collection: "posts" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/values/posts/test-id")
        })
      );

      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      expect(syncedFiles.get(file.path)).toBe("posts/test-id");
    });
  });

  describe("Update existing file", () => {
    it("should upload updated content when file was previously synced", async () => {
      // Pre-populate cache
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "test-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\n---\nUpdated content";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.action).toBe("create");
      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledTimes(1);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PUT"
        })
      );
    });
  });

  describe("Collection changed", () => {
    it("should delete old key and upload with new collection", async () => {
      // Pre-populate cache with old collection
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "posts/test-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\ncollection: tutorials\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id", collection: "tutorials" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledTimes(2);

      // First call: DELETE old key
      expect(requestUrl).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: "DELETE",
          url: expect.stringContaining("/values/posts/test-id")
        })
      );

      // Second call: PUT new key
      expect(requestUrl).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/values/tutorials/test-id")
        })
      );

      expect(syncedFiles.get(file.path)).toBe("tutorials/test-id");
    });
  });

  describe("ID changed", () => {
    it("should delete old key and upload with new ID", async () => {
      // Pre-populate cache with old ID
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "old-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: new-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "new-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledTimes(2);

      // First call: DELETE old key
      expect(requestUrl).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: "DELETE",
          url: expect.stringContaining("/values/old-id")
        })
      );

      // Second call: PUT new key
      expect(requestUrl).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/values/new-id")
        })
      );

      expect(syncedFiles.get(file.path)).toBe("new-id");
    });
  });

  describe("Unmark for sync", () => {
    it("should delete from KV when file was synced but now has kv_sync: false", async () => {
      // Pre-populate cache
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "test-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: false\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: false, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.sync?.action).toBe("delete");
      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "DELETE",
          url: expect.stringContaining("/values/test-id")
        })
      );

      expect(syncedFiles.has(file.path)).toBe(false);
    });
  });

  describe("Remove frontmatter", () => {
    it("should delete from KV when previously synced file loses frontmatter", async () => {
      // Pre-populate cache
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "test-id");

      const file = createMockTFile("test.md");
      const content = "Just content, no frontmatter anymore";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.sync?.action).toBe("delete");
      expect(result.sync?.success).toBe(true);

      expect(syncedFiles.has(file.path)).toBe(false);
    });

    it("should delete from KV when previously synced file loses id field", async () => {
      // Pre-populate cache
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "test-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.sync?.action).toBe("delete");
      expect(syncedFiles.has(file.path)).toBe(false);
    });
  });

  describe("Delete old fails", () => {
    it("should return error and not upload when delete of old key fails", async () => {
      // Pre-populate cache with old collection
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      syncedFiles.set("test.md", "posts/test-id");

      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\ncollection: tutorials\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id", collection: "tutorials" });
      (requestUrl as jest.Mock).mockResolvedValue(
        mockErrorResponse([{ code: 10000, message: "Delete failed" }])
      );

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.error).toContain("Unable to delete old kv entry");
      expect(result.sync).toBeUndefined();

      // Should only have called DELETE, not PUT
      expect(requestUrl).toHaveBeenCalledTimes(1);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "DELETE"
        })
      );

      // Cache should not have been updated
      expect(syncedFiles.get(file.path)).toBe("posts/test-id");
    });
  });

  describe("Upload fails", () => {
    it("should return error and not update cache when upload fails", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(
        mockErrorResponse([{ code: 10000, message: "Upload failed" }])
      );

      const result = await syncFile(file);

      expect(result.skipped).toBe(false);
      expect(result.sync?.action).toBe("create");
      expect(result.sync?.success).toBe(false);
      expect(result.sync?.error).toContain("Upload failed");

      // Cache should not have been updated
      const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
      expect(syncedFiles.has(file.path)).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("should handle file with boolean string 'true' for kv_sync", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: \"true\"\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: "true", id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
    });

    it("should handle file with uppercase 'TRUE' for kv_sync", async () => {
      const file = createMockTFile("test.md");
      const content = "---\nkv_sync: \"TRUE\"\nid: test-id\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ kv_sync: "TRUE", id: "test-id" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
    });

    it("should handle custom syncKey and idKey", async () => {
      plugin.settings.syncKey = "publish";
      plugin.settings.idKey = "slug";

      const file = createMockTFile("test.md");
      const content = "---\npublish: true\nslug: my-post\n---\nContent";
      (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
      (parseYaml as jest.Mock).mockReturnValue({ publish: true, slug: "my-post" });
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await syncFile(file);

      expect(result.sync?.success).toBe(true);
      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/values/my-post")
        })
      );
    });
  });
});

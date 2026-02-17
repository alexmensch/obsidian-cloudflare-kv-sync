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
  | {
      skipped: false;
      error?: string;
      sync?: { action: string; success: boolean; error?: string };
    };

describe("Auto-assign ID", () => {
  let plugin: CloudflareKVPlugin;
  let syncFile: (file: TFile) => Promise<SyncResult>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    syncFile = getPrivateMethod(plugin, "syncFile");

    (requestUrl as jest.Mock).mockReset();
    (parseYaml as jest.Mock).mockReset();
  });

  it("should auto-assign ID when kv_sync is true but id is missing", async () => {
    const files = new Map<string, string>();
    files.set("test.md", "---\nkv_sync: true\n---\nContent");

    const file = createMockTFile("test.md");

    // First cachedRead: original content without id
    // After processFrontMatter: content with the new id
    let callCount = 0;
    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return "---\nkv_sync: true\n---\nContent";
      return "---\nkv_sync: true\nid: generated-uuid\n---\nContent";
    });

    // First parseYaml call: no id
    // Second parseYaml call: with generated id
    (parseYaml as jest.Mock)
      .mockReturnValueOnce({ kv_sync: true })
      .mockReturnValueOnce({ kv_sync: true, id: "generated-uuid" });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (
        _file: TFile,
        fn: (fm: Record<string, unknown>) => void
      ) => {
        const fm: Record<string, unknown> = { kv_sync: true };
        fn(fm);
        expect(fm[plugin.settings.idKey]).toBeDefined();
      }
    );

    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await syncFile(file);

    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      file,
      expect.any(Function)
    );
    expect(result.skipped).toBe(false);
    expect(result.sync?.success).toBe(true);
  });

  it("should not overwrite existing ID", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: existing-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({
      kv_sync: true,
      id: "existing-id"
    });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await syncFile(file);

    expect(
      plugin.app.fileManager.processFrontMatter
    ).not.toHaveBeenCalled();
    expect(result.sync?.success).toBe(true);
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/values/existing-id")
      })
    );
  });

  it("should delete old key and assign new ID when previously synced file loses id", async () => {
    const syncedFiles = getPrivateProperty<Map<string, string>>(
      plugin,
      "syncedFiles"
    );
    syncedFiles.set("test.md", "old-key");

    const file = createMockTFile("test.md");
    const newId = "new-generated-uuid";

    (plugin.app.vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce("---\nkv_sync: true\n---\nContent")
      .mockResolvedValueOnce(`---\nkv_sync: true\nid: ${newId}\n---\nContent`)
      .mockResolvedValueOnce(`---\nkv_sync: true\nid: ${newId}\n---\nContent`);

    (parseYaml as jest.Mock)
      .mockReturnValueOnce({ kv_sync: true })
      .mockReturnValueOnce({ kv_sync: true, id: newId });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockResolvedValue(
      undefined
    );
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await syncFile(file);

    expect(result.skipped).toBe(false);
    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(requestUrl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/values/old-key")
      })
    );
    expect(requestUrl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "PUT",
        url: expect.stringContaining(`/values/${newId}`)
      })
    );
    expect(result.sync?.action).toBe("create");
    expect(result.sync?.success).toBe(true);
    expect(syncedFiles.get(file.path)).toBe(newId);
  });

  it("should return error when old key deletion fails during ID reassignment", async () => {
    const syncedFiles = getPrivateProperty<Map<string, string>>(
      plugin,
      "syncedFiles"
    );
    syncedFiles.set("test.md", "old-key");

    const file = createMockTFile("test.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(
      "---\nkv_sync: true\n---\nContent"
    );
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true });
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Delete failed" }])
    );

    const result = await syncFile(file);

    expect(result.skipped).toBe(false);
    expect(result.error).toContain("Unable to delete old kv entry");
    expect(result.sync).toBeUndefined();
    // Should only have called DELETE, not PUT
    expect(requestUrl).toHaveBeenCalledTimes(1);
    // Cache should still have the old key
    expect(syncedFiles.get(file.path)).toBe("old-key");
  });

  it("should return error when frontmatter re-read fails after ID assignment", async () => {
    const file = createMockTFile("test.md");

    // First read: has frontmatter with kv_sync but no id
    // Second read (after assignIdToFile): no frontmatter
    (plugin.app.vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce("---\nkv_sync: true\n---\nContent")
      .mockResolvedValueOnce("Content without frontmatter");

    (parseYaml as jest.Mock).mockReturnValueOnce({ kv_sync: true });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockResolvedValue(
      undefined
    );

    const result = await syncFile(file);

    expect(result.skipped).toBe(true);
    expect(result.error).toContain("No frontmatter found");
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("should use the generated ID for the KV key", async () => {
    const file = createMockTFile("test.md");
    const generatedId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    (plugin.app.vault.cachedRead as jest.Mock)
      .mockResolvedValueOnce("---\nkv_sync: true\n---\nContent")
      .mockResolvedValueOnce(
        `---\nkv_sync: true\nid: ${generatedId}\n---\nContent`
      )
      .mockResolvedValueOnce(
        `---\nkv_sync: true\nid: ${generatedId}\n---\nContent`
      );

    (parseYaml as jest.Mock)
      .mockReturnValueOnce({ kv_sync: true })
      .mockReturnValueOnce({ kv_sync: true, id: generatedId });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockResolvedValue(
      undefined
    );

    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await syncFile(file);

    expect(result.skipped).toBe(false);
    expect(result.sync?.success).toBe(true);

    const syncedFiles = getPrivateProperty<Map<string, string>>(
      plugin,
      "syncedFiles"
    );
    expect(syncedFiles.get(file.path)).toBe(generatedId);
  });

  describe("assignIdToFile", () => {
    let assignIdToFile: (file: TFile) => Promise<string>;

    beforeEach(() => {
      assignIdToFile = getPrivateMethod(plugin, "assignIdToFile");
    });

    it("should call processFrontMatter with the file", async () => {
      const file = createMockTFile("test.md");
      (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
        async (
          _file: TFile,
          fn: (fm: Record<string, unknown>) => void
        ) => {
          fn({});
        }
      );

      await assignIdToFile(file);

      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
        file,
        expect.any(Function)
      );
    });

    it("should return the generated ID", async () => {
      const file = createMockTFile("test.md");
      (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
        async (
          _file: TFile,
          fn: (fm: Record<string, unknown>) => void
        ) => {
          fn({});
        }
      );

      const id = await assignIdToFile(file);

      expect(typeof id).toBe("string");
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("should set the ID using the configured idKey", async () => {
      plugin.settings.idKey = "custom_id";
      const file = createMockTFile("test.md");

      let capturedFm: Record<string, unknown> = {};
      (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
        async (
          _file: TFile,
          fn: (fm: Record<string, unknown>) => void
        ) => {
          const fm: Record<string, unknown> = {};
          fn(fm);
          capturedFm = fm;
        }
      );

      const id = await assignIdToFile(file);

      expect(capturedFm["custom_id"]).toBe(id);
    });
  });
});

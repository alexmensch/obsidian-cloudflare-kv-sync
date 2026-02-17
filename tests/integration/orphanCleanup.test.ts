import CloudflareKVPlugin from "../../main";
import { requestUrl, TFile } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod,
  getPrivateProperty
} from "../helpers/plugin-test-helper";
import { createMockNotice, createMockTFile } from "../mocks/obsidian-mocks";
import {
  mockSuccessResponse,
  mockErrorResponse
} from "../mocks/cloudflare-mocks";
describe("removeOrphanedUploads", () => {
  let noticeMock: jest.Mock;

  beforeEach(() => {
    noticeMock = createMockNotice();
    noticeMock.mockClear();
    (requestUrl as jest.Mock).mockReset();
  });

  async function setupPluginWithCache(
    cachedFiles: Record<string, string>,
    existingFilePaths: string[]
  ): Promise<CloudflareKVPlugin> {
    const cacheContent = JSON.stringify({
      syncedFiles: cachedFiles
    });
    const plugin = await createTestPlugin({ cacheContent });

    // Mock getAbstractFileByPath to return file only if it exists
    (plugin.app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (existingFilePaths.includes(path)) {
        return createMockTFile(path);
      }
      return null;
    });

    return plugin;
  }

  it("should not delete anything when all cached files exist", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2"
      },
      ["file1.md", "file2.md"]
    );

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(requestUrl).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("should delete orphaned entries when files are deleted from vault", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2",
        "file3.md": "key3"
      },
      ["file1.md"] // Only file1 exists
    );
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/values/key2")
      })
    );
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/values/key3")
      })
    );
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("2 successful"));
  });

  it("should handle partial failures", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2"
      },
      [] // Neither file exists
    );
    (requestUrl as jest.Mock)
      .mockResolvedValueOnce(mockSuccessResponse())
      .mockResolvedValueOnce(mockErrorResponse([{ code: 10000, message: "Failed" }]));

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("1 successful"));
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
  });

  it("should handle all deletions failing", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2"
      },
      []
    );
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Failed" }])
    );

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("0 successful, 2 failed"));
  });

  it("should not show notice when no orphans exist", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1"
      },
      ["file1.md"]
    );

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("should handle empty cache", async () => {
    const plugin = await setupPluginWithCache({}, []);

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(requestUrl).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("should remove successfully deleted entries from cache", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2"
      },
      [] // Neither file exists
    );
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    expect(syncedFiles.size).toBe(0);
  });

  it("should keep failed entries in cache", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2"
      },
      []
    );
    (requestUrl as jest.Mock)
      .mockResolvedValueOnce(mockSuccessResponse())
      .mockResolvedValueOnce(mockErrorResponse([{ code: 10000, message: "Failed" }]));

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    const syncedFiles = getPrivateProperty<Map<string, string>>(plugin, "syncedFiles");
    // One should have been removed, one should remain
    expect(syncedFiles.size).toBe(1);
  });

  it("should save cache after cleanup", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1"
      },
      []
    );
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(plugin.app.vault.adapter.write).toHaveBeenCalled();
  });

  it("should handle files with collection prefixes", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "posts/key1",
        "file2.md": "tutorials/key2"
      },
      []
    );
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/values/posts/key1")
      })
    );
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/values/tutorials/key2")
      })
    );
  });

  it("should process deletions sequentially", async () => {
    const plugin = await setupPluginWithCache(
      {
        "file1.md": "key1",
        "file2.md": "key2",
        "file3.md": "key3"
      },
      []
    );

    const callOrder: string[] = [];
    (requestUrl as jest.Mock).mockImplementation(async (options: { url: string }) => {
      callOrder.push(options.url);
      return mockSuccessResponse();
    });

    const removeOrphanedUploads = getPrivateMethod<() => Promise<void>>(plugin, "removeOrphanedUploads");
    await removeOrphanedUploads();

    // Should have been called 3 times sequentially
    expect(callOrder.length).toBe(3);
  });
});

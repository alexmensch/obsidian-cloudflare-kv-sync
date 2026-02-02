import CloudflareKVPlugin from "../../main";
import { TFile, requestUrl, parseYaml, Notice } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import { createMockTFile, createMockNotice } from "../mocks/obsidian-mocks";
import {
  mockSuccessResponse,
  mockErrorResponse
} from "../mocks/cloudflare-mocks";

describe("syncAllFiles", () => {
  let plugin: CloudflareKVPlugin;
  let syncAllFiles: () => Promise<void>;
  let noticeMock: jest.Mock;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    syncAllFiles = getPrivateMethod(plugin, "syncAllFiles");

    noticeMock = createMockNotice();
    noticeMock.mockClear();

    (requestUrl as jest.Mock).mockReset();
    (parseYaml as jest.Mock).mockReset();
  });

  it("should show starting notice and sync all marked files", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1, file2]);
    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) => {
      if (file.path === "file1.md") return "---\nkv_sync: true\nid: id1\n---\n";
      if (file.path === "file2.md") return "---\nkv_sync: true\nid: id2\n---\n";
      return "";
    });
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      if (yaml.includes("id2")) return { kv_sync: true, id: "id2" };
      return {};
    });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith("Syncing all notes in your vault...");
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("2 successful"));
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("should skip files not marked for sync", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1, file2]);
    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) => {
      if (file.path === "file1.md") return "---\nkv_sync: true\nid: id1\n---\n";
      if (file.path === "file2.md") return "---\nkv_sync: false\nid: id2\n---\n";
      return "";
    });
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      if (yaml.includes("id2")) return { kv_sync: false, id: "id2" };
      return {};
    });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("1 successful"));
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("should track failed syncs separately", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");
    const file3 = createMockTFile("file3.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1, file2, file3]);
    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) => {
      if (file.path === "file1.md") return "---\nkv_sync: true\nid: id1\n---\n";
      if (file.path === "file2.md") return "---\nkv_sync: true\nid: id2\n---\n";
      if (file.path === "file3.md") return "---\nkv_sync: true\nid: id3\n---\n";
      return "";
    });
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      if (yaml.includes("id2")) return { kv_sync: true, id: "id2" };
      if (yaml.includes("id3")) return { kv_sync: true, id: "id3" };
      return {};
    });
    (requestUrl as jest.Mock)
      .mockResolvedValueOnce(mockSuccessResponse())
      .mockResolvedValueOnce(mockErrorResponse([{ code: 10000, message: "Failed" }]))
      .mockResolvedValueOnce(mockSuccessResponse());

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("2 successful"));
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("1 failed"));
  });

  it("should skip files with missing ID (not counted as failed)", async () => {
    // Note: The syncFile function returns { skipped: true } for files with
    // kv_sync: true but missing id. These are treated as skipped, not failed.
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1, file2]);
    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) => {
      if (file.path === "file1.md") return "---\nkv_sync: true\nid: id1\n---\n";
      if (file.path === "file2.md") return "---\nkv_sync: true\n---\n"; // Missing id - skipped
      return "";
    });
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      return { kv_sync: true }; // Missing id
    });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncAllFiles();

    // Only file1 is synced, file2 is skipped (not counted as failed)
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("1 successful"));
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("0 failed"));
  });

  it("should handle empty vault", async () => {
    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([]);

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith("Syncing all notes in your vault...");
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("0 successful, 0 failed"));
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("should save cache after syncing all files", async () => {
    const file1 = createMockTFile("file1.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1]);
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: id1\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "id1" });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncAllFiles();

    expect(plugin.app.vault.adapter.write).toHaveBeenCalled();
  });

  it("should not run sync when settings are invalid", async () => {
    // Remove API token secret
    (plugin.app.secretStorage.getSecret as jest.Mock).mockReturnValue(undefined);

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("requires a value"));
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("should handle all files failing", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1, file2]);
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: id1\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "id1" });
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Error" }])
    );

    await syncAllFiles();

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("0 successful, 2 failed"));
  });

  it("should count as failed when key change deletion fails (error path without sync result)", async () => {
    const file1 = createMockTFile("file1.md");

    // Pre-populate cache with old key
    const syncedFiles = (
      plugin as unknown as { syncedFiles: Map<string, string> }
    ).syncedFiles;
    syncedFiles.set("file1.md", "old-key");

    (plugin.app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([file1]);
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(
      "---\nkv_sync: true\nid: new-id\n---\n"
    );
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "new-id" });

    // First call (DELETE old key) fails, second call (PUT new key) would succeed but won't be called
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Delete failed" }])
    );

    await syncAllFiles();

    // Should report as failed since delete of old key failed
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("0 successful, 1 failed"));
  });
});

describe("syncSingleFile", () => {
  let plugin: CloudflareKVPlugin;
  let syncSingleFile: (file: TFile, notifyOutcome?: boolean) => Promise<void>;
  let noticeMock: jest.Mock;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    syncSingleFile = getPrivateMethod(plugin, "syncSingleFile");

    noticeMock = createMockNotice();
    noticeMock.mockClear();

    (requestUrl as jest.Mock).mockReset();
    (parseYaml as jest.Mock).mockReset();
  });

  it("should show notice on successful sync when notifyOutcome is true", async () => {
    const file = createMockTFile("test.md");
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: test-id\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncSingleFile(file, true);

    expect(noticeMock).toHaveBeenCalledWith("Successful sync");
  });

  it("should not show notice on successful sync when notifyOutcome is false", async () => {
    const file = createMockTFile("test.md");
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: test-id\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncSingleFile(file, false);

    expect(noticeMock).not.toHaveBeenCalledWith("Successful sync");
  });

  it("should show 'not marked for sync' notice when file is skipped", async () => {
    const file = createMockTFile("test.md");
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: false\nid: test-id\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: false, id: "test-id" });

    await syncSingleFile(file, true);

    expect(noticeMock).toHaveBeenCalledWith("File not marked for sync");
  });

  it("should show error notice on sync failure", async () => {
    const file = createMockTFile("test.md");
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: test-id\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Upload failed" }])
    );

    await syncSingleFile(file, true);

    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("Error syncing"));
  });

  it("should save cache after sync", async () => {
    const file = createMockTFile("test.md");
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue("---\nkv_sync: true\nid: test-id\n---\n");
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    await syncSingleFile(file, false);

    expect(plugin.app.vault.adapter.write).toHaveBeenCalled();
  });

  it("should not run when settings are invalid", async () => {
    (plugin.app.secretStorage.getSecret as jest.Mock).mockReturnValue(undefined);
    const file = createMockTFile("test.md");

    await syncSingleFile(file, true);

    expect(requestUrl).not.toHaveBeenCalled();
    expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining("requires a value"));
  });
});

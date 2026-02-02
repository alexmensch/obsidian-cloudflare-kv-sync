import CloudflareKVPlugin from "../../main";
import { TFile, requestUrl, parseYaml } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod,
  getPrivateProperty
} from "../helpers/plugin-test-helper";
import { createMockTFile } from "../mocks/obsidian-mocks";
import { mockSuccessResponse } from "../mocks/cloudflare-mocks";
import { getConsoleErrorMock } from "../setup";

describe("debouncedFileSync", () => {
  let plugin: CloudflareKVPlugin;

  beforeEach(async () => {
    jest.useFakeTimers();
    plugin = await createTestPlugin();

    // Mock requestUrl and parseYaml for sync operations
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("should call syncSingleFile after debounce delay", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file);

    // Should not have synced yet
    expect(requestUrl).not.toHaveBeenCalled();

    // Advance timers by debounce delay (60 seconds) and run all async
    await jest.advanceTimersByTimeAsync(60000);

    expect(requestUrl).toHaveBeenCalled();
  });

  it("should only sync once for rapid edits to the same file", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    // Rapid edits
    debouncedFileSync(file);
    jest.advanceTimersByTime(10000);
    debouncedFileSync(file);
    jest.advanceTimersByTime(10000);
    debouncedFileSync(file);
    jest.advanceTimersByTime(10000);
    debouncedFileSync(file);
    jest.advanceTimersByTime(10000);
    debouncedFileSync(file);

    // Still within debounce window
    expect(requestUrl).not.toHaveBeenCalled();

    // Advance to complete the last debounce
    await jest.advanceTimersByTimeAsync(60000);

    // Should only have synced once
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("should sync different files independently", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");
    const content1 = "---\nkv_sync: true\nid: id1\n---\nContent 1";
    const content2 = "---\nkv_sync: true\nid: id2\n---\nContent 2";

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(async (file: TFile) => {
      if (file.path === "file1.md") return content1;
      if (file.path === "file2.md") return content2;
      return "";
    });
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      if (yaml.includes("id2")) return { kv_sync: true, id: "id2" };
      return {};
    });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file1);
    debouncedFileSync(file2);

    // Advance timers
    await jest.advanceTimersByTimeAsync(60000);

    // Both files should have synced
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("should clear timeout after sync completes", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");
    const syncTimeouts = getPrivateProperty<Map<string, NodeJS.Timeout>>(plugin, "syncTimeouts");

    debouncedFileSync(file);

    expect(syncTimeouts.has(file.path)).toBe(true);

    await jest.advanceTimersByTimeAsync(60000);

    expect(syncTimeouts.has(file.path)).toBe(false);
  });

  it("should handle sync errors without crashing", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    // Make the upload fail
    (requestUrl as jest.Mock).mockRejectedValue(new Error("Network error"));

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file);

    await jest.advanceTimersByTimeAsync(60000);

    // Should have logged an error
    expect(getConsoleErrorMock()).toHaveBeenCalledWith(
      "Error in debounced sync:",
      expect.any(Error)
    );
  });

  it("should use configured debounce delay", async () => {
    // Change debounce delay to 30 seconds
    plugin.settings.debounceDelay = 30;

    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file);

    // 29 seconds - should not have synced
    jest.advanceTimersByTime(29000);
    expect(requestUrl).not.toHaveBeenCalled();

    // 30 seconds - should sync
    await jest.advanceTimersByTimeAsync(1000);

    expect(requestUrl).toHaveBeenCalled();
  });

  it("should handle zero debounce delay", async () => {
    plugin.settings.debounceDelay = 0;

    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file);

    // With zero delay, should execute on next tick
    await jest.advanceTimersByTimeAsync(0);

    expect(requestUrl).toHaveBeenCalled();
  });

  it("should clear previous timeout when file is modified again", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\nid: test-id\n---\nContent";
    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "test-id" });

    const debouncedFileSync = getPrivateMethod<(file: TFile) => void>(plugin, "debouncedFileSync");

    debouncedFileSync(file);

    // Wait 30 seconds
    jest.advanceTimersByTime(30000);
    expect(requestUrl).not.toHaveBeenCalled();

    // Modify again - should reset the timer
    debouncedFileSync(file);

    // Wait another 30 seconds (total 60 from first call)
    jest.advanceTimersByTime(30000);
    expect(requestUrl).not.toHaveBeenCalled();

    // Wait remaining 30 seconds from second call
    await jest.advanceTimersByTimeAsync(30000);

    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
});

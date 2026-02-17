import CloudflareKVPlugin from "../../main";
import { TFile, parseYaml } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import { createMockTFile } from "../mocks/obsidian-mocks";

describe("detectAndFixDuplicates", () => {
  let plugin: CloudflareKVPlugin;
  let detectAndFixDuplicates: (files: TFile[]) => Promise<void>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    detectAndFixDuplicates = getPrivateMethod(plugin, "detectAndFixDuplicates");

    (parseYaml as jest.Mock).mockReset();
  });

  it("should not modify files when there are no duplicates", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async (file: TFile) => {
        if (file.path === "file1.md")
          return "---\nkv_sync: true\nid: id1\n---\n";
        if (file.path === "file2.md")
          return "---\nkv_sync: true\nid: id2\n---\n";
        return "";
      }
    );
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("id1")) return { kv_sync: true, id: "id1" };
      if (yaml.includes("id2")) return { kv_sync: true, id: "id2" };
      return {};
    });

    await detectAndFixDuplicates([file1, file2]);

    expect(
      plugin.app.fileManager.processFrontMatter
    ).not.toHaveBeenCalled();
  });

  it("should replace ID of second file (alphabetically) when two files share same KV key", async () => {
    const fileA = createMockTFile("a-file.md");
    const fileB = createMockTFile("b-file.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async (file: TFile) => {
        if (file.path === "a-file.md")
          return "---\nkv_sync: true\nid: same-id\n---\n";
        if (file.path === "b-file.md")
          return "---\nkv_sync: true\nid: same-id\n---\n";
        return "";
      }
    );
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("same-id")) return { kv_sync: true, id: "same-id" };
      return {};
    });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (
        _file: TFile,
        fn: (fm: Record<string, unknown>) => void
      ) => {
        fn({});
      }
    );

    await detectAndFixDuplicates([fileA, fileB]);

    // Only the second file (b-file.md) should get a new ID
    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      fileB,
      expect.any(Function)
    );
  });

  it("should not conflict when same ID is in different collections", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async (file: TFile) => {
        if (file.path === "file1.md")
          return "---\nkv_sync: true\nid: same-id\ncollection: posts\n---\n";
        if (file.path === "file2.md")
          return "---\nkv_sync: true\nid: same-id\ncollection: tutorials\n---\n";
        return "";
      }
    );
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("posts"))
        return { kv_sync: true, id: "same-id", collection: "posts" };
      if (yaml.includes("tutorials"))
        return { kv_sync: true, id: "same-id", collection: "tutorials" };
      return {};
    });

    await detectAndFixDuplicates([file1, file2]);

    expect(
      plugin.app.fileManager.processFrontMatter
    ).not.toHaveBeenCalled();
  });

  it("should handle three-way duplicate - files 2 and 3 get new IDs", async () => {
    const fileA = createMockTFile("a.md");
    const fileB = createMockTFile("b.md");
    const fileC = createMockTFile("c.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async (file: TFile) => {
        return "---\nkv_sync: true\nid: dup-id\n---\n";
      }
    );
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "dup-id" });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (
        _file: TFile,
        fn: (fm: Record<string, unknown>) => void
      ) => {
        fn({});
      }
    );

    await detectAndFixDuplicates([fileA, fileB, fileC]);

    // Files b.md and c.md should get new IDs (a.md is kept)
    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(2);
    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      fileB,
      expect.any(Function)
    );
    expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
      fileC,
      expect.any(Function)
    );
  });

  it("should ignore files without kv_sync: true", async () => {
    const file1 = createMockTFile("file1.md");
    const file2 = createMockTFile("file2.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async (file: TFile) => {
        if (file.path === "file1.md")
          return "---\nkv_sync: true\nid: same-id\n---\n";
        if (file.path === "file2.md")
          return "---\nkv_sync: false\nid: same-id\n---\n";
        return "";
      }
    );
    (parseYaml as jest.Mock).mockImplementation((yaml: string) => {
      if (yaml.includes("true")) return { kv_sync: true, id: "same-id" };
      if (yaml.includes("false")) return { kv_sync: false, id: "same-id" };
      return {};
    });

    await detectAndFixDuplicates([file1, file2]);

    expect(
      plugin.app.fileManager.processFrontMatter
    ).not.toHaveBeenCalled();
  });

  it("should write error log with old and new IDs for duplicates", async () => {
    const fileA = createMockTFile("a-file.md");
    const fileB = createMockTFile("b-file.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockImplementation(
      async () => "---\nkv_sync: true\nid: dup-id\n---\n"
    );
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, id: "dup-id" });

    (plugin.app.fileManager.processFrontMatter as jest.Mock).mockImplementation(
      async (
        _file: TFile,
        fn: (fm: Record<string, unknown>) => void
      ) => {
        fn({});
      }
    );

    // Mock the error log adapter calls
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    await detectAndFixDuplicates([fileA, fileB]);

    // Verify error log was written
    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining('Duplicate KV key "dup-id" in b-file.md')
    );
  });
});

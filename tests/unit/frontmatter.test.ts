import CloudflareKVPlugin from "../../main";
import { TFile, parseYaml } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import { createMockTFile } from "../mocks/obsidian-mocks";

describe("getFrontmatter", () => {
  let plugin: CloudflareKVPlugin;
  let getFrontmatter: (file: TFile) => Promise<Record<string, unknown> | null>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    getFrontmatter = getPrivateMethod(plugin, "getFrontmatter");
  });

  it("should parse valid YAML frontmatter", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nid: test-id\nkv_sync: true\n---\n\nBody content";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ id: "test-id", kv_sync: true });

    const result = await getFrontmatter(file);

    expect(result).toEqual({ id: "test-id", kv_sync: true });
  });

  it("should return null for file without frontmatter", async () => {
    const file = createMockTFile("test.md");
    const content = "Just some body content without frontmatter";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });

  it("should return null for file with only opening delimiter", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nid: test\nNo closing delimiter";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });

  it("should return null for truly empty frontmatter (parseYaml returns null)", async () => {
    const file = createMockTFile("test.md");
    const content = "---\n---\n\nBody content";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue(null);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });

  it("should return empty object when parseYaml returns empty object", async () => {
    const file = createMockTFile("test.md");
    const content = "---\n\n---\n\nBody content";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({});

    const result = await getFrontmatter(file);

    expect(result).toEqual({});
  });

  it("should return null for array frontmatter", async () => {
    const file = createMockTFile("test.md");
    const content = "---\n- item1\n- item2\n---\n\nBody content";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue(["item1", "item2"]);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });

  it("should return null and log error for invalid YAML", async () => {
    const file = createMockTFile("test.md");
    const content = "---\n{invalid: yaml:\n---\n\nBody content";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockImplementation(() => {
      throw new Error("Invalid YAML");
    });
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
    // writeErrorLog is called with void (fire-and-forget), give it a tick
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("Error parsing frontmatter in test.md")
    );
  });

  it("should return null and log error for file read error", async () => {
    const file = createMockTFile("test.md");

    (plugin.app.vault.cachedRead as jest.Mock).mockRejectedValue(
      new Error("File read error")
    );
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    const result = await getFrontmatter(file);

    // writeErrorLog is called with void (fire-and-forget), give it a tick
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result).toBeNull();
    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("Error reading file test.md")
    );
  });

  it("should handle nested objects in frontmatter", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nmeta:\n  key: val\n  nested:\n    deep: value\n---";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({
      meta: { key: "val", nested: { deep: "value" } }
    });

    const result = await getFrontmatter(file);

    expect(result).toEqual({
      meta: { key: "val", nested: { deep: "value" } }
    });
  });

  it("should handle frontmatter with boolean values", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nkv_sync: true\ndraft: false\n---";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ kv_sync: true, draft: false });

    const result = await getFrontmatter(file);

    expect(result).toEqual({ kv_sync: true, draft: false });
  });

  it("should handle frontmatter with numeric values", async () => {
    const file = createMockTFile("test.md");
    const content = "---\nversion: 1\npriority: 5.5\n---";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue({ version: 1, priority: 5.5 });

    const result = await getFrontmatter(file);

    expect(result).toEqual({ version: 1, priority: 5.5 });
  });

  it("should return null when parseYaml returns null", async () => {
    const file = createMockTFile("test.md");
    const content = "---\n\n---";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue(null);

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });

  it("should return null when parseYaml returns a primitive", async () => {
    const file = createMockTFile("test.md");
    const content = "---\njust a string\n---";

    (plugin.app.vault.cachedRead as jest.Mock).mockResolvedValue(content);
    (parseYaml as jest.Mock).mockReturnValue("just a string");

    const result = await getFrontmatter(file);

    expect(result).toBeNull();
  });
});

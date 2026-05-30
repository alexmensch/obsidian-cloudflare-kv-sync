import CloudflareKVPlugin from "../../main";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import { getConsoleErrorMock } from "../setup";

describe("writeErrorLog", () => {
  let plugin: CloudflareKVPlugin;
  let writeErrorLog: (messages: string | string[]) => Promise<void>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    writeErrorLog = getPrivateMethod(plugin, "writeErrorLog");
  });

  it("should create error log file when it does not exist", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    await writeErrorLog("Test error message");

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("- Test error message")
    );
  });

  it("should append (not read+rewrite) to an existing under-cap log", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.stat as jest.Mock).mockResolvedValue({ size: 0 });
    // createTestPlugin's loadCache already read/wrote cache.json; only care
    // about calls made by writeErrorLog itself.
    (plugin.app.vault.adapter.read as jest.Mock).mockClear();
    (plugin.app.vault.adapter.write as jest.Mock).mockClear();

    await writeErrorLog("New error message");

    // Hot path appends in O(1) — no full-file read or rewrite.
    expect(plugin.app.vault.adapter.append).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("- New error message")
    );
    expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
    expect(plugin.app.vault.adapter.write).not.toHaveBeenCalled();
  });

  it("should rotate the log when it exceeds the size cap", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.stat as jest.Mock).mockResolvedValue({
      size: 2_000_000
    });
    // Oldest entry should be dropped; a more recent one kept.
    const existing =
      "\n## 1 Jan 2020, 00:00:00\n- Ancient error\n" +
      "x".repeat(1_500_000) +
      "\n## 2 Jan 2020, 00:00:00\n- Recent error\n";
    (plugin.app.vault.adapter.read as jest.Mock).mockResolvedValue(existing);

    await writeErrorLog("New error message");

    expect(plugin.app.vault.adapter.append).not.toHaveBeenCalled();
    const rewritten = (plugin.app.vault.adapter.write as jest.Mock).mock
      .calls[0][1] as string;
    expect(rewritten).toContain("- Recent error");
    expect(rewritten).toContain("- New error message");
    expect(rewritten).not.toContain("- Ancient error");
    // Trimmed content starts at a whole entry header.
    expect(rewritten.startsWith("## ")).toBe(true);
    expect(rewritten.length).toBeLessThan(existing.length);
  });

  it("should handle array of messages", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    await writeErrorLog(["Error 1", "Error 2", "Error 3"]);

    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock
      .calls[0][1] as string;
    expect(writeCall).toContain("- Error 1");
    expect(writeCall).toContain("- Error 2");
    expect(writeCall).toContain("- Error 3");
  });

  it("should include human-readable datetime header", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    await writeErrorLog("Test error");
    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock
      .calls[0][1] as string;

    // Check that header matches "17 Feb 2026, 23:32:22" format
    expect(writeCall).toMatch(
      /## \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2}/
    );
  });

  it("should fall back to console.error if vault API fails", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockRejectedValue(
      new Error("Vault error")
    );

    await writeErrorLog("Test error");

    expect(getConsoleErrorMock()).toHaveBeenCalledWith(
      "Failed to write error log:",
      expect.any(Error)
    );
  });
});

describe("formatErrorLogHeader", () => {
  let plugin: CloudflareKVPlugin;
  let formatErrorLogHeader: () => string;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    formatErrorLogHeader = getPrivateMethod(plugin, "formatErrorLogHeader");
  });

  it("should return a markdown header with human-readable datetime", () => {
    const header = formatErrorLogHeader();

    expect(header).toMatch(
      /\n## \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}:\d{2}\n/
    );
  });
});

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

  it("should append to existing error log file", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
    (plugin.app.vault.adapter.read as jest.Mock).mockResolvedValue(
      "\n## 2026-01-01T00:00:00.000Z\n- Previous error\n"
    );

    await writeErrorLog("New error message");

    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("- Previous error")
    );
    expect(plugin.app.vault.adapter.write).toHaveBeenCalledWith(
      "Cloudflare KV Sync error log.md",
      expect.stringContaining("- New error message")
    );
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

  it("should include ISO datetime header", async () => {
    (plugin.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

    const before = new Date().toISOString().substring(0, 10);
    await writeErrorLog("Test error");
    const writeCall = (plugin.app.vault.adapter.write as jest.Mock).mock
      .calls[0][1] as string;

    // Check that header contains a date
    expect(writeCall).toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(writeCall).toContain(before);
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

  it("should return a markdown header with ISO datetime", () => {
    const header = formatErrorLogHeader();

    expect(header).toMatch(/\n## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n/);
  });
});

import CloudflareKVPlugin from "../../main";
import { Notice } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import {
  createMockApp,
  createMockNotice,
  DEFAULT_TEST_SETTINGS
} from "../mocks/obsidian-mocks";

describe("loadSettings", () => {
  it("should use DEFAULT_SETTINGS when loadData returns null", async () => {
    const plugin = await createTestPlugin({
      settings: null as unknown as Record<string, unknown>
    });

    // Re-mock loadData and call loadSettings again
    plugin.loadData = jest.fn().mockResolvedValue(null);
    await (plugin as unknown as { loadSettings: () => Promise<void> }).loadSettings();

    expect(plugin.settings).toEqual({
      accountId: "",
      namespaceId: "",
      apiToken: "",
      syncKey: "kv_sync",
      idKey: "id",
      autoSync: false,
      debounceDelay: 60
    });
  });

  it("should merge loaded settings with defaults", async () => {
    const plugin = await createTestPlugin({
      settings: {
        accountId: "my-account",
        namespaceId: "my-namespace"
      }
    });

    expect(plugin.settings.accountId).toBe("my-account");
    expect(plugin.settings.namespaceId).toBe("my-namespace");
    expect(plugin.settings.syncKey).toBe("kv_sync");
    expect(plugin.settings.idKey).toBe("id");
  });

  it("should use all loaded settings when fully specified", async () => {
    const fullSettings = {
      accountId: "acc-123",
      namespaceId: "ns-456",
      apiToken: "token-key",
      syncKey: "sync",
      idKey: "doc_id",
      autoSync: true,
      debounceDelay: 30
    };
    const plugin = await createTestPlugin({ settings: fullSettings });

    expect(plugin.settings).toEqual(fullSettings);
  });

  it("should throw error when loadData returns an array", async () => {
    const plugin = await createTestPlugin();
    plugin.loadData = jest.fn().mockResolvedValue([]);

    await expect(
      (plugin as unknown as { loadSettings: () => Promise<void> }).loadSettings()
    ).rejects.toThrow("Unexpected response from settings data load");
  });

  it("should throw error when loadData returns a primitive", async () => {
    const plugin = await createTestPlugin();
    plugin.loadData = jest.fn().mockResolvedValue("invalid");

    await expect(
      (plugin as unknown as { loadSettings: () => Promise<void> }).loadSettings()
    ).rejects.toThrow("Unexpected response from settings data load");
  });

  it("should throw error when loadData returns a number", async () => {
    const plugin = await createTestPlugin();
    plugin.loadData = jest.fn().mockResolvedValue(123);

    await expect(
      (plugin as unknown as { loadSettings: () => Promise<void> }).loadSettings()
    ).rejects.toThrow("Unexpected response from settings data load");
  });
});

describe("saveSettings", () => {
  it("should call saveData with current settings", async () => {
    const plugin = await createTestPlugin();
    plugin.settings.accountId = "new-account";

    await plugin.saveSettings();

    expect(plugin.saveData).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "new-account"
      })
    );
  });

  it("should save all settings fields", async () => {
    const plugin = await createTestPlugin();
    plugin.settings = {
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "token",
      syncKey: "sync",
      idKey: "id",
      autoSync: true,
      debounceDelay: 45
    };

    await plugin.saveSettings();

    expect(plugin.saveData).toHaveBeenCalledWith(plugin.settings);
  });
});

describe("validateSettings", () => {
  let noticeMock: jest.Mock;

  beforeEach(() => {
    noticeMock = createMockNotice();
    noticeMock.mockClear();
  });

  it("should return false and show notice when accountId is missing", async () => {
    const plugin = await createTestPlugin({
      settings: {
        ...DEFAULT_TEST_SETTINGS,
        accountId: ""
      }
    });

    const validateSettings = getPrivateMethod<() => boolean>(plugin, "validateSettings");
    const result = validateSettings();

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith(
      "Cloudflare kv sync plugin requires configuration"
    );
  });

  it("should return false and show notice when namespaceId is missing", async () => {
    const plugin = await createTestPlugin({
      settings: {
        ...DEFAULT_TEST_SETTINGS,
        namespaceId: ""
      }
    });

    const validateSettings = getPrivateMethod<() => boolean>(plugin, "validateSettings");
    const result = validateSettings();

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith(
      "Cloudflare kv sync plugin requires configuration"
    );
  });

  it("should return false and show notice when apiToken key is missing", async () => {
    const plugin = await createTestPlugin({
      settings: {
        ...DEFAULT_TEST_SETTINGS,
        apiToken: ""
      }
    });

    const validateSettings = getPrivateMethod<() => boolean>(plugin, "validateSettings");
    const result = validateSettings();

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith(
      "Cloudflare kv sync plugin requires configuration"
    );
  });

  it("should return false and show notice when secret storage has no value for token key", async () => {
    const plugin = await createTestPlugin({
      secrets: new Map() // Empty secrets
    });

    const validateSettings = getPrivateMethod<() => boolean>(plugin, "validateSettings");
    const result = validateSettings();

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith(
      expect.stringContaining("requires a value")
    );
  });

  it("should return true when all settings are valid", async () => {
    const plugin = await createTestPlugin();

    const validateSettings = getPrivateMethod<() => boolean>(plugin, "validateSettings");
    const result = validateSettings();

    expect(result).toBe(true);
    expect(noticeMock).not.toHaveBeenCalled();
  });
});

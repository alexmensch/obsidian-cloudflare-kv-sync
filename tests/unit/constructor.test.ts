import CloudflareKVPlugin from "../../main";
import { getPrivateProperty } from "../helpers/plugin-test-helper";

describe("CloudflareKVPlugin field initialization", () => {
  it("initializes timer, synced-file, and load-state defaults", () => {
    // Constructed directly (not via createTestPlugin, which bypasses the
    // constructor) so the class field initializers actually run.
    const plugin = new CloudflareKVPlugin();

    expect(
      getPrivateProperty<Map<string, number>>(plugin, "syncTimeouts")
    ).toEqual(new Map());
    expect(
      getPrivateProperty<Map<string, string>>(plugin, "syncedFiles")
    ).toEqual(new Map());
    expect(
      getPrivateProperty<boolean>(plugin, "loadedSuccesfully")
    ).toBe(false);
  });
});

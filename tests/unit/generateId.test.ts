import CloudflareKVPlugin from "../../main";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";

describe("generateId", () => {
  let plugin: CloudflareKVPlugin;
  let generateId: () => string;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    generateId = getPrivateMethod(plugin, "generateId");
  });

  it("should return a string", () => {
    const id = generateId();
    expect(typeof id).toBe("string");
  });

  it("should return a valid UUID format", () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("should return unique values on consecutive calls", () => {
    const id1 = generateId();
    const id2 = generateId();
    const id3 = generateId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });
});

import CloudflareKVPlugin from "../../main";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";

describe("buildKVKey", () => {
  let plugin: CloudflareKVPlugin;
  let buildKVKey: (frontmatter: Record<string, unknown>) => string | null;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    buildKVKey = getPrivateMethod(plugin, "buildKVKey");
  });

  it("should return just the id when no collection is specified", () => {
    expect(buildKVKey({ id: "abc" })).toBe("abc");
  });

  it("should return collection/id when collection is specified", () => {
    expect(buildKVKey({ id: "abc", collection: "posts" })).toBe("posts/abc");
  });

  it("should return just the id when collection is empty string", () => {
    expect(buildKVKey({ id: "abc", collection: "" })).toBe("abc");
  });

  it("should return just the id when collection is whitespace", () => {
    expect(buildKVKey({ id: "abc", collection: "  " })).toBe("abc");
  });

  it("should return null when id is missing and no collection", () => {
    expect(buildKVKey({})).toBeNull();
  });

  it("should return null when id is empty string and no collection", () => {
    expect(buildKVKey({ id: "" })).toBeNull();
  });

  it("should return null when id is whitespace and no collection", () => {
    expect(buildKVKey({ id: "   " })).toBeNull();
  });

  it("should return null when id is missing even if a collection is set", () => {
    // Guards against producing a "collection/undefined" key.
    expect(buildKVKey({ collection: "posts" })).toBeNull();
  });

  it("should handle complex id values", () => {
    expect(buildKVKey({ id: "my-complex-id-123" })).toBe("my-complex-id-123");
  });

  it("should handle complex collection values", () => {
    expect(buildKVKey({ id: "abc", collection: "blog-posts" })).toBe(
      "blog-posts/abc"
    );
  });

  it("should handle id with slashes", () => {
    expect(buildKVKey({ id: "path/to/doc" })).toBe("path/to/doc");
  });

  it("should handle collection and id with special characters", () => {
    expect(buildKVKey({ id: "doc-123", collection: "tutorials" })).toBe(
      "tutorials/doc-123"
    );
  });

  it("should use custom idKey from settings", async () => {
    plugin.settings.idKey = "customId";
    expect(buildKVKey({ customId: "my-id" })).toBe("my-id");
  });

  it("should ignore non-string id values", () => {
    expect(buildKVKey({ id: 123 })).toBeNull();
  });

  it("should ignore non-string collection values", () => {
    expect(buildKVKey({ id: "abc", collection: 123 })).toBe("abc");
  });
});

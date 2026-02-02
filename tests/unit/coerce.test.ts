import CloudflareKVPlugin from "../../main";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";

describe("coerceBoolean", () => {
  let plugin: CloudflareKVPlugin;
  let coerceBoolean: (value: unknown) => boolean;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    coerceBoolean = getPrivateMethod(plugin, "coerceBoolean");
  });

  it("should return true for boolean true", () => {
    expect(coerceBoolean(true)).toBe(true);
  });

  it("should return true for string 'true'", () => {
    expect(coerceBoolean("true")).toBe(true);
  });

  it("should return true for string 'True'", () => {
    expect(coerceBoolean("True")).toBe(true);
  });

  it("should return true for string 'TRUE'", () => {
    expect(coerceBoolean("TRUE")).toBe(true);
  });

  it("should return false for boolean false", () => {
    expect(coerceBoolean(false)).toBe(false);
  });

  it("should return false for string 'false'", () => {
    expect(coerceBoolean("false")).toBe(false);
  });

  it("should return false for null", () => {
    expect(coerceBoolean(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(coerceBoolean(undefined)).toBe(false);
  });

  it("should return false for number 1", () => {
    expect(coerceBoolean(1)).toBe(false);
  });

  it("should return false for string 'yes'", () => {
    expect(coerceBoolean("yes")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(coerceBoolean("")).toBe(false);
  });

  it("should return false for object", () => {
    expect(coerceBoolean({})).toBe(false);
  });

  it("should return false for array", () => {
    expect(coerceBoolean([])).toBe(false);
  });
});

describe("coerceString", () => {
  let plugin: CloudflareKVPlugin;
  let coerceString: (value: unknown) => string | undefined;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    coerceString = getPrivateMethod(plugin, "coerceString");
  });

  it("should return the string for a valid string", () => {
    expect(coerceString("hello")).toBe("hello");
  });

  it("should preserve spaces in strings", () => {
    expect(coerceString("  spaced  ")).toBe("  spaced  ");
  });

  it("should return undefined for empty string", () => {
    expect(coerceString("")).toBeUndefined();
  });

  it("should return undefined for whitespace-only string", () => {
    expect(coerceString("   ")).toBeUndefined();
  });

  it("should return undefined for number", () => {
    expect(coerceString(123)).toBeUndefined();
  });

  it("should return undefined for null", () => {
    expect(coerceString(null)).toBeUndefined();
  });

  it("should return undefined for undefined", () => {
    expect(coerceString(undefined)).toBeUndefined();
  });

  it("should return undefined for boolean", () => {
    expect(coerceString(true)).toBeUndefined();
  });

  it("should return undefined for object", () => {
    expect(coerceString({})).toBeUndefined();
  });

  it("should return undefined for array", () => {
    expect(coerceString([])).toBeUndefined();
  });
});

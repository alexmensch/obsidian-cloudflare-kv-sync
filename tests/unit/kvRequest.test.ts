import CloudflareKVPlugin from "../../main";
import { requestUrl } from "obsidian";
import {
  createTestPlugin,
  getPrivateMethod
} from "../helpers/plugin-test-helper";
import {
  mockSuccessResponse,
  mockErrorResponse,
  mockInvalidJsonResponse,
  mockArrayResponse,
  mockNetworkError
} from "../mocks/cloudflare-mocks";

type KVRequestResult = { success: true } | { success: false; error: string };

describe("kvRequest", () => {
  let plugin: CloudflareKVPlugin;
  let kvRequest: (key: string, method: "PUT" | "DELETE", body?: string) => Promise<KVRequestResult>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    kvRequest = getPrivateMethod(plugin, "kvRequest");
  });

  describe("PUT requests", () => {
    it("should return success for successful PUT request", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await kvRequest("test-key", "PUT", "test content");

      expect(result).toEqual({ success: true });
      expect(requestUrl).toHaveBeenCalledWith({
        url: expect.stringContaining("/values/test-key"),
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "text/plain"
        },
        body: "test content"
      });
    });

    it("should construct correct URL with account and namespace IDs", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      await kvRequest("my-key", "PUT", "content");

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.cloudflare.com/client/v4/accounts/test-account-id/storage/kv/namespaces/test-namespace-id/values/my-key"
        })
      );
    });

    it("should return error for API error response", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(
        mockErrorResponse([
          { code: 10000, message: "Invalid API key" }
        ])
      );

      const result = await kvRequest("test-key", "PUT", "content");

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Invalid API key")
      });
    });

    it("should handle multiple errors in response", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(
        mockErrorResponse([
          { code: 10000, message: "Error 1" },
          { code: 10001, message: "Error 2" }
        ])
      );

      const result = await kvRequest("test-key", "PUT", "content");

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Error 1")
      });
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Error 2")
      });
    });
  });

  describe("DELETE requests", () => {
    it("should return success for successful DELETE request", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      const result = await kvRequest("test-key", "DELETE");

      expect(result).toEqual({ success: true });
      expect(requestUrl).toHaveBeenCalledWith({
        url: expect.stringContaining("/values/test-key"),
        method: "DELETE",
        headers: {
          Authorization: "Bearer test-token"
        }
      });
    });

    it("should not include Content-Type header for DELETE", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      await kvRequest("test-key", "DELETE");

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.not.objectContaining({
            "Content-Type": expect.anything()
          })
        })
      );
    });

    it("should return error for DELETE API error", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(
        mockErrorResponse([
          { code: 10009, message: "Key not found" }
        ])
      );

      const result = await kvRequest("nonexistent-key", "DELETE");

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Key not found")
      });
    });
  });

  describe("Error handling", () => {
    it("should throw error for invalid JSON response", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockInvalidJsonResponse());

      await expect(kvRequest("test-key", "PUT", "content")).rejects.toThrow();
    });

    it("should throw error for array response", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockArrayResponse());

      await expect(kvRequest("test-key", "PUT", "content")).rejects.toThrow(
        "Unexpected response from cloudflare kv API"
      );
    });

    it("should propagate network errors", async () => {
      const networkError = mockNetworkError("Connection refused");
      (requestUrl as jest.Mock).mockRejectedValue(networkError);

      await expect(kvRequest("test-key", "PUT", "content")).rejects.toThrow(
        "Connection refused"
      );
    });

    it("should propagate timeout errors", async () => {
      const timeoutError = mockNetworkError("Request timeout");
      (requestUrl as jest.Mock).mockRejectedValue(timeoutError);

      await expect(kvRequest("test-key", "DELETE")).rejects.toThrow(
        "Request timeout"
      );
    });
  });

  describe("URL encoding", () => {
    it("should handle keys with special characters", async () => {
      (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

      await kvRequest("posts/my-doc-123", "PUT", "content");

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/values/posts/my-doc-123")
        })
      );
    });
  });
});

describe("uploadToKV", () => {
  let plugin: CloudflareKVPlugin;
  let uploadToKV: (key: string, value: string) => Promise<{ action: "create"; success: boolean; error?: string }>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    uploadToKV = getPrivateMethod(plugin, "uploadToKV");
  });

  it("should return action: create with success for successful upload", async () => {
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await uploadToKV("test-key", "test content");

    expect(result).toEqual({ action: "create", success: true });
  });

  it("should return action: create with error for failed upload", async () => {
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10000, message: "Upload failed" }])
    );

    const result = await uploadToKV("test-key", "test content");

    expect(result.action).toBe("create");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Upload failed");
  });
});

describe("deleteFromKV", () => {
  let plugin: CloudflareKVPlugin;
  let deleteFromKV: (key: string) => Promise<{ action: "delete"; success: boolean; error?: string }>;

  beforeEach(async () => {
    plugin = await createTestPlugin();
    deleteFromKV = getPrivateMethod(plugin, "deleteFromKV");
  });

  it("should return action: delete with success for successful deletion", async () => {
    (requestUrl as jest.Mock).mockResolvedValue(mockSuccessResponse());

    const result = await deleteFromKV("test-key");

    expect(result).toEqual({ action: "delete", success: true });
  });

  it("should return action: delete with error for failed deletion", async () => {
    (requestUrl as jest.Mock).mockResolvedValue(
      mockErrorResponse([{ code: 10009, message: "Delete failed" }])
    );

    const result = await deleteFromKV("test-key");

    expect(result.action).toBe("delete");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Delete failed");
  });
});

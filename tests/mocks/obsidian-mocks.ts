// Factory functions for creating mock Obsidian types
// These use our mock obsidian module, not the real one
import {
  App,
  Vault,
  TFile,
  DataAdapter,
  FileManager,
  SecretStorage,
  Notice,
  requestUrl,
  parseYaml
} from "../../src/__mocks__/obsidian";

// Re-export TFile for use in tests
export { TFile };

/**
 * Creates a mock TFile instance
 */
export function createMockTFile(
  path: string,
  options?: { extension?: string }
): TFile {
  const file = new TFile(path);
  if (options?.extension) {
    file.extension = options.extension;
  }
  return file;
}

/**
 * Creates a mock Vault with configurable file content
 */
export function createMockVault(
  files: Map<string, string> = new Map()
): jest.Mocked<Vault> {
  const vault = new Vault() as jest.Mocked<Vault>;

  vault.cachedRead = jest.fn().mockImplementation(async (file: TFile) => {
    return files.get(file.path) || "";
  });

  vault.getMarkdownFiles = jest.fn().mockReturnValue(
    Array.from(files.keys()).map((path) => new TFile(path))
  );

  vault.getAbstractFileByPath = jest.fn().mockImplementation((path: string) => {
    if (files.has(path)) {
      return new TFile(path);
    }
    return null;
  });

  return vault;
}

/**
 * Creates a mock App with configurable components
 */
export function createMockApp(options?: {
  files?: Map<string, string>;
  secrets?: Map<string, string>;
  cacheContent?: string;
}): jest.Mocked<App> {
  const app = new App() as jest.Mocked<App>;
  const files = options?.files || new Map();
  const secrets = options?.secrets || new Map();

  // Setup vault
  app.vault = createMockVault(files);

  // Setup adapter for cache operations
  const adapter = app.vault.adapter as jest.Mocked<DataAdapter>;
  adapter.exists = jest
    .fn()
    .mockResolvedValue(options?.cacheContent !== undefined);
  adapter.read = jest.fn().mockImplementation(async (path: string) => {
    if (options?.cacheContent !== undefined) {
      return options.cacheContent;
    }
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    throw error;
  });
  adapter.write = jest.fn().mockResolvedValue(undefined);

  // Setup secret storage
  const secretStorage = app.secretStorage as jest.Mocked<SecretStorage>;
  secretStorage.getSecret = jest.fn().mockImplementation((key: string) => {
    return secrets.get(key);
  });

  // Setup file manager
  const fileManager = app.fileManager as jest.Mocked<FileManager>;
  fileManager.processFrontMatter = jest
    .fn()
    .mockImplementation(
      async (
        file: TFile,
        fn: (frontmatter: Record<string, unknown>) => void
      ) => {
        // Parse existing frontmatter from file content
        const content = files.get(file.path) || "";
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const frontmatter: Record<string, unknown> = {};
        if (fmMatch) {
          const lines = fmMatch[1].split("\n");
          for (const line of lines) {
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0) {
              const key = line.substring(0, colonIdx).trim();
              let val: unknown = line.substring(colonIdx + 1).trim();
              if (val === "true") val = true;
              else if (val === "false") val = false;
              else if (val === "") val = undefined;
              frontmatter[key] = val;
            }
          }
        }

        // Execute callback
        fn(frontmatter);

        // Rebuild file content with updated frontmatter
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
        const body = bodyMatch ? bodyMatch[1] : content;
        const fmLines = ["---"];
        for (const [key, value] of Object.entries(frontmatter)) {
          if (value !== undefined) {
            fmLines.push(`${key}: ${value}`);
          }
        }
        fmLines.push("---");
        const newContent = body ? fmLines.join("\n") + "\n" + body : fmLines.join("\n");
        files.set(file.path, newContent);
      }
    );

  return app;
}

/**
 * Creates a mock Notice class for testing notifications
 */
export function createMockNotice(): jest.Mock {
  return Notice as unknown as jest.Mock;
}

/**
 * Configures the requestUrl mock for testing
 */
export function mockRequestUrl(
  response: { text: string } | Error
): jest.Mock {
  const mock = requestUrl as jest.Mock;
  if (response instanceof Error) {
    mock.mockRejectedValue(response);
  } else {
    mock.mockResolvedValue(response);
  }
  return mock;
}

/**
 * Configures parseYaml mock for testing
 */
export function mockParseYaml(
  result: unknown | Error
): jest.Mock {
  const mock = parseYaml as jest.Mock;
  if (result instanceof Error) {
    mock.mockImplementation(() => {
      throw result;
    });
  } else {
    mock.mockReturnValue(result);
  }
  return mock;
}

/**
 * Creates frontmatter content string from an object
 */
export function createFrontmatterContent(
  frontmatter: Record<string, unknown>,
  body: string = ""
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === true) {
      lines.push(`${key}: true`);
    } else if (value === false) {
      lines.push(`${key}: false`);
    } else if (typeof value === "string") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  if (body) {
    lines.push("", body);
  }
  return lines.join("\n");
}

/**
 * Default settings for testing
 */
export const DEFAULT_TEST_SETTINGS = {
  accountId: "test-account-id",
  namespaceId: "test-namespace-id",
  apiToken: "cloudflare-api-token",
  syncKey: "kv_sync",
  idKey: "id",
  autoSync: false,
  debounceDelay: 60
};

/**
 * Default cache for testing
 */
export const DEFAULT_TEST_CACHE = {
  syncedFiles: {}
};

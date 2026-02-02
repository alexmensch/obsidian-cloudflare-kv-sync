import CloudflareKVPlugin from "../../main";
import {
  createMockApp,
  DEFAULT_TEST_SETTINGS,
  DEFAULT_TEST_CACHE
} from "../mocks/obsidian-mocks";
import { App } from "../../src/__mocks__/obsidian";

interface PluginTestOptions {
  settings?: Record<string, unknown>;
  secrets?: Map<string, string>;
  cacheContent?: string;
  files?: Map<string, string>;
}

/**
 * Creates a plugin instance for testing with mocked dependencies.
 * This bypasses the constructor requirements and sets up the plugin directly.
 */
export async function createTestPlugin(options?: PluginTestOptions): Promise<CloudflareKVPlugin> {
  const settings = options?.settings || DEFAULT_TEST_SETTINGS;
  const secrets = options?.secrets || new Map([["cloudflare-api-token", "test-token"]]);
  const cacheContent = options?.cacheContent || JSON.stringify(DEFAULT_TEST_CACHE);
  const files = options?.files || new Map();

  // Create plugin instance without calling constructor
  const plugin = Object.create(CloudflareKVPlugin.prototype) as CloudflareKVPlugin;

  // Setup mock app
  const app = createMockApp({
    secrets,
    cacheContent,
    files
  });

  // Directly set properties
  (plugin as unknown as { app: App }).app = app;
  (plugin as unknown as { manifest: { dir: string } }).manifest = {
    dir: ".obsidian/plugins/cloudflare-kv-sync"
  };
  (plugin as unknown as { syncTimeouts: Map<string, NodeJS.Timeout> }).syncTimeouts = new Map();
  (plugin as unknown as { syncedFiles: Map<string, string> }).syncedFiles = new Map();
  (plugin as unknown as { loadedSuccesfully: boolean }).loadedSuccesfully = false;

  // Mock loadData and saveData
  plugin.loadData = jest.fn().mockResolvedValue(settings);
  plugin.saveData = jest.fn().mockResolvedValue(undefined);
  plugin.addSettingTab = jest.fn();
  plugin.addRibbonIcon = jest.fn();
  plugin.addCommand = jest.fn();
  plugin.registerEvent = jest.fn();

  // Load settings and cache
  await (plugin as unknown as { loadSettings: () => Promise<void> }).loadSettings();
  await (plugin as unknown as { loadCache: () => Promise<void> }).loadCache();

  return plugin;
}

/**
 * Gets a private method from the plugin for testing
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPrivateMethod<T extends (...args: any[]) => any>(plugin: CloudflareKVPlugin, methodName: string): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const method = (plugin as unknown as Record<string, any>)[methodName];
  return method.bind(plugin) as T;
}

/**
 * Gets a private property from the plugin for testing
 */
export function getPrivateProperty<T>(plugin: CloudflareKVPlugin, propertyName: string): T {
  return (plugin as unknown as Record<string, T>)[propertyName];
}

/**
 * Sets a private property on the plugin for testing
 */
export function setPrivateProperty<T>(plugin: CloudflareKVPlugin, propertyName: string, value: T): void {
  (plugin as unknown as Record<string, T>)[propertyName] = value;
}

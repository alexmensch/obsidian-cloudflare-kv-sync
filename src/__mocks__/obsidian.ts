// Mock implementation of Obsidian API for testing

export class Plugin {
  app: App;
  manifest: { dir: string };

  constructor() {
    this.app = new App();
    this.manifest = { dir: ".obsidian/plugins/cloudflare-kv-sync" };
  }

  loadData = jest.fn().mockResolvedValue(null);
  saveData = jest.fn().mockResolvedValue(undefined);
  addSettingTab = jest.fn();
  addRibbonIcon = jest.fn();
  addCommand = jest.fn();
  registerEvent = jest.fn();
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }

  display(): void {}
  hide(): void {}
}

export class App {
  vault: Vault;
  workspace: Workspace;
  secretStorage: SecretStorage;

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
    this.secretStorage = new SecretStorage();
  }
}

export class Vault {
  adapter: DataAdapter;
  private files: Map<string, string> = new Map();

  constructor() {
    this.adapter = new DataAdapter();
  }

  getMarkdownFiles(): TFile[] {
    return [];
  }

  cachedRead = jest.fn().mockResolvedValue("");

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return null;
  }

  on(event: string, callback: (file: TAbstractFile) => void): EventRef {
    return { event, callback } as EventRef;
  }
}

export class DataAdapter {
  read = jest.fn().mockResolvedValue("");
  write = jest.fn().mockResolvedValue(undefined);
}

export class Workspace {
  getActiveFile = jest.fn().mockReturnValue(null);
}

export class SecretStorage {
  private secrets: Map<string, string> = new Map();

  getSecret(key: string): string | undefined {
    return this.secrets.get(key);
  }

  setSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }
}

export class TFile {
  path: string;
  name: string;
  extension: string;
  basename: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    this.extension = this.name.split(".").pop() || "";
    this.basename = this.name.replace(/\.[^/.]+$/, "");
  }
}

export class TAbstractFile {
  path: string;
  name: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || path;
  }
}

export interface EventRef {
  event: string;
  callback: (file: TAbstractFile) => void;
}

export const Notice = jest.fn().mockImplementation((message: string) => {
  return { message };
});

export const parseYaml = jest.fn().mockImplementation((yaml: string) => {
  // Simple YAML parser mock - handles basic key: value pairs
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check for array items
    if (trimmed.startsWith("- ")) {
      // Return as array to trigger the Array.isArray check
      return [trimmed.substring(2)];
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      let value: unknown = trimmed.substring(colonIndex + 1).trim();

      // Handle boolean values
      if (value === "true") value = true;
      else if (value === "false") value = false;
      // Handle empty values
      else if (value === "") value = undefined;
      // Handle quoted strings
      else if (
        typeof value === "string" &&
        value.startsWith('"') &&
        value.endsWith('"')
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }
  }

  return result;
});

export const requestUrl = jest.fn().mockResolvedValue({
  text: JSON.stringify({ success: true })
});

export class Setting {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }

  setName(_name: string): this {
    return this;
  }

  setDesc(_desc: string): this {
    return this;
  }

  setHeading(): this {
    return this;
  }

  addText(_cb: (text: TextComponent) => void): this {
    return this;
  }

  addToggle(_cb: (toggle: ToggleComponent) => void): this {
    return this;
  }

  addComponent(_cb: (el: HTMLElement) => void): this {
    return this;
  }
}

export class TextComponent {
  setValue(_value: string): this {
    return this;
  }

  setPlaceholder(_placeholder: string): this {
    return this;
  }

  onChange(_cb: (value: string) => void): this {
    return this;
  }
}

export class ToggleComponent {
  setValue(_value: boolean): this {
    return this;
  }

  onChange(_cb: (value: boolean) => void): this {
    return this;
  }
}

export class SecretComponent {
  constructor(_app: App, _el: HTMLElement) {}

  setValue(_value: string): this {
    return this;
  }

  onChange(_cb: (value: string) => void): this {
    return this;
  }
}

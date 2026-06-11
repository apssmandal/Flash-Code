// Minimal `vscode` API mock for unit tests run outside the extension host.
// Expand as modules under test require more surface.

export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T) { for (const l of this.listeners) l(data); }
  dispose() { this.listeners = []; }
}

export class Uri {
  private constructor(public scheme: string, public path: string, public fsPath: string) {}
  static file(p: string) { return new Uri('file', p, p); }
  static parse(s: string) { return new Uri('file', s, s); }
  static joinPath(base: Uri, ...parts: string[]) {
    const joined = [base.path, ...parts].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined, joined);
  }
  toString() { return `${this.scheme}://${this.path}`; }
}

// In-memory configuration store, overridable per test via __setConfig.
const configStore: Record<string, any> = {};
export function __setConfig(values: Record<string, any>) { Object.assign(configStore, values); }
export function __resetConfig() { for (const k of Object.keys(configStore)) delete configStore[k]; }

export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/workspace'), name: 'workspace', index: 0 }] as any[],
  getConfiguration(section?: string) {
    const prefix = section ? section + '.' : '';
    return {
      get: <T>(key: string, def?: T): T => {
        const v = configStore[prefix + key];
        return (v === undefined ? def : v) as T;
      },
      update: async (key: string, value: any) => { configStore[prefix + key] = value; },
    };
  },
  fs: {
    readFile: async (_uri: Uri): Promise<Uint8Array> => { throw new Error('not mocked'); },
    writeFile: async (_uri: Uri, _data: Uint8Array): Promise<void> => {},
    readDirectory: async (_uri: Uri): Promise<[string, FileType][]> => [],
    stat: async (_uri: Uri) => ({ type: FileType.File, size: 0, mtime: 0, ctime: 0 }),
    delete: async (_uri: Uri) => {},
    createDirectory: async (_uri: Uri) => {},
    rename: async () => {},
    copy: async () => {},
  },
  createFileSystemWatcher() {
    return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
  },
  findFiles: async () => [],
  asRelativePath: (p: any) => String(p),
};

export const window = {
  activeTextEditor: undefined as any,
  visibleTextEditors: [] as any[],
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  createWebviewPanel: () => ({ webview: { html: '', postMessage: async () => {}, onDidReceiveMessage: () => ({ dispose() {} }) }, onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {} }),
  registerWebviewViewProvider: () => ({ dispose() {} }),
};

export const commands = {
  registerCommand: () => ({ dispose() {} }),
  executeCommand: async () => undefined,
};

export const env = { clipboard: { readText: async () => '', writeText: async () => {} }, openExternal: async () => true };

/** Build a fake ExtensionContext with in-memory globalState + SecretStorage. */
export function makeContext() {
  const gstate = new Map<string, any>();
  const secretMap = new Map<string, string>();
  return {
    globalState: {
      get: <T>(k: string, def?: T): T => (gstate.has(k) ? gstate.get(k) : def),
      update: async (k: string, v: any) => { if (v === undefined) gstate.delete(k); else gstate.set(k, v); },
    },
    secrets: {
      get: async (k: string) => secretMap.get(k),
      store: async (k: string, v: string) => { secretMap.set(k, v); },
      delete: async (k: string) => { secretMap.delete(k); },
    },
    subscriptions: [] as any[],
  } as any;
}

export default { FileType, ConfigurationTarget, EventEmitter, Uri, workspace, window, commands, env, __setConfig, __resetConfig, makeContext };

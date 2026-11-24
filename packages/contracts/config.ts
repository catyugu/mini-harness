import type { ScopeSettings } from './capabilities.js';

/** Types shared by all runtimes. No imports from platform or features. */
export interface Settings {
  port: number;
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  providers: Record<string, string>;
  scopes: Record<string, ScopeSettings>;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };

/** Runtime paths are data, not a dependency on the filesystem adapter. */
export interface Paths {
  home: string;
  cwd: string;
  settings: string;
  registry: string;
  sessions: string;
  pid: string;
  log: string;
  plugins: string;
  devPlugin?: string;
}

/** A configuration handle whose namespace and lifetime are bound by the host. */
export interface PluginConfiguration {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
  /** Apply a shallow field patch as one transaction. */
  patch(values: Record<string, unknown>): Promise<void>;
  subscribe<T = unknown>(key: string, listener: (value: T) => void): () => void;
}

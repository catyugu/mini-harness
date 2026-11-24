import type {} from 'cordis';
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

/** A configuration handle whose namespace and lifetime are bound by the host. */
export interface PluginConfiguration {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): Promise<void>;
  /** Apply a shallow field patch as one transaction. */
  patch(values: Record<string, unknown>): Promise<void>;
  subscribe<T = unknown>(key: string, listener: (value: T) => void): () => void;
}

export interface SettingsPort {
  readonly settings: Settings;
  update(patch: unknown): Promise<Settings>;
  forgetPlugin(id: string): void;
  forgetScopes(keys: string[]): void;
  subscribe(listener: () => void): () => void;
}

declare module 'cordis' {
  interface Context {
    harnessSettingsStore: SettingsPort;
  }
}

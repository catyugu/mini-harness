import type { ScopeSettings } from './capabilities.js';

/** Types shared by all runtimes. No imports from platform or features. */
export interface Settings {
  port: number;
  model: { provider: string; id: string };
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  providers: Record<string, string>;
  scopes: Record<string, ScopeSettings>;
  appearance: 'system' | 'light' | 'dark';
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
  skills: string;
  devPlugin?: string;
}

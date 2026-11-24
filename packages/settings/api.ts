import type {} from 'cordis';
import type { PluginSettings } from '@mini-harness/plugin-api/configuration';

export interface Settings extends PluginSettings { port: number }

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };

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

declare module '@mini-harness/kernel/scopes' {
  interface ScopeSettings { disabledTools?: string[] }
}

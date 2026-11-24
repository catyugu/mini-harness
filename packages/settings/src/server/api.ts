import type { Settings } from '../shared/settings.js';
import type {} from 'cordis';

export interface SettingsPort {
  readonly settings: Settings;
  update(patch: unknown): Promise<Settings>;
  forgetPlugin<T>(id: string, uninstall: () => T): Promise<T>;
  forgetScopes(keys: string[]): Promise<void>;
  subscribe(listener: () => void): () => void;
}

declare module 'cordis' {
  interface Context {
    harnessSettingsStore: SettingsPort;
  }
}

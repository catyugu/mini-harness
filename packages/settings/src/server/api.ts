import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { Settings } from '../shared/settings.js';
import type {} from 'mini-harness/cordis';

export interface SettingsPort {
  readonly settings: Settings;
  update(patch: unknown): Promise<Settings>;
  forgetPlugin<T>(id: string, uninstall: () => T): Promise<T>;
  forgetScopes(keys: ScopeKey[]): Promise<void>;
  subscribe(listener: () => void): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSettingsStore: SettingsPort;
  }
}

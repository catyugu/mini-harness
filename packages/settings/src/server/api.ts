import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { PluginConfigurationPort, SettingsManager } from './manager.js';
import type { Settings } from '../shared/settings.js';
import type {} from 'mini-harness/cordis';

export interface SettingsPort {
  readonly settings: Settings;
  update(patch: unknown): Promise<Settings>;
  forgetPlugin: SettingsManager['forgetPlugin'];
  forgetScopes(keys: ScopeKey[]): Promise<void>;
  writePlugin: SettingsManager['writePlugin'];
  subscribe(listener: () => void): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSettingsStore: SettingsPort;
    harnessComposition: PluginConfigurationPort;
  }
}

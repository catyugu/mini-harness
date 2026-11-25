import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { PluginConfigurationPort, SettingsManager } from './manager.ts';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';

export interface SettingsPort {
  readonly settings: ProfileConfiguration;
  update(patch: unknown): Promise<ProfileConfiguration>;
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

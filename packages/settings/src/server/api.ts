import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';

export interface PluginConfigurationPort {
  configure(
    settings: ProfileConfiguration,
    commit?: () => void,
    released?: ReadonlySet<ScopeKey>,
  ): Promise<void>;
}

export interface SettingsPort {
  readonly settings: ProfileConfiguration;
  update(patch: unknown): Promise<ProfileConfiguration>;
  forgetScopes(keys: ScopeKey[]): Promise<void>;
  writePlugin(
    id: string,
    key: ScopeKey | undefined,
    patch: unknown,
    check: () => void,
  ): Promise<ProfileConfiguration>;
  subscribe(listener: () => void): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSettingsStore: SettingsPort;
    harnessComposition: PluginConfigurationPort;
  }
}

import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';

declare module 'mini-harness/cordis' {
  interface Context {
    miniAppearance: PluginConfiguration;
  }
}

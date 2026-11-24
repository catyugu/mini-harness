import type { ScopeSettings } from '@mini-harness/kernel/scopes';

export interface PluginSettings {
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  providers: Record<string, string>;
  scopes: Record<string, ScopeSettings>;
}

export interface PluginConfigurationPort {
  effective<Settings extends PluginSettings>(settings: Settings): Settings;
  configure(settings: PluginSettings, commit?: () => void): Promise<void>;
}

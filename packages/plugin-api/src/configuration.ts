import type { ScopeSettings } from '@mini-harness/kernel/scopes';

export interface PluginSettings {
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  providers: Record<string, string>;
  scopes: Record<string, ScopeSettings>;
}

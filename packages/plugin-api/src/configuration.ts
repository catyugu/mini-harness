import type { ScopeKey, ScopeSettings } from './scopes.ts';

export interface PluginSettings {
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  scopes: Partial<Record<ScopeKey, ScopeSettings>>;
}

export function scopeKeys(settings: PluginSettings) {
  return Object.keys(settings.scopes) as ScopeKey[];
}

import type { ScopeKey, ScopeSettings } from './scopes.ts';

/** Configuration of one Cordis Entry, indexed by its stable ID in a Profile. */
export interface EntryConfiguration {
  disabled?: boolean;
  config?: Record<string, unknown>;
}

export interface CompositionConfig {
  entries: Record<string, EntryConfiguration>;
  scopes: Partial<Record<ScopeKey, ScopeSettings>>;
}

export interface ProfileConfiguration extends CompositionConfig {
  readOnlyTools: Record<string, string[]>;
}

export function scopeKeys(configuration: CompositionConfig) {
  return Object.keys(configuration.scopes) as ScopeKey[];
}

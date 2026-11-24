import type { ScopeSettings } from '@mini-harness/kernel/scopes';

export interface PluginSettings {
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  providers: Record<string, string>;
  scopes: Record<string, ScopeSettings>;
  /** Explicit user grants keyed by installed plugin ID and exact tool name. */
  readOnlyTools?: Record<string, string[]>;
}

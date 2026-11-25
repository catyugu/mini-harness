import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';

export interface PluginMetadata
  extends Pick<
    ResolvedPlugin,
    | 'id'
    | 'title'
    | 'description'
    | 'defaultEnabled'
    | 'web'
    | 'browser'
    | 'icon'
    | 'configGroups'
    | 'configHint'
    | 'configSchema'
  > {
  external?: boolean;
  name?: string;
  package?: { name: string; version: string };
  error?: string;
  state: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  instances: {
    scope: 'application' | ScopeAddress;
    name?: string;
    configSchema?: Record<string, any>;
    state: 'ready' | 'failed' | 'inactive' | 'disabled';
    error?: string;
  }[];
}

/** Scope choices for the plugin configuration editor. */
export interface ScopeOption {
  key: ScopeAddress;
  name: string;
}

declare module 'mini-harness/cordis' {
  interface Events {
    'settings/scopes'(options: ScopeOption[]): void;
  }
}

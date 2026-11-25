import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';

export interface PluginMetadata
  extends Pick<
    ResolvedPlugin,
    | 'id'
    | 'scope'
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
  trustedCode?: boolean;
  package?: { name: string; version: string };
  error?: string;
  state?: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  instances?: {
    scope: 'application' | ScopeKey;
    state: 'ready' | 'failed' | 'inactive' | 'disabled';
    error?: string;
  }[];
}

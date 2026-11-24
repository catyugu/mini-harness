import type { ScopeKey } from '@mini-harness/kernel/scopes';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export interface PluginMetadata extends Pick<PluginDescriptor, 'id' | 'scope' | 'title' | 'description'
  | 'provides' | 'defaultEnabled' | 'web' | 'browser' | 'icon' | 'configGroups' | 'configHint' | 'requires' | 'configSchema'> {
  trustedCode?: boolean;
  package?: { name: string; version: string };
  error?: string;
  state?: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  instances?: { scope: 'application' | ScopeKey; state: 'ready' | 'failed' | 'inactive' | 'disabled'; error?: string }[];
}

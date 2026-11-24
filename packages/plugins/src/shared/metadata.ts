import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export interface PluginMetadata extends Pick<PluginDescriptor, 'id' | 'scope' | 'title' | 'description'
  | 'provides' | 'defaultEnabled' | 'web' | 'browser' | 'icon' | 'configGroups' | 'configHint' | 'requires' | 'configSchema'> {
  trustedCode?: boolean;
  readOnlyTools?: string[];
  package?: { name: string; version: string };
  error?: string;
  state?: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  instances?: { scope: string; state: 'ready' | 'failed' | 'inactive' | 'disabled'; error?: string }[];
}

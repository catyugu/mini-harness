import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export interface PluginMetadata extends Pick<PluginInfo, 'title' | 'description' | 'icon' | 'configSchema'> {
  id: string;
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

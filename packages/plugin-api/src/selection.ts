import type { ScopeKey } from './scopes.ts';
import { DomainError } from '@mini-harness/platform/errors';

export const localPluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
export const pluginIdPattern = /^(?:core:)?[a-z][a-z0-9-]{0,63}$/;
export function isScopeKey(value: string): value is ScopeKey {
  return /^(?:workspace:[a-f0-9]{32}|session:[a-f0-9-]{36})$/.test(value);
}

export function validatePluginSettings(plugins: Record<string, unknown>, configs: Record<string, unknown>) {
  for (const [key, value] of Object.entries(plugins)) {
    if (!pluginIdPattern.test(key)) throw new DomainError('invalid_input', 'Invalid plugin name');
    if (typeof value !== 'boolean') throw new DomainError('invalid_input', 'Plugin switches must be boolean');
  }
  for (const [id, config] of Object.entries(configs)) {
    if (!pluginIdPattern.test(id) || !config || typeof config !== 'object' || Array.isArray(config))
      throw new DomainError('invalid_input', 'Invalid plugin configuration for ' + id);
  }
}

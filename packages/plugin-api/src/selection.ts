import type { ScopeKey } from './scopes.ts';
import { DomainError } from '@mini-harness/platform/errors';

export const localPluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
export const pluginIdPattern = /^(?:core:)?[a-z][a-z0-9-]{0,63}$/;
export function isScopeKey(value: string): value is ScopeKey {
  return /^(?:workspace:[a-f0-9]{32}|session:[a-f0-9-]{36})$/.test(value);
}

export function validateEntries(entries: Record<string, unknown>) {
  for (const [id, value] of Object.entries(entries)) {
    if (!pluginIdPattern.test(id) || !value || typeof value !== 'object' || Array.isArray(value))
      throw new DomainError('invalid_input', 'Invalid plugin entry: ' + id);
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== 'disabled' && key !== 'live' && key !== 'config'))
      throw new DomainError('invalid_input', 'Unknown plugin entry field: ' + id);
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean')
      throw new DomainError('invalid_input', 'Plugin disabled flags must be boolean');
    if (entry.live !== undefined && typeof entry.live !== 'boolean')
      throw new DomainError('invalid_input', 'Plugin live flags must be boolean');
    if (
      entry.config !== undefined &&
      (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config))
    )
      throw new DomainError('invalid_input', 'Invalid plugin configuration for ' + id);
  }
}

import type { ProfileConfiguration } from './configuration.ts';
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
    if (Object.keys(entry).some((key) => !['name', 'client', 'disabled', 'live', 'config'].includes(key)))
      throw new DomainError('invalid_input', 'Unknown plugin entry field: ' + id);
    if (entry.name !== undefined && (typeof entry.name !== 'string' || !entry.name.trim()))
      throw new DomainError('invalid_input', 'Invalid plugin module name: ' + id);
    if (entry.client !== undefined && typeof entry.client !== 'boolean')
      throw new DomainError('invalid_input', 'Plugin client flags must be boolean');
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

export const DEFAULTS: Readonly<ProfileConfiguration> = Object.freeze({
  entries: {},
  scopes: {},
  readOnlyTools: {},
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(value: unknown, name: string) {
  if (value === undefined) return {};
  if (!isObject(value)) throw new DomainError('invalid_input', 'Invalid settings section: ' + name);
  return value;
}

export function validateSettings(input: unknown): asserts input is ProfileConfiguration {
  if (!isObject(input)) throw new DomainError('invalid_input', 'Invalid settings object');
  if (Object.keys(input).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw new DomainError('invalid_input', 'Unknown settings field');
  const { entries, scopes, readOnlyTools } = input;
  for (const [key, value] of Object.entries({ entries, scopes, readOnlyTools }))
    if (!isObject(value)) throw new DomainError('invalid_input', 'Invalid settings section: ' + key);
  validateEntries(entries as Record<string, unknown>);
  for (const [key, scope] of Object.entries(scopes as Record<string, unknown>)) {
    if (
      !isScopeKey(key) ||
      !isObject(scope) ||
      Object.keys(scope).some((field) => !['entries', 'disabledTools', 'isolate'].includes(field))
    )
      throw new DomainError('invalid_input', 'Invalid plugin scope: ' + key);
    const { disabledTools, isolate } = scope;
    if (
      isolate !== undefined &&
      (!Array.isArray(isolate) ||
        !isolate.every((name: unknown) => typeof name === 'string' && !!name))
    )
      throw new DomainError('invalid_input', 'Invalid service isolation: ' + key);
    if (
      disabledTools !== undefined &&
      (!Array.isArray(disabledTools) ||
        !disabledTools.every((name: unknown) => typeof name === 'string' && !!name))
    )
      throw new DomainError('invalid_input', 'Invalid scoped tool restriction: ' + key);
    validateEntries(section(scope.entries, key + '.entries'));
  }
  for (const [plugin, tools] of Object.entries(readOnlyTools as Record<string, unknown>)) {
    if (
      !pluginIdPattern.test(plugin) ||
      !Array.isArray(tools) ||
      !tools.every((name: unknown) => typeof name === 'string' && !!name)
    )
      throw new DomainError('invalid_input', 'Invalid read-only tool grant: ' + plugin);
  }
}

export function parseSettings(input: unknown): ProfileConfiguration {
  if (!isObject(input)) throw new DomainError('invalid_input', 'Invalid settings object');
  const settings = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  };
  validateSettings(settings);
  return settings;
}

export function mergeSettings(current: ProfileConfiguration, patch: unknown): ProfileConfiguration {
  if (!isObject(patch)) throw new DomainError('invalid_input', 'Invalid settings patch');
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw new DomainError('invalid_input', 'Unknown settings field');
  const entries = section(patch.entries, 'entries');
  validateEntries(entries);
  const next = {
    ...current,
    ...patch,
    scopes: patch.scopes === undefined ? current.scopes : section(patch.scopes, 'scopes'),
    entries: {
      ...current.entries,
      ...Object.fromEntries(
        Object.entries(entries).map(([id, value]) => [id, { ...current.entries[id], ...(value as object) }]),
      ),
    },
  };
  validateSettings(next);
  return next;
}

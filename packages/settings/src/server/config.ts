import { DomainError } from '@mini-harness/platform/errors';
import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import { isScopeKey, validateEntries } from '@mini-harness/plugin-api/selection';
import { toolNamePattern } from '@mini-harness/llm/vocabulary';

export const DEFAULTS = Object.freeze({
  entries: {},
  scopes: {},
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
  const { entries, scopes } = input;
  for (const [key, value] of Object.entries({ entries, scopes }))
    if (!isObject(value)) throw new DomainError('invalid_input', 'Invalid settings section: ' + key);
  validateEntries(section(entries, 'entries'));
  for (const [key, scope] of Object.entries(section(scopes, 'scopes'))) {
    if (
      !isScopeKey(key) ||
      !isObject(scope) ||
      Object.keys(scope).some((field) => !['entries', 'disabledTools'].includes(field))
    )
      throw new DomainError('invalid_input', 'Invalid plugin scope: ' + key);
    const { disabledTools } = scope;
    if (
      disabledTools !== undefined &&
      (!Array.isArray(disabledTools) ||
        !disabledTools.every((name: unknown) => typeof name === 'string' && toolNamePattern.test(name)))
    )
      throw new DomainError('invalid_input', 'Invalid scoped tool restriction: ' + key);
    validateEntries(section(scope.entries, key + '.entries'));
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

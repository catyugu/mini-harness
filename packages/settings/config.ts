import { DomainError } from '@mini-harness/platform/errors';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { Settings } from '@mini-harness/contracts/config';
import { scopeSettingsPattern, validatePluginSettings, validateProviderChoices } from '@mini-harness/contracts/plugins';
import { validToolRestrictions } from '@mini-harness/contracts/tools';
import { readJson } from '@mini-harness/platform/json';

export const DEFAULTS = Object.freeze({
  port: 3837,
  plugins: {},
  pluginConfig: {},
  providers: {},
  scopes: {}
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(value: unknown, name: string) {
  if (value === undefined) return {};
  if (!isObject(value)) throw new DomainError('invalid_input', 'Invalid settings section: ' + name);
  return value;
}

export function validateSettings(input: unknown): asserts input is Settings {
  if (!isObject(input)) throw new DomainError('invalid_input', 'Invalid settings object');
  const { plugins, pluginConfig, providers, scopes, port } = input;
  for (const [key, value] of Object.entries({ plugins, pluginConfig, providers, scopes }))
    if (!isObject(value)) throw new DomainError('invalid_input', 'Invalid settings section: ' + key);
  validatePluginSettings(section(plugins, 'plugins'), section(pluginConfig, 'pluginConfig'));
  validateProviderChoices(section(providers, 'providers'));
  for (const [key, scope] of Object.entries(section(scopes, 'scopes'))) {
    if (!scopeSettingsPattern.test(key) || !isObject(scope) ||
        Object.keys(scope).some((field) => !['plugins', 'pluginConfig', 'disabledTools', 'providers'].includes(field)))
      throw new DomainError('invalid_input', 'Invalid plugin scope: ' + key);
    const { disabledTools } = scope;
    if (disabledTools !== undefined && !validToolRestrictions(disabledTools))
      throw new DomainError('invalid_input', 'Invalid scoped tool restriction: ' + key);
    validatePluginSettings(section(scope.plugins, key + '.plugins'), section(scope.pluginConfig, key + '.pluginConfig'));
    validateProviderChoices(section(scope.providers, key + '.providers'));
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new DomainError('invalid_input', 'Invalid port');
}

export function readSettings(paths: Paths): Settings {
  return parseSettings(readJson<unknown>(paths.settings, {}));
}

export function parseSettings(input: unknown): Settings {
  if (!isObject(input)) throw new DomainError('invalid_input', 'Invalid settings object');
  const settings = {
    port: input.port === undefined ? DEFAULTS.port : input.port,
    plugins: section(input.plugins, 'plugins'),
    pluginConfig: section(input.pluginConfig, 'pluginConfig'),
    providers: section(input.providers, 'providers'),
    scopes: section(input.scopes, 'scopes')
  };
  validateSettings(settings);
  return settings;
}

export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) throw new DomainError('invalid_input', 'Invalid settings patch');
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw new DomainError('invalid_input', 'Unknown settings field');
  const plugins = section(patch.plugins, 'plugins');
  const pluginConfig = section(patch.pluginConfig, 'pluginConfig');
  validatePluginSettings(plugins, pluginConfig);
  const next = {
    ...current,
    ...patch,
    providers: patch.providers === undefined ? current.providers : section(patch.providers, 'providers'),
    scopes: patch.scopes === undefined ? current.scopes : section(patch.scopes, 'scopes'),
    plugins: { ...current.plugins, ...plugins },
    pluginConfig: { ...current.pluginConfig, ...pluginConfig }
  };
  validateSettings(next);
  return next;
}

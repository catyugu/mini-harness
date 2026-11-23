import { HttpError } from '@mini-harness/contracts/routes';
import type { Settings, Paths } from '@mini-harness/contracts/config';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 3837,
  model: { provider: '', id: '' },
  plugins: {},
  pluginConfig: {},
  providers: {},
  scopes: {},
  appearance: 'system'
});

export function getPaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Paths {
  const project = resolve(cwd);
  const home = resolve(env.MINI_HARNESS_HOME || join(homedir(), '.mini-harness'));
  const key = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex').slice(0, 16);
  return {
    home, cwd: project, settings: join(home, 'settings.json'),
    registry: join(home, 'sessions.json'), sessions: join(home, 'sessions', key),
    pid: join(home, 'server.json'), log: join(home, 'server.log'),
    plugins: join(home, 'plugins'), skills: join(home, 'skills'),
    ...(env.MINI_HARNESS_DEV_PLUGIN ? { devPlugin: resolve(env.MINI_HARNESS_DEV_PLUGIN) } : {})
  };
}


export function ensurePaths(paths: Paths) {
  for (const path of [paths.home, paths.sessions, paths.skills, paths.plugins]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return structuredClone(fallback);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(handle, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(handle);
    } finally { closeSync(handle); }
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(value: unknown, name: string) {
  if (value === undefined) return {};
  if (!isObject(value)) throw new HttpError('invalid_input', 'Invalid settings section: ' + name);
  return value;
}

function validateModel(model: Record<string, unknown>, partial: boolean) {
  for (const key of Object.keys(model))
    if (key !== 'provider' && key !== 'id') throw new HttpError('invalid_input', 'Unknown model setting');
  for (const key of ['provider', 'id'] as const) {
    const value = model[key];
    if (partial && !Object.hasOwn(model, key)) continue;
    if (typeof value !== 'string' || value.length > 160)
      throw new HttpError('invalid_input', 'Invalid settings field: model.' + key);
  }
}

export function validateSettings(input: unknown): asserts input is Settings {
  if (!isObject(input)) throw new HttpError('invalid_input', 'Invalid settings object');
  const { model, plugins, pluginConfig, providers, scopes, appearance, port } = input;
  validateModel(section(model, 'model'), false);
  for (const [key, value] of Object.entries({ plugins, pluginConfig, providers, scopes }))
    if (!isObject(value)) throw new HttpError('invalid_input', 'Invalid settings section: ' + key);
  validatePluginSettings(section(plugins, 'plugins'), section(pluginConfig, 'pluginConfig'));
  validateProviderChoices(section(providers, 'providers'));
  for (const [key, scope] of Object.entries(section(scopes, 'scopes'))) {
    if (!/^(?:workspace:[a-f0-9]{32}|session:[a-f0-9-]{36})$/.test(key) || !isObject(scope) ||
        Object.keys(scope).some((field) => !['plugins', 'pluginConfig', 'disabledTools', 'providers'].includes(field)))
      throw new HttpError('invalid_input', 'Invalid plugin scope: ' + key);
    const { disabledTools } = scope;
    if (disabledTools !== undefined && (!Array.isArray(disabledTools) ||
        disabledTools.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))))
      throw new HttpError('invalid_input', 'Invalid scoped tool restriction: ' + key);
    validatePluginSettings(section(scope.plugins, key + '.plugins'), section(scope.pluginConfig, key + '.pluginConfig'));
    validateProviderChoices(section(scope.providers, key + '.providers'));
  }
  if (appearance !== 'system' && appearance !== 'light' && appearance !== 'dark')
    throw new HttpError('invalid_input', 'Invalid appearance');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new HttpError('invalid_input', 'Invalid port');
}

function validateProviderChoices(choices: Record<string, unknown>) {
  for (const [service, id] of Object.entries(choices)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(service) ||
        typeof id !== 'string' || !/^(?:core:)?[a-z][a-z0-9-]{0,63}$/.test(id))
      throw new HttpError('invalid_input', 'Invalid provider selection');
  }
}

function validatePluginSettings(plugins: Record<string, unknown>, configs: Record<string, unknown>) {
  for (const [key, value] of Object.entries(plugins)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new HttpError('invalid_input', 'Invalid plugin name');
    if (typeof value !== 'boolean') throw new HttpError('invalid_input', 'Plugin switches must be boolean');
  }
  for (const [id, config] of Object.entries(configs)) {
    if (!/^(?:core:)?[a-z][a-z0-9-]{0,63}$/.test(id) || !isObject(config))
      throw new HttpError('invalid_input', 'Invalid plugin configuration for ' + id);
  }
}

export function readSettings(paths: Paths): Settings {
  const input = readJson<unknown>(paths.settings, {});
  if (!isObject(input)) throw new HttpError('invalid_input', 'Invalid settings object');
  const settings = {
    port: input.port === undefined ? DEFAULTS.port : input.port,
    model: { ...DEFAULTS.model, ...section(input.model, 'model') },
    plugins: section(input.plugins, 'plugins'),
    pluginConfig: section(input.pluginConfig, 'pluginConfig'),
    providers: section(input.providers, 'providers'),
    scopes: section(input.scopes, 'scopes'),
    appearance: input.appearance === undefined ? DEFAULTS.appearance : input.appearance
  };
  validateSettings(settings);
  return settings;
}

export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) throw new HttpError('invalid_input', 'Invalid settings patch');
  if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw new HttpError('invalid_input', 'Unknown settings field');
  const model = section(patch.model, 'model');
  validateModel(model, true);
  const plugins = section(patch.plugins, 'plugins');
  const pluginConfig = section(patch.pluginConfig, 'pluginConfig');
  validatePluginSettings(plugins, pluginConfig);
  const next = {
    ...current,
    ...patch,
    model: { ...current.model, ...model },
    providers: patch.providers === undefined ? current.providers : section(patch.providers, 'providers'),
    scopes: patch.scopes === undefined ? current.scopes : section(patch.scopes, 'scopes'),
    plugins: { ...current.plugins, ...plugins },
    pluginConfig: Object.fromEntries([...new Set([...Object.keys(current.pluginConfig), ...Object.keys(pluginConfig)])]
      .map((id) => [id, { ...(current.pluginConfig[id] ?? {}), ...section(pluginConfig[id], 'pluginConfig.' + id) }]))
  };
  validateSettings(next);
  return next;
}

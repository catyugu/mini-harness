import type { Settings, SettingsPatch, Paths } from '@mini-harness/contracts/config';
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
    plugins: join(home, 'plugins'), skills: join(home, 'skills')
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

export function validateSettings(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings object');
  validatePluginSettings(input);
  for (const section of [input.providers, input.scopes]) {
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section)))
      throw new Error('Invalid capability settings section');
  }
  validateProviderChoices(input.providers);
  for (const [key, scope] of Object.entries(input.scopes ?? {})) {
    if (!/^(?:workspace:[a-f0-9]{32}|session:[a-f0-9-]{36})$/.test(key) ||
        !scope || typeof scope !== 'object' || Array.isArray(scope) ||
        Object.keys(scope).some((field) => !['plugins', 'pluginConfig', 'disabledTools', 'providers'].includes(field)))
      throw new Error('Invalid plugin scope: ' + key);
    const { disabledTools } = scope as import('@mini-harness/contracts/capabilities').ScopeSettings;
    if (disabledTools !== undefined && (!Array.isArray(disabledTools) ||
        disabledTools.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))))
      throw new Error('Invalid scoped tool restriction: ' + key);
    validatePluginSettings(scope);
    validateProviderChoices((scope as import('@mini-harness/contracts/capabilities').ScopeSettings).providers);
  }
  if (!['system', 'light', 'dark'].includes(input.appearance ?? 'system')) throw new Error('Invalid appearance');
  if (!Number.isInteger(input.port ?? 3837) || (input.port ?? 3837) < 1024 || (input.port ?? 3837) > 65535) throw new Error('Invalid port');
  return true;
}

function validateProviderChoices(choices: unknown) {
  if (choices === undefined) return;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices))
    throw new Error('Invalid provider selections');
  for (const [service, id] of Object.entries(choices)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(service) ||
        typeof id !== 'string' || !/^(?:core:)?[a-z][a-z0-9-]{0,63}$/.test(id))
      throw new Error('Invalid provider selection');
  }
}

function validatePluginSettings(input: { plugins?: unknown; pluginConfig?: unknown }) {
  for (const section of [input.plugins, input.pluginConfig]) {
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section)))
      throw new Error('Invalid plugin settings section');
  }
  const p = input.plugins ?? {};
  for (const [key, value] of Object.entries(p)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new Error('Invalid plugin name');
    if (typeof value !== 'boolean') throw new Error('Plugin switches must be boolean');
  }
  for (const [id, config] of Object.entries(input.pluginConfig ?? {})) {
    if (!/^(?:core:)?[a-z][a-z0-9-]{0,63}$/.test(id) || !config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid plugin configuration for ' + id);
  }
}

export function readSettings(paths: Paths): Settings {
  const input = readJson<Record<string, any>>(paths.settings, {});
  const settings = {
    port: input.port ?? DEFAULTS.port,
    model: { ...DEFAULTS.model, ...input.model },
    plugins: { ...DEFAULTS.plugins, ...input.plugins },
    pluginConfig: input.pluginConfig ?? {},
    providers: input.providers ?? {},
    scopes: input.scopes ?? {},
    appearance: input.appearance ?? DEFAULTS.appearance
  };
  validateSettings(settings);
  return settings as Settings;
}


export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch');
  const allowed = Object.keys(DEFAULTS);
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown settings field');
  for (const group of ['model', 'plugins', 'pluginConfig', 'providers', 'scopes']) {
    if (group in patch && (!patch[group] || typeof patch[group] !== 'object' || Array.isArray(patch[group]))) throw new Error('Invalid settings section');
  }
  const next: Settings = {
    ...current,
    ...patch,
    model: { ...current.model, ...(patch.model || {}) },
    plugins: { ...current.plugins, ...patch.plugins },
    pluginConfig: Object.fromEntries([...new Set([...Object.keys(current.pluginConfig), ...Object.keys(patch.pluginConfig ?? {})])]
      .map((id) => [id, { ...(current.pluginConfig[id] ?? {}), ...(patch.pluginConfig?.[id] ?? {}) }]))
  };
  validateSettings(next);
  return next;
}

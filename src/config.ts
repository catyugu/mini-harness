export interface Settings {
  port: number;
  defaultPermission: import('./execution-policy.js').Permission;
  model: {provider: string; id: string};
  plugins: Record<string, boolean>;
  pluginConfig: Record<string, Record<string, unknown>>;
  subagents: {maxDepth: number; maxParallel: number; provider: string; model: string};
  sandbox: {mode: 'isolated'|'host'; timeoutSeconds: number};
  appearance: 'system'|'light'|'dark';
  typography: { body: number; code: number; terminal: number };
}
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 3837,
  defaultPermission: 'workspace-write',
  model: { provider: '', id: '' },
  plugins: { files: true, skills: true, subagents: true, shell: false, todos: true },
  pluginConfig: {},
  subagents: { maxDepth: 1, maxParallel: 4, provider: '', model: '' },
  sandbox: { mode: 'isolated', timeoutSeconds: 60 },
  appearance: 'system',
  typography: { body: 14, code: 13, terminal: 12 }
});

export function getPaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const project = resolve(cwd);
  const home = resolve(env.MINI_HARNESS_HOME || join(homedir(), '.mini-harness'));
  const key = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex').slice(0, 16);
  return {
    home, cwd: project, agent: join(home, 'pi'), settings: join(home, 'settings.json'),
    registry: join(home, 'sessions.json'), sessions: join(home, 'sessions', key),
    pid: join(home, 'server.json'), log: join(home, 'server.log'),
    plugins: join(home, 'plugins'), skills: join(home, 'skills'),
    projectSkills: join(project, '.mini-harness', 'skills')
  };
}

export function ensurePaths(paths: ReturnType<typeof getPaths>) {
  for (const path of [paths.home, paths.agent, paths.sessions, paths.skills, paths.plugins]) {
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
  if (!['read-only', 'workspace-write', 'full'].includes(input.defaultPermission ?? 'workspace-write')) throw new Error('Invalid execution permission');
  const p = input.plugins || {};
  const s = input.subagents || {};
  const model = input.model || {};
  const sandbox = input.sandbox || {};
  for (const [key, value] of Object.entries(p)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new Error('Invalid plugin name');
    if (typeof value !== 'boolean') throw new Error('Plugin switches must be boolean');
  }
  for (const [id, config] of Object.entries(input.pluginConfig ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid plugin configuration for ' + id);
  }
  if (!Number.isInteger(s.maxDepth ?? 1) || (s.maxDepth ?? 1) < 0 || (s.maxDepth ?? 1) > 8) throw new Error('maxDepth must be 0..8');
  if (!Number.isInteger(s.maxParallel ?? 4) || (s.maxParallel ?? 4) < 1 || (s.maxParallel ?? 4) > 16) throw new Error('maxParallel must be 1..16');
  for (const value of [s.provider ?? '', s.model ?? '', model.provider ?? '', model.id ?? '']) {
    if (typeof value !== 'string' || value.length > 160) throw new Error('Invalid provider or model');
  }
  if (!['isolated', 'host'].includes(sandbox.mode ?? 'isolated')) throw new Error('Invalid sandbox mode');
  if (!Number.isInteger(sandbox.timeoutSeconds ?? 60) || (sandbox.timeoutSeconds ?? 60) < 1 || (sandbox.timeoutSeconds ?? 60) > 300) throw new Error('Invalid shell timeout');
  for (const size of Object.values(input.typography ?? {})) {
    if (!Number.isInteger(size) || Number(size) < 10 || Number(size) > 22) throw new Error('Font size must be 10–22');
  }
  if (input.typography && Object.keys(input.typography).some((key) => !['body', 'code', 'terminal'].includes(key))) throw new Error('Unknown typography field');
  if (!['system', 'light', 'dark'].includes(input.appearance ?? 'system')) throw new Error('Invalid appearance');
  if (!Number.isInteger(input.port ?? 3837) || (input.port ?? 3837) < 1024 || (input.port ?? 3837) > 65535) throw new Error('Invalid port');
  return true;
}

export function readSettings(paths: ReturnType<typeof getPaths>): Settings {
  const input = readJson<Record<string, any>>(paths.settings, {});
  const settings = {
    port: input.port ?? DEFAULTS.port,
    defaultPermission: input.defaultPermission ?? DEFAULTS.defaultPermission,
    model: { ...DEFAULTS.model, ...input.model },
    plugins: { ...DEFAULTS.plugins, ...input.plugins },
    pluginConfig: { ...input.pluginConfig },
    subagents: { ...DEFAULTS.subagents, ...input.subagents },
    sandbox: { ...DEFAULTS.sandbox, ...input.sandbox },
    appearance: input.appearance ?? DEFAULTS.appearance,
    typography: { ...DEFAULTS.typography, ...input.typography }
  };
  validateSettings(settings);
  return settings as Settings;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch');
  const allowed = Object.keys(DEFAULTS);
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown settings field');
  for (const group of ['model', 'plugins', 'pluginConfig', 'subagents', 'sandbox', 'typography']) {
    if (group in patch && (!patch[group] || typeof patch[group] !== 'object' || Array.isArray(patch[group]))) throw new Error('Invalid settings section');
  }
  const next: Settings = {
    ...current,
    ...patch,
    model: { ...current.model, ...(patch.model || {}) },
    plugins: { ...current.plugins, ...patch.plugins },
    pluginConfig: { ...current.pluginConfig, ...patch.pluginConfig },
    subagents: { ...current.subagents, ...(patch.subagents || {}) },
    sandbox: { ...current.sandbox, ...(patch.sandbox || {}) },
    typography: { ...current.typography, ...patch.typography }
  };
  validateSettings(next);
  return next;
}

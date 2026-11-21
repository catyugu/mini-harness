export interface Settings {
  port: number;
  model: {provider: string; id: string};
  plugins: Record<string, boolean>;
  subagents: {maxParallel: number; provider: string; model: string};
  sandbox: {mode: 'isolated'|'host'; timeoutSeconds: number};
  appearance: 'system'|'light'|'dark';
}
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 3837,
  model: { provider: '', id: '' },
  plugins: { skills: true, subagents: true, shell: false },
  subagents: { maxParallel: 2, provider: '', model: '' },
  sandbox: { mode: 'isolated', timeoutSeconds: 60 },
  appearance: 'system'
});

export function getPaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const project = resolve(cwd);
  const home = resolve(env.MINIH_HOME || join(homedir(), '.minih'));
  const key = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex').slice(0, 16);
  return {
    home, cwd: project, agent: join(home, 'pi'), settings: join(home, 'settings.json'),
    registry: join(home, 'sessions.json'), sessions: join(home, 'sessions', key),
    pid: join(home, 'server.json'), log: join(home, 'server.log'),
    plugins: join(home, 'plugins'), skills: join(home, 'skills'),
    projectSkills: join(project, '.minih', 'skills')
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
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export function validateSettings(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings object');
  const p = input.plugins || {};
  const s = input.subagents || {};
  const model = input.model || {};
  const sandbox = input.sandbox || {};
  for (const [key, value] of Object.entries(p)) {
    if (!(key in DEFAULTS.plugins) && !/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new Error('Invalid plugin name');
    if (typeof value !== 'boolean') throw new Error('Plugin switches must be boolean');
  }
  if (!Number.isInteger(s.maxParallel ?? 2) || (s.maxParallel ?? 2) < 1 || (s.maxParallel ?? 2) > 16) throw new Error('maxParallel must be 1..16');
  for (const value of [s.provider ?? '', s.model ?? '', model.provider ?? '', model.id ?? '']) {
    if (typeof value !== 'string' || value.length > 160) throw new Error('Invalid provider or model');
  }
  if (!['isolated', 'host'].includes(sandbox.mode ?? 'isolated')) throw new Error('Invalid sandbox mode');
  if (!Number.isInteger(sandbox.timeoutSeconds ?? 60) || (sandbox.timeoutSeconds ?? 60) < 1 || (sandbox.timeoutSeconds ?? 60) > 300) throw new Error('Invalid shell timeout');
  if (!['system', 'light', 'dark'].includes(input.appearance ?? 'system')) throw new Error('Invalid appearance');
  if (!Number.isInteger(input.port ?? 3837) || (input.port ?? 3837) < 1024 || (input.port ?? 3837) > 65535) throw new Error('Invalid port');
  return true;
}

export function readSettings(paths: ReturnType<typeof getPaths>): Settings {
  const input = readJson<Record<string, any>>(paths.settings, {});
  const settings = {
    port: input.port ?? DEFAULTS.port,
    model: { ...DEFAULTS.model, ...input.model },
    plugins: { ...DEFAULTS.plugins, ...input.plugins },
    subagents: { ...DEFAULTS.subagents, ...input.subagents },
    sandbox: { ...DEFAULTS.sandbox, ...input.sandbox },
    appearance: input.appearance ?? DEFAULTS.appearance
  };
  validateSettings(settings);
  return settings as Settings;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch');
  const allowed = Object.keys(DEFAULTS);
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown settings field');
  for (const group of ['model', 'plugins', 'subagents', 'sandbox']) {
    if (group in patch && (!patch[group] || typeof patch[group] !== 'object' || Array.isArray(patch[group]))) throw new Error('Invalid settings section');
  }
  const next: Settings = {
    ...current,
    ...patch,
    model: { ...current.model, ...(patch.model || {}) },
    plugins: { ...current.plugins, ...(patch.plugins || {}) },
    subagents: { ...current.subagents, ...(patch.subagents || {}) },
    sandbox: { ...current.sandbox, ...(patch.sandbox || {}) }
  };
  validateSettings(next);
  return next;
}

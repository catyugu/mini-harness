import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { Context, EntryTree, type EntryOptions, type Plugin } from 'mini-harness/cordis';
import { readJson, writeJson, writeText } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { isScopeKey, localPluginIdPattern, pluginIdPattern } from '@mini-harness/plugin-api/selection';
import type { ProfileConfiguration, ProfileRuntime } from '@mini-harness/plugin-api/profile';
import { parseSettings } from '@mini-harness/settings/config';

interface Row {
  id: string;
  name?: string;
  disabled?: boolean;
  client?: boolean;
  config?: Record<string, unknown>;
  bootstrap?: boolean;
  required?: boolean;
}

interface Layer {
  detached?: boolean;
  include?: string[];
  plugins?: Row[];
  providers?: ProfileConfiguration['providers'];
  browserProviders?: ProfileConfiguration['browserProviders'];
  scopes?: ProfileConfiguration['scopes'];
}

const bundled = new URL('../../../../profiles/', import.meta.url);
const installed = new URL('../../../', import.meta.url);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function load(file: string, user = false): Layer {
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'), { schema: 'core', strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map(error => error.message).join('\n'));
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value == null) return {};
    const fields = ['include', 'detached', 'plugins', 'providers', 'browserProviders', 'scopes'];
    if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Expected a Profile object');
    if (value.detached !== undefined && (user || typeof value.detached !== 'boolean')) throw new Error('Invalid detached setting');
    if (value.include !== undefined && (user || !Array.isArray(value.include) || value.include.some(path => path !== './base.yml')))
      throw new Error('Only shipped Profiles may include ./base.yml');
    if (value.plugins !== undefined && !Array.isArray(value.plugins)) throw new Error('plugins must be a list');
    const ids = new Set<string>();
    for (const row of value.plugins as unknown[] ?? []) {
      if (!object(row) || Object.keys(row).some(key => !['id','name','disabled','client','config','bootstrap','required'].includes(key)) ||
        typeof row.id !== 'string' || !pluginIdPattern.test(row.id) || ids.has(row.id) ||
        row.name !== undefined && typeof row.name !== 'string' ||
        row.config !== undefined && !object(row.config) ||
        ['disabled','client','bootstrap','required'].some(key => row[key] !== undefined && typeof row[key] !== 'boolean') ||
        user && (row.bootstrap !== undefined || row.required !== undefined))
        throw new Error('Invalid or duplicate plugin entry: ' + (object(row) ? row.id : row));
      ids.add(row.id);
    }
    return value as Layer;
  } catch (error) {
    if (user && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(file + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
}

function rows(layers: readonly Layer[]) {
  const result = new Map<string, Row>();
  for (const layer of layers) for (const row of layer.plugins ?? []) {
    const existing = result.get(row.id);
    result.set(row.id, { ...existing, ...row, config: { ...existing?.config, ...row.config } });
  }
  return result;
}

function profileFile(name: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || name === 'base') throw new Error('Invalid Profile name: ' + name);
  return load(fileURLToPath(new URL(name + '.yml', bundled)));
}

export function allowsDetachment(name: string) { return profileFile(name).detached === true; }

export function readProfile(name: string) {
  const surface = profileFile(name);
  return rows([...(surface.include?.length ? [load(fileURLToPath(new URL('base.yml', bundled)))] : []), surface]);
}

async function moduleFor(name: string) {
  const [path, entry = 'default'] = name.split('#');
  if (!/^packages\/[a-z][a-z0-9-]*\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(path) ||
      !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(entry) || name.split('#').length > 2)
    throw new Error('Invalid Profile module: ' + name);
  const exports = await import(new URL(path, installed).href);
  const value: unknown = exports[entry];
  if (value == null) throw new Error('Profile module export not found: ' + name);
  return value;
}

export async function profileDescriptors(entries: ReadonlyMap<string, Row>) {
  return Promise.all([...entries.values()].filter(row => !row.bootstrap && row.name && !row.name.startsWith('installed:')).map(async row => {
    const descriptor = await moduleFor(row.name!) as PluginDescriptor;
    return { ...descriptor, id: row.id, defaultEnabled: !row.disabled, required: row.required,
      browser: row.client ? descriptor.browser : undefined,
      browserStyles: row.client ? descriptor.browserStyles : undefined,
      browserRequires: row.client ? descriptor.browserRequires : undefined,
      browserProvides: row.client ? descriptor.browserProvides : undefined,
    };
  }));
}

export async function loadProfile(name: string, paths: Paths, context: Context): Promise<ProfileRuntime> {
  const official = readProfile(name);
  const file = join(paths.home, 'profiles', name, 'cordis.yml');
  const user = load(file, true);
  for (const row of user.plugins ?? []) {
    const base = official.get(row.id);
    if (base?.bootstrap || base?.required && (row.disabled || base.client && row.client === false) ||
      base && row.name && base.name !== row.name)
      throw new Error(file + ': entry cannot be replaced or disabled: ' + row.id);
    if (!base && !row.name) throw new Error(file + ': new entry requires a module name: ' + row.id);
    if (row.name?.startsWith('installed:') && (!localPluginIdPattern.test(row.name.slice(10)) || !localPluginIdPattern.test(row.id)))
      throw new Error(file + ': installed entries use the installed module ID: ' + row.id);
  }
  const resolved = rows([{ plugins: [...official.values()] }, user]);
  const { legacy, product, scopedTools, migration } = legacySettings(paths);
  const overrides = {
    plugins: Object.fromEntries([...resolved.values()].filter(row => !row.bootstrap).map(row => [row.id, !row.disabled])),
    pluginConfig: Object.fromEntries([...resolved.values()].filter(row => Object.keys(row.config ?? {}).length)
      .map(row => [row.id, { ...row.config, ...legacy.pluginConfig[row.id] }])),
    providers: legacy.providers, browserProviders: legacy.browserProviders, scopes: legacy.scopes,
  };
  Object.assign(overrides.plugins, legacy.plugins);
  for (const [id, config] of Object.entries(legacy.pluginConfig)) overrides.pluginConfig[id] ??= config;
  for (const row of user.plugins ?? []) {
    if (row.disabled !== undefined) overrides.plugins[row.id] = !row.disabled;
    if (row.config) overrides.pluginConfig[row.id] = { ...overrides.pluginConfig[row.id], ...row.config };
  }
  const configuredPort = resolved.get('core:web-server')?.config?.port;
  const effective = parseSettings({
    ...product, ...overrides,
    port: configuredPort ?? legacy.port,
    providers: user.providers ?? overrides.providers,
    browserProviders: user.browserProviders ?? overrides.browserProviders,
    scopes: withToolRules(user.scopes ?? overrides.scopes, scopedTools),
  });
  if (migration && configuredPort !== undefined && !user.plugins?.some(row => row.id === 'core:web-server' && row.config?.port !== undefined)) {
    effective.port = legacy.port;
    if (resolved.has('core:web-server')) {
      effective.pluginConfig['core:web-server'] = { ...effective.pluginConfig['core:web-server'], port: legacy.port };
    }
  }
  const descriptors = await profileDescriptors(resolved);
  const modules = await Promise.all([...resolved.values()].filter(row => row.bootstrap).map(async row => ({
    row, plugin: await moduleFor(row.name!) as Plugin,
  })));
  const infrastructure = modules.flatMap(({ plugin }) => typeof plugin.provide === 'string' ? [plugin.provide] : plugin.provide ?? []);
  const bootstrap: EntryOptions[] = modules.map(({ row, plugin }) => ({
    id: row.id, module: row.name!, context, config: row.config ?? {}, load: () => plugin,
  }));
  const entries = new EntryTree();
  const aliases = new Map([...resolved.values()].flatMap(row => row.name?.startsWith('installed:') ? [[row.id, row.name.slice(10)]] : []));
  let current = effective;
  let migrate = migration;
  function commit(settings: ProfileConfiguration) {
    const plugins: Row[] = [];
    for (const id of new Set([...Object.keys(settings.plugins), ...Object.keys(settings.pluginConfig), ...(user.plugins ?? []).filter(row => !row.name?.startsWith('installed:')).map(row => row.id)])) {
      const base = official.get(id);
      if (base?.bootstrap) continue;
      const existing = resolved.get(id);
      const config = settings.pluginConfig[id];
      const row: Row = { id };
      if (!base) row.name = existing?.name ?? 'installed:' + id;
      const disabled = settings.plugins[id] === undefined ? undefined : !settings.plugins[id];
      if (disabled !== undefined && (!base || disabled !== Boolean(base.disabled))) row.disabled = disabled;
      const changed = Object.fromEntries(Object.entries(config ?? {}).filter(([key, value]) => !isDeepStrictEqual(value, base?.config?.[key])));
      if (Object.keys(changed).length) row.config = changed;
      if (existing?.client !== undefined && existing.client !== base?.client) row.client = existing.client;
      if (Object.keys(row).length > 1) plugins.push(row);
    }
    const rules = Object.fromEntries(Object.entries(settings.scopes).flatMap(([key, scope]) => scope?.disabledTools ? [[key, scope.disabledTools]] : []));
    const scopes = Object.fromEntries(Object.entries(settings.scopes).flatMap(([key, scope]) => {
      if (!scope) return [];
      const { disabledTools: _, ...scopeSettings } = scope;
      return Object.keys(scopeSettings).length ? [[key, scopeSettings]] : [];
    }));
    const next = { plugins, providers: settings.providers, browserProviders: settings.browserProviders ?? {}, scopes };
    const text = stringify(next);
    // The YAML commit happens before removing legacy settings, so a crash is recoverable
    // from the YAML layer. Ordinary product settings are saved only when they change.
    const previous = readProfileText(file);
    if (previous !== text) writeText(file, text);
    const domain = { readOnlyTools: settings.readOnlyTools, scopedTools: rules };
    try {
      if (migrate || !isDeepStrictEqual(current.readOnlyTools, settings.readOnlyTools) ||
        !isDeepStrictEqual(scopedRules(current.scopes), rules)) writeJson(paths.settings, domain);
    } catch (error) {
      if (previous === undefined) rmSync(file, { force: true });
      else if (previous !== text) writeText(file, previous);
      throw error;
    }
    migrate = false;
    for (const id of aliases.keys()) if (!Object.hasOwn(settings.plugins, id) && !Object.hasOwn(settings.pluginConfig, id))
      aliases.delete(id);
    current = settings;
  }
  return { descriptors, bootstrap, entries, infrastructure,
    installed: aliases,
    client(id) { return resolved.get(id)?.client ?? descriptors.some(row => row.browser); },
    read: () => current, commit,
    finishMigration() { if (migrate) commit(current); },
  };
}

function readProfileText(file: string) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function scopedRules(scopes: ProfileConfiguration['scopes']) {
  return Object.fromEntries(Object.entries(scopes).flatMap(([key, scope]) => scope?.disabledTools ? [[key, scope.disabledTools]] : []));
}

function withToolRules(scopes: ProfileConfiguration['scopes'], rules: Record<string, unknown>) {
  return { ...scopes, ...Object.fromEntries(Object.entries(rules).map(([key, disabledTools]) => [key, {
    ...scopes[key as keyof typeof scopes], disabledTools,
  }])) };
}

function legacySettings(paths: Paths) {
  const raw = readJson<Record<string, unknown>>(paths.settings, {});
  const migration = ['plugins','pluginConfig','providers','browserProviders','scopes','port'].some(key => Object.hasOwn(raw, key));
  const legacy = parseSettings(raw);
  const scopedTools = object(raw.scopedTools) ? raw.scopedTools : scopedRules(legacy.scopes);
  if (Object.keys(scopedTools).some(key => !isScopeKey(key))) throw new Error('Invalid scoped tool settings');
  return { migration, legacy, scopedTools, product: { readOnlyTools: legacy.readOnlyTools } };
}

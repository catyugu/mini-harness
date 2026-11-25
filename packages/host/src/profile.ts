import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { Context, EntryTree, type EntryOptions, type Plugin } from 'mini-harness/cordis';
import { readJson, writeJson, writeText } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { ResolvedPlugin, PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { bindInstance } from '@mini-harness/plugin-api/instance';
import { bindPluginImports, resolveModule } from '@mini-harness/plugins/module-resolution';
import { isScopeKey, localPluginIdPattern, pluginIdPattern } from '@mini-harness/plugin-api/selection';
import type { ProfileConfiguration, ProfileRuntime } from '@mini-harness/plugin-api/profile';
import { parseSettings } from '@mini-harness/settings/config';

interface Row {
  id: string;
  name?: string;
  disabled?: boolean;
  client?: boolean;
  config?: Record<string, unknown>;
}

interface Layer {
  detached?: boolean;
  include?: string[];
  plugins?: Row[];
  scopes?: ProfileConfiguration['scopes'];
}

interface LoadedLayer extends Layer {
  file: string;
}

interface ResolvedRow extends Row {
  source?: string;
}

const bundled = new URL('../../../../profiles/', import.meta.url);
const installed = new URL('../../../', import.meta.url);
const officialBundles = new Map([
  ['@mini-harness/base', 'base.yml'],
  ['@mini-harness/web', 'web.yml'],
]);

export const WEB_BUNDLES = [...officialBundles.keys()];
const ROOT = 'cordis.yml';
const PATCH = 'cordis.patch.yml';
const MANIFEST = 'package.json';

function profileDirectory(name: string, paths: Paths) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.toLowerCase() === 'node_modules')
    throw new Error('Invalid Profile name: ' + name);
  return join(paths.home, 'profiles', name);
}

/** Create an ordinary private npm package; an existing Profile is never overwritten. */
export function initializeProfile(name: string, paths: Paths, bundles: readonly string[] = []) {
  const directory = profileDirectory(name, paths);
  const manifest = join(directory, MANIFEST);
  if (existsSync(manifest)) throw new Error('Profile already exists: ' + name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = join(directory, ROOT);
  const patch = join(directory, PATCH);
  // Before Profiles were packages, the user configuration lived in cordis.yml.
  // Move it to the user patch before writing the package manifest.
  if (!existsSync(patch)) writeText(patch, existsSync(root) ? readFileSync(root, 'utf8') : 'plugins: []\n');
  writeText(root, 'plugins: []\n');
  writeJson(manifest, {
    name: 'mini-harness-profile-' + name.toLowerCase(),
    private: true,
    type: 'module',
    dependencies: {},
    miniHarness: { profile: { bundles: [...bundles] } },
  });
  return directory;
}

function bundleLayers(name: string, directory: string): LoadedLayer[] {
  const shipped = officialBundles.get(name);
  if (shipped) return layers(fileURLToPath(new URL(shipped, bundled)));
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))
    throw new Error('Invalid Profile bundle package name: ' + name);
  const root = join(directory, 'node_modules', name);
  const manifest = readJson<{ miniHarness?: { bundle?: { patch?: unknown } } }>(
    join(root, MANIFEST),
    {},
  );
  const declared = manifest.miniHarness?.bundle?.patch;
  const patches = typeof declared === 'string' ? [declared] : declared;
  if (!Array.isArray(patches) || !patches.length || patches.some((file) => typeof file !== 'string'))
    throw new Error('Profile bundle must declare miniHarness.bundle.patch: ' + name);
  return patches.flatMap((file: string) => {
    const path = resolve(root, file);
    const location = relative(root, path);
    if (!location || isAbsolute(location) || location === '..' || location.startsWith('..' + sep))
      throw new Error('Profile bundle patch must be inside its package: ' + name);
    return layers(path);
  });
}
const packagedModules = new Map(
  Object.entries(
    JSON.parse(readFileSync(new URL('./profile-modules.json', import.meta.url), 'utf8')) as Record<
      string,
      { path: string; exportName: string }
    >,
  ),
);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function load(file: string, optional = false): Layer | undefined {
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'), { schema: 'core', strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error([...doc.errors, ...doc.warnings].map((error) => error.message).join('\n'));
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value == null) return {};
    const fields = ['include', 'detached', 'plugins', 'scopes'];
    if (!object(value) || Object.keys(value).some((key) => !fields.includes(key)))
      throw new Error('Expected a Profile object');
    if (value.detached !== undefined && typeof value.detached !== 'boolean')
      throw new Error('Invalid detached setting');
    if (
      value.include !== undefined &&
      (!Array.isArray(value.include) ||
        value.include.some((path) => typeof path !== 'string' || !path.trim()))
    )
      throw new Error('include must be a list of YAML paths');
    if (value.plugins !== undefined && !Array.isArray(value.plugins))
      throw new Error('plugins must be a list');
    const ids = new Set<string>();
    for (const row of (value.plugins as unknown[]) ?? []) {
      if (
        !object(row) ||
        Object.keys(row).some(
          (key) => !['id', 'name', 'disabled', 'client', 'config'].includes(key),
        ) ||
        typeof row.id !== 'string' ||
        !pluginIdPattern.test(row.id) ||
        ids.has(row.id) ||
        (row.name !== undefined && (typeof row.name !== 'string' || !row.name.trim())) ||
        (row.config !== undefined && !object(row.config)) ||
        ['disabled', 'client'].some(
          (key) => row[key] !== undefined && typeof row[key] !== 'boolean',
        )
      )
        throw new Error('Invalid or duplicate plugin entry: ' + (object(row) ? row.id : row));
      ids.add(row.id);
    }
    return value as Layer;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(file + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
}

/** Resolve includes relative to the declaring YAML, detecting aliases of the same physical file. */
function layers(file: string, optional = false, ancestors: readonly string[] = []): LoadedLayer[] {
  const layer = load(file, optional);
  if (!layer) return [];
  const physical = realpathSync(file);
  if (ancestors.includes(physical))
    throw new Error('Cyclic Profile include: ' + [...ancestors, physical].join(' -> '));
  return [
    ...(layer.include ?? []).flatMap((path) =>
      layers(resolve(dirname(file), path), false, [...ancestors, physical]),
    ),
    { ...layer, file },
  ];
}

function rows(layers: readonly LoadedLayer[]) {
  const result = new Map<string, ResolvedRow>();
  for (const layer of layers)
    for (const row of layer.plugins ?? []) {
      const existing = result.get(row.id);
      result.set(row.id, {
        ...existing,
        ...row,
        source: row.name === undefined ? existing?.source : layer.file,
        config: { ...existing?.config, ...row.config },
      });
    }
  for (const row of result.values())
    if (!row.name) throw new Error('Profile entry requires a module name: ' + row.id);
  return result;
}

function installedPath(file: string, directory: string) {
  const path = relative(dirname(file), directory).split(sep).join('/');
  return isAbsolute(path) || path.startsWith('../') ? path : './' + path;
}

function localDirectory(row: ResolvedRow, paths: Paths) {
  const name = row.name!;
  if (!isAbsolute(name) && !name.startsWith('./') && !name.startsWith('../')) return;
  const directory = resolve(dirname(row.source!), name);
  const location = relative(paths.plugins, directory);
  if (localPluginIdPattern.test(location) || statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    return relative(paths.plugins, existsSync(directory) ? realpathSync(directory) : directory);
}

function profileLayers(name: string, paths: Paths) {
  const directory = profileDirectory(name, paths);
  const manifestPath = join(directory, MANIFEST);
  if (!existsSync(manifestPath)) {
    if (name !== 'web') throw new Error('Unknown Profile package: ' + name);
    initializeProfile(name, paths, WEB_BUNDLES);
  }
  const manifest = readJson<{ miniHarness?: { profile?: { bundles?: unknown } } }>(manifestPath, {});
  const bundles = manifest.miniHarness?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some((bundle) => typeof bundle !== 'string'))
    throw new Error(manifestPath + ': expected miniHarness.profile.bundles');
  const file = join(directory, PATCH);
  // Convert the old installed-module specifier in the writable layer once.
  const patch = load(file);
  let converted = false;
  for (const row of patch?.plugins ?? []) {
    if (!row.name?.startsWith('installed:')) continue;
    const id = row.name.slice(10);
    if (!localPluginIdPattern.test(id)) throw new Error('Invalid installed plugin ID: ' + id);
    row.name = installedPath(file, join(paths.plugins, id));
    converted = true;
  }
  if (converted) writeText(file, stringify(patch));
  return {
    directory,
    file,
    shipped: [
      ...layers(join(directory, ROOT)),
      ...bundles.flatMap((bundle: string) => bundleLayers(bundle, directory)),
    ],
    userLayers: layers(file),
  };
}

export function allowsDetachment(name: string, paths: Paths) {
  const { shipped, userLayers } = profileLayers(name, paths);
  return Object.assign({}, ...shipped, ...userLayers).detached === true;
}

export function readProfile(name: string, paths?: Paths) {
  if (!paths) {
    if (name !== 'web') throw new Error('Unknown shipped Profile template: ' + name);
    return rows(WEB_BUNDLES.flatMap((bundle) => bundleLayers(bundle, '')));
  }
  const { shipped, userLayers } = profileLayers(name, paths);
  return rows([...shipped, ...userLayers]);
}

function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'function' || (object(value) && typeof value.apply === 'function');
}

async function moduleFor(name: string): Promise<{ plugin?: Plugin; metadata?: PluginInfo }> {
  const target = packagedModules.get(name);
  if (!target) throw new Error('Unknown packaged Profile plugin: ' + name);
  const exports = await import(new URL(target.path, installed).href);
  const value: unknown = exports[target.exportName];
  const metadata: PluginInfo | undefined =
    exports[target.exportName === 'default' ? 'metadata' : target.exportName + 'Metadata'];
  if (value !== undefined && !isPlugin(value))
    throw new Error('Profile module must export a Cordis plugin: ' + name);
  if (!value && !metadata?.browser) throw new Error('Profile module export not found: ' + name);
  return { plugin: value, metadata };
}

async function nativeModule(row: ResolvedRow, module: string) {
  const name = row.name!;
  const value: unknown = packagedModules.has(name)
    ? (await moduleFor(name)).plugin
    : await import(module).then((exports) => exports.default ?? exports);
  if (!isPlugin(value)) throw new Error('Profile module must export a Cordis plugin: ' + name);
  return { row, module, plugin: value };
}

export async function profileDescriptors(entries: ReadonlyMap<string, Row>): Promise<ResolvedPlugin[]> {
  const descriptors = await Promise.all(
    [...entries.values()]
      .filter((row) => row.name && packagedModules.has(row.name))
      .map(async (row) => {
        const { plugin, metadata } = await moduleFor(row.name!);
        if (!metadata) return;
        return {
          ...metadata,
          plugin,
          id: row.id,
          defaultEnabled: !row.disabled,
          browser: row.client ? metadata.browser : undefined,
          browserStyles: row.client ? metadata.browserStyles : undefined,
        };
      }),
  );
  return descriptors.filter((descriptor) => descriptor !== undefined);
}

export async function loadProfile(name: string, paths: Paths, context: Context): Promise<ProfileRuntime> {
  const { directory, file, shipped, userLayers } = profileLayers(name, paths);
  const user: Layer = userLayers.at(-1) ?? {};
  const baseLayers = [...shipped, ...userLayers.slice(0, -1)];
  const official = rows(baseLayers);
  const resolved = rows([...shipped, ...userLayers]);
  const merged: Layer = Object.assign({}, ...shipped, ...userLayers);
  const aliases = new Map<string, string>();
  for (const row of resolved.values()) {
    const location = localDirectory(row, paths);
    if (location !== undefined) aliases.set(row.id, location);
  }
  const descriptors = await profileDescriptors(resolved);
  const managedIds = new Set(descriptors.map(({ id }) => id));
  const nativeRows = [...resolved.values()].filter(
    (row) => !managedIds.has(row.id) && !aliases.has(row.id),
  );
  const nativeIds = new Set(nativeRows.map(({ id }) => id));
  const { legacy: previousSettings, product, scopedTools, migration: pendingMigration, raw } =
    legacySettings(paths);
  const legacy = name === 'web' ? previousSettings : parseSettings({});
  const migration = name === 'web' && pendingMigration;
  const overrides = {
    plugins: Object.fromEntries(
      [...resolved.values()].filter((row) => !nativeIds.has(row.id)).map((row) => [row.id, !row.disabled]),
    ),
    pluginConfig: Object.fromEntries(
      [...resolved.values()]
        .filter((row) => !nativeIds.has(row.id) && Object.keys(row.config ?? {}).length)
        .map((row) => [row.id, { ...row.config, ...legacy.pluginConfig[row.id] }]),
    ),
    scopes: legacy.scopes,
  };
  Object.assign(overrides.plugins, legacy.plugins);
  for (const [id, config] of Object.entries(legacy.pluginConfig))
    if (!nativeIds.has(id)) overrides.pluginConfig[id] ??= config;
  for (const layer of userLayers)
    for (const row of layer.plugins ?? []) {
      if (nativeIds.has(row.id)) continue;
      if (row.disabled !== undefined) overrides.plugins[row.id] = !row.disabled;
      if (row.config) overrides.pluginConfig[row.id] = { ...overrides.pluginConfig[row.id], ...row.config };
    }
  for (const id of nativeIds) {
    delete overrides.plugins[id];
    delete overrides.pluginConfig[id];
  }
  const configuredPort = resolved.get('core:web-server')?.config?.port;
  const effective = parseSettings({
    ...product,
    ...overrides,
    port: configuredPort ?? legacy.port,
    scopes: withToolRules(merged.scopes ?? overrides.scopes, scopedTools),
  });
  if (
    migration &&
    configuredPort !== undefined &&
    !user.plugins?.some((row) => row.id === 'core:web-server' && row.config?.port !== undefined)
  ) {
    effective.port = legacy.port;
    if (resolved.has('core:web-server')) {
      effective.pluginConfig['core:web-server'] = {
        ...effective.pluginConfig['core:web-server'],
        port: legacy.port,
      };
    }
  }
  // Disabled external modules are never resolved or imported.
  const sources = nativeRows
    .filter((row) => !row.disabled)
    .map((row) => ({
      row,
      module: packagedModules.has(row.name!) ? row.name! : resolveModule(row.name!, row.source!),
    }));
  const roots = [
    directory,
    ...[...aliases.values()].map((location) => resolve(paths.plugins, location)),
    ...sources.flatMap(({ row, module }) =>
      packagedModules.has(row.name!) ? [] : [dirname(fileURLToPath(module))],
    ),
  ];
  const imports = bindPluginImports(roots);
  let modules: Awaited<ReturnType<typeof nativeModule>>[];
  try {
    modules = await Promise.all(sources.map(({ row, module }) => nativeModule(row, module)));
  } catch (error) {
    imports.deregister();
    throw error;
  }
  const infrastructure = modules.flatMap(({ plugin }) =>
    typeof plugin.provide === 'string' ? [plugin.provide] : (plugin.provide ?? []),
  );
  const nativeEntries: EntryOptions[] = modules.map(({ row, module, plugin }) => ({
    id: row.id,
    module,
    context,
    config: row.config ?? {},
    load: () => plugin,
    prepare: packagedModules.has(row.name!)
      ? undefined
      : (ctx) => {
          bindInstance(ctx.fiber.entry!, {
            pluginId: row.id,
            scope: { kind: 'application' },
            trusted: false,
            writableConfig: false,
          });
        },
  }));
  const entries = new EntryTree();
  let current = effective;
  let migrate = migration;
  function commit(settings: ProfileConfiguration) {
    // Native Entries belong to the selected YAML and are not editable through the
    // managed Settings projection. Preserve their root declarations verbatim.
    const plugins: Row[] = (user.plugins ?? []).filter(({ id }) => nativeIds.has(id));
    for (const id of nativeIds)
      if (Object.hasOwn(settings.plugins, id) || Object.hasOwn(settings.pluginConfig, id))
        throw new Error('Edit the native Profile entry and restart to configure: ' + id);
    for (const id of new Set([
      ...Object.keys(settings.plugins),
      ...Object.keys(settings.pluginConfig),
      ...(user.plugins ?? [])
        .filter((row) => !nativeIds.has(row.id) && !aliases.has(row.id))
        .map((row) => row.id),
    ])) {
      const base = official.get(id);
      if (nativeIds.has(id)) continue;
      const existing = resolved.get(id);
      const config = settings.pluginConfig[id];
      const row: Row = { id };
      if (!base || existing?.name !== base.name)
        row.name = aliases.has(id)
          ? installedPath(file, resolve(paths.plugins, aliases.get(id)!))
          : existing?.name ?? installedPath(file, join(paths.plugins, id));
      const disabled = settings.plugins[id] === undefined ? undefined : !settings.plugins[id];
      if (disabled !== undefined && (!base || disabled !== Boolean(base.disabled))) row.disabled = disabled;
      const changed = Object.fromEntries(
        Object.entries(config ?? {}).filter(([key, value]) => !isDeepStrictEqual(value, base?.config?.[key])),
      );
      if (Object.keys(changed).length) row.config = changed;
      if (existing?.client !== undefined && existing.client !== base?.client) row.client = existing.client;
      if (Object.keys(row).length > 1) plugins.push(row);
    }
    const rules = Object.fromEntries(
      Object.entries(settings.scopes).flatMap(([key, scope]) =>
        scope?.disabledTools ? [[key, scope.disabledTools]] : [],
      ),
    );
    const scopes = Object.fromEntries(
      Object.entries(settings.scopes).flatMap(([key, scope]) => {
        if (!scope) return [];
        const { disabledTools: _, ...scopeSettings } = scope;
        return Object.keys(scopeSettings).length ? [[key, scopeSettings]] : [];
      }),
    );
    const next = {
      ...(user.include === undefined ? {} : { include: user.include }),
      ...(user.detached === undefined ? {} : { detached: user.detached }),
      plugins,
      scopes,
    };
    const text = stringify(next);
    // The YAML commit happens before removing legacy settings, so a crash is recoverable
    // from the YAML layer. Ordinary product settings are saved only when they change.
    const previous = readProfileText(file);
    if (previous !== text) writeText(file, text);
    const domain = {
      ...(pendingMigration && name !== 'web' ? raw : {}),
      readOnlyTools: settings.readOnlyTools,
      scopedTools: rules,
    };
    try {
      if (
        migrate ||
        !isDeepStrictEqual(current.readOnlyTools, settings.readOnlyTools) ||
        !isDeepStrictEqual(scopedRules(current.scopes), rules)
      )
        writeJson(paths.settings, domain);
    } catch (error) {
      if (previous === undefined) rmSync(file, { force: true });
      else if (previous !== text) writeText(file, previous);
      throw error;
    }
    migrate = false;
    for (const id of aliases.keys())
      if (!Object.hasOwn(settings.plugins, id) && !Object.hasOwn(settings.pluginConfig, id))
        aliases.delete(id);
    current = settings;
  }
  return {
    directory,
    descriptors,
    nativeEntries,
    entries,
    infrastructure,
    installed: aliases,
    client(id) {
      return resolved.get(id)?.client ?? descriptors.some((row) => row.browser);
    },
    read: () => current,
    commit,
    finishMigration() {
      if (migrate) commit(current);
    },
    async close() {
      try {
        await entries.close();
      } finally {
        imports.deregister();
      }
    },
  };
}

function readProfileText(file: string) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function scopedRules(scopes: ProfileConfiguration['scopes']) {
  return Object.fromEntries(
    Object.entries(scopes).flatMap(([key, scope]) =>
      scope?.disabledTools ? [[key, scope.disabledTools]] : [],
    ),
  );
}

function withToolRules(scopes: ProfileConfiguration['scopes'], rules: Record<string, unknown>) {
  return {
    ...scopes,
    ...Object.fromEntries(
      Object.entries(rules).map(([key, disabledTools]) => [
        key,
        {
          ...scopes[key as keyof typeof scopes],
          disabledTools,
        },
      ]),
    ),
  };
}

function legacySettings(paths: Paths) {
  const raw = readJson<Record<string, unknown>>(paths.settings, {});
  const migration = ['plugins', 'pluginConfig', 'providers', 'scopes', 'port'].some(
    (key) => Object.hasOwn(raw, key),
  );
  if (object(raw.providers) && Object.keys(raw.providers).length)
    throw new Error('Plugin provider selections are no longer supported. Enable the desired entries and disable conflicting entries in the Profile.');
  const legacy = parseSettings(raw);
  const scopedTools = object(raw.scopedTools) ? raw.scopedTools : scopedRules(legacy.scopes);
  if (Object.keys(scopedTools).some((key) => !isScopeKey(key)))
    throw new Error('Invalid scoped tool settings');
  return { raw, migration, legacy, scopedTools, product: { readOnlyTools: legacy.readOnlyTools } };
}

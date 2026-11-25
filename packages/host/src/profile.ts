import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { Context, EntryTree } from 'mini-harness/cordis';
import { readJson, writeJson, writeText } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { PluginCatalog } from '@mini-harness/plugins/catalog';
import { bindPluginImports } from '@mini-harness/plugins/module-resolution';
import { localPluginIdPattern, pluginIdPattern, parseSettings } from '@mini-harness/plugin-api/selection';
import type { ProfileRuntime } from '@mini-harness/plugin-api/profile';
import type { EntryConfiguration, ProfileConfiguration } from '@mini-harness/plugin-api/configuration';

interface Row extends EntryConfiguration {
  id: string;
}

interface Layer {
  detached?: boolean;
  include?: string[];
  plugins?: Row[];
  scopes?: ProfileConfiguration['scopes'];
  readOnlyTools?: ProfileConfiguration['readOnlyTools'];
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

export function profileDirectory(name: string, paths: Paths) {
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
  if (existsSync(root) || existsSync(patch))
    throw new Error('Profile directory already contains configuration: ' + name);
  writeText(patch, 'plugins: []\n');
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
  const manifest = readJson<{ miniHarness?: { bundle?: { patch?: unknown } } }>(join(root, MANIFEST), {});
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

/** Module-only rows use a stable ID without requiring a second name. */
function entryId(name: string) {
  if (localPluginIdPattern.test(name)) return name;
  return 'plugin-' + createHash('sha256').update(name).digest('hex').slice(0, 24);
}

function load(file: string, optional = false): Layer | undefined {
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'), { schema: 'core', strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error([...doc.errors, ...doc.warnings].map((error) => error.message).join('\n'));
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value == null) return {};
    const fields = ['include', 'detached', 'plugins', 'scopes', 'readOnlyTools'];
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
      if (object(row) && row.id === undefined && typeof row.name === 'string' && row.name.trim())
        row.id = entryId(row.name);
      if (
        !object(row) ||
        Object.keys(row).some(
          (key) => !['id', 'name', 'disabled', 'client', 'live', 'config'].includes(key),
        ) ||
        typeof row.id !== 'string' ||
        !pluginIdPattern.test(row.id) ||
        ids.has(row.id) ||
        (row.name !== undefined && (typeof row.name !== 'string' || !row.name.trim())) ||
        (row.config !== undefined && !object(row.config)) ||
        ['disabled', 'client', 'live'].some((key) => row[key] !== undefined && typeof row[key] !== 'boolean')
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

function moduleName(name: string, source: string) {
  return name.startsWith('./') || name.startsWith('../') ? resolve(dirname(source), name) : name;
}

function scopedEntries(selected: readonly LoadedLayer[]) {
  const layer = [...selected].reverse().find(({ scopes }) => scopes !== undefined);
  return Object.fromEntries(
    Object.entries(layer?.scopes ?? {}).map(([key, scope]) => [
      key,
      {
        ...scope,
        entries: Object.fromEntries(
          Object.entries(scope?.entries ?? {}).map(([id, entry]) => [
            id,
            { ...entry, ...(entry.name ? { name: moduleName(entry.name, layer!.file) } : {}) },
          ]),
        ),
      },
    ]),
  );
}

export function recreateProfile(name: string, template: string, paths: Paths) {
  if (template !== 'web') throw new Error('Unknown shipped Profile template: ' + template);
  const directory = profileDirectory(name, paths);
  rmSync(directory, { recursive: true, force: true });
  return initializeProfile(name, paths, WEB_BUNDLES);
}

export function ensureProfile(name: string, paths: Paths) {
  const directory = profileDirectory(name, paths);
  if (!existsSync(join(directory, MANIFEST))) {
    if (name !== 'web') throw new Error('Unknown Profile package: ' + name);
    initializeProfile(name, paths, WEB_BUNDLES);
  }
  return directory;
}

function profileLayers(name: string, paths: Paths, patches: readonly string[] = [], defaults = false) {
  const directory = ensureProfile(name, paths);
  const manifestPath = join(directory, MANIFEST);
  const manifest = readJson<{ miniHarness?: { profile?: { bundles?: unknown } } }>(manifestPath, {});
  const bundles = manifest.miniHarness?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some((bundle) => typeof bundle !== 'string'))
    throw new Error(manifestPath + ': expected miniHarness.profile.bundles');
  const file = join(directory, PATCH);
  return {
    directory,
    file,
    shipped: [
      ...layers(join(directory, ROOT)),
      ...bundles.flatMap((bundle: string) => bundleLayers(bundle, directory)),
    ],
    userLayers: defaults ? [] : layers(file),
    overlays: patches.flatMap((patch) => layers(resolve(patch))),
  };
}

export function allowsDetachment(name: string, paths: Paths, patches: readonly string[] = []) {
  const { shipped, userLayers, overlays } = profileLayers(name, paths, patches);
  return Object.assign({}, ...shipped, ...userLayers, ...overlays).detached === true;
}

/** Print the actual layer composition without importing or mounting a plugin. */
export function dumpProfile(name: string, paths: Paths, patches: readonly string[], defaults = false) {
  const { shipped, userLayers, overlays } = profileLayers(name, paths, defaults ? [] : patches, defaults);
  const selected = defaults ? shipped : [...shipped, ...userLayers, ...overlays];
  const { detached, scopes } = Object.assign({}, ...selected) as Layer;
  return stringify({
    ...(detached === undefined ? {} : { detached }),
    plugins: [...rows(selected).values()].map(({ source, ...row }) => ({
      ...row,
      name:
        row.name!.startsWith('./') || row.name!.startsWith('../')
          ? resolve(dirname(source!), row.name!)
          : row.name,
    })),
    ...(scopes === undefined ? {} : { scopes: scopedEntries(selected) }),
    readOnlyTools: Object.assign({}, ...selected.map((layer) => layer.readOnlyTools)),
  });
}

/** The YAML layer and Entry envelope, independent of executable plugin schemas. */
export const profileSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    include: { type: 'array', items: { type: 'string', minLength: 1 } },
    detached: { type: 'boolean' },
    plugins: {
      type: 'array',
      items: {
        type: 'object',
        anyOf: [{ required: ['id'] }, { required: ['name'] }],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: pluginIdPattern.source },
          name: { type: 'string', minLength: 1 },
          disabled: { type: 'boolean' },
          client: { type: 'boolean' },
          live: { type: 'boolean' },
          config: { type: 'object' },
        },
      },
    },
    scopes: { type: 'object' },
    readOnlyTools: { type: 'object' },
  },
};

/** Apply only changes made during this run to the underlying persistent projection. */
function changedValues(base: unknown, before: unknown, after: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return base;
  if (!object(before) || !object(after)) return after;
  const result = { ...(object(base) ? base : {}) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      isDeepStrictEqual(before[key], after[key]) &&
      Object.hasOwn(before, key) === Object.hasOwn(after, key)
    )
      continue;
    if (!Object.hasOwn(after, key)) delete result[key];
    else result[key] = changedValues(result[key], before[key], after[key]);
  }
  return result;
}

export function readProfile(name: string, paths?: Paths) {
  if (!paths) {
    if (name !== 'web') throw new Error('Unknown shipped Profile template: ' + name);
    return rows(WEB_BUNDLES.flatMap((bundle) => bundleLayers(bundle, '')));
  }
  const { shipped, userLayers } = profileLayers(name, paths);
  return rows([...shipped, ...userLayers]);
}

const displayMetadata = readJson<Record<string, Partial<ResolvedPlugin>>>(
  fileURLToPath(new URL('./profile-metadata.json', import.meta.url)),
  {},
);

function builtin(id: string, name: string, client: boolean): ResolvedPlugin | undefined {
  const base = name.endsWith('/client') ? name.slice(0, -7) : name;
  const target = packagedModules.get(base);
  if (!target) return;
  const info = displayMetadata[base];
  if (base !== name) {
    if (!client || !info?.browser) return;
    return {
      id,
      title: info.title ?? id,
      description: info.description ?? '',
      icon: info.icon,
      browser: info.browser,
      browserStyles: info.browserStyles,
    };
  }
  return {
    title: id,
    description: '',
    ...info,
    id,
    location: { url: new URL(target.path, installed).href, exportName: target.exportName },
    browser: client ? info?.browser : undefined,
    browserStyles: client ? info?.browserStyles : undefined,
  };
}

export function profileDescriptors(entries: ReadonlyMap<string, Row>): ResolvedPlugin[] {
  const client = [...entries.values()].some(
    ({ name, disabled }) => name === '@mini-harness/web-gateway' && !disabled,
  );
  return [...entries.values()].flatMap((row) => {
    const descriptor = builtin(row.id, row.name!, row.client ?? client);
    return descriptor ? [{ ...descriptor, defaultEnabled: !row.disabled }] : [];
  });
}

export async function loadProfile(
  name: string,
  paths: Paths,
  context: Context,
  patches: readonly string[] = [],
): Promise<ProfileRuntime> {
  const { directory, file, shipped, userLayers, overlays } = profileLayers(name, paths, patches);
  const user: Layer = userLayers.at(-1) ?? {};
  const baseLayers = [...shipped, ...userLayers.slice(0, -1)];
  const official = rows(baseLayers);
  const persistentRows = rows([...shipped, ...userLayers]);
  const resolved = rows([...shipped, ...userLayers, ...overlays]);
  const overlayFiles = new Set(overlays.map(({ file }) => file));
  const source = (id: string, name: string) => {
    const row = resolved.get(id);
    if (row?.name && moduleName(row.name, row.source!) === name && !overlayFiles.has(row.source!))
      return row.source!;
    return join(directory, MANIFEST);
  };
  function configurationFor(
    selected: ReadonlyMap<string, ResolvedRow>,
    selectedLayers: readonly LoadedLayer[],
  ) {
    return parseSettings({
      entries: Object.fromEntries(
        [...selected.values()].map((row) => [
          row.id,
          {
            name: moduleName(row.name!, row.source!),
            disabled: Boolean(row.disabled),
            ...(row.client === undefined ? {} : { client: row.client }),
            ...(row.live === undefined ? {} : { live: row.live }),
            ...(row.config === undefined ? {} : { config: row.config }),
          },
        ]),
      ),
      scopes: scopedEntries([...shipped, ...selectedLayers]),
      readOnlyTools: Object.assign(
        {},
        ...[...shipped, ...selectedLayers].map((layer) => layer.readOnlyTools),
      ),
    });
  }
  let persistent = configurationFor(persistentRows, userLayers);
  const effective = overlays.length ? configurationFor(resolved, [...userLayers, ...overlays]) : persistent;
  const imports = bindPluginImports();
  const entries = new EntryTree();
  let current = effective;
  function commit(runtime: ProfileConfiguration) {
    const settings = overlays.length
      ? parseSettings(changedValues(persistent, current, runtime))
      : structuredClone(runtime);
    for (const id of resolved.keys()) {
      if (persistentRows.has(id)) continue;
      delete settings.entries[id];
    }
    const plugins: Row[] = [];
    for (const [id, entry] of Object.entries(settings.entries)) {
      const base = official.get(id);
      const config = entry.config;
      const row: Row = { id };
      if (!entry.name) throw new Error('Profile entry requires a module name: ' + id);
      if (!base || entry.name !== moduleName(base.name!, base.source!)) {
        const original = persistentRows.get(id);
        const local = isAbsolute(entry.name) ? relative(dirname(file), entry.name).split(sep).join('/') : '';
        row.name =
          original?.name &&
          moduleName(original.name, original.source!) === entry.name &&
          original.source === file
            ? original.name
            : local && !isAbsolute(local)
              ? local.startsWith('../')
                ? local
                : './' + local
              : entry.name;
      }
      const disabled = settings.entries[id]?.disabled;
      if (disabled !== undefined && (!base || disabled !== Boolean(base.disabled))) row.disabled = disabled;
      const live = settings.entries[id]?.live;
      if (live !== undefined && live !== base?.live) row.live = live;
      const changed = Object.fromEntries(
        Object.entries(config ?? {}).filter(([key, value]) => !isDeepStrictEqual(value, base?.config?.[key])),
      );
      if (Object.keys(changed).length) row.config = changed;
      if (entry.client !== undefined && entry.client !== base?.client) row.client = entry.client;
      if (Object.keys(row).length > 1) plugins.push(row);
    }
    const next = {
      ...(user.include === undefined ? {} : { include: user.include }),
      ...(user.detached === undefined ? {} : { detached: user.detached }),
      plugins,
      scopes: settings.scopes,
      readOnlyTools: settings.readOnlyTools,
    };
    writeText(file, stringify(next));
    persistent = settings;
    current = runtime;
  }
  const profile: ProfileRuntime = {
    directory,
    builtin,
    source,
    entries,
    async start() {
      const catalog = new PluginCatalog(profile);
      const settings = current;
      const errors = new Map<string, unknown>();
      const plans = catalog.plans(
        settings,
        await catalog.runtimeDescriptors(settings),
        undefined,
        (id, error) => {
          errors.set(id, error);
          return true;
        },
      );
      for (const [id, error] of await entries.update(
        plans.filter(({ descriptor }) => descriptor.plugin).map((plan) => catalog.entry(plan, context)),
      ))
        errors.set(id, error);
      return errors;
    },
    read: () => current,
    commit,
    async close() {
      try {
        await entries.close();
      } finally {
        imports.deregister();
      }
    },
  };
  return profile;
}

import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { lstatSync, realpathSync } from 'node:fs';
import { readJson } from '@mini-harness/platform/json';
import type { PluginInfo, PluginLocation } from '@mini-harness/plugin-api/descriptor';
import { readBrowserAssets, type BrowserAssets } from './browser-assets.ts';
import { loadPluginModule, resolveModule } from './module-resolution.ts';
import { assertPeerCompatibility, isRegularFile } from './source.ts';

import type { PluginMetadata } from '../shared/metadata.ts';

export interface ResolvedPlugin extends Pick<PluginMetadata, 'external' | 'package' | 'error'> {
  id: string;
  info: PluginInfo;
  name?: string;
  scopeAddress?: import('@mini-harness/plugin-api/configuration').ScopeAddress;
  location?: { url: string; exportName?: string };
  native?: Awaited<ReturnType<typeof loadPluginModule>>;
  resources?: BrowserAssets;
}

/** Locate a native module first; then resolve its common metadata, schema and resources. */
export async function describePlugin(
  id: string,
  { folder, entry, exportName, clientOnly: explicitClient }: PluginLocation,
  client: boolean,
  enabled: boolean,
  previous?: ResolvedPlugin,
): Promise<ResolvedPlugin> {
  assertPeerCompatibility(folder);
  const packageFile = join(folder, 'package.json');
  const packageInfo = readJson<{
    name?: string;
    version?: string;
    main?: string;
    exports?: unknown;
    miniHarness?: { plugin?: Partial<PluginInfo> };
  }>(packageFile, {});
  const exports = packageInfo.exports;
  const subpaths =
    exports &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith('.'))
      ? (exports as Record<string, unknown>)
      : undefined;
  const standardClient =
    packageInfo.name && subpaths && Object.hasOwn(subpaths, './client')
      ? relative(
          realpathSync(folder),
          realpathSync(fileURLToPath(resolveModule(packageInfo.name + '/client', packageFile))),
        )
          .split(sep)
          .join('/')
      : undefined;
  const clientOnly = explicitClient || !!(
    entry &&
    standardClient &&
    realpathSync(entry) === realpathSync(join(folder, standardClient))
  );
  let source = clientOnly ? undefined : entry;
  if (
    !clientOnly &&
    !source &&
    packageInfo.name &&
    (exports !== undefined || packageInfo.main !== undefined) &&
    (!subpaths || Object.hasOwn(subpaths, '.'))
  ) {
    const resolved =
      packageInfo.exports !== undefined
        ? fileURLToPath(resolveModule(packageInfo.name, packageFile))
        : createRequire(packageFile).resolve(folder);
    const physical = realpathSync(resolved);
    const location = relative(realpathSync(folder), physical);
    if (
      isAbsolute(location) ||
      location === '..' ||
      location.startsWith('..' + sep) ||
      !isRegularFile(physical)
    )
      throw new Error('Plugin entry must resolve inside its package');
    source = physical;
  } else if (!clientOnly && !source && !standardClient && isRegularFile(join(folder, 'plugin.js'))) {
    source = join(folder, 'plugin.js');
  }
  const descriptor = join(folder, 'plugin.json');
  const manifest = isRegularFile(descriptor)
    ? readJson<Partial<PluginInfo> | null>(descriptor, null)
    : (packageInfo.miniHarness?.plugin ?? {});
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Expected an object in plugin.json');
  // Optional module-specific static metadata uses the same contract as package metadata.
  const sidecar = entry ?? source;
  const staticInfo = {
    ...manifest,
    ...(sidecar ? readJson<Partial<PluginInfo>>(sidecar + '.' + (exportName ?? 'default') + '.plugin.json', {}) : {}),
  };
  if (clientOnly) delete staticInfo.configSchema;
  const location = source
    ? { url: pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs, exportName }
    : undefined;
  const native = !location
    ? undefined
    : enabled
      ? await loadPluginModule(location.url, exportName)
      : previous?.location?.url === location.url && previous.location.exportName === exportName
        ? previous.native
        : undefined;
  const info = { ...staticInfo, ...native?.metadata };
  const browser = info.browser ?? standardClient ?? (isRegularFile(join(folder, 'web.js')) ? 'web.js' : undefined);
  if (browser !== undefined && typeof browser !== 'string') throw new Error('Invalid browser entry');
  if (!source && !browser) throw new Error('Provide a server or browser module');
  const title = typeof info.title === 'string' ? info.title.slice(0, 100) : id;
  const description = typeof info.description === 'string' ? info.description.slice(0, 300) : '';
  if (!browser && (info.browserDirectory !== undefined || info.browserStyles?.length))
    throw new Error('Browser assets require a browser entry');
  const inferredDirectory = browser === standardClient && standardClient && dirname(standardClient) !== '.'
    ? dirname(standardClient) : undefined;
  const resources = client && browser
    ? readBrowserAssets(id, folder, browser, info.browserDirectory ?? inferredDirectory, info.browserStyles)
    : undefined;
  if (enabled && !native?.plugin && !browser)
    throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config) or a browser entry');
  const configSchema = (native?.Config as { jsonSchema?: Record<string, any> } | undefined)?.jsonSchema ?? info.configSchema;
  const { configGroups, configHint } = info;
  if (
    configGroups !== undefined &&
    (!Array.isArray(configGroups) ||
      !configGroups.every(
        (group) =>
          group &&
          typeof group.title === 'string' &&
          Array.isArray(group.fields) &&
          group.fields.every((field) => typeof field === 'string'),
      ))
  )
    throw new Error('Invalid plugin configuration groups: ' + id);
  if (configHint !== undefined && typeof configHint !== 'string')
    throw new Error('Invalid plugin configuration hint: ' + id);
  const icon = info.icon;
  if (
    icon !== undefined &&
    !(
      (typeof icon === 'string' && icon.length > 0 && icon.length <= 128) ||
      (icon !== null &&
        typeof icon === 'object' &&
        !Array.isArray(icon) &&
        typeof icon.path === 'string' &&
        icon.path.length > 0 &&
        icon.path.length <= 8192 &&
        (icon.viewBox === undefined || (typeof icon.viewBox === 'string' && icon.viewBox.length <= 100)))
    )
  )
    throw new Error('Invalid plugin icon: ' + id);
  return {
    id,
    location,
    native,
    resources,
    package: packageInfo.name && packageInfo.version ? { name: packageInfo.name, version: packageInfo.version } : undefined,
    info: { title, description, icon, configGroups, configHint, configSchema },
  };
}

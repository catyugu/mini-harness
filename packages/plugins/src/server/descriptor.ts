import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { readJson } from '@mini-harness/platform/json';
import type { PluginInfo, ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { readBrowserAssets, type BrowserAssets } from './browser-assets.ts';
import { resolveModule } from './module-resolution.ts';
import { assertPeerCompatibility, isRegularFile } from './source.ts';

import type { PluginMetadata } from '../shared/metadata.ts';

export interface DiscoveredPlugin
  extends ResolvedPlugin,
    Pick<PluginMetadata, 'external' | 'package' | 'error'> {
  scopeKey?: import('@mini-harness/plugin-api/scopes').ScopeKey;
  name?: string;
  source?: string;
  module?: string;
  resources?: BrowserAssets;
}

export function describePlugin(id: string, folder: string, entry?: string): DiscoveredPlugin {
  assertPeerCompatibility(folder);
  const packageFile = join(folder, 'package.json');
  const packageInfo = readJson<{
    name?: string;
    version?: string;
    main?: string;
    exports?: unknown;
    miniHarness?: { plugin?: Partial<PluginInfo> & { browserDirectory?: unknown } };
  }>(packageFile, {});
  const exports = packageInfo.exports;
  const subpaths = exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.')) ? exports as Record<string, unknown> : undefined;
  const standardClient = packageInfo.name && subpaths && Object.hasOwn(subpaths, './client')
    ? relative(realpathSync(folder), realpathSync(fileURLToPath(resolveModule(packageInfo.name + '/client', packageFile)))).split(sep).join('/')
    : undefined;
  let source = entry;
  if (!source && packageInfo.name && (exports !== undefined || packageInfo.main !== undefined) && (!subpaths || Object.hasOwn(subpaths, '.'))) {
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
  } else if (!source && !standardClient && isRegularFile(join(folder, 'plugin.js'))) {
    source = join(folder, 'plugin.js');
  }
  const descriptor = join(folder, 'plugin.json');
  const manifest = isRegularFile(descriptor)
    ? readJson<(Partial<PluginInfo> & { browserDirectory?: unknown }) | null>(descriptor, null)
    : (packageInfo.miniHarness?.plugin ?? {});
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Expected an object in plugin.json');
  const browser = standardClient ?? manifest.browser ?? (isRegularFile(join(folder, 'web.js')) ? 'web.js' : undefined);
  if (browser !== undefined && typeof browser !== 'string') throw new Error('Invalid browser entry');
  const hasWeb = browser !== undefined;
  if (!source && !hasWeb) throw new Error('Provide a server or browser module');
  const title = typeof manifest.title === 'string' ? manifest.title.slice(0, 100) : id;
  const description =
    typeof manifest.description === 'string'
      ? manifest.description.slice(0, 300)
      : 'Runs local JavaScript with your user permissions.';
  if (!hasWeb && manifest.browserDirectory !== undefined)
    throw new Error('Browser assets require a browser entry');
  const inferredDirectory = standardClient && dirname(standardClient) !== '.' ? dirname(standardClient) : undefined;
  const browserDirectory = manifest.browserDirectory ?? inferredDirectory;
  if (source && browser) {
    const location = relative(realpathSync(folder), realpathSync(source)).split(sep).join('/');
    if (location === browser || (typeof browserDirectory === 'string' && location.startsWith(browserDirectory.replace(/\/$/, '') + '/')))
      throw new Error('Server entry cannot be inside the public browser asset directory');
  }
  const resources =
    browser !== undefined ? readBrowserAssets(id, folder, browser, browserDirectory) : undefined;
  const { configGroups, configHint } = manifest;
  if (
    configGroups !== undefined &&
    (!Array.isArray(configGroups) ||
      !configGroups.every(
        (group) =>
          group &&
          typeof group.title === 'string' &&
          Array.isArray(group.fields) &&
          group.fields.every(
            (field) => typeof field === 'string',
          ),
      ))
  )
    throw new Error('Invalid plugin configuration groups: ' + id);
  if (configHint !== undefined && typeof configHint !== 'string')
    throw new Error('Invalid plugin configuration hint: ' + id);
  const icon = manifest.icon;
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
    source,
    resources,
    package:
      packageInfo.name && packageInfo.version
        ? { name: packageInfo.name, version: packageInfo.version }
        : undefined,
    id,
    title,
    description,
    configGroups,
    configHint,
    icon,
    web: hasWeb,
    external: true,
  };
}

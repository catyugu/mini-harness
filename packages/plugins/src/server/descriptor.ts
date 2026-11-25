import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '@mini-harness/platform/json';
import type { PluginInfo, ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { readBrowserAssets, type BrowserAssets } from './browser-assets.ts';
import { assertPeerCompatibility, isRegularFile } from './source.ts';

import type { PluginMetadata } from '../shared/metadata.ts';

export interface DiscoveredPlugin
  extends ResolvedPlugin,
    Pick<PluginMetadata, 'trustedCode' | 'package' | 'error'> {
  source?: string;
  module?: string;
  resources?: BrowserAssets;
}

export function describePlugin(id: string, folder: string): DiscoveredPlugin {
  assertPeerCompatibility(folder);
  const source = join(folder, 'plugin.js');
  const hasHost = isRegularFile(source);
  const hasWeb = isRegularFile(join(folder, 'web.js'));
  if (!hasHost && !hasWeb) throw new Error('Provide plugin.js, web.js or both');
  if (hasWeb && lstatSync(join(folder, 'web.js')).size > 1024 * 1024)
    throw new Error('Plugin browser entry exceeds 1 MiB');
  const descriptor = join(folder, 'plugin.json');
  const manifest = isRegularFile(descriptor)
    ? readJson<(Partial<PluginInfo> & { browserAssets?: unknown; browserPreload?: unknown }) | null>(
        descriptor,
        null,
      )
    : null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Expected an object in plugin.json');
  const title = typeof manifest.title === 'string' ? manifest.title.slice(0, 100) : id;
  const description =
    typeof manifest.description === 'string'
      ? manifest.description.slice(0, 300)
      : 'Runs local JavaScript with your user permissions.';
  const scope = manifest.scope ?? 'application';
  if (scope !== 'application' && scope !== 'workspace' && scope !== 'session')
    throw new Error('Invalid plugin scope');
  if (scope !== 'application' && hasWeb)
    throw new Error('Browser entries belong to the application scope');
  if (!hasWeb && (manifest.browserAssets !== undefined || manifest.browserPreload !== undefined))
    throw new Error('Browser assets require web.js');
  const resources = hasWeb
    ? readBrowserAssets(id, folder, manifest.browserAssets, manifest.browserPreload)
    : undefined;
  if (manifest.configChanges !== undefined && manifest.configChanges !== 'live')
    throw new Error('Invalid plugin configChanges: ' + id);
  const configSchema = manifest.configSchema;
  if (
    configSchema &&
    (configSchema.type !== 'object' ||
      !configSchema.properties ||
      typeof configSchema.properties !== 'object')
  )
    throw new Error('Expected an object configSchema for plugin: ' + id);
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
            (field) => typeof field === 'string' && Object.hasOwn(configSchema?.properties ?? {}, field),
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
    source: hasHost ? source : undefined,
    resources,
    scope,
    id,
    title,
    description,
    configSchema,
    configGroups,
    configHint,
    configChanges: manifest.configChanges,
    icon,
    web: hasWeb,
    trustedCode: true,
  };
}

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '@mini-harness/platform/json';
import { pluginIdPattern, serviceNamePattern, type PluginDescriptor } from '@mini-harness/contracts/plugins';
import { readBrowserAssets } from './browser-assets.js';
import { isRegularFile } from './source.js';

export interface DiscoveredPlugin extends PluginDescriptor {
  source?: string;
  resources?: ReturnType<typeof readBrowserAssets>;
}

export function describePlugin(id: string, folder: string): DiscoveredPlugin {
  const source = join(folder, 'plugin.js');
  const hasHost = isRegularFile(source);
  const hasWeb = isRegularFile(join(folder, 'web.js'));
  if (!hasHost && !hasWeb) throw new Error('Provide plugin.js, web.js or both');
  if (hasWeb && lstatSync(join(folder, 'web.js')).size > 1024 * 1024) throw new Error('Plugin browser entry exceeds 1 MiB');
  const descriptor = join(folder, 'plugin.json');
  const manifest = isRegularFile(descriptor) ? readJson<(Partial<PluginDescriptor> & { browserAssets?: unknown; browserPreload?: unknown }) | null>(descriptor, null) : null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Expected an object in plugin.json');
  const title = typeof manifest.title === 'string' ? manifest.title.slice(0, 100) : id;
  const description = typeof manifest.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
  const scope = manifest.scope ?? 'application';
  if (scope !== 'application' && scope !== 'workspace' && scope !== 'session') throw new Error('Invalid plugin scope');
  const names = (field: 'requires' | 'inject' | 'optional' | 'provides' | 'browserRequires' | 'browserInject' | 'browserProvides', pattern: RegExp) => {
    const input = manifest[field] ?? [];
    if (!Array.isArray(input) || input.some((name) => typeof name !== 'string' || !pattern.test(name)) ||
        new Set(input).size !== input.length) throw new Error('Invalid plugin ' + field + ': ' + id);
    return input;
  };
  const requires = names('requires', pluginIdPattern);
  const provides = names('provides', serviceNamePattern);
  const inject = names('inject', serviceNamePattern);
  const optional = names('optional', serviceNamePattern);
  const browserRequires = names('browserRequires', pluginIdPattern);
  const browserInject = names('browserInject', serviceNamePattern);
  const browserProvides = names('browserProvides', serviceNamePattern);
  if (!hasWeb && (browserRequires.length || browserInject.length || browserProvides.length))
    throw new Error('Browser dependencies require web.js');
  if (!hasHost && (provides.length || inject.length || optional.length)) throw new Error('Server services require plugin.js');
  if (scope !== 'application' && (hasWeb || [...inject, ...optional].some((name) => name === 'harnessRoutes' || name === 'harnessNetwork'))) throw new Error('Scoped plugins require a server entry without routes');
  if (inject.some((service) => optional.includes(service) || provides.includes(service))) throw new Error('Conflicting service declarations');
  if (!hasWeb && (manifest.browserAssets !== undefined || manifest.browserPreload !== undefined))
    throw new Error('Browser assets require web.js');
  const resources = hasWeb ? readBrowserAssets(id, folder, manifest.browserAssets, manifest.browserPreload) : undefined;
  if (manifest.configChanges !== undefined && manifest.configChanges !== 'live')
    throw new Error('Invalid plugin configChanges: ' + id);
  const configSchema = manifest.configSchema;
  if (configSchema && (configSchema.type !== 'object' || !configSchema.properties || typeof configSchema.properties !== 'object'))
    throw new Error('Expected an object configSchema for plugin: ' + id);
  const icon = manifest.icon;
  if (icon !== undefined && !(
    typeof icon === 'string' && icon.length > 0 && icon.length <= 128 ||
    icon !== null && typeof icon === 'object' && !Array.isArray(icon) &&
    typeof icon.path === 'string' && icon.path.length > 0 && icon.path.length <= 8192 &&
    (icon.viewBox === undefined || typeof icon.viewBox === 'string' && icon.viewBox.length <= 100)
  )) throw new Error('Invalid plugin icon: ' + id);
  return { source: hasHost ? source : undefined, resources, scope, id, title, description,
    requires, provides, inject, optional, browserRequires, browserInject, browserProvides, configSchema, configChanges: manifest.configChanges, icon, web: hasWeb, trustedCode: true };
}

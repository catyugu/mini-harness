import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { Settings } from '@mini-harness/settings/settings';
import { writeJson } from '@mini-harness/platform/json';
import { describePlugin } from './descriptor.js';
import { assertDisabled } from './files.js';
import { installRegistryPackage } from './registry-client.js';
import { generationPattern, packageBundle, packageMarker, packageSource, packageSpecPattern } from './source.js';

/** CLI holds the instance lock for all inspection, installation and publication. */
export async function installPackagedPlugin(paths: Paths, operation: 'install' | 'update', id: string, requested: string | undefined, options: { settings: Settings; reserved(id: string): boolean; signal?: AbortSignal }) {
  const { settings, reserved, signal } = options;
  if (!localPluginIdPattern.test(id) || reserved(id)) throw new Error('Invalid plugin ID');
  const target = join(paths.plugins, id);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (operation === 'install' && existing) throw new Error('Plugin already exists: ' + id);
  const previous = existing?.isDirectory() ? packageSource(target) : undefined;
  if (operation === 'update' && !previous) throw new Error('Unknown packaged plugin: ' + id);
  // A stale enabled selection can also refer to a directory the user removed manually.
  assertDisabled(settings, id);
  const spec = requested ?? previous?.spec;
  const name = typeof spec === 'string' && packageSpecPattern.exec(spec)?.[1];
  if (!name) throw new Error('Expected an npm package name with an optional version or tag');
  const originalName = previous && packageSpecPattern.exec(previous.spec)?.[1];
  if (previous && (!originalName || originalName !== name))
    throw new Error('Update must use the installed package name: ' + (originalName ?? previous.spec));

  const generation = randomUUID();
  const directory = join(target, generation);
  // Stage inside the permanent directory so installation paths remain stable across platforms.
  if (operation === 'install') mkdirSync(target, { mode: 0o700 });
  let installedPackage: ReturnType<typeof packageBundle>['package'];
  try {
    writeJson(join(directory, 'package.json'), { name: 'mini-harness-plugin-install', private: true });
    await installRegistryPackage(directory, spec, signal);
    signal?.throwIfAborted();
    const bundle = packageBundle(directory, spec);
    describePlugin(id, bundle.folder);
    installedPackage = bundle.package;
    writeJson(join(target, packageMarker), { spec, generation });
  } catch (error) {
    rmSync(operation === 'install' ? target : directory, { recursive: true, force: true });
    throw error;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== generation && generationPattern.test(entry.name))
      rmSync(join(target, entry.name), { recursive: true, force: true });
  }
  return installedPackage;
}

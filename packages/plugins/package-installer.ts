import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Paths } from '@mini-harness/contracts/config';
import { readSettings, writeJson } from '@mini-harness/platform/config';
import { describePlugin } from './descriptor.js';
import { assertDisabled } from './files.js';
import { generationPattern, packageBundle, packageMarker, packageSource, packageSpecPattern, pluginIdPattern } from './source.js';

function installPackage(cwd: string, spec: string) {
  const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.cjs');
  const args = ['add', '--save-prod', '--save-exact', '--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace',
    '--config.node-linker=isolated', '--config.lockfile=true', '--', spec];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('pnpm plugin installation failed')));
  });
}

/** CLI holds the instance lock for all inspection, installation and publication. */
export async function installPackagedPlugin(paths: Paths, operation: 'install' | 'update', id: string, requested: string | undefined, reserved: (id: string) => boolean) {
  if (!pluginIdPattern.test(id) || reserved(id)) throw new Error('Invalid plugin ID');
  const target = join(paths.plugins, id);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (operation === 'install' && existing) throw new Error('Plugin already exists: ' + id);
  const previous = existing?.isDirectory() ? packageSource(target) : undefined;
  if (operation === 'update' && !previous) throw new Error('Unknown packaged plugin: ' + id);
  // A stale enabled selection can also refer to a directory the user removed manually.
  assertDisabled(readSettings(paths), id);
  const spec = requested ?? previous?.spec;
  const name = typeof spec === 'string' && packageSpecPattern.exec(spec)?.[1];
  if (!name) throw new Error('Expected an npm package name with an optional version or tag');
  if (previous && packageSpecPattern.exec(previous.spec)[1] !== name)
    throw new Error('Update must use the installed package name: ' + packageSpecPattern.exec(previous.spec)[1]);

  const staging = mkdtempSync(join(paths.plugins, '.package-'));
  const generation = randomUUID();
  const directory = join(staging, generation);
  try {
    writeJson(join(directory, 'package.json'), { name: 'mini-harness-plugin-install', private: true });
    await installPackage(directory, spec);
    const { folder, package: installedPackage } = packageBundle(directory, spec);
    describePlugin(id, folder);
    const source = { spec, generation };
    if (operation === 'install') {
      writeJson(join(staging, packageMarker), source);
      renameSync(staging, target);
    } else {
      const installed = join(target, generation);
      renameSync(directory, installed);
      try { writeJson(join(target, packageMarker), source); }
      catch (error) { rmSync(installed, { recursive: true, force: true }); throw error; }
      // A generation is private staging storage. Remove every former generation after publishing.
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== generation && generationPattern.test(entry.name))
          rmSync(join(target, entry.name), { recursive: true, force: true });
      }
    }
    return installedPackage;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

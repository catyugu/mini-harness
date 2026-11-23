import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Paths } from '../contracts/config.js';
import { readSettings, writeJson } from '../platform/config.js';
import { describePlugin } from './catalog.js';
import { assertDisabled } from './files.js';
import { generationPattern, npmBundle, npmMarker, npmSource, packageSpecPattern, pluginIdPattern } from './source.js';

function installPackage(cwd: string, spec: string) {
  const npmCli = basename(process.env.npm_execpath ?? '') === 'npm-cli.js' ? process.env.npm_execpath : undefined;
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--global=false', '--workspaces=false', '--', spec];
  const windows = process.platform === 'win32';
  return new Promise<void>((resolve, reject) => {
    // Windows npm.cmd needs a shell. The package spec has already been restricted to registry names and tags/versions.
    const child = npmCli ? spawn(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' }) :
      windows ? spawn('npm.cmd ' + args.join(' '), { cwd, shell: true, stdio: 'inherit' }) :
        spawn('npm', args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('npm install failed')));
  });
}

/** CLI holds the instance lock for all inspection, installation and publication. */
export async function installNpmPlugin(paths: Paths, operation: 'install' | 'update', id: string, requested: string | undefined, reserved: (id: string) => boolean) {
  if (!pluginIdPattern.test(id) || reserved(id)) throw new Error('Invalid plugin ID');
  const target = join(paths.plugins, id);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (operation === 'install' && existing) throw new Error('Plugin already exists: ' + id);
  const previous = existing?.isDirectory() ? npmSource(target) : undefined;
  if (operation === 'update' && !previous) throw new Error('Unknown npm plugin: ' + id);
  // A stale enabled selection can also refer to a directory the user removed manually.
  assertDisabled(readSettings(paths), id);
  const spec = requested ?? previous?.spec;
  const name = typeof spec === 'string' && packageSpecPattern.exec(spec)?.[1];
  if (!name) throw new Error('Expected an npm package name with an optional version or tag');
  if (previous && packageSpecPattern.exec(previous.spec)[1] !== name)
    throw new Error('Update must use the installed package name: ' + packageSpecPattern.exec(previous.spec)[1]);

  const staging = mkdtempSync(join(paths.plugins, '.npm-'));
  const generation = randomUUID();
  const directory = join(staging, generation);
  try {
    writeJson(join(directory, 'package.json'), { name: 'mini-harness-plugin-install', private: true });
    await installPackage(directory, spec);
    const { folder, npm } = npmBundle(directory, spec);
    describePlugin(id, folder);
    const source = { spec, generation };
    if (operation === 'install') {
      writeJson(join(staging, npmMarker), source);
      renameSync(staging, target);
    } else {
      const installed = join(target, generation);
      renameSync(directory, installed);
      try { writeJson(join(target, npmMarker), source); }
      catch (error) { rmSync(installed, { recursive: true, force: true }); throw error; }
      // A generation is private staging storage. Remove every former generation after publishing.
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== generation && generationPattern.test(entry.name))
          rmSync(join(target, entry.name), { recursive: true, force: true });
      }
    }
    return npm;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

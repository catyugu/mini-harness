import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies, validRange } from 'semver';
import { readJson } from '@mini-harness/platform/json';

export const packageSpecPattern = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/;
export const packageMarker = '.package-source.json';
export const generationPattern = /^[a-f0-9-]{36}$/;

export function isRegularFile(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export interface PackageSource { spec: string; generation: string }

export function packageSource(folder: string): PackageSource | undefined {
  const marker = join(folder, packageMarker);
  if (!lstatSync(marker, { throwIfNoEntry: false })) return;
  if (!isRegularFile(marker)) throw new Error('Invalid plugin package source file');
  const source = readJson<PackageSource | null>(marker, null);
  if (!source || typeof source.spec !== 'string' || !packageSpecPattern.test(source.spec) ||
      typeof source.generation !== 'string' || !generationPattern.test(source.generation))
    throw new Error('Invalid plugin package source');
  return source;
}

export function assertPeerCompatibility(folder: string) {
  const path = join(folder, 'package.json');
  if (!isRegularFile(path)) return;
  const manifest = readJson<{ peerDependencies?: { 'mini-harness'?: unknown } }>(path, {});
  const range = manifest?.peerDependencies?.['mini-harness'];
  if (range === undefined) return;
  if (typeof range !== 'string' || !validRange(range)) throw new Error('Invalid mini-harness peer dependency range');
  const version = readJson<{ version: string }>(fileURLToPath(new URL('../../../../../package.json', import.meta.url)), { version: '' }).version;
  if (!satisfies(version, range)) throw new Error('Plugin requires mini-harness ' + range + ' (running ' + version + ')');
}

export function packageBundle(directory: string, spec: string) {
  const name = packageSpecPattern.exec(spec)?.[1];
  if (!name) throw new Error('Expected an npm package name with an optional version or tag');
  if (!lstatSync(directory).isDirectory()) throw new Error('Plugin installation directory must be local');
  const root = realpathSync(directory);
  const folder = realpathSync(join(root, 'node_modules', ...name.split('/')));
  const location = relative(root, folder);
  if (!location || location === '..' || location.startsWith('..' + sep) || isAbsolute(location))
    throw new Error('Plugin package resolves outside its installation directory');
  if (!isRegularFile(join(root, 'package-lock.json'))) throw new Error('Missing plugin dependency lockfile');
  const manifestPath = join(folder, 'package.json');
  if (!isRegularFile(manifestPath)) throw new Error('Missing plugin package.json');
  const manifest = readJson<{ name?: string; version?: string; type?: string }>(manifestPath, {});
  const install = readJson<{ dependencies?: Record<string, string> }>(join(root, 'package.json'), {});
  if (manifest?.name !== name || typeof manifest.version !== 'string' || install.dependencies?.[name] !== manifest.version)
    throw new Error('Plugin package identity does not match ' + name);
  if (isRegularFile(join(folder, 'plugin.js')) && manifest.type !== 'module')
    throw new Error('Server npm plugins must declare "type": "module"');
  return { folder, package: { name, version: manifest.version } };
}

export function pluginBundle(folder: string) {
  const source = packageSource(folder);
  return source ? packageBundle(join(folder, source.generation), source.spec) : { folder, package: undefined };
}

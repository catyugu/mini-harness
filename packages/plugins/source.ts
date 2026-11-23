import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../platform/config.js';

export const pluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
export const packageSpecPattern = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/;
export const npmMarker = '.npm-plugin.json';
export const generationPattern = /^[a-f0-9-]{36}$/;

export function isRegularFile(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export interface NpmSource { spec: string; generation: string }

export function npmSource(folder: string): NpmSource | undefined {
  const marker = join(folder, npmMarker);
  if (!lstatSync(marker, { throwIfNoEntry: false })) return;
  if (!isRegularFile(marker)) throw new Error('Invalid npm plugin source file');
  const source = readJson<NpmSource>(marker, null);
  if (!source || typeof source.spec !== 'string' || !packageSpecPattern.test(source.spec) ||
      typeof source.generation !== 'string' || !generationPattern.test(source.generation))
    throw new Error('Invalid npm plugin source');
  return source;
}

export function npmBundle(directory: string, spec: string) {
  const name = packageSpecPattern.exec(spec)?.[1];
  if (!name) throw new Error('Expected an npm package name with an optional version or tag');
  const root = [directory, 'node_modules', ...name.split('/')];
  for (let length = 1; length <= root.length; length++) {
    if (!lstatSync(join(...root.slice(0, length)), { throwIfNoEntry: false })?.isDirectory())
      throw new Error('npm did not install the requested package: ' + name);
  }
  const folder = join(...root);
  const manifestPath = join(folder, 'package.json');
  if (!isRegularFile(manifestPath)) throw new Error('Missing npm plugin package.json');
  const manifest = readJson<{ name?: string; version?: string; type?: string }>(manifestPath, {});
  if (manifest?.name !== name || typeof manifest.version !== 'string')
    throw new Error('npm plugin package identity does not match ' + name);
  if (isRegularFile(join(folder, 'plugin.js')) && manifest.type !== 'module')
    throw new Error('Server npm plugins must declare "type": "module"');
  return { folder, npm: { name, version: manifest.version } };
}

export function pluginBundle(folder: string) {
  const source = npmSource(folder);
  return source ? npmBundle(join(folder, source.generation), source.spec) : { folder, npm: undefined };
}

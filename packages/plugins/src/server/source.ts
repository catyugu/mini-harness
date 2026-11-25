import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies, validRange } from 'semver';
import { readJson } from '@mini-harness/platform/json';

export function isRegularFile(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function assertPeerCompatibility(folder: string) {
  const path = join(folder, 'package.json');
  if (!isRegularFile(path)) return;
  const manifest = readJson<{ peerDependencies?: { 'mini-harness'?: unknown } }>(path, {});
  const range = manifest?.peerDependencies?.['mini-harness'];
  if (range === undefined) return;
  if (typeof range !== 'string' || !validRange(range))
    throw new Error('Invalid mini-harness peer dependency range');
  const version = readJson<{ version: string }>(
    fileURLToPath(new URL('../../../../../package.json', import.meta.url)),
    { version: '' },
  ).version;
  if (!satisfies(version, range))
    throw new Error('Plugin requires mini-harness ' + range + ' (running ' + version + ')');
}


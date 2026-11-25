import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Service } from 'mini-harness/cordis';
import { pluginEntryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { entryAddress } from './entry-address.ts';
import { protectLocal } from '@mini-harness/platform/local-secret';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';
import type { PluginData, PluginSecrets } from '@mini-harness/plugin-api/services';

function storagePath(service: object, directory: string, name: string, secret = false) {
  const ctx = Service.caller(service);
  const { id, scope } = entryAddress(pluginEntryFiber(ctx).entry!.options.id);
  ctx.fiber.signal.throwIfAborted();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid private data name');
  const instance = scope ? createHash('sha256').update(scope).digest('hex') : 'application';
  const root = join(directory, id, instance);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, (secret ? '.' : '') + name + '.json');
  if (secret) {
    if (relative(root, realpathSync(root))) throw new Error('Plugin data directory was redirected');
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (
      entry &&
      (!entry.isFile() ||
        entry.nlink !== 1 ||
        (process.platform !== 'win32' && (entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0)))
    )
      throw new Error('Invalid protected plugin data file');
  }
  return file;
}

export function pluginData(directory: string): PluginData {
  return Service.track({
    read(name, fallback) {
      return readJson(storagePath(this, directory, name), fallback);
    },
    write(name, value) {
      writeJson(storagePath(this, directory, name), value);
    },
    remove(name) {
      rmSync(storagePath(this, directory, name), { force: true });
    },
  });
}

export function pluginSecrets(directory: string): PluginSecrets {
  const windows = process.platform === 'win32';
  return Service.track({
    read(name) {
      const value = readJson<unknown>(storagePath(this, directory, name, true), undefined);
      if (value === undefined) return;
      if (typeof value !== 'string') throw new Error('Invalid protected plugin data');
      return windows ? protectLocal('Unprotect', Buffer.from(value, 'base64')).toString('utf8') : value;
    },
    write(name, value) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 16384)
        throw new Error('Invalid protected plugin data');
      writeJson(
        storagePath(this, directory, name, true),
        windows ? protectLocal('Protect', Buffer.from(value)).toString('base64') : value,
      );
    },
    remove(name) {
      rmSync(storagePath(this, directory, name, true), { force: true });
    },
  });
}

export function removeScopeData(root: string, keys: ReadonlySet<ScopeAddress>) {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory() || relative(root, realpathSync(root)))
    throw new Error('Plugin data directory has been redirected');
  const instances = [...keys].map((key) => createHash('sha256').update(key).digest('hex'));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const instance of instances)
      rmSync(join(root, entry.name, instance), { recursive: true, force: true });
  }
}

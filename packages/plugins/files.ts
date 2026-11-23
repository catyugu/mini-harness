import { mkdirSync, renameSync, rmSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from '#mini-harness/platform/config.js';
import type { Settings } from '#mini-harness/contracts/config.js';
import { isRegularFile, pluginBundle, pluginIdPattern } from './source.js';
import type { PluginMetadata } from '#mini-harness/contracts/plugins.js';

type PluginFilesHost = {
  paths: { plugins: string };
  settings: Pick<Settings, 'plugins' | 'scopes' | 'providers'>;
  plugins: { metadata(): PluginMetadata[]; reserved(id: string): boolean };
};
export function installPlugin(runtime: PluginFilesHost, input: any) {
  if (!input || !pluginIdPattern.test(input.id) || (runtime.plugins.reserved(input.id) || runtime.plugins.metadata().some(({ id }) => id === input.id))) throw new Error('Invalid or existing plugin ID');
  if (!Array.isArray(input.files) || input.files.length > 3 || !input.files.some((f: { name?: unknown }) => f.name === 'plugin.js' || f.name === 'web.js')) throw new Error('Provide plugin.js, web.js or both');
  const seen = new Set(); let size = 0;
  for (const file of input.files) {
    if (!['plugin.js', 'plugin.json', 'web.js'].includes(file.name) || seen.has(file.name) || typeof file.content !== 'string') throw new Error('Invalid plugin file');
    seen.add(file.name); size += Buffer.byteLength(file.content);
  }
  if (size > 1024 * 1024) throw new Error('Plugin bundle exceeds 1 MiB');
  const manifest = input.files.find((file: { name?: unknown }) => file.name === 'plugin.json');
  if (!manifest) throw new Error('Include plugin.json');
  const descriptor = JSON.parse(manifest.content);
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('Expected an object in plugin.json');
  const temp = join(runtime.paths.plugins, '.' + randomUUID()); mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of input.files) {
      // writeJson provides atomic private writes; JS uses the same private file mode.
      const path = join(temp, file.name);
      if (file.name === 'plugin.json') writeJson(path, descriptor);
      else writeFileSync(path, file.content, { mode: 0o600 });
    }
    renameSync(temp, join(runtime.paths.plugins, input.id));
  } finally { rmSync(temp, { recursive: true, force: true }); }
  try {
    const metadata = runtime.plugins.metadata();
    const installed = metadata.find((plugin) => plugin.id === input.id);
    if (installed?.error) throw new Error('Invalid plugin manifest: ' + installed.error);
    return metadata;
  }
  catch (error) { rmSync(join(runtime.paths.plugins, input.id), { recursive: true, force: true }); throw error; }
}
export async function uninstallPlugin(runtime: PluginFilesHost, id: string) {
  const plugin = runtime.plugins.metadata().find((item) => item.id === id && item.trustedCode);
  if (!plugin || !pluginIdPattern.test(id)) throw new Error('Unknown local plugin');
  assertDisabled(runtime.settings, id);
  const folder = join(runtime.paths.plugins, id);
  if (lstatSync(folder).isSymbolicLink()) throw new Error('Linked plugins must be removed locally');
  rmSync(folder, { recursive: true });
  return runtime.plugins.metadata();
}
export function assertDisabled(settings: PluginFilesHost['settings'], id: string) {
  if (settings.plugins[id] === true || Object.values(settings.scopes).some((scope) =>
    scope.plugins?.[id] === true || Object.values(scope.providers ?? {}).includes(id)) ||
      Object.values(settings.providers).includes(id)) throw new Error('Disable and save this plugin before changing its files');
}
export function frontendSource(runtime: PluginFilesHost, id: string) {
  if (!pluginIdPattern.test(id) || !runtime.plugins.metadata().some((p) => p.id === id && p.web && p.state === 'ready')) throw new Error('Plugin UI is unavailable');
  const folder = join(runtime.paths.plugins, id);
  if (!lstatSync(folder).isDirectory()) throw new Error('Invalid plugin folder');
  const path = join(pluginBundle(folder).folder, 'web.js');
  if (!isRegularFile(path) || lstatSync(path).size > 1024 * 1024) throw new Error('Invalid plugin UI file');
  return readFileSync(path, 'utf8');
}

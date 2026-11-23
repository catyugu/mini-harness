import { mkdirSync, renameSync, rmSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from '../platform/config.js';
import type { PluginMetadata } from '../contracts/plugins.js';

type PluginFilesHost = {
  paths: { plugins: string };
  settings: { plugins: Record<string, boolean> };
  plugins: { metadata(): PluginMetadata[]; reserved(id: string): boolean };
};
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
export function installPlugin(runtime: PluginFilesHost, input: any) {
  if (!input || !idPattern.test(input.id) || (runtime.plugins.reserved(input.id) || runtime.plugins.metadata().some(({ id }) => id === input.id))) throw new Error('Invalid or existing plugin ID');
  if (!Array.isArray(input.files) || input.files.length > 3 || !input.files.some((f) => f.name === 'plugin.js' || f.name === 'web.js')) throw new Error('Provide plugin.js, web.js or both, optionally with plugin.json');
  const seen = new Set(); let size = 0;
  for (const file of input.files) {
    if (!['plugin.js', 'plugin.json', 'web.js'].includes(file.name) || seen.has(file.name) || typeof file.content !== 'string') throw new Error('Invalid plugin file');
    seen.add(file.name); size += Buffer.byteLength(file.content);
  }
  if (size > 1024 * 1024) throw new Error('Plugin bundle exceeds 1 MiB');
  const manifest = input.files.find((file) => file.name === 'plugin.json');
  if (manifest) { const data = JSON.parse(manifest.content); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid manifest'); }
  const temp = join(runtime.paths.plugins, '.' + randomUUID()); mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of input.files) {
      // writeJson provides atomic private writes; JS uses the same private file mode.
      const path = join(temp, file.name);
      if (file.name === 'plugin.json') writeJson(path, JSON.parse(file.content));
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
  if (!plugin || !idPattern.test(id)) throw new Error('Unknown local plugin');
  if (runtime.settings.plugins[id]) throw new Error('Disable and save this plugin before uninstalling');
  const folder = join(runtime.paths.plugins, id);
  if (lstatSync(folder).isSymbolicLink()) throw new Error('Linked plugins must be removed locally');
  rmSync(folder, { recursive: true });
  return runtime.plugins.metadata();
}
export function frontendSource(runtime: PluginFilesHost, id: string) {
  if (!idPattern.test(id) || !runtime.settings.plugins[id] || !runtime.plugins.metadata().some((p) => p.id === id && p.web)) throw new Error('Plugin UI is unavailable');
  const folder = join(runtime.paths.plugins, id), file = join(folder, 'web.js');
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 1024 * 1024)
    throw new Error('Invalid plugin UI file');
  return readFileSync(file, 'utf8');
}

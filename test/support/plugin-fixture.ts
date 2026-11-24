import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const pluginSdkUrl = import.meta.resolve('mini-harness/plugin');

export function writePlugin(directory: string, id: string, descriptor: object, source: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(descriptor));
  writeFileSync(join(folder, 'plugin.js'),
    'import { agentExtensions, promptExtensions, sessionDisplayExtensions, sessionExtensions, toolExtensions } from ' + JSON.stringify(pluginSdkUrl) + ';\n' + source);
  return folder;
}

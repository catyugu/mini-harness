import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sdk = new URL('../../packages/sdk/plugin.js', import.meta.url).href;

export function writePlugin(directory: string, id: string, descriptor: object, source: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(descriptor));
  writeFileSync(join(folder, 'plugin.js'),
    'import { agentExtensions, promptExtensions, sessionExtensions, toolExtensions } from ' + JSON.stringify(sdk) + ';\n' + source);
  return folder;
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writePlugin(directory: string, id: string, descriptor: object, source: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(descriptor));
  writeFileSync(join(folder, 'plugin.js'), source);
  return folder;
}

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

// Use the same native resolver as fs/promises.realpath, including Windows long path names.
export const canonicalWorkspacePath = realpathSync.native;

export function workspaceId(path: string) {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

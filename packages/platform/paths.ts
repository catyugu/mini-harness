import { relative, isAbsolute, sep } from 'node:path';

export function containsPath(root: string, candidate: string) {
  const name = relative(root, candidate);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
}


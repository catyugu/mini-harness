import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Paths } from '@mini-harness/contracts/config';
import type { SessionRecord } from '@mini-harness/contracts/conversation';
import type { WorkspacePort } from '@mini-harness/contracts/services';
import { getPaths } from '@mini-harness/platform/config';

export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function sessionDirectory(paths: Paths, workspaces: WorkspacePort, workspaceId: string) {
  const expected = getPaths(workspaces.get(workspaceId).path, { MINI_HARNESS_HOME: paths.home }).sessions;
  mkdirSync(expected, { recursive: true, mode: 0o700 });
  const physical = join(realpathSync(paths.home), 'sessions', basename(expected));
  if (relative(physical, realpathSync(expected)) || lstatSync(dirname(expected)).isSymbolicLink() ||
      lstatSync(expected).isSymbolicLink()) throw new Error('Session directory outside managed storage');
  return expected;
}

/** Never follows a user-controlled session symlink or an aliased hardlink. */
export function checkedStoredFile(paths: Paths, workspaces: WorkspacePort, workspaceId: string, candidate: string) {
  const expected = sessionDirectory(paths, workspaces, workspaceId);
  const file = resolve(candidate);
  if (!isAbsolute(candidate) || relative(expected, dirname(file)) || !/^[a-z0-9_.-]+\.jsonl$/i.test(basename(file)))
    throw new Error('Session file outside managed storage');
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        relative(join(realpathSync(expected), basename(file)), realpathSync(file)))
      throw new Error('Session file outside managed storage');
  } catch (error) { if (!missing(error)) throw error; }
  return file;
}

export function nativeFile(paths: Paths, workspaces: WorkspacePort, record: Pick<SessionRecord, 'id' | 'workspaceId'>) {
  if (!/^[a-f0-9-]{36}$/i.test(record.id)) throw new Error('Invalid conversation ID');
  return checkedStoredFile(paths, workspaces, record.workspaceId,
    join(sessionDirectory(paths, workspaces, record.workspaceId), record.id + '.jsonl'));
}

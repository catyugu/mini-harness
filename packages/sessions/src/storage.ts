import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { SessionRecord } from './shared/identity.js';
import type { WorkspacePort } from '@mini-harness/workspaces/api';
import { getPaths } from '@mini-harness/platform/paths';

export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function sessionDirectory(
  paths: Paths,
  workspaces: WorkspacePort,
  workspaceId: string,
  create = true,
) {
  const expected = getPaths(workspaces.get(workspaceId).path, { MINI_HARNESS_HOME: paths.home }).sessions;
  if (create) mkdirSync(expected, { recursive: true, mode: 0o700 });
  const physical = join(realpathSync(paths.home), 'sessions', basename(expected));
  if (
    relative(physical, realpathSync(expected)) ||
    lstatSync(dirname(expected)).isSymbolicLink() ||
    lstatSync(expected).isSymbolicLink()
  )
    throw new Error('Session directory outside managed storage');
  return expected;
}

/** Never follows a user-controlled session symlink or an aliased hardlink. */
export function checkedStoredFile(
  paths: Paths,
  workspaces: WorkspacePort,
  workspaceId: string,
  candidate: string,
  create = true,
) {
  const expected = sessionDirectory(paths, workspaces, workspaceId, create);
  const file = resolve(candidate);
  if (
    !isAbsolute(candidate) ||
    relative(expected, dirname(file)) ||
    !/^[a-z0-9_.-]+\.jsonl$/i.test(basename(file))
  )
    throw new Error('Session file outside managed storage');
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      relative(join(realpathSync(expected), basename(file)), realpathSync(file))
    )
      throw new Error('Session file outside managed storage');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return file;
}

export function nativeFile(
  paths: Paths,
  workspaces: WorkspacePort,
  record: Pick<SessionRecord, 'id' | 'workspaceId'>,
  create = true,
) {
  if (!/^[a-f0-9-]{36}$/i.test(record.id)) throw new Error('Invalid conversation ID');
  return checkedStoredFile(
    paths,
    workspaces,
    record.workspaceId,
    join(sessionDirectory(paths, workspaces, record.workspaceId, create), record.id + '.jsonl'),
    create,
  );
}

/** A native conversation owns this directory next to its JSONL log. */
function ownedDirectory(path: string, create: boolean): string | undefined {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      relative(join(realpathSync(dirname(path)), basename(path)), realpathSync(path))
    )
      throw new Error('Attachment directory outside managed storage');
    return path;
  } catch (error) {
    if (missing(error) && !create) return;
    throw error;
  }
}

export function attachmentDirectory(file: string, create = false) {
  const root = ownedDirectory(file.slice(0, -'.jsonl'.length), create);
  return root && ownedDirectory(join(root, 'attachments'), create);
}

export function deleteAttachments(file: string) {
  const root = ownedDirectory(file.slice(0, -'.jsonl'.length), false);
  if (root) rmSync(root, { recursive: true });
}

export function readAttachmentFile(directory: string, id: string): Buffer | undefined {
  if (!/^[a-f0-9]{64}$/.test(id)) return;
  const file = join(directory, id);
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      relative(join(realpathSync(directory), id), realpathSync(file))
    )
      throw new Error('Attachment outside managed storage');
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== id)
      throw new Error('Attachment content does not match its identity');
    return bytes;
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export function storeAttachments(directory: string, files: { id: string; bytes: Buffer }[]) {
  for (const { id, bytes } of files) {
    if (readAttachmentFile(directory, id)) continue;
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, join(directory, id));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

import { rootedFileAccess, type RootedFileAccess } from '@mini-harness/file-access/api';
import { realpath } from 'node:fs/promises';
import { containsPath } from '@mini-harness/platform/paths';
import { DomainError } from '@mini-harness/platform/errors';
import type { RouteRequest } from '@mini-harness/transport/routes';
import type { Context } from 'mini-harness/cordis';

/** Resolve the same scoped file policy for every authenticated workspace file route. */
export async function workspaceFiles(ctx: Context, { params, url, signal }: RouteRequest) {
  const workspace = ctx.harnessWorkspaces.get(params.id);
  const scopes = ctx.harnessProfileScopes;
  const session = url.searchParams.get('sessionId');
  const owner = `workspace:${workspace.id}` as const;
  const key = session ? (`session:${session}` as const) : owner;
  if (session && !scopes.address(key).includes(owner))
    throw new DomainError('not_found', 'Conversation not found');
  await scopes.prepare(key, signal);
  const root = ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id);
  const state = await realpath(ctx.harnessState.paths.home);
  const access = scopes.context(key).get('harnessFileAccess');
  if (!access) throw new DomainError('unavailable', 'File access is unavailable in this scope');
  const files: RootedFileAccess = rootedFileAccess(access, root, {
    exclude: (path) => containsPath(state, path),
  });
  return {
    files,
    root,
    path: url.searchParams.get('path') ?? '.',
  };
}
